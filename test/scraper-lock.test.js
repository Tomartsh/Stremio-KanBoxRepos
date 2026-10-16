const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const BaseScraper = require("../classes/BaseScraper");
const { formatRunResult } = require("../classes/catalogGate");
const {
    acquireScraperLock,
    releaseScraperLock
} = require("../classes/scraperLock");

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), "kan-lock-"));
}

test("a held lock blocks a second acquire until it is released", () => {
    const dir = tempDir();
    const first = acquireScraperLock("kanDigital", { lockDir: dir, budgetMs: 20 * 60 * 60 * 1000 });
    try {
        assert.equal(first.acquired, true);
        assert.equal(first.staleAfterMs, 22 * 60 * 60 * 1000);
        const second = acquireScraperLock("kanDigital", { lockDir: dir, budgetMs: 20 * 60 * 60 * 1000 });
        assert.equal(second.acquired, false);
        assert.equal(second.holder.pid, process.pid);
        assert.match(second.file, /kanDigital\.lock$/);
    } finally {
        releaseScraperLock(first);
    }
    const third = acquireScraperLock("kanDigital", { lockDir: dir, budgetMs: 1000 });
    assert.equal(third.acquired, true);
    releaseScraperLock(third);
    assert.equal(fs.existsSync(third.file), false);
});

test("a dead pid and an expired lock are both stale", () => {
    const dir = tempDir();
    const dead = path.join(dir, "kan88.lock");
    fs.writeFileSync(dead, JSON.stringify({
        scraper: "kan88",
        pid: 2147483646,
        startedAt: new Date().toISOString(),
        staleAfterMs: 26 * 60 * 60 * 1000
    }));
    const taken = acquireScraperLock("kan88", { lockDir: dir });
    assert.equal(taken.acquired, true);
    assert.equal(taken.pid, process.pid);
    releaseScraperLock(taken);

    const expired = path.join(dir, "kanDigital.lock");
    fs.writeFileSync(expired, JSON.stringify({
        scraper: "kanDigital",
        pid: process.pid,
        startedAt: new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString(),
        staleAfterMs: 60 * 1000
    }));
    const replaced = acquireScraperLock("kanDigital", { lockDir: dir, budgetMs: 1000 });
    assert.equal(replaced.acquired, true);
    releaseScraperLock(replaced);
});

class LockProbe extends BaseScraper {
    constructor() {
        super("KanDigital", { exportFilename: "stremio-kandigital", databaseKey: "kandigital" });
        this.calls = 0;
        this.published = false;
    }

    async crawlContent() {
        this.calls += 1;
        this.addToJsonObject("id1", "סדרה", "https://www.kan.org.il/show", "", "", [], [{ id: "v" }], "d", "series");
    }

    writeJSON() {
        this.published = true;
    }

    async updateDatabase() {
        this.published = true;
    }
}

test("the nightly crawl skips a scraper whose lock is held and does not publish", async () => {
    const dir = tempDir();
    const held = acquireScraperLock("kanDigital", { lockDir: dir, budgetMs: 20 * 60 * 60 * 1000 });
    try {
        const scraper = new LockProbe();
        scraper.lockDir = dir;
        scraper.previousCountsOverride = { series: 10, videos: 10 };
        const outcome = await scraper.crawl(true, "full");
        assert.equal(scraper.calls, 0);
        assert.equal(scraper.published, false);
        assert.equal(outcome.skipped, true);
        assert.equal(outcome.published, false);
        assert.match(outcome.line, /^SKIPPED /);
        assert.match(outcome.line, /pid/);
        assert.match(outcome.line, /left unchanged/);
        const formatted = formatRunResult("kanDigital", outcome);
        assert.equal(formatted.level, "warn");
        assert.match(formatted.message, /^SKIPPED /);
    } finally {
        releaseScraperLock(held);
    }
});

test("a stale lock does not keep the nightly crawl from starting", async () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "kanDigital.lock"), JSON.stringify({
        scraper: "kanDigital",
        pid: 2147483646,
        startedAt: new Date().toISOString(),
        staleAfterMs: 22 * 60 * 60 * 1000
    }));
    const scraper = new LockProbe();
    scraper.lockDir = dir;
    scraper.previousCountsOverride = { series: 1, videos: 1 };
    const outcome = await scraper.crawl(true, "full");
    assert.equal(scraper.calls, 1);
    assert.equal(outcome.skipped, undefined);
    assert.equal(outcome.published, true);
    assert.equal(scraper.published, true);
    assert.equal(fs.existsSync(path.join(dir, "kanDigital.lock")), false);
});
