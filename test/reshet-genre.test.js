const { describe, test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ReshetScraper = require("../classes/ReshetScraper");
const {
    parseReshetGenreXml,
    genresFromKalturaResponse,
    rankSeriesGenres
} = ReshetScraper;
const { RESHET } = require("../classes/constants");
const utils = require("../classes/utilities");

const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures/reshet/kaltura-multirequest.json"),
    "utf8"
));

const DRAMA_URL = "https://cdnapisec.kaltura.com/p/2748741/sp/274874100/playManifest/entryId/1_drama/protocol/https/format/applehttp/a.m3u8";
const PIPE_URL = "https://cdnapisec.kaltura.com/p/2748741/sp/274874100/playManifest/entryId/1_pipe/protocol/https/format/applehttp/a.m3u8";
const COMEDY_URL = "https://cdnapisec.kaltura.com/p/2748741/sp/274874100/playManifest/entryId/1_comedy/protocol/https/format/applehttp/a.m3u8";
const NONE_URL = "https://cdnapisec.kaltura.com/p/2748741/sp/274874100/playManifest/entryId/1_none/protocol/https/format/applehttp/a.m3u8";
const REUSED_URL = "https://cdnapisec.kaltura.com/p/2748741/sp/274874100/playManifest/entryId/1_published/protocol/https/format/applehttp/a.m3u8";

function seriesPage(episodes) {
    return {
        pageProps: {
            page: {
                Content: {
                    PageGrid: [
                        {
                            grid_type: "VodPlaylist",
                            episodesSeasonsMap: {
                                "1": {
                                    name: "עונה 1",
                                    episodes: episodes
                                }
                            }
                        }
                    ]
                }
            }
        }
    };
}

function episode(id, kalturaId, title) {
    return {
        id: id,
        title: title,
        secondaryTitle: "תיאור",
        air_date: "",
        link: "/episode/" + id,
        video: {
            kalturaId: kalturaId,
            poster: ""
        }
    };
}

function scraperWith(fetchData) {
    const scraper = new ReshetScraper();
    scraper._buildId = "buildtest";
    scraper.tmdbHelper.searchTMDBSeries = async () => null;
    scraper.previousCatalogRemote = false;
    const original = utils.fetchData;
    utils.fetchData = fetchData;
    return {
        scraper: scraper,
        restore: () => {
            utils.fetchData = original;
        }
    };
}

test("kaltura metadata xml yields genres, including pipe-separated labels", () => {
    assert.deepEqual(genresFromKalturaResponse(fixture.drama), ["דרמה"]);
    assert.deepEqual(genresFromKalturaResponse(fixture.comedy), ["קומדיה"]);
    assert.deepEqual(genresFromKalturaResponse(fixture.pipeSeparated), ["ריאליטי", "בידור"]);
    assert.deepEqual(genresFromKalturaResponse(fixture.blankTokens), ["דרמה", "קומדיה"]);
    assert.deepEqual(genresFromKalturaResponse(fixture.multiline), ["דוקו-ריאליטי"]);
    assert.equal(fixture.noGenre[3].objects[0].xml.includes("ללא ז'אנר"), true);
    assert.equal(fixture.noGenreGeresh[3].objects[0].xml.includes("\u05F3"), true);
    assert.deepEqual(genresFromKalturaResponse(fixture.noGenre), []);
    assert.deepEqual(genresFromKalturaResponse(fixture.noGenreGeresh), []);
    assert.deepEqual(genresFromKalturaResponse(fixture.missingMetadata), []);
    assert.deepEqual(genresFromKalturaResponse(fixture.sourcesMissing), ["בידור"]);
    assert.deepEqual(genresFromKalturaResponse(undefined), []);
    assert.deepEqual(genresFromKalturaResponse({}), []);
    assert.deepEqual(parseReshetGenreXml(""), []);
    assert.deepEqual(parseReshetGenreXml(null), []);
    assert.deepEqual(rankSeriesGenres([
        ["דרמה"],
        ["דרמה"],
        ["קומדיה"],
        ["ריאליטי", "בידור"],
        ["ללא ז'אנר"],
        []
    ]), ["דרמה", "קומדיה", "ריאליטי", "בידור"]);
    assert.deepEqual(rankSeriesGenres([
        ["בידור", "דרמה"],
        ["דרמה", "בידור"]
    ]), ["בידור", "דרמה"]);
});

describe("reshet genre scraping", { concurrency: false }, () => {
    test("getStream keeps the applehttp url and returns genres from the same response", async () => {
        const calls = [];
        const wrapped = scraperWith(async (url, asJson, params, headers) => {
            calls.push({ url: url, asJson: asJson, params: params, headers: headers });
            assert.equal(url, RESHET.URL_STREAM);
            return fixture.pipeSeparated;
        });
        try {
            const result = await wrapped.scraper.getStream("1_pipe", "פרק הצינור");
            assert.equal(calls.length, 1);
            assert.equal(calls[0].asJson, true);
            assert.equal(calls[0].headers, RESHET.HEADERS);
            assert.equal(calls[0].params.partnerId, RESHET.PARTNER_ID);
            assert.equal(calls[0].params["3"].action, "getPlaybackContext");
            assert.equal(calls[0].params["4"].service, "metadata_metadata");
            assert.equal(calls[0].params["4"].action, "list");
            assert.equal(calls[0].params["4"].filter.objectIdEqual, "1_pipe");
            assert.deepEqual(result.genres, ["ריאליטי", "בידור"]);
            assert.deepEqual(result.streams, [{ url: PIPE_URL, name: "פרק הצינור" }]);
            assert.deepEqual(Object.keys(result.streams[0]).sort(), ["name", "url"]);
        } finally {
            wrapped.restore();
        }
    });

    test("getStream fails soft when the metadata or the response is missing", async () => {
        const wrapped = scraperWith(async () => fixture.missingMetadata);
        try {
            const missing = await wrapped.scraper.getStream("1_missing", "בלי ז'אנר");
            assert.deepEqual(missing.genres, []);
            assert.equal(missing.streams.length, 1);
            assert.equal(missing.streams[0].url.includes("1_missing"), true);
        } finally {
            wrapped.restore();
        }

        const noSources = scraperWith(async () => fixture.sourcesMissing);
        try {
            const empty = await noSources.scraper.getStream("1_nosrc", "בלי מקור");
            assert.deepEqual(empty, { streams: [], genres: ["בידור"] });
        } finally {
            noSources.restore();
        }

        const absent = scraperWith(async () => undefined);
        try {
            const none = await absent.scraper.getStream("1_absent", "אין");
            assert.deepEqual(none, { streams: [], genres: [] });
        } finally {
            absent.restore();
        }
    });

    test("a series stores the most common genres on meta.genres", async () => {
        const episodes = [
            episode(1, "1_d1", "דרמה 1"),
            episode(2, "1_d2", "דרמה 2"),
            episode(3, "1_d3", "דרמה 3"),
            episode(4, "1_c1", "קומדיה 1"),
            episode(5, "1_c2", "קומדיה 2"),
            episode(6, "1_p", "ריאליטי"),
            episode(7, "1_n", "בלי ז'אנר")
        ];
        const byId = {
            "1_d1": fixture.drama,
            "1_d2": fixture.drama,
            "1_d3": fixture.drama,
            "1_c1": fixture.comedy,
            "1_c2": fixture.comedy,
            "1_p": fixture.pipeSeparated,
            "1_n": fixture.noGenre
        };
        const urls = [];
        const wrapped = scraperWith(async (url, asJson, params) => {
            urls.push(url);
            if (url === RESHET.URL_STREAM) {
                const kalturaId = params["4"].filter.objectIdEqual;
                return byId[kalturaId];
            }
            return seriesPage(episodes);
        });
        try {
            const added = await wrapped.scraper.processOneReshetSeries({
                url: "/all-shows/genre-show/",
                title: "סדרה לדוגמה",
                poster: "https://img.example/poster.jpg",
                id: 255
            });
            assert.equal(added.id, "il_reshet_genre_show");
            const row = wrapped.scraper.getJsonObject().il_reshet_genre_show;
            assert.equal(row.subtype, "r");
            assert.equal(row.type, "series");
            assert.equal(row.meta.description, "");
            assert.deepEqual(row.meta.genres, ["דרמה", "קומדיה", "ריאליטי", "בידור"]);
            assert.equal(row.meta.videos.length, 7);
            assert.equal(row.meta.videos[0].id, "il_reshet_genre_show:1:1");
            assert.equal(row.meta.videos[0].episode, 1);
            assert.deepEqual(row.meta.videos[0].streams, [{ url: DRAMA_URL, name: "דרמה 1" }]);
            assert.deepEqual(row.meta.videos[3].streams, [{ url: COMEDY_URL, name: "קומדיה 1" }]);
            assert.deepEqual(row.meta.videos[5].streams, [{ url: PIPE_URL, name: "ריאליטי" }]);
            assert.deepEqual(row.meta.videos[6].streams, [{ url: NONE_URL, name: "בלי ז'אנר" }]);
            assert.equal(Object.prototype.hasOwnProperty.call(row.meta.videos[0], "genres"), false);
            assert.equal(JSON.stringify(row.meta.videos).includes("\"genres\""), false);
            const seriesCalls = urls.filter((url) => url.includes("13tv.co.il"));
            const kalturaCalls = urls.filter((url) => url === RESHET.URL_STREAM);
            assert.equal(seriesCalls.length, 1);
            assert.equal(kalturaCalls.length, episodes.length);
            assert.equal(urls.length, seriesCalls.length + kalturaCalls.length);
        } finally {
            wrapped.restore();
        }
    });

    test("a reused stream keeps the published genres and a fresh empty read does not", async () => {
        const seriesId = "il_reshet_todays_talk";
        const show = {
            url: "/all-shows/todays-talk/",
            title: "שיחת היום",
            poster: "https://img.example/poster.jpg",
            id: 255
        };

        const reusedRow = await runWithStreams(show, seriesId, ["ריאליטי", "בידור", "ללא ז'אנר", ""], async () => ({
            streams: [{ url: REUSED_URL, name: "פרק" }],
            genres: ["דרמה"],
            streamReused: true
        }), [
            episode(1, "1_old", "פרק 1"),
            episode(2, "1_old_b", "פרק 2")
        ]);
        assert.deepEqual(reusedRow.meta.genres, ["ריאליטי", "בידור"]);
        assert.equal(reusedRow.meta.videos.length, 2);
        assert.equal(reusedRow.meta.videos[0].streams[0].url, REUSED_URL);
        assert.equal(reusedRow.meta.videos[0].id, "il_reshet_todays_talk:1:1");

        const reusedEmpty = await runWithStreams(show, seriesId, "", async () => ({
            streams: [{ url: REUSED_URL, name: "פרק" }],
            streamReused: true
        }), [episode(1, "1_old", "פרק 1")]);
        assert.deepEqual(reusedEmpty.meta.genres, []);

        const unmatched = await runWithStreams({
            url: "/all-shows/not-published/",
            title: "חדש",
            poster: "",
            id: 9
        }, seriesId, ["דרמה"], async () => ({
            streams: [{ url: REUSED_URL, name: "פרק" }],
            streamReused: true
        }), [episode(1, "1_old", "פרק 1")]);
        assert.deepEqual(unmatched.meta.genres, []);

        const freshEmpty = await runWithStreams(show, seriesId, ["דרמה"], async () => ({
            streams: [{ url: NONE_URL, name: "פרק" }],
            genres: []
        }), [episode(1, "1_none", "פרק 1")]);
        assert.deepEqual(freshEmpty.meta.genres, []);

        const freshWins = await runWithStreams(show, seriesId, ["ריאליטי", "בידור"], async (kalturaId) => {
            if (kalturaId === "1_old") {
                return {
                    streams: [{ url: REUSED_URL, name: "ישן" }],
                    streamReused: true
                };
            }
            return {
                streams: [{ url: COMEDY_URL, name: "חדש" }],
                genres: ["קומדיה"]
            };
        }, [
            episode(1, "1_old", "ישן"),
            episode(2, "1_c1", "חדש"),
            episode(3, "1_c2", "חדש 2")
        ]);
        assert.deepEqual(freshWins.meta.genres, ["קומדיה"]);
        assert.equal(freshWins.meta.videos[0].streams[0].url, REUSED_URL);
        assert.equal(freshWins.meta.videos[1].streams[0].url, COMEDY_URL);
    });
});

async function runWithStreams(show, seriesId, catalogGenres, getStream, episodes) {
    const urls = [];
    const wrapped = scraperWith(async (url) => {
        urls.push(url);
        return seriesPage(episodes);
    });
    wrapped.scraper.getStream = async (kalturaId, streamName) => getStream(kalturaId, streamName);
    wrapped.scraper.previousCatalogOverride = {
        root: {
            data: {
                [seriesId]: {
                    id: seriesId,
                    name: "שיחת היום",
                    link: "https://13tv.co.il/all-shows/todays-talk",
                    meta: { genres: catalogGenres }
                }
            }
        }
    };
    await wrapped.scraper.loadSeriesIdentityIndex();
    try {
        const added = await wrapped.scraper.processOneReshetSeries(show);
        assert.equal(urls.some((url) => url === RESHET.URL_STREAM), false);
        assert.equal(urls.length, 1);
        return wrapped.scraper.getJsonObject()[added.id];
    } finally {
        wrapped.restore();
    }
}
