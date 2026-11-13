/**
 * Streams already stored in the published catalog.
 *
 * Kids and teens episode pages are fetched again on every run. When the
 * published episode id already has a stream URL, that URL can be kept and the
 * page skipped. Kan HLS URLs in the published kids and teens catalogs are
 * stable Redge paths such as
 * `https://r.il.cdn-redge.media/.../playlist.m3u8?fmp4`
 * or a YouTube link. `fmp4` is a container hint, not a credential.
 * A signed or expiring URL (token, exp, hdnts, CloudFront policy, a JWT)
 * is not reused.
 */

const EXPIRING_QUERY_KEYS = new Set([
    "exp",
    "expires",
    "expiry",
    "expire",
    "token",
    "hdnts",
    "hdnea",
    "policy",
    "signature",
    "key-pair-id",
    "acl"
]);

const JWT_VALUE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

function unwrapCatalog(root) {
    if (!root || typeof root !== "object" || Array.isArray(root)) return {};
    if (root.data && typeof root.data === "object" && !Array.isArray(root.data)) return root.data;
    return root;
}

function fullCatalogRefresh() {
    const raw = process.env.KAN_FULL_REFRESH;
    if (raw == null || String(raw).trim() === "") return false;
    return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function streamUrlIsReusable(url) {
    const value = String(url || "").trim();
    if (!value) return false;
    let parsed;
    try {
        parsed = new URL(value);
    } catch (error) {
        return false;
    }
    for (const key of parsed.searchParams.keys()) {
        if (EXPIRING_QUERY_KEYS.has(String(key).toLowerCase())) return false;
    }
    for (const part of parsed.searchParams.values()) {
        if (JWT_VALUE.test(part)) return false;
    }
    const segments = parsed.pathname.split("/");
    for (const segment of segments) {
        if (JWT_VALUE.test(segment)) return false;
    }
    return true;
}

function streamList(video) {
    if (!video || typeof video !== "object") return [];
    const raw = video.streams;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === "object" ? [raw] : []);
    return list.filter((item) => item && typeof item === "object" && item.url);
}

function indexPublishedStreams(root) {
    const byEpisode = new Map();
    for (const series of Object.values(unwrapCatalog(root))) {
        if (!series || typeof series !== "object" || Array.isArray(series)) continue;
        const videos = (series.meta && series.meta.videos) || series.videos;
        if (!Array.isArray(videos)) continue;
        for (const video of videos) {
            if (!video || video.id == null) continue;
            const streams = streamList(video);
            if (!streams.length) continue;
            const id = String(video.id);
            if (byEpisode.has(id)) continue;
            byEpisode.set(id, streams.map((item) => Object.assign({}, item)));
        }
    }
    return byEpisode;
}

module.exports = {
    fullCatalogRefresh,
    streamUrlIsReusable,
    indexPublishedStreams
};
