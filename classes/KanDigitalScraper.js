const utils = require("./utilities.js");
const {fetchData, getNameFromSeriesPage, extractReleaseDate, DeltaTracker, extractLatestDateFromList, hasNewEpisode, hasSeriesChanged} = require("./utilities.js");
const {
    LOG4JS,
    KAN_URL_ADDRESS,
    KAN_DIGITAL_IMAGE_PREFIX,
    KAN_BOX_URL,
    KAN_BOX_IGNORE_LIST,
    SCRAPER_CONFIG,
    TMDB
} = require("./constants.js");
const TmdbHelper = require("./TmdbHelper.js");
const SUB_PREFIX = "dogital";
const SUBTYPE = "d";

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

const EXPORT_FILENAME = "stremio-kandigital";
var logger = log4js.getLogger("KanDigitalScraper");

class KanDigitalScraper {

    constructor() {
        this._kanDigitalJSONObj = {};
        this.seriesIdIterator = 1000;
        this.isRunning = false;
        this.tmdbHelper = new TmdbHelper();
        this.deltaTracker = new DeltaTracker();

        const scraperName = 'KanDigitalScraper';
        const config = SCRAPER_CONFIG[scraperName] || {};
        this.config = {
            parallelFetching: config.parallelFetching ?? SCRAPER_CONFIG.DEFAULT_PARALLEL_FETCHING,
            batchSize: config.batchSize ?? SCRAPER_CONFIG.DEFAULT_BATCH_SIZE,
            delayBetweenBatches: config.delayBetweenBatches ?? SCRAPER_CONFIG.DEFAULT_DELAY_BETWEEN_BATCHES
        };

        logger.info(`KanDigitalScraper initialized - Parallel: ${this.config.parallelFetching}, Batch size: ${this.config.batchSize}, TMDB: ${this.tmdbHelper._enabled}`);
    }

    async crawl(isDoWriteFile = false){
        logger.info("Started Crawling");
        this.isRunning = true;
        this.deltaTracker.clear();

        try {
            await this.crawlVod();
        } catch (error) {
            logger.error(`crawl => Kan-Digital scraping failed: ${error.message}`);
            logger.error(error.stack);
        }

        try {
            await this.crawlKanBox();
        } catch (error) {
            logger.error(`crawl => Kan-Box scraping failed: ${error.message}`);
            logger.error(error.stack);
        }

        logger.info("Done Crawling");
        logger.info("Delta Summary:", JSON.stringify(this.deltaTracker.getSummary()));

        const { WRITE_TO_GITHUB, UPDATE_DATABASE } = require('./constants.js');

        if (WRITE_TO_GITHUB || UPDATE_DATABASE) {
            if (WRITE_TO_GITHUB) {
                logger.info("crawl => writing JSON file to GitHub");
                this.writeJSON();
            }

            if (UPDATE_DATABASE) {
                logger.info("crawl => 🚀 Starting bulk database update...");
                await this.updateDatabase();
                logger.info("crawl => ✅ Bulk database update completed!");
            }
        } else if (isDoWriteFile) {
            // Backward compatibility with old parameter
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }

        logger.info("crawl =========== ✅ ALL OPERATIONS COMPLETE ===========");
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

    /***********************************************************
     *
     * Kan Digital handling
     *
     ***********************************************************/
    async crawlVod(){
        logger.trace("crawlVod => Entered");
        
        // get the JSON from the site contaitning all the series.
        var seriesJson;
        var doc = await fetchData(KAN_URL_ADDRESS);

        if (!doc) {
            logger.error("crawlVod => Could not retrieve data from Kan. Skipping this crawl.");
            return; // Nothing to see here, go back to the beggining
        }

        // get all script elements
        var scriptElems = doc.querySelectorAll('script');
        
        //Initialize items as an empty array at the function level scope
        let items = [];
        
        // find the script element with the json of the series
        const targetScript = scriptElems.find(script => script.rawText.includes('digitalSeries:'));
        if (targetScript) {
            const scriptContent = targetScript.rawText;

            try {
                // Extract the JSON portion - use better regex to handle full array
                const jsonMatch = scriptContent.match(/digitalSeries:\s*(\[[\s\S]*\])\s*,\s*[\w]+:/);

                if (jsonMatch && jsonMatch[1]) {
                    let rawJsonString = jsonMatch[1].trim();

                    //Parse it
                    items = JSON.parse(rawJsonString);

                    logger.info(`Success! Found ${items.length} Digital Series items.`);

                    // Warn if pagination detected
                    if (items.length === 100 || items.length === 50 || items.length === 20) {
                        logger.warn(`⚠️  Found exactly ${items.length} series - this might be a pagination limit`);
                        logger.warn(`⚠️  Last series ID: ${items[items.length - 1]?.Url || 'unknown'}`);
                    }
                } else {
                    // Fallback to original method
                    const fallbackMatch = scriptContent.match(/digitalSeries:\s*(\[[\s\S]*?\])/);
                    if (fallbackMatch && fallbackMatch[1]) {
                        let rawJsonString = fallbackMatch[1].trim();
                        items = JSON.parse(rawJsonString);
                        logger.debug(`Fallback method found ${items.length} Digital Series items.`);
                    }
                }
            } catch (error) {
                logger.error(`Failed to parse digitalSeries JSON: ${error.message}`);
                logger.error("The website structure might have changed");
            }
        } else {
             logger.error("Could not find a script containing 'digitalSeries: [' - website structure may have changed");
        }

        // Process series using batch processor
        logger.info(`crawlVod => Found ${items.length} digital series to process`);
        await this.processBatch(
            items,
            async (item, index) => {
                return await this.processOneDigitalSeries(item);
            },
            "digital-series"
        );

        logger.trace("crawl() => Exiting");
    }

    /***********************************************************
     *
     * Kan-Box handling
     *
     ***********************************************************/
    async crawlKanBox(){
        logger.trace("crawlKanBox => Entering");
        logger.info("crawlKanBox => Starting Kan-Box scraping");

        const { parse } = require('node-html-parser');

        try {
            // Fetch Kan-Box lobby page
            logger.info(`crawlKanBox => Fetching: ${KAN_BOX_URL}`);
            const response = await fetchData(KAN_BOX_URL, false);
            const html = response;
            const root = parse(html);

            // Find all block-list items (categories)
            const blockLists = root.querySelectorAll('.block-list');
            logger.info(`crawlKanBox => Found ${blockLists.length} block-list sections`);

            let allCategories = [];

            // Extract categories and their series from all block-lists
            blockLists.forEach((blockList, index) => {
                const items = blockList.querySelectorAll('.block-list-item');
                logger.debug(`crawlKanBox => Section ${index + 1}: ${items.length} categories`);

                items.forEach((item) => {
                    const titleElem = item.querySelector('.h3.title-elem');
                    const linkElem = item.querySelector('a.unstyled-link');

                    if (titleElem && linkElem) {
                        const categoryName = titleElem.text.trim();
                        const categoryLink = linkElem.getAttribute('href');

                        // Extract series directly from the category item
                        // The category items contain series links
                        const seriesLinks = item.querySelectorAll('a.card-link');

                        allCategories.push({
                            name: categoryName,
                            link: categoryLink,
                            seriesLinks: Array.from(seriesLinks).map(link => link.getAttribute('href')).filter(url => url)
                        });
                    }
                });
            });

            logger.info(`crawlKanBox => Total categories found: ${allCategories.length}`);

            // Filter out ignored categories
            const categoriesToScrape = allCategories.filter(cat => !KAN_BOX_IGNORE_LIST.includes(cat.name));
            const ignoredCount = allCategories.length - categoriesToScrape.length;

            logger.info(`crawlKanBox => Ignored: ${ignoredCount} categories`);
            logger.info(`crawlKanBox => To scrape: ${categoriesToScrape.length} categories`);

            // Scrape series directly from Kan-Box page (no additional requests!)
            let totalSeriesFound = 0;
            let duplicateCount = 0;

            for (const category of categoriesToScrape) {
                logger.info(`crawlKanBox => Processing category: ${category.name} (${category.seriesLinks.length} series)`);

                // Process each series link found in this category
                for (const seriesUrl of category.seriesLinks) {
                    if (!seriesUrl) continue;

                    // Build full URL - check if it's already a full URL or relative
                    let fullSeriesUrl = seriesUrl;
                    if (seriesUrl.startsWith('/')) {
                        // Relative path - prepend base URL
                        fullSeriesUrl = KAN_DIGITAL_IMAGE_PREFIX + seriesUrl;
                    } else if (!seriesUrl.startsWith('http')) {
                        // Not a full URL and not starting with / - treat as relative
                        fullSeriesUrl = KAN_DIGITAL_IMAGE_PREFIX + '/' + seriesUrl;
                    }
                    // If it already starts with http, use as-is

                    // Generate series ID to check for duplicates
                    const seriesId = utils.generateSeriesId(fullSeriesUrl, SUB_PREFIX);

                    // Check if this series already exists in our catalog (from Kan-Digital)
                    if (this._kanDigitalJSONObj.hasOwnProperty(seriesId)) {
                        logger.debug(`crawlKanBox => Duplicate found: ${seriesId} - skipping`);
                        this.deltaTracker.skipSeries(); // Track skipped duplicate
                        duplicateCount++;
                        continue;
                    }

                    // Create a minimal item object for processOneDigitalSeries
                    const item = {
                        Url: fullSeriesUrl,
                        Image: '',
                        ImageAlt: '',
                        Description: `From Kan-Box category: ${category.name}`
                    };

                    // Process the series using existing method
                    try {
                        const result = await this.processOneDigitalSeries(item);
                        if (result) {
                            totalSeriesFound++;
                            logger.info(`crawlKanBox => Added series from ${category.name}: ${result.title}`);
                        }
                    } catch (error) {
                        logger.error(`crawlKanBox => Error processing series ${fullSeriesUrl}: ${error.message}`);
                    }
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
     * Process a single digital series (extracted from crawlVod for batch processing)
     */
    async processOneDigitalSeries(item) {
        let title = item.ImageAlt; // Usually the show name
        let pageUrl = item.Url; //URL of the series episodes
        const description = item.Description;

        //set the series URL
        if (pageUrl == undefined) {
            logger.debug("processOneDigitalSeries => No pageUrl, skipping");
            return null;
        }
        if (pageUrl.includes("kan-actual")){
            logger.debug("processOneDigitalSeries => Skipping news item");
            return null;
        }
        if (pageUrl.includes("archive")){
            logger.debug("processOneDigitalSeries => Skipping archive item");
            return null;
        }
        if (pageUrl.includes("podcasts")){
            logger.debug("processOneDigitalSeries => Skipping podcast item");
            return null;
        }
        if ((! pageUrl.includes("/content/kan/")) && (! pageUrl.includes("dig/digital"))) {
            logger.debug("processOneDigitalSeries => URL doesn't match digital series pattern");
            return null;
        }
        if (pageUrl.startsWith("/")) { pageUrl = KAN_URL_ADDRESS + pageUrl; }

        var id = utils.generateSeriesId(pageUrl, SUB_PREFIX);
        var imgUrl = KAN_DIGITAL_IMAGE_PREFIX + item.Image;

        //get the doc of the series
        var seriesPageDoc;
        try{
            seriesPageDoc = await fetchData(`${pageUrl}?page=1&itemsToShow=1000`);
        } catch (e){
            logger.error(`processOneDigitalSeries => could not retrieve series page doc from URL ${pageUrl}. Error: ${e}`);
            return null;
        }

        //verify there is a name to the series
        if (title.trim() == ""){
            logger.info("processOneDigitalSeries => Title is empty. Attempting to retrieve it");
            logger.trace("processOneDigitalSeries => Attempting to retrieve from img.img-fluid");
            if (seriesPageDoc.querySelector("img.img-fluid").getAttribute("title")){
                title = getNameFromSeriesPage(seriesPageDoc.querySelector("img.img-fluid").getAttribute("title"));
            } else if (seriesPageDoc.querySelector("h2.title.h1")){
                title = getNameFromSeriesPage(seriesPageDoc.querySelector("h2.title.h1").text.trim());
            }
        }

        //set series genres
        const genres = this.setGenre(seriesPageDoc.querySelector("div.info-genre"));

        // Search TMDB for this series
        let tmdbSeriesId = null;
        tmdbSeriesId = await this.tmdbHelper.searchTMDBSeries(title);
        if (tmdbSeriesId) {
            logger.info(`processOneDigitalSeries => Found TMDB ID ${tmdbSeriesId} for "${title}"`);
        } else {
            logger.debug(`processOneDigitalSeries => No TMDB ID found for "${title}"`);
        }

        //Get the seasons number
        var seasons = seriesPageDoc.querySelectorAll("div.seasons-item");
        var videoObj = [];
        if ((seasons != undefined) && (seasons.length > 0)){ //generate videos object with media links(streams)
            logger.debug("processOneDigitalSeries => seasons " + title + " length: " + seasons.length);
            videoObj = await this.getVideos(seasons, id, tmdbSeriesId);

        } else {
            // probably no episodes, only a single movie
            if (! seriesPageDoc.querySelector("a.btn.with-arrow")){
                logger.debug("processOneDigitalSeries => No video button found, skipping");
                return null;
            }
            var moveiLink = seriesPageDoc.querySelector("a.btn.with-arrow").getAttribute("href");
            videoObj = await this.getVideo(moveiLink, id);
        }
        if ((videoObj == null) || (videoObj.length == 0)){
            logger.warn(`processOneDigitalSeries => could not find videos for series ${title} @ URL ${pageUrl}`);
            return null;
        } else {
            // last minute checks before add the series
            //check that we have a valid name for the series

            this.addToJsonObject(id, title, pageUrl, imgUrl,description,genres,videoObj,"series", tmdbSeriesId);
            logger.debug(`processOneDigitalSeries => Added series ${title}`);
            return { id, title };
        }
    }

     /**
     * Get the video element in case of a single episode (movie)
     * @param {*} url - The link to the movie page
     */
    async getVideo(url, id){
        logger.trace("getVideo => Entering");
        try {
            var movieDoc = await fetchData(url);
        } catch (e) {
            logger.error(`getVideo => could not retrieve movie page doc from URL ${url}. Error: ${e}`);
            return null;
        }

        // Try to get stream URL from redge-player element (new Kan player)
        var playerElem = movieDoc.querySelector("[id^='redge-player-']");
        if (playerElem && playerElem.getAttribute("data-hls-url")) {
            let videoUrl = playerElem.getAttribute("data-hls-url");
            if (videoUrl.startsWith("//")) {
                videoUrl = "https:" + videoUrl;
            }
            logger.debug("getVideo => Found redge-player URL: " + videoUrl);

            // Get metadata from the page
            let name = "";
            let desc = "";
            let released = "";

            if (movieDoc.querySelectorAll("div.info-title h1.h2").length > 0) {
                name = movieDoc.querySelectorAll("div.info-title h1.h2")[0].text.trim();
                name = this.getVideoNameFromEpisodePage(name);
            } else if (movieDoc.querySelector("title")) {
                name = movieDoc.querySelector("title").text.trim();
                name = this.getVideoNameFromEpisodePage(name);
            }

            if (movieDoc.querySelector("div.info-description") != null) {
                desc = movieDoc.querySelector("div.info-description").text.trim();
            }

            if (movieDoc.querySelector("li.date-local") != undefined) {
                const dateStr = movieDoc.querySelector("li.date-local").getAttribute("data-date-utc");
                logger.debug("getVideo => Found date string: " + dateStr);
                if (dateStr) {
                    // Parse DD.MM.YYYY HH:MM:SS format
                    const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2})?:?(\d{2})?:?(\d{2})?/);
                    if (match) {
                        const [, day, month, year, hour = "00", min = "00", sec = "00"] = match;
                        const date = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
                        released = isNaN(date.getTime()) ? "" : date.toISOString();
                        logger.debug("getVideo => Parsed release date: " + released);
                    }
                }
            }

            const episodeId = `${id}:1:1`;
            let stream = {
                url: videoUrl,
                title: name,
                name: name
            };

            return [{
                id: episodeId,
                name: name,
                season: 1,
                episode: 1,
                description: desc,
                thumbnail: "",
                episodeLink: url,
                released: released,
                streams: [stream]
            }];
        }

        // Fallback to VideoObject method (legacy)
        let scripts = movieDoc.querySelectorAll('script[type="application/ld+json"]');
        let videosList = this.getStream(scripts, id, url);

        if ((videosList == null) || (videosList.length == 0)) {
            logger.warn(`getVideo => No VideoObject found in the movie page at URL ${url}`);
        }
        return videosList;

    }

getStream (scripts, id, url){
    logger.trace("getStream => Entering");
    for (const script of scripts){
        try {
            let scriptContent = script.text || script.innerText || script.rawText;

            // First check if it's a VideoObject before doing any processing
            if (!scriptContent.includes('"@type"') || !scriptContent.includes('VideoObject')) {
                continue; // Skip if not a VideoObject
            }

            // Only handle HTML entities - keep all quotes as they are
            scriptContent = scriptContent
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .replace(/&#xD;&#xA;/g, '\n')
                .replace(/&#xD;/g, '\n')
                .replace(/&#xA;/g, '\n')
                .trim();

            // Split into lines
            const lines = scriptContent.split('\n');
            
            let name = '';
            let desc = '';
            let thumb = '';
            let episodeLink = '';
            let inDescription = false;
            let descriptionLines = [];
            let released = '';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Skip empty lines
                if (!line) continue;
                
                //skip {, }, @context, @type
                if (line.startsWith('{') || line.endsWith('}') || line.startsWith('"@context') || line.startsWith('"@type')) { continue; }

                // Handle multi-line description continuation first
                if (inDescription) {
                    if (line.endsWith('",') || line.endsWith('"')) {
                        // End of description
                        descriptionLines.push(line.replace(/",?$/, ''));
                        desc = descriptionLines.join('\n');
                        inDescription = false;
                        descriptionLines = [];
                    } else {
                        descriptionLines.push(line);
                    }
                    continue; // Skip other checks while in description mode
                }
                
                // Extract name
                if (line.includes('"name":')) {
                    const match = line.match(/"name":\s*"([^"]+)"/);
                    if (match) {
                        name = match[1];
                    }
                    continue;
                }
                
                // Extract description (might span multiple lines)
                if (line.includes('"description":')) {
                    const match = line.match(/"description":\s*"(.*)$/);
                    if (match) {
                        const content = match[1];
                        // Check if description ends on same line
                        if (content.endsWith('",') || content.endsWith('"')) {
                            desc = content.replace(/",?$/, '');
                        } else {
                            // Description continues on next lines
                            inDescription = true;
                            descriptionLines.push(content);
                        }
                    }
                    continue;
                }
                
                // Extract thumbnailUrl
                if (line.includes('"thumbnailUrl":')) {
                    const match = line.match(/"thumbnailUrl":\s*"([^"]+)"/);
                    if (match) {
                        thumb = match[1];
                    }
                    continue;
                }
                
                // Extract contentUrl
                if (line.includes('"contentUrl":')) {
                    const match = line.match(/"contentUrl":\s*"([^"]+)"/);
                    if (match) {
                        episodeLink = match[1];
                    }
                    continue;
                }
                
                // Extract release date
                if (line.includes('"uploadDate":')) {
                    const match = line.match(/"uploadDate":\s*"([^"]+)"/);
                    if (match) {
                        let tempDate = match[1];
                        const date = new Date(tempDate);
                        released = isNaN(date.getTime()) ? "" : date.toISOString();
                    }
                    continue;
                }
            }

            // Verify we got the essential fields
            var videosList = [];

            if (!episodeLink){  
                logger.warn(`getStream => Missing contentUrl in VideoObject at URL ${url}`);
                return videosList;
            }


            const episodeId = `${id}:1:1`;
            let stream = {
                    url: episodeLink,
                    title: name,
                    name: name
            }

            videosList.push({
                id: episodeId,
                name: name,
                season: 1,
                episode: 1,
                description: desc,
                thumbnail: thumb,
                episodeLink: url,
                released: released,
                streams: [stream]
            });
            logger.info(`getStream => Successfully extracted VideoObject: ${name}`);
            return videosList;

                
        } catch (e) {
            logger.debug("getStream => Error processing VideoObject: " + e);
            return [];
        }
    }
}
    /**********************************************************
     * receive the video elements with ID of series and
     * retrieve the list of videos and streams
     * @param {*} videosElems
     * @param {*} id
     * @param {*} tmdbSeriesId
     * @returns Array of video json objects
     *********************************************************/
    async getVideos(videosElems, id, tmdbSeriesId = null){
        var videosArr = [];

        var noOfSeasons = videosElems.length;
        logger.info(`getVideos => Processing ${noOfSeasons} season(s) for series ID: ${id}`);

        for (var i = 0 ; i < noOfSeasons; i++){//iterate over seasons
            var seasonNo = noOfSeasons - i;
            var seasonEpisodesElems = videosElems[i].querySelectorAll("a.card-link");

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
            const episodeResults = await this.processBatch(
                episodeData,
                async (epData, index) => {
                    return await this.processOneDigitalEpisode(epData, id, tmdbSeriesId);
                },
                `episodes (Season ${seasonNo})`
            );

            // Add successful episodes to videosArr
            for (const result of episodeResults) {
                if (result && result.video) {
                    videosArr.push(result.video);
                    logger.info(`Added: S${result.video.season} E${result.video.episode} - ${result.video.name}`);
                }
            }
        }

        logger.debug(`getVideos => Completed processing all seasons for series ID: ${id}`);
        return videosArr;
    }

    /**
     * Process a single digital episode (extracted from getVideos for batch processing)
     * NOTE: Stream URLs are NOT fetched during scraping to avoid rate limiting.
     * The episodeLink is stored and streams are resolved on-demand when user plays.
     */
    async processOneDigitalEpisode(epData, id, tmdbSeriesId = null) {
        const { elem: seasonEpisodesElem, seasonNo, episodeNo } = epData;

        logger.trace(`processOneDigitalEpisode => season: ${seasonNo} episode: ${episodeNo}`);

        var episodePageLink = seasonEpisodesElem.getAttribute("href");

        if (episodePageLink.includes("p-12385/s4")){//season 4 of this series yields no episode. Skipping.
            logger.debug(`processOneDigitalEpisode => Skipping season: ${seasonNo} of id ${id} due to no episodes`);
            return null;
        }
        if (episodePageLink.startsWith("/")){
            episodePageLink = KAN_DIGITAL_IMAGE_PREFIX + episodePageLink;
        }
        var title = "";
        if (seasonEpisodesElem.querySelector("div.card-title")) {
            title = seasonEpisodesElem.querySelector("div.card-title").text.trim();
        } else {
            title = seasonEpisodesElem.getAttribute("title");
        }
        var description = "";
        if (seasonEpisodesElem.querySelector("div.card-text") != undefined) {
            description = seasonEpisodesElem.querySelector("div.card-text").text.trim();
        }
        var  videoId = id + ":" + seasonNo + ":" + episodeNo;

        var episodeLogoUrl = "";
        let released = "";

        // Extract thumbnail and release date from individual episode page
        // The series page card may not have the correct episode-specific thumbnail
        try {
            const episodeDoc = await fetchData(episodePageLink);
            if (episodeDoc) {
                // Try to get thumbnail from Open Graph or Twitter Card meta tags
                const ogImage = episodeDoc.querySelector('meta[property="og:image"]');
                const twitterImage = episodeDoc.querySelector('meta[name="twitter:image"]');
                const thumbnailMeta = episodeDoc.querySelector('meta[itemprop="thumbnailUrl"]');

                if (thumbnailMeta) {
                    episodeLogoUrl = thumbnailMeta.getAttribute('content');
                } else if (ogImage) {
                    episodeLogoUrl = ogImage.getAttribute('content');
                } else if (twitterImage) {
                    episodeLogoUrl = twitterImage.getAttribute('content');
                }

                // Clean up URL if needed
                if (episodeLogoUrl) {
                    episodeLogoUrl = utils.getImageFromUrl(episodeLogoUrl, SUBTYPE);
                }

                // Extract release date
                const dateElement = episodeDoc.querySelector("li.date-local");
                released = extractReleaseDate(dateElement);
                if (released) {
                    logger.debug(`processOneDigitalEpisode => Extracted release date: ${released} for ${title}`);
                }

                logger.trace(`processOneDigitalEpisode => Extracted thumbnail: ${episodeLogoUrl} for ${title}`);
            }
        } catch (error) {
            logger.warn(`processOneDigitalEpisode => Could not extract thumbnail/release date for ${title}: ${error.message}`);
        }

        // Search TMDB for this episode if we have a series ID
        let tmdbEpisodeId = null;
        tmdbEpisodeId = await this.tmdbHelper.searchTMDBEpisode(tmdbSeriesId, seasonNo, episodeNo);
        if (tmdbEpisodeId) {
            logger.debug(`processOneDigitalEpisode => Found TMDB episode ID ${tmdbEpisodeId} for ${videoId}`);
        }

        // Create video object with episodeLink for on-demand stream resolution
        // Stream URL will be fetched when user actually plays the episode
        const video = {
            id: videoId,
            name: title,
            season: seasonNo,
            episode: episodeNo,
            description: description,
            thumbnail: episodeLogoUrl,
            episodeLink: episodePageLink,
            released: released,
            streams: [] // Streams will be resolved on-demand by the addon
        };
        if (tmdbEpisodeId) {
            video.tmdbEpisodeId = tmdbEpisodeId;
        }
        logger.debug(`processOneDigitalEpisode => ✓ processed episode : ${title} season:${seasonNo}, episode: ${episodeNo} (stream on-demand)`);
        return { video, videoId, title };
    }

    async getStreams(link){
        logger.trace("getStreams => Entering");
        logger.trace("getStreams => Link: " + link);

        var doc = await fetchData(link);

        if (doc == undefined){
            logger.debug("getStreams => Error retrieving do from " + link);
            return null;
        }
        var released = "";
        var videoUrl = "";
        var nameVideo = "";

        if (doc.querySelector("li.date-local") != undefined){
            const dateStr = doc.querySelector("li.date-local").getAttribute("data-date-utc");
            logger.debug("getStreams => Found date string: " + dateStr);
            if (dateStr) {
                // Parse DD.MM.YYYY HH:MM:SS format
                const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2})?:?(\d{2})?:?(\d{2})?/);
                if (match) {
                    const [, day, month, year, hour = "00", min = "00", sec = "00"] = match;
                    const date = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
                    released = isNaN(date.getTime()) ? "" : date.toISOString();
                    logger.debug("getStreams => Parsed release date: " + released);
                }
            }
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

        var streamsJSONObj = {
            url: videoUrl,
            title: nameVideo,
            name: nameVideo,
            released: released
        };

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

    getSeriesNameFromSeriesPage(url){

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

    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, type, tmdbSeriesId = null){
        // Check if this is a new series or update
        const isNewSeries = !this._kanDigitalJSONObj.hasOwnProperty(id);
        const existingSeries = this._kanDigitalJSONObj[id];

        const seriesObj = {
            id: id,
            name: seriesTitle,
            poster: imgUrl,
            description: seriesDescription,
            link: seriesPage,
            background: imgUrl,
            genres: genres,
            type: type,
            subtype: SUBTYPE,
            meta: {
                id: id,
                type: type,
                name: seriesTitle,
                link: seriesPage,
                background: imgUrl,
                poster: imgUrl,
                posterShape: "landscape",
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

        this._kanDigitalJSONObj[id] = seriesObj;

        // Track changes with DeltaTracker
        if (isNewSeries) {
            this.deltaTracker.addNewSeries(id, { name: seriesTitle, link: seriesPage });
            // Track new videos
            if (videosList && videosList.length > 0) {
                videosList.forEach(video => {
                    this.deltaTracker.addNewVideo(video.id, { name: video.name, seriesId: id });
                });
            }
        } else {
            this.deltaTracker.addUpdatedSeries(id, { name: seriesTitle, link: seriesPage });
            // Track video changes (simple comparison by count)
            const oldVideoCount = existingSeries.meta.videos ? existingSeries.meta.videos.length : 0;
            const newVideoCount = videosList ? videosList.length : 0;
            if (newVideoCount > oldVideoCount) {
                // Assume new videos were added
                for (let i = oldVideoCount; i < newVideoCount; i++) {
                    if (videosList[i]) {
                        this.deltaTracker.addNewVideo(videosList[i].id, { name: videosList[i].name, seriesId: id });
                    }
                }
            }
        }

        logger.info(`addToJsonObject => Added  series, ID: ${id} Name: ${seriesTitle} Link: ${seriesPage}`);
    }

    async updateDatabase() {
        logger.trace("updateDatabase => Entered");
        logger.debug("updateDatabase => Starting bulk database update");

        const DatabaseUpdater = require('./DatabaseUpdater');
        const dbUpdater = new DatabaseUpdater();

        try {
            const result = await dbUpdater.updateFromJSON('kandigital', this._kanDigitalJSONObj);
            logger.info(`updateDatabase => ✅ Updated ${result.series} series, ${result.videos} videos, ${result.streams} streams in ${result.duration}s`);
        } catch (error) {
            logger.error(`updateDatabase => ❌ Failed to update database: ${error.message}`);
            throw error;
        }

        logger.trace("updateDatabase => Leaving");
    }

    writeJSON(){
        logger.trace("writeJSON => Entered");
        logger.info("writeJSON => 📝 Writing JSON file and uploading to GitHub...");
        utils.writeJSONToFile(this._kanDigitalJSONObj, EXPORT_FILENAME);
        logger.info("writeJSON => ✅ File written and uploaded successfully!");

        logger.trace("writeJSON => Leaving");
    }
}

/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanDigitalScraper;
exports.crawl = this.crawl;
exports.isRunning = this.isRunning;
exports.writeJSON = this.writeJSON;

// Run scraper if executed directly
if (require.main === module) {
    require('dotenv').config({ path: './classes/.env' });
    const scraper = new KanDigitalScraper();

    scraper.crawl().catch(error => {
        logger.error('Fatal error:', error);
        process.exit(1);
    });
}