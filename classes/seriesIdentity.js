/**
 * Series identity for catalogs whose page URL has no numeric id.
 *
 * Those series used to take the next value from a process-wide counter, so
 * the id depended on scrape order. Published ids stay as they are: match the
 * previous catalog by link, then by name. A series that is not in that
 * catalog gets a deterministic id from its URL slug.
 */

const crypto = require("crypto");

function unwrapCatalog(root) {
    if (!root || typeof root !== "object" || Array.isArray(root)) return {};
    if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) return root.data;
    return root;
}

function normalizeSeriesLink(link) {
    const value = String(link || "").trim();
    if (!value) return "";
    try {
        const url = new URL(value);
        url.hash = "";
        url.search = "";
        const path = url.pathname.replace(/\/+$/, "");
        return `${url.protocol}//${url.host.toLowerCase()}${path}`;
    } catch (error) {
        return value.split("#")[0].split("?")[0].replace(/\/+$/, "");
    }
}

function normalizeSeriesName(name) {
    return String(name || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function linkSlug(link) {
    const normalized = normalizeSeriesLink(link);
    if (!normalized) return "";
    const slash = normalized.lastIndexOf("/");
    return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

/**
 * Digits in the last path segment. `p-11766` stays `11766`, which is the id
 * already published for numeric Kan URLs. A query string is not part of the id.
 */
function numericIdFromLink(link) {
    const slug = linkSlug(link);
    if (!slug) return "";
    return slug.replace(/\D/g, "");
}

function stableSlugToken(link) {
    let slug = linkSlug(link);
    if (slug) {
        try {
            slug = decodeURIComponent(slug);
        } catch (error) {
            // Keep the raw slug when it is not valid percent-encoding.
        }
    }
    const token = String(slug || "")
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_+/g, "_");
    if (token) return token;
    const basis = normalizeSeriesLink(link) || String(link || "unknown");
    return `s_${crypto.createHash("sha1").update(basis).digest("hex").slice(0, 12)}`;
}

function seriesLinkOf(series) {
    if (!series || typeof series !== "object") return "";
    return series.link || (series.meta && series.meta.link) || "";
}

function seriesNameOf(series) {
    if (!series || typeof series !== "object") return "";
    return series.name || (series.meta && series.meta.name) || "";
}

function buildSeriesIdentityIndex(root) {
    const byId = new Map();
    const byLink = new Map();
    const byName = new Map();
    for (const [key, series] of Object.entries(unwrapCatalog(root))) {
        if (!series || typeof series !== "object" || Array.isArray(series)) continue;
        if (!series.meta && series.id == null && series.name == null) continue;
        const id = String(series.id || key);
        const record = {
            id,
            link: normalizeSeriesLink(seriesLinkOf(series)),
            name: normalizeSeriesName(seriesNameOf(series)),
            series
        };
        if (!byId.has(id)) byId.set(id, record);
        if (record.link && !byLink.has(record.link)) byLink.set(record.link, record);
        if (record.name && !byName.has(record.name)) byName.set(record.name, record);
    }
    return { byId, byLink, byName };
}

/**
 * Match a scraped series to a published one. Id, then link, then name.
 * These catalogs do not reuse a title across series, so a renamed URL still
 * keeps the published id.
 */
function matchSeriesIdentity(index, query) {
    if (!index || !query) return null;
    const id = query.id ? String(query.id) : "";
    if (id && index.byId && index.byId.has(id)) return index.byId.get(id);
    const link = normalizeSeriesLink(query.link);
    if (link && index.byLink && index.byLink.has(link)) return index.byLink.get(link);
    const name = normalizeSeriesName(query.name);
    if (!name || !index.byName || !index.byName.has(name)) return null;
    return index.byName.get(name);
}

module.exports = {
    normalizeSeriesLink,
    normalizeSeriesName,
    linkSlug,
    numericIdFromLink,
    stableSlugToken,
    seriesLinkOf,
    seriesNameOf,
    buildSeriesIdentityIndex,
    matchSeriesIdentity
};
