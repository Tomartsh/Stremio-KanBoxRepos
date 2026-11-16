const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");
const {
    extractLobbySeries,
    applySeriesPoster
} = require("../classes/ScraperHelpers");
const { getImageFromUrl, setGenreFromString, generateSeriesId } = require("../classes/utilities");
const { HINUKHIT } = require("../classes/constants");
const KanKidsScraper = require("../classes/KanKidsScraper");
const KanTeensScraper = require("../classes/KanTeensScraper");
const {
    resetKanSitemapCache,
    ROBOTS_URL,
    DEFAULT_INDEX_URL
} = require("../classes/KanSitemap");

const fixtureDir = path.join(__dirname, "fixtures/kankids");
const LOBBY_PART = "https://www.kan.org.il/media/sitemap/kids/sitemap-lobby.xml";

const LOBBY_SITEMAP = `<?xml version="1.0" encoding="utf-8"?>
<urlset>
  <url><loc>https://www.kankids.org.il/content/kids/hinuchit-main/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/hinuchit-main/the_serials/s2/1088640/</loc></url>
  <url><loc>https://www.kankids.org.il/kids/content/kids/hinuchit-main/concert/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/hinuchit-main/p-11917/s10/500010/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/hinuchit-main/p-11917/s9/500009/</loc></url>
  <url><loc>https://www.kan.org.il/content/kids/hinuchit-main/saving_the_pets/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/ktantanim-main/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/ktantanim-main/bluey/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/s1/135116/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100071/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/ktantanim-main/p-762163/762173/</loc></url>
  <url><loc>https://www.kankids.org.il/content/kids/kids-podcasts/p-432148/1/</loc></url>
</urlset>`;

function readFixture(name) {
    return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

function quietLogger() {
    return { warn() {}, info() {}, debug() {}, error() {} };
}

function lobbySitemapOptions(xml) {
    return {
        retries: 0,
        retryDelayMs: 0,
        fileDelayMs: 0,
        timeoutMs: 1000,
        logger: quietLogger(),
        fetchText: async (url) => {
            const parsed = new URL(url);
            if (parsed.pathname === "/robots.txt" || url === ROBOTS_URL) {
                return `Sitemap: ${DEFAULT_INDEX_URL}\n`;
            }
            if (parsed.pathname.endsWith("/siteindex.xml")) {
                return `<?xml version="1.0"?><sitemapindex><sitemap><loc>${LOBBY_PART}</loc></sitemap></sitemapindex>`;
            }
            if (parsed.pathname.endsWith("/sitemap-lobby.xml")) return xml;
            throw new Error("unexpected " + url);
        }
    };
}

function seriesDocument(image) {
    return `<!DOCTYPE html><html lang="he" dir="rtl"><head>
        <title>כאן חינוכית | בלואי - פרקים מלאים לצפייה ישירה</title>
        <meta name="description" content="בלואי והמשפחה">
        <meta property="og:image" content="${image}">
        </head><body>
        <div id="program-episodes">
          <a class="cr-item" href="/content/kids/ktantanim-main/bluey/1/" aria-label="פרק 1">
            <h3 class="cr-title">פרק 1</h3>
            <p class="cr-subtitle">תיאור הפרק</p>
          </a>
        </div>
        </body></html>`;
}

test("kids lobby JSON is read from the historical script slot", () => {
    const scripts = [0, 1, 2, 3].map(n => `<script>var unused${n} = 1;</script>`).join("");
    const html = `<div class="umb-block-list"><div>${scripts}
        <script>var payload = [{"Url":"/content/kids/bluey","Image":"/bluey.jpg","Genres":"קטנטנים"}];</script>
    </div></div>`;
    const series = extractLobbySeries(parse(html));
    assert.equal(series.length, 1);
    assert.equal(series[0].Url, "/content/kids/bluey");
});

test("kids lobby JSON is still found when it is not script index 4", () => {
    const html = `<div><script>var shows = [{"Url":"/only-show","Image":"/a.jpg"}];</script></div>`;
    const series = extractLobbySeries(parse(html));
    assert.equal(series[0].Url, "/only-show");
});

test("a missing lobby document fails instead of publishing an empty catalog", () => {
    assert.throws(() => extractLobbySeries(null), /did not load/);
    assert.throws(() => extractLobbySeries(parse("<html><body>no series</body></html>")), /series list/);
});

test("embedded lobby JSON still wins over the grid and the sitemap", () => {
    let calls = 0;
    const html = `<div class="umb-block-list"><div>
        <script></script><script></script><script></script><script></script>
        <script>var payload = [{"Url":"/content/kids/bluey","Image":"/bluey.jpg","Genres":"קטנטנים"}];</script>
        </div></div>
        <section class="content-grid-section"><div class="cr-grid"><div class="cr-grid-item">
            <a class="cr-item" href="/content/kids/ktantanim-main/other/" aria-label="אחר"><h3 class="cr-title">אחר</h3></a>
        </div></div></section>`;
    const series = extractLobbySeries(parse(html), {
        sectionPrefix: HINUKHIT.SECTION_KIDS,
        fetchText: async () => {
            calls += 1;
            throw new Error("sitemap should not be read");
        }
    });
    assert.ok(Array.isArray(series));
    assert.equal(series.length, 1);
    assert.equal(series[0].Url, "/content/kids/bluey");
    assert.equal(calls, 0);
});

describe("redesigned kids and teens lobbies", { concurrency: false }, () => {
    test("teens and tiny grids merge with the kids sitemap by series URL", async () => {
        resetKanSitemapCache();
        const options = lobbySitemapOptions(LOBBY_SITEMAP);
        const teens = await extractLobbySeries(parse(readFixture("lobby-teens.html")), Object.assign({
            sectionPrefix: HINUKHIT.SECTION_TEENS
        }, options));
        assert.deepEqual(teens.map((series) => series.Url), [
            "https://www.kankids.org.il/content/kids/hinuchit-main/the_serials/",
            "https://www.kankids.org.il/content/kids/hinuchit-main/concert/",
            "https://www.kankids.org.il/content/kids/hinuchit-main/p-11917/",
            "https://www.kankids.org.il/content/kids/hinuchit-main/saving_the_pets/",
            "https://www.kankids.org.il/content/kids/hinuchit-main/malon_hotel/"
        ]);
        assert.deepEqual(teens.map((series) => [series.Name, series.Image, series.Genres]), [
            ["הסדרתיים", "/media/the-serials.jpg", []],
            ["המדריך לתזמורת", "/media/concert.jpg", []],
            ["גלילאו", "", []],
            ["", "", []],
            ["מלון הוטל", "/media/hotel.jpg", []]
        ]);
        assert.equal(teens.some((series) => series.Name === "לא מהגריד"), false);
        assert.equal(teens.some((series) => series.Name === "פוסטר"), false);
        assert.equal(teens.some((series) => series.Name === "כותרת אחרת"), false);
        assert.equal(generateSeriesId(teens[0].Url, "teens"), "il_kan_teens_the_serials");
        assert.equal(generateSeriesId(teens[2].Url, "teens"), "il_kan_teens_11917");
        assert.equal(generateSeriesId(teens[3].Url, "teens"), "il_kan_teens_saving_the_pets");

        const kids = await extractLobbySeries(parse(readFixture("lobby-tiny.html")), Object.assign({
            sectionPrefix: HINUKHIT.SECTION_KIDS
        }, options));
        assert.deepEqual(kids.map((series) => series.Url), [
            "https://www.kankids.org.il/content/kids/ktantanim-main/bluey/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/p-762163/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/charlie_and_lola/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/tamaris_garden/"
        ]);
        assert.equal(kids[0].Name, "בלואי");
        assert.equal(kids[0].Image, "/media/bluey.jpg");
        assert.equal(kids[1].Name, "פרפר נחמד");
        assert.equal(kids[1].Image, "/media/parpar.jpg");
        assert.equal(kids[2].Name, "בית ספר לקוסמים");
        assert.equal(kids[3].Name, "");
        assert.equal(kids[3].Image, "");
        assert.equal(kids[5].Name, "הגינה של תמרי");
        assert.equal(kids[5].Image, "");
        assert.equal(kids.every((series) => Array.isArray(series.Genres) && series.Genres.length === 0), true);
        assert.equal(kids.some((series) => /hinuchit-main|kids-podcasts/.test(series.Url)), false);
        assert.equal(generateSeriesId(kids[0].Url, "kids"), "il_kan_kids_bluey");
        assert.equal(generateSeriesId(kids[2].Url, "kids"), "il_kan_kids_11732");
    });

    test("a lobby with neither sitemap series nor grid cards still fails", async () => {
        resetKanSitemapCache();
        const onlyOtherSection = `<?xml version="1.0"?><urlset>
            <url><loc>https://www.kankids.org.il/content/kids/hinuchit-main/</loc></url>
            <url><loc>https://www.kankids.org.il/content/kids/kids-podcasts/p-432148/1/</loc></url>
        </urlset>`;
        await assert.rejects(
            () => extractLobbySeries(parse("<html><body><p>empty</p></body></html>"), Object.assign({
                sectionPrefix: HINUKHIT.SECTION_TEENS
            }, lobbySitemapOptions(onlyOtherSection))),
            /series list/
        );
    });

    test("grid cards remain when the kids sitemap cannot be read", async () => {
        resetKanSitemapCache();
        const series = await extractLobbySeries(parse(readFixture("lobby-tiny.html")), {
            sectionPrefix: HINUKHIT.SECTION_KIDS,
            retries: 0,
            retryDelayMs: 0,
            fileDelayMs: 0,
            timeoutMs: 50,
            logger: quietLogger(),
            fetchText: async () => {
                throw new Error("down");
            }
        });
        assert.deepEqual(series.map((item) => item.Url), [
            "https://www.kankids.org.il/content/kids/ktantanim-main/bluey/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/charlie_and_lola/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/tamaris_garden/"
        ]);
        assert.equal(series.some((item) => item.Url.endsWith("/p-762163/")), false);
    });
});

test("setGenreFromString accepts a missing value, a string, or an array", () => {
    assert.equal(setGenreFromString(undefined), "Kan");
    assert.equal(setGenreFromString(null), "Kan");
    assert.equal(setGenreFromString(""), "Kan");
    assert.deepEqual(setGenreFromString([]), []);
    assert.deepEqual(setGenreFromString("דרמה|קומדיה"), ["Drama", "דרמה", "Comedy", "קומדיה"]);
    assert.deepEqual(setGenreFromString("ילדים ונוער, קטנטנים"), ["Kids", "ילדים ונוער", "קטנטנים"]);
    assert.deepEqual(setGenreFromString(["דרמה"]), ["Drama", "דרמה"]);
    assert.equal(getImageFromUrl(undefined, "k"), "");
    assert.equal(getImageFromUrl(null, "n"), "");
    assert.equal(getImageFromUrl("/media/bluey.jpg", "k"), "https://www.kankids.org.il/media/bluey.jpg");
});

test("a series page og:image fills a blank lobby poster and is ignored when the lobby has one", () => {
    const page = parse(seriesDocument("https://www.kan.org.il/media/bluey-poster.jpg"));
    assert.equal(
        applySeriesPoster("", page, "k"),
        "https://www.kan.org.il/media/bluey-poster.jpg"
    );
    assert.equal(
        applySeriesPoster("/media/lobby.jpg", page, "k"),
        "https://www.kankids.org.il/media/lobby.jpg"
    );
    const logo = parse(seriesDocument("https://www.kankids.org.il/media/brandlogo.svg"));
    assert.equal(applySeriesPoster(undefined, logo, "n"), "");
    assert.equal(applySeriesPoster(undefined, null, "k"), "");
});

test("kids and teens series pages supply og:image without changing the series id", async () => {
    const html = seriesDocument("https://www.kan.org.il/media/bluey-poster.jpg");
    const kids = new KanKidsScraper();
    kids.fetchCatalogDocument = async () => ({ doc: parse(html) });
    kids.fetchEducationalDocument = async () => {
        throw new Error("unexpected extra fetch");
    };
    kids.resolveEpisodeStreams = async () => ({ url: "https://cdn.example/bluey.m3u8", released: "" });
    const kidsResult = await kids.processOneKidsSeries({
        Url: "https://www.kankids.org.il/content/kids/ktantanim-main/bluey/",
        Name: "בלואי"
    }, "k");
    assert.equal(kidsResult.id, "il_kan_kids_bluey");
    assert.equal(kids.getJsonObject()[kidsResult.id].meta.poster, "https://www.kan.org.il/media/bluey-poster.jpg");
    assert.equal(kids.getJsonObject()[kidsResult.id].meta.genres, "Kan");
    assert.equal(kids.getJsonObject()[kidsResult.id].link, "https://www.kankids.org.il/content/kids/ktantanim-main/bluey/");

    const teensHtml = html
        .replaceAll("/content/kids/ktantanim-main/bluey/1/", "/content/kids/hinuchit-main/the_serials/1/")
        .replace("בלואי - פרקים מלאים לצפייה ישירה", "הסדרתיים - פרקים מלאים לצפייה ישירה")
        .replace("https://www.kan.org.il/media/bluey-poster.jpg", "https://www.kan.org.il/media/serials-poster.jpg");
    const teens = new KanTeensScraper();
    teens.fetchCatalogDocument = async () => ({ doc: parse(teensHtml) });
    teens.fetchEducationalDocument = async () => {
        throw new Error("unexpected extra fetch");
    };
    teens.resolveEpisodeStreams = async () => ({ url: "https://cdn.example/serials.m3u8", released: "" });
    const teensResult = await teens.processOneTeensSeries({
        Url: "https://www.kankids.org.il/content/kids/hinuchit-main/the_serials/",
        Name: "הסדרתיים",
        Image: "",
        Genres: []
    }, "n");
    assert.equal(teensResult.id, "il_kan_teens_the_serials");
    assert.equal(teens.getJsonObject()[teensResult.id].meta.poster, "https://www.kan.org.il/media/serials-poster.jpg");
    assert.deepEqual(teens.getJsonObject()[teensResult.id].meta.genres, []);
});
