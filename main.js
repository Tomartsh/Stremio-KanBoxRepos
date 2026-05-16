/**
 * Stremio KanBox Scraper Server
 *
 * This Express server provides HTTP endpoints to trigger scrapers in the background.
 *
 * Server runs on PORT (default: 49999) - configurable via environment variable.
 *
 * ENDPOINTS:
 *
 * GET /run?scraper=<name>&mode=<mode>
 *   Trigger a scraper to run in the background.
 *
 *   Parameters:
 *     scraper (required): kanDigital, kanArchive, kanKids, kanTeens, kanPodcasts,
 *                         kan88, mako, reshet, livetv
 *     mode (optional):    auto (default), full, incremental, skip
 *
 *   Modes:
 *     auto:        Use scraper configuration (KanDigital/KanPodcasts use incremental)
 *     full:        Force full scrape (ignore state, fetch all content)
 *     incremental: Force incremental mode (skip unchanged series)
 *     skip:        Skip scraping, validation only
 *
 *   Examples:
 *     /run?scraper=kanPodcasts
 *     /run?scraper=kanPodcasts&mode=full
 *     /run?scraper=kanDigital&mode=incremental
 *
 *   Response: Immediate confirmation, scraper runs in background.
 *   Check logs for progress: logs/Stremio-Repos.log
 *
 * GET /healthcheck
 *   Server health check.
 *
 * GET /
 *   Root endpoint with usage information.
 */

const express = require("express");
const path = require('path');

// Load .env FIRST - before any modules that read process.env
require("dotenv").config({
    debug: true,
    path: path.resolve(__dirname, './classes/.env')
});

const AdmZip = require("adm-zip");
const https = require("https");
const axios = require('axios');
const cron = require('node-cron');
const log4js = require("log4js");

//Express setup (setup is done before calling classes in order to make env variables available to them)
const app = express();
const PORT = process.env.PORT || 49999; //set the port if does not exist

const utils = require("./classes/utilities.js");
const {fetchData} = require("./classes/utilities.js");
const constants = require("./classes/constants.js");
const {
    LOG4JS,
} = require("./classes/constants.js");

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

log4js.configure({
    appenders: {
        out: { type: "stdout" },
        ScraperLogs:
        {
            type: LOG4JS.TYPE,
            filename: LOG4JS.FILENAME,
            maxLogSize: LOG4JS.MAX_SIZE,
            backups: LOG4JS.BACKUP_FILES, // keep five backup files
        }
    },
    categories: { default: { appenders: ['ScraperLogs','out'], level: LOG4JS.LEVEL } },
});

var logger = log4js.getLogger("main");

app.get('/run', async (req, res) => {

    const { scraper, mode } = req.query;
    // Validation FIRST
    if (!scraper) {
        return res.status(400).send("Missing ?scraper= parameter");
    }

    // List of valid scrapers to prevent the "Double Send" on the default case
    const validScrapers = ["kanDigital", "kanArchive", "kanKids", "kanTeens", "kanPodcasts", "kan88", "mako", "reshet", "livetv"];

    if (!validScrapers.includes(scraper)) {
        return res.status(404).send(`Unknown scraper: ${scraper}`);
    }

    // Determine scrape mode
    // Modes: 'auto' (default, uses config), 'full' (force full), 'incremental' (force incremental), 'skip' (validation only)
    const scrapeMode = mode || 'auto';

    // Send the "Started" response and END the request cycle here
    res.send(`✅ ${scraper} started in the background (mode: ${scrapeMode}).`);

    // 3. Run the logic in a "Fire and Forget" block with its own error handling
    // We don't 'await' this inside the route if we already sent a response
    (async () => {
        try {
            logger.info(`Starting execution for: ${scraper} (mode: ${scrapeMode})`);
            switch (scraper) {
                case "kanDigital": await new KanDigitalscraper().crawl(true, scrapeMode); break;
                case "kanArchive": await new KanArchivescraper().crawl(true, scrapeMode); break;
                case "kanKids":    await new KanKidscraper().crawl(true, scrapeMode);    break;
                case "kanTeens":   await new KanTeensscraper().crawl(true, scrapeMode);   break;
                case "kanPodcasts": await new KanPodcastsscraper().crawl(true, scrapeMode); break;
                case "kan88":      await new Kan88scraper().crawl(true, scrapeMode);      break;
                case "mako":       await new Makoscraper().crawl(true, scrapeMode);       break;
                case "reshet":     await new Reshetscraper().crawl(true, scrapeMode);     break;
                case "livetv":     await new LiveTV().crawl(true, scrapeMode);            break;
            }
            logger.info(`✅ ${scraper} completed successfully`);
        } catch (err) {
            // Since the response is already sent, we ONLY log the error.
            // This prevents the "Headers already sent" crash.
            logger.error(`❌ Background Error in ${scraper}:`, err);
        }
    })();

});

/**
 * GET /sanityCheck
 *   Run database sanity checks.
 *
 *   Parameters:
 *     mode (optional):    report (default), fix
 *     scraper (optional): Check only specific scraper (e.g., kanDigital)
 *     table (optional):   Check only specific table (series, videos, streams)
 *     quick (optional):   true=skip URL validations, false=full check
 *
 *   Examples:
 *     /sanityCheck
 *     /sanityCheck?mode=fix
 *     /sanityCheck?scraper=kanDigital
 *     /sanityCheck?mode=report&scraper=kanDigital&quick=true
 *
 *   Response: Immediate confirmation, check runs in background.
 */
app.get('/sanityCheck', async (req, res) => {
    const { mode, scraper, table, quick } = req.query;

    // Determine check mode
    const checkMode = mode === 'fix' ? 'fix' : 'report';
    const quickMode = quick === 'true' || quick === '1';

    // Send immediate response
    res.send(`✅ Database sanity check started in the background (mode: ${checkMode}${quickMode ? ', quick mode' : ''}). Check logs for details.`);

    // Run in background
    (async () => {
        try {
            const DatabaseSanityChecker = require('./scripts/database-sanity-checker.js');
            const checker = new DatabaseSanityChecker({
                fix: checkMode === 'fix',
                scraper: scraper || null,
                table: table || null,
                quick: quickMode,
                verbose: true
            });

            logger.info(`Starting database sanity check (mode: ${checkMode})`);
            await checker.run();
            logger.info(`✅ Database sanity check completed`);

        } catch (err) {
            logger.error(`❌ Error in sanity check:`, err);
        }
    })();
});

// Health check
app.get("/healthcheck", (req, res) => {
  res.send("Scraper server is running. Use /run?scraper=name");
});

// Optional root route to confirm server is live
app.get("/", (req, res) => {
  res.send("Scraper server is running. Use /run?scraper=name or /sanityCheck for database checks");
});

// Start server
app.listen(PORT, () => {
    logger.info(`🚀 Scraper server listening at http://localhost:${PORT}`);
});
