const utils = require("./utilities.js");
const {fetchData, getNameFromSeriesPage, extractReleaseDate, DeltaTracker, extractLatestDateFromList, hasNewEpisode, hasSeriesChanged, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    KAN_URL_ADDRESS,
    KAN_DIGITAL_IMAGE_PREFIX,
    KAN_BOX_URL,
    KAN_BOX_IGNORE_LIST,
    SCRAPER_CONFIG
} = require("./constants.js");
const { extractKanStream, cleanVideoName, safeExecute } = require("./ScraperHelpers.js");
const BaseScraper = require("./BaseScraper.js");
const SUB_PREFIX = "dogital";
const SUBTYPE = "d";

const log4js = require("log4js");
var logger = log4js.getLogger("KanDigitalScraper");

class KanDigitalScraper extends BaseScraper {

    constructor() {
        // Initialize BaseScraper with the scraper name
        super('KanDigital', { exportFilename: "stremio-kandigital", databaseKey: 'kandigital' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize KanDigital-specific properties
        this._kanDigitalJSONObj = {};
        this.seriesIdIterator = 1000;
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        await safeExecute(
            () => this.crawlVod(),
            "crawlContent.crawlVod",
            this.logger
        );

        await safeExecute(
            () => this.crawlKanBox(),
            "crawlContent.crawlKanBox",
            this.logger
        );
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
                    if (this._jsonObj.hasOwnProperty(seriesId)) {
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

        // Extract image from series page if not provided or if the image URL is incomplete
        if (!item.Image || item.Image === '') {
            const seriesImg = seriesPageDoc.querySelector("img.img-fluid");
            if (seriesImg) {
                const extractedImgSrc = seriesImg.getAttribute('src');
                if (extractedImgSrc) {
                    imgUrl = utils.getImageFromUrl(extractedImgSrc, SUBTYPE);
                    logger.debug(`processOneDigitalSeries => Extracted image from series page: ${imgUrl}`);
                }
            }
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

        //Get the seasons number
        var seasons = seriesPageDoc.querySelectorAll("div.seasons-item");
        var videoObj = [];
        if ((seasons != undefined) && (seasons.length > 0)){ //generate videos object with media links(streams)
            logger.debug("processOneDigitalSeries => seasons " + title + " length: " + seasons.length);
            videoObj = await this.getVideos(seasons, id);

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

            this.addToJsonObject(id, title, pageUrl, imgUrl,description,genres,videoObj,"series");
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
                name = cleanVideoName(name);
            } else if (movieDoc.querySelector("title")) {
                name = movieDoc.querySelector("title").text.trim();
                name = cleanVideoName(name);
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

            // Process thumbnail URL if present (convert relative to absolute)
            let processedThumb = thumb;
            if (thumb) {
                processedThumb = utils.getImageFromUrl(thumb, SUBTYPE);
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
                thumbnail: processedThumb,
                episodeLink: url,
                released: released,
                streams: [stream]
            });
            logger.info(`getStream => Successfully extracted VideoObject: ${name} with thumbnail: ${processedThumb ? 'YES' : 'NO'}`);
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
     * @returns Array of video json objects
     *********************************************************/
    async getVideos(videosElems, id){
        var videosArr = [];

        var noOfSeasons = videosElems.length;
        logger.info(`getVideos => Processing ${noOfSeasons} season(s) for series ID: ${id}`);

        for (var i = 0 ; i < noOfSeasons; i++){//iterate over seasons (descending - season N is first)
            var seasonNo = noOfSeasons - i;
            var seasonEpisodesElems = videosElems[i].querySelectorAll("a.card-link");
            var numEpisodes = seasonEpisodesElems.length;

            logger.info(`getVideos => Season ${seasonNo} has ${numEpisodes} episode(s) - processing in descending order`);

            // Prepare episode data for batch processing (descending order)
            // Episode numbers stay correct (episode 36 is still episode 36) but processed in reverse
            const episodeData = [];
            for (let iter = 0; iter < numEpisodes; iter++) {
                // Process from last to first (highest episode number first)
                const actualEpisodeNo = numEpisodes - iter;  // This keeps the correct episode number
                episodeData.push({
                    elem: seasonEpisodesElems[numEpisodes - 1 - iter],  // Access in reverse
                    seasonNo: seasonNo,
                    episodeNo: actualEpisodeNo  // Keep correct episode number
                });
            }

            // Process episodes in batches
            const episodeResults = await this.processBatch(
                episodeData,
                async (epData, index) => {
                    return await this.processOneDigitalEpisode(epData, id);
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
     * NOTE: Stream URLs are NOT fetched during scraping to avoid rate limiting/403 errors.
     * The episodeLink is stored and streams are resolved on-demand when user plays.
     */
    async processOneDigitalEpisode(epData, id) {
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
        logger.debug(`processOneDigitalEpisode => ✓ processed episode : ${title} season:${seasonNo}, episode: ${episodeNo} (stream on-demand)`);
        return { video, videoId, title };
    }

    async getStreams(link){
        logger.trace("getStreams => Entering");
        logger.trace("getStreams => Link: " + link);

        const stream = await extractKanStream(link, "KanDigital");

        logger.trace("getStreams => Exiting");
        return stream || null;
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
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanDigitalScraper;


// Run scraper if executed directly
if (require.main === module) {
    require('dotenv').config({ path: './classes/.env' });
    const scraper = new KanDigitalScraper();

    scraper.crawl().catch(error => {
        logger.error('Fatal error:', error);
        process.exit(1);
    });
}
