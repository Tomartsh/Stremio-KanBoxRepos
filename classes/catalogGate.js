/**
 * Decide whether a finished scrape may replace the published catalog.
 *
 * updateFromJSON deletes that scraper's Supabase rows before inserting, and
 * writeJSONToFile replaces the ZIP. A run that was blocked, or that kept the
 * series list while dropping episodes, must leave both alone.
 */

const fs = require("fs");
const path = require("path");
const axios = require("axios");
const AdmZip = require("adm-zip");
const { KAN_SESSION, URL_JSON_BASE, SAVE_FOLDER } = require("./constants");
const { isKanBlockedError, isKanBrowserError } = require("./kanSession");
const {
    normalizeSeriesLink,
    normalizeSeriesName,
    buildSeriesIdentityIndex,
    matchSeriesIdentity
} = require("./seriesIdentity");

const PARTIAL_INCREMENTAL_SCRAPERS = new Set(["Kan88", "KanPodcasts"]);

function catalogIsComplete(scraperName, incrementalMode) {
    if (incrementalMode && PARTIAL_INCREMENTAL_SCRAPERS.has(scraperName)) return false;
    return true;
}

function unwrapCatalog(root) {
    if (!root || typeof root !== "object" || Array.isArray(root)) return {};
    if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) return root.data;
    return root;
}

function countCatalog(root) {
    const measured = measureCatalog(root);
    return { series: measured.series, videos: measured.videos };
}

/**
 * Series count, video count, how many videos have a description, the
 * uncompressed JSON size of the catalog object, and a per-series video count.
 * The JSON size is JSON.stringify of the series map, not the compressed ZIP.
 */
function measureCatalog(root) {
    const data = unwrapCatalog(root);
    let series = 0;
    let videos = 0;
    let described = 0;
    const perSeries = {};
    for (const [id, value] of Object.entries(data)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        if (!value.meta && value.id == null && value.name == null) continue;
        series += 1;
        const list = (value.meta && value.meta.videos) || value.videos;
        const count = Array.isArray(list) ? list.length : 0;
        videos += count;
        if (Array.isArray(list)) {
            for (const video of list) {
                if (video && String(video.description || "").trim()) described += 1;
            }
        }
        perSeries[id] = {
            name: value.name || (value.meta && value.meta.name) || "",
            link: value.link || (value.meta && value.meta.link) || "",
            videos: count
        };
    }
    return {
        series,
        videos,
        described,
        jsonBytes: Buffer.byteLength(JSON.stringify(data)),
        perSeries
    };
}

function percentOf(current, previous) {
    if (!previous) return "n/a";
    return `${Math.round((current / previous) * 1000) / 10}% of ${previous}`;
}

/**
 * One line for the log. Compressed ZIP size is intentionally not included.
 */
function formatCatalogComparison(scraperName, counts, previous) {
    const current = counts || {};
    const series = current.series || 0;
    const videos = current.videos || 0;
    let seriesPart = `${series} series`;
    if (previous && previous.series) seriesPart += ` (${percentOf(series, previous.series)})`;
    let videoPart = `${videos} videos`;
    if (previous && previous.videos) videoPart += ` (${percentOf(videos, previous.videos)})`;
    const parts = [seriesPart, videoPart];
    if (current.jsonBytes != null) {
        let jsonPart = `uncompressed JSON ${current.jsonBytes}B`;
        if (previous && previous.jsonBytes) jsonPart += ` (${percentOf(current.jsonBytes, previous.jsonBytes)})`;
        parts.push(jsonPart);
    }
    if (current.described != null && videos > 0) {
        const ratio = Math.round((current.described / videos) * 1000) / 10;
        let desc = `descriptions ${current.described}/${videos} (${ratio}%)`;
        if (previous && previous.described != null && previous.videos) {
            const prevRatio = Math.round((previous.described / previous.videos) * 1000) / 10;
            desc += ` vs previous ${previous.described}/${previous.videos} (${prevRatio}%)`;
        }
        parts.push(desc);
    }
    return `${scraperName} catalog: ${parts.join(", ")}`;
}

function seriesVideoDrops(previous, counts) {
    if (!previous || !previous.perSeries || !counts || !counts.perSeries) return [];
    const byLink = new Map();
    const byName = new Map();
    for (const [id, next] of Object.entries(counts.perSeries)) {
        const link = normalizeSeriesLink(next && next.link);
        const name = normalizeSeriesName(next && next.name);
        const record = {
            id,
            name: (next && next.name) || "",
            link,
            videos: next ? next.videos : 0
        };
        if (link && !byLink.has(link)) byLink.set(link, record);
        if (name && !byName.has(name)) byName.set(name, record);
    }
    const consumed = new Set();
    const drops = [];
    for (const [id, prev] of Object.entries(previous.perSeries)) {
        let next = null;
        if (counts.perSeries[id] && !consumed.has(id)) {
            const same = counts.perSeries[id];
            next = {
                id,
                name: same.name || "",
                link: normalizeSeriesLink(same.link),
                videos: same.videos
            };
        } else {
            const link = normalizeSeriesLink(prev && prev.link);
            const name = normalizeSeriesName(prev && prev.name);
            let hit = link ? byLink.get(link) : null;
            if (hit && consumed.has(hit.id)) hit = null;
            if (!hit && name) {
                const named = byName.get(name);
                if (named && !consumed.has(named.id)) hit = named;
            }
            if (hit) next = hit;
        }
        if (next && next.id) consumed.add(next.id);
        const previousCount = Number(prev && prev.videos) || 0;
        const currentCount = next ? (Number(next.videos) || 0) : 0;
        if (currentCount >= previousCount) continue;
        drops.push({
            id,
            name: (next && next.name) || (prev && prev.name) || id,
            previous: previousCount,
            current: currentCount
        });
    }
    drops.sort((left, right) => (right.previous - right.current) - (left.previous - left.current));
    return drops;
}

function dropIsSevere(drop) {
    const lost = drop.previous - drop.current;
    if (drop.previous >= 3 && drop.current <= 1) return true;
    if (lost >= 3) return true;
    return false;
}

function catalogFromZipBuffer(buffer) {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntries().find((item) => item.entryName.endsWith(".json"));
    if (!entry) return null;
    const root = JSON.parse(entry.getData().toString("utf8"));
    return { root, data: unwrapCatalog(root) };
}

function countZipBuffer(buffer) {
    const catalog = catalogFromZipBuffer(buffer);
    if (!catalog) return null;
    return countCatalog(catalog.root);
}

function seriesEntries(root) {
    const entries = [];
    for (const [id, series] of Object.entries(unwrapCatalog(root))) {
        if (!series || typeof series !== "object" || Array.isArray(series)) continue;
        if (!series.meta && series.id == null && series.name == null) continue;
        entries.push([id, series]);
    }
    return entries;
}

/**
 * Keep every previous series, and replace a series only when this run
 * finished it with at least one video. A series that was not reached, or
 * that came back empty, stays as it was. The caller still runs the video
 * count gate on the merged catalog.
 */
function recoverCatalogAfterBudget(previousRoot, scrapedRoot) {
    const previous = seriesEntries(previousRoot);
    if (previous.length === 0) return null;
    const data = {};
    for (const [id, series] of previous) data[id] = series;
    for (const [id, series] of seriesEntries(scrapedRoot)) {
        const videos = series.meta && series.meta.videos;
        if (!Array.isArray(videos) || videos.length === 0) continue;
        data[id] = series;
    }
    return { data, counts: measureCatalog({ data }) };
}

/**
 * Put previous episodes back after a page timeout.
 *
 * A listing timeout keeps every published series this run did not finish,
 * because the run cannot tell a slow page from a series that left the lobby.
 * The next listing fetch that succeeds drops a series that is really gone.
 * A series-page timeout keeps that series only. A page that loads and lists
 * fewer episodes, or a series missing from a listing that did load, is left
 * as scraped so the video gate can still refuse a real removal.
 */
function restoreFailedFetches(previousRoot, scrapedRoot, options = {}) {
    const listingIncomplete = !!(options && options.listingIncomplete);
    const failedSeries = (options && options.failedSeries) || [];
    if (!listingIncomplete && failedSeries.length === 0) return null;
    const previous = seriesEntries(previousRoot);
    if (previous.length === 0) return null;

    const data = {};
    for (const [id, series] of seriesEntries(scrapedRoot)) data[id] = series;
    const scrapedIndex = buildSeriesIdentityIndex({ data });
    const previousIndex = buildSeriesIdentityIndex(previousRoot);

    const present = (id, link) => {
        if (id && Object.prototype.hasOwnProperty.call(data, id)) return true;
        if (link && scrapedIndex.byLink.has(link)) return true;
        return false;
    };
    let restored = 0;
    const add = (id, series) => {
        const canonicalId = String((series && series.id) || id);
        const link = normalizeSeriesLink(series && (series.link || (series.meta && series.meta.link)));
        if (present(canonicalId, link)) return;
        data[canonicalId] = JSON.parse(JSON.stringify(series));
        scrapedIndex.byId.set(canonicalId, { id: canonicalId, link, series });
        if (link) scrapedIndex.byLink.set(link, { id: canonicalId, link, series });
        restored += 1;
    };

    if (listingIncomplete) {
        for (const [id, series] of previous) add(id, series);
    }
    for (const failure of failedSeries) {
        const matched = matchSeriesIdentity(previousIndex, failure || {});
        if (!matched) continue;
        add(matched.id, matched.series);
    }
    if (restored === 0) return null;
    return { data, counts: measureCatalog({ data }), restored };
}

function shouldRecoverAfterBudget({ scrapeError = null, blocked = false, http403 = 0 } = {}) {
    if (blocked || http403 > 0 || isKanBlockedError(scrapeError)) return false;
    return !!(scrapeError && scrapeError.code === "BUDGET");
}

function shouldCheckVideoCount({ catalogComplete, counts, previous, seriesRatio }) {
    if (!previous || !(previous.videos > 0)) return false;
    if (catalogComplete) return true;
    if (previous.series > 0 && counts.series >= previous.series * seriesRatio) return true;
    return false;
}

function decidePublish({
    scraperName,
    exportFilename,
    scrapeError = null,
    counts = { series: 0, videos: 0 },
    previous = null,
    blocked = false,
    http403 = 0,
    allowEmpty = false,
    catalogComplete = true,
    videoKeepRatio = KAN_SESSION.VIDEO_KEEP_RATIO,
    seriesRatio = KAN_SESSION.FULL_CATALOG_SERIES_RATIO,
    seriesKeepRatio = KAN_SESSION.SERIES_KEEP_RATIO,
    jsonKeepRatio = KAN_SESSION.JSON_KEEP_RATIO,
    descriptionKeepRatio = KAN_SESSION.DESCRIPTION_KEEP_RATIO
}) {
    const file = exportFilename || scraperName;
    const blockedRun = blocked || http403 > 0 || isKanBlockedError(scrapeError);

    if (blockedRun) {
        const reason = (isKanBlockedError(scrapeError) && scrapeError.message)
            || (scrapeError && scrapeError.message)
            || "HTTP 403 from Cloudflare";
        return refusal(scraperName, file, reason, true);
    }

    if (scrapeError && scrapeError.code === "BUDGET") {
        return refusal(
            scraperName,
            file,
            scrapeError.message || "time budget exhausted",
            false,
            "BUDGET"
        );
    }

    if (scrapeError && (scrapeError.code === "BROWSER" || isKanBrowserError(scrapeError))) {
        return refusal(
            scraperName,
            file,
            scrapeError.message || "KAN BROWSER UNAVAILABLE",
            false,
            "BROWSER"
        );
    }

    if (scrapeError) {
        return refusal(scraperName, file, `scrape failed (${scrapeError.message})`, false);
    }

    if ((counts.series || 0) === 0 && !allowEmpty) {
        return refusal(scraperName, file, "scrape produced 0 series", false);
    }

    const seriesDrops = seriesVideoDrops(previous, counts);
    if (shouldCheckVideoCount({ catalogComplete, counts, previous, seriesRatio })) {
        const reasons = [];
        const minimum = previous.videos * videoKeepRatio;
        if (counts.videos < minimum) {
            const pct = Math.round((counts.videos / previous.videos) * 1000) / 10;
            reasons.push(
                `video count ${counts.videos} is ${pct}% of the previous ${previous.videos} (minimum ${Math.round(videoKeepRatio * 100)}%)`
            );
        }
        if (previous.series > 0 && (counts.series || 0) < previous.series * seriesKeepRatio) {
            const pct = Math.round(((counts.series || 0) / previous.series) * 1000) / 10;
            reasons.push(
                `series count ${counts.series || 0} is ${pct}% of the previous ${previous.series} (minimum ${Math.round(seriesKeepRatio * 100)}%)`
            );
        }
        if (previous.jsonBytes > 0 && counts.jsonBytes != null && counts.jsonBytes < previous.jsonBytes * jsonKeepRatio) {
            const pct = Math.round((counts.jsonBytes / previous.jsonBytes) * 1000) / 10;
            reasons.push(
                `uncompressed JSON ${counts.jsonBytes}B is ${pct}% of the previous ${previous.jsonBytes}B (minimum ${Math.round(jsonKeepRatio * 100)}%)`
            );
        }
        if (previous.videos > 0 && previous.described != null && counts.described != null && counts.videos > 0) {
            const previousRate = previous.described / previous.videos;
            const currentRate = counts.described / counts.videos;
            if (previousRate >= 0.5 && currentRate < previousRate * descriptionKeepRatio) {
                const prevPct = Math.round(previousRate * 1000) / 10;
                const newPct = Math.round(currentRate * 1000) / 10;
                reasons.push(
                    `descriptions ${counts.described}/${counts.videos} (${newPct}%) fell below ${Math.round(descriptionKeepRatio * 100)}% of the previous fill rate ${previous.described}/${previous.videos} (${prevPct}%)`
                );
            }
        }
        const severe = seriesDrops.filter(dropIsSevere);
        if (severe.length > 0) {
            const sample = severe.slice(0, 8).map((drop) => `${drop.name} ${drop.previous}->${drop.current}`).join(", ");
            reasons.push(`${severe.length} series lost videos (${sample})`);
        }
        if (reasons.length > 0) {
            const refused = refusal(scraperName, file, reasons.join("; "), false);
            refused.seriesDrops = seriesDrops;
            return refused;
        }
    }

    return {
        published: true,
        blocked: false,
        status: "published",
        series: counts.series || 0,
        videos: counts.videos || 0,
        seriesDrops
    };
}

function refusal(scraperName, file, reason, blocked, status) {
    const line = blocked
        ? `BLOCKED ${scraperName} => Refusing to publish ${file}: ${reason}. The existing ZIP and Supabase rows were left unchanged.`
        : `${scraperName} => Refusing to publish ${file}: ${reason}. The existing ZIP and Supabase rows were left unchanged.`;
    return {
        published: false,
        blocked,
        status: status || (blocked ? "BLOCKED" : "REFUSED"),
        reason,
        line,
        series: 0,
        videos: 0
    };
}

function formatRunResult(scraperName, outcome) {
    if (outcome && outcome.skipped) {
        return { level: "warn", message: outcome.line || `SKIPPED ${scraperName}` };
    }
    if (!outcome || outcome.published !== false) {
        return { level: "info", message: `✅ ${scraperName} completed successfully` };
    }
    if (outcome.blocked) {
        return {
            level: "error",
            message: outcome.line || `BLOCKED ${scraperName}: ${outcome.reason}`
        };
    }
    return {
        level: "error",
        message: outcome.line || `${scraperName} was not published: ${outcome.reason}`
    };
}

function readLocalCatalog(exportFilename, outputDir) {
    const zipPath = path.join(outputDir, `${exportFilename}.zip`);
    const jsonPath = path.join(outputDir, `${exportFilename}.json`);
    if (fs.existsSync(zipPath)) return catalogFromZipBuffer(fs.readFileSync(zipPath));
    if (fs.existsSync(jsonPath)) {
        const root = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
        return { root, data: unwrapCatalog(root) };
    }
    return null;
}

function readLocalCatalogCounts(exportFilename, outputDir) {
    const catalog = readLocalCatalog(exportFilename, outputDir);
    if (!catalog) return null;
    return countCatalog(catalog.root);
}

/**
 * Previous published catalog: the ZIP on the raw output URL, then the local
 * ZIP. No Supabase read. Returns null when neither copy has a series.
 */
async function loadPreviousCatalog(exportFilename, options = {}) {
    const logger = options.logger || console;
    const outputDir = options.outputDir || path.join(__dirname, `../${SAVE_FOLDER}`);
    const remote = options.remote !== false && process.env.CATALOG_GATE_OFFLINE !== "1";

    if (remote) {
        const remoteUrl = `${URL_JSON_BASE}${exportFilename}.zip`;
        try {
            const response = await axios.get(remoteUrl, {
                responseType: "arraybuffer",
                timeout: options.timeoutMs || 8000,
                validateStatus: (status) => status >= 200 && status < 300
            });
            const catalog = catalogFromZipBuffer(Buffer.from(response.data));
            if (catalog && countCatalog(catalog.root).series > 0) return catalog;
        } catch (error) {
            logger.warn(`catalogGate => No remote baseline for ${exportFilename}: ${error.message}`);
        }
    }

    try {
        const local = readLocalCatalog(exportFilename, outputDir);
        if (local && countCatalog(local.root).series > 0) return local;
    } catch (error) {
        logger.warn(`catalogGate => Could not read local baseline for ${exportFilename}: ${error.message}`);
    }

    return null;
}

async function countFromSupabase(databaseKey, logger) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key || !databaseKey) return null;
    try {
        const { createClient } = require("@supabase/supabase-js");
        const supabase = createClient(url, key);
        const { data, error } = await supabase
            .from("series")
            .select("video_count")
            .eq("scraper", databaseKey);
        if (error) {
            logger.warn(`catalogGate => Could not read previous Supabase counts for ${databaseKey}: ${error.message}`);
            return null;
        }
        const rows = data || [];
        const videos = rows.reduce((sum, row) => sum + (Number(row.video_count) || 0), 0);
        return { series: rows.length, videos };
    } catch (error) {
        logger.warn(`catalogGate => Supabase baseline skipped for ${databaseKey}: ${error.message}`);
        return null;
    }
}

async function loadPreviousCatalogCounts(exportFilename, options = {}) {
    const logger = options.logger || console;
    const remote = options.remote !== false && process.env.CATALOG_GATE_OFFLINE !== "1";
    const catalog = await loadPreviousCatalog(exportFilename, options);
    if (catalog) {
        const counts = countCatalog(catalog.root);
        if (counts.series > 0) return counts;
    }

    if (options.databaseKey && remote) {
        const fromDb = await countFromSupabase(options.databaseKey, logger);
        if (fromDb && fromDb.series > 0) return fromDb;
    }

    return null;
}

module.exports = {
    PARTIAL_INCREMENTAL_SCRAPERS,
    catalogIsComplete,
    countCatalog,
    measureCatalog,
    formatCatalogComparison,
    seriesVideoDrops,
    countZipBuffer,
    shouldCheckVideoCount,
    decidePublish,
    formatRunResult,
    readLocalCatalog,
    readLocalCatalogCounts,
    loadPreviousCatalog,
    loadPreviousCatalogCounts,
    recoverCatalogAfterBudget,
    shouldRecoverAfterBudget,
    restoreFailedFetches
};
