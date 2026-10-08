const test = require("node:test");
const assert = require("node:assert/strict");
const BaseScraper = require("../classes/BaseScraper");

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
