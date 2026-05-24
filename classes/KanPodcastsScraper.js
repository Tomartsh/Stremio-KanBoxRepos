const utils = require("./utilities.js");
const {fetchData, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    PODCASTS,
    KAN_BASE_URL,
    SCRAPER_CONFIG
} = require("./constants.js");
const BaseScraper = require("./BaseScraper.js");

const log4js = require("log4js");
var logger = log4js.getLogger("KanPodcastsScraper");

class KanPodcastsScraper extends BaseScraper {

    constructor() {
        // Initialize BaseScraper with the scraper name
        super('KanPodcasts', { exportFilename: "stremio-kanpodcasts", databaseKey: 'kanpodcasts' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize KanPodcasts-specific properties
        this._kanPodcastsJSONObj = {};
    }

    /**
     * Quick check for incremental mode - fetches only first page to decide if scraping is needed
     */
    async shouldScrapeSeriesQuickCheck(seriesId, title, pageUrl) {
        const state = this.getStateManager()?.getSeriesState(seriesId);
        if (!state) {
            logger.debug(`shouldScrapeSeriesQuickCheck => New series (no state): ${title}`);
            return true; // New series, always scrape
        }

        // Check if past force refresh period
        const config = { forceRefreshDays: 3 }; // KanPodcasts specific
        const daysSinceScrape = (Date.now() - new Date(state.last_scraped_at).getTime()) / (1000 * 60 * 60 * 24);
        if (daysSinceScrape > config.forceRefreshDays) {
            logger.debug(`shouldScrapeSeriesQuickCheck => ${title} past refresh threshold (${daysSinceScrape.toFixed(1)} days), will scrape`);
            return true;
        }

        try {
            // Fetch first page to get latest episode info
            const firstPageDoc = await fetchData(pageUrl, false);
            if (!firstPageDoc) {
                logger.warn(`shouldScrapeSeriesQuickCheck => Could not fetch page for ${title}, will scrape`);
                return true;
            }

            // Get first episode (latest)
            const firstEpisodeElem = firstPageDoc.querySelector("div.card.card-row");
            if (!firstEpisodeElem) {
                logger.debug(`shouldScrapeSeriesQuickCheck => No episodes found for ${title}, will scrape`);
                return true;
            }

            // Extract episode link for comparison
            const episodeLinkElem = firstEpisodeElem.querySelector("a.card-body");
            const episodeLink = episodeLinkElem?.getAttribute("href") || "";
            const fullEpisodeLink = episodeLink.startsWith("/") ? KAN_BASE_URL + episodeLink : episodeLink;

            // Compare with stored last_episode_id
            if (state.last_episode_id && state.last_episode_id === fullEpisodeLink) {
                logger.debug(`shouldScrapeSeriesQuickCheck => Latest episode unchanged for ${title}, skipping`);
                // Update the skip timestamp in state
                await this.updateSeriesState(seriesId, { name: title }, 'SKIP', 'Latest episode unchanged');
                return false;
            }

            logger.debug(`shouldScrapeSeriesQuickCheck => Latest episode changed for ${title} (was: ${state.last_episode_id}, now: ${fullEpisodeLink})`);
            return true;
        } catch (error) {
            logger.warn(`shouldScrapeSeriesQuickCheck => Error checking ${title}: ${error.message}, will scrape`);
            return true;
        }
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        // Crawl regular podcasts
        await this.crawlPodcasts(PODCASTS.KAN_CATEGORIES, "p", "Podcasts");

        // Crawl kids podcasts (commented out in original)
        //await this.crawlPodcasts(PODCASTS.KAN_CHILDREN_CATEGORIES, "h", "Podcasts");
    }

    /**
     * Main method:
     * 1. Fetch all podcast series from mobile JSON API (paged).
     * 2. For each series, fetch its episodes (JSON, same API family).
     * 3. Build Stremio‑ready structure in memory.
     *
     * @param {string} categoryId - The category ID to fetch (regular or kids)
     * @param {string} subType - The subtype identifier ("p" for regular, "h" for kids)
     * @param {string} type - The content type (usually "series")
     */
    async crawlPodcasts(categoryId, subType, type){
        logger.trace(`crawlPodcasts => Entering (category: ${categoryId}, subType: ${subType})`);
        logger.debug(`crawlPodcasts => Fetching podcast series list for category ${categoryId}...`);

        let seriesList;

        try {
            seriesList = await this.getAllSeries(categoryId);
            logger.debug(`crawlPodcasts => Found ${seriesList.length} series.`);
        } catch (error) {
            logger.error(`crawlPodcasts => Error cannot get series list for category ${categoryId}:`, error);
            return;
        }

        if (!Array.isArray(seriesList) || seriesList.length === 0) {
            logger.warn(`crawlPodcasts => No series returned from mobile API for category ${categoryId}`);
            return;
        }

        // Filter out invalid series before processing
        const validSeriesList = seriesList.filter(series => {
            const pageUrl = series.link?.href?.replace('?app=true', '') || '';
            return series.id && !pageUrl.includes("kan88");
        });

        logger.info(`crawlPodcasts => Processing ${validSeriesList.length} valid series (filtered ${seriesList.length - validSeriesList.length})`);

        // Process series using batch processor
        await this.processBatch(
            validSeriesList,
            async (series) => {
                return await this.processOneSeries(series, subType, type);
            },
            `podcast-series (${subType})`
        );

        logger.trace(`crawlPodcasts => Exiting (category: ${categoryId})`);
    }

    /**
     * Process a single podcast series (extracted from crawlPodcasts for batch processing)
     */
    async processOneSeries(series, subType, type) {
        const pageUrl = series.link?.href?.replace('?app=true', '') || '';
        const programId = series.id;
        const title = series.title;
        const description = series.description || "";

        // Generate numerical series ID using the utility function
        const stremioId = utils.generateSeriesId(pageUrl, PODCASTS.SUBPREFIX, "0");
        const podcastImageUrl = series.media_group?.[0]?.media_item?.[0]?.src || "";

        logger.debug(`processOneSeries => Processing: ${title} (OriginalID: ${programId}, StremioID: ${stremioId})`);

        // In incremental mode, do a quick check first
        if (this.isIncrementalMode()) {
            const shouldScrape = await this.shouldScrapeSeriesQuickCheck(stremioId, title, pageUrl);
            if (!shouldScrape) {
                logger.debug(`processOneSeries => Skipping unchanged series: ${title}`);
                return null;
            }
        }

        try {
            const episodes = await this.getEpisodes(programId, pageUrl);

            if (episodes.length > 0) {
                logger.debug(`processOneSeries => Found ${episodes.length} episodes for ${title}`);

                // Convert episodes to videos format expected by Stremio
                // Episode numbering: newest episode = highest number
                // Streams are empty - resolved on-demand by the addon
                const videosList = episodes.map((ep, index) => {
                    const episodeNo = episodes.length - index;
                    const episodeId = `${stremioId}:1:${episodeNo}`;

                    // Create unique title: include episode number to avoid duplicates
                    // If original title already includes "Episode X", prepend the number
                    // Otherwise, add "Episode X" prefix
                    let uniqueTitle = ep.title;
                    if (!uniqueTitle.match(/^פרק \d+/)) {
                        uniqueTitle = `פרק ${episodeNo}: ${uniqueTitle}`;
                    }

                    return {
                        id: episodeId,
                        title: uniqueTitle,
                        name: uniqueTitle,
                        season: 1,
                        episode: episodeNo,
                        description: ep.description,
                        thumbnail: ep.thumbnail,
                        released: ep.released,
                        episodeLink: ep.episodeLink,
                        streams: [] // Resolved on-demand by the addon
                    };
                });

                this.addToJsonObject(
                    stremioId,
                    title,
                    pageUrl,
                    podcastImageUrl,
                    description,
                    [],
                    videosList,
                    subType,
                    type
                );

                // Update state after successful processing
                const latestEpisode = episodes[0]; // Sorted newest first
                const stateData = {
                    name: title,
                    description: description,
                    poster: podcastImageUrl,
                    videoCount: episodes.length,
                    latestEpisodeDate: latestEpisode?.released || null,
                    lastEpisodeId: latestEpisode?.episodeLink || null
                };
                await this.updateSeriesState(stremioId, stateData, 'SCRAPE');

                return { stremioId, title, episodeCount: episodes.length };
            } else {
                logger.warn(`processOneSeries => No episodes found for ${title}`);
                return null;
            }
        } catch (error) {
            logger.error(`processOneSeries => Error processing ${title}:`, error.message);
            return null;
        }
    }

    /**
    * Replicates GetRadioSeriesList logic: fetches all series entries.
    * Uses chunks of 200 as seen in the Python code.
    */
    async getAllSeries(categoryId) {
        let allEntries = [];
        let from = 1;
        let hasMore = true;
        const chunkSize = 200;

        logger.info(`getAllSeries => Starting fetch for category ${categoryId}`);

        while (hasMore) {
            logger.debug(`getAllSeries => Fetching from=${from}`);

            const response = await fetchData(PODCASTS.BASE_MOB_API, true,
                { id: categoryId, from: from },
                { 'User-Agent': PODCASTS.USER_AGENT }
            );

            if (!response) {
                logger.warn("getAllSeries => Null response, stopping pagination");
                break;
            }

            const entries = response.entry || [];

            if (!Array.isArray(entries) || entries.length === 0) {
                logger.debug("getAllSeries => No more entries, stopping");
                hasMore = false;
                break;
            }

            logger.debug(`getAllSeries => Got ${entries.length} entries in this batch`);

            // Filter out duplicates based on ID before adding
            const newEntries = entries.filter(entry =>
                !allEntries.some(existing => existing.id === entry.id)
            );

            logger.debug(`getAllSeries => ${newEntries.length} new unique entries (filtered ${entries.length - newEntries.length} duplicates)`);

            allEntries = allEntries.concat(newEntries);

            // Stop if we got fewer entries than chunk size (last page)
            if (entries.length < chunkSize) {
                logger.debug(`getAllSeries => Last page reached (got ${entries.length} < ${chunkSize})`);
                hasMore = false;
            } else {
                from += chunkSize;
            }
        }

        logger.info(`getAllSeries => Accumulated ${allEntries.length} unique series entries for category ${categoryId}`);
        return allEntries;
    }

    /**
     * getEpisodes: Scrape HTML page with pagination support
     * NOTE: Kan website uses JavaScript for pagination, so raw HTTP requests
     * may return duplicate content. We detect and handle this by tracking unique episodes.
     */
    async getEpisodes(programId, pageUrl = null) {
        logger.trace(`getEpisodes => Entering (programId=${programId}, pageUrl=${pageUrl})`);

        if (!pageUrl) {
            logger.warn(`getEpisodes => No pageUrl provided, cannot fetch episodes`);
            return [];
        }

        logger.debug(`getEpisodes => Scraping episodes from: ${pageUrl}`);

        try {
            const allEpisodes = [];
            const seenEpisodeLinks = new Set(); // Track unique episodes to detect duplicates

            // STEP 1: Fetch first page and detect total pages
            const firstPageDoc = await fetchData(pageUrl, false);
            if (!firstPageDoc) {
                logger.error(`getEpisodes => Could not fetch first page: ${pageUrl}`);
                return [];
            }

            // Detect total number of pages
            const lastPageElement = firstPageDoc.querySelector('li[class*="pagination-page__item"][title*="Last page"]');
            const totalPages = lastPageElement ? parseInt(lastPageElement.getAttribute('data-num')) : 1;

            logger.debug(`getEpisodes => Detected ${totalPages} pages for podcast`);

            // Safety limit: Kan podcasts rarely have more than 50 actual pages of unique content
            // If pagination claims more, it's likely a JS-rendered pagination bug
            const maxPages = Math.min(totalPages, 100);

            // STEP 2: Parse all pages
            for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
                logger.debug(`getEpisodes => Parsing page ${pageNum}/${maxPages}`);

                let pageDoc = firstPageDoc;

                // Fetch additional pages (skip first page as we already have it)
                if (pageNum > 1) {
                    const pageUrl_withParams = `${pageUrl}?page=${pageNum}`;
                    logger.trace(`getEpisodes => Fetching: ${pageUrl_withParams}`);

                    pageDoc = await fetchData(pageUrl_withParams, false);
                    if (!pageDoc) {
                        logger.warn(`getEpisodes => Could not fetch page ${pageNum}, skipping`);
                        continue;
                    }
                }

                // Parse episodes on this page
                const episodeElements = pageDoc.querySelectorAll("div.card.card-row");
                logger.debug(`getEpisodes => Found ${episodeElements.length} episodes on page ${pageNum}`);

                let newEpisodesOnPage = 0;
                let duplicateEpisodesOnPage = 0;

                for (const episodeElem of episodeElements) {
                    try {
                        const episode = await this.parseEpisodeElement(episodeElem, programId);
                        if (episode) {
                            // Check if this episode is already in our list (by episodeLink)
                            if (seenEpisodeLinks.has(episode.episodeLink)) {
                                duplicateEpisodesOnPage++;
                                logger.trace(`getEpisodes => Skipping duplicate episode: ${episode.title}`);
                                continue;
                            }

                            seenEpisodeLinks.add(episode.episodeLink);
                            allEpisodes.push(episode);
                            newEpisodesOnPage++;
                            logger.trace(`Added: ${episode.title}`);
                        }
                    } catch (error) {
                        logger.warn(`getEpisodes => Error parsing episode element:`, error.message);
                    }
                }

                logger.debug(`getEpisodes => Page ${pageNum}: ${newEpisodesOnPage} new, ${duplicateEpisodesOnPage} duplicates`);

                // If this page has NO new episodes (all duplicates), pagination is broken
                // or we've reached the end. Stop pagination.
                if (pageNum > 1 && newEpisodesOnPage === 0 && duplicateEpisodesOnPage > 0) {
                    logger.warn(`getEpisodes => Page ${pageNum} has no new episodes (all duplicates). Stopping pagination early.`);
                    break;
                }

                // If we've seen more than 100 consecutive pages with NO new episodes, something is wrong
                // This handles cases where the pagination element claims many pages but content repeats
                if (pageNum > 10 && newEpisodesOnPage === 0) {
                    logger.warn(`getEpisodes => No new episodes for multiple pages. Stopping pagination.`);
                    break;
                }
            }

            logger.info(`getEpisodes => Successfully parsed ${allEpisodes.length} unique episodes`);

            // Sort episodes by release date (newest first)
            allEpisodes.sort((a, b) => {
                const dateA = a.released ? new Date(a.released).getTime() : 0;
                const dateB = b.released ? new Date(b.released).getTime() : 0;
                return dateB - dateA; // Descending (newest first)
            });

            logger.debug(`getEpisodes => Episodes sorted by release date (newest first)`);
            return allEpisodes;

        } catch (error) {
            logger.error(`getEpisodes => Error:`, error.message);
            return [];
        }
    }

    /**
     * Parse a single episode card element
     * NOTE: Stream URLs are NOT fetched during scraping to avoid Cloudflare rate limiting.
     * The episodeLink is stored and streams are resolved on-demand when user plays.
     */
    async parseEpisodeElement(episodeElem, programId) {
        logger.trace(`parseEpisodeElement => Parsing episode element`);

        try {
            // Extract episode link
            const episodeLinkElem = episodeElem.querySelector("a.card-body");
            if (!episodeLinkElem) {
                logger.debug(`parseEpisodeElement => No card-body link found`);
                return null;
            }

            let episodeLink = episodeLinkElem.getAttribute("href");
            if (!episodeLink) {
                logger.debug(`parseEpisodeElement => No href found`);
                return null;
            }

            // Make link absolute
            if (episodeLink.startsWith("/")) {
                episodeLink = KAN_BASE_URL + episodeLink;
            }

            // Extract title - titles are in h3 elements
            const titleElem = episodeElem.querySelector("h3");
            let episodeTitle = "Unknown";
            if (titleElem) {
                try {
                    // h3 contains title followed by description, extract just the title
                    const fullText = titleElem.text.trim();
                    // The title is usually the first line or first few words
                    // Look for common patterns to extract just the title
                    const lines = fullText.split('\n').map(l => l.trim()).filter(l => l);
                    if (lines.length > 0) {
                        // Take the first line as the title
                        episodeTitle = lines[0].replace(/^פרק \d+:\s*/, '').trim() || "Unknown";
                    } else {
                        episodeTitle = fullText.replace(/^פרק \d+:\s*/, '').trim() || "Unknown";
                    }
                } catch {
                    episodeTitle = "Unknown";
                }
            }

            // Extract image
            const imgElem = episodeElem.querySelector("img.img-full");
            const episodeImgUrl = imgElem
                ? utils.getImageFromUrl(imgElem.getAttribute("src"), "p")
                : "";

            // Extract description
            const descElem = episodeElem.querySelector("div.description");
            let episodeDescription = "";
            if (descElem) {
                try {
                    episodeDescription = descElem.text.trim();
                } catch {
                    episodeDescription = "";
                }
            }

            // Extract release date
            let released = "";
            const dateElem = episodeElem.querySelector("li.date-local");
            if (dateElem) {
                const dateUtc = dateElem.getAttribute("data-date-utc");
                if (dateUtc) {
                    const date = new Date(dateUtc);
                    released = isNaN(date.getTime()) ? "" : date.toISOString();
                }
            }

            // Store episodeLink for on-demand stream resolution (no fetch needed here)
            logger.debug(`parseEpisodeElement => ✓ ${episodeTitle} (stream on-demand from: ${episodeLink})`);

            return {
                title: episodeTitle,
                description: episodeDescription,
                thumbnail: episodeImgUrl,
                released: released,
                episodeLink: episodeLink,
                streamUrl: "" // Resolved on-demand by the addon
            };

        } catch (error) {
            logger.error(`parseEpisodeElement => Error:`, error.message);
            return null;
        }
    }
}

/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanPodcastsScraper;
