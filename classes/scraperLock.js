/**
 * One lock file per scraper so a long standalone run and the nightly runner
 * do not hit the same site together.
 *
 * The nightly runner pulls this repo and starts scrapers through BaseScraper.
 * crawl() takes locks/<scraper>.lock before any request. If that file is held
 * by a live pid and is younger than the run budget plus two hours, crawl
 * returns SKIPPED and does not publish. A dead pid, or a file older than that
 * limit, is stale and is replaced.
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_LOCK_DIR = path.join(__dirname, "..", "locks");
const LOCK_GRACE_MS = 2 * 60 * 60 * 1000;
const DEFAULT_STALE_MS = 26 * 60 * 60 * 1000;
const heldByThisProcess = new Set();

function lockDirectory(explicit) {
    return explicit || process.env.SCRAPER_LOCK_DIR || DEFAULT_LOCK_DIR;
}

function lockFile(scraperKey, lockDir) {
    return path.join(lockDirectory(lockDir), `${scraperKey}.lock`);
}

function isPidAlive(pid) {
    const number = Number(pid);
    if (!Number.isInteger(number) || number <= 0) return false;
    if (number === process.pid) return true;
    try {
        process.kill(number, 0);
        return true;
    } catch (error) {
        return error.code === "EPERM";
    }
}

function readLock(file) {
    try {
        return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
        return null;
    }
}

function staleReason(info, now) {
    if (!info || typeof info !== "object") return "unreadable lock file";
    if (!isPidAlive(info.pid)) return `pid ${info.pid} is not running`;
    const started = Date.parse(info.startedAt);
    const limit = Number(info.staleAfterMs) || DEFAULT_STALE_MS;
    if (!Number.isFinite(started)) return "lock has no start time";
    const age = now - started;
    if (age > limit) return `lock is ${age}ms old, past ${limit}ms`;
    return "";
}

function acquireScraperLock(scraperKey, options = {}) {
    const dir = lockDirectory(options.lockDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = lockFile(scraperKey, dir);
    const budgetMs = options.budgetMs == null ? null : options.budgetMs;
    const staleAfterMs = budgetMs == null ? DEFAULT_STALE_MS : budgetMs + LOCK_GRACE_MS;
    const payload = {
        scraper: scraperKey,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        budgetMs,
        staleAfterMs,
        host: os.hostname()
    };

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const fd = fs.openSync(file, "wx");
            fs.writeFileSync(fd, JSON.stringify(payload, null, 2));
            fs.closeSync(fd);
            heldByThisProcess.add(file);
            return { acquired: true, file, ...payload };
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const info = readLock(file);
            const why = staleReason(info, Date.now());
            if (!why) return { acquired: false, file, holder: info };
            try {
                fs.unlinkSync(file);
            } catch (unlinkError) {
                if (unlinkError.code !== "ENOENT") throw unlinkError;
            }
        }
    }

    const holder = readLock(file);
    return { acquired: false, file, holder };
}

function releaseScraperLock(lock) {
    if (!lock || !lock.acquired || !lock.file) return;
    heldByThisProcess.delete(lock.file);
    try {
        const info = readLock(lock.file);
        if (!info || Number(info.pid) === process.pid) fs.unlinkSync(lock.file);
    } catch (error) {
        if (error.code !== "ENOENT") throw error;
    }
}

function formatSkipLine(scraperName, lock) {
    const holder = (lock && lock.holder) || {};
    const since = holder.startedAt || "unknown";
    const file = (lock && lock.file) || lockFile(scraperName);
    return `SKIPPED ${scraperName} => lock held by pid ${holder.pid} since ${since} (${file}). This scraper was not started. The existing ZIP and Supabase rows were left unchanged.`;
}

process.on("exit", () => {
    for (const file of heldByThisProcess) {
        try {
            const info = readLock(file);
            if (!info || Number(info.pid) === process.pid) fs.unlinkSync(file);
        } catch (error) {
            // The process is already leaving. A leftover file is stale on the next run.
        }
    }
});

module.exports = {
    DEFAULT_LOCK_DIR,
    LOCK_GRACE_MS,
    acquireScraperLock,
    releaseScraperLock,
    formatSkipLine,
    isPidAlive,
    staleReason,
    lockFile
};
