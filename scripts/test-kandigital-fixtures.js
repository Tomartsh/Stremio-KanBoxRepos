#!/usr/bin/env node
/**
 * Parse a directory of Kan Digital HTML captures and print PASS/FAIL.
 *
 * Expected file names:
 *   lobby-raw.html
 *   kupara-raw.html
 *   kupara-s6-raw.html
 *   series-kan11.html
 *   movie-p525000-raw.html
 *
 * Usage: node scripts/test-kandigital-fixtures.js <directory>
 */

const fs = require("fs");
const path = require("path");
const { parseKanBoxLobby, parseSeriesPage } = require("../classes/kanDigitalParse");

const SERIES_12832 = "https://www.kan.org.il/content/kan/kan-11/p-12832/";
const SERIES_682519 = "https://www.kan.org.il/content/kan/kan-11/p-682519/";
const MOVIE_URL = "https://www.kan.org.il/content/kan/kan-11/p-525000/525002/";

const dir = process.argv[2];
if (!dir) {
    console.error("Usage: node scripts/test-kandigital-fixtures.js <directory>");
    process.exit(2);
}

let failed = 0;

function check(name, ok, detail) {
    const suffix = detail ? " — " + detail : "";
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${suffix}`);
    if (!ok) failed += 1;
}

function load(name) {
    const filePath = path.join(dir, name);
    if (!fs.existsSync(filePath)) {
        check(name, false, "file missing");
        return null;
    }
    const html = fs.readFileSync(filePath, "utf8");
    console.log(`\n${name}: ${html.length} bytes`);
    return html;
}

const lobbyHtml = load("lobby-raw.html");
if (lobbyHtml != null) {
    const entries = parseKanBoxLobby(lobbyHtml);
    const urls = [...new Set(entries.map((entry) => entry.seriesUrl))];
    const categories = new Set(entries.map((entry) => entry.category));
    console.log(`  rows=${entries.length} uniqueSeries=${urls.length} categories=${categories.size}`);
    check("lobby includes p-12832", urls.includes(SERIES_12832));
    check("lobby includes p-682519", urls.includes(SERIES_682519));
    check("lobby has many unique series", urls.length >= 100, String(urls.length));
    check(
        "lobby urls are series roots",
        urls.every((url) => /\/p-\d+\/$/.test(url)),
        `${urls.length} urls`
    );
    check(
        "lobby has no episode-level urls",
        urls.every((url) => !/\/s\d+\//.test(url) && !/\/p-\d+\/\d+\//.test(url))
    );
}

const kuparaHtml = load("kupara-raw.html");
if (kuparaHtml != null) {
    const parsed = parseSeriesPage(kuparaHtml, SERIES_12832);
    const seasons = parsed.seasonUrls.map((url) => (url.match(/\/s(\d+)\/$/) || [])[1]).filter(Boolean);
    console.log(`  seasonUrls=${parsed.seasonUrls.length} [${seasons.join(",")}] episodes=${parsed.episodes.length} movieUrl=${parsed.movieUrl || ""}`);
    check(
        "kupara seasons s1-s6",
        [1, 2, 3, 4, 5, 6].every((season) => parsed.seasonUrls.some((url) => url.endsWith(`/s${season}/`)))
    );
    check("kupara has episodes", parsed.episodes.length > 0, String(parsed.episodes.length));
    check(
        "kupara episodes stay under /p-12832/",
        parsed.episodes.length > 0 && parsed.episodes.every((episode) => episode.url.includes("/p-12832/"))
    );
}

const seasonHtml = load("kupara-s6-raw.html");
if (seasonHtml != null) {
    const parsed = parseSeriesPage(seasonHtml, "https://www.kan.org.il/content/kan/kan-11/p-12832/s6/");
    const seasonSix = parsed.episodes.filter((episode) => episode.season === 6);
    console.log(`  episodes=${parsed.episodes.length} season6=${seasonSix.length}`);
    check(
        "s6 page yields season 6 episodes",
        seasonSix.length > 0 && seasonSix.every((episode) => episode.url.includes("/p-12832/s6/")),
        String(seasonSix.length)
    );
}

const seriesHtml = load("series-kan11.html");
if (seriesHtml != null) {
    const parsed = parseSeriesPage(seriesHtml, SERIES_682519);
    console.log(`  episodes=${parsed.episodes.length} seasons=${parsed.seasonUrls.length}`);
    check("p-682519 has program-grid episodes", parsed.episodes.length > 0, String(parsed.episodes.length));
    check(
        "p-682519 episodes have titles",
        parsed.episodes.length > 0 && parsed.episodes.every((episode) => episode.title && episode.title.trim())
    );
    check(
        "p-682519 episodes have durations",
        parsed.episodes.length > 0 && parsed.episodes.every((episode) => /^\d{2}:\d{2}:\d{2}$/.test(episode.duration))
    );
}

const movieHtml = load("movie-p525000-raw.html");
if (movieHtml != null) {
    const parsed = parseSeriesPage(movieHtml, "https://www.kan.org.il/content/kan/kan-11/p-525000/");
    console.log(`  movieUrl=${parsed.movieUrl || ""} episodes=${parsed.episodes.length} seasons=${parsed.seasonUrls.length}`);
    check("movie page yields hero watch url", parsed.movieUrl === MOVIE_URL, parsed.movieUrl || "");
}

console.log("");
if (failed === 0) {
    console.log("PASS");
    process.exit(0);
}
console.log(`FAIL (${failed})`);
process.exit(1);
