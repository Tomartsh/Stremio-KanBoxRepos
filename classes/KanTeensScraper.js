const utils = require("./utilities.js");
const {fetchData, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    HINUKHIT,
    SCRAPER_CONFIG
} = require("./constants.js");
const { safeExecute } = require("./ScraperHelpers.js");
const BaseScraper = require("./BaseScraper.js");

const log4js = require("log4js");
var logger = log4js.getLogger("KanTeensScraper");

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
        var doc = await fetchData(HINUKHIT.URL_TEENS);

        var teensSeries = doc.querySelectorAll("div.umb-block-list div script");
        var teensScriptStr = teensSeries[4].toString();
        var startIndex = teensScriptStr.indexOf("[{");
        var lastIndex = teensScriptStr.lastIndexOf("}]") +2 ;
        var teensJsonStr = teensScriptStr.substring(startIndex, lastIndex);
        var teensJsonArr = JSON.parse(teensJsonStr);

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

        var seriesPage = HINUKHIT.URL_KIDS_CONTENT_PREFIX + series.Url;
        var genres = utils.setGenreFromString(series.Genres);
        var id = utils.generateSeriesId(seriesPage, HINUKHIT.SUBPREFIX_TEENS);
        logger.debug(`processOneTeensSeries => seriesPage is ${series.Url}`);
        var doc2 = await fetchData(seriesPage + "?currentPage=2&itemsToShow=500");
        if (doc2 == undefined){
            logger.warn(`processOneTeensSeries => Could not fetch page for ${series.Url}`);
            return null;
        }

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

        var seasons = doc2.querySelectorAll("div.seasons-item.kids");
        // Create a temporary videos array to collect episodes
        const videosCollected = [];
        await this.getKidsVideos(seasons, id, subType, videosCollected);

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

        const { parse } = require('node-html-parser');
        const { KAN_BOX_URL, KAN_DIGITAL_IMAGE_PREFIX } = require("./constants");

        try {
            // Fetch Kan-Box lobby page
            logger.info(`crawlKanBox => Fetching: ${KAN_BOX_URL}`);
            const response = await fetchData(KAN_BOX_URL, false);
            const html = response;
            const root = parse(html);

            // Find all block-list items (categories)
            const blockLists = root.querySelectorAll('.block-list');
            logger.info(`crawlKanBox => Found ${blockLists.length} block-list sections`);

            let targetCategory = null;

            // Find the "ילדים ונוער" category
            blockLists.forEach((blockList, index) => {
                const items = blockList.querySelectorAll('.block-list-item');
                logger.debug(`crawlKanBox => Section ${index + 1}: ${items.length} categories`);

                items.forEach((item) => {
                    const titleElem = item.querySelector('.h3.title-elem');
                    const linkElem = item.querySelector('a.unstyled-link');

                    if (titleElem && linkElem) {
                        const categoryName = titleElem.text.trim();

                        // Check if this is our target category
                        if (categoryName === HINUKHIT.KAN_BOX_CATEGORY) {
                            const categoryLink = linkElem.getAttribute('href');
                            const seriesLinks = item.querySelectorAll('a.card-link');

                            targetCategory = {
                                name: categoryName,
                                link: categoryLink,
                                seriesLinks: Array.from(seriesLinks).map(link => link.getAttribute('href')).filter(url => url)
                            };
                        }
                    }
                });
            });

            if (!targetCategory) {
                logger.warn(`crawlKanBox => Category "${HINUKHIT.KAN_BOX_CATEGORY}" not found on Kan-Box page`);
                return;
            }

            logger.info(`crawlKanBox => Found category: ${targetCategory.name} (${targetCategory.seriesLinks.length} series)`);

            // Scrape series directly from Kan-Box page
            let totalSeriesFound = 0;
            let duplicateCount = 0;

            // Process each series link found in this category
            for (const seriesUrl of targetCategory.seriesLinks) {
                if (!seriesUrl) continue;

                // Build full URL if relative
                let fullSeriesUrl = seriesUrl;
                if (seriesUrl.startsWith('/')) {
                    fullSeriesUrl = KAN_DIGITAL_IMAGE_PREFIX + seriesUrl;
                }

                // Generate series ID to check for duplicates
                const seriesId = utils.generateSeriesId(fullSeriesUrl, HINUKHIT.SUBPREFIX_TEENS);

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
                    Description: `From Kan-Box category: ${targetCategory.name}`
                };

                // Process the series using existing method
                try {
                    const result = await this.processOneTeensSeries(item, "n");
                    if (result) {
                        totalSeriesFound++;
                        logger.info(`crawlKanBox => Added series from ${targetCategory.name}: ${result.seriesTitle}`);
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
    async getKidsVideos(seasons, id, subType, videosCollected = []){
        var noOfSeasons = seasons.length;
        logger.info(`getKidsVideos => Processing ${noOfSeasons} season(s) for series ID: ${id}`);

        for (var iter = 0; iter< noOfSeasons; iter++){ //iterate over seasons (descending)
            var season = seasons[iter];
            var seasonNo = noOfSeasons - iter;
            var episodes = season.querySelectorAll("li.border-item");
            var numEpisodes = episodes.length;

            logger.info(`getKidsVideos => Season ${seasonNo} has ${numEpisodes} episode(s) - processing in descending order`);

            // Prepare episode data for batch processing (descending order)
            const episodeData = [];
            for (let n = 0; n < numEpisodes; n++) {
                // Process from last to first (highest episode number first)
                const actualEpisodeNo = numEpisodes - n;  // Keep correct episode number
                episodeData.push({
                    elem: episodes[numEpisodes - 1 - n],  // Access in reverse
                    seasonNo: seasonNo,
                    episodeNo: actualEpisodeNo  // Keep correct episode number
                });
            }

            // Process episodes in batches
            const episodeResults = await this.processBatch(
                episodeData,
                async (epData, index) => {
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
        const { elem: episode, seasonNo, episodeNo } = epData;

        var episodeLink = episode.querySelector("a.card-link").getAttribute("href");
        if (episodeLink.startsWith("/")){
            episodeLink = HINUKHIT.URL_KIDS_CONTENT_PREFIX + episodeLink;
        }
        var episodeTitle = episode.querySelector("a.card-link").getAttribute("title");
        if (episodeTitle.indexOf("|") > 0){
            episodeTitle = episodeTitle.substring(episodeTitle.indexOf("|") + 1).trim();
        }
        if (episodeTitle.startsWith("עונה")){
            episodeTitle = episodeTitle.substring(episodeTitle.indexOf("|") + 1).trim();
        }

        var episodeImgUrl = "";
        if ((episode.querySelector("img.img-full") != undefined) &&
            (episode.querySelector("img.img-full").getAttribute("src").indexOf("?") > 0)){
            episodeImgUrl = utils.getImageFromUrl(episode.querySelector("img.img-full").getAttribute("src"), subType);
        }
        logger.trace("processOneTeensEpisode => episodeImgUrl: " + episodeImgUrl + " Name: " + episodeTitle);

        var episodeDescription = episode.querySelector("div.card-text").text;
        episodeDescription = episodeDescription.replace(/[\r\n]+/gm, "").trim();;

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
