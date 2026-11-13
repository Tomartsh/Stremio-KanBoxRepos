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
    measureCatalog,
    formatCatalogComparison,
    countZipBuffer,
    decidePublish,
    formatRunResult,
    readLocalCatalogCounts,
    loadPreviousCatalog,
    recoverCatalogAfterBudget,
    shouldRecoverAfterBudget,
    seriesVideoDrops,
    restoreFailedFetches
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
    assert.equal(recovered.counts.series, 4);
    assert.equal(recovered.counts.videos, 5);

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

test("the publish gate compares series, videos, and uncompressed JSON, not the ZIP", () => {
    const previous = {
        series: 171,
        videos: 1568,
        jsonBytes: 2343800,
        described: 1568,
        perSeries: {
            keep: { name: "נשאר", videos: 10 },
            collapse: { name: "צימרים", videos: 26 },
            small: { name: "יום אחד", videos: 2 }
        }
    };
    const healthy = {
        series: 175,
        videos: 2337,
        jsonBytes: 2664461,
        described: 2200,
        zipBytes: 180077,
        perSeries: {
            keep: { name: "נשאר", videos: 12 },
            collapse: { name: "צימרים", videos: 30 },
            small: { name: "יום אחד", videos: 2 }
        }
    };
    const grown = decidePublish({
        scraperName: "KanArchive",
        exportFilename: "stremio-kanarchive",
        counts: healthy,
        previous,
        catalogComplete: true
    });
    assert.equal(grown.published, true);
    assert.match(formatCatalogComparison("KanArchive", healthy, previous), /uncompressed JSON 2664461B/);
    assert.equal(formatCatalogComparison("KanArchive", healthy, previous).includes("ZIP"), false);

    const wiped = decidePublish({
        scraperName: "KanArchive",
        exportFilename: "stremio-kanarchive",
        counts: {
            series: 175,
            videos: 2337,
            jsonBytes: 2664461,
            described: 4,
            perSeries: {
                keep: { name: "נשאר", videos: 12 },
                collapse: { name: "צימרים", videos: 1 },
                small: { name: "יום אחד", videos: 1 }
            }
        },
        previous,
        catalogComplete: true
    });
    assert.equal(wiped.published, false);
    assert.match(wiped.reason, /descriptions 4\/2337/);
    assert.match(wiped.reason, /צימרים 26->1/);
    assert.equal(wiped.reason.includes("ZIP"), false);
    assert.equal(wiped.seriesDrops.some((drop) => drop.name === "יום אחד" && drop.current === 1), true);

    const tinyJson = decidePublish({
        scraperName: "KanArchive",
        exportFilename: "stremio-kanarchive",
        counts: {
            series: 175,
            videos: 2337,
            jsonBytes: 1000,
            described: 2337,
            perSeries: {
                keep: { name: "נשאר", videos: 12 },
                collapse: { name: "צימרים", videos: 26 },
                small: { name: "יום אחד", videos: 2 }
            }
        },
        previous,
        catalogComplete: true
    });
    assert.equal(tinyJson.published, false);
    assert.match(tinyJson.reason, /uncompressed JSON 1000B/);
    assert.match(tinyJson.reason, /70%/);
    assert.equal(tinyJson.reason.includes("ZIP"), false);

    const fewerSeries = decidePublish({
        scraperName: "KanArchive",
        exportFilename: "stremio-kanarchive",
        counts: {
            series: 100,
            videos: 2000,
            jsonBytes: 3000000,
            described: 2000,
            perSeries: {}
        },
        previous,
        catalogComplete: true
    });
    assert.equal(fewerSeries.published, false);
    assert.match(fewerSeries.reason, /series count 100/);

    const oneRemoved = decidePublish({
        scraperName: "KanArchive",
        exportFilename: "stremio-kanarchive",
        counts: Object.assign({}, healthy, {
            perSeries: {
                keep: { name: "נשאר", videos: 12 },
                collapse: { name: "צימרים", videos: 30 },
                small: { name: "יום אחד", videos: 1 }
            }
        }),
        previous,
        catalogComplete: true
    });
    assert.equal(oneRemoved.published, true);
    assert.equal(oneRemoved.seriesDrops.length, 1);
    assert.equal(oneRemoved.seriesDrops[0].previous, 2);

    const measured = measureCatalog({
        data: {
            show: {
                id: "show",
                name: "א",
                meta: { videos: [{ id: "v", description: "יש" }, { id: "w", description: "" }] }
            }
        }
    });
    assert.equal(measured.series, 1);
    assert.equal(measured.videos, 2);
    assert.equal(measured.described, 1);
    assert.ok(measured.jsonBytes > 0);
});

test("an id shift is not a drop when the link or the name still matches", () => {
    const previous = {
        series: 4,
        videos: 89,
        jsonBytes: 500000,
        described: 89,
        perSeries: {
            il_kan_kids_1019: {
                name: "הגינה של תמרי",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/tamaris_garden/",
                videos: 20
            },
            il_kan_kids_1020: {
                name: "בלואי",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/bluey/",
                videos: 13
            },
            il_kan_kids_1021: {
                name: "פרפר נחמד",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/",
                videos: 30
            },
            il_kan_kids_1022: {
                name: "צ'רלי ולולה",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/charlie_and_lola/",
                videos: 26
            }
        }
    };
    const shifted = {
        series: 4,
        videos: 89,
        jsonBytes: 500000,
        described: 89,
        perSeries: {
            il_kan_kids_1000: {
                name: "הגינה של תמרי",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/tamaris_garden",
                videos: 20
            },
            il_kan_kids_1001: {
                name: "בלואי",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/bluey",
                videos: 13
            },
            il_kan_kids_1002: {
                name: "פרפר נחמד",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/",
                videos: 30
            },
            il_kan_kids_1003: {
                name: "צ'רלי ולולה",
                link: "https://www.kankids.org.il/content/kids/somewhere-else/charlie/",
                videos: 26
            }
        }
    };
    const kept = decidePublish({
        scraperName: "KanKids",
        exportFilename: "stremio-kankids",
        counts: shifted,
        previous,
        catalogComplete: true
    });
    assert.equal(kept.published, true);
    assert.equal(kept.seriesDrops.length, 0);

    const removed = decidePublish({
        scraperName: "KanKids",
        exportFilename: "stremio-kankids",
        counts: {
            series: 3,
            videos: 69,
            jsonBytes: 400000,
            described: 69,
            perSeries: {
                il_kan_kids_1001: shifted.perSeries.il_kan_kids_1001,
                il_kan_kids_1002: shifted.perSeries.il_kan_kids_1002,
                il_kan_kids_1003: shifted.perSeries.il_kan_kids_1003
            }
        },
        previous,
        catalogComplete: true
    });
    assert.equal(removed.published, false);
    assert.equal(removed.seriesDrops.length, 1);
    assert.equal(removed.seriesDrops[0].id, "il_kan_kids_1019");
    assert.equal(removed.seriesDrops[0].previous, 20);
    assert.equal(removed.seriesDrops[0].current, 0);
    assert.equal(removed.seriesDrops.some((drop) => drop.name === "בלואי"), false);

    const byNameOnly = seriesVideoDrops(
        { perSeries: { il_kan_kids_1020: { name: "בלואי", videos: 13 } } },
        { perSeries: { il_kan_kids_1001: { name: "בלואי", videos: 13 } } }
    );
    assert.equal(byNameOnly.length, 0);
});

test("a timed-out series keeps its previous episodes and a removed series does not", () => {
    const previous = {
        data: {
            il_kan_kids_1020: {
                id: "il_kan_kids_1020",
                name: "בלואי",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/bluey/",
                meta: { videos: [{ id: "old-1" }, { id: "old-2" }, { id: "old-3" }] }
            },
            il_kan_kids_1021: {
                id: "il_kan_kids_1021",
                name: "פרפר נחמד",
                link: "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/",
                meta: { videos: [{ id: "keep" }] }
            },
            il_kan_teens_1000: {
                id: "il_kan_teens_1000",
                name: "הסדרתיים",
                link: "https://www.kankids.org.il/content/kids/hinuchit-main/the_serials/",
                meta: { videos: [{ id: "gone" }] }
            }
        }
    };
    const scraped = {
        il_kan_kids_1021: {
            id: "il_kan_kids_1021",
            name: "פרפר נחמד",
            link: "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad",
            meta: { videos: [{ id: "new-1" }, { id: "new-2" }] }
        }
    };
    const restored = restoreFailedFetches(previous, scraped, {
        failedSeries: [{
            link: "https://www.kankids.org.il/content/kids/ktantanim-main/bluey",
            name: "בלואי"
        }]
    });
    assert.equal(restored.restored, 1);
    assert.equal(restored.data.il_kan_kids_1020.meta.videos.length, 3);
    assert.equal(restored.data.il_kan_kids_1021.meta.videos.length, 2);
    assert.equal(restored.data.il_kan_teens_1000, undefined);

    const listing = restoreFailedFetches(previous, scraped, { listingIncomplete: true });
    assert.equal(listing.data.il_kan_kids_1020.meta.videos.length, 3);
    assert.equal(listing.data.il_kan_teens_1000.meta.videos.length, 1);
    assert.equal(listing.data.il_kan_kids_1021.name, "פרפר נחמד");
    assert.equal(listing.data.il_kan_kids_1021.meta.videos[0].id, "new-1");
});

test("a reshet id change is compared by link, and a shifted id is not a different show's videos", () => {
    const previous = {
        series: 2,
        videos: 720,
        jsonBytes: 1000000,
        described: 720,
        perSeries: {
            il_reshet_254: {
                name: 'שיחות מהממ"ד',
                link: "https://13tv.co.il/all-shows/mamad-talk",
                videos: 0
            },
            il_reshet_255: {
                name: "שיחת היום עם לוסי אהריש",
                link: "https://13tv.co.il/all-shows/todays-talk",
                videos: 720
            }
        }
    };
    const slugIds = {
        series: 2,
        videos: 720,
        jsonBytes: 1000000,
        described: 720,
        perSeries: {
            il_reshet_mamad_talk: {
                name: 'שיחות מהממ"ד',
                link: "https://13tv.co.il/all-shows/mamad-talk",
                videos: 0
            },
            il_reshet_todays_talk: {
                name: "שיחת היום עם לוסי אהריש",
                link: "https://13tv.co.il/all-shows/todays-talk/",
                videos: 720
            }
        }
    };
    const kept = decidePublish({
        scraperName: "Reshet",
        exportFilename: "stremio-reshet",
        counts: slugIds,
        previous,
        catalogComplete: true
    });
    assert.equal(kept.published, true);
    assert.equal(kept.seriesDrops.length, 0);

    const shifted = decidePublish({
        scraperName: "Reshet",
        exportFilename: "stremio-reshet",
        counts: {
            series: 2,
            videos: 720,
            jsonBytes: 1000000,
            described: 720,
            perSeries: {
                il_reshet_255: {
                    name: 'שיחות מהממ"ד',
                    link: "https://13tv.co.il/all-shows/mamad-talk",
                    videos: 0
                },
                il_reshet_256: {
                    name: "שיחת היום עם לוסי אהריש",
                    link: "https://13tv.co.il/all-shows/todays-talk",
                    videos: 720
                }
            }
        },
        previous,
        catalogComplete: true
    });
    assert.equal(shifted.published, true);
    assert.equal(shifted.seriesDrops.some((drop) => drop.previous === 720 && drop.current === 0), false);

    const lost = decidePublish({
        scraperName: "Reshet",
        exportFilename: "stremio-reshet",
        counts: {
            series: 1,
            videos: 0,
            jsonBytes: 1000000,
            described: 0,
            perSeries: {
                il_reshet_255: {
                    name: 'שיחות מהממ"ד',
                    link: "https://13tv.co.il/all-shows/mamad-talk",
                    videos: 0
                }
            }
        },
        previous,
        catalogComplete: true
    });
    assert.equal(lost.published, false);
    assert.equal(lost.seriesDrops.length, 1);
    assert.equal(lost.seriesDrops[0].name, "שיחת היום עם לוסי אהריש");
    assert.equal(lost.seriesDrops[0].previous, 720);
    assert.equal(lost.seriesDrops[0].current, 0);
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
