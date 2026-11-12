const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { collectEducationalEpisodes } = require("../classes/ScraperHelpers");
const KanKidsScraper = require("../classes/KanKidsScraper");
const KanTeensScraper = require("../classes/KanTeensScraper");
const {
    resetKanSitemapCache,
    canonicalKidsPath,
    parseKidsEpisodeUrl,
    groupSitemapEpisodes,
    locsFromXml,
    missingSitemapEpisodes,
    episodeNumberFromTitle,
    isTrailerOrExtraTitle,
    episodeFieldsFromDocument,
    assignAddedEpisodeNumbers,
    loadKidsSitemap,
    supplementEducationalEpisodes,
    siblingSitemapUrl,
    ROBOTS_URL,
    DEFAULT_INDEX_URL
} = require("../classes/KanSitemap");

const fixtureDir = path.join(__dirname, "fixtures/kankids");
const SERIES_11732 = "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/";
const KIDS_ROOT = SERIES_11732 + "?currentPage=2&itemsToShow=100";
const INDEX_URL = "https://www.kan.org.il/media/sitemap/kids/siteindex.xml";
const PART_0 = "https://www.kankids.org.il/media/sitemap/kids/sitemap0.xml";
const PART_1 = "https://www.kankids.org.il/media/sitemap/kids/sitemap1.xml";
const PART_0_KAN = "https://www.kan.org.il/media/sitemap/kids/sitemap0.xml";

function readFixture(name) {
    return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

function loggerStub() {
    const warnings = [];
    const infos = [];
    return {
        warnings,
        infos,
        warn(message) { warnings.push(String(message)); },
        info(message) { infos.push(String(message)); },
        debug() {}
    };
}

function sitemapFiles() {
    return {
        [ROBOTS_URL]: readFixture("robots.txt"),
        [INDEX_URL]: readFixture("sitemap-index.xml"),
        [PART_0]: readFixture("sitemap-part-0.xml"),
        [PART_1]: readFixture("sitemap-part-1.xml"),
        [PART_0_KAN]: readFixture("sitemap-part-0.xml")
    };
}

function quietLoad(extra) {
    return Object.assign({
        logger: loggerStub(),
        retries: 0,
        retryDelayMs: 0,
        fileDelayMs: 0,
        timeoutMs: 1000
    }, extra);
}

describe("Kan kids sitemap", { concurrency: false }, () => {
    test("episode URLs group by series and season, and the extra /kids segment matches", () => {
        resetKanSitemapCache();
        const part0 = locsFromXml(readFixture("sitemap-part-0.xml"));
        const part1 = locsFromXml(readFixture("sitemap-part-1.xml"));
        assert.equal(part0.isIndex, false);
        assert.equal(locsFromXml(readFixture("sitemap-index.xml")).isIndex, true);
        const groups = groupSitemapEpisodes(part0.locs.concat(part1.locs));

        const kids = groups.get("p-11732");
        assert.deepEqual(kids.seasonal.get(1).map((item) => item.episodeId), [
            "100071", "100625", "100698", "100745", "100900"
        ]);
        assert.equal(kids.seasonal.get(2)[0].episodeId, "100800");
        assert.equal(kids.flat[0].episodeId, "100901");
        assert.equal(kids.flat[0].season, null);
        assert.equal(groups.get("p-762163").flat.length, 3);
        assert.equal(groups.get("p-762163").seasonal.size, 0);
        assert.equal(groups.get("p-432148").flat.length, 3);
        assert.equal(groups.has("p-11022"), false);

        const catalogStyle = "https://www.kankids.org.il/kids/content/kids/ktantanim-main/p-11732/s1/100625";
        const pageStyle = "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100625/";
        assert.equal(canonicalKidsPath(catalogStyle), canonicalKidsPath(pageStyle));
        assert.equal(parseKidsEpisodeUrl(catalogStyle).url, pageStyle);
        assert.equal(parseKidsEpisodeUrl("https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/"), null);
        assert.equal(parseKidsEpisodeUrl("https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/s1/135116/"), null);
    });

    test("a saved episode page supplies title, פרק number, image, description, and stream", () => {
        const fields = episodeFieldsFromDocument(readFixture("episode-sitemap-added.html"));
        assert.equal(fields.title, "נגד כח המשיכה | פרק 51");
        assert.equal(fields.parsedEpisodeNo, 51);
        assert.equal(fields.image, "https://www.kan.org.il/media/xepnzxtr/2019-2-5-imgid-4103_b.jpeg");
        assert.match(fields.description, /מרחפים באוויר/);
        assert.equal(fields.datePublished, new Date("2023-04-22T22:07:17+02:00").toISOString());
        assert.equal(
            fields.stream.url,
            "https://r.il.cdn-redge.media/webcache/gorigin/hls/oil/kancdn/vod/100698/Manifest.ism/playlist.m3u8"
        );
        assert.equal(fields.stream.released, fields.datePublished);
        assert.equal(isTrailerOrExtraTitle(fields.title), false);
        assert.equal(isTrailerOrExtraTitle("אפצ'י וסיפור | טריילר"), true);
        assert.equal(isTrailerOrExtraTitle("שיר הנושא 🎵"), true);
        assert.equal(isTrailerOrExtraTitle("הצצה לפרק הבכורה"), true);
        assert.equal(isTrailerOrExtraTitle("פתיח"), true);
        assert.equal(episodeNumberFromTitle("פרק 60"), 60);
        assert.equal(episodeNumberFromTitle("ספיישל"), null);
    });

    test("added episode numbers keep the page sequence and prefer a free פרק number", () => {
        const page = [
            { url: "https://www.kankids.org.il/content/kids/ktantanim-main/p-1/s1/1/", season: 1, episodeNo: 1 },
            { url: "https://www.kankids.org.il/content/kids/ktantanim-main/p-1/s1/2/", season: 1, episodeNo: 2 }
        ];
        const added = assignAddedEpisodeNumbers(page, [
            { url: "/s1/9/", episodeId: "9", season: 1, title: "פרק 2", parsedEpisodeNo: 2, datePublished: "2020-01-01T00:00:00.000Z" },
            { url: "/s1/8/", episodeId: "8", season: 1, title: "פרק 5", parsedEpisodeNo: 5, datePublished: "2020-01-02T00:00:00.000Z" },
            { url: "/s1/30/", episodeId: "30", season: 1, title: "ספיישל מאוחר", parsedEpisodeNo: null, datePublished: "2021-05-01T00:00:00.000Z" },
            { url: "/s1/20/", episodeId: "20", season: 1, title: "ספיישל מוקדם", parsedEpisodeNo: null, datePublished: "2021-01-01T00:00:00.000Z" }
        ]);
        assert.deepEqual(added.map((item) => [item.url, item.episodeNo]), [
            ["/s1/8/", 5],
            ["/s1/9/", 6],
            ["/s1/20/", 7],
            ["/s1/30/", 8]
        ]);
        assert.equal(page[0].episodeNo, 1);
        assert.equal(page[1].episodeNo, 2);

        const fullRow = Array.from({ length: 50 }, (_, index) => ({
            season: 1,
            episodeNo: index + 1,
            url: "/page/" + (index + 1)
        }));
        const kept = assignAddedEpisodeNumbers(fullRow, [
            { url: "/old/", episodeId: "1", season: 1, title: "פרק 6", parsedEpisodeNo: 6 },
            { url: "/new/", episodeId: "2", season: 1, title: "פרק 51", parsedEpisodeNo: 51 }
        ]);
        assert.equal(kept.find((item) => item.url === "/new/").episodeNo, 51);
        assert.equal(kept.find((item) => item.url === "/old/").episodeNo, 52);
        assert.equal(fullRow[0].episodeNo, 1);
        assert.equal(fullRow[49].episodeNo, 50);
    });

    test("the sitemap is read once, and a blocked kankids file is read from kan.org.il", async () => {
        resetKanSitemapCache();
        const files = sitemapFiles();
        const calls = [];
        const log = loggerStub();
        const fetchText = async (url) => {
            calls.push(url);
            if (url === PART_0) throw new Error("HTTP 403 for " + url);
            if (!files[url]) throw new Error("missing " + url);
            return files[url];
        };
        const first = await loadKidsSitemap(quietLoad({ fetchText, logger: log }));
        const callsAfterFirst = calls.length;
        const second = await loadKidsSitemap(quietLoad({ fetchText, logger: log }));
        assert.equal(second, first);
        assert.equal(calls.length, callsAfterFirst);
        assert.equal(calls.filter((url) => url === ROBOTS_URL).length, 1);
        assert.ok(calls.includes(PART_0_KAN));
        assert.equal(first.get("p-11732").seasonal.get(1).length, 5);
        assert.equal(first.get("p-432148").flat.length, 3);
        assert.equal(log.warnings.some((line) => /unavailable/i.test(line)), false);
        assert.equal(siblingSitemapUrl(PART_0), PART_0_KAN);
        assert.equal(siblingSitemapUrl(DEFAULT_INDEX_URL), "https://www.kankids.org.il/media/sitemap/kids/siteindex.xml");
    });

    test("a failed sitemap file is retried, and a total failure keeps the page episodes", async () => {
        resetKanSitemapCache();
        const files = sitemapFiles();
        const log = loggerStub();
        let indexTries = 0;
        const groups = await loadKidsSitemap(quietLoad({
            logger: log,
            retries: 2,
            fetchText: async (url) => {
                if (url === INDEX_URL) {
                    indexTries += 1;
                    if (indexTries === 1) throw new Error("reset");
                }
                if (!files[url]) throw new Error("missing " + url);
                return files[url];
            }
        }));
        assert.equal(indexTries, 2);
        assert.ok(groups.get("p-11917"));
        assert.equal(log.warnings.some((line) => /retry 1 of 2/.test(line)), true);

        resetKanSitemapCache();
        const failedLog = loggerStub();
        const page = [{ url: "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/1/", season: 1, episodeNo: 1, title: "פרק 1" }];
        const fetched = [];
        const merged = await supplementEducationalEpisodes(page, SERIES_11732, quietLoad({
            logger: failedLog,
            timeoutMs: 30,
            fetchText: () => new Promise(() => {}),
            fetchDocument: async (url) => { fetched.push(url); return "<html></html>"; }
        }));
        assert.equal(merged, page);
        assert.deepEqual(fetched, []);
        assert.equal(failedLog.warnings.some((line) => /Kids sitemap unavailable/.test(line)), true);

        const again = await supplementEducationalEpisodes(page, SERIES_11732, quietLoad({
            logger: failedLog,
            fetchText: async () => { throw new Error("should stay cached"); }
        }));
        assert.equal(again, page);
        assert.equal(failedLog.warnings.filter((line) => /Kids sitemap unavailable/.test(line)).length, 1);
    });

    test("p-11732 keeps the first 50 page ids and appends sitemap episodes past the row", async () => {
        resetKanSitemapCache();
        const files = sitemapFiles();
        const log = loggerStub();
        const pageEpisodes = await collectEducationalEpisodes(
            readFixture("kids-p-11732.html"),
            KIDS_ROOT,
            async () => readFixture("kids-p-11732.html")
        );
        assert.equal(pageEpisodes.length, 50);
        assert.equal(pageEpisodes[0].episodeNo, 1);
        assert.equal(pageEpisodes[49].episodeNo, 50);

        const fetched = [];
        const merged = await supplementEducationalEpisodes(pageEpisodes, SERIES_11732, quietLoad({
            logger: log,
            concurrency: 2,
            delayMs: 0,
            fetchText: async (url) => {
                if (!files[url]) throw new Error("missing " + url);
                return files[url];
            },
            fetchDocument: async (url) => {
                fetched.push(url);
                if (url.endsWith("/100698/")) return readFixture("episode-sitemap-added.html");
                if (url.endsWith("/100745/")) return readFixture("episode-sitemap-60.html");
                if (url.endsWith("/100900/")) return readFixture("episode-sitemap-extra.html");
                throw new Error("unexpected episode " + url);
            }
        }));

        assert.equal(merged.length, 52);
        for (let i = 0; i < 50; i++) {
            assert.equal(merged[i], pageEpisodes[i]);
            assert.equal(merged[i].episodeNo, i + 1);
        }
        assert.equal(merged[50].episodeNo, 51);
        assert.equal(merged[50].title, "נגד כח המשיכה | פרק 51");
        assert.equal(merged[50].url, "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100698/");
        assert.match(merged[50].stream.url, /100698/);
        assert.equal(merged[51].episodeNo, 60);
        assert.equal(merged[51].title, "פרק 60");
        assert.equal(merged[51].url.endsWith("/s1/100745/"), true);
        assert.deepEqual(fetched, [
            "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100698/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100745/",
            "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100900/"
        ]);
        assert.equal(log.infos.some((line) => /p-11732: added 2 episode/.test(line)), true);

        const scraper = new KanKidsScraper();
        scraper.getStreams = async () => { throw new Error("page already fetched"); };
        const videos = [];
        await scraper.processOneKidsEpisode(merged[50], "il_kan_kids_11732", "k", videos);
        assert.equal(videos[0].id, "il_kan_kids_11732:1:51");
        assert.equal(videos[0].episode, 51);
        assert.equal(videos[0].name, "נגד כח המשיכה | פרק 51");
        assert.equal(videos[0].thumbnail, "https://www.kan.org.il/media/xepnzxtr/2019-2-5-imgid-4103_b.jpeg");
        assert.equal(videos[0].streams[0].url, merged[50].stream.url);
        assert.equal(videos[0].released, merged[50].stream.released);
    });

    test("seasonless series take flat sitemap episodes, and a seasonal series does not", async () => {
        resetKanSitemapCache();
        const files = sitemapFiles();
        const fetched = [];
        const fetchText = async (url) => files[url];
        const fetchDocument = async (url) => {
            fetched.push(url);
            if (url.endsWith("/863608/")) return readFixture("episode-sitemap-trailer.html");
            if (url.endsWith("/763215/")) {
                return `<html><head><title>אפצ'י וסיפור | פרק 65</title></head><body>
                    <script type="application/ld+json">{"@type":"VideoObject","name":"אפצ'י וסיפור | פרק 65","description":"פרק 65","contentUrl":"https://cdn.example/763215.m3u8","uploadDate":"2024-06-02T08:00:00Z"}</script>
                    </body></html>`;
            }
            if (url.endsWith("/500010/") || url.endsWith("/500009/")) {
                const number = url.endsWith("/500010/") ? 51 : 40;
                return `<html><head><title>גלילאו | פרק ${number}</title></head><body>
                    <script type="application/ld+json">{"@type":"VideoObject","name":"גלילאו | פרק ${number}","description":"פרק","contentUrl":"https://cdn.example/${number}.m3u8"}</script>
                    </body></html>`;
            }
            throw new Error("unexpected " + url);
        };
        const options = quietLoad({ fetchText, fetchDocument, concurrency: 2, delayMs: 0 });
        const flatPage = [{
            url: "https://www.kankids.org.il/content/kids/ktantanim-main/p-762163/762173/",
            season: 1,
            episodeNo: 1,
            title: "פרק 1"
        }];
        const flatMerged = await supplementEducationalEpisodes(
            flatPage,
            "https://www.kankids.org.il/content/kids/ktantanim-main/p-762163/",
            options
        );
        assert.equal(flatMerged.length, 2);
        assert.equal(flatMerged[0], flatPage[0]);
        assert.equal(flatMerged[1].episodeNo, 65);
        assert.equal(flatMerged[1].title, "פרק 65");
        assert.equal(flatMerged[1].stream.url, "https://cdn.example/763215.m3u8");
        assert.equal(fetched.some((url) => url.endsWith("/863608/")), true);
        assert.equal(fetched.some((url) => url.includes("p-432148")), false);

        const teens = new KanTeensScraper();
        const teenVideos = [];
        await teens.processOneTeensEpisode(flatMerged[1], "il_kan_teens_762163", "n", teenVideos);
        assert.equal(teenVideos[0].id, "il_kan_teens_762163:1:65");
        assert.equal(teenVideos[0].streams[0].url, "https://cdn.example/763215.m3u8");

        fetched.length = 0;
        const seasonal = await supplementEducationalEpisodes([
            { url: "https://www.kankids.org.il/content/kids/hinuchit-main/p-11917/s10/1/", season: 10, episodeNo: 50, title: "פרק 50" },
            { url: "https://www.kankids.org.il/content/kids/hinuchit-main/p-11917/s9/1/", season: 9, episodeNo: 50, title: "פרק 50" }
        ], "https://www.kankids.org.il/content/kids/hinuchit-main/p-11917/", options);
        assert.deepEqual(seasonal.map((item) => [item.season, item.episodeNo]), [
            [10, 50],
            [9, 50],
            [9, 40],
            [10, 51]
        ]);
        assert.equal(fetched.some((url) => url.endsWith("/862347/")), false);
        assert.equal(fetched.some((url) => url.includes("/s2/")), false);

        const onPage = missingSitemapEpisodes(
            groupSitemapEpisodes(locsFromXml(readFixture("sitemap-part-0.xml")).locs),
            SERIES_11732,
            [{ url: "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100698/", season: 1, episodeNo: 51 }]
        );
        assert.equal(onPage.some((item) => item.episodeId === "100698"), false);
        assert.equal(onPage.some((item) => item.episodeId === "100800"), false);
        assert.equal(onPage.some((item) => item.episodeId === "100901"), false);
    });
});
