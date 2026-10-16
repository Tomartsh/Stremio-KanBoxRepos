const test = require("node:test");
const assert = require("node:assert/strict");
const {
    KanSession,
    KanBlockedError,
    KanBudgetError,
    bindKanRun,
    getKanRunState
} = require("../classes/kanSession");
const { resolvePacing } = require("../classes/pacing");
const { decidePublish } = require("../classes/catalogGate");
const BaseScraper = require("../classes/BaseScraper");

const PAGE = "https://www.kan.org.il/content/kan/kan-11/p-11766/?page=1&itemsToShow=1000";
const NEXT = "https://www.kan.org.il/content/kan/kan-11/p-11766/?page=2&itemsToShow=1000";
const LATER = "https://www.kan.org.il/lobby/kan11";
const HTML = "<html><body><h1>כאן 11</h1><p>catalog page with enough markup to count as the site.</p></body></html>";

function scriptedClient(responses) {
    const calls = [];
    return {
        calls,
        async get(url) {
            calls.push(url);
            const next = responses.shift();
            if (typeof next === "function") return next(url);
            return next;
        }
    };
}

function timedSession(extra = {}) {
    const sleeps = [];
    const session = new KanSession({
        random: () => 0,
        sleep: (ms) => new Promise((resolve) => {
            sleeps.push(ms);
            setTimeout(resolve, ms);
        }),
        ...extra
    });
    return { session, sleeps };
}

function browser(pages) {
    const gotos = [];
    return {
        gotos,
        async factory() {
            return {
                browser: { async close() {} },
                context: { async close() {}, async addCookies() {} },
                page: {
                    async goto(url) {
                        gotos.push(url);
                        const next = pages[gotos.length - 1] || {};
                        return { status: () => next.status || 200 };
                    },
                    async content() {
                        const next = pages[gotos.length - 1] || {};
                        return next.content == null ? HTML : next.content;
                    },
                    async close() {}
                }
            };
        }
    };
}

async function drain(t) {
    for (let i = 0; i < 30; i++) {
        for (let step = 0; step < 8; step++) await Promise.resolve();
        t.mock.timers.runAll();
    }
}

const FAST_SLOW = {
    slow: true,
    governHttp: false,
    minIntervalMs: 0,
    requestDelayMinMs: 0,
    requestDelayMaxMs: 0,
    pauseEveryPages: 0,
    pauseMinMs: 0,
    pauseMaxMs: 0,
    blockBackoffMinMs: 60 * 60 * 1000,
    blockBackoffMaxMs: 90 * 60 * 1000,
    budgetMs: 20 * 60 * 60 * 1000,
    maxRetries: null,
    maxPerMinute: null
};

test("kanDigital's configured delay is the gap between requests", { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pacing = resolvePacing("kanDigital", {}, {});
    const client = scriptedClient([{ status: 200, data: HTML }]);
    const { session, sleeps } = timedSession({ client });
    const pending = bindKanRun(() => session.fetch(PAGE), pacing);
    await drain(t);
    const doc = await pending;
    assert.equal(typeof doc.querySelector, "function");
    assert.equal(sleeps[0], 45000);
    assert.equal(sleeps.length, 1);
    const state = getKanRunState();
    assert.equal(state, null);
    await session.close();
});

test("a 403 waits out the backoff and resumes the same page", { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const client = scriptedClient([
        { status: 200, data: HTML },
        { status: 403, data: "<html>Just a moment</html>" }
    ]);
    const pages = [{ status: 200 }, { status: 200 }];
    const fakeBrowser = browser(pages);
    const { session, sleeps } = timedSession({
        client,
        browserFactory: () => fakeBrowser.factory()
    });

    let seen = null;
    const pending = bindKanRun(async () => {
        await session.fetch(LATER);
        await session.fetch(PAGE);
        await session.fetch(NEXT);
        seen = {
            blocked: getKanRunState().blocked,
            pages: getKanRunState().pages,
            progress: getKanRunState().progress.map((event) => event.type)
        };
    }, FAST_SLOW);

    await drain(t);
    await pending;

    assert.deepEqual(client.calls, [LATER, PAGE]);
    assert.deepEqual(fakeBrowser.gotos, [PAGE, NEXT]);
    assert.equal(sleeps.filter((ms) => ms >= 60 * 60 * 1000).length, 1);
    assert.equal(seen.blocked, false);
    assert.equal(seen.pages, 3);
    assert.ok(seen.progress.includes("page"));
    assert.ok(seen.progress.includes("block"));
    assert.ok(seen.progress.includes("sleep"));
    await session.close();
});

test("a pause is inserted every N completed pages", { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pacing = {
        ...FAST_SLOW,
        pauseEveryPages: 2,
        pauseMinMs: 10 * 60 * 1000,
        pauseMaxMs: 20 * 60 * 1000
    };
    const client = scriptedClient([
        { status: 200, data: HTML },
        { status: 200, data: HTML },
        { status: 200, data: HTML }
    ]);
    const { session, sleeps } = timedSession({ client });
    const pending = bindKanRun(async () => {
        await session.fetch("https://www.kan.org.il/a");
        await session.fetch("https://www.kan.org.il/b");
        await session.fetch("https://www.kan.org.il/c");
        return getKanRunState().progress.filter((event) => event.type === "page").map((event) => event.pages);
    }, pacing);

    await drain(t);
    const pages = await pending;
    assert.deepEqual(pages, [1, 2, 3]);
    assert.deepEqual(sleeps, [pacing.pauseMinMs]);
    await session.close();
});

test("a 403 gives up only when the time budget cannot cover the next wait", { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pacing = {
        ...FAST_SLOW,
        budgetMs: 30 * 60 * 1000
    };
    const client = scriptedClient([
        { status: 403, data: "Sorry, you have been blocked" },
        { status: 200, data: HTML }
    ]);
    const { session, sleeps } = timedSession({ client });
    const error = await bindKanRun(() => session.fetch(PAGE), pacing).catch((caught) => caught);
    assert.ok(error instanceof KanBudgetError);
    assert.equal(error.code, "BUDGET");
    assert.match(error.message, /time budget exhausted/);
    assert.equal(client.calls.length, 1);
    assert.ok(sleeps.every((ms) => ms < 60 * 60 * 1000));
    const decision = decidePublish({
        scraperName: "KanDigital",
        exportFilename: "stremio-kandigital",
        scrapeError: error,
        counts: { series: 40, videos: 2168 },
        previous: { series: 40, videos: 2168 },
        catalogComplete: true
    });
    assert.equal(decision.published, false);
    assert.equal(decision.status, "BUDGET");
    await session.close();
});

test("slow mode still aborts after maxRetries when that limit is set", { timeout: 5000 }, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
    const pacing = {
        ...FAST_SLOW,
        maxRetries: 1,
        blockBackoffMinMs: 1000,
        blockBackoffMaxMs: 1000
    };
    const client = scriptedClient([{ status: 403, data: "blocked" }]);
    const fakeBrowser = browser([{ status: 403, content: "blocked" }]);
    const { session } = timedSession({
        client,
        browserFactory: () => fakeBrowser.factory()
    });
    const pending = bindKanRun(() => session.fetch(PAGE), pacing).catch((caught) => caught);
    await drain(t);
    const error = await pending;
    assert.ok(error instanceof KanBlockedError);
    assert.equal(error.code, "BLOCKED");
    assert.equal(fakeBrowser.gotos.length, 1);
    await session.close();
});

class BudgetProbe extends BaseScraper {
    constructor() {
        super("Probe", { exportFilename: "stremio-probe", databaseKey: "probe" });
        this.published = false;
    }

    async crawlContent() {
        this.addToJsonObject("id1", "ארכיון", "https://www.kan.org.il/show", "", "", [], new Array(2168).fill({ id: "v" }), "d", "series");
        throw new KanBudgetError("time budget exhausted during 403 backoff, then resume this page");
    }

    writeJSON() {
        this.published = true;
    }

    async updateDatabase() {
        this.published = true;
    }
}

test("a scraper that exhausts its budget does not publish", async () => {
    const scraper = new BudgetProbe();
    scraper.previousCountsOverride = { series: 40, videos: 2168 };
    const outcome = await scraper.crawl(true, "full");
    assert.equal(scraper.published, false);
    assert.equal(outcome.published, false);
    assert.equal(outcome.blocked, false);
    assert.equal(outcome.status, "BUDGET");
    assert.match(outcome.line, /left unchanged/);
});
