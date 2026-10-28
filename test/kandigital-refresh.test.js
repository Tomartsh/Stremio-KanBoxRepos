const test = require("node:test");
const assert = require("node:assert/strict");
const KanDigitalScraper = require("../classes/KanDigitalScraper");
const { countCatalog, decidePublish } = require("../classes/catalogGate");

function seriesRow(id, videoCount) {
    return {
        id,
        name: id,
        link: `https://www.kan.org.il/content/kan/kan-11/${id}/`,
        meta: {
            id,
            name: id,
            videos: Array.from({ length: videoCount }, (_, index) => ({
                id: `${id}:${index}`,
                name: `פרק ${index + 1}`,
                season: 1,
                episode: index + 1,
                episodeLink: `https://www.kan.org.il/content/kan/kan-11/p-1/${index}/`,
                released: "2020-01-01T00:00:00.000Z"
            }))
        }
    };
}

test("a kanDigital run starts from the previous catalog and keeps series it does not reach", async () => {
    const data = {};
    for (let index = 0; index < 10; index++) {
        data[`kept-${index}`] = seriesRow(`kept-${index}`, 10);
    }
    const scraper = new KanDigitalScraper();
    scraper.previousCatalogOverride = { data };
    const seeded = await scraper.seedPreviousCatalog();
    assert.equal(seeded, 10);
    assert.equal(Object.keys(scraper.getJsonObject()).length, 10);
    assert.equal(scraper.alreadyHandled("kept-0"), false);

    scraper.addToJsonObject(
        "kept-0",
        "updated",
        data["kept-0"].link,
        "",
        "",
        [],
        data["kept-0"].meta.videos,
        "d",
        "series"
    );
    const catalog = scraper.getJsonObject();
    assert.equal(catalog["kept-0"].name, "updated");
    assert.equal(catalog["kept-9"].meta.videos.length, 10);

    const counts = countCatalog(catalog);
    const decision = decidePublish({
        scraperName: "KanDigital",
        exportFilename: "stremio-kandigital",
        counts,
        previous: countCatalog({ data }),
        catalogComplete: true
    });
    assert.equal(counts.videos, 100);
    assert.equal(decision.published, true);
});

test("unchanged series stay cached except for one rotating slice, and full mode refreshes all", () => {
    const days = 3;
    const ids = ["il_kan_digital_13779", "il_kan_digital_13871", "il_kan_digital_100", "il_kan_digital_200"];
    const start = new Date(Date.UTC(2026, 0, 1));
    for (const id of ids) {
        const dueDays = [];
        for (let offset = 0; offset < days; offset++) {
            const now = new Date(start.getTime() + offset * 86400000);
            if (KanDigitalScraper.seriesDueForRefresh(id, { now, forceRefreshDays: days })) dueDays.push(offset);
        }
        assert.equal(dueDays.length, 1, id);
    }

    const scraper = new KanDigitalScraper();
    scraper.incrementalMode = true;
    scraper.scrapeMode = "incremental";
    const id = "il_kan_digital_13779";
    const quiet = new Date(start.getTime());
    while (KanDigitalScraper.seriesDueForRefresh(id, { now: quiet, forceRefreshDays: days })) {
        quiet.setTime(quiet.getTime() + 86400000);
    }
    scraper.refreshClock = quiet;
    scraper.previousCatalogOverride = {
        data: {
            [id]: seriesRow(id, 4)
        }
    };
    return scraper.seedPreviousCatalog().then(async () => {
        assert.equal(scraper.shouldReuseCachedSeries(id), true);
        const result = await scraper.processOneDigitalSeries({
            Url: "https://www.kan.org.il/content/kan/kan-11/p-13779/",
            Image: "",
            ImageAlt: "",
            Description: ""
        }, "kan11_lobby");
        assert.equal(result.cached, true);
        assert.equal(scraper.getJsonObject()[id].meta.videos.length, 4);
        assert.equal(scraper.alreadyHandled(id), true);

        const due = new Date(quiet.getTime());
        while (!KanDigitalScraper.seriesDueForRefresh(id, { now: due, forceRefreshDays: days })) {
            due.setTime(due.getTime() + 86400000);
        }
        scraper.refreshClock = due;
        assert.equal(scraper.shouldReuseCachedSeries(id), false);

        scraper.incrementalMode = false;
        scraper.scrapeMode = "full";
        scraper.refreshClock = quiet;
        assert.equal(scraper.shouldReuseCachedSeries(id), false);
    });
});

test("kanDigital keeps incremental mode without a scrape-state database", async () => {
    const scraper = new KanDigitalScraper();
    scraper.incrementalMode = true;
    await scraper.initializeStateManager();
    assert.equal(scraper.incrementalMode, true);
});
