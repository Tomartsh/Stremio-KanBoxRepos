const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");
const {
    readLastPageNumber,
    pageUrls,
    collectCards,
    parseSeriesCard,
    parseEpisodeCard
} = require("../classes/kan88Parse");

const lobby = parse(fs.readFileSync(path.join(__dirname, "fixtures/kan88-lobby.html"), "utf8"));

test("Kan 88 lobby fixture has both pages of series cards", () => {
    assert.equal(readLastPageNumber(lobby), 2);
    assert.equal(collectCards(lobby).length, 8);
    const urls = pageUrls("https://www.kan.org.il/content/kan/podcasts/kan88/", 2);
    assert.deepEqual(urls, [
        "https://www.kan.org.il/content/kan/podcasts/kan88/",
        "https://www.kan.org.il/content/kan/podcasts/kan88/?page=2"
    ]);

    const first = parseSeriesCard(collectCards(lobby)[0]);
    assert.equal(first.title, "זהב שחור - ההסכת");
    assert.match(first.link, /\/kan88\/zahavshachor\/$/);
    assert.match(first.imageSrc, /זהב-שחור/);
    assert.match(first.description, /היפ הופ/);
});

test("a series page with no Last page control is one page", () => {
    const html = `
        <div class="card card-row">
            <a class="card-img card-media" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/886976/">
                <img class="img-full" src="/media/madonna.jpg?width=10" title="מדונה.כאן">
            </a>
            <a class="card-body" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/886976/">
                <h3 class="card-title">מדונה | פרק 4</h3>
                <div class="description">פרק ארבע</div>
            </a>
        </div>
        <div class="card card-row">
            <a class="card-body" href="https://www.kan.org.il/content/kan/podcasts/kan88/madonna/1/">
                <h3 class="card-title">פרק 1: התחלה</h3>
                <div class="description">ראשון</div>
            </a>
            <time datetime="2024-01-02T00:00:00Z"></time>
        </div>`;
    const doc = parse(html);
    assert.equal(readLastPageNumber(doc), 1);
    assert.equal(pageUrls("https://example/series/", 1).length, 1);
    const episodes = collectCards(doc).map(parseEpisodeCard);
    assert.equal(episodes[0].title, "מדונה | פרק 4");
    assert.equal(episodes[0].episodeLink, "https://www.kan.org.il/content/kan/podcasts/kan88/madonna/886976/");
    assert.equal(episodes[1].title, "התחלה");
    assert.equal(episodes[1].released, "2024-01-02T00:00:00.000Z");
});

test("missing lobby document does not throw while reading the page count", () => {
    assert.equal(readLastPageNumber(null), 1);
    assert.equal(collectCards(null).length, 0);
});
