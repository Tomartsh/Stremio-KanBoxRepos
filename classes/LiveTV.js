const utils = require("./utilities.js");
const {fetchData} = require("./utilities.js");
const {
    LOG4JS,
    URLS_ASSETS_BASE,
    KNESSET_URL_TV
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

class LiveTV {

    constructor() {
        this._liveTVJSONObj = {};
    }

    /********************************************************************
     * 
     * Kan Live channels handling
     * 
     ********************************************************************/
    
    crawl(isDoWriteFile = false){
        logger.info("Start Crawling");

        // Kan channels - default referer is kan.org.il
        this.addToLiveJSON("il_kanTV_04", "כאן 11", ["actuality", "news", "חדשות", "אקטואליה"], URLS_ASSETS_BASE + "kan.jpg", "Kan 11 Live Stream From Israel", "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/kan11/live.livx/playlist.m3u8");
        this.addToLiveJSON("il_kanTV_05", "חינוכית", ["Kids","ילדים ונוער"], URLS_ASSETS_BASE + "hinuchit.jpg", "שידורי הטלויזיה החינוכית", "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/kan_edu/live.livx/playlist.m3u8", "https://www.kankids.org.il/");
        this.addToLiveJSON("il_kanTV_07", "שידורי ערוץ השידור הערבי", ["Actuality","אקטואליה"], "https://www.makan.org.il/media/d3if2qoj/לוגו-ראשי-מכאן.png", "שידורי ערוץ השידור הערבי", "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/makan/live.livx/playlist.m3u8");

        // Knesset
        this.addToLiveJSON("il_kan_TV_06", "שידורי ערוץ הכנסת 99", ["Actuality","אקטואליה"], "https://www.knesset.tv/media/20004/logo-new.png", "שידורי ערוץ הכנסת - 99", "https://kneset.gostreaming.tv/p2-kneset/_definst_/myStream/index.m3u8", "https://www.knesset.tv/");

        // Mako/Keshet - Channel 12 & 24
        this.addToLiveJSON("il_makoTV_01", "מאקו ערוץ 12", ["Actuality","אקטואליה"], URLS_ASSETS_BASE + "LIVE_push_mako_tv.jpg", "שידור חי מאקו ערוץ 12", "https://mako-streaming.akamaized.net/direct/hls/live/2032286/ch12live-clean/hdntl=exp=1770369468~acl=%2f*~data=hdntl~hmac=d94284be45758c7d7ab25772c1d0a9ec1653e0cd37c1afed0730d047849c30af/master.m3u8", "https://www.mako.co.il/");
        this.addToLiveJSON("il_24_01", "ערוץ 24 חדשות", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "channel24_square.png", "שידור חי ערוץ 24 חדשות", "https://mako-streaming.akamaized.net/direct/hls/live/2035340/ch24live/hdntl=exp=1735742336~acl=%2f*~data=hdntl~hmac=7eedf5eaef20a12e53120f7bcc33e0a0ebbc95c83894b870abdb45976d91d493/video_7201280_p_1.m3u8", "https://www.mako.co.il/");

        // Reshet - Channel 13
        this.addToLiveJSON("il_reshetTV_01", "רשת ערוץ 13", ["Actuality","אקטואליה"], URLS_ASSETS_BASE + "13.jpg", "שידור חי רשת ערוץ 13", "https://reshet.g-mana.live/media/87f59c77-03f6-4bad-a648-897e095e7360/mainManifest.m3u8", "https://13tv.co.il/");

        // Channel 14
        this.addToLiveJSON("il_14TV_01", "ערוץ 14", ["Actuality","אקטואליה"], URLS_ASSETS_BASE + "14square.png", "שידור חי ערוץ 14", "https://ch14-channel14-content.akamaized.net/hls/live/2104807/CH14_CHANNEL14/master.m3u8", "https://www.now14.co.il/");

        // Ynet
        this.addToLiveJSON("il_ynetTv_01", "שידור חי ynet", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "ynet_logo_gif_ynet.gif", "שידור חי ynet", "https://ynet-live-02.ynet-pic1.yit.co.il/ynet/live_720.m3u8", "https://www.ynet.co.il/");

        // i24 News
        this.addToLiveJSON("il_24newsEng_01", "שידור חי באנגלית i24", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "i24new_english_square.png", "שידור חי באנגלית i24", "https://bcovlive-a.akamaihd.net/ecf224f43f3b43e69471a7b626481af0/eu-central-1/5377161796001/playlist.m3u8", "https://www.i24news.tv/");
        this.addToLiveJSON("il_24newsHeb_01", "שידור חי בעיברית i24", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "i24news_hebrew_square.png", "שידור חי בעיברית i24", "https://bcovlive-a.akamaihd.net/d89ede8094c741b7924120b27764153c/eu-central-1/5377161796001/playlist.m3u8", "https://www.i24news.tv/");
        this.addToLiveJSON("il_24newsFrn_01", "שידור חי בצרפתית i24", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE +"i24new_french_square.png", "שידור חי בצרפתית i24", "https://bcovlive-a.akamaihd.net/41814196d97e433fb401c5e632d985e9/eu-central-1/5377161796001/playlist.m3u8", "https://www.i24news.tv/");
        this.addToLiveJSON("il_24newsArb_01", "שידור חי בערבית i24", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "i24news_arabic_square.png", "שידור חי בערבית i24", "https://bcovlive-a.akamaihd.net/5f7e2f3f5d6b4f2eaedc6f3f1e0e1a5e/eu-central-1/5377161796001/playlist.m3u8", "https://www.i24news.tv/");

        // Walla
        this.addToLiveJSON("il_walla_live_01", "וואלה! NEWS", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "walla_news_square.png", "שידור חי וואלה! NEWS", "https://amg01742-walla-wallanews-ono-btlna.amagi.tv/playlist/amg01742-walla-wallanews-ono/playlist.m3u8", "https://www.walla.co.il/");

        // Channel 10 (Redge CDN)
        this.addToLiveJSON("il_10_live_01", "ערוץ עשר", ["Actuality","אקטואליה"], URLS_ASSETS_BASE + "10.png", "שידור חי ערוץ עשר", "https://r.il.cdn-redge.media/livehls/oil/calcala-live/live/channel10/live.livx/playlist.m3u8", "https://www.10tv.co.il/");


        logger.info("LiveTV => Done Crawling");
        if (isDoWriteFile){
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }
    }

    addToLiveJSON(id, name, genres, bkgImg, desc, streamUrl, referer = "https://www.kan.org.il/"){
        this._liveTVJSONObj[id] = {
            id: id,
            type: "tv",
            subtype: "t",
            name: name,
            meta: {
                id: id,
                name: name,
                type: "tv",
                genres: genres,
                background: URLS_ASSETS_BASE + bkgImg,
                poster: bkgImg,
                posterShape: "square",
                description: desc,
                videos: [
                    {
                        id: id,
                        name: name,
                        title: name,
                        description: desc,
                        streams:
                        [{
                            url: streamUrl,
                            //type: "tv",
                            title: name,
                            name: name,
                            description: desc,
                            behaviorHints: {
                                proxyHeaders: {
                                    request: {
                                        "Referer": referer,
                                        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                                        "Accept": "*/*"
                                    }
                                }
                            }
                        }]
                    }

                ]
            }
        }
        logger.debug(`addToLiveJSON => Added Live TV - ${name} ID: ${id}`);
    }

    writeJSON(){
        logger.debug("writeJSON => Entered");
        utils.writeJSONToFile(this._liveTVJSONObj, "stremio-live");
        
        logger.debug("writeJSON => Leaving");
    } 
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = LiveTV;