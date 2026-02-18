const utils = require("./utilities.js");
const {fetchData} = require("./utilities.js");
const {
    LOG4JS,
    HINUKHIT,
    SCRAPER_CONFIG
} = require("./constants.js");

const log4js = require("log4js");

log4js.configure({
    appenders: { 
        out: { type: "stdout" },
        Stremio: 
        { 
            type: LOG4JS.TYPE, 
            filename: LOG4JS.FILENAME, 
            maxLogSize: LOG4JS.MAX_SIZE, 
            backups: LOG4JS.BACKUP_FILES, 
        }
    },
    categories: { default: { appenders: ['Stremio','out'], level: LOG4JS.LEVEL } },
});

const EXPORT_FILENAME = "stremio-kanteens";
var logger = log4js.getLogger("KanTeensScraper");

class KanTeensScraper {

    constructor() {
        this._kanTeenJSONObj = {};
        this.isRunning = false;

        // Get scraper configuration
        const scraperName = 'KanTeensScraper';
        const config = SCRAPER_CONFIG[scraperName] || {};
        this.config = {
            parallelFetching: config.parallelFetching ?? SCRAPER_CONFIG.DEFAULT_PARALLEL_FETCHING,
            batchSize: config.batchSize ?? SCRAPER_CONFIG.DEFAULT_BATCH_SIZE,
            delayBetweenBatches: config.delayBetweenBatches ?? SCRAPER_CONFIG.DEFAULT_DELAY_BETWEEN_BATCHES
        };

        logger.info(`KanTeensScraper initialized - Parallel: ${this.config.parallelFetching}, Batch size: ${this.config.batchSize}`);
    }

    async crawl(isDoWriteFile = false){
        logger.info("Started Crawling");
        this.isRunning = true;
        await this.crawlTeens();
        logger.info("Done Crawling");
        
        if (isDoWriteFile){
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }
        this.isRunning = false;

        logger.info("crawl => Done crawling. Exiting");
    }

    /**
     * Helper method to process items in batches with detailed logging
     * @param {Array} items - Array of items to process
     * @param {Function} processor - Async function to process each item
     * @param {String} itemType - Description of item type for logging (e.g., "series", "episodes")
     * @returns {Promise<Array>} - Results from all processed items
     */
    async processBatch(items, processor, itemType = "items") {
        if (!this.config.parallelFetching) {
            // Sequential processing (original behavior)
            logger.info(`[${itemType}] Processing ${items.length} ${itemType} sequentially`);
            const results = [];
            for (let i = 0; i < items.length; i++) {
                const startTime = Date.now();
                logger.debug(`[${itemType}] Processing ${i + 1}/${items.length}`);
                try {
                    const result = await processor(items[i], i);
                    const duration = Date.now() - startTime;
                    logger.debug(`[${itemType}] Completed ${i + 1}/${items.length} in ${duration}ms`);
                    results.push(result);
                } catch (error) {
                    logger.error(`[${itemType}] Failed ${i + 1}/${items.length}: ${error.message}`);
                    results.push(null);
                }
            }
            return results;
        }

        // Parallel batch processing
        const { batchSize, delayBetweenBatches } = this.config;
        const totalBatches = Math.ceil(items.length / batchSize);
        logger.info(`[${itemType}] Processing ${items.length} ${itemType} in ${totalBatches} batches (${batchSize} per batch)`);

        const allResults = [];

        for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
            const batchStart = batchIndex * batchSize;
            const batchEnd = Math.min(batchStart + batchSize, items.length);
            const batch = items.slice(batchStart, batchEnd);

            const batchNum = batchIndex + 1;
            const batchStartTime = Date.now();
            logger.info(`[${itemType}] Starting batch ${batchNum}/${totalBatches} (${itemType} ${batchStart + 1}-${batchEnd} of ${items.length})`);

            // Process batch in parallel
            const batchPromises = batch.map(async (item, indexInBatch) => {
                const globalIndex = batchStart + indexInBatch;
                const itemStartTime = Date.now();
                try {
                    const result = await processor(item, globalIndex);
                    const itemDuration = Date.now() - itemStartTime;
                    logger.debug(`[${itemType}] ✓ Item ${globalIndex + 1}/${items.length} completed in ${itemDuration}ms`);
                    return { success: true, result, index: globalIndex };
                } catch (error) {
                    const itemDuration = Date.now() - itemStartTime;
                    logger.error(`[${itemType}] ✗ Item ${globalIndex + 1}/${items.length} failed after ${itemDuration}ms: ${error.message}`);
                    return { success: false, error, index: globalIndex };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            const batchDuration = Date.now() - batchStartTime;
            const successCount = batchResults.filter(r => r.success).length;
            const failCount = batchResults.length - successCount;

            logger.info(`[${itemType}] Batch ${batchNum}/${totalBatches} completed: ${successCount}/${batch.length} successful, ${failCount} failed in ${batchDuration}ms`);

            allResults.push(...batchResults.map(r => r.result));

            // Delay between batches to avoid rate limiting (except after last batch)
            if (batchIndex < totalBatches - 1 && delayBetweenBatches > 0) {
                logger.debug(`[${itemType}] Waiting ${delayBetweenBatches}ms before next batch...`);
                await new Promise(resolve => setTimeout(resolve, delayBetweenBatches));
            }
        }

        const successfulResults = allResults.filter(r => r !== null && r !== undefined);
        logger.info(`[${itemType}] All batches completed: ${successfulResults.length}/${items.length} total successful`);

        return allResults;
    }

    /****************************************************************
     *
     * Hinukhit functions
     *
     ****************************************************************/
    async crawlTeens(){
        logger.trace("crawlKids => Entering");
        logger.debug("crawlKids => Starting retrieval of Tiny series");

        var subType = "n";
        var doc = await fetchData(HINUKHIT.URL_TEENS);
        
        var kidsSeries = doc.querySelectorAll("div.umb-block-list div script");
        var kidsScriptStr = kidsSeries[4].toString();
        var startIndex = kidsScriptStr.indexOf("[{");
        var lastIndex = kidsScriptStr.lastIndexOf("}]") +2 ;
        var kidsJsonStr = kidsScriptStr.substring(startIndex, lastIndex);
        var kidsJsonArr = JSON.parse(kidsJsonStr);

        // Process teens series using batch processor
        logger.info(`crawlTeens => Found ${kidsJsonArr.length} teens series to process`);
        await this.processBatch(
            kidsJsonArr,
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
        this.addToJsonObject(id, seriesTitle,seriesPage,imgUrl,seriesDescription,genres,[],subType,"series");
        await this.getKidsVideos(seasons, id, subType);

        logger.debug(`processOneTeensSeries => Added teens series ${seriesTitle}`);
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
     * @returns JSON object
     *****************************************************************************/
    async getKidsVideos(seasons, id, subType){
        var noOfSeasons = seasons.length;
        logger.info(`getKidsVideos => Processing ${noOfSeasons} season(s) for series ID: ${id}`);

        for (var iter = 0; iter< noOfSeasons; iter++){ //iterate over seasons
            var season = seasons[iter];
            var seasonNo = noOfSeasons - iter;
            var episodes = season.querySelectorAll("li.border-item");

            logger.info(`getKidsVideos => Season ${seasonNo} has ${episodes.length} episode(s)`);

            // Prepare episode data for batch processing
            const episodeData = [];
            for (let n = 0; n < episodes.length; n++) {
                episodeData.push({
                    elem: episodes[n],
                    seasonNo: seasonNo,
                    episodeNo: n + 1
                });
            }

            // Process episodes in batches
            await this.processBatch(
                episodeData,
                async (epData, index) => {
                    return await this.processOneTeensEpisode(epData, id, subType);
                },
                `teens-episodes (Season ${seasonNo})`
            );
        }
    }

    /**
     * Process a single teens episode (extracted from getKidsVideos for batch processing)
     */
    async processOneTeensEpisode(epData, id, subType) {
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
        logger.trace("processOneTeensEpisode => episodeImgUrl: " + episodeImgUrl + " Name: " + episodeTitle)

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

        this.addVideoToMeta(id, videoId, episodeTitle,seasonNo, episodeNo, episodeDescription, episodeImgUrl, episodeLink, released, streamsArr);
        logger.debug("processOneTeensEpisode => ✓ Added episode : " + episodeTitle + " " + videoId);
        return { videoId, episodeTitle };
    }

    setDescription(seriesElems){
        var description = "";
        if (seriesElems.length < 1) {return description;}
        description = seriesElems.text.trim() +".\n";

        return description;
    }

    addVideoToMeta(key, episodeId, name, seasonNo, episodeNo, desc, thumb, episodeLink, released, streams){
        var video = {
            id: episodeId,
            name: name,
            season: seasonNo,
            episode: episodeNo ,
            description: desc,
            thumbnail: thumb,
            episodeLink: episodeLink,
            streams: streams
        };
        if (released != "") {video["released"] = released;}

        this._kanTeenJSONObj[key]["meta"]["videos"].push(video);

    }

    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, subType, type){
        this._kanTeenJSONObj[id] =  {
            id: id, 
            name: seriesTitle, 
            link: seriesPage,
            type: type, 
            subtype: subType,
            meta: {
                id: id,
                type: type,
                name: seriesTitle,
                link: seriesPage,
                background: imgUrl,
                poster: imgUrl,
                posterShape: "poster",
                logo: imgUrl,
                description: seriesDescription,
                genres: genres,
                videos: videosList
            }
        }
        logger.info("addToJsonObject => Added  series, ID: " + id + " Name: " + seriesTitle + " Link: " + seriesPage + " subtype: " + subType);
    }

    writeJSON(){
        logger.trace("writeJSON => Entered");
        logger.debug("writeJSON => All tasks completed - writing file");
        utils.writeJSONToFile(this._kanTeenJSONObj, EXPORT_FILENAME);

        logger.trace("writeJSON => Leaving");

    }
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanTeensScraper;
exports.crawl = this.crawl;
exports.isRunning = this.isRunning;
exports.writeJSON = this.writeJSON;