/**
 * ScraperHelpers - Common utility functions for scrapers
 *
 * Provides shared functionality for:
 * - Stream extraction (redge-player, VideoObject, etc.)
 * - Date parsing (Israeli dates, ISO dates, etc.)
 * - Error handling (safeExecute, safeFetch)
 * - Rate limiting (CircuitBreaker, RateLimiter)
 * - URL processing
 */

const { fetchData, extractReleaseDate } = require("./utilities.js");
const log4js = require("log4js");
const logger = log4js.getLogger("ScraperHelpers");

/**
 * Circuit Breaker - Prevents cascading failures when a service is down
 * Tracks failures and opens the circuit after threshold, preventing further calls
 */
class CircuitBreaker {
    constructor(threshold = 5, timeout = 60000) {
        this.failureCount = 0;
        this.threshold = threshold;
        this.timeout = timeout;
        this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
        this.nextAttempt = 0;
    }

    async execute(fn, context) {
        if (this.state === 'OPEN') {
            if (Date.now() < this.nextAttempt) {
                throw new Error(`CircuitBreaker OPEN for ${context} - too many recent failures`);
            }
            this.state = 'HALF_OPEN';
            logger.info(`CircuitBreaker => Entering HALF_OPEN state for ${context}`);
        }

        try {
            const result = await fn();
            this.onSuccess(context);
            return result;
        } catch (error) {
            this.onFailure(context, error);
            throw error;
        }
    }

    onSuccess(context) {
        this.failureCount = 0;
        if (this.state === 'HALF_OPEN') {
            this.state = 'CLOSED';
            logger.info(`CircuitBreaker => Circuit CLOSED for ${context} - service recovered`);
        }
    }

    onFailure(context, error) {
        this.failureCount++;
        logger.warn(`CircuitBreaker => Failure ${this.failureCount}/${this.threshold} for ${context}: ${error.message}`);

        if (this.failureCount >= this.threshold) {
            this.state = 'OPEN';
            this.nextAttempt = Date.now() + this.timeout;
            logger.error(`CircuitBreaker => Circuit OPEN for ${context} - paused for ${this.timeout}ms`);
        }
    }

    getState() {
        return {
            state: this.state,
            failureCount: this.failureCount,
            nextAttempt: this.nextAttempt
        };
    }
}

/**
 * Rate Limiter - Tracks requests and enforces rate limits
 */
class RateLimiter {
    constructor(requestsPerSecond = 2) {
        this.requestsPerSecond = requestsPerSecond;
        this.requests = [];
    }

    async wait(slotName = '') {
        const now = Date.now();
        const windowStart = now - 1000;

        // Remove old requests outside the 1-second window
        this.requests = this.requests.filter(t => t > windowStart);

        if (this.requests.length >= this.requestsPerSecond) {
            const oldestRequest = this.requests[0];
            const waitTime = 1000 - (now - oldestRequest);
            if (waitTime > 0) {
                logger.trace(`RateLimiter => Waiting ${waitTime}ms for slot: ${slotName}`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }

        this.requests.push(Date.now());
    }

    reset() {
        this.requests = [];
    }

    getStats() {
        const now = Date.now();
        const windowStart = now - 1000;
        const recentRequests = this.requests.filter(t => t > windowStart);
        return {
            requestsInLastSecond: recentRequests.length,
            limit: this.requestsPerSecond
        };
    }
}

/**
 * Extract stream URL from a Kan episode page
 * Handles both new redge-player and legacy VideoObject methods
 *
 * @param {string} link - URL to the episode page
 * @param {string} siteName - Name of the site for logging (default: "Kan")
 * @returns {Promise<Object>} - Stream object with url, name, description, released
 */
async function extractKanStream(link, siteName = "Kan") {
    logger.trace(`extractKanStream => Entering for ${siteName}: ${link}`);

    const doc = await fetchData(link);
    if (!doc) {
        logger.debug(`extractKanStream => Error retrieving doc from ${link}`);
        return null;
    }

    let released = "";
    let videoUrl = "";
    let nameVideo = "";
    let descVideo = "";

    // Extract release date
    const dateElement = doc.querySelector("li.date-local");
    released = extractReleaseDate(dateElement);
    if (released) {
        logger.debug(`extractKanStream => Extracted release date: ${released}`);
    }

    // Try to get stream URL from redge-player element (new Kan player)
    const playerElem = doc.querySelector("[id^='redge-player-']");
    if (playerElem && playerElem.getAttribute("data-hls-url")) {
        videoUrl = playerElem.getAttribute("data-hls-url");
        // Ensure URL has protocol
        if (videoUrl.startsWith("//")) {
            videoUrl = "https:" + videoUrl;
        }
        logger.debug(`extractKanStream => Found redge-player URL: ${videoUrl}`);
    } else {
        // Fallback to VideoObject method (legacy - Kaltura URLs, may not work)
        logger.debug("extractKanStream => No redge-player found, falling back to VideoObject");
        const scriptElems = doc.querySelectorAll("script");
        for (const scriptElem of scriptElems) {
            if (scriptElem.toString().includes("VideoObject")) {
                videoUrl = extractVideoObjectUrl(scriptElem.toString());
                // Ensure URL has protocol
                if (videoUrl && videoUrl.startsWith("//")) {
                    videoUrl = "https:" + videoUrl;
                }
                break;
            }
        }
    }

    // Extract video name
    if (doc.querySelectorAll("div.info-title h1.h2").length > 0) {
        nameVideo = doc.querySelectorAll("div.info-title h1.h2")[0].text.trim();
        nameVideo = cleanVideoName(nameVideo);
    } else if (doc.querySelector("title")) {
        nameVideo = doc.querySelector("title").text.trim();
        nameVideo = cleanVideoName(nameVideo);
    }

    // Extract description
    if (doc.querySelector("div.info-description") != null) {
        descVideo = doc.querySelector("div.info-description").text.trim();
    }

    if (!videoUrl) {
        logger.warn(`extractKanStream => No stream URL found for ${link}`);
        return null;
    }

    const streamObj = {
        url: videoUrl,
        type: "series",
        name: nameVideo,
        description: descVideo
    };

    if (released) {
        streamObj.released = released;
    }

    logger.trace(`extractKanStream => Exiting with ${videoUrl ? 'stream' : 'no stream'}`);
    return streamObj;
}

/**
 * Extract contentUrl from VideoObject script content
 *
 * @param {string} scriptContent - Content of the script tag
 * @returns {string} - The extracted URL or empty string
 */
function extractVideoObjectUrl(scriptContent) {
    const startPoint = scriptContent.indexOf("contentUrl");
    if (startPoint === -1) return "";

    let link = scriptContent.substring(startPoint + 14);
    const endPoint = link.indexOf('"');
    link = link.substring(0, endPoint);

    return link;
}

/**
 * Clean video name by removing prefixes like "Episode X:" or pipe characters
 *
 * @param {string} str - The video name to clean
 * @returns {string} - Cleaned video name
 */
function cleanVideoName(str) {
    if (!str) return "";

    // Remove "Episode X:" prefix (Hebrew: "פרק X:")
    str = str.replace(/^פרק \d+:\s*/, '');

    // Remove pipe separators
    if (str.indexOf("|") > 0) {
        str = str.substring(str.indexOf('|') + 1);
    }

    return str.trim();
}

/**
 * Parse Israeli date format (DD.MM.YYYY or D.M.YYYY) to ISO format
 * Also handles ISO format and direct Date parsing
 *
 * @param {string} dateStr - Date string in various formats
 * @returns {string} - ISO date string or empty string if parsing fails
 */
function parseIsraeliDate(dateStr) {
    if (!dateStr || typeof dateStr !== 'string') return "";

    try {
        // Try ISO format first
        const isoMatch = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
        if (isoMatch) {
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
                return date.toISOString();
            }
        }

        // Parse D.M.YYYY, DD.MM.YYYY, D/M/YYYY, DD/MM/YYYY format
        const ilMatch = dateStr.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
        if (ilMatch) {
            const [, day, month, year] = ilMatch;
            const paddedDay = day.padStart(2, '0');
            const paddedMonth = month.padStart(2, '0');
            const date = new Date(`${year}-${paddedMonth}-${paddedDay}T00:00:00`);
            if (!isNaN(date.getTime())) {
                return date.toISOString();
            }
        }

        // Try direct parsing as last resort
        const date = new Date(dateStr);
        if (!isNaN(date.getTime())) {
            return date.toISOString();
        }

        logger.warn(`parseIsraeliDate => Could not parse date: ${dateStr}`);
        return "";
    } catch (error) {
        logger.error(`parseIsraeliDate => Error: ${error.message}`);
        return "";
    }
}

/**
 * Extract release date from data-date-utc attribute
 * Common pattern for Kan sites
 *
 * @param {HTMLElement} element - Element containing the date
 * @returns {string} - ISO date string or empty string
 */
function extractDateFromDataAttr(element) {
    if (!element) return "";

    const dateUtc = element.getAttribute("data-date-utc");
    if (dateUtc) {
        const date = new Date(dateUtc);
        return isNaN(date.getTime()) ? "" : date.toISOString();
    }
    return "";
}

/**
 * Extract release date from datetime attribute
 * Common pattern for HTML5 time elements
 *
 * @param {HTMLElement} element - Time element
 * @returns {string} - ISO date string or empty string
 */
function extractDateFromDatetime(element) {
    if (!element) return "";

    const datetime = element.getAttribute("datetime");
    if (datetime) {
        const date = new Date(datetime);
        return isNaN(date.getTime()) ? "" : date.toISOString();
    }
    return "";
}

/**
 * Generic release date extractor that tries multiple methods
 *
 * @param {HTMLElement} element - Element that might contain date info
 * @returns {string} - ISO date string or empty string
 */
function extractReleaseDateGeneric(element) {
    if (!element) return "";

    // Try extractReleaseDate from utilities first
    const result = extractReleaseDate(element);
    if (result) return result;

    // Try data-date-utc attribute
    let date = extractDateFromDataAttr(element);
    if (date) return date;

    // Try datetime attribute
    date = extractDateFromDatetime(element);
    if (date) return date;

    return "";
}

/**
 * Safely execute an async function with standardized error handling
 * Returns null on error, logs with context
 *
 * @param {Function} fn - Async function to execute
 * @param {string} context - Context for error logging
 * @param {Object} logger - Logger instance to use
 * @param {*} defaultValue - Value to return on error (default: null)
 * @returns {Promise<*>} - Result of fn or defaultValue on error
 */
async function safeExecute(fn, context, logger, defaultValue = null) {
    try {
        return await fn();
    } catch (error) {
        logger.error(`${context} => Error: ${error.message}`);
        if (error.stack && process.env.NODE_ENV !== 'production') {
            logger.debug(`${context} => Stack: ${error.stack}`);
        }
        return defaultValue;
    }
}

/**
 * Safely fetch a URL with retries and standardized error handling
 *
 * @param {string} url - URL to fetch
 * @param {string} context - Context for error logging
 * @param {Object} logger - Logger instance to use
 * @param {Object} options - Options for fetch (isJson, headers, etc.)
 * @param {number} retries - Number of retries (default: 1)
 * @returns {Promise<*>} - Fetch result or null on error
 */
async function safeFetch(url, context, logger, options = {}, retries = 1) {
    const { isJson = false, headers = {} } = options;
    let lastError;

    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const result = await fetchData(url, isJson, headers);
            if (!result) {
                throw new Error('Empty response from fetchData');
            }
            return result;
        } catch (error) {
            lastError = error;
            if (attempt < retries) {
                const delay = Math.pow(2, attempt) * 1000; // Exponential backoff
                logger.warn(`${context} => Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    logger.error(`${context} => Failed after ${retries + 1} attempts: ${lastError.message}`);
    return null;
}

/**
 * Wrap a processor function for batch processing with error handling
 * Returns null on error, allowing batch to continue
 *
 * @param {Function} processor - Function to wrap
 * @param {string} context - Context for error logging
 * @param {Object} logger - Logger instance to use
 * @returns {Function} - Wrapped function
 */
function wrapProcessor(processor, context, logger) {
    return async (...args) => {
        try {
            return await processor(...args);
        } catch (error) {
            logger.error(`${context} => Processor error: ${error.message}`);
            return null;
        }
    };
}

module.exports = {
    extractKanStream,
    extractVideoObjectUrl,
    cleanVideoName,
    parseIsraeliDate,
    extractDateFromDataAttr,
    extractDateFromDatetime,
    extractReleaseDateGeneric,
    safeExecute,
    safeFetch,
    wrapProcessor,
    CircuitBreaker,
    RateLimiter
};
