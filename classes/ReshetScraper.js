const utils = require("./utilities.js");
const {
    LOG4JS,
    RESHET,
    PREFIX,
    SCRAPER_CONFIG,
    TMDB
} = require ("./constants");
const {fetchData, writeLog, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const log4js = require("log4js");
const TmdbHelper = require("./TmdbHelper.js");

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

var logger = log4js.getLogger("ReshetScraper");

class ReshetScraper {

    constructor(){
        this._reshetJSONObj = {};
        this._buildId = "";
        this._videos = [];
        this.tmdbHelper = new TmdbHelper();
        
        this.deltaTracker = new DeltaTracker();

        // Get scraper configuration
        const scraperName = 'ReshetScraper';
        const config = SCRAPER_CONFIG[scraperName] || {};
        this.config = {
            parallelFetching: config.parallelFetching ?? SCRAPER_CONFIG.DEFAULT_PARALLEL_FETCHING,
            batchSize: config.batchSize ?? SCRAPER_CONFIG.DEFAULT_BATCH_SIZE,
            delayBetweenBatches: config.delayBetweenBatches ?? SCRAPER_CONFIG.DEFAULT_DELAY_BETWEEN_BATCHES
        };

        logger.info(`ReshetScraper initialized - Parallel: ${this.config.parallelFetching}, Batch size: ${this.config.batchSize}, TMDB: `);
    }

    async crawl(isDoWriteFile = false){
        this.deltaTracker.clear();
        await this.crawlVOD();
        logger.info("Delta Summary:", JSON.stringify(this.deltaTracker.getSummary()));

        const { WRITE_TO_GITHUB, UPDATE_DATABASE } = require("./constants.js");

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

    async crawlVOD(){    
        logger.trace("crawl() => Entering");
        //writeLog("TRACE","ReshetScraper-crawl() => Entering");
        
        var seriesListJson =  await this.getJson(RESHET.URL_VOD);
        this._buildId = seriesListJson["buildId"];
        const shows = seriesListJson["props"]["pageProps"]["page"]["Content"]["PageGrid"][0]["shows"];

        // Process series using batch processor
        logger.info(`crawlVOD => Found ${shows.length} Reshet series to process`);
        var reshetId = 1;
        await this.processBatch(
            shows,
            async (series, index) => {
                const result = await this.processOneReshetSeries(series, reshetId + index);
                return result;
            },
            "reshet-series"
        );

        logger.info("crawl() => Exiting");
        //writeLog("TRACE","ReshetScraper-crawl() => Exiting");
    }

    /**
     * Process a single Reshet series (extracted from crawlVOD for batch processing)
     */
    async processOneReshetSeries(series, reshetId) {
        var seriesUrl = series["url"];
        //if no URL we skip
        if ((seriesUrl == undefined) || (seriesUrl.startsWith("/?"))) {
            logger.debug("processOneReshetSeries => No valid URL, skipping");
            return null;
        }

        var id = PREFIX + "reshet_" + reshetId;
        var picUrl = series["poster"];
        var title = series["title"];
        var seriesReshetId = series["id"];
        logger.debug(`processOneReshetSeries => seriesReshetId: ${seriesReshetId} seriesUrl: ${seriesUrl} `);
        seriesUrl = seriesUrl.substring(0,seriesUrl.length -1);
        var seriesReshetName = seriesUrl.substring(seriesUrl.lastIndexOf("/") + 1);
        logger.debug(`processOneReshetSeries => seriesReshetName: ${seriesReshetName}`);

        // Search TMDB for this series
        let tmdbSeriesId = null;
        tmdbSeriesId = await this.tmdbHelper.searchTMDBSeries(title);
        if (tmdbSeriesId) {
            logger.info(`processOneReshetSeries => Found TMDB ID ${tmdbSeriesId} for "${title}"`);
        }

        var videos = await this.getEpisodes(seriesReshetName, id)
        if (videos == "-1"){
            logger.error("processOneReshetSeries => Invalid KulturaId or page non existing. Skipping");
            return null;
        }

        this.addToJsonObject(id, title, RESHET.URL_BASE + seriesUrl, picUrl, "",  "", videos, "r", "series", tmdbSeriesId )
        logger.debug(`processOneReshetSeries => Added series ${title}`);
        return { id, title };
    }

    async getEpisodes(seriesReshetName, id){
        logger.debug("getEpisodes() => Entering");
        //writeLog("TRACE","ReshetScraper-getEpisodes() => Entering");
        var link = RESHET.URL_BASE + "/_next/data/" + this._buildId + "/he/all-shows/" + seriesReshetName + ".json?all=all-shows&all=" + seriesReshetName;
        logger.debug("getEpisodes() => link used " + link);
        var seriesJson =  await fetchData(link, true);
        if (seriesJson == undefined){ 
            logger.error(`getEpisodes() => page not found at ${link}`);
            return "-1";
        }
        var grids = seriesJson["pageProps"]["page"]["Content"]["PageGrid"];
        var videos = [];

        for (var grid of grids){
            if (grid["grid_type"] == "VodPlaylist" ){
                //var seasons = {};
                var seasons = grid["episodesSeasonsMap"];

                var noOfSeasons = seasons.length;
                //the length operator has failed so we need to calculate in a different way
                if (noOfSeasons == undefined){
                    var seasonCounter = 0;
                    for (const [key, episodesList] of Object.entries(seasons)){
                        seasonCounter++;
                    }
                    if (seasonCounter > 0){
                        noOfSeasons = seasonCounter;
                    }
                }
                for (const [key, episodesList] of Object.entries(seasons)) {
                    //var seasonId = noOfSeasons - key + 1;
                    var seasonName = episodesList["name"];
                    var seasonId = this.setSeasonId(seasonName,key);

                    logger.debug("getEpisodes() => Retrieving season " + seasonName + " with ID " + seasonId );
                    var episodes = episodesList["episodes"]
                    var numEpisodes = episodes.length;

                    // Prepare episode data for batch processing (descending order)
                    const episodeData = [];
                    for (let i = 0; i < numEpisodes; i++) {
                        // Process from last to first (highest episode number first)
                        episodeData.push({
                            episode: episodes[numEpisodes - 1 - i],
                            index: numEpisodes - 1 - i,
                            seasonId: seasonId
                        });
                    }

                    // Process episodes in batches
                    logger.info(`getEpisodes() => Processing ${episodeData.length} episodes for season ${seasonId} - descending order`);
                    const episodeResults = await this.processBatch(
                        episodeData,
                        async (epData, index) => {
                            return await this.processOneReshetEpisode(epData, id);
                        },
                        `reshet-episodes (Season ${seasonId})`
                    );

                    // Collect successful videos - they're already in descending order
                    var seasonVideos = [];
                    for (const result of episodeResults) {
                        if (result && result.video) {
                            seasonVideos.push(result.video);
                        }
                    }

                    // Sort by reshetEpisodeId to ensure correct episode numbers
                    // Then reverse to get descending order for display
                    logger.debug("getEpisodes() => Sorting episodes by ID, then reversing for descending order");
                    seasonVideos.sort((a, b) => b.reshetEpisodeId - a.reshetEpisodeId);

                    // Set episode numbers based on sorted order (highest reshetEpisodeId = episode 1 in our list)
                    var iter = 1;
                    for (var videoItem of seasonVideos){
                        videoItem.id = videoItem.id + iter;
                        videoItem.episode = iter;

                        videos.push(videoItem);
                        logger.info(`Added: S${videoItem.season} E${iter} - ${videoItem.name}`);
                        iter ++;
                    }
                }
            }
        }
        return videos;
    }

    /**
     * Process a single Reshet episode (extracted from getEpisodes for batch processing)
     */
    async processOneReshetEpisode(epData, id) {
        const { episode, index, seasonId } = epData;

        var kalturaId = episode["video"]["kalturaId"];
        if (kalturaId == undefined){
            logger.warn("processOneReshetEpisode => No kalturaId found");
            return null;
        }
        var streams = await this.getStream(kalturaId, episode["title"]);

        // Parse Israeli date format
        var released = this.parseIsraeliDate(episode["air_date"]);

        var video = {
            reshetEpisodeId: episode["id"],
            id: id + ":" + seasonId + ":" ,
            name: episode["title"],
            season: seasonId,
            episode: "",
            description: episode["secondaryTitle"],
            thumbnail: episode["video"]["poster"],
            episodeLink: RESHET.URL_BASE + episode["link"],
            streams: streams
        }
        if (released != "") {video["released"] = released;}

        logger.debug("processOneReshetEpisode => ✓ processed episode  " + episode["title"] + " of season " + seasonId);
        return { video };
    }

    async getStream(kalturaId, streamName){
        logger.trace("getStream() => Entering");
        var streams = [];
        var user_data = {
            "1":{
                "service":"session",
                "action":"startWidgetSession",
                "widgetId":"_" + RESHET.PARTNER_ID
            },
            "2":{
                "service":"baseEntry",
                "action":"list",
                "ks":"{1:result:ks}",
                "filter":{
                    "redirectFromEntryId": kalturaId
                },
                "responseProfile":{
                    "type":1,
                    "fields":"id,referenceId,name,description,thumbnailUrl,dataUrl,duration,msDuration,flavorParamsIds,mediaType,type,tags,dvrStatus,externalSourceType,status"
                }
            },
            "3":{
                "service":"baseEntry",
                "action":"getPlaybackContext",
                "entryId":"{2:result:objects:0:id}",
                "ks":"{1:result:ks}",
                "contextDataParams":{
                    "objectType":"KalturaContextDataParams",
                    "flavorTags":"all"
                }
            },
            "4":{
                "service":"metadata_metadata",
                "action":"list",
                "filter":{
                    "objectType":"KalturaMetadataFilter",
                    "objectIdEqual":kalturaId,
                    "metadataObjectTypeEqual":"1"
                },
            "ks":"{1:result:ks}"},
            "apiVersion":"3.3.0",
            "format":1,
            "ks":"",
            "clientTag":"html5:v0.56.1",
            "partnerId": RESHET.PARTNER_ID
        }
        logger.trace("getStream() => Kaltura ID: " + kalturaId);
        var streamJsonObj = await fetchData(RESHET.URL_STREAM, true, user_data, RESHET.HEADERS);
        if (streamJsonObj != undefined) {
            var sources = streamJsonObj[2]["sources"];
            if (sources == undefined){
                return streams;
            }
            for (var source of sources){
                if ((source["url"]) && (source["format"] == "applehttp")){
                    var stream = {
                        url: source["url"],
                        name: streamName
                    }
                    streams.push(stream);
                }
            }
        }
        return streams
    }

    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, subType, type, tmdbSeriesId = null){
        // Sort videos by released date (newest first)
        const sortedVideos = videosList.sort((a, b) => {
            if (!a.released) return 1;
            if (!b.released) return -1;
            return new Date(b.released) - new Date(a.released);
        });

        var jsonObj = {
            id: id,
            link: seriesPage,
            type: type,
            subtype: subType,
            name: seriesTitle,
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
                videos: sortedVideos
            }
        };

        // Add TMDB series ID if found
        if (tmdbSeriesId) {
            jsonObj.meta.tmdbId = tmdbSeriesId;
            jsonObj.tmdbId = tmdbSeriesId;
            logger.debug(`addToJsonObject => Added TMDB ID ${tmdbSeriesId} to series "${seriesTitle}"`);
        }

        this._reshetJSONObj[id] = jsonObj;
        logger.info("addToJsonObject => Added  series, ID: " + id + " Name: " + seriesTitle + " Link: " + seriesPage + " subtype: " + subType);
    }

    async getJson(link){
        logger.trace("getJson() => Entering");
        logger.debug("getJson() => link: " + link);
        var retPage = await fetchData(link);
        var jsonElem = retPage.querySelector("script#__NEXT_DATA__").text;
        var retJson = JSON.parse(jsonElem);
        logger.trace("getJson() => JSON: " + retJson);
        return retJson;
    }

    async updateDatabase() {
        logger.trace("updateDatabase => Entered");
        logger.debug("updateDatabase => Starting bulk database update");

        try {
            const result = await updateDatabaseFromJSON('reshet', this._reshetJSONObj, logger);
            logger.info(`updateDatabase => ✅ Updated ${result.series} series, ${result.videos} videos, ${result.streams} streams in ${result.duration}s`);
        } catch (error) {
            logger.error(`updateDatabase => ❌ Failed to update database: ${error.message}`);
            throw error;
        }

        logger.trace("updateDatabase => Leaving");
    }

    writeJSON(){
        logger.trace("writeJSON => Entered");
        logger.debug("writeJSON => writing file");
        utils.writeJSONToFile(this._reshetJSONObj, "stremio-reshet");
        logger.trace("writeJSON => Leaving");
    }

    setSeasonId(seasonName, seasonKey){
        if ((seasonName != undefined) &&(seasonName.startsWith("עונה "))){
            seasonName = seasonName.replace("עונה ","");
            return seasonName;
        } else {
            return seasonKey;
        }
    }

    /**
     * Parse Israeli date format (DD.MM.YYYY or D.M.YYYY) to ISO format
     * @param {string} dateStr - Date string in Israeli format
     * @returns {string} - ISO date string or empty string if parsing fails
     */
    parseIsraeliDate(dateStr) {
        if (!dateStr || typeof dateStr !== 'string') return "";

        try {
            // Try ISO format first
            const isoMatch = dateStr.match(/(\d{4})-(\d{2})-(\d{2})/);
            if (isoMatch) {
                const date = new Date(dateStr);
                if (!isNaN(date.getTime())) {
                    return date.toISOString();
                }
            }

            // Parse D.M.YYYY, DD.MM.YYYY, D/M/YYYY, DD/MM/YYYY format
            const ilMatch = dateStr.match(/(\d{1,2})[./](\d{1,2})[./](\d{4})/);
            if (ilMatch) {
                const [, day, month, year] = ilMatch;
                const paddedDay = day.padStart(2, '0');
                const paddedMonth = month.padStart(2, '0');
                const date = new Date(`${year}-${paddedMonth}-${paddedDay}T00:00:00`);
                if (!isNaN(date.getTime())) {
                    return date.toISOString();
                }
            }

            // Try direct parsing as last resort
            const date = new Date(dateStr);
            if (!isNaN(date.getTime())) {
                return date.toISOString();
            }

            logger.warn(`parseIsraeliDate => Could not parse date: ${dateStr}`);
            return "";
        } catch (error) {
            logger.error(`parseIsraeliDate => Error: ${error.message}`);
            return "";
        }
    }
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = ReshetScraper;
exports.crawl = this.crawl;
exports.writeJSON = this.writeJSON;
exports.getJson = this.getJson;