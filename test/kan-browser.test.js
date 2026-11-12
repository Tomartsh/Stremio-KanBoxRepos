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
    const delays = [];
    const root = path.join(os.tmpdir(), "kan-profile-lock");
    const playwright = {
        chromium: {
            async launchPersistentContext(dir, launchOptions) {
                dirs.push(dir);
                options.push(launchOptions);
                if (dirs.length === 1) {
                    throw new Error("browserType.launchPersistentContext: Failed to create a ProcessSingleton for your profile directory. This usually means that the profile is already in use by another instance of Chromium.");
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
        sleep: async (ms) => { delays.push(ms); },
        logger: quietLogger(),
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
    assert.deepEqual(delays, []);
});

test("a browser that exits during launch is retried on the same profile", async () => {
    const closed = "browserType.launchPersistentContext: Target page, context or browser has been closed";
    const dirs = [];
    const delays = [];
    const warnings = [];
    let calls = 0;
    const root = path.join(os.tmpdir(), "kan-launch-retry");
    const opened = await launchKanBrowser({
        playwright: {
            chromium: {
                async launchPersistentContext(dir) {
                    dirs.push(dir);
                    calls += 1;
                    if (calls === 1) throw new Error(closed);
                    if (calls === 2) throw new Error("Target page, context or browser has been closed");
                    return readyContext();
                }
            }
        },
        fs: { mkdirSync() {} },
        pid: 7,
        sleep: async (ms) => { delays.push(ms); },
        logger: quietLogger(warnings),
        env: {
            KAN_BROWSER_USER_DATA_DIR: root,
            KAN_BROWSER_CHANNEL: "chrome",
            KAN_BROWSER_HEADLESS: "new"
        }
    });
    assert.deepEqual(dirs, [root, root, root]);
    assert.deepEqual(delays, [5000, 5000]);
    assert.equal(opened.userDataDir, root);
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /attempt 1\/3/);
    assert.match(warnings[0], /Target page, context or browser has been closed/);
    assert.match(warnings[0], /Waiting 5000ms and retrying the same profile/);
    assert.ok(warnings[0].includes(root));
    assert.match(warnings[1], /attempt 2\/3/);
    assert.match(warnings[1], /Target page, context or browser has been closed/);
});

test("a failed launch closes its context and browser before the retry wait", async () => {
    const events = [];
    let calls = 0;
    const root = path.join(os.tmpdir(), "kan-launch-cleanup");
    const opened = await launchKanBrowser({
        playwright: {
            chromium: {
                async launchPersistentContext(dir) {
                    events.push(`launch:${dir}`);
                    calls += 1;
                    if (calls === 1) {
                        return {
                            async addInitScript() {},
                            pages() { return []; },
                            async newPage() {
                                events.push("newPage");
                                throw new Error("browserType.launchPersistentContext: Target page, context or browser has been closed");
                            },
                            browser() {
                                return { async close() { events.push("browser.close"); } };
                            },
                            async close() { events.push("context.close"); }
                        };
                    }
                    return {
                        async addInitScript() {},
                        pages() { return [{ async route() {} }]; },
                        browser() { return { async close() {} }; },
                        async close() { events.push("success.close"); }
                    };
                }
            }
        },
        fs: { mkdirSync() {} },
        sleep: async (ms) => { events.push(`sleep:${ms}`); },
        logger: quietLogger(),
        env: {
            KAN_BROWSER_USER_DATA_DIR: root,
            KAN_BROWSER_CHANNEL: "chrome",
            KAN_BROWSER_HEADLESS: "false",
            KAN_BROWSER_LAUNCH_RETRIES: "2",
            KAN_BROWSER_LAUNCH_RETRY_DELAY_MS: "5000"
        }
    });
    assert.deepEqual(events, [
        `launch:${root}`,
        "newPage",
        "context.close",
        "browser.close",
        "sleep:5000",
        `launch:${root}`
    ]);
    assert.equal(opened.userDataDir, root);
});

test("launch retries give up on the same profile and surface the browser error", async () => {
    const dirs = [];
    const delays = [];
    const root = path.join(os.tmpdir(), "kan-launch-give-up");
    const failure = "browserType.launchPersistentContext: Target page, context or browser has been closed";
    await assert.rejects(
        () => launchKanBrowser({
            playwright: {
                chromium: {
                    async launchPersistentContext(dir) {
                        dirs.push(dir);
                        throw new Error(failure);
                    }
                }
            },
            fs: { mkdirSync() {} },
            pid: 9,
            sleep: async (ms) => { delays.push(ms); },
            logger: quietLogger(),
            env: {
                KAN_BROWSER_USER_DATA_DIR: root,
                KAN_BROWSER_CHANNEL: "chrome",
                KAN_BROWSER_HEADLESS: "new",
                KAN_BROWSER_LAUNCH_RETRIES: "2",
                KAN_BROWSER_LAUNCH_RETRY_DELAY_MS: "250"
            }
        }),
        (error) => error instanceof Error && error.message === failure
    );
    assert.deepEqual(dirs, [root, root, root]);
    assert.deepEqual(delays, [250, 250]);
});

test("a missing browser executable is retried on the same profile", async () => {
    const dirs = [];
    const delays = [];
    const warnings = [];
    const root = path.join(os.tmpdir(), "kan-launch-missing");
    let calls = 0;
    const opened = await launchKanBrowser({
        playwright: {
            chromium: {
                async launchPersistentContext(dir) {
                    dirs.push(dir);
                    calls += 1;
                    if (calls === 1) {
                        throw new Error("browserType.launchPersistentContext: Executable doesn't exist at C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe");
                    }
                    return readyContext();
                }
            }
        },
        fs: { mkdirSync() {} },
        sleep: async (ms) => { delays.push(ms); },
        logger: quietLogger(warnings),
        env: {
            KAN_BROWSER_USER_DATA_DIR: root,
            KAN_BROWSER_CHANNEL: "chrome",
            KAN_BROWSER_HEADLESS: "new",
            KAN_BROWSER_LAUNCH_RETRIES: "1",
            KAN_BROWSER_LAUNCH_RETRY_DELAY_MS: "10"
        }
    });
    assert.deepEqual(dirs, [root, root]);
    assert.deepEqual(delays, [10]);
    assert.match(warnings[0], /attempt 1\/2/);
    assert.match(warnings[0], /Executable doesn't exist/);
    assert.equal(opened.userDataDir, root);
});

test("invalid launch retry settings keep the defaults", async () => {
    const delays = [];
    const warnings = [];
    let calls = 0;
    const root = path.join(os.tmpdir(), "kan-launch-defaults");
    await launchKanBrowser({
        playwright: {
            chromium: {
                async launchPersistentContext() {
                    calls += 1;
                    if (calls === 1) throw new Error("Failed to launch chrome");
                    return readyContext();
                }
            }
        },
        fs: { mkdirSync() {} },
        sleep: async (ms) => { delays.push(ms); },
        logger: quietLogger(warnings),
        env: {
            KAN_BROWSER_USER_DATA_DIR: root,
            KAN_BROWSER_CHANNEL: "chrome",
            KAN_BROWSER_LAUNCH_RETRIES: "nope",
            KAN_BROWSER_LAUNCH_RETRY_DELAY_MS: "-5"
        }
    });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [5000]);
    assert.match(warnings[0], /attempt 1\/3/);
    assert.match(warnings[0], /Failed to launch chrome/);
});

test("zero launch retries and unrelated errors fail on the first attempt", async () => {
    let closedCalls = 0;
    let otherCalls = 0;
    const delays = [];
    const root = path.join(os.tmpdir(), "kan-launch-once");
    const base = {
        fs: { mkdirSync() {} },
        sleep: async (ms) => { delays.push(ms); },
        logger: quietLogger()
    };
    await assert.rejects(
        () => launchKanBrowser({
            ...base,
            playwright: {
                chromium: {
                    async launchPersistentContext() {
                        closedCalls += 1;
                        throw new Error("Target page, context or browser has been closed");
                    }
                }
            },
            env: {
                KAN_BROWSER_USER_DATA_DIR: root,
                KAN_BROWSER_LAUNCH_RETRIES: "0",
                KAN_BROWSER_LAUNCH_RETRY_DELAY_MS: "5000"
            }
        }),
        /Target page, context or browser has been closed/
    );
    await assert.rejects(
        () => launchKanBrowser({
            ...base,
            playwright: {
                chromium: {
                    async launchPersistentContext() {
                        otherCalls += 1;
                        throw new Error("HTTP 403");
                    }
                }
            },
            env: {
                KAN_BROWSER_USER_DATA_DIR: root,
                KAN_BROWSER_CHANNEL: "chrome"
            }
        }),
        /HTTP 403/
    );
    assert.equal(closedCalls, 1);
    assert.equal(otherCalls, 1);
    assert.deepEqual(delays, []);
});

test("a closed browser on the fallback profile is retried there", async () => {
    const dirs = [];
    const delays = [];
    const root = path.join(os.tmpdir(), "kan-launch-fallback-retry");
    let calls = 0;
    const opened = await launchKanBrowser({
        playwright: {
            chromium: {
                async launchPersistentContext(dir) {
                    dirs.push(dir);
                    calls += 1;
                    if (calls === 1) {
                        throw new Error("browserType.launchPersistentContext: ProcessSingleton profile is already in use");
                    }
                    if (calls === 2) {
                        throw new Error("browserType.launchPersistentContext: Target page, context or browser has been closed");
                    }
                    return readyContext();
                }
            }
        },
        fs: { mkdirSync() {} },
        pid: 11,
        sleep: async (ms) => { delays.push(ms); },
        logger: quietLogger(),
        env: {
            KAN_BROWSER_USER_DATA_DIR: root,
            KAN_BROWSER_CHANNEL: "chrome",
            KAN_BROWSER_HEADLESS: "new",
            KAN_BROWSER_LAUNCH_RETRY_DELAY_MS: "5000"
        }
    });
    const fallback = path.join(root, "pid-11");
    assert.deepEqual(dirs, [root, fallback, fallback]);
    assert.deepEqual(delays, [5000]);
    assert.equal(opened.userDataDir, fallback);
});

test("the scraper that hit a closed launch keeps going after the retry", async () => {
    const root = path.join(os.tmpdir(), "kan-launch-session");
    const delays = [];
    let launches = 0;
    const playwright = {
        chromium: {
            async launchPersistentContext() {
                launches += 1;
                if (launches === 1) {
                    throw new Error("browserType.launchPersistentContext: Target page, context or browser has been closed");
                }
                return {
                    async addInitScript() {},
                    async cookies() { return []; },
                    pages() { return []; },
                    async newPage() {
                        return {
                            async route() {},
                            async goto() { return { status: () => 200 }; },
                            async content() { return HTML; },
                            async evaluate(fn) {
                                const source = Function.prototype.toString.call(fn);
                                if (source.includes("userAgentData")) return null;
                                return "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.85 Safari/537.36";
                            },
                            async close() {}
                        };
                    },
                    browser() { return { async close() {} }; },
                    async close() {}
                };
            }
        }
    };
    const session = new KanSession({
        sleep: async () => {},
        random: () => 0,
        snapshotPath: null,
        client: {
            async get() {
                return { status: 403, data: "<html>Just a moment</html>" };
            }
        },
        browserFactory: () => launchKanBrowser({
            playwright,
            fs: { mkdirSync() {} },
            sleep: async (ms) => { delays.push(ms); },
            logger: quietLogger(),
            env: {
                KAN_BROWSER_USER_DATA_DIR: root,
                KAN_BROWSER_CHANNEL: "chrome",
                KAN_BROWSER_HEADLESS: "false",
                KAN_BROWSER_LAUNCH_RETRIES: "2",
                KAN_BROWSER_LAUNCH_RETRY_DELAY_MS: "5000"
            }
        })
    });
    const doc = await session.fetch("https://www.kan.org.il/lobby/kan-box/");
    assert.equal(typeof doc.querySelector, "function");
    assert.equal(launches, 2);
    assert.equal(session.browserLaunches, 1);
    assert.deepEqual(delays, [5000]);
    await session.close();
});

function quietLogger(warnings) {
    return {
        info() {},
        warn(message) {
            if (warnings) warnings.push(String(message));
        },
        error() {},
        debug() {}
    };
}

function readyContext() {
    return {
        async addInitScript() {},
        pages() { return []; },
        async newPage() { return { async route() {} }; },
        browser() { return { async close() {} }; },
        async close() {}
    };
}
