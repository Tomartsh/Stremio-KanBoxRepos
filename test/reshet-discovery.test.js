const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const ReshetScraper = require("../classes/ReshetScraper");
const {
    loadReshetExtraShows,
    collectMenuLinks,
    menuUrlToAllShows,
    mergeReshetShows,
    pageHasVodPlaylist,
    discoverReshetShows,
    showSlugFromUrl
} = require("../classes/reshetDiscovery");
const utils = require("../classes/utilities");

const listFixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures/reshet/all-shows-list-without-vort.json"),
    "utf8"
));
const vortPage = JSON.parse(fs.readFileSync(
    path.join(__dirname, "fixtures/reshet/vort-page.json"),
    "utf8"
));

function slugs(shows) {
    return shows.map((show) => showSlugFromUrl(show.url)).sort();
}

function categoryPage(title) {
    return {
        props: {
            pageProps: {
                page: {
                    PageMeta: { title: title },
                    Content: {
                        PageGrid: [{ grid_type: "AllShows", shows: [] }]
                    }
                }
            }
        }
    };
}

test("menu maps /shows/{slug}/ to /all-shows/{slug}/ and skips news and daytime pages", () => {
    assert.deepEqual(menuUrlToAllShows("/shows/vort/"), {
        slug: "vort",
        url: "/all-shows/vort/"
    });
    assert.deepEqual(menuUrlToAllShows("https://13tv.co.il/shows/vort"), {
        slug: "vort",
        url: "/all-shows/vort/"
    });
    assert.deepEqual(menuUrlToAllShows("/all-shows/the-promised-land/"), {
        slug: "the-promised-land",
        url: "/all-shows/the-promised-land/"
    });
    assert.equal(menuUrlToAllShows("/news/hamakor/"), null);
    assert.equal(menuUrlToAllShows("/daytime/daily-report/"), null);
    assert.equal(menuUrlToAllShows("/entertainment/hatzinor/"), null);
    assert.equal(menuUrlToAllShows("/mood/survivor/"), null);
    assert.equal(menuUrlToAllShows("/allshows/"), null);
    assert.equal(menuUrlToAllShows("/all-shows/"), null);
    assert.equal(menuUrlToAllShows("/all-shows/all-shows-list/"), null);
});

test("the extras seed starts with vort", () => {
    const extras = loadReshetExtraShows();
    assert.equal(extras.some((item) => showSlugFromUrl(item.url).toLowerCase() === "vort"), true);
    assert.equal(extras[0].title, "ווארט");
});

test("an all-shows-list without vort still queues it from the menu", async () => {
    const probed = [];
    const result = await discoverReshetShows(listFixture, {
        extras: [],
        isVodPlaylist: async (candidate) => {
            probed.push(candidate.slug);
            return candidate.slug === "vort";
        }
    });

    assert.equal(slugs(result.shows).includes("vort"), true);
    const vort = result.shows.find((show) => showSlugFromUrl(show.url) === "vort");
    assert.equal(vort.url, "/all-shows/vort/");
    assert.equal(vort.title, "ווארט");
    assert.deepEqual(result.fromMenu.map((show) => showSlugFromUrl(show.url)), ["vort"]);
    assert.equal(result.fromExtras.length, 0);
    assert.equal(probed.includes("vort"), true);
    assert.equal(probed.includes("news"), true);
    assert.equal(probed.includes("reality"), true);
    assert.equal(probed.includes("the-promised-land"), false);
    assert.equal(probed.includes("hamakor"), false);
    assert.equal(probed.includes("daily-report"), false);
    assert.equal(probed.includes("hatzinor"), false);
    assert.equal(probed.includes("survivor"), false);
    // Category pages were probed and rejected.
    assert.equal(result.shows.some((show) => ["news", "reality", "comedy", "drama"].includes(showSlugFromUrl(show.url))), false);
    // Invalid listed rows stay out, and promised land is not duplicated.
    assert.deepEqual(slugs(result.shows), ["assenheim", "the-promised-land", "vort"]);
});

test("an extras seed queues vort when the list and menu omit it", async () => {
    const list = JSON.parse(JSON.stringify(listFixture));
    list.props.pageProps.page.Header.mainMenu = [];
    list.props.pageProps.page.Header.mainMenuMobile = [];
    list.props.pageProps.page.Header.subMenu = [];
    let probed = 0;
    const result = await discoverReshetShows(list, {
        extras: [{ url: "/all-shows/vort/", title: "ווארט" }],
        isVodPlaylist: async () => {
            probed += 1;
            return true;
        }
    });
    assert.equal(probed, 0);
    assert.deepEqual(slugs(result.shows), ["assenheim", "the-promised-land", "vort"]);
    assert.deepEqual(result.fromExtras.map((show) => showSlugFromUrl(show.url)), ["vort"]);
    assert.equal(result.fromMenu.length, 0);
});

test("listed, menu, and extras entries for the same slug merge once", async () => {
    const result = await discoverReshetShows(listFixture, {
        extras: [
            { url: "/all-shows/vort/", title: "ווארט" },
            { url: "/all-shows/the-promised-land/", title: "should not replace" }
        ],
        isVodPlaylist: async () => {
            throw new Error("vort is already known from extras; do not probe");
        }
    });
    const promised = result.shows.filter((show) => showSlugFromUrl(show.url) === "the-promised-land");
    const vort = result.shows.filter((show) => showSlugFromUrl(show.url) === "vort");
    assert.equal(promised.length, 1);
    assert.equal(promised[0].title, "הארץ המובטחת");
    assert.equal(vort.length, 1);
    assert.deepEqual(slugs(result.shows), ["assenheim", "the-promised-land", "vort"]);
});

test("pageHasVodPlaylist accepts a real show page and rejects category grids", () => {
    assert.equal(pageHasVodPlaylist(vortPage), true);
    assert.equal(pageHasVodPlaylist(listFixture), false);
    assert.equal(pageHasVodPlaylist(categoryPage("ריאליטי")), false);
    assert.equal(pageHasVodPlaylist({}), false);
});

test("collectMenuLinks reads url and link fields without duplicating vort", () => {
    const links = collectMenuLinks(listFixture);
    const vortLinks = links.filter((item) => item.url.includes("vort"));
    assert.equal(vortLinks.length, 1);
    assert.equal(vortLinks[0].title, "ווארט");
    assert.equal(links.some((item) => item.url === "/all-shows/news/"), true);
    assert.equal(links.some((item) => item.url === "/all-shows/the-promised-land/"), true);
});

test("a real vort page fixture parses 37 episodes across three seasons", async () => {
    const scraper = new ReshetScraper();
    scraper._buildId = "test-build";
    scraper.getStream = async (kalturaId, streamName) => {
        return {
            streams: [{ url: "https://example.com/" + kalturaId, name: streamName }],
            genres: ["דוקו-ריאליטי"]
        };
    };
    const original = utils.fetchData;
    const fetched = [];
    utils.fetchData = async (url) => {
        fetched.push(url);
        return vortPage;
    };
    try {
        const videos = await scraper.getEpisodes("vort", "il_reshet_vort");
        assert.equal(Array.isArray(videos), true);
        assert.equal(videos.length, 37);

        const bySeason = new Map();
        for (const video of videos) {
            const count = bySeason.get(video.season) || 0;
            bySeason.set(video.season, count + 1);
            assert.equal(String(video.id).startsWith("il_reshet_vort:"), true);
            assert.equal(typeof video.episode, "number");
            assert.ok(video.streams && video.streams.length >= 1);
        }
        assert.equal(bySeason.get("1"), 11);
        assert.equal(bySeason.get("2"), 21);
        assert.equal(bySeason.get("3"), 5);

        const season3 = videos.filter((video) => String(video.season) === "3")
            .sort((a, b) => a.episode - b.episode);
        assert.equal(season3.length, 5);
        assert.equal(season3[0].name, "ווארט, עונה 3, פרק 1: פרק הבכורה");
        assert.equal(season3[4].name, "ווארט, עונה 3, פרק 5: השידוך הנועז");
        assert.equal(season3[4].episode, 5);
        // 24/11/2026 is stored as an ISO timestamp; the UTC day can shift
        // because parseIsraeliDate treats the calendar date as local midnight.
        assert.equal(typeof season3[4].released, "string");
        assert.equal(/2026-11-2[34]/.test(season3[4].released), true);

        const season1 = videos.filter((video) => String(video.season) === "1")
            .sort((a, b) => a.episode - b.episode);
        assert.equal(season1[0].name, "ווארט, עונה 1, פרק 1: פרק הבכורה");
        assert.equal(fetched.length, 1);
        assert.equal(fetched[0].includes("/all-shows/vort.json"), true);
    } finally {
        utils.fetchData = original;
    }
});

test("mergeReshetShows drops empty and query-only urls", () => {
    const merged = mergeReshetShows([
        { title: "ווארט", url: "/all-shows/vort/" },
        { title: "ווארט again", url: "/shows/vort/" },
        { title: "דירה מנצחת", url: "" },
        { title: "חצות ועוד יותר", url: "/?page_id=903952262" }
    ]);
    assert.deepEqual(slugs(merged), ["vort"]);
});
