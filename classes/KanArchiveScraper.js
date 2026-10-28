const utils = require("./utilities.js");
const {fetchData, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    KAN_ARCHIVE,
    KAN_DIGITAL_IMAGE_PREFIX,
    SCRAPER_CONFIG
} = require("./constants.js");
const { extractKanStream } = require("./ScraperHelpers.js");
const { rethrowIfKanBlocked } = require("./kanSession.js");
const {
    parseArchiveIndex,
    parseSeriesMeta,
    parseSeriesPage,
    seasonUrlsToFetch,
    numberDigitalEpisodes
} = require("./kanDigitalParse.js");
const BaseScraper = require("./BaseScraper.js");
const SUB_PREFIX = "archive";

const log4js = require("log4js");
var logger = log4js.getLogger("KanArchiveScraper");

class KanArchiveScraper extends BaseScraper {

    constructor() {
        // Initialize BaseScraper with the scraper name
        super('KanArchive', { exportFilename: "stremio-kanarchive", databaseKey: 'kanarchive' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize KanArchive-specific properties
        this._kanArchiveJSONObj = {};
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        await this.crawlVod();
    }

    /***********************************************************
     *
     * Kan Digital handling
     *
     ***********************************************************/
    async crawlVod(){
        logger.trace("crawlVod => Entered");
        logger.debug("crawlVod => Starting retrieval of VOD series");

        const doc = await fetchData(KAN_ARCHIVE.URL_ADDRESS);
        if (!doc) {
            logger.error("crawlVod => Could not retrieve the archive index");
            return;
        }

        // Names come from the poster alt. The old crawl stored "" and only
        // filled the name after an episode-button check the new layout fails.
        const series = parseArchiveIndex(doc);
        logger.info(`crawlVod => ${series.length} archive series on the index`);
        for (const card of series) {
            if (!card.url) continue;
            const id = utils.generateSeriesId(card.url, SUB_PREFIX);
            this.addToJsonObject(
                id,
                card.name || "",
                card.url,
                card.image || "",
                card.description || "",
                "",
                [],
                "a",
                "series"
            );
        }

        await this.getSeries();
        logger.trace("crawl() => Exiting");
    }

    async getSeries(){
        logger.trace("getSeries => Entering");

        // Collect all series keys
        const seriesKeys = Object.keys(this._jsonObj);
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
        const series = this._jsonObj[key];
        if (!series) return null;
        const id = series.id;
        const pageUrl = series.link;
        const joiner = String(pageUrl).includes("?") ? "&" : "?";
        const retrieveLink = pageUrl + joiner + "page=1&itemsToShow=1000";

        logger.debug(`processOneSeries => Fetching series ID: ${id} from ${retrieveLink}`);
        let seriesPageDoc;
        try {
            seriesPageDoc = await fetchData(retrieveLink);
        } catch (error) {
            rethrowIfKanBlocked(error);
            logger.warn(`processOneSeries => Failed to fetch series page for ID: ${id}: ${error.message}`);
            delete this._jsonObj[key];
            return null;
        }

        if (!seriesPageDoc) {
            logger.warn(`processOneSeries => Failed to fetch series page for ID: ${id}`);
            delete this._jsonObj[key];
            return null;
        }

        const pageMeta = parseSeriesMeta(seriesPageDoc);
        const title = utils.getNameFromSeriesPage(pageMeta.title || series.name || "");
        if (title) {
            series.name = title;
            series.meta.name = title;
        }
        if (pageMeta.description) series.meta.description = pageMeta.description;
        series.meta.genres = this.setGenre(seriesPageDoc.querySelector("div.info-genre"));

        // Same card parser as Kan Digital. Season from the /sN/ path. The
        // legacy button, card-link, and seasons-item selectors stay inside it.
        const parsed = parseSeriesPage(seriesPageDoc, pageUrl);
        const seasonUrls = seasonUrlsToFetch(seriesPageDoc, pageUrl, parsed);
        let episodes = [];
        try {
            episodes = await this.collectArchiveEpisodes(parsed, seasonUrls, title);
        } catch (error) {
            rethrowIfKanBlocked(error);
            logger.error(`processOneSeries => season fetch failed for ${id}: ${error.message}`);
        }

        if (episodes.length === 0 && parsed.movieUrl) {
            const added = await this.addArchiveMovie(id, title || series.name || "", pageMeta.description || "", series.meta.poster || "", parsed.movieUrl);
            if (added) return { id, title };
        }

        const numbered = numberDigitalEpisodes(episodes);
        for (const episode of numbered) {
            let streams;
            try {
                streams = await this.getStreams(episode.url);
            } catch (error) {
                rethrowIfKanBlocked(error);
                logger.warn(`processOneSeries => stream fetch failed for ${episode.url}: ${error.message}`);
                continue;
            }
            if (!streams || !streams.url) {
                logger.warn(`processOneSeries => No stream for "${episode.title}" (${episode.url})`);
                continue;
            }
            this.addVideoToMeta(
                id,
                `${id}:${episode.season}:${episode.episodeNo}`,
                episode.title || `Episode ${episode.episodeNo}`,
                episode.season,
                episode.episodeNo,
                episode.description || streams.description || "",
                episode.image || "",
                episode.url,
                streams.released,
                [{
                    url: streams.url,
                    type: streams.type,
                    name: streams.name,
                    description: streams.description
                }]
            );
        }

        const videos = series.meta && series.meta.videos;
        if (!videos || videos.length === 0) {
            logger.debug(`processOneSeries => Series page is empty, skipping series ID: ${id}`);
            delete this._jsonObj[key];
            return null;
        }

        logger.info(`processOneSeries => Added ${videos.length} video(s) for "${title}" (${id})`);
        return { id, title };
    }

    async collectArchiveEpisodes(parsedSeries, seasonUrls, title) {
        const episodes = [];
        const seen = new Set();
        const addEpisodes = (list) => {
            for (const episode of list || []) {
                if (!episode || !episode.url || seen.has(episode.url)) continue;
                seen.add(episode.url);
                episodes.push(episode);
            }
        };
        addEpisodes(parsedSeries && parsedSeries.episodes);
        if (seasonUrls && seasonUrls.length > 0) {
            logger.info(`processOneSeries => Fetching ${seasonUrls.length} season page(s) for ${title}`);
        }
        for (const seasonUrl of seasonUrls || []) {
            let fetchUrl = seasonUrl;
            if (fetchUrl.startsWith("/")) fetchUrl = KAN_DIGITAL_IMAGE_PREFIX + fetchUrl;
            fetchUrl = fetchUrl.split("?")[0];
            try {
                const seasonDoc = await fetchData(`${fetchUrl}?page=1&itemsToShow=1000`);
                if (!seasonDoc) continue;
                addEpisodes(parseSeriesPage(seasonDoc, fetchUrl).episodes);
            } catch (error) {
                rethrowIfKanBlocked(error);
                logger.error(`processOneSeries => Error fetching season ${fetchUrl}: ${error.message}`);
            }
        }
        return episodes;
    }

    async addArchiveMovie(id, title, description, poster, movieUrl) {
        const streams = await this.getStreams(movieUrl);
        if (!streams || !streams.url) {
            logger.warn(`processOneSeries => No stream for movie ${movieUrl}`);
            return false;
        }
        this.addVideoToMeta(
            id,
            `${id}:1:1`,
            title,
            "1",
            "1",
            description,
            poster,
            movieUrl,
            streams.released,
            [{
                url: streams.url,
                type: streams.type,
                name: streams.name,
                description: streams.description
            }]
        );
        logger.info(`processOneSeries => Added movie "${title}" for series ID: ${id}`);
        return true;
    }

    async getStreams(link){
        logger.trace("getStreams => Entering");
        logger.trace("getStreams => Link: " + link);

        const stream = await extractKanStream(link, "KanArchive");

        logger.trace("getStreams => Exiting");
        return stream || "";
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
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanArchiveScraper;
