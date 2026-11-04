const test = require("node:test");
const assert = require("node:assert/strict");
const BaseScraper = require("../classes/BaseScraper");
const KanKidsScraper = require("../classes/KanKidsScraper");
const KanTeensScraper = require("../classes/KanTeensScraper");

class RecordingScraper extends BaseScraper {
    constructor(work) {
        super("KanKids", { exportFilename: "stremio-kankids", databaseKey: "kankids" });
        this.work = work;
        this.published = false;
        this.lockEnabled = false;
    }

    async crawlContent() {
        await this.work.call(this);
    }

    writeJSON() {
        this.published = true;
    }

    async updateDatabase() {
        this.published = true;
    }
}

function videos(id, count) {
    return Array.from({ length: count }, (_, index) => ({
        id: `${id}:${index}`,
        name: `פרק ${index + 1}`,
        description: "תיאור",
        episodeLink: `https://www.kankids.org.il/content/kids/${id}/${index}/`
    }));
}

function series(id, name, link, count) {
    return {
        id,
        name,
        link,
        meta: {
            id,
            name,
            link,
            videos: videos(id, count)
        }
    };
}

test("a null series document does not crash title parsing", () => {
    assert.equal(new KanKidsScraper().getEducationalTitle(null), "");
    assert.equal(new KanTeensScraper().getEducationalTitle(undefined), "");
});

test("a timed-out series keeps the published episodes and its published id", async () => {
    const bluey = "https://www.kankids.org.il/content/kids/ktantanim-main/bluey/";
    const parpar = "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/";
    const data = {
        il_kan_kids_1020: series("il_kan_kids_1020", "בלואי", bluey, 8),
        il_kan_kids_1021: series("il_kan_kids_1021", "פרפר נחמד", parpar, 8)
    };
    const scraper = new RecordingScraper(async function () {
        const id = this.seriesIdFor(bluey, "kids", "בלואי");
        assert.equal(id, "il_kan_kids_1020");
        this.addToJsonObject(id, "בלואי", bluey, "", "תיאור", [], videos(id, 8), "k", "series");
        this.noteFailedSeries({
            id: this.seriesIdFor(parpar, "kids", "פרפר נחמד"),
            link: parpar,
            name: "פרפר נחמד"
        });
    });
    scraper.previousCatalogOverride = { root: { data }, data };
    scraper.previousCatalogRemote = false;

    const outcome = await scraper.crawl(false, "full");
    const json = scraper.getJsonObject();
    assert.equal(outcome.published, true);
    assert.equal(scraper.published, true);
    assert.equal(json.il_kan_kids_1020.meta.videos.length, 8);
    assert.equal(json.il_kan_kids_1021.meta.videos.length, 8);
    assert.equal(json.il_kan_kids_1021.meta.videos[0].id, "il_kan_kids_1021:0");
    assert.equal(json.il_kan_kids_parpar_nehmad, undefined);
    assert.equal(json.il_kan_kids_bluey, undefined);
});

test("a listing timeout keeps the previous catalog instead of publishing nothing", async () => {
    const data = {
        il_kan_teens_1000: series(
            "il_kan_teens_1000",
            "הסדרתיים",
            "https://www.kankids.org.il/content/kids/hinuchit-main/the_serials/",
            6
        ),
        il_kan_teens_1001: series(
            "il_kan_teens_1001",
            "הסדרתיים - כל השירים",
            "https://www.kankids.org.il/content/kids/hinuchit-main/the_serials_songs/",
            6
        )
    };
    const scraper = new RecordingScraper(async function () {
        this.noteListingIncomplete("https://www.kankids.org.il/lobby-kids/kids-teens");
    });
    scraper.previousCatalogOverride = { data };
    scraper.previousCatalogRemote = false;

    const outcome = await scraper.crawl(false, "full");
    const json = scraper.getJsonObject();
    assert.equal(outcome.published, true);
    assert.equal(json.il_kan_teens_1000.meta.videos.length, 6);
    assert.equal(json.il_kan_teens_1001.meta.videos.length, 6);
});
