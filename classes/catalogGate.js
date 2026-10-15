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
const { isKanBlockedError } = require("./kanSession");

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

function countZipBuffer(buffer) {
    const zip = new AdmZip(buffer);
    const entry = zip.getEntries().find((item) => item.entryName.endsWith(".json"));
    if (!entry) return null;
    const parsed = JSON.parse(entry.getData().toString("utf8"));
    return countCatalog(parsed);
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

function refusal(scraperName, file, reason, blocked) {
    const line = blocked
        ? `BLOCKED ${scraperName} => Refusing to publish ${file}: ${reason}. The existing ZIP and Supabase rows were left unchanged.`
        : `${scraperName} => Refusing to publish ${file}: ${reason}. The existing ZIP and Supabase rows were left unchanged.`;
    return {
        published: false,
        blocked,
        status: blocked ? "BLOCKED" : "REFUSED",
        reason,
        line,
        series: 0,
        videos: 0
    };
}

function formatRunResult(scraperName, outcome) {
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

function readLocalCatalogCounts(exportFilename, outputDir) {
    const zipPath = path.join(outputDir, `${exportFilename}.zip`);
    const jsonPath = path.join(outputDir, `${exportFilename}.json`);
    if (fs.existsSync(zipPath)) {
        return countZipBuffer(fs.readFileSync(zipPath));
    }
    if (fs.existsSync(jsonPath)) {
        return countCatalog(JSON.parse(fs.readFileSync(jsonPath, "utf8")));
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
            const counts = countZipBuffer(Buffer.from(response.data));
            if (counts && counts.series > 0) return counts;
        } catch (error) {
            logger.warn(`catalogGate => No remote baseline for ${exportFilename}: ${error.message}`);
        }
    }

    try {
        const local = readLocalCatalogCounts(exportFilename, outputDir);
        if (local && local.series > 0) return local;
    } catch (error) {
        logger.warn(`catalogGate => Could not read local baseline for ${exportFilename}: ${error.message}`);
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
    readLocalCatalogCounts,
    loadPreviousCatalogCounts
};
