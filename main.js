const AdmZip = require("adm-zip");
const https = require("https");
const axios = require('axios');
const cron = require('node-cron');
const log4js = require("log4js"); 

const utils = require("./classes/utilities.js");
const {fetchData} = require("./classes/utilities.js");
//const KanDigitalscraper = require("./classes/KanDigitalScraper.js");
//const KanArchivescraper = require("./classes/KanArchiveScraper.js");
//const KanKidscraper = require("./classes/KanKidsScraper.js");
//const KanTeensscraper = require("./classes/KanTeensScraper.js");
//const KanPodcastsscraper = require("./classes/KanPodcastsScraper.js");
//const Kan88scraper = require("./classes/Kan88Scraper.js");
// const Makoscraper = require("./classes/MakoScraper.js");
// const Reshetscraper = require("./classes/ReshetScraper.js");
// const LiveTV = require("./classes/LiveTV.js"); 
const constants = require("./classes/constants.js");
const {URL_ZIP_FILES, URL_JSON_BASE, LOG4JS_LEVEL, MAX_LOG_SIZE, LOG_BACKUP_FILES} = require("./classes/constants.js");
// require("dotenv").config(); // Load .env from config folder

log4js.configure({
	appenders: { 
		out: { type: "stdout" },
		Stremio: 
		{ 
			type: "file", 
			filename: "logs/Stremio_addon.log", 
			maxLogSize: MAX_LOG_SIZE,
			backups: LOG_BACKUP_FILES, // keep five backup files
		}
	},
	categories: { default: { appenders: ['Stremio','out'], level: LOG4JS_LEVEL } },
});

var logger = log4js.getLogger("addon");

// const liveTV = new LiveTV();
//liveTV.crawl(true);
// const makoScraper = new Makoscraper()
//makoScraper.crawl(true);
// const reshetScraper = new Reshetscraper();
//reshetScraper.crawl(true);
// const kanDigitalScraper = new KanDigitalscraper()
//kanDigitalScraper.crawl(true);
// const kanArchiveScraper = new KanArchivescraper()
//kanArchiveScraper.crawl(true);
// const kanKidsScraper = new KanKidscraper()
//kanKidsScraper.crawl(true);
// const kanTeensScraper = new KanTeensscraper()
//kanTeensScraper.crawl(true);
// const kanPodcastsScraper = new KanPodcastsscraper()
//kanPodcastsScraper.crawl(true);
// const kan88Scraper = new Kan88scraper();
//kan88Scraper.crawl(true);

logger.trace("leaving main");