const utils = require("./utilities.js");
const {fetchData, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    HINUKHIT,
    SCRAPER_CONFIG
} = require("./constants.js");
const { extractKanStream } = require("./ScraperHelpers.js");
const BaseScraper = require("./BaseScraper.js");

const log4js = require("log4js");
var logger = log4js.getLogger("KanKidsScraper");

class KanKidsScraper extends BaseScraper {

    constructor() {
        // Initialize BaseScraper with the scraper name
        super('KanKids', { exportFilename: "stremio-kankids", databaseKey: 'kankids' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize KanKids-specific properties
        this._kanKidsJSONObj = {};
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        await this.crawlKids();
    }

    /****************************************************************
     *
     * Hinukhit functions
     *
     ****************************************************************/

    async crawlKids(){
        logger.trace("crawlKids => Entering");
        logger.debug("crawlKids => Starting retrieval of Tiny series");

        var subType = "k";
        var doc = await fetchData(HINUKHIT.URL_TINY);

        var kidsSeries = doc.querySelectorAll("div.umb-block-list div script");
        var kidsScriptStr = kidsSeries[4].toString();
        var startIndex = kidsScriptStr.indexOf("[{");
        var lastIndex = kidsScriptStr.lastIndexOf("}]") +2 ;
        var kidsJsonStr = kidsScriptStr.substring(startIndex, lastIndex);
        var kidsJsonArr = JSON.parse(kidsJsonStr);

        // Process kids series using batch processor
        logger.info(`crawlKids => Found ${kidsJsonArr.length} kids series to process`);
        await this.processBatch(
            kidsJsonArr,
            async (series, index) => {
                return await this.processOneKidsSeries(series, subType);
            },
            "kids-series"
        );
    }

    /**
     * Process a single kids series (extracted from crawlKids for batch processing)
     */
    async processOneKidsSeries(series, subType) {
        var imgUrl = utils.getImageFromUrl(series.Image, subType);

        var seriesPage = HINUKHIT.URL_KIDS_CONTENT_PREFIX + series.Url;
        var genres = utils.setGenreFromString(series.Genres);
        var id = utils.generateSeriesId(seriesPage, HINUKHIT.SUBPREFIX_KIDS);
        var doc2 = await fetchData(seriesPage + "?currentPage=2&itemsToShow=100");

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
            logger.warn(`processOneKidsSeries => Skipping "${seriesTitle}" - no episodes found (likely a single-page article)`);
            return null;
        }

        // Add series with collected videos
        this.addToJsonObject(id, seriesTitle,seriesPage,imgUrl,seriesDescription,genres,videosCollected,subType,"series");
        logger.debug(`processOneKidsSeries => Added kids series ${seriesTitle} with ${videosCollected.length} episodes`);
        return { id, seriesTitle };
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
                    return await this.processOneKidsEpisode(epData, id, subType, videosCollected);
                },
                `kids-episodes (Season ${seasonNo})`
            );
        }
    }

    /**
     * Process a single kids episode (extracted from getKidsVideos for batch processing)
     */
    async processOneKidsEpisode(epData, id, subType, videosCollected = []) {
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
        logger.trace("processOneKidsEpisode => episodeImgUrl: " + episodeImgUrl + " Name: " + episodeTitle);

        var episodeDescription = episode.querySelector("div.card-text").text;
        episodeDescription = episodeDescription.replace(/[\r\n]+/gm, "").trim();;

        var streams = await this.getStreams(episodeLink);
        var streamsArr = [];
        var released = "";
        if (streams == "-1"){
            logger.debug("processOneKidsEpisode => Stream is empty. Leaving it empty");
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
        logger.debug("processOneKidsEpisode => ✓ Added episode : " + episodeTitle + " " + videoId);
        return { videoId, episodeTitle };
    }

    async getStreams(link){
        logger.trace("getStreams => Entering");
        logger.trace("getStreams => Link: " + link);

        const stream = await extractKanStream(link, "KanKids");

        logger.trace("getStreams => Exiting");
        return stream || "";
    }

    setDescription(seriesElems){
        var description = "";
        if (seriesElems.length < 1) {return description;}
        description = seriesElems.text.trim() +".\n";

        return description;
    }
}

/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanKidsScraper;
