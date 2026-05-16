/**
 * ScraperTester - Testing and monitoring utilities for scrapers
 *
 * Provides:
 * - Test harness to run individual or all scrapers
 * - Validation helpers for scraped data
 * - Performance metrics collection
 * - Health check functionality
 */

const log4js = require("log4js");

// Configure logger for testing
log4js.configure({
    appenders: {
        out: { type: "stdout" },
        test: {
            type: "file",
            filename: "logs/scraper-test.log",
            maxLogSize: 10 * 1024 * 1024,
            backups: 2,
        }
    },
    categories: { default: { appenders: ['test', 'out'], level: "info" } },
});

const logger = log4js.getLogger("ScraperTester");

/**
 * Performance metrics for a scraper run
 */
class ScraperMetrics {
    constructor(scraperName) {
        this.scraperName = scraperName;
        this.startTime = null;
        this.endTime = null;
        this.seriesProcessed = 0;
        this.episodesProcessed = 0;
        this.errors = [];
        this.warnings = [];
        this.circuitBreakerTrips = 0;
        this.rateLimitHits = 0;
    }

    start() {
        this.startTime = Date.now();
        logger.info(`[${this.scraperName}] Test started at ${new Date(this.startTime).toISOString()}`);
    }

    end() {
        this.endTime = Date.now();
        const duration = ((this.endTime - this.startTime) / 1000).toFixed(2);
        logger.info(`[${this.scraperName}] Test completed in ${duration}s`);
        return this.getSummary();
    }

    recordSeries() {
        this.seriesProcessed++;
    }

    recordEpisode() {
        this.episodesProcessed++;
    }

    recordError(error) {
        this.errors.push({
            timestamp: new Date().toISOString(),
            message: error.message || String(error),
            stack: error.stack
        });
    }

    recordWarning(message) {
        this.warnings.push({
            timestamp: new Date().toISOString(),
            message: message
        });
    }

    recordCircuitBreakerTrip() {
        this.circuitBreakerTrips++;
    }

    recordRateLimitHit() {
        this.rateLimitHits++;
    }

    getSummary() {
        const duration = this.endTime ? ((this.endTime - this.startTime) / 1000).toFixed(2) : 0;
        return {
            scraperName: this.scraperName,
            duration: parseFloat(duration),
            seriesProcessed: this.seriesProcessed,
            episodesProcessed: this.episodesProcessed,
            errorCount: this.errors.length,
            warningCount: this.warnings.length,
            circuitBreakerTrips: this.circuitBreakerTrips,
            rateLimitHits: this.rateLimitHits,
            success: this.errors.length === 0,
            errors: this.errors,
            warnings: this.warnings
        };
    }
}

/**
 * Validate scraped series data
 */
function validateSeriesData(seriesData, strict = false) {
    const errors = [];
    const warnings = [];

    if (!seriesData) {
        errors.push("Series data is null or undefined");
        return { valid: false, errors, warnings };
    }

    // Required fields
    const requiredFields = ['id', 'name', 'link', 'type', 'subtype', 'meta'];
    for (const field of requiredFields) {
        if (!seriesData[field]) {
            errors.push(`Missing required field: ${field}`);
        }
    }

    // meta validation
    if (seriesData.meta) {
        if (!seriesData.meta.videos || !Array.isArray(seriesData.meta.videos)) {
            warnings.push("No videos array or invalid format");
        } else if (seriesData.meta.videos.length === 0) {
            warnings.push("Series has no episodes");
        } else {
            // Validate video objects
            seriesData.meta.videos.forEach((video, index) => {
                if (!video.id) {
                    warnings.push(`Video ${index} missing id`);
                }
                if (!video.name) {
                    warnings.push(`Video ${index} missing name`);
                }
                if (video.season === undefined || video.season === null) {
                    warnings.push(`Video ${index} missing season`);
                }
                if (video.episode === undefined || video.episode === null) {
                    warnings.push(`Video ${index} missing episode`);
                }
            });
        }
    }

    // URL validation
    if (seriesData.link) {
        try {
            new URL(seriesData.link);
        } catch (e) {
            errors.push(`Invalid link URL: ${seriesData.link}`);
        }
    }

    // Image URL validation
    const imageFields = ['meta.poster', 'meta.background', 'meta.logo'];
    imageFields.forEach(field => {
        const value = field.split('.').reduce((obj, key) => obj?.[key], seriesData);
        if (value && value.startsWith('http')) {
            try {
                new URL(value);
            } catch (e) {
                warnings.push(`Invalid ${field} URL: ${value}`);
            }
        }
    });

    const valid = strict ? errors.length === 0 && warnings.length === 0 : errors.length === 0;
    return { valid, errors, warnings };
}

/**
 * Health check for a scraper
 */
async function healthCheck(scraper) {
    const health = {
        scraperName: scraper.scraperName,
        timestamp: new Date().toISOString(),
        status: 'unknown',
        checks: {}
    };

    try {
        // Check if scraper has required methods
        health.checks.hasCrawlContent = typeof scraper.crawlContent === 'function';
        health.checks.hasGetJsonObject = typeof scraper.getJsonObject === 'function';
        health.checks.hasLogger = scraper.logger !== undefined;
        health.checks.hasConfig = scraper.config !== undefined;

        // Check circuit breaker state
        if (scraper.getCircuitBreakerState) {
            const cbState = scraper.getCircuitBreakerState();
            health.checks.circuitBreakerState = cbState.state;
            health.checks.circuitBreakerFailures = cbState.failureCount;
        }

        // Check rate limiter stats
        if (scraper.getRateLimiterStats) {
            const rlStats = scraper.getRateLimiterStats();
            health.checks.rateLimiterLimit = rlStats.limit;
            health.checks.rateLimiterRecent = rlStats.requestsInLastSecond;
        }

        // Overall health status
        const allChecksPassed = Object.values(health.checks).every(check =>
            check === true || typeof check === 'object' || typeof check === 'number'
        );
        health.status = allChecksPassed ? 'healthy' : 'degraded';

    } catch (error) {
        health.status = 'unhealthy';
        health.error = error.message;
    }

    return health;
}

/**
 * Run a single scraper with metrics collection
 * @param {Function} scraperClass - Scraper class constructor
 * @param {string} scraperName - Name of the scraper
 * @param {string} mode - Scraping mode: 'auto', 'full', 'incremental', 'skip'
 */
async function runScraperWithMetrics(scraperClass, scraperName, mode = 'auto') {
    const metrics = new ScraperMetrics(scraperName);
    metrics.start();

	const scraper = new scraperClass();

	// Override logger to capture errors (only for scrapers with instance logger)
	// MakoScraper uses module-level logger, so we skip it
	if (scraper.logger && typeof scraper.logger.error === 'function') {
		const originalError = scraper.logger.error;
		scraper.logger.error = (...args) => {
			metrics.recordError(new Error(args.join(' ')));
			originalError.apply(scraper.logger, args);
		};

		const originalWarn = scraper.logger.warn;
		scraper.logger.warn = (...args) => {
			metrics.recordWarning(args.join(' '));
			originalWarn.apply(scraper.logger, args);
		};
	}

    try {
        await scraper.crawl(true, mode);

        // Collect stats from scraper
        if (scraper.deltaTracker) {
            const summary = scraper.deltaTracker.getSummary();
            metrics.seriesProcessed = summary.series || 0;
        }

        metrics.end();
        return metrics.getSummary();

    } catch (error) {
        metrics.recordError(error);
        metrics.endTime = Date.now();
        const summary = metrics.getSummary();
        logger.error(`[${scraperName}] Test failed: ${error.message}`);
        return summary;
    }
}

/**
 * Run all scrapers and collect metrics
 */
async function runAllScrapers() {
    logger.info("=== Starting comprehensive scraper tests ===");

    // Group scrapers by server to allow parallel execution
    // Kan scrapers all hit kan.org.il servers, run sequentially
    // Reshet hits 13tv.co.il, Mako hits mako.co.il - can run in parallel with Kan
    const scraperGroups = {
        kan: [
            { name: 'Kan88', class: require('./Kan88Scraper.js') },
            { name: 'KanArchive', class: require('./KanArchiveScraper.js') },
            { name: 'KanDigital', class: require('./KanDigitalScraper.js') },
            { name: 'KanKids', class: require('./KanKidsScraper.js') },
            { name: 'KanPodcasts', class: require('./KanPodcastsScraper.js') },
            { name: 'KanTeens', class: require('./KanTeensScraper.js') }
        ],
        other: [
            { name: 'Reshet', class: require('./ReshetScraper.js') },
            { name: 'Mako', class: require('./MakoScraper.js') }
        ]
    };

    const results = [];
    const allResults = await Promise.all([
        // Run Kan scrapers sequentially within their group
        (async () => {
            const groupResults = [];
            for (const { name, class: ScraperClass } of scraperGroups.kan) {
                logger.info(`\n--- Testing ${name}Scraper ---`);
                try {
                    const summary = await runScraperWithMetrics(ScraperClass, name);
                    groupResults.push(summary);
                } catch (error) {
                    logger.error(`[${name}] Fatal error: ${error.message}`);
                    groupResults.push({
                        scraperName: name,
                        success: false,
                        error: error.message,
                        errors: [{ message: error.message, stack: error.stack }]
                    });
                }
            }
            return groupResults;
        })(),
        // Run Reshet and Mako sequentially within their group (but parallel to Kan)
        (async () => {
            const groupResults = [];
            for (const { name, class: ScraperClass } of scraperGroups.other) {
                logger.info(`\n--- Testing ${name}Scraper ---`);
                try {
                    const summary = await runScraperWithMetrics(ScraperClass, name);
                    groupResults.push(summary);
                } catch (error) {
                    logger.error(`[${name}] Fatal error: ${error.message}`);
                    groupResults.push({
                        scraperName: name,
                        success: false,
                        error: error.message,
                        errors: [{ message: error.message, stack: error.stack }]
                    });
                }
            }
            return groupResults;
        })()
    ]);

    // Flatten results from both groups
    results.push(...allResults[0], ...allResults[1]);

    // Print summary
    logger.info("\n=== Test Summary ===");
    results.forEach(result => {
        const status = result.success ? '✅ PASS' : '❌ FAIL';
        logger.info(`${status} ${result.scraperName}: ${result.seriesProcessed} series, ${result.episodesProcessed} episodes, ${result.duration}s`);
        if (result.errors && result.errors.length > 0) {
            logger.error(`  Errors: ${result.errors.map(e => e.message).join(', ')}`);
        }
    });

    const successCount = results.filter(r => r.success).length;
    logger.info(`\nTotal: ${successCount}/${results.length} scrapers passed`);

    return results;
}

module.exports = {
    ScraperMetrics,
    validateSeriesData,
    healthCheck,
    runScraperWithMetrics,
    runAllScrapers
};
