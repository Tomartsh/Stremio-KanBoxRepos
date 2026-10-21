/**
 * One HTTP session for every kan.org.il and kankids.org.il request in this process.
 *
 * Plain HTTP (axios) is challenged because Node's TLS fingerprint is not Chrome.
 * The browser that used to run after that challenge was Playwright's
 * chromium-headless-shell with a forced Chrome/141 user agent, a fresh profile,
 * and an 8 second sleep. Cloudflare keeps serving "Just a moment" to that shell.
 * A missing browser binary (the SYSTEM account does not see another user's
 * Playwright cache) was reported as the same HTTP 403.
 *
 * This session:
 * - sends one stable Windows Chrome header set, replaced by the real browser UA
 *   once a browser has solved a challenge
 * - waits a polite interval plus jitter between requests
 * - runs a single request at a time
 * - keeps one cookie jar, and reloads cookies saved by the previous run
 * - opens one real Chrome (or full Chromium) persistent context after a
 *   challenge, and reuses that page
 * - logs CLOUDFLARE CHALLENGE for an interstitial and KAN BROWSER UNAVAILABLE
 *   when the browser cannot start
 * - in slow mode, opens the browser before the long backoff. The long backoff
 *   runs only when that browser is still blocked
 *
 * A scraper run can install pacing (config/pacing.json) on the async context.
 * Slow mode keeps the same session and the same page: it waits 45–90s between
 * requests, pauses every 40 pages, and gives up only when the time budget is
 * exhausted (or maxRetries, if that is set). Outside a paced run the timings
 * above apply.
 */

const { AsyncLocalStorage } = require("async_hooks");
const path = require("path");
const { parse } = require("node-html-parser");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const log4js = require("log4js");
const { KAN_SESSION } = require("./constants");
const { formatDuration } = require("./pacing");
const {
    isChallengeDocument,
    isInteractiveChallenge,
    blockKind,
    isBrowserUnavailableError,
    readHttpSnapshot,
    writeHttpSnapshot,
    cookieHeader,
    cookieUrl,
    launchKanBrowser,
    resolveKanBrowserOptions,
    INTERACTIVE_PATTERN
} = require("./kanBrowser");

const logger = log4js.getLogger("kanSession");
const runStore = new AsyncLocalStorage();

const KAN_BROWSER_HEADERS = Object.freeze({
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "max-age=0",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Sec-Fetch-User": "?1",
    "sec-ch-ua": '"Google Chrome";v="141", "Chromium";v="141", "Not-A.Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"'
});

class KanBlockedError extends Error {
    constructor(message, url) {
        super(message);
        this.name = "KanBlockedError";
        this.code = "BLOCKED";
        this.statusCode = 403;
        this.url = url || "";
    }
}

function isKanBlockedError(error) {
    return !!(error && (error.code === "BLOCKED" || error.name === "KanBlockedError"));
}

class KanBudgetError extends Error {
    constructor(message) {
        super(message);
        this.name = "KanBudgetError";
        this.code = "BUDGET";
    }
}

function isKanBudgetError(error) {
    return !!(error && (error.code === "BUDGET" || error.name === "KanBudgetError"));
}

class KanBrowserError extends Error {
    constructor(message, url) {
        super(message);
        this.name = "KanBrowserError";
        this.code = "BROWSER";
        this.url = url || "";
    }
}

function isKanBrowserError(error) {
    return !!(error && (error.code === "BROWSER" || error.name === "KanBrowserError"));
}

function isKanHost(hostname) {
    if (!hostname) return false;
    const host = String(hostname).toLowerCase();
    return host === "kan.org.il" || host.endsWith(".kan.org.il")
        || host === "kankids.org.il" || host.endsWith(".kankids.org.il");
}

function isHttpBlocked(status, body) {
    if (status === 403) return true;
    if (isChallengeDocument(body)) return true;
    return false;
}

function looksLikeSiteDocument(body) {
    const text = String(body || "");
    if (isChallengeDocument(text)) return false;
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
    return /<html[\s>]/i.test(text) && text.length > 80;
}

function jitterMs(range, random) {
    const [min, max] = range || [0, 0];
    if (max <= min) return min;
    const roll = typeof random === "function" ? random() : Math.random();
    return min + Math.floor(roll * (max - min + 1));
}

function withParams(url, params) {
    if (!params || Object.keys(params).length === 0) return url;
    const built = new URL(url);
    for (const [key, value] of Object.entries(params)) {
        built.searchParams.set(key, value == null ? "" : String(value));
    }
    return built.toString();
}

function bindKanRun(fn, pacing) {
    return runStore.run({
        http403: 0,
        blocked: false,
        reason: "",
        pacing: pacing || null,
        startedAt: Date.now(),
        pages: 0,
        progress: []
    }, fn);
}

function getKanRunState() {
    return runStore.getStore() || null;
}

function rethrowIfKanBlocked(error) {
    if (isKanBlockedError(error) || isKanBudgetError(error) || isKanBrowserError(error)) throw error;
    const state = getKanRunState();
    if (state && state.blocked) {
        throw new KanBlockedError(state.reason || "BLOCKED kan.org.il HTTP 403");
    }
    if (state && state.budgetExhausted) {
        throw new KanBudgetError(state.reason || "time budget exhausted");
    }
}

function assertKanOpen() {
    const state = getKanRunState();
    if (state && state.blocked) {
        throw new KanBlockedError(state.reason || "BLOCKED kan.org.il HTTP 403");
    }
}

class KanSession {
    constructor(deps = {}) {
        this.config = { ...(deps.config || KAN_SESSION) };
        const env = deps.env || process.env;
        if (env.KAN_CHALLENGE_TIMEOUT_MS) {
            const timeout = Number(env.KAN_CHALLENGE_TIMEOUT_MS);
            if (Number.isFinite(timeout) && timeout >= 0) this.config.CHALLENGE_TIMEOUT_MS = timeout;
        }
        this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.random = deps.random || Math.random;
        this.browserFactory = deps.browserFactory || (() => launchKanBrowser({ env }));
        this.jar = deps.jar || new CookieJar();
        this.client = deps.client || createHttpClient(this.jar, this.config, deps.adapter);
        this.launchOptions = deps.launchOptions || resolveKanBrowserOptions(env);
        this.snapshotPath = Object.prototype.hasOwnProperty.call(deps, "snapshotPath")
            ? deps.snapshotPath
            : path.join(this.launchOptions.userDataDir, "http-session.json");
        this.browserUserAgent = "";
        this.browserSecChUa = "";
        this.browserSecChUaMobile = "";
        this.browserSecChUaPlatform = "";
        this.tail = Promise.resolve();
        this.lastRequestAt = 0;
        this.lastUrl = "";
        this.transport = "http";
        this.browser = null;
        this.context = null;
        this.page = null;
        this.launching = null;
        this.browserLaunches = 0;
        if (this.snapshotPath) this._applySnapshot(readHttpSnapshot(this.snapshotPath));
    }

    fetch(url, options = {}) {
        const state = getKanRunState();
        const run = () => {
            if (state) return runStore.run(state, () => this._fetch(url, options));
            return this._fetch(url, options);
        };
        const queued = this.tail.then(run, run);
        this.tail = queued.then(() => undefined, () => undefined);
        return queued;
    }

    async _fetch(url, options) {
        const timing = this._timing();
        const extended = timing.slow || timing.maxRetries !== 1 || timing.budgetMs != null;
        if (extended) return this._fetchSlow(url, options, timing);
        return this._fetchStandard(url, options, timing);
    }

    async _fetchStandard(url, options, timing) {
        assertKanOpen();
        if (timing.budgetMs != null) this._throwIfBudgetSpent(timing, "before request");
        await this._pace();

        let first;
        try {
            first = await this._attempt(url, options);
        } catch (error) {
            if (isKanBlockedError(error) || isKanBudgetError(error) || isKanBrowserError(error)) throw error;
            if (isBrowserUnavailableError(error)) throw this._failBrowser(url, error);
            if (error.statusCode && error.statusCode < 500) throw error;
            await this.sleep(jitterMs([400, 900], this.random));
            first = await this._attempt(url, options);
        }

        if (!first.blocked) {
            await this._afterSuccessfulPage(url, timing);
            return first.value;
        }

        const backoff = jitterMs([timing.backoffMin, timing.backoffMax], this.random);
        logger.warn(this._blockLog(url, first, `Backing off once (${backoff}ms) and opening the browser.`));
        await this.sleep(backoff);
        this.transport = "browser";

        let second;
        try {
            second = await this._attempt(url, options, { forceBrowser: true });
        } catch (error) {
            if (isKanBrowserError(error)) throw error;
            if (isBrowserUnavailableError(error)) throw this._failBrowser(url, error);
            this._markBlocked(url, error.message || "retry failed", first.kind);
            throw new KanBlockedError(this._blockedMessage(url, first, "one backoff"), url);
        }

        if (second.blocked) {
            this._markBlocked(url, `HTTP ${second.status || 403}`, second.kind || first.kind);
            throw new KanBlockedError(
                this._blockedMessage(url, second.kind ? second : first, "one backoff"),
                url
            );
        }

        logger.info(`CLOUDFLARE CHALLENGE cleared for ${url}. Reusing this browser for the rest of the scrape.`);
        await this._afterSuccessfulPage(url, timing);
        return second.value;
    }

    async _fetchSlow(url, options, timing) {
        assertKanOpen();
        this._throwIfBudgetSpent(timing, "before request");
        await this._pace();

        let blockRound = 0;
        while (true) {
            let outcome;
            try {
                outcome = await this._attempt(url, options);
            } catch (error) {
                if (isKanBlockedError(error) || isKanBudgetError(error) || isKanBrowserError(error)) throw error;
                if (isBrowserUnavailableError(error)) throw this._failBrowser(url, error);
                if (error.statusCode && error.statusCode < 500) throw error;
                const gap = jitterMs([400, 900], this.random);
                await this._sleepBudgeted(gap, "transient retry", timing);
                outcome = await this._attempt(url, options);
            }

            if (!outcome.blocked) {
                await this._afterSuccessfulPage(url, timing);
                return outcome.value;
            }

            if (this.transport !== "browser") {
                logger.warn(this._blockLog(url, outcome, "Opening the browser before any long backoff."));
                this.transport = "browser";
                continue;
            }

            blockRound += 1;
            if (timing.maxRetries != null && blockRound > timing.maxRetries) {
                this._markBlocked(url, `HTTP ${outcome.status || 403}`, outcome.kind);
                const times = timing.maxRetries === 1 ? "one backoff" : `${timing.maxRetries} backoffs`;
                throw new KanBlockedError(this._blockedMessage(url, outcome, times), url);
            }

            const backoff = jitterMs([timing.backoffMin, timing.backoffMax], this.random);
            const state = getKanRunState();
            const pages = state ? state.pages || 0 : 0;
            const left = this._budgetLeft(timing);
            const prefix = timing.slow ? "kan slow" : "pacing";
            logger.warn(
                `${this._blockLog(url, outcome, "")} ${prefix}: sleeping ${formatDuration(backoff)} then resuming this page (not restarting). retry ${blockRound}. pages ${pages}. budget left ${formatDuration(left)}.`
            );
            this._pushProgress({ type: "block", url, ms: backoff, retry: blockRound, pages, budgetLeftMs: left });
            await this._sleepBudgeted(backoff, "403 backoff, then resume this page", timing);
            this.transport = "browser";
        }
    }

    _timing() {
        const state = getKanRunState();
        const pacing = state && state.pacing;
        if (!pacing) {
            const jitter = this.config.JITTER_MS || [0, 0];
            const backoff = this.config.BACKOFF_MS || [0, 0];
            return {
                slow: false,
                minIntervalMs: this.config.MIN_INTERVAL_MS || 0,
                jitterMin: jitter[0],
                jitterMax: jitter[1],
                backoffMin: backoff[0],
                backoffMax: backoff[1],
                maxRetries: 1,
                pauseEveryPages: 0,
                pauseMin: 0,
                pauseMax: 0,
                budgetMs: null
            };
        }
        return {
            slow: !!pacing.slow,
            minIntervalMs: pacing.minIntervalMs || 0,
            jitterMin: pacing.requestDelayMinMs,
            jitterMax: pacing.requestDelayMaxMs,
            backoffMin: pacing.blockBackoffMinMs,
            backoffMax: pacing.blockBackoffMaxMs,
            maxRetries: pacing.maxRetries,
            pauseEveryPages: pacing.pauseEveryPages || 0,
            pauseMin: pacing.pauseMinMs || 0,
            pauseMax: pacing.pauseMaxMs || 0,
            budgetMs: pacing.budgetMs
        };
    }

    _budgetLeft(timing) {
        if (!timing || timing.budgetMs == null) return null;
        const state = getKanRunState();
        const started = state && state.startedAt ? state.startedAt : Date.now();
        return timing.budgetMs - (Date.now() - started);
    }

    _throwIfBudgetSpent(timing, reason) {
        const left = this._budgetLeft(timing);
        if (left == null || left > 0) return left;
        const message = `time budget exhausted${reason ? ` (${reason})` : ""}`;
        const state = getKanRunState();
        if (state) {
            state.budgetExhausted = true;
            state.reason = message;
        }
        logger.error(`pacing: ${message}. pages ${state ? state.pages || 0 : 0}. Not publishing.`);
        throw new KanBudgetError(message);
    }

    async _sleepBudgeted(ms, reason, timing) {
        if (ms <= 0) return;
        const left = this._throwIfBudgetSpent(timing, reason);
        if (left != null && ms > left) {
            const message = `time budget exhausted during ${reason}: need ${formatDuration(ms)}, ${formatDuration(left)} left`;
            const state = getKanRunState();
            if (state) {
                state.budgetExhausted = true;
                state.reason = message;
            }
            logger.error(`pacing: ${message}. Not publishing.`);
            throw new KanBudgetError(message);
        }
        const state = getKanRunState();
        const pages = state ? state.pages || 0 : 0;
        const prefix = timing.slow ? "kan slow" : "pacing";
        logger.info(`${prefix}: sleeping ${formatDuration(ms)} (${reason}). pages ${pages}. budget left ${formatDuration(left)}.`);
        this._pushProgress({ type: "sleep", ms, reason, pages, budgetLeftMs: left });
        await this.sleep(ms);
    }

    _pushProgress(event) {
        const state = getKanRunState();
        if (!state) return;
        if (!state.progress) state.progress = [];
        state.progress.push(event);
    }

    async _afterSuccessfulPage(url, timing) {
        if (!timing.slow && !(timing.pauseEveryPages > 0)) return;
        const state = getKanRunState();
        const pages = state ? (state.pages = (state.pages || 0) + 1) : 1;
        const left = this._budgetLeft(timing);
        const elapsed = state && state.startedAt ? Date.now() - state.startedAt : 0;
        const eta = timing.budgetMs != null && state && state.startedAt
            ? new Date(state.startedAt + timing.budgetMs).toISOString()
            : "n/a";
        let pauseNote = "";
        if (timing.pauseEveryPages > 0) {
            const remainder = pages % timing.pauseEveryPages;
            if (remainder === 0) pauseNote = " pausing now.";
            else pauseNote = ` next pause in ${timing.pauseEveryPages - remainder} pages.`;
        }
        const prefix = timing.slow ? "kan slow" : "pacing";
        logger.info(
            `${prefix}: page ${pages} done (${url}). elapsed ${formatDuration(elapsed)}. budget left ${formatDuration(left)}. ETA ${eta}.${pauseNote}`
        );
        this._pushProgress({ type: "page", pages, url, elapsedMs: elapsed, budgetLeftMs: left, eta });
        if (timing.pauseEveryPages > 0 && pages % timing.pauseEveryPages === 0) {
            const pause = jitterMs([timing.pauseMin, timing.pauseMax], this.random);
            logger.info(`${prefix}: pause after ${pages} pages for ${formatDuration(pause)}.`);
            await this._sleepBudgeted(pause, `pause after ${pages} pages`, timing);
        }
    }

    async _attempt(url, options, extra = {}) {
        if (this.transport === "browser" || extra.forceBrowser) {
            return this._browserAttempt(url, options);
        }
        return this._httpAttempt(url, options);
    }

    async _httpAttempt(url, options) {
        const headers = this._headersFor(url, options);
        const response = await this.client.get(url, {
            headers,
            params: options.params,
            responseType: "text",
            validateStatus: () => true,
            timeout: this.config.REQUEST_TIMEOUT_MS
        });
        const status = response.status ?? response.statusCode;
        const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
        this.lastUrl = url;
        if (isHttpBlocked(status, body)) {
            if (this._hasClearance(url)) this.plainHttpBlocked = true;
            return { blocked: true, status: status || 403, kind: blockKind(status, body) };
        }
        if (status >= 400) {
            const error = new Error(`HTTP ${status}`);
            error.statusCode = status;
            throw error;
        }
        return { blocked: false, value: this._decode(body, options) };
    }

    async _browserAttempt(url, options) {
        const page = await this._getPage();
        const target = withParams(url, options.params);
        await this._noteLaunchUa();
        await this._seedBrowserCookies(target);
        const response = await page.goto(target, {
            waitUntil: "domcontentloaded",
            timeout: this.config.REQUEST_TIMEOUT_MS
        });
        let status = 200;
        if (response && typeof response.status === "function") status = response.status() || 200;
        else if (response && typeof response.status === "number") status = response.status;

        let html = await page.content();
        if (isInteractiveChallenge(html)) {
            await this._waitOutChallenge(page, target, status);
            html = await page.content();
        }
        this.lastUrl = target;

        if (isInteractiveChallenge(html)) {
            logger.error(`CLOUDFLARE CHALLENGE kan.org.il still present on ${target} after the browser wait (HTTP ${status || 403}).`);
            return { blocked: true, status: status === 200 ? 403 : (status || 403), kind: "challenge" };
        }
        if (isChallengeDocument(html)) {
            logger.error(`CLOUDFLARE BLOCK kan.org.il on ${target} (HTTP ${status || 403}). Cloudflare returned a block page, not an interstitial the browser can finish.`);
            return { blocked: true, status: status === 200 ? 403 : (status || 403), kind: "block" };
        }
        if (status === 403) {
            if (looksLikeSiteDocument(html)) {
                await this._captureBrowserIdentity(target);
                return { blocked: false, value: this._decode(html, options) };
            }
            logger.error(`CLOUDFLARE BLOCK kan.org.il on ${target} (HTTP 403).`);
            return { blocked: true, status: 403, kind: "block" };
        }
        if (status >= 400) {
            const error = new Error(`HTTP ${status}`);
            error.statusCode = status;
            throw error;
        }
        await this._captureBrowserIdentity(target);
        return { blocked: false, value: this._decode(html, options) };
    }

    async _noteLaunchUa() {
        if (this._notedLaunchUa || !this.page || typeof this.page.evaluate !== "function") return;
        this._notedLaunchUa = true;
        try {
            const ua = await this.page.evaluate(() => navigator.userAgent);
            if (!ua || typeof ua !== "string") return;
            if (!this.browserUserAgent) this.browserUserAgent = ua;
            if (/HeadlessChrome/i.test(ua)) {
                logger.warn(
                    `kanSession => Browser user agent is ${ua}. Headless Chrome is challenged by kan.org.il. ` +
                    "Set KAN_BROWSER_HEADLESS=false so Chrome stays headed and off-screen."
                );
            } else {
                logger.info(`kanSession => Browser user agent ${ua}`);
            }
        } catch (error) {
            logger.debug(`kanSession => Could not read the launch user agent: ${error.message}`);
        }
    }

    async _waitOutChallenge(page, target, status) {
        const timeout = this.config.CHALLENGE_TIMEOUT_MS || this.config.CHALLENGE_WAIT_MS || 0;
        logger.warn(
            `CLOUDFLARE CHALLENGE kan.org.il on ${target} (HTTP ${status || 403}). ` +
            `Waiting up to ${timeout}ms for the interstitial to clear. This is not a generic HTTP error.`
        );
        if (typeof page.waitForFunction === "function" && timeout > 0) {
            try {
                await page.waitForFunction((pattern) => {
                    const title = document.title || "";
                    const text = document.body ? (document.body.innerText || "") : "";
                    const blob = `${title}\n${text}`;
                    if (/Sorry, you have been blocked|Attention Required|cf-error-details/i.test(blob)) return true;
                    return !new RegExp(pattern, "i").test(blob);
                }, INTERACTIVE_PATTERN, { timeout });
            } catch (error) {
                const message = String(error && error.message || error);
                if (/Execution context was destroyed|navigation/i.test(message)) {
                    if (typeof page.waitForLoadState === "function") {
                        await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
                    }
                    return;
                }
                logger.warn(`CLOUDFLARE CHALLENGE wait ended without a clear page (${message}).`);
            }
            return;
        }
        if (this.config.CHALLENGE_WAIT_MS > 0) await this.sleep(this.config.CHALLENGE_WAIT_MS);
    }

    _blockLog(url, outcome, detail) {
        const label = outcome && outcome.kind === "challenge" ? "CLOUDFLARE CHALLENGE" : "CLOUDFLARE BLOCK";
        const tail = detail ? ` ${detail}` : "";
        return `${label} kan.org.il HTTP ${outcome && outcome.status || 403} on ${url}.${tail}`;
    }

    _blockedMessage(url, outcome, times) {
        const status = (outcome && outcome.status) || 403;
        if (outcome && outcome.kind === "challenge") {
            return `BLOCKED kan.org.il CLOUDFLARE CHALLENGE HTTP ${status} after ${times}: ${url}`;
        }
        return `BLOCKED kan.org.il HTTP ${status} after ${times}: ${url}`;
    }

    _failBrowser(url, error) {
        const message = `KAN BROWSER UNAVAILABLE for ${url}: ${error && error.message ? error.message : error}. Not a Cloudflare block. Set KAN_BROWSER_EXECUTABLE to the installed chrome.exe and KAN_BROWSER_USER_DATA_DIR to a directory on D:. The SYSTEM account does not see another user's Playwright browsers. Bundled Chromium works only when KAN_BROWSER_CHANNEL=chromium and PLAYWRIGHT_BROWSERS_PATH point at a directory where the browsers were installed.`;
        logger.error(message);
        return new KanBrowserError(message, url);
    }

    _applySnapshot(snapshot) {
        if (!snapshot) return;
        if (snapshot.userAgent) this.browserUserAgent = String(snapshot.userAgent);
        if (snapshot.secChUa) this.browserSecChUa = String(snapshot.secChUa);
        if (snapshot.secChUaMobile) this.browserSecChUaMobile = String(snapshot.secChUaMobile);
        if (snapshot.secChUaPlatform) this.browserSecChUaPlatform = String(snapshot.secChUaPlatform);
        if (snapshot.plainHttpBlocked) {
            this.transport = "browser";
            this.plainHttpBlocked = true;
        }
        const cookies = Array.isArray(snapshot.cookies) ? snapshot.cookies : [];
        if (!this.jar || typeof this.jar.setCookieSync !== "function") return;
        for (const cookie of cookies) {
            if (!cookie || !cookie.name) continue;
            try {
                this.jar.setCookieSync(cookieHeader(cookie), cookieUrl(cookie));
            } catch (error) {
                logger.debug(`kanSession => Could not restore cookie ${cookie.name}: ${error.message}`);
            }
        }
    }

    _hasClearance(url) {
        if (!this.jar || typeof this.jar.getCookiesSync !== "function") return false;
        try {
            return this.jar.getCookiesSync(url).some((cookie) => cookie.key === "cf_clearance");
        } catch (error) {
            return false;
        }
    }

    async _readBrowserCookies(pageUrl) {
        if (!this.context || typeof this.context.cookies !== "function") return [];
        let cookies = [];
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                cookies = await this.context.cookies(pageUrl);
            } catch (error) {
                logger.debug(`kanSession => Could not read browser cookies: ${error.message}`);
                return cookies;
            }
            if (cookies.some((cookie) => cookie && cookie.name === "cf_clearance")) return cookies;
            if (attempt < 5) await this.sleep(500);
        }
        return cookies;
    }

    async _captureBrowserIdentity(pageUrl) {
        if (this.page && typeof this.page.evaluate === "function") {
            try {
                const ua = await this.page.evaluate(() => navigator.userAgent);
                if (ua && typeof ua === "string") this.browserUserAgent = ua;
                const hints = await this.page.evaluate(() => {
                    const data = navigator.userAgentData;
                    if (!data || !data.brands) return null;
                    return {
                        secChUa: data.brands.map((brand) => `"${brand.brand}";v="${brand.version}"`).join(", "),
                        secChUaMobile: data.mobile ? "?1" : "?0",
                        secChUaPlatform: data.platform ? `"${data.platform}"` : ""
                    };
                });
                if (hints && hints.secChUa) {
                    this.browserSecChUa = hints.secChUa;
                    this.browserSecChUaMobile = hints.secChUaMobile || "";
                    this.browserSecChUaPlatform = hints.secChUaPlatform || "";
                }
            } catch (error) {
                logger.debug(`kanSession => Could not read the browser user agent: ${error.message}`);
            }
        }
        if (this.browserUserAgent && /HeadlessChrome/i.test(this.browserUserAgent)) {
            logger.warn(`kanSession => Browser user agent contains HeadlessChrome (${this.browserUserAgent}). Cloudflare may keep challenging this session. Set KAN_BROWSER_CHANNEL=chrome.`);
        }
        const cookies = await this._readBrowserCookies(pageUrl);
        if (this.jar && typeof this.jar.setCookie === "function") {
            for (const cookie of cookies) {
                if (!cookie || !cookie.name) continue;
                try {
                    await this.jar.setCookie(cookieHeader(cookie), cookieUrl(cookie));
                } catch (error) {
                    logger.debug(`kanSession => Could not store browser cookie ${cookie.name}: ${error.message}`);
                }
            }
        }
        if (!this.snapshotPath) return;
        const clearance = cookies.some((cookie) => cookie && cookie.name === "cf_clearance");
        try {
            writeHttpSnapshot(this.snapshotPath, {
                userAgent: this.browserUserAgent || "",
                secChUa: this.browserSecChUa || "",
                secChUaMobile: this.browserSecChUaMobile || "",
                secChUaPlatform: this.browserSecChUaPlatform || "",
                plainHttpBlocked: !!this.plainHttpBlocked,
                cookies: cookies.map((cookie) => ({
                    name: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain,
                    path: cookie.path,
                    secure: !!cookie.secure,
                    httpOnly: !!cookie.httpOnly,
                    expires: cookie.expires || 0
                }))
            });
            logger.info(`kanSession => Saved browser cookies for the next run (cf_clearance=${clearance ? "yes" : "no"}).`);
        } catch (error) {
            logger.warn(`kanSession => Could not save the browser cookie snapshot: ${error.message}`);
        }
    }

    _decode(body, options) {
        const text = String(body || "");
        if (!options.asJson) return parse(text);
        const trimmed = text.trim();
        if (trimmed.startsWith("<")) {
            const pre = trimmed.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
            const raw = pre ? pre[1] : trimmed.replace(/<[^>]+>/g, "");
            return JSON.parse(raw);
        }
        return JSON.parse(trimmed);
    }

    _headersFor(url, options) {
        const headers = { ...KAN_BROWSER_HEADERS };
        if (this.browserUserAgent) {
            headers["User-Agent"] = this.browserUserAgent;
            if (this.browserSecChUa) headers["sec-ch-ua"] = this.browserSecChUa;
            else delete headers["sec-ch-ua"];
            if (this.browserSecChUaMobile) headers["sec-ch-ua-mobile"] = this.browserSecChUaMobile;
            if (this.browserSecChUaPlatform) headers["sec-ch-ua-platform"] = this.browserSecChUaPlatform;
        }
        if (options.asJson) {
            headers.Accept = "application/json, text/plain, */*";
            headers["Sec-Fetch-Dest"] = "empty";
            headers["Sec-Fetch-Mode"] = "cors";
        }
        if (this.lastUrl) {
            headers.Referer = this.lastUrl;
            headers["Sec-Fetch-Site"] = "same-origin";
            try {
                if (new URL(this.lastUrl).host !== new URL(url).host) headers["Sec-Fetch-Site"] = "cross-site";
            } catch (error) {
                headers["Sec-Fetch-Site"] = "same-origin";
            }
        }
        return headers;
    }

    async _pace() {
        const timing = this._timing();
        const minInterval = timing.minIntervalMs || 0;
        const now = Date.now();
        let wait = 0;
        if (this.lastRequestAt) {
            const since = now - this.lastRequestAt;
            if (since < minInterval) wait += minInterval - since;
        }
        wait += jitterMs([timing.jitterMin, timing.jitterMax], this.random);
        if (wait > 0) {
            if (timing.slow) await this._sleepBudgeted(wait, "delay between kan.org.il requests", timing);
            else await this.sleep(wait);
        }
        this.lastRequestAt = Date.now();
    }

    async _seedBrowserCookies(url) {
        if (!this.context || typeof this.context.addCookies !== "function" || !this.jar) return;
        let cookies = [];
        try {
            cookies = await this.jar.getCookies(url);
        } catch (error) {
            logger.debug(`kanSession => Could not read cookies for ${url}: ${error.message}`);
            return;
        }
        if (!cookies.length) return;
        await this.context.addCookies(cookies.map((cookie) => ({
            name: cookie.key,
            value: cookie.value,
            url,
            httpOnly: !!cookie.httpOnly,
            secure: !!cookie.secure
        })));
    }

    async _getPage() {
        if (this.page && typeof this.page.isClosed === "function" && this.page.isClosed()) {
            this.page = null;
            if (this.context && typeof this.context.newPage === "function") {
                this.page = await this._armPage(await this.context.newPage());
                logger.debug("kanSession => Reopened the shared Kan page on the same browser context");
                return this.page;
            }
        }
        if (this.page) return this.page;
        if (!this.launching) {
            this.browserLaunches += 1;
            this.launching = Promise.resolve()
                .then(() => this.browserFactory())
                .then(async (handles) => {
                    this.browser = handles.browser;
                    this.context = handles.context;
                    this.page = await this._armPage(handles.page);
                    return this.page;
                })
                .catch((error) => {
                    this.launching = null;
                    this.page = null;
                    throw error;
                });
        }
        return this.launching;
    }

    async _armPage(page) {
        if (!page || page.__kanArmed || typeof page.route !== "function") return page;
        await page.route("**/*", (route) => {
            let type = "";
            try {
                type = route.request().resourceType();
            } catch (error) {
                type = "";
            }
            if (type === "media") return route.abort();
            return route.continue();
        });
        page.__kanArmed = true;
        return page;
    }

    _markBlocked(url, detail, kind) {
        const challenge = kind === "challenge";
        const reason = challenge
            ? `CLOUDFLARE CHALLENGE on ${url} (${detail}). The browser did not clear Cloudflare.`
            : `HTTP 403 from Cloudflare on ${url} (${detail})`;
        const state = getKanRunState();
        if (state) {
            state.blocked = true;
            state.http403 = (state.http403 || 0) + 1;
            state.challenge = challenge;
            state.reason = reason;
        }
        logger.error(`BLOCKED kan.org.il ${reason}. Aborting this scraper.`);
    }

    async close() {
        const page = this.page;
        const context = this.context;
        const browser = this.browser;
        this.page = null;
        this.context = null;
        this.browser = null;
        this.launching = null;
        if (page && typeof page.close === "function") await page.close().catch(() => {});
        if (context && typeof context.close === "function") await context.close().catch(() => {});
        if (browser && typeof browser.close === "function") await browser.close().catch(() => {});
    }
}

function createHttpClient(jar, config, adapter) {
    const instance = axios.create({
        jar,
        withCredentials: true,
        timeout: config.REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
        maxRedirects: 5,
        ...(adapter ? { adapter } : {})
    });
    return wrapper(instance);
}

let singleton = null;

function getKanSession() {
    if (!singleton) singleton = new KanSession();
    return singleton;
}

async function closeKanSession() {
    if (!singleton) return;
    const session = singleton;
    singleton = null;
    await session.close();
}

module.exports = {
    KAN_BROWSER_HEADERS,
    KanBlockedError,
    KanBudgetError,
    KanBrowserError,
    KanSession,
    isKanBlockedError,
    isKanBudgetError,
    isKanBrowserError,
    isKanHost,
    isChallengeDocument,
    isHttpBlocked,
    looksLikeSiteDocument,
    jitterMs,
    bindKanRun,
    getKanRunState,
    rethrowIfKanBlocked,
    assertKanOpen,
    getKanSession,
    closeKanSession
};
