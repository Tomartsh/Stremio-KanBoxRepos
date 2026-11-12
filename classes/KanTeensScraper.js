const utils = require("./utilities.js");
const {extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    HINUKHIT,
    SCRAPER_CONFIG
} = require("./constants.js");
const { safeExecute, extractLobbySeries, collectEducationalEpisodes, parseKanBoxCategorySeries } = require("./ScraperHelpers.js");
const BaseScraper = require("./BaseScraper.js");

const log4js = require("log4js");
var logger = log4js.getLogger("KanTeensScraper");

function kidsContentUrl(url) {
    const value = String(url || "");
    if (/^https?:\/\//i.test(value)) return value;
    return HINUKHIT.URL_KIDS_CONTENT_PREFIX + value;
}

function lobbySeriesName(series) {
    if (!series) return "";
    return series.Name || series.Title || series.ImageAlt || series.title || "";
}

class KanTeensScraper extends BaseScraper {

    constructor() {
        // Initialize BaseScraper with the scraper name
        super('KanTeens', { exportFilename: "stremio-kanteens", databaseKey: 'kanteens' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize KanTeens-specific properties
        this._kanTeenJSONObj = {};
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        await safeExecute(
            () => this.crawlTeens(),
            "crawlContent.crawlTeens",
            this.logger
        );

        await safeExecute(
            () => this.crawlKanBox(),
            "crawlContent.crawlKanBox",
            this.logger
        );
    }

    /****************************************************************
     *
     * Hinukhit functions
     *
     ****************************************************************/
    async crawlTeens(){
        logger.trace("crawlTeens => Entering");
        logger.debug("crawlTeens => Starting retrieval of Teens series");

        var subType = "n";
        var loaded = await this.fetchCatalogDocument(HINUKHIT.URL_TEENS);
        if (loaded.timeout) {
            this.noteListingIncomplete(HINUKHIT.URL_TEENS);
            return;
        }
        if (!loaded.doc) {
            throw new Error("Lobby page did not load");
        }
        var teensJsonArr = extractLobbySeries(loaded.doc);

        // Process teens series using batch processor
        logger.info(`crawlTeens => Found ${teensJsonArr.length} teens series to process`);
        await this.processBatch(
            teensJsonArr,
            async (series, index) => {
                return await this.processOneTeensSeries(series, subType);
            },
            "teens-series"
        );
    }

    /**
     * Process a single teens series (extracted from crawlTeens for batch processing)
     */
    async processOneTeensSeries(series, subType) {
        var imgUrl = utils.getImageFromUrl(series.Image, subType);

        var seriesPage = kidsContentUrl(series.Url);
        var genres = utils.setGenreFromString(series.Genres);
        var seriesName = lobbySeriesName(series);
        var id = this.seriesIdFor(seriesPage, HINUKHIT.SUBPREFIX_TEENS, seriesName);
        logger.debug(`processOneTeensSeries => seriesPage is ${series.Url}`);
        var loaded = await this.fetchCatalogDocument(seriesPage + "?currentPage=2&itemsToShow=500");
        if (!loaded.doc || typeof loaded.doc.querySelector !== "function") {
            if (loaded.timeout) {
                this.noteFailedSeries({ id, link: seriesPage, name: seriesName });
            } else {
                logger.warn(`processOneTeensSeries => Could not fetch page for ${series.Url}`);
            }
            return null;
        }
        var doc2 = loaded.doc;

        //set the series name
        var seriesTitle = this.getEducationalTitle(doc2);

        var seriesDescription = "";
        if (doc2.querySelector("meta[name=description]") != undefined){
            seriesDescription = doc2.querySelector("meta[name=description]").getAttribute("content").trim();
            seriesDescription = seriesDescription.replace("<p>","");
            seriesDescription = seriesDescription.replace("</p>","");
        } else {
            if (doc2.querySelector("div.info-description") != undefined){
                seriesDescription = doc2.querySelector("div.info-description").text.trim();
            }
        }
        seriesDescription = seriesDescription.replace("\r\n","").trim();
        seriesDescription = seriesDescription.trim();

        // Create a temporary videos array to collect episodes.
        // The series URL still carries currentPage/itemsToShow. The new row
        // ignores those params; collectEducationalEpisodes asks for the next
        // page only when the row is full and the next page has new episodes.
        const videosCollected = [];
        const episodes = await collectEducationalEpisodes(
            doc2,
            seriesPage + "?currentPage=2&itemsToShow=500",
            (url) => this.fetchEducationalDocument(url)
        );
        await this.getKidsVideos(episodes, id, subType, videosCollected);

        // Only add series to JSON if it has videos
        if (videosCollected.length === 0) {
            logger.warn(`processOneTeensSeries => Skipping "${seriesTitle}" - no episodes found (likely a single-page article)`);
            return null;
        }

        // Add series with collected videos
        this.addToJsonObject(id, seriesTitle,seriesPage,imgUrl,seriesDescription,genres,videosCollected,subType,"series");
        logger.debug(`processOneTeensSeries => Added teens series ${seriesTitle} with ${videosCollected.length} episodes`);
        return { id, seriesTitle };
    }

    /***********************************************************
     *
     * Kan-Box handling (Kids and Teens category only)
     *
     ***********************************************************/
    async crawlKanBox(){
        logger.trace("crawlKanBox => Entering");
        logger.info("crawlKanBox => Starting Kan-Box scraping for category: ילדים ונוער");

        const { KAN_BOX_URL, KAN_DIGITAL_IMAGE_PREFIX } = require("./constants");

        try {
            // Fetch Kan-Box lobby page
            logger.info(`crawlKanBox => Fetching: ${KAN_BOX_URL}`);
            const loaded = await this.fetchCatalogDocument(KAN_BOX_URL, false);
            if (loaded.timeout) {
                this.noteListingIncomplete(KAN_BOX_URL);
                return;
            }
            if (!loaded.doc || typeof loaded.doc.querySelectorAll !== "function") {
                logger.warn(`crawlKanBox => Could not fetch ${KAN_BOX_URL}`);
                return;
            }
            const root = loaded.doc;

            // New Kan-Box lobby is content rows (h2 + a.cr-item). The old
            // block-list / card-link markup is the fallback inside the helper.
            const seriesLinks = parseKanBoxCategorySeries(root, HINUKHIT.KAN_BOX_CATEGORY);
            if (!seriesLinks.length) {
                logger.warn(`crawlKanBox => Category "${HINUKHIT.KAN_BOX_CATEGORY}" not found on Kan-Box page`);
                return;
            }

            logger.info(`crawlKanBox => Found category: ${HINUKHIT.KAN_BOX_CATEGORY} (${seriesLinks.length} series)`);

            // Scrape series directly from Kan-Box page
            let totalSeriesFound = 0;
            let duplicateCount = 0;

            // Process each series link found in this category
            for (const seriesUrl of seriesLinks) {
                if (!seriesUrl) continue;

                // Build full URL if relative
                let fullSeriesUrl = seriesUrl;
                if (seriesUrl.startsWith('/')) {
                    fullSeriesUrl = KAN_DIGITAL_IMAGE_PREFIX + seriesUrl;
                }

                // Generate series ID to check for duplicates
                const seriesId = this.seriesIdFor(fullSeriesUrl, HINUKHIT.SUBPREFIX_TEENS);

                // Check if this series already exists in our catalog
                if (this._jsonObj.hasOwnProperty(seriesId)) {
                    logger.debug(`crawlKanBox => Duplicate found: ${seriesId} - skipping`);
                    this.deltaTracker.skipSeries();
                    duplicateCount++;
                    continue;
                }

                // Create a minimal item object for processing
                const item = {
                    Url: fullSeriesUrl,
                    Image: '',
                    ImageAlt: '',
                    Description: `From Kan-Box category: ${HINUKHIT.KAN_BOX_CATEGORY}`
                };

                // Process the series using existing method
                try {
                    const result = await this.processOneTeensSeries(item, "n");
                    if (result) {
                        totalSeriesFound++;
                        logger.info(`crawlKanBox => Added series from ${HINUKHIT.KAN_BOX_CATEGORY}: ${result.seriesTitle}`);
                    }
                } catch (error) {
                    logger.error(`crawlKanBox => Error processing series ${fullSeriesUrl}: ${error.message}`);
                }
            }

            logger.info(`crawlKanBox => Completed scraping`);
            logger.info(`crawlKanBox => Total new series added: ${totalSeriesFound}`);
            logger.info(`crawlKanBox => Total duplicates skipped: ${duplicateCount}`);

        } catch (error) {
            logger.error(`crawlKanBox => Fatal error: ${error.message}`);
            throw error;
        }

        logger.trace("crawlKanBox => Exiting");
    }

    /**
     * Function to retrieve the serise title
     * @param {*} doc = html element of page of series
     * @returns String of the series title
     */
    getEducationalTitle(doc){
        if (!doc || typeof doc.querySelector !== "function") return "";
        var seriesTitle = "";
        if (doc.querySelector("title") != undefined){
            seriesTitle = utils.getNameFromSeriesPage(doc.querySelector("title").text.trim());
        }
        if (!seriesTitle){
            if (doc.querySelector("h2.title.h1") != undefined){
                var h2Title = doc.querySelector("h2.title.h1").text.trim();
                seriesTitle = utils.getNameFromSeriesPage(utils.getNameFromSeriesPage(h2Title));
            }
            if (!seriesTitle){
                var titleAlt = doc.querySelector("span.logo.d-none.d-md-inline img.img-fluid").getAttribute("alt");
                seriesTitle = utils.getNameFromSeriesPage(titleAlt);
                if (!seriesTitle){
                    seriesTitle = utils.getNameFromSeriesPage(jsonObj.ImageAlt).trim();
                }
            }
        }
        return seriesTitle;
    }

    /*****************************************************************************
     * Get the episodes of each season (video object and streams)
     * @param {*} seasons
     * @param {*} id
     * @param {*} subType
     * @param {*} videosCollected - Array to collect videos into
     * @returns JSON object
     *****************************************************************************/
    async fetchEducationalDocument(url) {
        const loaded = await this.fetchCatalogDocument(url);
        if (!loaded || !loaded.doc || typeof loaded.doc.querySelector !== "function") {
            if (loaded && loaded.timeout) {
                logger.warn(`fetchEducationalDocument => Timed out: ${url}`);
            }
            return null;
        }
        return loaded.doc;
    }

    async getKidsVideos(episodes, id, subType, videosCollected = []){
        const bySeason = new Map();
        for (const episode of episodes || []) {
            if (!bySeason.has(episode.season)) bySeason.set(episode.season, []);
            bySeason.get(episode.season).push(episode);
        }
        const seasonNumbers = [...bySeason.keys()].sort((a, b) => b - a);
        logger.info(`getKidsVideos => Processing ${seasonNumbers.length} season(s) for series ID: ${id}`);

        for (const seasonNo of seasonNumbers) {
            const episodeData = bySeason.get(seasonNo).slice().sort((a, b) => b.episodeNo - a.episodeNo);
            logger.info(`getKidsVideos => Season ${seasonNo} has ${episodeData.length} episode(s) - processing in descending order`);
            await this.processBatch(
                episodeData,
                async (epData) => {
                    return await this.processOneTeensEpisode(epData, id, subType, videosCollected);
                },
                `teens-episodes (Season ${seasonNo})`
            );
        }
    }

    /**
     * Process a single teens episode (extracted from getKidsVideos for batch processing)
     */
    async processOneTeensEpisode(epData, id, subType, videosCollected = []) {
        const seasonNo = epData.season;
        const episodeNo = epData.episodeNo;

        var episodeLink = epData.url || "";
        if (episodeLink.startsWith("/")){
            episodeLink = HINUKHIT.URL_KIDS_CONTENT_PREFIX + episodeLink;
        }
        var episodeTitle = epData.title || "";

        var episodeImgUrl = "";
        if (epData.image) {
            episodeImgUrl = utils.getImageFromUrl(epData.image, subType);
        }
        logger.trace("processOneTeensEpisode => episodeImgUrl: " + episodeImgUrl + " Name: " + episodeTitle);

        var episodeDescription = String(epData.description || "");
        episodeDescription = episodeDescription.replace(/[\r\n]+/gm, "").trim();

        var streams = await utils.getStreams(episodeLink);
        var streamsArr = [];
        var released = "";
        if (streams == "-1"){
            logger.debug("processOneTeensEpisode => Stream is empty. Leaving it empty");
        } else {
            streamsArr.push(streams);
            released = streams.released;
        }

        var videoId = id + ":" + seasonNo + ":" + episodeNo;

        // Create video object and add to collected array
        const video = {
            id: videoId,
            name: episodeTitle,
            season: seasonNo,
            episode: episodeNo,
            description: episodeDescription,
            thumbnail: episodeImgUrl,
            episodeLink: episodeLink,
            streams: streamsArr
        };
        if (released != "") {video["released"] = released;}

        videosCollected.push(video);
        logger.info(`Added: S${seasonNo} E${episodeNo} - ${episodeTitle}`);
        logger.debug("processOneTeensEpisode => ✓ Added episode : " + episodeTitle + " " + videoId);
        return { videoId, episodeTitle };
    }

    setDescription(seriesElems){
        var description = "";
        if (seriesElems.length < 1) {return description;}
        description = seriesElems.text.trim() +".\n";

        return description;
    }

    /*************************************************************
     * Get the URL of the indivifual Episode
     * @link
     *************************************************************/
    getEpisodeUrl(link){
        var startPoint = link.indexOf("contentUrl");
        link = link.substring(startPoint + 14);
        var endPoint = link.indexOf('\"');
        link = link.substring(0,endPoint);

        return link;
    }

    getVideoNameFromEpisodePage(str){
        if (str.indexOf("|") > 0) {
            str = str.substring(str.indexOf('|'));
            str = str.replace("|", "");
        }
        str = str.trim();
        return str;
    }
}

/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanTeensScraper;
