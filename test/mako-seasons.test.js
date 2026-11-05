const test = require("node:test");
const assert = require("node:assert/strict");

// MakoScraper takes fetchData from utilities when it is loaded, so stub it first.
const utilities = require("../classes/utilities.js");
let seasonLists = {};
utilities.fetchData = async url => {
    const path = new URL(url).pathname;
    if (seasonLists[path]) {
        return { seasons: seasonLists[path] };
    }
    return { channelId: "c", menu: [{ vods: [{ componentLayout: "vod", title: "episode", extraInfo: "פרק 1@01.01.26" }] }] };
};
const MakoScraper = require("../classes/MakoScraper");

// Runs processSeries on a season list as Mako returns it, and gives each season's
// ID (the middle part of the video ID) with the season number it was given.
async function seasonsFor(slug, seasons) {
    seasonLists = { [`/mako-vod-keshet/${slug}`]: seasons };
    const scraper = new MakoScraper();
    scraper.tmdbHelper = { searchTMDBSeries: async () => null };
    scraper.getEpisode = async (episode, id, seasonId) => ({
        status: "1",
        episodeId: `${id}:${seasonId}:1`,
        episodeTitle: episode.title
    });
    scraper.getStream = async () => [];
    let videos = [];
    scraper.addToJsonObject = (id, seriesUrl, title, background, poster, description, genres, seriesVideos) => {
        videos = seriesVideos;
    };
    await scraper.processSeries({ title: slug, pic: "", pageUrl: `/mako-vod-keshet/${slug}` });
    return Object.fromEntries(videos.map(video => [video.id.split(":")[1], video.season]));
}

function season(seasonTitle, page) {
    return { seasonTitle, pageUrl: `/mako-vod-keshet/${page}` };
}

// The season lists below are the ones Mako returned on 2026-10-23.

test("seasons with names only are numbered in Mako's order (המטבח המנצח VIP)", async () => {
    const numbers = await seasonsFor("mkr_israel", [
        season("VIP", "mkr_israel-vip"),
        season("VIP 2", "mkr_israel-VIP2"),
        season("VIP 3", "mkr_israel-vip3"),
        season("VIP 4", "mkr_israel-vip4"),
        season("VIP 5", "mkr_israel-vip5")
    ]);
    assert.deepEqual(numbers, { "VIP": 1, "VIP 2": 2, "VIP 3": 3, "VIP 4": 4, "VIP 5": 5 });
});

test("named seasons take numbers the numbered seasons leave free (מאסטר שף)", async () => {
    const numbers = await seasonsFor("masterchef", [
        season("VIP 2022", "masterchef-vip_2022"),
        season("עונה 11", "masterchef-s11"),
        season("נבחרת החלומות", "masterchef-dream_team"),
        season("עונה 12", "masterchef-s12"),
        season("נבחרת החלומות 2", "masterchef-dream_team_2")
    ]);
    assert.deepEqual(numbers, { "VIP 2022": 1, "11": 11, "נבחרת החלומות": 2, "12": 12, "נבחרת החלומות 2": 3 });
});

test("a new numbered season does not renumber the named ones", async () => {
    const numbers = await seasonsFor("masterchef", [
        season("VIP 2022", "masterchef-vip_2022"),
        season("עונה 11", "masterchef-s11"),
        season("נבחרת החלומות", "masterchef-dream_team"),
        season("עונה 12", "masterchef-s12"),
        season("נבחרת החלומות 2", "masterchef-dream_team_2"),
        season("עונה 13", "masterchef-s13")
    ]);
    assert.deepEqual(numbers, { "VIP 2022": 1, "11": 11, "נבחרת החלומות": 2, "12": 12, "נבחרת החלומות 2": 3, "13": 13 });
});

test("named seasons fill the numbers below year-based seasons (פאולה וליאון)", async () => {
    const numbers = await seasonsFor("paula_and_leon", [
        season("חשבון משותף", "paula_and_leon-s1"),
        season("בוקר בריא", "paula_and_leon-healthy-morning"),
        season("2019", "paula_and_leon-2019"),
        season("2020", "paula_and_leon-2020"),
        season("2021", "paula_and_leon-2021"),
        season("2022", "paula_and_leon-2022"),
        season("2023", "paula_and_leon-2023")
    ]);
    // The years keep the numbers they had: 3..7.
    assert.deepEqual(numbers, { "חשבון משותף": 1, "בוקר בריא": 2, "3": 3, "4": 4, "5": 5, "6": 6, "7": 7 });
});

test("year ranges are named seasons, not season 1993 (החדשות של ישראל)", async () => {
    const numbers = await seasonsFor("israel_news", [
        season("1993-1999", "israel_news-1993_until_1999"),
        season("2000-2005", "israel_news-2000_until_2005"),
        season("2006-2010", "israel_news-2006_until_2010"),
        season("2011-2014", "israel_news-2011_until_2014"),
        season("2015-2017", "israel_news-2015_until_2019"),
        season("2018-2023", "israel_news-2020_until_2023")
    ]);
    assert.deepEqual(numbers, {
        "1993-1999": 1, "2000-2005": 2, "2006-2010": 3, "2011-2014": 4, "2015-2017": 5, "2018-2023": 6
    });
});

test("named seasons listed between numbered ones come after them (נקסט)", async () => {
    const numbers = await seasonsFor("next", [
        season("נקסטר", "next-nexter"),
        season("עונה 1", "next-s-1"),
        season("עונה 2", "next-s2"),
        season("Samsung QLED", "next-samsung_qled"),
        season("עונה 3", "next-s3"),
        season("עונה 4", "next-s4"),
        season("עונה 5", "next-s5"),
        season("עונה 6", "next-s6")
    ]);
    assert.deepEqual(numbers, { "נקסטר": 7, "1": 1, "2": 2, "Samsung QLED": 8, "3": 3, "4": 4, "5": 5, "6": 6 });
});

test("numbered seasons are unchanged", async () => {
    const numbers = await seasonsFor("parliament", [
        season("עונה 1", "parliament-s1"),
        season("עונה 2", "parliament-s2")
    ]);
    assert.deepEqual(numbers, { "1": 1, "2": 2 });
});
