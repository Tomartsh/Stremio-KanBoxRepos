const utils = require("./utilities.js");
const {DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    HINUKHIT,
    SCRAPER_CONFIG
} = require("./constants.js");
const { extractKanStream, extractLobbySeries, collectEducationalEpisodes } = require("./ScraperHelpers.js");
const { supplementEducationalEpisodes } = require("./KanSitemap.js");
const BaseScraper = require("./BaseScraper.js");

const log4js = require("log4js");
var logger = log4js.getLogger("KanKidsScraper");

function kidsContentUrl(url) {
    const value = String(url || "");
    if (/^https?:\/\//i.test(value)) return value;
    return HINUKHIT.URL_KIDS_CONTENT_PREFIX + value;
}

function lobbySeriesName(series) {
    if (!series) return "";
    return series.Name || series.Title || series.ImageAlt || series.title || "";
}

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
        this.allowParallelKanHttp();
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
        var loaded = await this.fetchCatalogDocument(HINUKHIT.URL_TINY);
        if (loaded.timeout) {
            this.noteListingIncomplete(HINUKHIT.URL_TINY);
            return;
        }
        if (!loaded.doc) {
            throw new Error("Lobby page did not load");
        }
        var kidsJsonArr = extractLobbySeries(loaded.doc);

        // Process kids series using batch processor
        logger.info(`crawlKids => Found ${kidsJsonArr.length} kids series to process`);
        const results = await this.processBatch(
            kidsJsonArr,
            async (series, index) => {
                return await this.processOneKidsSeries(series, subType);
            },
            "kids-series"
        );
        this.orderJsonByIds(results.map((result) => result && result.id));
    }

    /**
     * Process a single kids series (extracted from crawlKids for batch processing)
     */
    async processOneKidsSeries(series, subType) {
        var imgUrl = utils.getImageFromUrl(series.Image, subType);

        var seriesPage = kidsContentUrl(series.Url);
        var genres = utils.setGenreFromString(series.Genres);
        var seriesName = lobbySeriesName(series);
        var id = this.seriesIdFor(seriesPage, HINUKHIT.SUBPREFIX_KIDS, seriesName);
        var loaded = await this.fetchCatalogDocument(seriesPage + "?currentPage=2&itemsToShow=100");
        if (!loaded.doc || typeof loaded.doc.querySelector !== "function") {
            if (loaded.timeout) {
                this.noteFailedSeries({ id, link: seriesPage, name: seriesName });
            } else {
                logger.warn(`processOneKidsSeries => Could not fetch page for ${series.Url}`);
            }
            return null;
        }
        var doc2 = loaded.doc;

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

        // The series URL still carries currentPage/itemsToShow. That row caps
        // at about 50 cards. collectEducationalEpisodes reads the page, then
        // the kids sitemap adds episode URLs the row did not show.
        const videosCollected = [];
        const pageEpisodes = await collectEducationalEpisodes(
            doc2,
            seriesPage + "?currentPage=2&itemsToShow=100",
            (url) => this.fetchEducationalDocument(url)
        );
        const episodes = await supplementEducationalEpisodes(pageEpisodes, seriesPage, {
            fetchDocument: (url) => this.fetchEducationalDocument(url),
            logger
        });
        await this.getKidsVideos(episodes, id, subType, videosCollected);

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
        if (!doc || typeof doc.querySelector !== "function") return "";
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
    async fetchEducationalDocument(url) {
        const loaded = await this.fetchCatalogDocument(url);
        if (!loaded || !loaded.doc || typeof loaded.doc.querySelector !== "function") {
            if (loaded && loaded.timeout) {
                logger.warn(`fetchEducationalDocument => Timed out: ${url}`);
            }
            return null;
        }
        return loaded.doc;
    }

    async getKidsVideos(episodes, id, subType, videosCollected = []){
        const bySeason = new Map();
        for (const episode of episodes || []) {
            if (!bySeason.has(episode.season)) bySeason.set(episode.season, []);
            bySeason.get(episode.season).push(episode);
        }
        const seasonNumbers = [...bySeason.keys()].sort((a, b) => b - a);
        logger.info(`getKidsVideos => Processing ${seasonNumbers.length} season(s) for series ID: ${id}`);

        for (const seasonNo of seasonNumbers) {
            const episodeData = bySeason.get(seasonNo).slice().sort((a, b) => b.episodeNo - a.episodeNo);
            logger.info(`getKidsVideos => Season ${seasonNo} has ${episodeData.length} episode(s) - processing in descending order`);
            const start = videosCollected.length;
            await this.processBatch(
                episodeData,
                async (epData) => {
                    return await this.processOneKidsEpisode(epData, id, subType, videosCollected);
                },
                `kids-episodes (Season ${seasonNo})`
            );
            // Parallel completion order is not episode order. Restore the
            // descending episode order the sequential path used to push.
            const added = videosCollected.splice(start);
            added.sort((a, b) => Number(b.episode) - Number(a.episode));
            videosCollected.push(...added);
        }
    }

    /**
     * Process a single kids episode (extracted from getKidsVideos for batch processing)
     */
    async processOneKidsEpisode(epData, id, subType, videosCollected = []) {
        const seasonNo = epData.season;
        const episodeNo = epData.episodeNo;

        var episodeLink = epData.url || "";
        if (episodeLink.startsWith("/")){
            episodeLink = HINUKHIT.URL_KIDS_CONTENT_PREFIX + episodeLink;
        }
        var episodeTitle = epData.title || "";

        var episodeImgUrl = "";
        if (epData.image) {
            episodeImgUrl = utils.getImageFromUrl(epData.image, subType);
        }
        logger.trace("processOneKidsEpisode => episodeImgUrl: " + episodeImgUrl + " Name: " + episodeTitle);

        var episodeDescription = String(epData.description || "");
        episodeDescription = episodeDescription.replace(/[\r\n]+/gm, "").trim();

        var videoId = id + ":" + seasonNo + ":" + episodeNo;
        var streams = await this.resolveEpisodeStreams(
            videoId,
            epData,
            () => this.getStreams(episodeLink)
        );
        var streamsArr = [];
        var released = "";
        if (streams == "-1"){
            logger.debug("processOneKidsEpisode => Stream is empty. Leaving it empty");
        } else {
            streamsArr.push(streams);
            released = streams.released;
        }

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
