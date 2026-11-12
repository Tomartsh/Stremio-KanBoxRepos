/**
 * Kids sitemap supplement for Kan kids and Kan teens series pages.
 *
 * A series page row (div#program-episodes) renders at most about 50 cards.
 * currentPage, itemsToShow, page, and the seasonId request all repeat that
 * same row. The kids sitemap lists the rest of the episode URLs. This module
 * reads that sitemap once per process and, for a series the scraper is
 * already processing, adds the episode URLs the page did not show.
 *
 * Episode ids stay {seriesId}:{season}:{episodeNo}, the same shape PR #26
 * stores. The page cards keep the numbers assignEducationalEpisodeNumbers
 * already gave them (the first card in a season is episode 1, even when the
 * row is full at 50). A sitemap episode that was not on the page takes the
 * "פרק N" number parsed from its title when that number is not already used
 * in the season. Free "פרק N" numbers are claimed first, so a colliding
 * title cannot take 51 away from an episode that is actually פרק 51. When
 * the title has no "פרק N", or that number is already used, the episode
 * takes the next integer after the highest number assigned in the season.
 * Those leftovers are ordered by numeric episode id, then datePublished.
 *
 * Flat /p-<series>/<id>/ URLs are season 1 only when the sitemap has no
 * /sN/ URLs for that series (p-762163). On a series that has seasons, those
 * flat URLs sit outside the season rows (trailers) and are not merged in.
 *
 * A sitemap miss logs a warning and the scraper keeps the page episodes.
 * Other series in the sitemap, including the very long ones, are ignored
 * until a scraper actually processes that series.
 */

const { parse } = require("node-html-parser");
const log4js = require("log4js");
const {
    streamFromKanDocument,
    cleanVideoName
} = require("./ScraperHelpers.js");
const {
    isKanBlockedError,
    isKanBudgetError,
    isKanBrowserError,
    rethrowIfKanBlocked
} = require("./kanSession.js");

const logger = log4js.getLogger("KanSitemap");

const KIDS_ORIGIN = "https://www.kankids.org.il";
const ROBOTS_URL = KIDS_ORIGIN + "/robots.txt";
const DEFAULT_INDEX_URL = "https://www.kan.org.il/media/sitemap/kids/siteindex.xml";
const SITEMAP_TIMEOUT_MS = 20000;
const SITEMAP_RETRIES = 2;
const SITEMAP_FILE_DELAY_MS = 300;
const EPISODE_CONCURRENCY = 3;
const EPISODE_DELAY_MS = 250;

const EXTRA_TITLE = /טריילר|הצצה|פרומו|מאחורי הקלעים|שיר הנושא|קליפ|בונוס/u;

let cache = null;
let inflight = null;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms fetching ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function resetKanSitemapCache() {
    cache = null;
    inflight = null;
}

function canonicalKidsPath(value) {
    let raw = String(value || "").trim();
    if (!raw) return "";
    if (raw.startsWith("/")) raw = KIDS_ORIGIN + raw;
    let url;
    try {
        url = new URL(raw);
    } catch (error) {
        return "";
    }
    let path = url.pathname || "/";
    path = path.replace(/^\/kids(?=\/content\/)/, "");
    if (!path.endsWith("/")) path += "/";
    return path;
}

function seriesIdFromPage(pageUrl) {
    const path = canonicalKidsPath(pageUrl);
    const match = path.match(/\/(p-\d+)(?:\/|$)/);
    return match ? match[1] : "";
}

/**
 * Episode URL shapes the kids sitemap uses:
 *   /content/kids/<section>/p-<series>/s<N>/<episodeId>/
 *   /content/kids/<section>/p-<series>/<episodeId>/   (no season segment)
 * An extra /kids segment (kankids.org.il/kids/content/...) is removed.
 * Season is null when the URL has no /sN/ segment.
 *
 * @param {string} value
 * @returns {{seriesId: string, season: number|null, episodeId: string, path: string, url: string}|null}
 */
function parseKidsEpisodeUrl(value) {
    const path = canonicalKidsPath(value);
    if (!path.includes("/content/kids/")) return null;
    const seasonal = path.match(/\/(p-\d+)\/s(\d+)\/(\d+)\/$/);
    if (seasonal) {
        return {
            seriesId: seasonal[1],
            season: parseInt(seasonal[2], 10),
            episodeId: seasonal[3],
            path,
            url: KIDS_ORIGIN + path
        };
    }
    const flat = path.match(/\/(p-\d+)\/(\d+)\/$/);
    if (!flat) return null;
    return {
        seriesId: flat[1],
        season: null,
        episodeId: flat[2],
        path,
        url: KIDS_ORIGIN + path
    };
}

function isBlockedDocument(text) {
    return /Attention Required|Sorry, you have been blocked|cf-error-details|Just a moment\.\.\./i.test(String(text || ""));
}

function locsFromXml(xml) {
    const text = String(xml || "").replace(/^\uFEFF/, "");
    const locs = [];
    const pattern = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s][^<]*?)\s*(?:\]\]>)?\s*<\/loc>/gi;
    let match;
    while ((match = pattern.exec(text))) {
        locs.push(match[1].trim().replace(/&amp;/g, "&"));
    }
    return {
        locs,
        isIndex: /<sitemapindex\b/i.test(text)
    };
}

/**
 * @param {string[]} locs
 * @returns {Map<string, {seasonal: Map<number, object[]>, flat: object[]}>}
 */
function groupSitemapEpisodes(locs) {
    const groups = new Map();
    const seen = new Set();
    for (const loc of locs || []) {
        const ref = parseKidsEpisodeUrl(loc);
        if (!ref || seen.has(ref.path)) continue;
        seen.add(ref.path);
        if (!groups.has(ref.seriesId)) {
            groups.set(ref.seriesId, { seasonal: new Map(), flat: [] });
        }
        const bucket = groups.get(ref.seriesId);
        if (ref.season == null) {
            bucket.flat.push(ref);
        } else {
            if (!bucket.seasonal.has(ref.season)) bucket.seasonal.set(ref.season, []);
            bucket.seasonal.get(ref.season).push(ref);
        }
    }
    return groups;
}

/**
 * Sitemap episodes for this series that the page did not already list.
 * Only seasons present on the page are filled. A series the page did not
 * return is not invented from the sitemap.
 *
 * @param {Map} groups
 * @param {string} seriesPageUrl
 * @param {object[]} pageEpisodes
 * @returns {object[]}
 */
function missingSitemapEpisodes(groups, seriesPageUrl, pageEpisodes) {
    const seriesId = seriesIdFromPage(seriesPageUrl);
    const bucket = seriesId && groups ? groups.get(seriesId) : null;
    if (!bucket) return [];
    const seasonsOnPage = new Set();
    const seen = new Set();
    for (const episode of pageEpisodes || []) {
        if (!episode) continue;
        const season = Number(episode.season);
        if (Number.isFinite(season) && season > 0) seasonsOnPage.add(season);
        const path = canonicalKidsPath(episode.url);
        if (path) seen.add(path);
    }
    if (!seasonsOnPage.size) return [];
    const hasSeasons = bucket.seasonal.size > 0;
    const missing = [];
    for (const season of seasonsOnPage) {
        const list = bucket.seasonal.get(season) || [];
        for (const ref of list) {
            if (seen.has(ref.path)) continue;
            seen.add(ref.path);
            missing.push(Object.assign({}, ref, { season }));
        }
    }
    if (!hasSeasons && seasonsOnPage.has(1)) {
        for (const ref of bucket.flat) {
            if (seen.has(ref.path)) continue;
            seen.add(ref.path);
            missing.push(Object.assign({}, ref, { season: 1 }));
        }
    }
    return missing;
}

function episodeNumberFromTitle(title) {
    const match = String(title || "").match(/פרק\s*(\d+)/u);
    if (!match) return null;
    const number = parseInt(match[1], 10);
    return Number.isFinite(number) && number > 0 ? number : null;
}

/**
 * Trailers and extras are named the way the series-page cards name them
 * (טריילר, הצצה, פרומו, מאחורי הקלעים, שיר הנושא, קליפ, בונוס, פתיח).
 * Cards already rendered on the page are kept; this only drops sitemap
 * URLs whose own page uses one of those titles.
 */
function isTrailerOrExtraTitle(title) {
    const text = String(title || "").replace(/\s+/g, " ").trim();
    if (!text) return false;
    const cleaned = String(cleanVideoName(text) || "").replace(/\s+/g, " ").trim();
    return [text, cleaned].some((value) => {
        if (!value) return false;
        if (EXTRA_TITLE.test(value)) return true;
        return /(?:^|\||\s)פתיח\s*$/u.test(value);
    });
}

function scriptText(script) {
    if (!script) return "";
    if (script.text != null && String(script.text).trim()) return String(script.text);
    return String(script.innerHTML || script.toString() || "");
}

function jsonField(text, field) {
    const match = String(text || "").match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
    if (!match) return "";
    try {
        return JSON.parse(`"${match[1]}"`);
    } catch (error) {
        return match[1];
    }
}

function asDocument(value) {
    if (!value) return null;
    if (typeof value === "string") return parse(value);
    if (typeof value.querySelector === "function") return value;
    return null;
}

function isoDate(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString();
}

function absoluteImage(src) {
    const text = String(src || "").trim();
    if (!text) return "";
    if (text.startsWith("//")) return "https:" + text;
    if (text.startsWith("/")) return KIDS_ORIGIN + text;
    return text;
}

/**
 * Title, episode number, image, description, datePublished, and stream from
 * one episode page. The stream uses streamFromKanDocument, the same extractor
 * the kids episode pages already use (redge data-hls-url, otherwise
 * VideoObject contentUrl).
 *
 * @param {string|object} html
 * @returns {object|null}
 */
function episodeFieldsFromDocument(html) {
    const doc = asDocument(html);
    if (!doc) return null;
    const stream = streamFromKanDocument(doc);
    let rawTitle = "";
    const titleNode = doc.querySelector("title");
    if (titleNode && titleNode.text) rawTitle = String(titleNode.text).trim();
    if (!rawTitle && stream && stream.name) rawTitle = stream.name;
    let published = "";
    let uploaded = "";
    let jsonName = "";
    let jsonImage = "";
    if (typeof doc.querySelectorAll === "function") {
        doc.querySelectorAll("script").forEach((script) => {
            const text = scriptText(script);
            if (!text) return;
            if (!published) published = jsonField(text, "datePublished");
            if (!uploaded) uploaded = jsonField(text, "uploadDate");
            if (!jsonName && text.includes("VideoObject")) jsonName = jsonField(text, "name");
            if (!jsonImage) jsonImage = jsonField(text, "thumbnailUrl");
        });
    }
    if (!rawTitle) rawTitle = jsonName;
    const title = String(cleanVideoName(rawTitle) || rawTitle || "").replace(/\s+/g, " ").trim();
    const description = (stream && stream.description)
        || (doc.querySelector('meta[name="description"]') && doc.querySelector('meta[name="description"]').getAttribute("content"))
        || "";
    const image = absoluteImage((stream && stream.thumbnail) || jsonImage);
    const datePublished = isoDate(published || uploaded || (stream && stream.released));
    let resolved = stream;
    if (resolved && datePublished && !resolved.released) {
        resolved = Object.assign({}, resolved, { released: datePublished });
    }
    return {
        title,
        parsedEpisodeNo: episodeNumberFromTitle(title) || episodeNumberFromTitle(rawTitle),
        description: String(description || "").replace(/[\r\n]+/g, "").trim(),
        image,
        datePublished,
        stream: resolved && resolved.url ? resolved : null
    };
}

function compareIdThenDate(left, right) {
    const leftId = Number(left.episodeId);
    const rightId = Number(right.episodeId);
    if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) return leftId - rightId;
    const leftDate = left.datePublished || "";
    const rightDate = right.datePublished || "";
    if (leftDate !== rightDate) return leftDate < rightDate ? -1 : 1;
    return String(left.url).localeCompare(String(right.url));
}

function comparePending(left, right) {
    const leftNo = left.parsedEpisodeNo;
    const rightNo = right.parsedEpisodeNo;
    if (leftNo != null && rightNo != null && leftNo !== rightNo) return leftNo - rightNo;
    if (leftNo != null && rightNo == null) return -1;
    if (leftNo == null && rightNo != null) return 1;
    return compareIdThenDate(left, right);
}

/**
 * Number sitemap episodes without changing the page cards' episode numbers.
 * See the module comment for the collision rule.
 *
 * @param {object[]} pageEpisodes
 * @param {object[]} pending
 * @returns {object[]}
 */
function assignAddedEpisodeNumbers(pageEpisodes, pending) {
    const bySeason = new Map();
    for (const item of pending || []) {
        if (!item) continue;
        const season = Number.isFinite(item.season) && item.season > 0 ? item.season : 1;
        if (!bySeason.has(season)) bySeason.set(season, []);
        bySeason.get(season).push(item);
    }
    const added = [];
    for (const [season, list] of bySeason) {
        const used = new Set();
        let highest = 0;
        for (const episode of pageEpisodes || []) {
            if (!episode || Number(episode.season) !== season) continue;
            const number = Number(episode.episodeNo);
            if (!Number.isFinite(number) || number <= 0) continue;
            used.add(number);
            if (number > highest) highest = number;
        }
        // Claim every free פרק number before leftovers take the next ids.
        // Otherwise a colliding "פרק 6" would be numbered 51 and the real
        // פרק 51 would be pushed to 52.
        const claimed = new Map();
        const leftovers = [];
        for (const item of list.slice().sort(comparePending)) {
            if (item.parsedEpisodeNo && !used.has(item.parsedEpisodeNo) && !claimed.has(item.parsedEpisodeNo)) {
                claimed.set(item.parsedEpisodeNo, item);
                if (item.parsedEpisodeNo > highest) highest = item.parsedEpisodeNo;
            } else {
                leftovers.push(item);
            }
        }
        const numbered = new Map();
        for (const [number, item] of claimed) {
            used.add(number);
            numbered.set(item, number);
        }
        leftovers.sort(compareIdThenDate);
        for (const item of leftovers) {
            let number = highest + 1;
            while (used.has(number)) number += 1;
            used.add(number);
            if (number > highest) highest = number;
            numbered.set(item, number);
        }
        for (const item of list) {
            const number = numbered.get(item);
            added.push({
                url: item.url,
                title: item.title,
                description: item.description || "",
                image: item.image || "",
                season,
                episodeNo: number,
                stream: item.stream || null
            });
        }
    }
    added.sort((left, right) => left.season - right.season || left.episodeNo - right.episodeNo);
    return added;
}

function siblingSitemapUrl(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch (error) {
        return "";
    }
    if (!url.pathname.includes("/media/sitemap/")) return "";
    const host = url.hostname.toLowerCase();
    if (host.endsWith("kankids.org.il")) url.hostname = "www.kan.org.il";
    else if (host.endsWith("kan.org.il")) url.hostname = "www.kankids.org.il";
    else return "";
    const next = url.toString();
    return next === String(raw) ? "" : next;
}

async function defaultFetchText(url, timeoutMs) {
    const { gotScraping } = require("got-scraping");
    const response = await gotScraping({
        url,
        timeout: { request: timeoutMs },
        throwHttpErrors: false,
        headerGeneratorOptions: {
            browsers: [{ name: "chrome", minVersion: 120 }],
            devices: ["desktop"],
            operatingSystems: ["windows"]
        },
        headers: {
            accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "accept-language": "he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7"
        }
    });
    const status = response.statusCode || 0;
    const body = String(response.body || "");
    if (status >= 400) {
        const error = new Error(`HTTP ${status} for ${url}`);
        error.statusCode = status;
        throw error;
    }
    return body;
}

async function fetchTextRetry(url, fetchText, timeoutMs, retries, retryDelayMs, log) {
    let lastError = null;
    const attempts = Math.max(0, retries) + 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            const body = await withTimeout(fetchText(url), timeoutMs, url);
            const text = String(body || "").replace(/^\uFEFF/, "").trim();
            if (!text) throw new Error(`Empty response for ${url}`);
            if (isBlockedDocument(text)) throw new Error(`Blocked response for ${url}`);
            return text;
        } catch (error) {
            lastError = error;
            if (attempt < attempts) {
                log.warn(`KanSitemap => ${url} failed (${error.message}), retry ${attempt} of ${retries}.`);
                if (retryDelayMs > 0) await sleep(retryDelayMs * attempt);
            }
        }
    }
    throw lastError;
}

async function fetchSitemapText(url, options) {
    const fetchText = options.fetchText;
    const timeoutMs = options.timeoutMs;
    const retries = options.retries;
    const retryDelayMs = options.retryDelayMs;
    const log = options.logger;
    try {
        return await fetchTextRetry(url, fetchText, timeoutMs, retries, retryDelayMs, log);
    } catch (error) {
        const alternate = siblingSitemapUrl(url);
        if (!alternate) throw error;
        log.info(`KanSitemap => ${url} failed (${error.message}). Trying ${alternate}.`);
        return fetchTextRetry(alternate, fetchText, timeoutMs, retries, retryDelayMs, log);
    }
}

function indexUrlFromRobots(robots) {
    const maps = [];
    const pattern = /^Sitemap:\s*(\S+)/gmi;
    let match;
    const text = String(robots || "");
    while ((match = pattern.exec(text))) maps.push(match[1].trim());
    return maps.find((item) => /siteindex\.xml$/i.test(item))
        || maps.find((item) => /sitemap/i.test(item))
        || "";
}

async function readSitemapGroups(options) {
    const log = options.logger;
    let indexUrl = "";
    try {
        const robots = await fetchTextRetry(
            ROBOTS_URL,
            options.fetchText,
            options.timeoutMs,
            options.retries,
            options.retryDelayMs,
            log
        );
        indexUrl = indexUrlFromRobots(robots);
    } catch (error) {
        log.info(`KanSitemap => robots.txt unavailable (${error.message}). Using ${DEFAULT_INDEX_URL}.`);
    }
    if (!indexUrl) indexUrl = DEFAULT_INDEX_URL;

    const indexBody = await fetchSitemapText(indexUrl, options);
    const index = locsFromXml(indexBody);
    if (!index.locs.length) throw new Error(`Sitemap index ${indexUrl} had no locations`);
    const childUrls = index.isIndex ? index.locs : [indexUrl];
    const pageLocs = index.isIndex ? [] : index.locs.slice();
    const errors = [];
    for (let i = 0; i < childUrls.length; i++) {
        if (index.isIndex) {
            try {
                const body = await fetchSitemapText(childUrls[i], options);
                const parsed = locsFromXml(body);
                if (parsed.isIndex) {
                    for (const nested of parsed.locs) {
                        const nestedBody = await fetchSitemapText(nested, options);
                        pageLocs.push(...locsFromXml(nestedBody).locs);
                    }
                } else {
                    pageLocs.push(...parsed.locs);
                }
            } catch (error) {
                errors.push(error);
                log.warn(`KanSitemap => Could not read ${childUrls[i]}: ${error.message}`);
            }
        }
        if (options.fileDelayMs > 0 && i < childUrls.length - 1) await sleep(options.fileDelayMs);
    }
    if (index.isIndex && !pageLocs.length) {
        throw errors[0] || new Error("Kids sitemap files were empty");
    }
    return groupSitemapEpisodes(pageLocs);
}

function sitemapOptions(options) {
    const provided = options || {};
    return {
        fetchText: provided.fetchText || ((url) => defaultFetchText(url, provided.timeoutMs || SITEMAP_TIMEOUT_MS)),
        timeoutMs: provided.timeoutMs == null ? SITEMAP_TIMEOUT_MS : provided.timeoutMs,
        retries: provided.retries == null ? SITEMAP_RETRIES : provided.retries,
        retryDelayMs: provided.retryDelayMs == null ? 200 : provided.retryDelayMs,
        fileDelayMs: provided.fileDelayMs == null ? SITEMAP_FILE_DELAY_MS : provided.fileDelayMs,
        logger: provided.logger || logger
    };
}

/**
 * Fetch robots.txt, the sitemap index, and each sub-sitemap once per process.
 * @returns {Promise<Map|null>} null when the sitemap cannot be read
 */
async function loadKidsSitemap(options) {
    if (cache) return cache.failed ? null : cache.groups;
    if (!inflight) {
        const resolved = sitemapOptions(options);
        inflight = readSitemapGroups(resolved)
            .then((groups) => {
                cache = { failed: false, groups };
                resolved.logger.info(`KanSitemap => Loaded ${groups.size} series from the kids sitemap.`);
                return groups;
            })
            .catch((error) => {
                cache = { failed: true, reason: error.message };
                resolved.logger.warn(
                    `KanSitemap => Kids sitemap unavailable (${error.message}). Series pages will be used on their own.`
                );
                return null;
            })
            .finally(() => {
                inflight = null;
            });
    }
    return inflight;
}

async function mapPool(items, concurrency, delayMs, fn) {
    const results = [];
    const size = Math.max(1, concurrency || 1);
    for (let i = 0; i < items.length; i += size) {
        const slice = items.slice(i, i + size);
        const batch = await Promise.all(slice.map((item) => fn(item)));
        results.push(...batch);
        if (delayMs > 0 && i + size < items.length) await sleep(delayMs);
    }
    return results;
}

/**
 * Keep page episodes (and their episode numbers) and append sitemap episodes
 * for this series that the page did not show.
 *
 * @param {object[]} pageEpisodes numbered by assignEducationalEpisodeNumbers
 * @param {string} seriesPageUrl
 * @param {object} [options]
 * @param {(url: string) => Promise<string|object|null>} [options.fetchDocument]
 * @returns {Promise<object[]>}
 */
async function supplementEducationalEpisodes(pageEpisodes, seriesPageUrl, options) {
    const episodes = Array.isArray(pageEpisodes) ? pageEpisodes : [];
    const settings = options || {};
    const log = settings.logger || logger;
    if (!episodes.length) return episodes;
    if (!seriesIdFromPage(seriesPageUrl)) return episodes;

    const groups = await loadKidsSitemap(settings);
    if (!groups) return episodes;
    const missing = missingSitemapEpisodes(groups, seriesPageUrl, episodes);
    if (!missing.length) return episodes;
    if (typeof settings.fetchDocument !== "function") {
        log.warn(`KanSitemap => No episode fetcher for ${seriesIdFromPage(seriesPageUrl)}. Keeping the series page only.`);
        return episodes;
    }

    const concurrency = settings.concurrency == null ? EPISODE_CONCURRENCY : settings.concurrency;
    const delayMs = settings.delayMs == null ? EPISODE_DELAY_MS : settings.delayMs;
    let blocked = null;
    const pending = await mapPool(missing, concurrency, delayMs, async (ref) => {
        if (blocked) return null;
        try {
            const doc = await settings.fetchDocument(ref.url);
            if (!doc) {
                log.warn(`KanSitemap => No episode page for ${ref.url}`);
                return null;
            }
            const fields = episodeFieldsFromDocument(doc);
            if (!fields || !fields.title) {
                log.warn(`KanSitemap => No title for ${ref.url}`);
                return null;
            }
            if (isTrailerOrExtraTitle(fields.title)) {
                log.debug(`KanSitemap => Skipping trailer/extra ${ref.url} (${fields.title})`);
                return null;
            }
            return {
                url: ref.url,
                episodeId: ref.episodeId,
                season: ref.season,
                title: fields.title,
                description: fields.description,
                image: fields.image,
                datePublished: fields.datePublished,
                parsedEpisodeNo: fields.parsedEpisodeNo,
                stream: fields.stream
            };
        } catch (error) {
            if (isKanBlockedError(error) || isKanBudgetError(error) || isKanBrowserError(error)) {
                blocked = error;
                return null;
            }
            try {
                rethrowIfKanBlocked(error);
            } catch (blockedError) {
                blocked = blockedError;
                return null;
            }
            log.warn(`KanSitemap => Could not read ${ref.url}: ${error.message}`);
            return null;
        }
    });
    if (blocked) throw blocked;

    const added = assignAddedEpisodeNumbers(episodes, pending.filter(Boolean));
    if (added.length) {
        const seriesId = seriesIdFromPage(seriesPageUrl);
        log.info(`KanSitemap => ${seriesId}: added ${added.length} episode(s) that the series page did not show.`);
    }
    return episodes.concat(added);
}

module.exports = {
    resetKanSitemapCache,
    canonicalKidsPath,
    seriesIdFromPage,
    parseKidsEpisodeUrl,
    locsFromXml,
    groupSitemapEpisodes,
    missingSitemapEpisodes,
    episodeNumberFromTitle,
    isTrailerOrExtraTitle,
    episodeFieldsFromDocument,
    assignAddedEpisodeNumbers,
    loadKidsSitemap,
    supplementEducationalEpisodes,
    siblingSitemapUrl,
    ROBOTS_URL,
    DEFAULT_INDEX_URL
};
