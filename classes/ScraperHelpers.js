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

const { parse } = require("node-html-parser");
const { fetchData, extractReleaseDate } = require("./utilities.js");
const { rethrowIfKanBlocked, isKanBlockedError } = require("./kanSession.js");
const log4js = require("log4js");
const logger = log4js.getLogger("ScraperHelpers");

const KIDS_ORIGIN = "https://www.kankids.org.il";
const KAN_ORIGIN = "https://www.kan.org.il";
// The redesigned episode row renders 50 cards. currentPage / itemsToShow /
// page do not add the rest on the series checked (p-11732 still omits episodes
// 51-60, which exist as their own pages but are not linked). Ask for the next
// page anyway when a row is full, and keep going only when new episode URLs appear.
const EDUCATIONAL_EPISODE_PAGE_CAP = 50;
const EDUCATIONAL_EXTRA_PAGES = 4;

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

    const streamObj = streamFromKanDocument(doc);
    if (!streamObj) {
        logger.warn(`extractKanStream => No stream URL found for ${link}`);
        return null;
    }
    if (streamObj.released) {
        logger.debug(`extractKanStream => Extracted release date: ${streamObj.released}`);
    }
    logger.trace(`extractKanStream => Exiting with ${streamObj.url ? 'stream' : 'no stream'}`);
    return streamObj;
}

/**
 * Extract contentUrl from VideoObject script content
 *
 * @param {string} scriptContent - Content of the script tag
 * @returns {string} - The extracted URL or empty string
 */
function extractVideoObjectUrl(scriptContent) {
    const text = String(scriptContent || "");
    const match = text.match(/"contentUrl"\s*:\s*"([^"]+)"/);
    if (match) return match[1];

    const startPoint = text.indexOf("contentUrl");
    if (startPoint === -1) return "";

    let link = text.substring(startPoint + 14);
    const endPoint = link.indexOf('"');
    if (endPoint < 0) return "";
    link = link.substring(0, endPoint);

    return link;
}

function scriptBody(scriptElem) {
    if (!scriptElem) return "";
    if (scriptElem.text != null && String(scriptElem.text).trim()) return String(scriptElem.text);
    return String(scriptElem.toString() || "")
        .replace(/^[\s\S]*?<script[^>]*>/i, "")
        .replace(/<\/script>\s*$/i, "");
}

function jsonStringField(text, field) {
    const match = String(text || "").match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (!match) return "";
    try {
        return JSON.parse(`"${match[1]}"`);
    } catch (error) {
        return match[1];
    }
}

/**
 * VideoObject blocks on an episode page. Archive pages put the playable URL,
 * the synopsis, and the thumbnail here. div.info-description is often absent.
 */
function videoObjectsFromDocument(doc) {
    const objects = [];
    if (!doc || typeof doc.querySelectorAll !== "function") return objects;
    doc.querySelectorAll("script").forEach((script) => {
        const text = scriptBody(script);
        if (!text || !text.includes("contentUrl")) return;
        const trimmed = text.trim();
        let parsed = null;
        try {
            parsed = JSON.parse(trimmed);
        } catch (error) {
            parsed = null;
        }
        const list = [];
        if (parsed && typeof parsed === "object") {
            if (Array.isArray(parsed)) list.push(...parsed);
            else if (Array.isArray(parsed["@graph"])) list.push(...parsed["@graph"]);
            else list.push(parsed);
        }
        let found = false;
        for (const item of list) {
            if (!item || typeof item !== "object") continue;
            const type = item["@type"];
            const types = Array.isArray(type) ? type : [type];
            if (!types.includes("VideoObject") || !item.contentUrl) continue;
            found = true;
            objects.push({
                contentUrl: String(item.contentUrl),
                name: item.name || "",
                description: item.description || "",
                thumbnailUrl: item.thumbnailUrl || ""
            });
        }
        if (found) return;
        const url = extractVideoObjectUrl(text);
        if (!url) return;
        objects.push({
            contentUrl: url,
            name: jsonStringField(text, "name"),
            description: jsonStringField(text, "description"),
            thumbnailUrl: jsonStringField(text, "thumbnailUrl")
        });
    });
    return objects;
}

function nameOverlap(left, right) {
    const a = String(left || "").replace(/\s+/g, " ").trim();
    const b = String(right || "").replace(/\s+/g, " ").trim();
    if (!a || !b) return 0;
    if (a === b) return 3;
    if (a.includes(b) || b.includes(a)) return 2;
    return 0;
}

/**
 * When a page lists more than one VideoObject, keep the one whose name matches
 * the episode. A shared promo listed first would otherwise be copied onto
 * every episode in the series.
 */
function chooseVideoObject(objects, pageName) {
    const withUrl = (objects || []).filter((item) => item && item.contentUrl);
    if (withUrl.length === 0) return null;
    if (withUrl.length === 1) return withUrl[0];
    let best = withUrl[0];
    let bestScore = nameOverlap(pageName, withUrl[0].name);
    for (let i = 1; i < withUrl.length; i++) {
        const score = nameOverlap(pageName, withUrl[i].name);
        if (score > bestScore) {
            best = withUrl[i];
            bestScore = score;
        }
    }
    return best;
}

function absoluteMediaUrl(src) {
    const text = String(src || "").trim();
    if (!text) return "";
    if (text.startsWith("//")) return "https:" + text;
    if (text.startsWith("/")) return "https://www.kan.org.il" + text;
    return text;
}

/**
 * Stream fields from an already-fetched episode document. redge-player on
 * archive pages has no data-hls-url; the playable URL is VideoObject.contentUrl.
 *
 * @param {object} doc parsed HTML document
 * @returns {object|null}
 */
function streamFromKanDocument(doc) {
    if (!doc || typeof doc.querySelector !== "function") return null;

    let released = "";
    let videoUrl = "";
    let nameVideo = "";
    let descVideo = "";

    const dateElement = doc.querySelector(".date-local");
    released = extractReleaseDate(dateElement);

    if (doc.querySelectorAll("div.info-title h1.h2").length > 0) {
        nameVideo = cleanVideoName(doc.querySelectorAll("div.info-title h1.h2")[0].text.trim());
    } else if (doc.querySelector("title")) {
        nameVideo = cleanVideoName(doc.querySelector("title").text.trim());
    }

    const chosen = chooseVideoObject(videoObjectsFromDocument(doc), nameVideo);
    let thumbnail = "";
    const playerElem = doc.querySelector("[id^='redge-player-']");
    if (playerElem && playerElem.getAttribute("data-hls-url")) {
        videoUrl = playerElem.getAttribute("data-hls-url");
        if (videoUrl.startsWith("//")) videoUrl = "https:" + videoUrl;
    } else if (chosen && chosen.contentUrl) {
        videoUrl = chosen.contentUrl;
        if (videoUrl.startsWith("//")) videoUrl = "https:" + videoUrl;
    }
    if (chosen) {
        if (!descVideo) descVideo = String(chosen.description || "").trim();
        thumbnail = absoluteMediaUrl(chosen.thumbnailUrl);
    }

    const infoDescription = doc.querySelector("div.info-description");
    const infoText = infoDescription && infoDescription.text ? infoDescription.text.trim() : "";
    if (infoText) descVideo = infoText;
    if (!descVideo) {
        const meta = doc.querySelector('meta[property="og:description"]') || doc.querySelector('meta[name="description"]');
        if (meta) descVideo = String(meta.getAttribute("content") || "").trim();
    }

    if (!videoUrl) return null;

    const streamObj = {
        url: videoUrl,
        type: "series",
        name: nameVideo,
        description: descVideo
    };
    if (thumbnail) streamObj.thumbnail = thumbnail;
    if (released) streamObj.released = released;
    return streamObj;
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
        rethrowIfKanBlocked(error);
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
            if (isKanBlockedError(error)) throw error;
            rethrowIfKanBlocked(error);
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
 * Kan Kids / Kan Teens lobby pages embed the series list as a JSON array
 * inside a script tag. The old scraper always read script index 4. When
 * Cloudflare (or a layout change) returned a different document, that index
 * threw and the empty result was published.
 *
 * Prefer the historical index when it parses, then scan every script.
 * @param {*} doc parsed HTML document
 * @returns {Array<object>}
 */
function extractLobbySeries(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") {
        throw new Error("Lobby page did not load");
    }

    const ordered = [];
    const blocks = doc.querySelectorAll("div.umb-block-list div script");
    if (blocks[4]) ordered.push(blocks[4]);
    for (const script of doc.querySelectorAll("script")) {
        ordered.push(script);
    }

    const seen = new Set();
    for (const script of ordered) {
        if (seen.has(script)) continue;
        seen.add(script);
        const text = typeof script.toString === "function" ? script.toString() : "";
        const start = text.indexOf("[{");
        const end = text.lastIndexOf("}]");
        if (start < 0 || end <= start) continue;
        try {
            const parsed = JSON.parse(text.substring(start, end + 2));
            if (Array.isArray(parsed) && parsed.some(item => item && typeof item === "object" && item.Url)) {
                return parsed;
            }
        } catch (error) {
            continue;
        }
    }

    throw new Error("Lobby page did not contain a series list");
}

function asDoc(value) {
    if (!value) return null;
    if (typeof value === "string") return parse(value);
    if (typeof value.querySelectorAll === "function") return value;
    return null;
}

function emptyEducationalParse() {
    return { mode: "empty", seasonTabs: [], episodes: [], seasonUrlsToFetch: [] };
}

function toAbsolute(href, base) {
    const raw = String(href || "").trim();
    if (!raw || raw.startsWith("#") || /^javascript:/i.test(raw)) return "";
    try {
        const url = new URL(raw, base || KIDS_ORIGIN);
        if (url.protocol === "http:" && (url.hostname.endsWith("kankids.org.il") || url.hostname.endsWith("kan.org.il"))) {
            url.protocol = "https:";
        }
        return url.toString();
    } catch (error) {
        return "";
    }
}

function episodeKey(url) {
    try {
        const parsed = new URL(url, KIDS_ORIGIN);
        parsed.hash = "";
        parsed.search = "";
        if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
        return parsed.toString();
    } catch (error) {
        return String(url || "");
    }
}

function seasonFromPath(href) {
    const match = String(href || "").match(/\/s(\d+)(?:\/|$)/);
    if (!match) return null;
    return parseInt(match[1], 10);
}

function flatText(node) {
    if (!node || node.text == null) return "";
    return String(node.text).replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
}

function legacyEpisodeTitle(raw) {
    let episodeTitle = String(raw || "");
    if (episodeTitle.indexOf("|") > 0) {
        episodeTitle = episodeTitle.substring(episodeTitle.indexOf("|") + 1).trim();
    }
    if (episodeTitle.startsWith("עונה")) {
        const pipe = episodeTitle.indexOf("|");
        episodeTitle = episodeTitle.substring(pipe + 1).trim();
    }
    return episodeTitle.trim();
}

function programCardTitle(card) {
    const aria = String(card.getAttribute("aria-label") || "").trim();
    if (aria) return aria;
    const heading = card.querySelector("h3.cr-title, h2.cr-title, .cr-title");
    const text = flatText(heading);
    if (text) return text;
    return String(card.getAttribute("title") || "").trim();
}

function programCardDescription(card) {
    const node = card.querySelector("p.cr-subtitle, div.card-text, p.card-text");
    return flatText(node);
}

function programCardImage(card) {
    const img = card.querySelector("img");
    if (!img) return "";
    return img.getAttribute("src") || img.getAttribute("data-src") || "";
}

function readSeasonTabs(doc, base) {
    const pageKey = episodeKey(base);
    const tabs = [];
    const seen = new Set();
    doc.querySelectorAll("section.program-seasons a.program-season-tab, a.program-season-tab").forEach((tab) => {
        const href = tab.getAttribute("href") || "";
        const url = toAbsolute(href, base);
        const key = episodeKey(url);
        if (!url || !key || seen.has(key)) return;
        seen.add(key);
        const className = String(tab.getAttribute("class") || "");
        const marked = className.split(/\s+/).includes("is-active") || tab.getAttribute("aria-current") === "page";
        tabs.push({
            url: url.split("#")[0],
            season: seasonFromPath(href),
            label: flatText(tab),
            active: marked || key === pageKey
        });
    });
    if (tabs.length && !tabs.some((tab) => tab.active)) tabs[0].active = true;
    return tabs;
}

function parseLegacyEducationalSeasons(doc, base) {
    const seasonDivs = doc.querySelectorAll("div.seasons-item.kids");
    const episodes = [];
    const seasonCount = seasonDivs.length;
    seasonDivs.forEach((seasonDiv, iter) => {
        const seasonNo = seasonCount - iter;
        seasonDiv.querySelectorAll("li.border-item").forEach((item) => {
            const link = item.querySelector("a.card-link");
            if (!link) return;
            const href = link.getAttribute("href") || "";
            const url = toAbsolute(href, base);
            if (!url) return;
            const img = item.querySelector("img.img-full");
            const src = img ? (img.getAttribute("src") || "") : "";
            episodes.push({
                url,
                title: legacyEpisodeTitle(link.getAttribute("title") || ""),
                description: flatText(item.querySelector("div.card-text")),
                image: src.indexOf("?") > 0 ? src : "",
                season: seasonNo
            });
        });
    });
    return episodes;
}

/**
 * Kids/teens series page.
 * Current markup: section.program-seasons a.program-season-tab, and the
 * episode row div#program-episodes a.cr-item (aria-label is the title).
 * No season tabs means one season. li.border-item outside that row is the
 * editor's-picks list and is not a season.
 * Fallback: div.seasons-item.kids li.border-item a.card-link, numbered the
 * way the previous scraper did (first season block is the highest season,
 * first card in a block is episode 1).
 *
 * @param {string|object} html
 * @param {string} pageUrl
 * @returns {{mode: string, seasonTabs: object[], episodes: object[], seasonUrlsToFetch: string[]}}
 */
function parseEducationalSeriesPage(html, pageUrl) {
    const doc = asDoc(html);
    if (!doc) return emptyEducationalParse();
    const base = pageUrl || KIDS_ORIGIN + "/";
    const episodeRoot = doc.querySelector("#program-episodes");
    const cards = episodeRoot ? episodeRoot.querySelectorAll("a.cr-item") : [];
    if (cards.length) {
        const tabs = readSeasonTabs(doc, base);
        const active = tabs.find((tab) => tab.active);
        const episodes = [];
        cards.forEach((card) => {
            const href = card.getAttribute("href") || "";
            if (!href || href.includes("/participants/")) return;
            const url = toAbsolute(href, base);
            if (!url) return;
            let season = seasonFromPath(href);
            if (season == null) season = (active && active.season) || 1;
            episodes.push({
                url,
                title: programCardTitle(card),
                description: programCardDescription(card),
                image: programCardImage(card),
                season
            });
        });
        return {
            mode: "program",
            seasonTabs: tabs,
            episodes,
            seasonUrlsToFetch: tabs.filter((tab) => !tab.active).map((tab) => tab.url)
        };
    }

    const legacy = parseLegacyEducationalSeasons(doc, base);
    if (legacy.length) {
        return { mode: "legacy", seasonTabs: [], episodes: legacy, seasonUrlsToFetch: [] };
    }
    return emptyEducationalParse();
}

/**
 * Episode numbers follow card order. The redesigned rows list episode 1
 * first, which is also how the previous seasons-item scraper numbered a block.
 *
 * @param {object[]} episodes
 * @returns {object[]}
 */
function assignEducationalEpisodeNumbers(episodes) {
    const groups = new Map();
    for (const episode of episodes || []) {
        if (!episode || !episode.url) continue;
        const season = Number.isFinite(episode.season) && episode.season > 0 ? episode.season : 1;
        if (!groups.has(season)) groups.set(season, []);
        groups.get(season).push(episode);
    }
    const numbered = [];
    for (const [season, list] of groups) {
        list.forEach((episode, index) => {
            numbered.push(Object.assign({}, episode, { season, episodeNo: index + 1 }));
        });
    }
    return numbered;
}

function nextEducationalListUrl(pageUrl) {
    let url;
    try {
        url = new URL(pageUrl);
    } catch (error) {
        return "";
    }
    const current = parseInt(url.searchParams.get("currentPage") || "1", 10);
    const next = Number.isFinite(current) && current > 0 ? current + 1 : 2;
    url.searchParams.set("currentPage", String(next));
    if (!url.searchParams.get("itemsToShow")) url.searchParams.set("itemsToShow", "100");
    return url.toString();
}

function pageParamListUrl(pageUrl) {
    let url;
    try {
        url = new URL(pageUrl);
    } catch (error) {
        return "";
    }
    if (url.searchParams.has("page")) return "";
    url.searchParams.set("page", "2");
    if (!url.searchParams.get("itemsToShow")) url.searchParams.set("itemsToShow", "100");
    return url.toString();
}

async function pullNewEducationalEpisodes(url, seen, fetchDocument) {
    if (!url) return [];
    let doc;
    try {
        doc = asDoc(await fetchDocument(url));
    } catch (error) {
        if (isKanBlockedError(error)) throw error;
        rethrowIfKanBlocked(error);
        logger.warn(`collectEducationalEpisodes => Could not fetch ${url}: ${error.message}`);
        return [];
    }
    if (!doc) return [];
    const parsed = parseEducationalSeriesPage(doc, url);
    const fresh = [];
    for (const episode of parsed.episodes) {
        const key = episodeKey(episode.url);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        fresh.push(episode);
    }
    return fresh;
}

async function readFurtherEpisodePages(sourceUrl, seen, fetchDocument) {
    const extra = [];
    let addedByCurrentPage = false;
    let url = sourceUrl;
    for (let i = 0; i < EDUCATIONAL_EXTRA_PAGES; i++) {
        url = nextEducationalListUrl(url);
        const found = await pullNewEducationalEpisodes(url, seen, fetchDocument);
        if (!found.length) break;
        addedByCurrentPage = true;
        extra.push(...found);
        if (found.length < EDUCATIONAL_EPISODE_PAGE_CAP) break;
    }
    if (!addedByCurrentPage) {
        const found = await pullNewEducationalEpisodes(pageParamListUrl(sourceUrl), seen, fetchDocument);
        extra.push(...found);
    }
    return extra;
}

/**
 * Episodes on this document, plus each other season tab (/sN/ is fetched
 * directly; the page script's $.ajax seasonId call returns the same row).
 * A full 50-card row is asked for the next page. Further pages are kept
 * only when they contain episode URLs the previous page did not.
 *
 * @param {string|object} html
 * @param {string} pageUrl
 * @param {(url: string) => Promise<string|object|null>} [fetchDocument]
 * @returns {Promise<object[]>}
 */
async function collectEducationalEpisodes(html, pageUrl, fetchDocument) {
    const parsed = parseEducationalSeriesPage(html, pageUrl);
    const seen = new Set();
    const episodes = [];
    const add = (list) => {
        for (const episode of list || []) {
            const key = episodeKey(episode && episode.url);
            if (!key || seen.has(key)) continue;
            seen.add(key);
            episodes.push(episode);
        }
    };
    add(parsed.episodes);

    if (parsed.mode === "program" && typeof fetchDocument === "function") {
        for (const seasonUrl of parsed.seasonUrlsToFetch) {
            const found = await pullNewEducationalEpisodes(seasonUrl, seen, fetchDocument);
            episodes.push(...found);
            if (found.length >= EDUCATIONAL_EPISODE_PAGE_CAP) {
                const more = await readFurtherEpisodePages(seasonUrl, seen, fetchDocument);
                episodes.push(...more);
            }
        }
        if (parsed.episodes.length >= EDUCATIONAL_EPISODE_PAGE_CAP) {
            const more = await readFurtherEpisodePages(pageUrl, seen, fetchDocument);
            episodes.push(...more);
        }
    }
    return assignEducationalEpisodeNumbers(episodes);
}

function seriesRootFromCardHref(href) {
    const absolute = toAbsolute(href, KAN_ORIGIN + "/");
    if (!absolute) return "";
    let url;
    try {
        url = new URL(absolute);
    } catch (error) {
        return "";
    }
    if (url.pathname.includes("/participants/")) return "";
    url.hash = "";
    url.search = "";
    const program = url.pathname.match(/^(.*\/p-\d+)(?:\/|$)/);
    if (program) url.pathname = program[1] + "/";
    else if (!url.pathname.endsWith("/")) url.pathname += "/";
    return url.toString();
}

/**
 * Series links for one Kan-Box category.
 * Current lobby: section.content-row-section, heading in h2, cards a.cr-item.
 * Episode hrefs are trimmed to the /p-N/ series root. A slug series with no
 * p-N id keeps its own path.
 * Fallback: .block-list .block-list-item .h3.title-elem and a.card-link.
 *
 * @param {string|object} html
 * @param {string} categoryName
 * @returns {string[]}
 */
function parseKanBoxCategorySeries(html, categoryName) {
    const doc = asDoc(html);
    if (!doc) return [];
    const wanted = String(categoryName || "").replace(/\s+/g, " ").trim();
    if (!wanted) return [];

    const fromRows = [];
    const seen = new Set();
    const push = (href, trimToSeries) => {
        const seriesUrl = trimToSeries ? seriesRootFromCardHref(href) : toAbsolute(href, KAN_ORIGIN + "/");
        if (!seriesUrl || seen.has(seriesUrl)) return;
        seen.add(seriesUrl);
        fromRows.push(seriesUrl);
    };

    doc.querySelectorAll("section.content-row-section").forEach((section) => {
        const heading = flatText(section.querySelector(".component-header h2, h2"));
        if (heading !== wanted) return;
        section.querySelectorAll("a.cr-item").forEach((card) => push(card.getAttribute("href"), true));
    });
    if (fromRows.length) return fromRows;

    doc.querySelectorAll(".block-list .block-list-item").forEach((item) => {
        const heading = flatText(item.querySelector(".h3.title-elem"));
        if (heading !== wanted) return;
        item.querySelectorAll("a.card-link").forEach((link) => push(link.getAttribute("href"), false));
    });
    return fromRows;
}

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
    streamFromKanDocument,
    chooseVideoObject,
    extractVideoObjectUrl,
    cleanVideoName,
    parseIsraeliDate,
    extractDateFromDataAttr,
    extractDateFromDatetime,
    extractReleaseDateGeneric,
    safeExecute,
    safeFetch,
    extractLobbySeries,
    parseEducationalSeriesPage,
    assignEducationalEpisodeNumbers,
    collectEducationalEpisodes,
    parseKanBoxCategorySeries,
    wrapProcessor,
    CircuitBreaker,
    RateLimiter
};
