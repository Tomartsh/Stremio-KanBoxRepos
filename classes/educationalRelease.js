/**
 * Release dates for Kan kids and Kan teens episodes.
 *
 * Reliability, from pages fetched on 2026-11-18 (kids and teens, including
 * YouTube embeds):
 *
 * 1. The episode page's `.date-local` / `data-date-utc` value is the date the
 *    site shows. It is an Israel wall time (often 21:00 or 22:00, the
 *    broadcast slot). This is the air or publish date.
 * 2. A JSON-LD `datePublished` that is not the VideoObject `uploadDate` is a
 *    date-only echo of that day, sometimes shifted by the +02:00 midnight
 *    encoding. `uploadDate` and `<meta property="datePublished">` are the CMS
 *    upload, frequently a 2023 bulk import for older shows.
 * 3. `og:published_time` matches a later page edit. Sitemap `<lastmod>` is
 *    the same kind of stamp: on the live kids sitemap most episodes share
 *    2025-09-12 or 2025-09-23, not their air date. HLS manifests are not
 *    readable from this network, and they are not needed when the page
 *    already has `.date-local`.
 *
 * Fallback when this run did not read the episode HTML (a reused stream):
 * the previously published `released`, then that sitemap lastmod, then the
 * first-seen stamp. The stamp is the run time the first time a video has no
 * other date, and the published value on every later run.
 */

const FETCHED = Symbol("educationalFetched");
const ISRAEL = "Asia/Jerusalem";

function toIso(value) {
    if (value == null) return "";
    const text = String(value).trim();
    if (!text) return "";
    const time = Date.parse(text);
    if (Number.isNaN(time)) return "";
    return new Date(time).toISOString();
}

function firstFilled() {
    for (let i = 0; i < arguments.length; i++) {
        const iso = toIso(arguments[i]);
        if (iso) return iso;
    }
    return "";
}

function zoneOffsetMs(utcMs, timeZone) {
    const dtf = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit"
    });
    const parts = {};
    for (const part of dtf.formatToParts(new Date(utcMs))) {
        if (part.type !== "literal") parts[part.type] = part.value;
    }
    let hour = Number(parts.hour);
    if (hour === 24) hour = 0;
    const asUtc = Date.UTC(
        Number(parts.year),
        Number(parts.month) - 1,
        Number(parts.day),
        hour,
        Number(parts.minute),
        Number(parts.second)
    );
    return asUtc - utcMs;
}

/**
 * Israel wall time from a kids/teens `.date-local` attribute.
 * "27.6.2021 21:00:00" is 21:00 in Asia/Jerusalem, not UTC and not the
 * server's local zone.
 * @param {string} value
 * @returns {string}
 */
function israelWallTimeToIso(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    const wall = text.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
    if (!wall) {
        if (/[T+]/.test(text) || /Z$/i.test(text)) return toIso(text);
        return "";
    }
    const day = Number(wall[1]);
    const month = Number(wall[2]);
    const year = Number(wall[3]);
    const hour = wall[4] != null ? Number(wall[4]) : 0;
    const minute = wall[5] != null ? Number(wall[5]) : 0;
    const second = wall[6] != null ? Number(wall[6]) : 0;
    if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return "";
    const wanted = Date.UTC(year, month - 1, day, hour, minute, second);
    let utc = wanted;
    for (let pass = 0; pass < 2; pass++) {
        utc = wanted - zoneOffsetMs(utc, ISRAEL);
    }
    const date = new Date(utc);
    if (Number.isNaN(date.getTime())) return "";
    return date.toISOString();
}

function scriptBody(script) {
    if (!script) return "";
    if (script.text != null && String(script.text).trim()) return String(script.text);
    return String(script.innerHTML || script.toString() || "");
}

function jsonStringValues(text, field) {
    const values = [];
    const pattern = new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`, "g");
    let match;
    const source = String(text || "");
    while ((match = pattern.exec(source))) {
        try {
            values.push(JSON.parse(`"${match[1]}"`));
        } catch (error) {
            values.push(match[1]);
        }
    }
    return values;
}

function metaContent(doc, property) {
    if (!doc || typeof doc.querySelector !== "function") return "";
    const node = doc.querySelector(`meta[property="${property}"]`);
    if (!node || typeof node.getAttribute !== "function") return "";
    return String(node.getAttribute("content") || "").trim();
}

/**
 * Air or publish date from one kids/teens episode document.
 * `.date-local` wins. JSON-LD publish/upload is next. Open Graph
 * `published_time` is a page edit and is not used.
 * @param {object} doc
 * @returns {string}
 */
function releaseDateFromEducationalDocument(doc) {
    if (!doc || typeof doc.querySelector !== "function") return "";
    const local = doc.querySelector(".date-local, [data-date-utc]");
    if (local && typeof local.getAttribute === "function") {
        const air = israelWallTimeToIso(local.getAttribute("data-date-utc") || local.text || "");
        if (air) return air;
    }
    const published = [];
    const uploaded = [];
    if (typeof doc.querySelectorAll === "function") {
        doc.querySelectorAll("script").forEach((script) => {
            const text = scriptBody(script);
            if (!text) return;
            published.push(...jsonStringValues(text, "datePublished"));
            uploaded.push(...jsonStringValues(text, "uploadDate"));
        });
    }
    const uploadIso = uploaded.map(toIso).filter(Boolean);
    const publishedIso = published.map(toIso).filter(Boolean);
    const distinct = publishedIso.filter((iso) => uploadIso.indexOf(iso) === -1);
    const fromJson = distinct[0] || publishedIso[0] || uploadIso[0] || "";
    if (fromJson) return fromJson;
    return toIso(metaContent(doc, "datePublished"));
}

/**
 * @param {{pageDate?: string, publishedReleased?: string, sitemapLastmod?: string, firstSeen?: string, now?: string}} sources
 * @returns {string}
 */
function chooseEducationalReleased(sources) {
    const input = sources || {};
    return firstFilled(
        input.pageDate,
        input.publishedReleased,
        input.sitemapLastmod,
        input.firstSeen,
        input.now
    );
}

function educationalRunStamp(host) {
    if (!host) return new Date().toISOString();
    if (!host._educationalRunStamp) host._educationalRunStamp = new Date().toISOString();
    return host._educationalRunStamp;
}

function tagEducationalStream(stream, fetched) {
    if (!stream || typeof stream !== "object") return stream;
    const copy = Object.assign({}, stream);
    copy[FETCHED] = !!fetched;
    return copy;
}

function educationalStreamWasFetched(stream) {
    if (!stream || typeof stream !== "object") return true;
    if (!Object.prototype.hasOwnProperty.call(stream, FETCHED)) return true;
    return stream[FETCHED] !== false;
}

/**
 * Set `video.released` and align `video.streams[0].released` with it.
 * A reused stream does not contribute a page date. Its own `released` is
 * only a carried published value when the video row has none.
 * @param {object} video
 * @param {object|string|null} stream
 * @param {object} sources
 * @returns {object}
 */
function finalizeEducationalEpisode(video, stream, sources) {
    const input = sources || {};
    const fetched = educationalStreamWasFetched(stream);
    const usable = stream && typeof stream === "object" && stream.url ? Object.assign({}, stream) : null;
    if (usable) delete usable[FETCHED];
    const pageDate = fetched ? firstFilled(usable && usable.released, input.episodeDate) : "";
    const carried = firstFilled(input.publishedReleased, !fetched && usable && usable.released);
    const released = chooseEducationalReleased({
        pageDate,
        publishedReleased: carried,
        sitemapLastmod: input.sitemapLastmod,
        firstSeen: input.firstSeen,
        now: input.now
    });
    video.streams = usable ? [usable] : [];
    if (released) {
        video.released = released;
        if (usable) usable.released = released;
    }
    return video;
}

function latestEpisodeDate(videos) {
    let latest = null;
    for (const video of videos || []) {
        const iso = toIso(video && video.released);
        if (!iso) continue;
        const time = Date.parse(iso);
        if (latest == null || time > latest) latest = time;
    }
    return latest == null ? null : new Date(latest).toISOString();
}

/**
 * Series column for the bulk updater. Undefined leaves other scrapers'
 * rows unchanged. Null clears a kids/teens series that has no dates.
 * @param {string} scraper
 * @param {object[]} videos
 * @returns {string|null|undefined}
 */
function seriesLatestEpisodeDate(scraper, videos) {
    if (scraper !== "kankids" && scraper !== "kanteens") return undefined;
    return latestEpisodeDate(videos);
}

function countVideosMissingReleased(jsonObj) {
    let videos = 0;
    let missing = 0;
    const root = jsonObj && typeof jsonObj === "object" ? jsonObj : {};
    for (const series of Object.values(root)) {
        const list = series && series.meta && series.meta.videos;
        if (!Array.isArray(list)) continue;
        for (const video of list) {
            videos += 1;
            if (!toIso(video && video.released)) missing += 1;
        }
    }
    return { videos, missing };
}

function missingReleasedReport(scraperName, jsonObj) {
    const counts = countVideosMissingReleased(jsonObj);
    return {
        videos: counts.videos,
        missing: counts.missing,
        warn: counts.missing > 0,
        line: `${scraperName} => videos without released: ${counts.missing} of ${counts.videos}`
    };
}

module.exports = {
    israelWallTimeToIso,
    releaseDateFromEducationalDocument,
    chooseEducationalReleased,
    educationalRunStamp,
    tagEducationalStream,
    educationalStreamWasFetched,
    finalizeEducationalEpisode,
    latestEpisodeDate,
    seriesLatestEpisodeDate,
    countVideosMissingReleased,
    missingReleasedReport
};
