const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");
const { getImageFromUrl } = require("../classes/utilities");
const { HINUKHIT } = require("../classes/constants");
const {
    parseEducationalSeriesPage,
    assignEducationalEpisodeNumbers,
    collectEducationalEpisodes,
    parseKanBoxCategorySeries,
    streamFromKanDocument
} = require("../classes/ScraperHelpers");
const KanKidsScraper = require("../classes/KanKidsScraper");

const fixtureDir = path.join(__dirname, "fixtures/kankids");

function readFixture(name) {
    return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

const TEENS_ROOT = "https://www.kankids.org.il/content/kids/hinuchit-main/p-863865/?currentPage=2&itemsToShow=500";
const TEENS_S1 = "https://www.kankids.org.il/content/kids/hinuchit-main/p-863865/s1/";
const KIDS_ROOT = "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/?currentPage=2&itemsToShow=100";

test("teens series page reads season tabs and cr-item episodes, not editor picks", () => {
    const html = readFixture("teens-p-863865.html");
    const parsed = parseEducationalSeriesPage(html, TEENS_ROOT);

    assert.equal(parsed.mode, "program");
    assert.deepEqual(parsed.seasonTabs.map((tab) => tab.season), [2, 1]);
    assert.equal(parsed.seasonTabs[0].active, true);
    assert.deepEqual(parsed.seasonUrlsToFetch, [
        "https://www.kankids.org.il/content/kids/hinuchit-main/p-863865/s1/"
    ]);
    assert.equal(parsed.episodes.length, 21);
    assert.equal(parse(html).querySelectorAll("li.border-item").length > 0, true);
    assert.equal(parsed.episodes.some((episode) => episode.url.includes("studio_amtzia")), false);

    assert.equal(parsed.episodes[0].season, 2);
    assert.equal(parsed.episodes[0].title, "פרק 1 - הכיף האחרון בחופש");
    assert.equal(parsed.episodes[0].url, "https://www.kankids.org.il/content/kids/hinuchit-main/p-863865/s2/1088640/");
    assert.match(parsed.episodes[0].description, /משפחה חדשה/);
    assert.equal(
        getImageFromUrl(parsed.episodes[0].image, "n"),
        "https://www.kankids.org.il/media/qssgkp1o/שכונת-חיים-2-פרק-1.jpg"
    );
    assert.equal(parsed.episodes[20].title, "חזרנו לשכונה!");
    assert.equal(parsed.episodes[20].url, "https://www.kankids.org.il/content/kids/hinuchit-main/p-863865/s2/1087683/");

    const fromDoc = parseEducationalSeriesPage(parse(html), TEENS_ROOT);
    assert.equal(fromDoc.episodes.length, parsed.episodes.length);
});

test("collecting a teens series follows the other season tab", async () => {
    const episodes = await collectEducationalEpisodes(
        readFixture("teens-p-863865.html"),
        TEENS_ROOT,
        async (url) => {
            assert.equal(url, TEENS_S1);
            return readFixture("teens-p-863865-s1.html");
        }
    );
    const season2 = episodes.filter((episode) => episode.season === 2);
    const season1 = episodes.filter((episode) => episode.season === 1);
    assert.equal(season2.length, 21);
    assert.equal(season1.length, 23);
    assert.equal(season2[0].episodeNo, 1);
    assert.equal(season2[0].title, "פרק 1 - הכיף האחרון בחופש");
    assert.equal(season2[20].episodeNo, 21);
    assert.equal(season1[0].episodeNo, 1);
    assert.equal(season1[0].title, "פרק 1 - כמו פעם");
    assert.equal(season1[0].url, "https://www.kankids.org.il/content/kids/hinuchit-main/p-863865/s1/870313/");
    assert.equal(season1[22].episodeNo, 23);
    assert.equal(season1[22].title, "שיר הנושא 🎵");
});

test("a season page does not fetch itself again", () => {
    const parsed = parseEducationalSeriesPage(readFixture("teens-p-863865-s1.html"), TEENS_S1);
    assert.equal(parsed.episodes.length, 23);
    assert.equal(parsed.episodes.every((episode) => episode.season === 1), true);
    assert.deepEqual(parsed.seasonUrlsToFetch, [
        "https://www.kankids.org.il/content/kids/hinuchit-main/p-863865/s2/"
    ]);
});

test("kids series with no season tabs is one season of cr-item cards", () => {
    const parsed = parseEducationalSeriesPage(readFixture("kids-p-11732.html"), KIDS_ROOT);
    assert.equal(parsed.mode, "program");
    assert.equal(parsed.seasonTabs.length, 0);
    assert.deepEqual(parsed.seasonUrlsToFetch, []);
    assert.equal(parsed.episodes.length, 50);
    assert.equal(parsed.episodes.every((episode) => episode.season === 1), true);
    assert.equal(parsed.episodes[0].title, "הנבואה התלויה | פרק 1");
    assert.equal(parsed.episodes[0].url, "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100071/");
    assert.equal(parsed.episodes[49].title, "מי בחר את הקלף | פרק 50");
    assert.equal(parsed.episodes[49].url, "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100625/");
    assert.equal(parse(readFixture("kids-p-11732.html")).querySelectorAll("li.border-item").length > 0, true);
});

test("a full 50-card row keeps episodes from the next page and stops when it repeats", async () => {
    function row(ids) {
        const cards = ids.map((id, index) => {
            return `<a class="cr-item" href="/content/kids/ktantanim-main/p-1/s1/${id}/" aria-label="פרק ${index + 1}"><p class="cr-subtitle">d</p></a>`;
        }).join("");
        return `<div id="program-episodes" data-season-id="1">${cards}</div>`;
    }
    const firstIds = Array.from({ length: 50 }, (_, index) => 1000 + index);
    const calls = [];
    const episodes = await collectEducationalEpisodes(row(firstIds), KIDS_ROOT, async (url) => {
        calls.push(url);
        if (url.includes("currentPage=3")) return row([2000, 2001]);
        return row(firstIds);
    });
    assert.equal(episodes.length, 52);
    assert.equal(episodes[0].episodeNo, 1);
    assert.equal(episodes[49].episodeNo, 50);
    assert.equal(episodes[50].url.endsWith("/s1/2000/"), true);
    assert.equal(episodes[51].episodeNo, 52);
    assert.equal(calls.some((url) => url.includes("page=2")), false);

    const repeatCalls = [];
    const same = await collectEducationalEpisodes(row(firstIds), KIDS_ROOT, async (url) => {
        repeatCalls.push(url);
        return row(firstIds);
    });
    assert.equal(same.length, 50);
    assert.equal(repeatCalls.some((url) => url.includes("currentPage=3")), true);
    assert.equal(repeatCalls.some((url) => url.includes("page=2")), true);
});

test("legacy seasons-item cards stay the fallback and keep the old numbering", () => {
    const html = `
        <div class="seasons-item kids">
            <ul>
                <li class="border-item">
                    <a class="card-link" href="/content/kids/hinuchit-main/p-50/s2/10/" title="סדרה | פרק ראשון">
                        <img class="img-full" src="/media/a.jpg?width=10">
                        <div class="card-text">תיאור ראשון</div>
                    </a>
                </li>
                <li class="border-item">
                    <a class="card-link" href="/content/kids/hinuchit-main/p-50/s2/11/" title="פרק שני">
                        <img class="img-full" src="/media/b.jpg">
                        <div class="card-text">תיאור שני</div>
                    </a>
                </li>
            </ul>
        </div>
        <div class="seasons-item kids">
            <ul>
                <li class="border-item">
                    <a class="card-link" href="https://www.kankids.org.il/content/kids/hinuchit-main/p-50/s1/1/" title="עונה 1 | פתיחה">
                        <img class="img-full" src="/media/c.jpg?x=1">
                        <div class="card-text">ישן</div>
                    </a>
                </li>
            </ul>
        </div>
        <li class="border-item">
            <a class="card-link" href="/content/kids/hinuchit-main/p-9/s1/3/" title="לא בעונה">
                <div class="card-text">מחוץ לעונה</div>
            </a>
        </li>`;
    const parsed = parseEducationalSeriesPage(html, "https://www.kankids.org.il/content/kids/hinuchit-main/p-50/");
    assert.equal(parsed.mode, "legacy");
    assert.equal(parsed.episodes.length, 3);
    assert.equal(parsed.episodes[0].season, 2);
    assert.equal(parsed.episodes[0].title, "פרק ראשון");
    assert.equal(parsed.episodes[0].description, "תיאור ראשון");
    assert.equal(parsed.episodes[0].image, "/media/a.jpg?width=10");
    assert.equal(parsed.episodes[1].season, 2);
    assert.equal(parsed.episodes[1].title, "פרק שני");
    assert.equal(parsed.episodes[1].image, "");
    assert.equal(parsed.episodes[2].season, 1);
    assert.equal(parsed.episodes[2].title, "פתיחה");
    assert.deepEqual(parsed.seasonUrlsToFetch, []);

    const numbered = assignEducationalEpisodeNumbers(parsed.episodes);
    assert.equal(numbered.find((episode) => episode.url.endsWith("/s2/10/")).episodeNo, 1);
    assert.equal(numbered.find((episode) => episode.url.endsWith("/s2/11/")).episodeNo, 2);
    assert.equal(numbered.find((episode) => episode.url.endsWith("/s1/1/")).episodeNo, 1);
});

test("program cards win when a legacy season block is also on the page", () => {
    const parsed = parseEducationalSeriesPage(`
        <div id="program-episodes">
            <a class="cr-item" href="/content/kids/hinuchit-main/p-50/s2/10/" aria-label="פרק 1 - חדש">
                <p class="cr-subtitle">חדש</p>
            </a>
        </div>
        <div class="seasons-item kids">
            <li class="border-item">
                <a class="card-link" href="/content/kids/hinuchit-main/p-50/s1/1/" title="ישן">
                    <div class="card-text">ישן</div>
                </a>
            </li>
        </div>
    `, "https://www.kankids.org.il/content/kids/hinuchit-main/p-50/");
    assert.equal(parsed.mode, "program");
    assert.equal(parsed.episodes.length, 1);
    assert.equal(parsed.episodes[0].title, "פרק 1 - חדש");
    assert.equal(parsed.episodes[0].season, 2);
});

test("no season tab and no /sN/ is a single season", () => {
    const parsed = parseEducationalSeriesPage(`
        <div id="program-episodes">
            <a class="cr-item" href="/content/kids/ktantanim-main/show/12/" aria-label="פרק בודד">
                <p class="cr-subtitle">תיאור</p>
            </a>
        </div>
    `, "https://www.kankids.org.il/content/kids/ktantanim-main/show/");
    assert.equal(parsed.seasonTabs.length, 0);
    assert.equal(parsed.episodes.length, 1);
    assert.equal(parsed.episodes[0].season, 1);
    assert.equal(parsed.episodes[0].title, "פרק בודד");
});

test("Kan-Box category lookup uses the content row and falls back to block-list", () => {
    const lobby = fs.readFileSync(path.join(__dirname, "fixtures/kandigital/lobby-raw.html"), "utf8");
    const series = parseKanBoxCategorySeries(lobby, HINUKHIT.KAN_BOX_CATEGORY);
    assert.deepEqual(series, [
        "https://www.kankids.org.il/content/kids/hinuchit-main/p-863865/",
        "https://www.kankids.org.il/content/kids/hinuchit-main/saving_the_pets/",
        "https://www.kankids.org.il/content/kids/hinuchit-main/p-1001668/",
        "https://www.kankids.org.il/content/kids/hinuchit-main/malon_hotel/"
    ]);
    const drama = parseKanBoxCategorySeries(lobby, "דרמה");
    assert.equal(drama.some((url) => url.includes("/p-1033206/")), true);
    assert.equal(drama.some((url) => url.includes("kankids.org.il")), false);
    assert.equal(series.some((url) => url.includes("/p-1033206/")), false);
    assert.equal(parseKanBoxCategorySeries(lobby, "אין קטגוריה כזו").length, 0);

    const episodeRow = parseKanBoxCategorySeries(`
        <section class="content-row-section">
            <div class="component-header"><h2>ילדים ונוער</h2></div>
            <a class="cr-item" href="/content/kids/hinuchit-main/p-863865/s2/1088640/">פרק</a>
            <a class="cr-item" href="https://www.kan.org.il/participants/someone/">משתתף</a>
        </section>
    `, HINUKHIT.KAN_BOX_CATEGORY);
    assert.deepEqual(episodeRow, [
        "https://www.kan.org.il/content/kids/hinuchit-main/p-863865/"
    ]);

    const legacy = parseKanBoxCategorySeries(`
        <div class="block-list">
            <div class="block-list-item">
                <h3 class="h3 title-elem">ילדים ונוער</h3>
                <a class="unstyled-link" href="/lobby/kids/">קטגוריה</a>
                <a class="card-link" href="/content/kids/hinuchit-main/p-10/">אחת</a>
                <a class="card-link" href="https://www.kankids.org.il/content/kids/hinuchit-main/p-11/s2/99/">שתיים</a>
            </div>
            <div class="block-list-item">
                <h3 class="h3 title-elem">דרמה</h3>
                <a class="card-link" href="/content/kan/kan-11/p-3/">לא</a>
            </div>
        </div>
    `, HINUKHIT.KAN_BOX_CATEGORY);
    assert.deepEqual(legacy, [
        "https://www.kan.org.il/content/kids/hinuchit-main/p-10/",
        "https://www.kankids.org.il/content/kids/hinuchit-main/p-11/s2/99/"
    ]);
});

test("episode page still resolves a stream from VideoObject when redge has no data-hls-url", () => {
    const doc = parse(readFixture("episode-p-11732-100071.html"));
    assert.equal(doc.querySelector("[id^='redge-player-']").getAttribute("data-hls-url"), undefined);
    const stream = streamFromKanDocument(doc);
    assert.equal(
        stream.url,
        "https://r.il.cdn-redge.media/webcache/gorigin/hls/oil/kancdn/vod/1_uwr9q6sg/LIBCODER_SMOOTH_1080_KAN/Manifest.ism/playlist.m3u8?fmp4"
    );
    assert.equal(stream.type, "series");
    assert.match(stream.description, /דיקו מנחש/);
});

test("kids video object keeps seriesId:season:episode and the published fields", async () => {
    const scraper = new KanKidsScraper();
    scraper.getStreams = async () => ({
        url: "https://cdn.example/stream.m3u8",
        type: "series",
        name: "פרק",
        description: "זרם",
        released: "2023-04-22T21:58:36.000Z"
    });
    const videos = [];
    await scraper.processOneKidsEpisode({
        url: "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100071/",
        title: "הנבואה התלויה | פרק 1",
        description: "דיקו מנחש תוצאת חיבור של מספרים אקראיים שבחרו הילדים",
        image: "/media/yufmrhlv/2019-2-25-imgid-5344_b.jpeg?width=490&height=272",
        season: 1,
        episodeNo: 1
    }, "il_kan_kids_11732", "k", videos);

    assert.equal(videos.length, 1);
    assert.equal(videos[0].id, "il_kan_kids_11732:1:1");
    assert.equal(videos[0].name, "הנבואה התלויה | פרק 1");
    assert.equal(videos[0].season, 1);
    assert.equal(videos[0].episode, 1);
    assert.equal(videos[0].description, "דיקו מנחש תוצאת חיבור של מספרים אקראיים שבחרו הילדים");
    assert.equal(videos[0].thumbnail, "https://www.kankids.org.il/media/yufmrhlv/2019-2-25-imgid-5344_b.jpeg");
    assert.equal(videos[0].episodeLink, "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100071/");
    assert.equal(videos[0].released, "2023-04-22T21:58:36.000Z");
    assert.equal(videos[0].streams.length, 1);
    assert.equal(videos[0].streams[0].url, "https://cdn.example/stream.m3u8");
});
