const express = require("express");
const AdmZip = require("adm-zip");
const https = require("https");
const axios = require('axios');
const cron = require('node-cron');
const log4js = require("log4js"); 
const path = require('path');

//Express setup (setup is done before calling classes in order to make env variables available to them)
const app = express();  
const PORT = process.env.PORT || 49999; //set the port if does not exist

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

require("dotenv").config({
	debug: true,
	path: path.resolve(__dirname, './classes/.env')
}); // Load .env from config folder

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

app.get('/run', async (req, res) => {
	
 	const { scraper } = req.query;
	// Validation FIRST
    if (!scraper) { 
        return res.status(400).send("Missing ?scraper= parameter");
    }

    // List of valid scrapers to prevent the "Double Send" on the default case
    const validScrapers = ["kanDigital", "kanArchive", "kanKids", "kanTeens", "kanPodcasts", "kan88", "mako", "reshet", "livetv"];

    if (!validScrapers.includes(scraper)) {
        return res.status(404).send(`Unknown scraper: ${scraper}`);
    }

    // Send the "Started" response and END the request cycle here
    res.send(`✅ ${scraper} started in the background.`);

	// 3. Run the logic in a "Fire and Forget" block with its own error handling
    // We don't 'await' this inside the route if we already sent a response
    (async () => {
        try {
            logger.info(`Starting execution for: ${scraper}`);
            switch (scraper) {
                case "kanDigital": await new KanDigitalscraper().crawl(true); break;
                case "kanArchive": await new KanArchivescraper().crawl(true); break;
                case "kanKids":    await new KanKidscraper().crawl(true);    break;
                case "kanTeens":   await new KanTeensscraper().crawl(true);   break;
                case "kanPodcasts": await new KanPodcastsscraper().crawl(true); break;
                case "kan88":      await new Kan88scraper().crawl(true);      break;
                case "mako":       await new Makoscraper().crawl(true);       break;
                case "reshet":     await new Reshetscraper().crawl(true);     break;
                case "livetv":     await new LiveTV().crawl(true);            break;
            }
            logger.info(`✅ ${scraper} completed successfully`);
        } catch (err) {
            // Since the response is already sent, we ONLY log the error.
            // This prevents the "Headers already sent" crash.
            logger.error(`❌ Background Error in ${scraper}:`, err);
        }
    })();
	/*
	try {
		// Run the scraper based on the provided name
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

		//res.send(`✅ ${scraper} completed successfully`);
	} catch (err) {
		logger.error(`❌ Error running ${scraper}:`, err);
		res.status(500).send("Scraper failed – see logs for error " + err.message);
	}

	*/
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
