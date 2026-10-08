const utils = require("./utilities.js");
const {fetchData, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    KAN88_POCASTS_URL,
    SCRAPER_CONFIG,
    KAN_BASE_URL,
    HEADERS
} = require("./constants.js");
const BaseScraper = require("./BaseScraper.js");
const {
    readLastPageNumber,
    pageUrls,
    collectCards,
    parseSeriesCard,
    parseEpisodeCard
} = require("./kan88Parse.js");
const SUB_PREFIX = "kan88";
// The addon catalog lists subtype "8" and also accepts "kan88" and "88".
// The Supabase scraper key stays "kan88". Series ids stay il_kan_kan88_*.
const CATALOG_SUBTYPE = "8";

const log4js = require("log4js");
var logger = log4js.getLogger("Kan88Scraper");

class Kan88Scraper extends BaseScraper {

    constructor() {
        // Initialize BaseScraper with the scraper name
        super('Kan88', { exportFilename: "stremio-kan88", databaseKey: 'kan88' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize Kan88-specific properties
        this._kanPodcastsJSONObj = {};
        this.seriesIdIterator = 11000;
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        await this.crawlKan88();
    }

    /**
     * kan.org.il answers plain HTTP clients with a Cloudflare challenge.
     * Playwright is the fetch path that currently returns the server-rendered lobby.
     */
    fetchKanPage(url) {
        return fetchData(url, false, {}, HEADERS, "playwright");
    }

    async crawlKan88(){
        logger.trace("crawlKan88 => Entering");
        const firstDoc = await this.fetchKanPage(KAN88_POCASTS_URL);
        if (!firstDoc) {
            throw new Error("Kan 88 lobby did not load (" + KAN88_POCASTS_URL + ")");
        }

        const lastPageNo = readLastPageNumber(firstDoc);
        const lobbyUrls = pageUrls(KAN88_POCASTS_URL, lastPageNo);
        var podcastsKan88SeriesElements = [...collectCards(firstDoc)];
        logger.info(`crawlKan88 => Lobby page 1/${lastPageNo}, ${podcastsKan88SeriesElements.length} cards`);

        for (let page = 2; page <= lastPageNo; page++) {
            const tempKanDoc = await this.fetchKanPage(lobbyUrls[page - 1]);
            if (!tempKanDoc) {
                throw new Error(
                    "Kan 88 lobby page " + page + " did not load (" + lobbyUrls[page - 1] + "). " +
                    "kan.org.il returns HTTP 403 from outside Israel, so a partial lobby is not published."
                );
            }
            const moreCards = collectCards(tempKanDoc);
            logger.info(`crawlKan88 => Lobby page ${page}/${lastPageNo}, ${moreCards.length} cards`);
            for (const podcast of moreCards) {
                podcastsKan88SeriesElements.push(podcast);
            }
        }

        // Deduplicate by link URL to prevent same podcasts from appearing twice across pages
        var seenLinks = new Set();
        var uniquePodcasts = [];
        for (var podcast of podcastsKan88SeriesElements) {
            var link = this.getPodcastLink(podcast);
            if (!seenLinks.has(link)) {
                seenLinks.add(link);
                uniquePodcasts.push(podcast);
            } else {
                logger.debug("crawlKan88 => Skipping duplicate podcast: " + link);
            }
        }
        podcastsKan88SeriesElements = uniquePodcasts;

        // Process podcasts using batch processor
        logger.info(`crawlKan88 => Found ${podcastsKan88SeriesElements.length} Kan 88 podcasts to process`);
        await this.processBatch(
            podcastsKan88SeriesElements,
            async (podcastElement, index) => {
                return await this.processOnePodcast(podcastElement);
            },
            "kan88-podcasts"
        );

        logger.trace("crawlKan88 => Exiting");
    }

    /**
     * Process a single Kan 88 podcast (extracted from crawlKan88 for batch processing)
     */
    async processOnePodcast(podcastKan88SeriesElement) {
        const parsedSeries = parseSeriesCard(podcastKan88SeriesElement);
        var podcastLink = parsedSeries.link;
        if (!podcastLink) {
            logger.warn("processOnePodcast => Card has no link, skipping");
            return null;
        }
        var genres = ["music","מוסיקה"];

        //set ID
        var id = utils.generateSeriesId(podcastLink, SUB_PREFIX);

        //set thumbnail image
        var podcastImageUrl = parsedSeries.imageSrc
            ? utils.getImageFromUrl(parsedSeries.imageSrc, "p")
            : "";

        //set title;
        var seriesTitle = parsedSeries.title;

        //set description
        var seriesDescription = parsedSeries.description;

        // Incremental scraping: check if we should scrape this series
        if (this.isIncrementalMode()) {
            const shouldScrape = await this.shouldScrapeSeriesQuickCheck(id, seriesTitle, podcastLink);
            if (!shouldScrape) {
                logger.debug(`processOnePodcast => Skipping unchanged series: ${seriesTitle}`);
                return null;
            }
        }

        // Use base class method to add to JSON
        this.addToJsonObject(id,seriesTitle,podcastLink,podcastImageUrl,seriesDescription,genres,[],CATALOG_SUBTYPE,"Podcasts");
        const episodeCount = await this.getpodcastEpisodeVideos(podcastLink, id);

        // Update state after successful processing
        if (this.isIncrementalMode() && episodeCount > 0) {
            const stateData = {
                name: seriesTitle,
                description: seriesDescription,
                poster: podcastImageUrl,
                videoCount: episodeCount
            };
            await this.updateSeriesState(id, stateData, 'SCRAPE');
        }

        logger.debug("processOnePodcast => Added Kan 88 podcast " + seriesTitle);
        return { id, seriesTitle, episodeCount };
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
        const config = { forceRefreshDays: 3 }; // Kan88 specific
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

    getPodcastTitle(podcastElement, seriesTempTitle){
        var seriesTitle = ""
        if (podcastElement.getAttribute("title") != undefined){
            seriesTitle = podcastElement.getAttribute("title").trim();
        } else { //Kan 88 Podcast episodes
            seriesTitle = seriesTempTitle;
        }

        seriesTitle = seriesTitle.replace("כאן 88 הסכתים - ","");
        seriesTitle = seriesTitle.replace(".כאן 88","");

        return seriesTitle;
    }

    getPodcastLink(podcastElement){
        var podcastSeriesLink = "";
        if (podcastElement.getAttribute("href") != null){
            podcastSeriesLink = podcastElement.getAttribute("href");
        } else{
            var podcastAnchorElem = podcastElement.querySelector("a");
            podcastSeriesLink = podcastAnchorElem.getAttribute("href");
        }
        return podcastSeriesLink;
    }

    async getpodcastEpisodeVideos(podcastSeriesLink, id){
        logger.trace("getpodcastEpisodeVideos => Entering");

        const firstDoc = await this.fetchKanPage(podcastSeriesLink);
        if (!firstDoc) {
            logger.warn("getpodcastEpisodeVideos => No page for " + podcastSeriesLink);
            return 0;
        }

        // A series page with no "Last page" item is a single page. The previous
        // loop `continue`d before fetching page 2, so multi-page series were truncated.
        const lastPageNo = readLastPageNumber(firstDoc);
        const urls = pageUrls(podcastSeriesLink, lastPageNo);
        logger.debug("getpodcastEpisodeVideos => podcast ID: " + id + " pages: " + lastPageNo);

        const podcastEpisodes = [];
        const seenLinks = new Set();
        const seriesLink = String(podcastSeriesLink || "").replace(/\/$/, "");

        for (let page = 1; page <= lastPageNo; page++) {
            const doc = page === 1 ? firstDoc : await this.fetchKanPage(urls[page - 1]);
            if (!doc) {
                logger.warn(`getpodcastEpisodeVideos => Page ${page} did not load for ${podcastSeriesLink}`);
                continue;
            }

            let added = 0;
            for (const card of collectCards(doc)) {
                const episode = parseEpisodeCard(card);
                if (!episode || !episode.episodeLink) continue;
                const normalized = episode.episodeLink.replace(/\/$/, "");
                if (normalized === seriesLink || seenLinks.has(normalized)) continue;
                seenLinks.add(normalized);
                added++;

                // ON-DEMAND RESOLUTION: Don't fetch the episode page. The addon
                // resolves the stream from episodeLink when the user presses play.
                podcastEpisodes.push({
                    episode: card,
                    stream: [],
                    _preProcessed: true,
                    _title: episode.title,
                    _description: episode.description,
                    _imageUrl: episode.imageSrc ? utils.getImageFromUrl(episode.imageSrc, "p") : "",
                    _released: episode.released,
                    _episodeLink: episode.episodeLink
                });
                logger.debug("getpodcastEpisodeVideos => Found episode (on-demand): " + episode.title);
            }

            if (page > 1 && added === 0) {
                logger.warn(`getpodcastEpisodeVideos => Page ${page} added no episodes. Stopping.`);
                break;
            }
        }

        // Prepare episode data with numbering (episodes are numbered in reverse order)
        const episodeDataArray = podcastEpisodes.map((podcastEpisode, index) => ({
            ...podcastEpisode,
            episodeNo: podcastEpisodes.length - index
        }));

        // Process episodes using batch processor
        logger.info(`getpodcastEpisodeVideos => Processing ${episodeDataArray.length} episodes for podcast ID: ${id}`);
        await this.processBatch(
            episodeDataArray,
            async (episodeData, index) => {
                return await this.processOneKan88Episode(episodeData, id);
            },
            "kan88-episodes"
        );

        logger.trace("getpodcastEpisodeVideos => Exiting");
        return podcastEpisodes.length; // Return episode count for state tracking
    }

    /**
     * Process a single Kan 88 podcast episode (extracted from getpodcastEpisodeVideos for batch processing)
     */
    async processOneKan88Episode(episodeData, id) {
        const { episode: episodeElement, stream: streams, episodeNo, _preProcessed, _title, _description, _imageUrl, _released, _episodeLink } = episodeData;

        // Handle pre-processed episodes (new Kan88 structure with button.btn-play)
        if (_preProcessed) {
            var episodeLink = _episodeLink || ""; // Use pre-extracted link
            if (!episodeLink) {
                var episodes_body = episodeElement.querySelector("a.card-body");
                if (episodes_body != undefined){
                    episodeLink = episodes_body.getAttribute("href");
                }
            }
            if (!episodeLink) {
                logger.debug("processOneKan88Episode => No episode link found, skipping. Link");
                return null;
            }

            var episodeId = id + ":1:" + episodeNo;
            this.addVideoToMeta(id, episodeId, _title, "1", episodeNo, _description, _imageUrl, episodeLink, _released, streams);
            logger.debug("processOneKan88Episode => Added pre-processed episode: " + episodeId);

            return { episodeId, episodeTitle: _title };
        }

        // Original processing for old structure
        var episodeLink = "";
        var episodes_media = episodeElement.querySelector("a.card-img.card-media")
        if (episodes_media != undefined){
            var episodeLinkElem = episodeElement.querySelector("a.card-img.card-media")
            episodeLink = episodeLinkElem.getAttribute("href");
        } else {
            var episodes_body = episodeElement.querySelector("a.card-body")
            if (episodes_body != undefined){
                episodeLink = episodes_body.getAttribute("href");
                logger.debug("processOneKan88Episode => href card image empty. Using card href");
            } else {
                logger.debug("processOneKan88Episode => No episode link found, skipping. Link");
                return null;
            }
        }

        var titleElem = episodeElement.querySelector("h2.card-title, h3.card-title, h2.title, h3.title, div.card-title");
        var episodeTitle = titleElem ? titleElem.text.trim() : "Unknown Episode";
        episodeTitle = episodeTitle.replace(/^פרק \d+:/, '').trim();

        var episodeImgUrl = "";
        if (episodeElement.querySelector("img.img-full") != null){
            episodeImgUrl = utils.getImageFromUrl(episodeElement.querySelector("img.img-full").getAttribute("src"), "p");
        }
        logger.debug("processOneKan88Episode => episodeImgUrl" + episodeImgUrl + " Name: " + episodeTitle);

        var episodeDescription = episodeElement.querySelector("div.description").text.trim();
        var released = "";
        if (episodeElement.querySelector("li.date-local") != undefined){
            let tempDate = episodeElement.querySelector("li.date-local").getAttribute("data-date-utc").trim();
            const date = new Date(tempDate);
            released = isNaN(date.getTime()) ? "" : date.toISOString();
        }
        logger.debug("processOneKan88Episode => Calling streams with URL: " + episodeLink + " for episode: " + episodeTitle + " released: " + released);
        var episodeId = id + ":1:" + episodeNo;
        this.addVideoToMeta(id, episodeId, episodeTitle, "1", episodeNo, episodeDescription, episodeImgUrl, episodeLink, released, streams);
        logger.debug("processOneKan88Episode => Added episode: " + episodeId);

        return { episodeId, episodeTitle };
    }

    getPodcastStream(streamElement){
        logger.trace("getPodcastStream => Entering");
        var episodeName = "";
        if (streamElement.querySelector("h2.title") != undefined){
            //episodeName = streamElement.querySelector("h2.title").text.trim();
            episodeName = streamElement.querySelector("h2.title").text.trim();
            episodeName = episodeName.replace(/^פרק \d+:/, '').trim();
        } else {
            logger.debug("getPodcastStreams => No name for the episode !");
        }
        var description = "";
        if (streamElement.querySelector("div.item-content.hide-content") != null) {
            description = streamElement.querySelector("div.item-content.hide-content").text.trim();
        }else {
            logger.debug("getPodcastStreams => No description for the episode !");
        }
        var urlRawElem = streamElement.querySelector("button.btn-play");
        var urlRaw
        if (urlRawElem != undefined ){
            urlRaw = urlRawElem.getAttribute("data-player-src");
            urlRaw = urlRaw.trim();
        }
        if ((urlRaw == undefined) ||(urlRaw.length == 0)){
            return streams;
        }
        var url = urlRaw.substring(0,urlRaw.indexOf("?"));
        logger.debug("getPodcastStreams => Podcast stream name: " + episodeName + " description: " + description);

        var streams = [
            {
                url: url,
                type: "Podcast",
                name: episodeName,
                description: description
            }
        ];

        logger.trace("getPodcastStream => Exiting");
        return streams;

    }
}

/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = Kan88Scraper;
