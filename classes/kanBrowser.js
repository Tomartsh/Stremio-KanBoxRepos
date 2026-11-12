/**
 * How the Kan scrapers launch a browser.
 *
 * Playwright's `chromium.launch({ headless: true })` with no channel starts
 * `chromium-headless-shell` (see BrowserType.getExecutableName in
 * playwright-core). That shell is not the desktop Chrome that loads
 * kan.org.il. It also forces a Chrome/141 user agent onto whatever binary
 * actually starts, so the UA and the client hints disagree. Cloudflare's
 * "Just a moment" interstitial answers both with HTTP 403.
 *
 * Passing `channel: "chrome"` uses the installed Google Chrome. Passing
 * `channel: "chromium"` uses the full Chromium binary, not the headless
 * shell. The default is headed, with the window placed off-screen: new
 * headless Chrome sends a HeadlessChrome user agent and kan.org.il keeps
 * the interstitial up. A persistent user-data dir keeps cf_clearance
 * between nightly runs.
 *
 * A pending Google Chrome auto-update makes the first chrome.exe exit
 * within a few seconds (setup.exe --rename-chrome-exe) before the
 * remote-debugging pipe opens. Playwright then throws "Target page,
 * context or browser has been closed" and the scrape would otherwise
 * stop as KAN BROWSER UNAVAILABLE. That launch is retried on the same
 * profile. KAN_BROWSER_LAUNCH_RETRIES (default 2) is how many extra
 * attempts follow the first failure. KAN_BROWSER_LAUNCH_RETRY_DELAY_MS
 * (default 5000) is the wait between them. A profile that is already in
 * use still falls back to a per-process directory and is not retried on
 * the same directory.
 */

const fs = require("fs");
const path = require("path");

// A cleared kan.org.il page still embeds /cdn-cgi/challenge-platform/scripts/jsd/main.js.
// Matching that URL marks the real catalog as a challenge. These phrases are the
// interstitial itself (English and the he-IL "רק רגע..." title).
const INTERACTIVE_RE = /Just a moment|רק רגע|cf-browser-verification|Checking your browser|Enable JavaScript and cookies|cf-challenge-running|id="challenge-stage"|id="cf-challenge-running"/i;
const HARD_BLOCK_RE = /sorry, you have been blocked|attention required|cf-error-details|cf-wrapper|error code:? 10(1[05]|20)/i;
const INTERACTIVE_PATTERN = "Just a moment|רק רגע|cf-browser-verification|Checking your browser|Enable JavaScript and cookies|cf-challenge-running";

function isHardBlockDocument(body) {
    return HARD_BLOCK_RE.test(String(body || ""));
}

function isInteractiveChallenge(body) {
    const text = String(body || "");
    if (isHardBlockDocument(text)) return false;
    return INTERACTIVE_RE.test(text);
}

function isChallengeDocument(body) {
    return isInteractiveChallenge(body) || isHardBlockDocument(body);
}

function blockKind(status, body) {
    if (isInteractiveChallenge(body)) return "challenge";
    if (status === 403 || isHardBlockDocument(body) || isChallengeDocument(body)) return "block";
    return "";
}

function isBrowserUnavailableError(error) {
    const message = String((error && error.message) || error || "");
    return /Executable doesn't exist|Failed to launch|browserType\.launch|spawn .* ENOENT|npx playwright install|Chromium distribution|Could not find browser|No usable sandbox|Target page, context or browser has been closed while launching/i.test(message);
}

function isProfileInUseError(error) {
    const message = String((error && error.message) || error || "");
    return /profile.*in use|ProcessSingleton|SingletonLock|Opening in existing browser session/i.test(message);
}

function isClosedBrowserLaunchError(error) {
    const message = String((error && error.message) || error || "");
    return /Target page, context or browser has been closed/i.test(message);
}

// Chrome's updater and a missing binary both surface as an unavailable
// launch. A profile lock is a different failure and is not retried here.
function isRetryableLaunchError(error) {
    if (isProfileInUseError(error)) return false;
    return isBrowserUnavailableError(error) || isClosedBrowserLaunchError(error);
}

function readNonNegativeInt(value, fallback) {
    if (value == null || String(value).trim() === "") return fallback;
    const parsed = Number(String(value).trim());
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return Math.floor(parsed);
}

function resolveLaunchRetry(env = process.env) {
    return {
        retries: readNonNegativeInt(env.KAN_BROWSER_LAUNCH_RETRIES, 2),
        delayMs: readNonNegativeInt(env.KAN_BROWSER_LAUNCH_RETRY_DELAY_MS, 5000)
    };
}

function errorText(error) {
    if (error && error.message) return error.message;
    return String(error);
}

async function closeLaunchAttempt(context) {
    if (!context) return;
    let browser = null;
    try {
        if (typeof context.browser === "function") browser = context.browser();
    } catch (error) {
        browser = null;
    }
    if (typeof context.close === "function") {
        try {
            await context.close();
        } catch (error) {
            // The browser may already have exited.
        }
    }
    if (browser && typeof browser.close === "function") {
        try {
            await browser.close();
        } catch (error) {
            // Closing the persistent context already stops the process.
        }
    }
}

function absoluteDir(input, cwd) {
    if (!input) return path.resolve(cwd || process.cwd(), "output", "kan-browser-profile");
    if (path.win32.isAbsolute(input) || path.posix.isAbsolute(input)) return input;
    return path.resolve(cwd || process.cwd(), input);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [cwd]
 */
function resolveKanBrowserOptions(env = process.env, cwd = process.cwd()) {
    const requestedChannel = env.KAN_BROWSER_CHANNEL == null || String(env.KAN_BROWSER_CHANNEL).trim() === ""
        ? "chrome"
        : String(env.KAN_BROWSER_CHANNEL).trim().toLowerCase();
    const executablePath = env.KAN_BROWSER_EXECUTABLE
        ? String(env.KAN_BROWSER_EXECUTABLE).trim()
        : "";
    const headlessRaw = env.KAN_BROWSER_HEADLESS == null || String(env.KAN_BROWSER_HEADLESS).trim() === ""
        ? "false"
        : String(env.KAN_BROWSER_HEADLESS).trim().toLowerCase();

    let headless = true;
    let forceShell = false;
    const args = [
        "--disable-blink-features=AutomationControlled",
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-sync",
        "--mute-audio",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--disable-renderer-backgrounding"
    ];

    if (["0", "false", "no", "headed", "offscreen"].includes(headlessRaw)) {
        headless = false;
        args.push("--window-position=-2400,-2400", "--window-size=1366,768");
    } else if (["shell", "old"].includes(headlessRaw)) {
        headless = true;
        forceShell = true;
    }

    let channel;
    if (executablePath || forceShell) {
        channel = undefined;
    } else if (requestedChannel === "chromium" || requestedChannel === "bundled") {
        // A channel is required. With headless:true and no channel, Playwright
        // launches chromium-headless-shell instead of the full browser.
        channel = "chromium";
    } else {
        channel = requestedChannel;
    }

    return {
        channel,
        requestedChannel,
        executablePath: executablePath || undefined,
        headless,
        headlessRaw: headless ? (forceShell ? "shell" : "new") : "headed",
        userDataDir: absoluteDir(env.KAN_BROWSER_USER_DATA_DIR, cwd),
        args,
        ignoreDefaultArgs: ["--enable-automation"]
    };
}

function persistentContextOptions(resolved) {
    const options = {
        headless: resolved.headless,
        ignoreDefaultArgs: resolved.ignoreDefaultArgs,
        args: resolved.args.slice(),
        viewport: null,
        locale: "he-IL",
        timezoneId: "Asia/Jerusalem",
        acceptDownloads: false,
        colorScheme: "light"
    };
    if (resolved.channel) options.channel = resolved.channel;
    if (resolved.executablePath) options.executablePath = resolved.executablePath;
    return options;
}

const HIDE_WEBDRIVER_SOURCE = `(() => {
  try {
    Object.defineProperty(navigator, "webdriver", { get: () => false, configurable: true });
  } catch (e) {}
})();`;

function readHttpSnapshot(file) {
    if (!file) return null;
    try {
        if (!fs.existsSync(file)) return null;
        const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
    } catch (error) {
        return null;
    }
}

function writeHttpSnapshot(file, data) {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
}

function cookieHeader(cookie) {
    const parts = [`${cookie.name}=${cookie.value}`];
    if (cookie.domain) parts.push(`Domain=${cookie.domain}`);
    parts.push(`Path=${cookie.path || "/"}`);
    if (cookie.secure) parts.push("Secure");
    if (cookie.httpOnly) parts.push("HttpOnly");
    if (cookie.expires && Number(cookie.expires) > 0) {
        parts.push(`Expires=${new Date(Number(cookie.expires) * 1000).toUTCString()}`);
    }
    return parts.join("; ");
}

function cookieUrl(cookie) {
    const domain = String(cookie.domain || "").replace(/^\./, "");
    const proto = cookie.secure ? "https" : "http";
    return `${proto}://${domain || "kan.org.il"}${cookie.path || "/"}`;
}

async function launchKanBrowser(deps = {}) {
    const log4js = require("log4js");
    const logger = deps.logger || log4js.getLogger("kanSession");
    const env = deps.env || process.env;
    const resolved = deps.launchOptions || resolveKanBrowserOptions(env);
    const playwright = deps.playwright || require("playwright");
    const fileSystem = deps.fs || fs;
    const pid = deps.pid || process.pid;
    const sleep = typeof deps.sleep === "function"
        ? deps.sleep
        : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const retry = resolveLaunchRetry(env);

    const open = async (userDataDir) => {
        fileSystem.mkdirSync(userDataDir, { recursive: true });
        logger.info(
            `kanSession => Launching one shared browser for kan.org.il ` +
            `(channel=${resolved.channel || "default"}, headless=${resolved.headlessRaw}, profile=${userDataDir})`
        );
        let context = null;
        try {
            context = await playwright.chromium.launchPersistentContext(
                userDataDir,
                persistentContextOptions(resolved)
            );
            if (typeof context.addInitScript === "function") {
                await context.addInitScript(HIDE_WEBDRIVER_SOURCE);
            }
            let page = null;
            if (typeof context.pages === "function") {
                const openPages = context.pages();
                page = openPages && openPages[0];
            }
            if (!page) page = await context.newPage();
            const browser = typeof context.browser === "function" ? context.browser() : null;
            return { browser, context, page, persistent: true, userDataDir };
        } catch (error) {
            await closeLaunchAttempt(context);
            throw error;
        }
    };

    // Retries stay on this profile. The caller (the scraper that asked for
    // the browser) waits here, so a dead first chrome.exe does not fail the
    // scrape and hand the run to the next scraper.
    const openRetrying = async (userDataDir) => {
        const attempts = retry.retries + 1;
        for (let attempt = 1; attempt <= attempts; attempt++) {
            try {
                return await open(userDataDir);
            } catch (error) {
                if (!isRetryableLaunchError(error) || attempt >= attempts) throw error;
                logger.warn(
                    `kanSession => Browser launch failed (attempt ${attempt}/${attempts}): ${errorText(error)}. ` +
                    `Waiting ${retry.delayMs}ms and retrying the same profile (${userDataDir}).`
                );
                await sleep(retry.delayMs);
            }
        }
    };

    try {
        return await openRetrying(resolved.userDataDir);
    } catch (error) {
        if (!isProfileInUseError(error)) throw error;
        const fallback = path.join(resolved.userDataDir, `pid-${pid}`);
        logger.warn(
            `kanSession => Browser profile is already in use (${resolved.userDataDir}). ` +
            `Launching a separate profile at ${fallback}. cf_clearance from the other run is not shared.`
        );
        return await openRetrying(fallback);
    }
}

module.exports = {
    isChallengeDocument,
    isHardBlockDocument,
    isInteractiveChallenge,
    blockKind,
    isBrowserUnavailableError,
    isProfileInUseError,
    resolveKanBrowserOptions,
    persistentContextOptions,
    readHttpSnapshot,
    writeHttpSnapshot,
    cookieHeader,
    cookieUrl,
    launchKanBrowser,
    HIDE_WEBDRIVER_SOURCE,
    INTERACTIVE_PATTERN
};
