#!/usr/bin/env node
/**
 * Parse a directory of Kan Archive HTML captures and print PASS/FAIL.
 *
 * Expected file names (raw captures):
 *   archive-index-lobby-series-raw.html
 *   archive-series-p-670875-raw.html
 *   archive-series-p-1084497-raw.html
 *   archive-series-p-670692-raw.html
 *   archive-episode-674967-raw.html
 *
 * Usage: node scripts/test-kanarchive-fixtures.js <directory>
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");
const { getNameFromSeriesPage } = require("../classes/utilities");
const { streamFromKanDocument } = require("../classes/ScraperHelpers");
const {
    parseArchiveIndex,
    parseSeriesMeta,
    parseSeriesPage,
    numberDigitalEpisodes,
    seasonUrlsToFetch
} = require("../classes/kanDigitalParse");

const dir = process.argv[2];
if (!dir) {
    console.error("Usage: node scripts/test-kanarchive-fixtures.js <directory>");
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

const indexHtml = load("archive-index-lobby-series-raw.html");
if (indexHtml != null) {
    const series = parseArchiveIndex(indexHtml);
    const vod = series.filter((item) => /\/archive1\/vod\/p-\d+\/$/.test(item.url));
    const blank = series.filter((item) => !item.name || !item.name.trim()).length;
    console.log(`  series=${series.length} vod=${vod.length} blankNames=${blank}`);
    check("index unique archive series", series.length === 173, String(series.length));
    check("index unique vod/p-N series", vod.length === 168, String(vod.length));
    check("index names are all set", blank === 0, String(blank));
    check(
        "index images are absolute and have no query",
        series.every((item) => item.image.startsWith("https://www.kan.org.il/") && !item.image.includes("?"))
    );
}

const seriesCases = [
    ["archive-series-p-670875-raw.html", "https://www.kan.org.il/content/archive1/vod/p-670875/", "אשכרה", 7, 6, 0],
    ["archive-series-p-1084497-raw.html", "https://www.kan.org.il/content/archive1/vod/p-1084497/", "החמישייה הקאמרית", 14, 13, 5],
    ["archive-series-p-670692-raw.html", "https://www.kan.org.il/content/archive1/vod/p-670692/", "סמי וסוסו", 18, 17, 0]
];

for (const [file, url, name, episodes, numberedEpisodes, seasons] of seriesCases) {
    const html = load(file);
    if (html == null) continue;
    const doc = parse(html);
    const meta = parseSeriesMeta(html);
    const parsed = parseSeriesPage(html, url);
    const numbered = numberDigitalEpisodes(parsed.episodes);
    const fetchSeasons = seasonUrlsToFetch(html, url, parsed);
    console.log(
        `  name=${getNameFromSeriesPage(meta.title)} episodes=${parsed.episodes.length} ` +
        `seasons=${parsed.seasonUrls.length} participants=${parsed.episodes.filter((episode) => episode.url.includes("/participants/")).length} ` +
        `legacyButtons=${doc.querySelectorAll("a.btn.with-arrow.info-link.btn-gradient").length}`
    );
    check(`${file} name`, getNameFromSeriesPage(meta.title) === name, getNameFromSeriesPage(meta.title));
    check(`${file} episodes`, parsed.episodes.length === episodes, String(parsed.episodes.length));
    check(`${file} numbered episodes`, numbered.filter((episode) => episode.episodeNo > 0).length === numberedEpisodes);
    check(`${file} opener`, numbered.some((episode) => episode.episodeNo === 0 && /פתיח/.test(episode.title)));
    check(`${file} season tabs`, parsed.seasonUrls.length === seasons, String(parsed.seasonUrls.length));
    check(`${file} season fetches`, fetchSeasons.length === seasons, String(fetchSeasons.length));
    check(`${file} no participant cards`, parsed.episodes.every((episode) => !episode.url.includes("/participants/")));
    check(`${file} no legacy empty-page button`, doc.querySelectorAll("a.btn.with-arrow.info-link.btn-gradient").length === 0);
    check(`${file} description`, meta.description.length > 0);
}

const chamishiya = load("archive-series-p-1084497-raw.html");
if (chamishiya != null) {
    const parsed = parseSeriesPage(chamishiya, "https://www.kan.org.il/content/archive1/vod/p-1084497/");
    const numbered = numberDigitalEpisodes(parsed.episodes);
    const mismatched = numbered.filter((episode) => episode.episodeNo > 0 && /עונה\s*5/.test(episode.subtitle || ""));
    check(
        "p-1084497 keeps the /s1/ path season",
        mismatched.length > 0 && mismatched.every((episode) => episode.season === 1),
        `cards=${mismatched.length}`
    );
}

const episodeHtml = load("archive-episode-674967-raw.html");
if (episodeHtml != null) {
    const doc = parse(episodeHtml);
    const player = doc.querySelector("[id^='redge-player-']");
    const stream = streamFromKanDocument(doc);
    console.log(`  stream=${stream && stream.url ? stream.url.slice(0, 80) : ""} released=${stream && stream.released}`);
    check("episode player has no data-hls-url", player && !player.getAttribute("data-hls-url"));
    check(
        "episode stream is the VideoObject contentUrl",
        stream && stream.url.includes("playlist.m3u8")
    );
    check("episode air date is 16.12.1987", stream && /^1987-12-1[67]T/.test(stream.released), stream && stream.released);
}

console.log(`\n${failed === 0 ? "OK" : "FAILED"} ${failed} failing check(s)`);
process.exit(failed === 0 ? 0 : 1);
