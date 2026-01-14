const utils = require("./utilities.js");
const {fetchData} = require("./utilities.js");
const {
    LOG4JS_LEVEL, 
    MAX_LOG_SIZE, 
    LOG_BACKUP_FILES,
    LOG_FILENAME,
    KAN_BASE_MOB_API,
    KAN_PODCAST_CATEGORIES,
    KAN_BASE_URL
} = require("./constants.js");
const SUB_PREFIX = "podcasts";

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const KAN_WEBSITE_API_PAGE = "https://www.kan.org.il/api/v1/Content/Page";


const log4js = require("log4js");

log4js.configure({
    appenders: { 
        out: { type: "stdout" },
        Stremio: 
        { 
            type: "file", 
            filename: LOG_FILENAME, 
            maxLogSize: MAX_LOG_SIZE, 
            backups: LOG_BACKUP_FILES, 
        }
    },
    categories: { default: { appenders: ['Stremio','out'], level: LOG4JS_LEVEL } },
});

const EXPORT_FILENAME = "stremio-kanpodcasts";
var logger = log4js.getLogger("KanPodcastsScraper");

class KanPodcastsScraper {

    constructor() {
        this._kanPodcastsJSONObj = {};
        this.seriesIdIterator = 10000;
        this.isRunning = false;
    }

    async crawl(isDoWriteFile = false){
        logger.info("Started Crawling");
        this.isRunning = true;
        await this.crawlPodcasts();
        logger.info("Done Crawling");
        
        if (isDoWriteFile){
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }
        this.isRunning = false;
    }

    /** 
     * Main method:
     * 1. Fetch all podcast series from mobile JSON API (paged).
     * 2. For each series, fetch its episodes (JSON, same API family).
     * 3. Build Stremio‑ready structure in memory.
     */
    async crawlPodcasts(){
        logger.trace("crawlPodcasts => Entering");
        logger.debug("crawlPodcasts => Fetching podcast series list...");
        
        let seriesList;

        try {
            
            seriesList = await this.getAllSeries(KAN_PODCAST_CATEGORIES);
            logger.debug(`crawlPodcasts => Found ${seriesList.length} series.`);
        } catch (error) {
            logger.error("crawlPodcasts => Error cannot get series list:", error);
            return;
        }

        if (!Array.isArray(seriesList) || seriesList.length === 0) {
            logger.warn("crawlPodcasts => No series returned from mobile API");
            return;
        }

        try {
            for (const series of seriesList) {
                const pageUrl = series.link?.href?.replace('?app=true', '') || '';
                // Exclude Kan 88 podcasts or invalid entries
                if (!series.id || pageUrl.includes("kan88")) {
                    continue; 
                }

                // Metadata extraction from the API response
                const programId = series.id;
                const title = series.title;
                const description = series.description || "";
                // Generate a unique ID for Stremio (e.g., podcasts_4451)
                const stremioId = utils.generateSeriesId("", SUB_PREFIX, programId);

                // Extract Image (API structure: media_group -> media_item)
                const podcastImageUrl = series.media_group?.[0]?.media_item?.[0]?.src || "";

                logger.debug(`crawlPodcasts => Processing: ${title} (ID: ${programId})`);

                //const episodes = await this.getEpisodes(programId, pageUrl);
                const episodes = await this.getpodcastEpisodeVideos(pageUrl, programId);

                if (episodes.length > 0) {
                    logger.debug(`crawlPodcasts => Found ${episodes.length} episodes for ${title}`);
                    this.addToJsonObject(stremioId, title, pageUrl, podcastImageUrl, description, episodes, [], "p", "series");
                }

            }
        } catch (error) {
            logger.error("crawlPodcasts => Error fetching series list:", error);
            return;
        }   
    }

    /**
     * Replicates GetRadioSeriesList logic: fetches all series entries.
     * Uses chunks of 200 as seen in the Python code.
     */
    async getAllSeries(categoryId) {
        let allEntries = [];
        let from = 1;
        let pageCounter = 0;
        let hasMore = true;

        while (hasMore) {
            const response = await fetchData(KAN_BASE_MOB_API, true, 
                { id: categoryId, from: from },
               { 'User-Agent': USER_AGENT }
            );

            if (!response) {
                logger.warn("getAllSeries => Null response, stopping pagination");
                break;
            }

            const entries = response.entry || [];

            if (!Array.isArray(entries) || entries.length === 0) {
                hasMore = false;
                break;
            }

            allEntries = allEntries.concat(entries);

            if (entries.length >= 200) {
                from += 200;
            } else {
                hasMore = false;
            }
        }
        logger.info(`getAllSeries => Accumulated ${allEntries.length} series entries`);
        return allEntries;
    }

    /**
     * getEpisodes: Scrape HTML page with pagination support
     */
    async getEpisodes(programId, pageUrl = null) {
        logger.trace(`getEpisodes => Entering (programId=${programId}, pageUrl=${pageUrl})`);

        if (!pageUrl) {
            logger.warn(`getEpisodes => No pageUrl provided, cannot fetch episodes`);
            return [];
        }

        logger.debug(`getEpisodes => Scraping episodes from: ${pageUrl}`);

        try {
            const allEpisodes = [];

            // STEP 1: Fetch first page and detect total pages
            const firstPageDoc = await fetchData(pageUrl, false);
            if (!firstPageDoc) {
                logger.error(`getEpisodes => Could not fetch first page: ${pageUrl}`);
                return [];
            }

            // Detect total number of pages
            const lastPageElement = firstPageDoc.querySelector('li[class*="pagination-page__item"][title*="Last page"]');
            const totalPages = lastPageElement ? parseInt(lastPageElement.getAttribute('data-num')) : 1;

            logger.debug(`getEpisodes => Detected ${totalPages} pages for podcast`);

            // STEP 2: Parse all pages
            for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
                logger.debug(`getEpisodes => Parsing page ${pageNum}/${totalPages}`);

                let pageDoc = firstPageDoc;

                // Fetch additional pages (skip first page as we already have it)
                if (pageNum > 1) {
                    const pageUrl_withParams = `${pageUrl}?page=${pageNum}`;
                    logger.trace(`getEpisodes => Fetching: ${pageUrl_withParams}`);

                    pageDoc = await fetchData(pageUrl_withParams, false);
                    if (!pageDoc) {
                        logger.warn(`getEpisodes => Could not fetch page ${pageNum}, skipping`);
                        continue;
                    }
                }

                // Parse episodes on this page
                const episodeElements = pageDoc.querySelectorAll("div.card.card-row");
                logger.debug(`getEpisodes => Found ${episodeElements.length} episodes on page ${pageNum}`);

                for (const episodeElem of episodeElements) {
                    try {
                        const episode = await this.parseEpisodeElement(episodeElem, programId);
                        if (episode) {
                            allEpisodes.push(episode);
                            logger.debug(`getEpisodes => Added: ${episode.title}`);
                        }
                    } catch (error) {
                        logger.warn(`getEpisodes => Error parsing episode element:`, error.message);
                    }
                }
            }

            logger.info(`getEpisodes => Successfully parsed ${allEpisodes.length} total episodes`);
            return allEpisodes;

        } catch (error) {
            logger.error(`getEpisodes => Error:`, error.message);
            return [];
        }
    }

    /**
     * Parse a single episode card element
     */
    async parseEpisodeElement(episodeElem, programId) {
        logger.trace(`parseEpisodeElement => Parsing episode element`);

        try {
            // Extract episode link
            const episodeLinkElem = episodeElem.querySelector("a.card-body");
            if (!episodeLinkElem) {
                logger.debug(`parseEpisodeElement => No card-body link found`);
                return null;
            }

            let episodeLink = episodeLinkElem.getAttribute("href");
            if (!episodeLink) {
                logger.debug(`parseEpisodeElement => No href found`);
                return null;
            }

            // Make link absolute
            if (episodeLink.startsWith("/")) {
                episodeLink = KAN_BASE_URL + episodeLink;
            }

            // Extract title
            let episodeTitle = "Unknown";
            const titleElem = episodeElem.querySelector("h2.card-title");
            if (titleElem) {
                episodeTitle = titleElem.text.trim();
                episodeTitle = episodeTitle.replace(/^פרק \d+:\s*/, '').trim();
            }

            // Extract image
            let episodeImgUrl = "";
            const imgElem = episodeElem.querySelector("img.img-full");
            if (imgElem) {
                const srcUrl = imgElem.getAttribute("src");
                if (srcUrl) {
                    episodeImgUrl = utils.getImageFromUrl(srcUrl, "p");
                }
            }

            // Extract description
            let episodeDescription = "";
            const descElem = episodeElem.querySelector("div.description");
            if (descElem) {
                episodeDescription = descElem.text.trim();
            }

            // Extract release date
            let released = "";
            const dateElem = episodeElem.querySelector("li.date-local");
            if (dateElem) {
                const dateUtc = dateElem.getAttribute("data-date-utc");
                if (dateUtc) {
                    released = utils.getReleaseDate(dateUtc);
                }
            }

            // STEP: Fetch episode page to get stream URL
            let streamUrl = "";
            try {
                logger.trace(`parseEpisodeElement => Fetching episode page: ${episodeLink}`);
                const episodePageDoc = await fetchData(episodeLink, false);

                if (episodePageDoc) {
                    // Look for figure with data-player-src
                    const figureElem = episodePageDoc.querySelector("figure[data-player-src]");
                    if (figureElem) {
                        streamUrl = figureElem.getAttribute("data-player-src");
                        if (streamUrl && streamUrl.includes("?")) {
                            streamUrl = streamUrl.substring(0, streamUrl.indexOf("?"));
                        }
                    }

                    logger.debug(`parseEpisodeElement => Found stream: ${streamUrl.substring(0, 50)}...`);
                }
            } catch (error) {
                logger.warn(`parseEpisodeElement => Could not fetch stream from episode page:`, error.message);
            }

            if (!streamUrl) {
                logger.warn(`parseEpisodeElement => No stream URL found for: ${episodeTitle}`);
                return null;
            }

            const episode = {
                id: `${programId}_${episodeTitle.replace(/\s+/g, '_')}`,
                title: episodeTitle,
                description: episodeDescription,
                thumbnail: episodeImgUrl,
                released: released,
                streamUrl: streamUrl
            };

            return episode;

        } catch (error) {
            logger.error(`parseEpisodeElement => Error:`, error.message);
            return null;
        }
    }

    async getpodcastEpisodeVideos(podcastSeriesLink, id){
        logger.trace("getpodcastEpisodeVideos => Entering");
        
        var podcastSeriesPageDoc = await fetchData(podcastSeriesLink); //get the series episodes 
        if (podcastSeriesPageDoc == undefined){
            logger.error("getpodcastEpisodeVideos => No podcast series page found for URL: " + podcastSeriesLink);
            return;
        }
        var lastPageNo = '';

        if (podcastSeriesPageDoc.querySelector('li[class*="pagination-page__item"][title*="Last page"]') != null){
            lastPageNo = podcastSeriesPageDoc.querySelector('li[class*="pagination-page__item"][title*="Last page"]').getAttribute('data-num');
            logger.trace("getpodcastEpisodeVideos => URL: " + podcastSeriesLink + ` has ${lastPageNo} pages`);
        } else {
            lastPageNo = 1;
            logger.trace("getpodcastEpisodeVideos => URL: " + podcastSeriesLink + " has only 1 page");
        }

        logger.debug("getpodcastEpisodeVideos => podcast ID: " + id + " number of pages: " + lastPageNo);
        var podcastEpisodes = []; //list of podcast episodes
        if ((lastPageNo) && (parseInt(lastPageNo) >= 0) ){
            var intLastPageNo = parseInt(lastPageNo);
            for (var i = 0 ; i < intLastPageNo ; i++){
                if (i == 0){
                    var podcastEpisodesToCheck = podcastSeriesPageDoc.querySelectorAll("div.card.card-row");
                    for (var episodeChecked of podcastEpisodesToCheck){
                        var hrefObj = episodeChecked.querySelector("a.card-body")
                        var episodeLink = hrefObj.getAttribute("href");
                        logger.debug("getpodcastEpisodeVideos => episodeLink is: " + episodeLink);
                        if (episodeLink.startsWith("/")){
                            episodeLink = KAN_BASE_URL + episodeLink;
                        }
                        var docToCheck = await fetchData(episodeLink);//check if there is an episode on the oher side or more episodes
                        var card;
                        if (docToCheck.querySelector("h2.title") != undefined){
                            card = docToCheck.querySelector("h2.title");
                        } else {
                            logger.error("getpodcastEpisodeVideos => No docToCheck for URL: " + episodeLink);
                        }
                        
                        //var card = docToCheck.querySelector("h2.title");
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
                if (podcastsAdditionalPages == undefined){
                    logger.warn("getpodcastEpisodeVideos => No additional pages found for URL: " + podcastSeriesLink + "?page=" + i);
                    continue;
                }
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
        //podcastEpisodes = podcastSeriesPageDoc.querySelectorAll("div.card.card-row");
        var podcastEpisodeNo = podcastEpisodes.length;

        for (var podcastEpisode of podcastEpisodes){ //iterate over episodes and get the video and stream
            var episodeElement = podcastEpisode.episode;
            var streams = podcastEpisode.stream;

            var episodeLink = "";
            var episodes_media = episodeElement.querySelector("a.card-img.card-media")
            if (episodes_media != undefined){
                var episodeLinkElem = episodeElement.querySelector("a.card-img.card-media")
                episodeLink = episodeLinkElem.getAttribute("href");
            } else {
                var episodes_body = episodeElement.querySelector("a.card-body")
                if (episodes_body != undefined){
                    episodeLink = episodes_body.getAttribute("href");
                    logger.debug("getPodcastEpisodeVideoArray => href card image empty. Using card href");
                } else {
                    logger.debug("getPodcastEpisodeVideoArray => No episode link found, skipping. Link");
                }
            }

            var episodeTitle = "";
            if (episodeElement.querySelector("h2.card-title") != null){
                episodeTitle = episodeElement.querySelector("h2.card-title").text.trim();
                episodeTitle = episodeTitle.replace(/^פרק \d+:/, '').trim();
            }


            var episodeImgUrl = "";
            if (episodeElement.querySelector("img.img-full") != null){
                episodeImgUrl = utils.getImageFromUrl(episodeElement.querySelector("img.img-full").getAttribute("src"), "p");
            }
            logger.debug("getpodcastEpisodeVideos => episodeImgUrl" + episodeImgUrl + " Name: " + episodeTitle);
            
            var episodeDescription = episodeElement.querySelector("div.description").text.trim();
            var released = "";
            var releasedTemp = ""
            if (episodeElement.querySelector("li.date-local") != undefined){
                releasedTemp = episodeElement.querySelector("li.date-local").getAttribute("data-date-utc").trim();
                released = utils.getReleaseDate(releasedTemp);
            }
            logger.debug("getpodcastEpisodeVideos => Calling streams with URL: " + episodeLink + " for episode: " + episodeTitle + " released: " + released);
            var episodeId = id + ":1:" + podcastEpisodeNo;
            this.addVideoToMeta(id,episodeId, episodeTitle,"1",podcastEpisodeNo,episodeDescription,episodeImgUrl,episodeLink,released,streams);
            logger.debug("getpodcastEpisodeVideos => Added episode: " + episodeId);
            podcastEpisodeNo--
        }

        logger.trace("getpodcastEpisodeVideos => Exiting");
        return podcastEpisodesVideos;
    }

    getPodcastStream(streamElement){
        logger.trace("getPodcastStream => Entering");
        var episodeName = "";
        if (streamElement.querySelector("h2.title") != undefined){
            //episodeName = streamElement.querySelector("h2.title").text.trim();
            episodeName = streamElement.querySelector("h2.title").text.trim();
            episodeName = episodeName.replace(/^פרק \d+:/, '').trim();
        } else {
            logger.trace("getPodcastStreams => No name for the episode !");
        }
        var description = "";
        if (streamElement.querySelector("div.item-content.hide-content") != null) {
            description = streamElement.querySelector("div.item-content.hide-content").text.trim();
        }else {
            logger.trace("getPodcastStreams => No description for the episode !");
        }
        var urlRawElem = streamElement.querySelector("figure");
        if (urlRawElem == undefined){
            urlRawElem = streamElement.querySelector("button.btn-play"); //try alternative
            if (urlRawElem == undefined) { return streams; }
        }
        
        const urlRaw = urlRawElem?.getAttribute("data-player-src")?.trim();

        if (!urlRaw) {
            return streams;
        }

        const urlObj = new URL(urlRaw);
        const url = urlObj.origin + urlObj.pathname;

        logger.trace(`getPodcastStreams => Podcast stream name: ${episodeName}, Description: ${description}`);
        
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
        if (released != "") {video["released"] = released;}

        if (
            this._kanPodcastsJSONObj[key] &&
            this._kanPodcastsJSONObj[key].meta &&
            this._kanPodcastsJSONObj[key].meta.videos
            ) {
            this._kanPodcastsJSONObj[key].meta.videos.push(video);
        }
    }

    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, subType, type){
        this._kanPodcastsJSONObj[id] =  {
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
        }

        logger.info("addToJsonObject => Added  series, ID: " + id + " Name: " + seriesTitle + " Link: " + seriesPage + " subtype: " + subType);
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
module.exports = KanPodcastsScraper;
exports.crawl = this.crawl;
exports.isRunning = this.isRunning;
exports.writeJSON = this.writeJSON;