const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");
const { getNameFromSeriesPage } = require("../classes/utilities");
const { streamFromKanDocument, extractVideoObjectUrl } = require("../classes/ScraperHelpers");
const {
    parseArchiveIndex,
    parseSeriesMeta,
    parseSeriesPage,
    seasonUrlsToFetch,
    numberDigitalEpisodes,
    videoFromEpisodeCard
} = require("../classes/kanDigitalParse");

const fixtureDir = path.join(__dirname, "fixtures/kanarchive");

function readFixture(name) {
    return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

test("archive index names come from the poster alt and skip non-archive cards", () => {
    const series = parseArchiveIndex(readFixture("index-cards.html"));
    const vod = series.filter((item) => /\/archive1\/vod\/p-\d+\/$/.test(item.url));

    assert.equal(series.length, 173);
    assert.equal(vod.length, 168);
    assert.ok(series.every((item) => item.name && item.name.trim()));
    assert.ok(series.every((item) => item.image.startsWith("https://www.kan.org.il/") && !item.image.includes("?")));
    assert.equal(series.some((item) => item.url.includes("/lobby/series/")), false);
    assert.equal(series.some((item) => item.name.includes(".כאן")), false);

    const known = series.find((item) => item.url.endsWith("/p-1084497/"));
    assert.equal(known.name, "החמישייה הקאמרית");
    assert.ok(known.description.length > 0);
});

test("a relative archive card is joined to the site origin", () => {
    const series = parseArchiveIndex(`
        <a class="card-link" href="/content/archive1/vod/p-42/">
            <img class="img-full" alt="שם נקי" title="שם נקי.כאן ארכיון" src="/media/poster.jpg">
            <h3>טקסט כרטיס</h3>
        </a>
        <a class="card-link" href="/content/kan/kan-11/p-9/">
            <img class="img-full" alt="לא ארכיון" src="/media/x.jpg">
        </a>
        <a class="card-link" href="/content/archive1/vod/p-42/">
            <img alt="שם נקי" src="/media/poster.jpg">
        </a>
    `);
    assert.equal(series.length, 1);
    assert.equal(series[0].url, "https://www.kan.org.il/content/archive1/vod/p-42/");
    assert.equal(series[0].name, "שם נקי");
    assert.equal(series[0].image, "https://www.kan.org.il/media/poster.jpg");
    assert.equal(series[0].description, "טקסט כרטיס");
});

test("archive series pages reuse the digital episode cards, including the opener", () => {
    const cases = [
        {
            file: "series-p-670875.html",
            url: "https://www.kan.org.il/content/archive1/vod/p-670875/",
            name: "אשכרה",
            episodes: 7,
            numberedEpisodes: 6,
            seasons: 0
        },
        {
            file: "series-p-1084497.html",
            url: "https://www.kan.org.il/content/archive1/vod/p-1084497/",
            name: "החמישייה הקאמרית",
            episodes: 14,
            numberedEpisodes: 13,
            seasons: 5
        },
        {
            file: "series-p-670692.html",
            url: "https://www.kan.org.il/content/archive1/vod/p-670692/",
            name: "סמי וסוסו",
            episodes: 18,
            numberedEpisodes: 17,
            seasons: 0
        }
    ];

    for (const item of cases) {
        const html = readFixture(item.file);
        const doc = parse(html);
        assert.equal(doc.querySelectorAll("a.btn.with-arrow.info-link.btn-gradient").length, 0, item.file);
        assert.equal(doc.querySelectorAll("div.seasons-item").length, 0, item.file);
        assert.equal(doc.querySelectorAll("a.card-link").length, 0, item.file);

        const meta = parseSeriesMeta(html);
        assert.equal(getNameFromSeriesPage(meta.title), item.name, item.file);
        assert.ok(meta.description.length > 0, item.file);
        assert.ok(meta.genres.includes("ארכיון"), item.file);

        const parsed = parseSeriesPage(html, item.url);
        assert.equal(parsed.episodes.length, item.episodes, item.file);
        assert.equal(parsed.seasonUrls.length, item.seasons, item.file);
        assert.equal(parsed.movieUrl, null, item.file);
        assert.equal(parsed.episodes.some((episode) => episode.url.includes("/participants/")), false, item.file);
        assert.ok(parsed.episodes.every((episode) => episode.image.startsWith("https://www.kan.org.il/") && !episode.image.includes("?")), item.file);

        const numbered = numberDigitalEpisodes(parsed.episodes);
        const opener = numbered.find((episode) => episode.episodeNo === 0);
        assert.ok(opener, item.file);
        assert.equal(opener.season, 1, item.file);
        assert.match(opener.title, /פתיח/, item.file);
        assert.equal(numbered.filter((episode) => episode.episodeNo > 0).length, item.numberedEpisodes, item.file);
        assert.equal(seasonUrlsToFetch(html, item.url, parsed).length, item.seasons, item.file);

        const video = videoFromEpisodeCard(numbered.find((episode) => episode.episodeNo > 0), "il_kan_archive_1");
        assert.equal(video.streams.length, 0, item.file);
        assert.ok(video.thumbnail, item.file);
        assert.equal(Object.hasOwn(video, "released"), false, item.file);
    }
});

test("archive season numbers stay on the /sN/ path when the subtitle names another season", () => {
    const url = "https://www.kan.org.il/content/archive1/vod/p-1084497/";
    const parsed = parseSeriesPage(readFixture("series-p-1084497.html"), url);
    const numbered = numberDigitalEpisodes(parsed.episodes);
    const first = numbered.find((episode) => episode.url.endsWith("/s1/1098316/"));
    assert.equal(first.season, 1);
    assert.equal(first.episodeNo, 1);
    assert.match(first.subtitle, /עונה 5,\s*פרק 1/);
    assert.deepEqual(
        parsed.seasonUrls,
        [1, 2, 3, 4, 5].map((season) => `https://www.kan.org.il/content/archive1/vod/p-1084497/s${season}/`)
    );
});

test("an archive episode page stream is the VideoObject contentUrl", () => {
    const html = readFixture("episode-674967.html");
    const doc = parse(html);
    const player = doc.querySelector("[id^='redge-player-']");
    assert.ok(player);
    assert.equal(player.getAttribute("data-hls-url"), undefined);

    const stream = streamFromKanDocument(doc);
    assert.equal(
        stream.url,
        "https://r.il.cdn-redge.media/webcache/gorigin/hls/oil/kancdn/vod/1_p6baqsnx/LIBCODER_SMOOTH_1080_KAN/Manifest.ism/playlist.m3u8?fmp4"
    );
    // data-date-utc is interpreted in the machine timezone. It must be the
    // 1987 air date, not the 2024 JSON-LD uploadDate.
    assert.equal(stream.released, new Date("1987-12-16T22:00:00").toISOString());
    assert.match(stream.released, /^1987-12-1[67]T/);
    assert.equal(extractVideoObjectUrl('{"contentUrl":"https://cdn.example/a.m3u8"}'), "https://cdn.example/a.m3u8");
});
