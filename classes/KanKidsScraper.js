const utils = require("./utilities.js");
const {fetchData, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    HINUKHIT,
    SCRAPER_CONFIG,
    TMDB
} = require("./constants.js");
const TmdbHelper = require("./TmdbHelper.js");


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

const EXPORT_FILENAME = "stremio-kankids";
var logger = log4js.getLogger("KanKidsScraper");

class KanKidsScraper {

    constructor() {
        this._kanKidsJSONObj = {};
        this.isRunning = false;
        this.tmdbHelper = new TmdbHelper();
        
        this.deltaTracker = new DeltaTracker();

        const scraperName = 'KanKidsScraper';
        const config = SCRAPER_CONFIG[scraperName] || {};
        this.config = {
            parallelFetching: config.parallelFetching ?? SCRAPER_CONFIG.DEFAULT_PARALLEL_FETCHING,
            batchSize: config.batchSize ?? SCRAPER_CONFIG.DEFAULT_BATCH_SIZE,
            delayBetweenBatches: config.delayBetweenBatches ?? SCRAPER_CONFIG.DEFAULT_DELAY_BETWEEN_BATCHES
        };

        logger.info(`KanKidsScraper initialized - Parallel: ${this.config.parallelFetching}, Batch size: ${this.config.batchSize}, TMDB: `);
    }

    async crawl(isDoWriteFile = false){
        logger.info("Started Crawling");
        this.isRunning = true;
        await this.crawlKids();
        logger.info("Done Crawling");
        logger.info("Delta Summary:", JSON.stringify(this.deltaTracker.getSummary()));

        const { WRITE_TO_GITHUB, UPDATE_DATABASE } = require("./constants.js");
const TmdbHelper = require("./TmdbHelper.js");

        if (WRITE_TO_GITHUB || UPDATE_DATABASE) {
            if (WRITE_TO_GITHUB) {
                logger.info("crawl => writing JSON file to GitHub");
                this.writeJSON();
            }

            if (UPDATE_DATABASE) {
                logger.info("crawl => updating database in bulk");
                await this.updateDatabase();
            }
        } else if (isDoWriteFile) {
            // Backward compatibility
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }

        this.isRunning = false;

        logger.info("crawl => Exiting");
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

        // Search TMDB for this series
        let tmdbSeriesId = null;
        tmdbSeriesId = await this.tmdbHelper.searchTMDBSeries(title);
            tmdbSeriesId = await this.tmdbHelper.searchTMDBSeries(seriesTitle);
            if (tmdbSeriesId) {
                logger.info(`processOneKidsSeries => Found TMDB ID ${tmdbSeriesId} for "${seriesTitle}"`);
            } else {
                logger.debug(`processOneKidsSeries => No TMDB ID found for "${seriesTitle}"`);
            }
        }

        var seasons = doc2.querySelectorAll("div.seasons-item.kids");
        this.addToJsonObject(id, seriesTitle,seriesPage,imgUrl,seriesDescription,genres,[],subType,"series", tmdbSeriesId);
        await this.getKidsVideos(seasons, id, subType, tmdbSeriesId);

        logger.debug(`processOneKidsSeries => Added kids series ${seriesTitle}`);
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
    async getKidsVideos(seasons, id, subType, tmdbSeriesId = null){
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
                    return await this.processOneKidsEpisode(epData, id, subType, tmdbSeriesId);
                },
                `kids-episodes (Season ${seasonNo})`
            );
        }
    }

    /**
     * Process a single kids episode (extracted from getKidsVideos for batch processing)
     */
    async processOneKidsEpisode(epData, id, subType, tmdbSeriesId = null) {
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

        // Search TMDB for this episode if we have a series ID
        let tmdbEpisodeId = null;
        tmdbEpisodeId = await this.tmdbHelper.searchTMDBEpisode(tmdbSeriesId, seasonNo, episodeNo);
            tmdbEpisodeId = await this.tmdbHelper.searchTMDBEpisode(tmdbSeriesId, seasonNo, episodeNo);
            if (tmdbEpisodeId) {
                logger.debug(`processOneKidsEpisode => Found TMDB episode ID ${tmdbEpisodeId} for series ${id}, S${seasonNo}E${episodeNo}`);
            }
        }

        var videoId = id + ":" + seasonNo + ":" + episodeNo;

        this.addVideoToMeta(id, videoId, episodeTitle,seasonNo, episodeNo, episodeDescription, episodeImgUrl, episodeLink, released, streamsArr, tmdbEpisodeId);
        logger.debug("processOneKidsEpisode => ✓ Added episode : " + episodeTitle + " " + videoId);
        return { videoId, episodeTitle };
    }

    async getStreams(link){
        logger.trace("getStreams => Entering");
        logger.trace("getStreams => Link: " + link);

        var doc = await fetchData(link);

        if (doc == undefined){
            logger.debug("getStreams => Error retrieving do from " + link);
        }
        var released = "";
        var videoUrl = "";
        var nameVideo = "";
        var descVideo = "";

        // Use centralized date extraction utility
        const dateElement = doc.querySelector("li.date-local");
        released = extractReleaseDate(dateElement);
        if (released) {
            logger.debug("getStreams => Extracted release date: " + released);
        }

        // Try to get stream URL from redge-player element (new Kan player)
        var playerElem = doc.querySelector("[id^='redge-player-']");
        if (playerElem && playerElem.getAttribute("data-hls-url")) {
            videoUrl = playerElem.getAttribute("data-hls-url");
            // Ensure URL has protocol
            if (videoUrl.startsWith("//")) {
                videoUrl = "https:" + videoUrl;
            }
            logger.debug("getStreams => Found redge-player URL: " + videoUrl);
        } else {
            // Fallback to VideoObject method (legacy - Kaltura URLs, may not work)
            logger.debug("getStreams => No redge-player found, falling back to VideoObject");
            var scriptElems = doc.querySelectorAll("script");
            for (var scriptElem of scriptElems){
                if (scriptElem.toString().includes("VideoObject")) {
                    videoUrl = this.getEpisodeUrl(scriptElem.toString());
                    // Ensure URL has protocol
                    if (videoUrl.startsWith("//")) {
                        videoUrl = "https:" + videoUrl;
                    }
                    break;
                }
            }
        }

        if (videoUrl == "") {
            return "-1";
        }

        if (doc.querySelectorAll("div.info-title h1.h2").length > 0){
            nameVideo = doc.querySelectorAll("div.info-title h1.h2")[0].text.trim();
            nameVideo = this.getVideoNameFromEpisodePage(nameVideo);
        } else if (doc.querySelector("title")) {
            nameVideo = doc.querySelector("title").text.trim();
            nameVideo = this.getVideoNameFromEpisodePage(nameVideo);
        }

        if (doc.querySelector("div.info-description") != null){
            descVideo = doc.querySelector("div.info-description").text.trim();
        }

        var streamsJSONObj = {
            url: videoUrl,
            type: "series",
            name: nameVideo,
            description: descVideo,
        };
        if (released != "") { streamsJSONObj["released"] = released;}
        logger.trace("getStreams => Exiting");
        return streamsJSONObj;
    }

    setDescription(seriesElems){
        var description = "";
        if (seriesElems.length < 1) {return description;}
        description = seriesElems.text.trim() +".\n";

        return description;
    }

    addVideoToMeta(key, episodeId, name, seasonNo, episodeNo, desc, thumb, episodeLink, released, streams, tmdbEpisodeId = null){
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
        if (tmdbEpisodeId) {video["tmdbEpisodeId"] = tmdbEpisodeId;}

        this._kanKidsJSONObj[key]["meta"]["videos"].push(video);
        logger.info(`Added: S${seasonNo} E${episodeNo} - ${name}`);
    }

    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, subType, type, tmdbSeriesId = null){
        const seriesObj = {
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
        };

        // Add TMDB series ID if found
        if (tmdbSeriesId) {
            seriesObj.meta.tmdbId = tmdbSeriesId;
            seriesObj.tmdbId = tmdbSeriesId; // Also at top level for easy access
            logger.debug(`addToJsonObject => Added TMDB ID ${tmdbSeriesId} to series "${seriesTitle}"`);
        }

        this._kanKidsJSONObj[id] = seriesObj;
        logger.info("addToJsonObject => Added  series, ID: " + id + " Name: " + seriesTitle + " Link: " + seriesPage + " subtype: " + subType);
    }

            // Check cache first
        const cacheKey = `${title}${year ? `_${year}` : ''}`;
        if (this._tmdbCache.has(cacheKey)) {
            logger.debug(`searchTMDBSeries => Cache hit for "${title}"`);
            return this._tmdbCache.get(cacheKey);
        }

        try {
            // Build search URL with Hebrew language
            let searchUrl = `${TMDB.BASE_URL}${TMDB.SEARCH_ENDPOINT}?api_key=${TMDB.API_KEY}&language=${TMDB.LANGUAGE}&query=${encodeURIComponent(title)}`;

            if (year) {
                searchUrl += `&first_air_date_year=${year}`;
            }

            logger.debug(`searchTMDBSeries => Searching TMDB for "${title}"${year ? ` (${year})` : ''}`);

            const response = await fetchData(searchUrl, false);

            if (!response || !response.results || response.results.length === 0) {
                logger.debug(`searchTMDBSeries => No results found for "${title}"`);
                this._tmdbCache.set(cacheKey, null);
                return null;
            }

            // Get first result's TMDB ID
            const tmdbId = response.results[0].id;
            logger.info(`searchTMDBSeries => Found TMDB ID ${tmdbId} for "${title}" (original_title: ${response.results[0].original_name || 'N/A'})`);

            // Cache the result
            this._tmdbCache.set(cacheKey, tmdbId);

            return tmdbId;

        } catch (error) {
            logger.error(`searchTMDBSeries => Error searching TMDB for "${title}":`, error.message);
            this._tmdbCache.set(cacheKey, null);
            return null;
        }
    }

            try {
            const episodeUrl = `${TMDB.BASE_URL}/tv/${tmdbSeriesId}/season/${seasonNumber}/episode/${episodeNumber}?api_key=${TMDB.API_KEY}`;

            logger.debug(`searchTMDBEpisode => Fetching TMDB episode data for series ${tmdbSeriesId}, S${seasonNumber}E${episodeNumber}`);

            const response = await fetchData(episodeUrl, false);

            if (!response || !response.id) {
                logger.debug(`searchTMDBEpisode => Episode not found for S${seasonNumber}E${episodeNumber}`);
                return null;
            }

            const tmdbEpisodeId = response.id;
            logger.debug(`searchTMDBEpisode => Found TMDB episode ID ${tmdbEpisodeId} for S${seasonNumber}E${episodeNumber}`);

            return tmdbEpisodeId;

        } catch (error) {
            logger.error(`searchTMDBEpisode => Error searching TMDB for episode:`, error.message);
            return null;
        }
    }

    async updateDatabase() {
        logger.trace("updateDatabase => Entered");
        logger.debug("updateDatabase => Starting bulk database update");

        try {
            const result = await updateDatabaseFromJSON('kankids', this._kanKidsJSONObj, logger);
            logger.info(`updateDatabase => ✅ Updated ${result.series} series, ${result.videos} videos, ${result.streams} streams in ${result.duration}s`);
        } catch (error) {
            logger.error(`updateDatabase => ❌ Failed to update database: ${error.message}`);
            throw error;
        }

        logger.trace("updateDatabase => Leaving");
    }

    writeJSON(){
        logger.trace("writeJSON => Entered");
        logger.debug("writeJSON => All tasks completed - writing file");
        utils.writeJSONToFile(this._kanKidsJSONObj, EXPORT_FILENAME);

        logger.trace("writeJSON => Leaving");

    }
}

/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanKidsScraper;
exports.crawl = this.crawl;
exports.isRunning = this.isRunning;
exports.writeJSON = this.writeJSON;