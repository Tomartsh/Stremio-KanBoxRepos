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
        // Archive season folders are Hebrew slugs. The URL parser leaves them
        // percent-encoded; decode so "/עונה-2/" matches the published links.
        try {
            path = decodeURIComponent(path);
        } catch (error) {
            // Keep the pathname when it is not valid percent-encoding.
        }
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
    return stripSiteSuffix(stripImageArtifacts(value));
}

function decodePathname(value) {
    const text = String(value || "").split("?")[0];
    try {
        return decodeURIComponent(text);
    } catch (error) {
        return text;
    }
}

/**
 * Hebrew archive seasons are not /sN/. They are folders such as /עונה-2/,
 * /עונה-1-מסך-אישי/, or /היום-זה-אנחנו-פרקים-מלאים/.
 */
function isSeasonFolderSlug(slug) {
    const text = decodePathname(slug);
    if (/^s\d+$/i.test(text)) return true;
    if (/עונה/u.test(text)) return true;
    if (/פרקים/u.test(text)) return true;
    if (/^season(?:-|\d)/i.test(text)) return true;
    return false;
}

function seasonNumberFromSlug(slug) {
    const text = decodePathname(slug);
    const latin = text.match(/^s(\d+)$/i);
    if (latin) return parseInt(latin[1], 10);
    const hebrew = text.match(/עונה-(\d+)/);
    if (hebrew) return parseInt(hebrew[1], 10);
    const english = text.match(/season-(\d+)/i);
    if (english) return parseInt(english[1], 10);
    return null;
}

/**
 * Stable key for a season tab and for the episodes that live under it.
 * /s2/ and /s2/104/ share s:2. /עונה-2/ and /עונה-2/104/ share the folder.
 */
function seasonIdentityFromPath(path) {
    const decoded = decodePathname(path);
    const withSlash = decoded.endsWith("/") ? decoded : decoded + "/";
    const season = withSlash.match(/\/s(\d+)\//);
    if (season) return "s:" + season[1];
    const folder = withSlash.match(/\/p-\d+\/([^/]+)\//);
    if (folder && isSeasonFolderSlug(folder[1]) && !/^s\d+$/i.test(folder[1])) {
        return "f:" + folder[1];
    }
    return null;
}

/**
 * A few archive series have no /p-N/: /betweenus/s1/673834/ and
 * /קיץ-ביובל/s1/776101/. The slug is the series, then the usual season.
 */
function seriesSlugFromUrl(seriesUrl) {
    const parsed = parseHref(seriesUrl || "");
    if (!parsed) return "";
    const match = parsed.path.match(/\/archive1\/(?:[^/]+\/)([^/]+)\/(?:s\d+\/)?$/);
    if (!match || /^p-\d+$/.test(match[1]) || /^s\d+$/i.test(match[1])) return "";
    return match[1];
}

function archiveSlugSeason(path) {
    const match = String(path || "").match(/\/archive1\/(?:[^/]+\/)([^/]+)\/s(\d+)\/(?:([^/]+)\/)?$/);
    if (!match || /^p-\d+$/.test(match[1])) return null;
    return {
        slug: match[1],
        season: parseInt(match[2], 10),
        episode: match[3] || ""
    };
}

/**
 * "פתיח" is the opening-theme card. "פתיחה" and "פתיחת" are ordinary titles.
 */
function isOpenerTitle(title) {
    return /(?:^|\||\s)פתיח\s*$/u.test(String(title || "").replace(/\s+/g, " ").trim());
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
function episodeFromHref(href, seriesId, options) {
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

    const slugEpisode = archiveSlugSeason(parsedHref.path);
    if (slugEpisode && slugEpisode.episode) {
        if (seriesId) return null;
        if (options && options.seriesSlug && options.seriesSlug !== slugEpisode.slug) return null;
        return {
            url: absoluteUrl(parsedHref),
            season: slugEpisode.season
        };
    }

    // /p-N/עונה-2/1046567/ and /p-N/עונה-1-מסך-אישי/874518/. The folder is the
    // season; the last segment is the episode. Digital /kan/ paths stay out.
    const folderMatch = parsedHref.path.match(/\/(p-\d+)\/([^/]+)\/([^/]+)\/$/);
    if (folderMatch && parsedHref.path.includes("/archive1/") && !/^s\d+$/i.test(folderMatch[2])) {
        if (seriesId && folderMatch[1] !== seriesId) return null;
        const seasonNo = seasonNumberFromSlug(folderMatch[2]);
        return {
            url: absoluteUrl(parsedHref),
            season: seasonNo == null ? 1 : seasonNo
        };
    }

    const archiveMatch = parsedHref.path.match(/\/archive1\/(?:[^/]+\/)*?(p-\d+)\/([^/]+)\/$/);
    if (archiveMatch && !/^s\d+$/i.test(archiveMatch[2]) && !isSeasonFolderSlug(archiveMatch[2])) {
        if (seriesId && archiveMatch[1] !== seriesId) return null;
        return {
            url: absoluteUrl(parsedHref),
            season: 0
        };
    }

    // Single-season digital shows (p-13779, p-13871) list episodes at
    // /p-N/<id>/ with no /sN/ segment. The same shape is also a trailer, so
    // only a card titled "פרק N" counts. Trailers ("טריילר", "הצצה") stay out
    // and a one-title page still resolves through the hero watch link.
    const flatMatch = parsedHref.path.match(/\/(p-\d+)\/([^/]+)\/$/);
    if (!flatMatch || /^s\d+$/.test(flatMatch[2])) return null;
    if (!(options && options.allowFlatEpisode)) return null;
    if (seriesId && flatMatch[1] !== seriesId) return null;
    return {
        url: absoluteUrl(parsedHref),
        season: 1
    };
}

function cardIsFlatEpisode(title) {
    // Subtitles on trailer cards also say "פרק N". The episode title itself
    // is what separates /p-N/<id>/ episodes from those trailers.
    return /פרק\s*\d+/u.test(String(title || ""));
}

/**
 * Episode blurbs. Archive cards no longer use div.card-text; the synopsis is
 * a description element when the card has one. A subtitle that only says
 * "עונה N, פרק M" is the episode number, not a description.
 */
function cardDescription(card) {
    if (!card || typeof card.querySelector !== "function") return "";
    const explicit = elementText(card.querySelector(
        "div.card-text, p.card-text, .cr-description, p.cr-description, p.episode-description"
    ));
    if (explicit) return explicit;
    const subtitle = elementText(card.querySelector("p.cr-subtitle"));
    if (!subtitle) return "";
    if (/^עונה\s*\d+/u.test(subtitle)) return "";
    if (/^פרק\s*\d+/u.test(subtitle)) return "";
    return subtitle;
}

function seasonFromHref(href, seriesId, seriesSlug) {
    const parsedHref = parseHref(href);
    if (!parsedHref) return null;
    const match = parsedHref.path.match(/\/(p-\d+)\/s(\d+)\/$/);
    if (match) {
        if (seriesId && match[1] !== seriesId) return null;
        return {
            url: absoluteUrl(parsedHref),
            season: parseInt(match[2], 10)
        };
    }

    const slugSeason = archiveSlugSeason(parsedHref.path);
    if (slugSeason && !slugSeason.episode) {
        if (seriesId) return null;
        if (seriesSlug && seriesSlug !== slugSeason.slug) return null;
        return {
            url: absoluteUrl(parsedHref),
            season: slugSeason.season
        };
    }

    const folder = parsedHref.path.match(/\/(p-\d+)\/([^/]+)\/$/);
    if (!folder || !parsedHref.path.includes("/archive1/")) return null;
    if (/^s\d+$/i.test(folder[2]) || !isSeasonFolderSlug(folder[2])) return null;
    if (seriesId && folder[1] !== seriesId) return null;
    return {
        url: absoluteUrl(parsedHref),
        season: seasonNumberFromSlug(folder[2]) || 1
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
    const extra = extras || {};
    const info = episodeFromHref(href, seriesId, {
        allowFlatEpisode: cardIsFlatEpisode(title),
        seriesSlug: extra.seriesSlug || ""
    });
    if (!info || seen.has(info.url)) return;
    seen.add(info.url);
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
        const rawAlt = img ? (img.getAttribute("alt") || "") : "";
        const rawTitle = img ? (img.getAttribute("title") || "") : "";
        const posterName = nameFromPosterFile(img ? (img.getAttribute("src") || img.getAttribute("data-src") || "") : "");
        let name = cleanCardName(rawAlt) || cleanCardName(rawTitle);
        if (!isValidSeriesTitle(name)) {
            const salvaged = titleFromPhotoCaption(rawAlt || rawTitle, posterName);
            name = isValidSeriesTitle(salvaged) ? salvaged : "";
        }
        series.push({
            url,
            name,
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
    const seriesSlug = seriesSlugFromUrl(seriesUrl);
    const episodes = [];
    const seenEpisodes = new Set();

    doc.querySelectorAll("a.program-grid-card").forEach((card) => {
        const title = elementText(card.querySelector(".program-grid-title")) || card.getAttribute("aria-label") || "";
        const duration = elementText(card.querySelector(".program-grid-duration"));
        pushEpisode(episodes, seenEpisodes, card.getAttribute("href"), title, duration, "", seriesId, {
            image: cardImage(card),
            subtitle: elementText(card.querySelector("p.cr-subtitle")),
            seriesSlug
        });
    });

    doc.querySelectorAll("a.cr-item").forEach((card) => {
        const href = card.getAttribute("href") || "";
        if (href.includes("/participants/")) return;
        const title = elementText(card.querySelector("h3.cr-title")) || card.getAttribute("aria-label") || "";
        const subtitle = elementText(card.querySelector("p.cr-subtitle"));
        pushEpisode(episodes, seenEpisodes, href, title, "", cardDescription(card), seriesId, {
            image: cardImage(card),
            subtitle,
            seriesSlug
        });
    });

    doc.querySelectorAll("a.card-link").forEach((card) => {
        const title = elementText(card.querySelector("div.card-title, h2.card-title, h3.card-title"))
            || card.getAttribute("title")
            || card.getAttribute("aria-label")
            || "";
        const description = cardDescription(card);
        pushEpisode(episodes, seenEpisodes, card.getAttribute("href"), title, "", description, seriesId, {
            image: cardImage(card),
            seriesSlug
        });
    });

    const seasons = [];
    const seenSeasons = new Set();
    doc.querySelectorAll("a").forEach((anchor) => {
        const info = seasonFromHref(anchor.getAttribute("href"), seriesId, seriesSlug);
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
    const titleMatch = String(episode.title || "").match(/(?:פרק|תוכנית)\s*(\d+)/);
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
            const identity = seasonIdentityFromPath(link.getAttribute("href") || "");
            if (identity) covered.add(identity);
        }
    }

    const pageKey = String(pageUrl || "").split("?")[0].replace(/\/+$/, "") + "/";
    const seasonUrls = [];
    for (const seasonUrl of parsed.seasonUrls || []) {
        const identity = seasonIdentityFromPath(seasonUrl);
        if (!identity) continue;
        if (seasonDivs.length > 0 && covered.has(identity)) continue;
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

/**
 * Keep seeded episodes when a rescrape returns fewer, zero, or a failed
 * season. A smaller card list is merged back with the seeded rows so a
 * partial parse cannot shrink the catalog. Episodes are dropped only when
 * that season loaded and the new list is at least as long as the seeded one.
 *
 * @param {object[]} scrapedVideos
 * @param {object[]} previousVideos
 * @param {{failedSeasons?: number[], keepPrevious?: boolean}} options
 * @returns {object[]}
 */
function mergeSeededVideos(scrapedVideos, previousVideos, options = {}) {
    const previous = Array.isArray(previousVideos) ? previousVideos : [];
    const scraped = Array.isArray(scrapedVideos) ? scrapedVideos : [];
    if (options.keepPrevious) {
        return previous.map((video) => Object.assign({}, video));
    }

    const failed = new Set((options.failedSeasons || []).map((season) => Number(season)));
    const scrapedLinks = new Set();
    const scrapedBySeason = new Map();
    for (const video of scraped) {
        const link = normalizeEpisodeUrl(video && (video.episodeLink || video.url));
        if (link) scrapedLinks.add(link);
        const season = Number(video && video.season) || 0;
        scrapedBySeason.set(season, (scrapedBySeason.get(season) || 0) + 1);
    }
    const previousBySeason = new Map();
    for (const video of previous) {
        const season = Number(video && video.season) || 0;
        previousBySeason.set(season, (previousBySeason.get(season) || 0) + 1);
    }

    const merged = [];
    const seen = new Set();
    const push = (video) => {
        if (!video) return;
        const link = normalizeEpisodeUrl(video.episodeLink || video.url);
        const key = link || video.id;
        if (!key || seen.has(key)) return;
        seen.add(key);
        merged.push(Object.assign({}, video));
    };

    for (const video of scraped) push(video);
    for (const video of previous) {
        const link = normalizeEpisodeUrl(video && (video.episodeLink || video.url));
        if (link && scrapedLinks.has(link)) continue;
        const season = Number(video && video.season) || 0;
        const scrapedCount = scrapedBySeason.get(season) || 0;
        const previousCount = previousBySeason.get(season) || 0;
        if (failed.has(season) || scrapedCount < previousCount) push(video);
    }
    return merged;
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
        // Only the opening-theme card is episode 0. Flat /p-N/<id>/ episodes
        // (documentaries, extras) are real episodes and need their own numbers.
        // A season of 0 means the link had no /sN/ and no Hebrew season folder.
        if (isOpenerTitle(episode.title)) {
            jobs.push(Object.assign({}, episode, {
                season: episode.season > 0 ? episode.season : 1,
                episodeNo: 0
            }));
            continue;
        }
        const season = episode.season > 0 ? episode.season : 1;
        rest.push(season === episode.season ? episode : Object.assign({}, episode, { season }));
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
    return disambiguateEpisodeNumbers(jobs);
}

/**
 * The first card that wants a season/episode pair keeps it. Later cards that
 * would reuse it take the next free positive number, so every video id built
 * from season and episode is unique. Episode 0 stays the opening theme.
 */
function disambiguateEpisodeNumbers(jobs) {
    const groups = new Map();
    jobs.forEach((job, index) => {
        const season = job.season;
        if (!groups.has(season)) groups.set(season, []);
        groups.get(season).push({ job, index });
    });
    const result = jobs.slice();
    for (const entries of groups.values()) {
        const taken = new Set();
        const dupes = [];
        for (const entry of entries) {
            const number = entry.job.episodeNo;
            if (!taken.has(number)) taken.add(number);
            else dupes.push(entry);
        }
        for (const entry of dupes) {
            let next = 1;
            while (taken.has(next)) next += 1;
            taken.add(next);
            result[entry.index] = Object.assign({}, entry.job, { episodeNo: next });
        }
    }
    return result;
}

/**
 * Series names sometimes come from a poster's alt text or caption instead of
 * the show title: "5", "6  Image Big 1200X1800", "4  image_small_239X360",
 * "תמונת אורך פרק". Those are rejected so a better source can be used.
 * A name that merely contains the word תמונה / תמונות is a real title and
 * stays valid.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isValidSeriesTitle(name) {
    const text = String(name == null ? "" : name).replace(/\s+/g, " ").trim();
    if (!text) return false;
    if (/^[\d\s\p{P}\p{S}]+$/u.test(text)) return false;
    if (/\d+\s*[xX×]\s*\d+/u.test(text)) return false;
    if (/image[\s_-]*(?:small|big)/iu.test(text)) return false;
    if (/תמונת\s+אורך\s+פרק/u.test(text)) return false;
    // The site name is not a show. A title that merely contains תמונה / תמונות stays valid.
    if (/^(?:כאן(?:\s+ארכיון)?|kan(?:\s+archive)?)$/iu.test(text)) return false;
    if (looksLikePhotoCaption(text)) return false;
    return true;
}

/**
 * Poster filenames and alts: "Poster Image Small 239X360", "6 Image Big 1200X1800",
 * "360 לול 239". The words around the dimensions are the show, when there are any.
 */
function stripImageArtifacts(value) {
    let text = String(value == null ? "" : value);
    text = text.replace(/poster/ig, " ");
    text = text.replace(/image[\s_-]*(?:small|big)/ig, " ");
    text = text.replace(/פוסטר(?:\s*קטן)?/g, " ");
    text = text.replace(/\d+\s*[-_]?\s*[xX×]\s*[-_]?\s*\d+/g, " ");
    text = text.replace(/\(\s*\d+\s*\)/g, " ");
    text = text.replace(/\s+/g, " ").trim();
    const sandwich = text.match(/^(\d{2,4})\s+(.+?)\s+(\d{2,4})$/u);
    if (sandwich) text = sandwich[2].trim();
    return text.trim();
}

/**
 * A photo caption names what is in the picture and appends a year:
 * "המסעדה הגדולה, 1985", "קהל מוחא כפיים, קיץ ביובל 1998".
 * A real title may contain a year ("היום זה אנחנו 2017") and still be valid.
 */
function looksLikePhotoCaption(text) {
    const value = String(text || "");
    if (!value.includes(",")) return false;
    return /(?:19|20)\d{2}/.test(value);
}

function nameFromPosterFile(src) {
    if (!src) return "";
    let file = String(src).split("?")[0].split("/").pop() || "";
    try {
        file = decodeURIComponent(file);
    } catch (error) {
        // Keep the raw filename.
    }
    file = file.replace(/\.(jpe?g|png|webp|gif|svg)$/i, "");
    file = stripImageArtifacts(file).replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
    if (!isValidSeriesTitle(file) || looksLikePhotoCaption(file)) return "";
    return file;
}

function titleFromPhotoCaption(caption, posterName) {
    const text = stripSiteSuffix(stripImageArtifacts(caption));
    if (!looksLikePhotoCaption(text)) return "";
    const parts = text.split(",").map((part) => part.replace(/\s+/g, " ").trim()).filter(Boolean);
    const stripped = parts.map((part) => {
        return part
            .replace(/\s*(?:19|20)\d{2}(?:\s*-\s*(?:19|20)\d{2})?\s*$/u, "")
            .replace(/^(?:19|20)\d{2}\s+/u, "")
            .trim();
    }).filter(Boolean);
    const poster = String(posterName || "").trim();
    if (poster) {
        const hit = stripped.find((part) => part === poster || poster.includes(part) || part.includes(poster));
        if (hit && isValidSeriesTitle(hit) && !looksLikePhotoCaption(hit)) return hit;
    }
    if (stripped.length === 1 && isValidSeriesTitle(stripped[0]) && !looksLikePhotoCaption(stripped[0])) {
        return stripped[0];
    }
    return "";
}

/**
 * Ids for archive series that are already in the published catalog.
 * /p-N/ keeps N. A slug with no p-N reuses the published id for that link.
 * Percent-encoded Hebrew is not turned into a digit string, and a new slug
 * gets a stable hash instead of a crawl-order counter.
 *
 * @param {string} url
 * @param {Map<string, string>|Object<string, string>|null} previousByUrl normalized link -> series id
 * @returns {string}
 */
function normalizeCatalogUrl(url) {
    try {
        const parsed = new URL(url, KAN_ORIGIN);
        let path = parsed.pathname || "/";
        try {
            path = decodeURIComponent(path);
        } catch (error) {
            // Keep the pathname.
        }
        if (!path.endsWith("/")) path += "/";
        return "https://www.kan.org.il" + path;
    } catch (error) {
        return "";
    }
}

function stableSlugToken(slug) {
    let hash = 5381;
    const text = String(slug || "");
    for (let i = 0; i < text.length; i++) {
        hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
    }
    return hash.toString(36);
}

function archiveSeriesId(url, previousByUrl) {
    const normalized = normalizeCatalogUrl(url);
    let path = "";
    try {
        path = new URL(normalized).pathname;
    } catch (error) {
        path = "";
    }
    const program = path.match(/\/p-(\d+)(?:\/|$)/);
    if (program) return "il_kan_archive_" + program[1];

    if (previousByUrl && normalized) {
        const previous = previousByUrl instanceof Map
            ? previousByUrl.get(normalized)
            : previousByUrl[normalized];
        if (previous) return previous;
    }

    const slug = path.split("/").filter(Boolean).pop() || "series";
    return "il_kan_archive_slug_" + stableSlugToken(slug);
}

/**
 * Drop a trailing site name: " | כאן", " - Kan", ".כאן11".
 */
function stripSiteSuffix(value) {
    let text = String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    // "כאן ארכיון | שישי בטברנה" keeps the show. "שישי בטברנה | כאן" keeps the show.
    text = text.replace(/^(?:כאן\s*ארכיון|כאן\s*11|כאן|kan)\s*[|\-–—]\s*/iu, "");
    text = text.replace(/\s*[|\-–—]\s*(?:כאן|Kan)(?:\s*(?:11|ארכיון|חינוכית|Box|דיגיטל))?\s*$/iu, "");
    text = text.replace(/\s*\.כאן(?:\s*(?:11|ארכיון))?\s*$/u, "");
    text = text.replace(/\s*\.ארכיון\s*$/u, "");
    return text.trim();
}

/**
 * Pick the series name. Candidates are tried in the order the scraper always
 * used (lobby image alt, lobby title hint, page image title, h2.title.h1,
 * og:title, h1, <title>), then the name already in the previous catalog.
 * The first candidate that passes isValidSeriesTitle wins. When none does,
 * the first non-empty candidate is kept so the series is not dropped.
 *
 * @param {string|object} html series page
 * @param {{imageAlt?: string, titleHint?: string, previousName?: string, clean?: function}} options
 * @returns {{title: string, source: string, rejected: string[]}}
 */
function pickSeriesTitle(html, options = {}) {
    const doc = ensureDoc(html);
    const clean = typeof options.clean === "function" ? options.clean : (value) => value;
    const attr = (selector, name) => {
        const node = doc.querySelector(selector);
        return node ? node.getAttribute(name) || "" : "";
    };
    const posterName = nameFromPosterFile(options.posterSrc);
    const captionTitle = titleFromPhotoCaption(options.imageAlt, posterName);
    const candidates = [
        ["imageAlt", options.imageAlt],
        ["titleHint", options.titleHint],
        ["img.img-fluid", attr("img.img-fluid", "title")],
        ["h2.title.h1", elementText(doc.querySelector("h2.title.h1"))],
        ["og:title", attr('meta[property="og:title"]', "content")],
        ["h1", elementText(doc.querySelector("h1"))],
        ["title", elementText(doc.querySelector("title"))],
        ["previous", options.previousName],
        ["caption", captionTitle]
    ];
    const rejected = [];
    let firstNonEmpty = null;
    for (const [source, raw] of candidates) {
        const rawText = String(raw == null ? "" : raw).trim();
        if (!rawText) continue;
        const value = stripSiteSuffix(clean(stripSiteSuffix(stripImageArtifacts(rawText))) || "");
        if (isValidSeriesTitle(value)) return { title: value, source, rejected };
        rejected.push(value || rawText);
        if (firstNonEmpty == null && value) firstNonEmpty = { title: value, source };
    }
    if (firstNonEmpty) return Object.assign(firstNonEmpty, { rejected });
    return { title: "", source: "", rejected };
}

/**
 * A single-title series reuses the series name for its one video, so a bad
 * alt-text name also ended up on the video. Replace a video name only when it
 * is invalid and is one of the rejected series names; real episode names
 * (including dates like "11/11/22") are left alone.
 *
 * @param {object[]} videos
 * @param {string[]} rejectedNames
 * @param {string} title
 * @returns {object[]}
 */
function repairVideoNames(videos, rejectedNames, title) {
    if (!Array.isArray(videos) || !isValidSeriesTitle(title)) return videos;
    const norm = (value) => String(value == null ? "" : value).replace(/\s+/g, " ").trim();
    const bad = new Set((rejectedNames || []).map(norm).filter(Boolean));
    return videos.map((video) => {
        if (!video) return video;
        const name = norm(video.name);
        if (!name || isValidSeriesTitle(name) || !bad.has(name)) return video;
        return Object.assign({}, video, { name: title });
    });
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
    mergeSeededVideos,
    numberDigitalEpisodes,
    normalizeEpisodeUrl,
    isValidSeriesTitle,
    stripSiteSuffix,
    pickSeriesTitle,
    repairVideoNames,
    archiveSeriesId,
    normalizeCatalogUrl
};
