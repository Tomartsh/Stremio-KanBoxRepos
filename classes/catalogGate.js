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
    const data = unwrapCatalog(root);
    let series = 0;
    let videos = 0;
    for (const value of Object.values(data)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        if (!value.meta && value.id == null && value.name == null) continue;
        series += 1;
        const list = (value.meta && value.meta.videos) || value.videos;
        if (Array.isArray(list)) videos += list.length;
    }
    return { series, videos };
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
    return { data, counts: countCatalog({ data }) };
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
    seriesRatio = KAN_SESSION.FULL_CATALOG_SERIES_RATIO
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

    if (shouldCheckVideoCount({ catalogComplete, counts, previous, seriesRatio })) {
        const minimum = previous.videos * videoKeepRatio;
        if (counts.videos < minimum) {
            const pct = Math.round((counts.videos / previous.videos) * 1000) / 10;
            return refusal(
                scraperName,
                file,
                `video count ${counts.videos} is ${pct}% of the previous ${previous.videos} (minimum ${Math.round(videoKeepRatio * 100)}%)`,
                false
            );
        }
    }

    return {
        published: true,
        blocked: false,
        status: "published",
        series: counts.series || 0,
        videos: counts.videos || 0
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
    countZipBuffer,
    shouldCheckVideoCount,
    decidePublish,
    formatRunResult,
    readLocalCatalog,
    readLocalCatalogCounts,
    loadPreviousCatalog,
    loadPreviousCatalogCounts,
    recoverCatalogAfterBudget,
    shouldRecoverAfterBudget
};
