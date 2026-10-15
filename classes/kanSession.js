/**
 * One HTTP session for every kan.org.il request in this process.
 *
 * kanDigital, kanArchive, and kan88 run together on a 12 GB machine.
 * A new browser or a new cookie jar per page is what Cloudflare answers
 * with HTTP 403, and the old retry ladder then sat on that page for minutes.
 *
 * This session:
 * - sends one stable Windows Chrome header set
 * - waits a polite interval plus jitter between requests
 * - runs a single request at a time
 * - keeps one cookie jar
 * - opens one headless browser only after a challenge, and reuses that page
 * - on HTTP 403 or a challenge page, backs off once, retries once, then throws
 */

const { AsyncLocalStorage } = require("async_hooks");
const { parse } = require("node-html-parser");
const axios = require("axios");
const { wrapper } = require("axios-cookiejar-support");
const { CookieJar } = require("tough-cookie");
const log4js = require("log4js");
const { KAN_SESSION } = require("./constants");

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

function isKanHost(hostname) {
    if (!hostname) return false;
    const host = String(hostname).toLowerCase();
    return host === "kan.org.il" || host.endsWith(".kan.org.il");
}

function isChallengeDocument(body) {
    const text = String(body || "");
    return /Just a moment|cf-browser-verification|cf-challenge|cf-error|cf-wrapper|Checking your browser|Attention Required|challenge-platform|cdn-cgi\/challenge|you have been blocked|Enable JavaScript and cookies/i.test(text);
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

function bindKanRun(fn) {
    return runStore.run({ http403: 0, blocked: false, reason: "" }, fn);
}

function getKanRunState() {
    return runStore.getStore() || null;
}

function rethrowIfKanBlocked(error) {
    if (isKanBlockedError(error)) throw error;
    const state = getKanRunState();
    if (state && state.blocked) {
        throw new KanBlockedError(state.reason || "BLOCKED kan.org.il HTTP 403");
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
        this.config = deps.config || KAN_SESSION;
        this.sleep = deps.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
        this.random = deps.random || Math.random;
        this.browserFactory = deps.browserFactory || launchLowMemoryBrowser;
        this.jar = deps.jar || new CookieJar();
        this.client = deps.client || createHttpClient(this.jar, this.config, deps.adapter);
        this.tail = Promise.resolve();
        this.lastRequestAt = 0;
        this.lastUrl = "";
        this.transport = "http";
        this.browser = null;
        this.context = null;
        this.page = null;
        this.launching = null;
        this.browserLaunches = 0;
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
        assertKanOpen();
        await this._pace();

        let first;
        try {
            first = await this._attempt(url, options);
        } catch (error) {
            if (isKanBlockedError(error)) throw error;
            if (error.statusCode && error.statusCode < 500) throw error;
            await this.sleep(jitterMs([400, 900], this.random));
            first = await this._attempt(url, options);
        }

        if (!first.blocked) return first.value;

        const backoff = jitterMs(this.config.BACKOFF_MS, this.random);
        logger.warn(`BLOCKED kan.org.il HTTP ${first.status || 403} on ${url}. Backing off once (${backoff}ms) and retrying the same session.`);
        await this.sleep(backoff);
        this.transport = "browser";

        let second;
        try {
            second = await this._attempt(url, options, { forceBrowser: true });
        } catch (error) {
            this._markBlocked(url, error.message || "retry failed");
            throw new KanBlockedError(
                `BLOCKED kan.org.il HTTP 403 after one backoff: ${url}`,
                url
            );
        }

        if (second.blocked) {
            this._markBlocked(url, `HTTP ${second.status || 403}`);
            throw new KanBlockedError(
                `BLOCKED kan.org.il HTTP ${second.status || 403} after one backoff: ${url}`,
                url
            );
        }

        logger.info(`kan.org.il challenge cleared for ${url}. Reusing this session for the rest of the scrape.`);
        return second.value;
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
            return { blocked: true, status: status || 403 };
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
        await this._seedBrowserCookies(target);
        const response = await page.goto(target, {
            waitUntil: "domcontentloaded",
            timeout: this.config.REQUEST_TIMEOUT_MS
        });
        let status = 200;
        if (response && typeof response.status === "function") status = response.status() || 200;
        else if (response && typeof response.status === "number") status = response.status;

        let html = await page.content();
        if (isChallengeDocument(html) && this.config.CHALLENGE_WAIT_MS > 0) {
            logger.debug(`kan.org.il challenge page on ${target}. Waiting ${this.config.CHALLENGE_WAIT_MS}ms in the same browser.`);
            await this.sleep(this.config.CHALLENGE_WAIT_MS);
            html = await page.content();
        }
        this.lastUrl = target;

        if (isChallengeDocument(html)) {
            return { blocked: true, status: status === 200 ? 403 : (status || 403) };
        }
        if (status === 403) {
            if (looksLikeSiteDocument(html)) {
                return { blocked: false, value: this._decode(html, options) };
            }
            return { blocked: true, status: 403 };
        }
        if (status >= 400) {
            const error = new Error(`HTTP ${status}`);
            error.statusCode = status;
            throw error;
        }
        return { blocked: false, value: this._decode(html, options) };
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
        if (options.asJson) {
            headers.Accept = "application/json, text/plain, */*";
            headers["Sec-Fetch-Dest"] = "empty";
            headers["Sec-Fetch-Mode"] = "cors";
        }
        if (this.lastUrl) {
            headers.Referer = this.lastUrl;
            headers["Sec-Fetch-Site"] = "same-origin";
        }
        return headers;
    }

    async _pace() {
        const minInterval = this.config.MIN_INTERVAL_MS || 0;
        const now = Date.now();
        let wait = 0;
        if (this.lastRequestAt) {
            const since = now - this.lastRequestAt;
            if (since < minInterval) wait += minInterval - since;
        }
        wait += jitterMs(this.config.JITTER_MS, this.random);
        if (wait > 0) await this.sleep(wait);
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
                this.page = await this.context.newPage();
                logger.debug("kanSession => Reopened the shared Kan page on the same browser context");
                return this.page;
            }
        }
        if (this.page) return this.page;
        if (!this.launching) {
            this.browserLaunches += 1;
            this.launching = Promise.resolve()
                .then(() => this.browserFactory())
                .then((handles) => {
                    this.browser = handles.browser;
                    this.context = handles.context;
                    this.page = handles.page;
                    return handles.page;
                });
        }
        return this.launching;
    }

    _markBlocked(url, detail) {
        const reason = `HTTP 403 from Cloudflare on ${url} (${detail})`;
        const state = getKanRunState();
        if (state) {
            state.blocked = true;
            state.http403 = (state.http403 || 0) + 1;
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

async function launchLowMemoryBrowser() {
    const { chromium } = require("playwright");
    logger.info("kanSession => Launching one shared browser for kan.org.il");
    const browser = await chromium.launch({
        headless: true,
        args: [
            "--disable-blink-features=AutomationControlled",
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--disable-extensions",
            "--disable-background-networking",
            "--disable-default-apps",
            "--disable-sync",
            "--mute-audio",
            "--no-first-run",
            "--renderer-process-limit=1"
        ]
    });
    const context = await browser.newContext({
        userAgent: KAN_BROWSER_HEADERS["User-Agent"],
        viewport: { width: 1280, height: 720 },
        locale: "he-IL",
        timezoneId: "Asia/Jerusalem",
        extraHTTPHeaders: {
            "Accept-Language": KAN_BROWSER_HEADERS["Accept-Language"]
        }
    });
    const page = await context.newPage();
    await page.route("**/*", (route) => {
        const type = route.request().resourceType();
        if (type === "image" || type === "media" || type === "font") return route.abort();
        return route.continue();
    });
    return { browser, context, page };
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
    KanSession,
    isKanBlockedError,
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
