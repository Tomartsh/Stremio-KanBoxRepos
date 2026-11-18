const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");
const {
    israelWallTimeToIso,
    releaseDateFromEducationalDocument,
    chooseEducationalReleased,
    seriesLatestEpisodeDate,
    missingReleasedReport
} = require("../classes/educationalRelease");
const { educationalStreamFromDocument } = require("../classes/ScraperHelpers");
const { episodeFieldsFromDocument } = require("../classes/KanSitemap");
const {
    resetKanSitemapCache,
    loadKidsSitemap,
    lastmodForEpisodeUrl,
    lastmodByPathFromXml,
    canonicalKidsPath,
    primeKanSitemapLastmods,
    ROBOTS_URL,
    DEFAULT_INDEX_URL
} = require("../classes/KanSitemap");
const { indexPublishedEpisodeDates } = require("../classes/publishedStreams");
const KanKidsScraper = require("../classes/KanKidsScraper");
const KanTeensScraper = require("../classes/KanTeensScraper");

const fixtureDir = path.join(__dirname, "fixtures/kankids");
const AIR = "2021-06-27T18:00:00.000Z";
const EPISODE_URL = "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100071/";
const STABLE = "https://r.il.cdn-redge.media/webcache/gorigin/hls/oil/kancdn/vod/2244765/LIBCODER_SMOOTH_1080_KAN/Manifest.ism/playlist.m3u8?fmp4";
const SITEMAP_DAY = "2025-09-12T00:00:00.000Z";

function readFixture(name) {
    return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

function airDocument() {
    return parse(readFixture("episode-air-date.html"));
}

test("Israel wall time from date-local is the displayed air date", () => {
    assert.equal(israelWallTimeToIso("27.6.2021 21:00:00"), AIR);
    assert.equal(israelWallTimeToIso("14.12.2020 22:00:00"), "2020-12-14T20:00:00.000Z");
    assert.equal(israelWallTimeToIso("2.8.2018 21:00:00"), "2018-08-02T18:00:00.000Z");
    assert.equal(israelWallTimeToIso("21.10.2018 21:00:00"), "2018-10-21T18:00:00.000Z");
    assert.equal(israelWallTimeToIso(""), "");
});

test("an episode page prefers date-local over uploadDate, JSON-LD datePublished, and og:published_time", () => {
    const doc = airDocument();
    assert.equal(releaseDateFromEducationalDocument(doc), AIR);
    const stream = educationalStreamFromDocument(doc);
    assert.equal(stream.released, AIR);
    assert.match(stream.url, /1_qypcz608/);

    const fields = episodeFieldsFromDocument(readFixture("episode-air-date.html"));
    assert.equal(fields.stream.released, AIR);
    assert.notEqual(fields.stream.released, fields.datePublished);

    const uploadOnly = parse(`
        <html><body>
        <script type="application/ld+json">
        {"@type":"VideoObject","contentUrl":"https://cdn.example/a.m3u8","uploadDate":"2024-06-02T08:00:00Z"}
        </script>
        </body></html>
    `);
    assert.equal(releaseDateFromEducationalDocument(uploadOnly), "2024-06-02T08:00:00.000Z");

    const pageEditOnly = parse(`
        <html><head>
        <meta property="og:published_time" content="2025-09-22T21:07:37Z">
        </head><body><div id="redge-player-1" data-hls-url="https://cdn.example/a.m3u8"></div></body></html>
    `);
    assert.equal(releaseDateFromEducationalDocument(pageEditOnly), "");
    assert.equal(educationalStreamFromDocument(pageEditOnly).released, undefined);
});

test("the fallback chain is page date, carried released, sitemap lastmod, then first-seen", () => {
    const now = "2024-03-01T00:00:00.000Z";
    const published = "2018-10-21T18:00:00.000Z";
    assert.equal(chooseEducationalReleased({
        pageDate: AIR,
        publishedReleased: published,
        sitemapLastmod: SITEMAP_DAY,
        now
    }), AIR);
    assert.equal(chooseEducationalReleased({
        pageDate: "",
        publishedReleased: published,
        sitemapLastmod: SITEMAP_DAY,
        now: "2030-01-01T00:00:00.000Z"
    }), published);
    assert.equal(chooseEducationalReleased({
        pageDate: "",
        publishedReleased: "",
        sitemapLastmod: SITEMAP_DAY,
        now
    }), SITEMAP_DAY);
    assert.equal(chooseEducationalReleased({
        pageDate: "",
        publishedReleased: "",
        sitemapLastmod: "",
        firstSeen: "",
        now
    }), now);
});

test("a first-seen date stays the same on the next run even if sitemap and the clock change", () => {
    const first = chooseEducationalReleased({ now: "2024-03-01T00:00:00.000Z" });
    const second = chooseEducationalReleased({
        publishedReleased: first,
        sitemapLastmod: SITEMAP_DAY,
        now: "2026-11-18T07:32:00.000Z"
    });
    assert.equal(second, first);
    assert.notEqual(second, SITEMAP_DAY);
});

describe("educational dates that share the sitemap cache", { concurrency: false }, () => {

test("sitemap lastmod is stored for slug episodes and date-only values stay on that UTC day", async () => {
    const slug = "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/s2/539852/";
    const xml = `<?xml version="1.0"?><urlset>
        <url><loc>${slug}</loc><lastmod>2025-09-12</lastmod></url>
    </urlset>`;
    assert.equal(lastmodByPathFromXml(xml).get(canonicalKidsPath(slug)), SITEMAP_DAY);

    resetKanSitemapCache();
    const files = {
        [ROBOTS_URL]: readFixture("robots.txt"),
        [DEFAULT_INDEX_URL]: readFixture("sitemap-index.xml"),
        "https://www.kankids.org.il/media/sitemap/kids/sitemap0.xml": readFixture("sitemap-part-0.xml"),
        "https://www.kankids.org.il/media/sitemap/kids/sitemap1.xml": readFixture("sitemap-part-1.xml"),
        "https://www.kan.org.il/media/sitemap/kids/sitemap0.xml": readFixture("sitemap-part-0.xml")
    };
    await loadKidsSitemap({
        logger: { warn() {}, info() {}, debug() {} },
        retries: 0,
        retryDelayMs: 0,
        fileDelayMs: 0,
        timeoutMs: 1000,
        fetchText: async (url) => {
            if (!files[url]) throw new Error("unexpected " + url);
            return files[url];
        }
    });
    assert.equal(lastmodForEpisodeUrl(EPISODE_URL), "2023-04-22T00:00:00.000Z");
    resetKanSitemapCache();
});

function episodeInput(url) {
    return {
        url,
        title: "פרק 1",
        description: "תיאור",
        season: 1,
        episodeNo: 1
    };
}

function armReuse(scraper, episodeId, released) {
    scraper._publishedStreams = new Map([[episodeId, [{
        url: STABLE,
        type: "series",
        name: "פרק"
    }]]]);
    scraper._publishedEpisodeDates = new Map([[episodeId, {
        released: released || "",
        firstSeen: ""
    }]]);
    scraper.getStreams = async () => {
        throw new Error("episode page was fetched");
    };
}

test("a reused episode keeps the published released date and ignores a newer sitemap lastmod", async () => {
    resetKanSitemapCache();
    primeKanSitemapLastmods([[EPISODE_URL, "2025-09-23"]]);
    const episodeId = "il_kan_kids_11732:1:1";
    const kids = new KanKidsScraper();
    armReuse(kids, episodeId, AIR);
    const videos = [];
    await kids.processOneKidsEpisode(episodeInput(EPISODE_URL), "il_kan_kids_11732", "k", videos);
    assert.equal(videos[0].released, AIR);
    assert.equal(videos[0].streams[0].released, AIR);
    assert.equal(videos[0].streams[0].url, STABLE);

    const teenId = "il_kan_teens_1000:2:17";
    const teenUrl = "https://www.kankids.org.il/content/kids/hinuchit-main/p-1/s2/17/";
    primeKanSitemapLastmods([[teenUrl, "2026-11-17"]]);
    const teens = new KanTeensScraper();
    armReuse(teens, teenId, "2020-09-06T18:00:00.000Z");
    const teenVideos = [];
    await teens.processOneTeensEpisode({
        ...episodeInput(teenUrl),
        season: 2,
        episodeNo: 17
    }, "il_kan_teens_1000", "n", teenVideos);
    assert.equal(teenVideos[0].released, "2020-09-06T18:00:00.000Z");
    assert.equal(teenVideos[0].streams[0].url, STABLE);
    resetKanSitemapCache();
});

test("a reused episode with no published date uses sitemap lastmod, and that value stays on the next run", async () => {
    resetKanSitemapCache();
    primeKanSitemapLastmods([[EPISODE_URL, "2025-09-12"]]);
    const episodeId = "il_kan_kids_11732:1:1";
    const first = new KanKidsScraper();
    armReuse(first, episodeId, "");
    first._educationalRunStamp = "2030-01-01T00:00:00.000Z";
    const firstVideos = [];
    await first.processOneKidsEpisode(episodeInput(EPISODE_URL), "il_kan_kids_11732", "k", firstVideos);
    assert.equal(firstVideos[0].released, SITEMAP_DAY);

    primeKanSitemapLastmods([[EPISODE_URL, "2026-01-02"]]);
    const second = new KanKidsScraper();
    armReuse(second, episodeId, firstVideos[0].released);
    second._educationalRunStamp = "2031-05-05T00:00:00.000Z";
    const secondVideos = [];
    await second.processOneKidsEpisode(episodeInput(EPISODE_URL), "il_kan_kids_11732", "k", secondVideos);
    assert.equal(secondVideos[0].released, SITEMAP_DAY);
    resetKanSitemapCache();
});

test("the first-seen stamp is kept for a reused episode that has no page date and no sitemap date", async () => {
    resetKanSitemapCache();
    const episodeId = "il_kan_kids_9:1:1";
    const url = "https://www.kankids.org.il/content/kids/ktantanim-main/p-9/s1/9/";
    const first = new KanKidsScraper();
    armReuse(first, episodeId, "");
    const stamp = "2024-03-01T00:00:00.000Z";
    first._educationalRunStamp = stamp;
    const firstVideos = [];
    await first.processOneKidsEpisode(episodeInput(url), "il_kan_kids_9", "k", firstVideos);
    assert.equal(firstVideos[0].released, stamp);
    assert.equal(firstVideos[0].streams[0].released, stamp);

    primeKanSitemapLastmods([[url, "2025-09-12"]]);
    const second = new KanKidsScraper();
    armReuse(second, episodeId, firstVideos[0].released);
    second._educationalRunStamp = "2026-11-18T00:00:00.000Z";
    const secondVideos = [];
    await second.processOneKidsEpisode(episodeInput(url), "il_kan_kids_9", "k", secondVideos);
    assert.equal(secondVideos[0].released, stamp);
    resetKanSitemapCache();
});

test("a freshly fetched page date replaces a carried sitemap date", async () => {
    resetKanSitemapCache();
    primeKanSitemapLastmods([[EPISODE_URL, "2025-09-12"]]);
    const episodeId = "il_kan_kids_11732:1:1";
    const kids = new KanKidsScraper();
    kids._publishedEpisodeDates = new Map([[episodeId, { released: SITEMAP_DAY, firstSeen: "" }]]);
    kids.getStreams = async () => educationalStreamFromDocument(airDocument());
    const videos = [];
    await kids.processOneKidsEpisode(episodeInput(EPISODE_URL), "il_kan_kids_11732", "k", videos);
    assert.equal(videos[0].released, AIR);
    assert.equal(videos[0].streams[0].released, AIR);
    resetKanSitemapCache();
});

});

test("published episode dates are indexed from the video, including a separate firstSeen", () => {
    const indexed = indexPublishedEpisodeDates({
        data: {
            series: {
                meta: {
                    videos: [
                        { id: "a:1:1", released: "2020-01-02T00:00:00.000Z", firstSeen: "2019-01-01T00:00:00.000Z" },
                        { id: "a:1:2" }
                    ]
                }
            }
        }
    });
    assert.equal(indexed.get("a:1:1").released, "2020-01-02T00:00:00.000Z");
    assert.equal(indexed.get("a:1:1").firstSeen, "2019-01-01T00:00:00.000Z");
    assert.equal(indexed.get("a:1:2").released, "");
});

test("a stored firstSeen date is used before the current run time", () => {
    assert.equal(chooseEducationalReleased({
        pageDate: "",
        publishedReleased: "",
        sitemapLastmod: "",
        firstSeen: "2019-05-01T00:00:00.000Z",
        now: "2026-11-18T00:00:00.000Z"
    }), "2019-05-01T00:00:00.000Z");
});

test("kids and teens series rows record latest_episode_date and other scrapers do not", () => {
    const videos = [
        { released: "2020-01-01T00:00:00.000Z" },
        { released: AIR },
        { released: "" }
    ];
    assert.equal(seriesLatestEpisodeDate("kankids", videos), AIR);
    assert.equal(seriesLatestEpisodeDate("kanteens", videos), AIR);
    assert.equal(seriesLatestEpisodeDate("kankids", [{ released: "" }]), null);
    assert.equal(seriesLatestEpisodeDate("kanarchive", videos), undefined);
    assert.equal(seriesLatestEpisodeDate("mako", videos), undefined);
});

test("the publish report counts videos that still have no released date", () => {
    const report = missingReleasedReport("KanKids", {
        one: { meta: { videos: [{ released: AIR }, { name: "חסר" }] } },
        two: { meta: { videos: [{ released: "" }] } }
    });
    assert.equal(report.missing, 2);
    assert.equal(report.videos, 3);
    assert.equal(report.warn, true);
    assert.equal(report.line, "KanKids => videos without released: 2 of 3");
    const clear = missingReleasedReport("KanTeens", {
        one: { meta: { videos: [{ released: AIR }] } }
    });
    assert.equal(clear.warn, false);
    assert.equal(clear.line, "KanTeens => videos without released: 0 of 1");
});
