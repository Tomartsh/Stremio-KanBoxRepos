const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CookieJar } = require("tough-cookie");
const {
    isInteractiveChallenge,
    isChallengeDocument,
    isHardBlockDocument,
    isBrowserUnavailableError,
    resolveKanBrowserOptions,
    persistentContextOptions,
    launchKanBrowser
} = require("../classes/kanBrowser");
const { KanSession } = require("../classes/kanSession");

const HTML = "<html><body><h1>כאן</h1><p>catalog page with enough markup to count as the site.</p></body></html>";

test("default launch options use installed Chrome, headed and off-screen", () => {
    const resolved = resolveKanBrowserOptions({}, "/work");
    assert.equal(resolved.channel, "chrome");
    assert.equal(resolved.headless, false);
    assert.equal(resolved.headlessRaw, "headed");
    assert.equal(resolved.userDataDir, path.resolve("/work", "output", "kan-browser-profile"));
    const options = persistentContextOptions(resolved);
    assert.equal(options.channel, "chrome");
    assert.equal(options.headless, false);
    assert.equal(options.viewport, null);
    assert.equal(Object.prototype.hasOwnProperty.call(options, "userAgent"), false);
    assert.deepEqual(options.ignoreDefaultArgs, ["--enable-automation"]);
    assert.ok(options.args.includes("--disable-blink-features=AutomationControlled"));
    assert.ok(options.args.includes("--window-position=-2400,-2400"));
});

test("bundled Chromium keeps a channel so Playwright does not pick the headless shell", () => {
    const resolved = resolveKanBrowserOptions({ KAN_BROWSER_CHANNEL: "chromium" }, "/work");
    assert.equal(resolved.channel, "chromium");
    assert.equal(persistentContextOptions(resolved).channel, "chromium");
});

test("an explicit browser path and a Windows profile directory are honored", () => {
    const resolved = resolveKanBrowserOptions({
        KAN_BROWSER_CHANNEL: "chrome",
        KAN_BROWSER_EXECUTABLE: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        KAN_BROWSER_HEADLESS: "false",
        KAN_BROWSER_USER_DATA_DIR: "D:\\KanBox\\kan-browser-profile"
    }, "/work");
    assert.equal(resolved.channel, undefined);
    assert.equal(resolved.executablePath, "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
    assert.equal(resolved.headless, false);
    assert.equal(resolved.userDataDir, "D:\\KanBox\\kan-browser-profile");
    assert.ok(resolved.args.includes("--window-position=-2400,-2400"));
    const options = persistentContextOptions(resolved);
    assert.equal(options.executablePath, resolved.executablePath);
    assert.equal(Object.prototype.hasOwnProperty.call(options, "channel"), false);
});

test("shell mode is the old headless shell", () => {
    const resolved = resolveKanBrowserOptions({ KAN_BROWSER_HEADLESS: "shell" }, "/work");
    assert.equal(resolved.channel, undefined);
    assert.equal(resolved.headless, true);
    assert.equal(resolved.headlessRaw, "shell");
});

test("challenge pages are distinguished from hard blocks and from a missing browser", () => {
    assert.equal(isInteractiveChallenge("<html>Just a moment...</html>"), true);
    assert.equal(isInteractiveChallenge("<html><title>רק רגע...</title></html>"), true);
    assert.equal(isHardBlockDocument("<html>Just a moment...</html>"), false);
    assert.equal(isInteractiveChallenge("<h1>Sorry, you have been blocked</h1>"), false);
    assert.equal(isHardBlockDocument("<h1>Sorry, you have been blocked</h1><div id='cf-error-details'></div>"), true);
    const cleared = "<html><head><script src=\"/cdn-cgi/challenge-platform/scripts/jsd/main.js\"></script><title>כאן</title></head><body><p>catalog page with enough markup to count as the site and not an interstitial.</p></body></html>";
    assert.equal(isInteractiveChallenge(cleared), false);
    assert.equal(isChallengeDocument(cleared), false);
    assert.equal(isBrowserUnavailableError(new Error("browserType.launch: Executable doesn't exist at ms-playwright")), true);
    assert.equal(isBrowserUnavailableError(new Error("HTTP 403")), false);
});

test("a cleared browser saves its user agent and cf_clearance for the next run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kan-snapshot-"));
    const snapshotPath = path.join(dir, "http-session.json");
    const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36";
    const client = {
        calls: [],
        async get(url, config) {
            client.calls.push({ url, headers: config.headers });
            return { status: 403, data: "<html>Just a moment</html>" };
        }
    };
    const session = new KanSession({
        sleep: async () => {},
        random: () => 0,
        snapshotPath,
        client,
        jar: new CookieJar(),
        browserFactory: async () => ({
            browser: { async close() {} },
            context: {
                async close() {},
                async cookies() {
                    return [{
                        name: "cf_clearance",
                        value: "from-browser",
                        domain: ".kan.org.il",
                        path: "/",
                        secure: true,
                        httpOnly: true,
                        expires: Math.floor(Date.now() / 1000) + 3600
                    }];
                }
            },
            page: {
                async goto() { return { status: () => 200 }; },
                async content() { return HTML; },
                async evaluate(fn) {
                    const source = Function.prototype.toString.call(fn);
                    if (source.includes("userAgentData")) {
                        return {
                            secChUa: "\"Google Chrome\";v=\"131\"",
                            secChUaMobile: "?0",
                            secChUaPlatform: "\"Windows\""
                        };
                    }
                    return ua;
                },
                async close() {}
            }
        })
    });

    await session.fetch("https://www.kan.org.il/lobby/kan-box/");
    assert.equal(session.browserUserAgent, ua);
    const saved = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
    assert.equal(saved.userAgent, ua);
    assert.equal(saved.cookies[0].name, "cf_clearance");
    assert.equal(saved.cookies[0].value, "from-browser");
    await session.close();

    const nextCalls = [];
    const next = new KanSession({
        sleep: async () => {},
        random: () => 0,
        snapshotPath,
        client: {
            async get(url, config) {
                nextCalls.push(config.headers);
                return { status: 200, data: HTML };
            }
        }
    });
    await next.fetch("https://www.kan.org.il/lobby/kan-box/");
    assert.equal(nextCalls[0]["User-Agent"], ua);
    assert.equal(nextCalls[0]["sec-ch-ua"], "\"Google Chrome\";v=\"131\"");
    const cookies = await next.jar.getCookies("https://www.kan.org.il/lobby/kan-box/");
    assert.equal(cookies.some((cookie) => cookie.key === "cf_clearance" && cookie.value === "from-browser"), true);
    await next.close();
});

test("plain HTTP that still gets challenged is skipped on the next run", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kan-skip-http-"));
    const snapshotPath = path.join(dir, "http-session.json");
    fs.writeFileSync(snapshotPath, JSON.stringify({
        userAgent: "Mozilla/5.0 Chrome/131.0.0.0",
        plainHttpBlocked: true,
        cookies: [{
            name: "cf_clearance",
            value: "kept",
            domain: ".kan.org.il",
            path: "/",
            secure: true,
            expires: Math.floor(Date.now() / 1000) + 3600
        }]
    }));
    let httpCalls = 0;
    let browserCalls = 0;
    const session = new KanSession({
        sleep: async () => {},
        random: () => 0,
        snapshotPath,
        client: {
            async get() {
                httpCalls += 1;
                return { status: 403, data: "<html>Just a moment</html>" };
            }
        },
        browserFactory: async () => ({
            browser: { async close() {} },
            context: { async close() {}, async cookies() { return []; } },
            page: {
                async goto() {
                    browserCalls += 1;
                    return { status: () => 200 };
                },
                async content() { return HTML; },
                async close() {}
            }
        })
    });
    const doc = await session.fetch("https://www.kan.org.il/lobby/kan-box/");
    assert.equal(typeof doc.querySelector, "function");
    assert.equal(httpCalls, 0);
    assert.equal(browserCalls, 1);
    await session.close();
});

test("a locked Chrome profile falls back to a per-process directory", async () => {
    const dirs = [];
    const options = [];
    const root = path.join(os.tmpdir(), "kan-profile-lock");
    const playwright = {
        chromium: {
            async launchPersistentContext(dir, launchOptions) {
                dirs.push(dir);
                options.push(launchOptions);
                if (dirs.length === 1) {
                    throw new Error("Failed to create a ProcessSingleton for your profile directory. This usually means that the profile is already in use by another instance of Chromium.");
                }
                return {
                    async addInitScript() {},
                    pages() { return []; },
                    async newPage() {
                        return { async route() {} };
                    },
                    browser() { return { async close() {} }; }
                };
            }
        }
    };
    const opened = await launchKanBrowser({
        playwright,
        fs: { mkdirSync() {} },
        pid: 4242,
        env: {
            KAN_BROWSER_USER_DATA_DIR: root,
            KAN_BROWSER_CHANNEL: "chrome",
            KAN_BROWSER_HEADLESS: "new"
        }
    });
    assert.equal(dirs[0], root);
    assert.equal(dirs[1], path.join(root, "pid-4242"));
    assert.equal(options[0].channel, "chrome");
    assert.equal(Object.prototype.hasOwnProperty.call(options[0], "userAgent"), false);
    assert.equal(opened.userDataDir, path.join(root, "pid-4242"));
});
