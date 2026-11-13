const test = require("node:test");
const assert = require("node:assert/strict");
const { streamUrlIsReusable, indexPublishedStreams } = require("../classes/publishedStreams");
const KanKidsScraper = require("../classes/KanKidsScraper");
const KanTeensScraper = require("../classes/KanTeensScraper");
const utils = require("../classes/utilities");

const STABLE = "https://r.il.cdn-redge.media/webcache/gorigin/hls/oil/kancdn/vod/2244765/LIBCODER_SMOOTH_1080_KAN/Manifest.ism/playlist.m3u8?fmp4";

test("stable kan playlist urls can be reused and signed urls cannot", () => {
    assert.equal(streamUrlIsReusable(STABLE), true);
    assert.equal(streamUrlIsReusable("https://www.youtube.com/watch?v=abc123"), true);
    assert.equal(streamUrlIsReusable("https://cdnapisec.kaltura.com/p/2748741/playManifest/entryId/1_mv4expvp/a.m3u8"), true);
    assert.equal(streamUrlIsReusable(STABLE + "&token=abc"), false);
    assert.equal(streamUrlIsReusable("https://cdn.example/a.m3u8?exp=1710000000"), false);
    assert.equal(streamUrlIsReusable("https://cdn.example/a.m3u8?hdnts=exp%3D1"), false);
    assert.equal(streamUrlIsReusable("https://cdn.example/a.m3u8?Policy=abc&Signature=def&Key-Pair-Id=ghi"), false);
    assert.equal(streamUrlIsReusable("https://cdn.example/eyJhbGciOiJIUzI1NiJ9.eyJleHAiOjF9.sig/a.m3u8"), false);
    assert.equal(streamUrlIsReusable(""), false);
});

test("kids and teens reuse a published stream, keep a sitemap stream, and refetch when asked", async () => {
    const episodeId = "il_kan_kids_11732:1:1";
    const scraper = new KanKidsScraper();
    scraper.previousCatalogOverride = {
        root: {
            data: {
                il_kan_kids_11732: {
                    id: "il_kan_kids_11732",
                    name: "נבואה",
                    link: "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/",
                    meta: {
                        videos: [{
                            id: episodeId,
                            streams: [{ url: STABLE, type: "series", name: "פרק", description: "ישן" }]
                        }]
                    }
                }
            }
        }
    };
    await scraper.loadSeriesIdentityIndex();
    let calls = 0;
    scraper.getStreams = async () => {
        calls += 1;
        return { url: "https://cdn.example/fresh.m3u8", type: "series", name: "פרק", description: "חדש" };
    };
    const episode = {
        url: "https://www.kankids.org.il/content/kids/ktantanim-main/p-11732/s1/100071/",
        title: "פרק 1",
        description: "מהדף",
        season: 1,
        episodeNo: 1
    };
    const reused = [];
    await scraper.processOneKidsEpisode(episode, "il_kan_kids_11732", "k", reused);
    assert.equal(calls, 0);
    assert.equal(reused[0].streams[0].url, STABLE);
    assert.notEqual(reused[0].streams[0], scraper._publishedStreams.get(episodeId)[0]);

    const indexed = indexPublishedStreams(scraper.previousCatalogOverride.root);
    assert.equal(indexed.get(episodeId)[0].url, STABLE);

    scraper._publishedStreams = new Map([[episodeId, [{ url: STABLE + "&token=abc", type: "series", name: "פרק" }]]]);
    const signed = [];
    await scraper.processOneKidsEpisode(episode, "il_kan_kids_11732", "k", signed);
    assert.equal(calls, 1);
    assert.equal(signed[0].streams[0].url, "https://cdn.example/fresh.m3u8");

    process.env.KAN_FULL_REFRESH = "1";
    try {
        scraper._publishedStreams = new Map([[episodeId, [{ url: STABLE, type: "series", name: "פרק" }]]]);
        const forced = [];
        await scraper.processOneKidsEpisode(episode, "il_kan_kids_11732", "k", forced);
        assert.equal(calls, 2);
    } finally {
        delete process.env.KAN_FULL_REFRESH;
    }

    const fromSitemap = [];
    await scraper.processOneKidsEpisode({
        ...episode,
        stream: { url: "https://cdn.example/from-sitemap.m3u8", type: "series", name: "פרק", released: "2024-01-01T00:00:00.000Z" }
    }, "il_kan_kids_11732", "k", fromSitemap);
    assert.equal(calls, 2);
    assert.equal(fromSitemap[0].streams[0].url, "https://cdn.example/from-sitemap.m3u8");
    assert.equal(fromSitemap[0].released, "2024-01-01T00:00:00.000Z");

    const teens = new KanTeensScraper();
    const teenId = "il_kan_teens_1000:2:17";
    teens._publishedStreams = new Map([[teenId, [{ url: STABLE, type: "series", name: "פרק" }]]]);
    const original = utils.getStreams;
    let teenCalls = 0;
    utils.getStreams = async () => {
        teenCalls += 1;
        return { url: "https://cdn.example/teen-fresh.m3u8", type: "series", name: "פרק" };
    };
    try {
        const teenVideos = [];
        await teens.processOneTeensEpisode({
            url: "https://www.kankids.org.il/content/kids/hinuchit-main/p-1/s2/17/",
            title: "פרק 17",
            season: 2,
            episodeNo: 17
        }, "il_kan_teens_1000", "n", teenVideos);
        assert.equal(teenCalls, 0);
        assert.equal(teenVideos[0].streams[0].url, STABLE);
        assert.equal(teenVideos[0].id, teenId);
    } finally {
        utils.getStreams = original;
    }
});
