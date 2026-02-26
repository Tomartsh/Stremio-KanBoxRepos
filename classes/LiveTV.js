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
        this.addToLiveJSON("il_kanTV_05", "חינוכית", ["Kids","ילדים ונוער"], URLS_ASSETS_BASE + "hinuchit.jpg", "שידורי הטלויזיה החינוכית", "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/kan_edu/live.livx/playlist.m3u8");
        this.addToLiveJSON("il_kanTV_07", "שידורי ערוץ השידור הערבי", ["Actuality","אקטואליה"], "https://www.makan.org.il/media/d3if2qoj/לוגו-ראשי-מכאן.png", "שידורי ערוץ השידור הערבי", "https://r.il.cdn-redge.media/livehls/oil/kancdn-live/live/makan/live.livx/playlist.m3u8");

        // Knesset
        this.addToLiveJSON("il_kan_TV_06", "שידורי ערוץ הכנסת 99", ["Actuality","אקטואליה"], "https://www.knesset.tv/media/20004/logo-new.png", "שידורי ערוץ הכנסת - 99", "https://kneset.gostreaming.tv/p2-kneset/_definst_/myStream/index.m3u8");

        // Mako/Keshet - Channel 12 & 24
        // Base URLs without tokens - the addon resolves tokens at runtime via entitlement service
        this.addToLiveJSON("il_makoTV_01", "מאקו ערוץ 12", ["Actuality","אקטואליה"], URLS_ASSETS_BASE + "LIVE_push_mako_tv.jpg", "שידור חי מאקו ערוץ 12", "/direct/hls/live/2033791/k12/index.m3u8");
        this.addToLiveJSON("il_24_01", "ערוץ 24 חדשות", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "channel24_square.png", "שידור חי ערוץ 24 חדשות", "/direct/hls/live/2035340/ch24live/index.m3u8");

        // Reshet - Channel 13
        this.addToLiveJSON("il_reshetTV_01", "רשת ערוץ 13", ["Actuality","אקטואליה"], URLS_ASSETS_BASE + "13.jpg", "שידור חי רשת ערוץ 13", "https://dsk76kvc9kie6.cloudfront.net/media/87f59c77-03f6-4bad-a648-897e095e7360/mainManifest.m3u8");

        // Channel 14
        this.addToLiveJSON("il_14TV_01", "ערוץ 14", ["Actuality","אקטואליה"], URLS_ASSETS_BASE + "14square.png", "שידור חי ערוץ 14", "https://ch14channel14.encoders.immergo.tv/app/2/streamPlaylist.m3u8");

        // Ynet
        this.addToLiveJSON("il_ynetTv_01", "שידור חי ynet", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "ynet_logo_gif_ynet.gif", "שידור חי ynet", "https://ynet-live-01.ynet-pic1.yit.co.il/ynet/live.m3u8");

        // i24 News (Fastly/Brightcove CDN)
        this.addToLiveJSON("il_24newsEng_01", "שידור חי באנגלית i24", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "i24new_english_square.png", "שידור חי באנגלית i24", "https://fastly.live.brightcove.com/6386790908112/eu-central-1/5377161796001/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJob3N0IjoiZXJmajYzLmVncmVzcy53YzQ3bTEiLCJhY2NvdW50X2lkIjoiNTM3NzE2MTc5NjAwMSIsImVobiI6ImZhc3RseS5saXZlLmJyaWdodGNvdmUuY29tIiwiaXNzIjoiYmxpdmUtcGxheWJhY2stc291cmNlLWFwaSIsInN1YiI6InBhdGhtYXB0b2tlbiIsImF1ZCI6WyI1Mzc3MTYxNzk2MDAxIl0sImp0aSI6IjYzODY3OTA5MDgxMTIifQ._w5c3EwfnEecDCEpDaKuVz07uuEyUb3vXvQN3svv-oU/playlist-hls.m3u8");
        this.addToLiveJSON("il_24newsHeb_01", "שידור חי בעיברית i24", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "i24news_hebrew_square.png", "שידור חי בעיברית i24", "https://fastly.live.brightcove.com/6386790215112/eu-central-1/5377161796001/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJob3N0IjoiZXJmajYzLmVncmVzcy53YzQ3bTEiLCJhY2NvdW50X2lkIjoiNTM3NzE2MTc5NjAwMSIsImVobiI6ImZhc3RseS5saXZlLmJyaWdodGNvdmUuY29tIiwiaXNzIjoiYmxpdmUtcGxheWJhY2stc291cmNlLWFwaSIsInN1YiI6InBhdGhtYXB0b2tlbiIsImF1ZCI6WyI1Mzc3MTYxNzk2MDAxIl0sImp0aSI6IjYzODY3OTAyMTUxMTIifQ.8ZawImK7DfcrrXeAT2OVZ62qQJrJiBaoc7Y1DNNq1bg/playlist-hls.m3u8");
        this.addToLiveJSON("il_24newsFrn_01", "שידור חי בצרפתית i24", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "i24new_french_square.png", "שידור חי בצרפתית i24", "https://fastly.live.brightcove.com/6386790513112/eu-central-1/5377161796001/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJob3N0IjoiZXJmajYzLmVncmVzcy53YzQ3bTEiLCJhY2NvdW50X2lkIjoiNTM3NzE2MTc5NjAwMSIsImVobiI6ImZhc3RseS5saXZlLmJyaWdodGNvdmUuY29tIiwiaXNzIjoiYmxpdmUtcGxheWJhY2stc291cmNlLWFwaSIsInN1YiI6InBhdGhtYXB0b2tlbiIsImF1ZCI6WyI1Mzc3MTYxNzk2MDAxIl0sImp0aSI6IjYzODY3OTA1MTMxMTIifQ.Szahkl5VVsEWGdM4mgrmlDPVkWPTRgBMwwGg4D5hGFU/playlist-hls.m3u8");
        this.addToLiveJSON("il_24newsArb_01", "שידור חי בערבית i24", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "i24news_arabic_square.png", "שידור חי בערבית i24", "https://fastly.live.brightcove.com/6386792572112/eu-central-1/5377161796001/eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJob3N0IjoiZXJmajYzLmVncmVzcy53YzQ3bTEiLCJhY2NvdW50X2lkIjoiNTM3NzE2MTc5NjAwMSIsImVobiI6ImZhc3RseS5saXZlLmJyaWdodGNvdmUuY29tIiwiaXNzIjoiYmxpdmUtcGxheWJhY2stc291cmNlLWFwaSIsInN1YiI6InBhdGhtYXB0b2tlbiIsImF1ZCI6WyI1Mzc3MTYxNzk2MDAxIl0sImp0aSI6IjYzODY3OTI1NzIxMTIifQ.vsA8IfCHFqoqo2BHxx4w0PqBgTESPMYgFGL771vzKoA/playlist-hls.m3u8");

        // Walla - stream no longer available
        // this.addToLiveJSON("il_walla_live_01", "וואלה! NEWS", ["Actuality","אקטואליה","news"], URLS_ASSETS_BASE + "walla_news_square.png", "שידור חי וואלה! NEWS", "", "https://www.walla.co.il/");

        // Channel 10 (Redge CDN)
        this.addToLiveJSON("il_10_live_01", "ערוץ עשר", ["Actuality","אקטואליה"], URLS_ASSETS_BASE + "10.png", "שידור חי ערוץ עשר", "https://r.il.cdn-redge.media/livehls/oil/calcala-live/live/channel10/live.livx/playlist.m3u8");


        logger.info("LiveTV => Done Crawling");
        if (isDoWriteFile){
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }
    }

    addToLiveJSON(id, name, genres, bkgImg, desc, streamUrl){
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
                background: bkgImg,
                poster: bkgImg,
                posterShape: "square",
                description: desc,
                videos: [
                    {
                        id: id,
                        name: name,
                        title: name,
                        description: desc,
                        streams: [{
                            url: streamUrl,
                            title: name,
                            name: name,
                            description: desc
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