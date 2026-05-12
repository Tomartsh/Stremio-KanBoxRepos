const {
    LOG4JS,
    SCRAPER_CONFIG,
    WRITE_TO_GITHUB,
    UPDATE_DATABASE
} = require("./constants.js");
const { DeltaTracker, updateDatabaseFromJSON } = require("./utilities.js");
const { CircuitBreaker, RateLimiter } = require("./ScraperHelpers.js");
const log4js = require("log4js");

// Configure log4js once globally (instead of per scraper)
log4js.configure({
    appenders: {
        out: { type: "stdout" },
        Stremio: {
            type: LOG4JS.TYPE,
            filename: LOG4JS.FILENAME,
            maxLogSize: LOG4JS.MAX_SIZE,
            backups: LOG4JS.BACKUP_FILES,
        }
    },
    categories: { default: { appenders: ['Stremio', 'out'], level: LOG4JS.LEVEL } },
});

/**
 * BaseScraper - Abstract base class for all scrapers
 *
 * Provides common functionality:
 * - Batch processing with configurable parallel/sequential modes
 * - Configuration handling from SCRAPER_CONFIG
 * - Database update and JSON file writing
 * - Delta tracking for changes
 * - Standardized crawl() template
 *
 * Subclasses must implement:
 * - crawlContent() - Main scraping logic (abstract)
 * - getExportFilename() - Return filename for JSON output
 * - getDatabaseKey() - Return database key for updates
 */
class BaseScraper {
    constructor(scraperName, options = {}) {
        if (!scraperName) {
            throw new Error('scraperName is required');
        }

        this.scraperName = scraperName;
        this._jsonObj = {};
        this.isRunning = false;
        this.deltaTracker = new DeltaTracker();

        // Load scraper-specific config or use defaults
        const config = SCRAPER_CONFIG[scraperName + 'Scraper'] || {};

        // Initialize circuit breaker and rate limiter for safer scraping
        this.circuitBreaker = new CircuitBreaker(
            config.circuitBreakerThreshold || 5,
            config.circuitBreakerTimeout || 60000
        );
        this.rateLimiter = new RateLimiter(
            config.requestsPerSecond || 2
        );
        this.config = {
            parallelFetching: config.parallelFetching ?? SCRAPER_CONFIG.DEFAULT_PARALLEL_FETCHING,
            batchSize: config.batchSize ?? SCRAPER_CONFIG.DEFAULT_BATCH_SIZE,
            delayBetweenBatches: config.delayBetweenBatches ?? SCRAPER_CONFIG.DEFAULT_DELAY_BETWEEN_BATCHES
        };

        // Initialize logger with scraper name
        this.logger = log4js.getLogger(scraperName);

        // Set export filename and database key from options if provided
        // Export filename - must be set by subclass (via options or setExportFilename)
        this._exportFilename = null;
        this._databaseKey = null;
        if (options.exportFilename) {
            this.setExportFilename(options.exportFilename);
        }
        if (options.databaseKey) {
            this.setDatabaseKey(options.databaseKey);
        }

        this.logger.info(`${scraperName} initialized - Parallel: ${this.config.parallelFetching}, Batch size: ${this.config.batchSize}`);
    }

    /**
     * Template method for the main crawl operation
     * Subclasses should override crawlContent() for specific logic
     */
    async crawl(isDoWriteFile = false) {
        this.logger.info("Started Crawling");
        this.isRunning = true;
        this.deltaTracker.clear();

        try {
            await this.crawlContent();
        } catch (error) {
            this.logger.error(`${this.scraperName} scraping failed: ${error.message}`);
            this.logger.error(error.stack);
        }

        this.logger.info("Done Crawling");
        this.logger.info("Delta Summary:", JSON.stringify(this.deltaTracker.getSummary()));

        // Handle output
        if (WRITE_TO_GITHUB || UPDATE_DATABASE) {
            if (WRITE_TO_GITHUB) {
                this.logger.info("crawl => writing JSON file to GitHub");
                this.writeJSON();
            }

            if (UPDATE_DATABASE) {
                this.logger.info("crawl => updating database in bulk");
                await this.updateDatabase();
            }
        } else if (isDoWriteFile) {
            // Backward compatibility
            this.logger.info("crawl => writing JSON file");
            this.writeJSON();
        }

        this.isRunning = false;
        this.logger.info("crawl => Exiting");
    }

    /**
     * Abstract method - subclasses must implement
     * This contains the main scraping logic for each scraper
     */
    async crawlContent() {
        throw new Error(`${this.scraperName}: crawlContent() must be implemented by subclass`);
    }

    /**
     * Abstract method - subclasses must implement
     * Returns the filename for JSON output (without extension)
     */
    getExportFilename() {
        if (!this._exportFilename) {
            throw new Error(`${this.scraperName}: getExportFilename() must be implemented by subclass`);
        }
        return this._exportFilename;
    }

    /**
     * Set the export filename (called by subclass)
     */
    setExportFilename(filename) {
        this._exportFilename = filename;
    }

    /**
     * Abstract method - subclasses must implement
     * Returns the database key for updates
     */
    getDatabaseKey() {
        if (!this._databaseKey) {
            throw new Error(`${this.scraperName}: getDatabaseKey() must be implemented by subclass`);
        }
        return this._databaseKey;
    }

    /**
     * Set the database key (called by subclass)
     */
    setDatabaseKey(key) {
        this._databaseKey = key;
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
            this.logger.info(`[${itemType}] Processing ${items.length} ${itemType} sequentially`);
            const results = [];
            for (let i = 0; i < items.length; i++) {
                const startTime = Date.now();
                this.logger.debug(`[${itemType}] Processing ${i + 1}/${items.length}`);
                try {
                    const result = await processor(items[i], i);
                    const duration = Date.now() - startTime;
                    this.logger.debug(`[${itemType}] Completed ${i + 1}/${items.length} in ${duration}ms`);
                    results.push(result);
                } catch (error) {
                    this.logger.error(`[${itemType}] Failed ${i + 1}/${items.length}: ${error.message}`);
                    results.push(null);
                }
            }
            return results;
        }

        // Parallel batch processing
        const { batchSize, delayBetweenBatches } = this.config;
        const totalBatches = Math.ceil(items.length / batchSize);
        this.logger.info(`[${itemType}] Processing ${items.length} ${itemType} in ${totalBatches} batches (${batchSize} per batch)`);

        const allResults = [];

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchStart = batchIndex * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, items.length);
            const batch = items.slice(batchStart, batchEnd);

            const batchNum = batchIndex + 1;
            const batchStartTime = Date.now();
            this.logger.info(`[${itemType}] Starting batch ${batchNum}/${totalBatches} (${itemType} ${batchStart + 1}-${batchEnd} of ${items.length})`);

            // Process batch in parallel
            const batchPromises = batch.map(async (item, indexInBatch) => {
                const globalIndex = batchStart + indexInBatch;
                const itemStartTime = Date.now();
                try {
                    const result = await processor(item, globalIndex);
                    const itemDuration = Date.now() - itemStartTime;
                    this.logger.debug(`[${itemType}] ✓ Item ${globalIndex + 1}/${items.length} completed in ${itemDuration}ms`);
                    return { success: true, result, index: globalIndex };
                } catch (error) {
                    const itemDuration = Date.now() - itemStartTime;
                    this.logger.error(`[${itemType}] ✗ Item ${globalIndex + 1}/${items.length} failed after ${itemDuration}ms: ${error.message}`);
                    return { success: false, error, index: globalIndex };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            const batchDuration = Date.now() - batchStartTime;
            const successCount = batchResults.filter(r => r.success).length;
            const failCount = batchResults.length - successCount;

            this.logger.info(`[${itemType}] Batch ${batchNum}/${totalBatches} completed: ${successCount}/${batch.length} successful, ${failCount} failed in ${batchDuration}ms`);

            allResults.push(...batchResults.map(r => r.result));

            // Delay between batches to avoid rate limiting (except after last batch)
            if (batchIndex < totalBatches - 1 && delayBetweenBatches > 0) {
                this.logger.debug(`[${itemType}] Waiting ${delayBetweenBatches}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }

        const successfulResults = allResults.filter(r => r !== null && r !== undefined);
        this.logger.info(`[${itemType}] All batches completed: ${successfulResults.length}/${items.length} total successful`);

        return allResults;
    }

    /**
     * Add a series to the JSON object
     *
     * @param {string} id - Series ID
     * @param {string} seriesTitle - Series title
     * @param {string} seriesPage - URL to series page
     * @param {string} imgUrl - Poster/background image URL
     * @param {string} seriesDescription - Series description
     * @param {Array} genres - Array of genre strings
     * @param {Array} videosList - Array of video objects
     * @param {string} subType - Subtype identifier
     * @param {string} type - Content type (e.g., "series")
     * @param {Object} extraFields - Optional extra fields to add to the series object
     */
    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, subType, type, extraFields = {}) {
        const seriesObj = {
            id: id,
            name: seriesTitle,
            link: seriesPage,
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

        // Merge any extra fields
        Object.assign(seriesObj, extraFields);
        if (Object.keys(extraFields).length > 0) {
            Object.assign(seriesObj.meta, extraFields);
        }

        this._jsonObj[id] = seriesObj;

        this.logger.info(`addToJsonObject => Added series, ID: ${id} Name: ${seriesTitle} Link: ${seriesPage} subtype: ${subType}`);
    }

    /**
     * Add a video to an existing series in the JSON object
     *
     * @param {string} key - Series ID
     * @param {string} episodeId - Episode ID
     * @param {string} name - Episode name
     * @param {number|string} seasonNo - Season number
     * @param {number|string} episodeNo - Episode number
     * @param {string} desc - Episode description
     * @param {string} thumb - Thumbnail URL
     * @param {string} episodeLink - URL to episode page
     * @param {string} released - Release date (ISO format)
     * @param {Array} streams - Array of stream objects
     */
    addVideoToMeta(key, episodeId, name, seasonNo, episodeNo, desc, thumb, episodeLink, released, streams) {
        const video = {
            id: episodeId,
            name: name,
            season: seasonNo,
            episode: episodeNo,
            description: desc,
            thumbnail: thumb,
            episodeLink: episodeLink,
            streams: streams
        };

        if (released && released !== "") {
            video.released = released;
        }

        if (this._jsonObj[key] && this._jsonObj[key].meta) {
            this._jsonObj[key].meta.videos.push(video);
            this.logger.info(`Added: S${seasonNo} E${episodeNo} - ${name}`);
        } else {
            this.logger.warn(`addVideoToMeta => Series ${key} not found, cannot add video`);
        }
    }

    /**
     * Update the database with the scraped data
     */
    async updateDatabase() {
        this.logger.trace("updateDatabase => Entered");
        this.logger.debug("updateDatabase => Starting bulk database update");

        try {
            const dbKey = this.getDatabaseKey();
            const result = await updateDatabaseFromJSON(dbKey, this._jsonObj, this.logger);
            this.logger.info(`updateDatabase => ✅ Updated ${result.series} series, ${result.videos} videos, ${result.streams} streams in ${result.duration}s`);
        } catch (error) {
            this.logger.error(`updateDatabase => ❌ Failed to update database: ${error.message}`);
            throw error;
        }

        this.logger.trace("updateDatabase => Leaving");
    }

    /**
     * Write the JSON object to a file
     */
    writeJSON() {
        this.logger.trace("writeJSON => Entered");
        this.logger.debug("writeJSON => All tasks completed - writing file");

        const utils = require("./utilities.js");
        utils.writeJSONToFile(this._jsonObj, this.getExportFilename());

        this.logger.trace("writeJSON => Leaving");
    }

    /**
     * Get the JSON object (useful for testing or direct access)
     */
    getJsonObject() {
        return this._jsonObj;
    }

    /**
     * Set the JSON object (useful for loading existing data)
     */
    setJsonObject(obj) {
        this._jsonObj = obj;
    }

    /**
     * Get circuit breaker state for monitoring
     */
    getCircuitBreakerState() {
        return this.circuitBreaker.getState();
    }

    /**
     * Get rate limiter stats for monitoring
     */
    getRateLimiterStats() {
        return this.rateLimiter.getStats();
    }

    /**
     * Reset circuit breaker (useful after manual intervention)
     */
    resetCircuitBreaker() {
        this.circuitBreaker = new CircuitBreaker(
            this.config.circuitBreakerThreshold || 5,
            this.config.circuitBreakerTimeout || 60000
        );
        this.logger.info("Circuit breaker has been reset");
    }
}

module.exports = BaseScraper;
