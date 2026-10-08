const {
    LOG4JS,
    URLS_ASSETS_BASE
} = require("./constants.js");

const log4js = require("log4js");
log4js.configure({
    appenders: {
        out: { type: "stdout" },
        Stremio:
        {
            type: LOG4JS.TYPE,
            filename: LOG4JS.FILENAME,
            maxLogSize: LOG4JS.MAX_SIZE,
            backups: LOG4JS.BACKUP_FILES,
        }
    },
    categories: { default: { appenders: ['Stremio','out'], level: LOG4JS.LEVEL } },
});

var logger = log4js.getLogger("LiveTV");

/**
 * Live TV channel list, aligned with Stremio-KanBoxAddon branch
 * cursor/fix-stremio-playback-d2c6 (PR #7), which follows the merged PR #6 list.
 *
 * The addon no longer reads output/stremio-live.zip. That archive was deleted
 * in May 2026, and classes/zipSources.js skips the filename. Catalog posters
 * live in the addon's classes/liveChannels.js. Playback URLs are resolved on
 * demand in classes/liveStreamResolver.js. Writing the zip again would
 * recreate a file nothing reads, so crawl() does not write it.
 *
 * The streamUrl on each channel is the first playlist the addon returns.
 * Keshet 12, Channel 24, and the Mako /evrideo/ channels need a fresh
 * entitlementsServicesV2.jsp ticket, which the addon appends at playback.
 * Reshet's first playlist is the CloudFront backup whose segments are relative.
 */
const LIVE_CATALOG = [
    {
        id: "il_kanTV_04",
        name: "כאן 11",
        genres: ["actuality", "news", "חדשות", "אקטואליה"],
        posterFile: "kan.jpg",
        description: "Kan 11 Live Stream From Israel",
        streamUrl: "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/kan11/live.livx/playlist.m3u8?dvr=21600000"
    },
    {
        id: "il_kanTV_05",
        name: "חינוכית",
        genres: ["Kids", "ילדים ונוער"],
        posterFile: "hinuchit.jpg",
        description: "שידורי הטלויזיה החינוכית",
        streamUrl: "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/kan_edu/live.livx/playlist.m3u8?dvr=21600000"
    },
    {
        id: "il_kanTV_07",
        name: "שידורי ערוץ השידור הערבי",
        genres: ["Actuality", "אקטואליה"],
        posterFile: "makan.png",
        description: "שידורי ערוץ השידור הערבי",
        streamUrl: "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/makan/live.livx/playlist.m3u8?dvr=21600000"
    },
    {
        id: "il_kan_TV_06",
        name: "שידורי ערוץ הכנסת 99",
        genres: ["Actuality", "אקטואליה"],
        posterFile: "knesset.png",
        description: "שידורי ערוץ הכנסת - 99",
        streamUrl: "https://kneset.gostreaming.tv/p2-kneset/_definst_/myStream/index.m3u8"
    },
    {
        id: "il_makoTV_01",
        name: "קשת 12",
        genres: ["Actuality", "אקטואליה"],
        posterFile: "LIVE_push_mako_tv.jpg",
        description: "שידור חי קשת 12",
        streamUrl: "https://mako-streaming.akamaized.net/stream/hls/live/2033791/k12/index.m3u8"
    },
    {
        id: "il_reshetTV_01",
        name: "רשת ערוץ 13",
        genres: ["Actuality", "אקטואליה"],
        posterFile: "13.jpg",
        description: "שידור חי רשת ערוץ 13",
        streamUrl: "https://d18b0e6mopany4.cloudfront.net/out/v1/2f2bc414a3db4698a8e94b89eaf2da2a/index.m3u8"
    },
    {
        id: "il_14TV_01",
        name: "ערוץ 14",
        genres: ["Actuality", "אקטואליה"],
        posterFile: "14square.png",
        description: "שידור חי ערוץ 14",
        streamUrl: "https://ch14channel14.encoders.immergo.tv/app/2/streamPlaylist.m3u8"
    },
    {
        id: "il_24_01",
        name: "ערוץ 24 חדשות",
        genres: ["Actuality", "אקטואליה", "news"],
        posterFile: "channel_24_square.jpg",
        description: "שידור חי ערוץ 24 חדשות",
        streamUrl: "https://mako-streaming.akamaized.net/direct/hls/live/2035340/ch24live/index.m3u8?as=1"
    },
    {
        id: "il_makoTV_erets",
        name: "ערוץ ארץ נהדרת",
        genres: ["Actuality", "אקטואליה"],
        poster: "https://raw.githubusercontent.com/Fishenzon/repo/master/plugin.video.idanplus/images/12eretz.jpg",
        description: "שידור חי ערוץ ארץ נהדרת",
        streamUrl: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/erets/index.m3u8"
    },
    {
        id: "il_makoTV_savri",
        name: "ערוץ סברי מרנן",
        genres: ["Actuality", "אקטואליה"],
        poster: "https://raw.githubusercontent.com/Fishenzon/repo/master/plugin.video.idanplus/images/12savri.jpg",
        description: "שידור חי ערוץ סברי מרנן",
        streamUrl: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/savri/index.m3u8"
    },
    {
        id: "il_makoTV_comedy",
        name: "ערוץ הקומדיה",
        genres: ["Actuality", "אקטואליה"],
        poster: "https://raw.githubusercontent.com/Fishenzon/repo/master/plugin.video.idanplus/images/12comedy.jpg",
        description: "שידור חי ערוץ הקומדיה",
        streamUrl: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/free_comedy/index.m3u8"
    },
    {
        id: "il_makoTV_drama",
        name: "ערוץ הדרמה",
        genres: ["Actuality", "אקטואליה"],
        poster: "https://raw.githubusercontent.com/Fishenzon/repo/master/plugin.video.idanplus/images/12drama.jpg",
        description: "שידור חי ערוץ הדרמה",
        streamUrl: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/free_drama/index.m3u8"
    },
    {
        id: "il_makoTV_music",
        name: "ערוץ המוזיקה",
        genres: ["Actuality", "אקטואליה"],
        poster: "https://raw.githubusercontent.com/Fishenzon/repo/master/plugin.video.idanplus/images/12music.jpg",
        description: "שידור חי ערוץ המוזיקה",
        streamUrl: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/free_music/index.m3u8"
    },
    {
        id: "il_makoTV_food",
        name: "ערוץ האוכל",
        genres: ["Actuality", "אקטואליה"],
        poster: "https://raw.githubusercontent.com/Fishenzon/repo/master/plugin.video.idanplus/images/12food.jpg",
        description: "שידור חי ערוץ האוכל",
        streamUrl: "https://mako-streaming.akamaized.net/evrideo/hls/live/20001278/free_food/index.m3u8"
    },
    {
        id: "il_10_live_01",
        name: "ערוץ עשר",
        genres: ["Actuality", "אקטואליה"],
        posterFile: "10.png",
        description: "שידור חי ערוץ עשר",
        streamUrl: "https://r.il.cdn-redge.media/livehls/oil/calcala-live/live/channel10/live.livx/playlist.m3u8?dvr=21600000"
    },
    {
        id: "il_ynetTv_01",
        name: "שידור חי ynet",
        genres: ["Actuality", "אקטואליה", "news"],
        posterFile: "ynet.jpg",
        description: "שידור חי ynet",
        streamUrl: "https://ynet-live-01.ynet-pic1.yit.co.il/ynet/live_720.m3u8"
    },
    {
        id: "il_24newsHeb_01",
        name: "i24 עברית",
        genres: ["Actuality", "אקטואליה", "news"],
        posterFile: "i24news_hebrew_square.png",
        description: "שידור חי i24 עברית",
        streamUrl: "https://i24newshebrew-cdn.encoders.immergo.tv/master.m3u8"
    },
    {
        id: "il_24newsEng_01",
        name: "i24 English",
        genres: ["Actuality", "אקטואליה", "news"],
        posterFile: "i24new_english_square.png",
        description: "i24 News English live",
        streamUrl: "https://i24newsenglish-cdn.encoders.immergo.tv/master.m3u8"
    },
    {
        id: "il_24newsFrn_01",
        name: "i24 Français",
        genres: ["Actuality", "אקטואליה", "news"],
        posterFile: "i24news.png",
        description: "i24 News Français en direct",
        streamUrl: "https://i24newsfrench-cdn.encoders.immergo.tv/master.m3u8"
    },
    {
        id: "il_24newsArb_01",
        name: "i24 العربية",
        genres: ["Actuality", "אקטואליה", "news"],
        posterFile: "i24news_arabic_square.png",
        description: "بث مباشر i24 بالعربية",
        streamUrl: "https://i24newsarabic-cdn.encoders.immergo.tv/master.m3u8"
    }
];

function assetUrl(posterFile) {
    return URLS_ASSETS_BASE + posterFile;
}

function channelPoster(channel) {
    if (channel.poster && /^https?:\/\//i.test(channel.poster)) return channel.poster;
    return assetUrl(channel.posterFile);
}

class LiveTV {

    constructor() {
        this._liveTVJSONObj = {};
    }

    crawl(isDoWriteFile = false) {
        logger.info("Start Crawling");

        for (const channel of LIVE_CATALOG) {
            this.addToLiveJSON(
                channel.id,
                channel.name,
                channel.genres,
                channelPoster(channel),
                channel.description,
                channel.streamUrl
            );
        }

        logger.info("LiveTV => Done Crawling");
        if (isDoWriteFile) {
            this.writeJSON();
        }
    }

    addToLiveJSON(id, name, genres, bkgImg, desc, streamUrl) {
        this._liveTVJSONObj[id] = {
            id: id,
            type: "tv",
            subtype: "t",
            name: name,
            meta: {
                id: id,
                name: name,
                type: "tv",
                subtype: "t",
                background: bkgImg,
                poster: bkgImg,
                posterShape: "square",
                logo: bkgImg,
                description: desc,
                genres: genres,
                streamUrl: streamUrl,
                streams: [{
                    url: streamUrl,
                    name: name,
                    title: name
                }]
            }
        };
        logger.debug(`addToLiveJSON => Added Live TV - ${name} ID: ${id}`);
    }

    /**
     * Intentionally does not write output/stremio-live.zip.
     * The addon retired that file. See the comment above LIVE_CATALOG.
     */
    writeJSON() {
        logger.info(
            "LiveTV => Not writing stremio-live.zip. The addon deleted that archive " +
            "and no longer reads it. Posters and primary URLs are kept in LIVE_CATALOG " +
            "so they stay aligned with Stremio-KanBoxAddon classes/liveChannels.js " +
            "and classes/liveStreamResolver.js."
        );
    }
}

module.exports = LiveTV;
module.exports.LIVE_CATALOG = LIVE_CATALOG;
module.exports.assetUrl = assetUrl;
module.exports.channelPoster = channelPoster;
module.exports.WRITES_LIVE_ZIP = false;
