const utils = require("./utilities.js");
const {fetchData, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    KAN_ARCHIVE,
    KAN_DIGITAL_IMAGE_PREFIX,
    SCRAPER_CONFIG
} = require("./constants.js");
const { extractKanStream } = require("./ScraperHelpers.js");
const BaseScraper = require("./BaseScraper.js");
const SUB_PREFIX = "archive";

const log4js = require("log4js");
var logger = log4js.getLogger("KanArchiveScraper");

class KanArchiveScraper extends BaseScraper {

    constructor() {
        // Initialize BaseScraper with the scraper name
        super('KanArchive', { exportFilename: "stremio-kanarchive", databaseKey: 'kanarchive' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize KanArchive-specific properties
        this._kanArchiveJSONObj = {};
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        await this.crawlVod();
    }

    /***********************************************************
     *
     * Kan Digital handling
     *
     ***********************************************************/
    async crawlVod(){
        logger.trace("crawlVod => Entered");
        logger.debug("crawlVod => Starting retrieval of VOD series");

        var doc = await fetchData(KAN_ARCHIVE.URL_ADDRESS);

        var series = doc.querySelectorAll("a.card-link");
        for (var seriesElem of series){// iterate over series
            if (seriesElem == undefined) { continue;} //if we do not have an element, skip

            //set the series URL
            var seriesUrl = seriesElem.getAttribute("href");
            if (seriesUrl == undefined) { continue;} // if there is not link to the series then skip
            if (seriesUrl.startsWith("/")) { seriesUrl = KAN_ARCHIVE.URL_ADDRESS + seriesUrl; }

            if (seriesUrl.includes("kan-actual")){continue;} //we are skipping news item (for rnow)

            if (seriesUrl.includes("podcasts")){continue;} //we are skipping podcasts, we will deal with them later

            if (! seriesUrl.includes("/archive1/")) { continue; }

            var subType = "a";

            //set series ID
            // in case the id is not numbers only we need to invent an ID. We will start with 5,000
            // the generateId will return also the incremented series iterator
            var id = utils.generateSeriesId(seriesUrl, SUB_PREFIX);

            //set series image link
            var imageElem = seriesElem.querySelector("img");
            var imgUrlStr = imageElem.getAttribute("src");
            var imgUrl = imgUrlStr.substring(0,imgUrlStr.indexOf("?"));
            if (imgUrl.startsWith("/")){
                imgUrl = KAN_ARCHIVE.IMAGE_PREFIX + imgUrl;
            }

            this.addToJsonObject(id, "",seriesUrl,imgUrl,"","",[],subType,"series");
        }

        //start working on each series
        await this.getSeries()
        logger.trace("crawl() => Exiting");

    }

    async getSeries(){
        logger.trace("getSeries => Entering");

        // Collect all series keys
        const seriesKeys = Object.keys(this._jsonObj);
        logger.info(`getSeries => Found ${seriesKeys.length} series to process`);

        // Process series using batch processor
        await this.processBatch(
            seriesKeys,
            async (key, index) => {
                return await this.processOneSeries(key);
            },
            "series"
        );

        logger.trace("getSeries => Exiting");
    }

    /**
     * Process a single series (extracted from getSeries for batch processing)
     */
    async processOneSeries(key) {
        const id = this._jsonObj[key]["id"];
        const subType = this._jsonObj[key]["subtype"];
        const retrieveLink = this._jsonObj[key]["link"] + "?page=1&itemsToShow=1000";

        logger.debug(`processOneSeries => Fetching series ID: ${id} from ${retrieveLink}`);
        const seriesPageDoc = await fetchData(retrieveLink);

        if (!seriesPageDoc) {
            logger.warn(`processOneSeries => Failed to fetch series page for ID: ${id}`);
            return null;
        }

        let episodeLink;

        // Check if this is empty
        try {
            const btnElement = seriesPageDoc.querySelector("a.btn.with-arrow.info-link.btn-gradient");
            if (!btnElement || btnElement.getAttribute("href") == undefined) {
                logger.debug(`processOneSeries => Series page is empty, skipping series ID: ${id}`);
                return null;
            }
            episodeLink = btnElement.getAttribute("href");
        } catch(error) {
            logger.debug(`processOneSeries => Series page is empty, skipping series ID: ${id} - Error: ${error.message}`);
            return null;
        }

        logger.debug(`processOneSeries => Working on series ID: ${id}`);

        // Set series Description
        if (seriesPageDoc.querySelector("div.info-description p") != undefined) {
            this._jsonObj[key]["meta"]["description"] = this.setDescription(seriesPageDoc.querySelector("div.info-description p"));
        }

        // Set series genres
        this._jsonObj[key]["meta"]["genres"] = this.setGenre(seriesPageDoc.querySelector("div.info-genre"));

        // Set series name
        const titleTemp = seriesPageDoc.querySelector("title").text;
        const title = utils.getNameFromSeriesPage(titleTemp);
        this._jsonObj[key]["meta"]["name"] = title;
        this._jsonObj[key]["name"] = title;

        const seasons = seriesPageDoc.querySelectorAll("div.seasons-item");
        logger.debug(`processOneSeries => Series "${title}" has ${seasons.length} season(s)`);

        if (seasons.length > 0) {
            // Multiple seasons and episodes
            await this.getVideos(seasons, id, subType);
        } else {
            // Single episode (movie)
            const movieTitle = seriesPageDoc.querySelector("h2").text.trim();
            let description = "";
            if (seriesPageDoc.querySelector("div.info-description p") != undefined) {
                description = seriesPageDoc.querySelector("div.info-description p").text.trim();
            }
            const videoId = key + ":1:1";

            const elemImage = seriesPageDoc.querySelector("div.block-img").toString();
            const startPoint = elemImage.indexOf("--desktop-vod-bg-image: url(") + 29;
            let imgUrl = elemImage.substring(startPoint);
            if (imgUrl.indexOf("?") < 1) {
                logger.warn(`processOneSeries => Could not extract image URL for series ID: ${id}`);
                return null;
            }
            imgUrl = imgUrl.substring(0, imgUrl.indexOf("?"));
            if (imgUrl.startsWith("/")) {
                imgUrl = "https://www.kan.org.il" + imgUrl;
            }

            this._jsonObj[key]["meta"]["link"] = episodeLink;
            this._jsonObj[key]["meta"]["description"] = description;
            this._jsonObj[key]["meta"]["poster"] = imgUrl;

            // Get streams
            const streams = await this.getStreams(episodeLink);

            this.addVideoToMeta(id, videoId, movieTitle, "1", "1", description, imgUrl, episodeLink, streams.released, streams);
            logger.info(`processOneSeries => Added movie "${movieTitle}" for series ID: ${id}`);
        }

        return { id, title };
    }

    /**********************************************************
     * receive the video elements with ID of series and the
     * subtype, and retrieve the list of videos and streams
     * @param {*} videosElems
     * @param {*} id
     * @param {*} subType
     * @returns Array of video json objects
     *********************************************************/
    async getVideos(videosElems, id, subType){
        const noOfSeasons = videosElems.length;
        logger.info(`getVideos => Processing ${noOfSeasons} season(s) for series ID: ${id}`);

        for (let i = 0; i < noOfSeasons; i++) {
            const seasonNo = noOfSeasons - i;
            const seasonEpisodesElems = videosElems[i].querySelectorAll("a.card-link");
            const numEpisodes = seasonEpisodesElems.length;

            logger.info(`getVideos => Season ${seasonNo} has ${numEpisodes} episode(s) - processing in descending order`);

            // Prepare episode data for batch processing (descending order)
            const episodeData = [];
            for (let iter = 0; iter < numEpisodes; iter++) {
                // Process from last to first (highest episode number first)
                const actualEpisodeNo = numEpisodes - iter;  // Keep correct episode number
                episodeData.push({
                    elem: seasonEpisodesElems[numEpisodes - 1 - iter],  // Access in reverse
                    seasonNo: seasonNo,
                    episodeNo: actualEpisodeNo  // Keep correct episode number
                });
            }

            // Process episodes in batches
            await this.processBatch(
                episodeData,
                async (epData, index) => {
                    return await this.processOneEpisode(epData, id, subType);
                },
                `episodes (Season ${seasonNo})`
            );
        }

        logger.debug(`getVideos => Completed processing all seasons for series ID: ${id}`);
    }

    /**
     * Process a single episode (extracted from getVideos for batch processing)
     */
    async processOneEpisode(epData, id, subType) {
        const { elem: seasonEpisodesElem, seasonNo, episodeNo } = epData;

        logger.trace(`processOneEpisode => Season: ${seasonNo}, Episode: ${episodeNo}`);

        let episodePageLink = seasonEpisodesElem.getAttribute("href");
        if (episodePageLink.startsWith("/")) {
            episodePageLink = KAN_DIGITAL_IMAGE_PREFIX + episodePageLink;
        }

        let title = "";
        if (seasonEpisodesElem.querySelector("div.card-title")) {
            title = seasonEpisodesElem.querySelector("div.card-title").text.trim();
        } else {
            title = seasonEpisodesElem.getAttribute("title");
        }

        let description = "";
        if (seasonEpisodesElem.querySelector("div.card-text") != undefined) {
            description = seasonEpisodesElem.querySelector("div.card-text").text.trim();
        }

        const videoId = id + ":" + seasonNo + ":" + episodeNo;

        let episodeLogoUrl = "";
        if (seasonEpisodesElem.querySelector("div.card-img")) {
            const elemImage = seasonEpisodesElem.querySelector("div.card-img");
            try {
                if ((elemImage != null) && (elemImage.querySelector("img.img-full") != null)) {
                    const elemEpisodeLogo = elemImage.querySelector("img.img-full");

                    if (elemEpisodeLogo != null) {
                        episodeLogoUrl = utils.getImageFromUrl(elemEpisodeLogo.attrs["src"], subType);
                    }
                    logger.trace(`processOneEpisode => episodeLogoUrl location: ${episodeLogoUrl}`);
                }
            } catch(ex) {
                logger.error(`processOneEpisode => episodeLogoUrl error: ${ex}`);
            }
        }

        // Get streams
        const streams = await this.getStreams(episodePageLink);

        if (!streams || !streams.url) {
            logger.warn(`processOneEpisode => No streams found for episode "${title}" (S${seasonNo}E${episodeNo})`);
            return null;
        }

        const streamsArr = [
            {
                url: streams.url,
                type: streams.type,
                name: streams.name,
                description: streams.description
            }
        ];

        this.addVideoToMeta(id, videoId, title, seasonNo, episodeNo, description, episodeLogoUrl, episodePageLink, streams.released, streamsArr);
        logger.debug(`processOneEpisode => ✓ Added episode "${title}" (S${seasonNo}E${episodeNo})`);

        return { videoId, title, seasonNo, episodeNo };
    }

    async getStreams(link){
        logger.trace("getStreams => Entering");
        logger.trace("getStreams => Link: " + link);

        const stream = await extractKanStream(link, "KanArchive");

        logger.trace("getStreams => Exiting");
        return stream || "";
    }

    setDescription(seriesElems){
        var description = "";
        if (seriesElems.length < 1) {return description;}
        description = seriesElems.text.trim() +".\n";

        return description;
    }

    /**
     * Get the genres from the html element and pass it to get the accurate genres
     * @param {*} genreElems
     * @returns
     */
    setGenre(genreElems){
        if ((genreElems == null) || (genreElems.length < 1)){ return "Kan";}

        var genresElements = genreElems.querySelectorAll("ul li");
        if (genresElements.length < 1) {return "Kan";}

        var genres = [];
        for (var check of genresElements){
            var strGenre = check.text.trim();
            genres.push(strGenre);
        }

        return utils.setGenreFromString(genres);
    }
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanArchiveScraper;
