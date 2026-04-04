const utils = require("./utilities.js");
const {fetchData} = require("./utilities.js");
const {
    LOG4JS,
    KAN_ARCHIVE,
    KAN_DIGITAL_IMAGE_PREFIX,
    SCRAPER_CONFIG,
    TMDB
} = require("./constants.js");
const SUB_PREFIX = "archive";

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

const EXPORT_FILENAME = "stremio-kanarchive";
var logger = log4js.getLogger("KanArchiveScraper");

class KanArchiveScraper {

    constructor() {
        this._kanArchiveJSONObj = {};
        this.isRunning = false;
        this._tmdbEnabled = TMDB.ENABLED;
        this._tmdbCache = new Map(); // Cache TMDB results to avoid duplicate searches

        // Get scraper configuration
        const scraperName = 'KanArchiveScraper';
        const config = SCRAPER_CONFIG[scraperName] || {};
        this.config = {
            parallelFetching: config.parallelFetching ?? SCRAPER_CONFIG.DEFAULT_PARALLEL_FETCHING,
            batchSize: config.batchSize ?? SCRAPER_CONFIG.DEFAULT_BATCH_SIZE,
            delayBetweenBatches: config.delayBetweenBatches ?? SCRAPER_CONFIG.DEFAULT_DELAY_BETWEEN_BATCHES
        };

        logger.info(`KanArchiveScraper initialized - Parallel: ${this.config.parallelFetching}, Batch size: ${this.config.batchSize}, TMDB: ${this._tmdbEnabled}`);
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

    async crawl(isDoWriteFile = false){
        logger.info("Started Crawling");
        this.isRunning = true;
        await this.crawlVod();
        logger.info("Done Crawling");
        
        if (isDoWriteFile){
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }
        this.isRunning = false;
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
        for (var seriesElem of series) {// iterate over series
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
        const seriesKeys = Object.keys(this._kanArchiveJSONObj);
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
        const id = this._kanArchiveJSONObj[key]["id"];
        const subType = this._kanArchiveJSONObj[key]["subtype"];
        const retrieveLink = this._kanArchiveJSONObj[key]["link"] + "?page=1&itemsToShow=1000";

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
            this._kanArchiveJSONObj[key]["meta"]["description"] = this.setDescription(seriesPageDoc.querySelector("div.info-description p"));
        }

        // Set series genres
        this._kanArchiveJSONObj[key]["meta"]["genres"] = this.setGenre(seriesPageDoc.querySelector("div.info-genre"));

        // Set series name
        const titleTemp = seriesPageDoc.querySelector("title").text;
        const title = utils.getNameFromSeriesPage(titleTemp);
        this._kanArchiveJSONObj[key]["meta"]["name"] = title;
        this._kanArchiveJSONObj[key]["name"] = title;

        // Search TMDB for this series
        let tmdbSeriesId = null;
        if (this._tmdbEnabled) {
            tmdbSeriesId = await this.searchTMDBSeries(title);
            if (tmdbSeriesId) {
                logger.info(`processOneSeries => Found TMDB ID ${tmdbSeriesId} for "${title}"`);
                // Add TMDB ID to the series object
                this._kanArchiveJSONObj[key].tmdbId = tmdbSeriesId;
                this._kanArchiveJSONObj[key].meta.tmdbId = tmdbSeriesId;
            } else {
                logger.debug(`processOneSeries => No TMDB ID found for "${title}"`);
            }
        }

        const seasons = seriesPageDoc.querySelectorAll("div.seasons-item");
        logger.debug(`processOneSeries => Series "${title}" has ${seasons.length} season(s)`);

        if (seasons.length > 0) {
            // Multiple seasons and episodes
            await this.getVideos(seasons, id, subType, tmdbSeriesId);
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

            this._kanArchiveJSONObj[key]["meta"]["link"] = episodeLink;
            this._kanArchiveJSONObj[key]["meta"]["description"] = description;
            this._kanArchiveJSONObj[key]["meta"]["poster"] = imgUrl;

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
     * @param {*} tmdbSeriesId
     * @returns Array of video json objects
     *********************************************************/
    async getVideos(videosElems, id, subType, tmdbSeriesId = null){
        const noOfSeasons = videosElems.length;
        logger.info(`getVideos => Processing ${noOfSeasons} season(s) for series ID: ${id}`);

        for (let i = 0; i < noOfSeasons; i++) {
            const seasonNo = noOfSeasons - i;
            const seasonEpisodesElems = videosElems[i].querySelectorAll("a.card-link");

            logger.info(`getVideos => Season ${seasonNo} has ${seasonEpisodesElems.length} episode(s)`);

            // Prepare episode data for batch processing
            const episodeData = [];
            for (let iter = 0; iter < seasonEpisodesElems.length; iter++) {
                episodeData.push({
                    elem: seasonEpisodesElems[iter],
                    seasonNo: seasonNo,
                    episodeNo: iter + 1
                });
            }

            // Process episodes in batches
            await this.processBatch(
                episodeData,
                async (epData, index) => {
                    return await this.processOneEpisode(epData, id, subType, tmdbSeriesId);
                },
                `episodes (Season ${seasonNo})`
            );
        }

        logger.debug(`getVideos => Completed processing all seasons for series ID: ${id}`);
    }

    /**
     * Process a single episode (extracted from getVideos for batch processing)
     */
    async processOneEpisode(epData, id, subType, tmdbSeriesId = null) {
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
            title = seasonEpisodesElem.attrs("title");
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

        // Search TMDB for this episode if we have a series ID
        let tmdbEpisodeId = null;
        if (this._tmdbEnabled && tmdbSeriesId) {
            tmdbEpisodeId = await this.searchTMDBEpisode(tmdbSeriesId, seasonNo, episodeNo);
            if (tmdbEpisodeId) {
                logger.debug(`processOneEpisode => Found TMDB episode ID ${tmdbEpisodeId} for ${videoId}`);
            }
        }

        const streamsArr = [
            {
                url: streams.url,
                type: streams.type,
                name: streams.name,
                description: streams.description
            }
        ];

        this.addVideoToMeta(id, videoId, title, seasonNo, episodeNo, description, episodeLogoUrl, episodePageLink, streams.released, streamsArr, tmdbEpisodeId);
        logger.debug(`processOneEpisode => ✓ Added episode "${title}" (S${seasonNo}E${episodeNo})`);

        return { videoId, title, seasonNo, episodeNo };
    }

    async getStreams(link){
        logger.trace("getStreams => Entering");
        logger.trace("getStreams => Link: " + link);

        var doc = await fetchData(link);

        if (doc == undefined){
            logger.debug("getStreams => Error retrieving doc from " + link);
            return "";
        }
        var released = "";
        var videoUrl = "";
        var nameVideo = "";
        var descVideo = "";

        if (doc.querySelector("li.date-local") != undefined){
            let tempDate = doc.querySelector("li.date-local").getAttribute("data-date-utc");
            const date = new Date(tempDate);
            released = isNaN(date.getTime()) ? "" : date.toISOString();
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

        if (released != "") { streamsJSONObj["released"] = released; }

        logger.trace("getStreams => Exiting");
        return streamsJSONObj;
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

    addVideoToMeta(key, episodeId, name, seasonNo, episodeNo, desc, thumb, episodeLink, released, streams, tmdbEpisodeId = null){
        var video  = {
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

        this._kanArchiveJSONObj[key]["meta"]["videos"].push(video);

    }

    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, subType, type, tmdbSeriesId = null){
        const seriesObj = {
            id: id,
            name: seriesTitle,
            poster: imgUrl,
            description: seriesDescription,
            link: seriesPage,
            background: imgUrl,
            genres: genres,
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

        this._kanArchiveJSONObj[id] = seriesObj;

        logger.info("addToJsonObject => Added  series, ID: " + id + " Name: " + seriesTitle + " Link: " + seriesPage + " subtype: " + subType);
    }

    /**
     * Search TMDB for a series by title (Hebrew)
     * @param {string} title - The series title
     * @param {string} year - Optional year for better matching
     * @returns {Promise<number|null>} - TMDB ID or null if not found
     */
    async searchTMDBSeries(title, year = null) {
        if (!this._tmdbEnabled) {
            logger.debug(`searchTMDBSeries => TMDB not enabled, skipping search for "${title}"`);
            return null;
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

    /**
     * Search TMDB for an episode by series ID, season, and episode number
     * @param {number} tmdbSeriesId - The TMDB series ID
     * @param {number} seasonNumber - Season number
     * @param {number} episodeNumber - Episode number
     * @returns {Promise<number|null>} - TMDB episode ID or null if not found
     */
    async searchTMDBEpisode(tmdbSeriesId, seasonNumber, episodeNumber) {
        if (!this._tmdbEnabled || !tmdbSeriesId) {
            return null;
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

    writeJSON(){
        logger.trace("writeJSON => Entered");
        logger.debug("writeJSON => All tasks completed - writing file");
        utils.writeJSONToFile(this._kanArchiveJSONObj, EXPORT_FILENAME);

        logger.trace("writeJSON => Leaving");

    }
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanArchiveScraper;
exports.crawl = this.crawl;
exports.isRunning = this.isRunning;
exports.writeJSON = this.writeJSON;