const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");
const {
    KAN_BROWSER_HEADERS,
    KanSession,
    KanBlockedError,
    bindKanRun,
    getKanRunState,
    getKanSession,
    closeKanSession,
    isKanHost
} = require("../classes/kanSession");

const PAGE = "https://www.kan.org.il/content/kan/kan-11/p-11766/?page=1&itemsToShow=1000";
const HTML = "<html><body><h1>כאן 11</h1></body></html>";

function immediateSession(extra) {
    const sleeps = [];
    const session = new KanSession({
        sleep: async (ms) => { sleeps.push(ms); },
        random: () => 0,
        snapshotPath: null,
        ...extra
    });
    return { session, sleeps };
}

function scriptedClient(responses) {
    const calls = [];
    return {
        calls,
        async get(url, config) {
            calls.push({ url, headers: config.headers, params: config.params });
            const next = responses.shift();
            if (typeof next === "function") return next(url, config);
            return next;
        }
    };
}

test("kan.org.il and kankids.org.il share the session", () => {
    assert.equal(isKanHost("www.kan.org.il"), true);
    assert.equal(isKanHost("mobapi.kan.org.il"), true);
    assert.equal(isKanHost("www.kankids.org.il"), true);
    assert.equal(isKanHost("www.mako.co.il"), false);
    assert.equal(isKanHost("13tv.co.il"), false);
});

test("requests use one stable Windows Chrome header set and a polite jittered gap", async () => {
    const client = scriptedClient([
        { status: 200, data: HTML },
        { status: 200, data: HTML }
    ]);
    const { session, sleeps } = immediateSession({ client });
    await session.fetch("https://www.kan.org.il/lobby/kan11");
    await session.fetch(PAGE);

    assert.equal(client.calls.length, 2);
    assert.equal(client.calls[0].headers["User-Agent"], KAN_BROWSER_HEADERS["User-Agent"]);
    assert.equal(client.calls[1].headers["User-Agent"], client.calls[0].headers["User-Agent"]);
    assert.match(client.calls[0].headers["User-Agent"], /Windows NT 10\.0; Win64; x64/);
    assert.match(client.calls[0].headers["User-Agent"], /Chrome\/141/);
    assert.equal(client.calls[0].headers["Accept-Language"], "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7");
    assert.equal(client.calls[1].headers.Referer, "https://www.kan.org.il/lobby/kan11");
    assert.equal(sleeps[0], 1000);
    assert.ok(sleeps[1] >= 2500 && sleeps[1] <= 3000, `gap was ${sleeps[1]}`);
    assert.equal(session.browserLaunches, 0);
});

test("kan.org.il requests stay at one in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const client = {
        async get() {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 40));
            inFlight -= 1;
            return { status: 200, data: HTML };
        }
    };
    const { session } = immediateSession({ client });
    await Promise.all([
        session.fetch("https://www.kan.org.il/a"),
        session.fetch("https://www.kan.org.il/b"),
        session.fetch("https://www.kan.org.il/c")
    ]);
    assert.equal(maxInFlight, 1);
});

test("a cleared challenge reuses one browser for later pages", async () => {
    let browserGoes = 0;
    const client = scriptedClient([
        { status: 403, data: "<html>Just a moment</html>" }
    ]);
    const { session } = immediateSession({
        client,
        browserFactory: async () => ({
            browser: { async close() {} },
            context: { async close() {} },
            page: {
                async goto() {
                    browserGoes += 1;
                    return { status: () => 200 };
                },
                async content() { return HTML; },
                async close() {}
            }
        })
    });

    const first = await session.fetch(PAGE);
    await session.fetch("https://www.kan.org.il/lobby/series/");
    assert.equal(typeof first.querySelector, "function");
    assert.equal(client.calls.length, 1);
    assert.equal(session.browserLaunches, 1);
    assert.equal(browserGoes, 2);
    await session.close();
});

test("the HTTP session sends cookies from the previous kan response", async () => {
    const seen = [];
    const server = http.createServer((req, res) => {
        seen.push(req.headers.cookie || "");
        res.writeHead(200, {
            "Content-Type": "text/html",
            "Set-Cookie": "cf_clearance=abc123; Path=/"
        });
        res.end(HTML);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address();
    const { session } = immediateSession();
    try {
        await session.fetch(`http://127.0.0.1:${port}/one`);
        await session.fetch(`http://127.0.0.1:${port}/two`);
        assert.equal(seen[0], "");
        assert.match(seen[1], /cf_clearance=abc123/);
        assert.equal(session.browserLaunches, 0);
    } finally {
        await session.close();
        await new Promise((resolve) => server.close(resolve));
    }
});

test("a 403 backs off once and then aborts without a retry loop", async () => {
    const client = scriptedClient([
        { status: 403, data: "<html>Just a moment</html>" },
        { status: 403, data: "<html>Just a moment</html>" },
        { status: 403, data: "<html>Just a moment</html>" },
        { status: 403, data: "<html>Just a moment</html>" },
        { status: 403, data: "<html>Just a moment</html>" }
    ]);
    let browserGoes = 0;
    const { session, sleeps } = immediateSession({
        client,
        browserFactory: async () => ({
            browser: {},
            context: {},
            page: {
                async goto() {
                    browserGoes += 1;
                    return { status: () => 403 };
                },
                async content() { return "<html>Just a moment</html>"; }
            }
        })
    });

    const error = await bindKanRun(() => session.fetch(PAGE)).catch((caught) => caught);
    assert.ok(error instanceof KanBlockedError);
    assert.equal(error.code, "BLOCKED");
    assert.match(error.message, /BLOCKED/);
    assert.match(error.message, /403/);
    assert.match(error.message, /p-11766/);
    assert.equal(client.calls.length, 1);
    assert.equal(browserGoes, 1);
    assert.equal(session.browserLaunches, 1);
    assert.equal(getKanRunState(), null);
    assert.ok(sleeps.every((ms) => ms < 20000));
    assert.equal(sleeps.filter((ms) => ms >= 8000).length, 2);
    await session.close();
});

test("a terminal 403 is recorded on the scraper run that made the request", async () => {
    const client = scriptedClient([{ status: 403, data: "Sorry, you have been blocked" }]);
    const { session } = immediateSession({
        client,
        browserFactory: async () => ({
            browser: {},
            context: {},
            page: {
                async goto() { return { status: () => 403 }; },
                async content() { return "Sorry, you have been blocked"; }
            }
        })
    });

    let seen = null;
    await bindKanRun(async () => {
        await session.fetch(PAGE).catch(() => {});
        seen = { ...getKanRunState() };
    });
    assert.equal(seen.blocked, true);
    assert.equal(seen.http403, 1);
    assert.match(seen.reason, /403/);
    await session.close();
});

test("an interstitial is logged as a Cloudflare challenge", async () => {
    const client = scriptedClient([{ status: 403, data: "<html>Just a moment</html>" }]);
    const { session } = immediateSession({
        client,
        browserFactory: async () => ({
            browser: {},
            context: {},
            page: {
                async goto() { return { status: () => 403 }; },
                async content() { return "<html><title>Just a moment...</title></html>"; }
            }
        })
    });
    let seen = null;
    await bindKanRun(async () => {
        const error = await session.fetch(PAGE).catch((caught) => caught);
        seen = { error, state: { ...getKanRunState() } };
    });
    assert.match(seen.error.message, /CLOUDFLARE CHALLENGE/);
    assert.match(seen.error.message, /BLOCKED/);
    assert.equal(seen.state.challenge, true);
    assert.match(seen.state.reason, /CLOUDFLARE CHALLENGE/);
    await session.close();
});

test("a missing browser is not reported as a Cloudflare challenge", async () => {
    const client = scriptedClient([{ status: 403, data: "<html>Just a moment</html>" }]);
    const { session } = immediateSession({
        client,
        browserFactory: async () => {
            throw new Error("browserType.launch: Executable doesn't exist at C:\\Windows\\System32\\config\\systemprofile\\AppData\\Local\\ms-playwright\\chromium-1200\\chrome-win64\\chrome.exe");
        }
    });
    let seen = null;
    await bindKanRun(async () => {
        const error = await session.fetch(PAGE).catch((caught) => caught);
        seen = { error, state: { ...getKanRunState() } };
    });
    assert.equal(seen.error.code, "BROWSER");
    assert.match(seen.error.message, /KAN BROWSER UNAVAILABLE/);
    assert.doesNotMatch(seen.error.message, /CLOUDFLARE CHALLENGE/);
    assert.notEqual(seen.state.blocked, true);
    await session.close();
});

test("the process exposes one shared Kan session", async () => {
    const first = getKanSession();
    const second = getKanSession();
    assert.equal(first, second);
    await closeKanSession();
    assert.notEqual(getKanSession(), first);
    await closeKanSession();
});
