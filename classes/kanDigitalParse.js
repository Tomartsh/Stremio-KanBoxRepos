/**
 * Pure HTML helpers for the Kan Digital / Kan-Box pages.
 *
 * Kan replaced the old block-list / card-link lobby and the seasons-item
 * episode grids. Series pages now come in two server-rendered shapes:
 * program-grid cards inside div.seasons-item, or cr-item cards plus plain
 * /p-N/sX/ season links. Single titles use a.hero-vod-cta. The legacy
 * selectors stay as fallbacks.
 *
 * Depends only on node-html-parser. Pass a raw HTML string or a document
 * that module already parsed.
 */

const { parse } = require("node-html-parser");

const KAN_ORIGIN = "https://www.kan.org.il";

function ensureDoc(html) {
    if (html && typeof html.querySelectorAll === "function") return html;
    if (typeof html !== "string" || html.length === 0) return parse("");
    return parse(html);
}

function elementText(element) {
    if (!element) return "";
    const value = element.text != null ? element.text : element.textContent;
    return String(value || "").replace(/\s+/g, " ").trim();
}

function parseHref(href) {
    if (!href || typeof href !== "string") return null;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("mailto:") || trimmed.startsWith("javascript:")) {
        return null;
    }
    try {
        const url = new URL(trimmed, KAN_ORIGIN);
        let path = url.pathname || "/";
        if (!path.endsWith("/")) path += "/";
        return { origin: url.origin, path };
    } catch (error) {
        return null;
    }
}

function absoluteUrl(parsedHref) {
    return parsedHref.origin + parsedHref.path;
}

function seriesIdFromUrl(seriesUrl) {
    const parsedHref = parseHref(seriesUrl || "");
    if (!parsedHref) return "";
    const match = parsedHref.path.match(/\/(p-\d+)\//);
    return match ? match[1] : "";
}

/**
 * Episode hrefs look like /p-12832/s6/1098487/. Season roots look like
 * /p-12832/s6/ and must not be treated as episodes.
 */
function episodeFromHref(href, seriesId) {
    const parsedHref = parseHref(href);
    if (!parsedHref) return null;
    const match = parsedHref.path.match(/\/(p-\d+)\/s(\d+)\/([^/]+)\/$/);
    if (!match) return null;
    if (seriesId && match[1] !== seriesId) return null;
    return {
        url: absoluteUrl(parsedHref),
        season: parseInt(match[2], 10)
    };
}

function seasonFromHref(href, seriesId) {
    const parsedHref = parseHref(href);
    if (!parsedHref) return null;
    const match = parsedHref.path.match(/\/(p-\d+)\/s(\d+)\/$/);
    if (!match) return null;
    if (seriesId && match[1] !== seriesId) return null;
    return {
        url: absoluteUrl(parsedHref),
        season: parseInt(match[2], 10)
    };
}

function seriesRootFromHref(href) {
    const parsedHref = parseHref(href);
    if (!parsedHref) return "";
    const match = parsedHref.path.match(/^(.*\/p-\d+)\//);
    if (!match) return "";
    return parsedHref.origin + match[1] + "/";
}

function pushEpisode(episodes, seen, href, title, duration, description, seriesId) {
    const info = episodeFromHref(href, seriesId);
    if (!info || seen.has(info.url)) return;
    seen.add(info.url);
    episodes.push({
        url: info.url,
        title: title || "",
        duration: duration || "",
        season: info.season,
        description: description || ""
    });
}

/**
 * Lobby cards are episode (or series) links grouped under a section heading.
 * Each card is trimmed to the series root /p-N/ and repeated cards in the
 * same section collapse. The same series may still appear in later sections
 * so the caller can apply the category ignore list before the final dedupe.
 *
 * @param {string|object} html
 * @returns {{category: string, seriesUrl: string}[]}
 */
function parseKanBoxLobby(html) {
    const doc = ensureDoc(html);
    const entries = [];
    const seen = new Set();

    doc.querySelectorAll("section.content-row-section").forEach((section) => {
        const category = elementText(section.querySelector(".component-header h2"));
        section.querySelectorAll("a.cr-item").forEach((card) => {
            const seriesUrl = seriesRootFromHref(card.getAttribute("href"));
            if (!seriesUrl) return;
            const key = category + "\0" + seriesUrl;
            if (seen.has(key)) return;
            seen.add(key);
            entries.push({ category, seriesUrl });
        });
    });

    return entries;
}

/**
 * Drop ignored categories, then keep the first remaining row for each series.
 * A series that also sits in a category we keep is still scraped.
 *
 * @param {{category: string, seriesUrl: string}[]} entries
 * @param {string[]} ignoreList
 */
function selectLobbySeries(entries, ignoreList) {
    const ignore = new Set(ignoreList || []);
    const seen = new Set();
    const selected = [];
    for (const entry of entries || []) {
        if (!entry || !entry.seriesUrl) continue;
        if (ignore.has(entry.category)) continue;
        if (seen.has(entry.seriesUrl)) continue;
        seen.add(entry.seriesUrl);
        selected.push(entry);
    }
    return selected;
}

/**
 * @param {string|object} html
 * @param {string} seriesUrl series root, or a season page under that series
 * @returns {{seasonUrls: string[], episodes: {url: string, title: string, duration: string, season: number, description: string}[], movieUrl: string|null}}
 */
function parseSeriesPage(html, seriesUrl) {
    const doc = ensureDoc(html);
    const seriesId = seriesIdFromUrl(seriesUrl);
    const episodes = [];
    const seenEpisodes = new Set();

    doc.querySelectorAll("a.program-grid-card").forEach((card) => {
        const title = elementText(card.querySelector(".program-grid-title")) || card.getAttribute("aria-label") || "";
        const duration = elementText(card.querySelector(".program-grid-duration"));
        pushEpisode(episodes, seenEpisodes, card.getAttribute("href"), title, duration, "", seriesId);
    });

    doc.querySelectorAll("a.cr-item").forEach((card) => {
        const title = elementText(card.querySelector("h3.cr-title")) || card.getAttribute("aria-label") || "";
        pushEpisode(episodes, seenEpisodes, card.getAttribute("href"), title, "", "", seriesId);
    });

    doc.querySelectorAll("a.card-link").forEach((card) => {
        const title = elementText(card.querySelector("div.card-title"))
            || card.getAttribute("title")
            || card.getAttribute("aria-label")
            || "";
        const description = elementText(card.querySelector("div.card-text"));
        pushEpisode(episodes, seenEpisodes, card.getAttribute("href"), title, "", description, seriesId);
    });

    const seasons = [];
    const seenSeasons = new Set();
    doc.querySelectorAll("a").forEach((anchor) => {
        const info = seasonFromHref(anchor.getAttribute("href"), seriesId);
        if (!info || seenSeasons.has(info.season)) return;
        seenSeasons.add(info.season);
        seasons.push(info);
    });
    seasons.sort((a, b) => a.season - b.season);

    let movieUrl = null;
    if (episodes.length === 0 && seasons.length === 0) {
        const cta = doc.querySelector("a.hero-vod-cta") || doc.querySelector("a.btn.with-arrow");
        const parsedHref = cta && parseHref(cta.getAttribute("href"));
        if (parsedHref) movieUrl = absoluteUrl(parsedHref);
    }

    return {
        seasonUrls: seasons.map((season) => season.url),
        episodes,
        movieUrl
    };
}

/**
 * Episode numbers come from a "פרק N" title when the card has one (the new
 * grids are not all newest-first). Cards with no episode number keep the
 * legacy order: the first card in the season is the highest episode.
 *
 * @param {{url: string, title: string, season: number}[]} episodes
 * @returns {object[]}
 */
function numberDigitalEpisodes(episodes) {
    const groups = new Map();
    for (const episode of episodes || []) {
        if (!episode || !episode.url) continue;
        const season = Number.isFinite(episode.season) ? episode.season : 1;
        if (!groups.has(season)) groups.set(season, []);
        groups.get(season).push(episode);
    }

    const jobs = [];
    const seasonNumbers = [...groups.keys()].sort((a, b) => a - b);
    for (const season of seasonNumbers) {
        const list = groups.get(season);
        const fromTitle = list.map((episode) => {
            const match = String(episode.title || "").match(/פרק\s*(\d+)/);
            return match ? parseInt(match[1], 10) : null;
        });

        if (fromTitle.every((value) => value == null)) {
            list.forEach((episode, index) => {
                jobs.push(Object.assign({}, episode, {
                    season,
                    episodeNo: list.length - index
                }));
            });
            continue;
        }

        const used = new Set();
        const assigned = new Array(list.length);
        list.forEach((episode, index) => {
            if (fromTitle[index] == null) return;
            let number = fromTitle[index];
            while (used.has(number)) number += 1;
            used.add(number);
            assigned[index] = number;
        });
        list.forEach((episode, index) => {
            if (assigned[index] != null) return;
            let number = 1;
            while (used.has(number)) number += 1;
            used.add(number);
            assigned[index] = number;
        });
        list.forEach((episode, index) => {
            jobs.push(Object.assign({}, episode, {
                season,
                episodeNo: assigned[index]
            }));
        });
    }
    return jobs;
}

module.exports = {
    parseKanBoxLobby,
    selectLobbySeries,
    parseSeriesPage,
    numberDigitalEpisodes
};
