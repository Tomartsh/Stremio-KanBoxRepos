const test = require("node:test");
const assert = require("node:assert/strict");
const {
    PACING_SCRAPERS,
    getPacingFile,
    resolvePacing,
    validatePacingFile,
    formatPacing,
    parseCommandLine,
    pacingOverridesFromQuery
} = require("../classes/pacing");

const HOUR = 60 * 60 * 1000;

test("the pacing file has a defaults section and every scraper", () => {
    const file = getPacingFile();
    assert.equal(file.defaults.slow, false);
    assert.equal(file.defaults.minIntervalMs, 2000);
    assert.deepEqual([file.defaults.requestDelayMinMs, file.defaults.requestDelayMaxMs], [1000, 4000]);
    assert.equal(file.defaults.maxRetries, 1);
    for (const name of PACING_SCRAPERS) {
        assert.equal(typeof file.scrapers[name], "object");
    }
});

test("kanDigital slow mode is the 20 hour profile", () => {
    const pacing = resolvePacing("kanDigital", {}, {});
    assert.equal(pacing.slow, true);
    assert.equal(pacing.minIntervalMs, 0);
    assert.equal(pacing.requestDelayMinMs, 45000);
    assert.equal(pacing.requestDelayMaxMs, 90000);
    assert.equal(pacing.pauseEveryPages, 40);
    assert.equal(pacing.pauseMinMs, 10 * 60 * 1000);
    assert.equal(pacing.pauseMaxMs, 20 * 60 * 1000);
    assert.equal(pacing.blockBackoffMinMs, 60 * 60 * 1000);
    assert.equal(pacing.blockBackoffMaxMs, 90 * 60 * 1000);
    assert.equal(pacing.budgetMs, 20 * HOUR);
    assert.equal(pacing.maxRetries, null);
    const line = formatPacing(pacing);
    assert.match(line, /slow=true/);
    assert.match(line, /requestDelay=45s-1m 30s/);
    assert.match(line, /pauseEvery=40 pages/);
    assert.match(line, /pause=10m-20m/);
    assert.match(line, /blockBackoff=1h-1h 30m/);
    assert.match(line, /budget=20h/);
    assert.match(line, /maxRetries=unlimited/);
});

test("other kan.org.il scrapers stay on the fast defaults until opted in", () => {
    for (const name of ["kanTeens", "kan88", "kanArchive", "kanPodcasts"]) {
        const pacing = resolvePacing(name, {}, {});
        assert.equal(pacing.slow, false, name);
        assert.equal(pacing.minIntervalMs, 2000, name);
        assert.equal(pacing.requestDelayMinMs, 1000, name);
        assert.equal(pacing.budgetMs, null, name);
        assert.equal(pacing.maxRetries, 1, name);
    }
});

test("--slow copies kanDigital timings; --no-slow returns to the fast defaults", () => {
    const opted = resolvePacing("kan88", { slow: true }, {});
    assert.equal(opted.slow, true);
    assert.equal(opted.requestDelayMinMs, 45000);
    assert.equal(opted.pauseEveryPages, 40);
    assert.equal(opted.budgetMs, 20 * HOUR);
    assert.equal(opted.maxRetries, null);

    const off = resolvePacing("kanDigital", { slow: false }, {});
    assert.equal(off.slow, false);
    assert.equal(off.minIntervalMs, 2000);
    assert.equal(off.requestDelayMinMs, 1000);
    assert.equal(off.requestDelayMaxMs, 4000);
    assert.equal(off.pauseEveryPages, 0);
    assert.equal(off.blockBackoffMinMs, 8000);
    assert.equal(off.budgetMs, null);
    assert.equal(off.maxRetries, 1);
});

test("env and CLI numeric overrides win, and KAN_SLOW=0 restores the fast pace", () => {
    const fromEnv = resolvePacing("kanDigital", {}, { KAN_BUDGET_HOURS: "18", KAN_PAUSE_EVERY_PAGES: "10" });
    assert.equal(fromEnv.slow, true);
    assert.equal(fromEnv.budgetMs, 18 * HOUR);
    assert.equal(fromEnv.pauseEveryPages, 10);
    assert.equal(fromEnv.requestDelayMinMs, 45000);

    const disabled = resolvePacing("kanDigital", {}, { KAN_SLOW: "0", KAN_BUDGET_HOURS: "2" });
    assert.equal(disabled.slow, false);
    assert.equal(disabled.requestDelayMinMs, 1000);
    assert.equal(disabled.budgetMs, 2 * HOUR);

    const cli = resolvePacing("kanTeens", { slow: true, budgetHours: "6", maxRetries: "4" }, { KAN_BUDGET_HOURS: "18" });
    assert.equal(cli.slow, true);
    assert.equal(cli.budgetMs, 6 * HOUR);
    assert.equal(cli.maxRetries, 4);
    assert.equal(cli.requestDelayMaxMs, 90000);
});

test("CLI and query strings parse the same knobs", () => {
    const parsed = parseCommandLine([
        "kanDigital",
        "--slow",
        "--budget-hours",
        "20",
        "--request-delay-min-ms",
        "45000",
        "--max-retries",
        "unlimited",
        "--mode",
        "full"
    ]);
    assert.equal(parsed.scraper, "kanDigital");
    assert.equal(parsed.mode, "full");
    assert.equal(parsed.overrides.slow, true);
    assert.equal(parsed.overrides.budgetHours, "20");
    assert.equal(parsed.overrides.maxRetries, "unlimited");

    const fromQuery = pacingOverridesFromQuery({
        scraper: "kanDigital",
        slow: "1",
        budgetHours: "20",
        pauseEveryPages: "40"
    });
    assert.equal(fromQuery.slow, "1");
    assert.equal(fromQuery.budgetHours, "20");
    assert.equal(fromQuery.pauseEveryPages, "40");
    assert.equal(fromQuery.scraper, undefined);
});

test("startup validation rejects a broken pacing file", () => {
    const file = structuredClone(getPacingFile());
    file.scrapers.kan88.typoMs = 1;
    assert.throws(() => validatePacingFile(file), /unknown field "typoMs"/);

    const backwards = structuredClone(getPacingFile());
    backwards.defaults.requestDelayMinMs = 9000;
    backwards.defaults.requestDelayMaxMs = 1000;
    assert.throws(() => validatePacingFile(backwards), /requestDelayMinMs/);

    const missing = structuredClone(getPacingFile());
    delete missing.scrapers.reshet;
    assert.throws(() => validatePacingFile(missing), /reshet/);

    const endless = structuredClone(getPacingFile());
    endless.scrapers.kanDigital.budgetMs = null;
    endless.scrapers.kanDigital.maxRetries = null;
    assert.throws(() => validatePacingFile(endless), /never ends/);
});
