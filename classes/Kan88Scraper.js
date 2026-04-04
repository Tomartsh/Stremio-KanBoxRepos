const utils = require("./utilities.js");
const {fetchData} = require("./utilities.js");
const {
    LOG4JS,
    KAN88_POCASTS_URL,
    SCRAPER_CONFIG,
    TMDB
} = require("./constants.js");
const SUB_PREFIX = "kan88";

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

const EXPORT_FILENAME = "stremio-kan88";
var logger = log4js.getLogger("Kan88Scraper");

class Kan88Scraper {

    constructor() {
        this._kanPodcastsJSONObj = {};
        this.seriesIdIterator = 11000;
        this.isRunning = false;
        this._tmdbEnabled = TMDB.ENABLED;
        this._tmdbCache = new Map();

        // Get scraper configuration
        const scraperName = 'Kan88Scraper';
        const config = SCRAPER_CONFIG[scraperName] || {};
        this.config = {
            parallelFetching: config.parallelFetching ?? SCRAPER_CONFIG.DEFAULT_PARALLEL_FETCHING,
            batchSize: config.batchSize ?? SCRAPER_CONFIG.DEFAULT_BATCH_SIZE,
            delayBetweenBatches: config.delayBetweenBatches ?? SCRAPER_CONFIG.DEFAULT_DELAY_BETWEEN_BATCHES
        };

        logger.info(`Kan88Scraper initialized - Parallel: ${this.config.parallelFetching}, Batch size: ${this.config.batchSize}, TMDB: ${this._tmdbEnabled}`);
    }

    async crawl(isDoWriteFile = false){
        logger.info("Started Crawling");
        this.isRunning = true;
        await this.crawlKan88();
        logger.info("Done Crawling");

        if (isDoWriteFile){
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }
        this.isRunning = false;
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

        // Search TMDB for this series
        let tmdbSeriesId = null;
        if (this._tmdbEnabled) {
            tmdbSeriesId = await this.searchTMDBSeries(seriesTitle);
            if (tmdbSeriesId) {
                logger.info(`processOnePodcast => Found TMDB ID ${tmdbSeriesId} for "${seriesTitle}"`);
            }
        }

        this.addToJsonObject(id,seriesTitle,podcastLink,podcastImageUrl,seriesDescription,genres,[],"8","Podcasts", tmdbSeriesId);
        await this.getpodcastEpisodeVideos(podcastLink, id);

        logger.debug("processOnePodcast => Added Kan 88 podcast " + seriesTitle);
        return { id, seriesTitle };
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
        if ((lastPageNo) && (parseInt(lastPageNo) >= 0) ){
            var intLastPageNo = parseInt(lastPageNo);
            for (var i = 0 ; i < intLastPageNo ; i++){
                if (i == 0){
                    var podcastEpisodesToCheck = podcastSeriesPageDoc.querySelectorAll("div.card.card-row");
                    for (var episodeChecked of podcastEpisodesToCheck){
                        var hrefObj = episodeChecked.querySelector("a.card-body")
                        var episodeLink = hrefObj.getAttribute("href");

                        var docToCheck = await fetchData(episodeLink);//check if there is an episode on the oher side or more episodes
                        var card = docToCheck.querySelector("h2.title");
                        if (card != undefined){ //this is an episode so let's get the  stream while we have the data
                            var streams = this.getPodcastStream(docToCheck);
                            podcastEpisodes.push({
                                episode: episodeChecked,
                                stream: streams
                            });
                        } else {
                            //var subPageHref = podcastEpisodesToCheck.querySelector("a.card-body").etAttribute("href");
                            var docSubPage = await fetchData(episodeLink);
                            var episodesToCheck = docSubPage.querySelectorAll("div.card.card-row");
                            for (var episodeToCheck of episodesToCheck){
                                var streams = this.getPodcastStream(episodeToCheck);
                                podcastEpisodes.push({
                                    episode: episodeToCheck,
                                    stream: streams
                            });
                            }
                        }                 
                    }
                    i = 1;
                    continue
                }
                logger.trace("getpodcastEpisodeVideos => calling fetchPage with URL: " + podcastSeriesLink + "?page=" + i);
                var podcastsAdditionalPages = await fetchData(podcastSeriesLink + "?page=" + i);
                var podcastElems = podcastsAdditionalPages.querySelectorAll("div.card.card-row");

                for (var additionalPodcast of podcastElems){
                    var hrefObj = additionalPodcast.querySelector("a.card-body")
                    var episodeLink = hrefObj.getAttribute("href");

                    var docToCheck = await fetchData(episodeLink);//check if there is an episode on the oher side or more episodes
                    if (docToCheck == undefined){ continue; }
                    var card = docToCheck.querySelector("h2.title");
                    if (card != undefined){ //this is an episode so let's get the  stream while we have the data
                        var streams =  this.getPodcastStream(docToCheck);
                        podcastEpisodes.push({
                            episode: additionalPodcast,
                            stream: streams
                        });
                    } else {
                        var docSubPage = await fetchData(episodeLink);
                        var episodesToCheck = docSubPage.querySelectorAll("div.card.card-row");
                        for (var episodeToCheck of episodesToCheck){
                            var streams = this.getPodcastStream(episodeToCheck);
                            podcastEpisodes.push({
                                episode: episodeToCheck,
                                stream: streams
                        });
                        }
                    }
                }
            }
        }

        var podcastEpisodesVideos = [];

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
        return podcastEpisodesVideos;
    }

    /**
     * Process a single Kan 88 podcast episode (extracted from getpodcastEpisodeVideos for batch processing)
     */
    async processOneKan88Episode(episodeData, id) {
        const { episode: episodeElement, stream: streams, episodeNo } = episodeData;

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
        if (released != "") { video["released"] = released;}

        this._kanPodcastsJSONObj[key]["meta"]["videos"].push(video);

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
            seriesObj.tmdbId = tmdbSeriesId;
            logger.debug(`addToJsonObject => Added TMDB ID ${tmdbSeriesId} to series "${seriesTitle}"`);
        }

        this._kanPodcastsJSONObj[id] = seriesObj;

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

    writeJSON(){
        logger.trace("writeJSON => Entered");
        logger.debug("writeJSON => All tasks completed - writing file");
        utils.writeJSONToFile(this._kanPodcastsJSONObj, EXPORT_FILENAME);

        logger.trace("writeJSON => Leaving");

    }
}

/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = Kan88Scraper;
exports.crawl = this.crawl;
exports.isRunning = this.isRunning;
exports.writeJSON = this.writeJSON;