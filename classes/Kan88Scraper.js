const utils = require("./utilities.js");
const {fetchData, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    KAN88_POCASTS_URL,
    SCRAPER_CONFIG,
    KAN_BASE_URL
} = require("./constants.js");
const BaseScraper = require("./BaseScraper.js");
const SUB_PREFIX = "kan88";

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

    async crawlKan88(){
        logger.trace("crawlKan88 => Entering");
        var kan88Series = await fetchData(KAN88_POCASTS_URL);

        //get the last page of Kan 88 serise
        var lastPageNo = kan88Series.querySelector('li[class*="pagination-page__item"][title*="Last page"]').getAttribute('data-num')

        //first page is already retrieved. We need to continue from page 2 an on
        var podcastsKan88SeriesElements = kan88Series.querySelectorAll("div.card.card-row");

        for (var i = 1 ; i < lastPageNo ; i++ ){
            var tempKanDoc = await fetchData(KAN88_POCASTS_URL + "?page=" + (i + 1));
            var podcastsKan88AdditionalPageSeriesElements = tempKanDoc.querySelectorAll("div.card.card-row");
            for( var podcast of podcastsKan88AdditionalPageSeriesElements){
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
        var podcastLink = this.getPodcastLink(podcastKan88SeriesElement);
        var genres = ["music","מוסיקה"];

        //set ID
        var id = utils.generateSeriesId(podcastLink, SUB_PREFIX);

        //set thumbnail image
        var podcastImageUrl = "";
        podcastImageUrl = utils.getImageFromUrl(podcastKan88SeriesElement.querySelector("img.img-full").getAttribute("src"),"p");
        var imgElem = podcastKan88SeriesElement.querySelector("img.img-full");

        //set title;
        var seriesTitle = this.getPodcastTitle(podcastKan88SeriesElement, imgElem.getAttribute("title").trim());

        //set description
        var seriesDescription = "";
        if (podcastKan88SeriesElement.querySelector("div.overlay div.text") != undefined){
            seriesDescription = podcastKan88SeriesElement.querySelector("div.overlay div.text").text.trim();
        } else {
            seriesDescription = podcastKan88SeriesElement.querySelector("div.description").text.trim(); //Kan 88 Podcast episodes
        }

        // Incremental scraping: check if we should scrape this series
        if (this.isIncrementalMode()) {
            const shouldScrape = await this.shouldScrapeSeriesQuickCheck(id, seriesTitle, podcastLink);
            if (!shouldScrape) {
                logger.debug(`processOnePodcast => Skipping unchanged series: ${seriesTitle}`);
                return null;
            }
        }

        // Use base class method to add to JSON
        this.addToJsonObject(id,seriesTitle,podcastLink,podcastImageUrl,seriesDescription,genres,[],SUB_PREFIX,"Podcasts");
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

        var podcastSeriesPageDoc = await fetchData(podcastSeriesLink); //get the series episodes
        var lastPageNo = ''
        try {
            lastPageNo = podcastSeriesPageDoc.querySelector('li[class*="pagination-page__item"][title*="Last page"]').getAttribute('data-num');
        }catch{
            lastPageNo = String(podcastSeriesPageDoc.querySelectorAll('li[class*="pagination-page__item"]').length);
            //if(lastPageNo==='0'){return {}; }
            lastPageNo = 1;
            logger.trace("getpodcastEpisodeVideos => URL: " + podcastSeriesLink + " has only 1 page");
        }
        logger.debug("getpodcastEpisodeVideos => podcast ID: " + id + " last page number: " + lastPageNo);
        var podcastEpisodes = []; //list of podcast episodes
        var podcastEpisodesVideos = []; //list of processed video objects
        if ((lastPageNo) && (parseInt(lastPageNo) >= 0) ){
            var intLastPageNo = parseInt(lastPageNo);
            for (var i = 0 ; i < intLastPageNo ; i++){
                if (i == 0){
                    var podcastEpisodesToCheck = podcastSeriesPageDoc.querySelectorAll("div.card.card-row");
                    for (var episodeChecked of podcastEpisodesToCheck){
                        var hrefObj = episodeChecked.querySelector("a.card-body")
                        var episodeLink = hrefObj.getAttribute("href");

                        // ON-DEMAND RESOLUTION: Don't fetch episode page to avoid 403s
                        // Store episodeLink for addon to resolve stream on-demand
                        var episodeTitle = episodeChecked.querySelector("h2.card-title")?.textContent?.trim() || "Unknown Episode";
                        var episodeImgElem = episodeChecked.querySelector("img.img-full");
                        var episodeImgUrl = episodeImgElem ? utils.getImageFromUrl(episodeImgElem.getAttribute("src"), "p") : "";
                        var episodeDescElem = episodeChecked.querySelector("div.description");
                        var episodeDescription = episodeDescElem ? episodeDescElem.text.trim() : "";

                        // Extract release date from card
                        var released = "";
                        var dateElem = episodeChecked.querySelector("li.date-local, time");
                        if (dateElem) {
                            var dateUtc = dateElem.getAttribute("data-date-utc") || dateElem.getAttribute("datetime");
                            if (dateUtc) {
                                var date = new Date(dateUtc);
                                released = isNaN(date.getTime()) ? "" : date.toISOString();
                            }
                        }

                        logger.debug("getpodcastEpisodeVideos => Found episode (on-demand): " + episodeTitle);
                        podcastEpisodes.push({
                            episode: episodeChecked,
                            stream: [], // Empty - resolved on-demand by addon
                            _preProcessed: true,
                            _title: episodeTitle,
                            _description: episodeDescription,
                            _imageUrl: episodeImgUrl,
                            _released: released,
                            _episodeLink: episodeLink // Store for on-demand resolution
                        });
                    }
                    continue;
                logger.trace("getpodcastEpisodeVideos => calling fetchPage with URL: " + podcastSeriesLink + "?page=" + i);
                var podcastsAdditionalPages = await fetchData(podcastSeriesLink + "?page=" + i);
                var podcastElems = podcastsAdditionalPages.querySelectorAll("div.card.card-row");

                for (var additionalPodcast of podcastElems){
                    var hrefObj = additionalPodcast.querySelector("a.card-body")
                    var episodeLink = hrefObj.getAttribute("href");

                    // ON-DEMAND RESOLUTION: Don't fetch episode page to avoid 403s
                    var episodeTitle = additionalPodcast.querySelector("h2.card-title")?.textContent?.trim() || "Unknown Episode";
                    var episodeImgElem = additionalPodcast.querySelector("img.img-full");
                    var episodeImgUrl = episodeImgElem ? utils.getImageFromUrl(episodeImgElem.getAttribute("src"), "p") : "";
                    var episodeDescElem = additionalPodcast.querySelector("div.description");
                    var episodeDescription = episodeDescElem ? episodeDescElem.text.trim() : "";

                    // Extract release date from card
                    var released = "";
                    var dateElem = additionalPodcast.querySelector("li.date-local, time");
                    if (dateElem) {
                        var dateUtc = dateElem.getAttribute("data-date-utc") || dateElem.getAttribute("datetime");
                        if (dateUtc) {
                            var date = new Date(dateUtc);
                            released = isNaN(date.getTime()) ? "" : date.toISOString();
                        }
                    }

                    logger.debug("getpodcastEpisodeVideos => Found episode (on-demand): " + episodeTitle);
                    podcastEpisodes.push({
                        episode: additionalPodcast,
                        stream: [], // Empty - resolved on-demand by addon
                        _preProcessed: true,
                        _title: episodeTitle,
                        _description: episodeDescription,
                        _imageUrl: episodeImgUrl,
                        _released: released,
                        _episodeLink: episodeLink
                    });
                }
                }
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

        var episodeTitle = episodeElement.querySelector("h2.card-title").text.trim();
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
