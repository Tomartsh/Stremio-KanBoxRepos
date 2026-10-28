const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const AdmZip = require("adm-zip");
const { KanBrowserError } = require("../classes/kanSession");
const { URL_JSON_BASE } = require("../classes/constants");
const {
    catalogIsComplete,
    countCatalog,
    countZipBuffer,
    decidePublish,
    formatRunResult,
    readLocalCatalogCounts,
    loadPreviousCatalog,
    recoverCatalogAfterBudget,
    shouldRecoverAfterBudget
} = require("../classes/catalogGate");

const PREVIOUS = { series: 40, videos: 2168 };

test("published catalogs count series and videos inside data", () => {
    const counts = countCatalog({
        timestamp: "2026-10-05T00:00:00.000Z",
        data: {
            il_kan_archive_1: { id: "il_kan_archive_1", name: "א", meta: { videos: [{ id: "a" }, { id: "b" }] } },
            il_kan_archive_2: { id: "il_kan_archive_2", name: "ב", meta: { videos: [{ id: "c" }] } }
        }
    });
    assert.deepEqual(counts, { series: 2, videos: 3 });
});

test("a zip baseline counts the catalog and then can be dropped", () => {
    const zip = new AdmZip();
    zip.addFile("stremio-kanarchive.json", Buffer.from(JSON.stringify({
        timestamp: "2026-10-05T00:00:00.000Z",
        data: {
            show: { id: "show", name: "א", meta: { videos: new Array(2168).fill({ id: "v" }) } }
        }
    })));
    assert.deepEqual(countZipBuffer(zip.toBuffer()), { series: 1, videos: 2168 });
});

test("the Oct 12 archive drop fails the video gate while a series increase would pass a series gate", () => {
    const decision = decidePublish({
        scraperName: "KanArchive",
        exportFilename: "stremio-kanarchive",
        counts: { series: 45, videos: 1568 },
        previous: PREVIOUS,
        catalogComplete: true
    });
    assert.equal(decision.published, false);
    assert.equal(decision.blocked, false);
    assert.match(decision.line, /1568/);
    assert.match(decision.line, /72\.3%/);
    assert.match(decision.line, /85%/);
    assert.match(decision.reason, /previous 2168/);
});

test("a time budget exhaustion refuses publish even when the video count held", () => {
    const error = new Error("time budget exhausted during 403 backoff, then resume this page: need 1h 30m, 12m left");
    error.code = "BUDGET";
    const decision = decidePublish({
        scraperName: "KanDigital",
        exportFilename: "stremio-kandigital",
        scrapeError: error,
        counts: { series: 40, videos: 2168 },
        previous: PREVIOUS,
        catalogComplete: true
    });
    assert.equal(decision.published, false);
    assert.equal(decision.blocked, false);
    assert.equal(decision.status, "BUDGET");
    assert.match(decision.line, /time budget exhausted/);
    assert.match(decision.line, /left unchanged/);
    assert.doesNotMatch(decision.line, /^BLOCKED /);
});

test("85% of the previous video count is enough to publish", () => {
    const allowed = decidePublish({
        scraperName: "KanArchive",
        exportFilename: "stremio-kanarchive",
        counts: { series: 40, videos: 1843 },
        previous: PREVIOUS,
        catalogComplete: true
    });
    const refused = decidePublish({
        scraperName: "KanArchive",
        exportFilename: "stremio-kanarchive",
        counts: { series: 40, videos: 1842 },
        previous: PREVIOUS,
        catalogComplete: true
    });
    assert.equal(allowed.published, true);
    assert.equal(refused.published, false);
});

test("any terminal 403 refuses publish even when the video count held", () => {
    const decision = decidePublish({
        scraperName: "KanDigital",
        exportFilename: "stremio-kandigital",
        counts: { series: 40, videos: 2168 },
        previous: PREVIOUS,
        http403: 1,
        catalogComplete: true
    });
    assert.equal(decision.blocked, true);
    assert.equal(decision.status, "BLOCKED");
    assert.match(decision.line, /^BLOCKED KanDigital/);
    const formatted = formatRunResult("kanDigital", decision);
    assert.equal(formatted.level, "error");
    assert.match(formatted.message, /^BLOCKED /);
});

test("a missing browser is refused without being called a Cloudflare block", () => {
    const decision = decidePublish({
        scraperName: "KanDigital",
        exportFilename: "stremio-kandigital",
        scrapeError: new KanBrowserError("KAN BROWSER UNAVAILABLE for https://www.kan.org.il/lobby/kan-box/: Executable doesn't exist"),
        counts: { series: 0, videos: 0 },
        catalogComplete: true
    });
    assert.equal(decision.published, false);
    assert.equal(decision.blocked, false);
    assert.equal(decision.status, "BROWSER");
    assert.match(decision.line, /KAN BROWSER UNAVAILABLE/);
    assert.doesNotMatch(decision.line, /^BLOCKED /);
});

test("an incremental delta with few series is not treated as a wiped catalog", () => {
    const decision = decidePublish({
        scraperName: "Kan88",
        exportFilename: "stremio-kan88",
        counts: { series: 3, videos: 12 },
        previous: { series: 80, videos: 2000 },
        catalogComplete: false
    });
    assert.equal(decision.published, true);
});

test("an incremental run that kept the series list still fails a video drop", () => {
    const decision = decidePublish({
        scraperName: "Kan88",
        exportFilename: "stremio-kan88",
        counts: { series: 70, videos: 1000 },
        previous: { series: 80, videos: 2000 },
        catalogComplete: false
    });
    assert.equal(decision.published, false);
    assert.match(decision.line, /85%/);
});

test("Kan archive stays a full catalog in incremental mode; Kan 88 does not", () => {
    assert.equal(catalogIsComplete("KanArchive", true), true);
    assert.equal(catalogIsComplete("KanDigital", true), true);
    assert.equal(catalogIsComplete("Kan88", true), false);
    assert.equal(catalogIsComplete("Kan88", false), true);
    assert.equal(catalogIsComplete("KanPodcasts", true), false);
});

test("a missing baseline does not block a non-empty catalog", () => {
    const decision = decidePublish({
        scraperName: "KanDigital",
        exportFilename: "stremio-kandigital",
        counts: { series: 10, videos: 20 },
        previous: null,
        catalogComplete: true
    });
    assert.equal(decision.published, true);
});

test("the remote baseline is the committed output folder, not GitHub Pages", () => {
    assert.match(URL_JSON_BASE, /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/output\/$/);
    assert.equal(URL_JSON_BASE.includes("github.io"), false);
});

test("a budget stop merges finished series and keeps series this run did not reach", () => {
    const previous = {
        data: {
            kept: { id: "kept", name: "ישן", meta: { videos: [{ id: "k1" }, { id: "k2" }] } },
            replaced: { id: "replaced", name: "ישן", meta: { videos: [{ id: "r1" }, { id: "r2" }, { id: "r3" }] } },
            empty: { id: "empty", name: "ישן", meta: { videos: [{ id: "e1" }] } }
        }
    };
    const scraped = {
        replaced: { id: "replaced", name: "חדש", meta: { videos: [{ id: "n1" }] } },
        empty: { id: "empty", name: "ריק", meta: { videos: [] } },
        fresh: { id: "fresh", name: "חדש", meta: { videos: [{ id: "f1" }] } }
    };
    const recovered = recoverCatalogAfterBudget(previous, scraped);
    assert.equal(recovered.data.kept.meta.videos.length, 2);
    assert.equal(recovered.data.replaced.name, "חדש");
    assert.equal(recovered.data.replaced.meta.videos.length, 1);
    assert.equal(recovered.data.empty.name, "ישן");
    assert.equal(recovered.data.empty.meta.videos.length, 1);
    assert.equal(recovered.data.fresh.meta.videos.length, 1);
    assert.deepEqual(recovered.counts, { series: 4, videos: 5 });

    const tooSmall = decidePublish({
        scraperName: "KanDigital",
        exportFilename: "stremio-kandigital",
        counts: recovered.counts,
        previous: countCatalog(previous),
        catalogComplete: true
    });
    assert.equal(tooSmall.published, false);
    assert.match(tooSmall.line, /85%/);

    assert.equal(recoverCatalogAfterBudget(null, scraped), null);
    assert.equal(recoverCatalogAfterBudget({ data: {} }, scraped), null);
});

test("a blocked run is not a candidate for merging a partial catalog", () => {
    const budget = new Error("time budget exhausted");
    budget.code = "BUDGET";
    assert.equal(shouldRecoverAfterBudget({ scrapeError: budget, blocked: false, http403: 0 }), true);
    assert.equal(shouldRecoverAfterBudget({ scrapeError: budget, blocked: true, http403: 0 }), false);
    assert.equal(shouldRecoverAfterBudget({ scrapeError: budget, blocked: false, http403: 1 }), false);
    assert.equal(shouldRecoverAfterBudget({ scrapeError: new Error("nope"), blocked: false }), false);
});

test("a local previous catalog is read without the network", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kan-catalog-"));
    const zip = new AdmZip();
    zip.addFile("stremio-kandigital.json", Buffer.from(JSON.stringify({
        timestamp: "2026-10-25T00:00:00.000Z",
        data: {
            show: { id: "show", name: "א", meta: { videos: [{ id: "v", episodeLink: "https://example/1/" }] } }
        }
    })));
    zip.writeZip(path.join(dir, "stremio-kandigital.zip"));
    const loaded = await loadPreviousCatalog("stremio-kandigital", {
        outputDir: dir,
        remote: false,
        logger: { warn() {}, info() {} }
    });
    assert.equal(loaded.data.show.meta.videos.length, 1);
    assert.equal(await loadPreviousCatalog("missing", { outputDir: dir, remote: false }), null);
});

test("local zip counts are read from the output directory", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kan-gate-"));
    const zip = new AdmZip();
    zip.addFile("stremio-kanarchive.json", Buffer.from(JSON.stringify({
        data: { show: { id: "show", meta: { videos: [{ id: "v" }, { id: "w" }] } } }
    })));
    zip.writeZip(path.join(dir, "stremio-kanarchive.zip"));
    assert.deepEqual(readLocalCatalogCounts("stremio-kanarchive", dir), { series: 1, videos: 2 });
    assert.equal(readLocalCatalogCounts("missing", dir), null);
});
