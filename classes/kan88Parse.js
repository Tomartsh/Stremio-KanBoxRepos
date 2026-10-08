/**
 * Pure HTML helpers for the Kan 88 podcast lobby and series pages.
 * The live pages are server-rendered `div.card.card-row` lists. A missing
 * "Last page" control means one page, not a failed scrape.
 */

function readLastPageNumber(doc) {
    if (!doc || typeof doc.querySelector !== "function") return 1;
    const last = doc.querySelector('li[class*="pagination-page__item"][title*="Last page"]');
    const num = parseInt(last && last.getAttribute("data-num"), 10);
    if (!Number.isFinite(num) || num < 1) return 1;
    return num;
}

function pageUrls(baseUrl, lastPage) {
    const urls = [];
    const total = Number.isFinite(lastPage) && lastPage > 0 ? lastPage : 1;
    for (let page = 1; page <= total; page++) {
        if (page === 1) {
            urls.push(baseUrl);
            continue;
        }
        const joiner = String(baseUrl).includes("?") ? "&" : "?";
        urls.push(`${baseUrl}${joiner}page=${page}`);
    }
    return urls;
}

function collectCards(doc) {
    if (!doc || typeof doc.querySelectorAll !== "function") return [];
    return doc.querySelectorAll("div.card.card-row");
}

function elementText(element) {
    if (!element) return "";
    const value = element.text != null ? element.text : element.textContent;
    return String(value || "").trim();
}

function cardHref(card) {
    if (!card) return "";
    const own = card.getAttribute && card.getAttribute("href");
    if (own) return own;
    const anchor = card.querySelector("a.card-body, a.card-img.card-media, a");
    return (anchor && anchor.getAttribute("href")) || "";
}

function cleanKan88Title(title) {
    return String(title || "")
        .replace("כאן 88 הסכתים - ", "")
        .replace(/\.כאן(?: 88)?$/, "")
        .replace(/^פרק \d+:/, "")
        .trim();
}

function parseSeriesCard(card) {
    const link = cardHref(card);
    const heading = card && card.querySelector("h2.card-title, h3.card-title, h2.title, h3.title, div.card-title");
    const image = card && card.querySelector("img.img-full");
    const imageTitle = image && image.getAttribute("title");
    const ownTitle = card && card.getAttribute && card.getAttribute("title");
    const title = cleanKan88Title(elementText(heading) || ownTitle || imageTitle || "");
    const overlay = card && card.querySelector("div.overlay div.text");
    const descriptionNode = card && card.querySelector("div.description");
    const description = elementText(overlay) || elementText(descriptionNode);
    return {
        link,
        title,
        description,
        imageSrc: (image && image.getAttribute("src")) || ""
    };
}

function parseEpisodeCard(card) {
    const body = card && card.querySelector("a.card-body");
    const media = card && card.querySelector("a.card-img.card-media");
    const episodeLink = (body && body.getAttribute("href")) || (media && media.getAttribute("href")) || "";
    if (!episodeLink) return null;

    const heading = card.querySelector("h2.card-title, h3.card-title, h2.title, h3.title, div.card-title");
    const image = card.querySelector("img.img-full");
    const descriptionNode = card.querySelector("div.description");
    let released = "";
    const dateElem = card.querySelector("li.date-local, time");
    if (dateElem) {
        const dateUtc = dateElem.getAttribute("data-date-utc") || dateElem.getAttribute("datetime");
        if (dateUtc) {
            const date = new Date(dateUtc);
            released = isNaN(date.getTime()) ? "" : date.toISOString();
        }
    }

    return {
        episodeLink,
        title: cleanKan88Title(elementText(heading) || "Unknown Episode"),
        description: elementText(descriptionNode),
        imageSrc: (image && image.getAttribute("src")) || "",
        released
    };
}

module.exports = {
    readLastPageNumber,
    pageUrls,
    collectCards,
    parseSeriesCard,
    parseEpisodeCard,
    cleanKan88Title
};
