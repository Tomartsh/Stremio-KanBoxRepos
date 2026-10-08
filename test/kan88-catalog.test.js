const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");
const Kan88Scraper = require("../classes/Kan88Scraper");

const SERIES_PAGE = `
    <div class="card card-row">
        <a class="card-body" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/886976/">
            <h3 class="card-title">מדונה | פרק 4</h3>
            <div class="description">אחרון</div>
        </a>
    </div>
    <div class="card card-row">
        <a class="card-body" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/2/">
            <h3 class="card-title">מדונה | פרק 2</h3>
            <div class="description">שני</div>
        </a>
    </div>`;

const LOBBY_CARD = `
    <div class="card card-row">
        <a class="card-img card-media" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/">
            <img class="img-full" src="/media/madonna.jpg?width=10" alt="מדונה" title="מדונה - השנים הראשונות.כאן">
        </a>
        <a class="card-body" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/">
            <h3 class="card-title">מדונה - השנים הראשונות</h3>
            <div class="description">מיני סדרה</div>
        </a>
    </div>`;

test("a Kan 88 series is stored with the addon catalog subtype and its episodes", async () => {
    const scraper = new Kan88Scraper();
    scraper.fetchKanPage = async () => parse(SERIES_PAGE);
    const card = parse(LOBBY_CARD).querySelector("div.card.card-row");

    const result = await scraper.processOnePodcast(card);
    const series = Object.values(scraper.getJsonObject());

    assert.equal(series.length, 1);
    assert.equal(series[0].subtype, "8");
    assert.equal(series[0].type, "Podcasts");
    assert.equal(series[0].name, "מדונה - השנים הראשונות");
    assert.equal(series[0].meta.videos.length, 2);
    assert.equal(series[0].meta.videos[0].episode, 2);
    assert.match(series[0].meta.videos[0].episodeLink, /886976/);
    assert.equal(result.episodeCount, 2);
});

test("episode page 2 is requested, not skipped by the old continue", async () => {
    const scraper = new Kan88Scraper();
    const requested = [];
    const page1 = parse(`
        <li class="pagination-page__item" data-num="2" title="Last page"></li>
        <div class="card card-row">
            <a class="card-body" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/9/">
                <h3 class="card-title">פרק 9</h3>
                <div class="description"></div>
            </a>
        </div>`);
    const page2 = parse(`
        <div class="card card-row">
            <a class="card-body" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/1/">
                <h3 class="card-title">פרק 1</h3>
                <div class="description"></div>
            </a>
        </div>`);
    scraper.fetchKanPage = async (url) => {
        requested.push(url);
        return String(url).includes("page=2") ? page2 : page1;
    };

    const count = await scraper.getpodcastEpisodeVideos(
        "https://www.kan.org.il/content/kan/podcasts/kan88/madonna/",
        "il_kan_kan88_1"
    );

    assert.deepEqual(requested, [
        "https://www.kan.org.il/content/kan/podcasts/kan88/madonna/",
        "https://www.kan.org.il/content/kan/podcasts/kan88/madonna/?page=2"
    ]);
    assert.equal(count, 2);
});

test("a lobby page that does not load aborts before any series are saved", async () => {
    const scraper = new Kan88Scraper();
    const lobby = parse(fs.readFileSync(path.join(__dirname, "fixtures/kan88-lobby.html"), "utf8"));
    scraper.fetchKanPage = async (url) => String(url).includes("page=2") ? null : lobby;

    await assert.rejects(() => scraper.crawlKan88(), /lobby page 2/);
    assert.equal(Object.keys(scraper.getJsonObject()).length, 0);
});
