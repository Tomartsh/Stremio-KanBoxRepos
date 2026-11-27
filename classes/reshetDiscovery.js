const fs = require("fs");
const path = require("path");

const EXTRA_SHOWS_PATH = path.join(__dirname, "..", "config", "reshet-extra-shows.json");

const LISTING_SLUGS = new Set([
    "",
    "allshows",
    "all-shows",
    "all-shows-list"
]);

// Site sections that are not a VOD show page. /shows/{slug} and
// /all-shows/{slug} still go through the VodPlaylist check.
const SKIP_SECTION = /^\/(news|daytime|entertainment|mood|specials|contact-us|tv-guide|item|general)(\/|$)/i;

function loadReshetExtraShows(filePath) {
    const source = filePath || EXTRA_SHOWS_PATH;
    try {
        const parsed = JSON.parse(fs.readFileSync(source, "utf8"));
        return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
        return [];
    }
}

function normalizePath(raw) {
    if (raw == null) return "";
    let value = String(raw).trim();
    if (!value) return "";
    try {
        if (/^https?:\/\//i.test(value)) {
            value = new URL(value).pathname;
        }
    } catch (error) {
        // Keep the raw path when it is not a valid absolute URL.
    }
    value = value.split("#")[0].split("?")[0].trim();
    if (!value.startsWith("/")) value = "/" + value;
    if (value.length > 1) value = value.replace(/\/+$/, "") + "/";
    return value;
}

function showSlugFromUrl(raw) {
    const pathname = normalizePath(raw);
    if (!pathname) return "";
    const parts = pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    if (!parts.length) return "";
    let slug = parts[parts.length - 1];
    try {
        slug = decodeURIComponent(slug);
    } catch (error) {
        // Keep the raw segment when it is not valid percent-encoding.
    }
    return String(slug).trim();
}

function allShowsUrlForSlug(slug) {
    return "/all-shows/" + slug + "/";
}

/**
 * Pull title + path from the 13tv header, mobile, and VOD sub menus.
 * Items use `url` in the main menu and `link` in the sub menu.
 */
function collectMenuLinks(listJson) {
    const header = listJson
        && listJson.props
        && listJson.props.pageProps
        && listJson.props.pageProps.page
        && listJson.props.pageProps.page.Header;
    if (!header || typeof header !== "object") return [];

    const links = [];
    const seen = new Set();

    function walk(items) {
        if (!Array.isArray(items)) return;
        for (const item of items) {
            if (!item || typeof item !== "object") continue;
            const raw = item.url || item.link || "";
            const title = item.title || item.name || "";
            const pathname = normalizePath(raw);
            if (pathname) {
                const key = pathname.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    links.push({ title: String(title || ""), url: pathname });
                }
            }
            walk(item.children);
        }
    }

    walk(header.mainMenu);
    walk(header.mainMenuMobile);
    walk(header.subMenu);
    return links;
}

/**
 * Map a menu path to an /all-shows/{slug}/ candidate, or null when the
 * path is a listing page or a non-VOD section (news, daytime, and similar).
 */
function menuUrlToAllShows(raw) {
    const pathname = normalizePath(raw);
    if (!pathname) return null;
    if (SKIP_SECTION.test(pathname)) return null;

    const showsMatch = pathname.match(/^\/shows\/([^/]+)\/$/i);
    const allShowsMatch = pathname.match(/^\/all-shows\/([^/]+)\/$/i);
    const slugRaw = showsMatch ? showsMatch[1] : (allShowsMatch ? allShowsMatch[1] : null);
    if (!slugRaw) return null;

    let slug = slugRaw;
    try {
        slug = decodeURIComponent(slugRaw);
    } catch (error) {
        // Keep the raw slug when it is not valid percent-encoding.
    }
    if (LISTING_SLUGS.has(String(slug).toLowerCase())) return null;

    return {
        slug: slug,
        url: allShowsUrlForSlug(slug)
    };
}

function listedShowsFromListJson(listJson) {
    try {
        const shows = listJson.props.pageProps.page.Content.PageGrid[0].shows;
        return Array.isArray(shows) ? shows : [];
    } catch (error) {
        return [];
    }
}

function asShowRecord(show, fallbackTitle) {
    if (!show || typeof show !== "object") return null;
    const rawUrl = show.url || show.link || "";
    const mapped = menuUrlToAllShows(rawUrl) || (showSlugFromUrl(rawUrl) ? {
        slug: showSlugFromUrl(rawUrl),
        url: allShowsUrlForSlug(showSlugFromUrl(rawUrl))
    } : null);
    // Listed items are already /all-shows/{slug}/; keep that url when present.
    const url = (rawUrl && /^\/all-shows\/[^/]+\/?$/i.test(normalizePath(rawUrl)))
        ? normalizePath(rawUrl)
        : (mapped ? mapped.url : "");
    if (!url || url.startsWith("/?")) return null;
    const slug = showSlugFromUrl(url);
    if (!slug || LISTING_SLUGS.has(slug.toLowerCase())) return null;
    return {
        url: url,
        title: show.title || show.name || fallbackTitle || slug,
        poster: show.poster || "",
        id: show.id
    };
}

/**
 * First show for each slug wins. Listed shows stay ahead of extras and
 * menu finds, so a page already on all-shows-list keeps its original record.
 */
function mergeReshetShows(...lists) {
    const bySlug = new Map();
    for (const list of lists) {
        if (!Array.isArray(list)) continue;
        for (const show of list) {
            const record = asShowRecord(show);
            if (!record) continue;
            const key = showSlugFromUrl(record.url).toLowerCase();
            if (!key || bySlug.has(key)) continue;
            bySlug.set(key, record);
        }
    }
    return Array.from(bySlug.values());
}

function pageContent(json) {
    if (!json || typeof json !== "object") return null;
    if (json.props && json.props.pageProps && json.props.pageProps.page) {
        return json.props.pageProps.page.Content || null;
    }
    if (json.pageProps && json.pageProps.page) {
        return json.pageProps.page.Content || null;
    }
    return null;
}

function pageHasVodPlaylist(json) {
    const content = pageContent(json);
    const grids = content && content.PageGrid;
    if (!Array.isArray(grids)) return false;
    return grids.some((grid) => grid && grid.grid_type === "VodPlaylist");
}

/**
 * Unique show list to scrape: all-shows-list, then the extras seed, then
 * header/mobile menu candidates that resolve to a VodPlaylist page.
 */
async function discoverReshetShows(listJson, options) {
    const opts = options || {};
    const extras = Array.isArray(opts.extras) ? opts.extras : loadReshetExtraShows();
    const isVodPlaylist = typeof opts.isVodPlaylist === "function"
        ? opts.isVodPlaylist
        : async () => false;

    const listed = listedShowsFromListJson(listJson);
    const extraShows = extras.map((item) => asShowRecord(item)).filter(Boolean);
    const known = new Set(mergeReshetShows(listed, extraShows).map((show) => {
        return showSlugFromUrl(show.url).toLowerCase();
    }));

    const fromMenu = [];
    const probed = new Set();
    for (const link of collectMenuLinks(listJson)) {
        const candidate = menuUrlToAllShows(link.url);
        if (!candidate) continue;
        const key = candidate.slug.toLowerCase();
        if (known.has(key) || probed.has(key)) continue;
        probed.add(key);
        const show = {
            url: candidate.url,
            title: link.title || candidate.slug,
            poster: "",
            slug: candidate.slug
        };
        let ok = false;
        try {
            ok = await isVodPlaylist(show);
        } catch (error) {
            ok = false;
        }
        if (!ok) continue;
        fromMenu.push(show);
        known.add(key);
    }

    const shows = mergeReshetShows(listed, extraShows, fromMenu);
    const listedSlugs = new Set(mergeReshetShows(listed).map((show) => {
        return showSlugFromUrl(show.url).toLowerCase();
    }));
    const fromExtras = extraShows.filter((show) => {
        return !listedSlugs.has(showSlugFromUrl(show.url).toLowerCase());
    });

    return {
        shows: shows,
        listedCount: mergeReshetShows(listed).length,
        fromExtras: fromExtras,
        fromMenu: fromMenu
    };
}

module.exports = {
    EXTRA_SHOWS_PATH,
    loadReshetExtraShows,
    showSlugFromUrl,
    collectMenuLinks,
    menuUrlToAllShows,
    mergeReshetShows,
    pageHasVodPlaylist,
    discoverReshetShows,
    listedShowsFromListJson
};
