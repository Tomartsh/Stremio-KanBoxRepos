const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const LiveTV = require("../classes/LiveTV");
const { LIVE_CATALOG, channelPoster, WRITES_LIVE_ZIP } = LiveTV;

const ADDON_PRIMARY_URLS = {
    il_kanTV_04: "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/kan11/live.livx/playlist.m3u8?dvr=21600000",
    il_kanTV_05: "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/kan_edu/live.livx/playlist.m3u8?dvr=21600000",
    il_kanTV_07: "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/makan/live.livx/playlist.m3u8?dvr=21600000",
    il_kan_TV_06: "https://kneset.gostreaming.tv/p2-kneset/_definst_/myStream/index.m3u8",
    il_makoTV_01: "https://mako-streaming.akamaized.net/stream/hls/live/2033791/k12/index.m3u8",
    il_reshetTV_01: "https://d18b0e6mopany4.cloudfront.net/out/v1/2f2bc414a3db4698a8e94b89eaf2da2a/index.m3u8",
    il_14TV_01: "https://ch14channel14.encoders.immergo.tv/app/2/streamPlaylist.m3u8",
    il_24_01: "https://mako-streaming.akamaized.net/direct/hls/live/2035340/ch24live/index.m3u8?as=1",
    il_makoTV_erets: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/erets/index.m3u8",
    il_makoTV_savri: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/savri/index.m3u8",
    il_makoTV_comedy: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/free_comedy/index.m3u8",
    il_makoTV_drama: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/free_drama/index.m3u8",
    il_makoTV_music: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/free_music/index.m3u8",
    il_makoTV_food: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/free_food/index.m3u8",
    il_10_live_01: "https://r.il.cdn-redge.media/livehls/oil/calcala-live/live/channel10/live.livx/playlist.m3u8?dvr=21600000",
    il_ynetTv_01: "https://ynet-live-01.ynet-pic1.yit.co.il/ynet/live_720.m3u8",
    il_24newsHeb_01: "https://i24newshebrew-cdn.encoders.immergo.tv/master.m3u8",
    il_24newsEng_01: "https://i24newsenglish-cdn.encoders.immergo.tv/master.m3u8",
    il_24newsFrn_01: "https://i24newsfrench-cdn.encoders.immergo.tv/master.m3u8",
    il_24newsArb_01: "https://i24newsarabic-cdn.encoders.immergo.tv/master.m3u8"
};

const POSTER_FILES = {
    il_kanTV_05: "hinuchit.jpg",
    il_kanTV_07: "makan.png",
    il_kan_TV_06: "knesset.png",
    il_24_01: "channel_24_square.jpg",
    il_24newsFrn_01: "i24news.png"
};

test("live posters are single asset URLs and the previously broken files match the addon", () => {
    const source = fs.readFileSync(path.join(__dirname, "../classes/LiveTV.js"), "utf8");
    assert.equal(source.includes("URLS_ASSETS_BASE + URLS_ASSETS_BASE"), false);
    assert.equal(source.includes("+ +"), false);
    assert.equal(source.includes("channel24_square.png"), false);
    assert.equal(source.includes("i24new_french_square.png"), false);
    assert.equal(WRITES_LIVE_ZIP, false);

    for (const channel of LIVE_CATALOG) {
        const poster = channelPoster(channel);
        assert.match(poster, /^https:\/\//);
        assert.equal(poster.includes("NaN"), false);
        assert.equal(poster.split("https://").length, 2);
        if (channel.posterFile) {
            assert.match(poster, /\/assets\/[^/]+$/);
        }
        assert.equal(ADDON_PRIMARY_URLS[channel.id], channel.streamUrl);
    }
    assert.equal(LIVE_CATALOG.filter(channel => channel.streamUrl.includes("/evrideo/")).length, 6);

    const byId = Object.fromEntries(LIVE_CATALOG.map(channel => [channel.id, channel]));
    for (const [id, file] of Object.entries(POSTER_FILES)) {
        assert.equal(byId[id].posterFile, file);
    }
});

test("crawl builds the catalog and does not write stremio-live.zip", () => {
    const zipPath = path.join(__dirname, "../output/stremio-live.zip");
    assert.equal(fs.existsSync(zipPath), false);

    const live = new LiveTV();
    live.crawl(true);
    const channels = live._liveTVJSONObj;

    assert.equal(Object.keys(channels).length, Object.keys(ADDON_PRIMARY_URLS).length);
    assert.equal(channels.il_kanTV_05.meta.poster.endsWith("/hinuchit.jpg"), true);
    assert.equal(channels.il_24_01.meta.poster.endsWith("/channel_24_square.jpg"), true);
    assert.equal(channels.il_24newsFrn_01.meta.poster.endsWith("/i24news.png"), true);
    assert.equal(fs.existsSync(zipPath), false);
});
