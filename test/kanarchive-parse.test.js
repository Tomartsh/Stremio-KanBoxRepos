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
    videoFromEpisodeCard,
    archiveSeriesId,
    normalizeCatalogUrl,
    pickSeriesTitle,
    isValidSeriesTitle
} = require("../classes/kanDigitalParse");
const { chooseVideoObject } = require("../classes/ScraperHelpers");

const fixtureDir = path.join(__dirname, "fixtures/kanarchive");

function readFixture(name) {
    return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

test("archive index names come from the poster alt and skip non-archive cards", () => {
    const series = parseArchiveIndex(readFixture("index-cards.html"));
    const vod = series.filter((item) => /\/archive1\/vod\/p-\d+\/$/.test(item.url));

    assert.equal(series.length, 173);
    assert.equal(vod.length, 168);
    assert.ok(series.filter((item) => item.name && item.name.trim()).length >= 155);
    assert.ok(series.every((item) => item.image.startsWith("https://www.kan.org.il/") && !item.image.includes("?")));
    assert.equal(series.some((item) => item.url.includes("/lobby/series/")), false);
    assert.equal(series.some((item) => item.name.includes(".כאן") || item.name.includes(".ארכיון")), false);
    assert.equal(series.some((item) => /poster image small/i.test(item.name)), false);
    assert.equal(series.some((item) => item.name === "כאן ארכיון"), false);

    const known = series.find((item) => item.url.endsWith("/p-1084497/"));
    assert.equal(known.name, "החמישייה הקאמרית");
    assert.ok(known.description.length > 0);
    assert.equal(series.find((item) => item.url.endsWith("/p-1080443/")).name, "שישי בטברנה");
    assert.equal(series.find((item) => item.url.endsWith("/p-991349/")).name, "איזו דרמה");
    assert.equal(series.find((item) => item.url.endsWith("/p-805958/")).name, "הופכים דף");
    assert.equal(series.find((item) => item.url.endsWith("/p-882497/")).name, "המסעדה הגדולה");
    assert.equal(series.find((item) => item.url.endsWith("/p-781749/")).name, "בערוגות החשק");
    assert.equal(series.find((item) => item.url.endsWith("/p-1097937/")).name, "דרך הודו");
    assert.equal(series.find((item) => item.url.endsWith("/betweenus/")).name, "שיישאר בינינו");
    assert.equal(series.find((item) => item.url.endsWith("/p-872058/")).name, "מסך אישי");
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
    assert.equal(stream.description, "באיזה רגע משתחרר הסכר ומתחילים לדבר? האם בחוויית לימודים משותפת? בנסיעה ארוכה או בהמתנה ללידה?");
    assert.equal(stream.thumbnail, "https://www.kan.org.il/media/y1tfjj0r/ashkara08.jpg");
    // data-date-utc is interpreted in the machine timezone. It must be the
    // 1987 air date, not the 2024 JSON-LD uploadDate.
    assert.equal(stream.released, new Date("1987-12-16T22:00:00").toISOString());
    assert.match(stream.released, /^1987-12-1[67]T/);
    assert.equal(extractVideoObjectUrl('{"contentUrl":"https://cdn.example/a.m3u8"}'), "https://cdn.example/a.m3u8");

    const emptyInfo = parse(`
        <title>פרק 6 - לא לבדו</title>
        <div class="info-description">   </div>
        <script type="application/ld+json">
        {"@graph":[
            {"@type":"VideoObject","name":"פרומו","description":"פרומו","contentUrl":"https://cdn.example/shared.m3u8"},
            {"@type":"VideoObject","name":"פרק 6 - לא לבדו","description":"תיאור הפרק","thumbnailUrl":"/media/ep6.jpg","contentUrl":"https://cdn.example/ep6.m3u8"}
        ]}
        </script>
    `);
    const chosen = streamFromKanDocument(emptyInfo);
    assert.equal(chosen.url, "https://cdn.example/ep6.m3u8");
    assert.equal(chosen.description, "תיאור הפרק");
    assert.equal(chosen.thumbnail, "https://www.kan.org.il/media/ep6.jpg");
    assert.equal(chooseVideoObject([
        { contentUrl: "https://cdn.example/shared.m3u8", name: "פרומו" },
        { contentUrl: "https://cdn.example/ep6.m3u8", name: "פרק 6 - לא לבדו" }
    ], "פרק 6 - לא לבדו").contentUrl, "https://cdn.example/ep6.m3u8");

    const infoWins = streamFromKanDocument(parse(`
        <div class="info-description">תקציר מהעמוד</div>
        <script type="application/ld+json">{"@type":"VideoObject","name":"פרק","description":"מה-JSON","contentUrl":"https://cdn.example/a.m3u8"}</script>
    `));
    assert.equal(infoWins.description, "תקציר מהעמוד");
});

test("Hebrew season folders are episodes, and the season page is fetched", () => {
    const url = "https://www.kan.org.il/content/archive1/vod/p-1034432/";
    const html = `
        <a class="cr-item" href="https://www.kan.org.il/content/archive1/vod/p-1034432/1047958/">
            <h3 class="cr-title">צימרים | פתיח</h3>
        </a>
        <a class="card-link" href="https://www.kan.org.il/content/archive1/vod/p-1034432/עונה-2/">
            <div class="card-title">עונה 2</div>
        </a>
        <a href="https://www.kan.org.il/content/archive1/vod/p-1034432/%D7%A2%D7%95%D7%A0%D7%94-1/">עונה 1</a>
        <a class="cr-item" href="/content/archive1/vod/p-1034432/עונה-2/1046567/">
            <h3 class="cr-title">פרק 3</h3>
            <p class="cr-subtitle">עונה 2, פרק 3</p>
            <p class="cr-description">שלושה אורחים בצימר</p>
        </a>
        <a href="https://www.kan.org.il/content/archive1/vod/p-872058/עונה-1-מסך-אישי/">מסך</a>
        <a class="cr-item" href="https://www.kan.org.il/content/archive1/vod/p-1009727/היום-זה-אנחנו-פרקים-מלאים/1/">
            <h3 class="cr-title">פרק 1</h3>
        </a>
    `;
    const parsed = parseSeriesPage(html, url);
    assert.equal(parsed.movieUrl, null);
    assert.equal(parsed.episodes.some((episode) => episode.url.endsWith("/עונה-2/")), false);
    const opener = parsed.episodes.find((episode) => episode.url.endsWith("/1047958/"));
    const episode = parsed.episodes.find((episode) => episode.url.endsWith("/1046567/"));
    assert.equal(opener.season, 0);
    assert.equal(episode.season, 2);
    assert.equal(episode.description, "שלושה אורחים בצימר");
    assert.equal(episode.url, "https://www.kan.org.il/content/archive1/vod/p-1034432/עונה-2/1046567/");
    assert.deepEqual(parsed.seasonUrls, [
        "https://www.kan.org.il/content/archive1/vod/p-1034432/עונה-1/",
        "https://www.kan.org.il/content/archive1/vod/p-1034432/עונה-2/"
    ]);
    assert.deepEqual(seasonUrlsToFetch(html, url, parsed), parsed.seasonUrls);

    const personal = parseSeriesPage(`
        <a href="https://www.kan.org.il/content/archive1/vod/p-872058/עונה-1-מסך-אישי/">עונה 1</a>
        <a class="cr-item" href="https://www.kan.org.il/content/archive1/vod/p-872058/עונה-1-מסך-אישי/874518/">
            <h3 class="cr-title">פרק 4</h3>
        </a>
    `, "https://www.kan.org.il/content/archive1/vod/p-872058/");
    assert.equal(personal.episodes[0].season, 1);
    assert.equal(personal.seasonUrls[0], "https://www.kan.org.il/content/archive1/vod/p-872058/עונה-1-מסך-אישי/");
    assert.equal(personal.movieUrl, null);

    const numbered = numberDigitalEpisodes(parsed.episodes.filter((item) => item.url.includes("/p-1034432/")));
    assert.equal(numbered.find((item) => item.url.endsWith("/1047958/")).episodeNo, 0);
    assert.equal(numbered.find((item) => item.url.endsWith("/1046567/")).episodeNo, 3);
    const opening = numberDigitalEpisodes([
        { url: "https://www.kan.org.il/content/archive1/vod/p-1/1/", title: "תוכנית 15 - פתיחת עונת הרחצה", season: 0 },
        { url: "https://www.kan.org.il/content/archive1/vod/p-1/2/", title: "ממני | פתיח", season: 0 }
    ]);
    assert.equal(opening.find((item) => item.url.endsWith("/1/")).episodeNo, 15);
    assert.equal(opening.find((item) => item.url.endsWith("/2/")).episodeNo, 0);
});

test("flat archive episodes get distinct ids, including several opening cards", () => {
    const episodes = [];
    for (let n = 1; n <= 24; n++) {
        episodes.push({
            url: `https://www.kan.org.il/content/archive1/vod/p-751520/${730000 + n}/`,
            title: `סרט ${n}`,
            season: 0
        });
    }
    episodes.push({
        url: "https://www.kan.org.il/content/archive1/vod/p-751520/1/",
        title: "סרטי תעודה | פתיח",
        season: 0
    });
    episodes.push({
        url: "https://www.kan.org.il/content/archive1/vod/p-751520/2/",
        title: "עוד פתיח",
        season: 0
    });
    const numbered = numberDigitalEpisodes(episodes);
    const ids = numbered.map((episode) => `il_kan_archive_751520:${episode.season}:${episode.episodeNo}`);
    assert.equal(new Set(ids).size, ids.length);
    assert.equal(numbered.filter((episode) => episode.episodeNo === 0).length, 1);
    assert.ok(numbered.every((episode) => episode.season === 1));
});

test("slug series episodes live under /betweenus/sN/ and /קיץ-ביובל/sN/", () => {
    const html = `
        <a href="https://www.kan.org.il/content/archive1/vod/betweenus/s1/">עונה 1</a>
        <a class="cr-item" href="https://www.kan.org.il/content/archive1/vod/betweenus/s1/673834/">
            <h3 class="cr-title">פרק 1</h3>
        </a>
        <a class="cr-item" href="https://www.kan.org.il/content/archive1/vod/%D7%A7%D7%99%D7%A5-%D7%91%D7%99%D7%95%D7%91%D7%9C/s1/776101/">
            <h3 class="cr-title">פרק 2</h3>
        </a>
    `;
    const between = parseSeriesPage(html, "https://www.kan.org.il/content/archive1/vod/betweenus/");
    assert.equal(between.episodes.length, 1);
    assert.equal(between.episodes[0].season, 1);
    assert.equal(between.episodes[0].url, "https://www.kan.org.il/content/archive1/vod/betweenus/s1/673834/");
    assert.deepEqual(between.seasonUrls, ["https://www.kan.org.il/content/archive1/vod/betweenus/s1/"]);
    assert.equal(between.movieUrl, null);
    const kayitz = parseSeriesPage(html, "https://www.kan.org.il/content/archive1/vod/קיץ-ביובל/");
    assert.equal(kayitz.episodes.length, 1);
    assert.equal(kayitz.episodes[0].url, "https://www.kan.org.il/content/archive1/vod/קיץ-ביובל/s1/776101/");

    const onAProgram = parseSeriesPage(html, "https://www.kan.org.il/content/archive1/vod/p-1034432/");
    assert.equal(onAProgram.episodes.length, 0);
    assert.equal(onAProgram.seasonUrls.length, 0);
});

test("slug series keep the published id instead of digits from a percent-encoded name", () => {
    const previous = new Map([
        [normalizeCatalogUrl("https://www.kan.org.il/content/archive1/vod/קיץ-ביובל/"), "il_kan_archive_1035"],
        [normalizeCatalogUrl("https://www.kan.org.il/content/archive1/vod/betweenus/"), "il_kan_archive_1034"]
    ]);
    assert.equal(
        archiveSeriesId("https://www.kan.org.il/content/archive1/vod/%D7%A7%D7%99%D7%A5-%D7%91%D7%99%D7%95%D7%91%D7%9C/", previous),
        "il_kan_archive_1035"
    );
    assert.equal(
        archiveSeriesId("https://www.kan.org.il/content/archive1/vod/betweenus/", previous),
        "il_kan_archive_1034"
    );
    assert.equal(
        archiveSeriesId("https://www.kan.org.il/content/archive1/vod/p-1034432/", previous),
        "il_kan_archive_1034432"
    );
    const fresh = archiveSeriesId("https://www.kan.org.il/content/archive1/vod/brand-new/", null);
    assert.equal(fresh, archiveSeriesId("https://www.kan.org.il/content/archive1/vod/brand-new/", null));
    assert.equal(fresh.startsWith("il_kan_archive_slug_"), true);
    assert.equal(/^\d+$/.test(fresh.split("_").pop()), false);

    const kept = pickSeriesTitle(`<title>כאן ארכיון</title><h1>קהל מוחא כפיים, קיץ ביובל 1998</h1>`, {
        imageAlt: "קהל מוחא כפיים, קיץ ביובל 1998",
        previousName: "קיץ ביובל",
        clean: (value) => value
    });
    assert.equal(kept.title, "קיץ ביובל");
    assert.equal(kept.source, "previous");
    const suffix = pickSeriesTitle("<title>שעת הסין.ארכיון</title>", { clean: (value) => value });
    assert.equal(suffix.title, "שעת הסין");
    const fromPoster = pickSeriesTitle("<title>הופכים דף, ספר פתוח ומנורה על שולחן, 1992</title>", {
        imageAlt: "הופכים דף, ספר פתוח ומנורה על שולחן, 1992",
        posterSrc: "/media/x/poster-image_small_239-x-360י-הופכים-דף_.jpg",
        clean: (value) => value
    });
    assert.equal(fromPoster.title, "הופכים דף");
});
