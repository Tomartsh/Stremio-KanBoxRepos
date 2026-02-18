const utils = require("./utilities.js");
const {
    LOG4JS,
    URL_SPORT5_VOD, 
    PREFIX, 
    //LOG4JS_LEVEL,
    //MAX_LOG_SIZE, 
    //LOG_BACKUP_FILES
} = require ("./constants");
const {fetchData, writeLog} = require("./utilities.js");
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

var logger = log4js.getLogger("Sport5Scraper");

class Sport5Scraper {

    constructor(){
        this._sport5JSONObj = {};
    }

    async crawl(isDoWriteFile = false){
        logger.trace("crawl() => Entering");

        var jsonCategories = await fetchData(URL_SPORT5_VOD, true); 
    }

}