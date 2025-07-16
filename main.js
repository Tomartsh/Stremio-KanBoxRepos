const express = require("express");
const AdmZip = require("adm-zip");
const https = require("https");
const axios = require('axios');
const cron = require('node-cron');
const log4js = require("log4js"); 

const utils = require("./classes/utilities.js");
const {fetchData} = require("./classes/utilities.js");
const constants = require("./classes/constants.js");
const {URL_ZIP_FILES, LOG_FILENAME, LOG4JS_LEVEL, MAX_LOG_SIZE, LOG_BACKUP_FILES} = require("./classes/constants.js");

//Scraper imports
const KanDigitalscraper = require("./classes/KanDigitalScraper.js");
const KanArchivescraper = require("./classes/KanArchiveScraper.js");
const KanKidscraper = require("./classes/KanKidsScraper.js");
const KanTeensscraper = require("./classes/KanTeensScraper.js");
const KanPodcastsscraper = require("./classes/KanPodcastsScraper.js");
const Kan88scraper = require("./classes/Kan88Scraper.js");
const Makoscraper = require("./classes/MakoScraper.js");
const Reshetscraper = require("./classes/ReshetScraper.js");
const LiveTV = require("./classes/LiveTV.js"); 

require("dotenv").config({debug: true}); // Load .env from config folder

log4js.configure({
	appenders: { 
		out: { type: "stdout" },
		ScraperLogs: 
		{ 
			type: "file", 
			filename: LOG_FILENAME, 
			maxLogSize: MAX_LOG_SIZE,
			backups: LOG_BACKUP_FILES, // keep five backup files
		}
	},
	categories: { default: { appenders: ['ScraperLogs','out'], level: LOG4JS_LEVEL } },
});

var logger = log4js.getLogger("main");

//Express setup
const app = express();  
const PORT = process.env.PORT || 49699; //set the port if does not exist

app.get('/run', async (req, res) => {
 	const { scraper } = req.query;
	logger.debug("request for: " + scraper);

	try {
		if (!scraper) { return res.status(400).send("Missing ?scraper= parameter");}

		logger.info(`Triggered scraper: ${scraper}`);

		switch (scraper) {
		case "kanDigital":
			await new KanDigitalscraper().crawl(true);
			break;
		case "kanArchive":
			await new KanArchivescraper().crawl(true);
			break;
		case "kanKids":
			await new KanKidscraper().crawl(true);
			break;
		case "kanTeens":
			await new KanTeensscraper().crawl(true);
			break;
		case "kanPodcasts":
			await new KanPodcastsscraper().crawl(true);
			break;
		case "kan88":
			await new Kan88scraper().crawl(true);
			break;
		case "mako":
			await new Makoscraper().crawl(true);
			break;
		case "reshet":
			await new Reshetscraper().crawl(true);
			break;
		case "livetv":
			await new LiveTV().crawl(true);
			break;

		default:
			logger.debug("scraper " + scraper  + " unknown");
			return res.status(404).send("Unknown scraper: " + scraper);
	}

    res.send(`✅ ${scraper} completed successfully`);
  } catch (err) {
    logger.error(`❌ Error running ${scraper}:`, err);
    res.status(500).send("Scraper failed – see logs");
  }
});

// Health check
app.get("/healthcheck", (req, res) => {
  res.send("Scraper server is running. Use /run?scraper=name");
});

// Optional root route to confirm server is live
app.get("/", (req, res) => {
  res.send("Scraper server is running. Use /run?scraper=name");
});

// Start server
app.listen(PORT, () => {
  logger.info(`🚀 Scraper server listening at http://localhost:${PORT}`);
});

