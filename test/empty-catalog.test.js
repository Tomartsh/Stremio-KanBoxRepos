process.env.CATALOG_GATE_OFFLINE = "1";

const test = require("node:test");
const assert = require("node:assert/strict");
const BaseScraper = require("../classes/BaseScraper");
const { KanBlockedError, bindKanRun, getKanRunState } = require("../classes/kanSession");

class ProbeScraper extends BaseScraper {
    constructor(work) {
        super("Probe", { exportFilename: "stremio-probe", databaseKey: "probe" });
        this.work = work;
        this.published = false;
    }

    async crawlContent() {
        await this.work();
    }

    writeJSON() {
        this.published = true;
    }

    async updateDatabase() {
        this.published = true;
    }
}

test("a scrape that finds nothing is not published", async () => {
    const scraper = new ProbeScraper(async () => {});
    await scraper.crawl(true, "full");
    assert.equal(scraper.published, false);
});

test("a scrape that throws is not published, even if it already collected series", async () => {
    const scraper = new ProbeScraper(async function () {
        this.addToJsonObject("id1", "שם", "https://example.test/show", "", "", [], [], "8", "Podcasts");
        throw new Error("lobby blocked");
    });
    await scraper.crawl(true, "full");
    assert.equal(scraper.published, false);
    assert.equal(Object.keys(scraper.getJsonObject()).length, 1);
});

test("a scrape that collected series is published", async () => {
    const scraper = new ProbeScraper(async function () {
        this.addToJsonObject("id1", "שם", "https://example.test/show", "", "", [], [], "8", "Podcasts");
    });
    await scraper.crawl(true, "full");
    assert.equal(scraper.published, true);
});

function withVideos(count) {
    return new Array(count).fill({ id: "episode" });
}

test("a higher series count with fewer videos is not published", async () => {
    const scraper = new ProbeScraper(async function () {
        this.addToJsonObject("id1", "ארכיון", "https://www.kan.org.il/show", "", "", [], withVideos(1568), "a", "series");
    });
    scraper.previousCountsOverride = { series: 40, videos: 2168 };
    const outcome = await scraper.crawl(true, "full");
    assert.equal(scraper.published, false);
    assert.equal(outcome.published, false);
    assert.equal(outcome.blocked, false);
    assert.match(outcome.line, /1568/);
    assert.match(outcome.line, /2168/);
    assert.match(outcome.line, /85%/);
    assert.match(outcome.line, /left unchanged/);
});

test("a catalog that keeps at least 85% of the videos is published", async () => {
    const scraper = new ProbeScraper(async function () {
        this.addToJsonObject("id1", "ארכיון", "https://www.kan.org.il/show", "", "", [], withVideos(1900), "a", "series");
    });
    scraper.previousCountsOverride = { series: 40, videos: 2168 };
    const outcome = await scraper.crawl(true, "full");
    assert.equal(outcome.published, true);
    assert.equal(scraper.published, true);
});

test("a Cloudflare 403 is marked BLOCKED and is not published", async () => {
    const scraper = new ProbeScraper(async function () {
        this.addToJsonObject("id1", "ארכיון", "https://www.kan.org.il/show", "", "", [], withVideos(2168), "a", "series");
        throw new KanBlockedError(
            "BLOCKED kan.org.il HTTP 403 after one backoff: https://www.kan.org.il/content/kan/kan-11/p-11766/?page=1&itemsToShow=1000"
        );
    });
    scraper.previousCountsOverride = { series: 40, videos: 2168 };
    const outcome = await scraper.crawl(true, "full");
    assert.equal(scraper.published, false);
    assert.equal(outcome.blocked, true);
    assert.equal(outcome.status, "BLOCKED");
    assert.match(outcome.line, /^BLOCKED /);
    assert.match(outcome.line, /403/);
    assert.match(outcome.line, /left unchanged/);
});

test("a 403 recorded on the run is not published even when the scrape returns", async () => {
    const scraper = new ProbeScraper(async function () {
        this.addToJsonObject("id1", "ארכיון", "https://www.kan.org.il/show", "", "", [], withVideos(2168), "a", "series");
        const state = getKanRunState();
        state.blocked = true;
        state.http403 = 1;
        state.reason = "HTTP 403 from Cloudflare on https://www.kan.org.il/lobby/series/";
    });
    scraper.previousCountsOverride = { series: 40, videos: 2168 };
    const outcome = await scraper.crawl(true, "full");
    assert.equal(outcome.blocked, true);
    assert.equal(scraper.published, false);
    assert.match(outcome.line, /^BLOCKED /);
});

test("a blocked Kan page stops the rest of the batch", async () => {
    const scraper = new ProbeScraper(async () => {});
    let calls = 0;
    await assert.rejects(
        () => bindKanRun(() => scraper.processBatch([1, 2, 3], async () => {
            calls += 1;
            const state = getKanRunState();
            state.blocked = true;
            state.reason = "BLOCKED test";
            throw new KanBlockedError("BLOCKED test");
        })),
        (error) => error.code === "BLOCKED"
    );
    assert.equal(calls, 1);
});
