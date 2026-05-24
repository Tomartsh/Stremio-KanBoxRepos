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
 *
 * GET /admin/stats
 *   Get database statistics by scraper type.
 *
 *   Examples:
 *     /admin/stats
 *
 * GET /admin/wipe/<scraper>
 *   Delete all data for a specific scraper from database.
 *   WARNING: This is destructive! Use with caution.
 *
 *   Parameters:
 *     scraper (required): kanDigital, kanArchive, kanKids, kanTeens, kanPodcasts,
 *                         kan88, mako, reshet, livetv
 *
 *   Examples:
 *     /admin/wipe/kanPodcasts
 *     /admin/wipe/mako
 *
 * GET /admin/diagnose/<scraper>
 *   Diagnose data for a specific scraper - check episodeLink and streams.
 *
 *   Examples:
 *     /admin/diagnose/kanPodcasts
 *     /admin/diagnose/kanDigital
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

/**
 * GET /admin/stats
 *   Get database statistics by scraper type.
 *
 *   Examples:
 *     /admin/stats
 */
app.get('/admin/stats', async (req, res) => {
    try {
        const DatabaseUpdater = require('./classes/DatabaseUpdater.js');
        const dbUpdater = new DatabaseUpdater();

        const { data, error } = await dbUpdater.supabase
            .from('series')
            .select('scraper');

        const stats = {
            timestamp: new Date().toISOString(),
            byScraper: {}
        };

        if (!error && data) {
            data.forEach(s => {
                stats.byScraper[s.scraper] = (stats.byScraper[s.scraper] || 0) + 1;
            });
        }

        stats.totalSeries = data?.length || 0;
        res.json(stats);

    } catch (error) {
        logger.error(`[ADMIN] Stats error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /admin/wipe/:scraper
 *   Delete all data for a specific scraper from database.
 *   WARNING: This is destructive! Use with caution.
 *
 *   Examples:
 *     /admin/wipe/kanPodcasts
 *     /admin/wipe/mako
 */
app.get('/admin/wipe/:scraper', async (req, res) => {
    const scraper = req.params.scraper;

    // Validate scraper name
    const validScrapers = ["kanDigital", "kanArchive", "kanKids", "kanTeens", "kanPodcasts", "kan88", "mako", "reshet", "livetv"];
    const scraperMap = {
        "kanDigital": "kandigital",
        "kanArchive": "kanarchive",
        "kanKids": "kankids",
        "kanTeens": "kanteens",
        "kanPodcasts": "kanpodcasts",
        "kan88": "kan88",
        "mako": "mako",
        "reshet": "reshet",
        "livetv": "livetv"
    };

    if (!validScrapers.includes(scraper)) {
        return res.status(400).json({ error: `Invalid scraper: ${scraper}. Valid options: ${validScrapers.join(', ')}` });
    }

    const dbKey = scraperMap[scraper];

    logger.warn(`[ADMIN] Wipe requested for: ${dbKey}`);

    try {
        const DatabaseUpdater = require('./classes/DatabaseUpdater.js');
        const dbUpdater = new DatabaseUpdater();

        // Get existing series count
        const { data: existingSeries } = await dbUpdater.supabase
            .from('series')
            .select('id')
            .eq('scraper', dbKey);

        const seriesCount = existingSeries?.length || 0;

        if (seriesCount === 0) {
            return res.json({
                message: `No data found for ${scraper}`,
                deleted: { series: 0, videos: 0, streams: 0 }
            });
        }

        const seriesIds = existingSeries.map(s => s.id);

        // Get all video IDs
        const { data: allVideos } = await dbUpdater.supabase
            .from('videos')
            .select('id')
            .in('series_id', seriesIds);

        const videoCount = allVideos?.length || 0;

        // Delete streams
        if (allVideos && allVideos.length > 0) {
            const videoIds = allVideos.map(v => v.id);
            await dbUpdater.supabase.from('streams').delete().in('video_id', videoIds);
        }

        // Delete videos
        await dbUpdater.supabase.from('videos').delete().in('series_id', seriesIds);

        // Delete series
        await dbUpdater.supabase.from('series').delete().eq('scraper', dbKey);

        const result = {
            message: `Successfully deleted ${seriesCount} series, ${videoCount} videos for ${scraper}`,
            deleted: { series: seriesCount, videos: videoCount, streams: videoCount }
        };

        logger.warn(`[ADMIN] ${result.message}`);
        res.json(result);

    } catch (error) {
        logger.error(`[ADMIN] Wipe error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
});

/**
 * GET /admin/diagnose/:scraper
 *   Diagnose data for a specific scraper - check episodeLink and streams.
 *
 *   Examples:
 *     /admin/diagnose/kanPodcasts
 *     /admin/diagnose/kanDigital
 */
app.get('/admin/diagnose/:scraper', async (req, res) => {
    const scraper = req.params.scraper;

    // Validate scraper name
    const validScrapers = ["kanDigital", "kanArchive", "kanKids", "kanTeens", "kanPodcasts", "kan88", "mako", "reshet", "livetv"];
    const scraperMap = {
        "kanDigital": "kandigital",
        "kanArchive": "kanarchive",
        "kanKids": "kankids",
        "kanTeens": "kanteens",
        "kanPodcasts": "kanpodcasts",
        "kan88": "kan88",
        "mako": "mako",
        "reshet": "reshet",
        "livetv": "livetv"
    };

    if (!validScrapers.includes(scraper)) {
        return res.status(400).json({ error: `Invalid scraper: ${scraper}. Valid options: ${validScrapers.join(', ')}` });
    }

    const dbKey = scraperMap[scraper];

    logger.info(`[ADMIN] Diagnostics requested for: ${dbKey}`);

    try {
        const DatabaseUpdater = require('./classes/DatabaseUpdater.js');
        const dbUpdater = new DatabaseUpdater();

        const diagnostics = {
            timestamp: new Date().toISOString(),
            scraper: scraper,
            dbKey: dbKey,
            series: [],
            summary: {
                totalSeries: 0,
                totalVideos: 0,
                videosWithEpisodeLink: 0,
                videosWithStreams: 0,
                videosWithoutEpisodeLink: 0
            },
            errors: []
        };

        // Get series from database
        const { data: seriesList, error: seriesError } = await dbUpdater.supabase
            .from('series')
            .select('id, name, scraper')
            .eq('scraper', dbKey)
            .limit(10); // Sample first 10

        if (seriesError) {
            diagnostics.errors.push(`Series query error: ${seriesError.message}`);
            return res.status(500).json(diagnostics);
        }

        diagnostics.summary.totalSeries = seriesList?.length || 0;

        // For each series, check videos
        for (const series of seriesList || []) {
            const seriesInfo = {
                id: series.id,
                name: series.name,
                videoCount: 0,
                videosWithEpisodeLink: 0,
                videosWithStreams: 0,
                sampleVideos: []
            };

            // Get videos for this series
            const { data: videos, error: videosError } = await dbUpdater.supabase
                .from('videos')
                .select('id, title, episode_link, released')
                .eq('series_id', series.id)
                .limit(5); // Sample first 5

            if (!videosError && videos) {
                seriesInfo.videoCount = videos.length;
                diagnostics.summary.totalVideos += videos.length;

                for (const video of videos) {
                    const hasEpisodeLink = !!video.episode_link;
                    if (hasEpisodeLink) seriesInfo.videosWithEpisodeLink++;
                    diagnostics.summary.videosWithEpisodeLink += hasEpisodeLink ? 1 : 0;
                    diagnostics.summary.videosWithoutEpisodeLink += hasEpisodeLink ? 0 : 1;

                    // Check streams for this video
                    const { data: streams, error: streamsError } = await dbUpdater.supabase
                        .from('streams')
                        .select('url')
                        .eq('video_id', video.id)
                        .limit(1);

                    const hasStreams = !streamsError && streams && streams.length > 0;
                    if (hasStreams) {
                        seriesInfo.videosWithStreams++;
                        diagnostics.summary.videosWithStreams++;
                    }

                    seriesInfo.sampleVideos.push({
                        id: video.id,
                        title: video.title,
                        hasEpisodeLink,
                        hasStreams,
                        released: video.released
                    });
                }
            }

            diagnostics.series.push(seriesInfo);
        }

        logger.info(`[ADMIN] Diagnostics complete: ${diagnostics.summary.totalSeries} series, ${diagnostics.summary.totalVideos} videos`);
        res.json(diagnostics);

    } catch (error) {
        logger.error(`[ADMIN] Diagnostics error: ${error.message}`);
        res.status(500).json({ error: error.message });
    }
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
