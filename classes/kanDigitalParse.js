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
function cleanCardName(value) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim()
        .replace(/\s*\.כאן(?:\s*(?:11|ארכיון))?\s*$/u, "")
        .trim();
}

function cardImage(card) {
    if (!card || typeof card.querySelector !== "function") return "";
    const img = card.querySelector("div.cr-card img, img.img-full, img");
    if (!img) return "";
    let src = img.getAttribute("src") || img.getAttribute("data-src") || "";
    const query = src.indexOf("?");
    if (query >= 0) src = src.slice(0, query);
    if (src.startsWith("//")) src = "https:" + src;
    else if (src.startsWith("/")) src = KAN_ORIGIN + src;
    return src;
}

/**
 * /p-N/sX/ID/ on kan-11 and on archive1. Archive openers (פתיח) live at
 * /archive1/.../p-N/ID/ with no season segment. The same shape under /kan/
 * is a trailer or extra and stays out, so a single-title page still resolves
 * through the hero watch link. Participant cards are never episodes.
 */
function episodeFromHref(href, seriesId) {
    const parsedHref = parseHref(href);
    if (!parsedHref) return null;
    if (parsedHref.path.includes("/participants/")) return null;

    const seasonMatch = parsedHref.path.match(/\/(p-\d+)\/s(\d+)\/([^/]+)\/$/);
    if (seasonMatch) {
        if (seriesId && seasonMatch[1] !== seriesId) return null;
        return {
            url: absoluteUrl(parsedHref),
            season: parseInt(seasonMatch[2], 10)
        };
    }

    const archiveMatch = parsedHref.path.match(/\/archive1\/(?:[^/]+\/)*?(p-\d+)\/([^/]+)\/$/);
    if (!archiveMatch) return null;
    if (/^s\d+$/.test(archiveMatch[2])) return null;
    if (seriesId && archiveMatch[1] !== seriesId) return null;
    return {
        url: absoluteUrl(parsedHref),
        season: 0
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

function pushEpisode(episodes, seen, href, title, duration, description, seriesId, extras) {
    const info = episodeFromHref(href, seriesId);
    if (!info || seen.has(info.url)) return;
    seen.add(info.url);
    const extra = extras || {};
    episodes.push({
        url: info.url,
        title: title || "",
        duration: duration || extra.duration || "",
        season: info.season,
        description: description || "",
        image: extra.image || "",
        subtitle: extra.subtitle || ""
    });
}

/**
 * Archive lobby cards. The series name is the poster alt (the title attribute
 * repeats it with a ".כאן11" / ".כאן ארכיון" suffix). The card has no
 * card-title text, which is why storing "" left every name blank.
 *
 * @param {string|object} html
 * @returns {{url: string, name: string, image: string, description: string}[]}
 */
function parseArchiveIndex(html) {
    const doc = ensureDoc(html);
    const series = [];
    const seen = new Set();

    doc.querySelectorAll("a.card-link").forEach((card) => {
        const href = card.getAttribute("href") || "";
        if (!href || href.includes("kan-actual") || href.includes("podcasts")) return;
        const parsedHref = parseHref(href);
        if (!parsedHref || !parsedHref.path.includes("/archive1/")) return;
        const url = absoluteUrl(parsedHref);
        if (seen.has(url)) return;
        seen.add(url);

        const img = card.querySelector("img.img-full, img");
        const alt = img ? cleanCardName(img.getAttribute("alt")) : "";
        const titleAttr = img ? cleanCardName(img.getAttribute("title")) : "";
        series.push({
            url,
            name: alt || titleAttr,
            image: cardImage(card),
            description: elementText(card.querySelector("h3"))
        });
    });

    return series;
}

/**
 * Series title, blurb, and raw genre labels. Title prefers the visually
 * hidden h1 used by the current program pages.
 *
 * @param {string|object} html
 * @returns {{title: string, description: string, genres: string[]}}
 */
function parseSeriesMeta(html) {
    const doc = ensureDoc(html);
    const title = elementText(doc.querySelector("h1.visually-hidden"))
        || elementText(doc.querySelector("h1"))
        || elementText(doc.querySelector("title"));
    const description = elementText(doc.querySelector("div.info-description p"))
        || elementText(doc.querySelector("div.info-description"));
    const genres = [];
    const genreRoot = doc.querySelector("div.info-genre");
    if (genreRoot) {
        genreRoot.querySelectorAll("ul li").forEach((item) => {
            const label = elementText(item);
            if (label) genres.push(label);
        });
    }
    return { title, description, genres };
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
        pushEpisode(episodes, seenEpisodes, card.getAttribute("href"), title, duration, "", seriesId, {
            image: cardImage(card),
            subtitle: elementText(card.querySelector("p.cr-subtitle"))
        });
    });

    doc.querySelectorAll("a.cr-item").forEach((card) => {
        const href = card.getAttribute("href") || "";
        if (href.includes("/participants/")) return;
        const title = elementText(card.querySelector("h3.cr-title")) || card.getAttribute("aria-label") || "";
        const subtitle = elementText(card.querySelector("p.cr-subtitle"));
        pushEpisode(episodes, seenEpisodes, href, title, "", "", seriesId, {
            image: cardImage(card),
            subtitle
        });
    });

    doc.querySelectorAll("a.card-link").forEach((card) => {
        const title = elementText(card.querySelector("div.card-title, h2.card-title, h3.card-title"))
            || card.getAttribute("title")
            || card.getAttribute("aria-label")
            || "";
        const description = elementText(card.querySelector("div.card-text"));
        pushEpisode(episodes, seenEpisodes, card.getAttribute("href"), title, "", description, seriesId, {
            image: cardImage(card)
        });
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
function episodeNumberFrom(episode) {
    const titleMatch = String(episode.title || "").match(/פרק\s*(\d+)/);
    if (titleMatch) return parseInt(titleMatch[1], 10);
    const subtitleMatch = String(episode.subtitle || "").match(/פרק\s*(\d+)/);
    if (subtitleMatch) return parseInt(subtitleMatch[1], 10);
    return null;
}

function setsEqual(left, right) {
    if (left.size !== right.size) return false;
    for (const value of left) {
        if (!right.has(value)) return false;
    }
    return true;
}

function normalizeEpisodeUrl(url) {
    const text = String(url || "").split("?")[0];
    if (!text) return "";
    return text.replace(/\/+$/, "") + "/";
}

/**
 * Season pages that are not already rendered on this document. A season
 * inside div.seasons-item is complete. The page we just fetched is not
 * requested again.
 *
 * @param {string|object} html
 * @param {string} pageUrl
 * @param {{seasonUrls?: string[]}} parsedSeries
 * @returns {string[]}
 */
function seasonUrlsToFetch(html, pageUrl, parsedSeries) {
    const doc = ensureDoc(html);
    const parsed = parsedSeries || {};
    const seasonDivs = doc.querySelectorAll("div.seasons-item");
    const covered = new Set();
    for (const seasonDiv of seasonDivs) {
        const links = seasonDiv.querySelectorAll("a.program-grid-card, a.cr-item, a.card-link");
        for (const link of links) {
            const match = (link.getAttribute("href") || "").match(/\/s(\d+)\//);
            if (match) covered.add(parseInt(match[1], 10));
        }
    }

    const pageKey = String(pageUrl || "").split("?")[0].replace(/\/+$/, "") + "/";
    const seasonUrls = [];
    for (const seasonUrl of parsed.seasonUrls || []) {
        const match = String(seasonUrl).match(/\/s(\d+)\/?$/);
        if (!match) continue;
        const seasonNo = parseInt(match[1], 10);
        if (seasonDivs.length > 0 && covered.has(seasonNo)) continue;
        const seasonKey = String(seasonUrl).split("?")[0].replace(/\/+$/, "") + "/";
        if (seasonKey === pageKey) continue;
        seasonUrls.push(seasonUrl);
    }
    return seasonUrls;
}

/**
 * Decide how much of a known series to fetch again.
 * Unchanged: the series page was enough, reuse the previous episodes.
 * Active-season cards changed but the season list did not: rebuild that
 * season from the cards already on the page and keep the other seasons.
 * A page that only shows a subset of a season (the Kupara series page
 * lists some of s6) is not treated as the full season: that season page
 * is fetched. A season was added or removed: fetch the season pages that
 * are not already rendered.
 *
 * @param {object[]|null} previousVideos
 * @param {object[]} pageEpisodes
 * @param {string[]} seasonUrls
 * @returns {{reuse: boolean, seasonUrls: string[], keepUnseenSeasons: boolean}}
 */
function planSeriesRefresh(previousVideos, pageEpisodes, seasonUrls) {
    const previous = Array.isArray(previousVideos) ? previousVideos : [];
    const fetchSeasons = {
        reuse: false,
        seasonUrls: seasonUrls || [],
        keepUnseenSeasons: false
    };
    if (previous.length === 0) return fetchSeasons;

    const prevBySeason = new Map();
    for (const video of previous) {
        const season = Number(video.season) || 0;
        const url = normalizeEpisodeUrl(video.episodeLink || video.url || "");
        if (!url) continue;
        if (!prevBySeason.has(season)) prevBySeason.set(season, new Set());
        prevBySeason.get(season).add(url);
    }
    const pageBySeason = new Map();
    for (const episode of pageEpisodes || []) {
        const season = Number(episode.season) || 0;
        const url = normalizeEpisodeUrl(episode.url || "");
        if (!url) continue;
        if (!pageBySeason.has(season)) pageBySeason.set(season, new Set());
        pageBySeason.get(season).add(url);
    }

    const tabSeasons = new Set();
    for (const url of seasonUrls || []) {
        const match = String(url).match(/\/s(\d+)\/?$/);
        if (match) tabSeasons.add(parseInt(match[1], 10));
    }
    const prevSeasons = new Set([...prevBySeason.keys()].filter((season) => season > 0));
    const visibleSeasons = new Set([
        ...tabSeasons,
        ...[...pageBySeason.keys()].filter((season) => season > 0)
    ]);

    if (tabSeasons.size === 0) {
        const prevUrls = new Set();
        for (const urls of prevBySeason.values()) {
            for (const url of urls) prevUrls.add(url);
        }
        const pageUrls = new Set();
        for (const urls of pageBySeason.values()) {
            for (const url of urls) pageUrls.add(url);
        }
        if (setsEqual(prevUrls, pageUrls)) {
            return { reuse: true, seasonUrls: [], keepUnseenSeasons: false };
        }
        return { reuse: false, seasonUrls: [], keepUnseenSeasons: false };
    }

    if (!setsEqual(prevSeasons, visibleSeasons)) {
        const covered = new Set([...pageBySeason.keys()].filter((season) => season > 0));
        const urls = (seasonUrls || []).filter((url) => {
            const match = String(url).match(/\/s(\d+)\/?$/);
            return match && !covered.has(parseInt(match[1], 10));
        });
        return { reuse: false, seasonUrls: urls, keepUnseenSeasons: false };
    }

    const toFetch = [];
    let pageIsAuthoritative = false;
    for (const [season, urls] of pageBySeason) {
        if (!(season > 0)) continue;
        const prev = prevBySeason.get(season) || new Set();
        if (setsEqual(prev, urls)) continue;
        const seasonUrl = (seasonUrls || []).find((url) => {
            return new RegExp(`/s${season}/?$`).test(String(url).split("?")[0]);
        });
        // The series root sometimes renders only the first cards of the
        // active season. Replacing the season with that subset would drop
        // episodes, so fetch the season page instead.
        if (seasonUrl && isProperSubset(urls, prev)) toFetch.push(seasonUrl);
        else pageIsAuthoritative = true;
    }
    if (!setsEqual(prevBySeason.get(0) || new Set(), pageBySeason.get(0) || new Set())) {
        pageIsAuthoritative = true;
    }
    if (!pageIsAuthoritative && toFetch.length === 0) {
        return { reuse: true, seasonUrls: [], keepUnseenSeasons: false };
    }
    return { reuse: false, seasonUrls: toFetch, keepUnseenSeasons: true };
}

function isProperSubset(pageSet, prevSet) {
    if (pageSet.size === 0 || pageSet.size >= prevSet.size) return false;
    for (const url of pageSet) {
        if (!prevSet.has(url)) return false;
    }
    return true;
}

/**
 * One catalog video from a series/season card. Nothing here comes from the
 * episode page. Release date is copied later when a previous catalog has it.
 *
 * @param {object} episode
 * @param {string} seriesId
 * @returns {object|null}
 */
function videoFromEpisodeCard(episode, seriesId) {
    if (!episode || !episode.url) return null;
    if (String(episode.url).includes("p-12385/s4")) return null;
    const season = Number.isFinite(episode.season) ? episode.season : 1;
    const episodeNo = Number.isFinite(episode.episodeNo) ? episode.episodeNo : 1;
    const video = {
        id: `${seriesId}:${season}:${episodeNo}`,
        name: episode.title || "",
        season,
        episode: episodeNo,
        description: episode.description || "",
        thumbnail: episode.image || "",
        episodeLink: episode.url,
        streams: []
    };
    if (episode.duration) video.duration = episode.duration;
    if (episode.released) video.released = episode.released;
    return video;
}

/**
 * A single title. The hero link is the episode page; the stream is resolved
 * on playback the same way as every other digital episode.
 */
function videoFromMovieCard(movieUrl, seriesId, title, description, image) {
    if (!movieUrl) return null;
    return {
        id: `${seriesId}:1:1`,
        name: title || "",
        season: 1,
        episode: 1,
        description: description || "",
        thumbnail: image || "",
        episodeLink: movieUrl,
        streams: []
    };
}

function carryPreviousEpisodeFields(videos, previousVideos) {
    const byLink = new Map();
    for (const video of previousVideos || []) {
        const link = normalizeEpisodeUrl(video && (video.episodeLink || video.url));
        if (link) byLink.set(link, video);
    }
    return (videos || []).map((video) => {
        const prev = byLink.get(normalizeEpisodeUrl(video.episodeLink));
        if (!prev) return video;
        const next = Object.assign({}, video);
        if (!next.thumbnail && prev.thumbnail) next.thumbnail = prev.thumbnail;
        if (!next.released && prev.released) next.released = prev.released;
        if (!next.description && prev.description) next.description = prev.description;
        return next;
    });
}

function numberDigitalEpisodes(episodes) {
    const jobs = [];
    const rest = [];
    for (const episode of episodes || []) {
        if (!episode || !episode.url) continue;
        // Openers have no /sN/ segment (season 0) or a "פתיח" title. They must
        // not take an episode number away from the season they sit beside.
        // "פתיח" is the intro card. "פתיחה" is an ordinary episode title.
        if (episode.season === 0 || /פתיח(?!ה)/u.test(String(episode.title || ""))) {
            jobs.push(Object.assign({}, episode, {
                season: episode.season > 0 ? episode.season : 1,
                episodeNo: 0
            }));
            continue;
        }
        rest.push(episode);
    }

    const groups = new Map();
    for (const episode of rest) {
        const season = Number.isFinite(episode.season) ? episode.season : 1;
        if (!groups.has(season)) groups.set(season, []);
        groups.get(season).push(episode);
    }

    const seasonNumbers = [...groups.keys()].sort((a, b) => a - b);
    for (const season of seasonNumbers) {
        const list = groups.get(season);
        const fromTitle = list.map((episode) => episodeNumberFrom(episode));

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
    parseArchiveIndex,
    parseSeriesMeta,
    parseSeriesPage,
    seasonUrlsToFetch,
    planSeriesRefresh,
    videoFromEpisodeCard,
    videoFromMovieCard,
    carryPreviousEpisodeFields,
    numberDigitalEpisodes,
    normalizeEpisodeUrl
};
