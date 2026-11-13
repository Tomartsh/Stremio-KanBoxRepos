const test = require("node:test");
const assert = require("node:assert/strict");
const KanKidsScraper = require("../classes/KanKidsScraper");
const KanTeensScraper = require("../classes/KanTeensScraper");
const { KanSession, KanBlockedError, bindKanRun, getKanRunState } = require("../classes/kanSession");

const HTML = "<html><body><h1>כאן</h1><p>catalog page with enough markup to count as the site.</p></body></html>";
const FAST = {
    slow: false,
    governHttp: false,
    minIntervalMs: 0,
    requestDelayMinMs: 0,
    requestDelayMaxMs: 0,
    pauseEveryPages: 0,
    pauseMinMs: 0,
    pauseMaxMs: 0,
    blockBackoffMinMs: 0,
    blockBackoffMaxMs: 0,
    budgetMs: null,
    maxRetries: 1,
    maxPerMinute: null
};

test("kids and teens use parallel batches of 4 with a pause between batches", () => {
    const kids = new KanKidsScraper();
    const teens = new KanTeensScraper();
    assert.equal(kids.config.parallelFetching, true);
    assert.equal(teens.config.parallelFetching, true);
    assert.equal(kids.config.batchSize, 4);
    assert.equal(teens.config.batchSize, 4);
    assert.equal(kids.config.delayBetweenBatches, 500);
    assert.equal(teens.config.delayBetweenBatches, 500);

    process.env.KAN_KIDS_BATCH_SIZE = "2";
    process.env.KAN_TEENS_BATCH_SIZE = "3";
    try {
        assert.equal(new KanKidsScraper().config.batchSize, 2);
        assert.equal(new KanTeensScraper().config.batchSize, 3);
        process.env.KAN_KIDS_BATCH_SIZE = "0";
        process.env.KAN_TEENS_BATCH_SIZE = "nope";
        assert.equal(new KanKidsScraper().config.batchSize, 4);
        assert.equal(new KanTeensScraper().config.batchSize, 4);
    } finally {
        delete process.env.KAN_KIDS_BATCH_SIZE;
        delete process.env.KAN_TEENS_BATCH_SIZE;
    }
});

test("one episode failure does not fail the kids batch, and a block still does", async () => {
    const scraper = new KanKidsScraper();
    scraper.config.delayBetweenBatches = 0;
    let active = 0;
    let maxActive = 0;
    const results = await scraper.processBatch([1, 2, 3, 4], async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 30));
        active -= 1;
        if (item === 2) throw new Error("episode failed");
        return item;
    }, "kids-episodes");
    assert.equal(maxActive, 4);
    assert.deepEqual(results.filter((item) => item != null), [1, 3, 4]);

    await assert.rejects(
        () => bindKanRun(() => scraper.processBatch([1, 2], async () => {
            throw new KanBlockedError("BLOCKED test");
        })),
        (error) => error && error.code === "BLOCKED"
    );
});

test("parallel episode fetches keep descending episode order", async () => {
    const scraper = new KanKidsScraper();
    scraper.config.delayBetweenBatches = 0;
    scraper.getStreams = async (link) => {
        const episodeNo = link.endsWith("/2/") ? 2 : 1;
        await new Promise((resolve) => setTimeout(resolve, episodeNo === 2 ? 40 : 5));
        return { url: `https://cdn.example/${episodeNo}.m3u8`, type: "series", name: "פרק", description: "" };
    };
    const videos = [];
    await scraper.getKidsVideos([
        { url: "https://www.kankids.org.il/e/1/", title: "פרק 1", season: 1, episodeNo: 1 },
        { url: "https://www.kankids.org.il/e/2/", title: "פרק 2", season: 1, episodeNo: 2 }
    ], "il_kan_kids_x", "k", videos);
    assert.deepEqual(videos.map((video) => video.episode), [2, 1]);
});

function delayedClient(ms) {
    let active = 0;
    let maxActive = 0;
    return {
        maxActive: () => maxActive,
        async get(url) {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise((resolve) => setTimeout(resolve, ms));
            active -= 1;
            if (String(url).includes("bad")) return { status: 500, data: "no" };
            return { status: 200, data: HTML };
        }
    };
}

test("the kan session stays serial unless the run sets a batch width", async () => {
    const serialClient = delayedClient(40);
    const serial = new KanSession({ client: serialClient, snapshotPath: null, random: () => 0 });
    await bindKanRun(() => Promise.all([1, 2, 3].map((n) => serial.fetch(`https://www.kankids.org.il/s${n}`))), FAST);
    assert.equal(serialClient.maxActive(), 1);
    await serial.close();

    const parallelClient = delayedClient(40);
    const parallel = new KanSession({ client: parallelClient, snapshotPath: null, random: () => 0 });
    await bindKanRun(() => {
        getKanRunState().httpConcurrency = 4;
        return Promise.all([1, 2, 3, 4].map((n) => parallel.fetch(`https://www.kankids.org.il/p${n}`)));
    }, FAST);
    assert.equal(parallelClient.maxActive(), 4);
    await parallel.close();
});

test("one kan http failure does not poison the other requests in the batch", async () => {
    const client = delayedClient(10);
    const session = new KanSession({ client, snapshotPath: null, random: () => 0 });
    const settled = await bindKanRun(() => {
        getKanRunState().httpConcurrency = 2;
        return Promise.allSettled([
            session.fetch("https://www.kankids.org.il/bad"),
            session.fetch("https://www.kankids.org.il/good"),
            session.fetch("https://www.kankids.org.il/again")
        ]);
    }, FAST);
    assert.equal(settled[0].status, "rejected");
    assert.equal(settled[1].status, "fulfilled");
    assert.equal(settled[2].status, "fulfilled");
    assert.equal(typeof settled[1].value.querySelector, "function");
    await session.close();
});

test("parallel series insertion keeps lobby order", () => {
    const scraper = new KanKidsScraper();
    scraper.addToJsonObject("z", "קודם", "https://www.kankids.org.il/z", "", "", [], [], "k", "series");
    scraper.addToJsonObject("b", "ב", "https://www.kankids.org.il/b", "", "", [], [], "k", "series");
    scraper.addToJsonObject("a", "א", "https://www.kankids.org.il/a", "", "", [], [], "k", "series");
    scraper.orderJsonByIds(["a", "b"]);
    assert.deepEqual(Object.keys(scraper.getJsonObject()), ["z", "a", "b"]);
});

test("kids and teens runs publish their batch size onto the kan session", async () => {
    const kids = new KanKidsScraper();
    const teens = new KanTeensScraper();
    await bindKanRun(async () => {
        kids.allowParallelKanHttp();
        assert.equal(getKanRunState().httpConcurrency, 4);
    }, FAST);
    await bindKanRun(async () => {
        teens.allowParallelKanHttp();
        assert.equal(getKanRunState().httpConcurrency, 4);
    }, FAST);
});
