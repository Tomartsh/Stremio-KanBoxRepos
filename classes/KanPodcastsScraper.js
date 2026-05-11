const utils = require("./utilities.js");
const {fetchData, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    PODCASTS,
    KAN_BASE_URL,
    SCRAPER_CONFIG,
    TMDB
} = require("./constants.js");
const TmdbHelper = require("./TmdbHelper.js");

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

const EXPORT_FILENAME = "stremio-kanpodcasts";
var logger = log4js.getLogger("KanPodcastsScraper");

class KanPodcastsScraper {

    constructor() {
        this._kanPodcastsJSONObj = {};
        this.isRunning = false;
        this.tmdbHelper = new TmdbHelper();
        
        this.deltaTracker = new DeltaTracker();

        const scraperName = 'KanPodcastsScraper';
        const config = SCRAPER_CONFIG[scraperName] || {};
        this.config = {
            parallelFetching: config.parallelFetching ?? SCRAPER_CONFIG.DEFAULT_PARALLEL_FETCHING,
            batchSize: config.batchSize ?? SCRAPER_CONFIG.DEFAULT_BATCH_SIZE,
            delayBetweenBatches: config.delayBetweenBatches ?? SCRAPER_CONFIG.DEFAULT_DELAY_BETWEEN_BATCHES
        };

        logger.info(`KanPodcastsScraper initialized - Parallel: ${this.config.parallelFetching}, Batch size: ${this.config.batchSize}, TMDB: `);
    }

    /**
     * Helper method to process items in batches with detailed logging
     * @param {Array} items - Array of items to process
     * @param {Function} processor - Async function to process each item
     * @param {String} itemType - Description of item type for logging (e.g., "series", "episodes")
     * @returns {Promise<Array>} - Results from all processed items
     */
    async processBatch(items, processor, itemType = "items") {
        if (!this.config.parallelFetching) {
            // Sequential processing (original behavior)
            logger.info(`[${itemType}] Processing ${items.length} ${itemType} sequentially`);
            const results = [];
            for (let i = 0; i < items.length; i++) {
                const startTime = Date.now();
                logger.debug(`[${itemType}] Processing ${i + 1}/${items.length}`);
                try {
                    const result = await processor(items[i], i);
                    const duration = Date.now() - startTime;
                    logger.debug(`[${itemType}] Completed ${i + 1}/${items.length} in ${duration}ms`);
                    results.push(result);
                } catch (error) {
                    logger.error(`[${itemType}] Failed ${i + 1}/${items.length}: ${error.message}`);
                    results.push(null);
                }
            }
            return results;
        }

        // Parallel batch processing
        const { batchSize, delayBetweenBatches } = this.config;
        const totalBatches = Math.ceil(items.length / batchSize);
        logger.info(`[${itemType}] Processing ${items.length} ${itemType} in ${totalBatches} batches (${batchSize} per batch)`);

        const allResults = [];

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchStart = batchIndex * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, items.length);
            const batch = items.slice(batchStart, batchEnd);

            const batchNum = batchIndex + 1;
            const batchStartTime = Date.now();
            logger.info(`[${itemType}] Starting batch ${batchNum}/${totalBatches} (${itemType} ${batchStart + 1}-${batchEnd} of ${items.length})`);

            // Process batch in parallel
            const batchPromises = batch.map(async (item, indexInBatch) => {
                const globalIndex = batchStart + indexInBatch;
                const itemStartTime = Date.now();
                try {
                    const result = await processor(item, globalIndex);
                    const itemDuration = Date.now() - itemStartTime;
                    logger.debug(`[${itemType}] ✓ Item ${globalIndex + 1}/${items.length} completed in ${itemDuration}ms`);
                    return { success: true, result, index: globalIndex };
                } catch (error) {
                    const itemDuration = Date.now() - itemStartTime;
                    logger.error(`[${itemType}] ✗ Item ${globalIndex + 1}/${items.length} failed after ${itemDuration}ms: ${error.message}`);
                    return { success: false, error, index: globalIndex };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            const batchDuration = Date.now() - batchStartTime;
            const successCount = batchResults.filter(r => r.success).length;
            const failCount = batchResults.length - successCount;

            logger.info(`[${itemType}] Batch ${batchNum}/${totalBatches} completed: ${successCount}/${batch.length} successful, ${failCount} failed in ${batchDuration}ms`);

            allResults.push(...batchResults.map(r => r.result));

            // Delay between batches to avoid rate limiting (except after last batch)
            if (batchIndex < totalBatches - 1 && delayBetweenBatches > 0) {
                logger.debug(`[${itemType}] Waiting ${delayBetweenBatches}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }

        const successfulResults = allResults.filter(r => r !== null && r !== undefined);
        logger.info(`[${itemType}] All batches completed: ${successfulResults.length}/${items.length} total successful`);

        return allResults;
    }

    async crawl(isDoWriteFile = false){
    logger.info("Started Crawling");
    this.isRunning = true;

    // Crawl regular podcasts
    await this.crawlPodcasts(PODCASTS.KAN_CATEGORIES, "p", "Podcasts");

    // Crawl kids podcasts
    //await this.crawlPodcasts(PODCASTS.KAN_CHILDREN_CATEGORIES, "h", "Podcasts");

    logger.info("Done Crawling");
    logger.info("Delta Summary:", JSON.stringify(this.deltaTracker.getSummary()));

    const { WRITE_TO_GITHUB, UPDATE_DATABASE } = require("./constants.js");

    if (WRITE_TO_GITHUB || UPDATE_DATABASE) {
        if (WRITE_TO_GITHUB) {
            logger.info("crawl => writing JSON file to GitHub");
            this.writeJSON();
        }

        if (UPDATE_DATABASE) {
            logger.info("crawl => updating database in bulk");
            await this.updateDatabase();
        }
    } else if (isDoWriteFile) {
        // Backward compatibility
        logger.info("crawl => writing JSON file");
        this.writeJSON();
    }

    this.isRunning = false;
}


    /**
     * Main method:
     * 1. Fetch all podcast series from mobile JSON API (paged).
     * 2. For each series, fetch its episodes (JSON, same API family).
     * 3. Build Stremio‑ready structure in memory.
     *
     * @param {string} categoryId - The category ID to fetch (regular or kids)
     * @param {string} subType - The subtype identifier ("p" for regular, "h" for kids)
     * @param {string} type - The content type (usually "series")
     */
    async crawlPodcasts(categoryId, subType, type){
        logger.trace(`crawlPodcasts => Entering (category: ${categoryId}, subType: ${subType})`);
        logger.debug(`crawlPodcasts => Fetching podcast series list for category ${categoryId}...`);

        let seriesList;

        try {
            seriesList = await this.getAllSeries(categoryId);
            logger.debug(`crawlPodcasts => Found ${seriesList.length} series.`);
        } catch (error) {
            logger.error(`crawlPodcasts => Error cannot get series list for category ${categoryId}:`, error);
            return;
        }

        if (!Array.isArray(seriesList) || seriesList.length === 0) {
            logger.warn(`crawlPodcasts => No series returned from mobile API for category ${categoryId}`);
            return;
        }

        // Filter out invalid series before processing
        const validSeriesList = seriesList.filter(series => {
            const pageUrl = series.link?.href?.replace('?app=true', '') || '';
            return series.id && !pageUrl.includes("kan88");
        });

        logger.info(`crawlPodcasts => Processing ${validSeriesList.length} valid series (filtered ${seriesList.length - validSeriesList.length})`);

        // Process series using batch processor
        await this.processBatch(
            validSeriesList,
            async (series) => {
                return await this.processOneSeries(series, subType, type);
            },
            `podcast-series (${subType})`
        );

        logger.trace(`crawlPodcasts => Exiting (category: ${categoryId})`);
    }

    /**
     * Process a single podcast series (extracted from crawlPodcasts for batch processing)
     */
    async processOneSeries(series, subType, type) {
        const pageUrl = series.link?.href?.replace('?app=true', '') || '';
        const programId = series.id;
        const title = series.title;
        const description = series.description || "";

        // Generate numerical series ID using the utility function
        const stremioId = utils.generateSeriesId(pageUrl, PODCASTS.SUBPREFIX, "0");
        const podcastImageUrl = series.media_group?.[0]?.media_item?.[0]?.src || "";

        logger.debug(`processOneSeries => Processing: ${title} (OriginalID: ${programId}, StremioID: ${stremioId})`);

        // Search TMDB for this series
        let tmdbSeriesId = null;
        tmdbSeriesId = await this.tmdbHelper.searchTMDBSeries(title);
        if (tmdbSeriesId) {
            logger.info(`processOneSeries => Found TMDB ID ${tmdbSeriesId} for "${title}"`);
        }

        try {
            const episodes = await this.getEpisodes(programId, pageUrl);

            if (episodes.length > 0) {
                logger.debug(`processOneSeries => Found ${episodes.length} episodes for ${title}`);

                // Convert episodes to videos format expected by Stremio
                // Episode numbering: newest episode = highest number
                // Streams are empty - resolved on-demand by the addon
                const videosList = episodes.map((ep, index) => {
                    const episodeNo = episodes.length - index;
                    const episodeId = `${stremioId}:1:${episodeNo}`;

                    // Create unique title: include episode number to avoid duplicates
                    // If original title already includes "Episode X", prepend the number
                    // Otherwise, add "Episode X" prefix
                    let uniqueTitle = ep.title;
                    if (!uniqueTitle.match(/^פרק \d+/)) {
                        uniqueTitle = `פרק ${episodeNo}: ${uniqueTitle}`;
                    }

                    return {
                        id: episodeId,
                        title: uniqueTitle,
                        name: uniqueTitle,
                        season: 1,
                        episode: episodeNo,
                        description: ep.description,
                        thumbnail: ep.thumbnail,
                        released: ep.released,
                        episodeLink: ep.episodeLink,
                        streams: [] // Resolved on-demand by the addon
                    };
                });

                this.addToJsonObject(
                    stremioId,
                    title,
                    pageUrl,
                    podcastImageUrl,
                    description,
                    [],
                    videosList,
                    subType,
                    type,
                    tmdbSeriesId
                );

                return { stremioId, title, episodeCount: episodes.length };
            } else {
                logger.warn(`processOneSeries => No episodes found for ${title}`);
                return null;
            }
        } catch (error) {
            logger.error(`processOneSeries => Error processing ${title}:`, error.message);
            return null;
        }
    }

    /**
    * Replicates GetRadioSeriesList logic: fetches all series entries.
    * Uses chunks of 200 as seen in the Python code.
    */
    async getAllSeries(categoryId) {
        let allEntries = [];
        let from = 1;
        let hasMore = true;
        const chunkSize = 200;

        logger.info(`getAllSeries => Starting fetch for category ${categoryId}`);

        while (hasMore) {
            logger.debug(`getAllSeries => Fetching from=${from}`);
            
            const response = await fetchData(PODCASTS.BASE_MOB_API, true, 
                { id: categoryId, from: from },
                { 'User-Agent': PODCASTS.USER_AGENT }
            );

            if (!response) {
                logger.warn("getAllSeries => Null response, stopping pagination");
                break;
            }

            const entries = response.entry || [];

            if (!Array.isArray(entries) || entries.length === 0) {
                logger.debug("getAllSeries => No more entries, stopping");
                hasMore = false;
                break;
            }

            logger.debug(`getAllSeries => Got ${entries.length} entries in this batch`);

            // Filter out duplicates based on ID before adding
            const newEntries = entries.filter(entry => 
                !allEntries.some(existing => existing.id === entry.id)
            );

            logger.debug(`getAllSeries => ${newEntries.length} new unique entries (filtered ${entries.length - newEntries.length} duplicates)`);

            allEntries = allEntries.concat(newEntries);

            // Stop if we got fewer entries than chunk size (last page)
            if (entries.length < chunkSize) {
                logger.debug(`getAllSeries => Last page reached (got ${entries.length} < ${chunkSize})`);
                hasMore = false;
            } else {
                from += chunkSize;
            }
        }

        logger.info(`getAllSeries => Accumulated ${allEntries.length} unique series entries for category ${categoryId}`);
        return allEntries;
    }

    
    /**
     * getEpisodes: Scrape HTML page with pagination support
     */
    async getEpisodes(programId, pageUrl = null) {
        logger.trace(`getEpisodes => Entering (programId=${programId}, pageUrl=${pageUrl})`);

        if (!pageUrl) {
            logger.warn(`getEpisodes => No pageUrl provided, cannot fetch episodes`);
            return [];
        }

        logger.debug(`getEpisodes => Scraping episodes from: ${pageUrl}`);

        try {
            const allEpisodes = [];

            // STEP 1: Fetch first page and detect total pages
            const firstPageDoc = await fetchData(pageUrl, false);
            if (!firstPageDoc) {
                logger.error(`getEpisodes => Could not fetch first page: ${pageUrl}`);
                return [];
            }

            // Detect total number of pages
            const lastPageElement = firstPageDoc.querySelector('li[class*="pagination-page__item"][title*="Last page"]');
            const totalPages = lastPageElement ? parseInt(lastPageElement.getAttribute('data-num')) : 1;

            logger.debug(`getEpisodes => Detected ${totalPages} pages for podcast`);

            // STEP 2: Parse all pages
            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                logger.debug(`getEpisodes => Parsing page ${pageNum}/${totalPages}`);

                let pageDoc = firstPageDoc;

                // Fetch additional pages (skip first page as we already have it)
                if (pageNum > 1) {
                    const pageUrl_withParams = `${pageUrl}?page=${pageNum}`;
                    logger.trace(`getEpisodes => Fetching: ${pageUrl_withParams}`);

                    pageDoc = await fetchData(pageUrl_withParams, false);
                    if (!pageDoc) {
                        logger.warn(`getEpisodes => Could not fetch page ${pageNum}, skipping`);
                        continue;
                    }
                }

                // Parse episodes on this page
                const episodeElements = pageDoc.querySelectorAll("div.card.card-row");
                logger.debug(`getEpisodes => Found ${episodeElements.length} episodes on page ${pageNum}`);

                for (const episodeElem of episodeElements) {
                    try {
                        const episode = await this.parseEpisodeElement(episodeElem, programId);
                        if (episode) {
                            allEpisodes.push(episode);
                            logger.info(`Added: ${episode.title}`);
                        }
                    } catch (error) {
                        logger.warn(`getEpisodes => Error parsing episode element:`, error.message);
                    }
                }
            }

            logger.info(`getEpisodes => Successfully parsed ${allEpisodes.length} total episodes`);

            // Sort episodes by release date (newest first)
            allEpisodes.sort((a, b) => {
                const dateA = a.released ? new Date(a.released).getTime() : 0;
                const dateB = b.released ? new Date(b.released).getTime() : 0;
                return dateB - dateA; // Descending (newest first)
            });

            logger.debug(`getEpisodes => Episodes sorted by release date (newest first)`);
            return allEpisodes;

        } catch (error) {
            logger.error(`getEpisodes => Error:`, error.message);
            return [];
        }
    }

    /**
     * Parse a single episode card element
     * NOTE: Stream URLs are NOT fetched during scraping to avoid Cloudflare rate limiting.
     * The episodeLink is stored and streams are resolved on-demand when user plays.
     */
    async parseEpisodeElement(episodeElem, programId) {
        logger.trace(`parseEpisodeElement => Parsing episode element`);

        try {
            // Extract episode link
            const episodeLinkElem = episodeElem.querySelector("a.card-body");
            if (!episodeLinkElem) {
                logger.debug(`parseEpisodeElement => No card-body link found`);
                return null;
            }

            let episodeLink = episodeLinkElem.getAttribute("href");
            if (!episodeLink) {
                logger.debug(`parseEpisodeElement => No href found`);
                return null;
            }

            // Make link absolute
            if (episodeLink.startsWith("/")) {
                episodeLink = KAN_BASE_URL + episodeLink;
            }

            // Extract title
            const titleElem = episodeElem.querySelector("h2.card-title");
            const episodeTitle = titleElem
                ? titleElem.text.trim().replace(/^פרק \d+:\s*/, '').trim()
                : "Unknown";

            // Extract image
            const imgElem = episodeElem.querySelector("img.img-full");
            const episodeImgUrl = imgElem
                ? utils.getImageFromUrl(imgElem.getAttribute("src"), "p")
                : "";

            // Extract description
            const descElem = episodeElem.querySelector("div.description");
            const episodeDescription = descElem ? descElem.text.trim() : "";

            // Extract release date
            let released = "";
            const dateElem = episodeElem.querySelector("li.date-local");
            if (dateElem) {
                const dateUtc = dateElem.getAttribute("data-date-utc");
                if (dateUtc) {
                    const date = new Date(dateUtc);
                    released = isNaN(date.getTime()) ? "" : date.toISOString();
                }
            }

            // Store episodeLink for on-demand stream resolution (no fetch needed here)
            logger.debug(`parseEpisodeElement => ✓ ${episodeTitle} (stream on-demand from: ${episodeLink})`);

            return {
                title: episodeTitle,
                description: episodeDescription,
                thumbnail: episodeImgUrl,
                released: released,
                episodeLink: episodeLink,
                streamUrl: "" // Resolved on-demand by the addon
            };

        } catch (error) {
            logger.error(`parseEpisodeElement => Error:`, error.message);
            return null;
        }
    }
    
    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, subType, type, tmdbSeriesId = null){
        const seriesObj = {
            id: id,
            name: seriesTitle,
            poster: imgUrl,
            description: seriesDescription,
            link: seriesPage,
            background: imgUrl,
            genres: genres,
            type: type,
            subtype: subType,
            meta: {
                id: id,
                type: type,
                name: seriesTitle,
                link: seriesPage,
                background: imgUrl,
                poster: imgUrl,
                posterShape: "poster",
                logo: imgUrl,
                description: seriesDescription,
                genres: genres,
                videos: videosList
            }
        };

        // Add TMDB series ID if found
        if (tmdbSeriesId) {
            seriesObj.meta.tmdbId = tmdbSeriesId;
            seriesObj.tmdbId = tmdbSeriesId;
            logger.debug(`addToJsonObject => Added TMDB ID ${tmdbSeriesId} to series "${seriesTitle}"`);
        }

        this._kanPodcastsJSONObj[id] = seriesObj;

        logger.info("addToJsonObject => Added  series, ID: " + id + " Name: " + seriesTitle + " Link: " + seriesPage + " subtype: " + subType);
    }

    async updateDatabase() {
        logger.trace("updateDatabase => Entered");
        logger.debug("updateDatabase => Starting bulk database update");

        try {
            const result = await updateDatabaseFromJSON('kanpodcasts', this._kanPodcastsJSONObj, logger);
            logger.info(`updateDatabase => ✅ Updated ${result.series} series, ${result.videos} videos, ${result.streams} streams in ${result.duration}s`);
        } catch (error) {
            logger.error(`updateDatabase => ❌ Failed to update database: ${error.message}`);
            throw error;
        }

        logger.trace("updateDatabase => Leaving");
    }

    writeJSON(){
        logger.trace("writeJSON => Entered");
        logger.debug("writeJSON => All tasks completed - writing file");
        utils.writeJSONToFile(this._kanPodcastsJSONObj, EXPORT_FILENAME);

        logger.trace("writeJSON => Leaving");

    }
}

/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanPodcastsScraper;
exports.crawl = this.crawl;
exports.isRunning = this.isRunning;
exports.writeJSON = this.writeJSON;