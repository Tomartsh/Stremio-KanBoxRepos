const crypto = require("crypto");
const utils = require("./utilities.js");
const {
    LOG4JS,
    RESHET,
    PREFIX,
    SCRAPER_CONFIG
} = require ("./constants");
const {writeLog, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const { parseIsraeliDate } = require("./ScraperHelpers.js");
const { normalizeSeriesLink, stableSlugToken } = require("./seriesIdentity.js");
const log4js = require("log4js");
const BaseScraper = require("./BaseScraper.js");
const TmdbHelper = require("./TmdbHelper.js");

/**
 * Series id from the show URL slug. The same path always yields the same id,
 * including when 13tv inserts a show and shifts the list.
 */
function reshetSeriesId(pageLink) {
    return PREFIX + "reshet_" + stableSlugToken(pageLink);
}

// Kaltura writes "no genre" with an ASCII apostrophe or a Hebrew geresh.
const NO_GENRE = "ללא ז'אנר";
const GENRE_TAG = /<OTTTAGGenre>(.*?)<\/OTTTAGGenre>/s;

function normalizeGenreLabel(value) {
    return String(value == null ? "" : value).replace(/[\u05F3\u2018\u2019]/g, "'").trim();
}

/**
 * Labels inside one metadata xml blob. The multirequest already asked for
 * this (call "4", response index 3). Missing xml yields no genres.
 */
function parseReshetGenreXml(xml) {
    if (typeof xml !== "string" || xml === "") return [];
    const match = xml.match(GENRE_TAG);
    if (!match) return [];
    const genres = [];
    const seen = new Set();
    for (const part of match[1].split("|")) {
        const genre = part.trim();
        if (!genre || normalizeGenreLabel(genre) === NO_GENRE || seen.has(genre)) continue;
        seen.add(genre);
        genres.push(genre);
    }
    return genres;
}

function genresFromKalturaResponse(streamJsonObj) {
    try {
        const xml = streamJsonObj?.[3]?.objects?.[0]?.xml;
        return parseReshetGenreXml(xml);
    } catch (error) {
        return [];
    }
}

/**
 * Distinct labels ordered by how many episodes carried them.
 * A tie keeps the order the labels were first seen.
 * Each episode counts a label once.
 */
function rankSeriesGenres(episodeGenreLists) {
    const counts = new Map();
    const order = [];
    for (const list of episodeGenreLists || []) {
        if (!Array.isArray(list)) continue;
        const seen = new Set();
        for (const raw of list) {
            const genre = String(raw == null ? "" : raw).trim();
            if (!genre || normalizeGenreLabel(genre) === NO_GENRE || seen.has(genre)) continue;
            seen.add(genre);
            if (!counts.has(genre)) {
                counts.set(genre, 0);
                order.push(genre);
            }
            counts.set(genre, counts.get(genre) + 1);
        }
    }
    return order.slice().sort((a, b) => counts.get(b) - counts.get(a));
}

function genreListFromSeries(series) {
    if (!series || typeof series !== "object") return [];
    const raw = (series.meta && series.meta.genres) || series.genres;
    if (!Array.isArray(raw)) return [];
    const genres = [];
    for (const item of raw) {
        const genre = String(item == null ? "" : item).trim();
        if (!genre || normalizeGenreLabel(genre) === NO_GENRE) continue;
        genres.push(genre);
    }
    return genres;
}

var logger = log4js.getLogger("ReshetScraper");

class ReshetScraper extends BaseScraper {

    constructor(){
        // Initialize BaseScraper with the scraper name
        super('Reshet', { exportFilename: "stremio-reshet", databaseKey: 'reshet' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize Reshet-specific properties
        this._reshetJSONObj = {};
        this._buildId = "";
        this._videos = [];
        this.tmdbHelper = new TmdbHelper();
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        await this.crawlVOD();
    }

    async crawlVOD(){
        logger.trace("crawlVOD() => Entering");
        //writeLog("TRACE","ReshetScraper-crawl() => Entering");

        var seriesListJson =  await this.getJson(RESHET.URL_VOD);
        this._buildId = seriesListJson["buildId"];
        const shows = seriesListJson["props"]["pageProps"]["page"]["Content"]["PageGrid"][0]["shows"];

        // Process series using batch processor. The id comes from the show
        // URL, not from this list position.
        logger.info(`crawlVOD => Found ${shows.length} Reshet series to process`);
        await this.processBatch(
            shows,
            async (series) => {
                return await this.processOneReshetSeries(series);
            },
            "reshet-series"
        );

        logger.info("crawlVOD() => Exiting");
        //writeLog("TRACE","ReshetScraper-crawl() => Exiting");
    }

    /**
     * Process a single Reshet series (extracted from crawlVOD for batch processing)
     */
    async processOneReshetSeries(series) {
        var seriesUrl = series["url"];
        //if no URL we skip
        if ((seriesUrl == undefined) || (seriesUrl.startsWith("/?"))) {
            logger.debug("processOneReshetSeries => No valid URL, skipping");
            return null;
        }

        var picUrl = series["poster"];
        var title = series["title"];
        var seriesReshetId = series["id"];
        logger.debug(`processOneReshetSeries => seriesReshetId: ${seriesReshetId} seriesUrl: ${seriesUrl} `);
        if (seriesUrl.endsWith("/")) seriesUrl = seriesUrl.slice(0, -1);
        var seriesReshetName = seriesUrl.substring(seriesUrl.lastIndexOf("/") + 1);
        const pageLink = RESHET.URL_BASE + seriesUrl;
        var id = this._reshetSeriesId(pageLink);
        logger.debug(`processOneReshetSeries => seriesReshetName: ${seriesReshetName} id: ${id}`);

        var videos = await this.getEpisodes(seriesReshetName, id)
        if (videos == "-1"){
            logger.error("processOneReshetSeries => Invalid KulturaId or page non existing. Skipping");
            return null;
        }

        // Search TMDB for this series so it can merge with the TMDB addon
        const tmdbSeriesId = await this.tmdbHelper.searchTMDBSeries(title);
        if (tmdbSeriesId) {
            logger.info(`processOneReshetSeries => Found TMDB ID ${tmdbSeriesId} for "${title}"`);
        } else {
            logger.debug(`processOneReshetSeries => No TMDB ID found for "${title}"`);
        }

        const extraFields = tmdbSeriesId ? { tmdbId: tmdbSeriesId } : {};
        const genres = this.seriesGenresFor(id, pageLink);
        this.addToJsonObject(id, title, pageLink, picUrl, "", genres, videos, "r", "series", extraFields)
        logger.debug(`processOneReshetSeries => Added series ${title}`);
        return { id, title, tmdbSeriesId };
    }

    async getEpisodes(seriesReshetName, id){
        logger.debug("getEpisodes() => Entering");
        //writeLog("TRACE","ReshetScraper-getEpisodes() => Entering");
        var link = RESHET.URL_BASE + "/_next/data/" + this._buildId + "/he/all-shows/" + seriesReshetName + ".json?all=all-shows&all=" + seriesReshetName;
        logger.debug("getEpisodes() => link used " + link);
        var seriesJson =  await utils.fetchData(link, true);
        if (seriesJson == undefined){
            logger.error(`getEpisodes() => page not found at ${link}`);
            return "-1";
        }
        var grids = seriesJson["pageProps"]["page"]["Content"]["PageGrid"];
        var videos = [];
        var genreSamples = [];
        var anyFetched = false;
        var episodeCount = 0;

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
                            episodeCount++;
                            // A reused stream skipped getStream, so it has no
                            // OTTTAGGenre sample and does not vote.
                            if (result.streamReused) continue;
                            anyFetched = true;
                            genreSamples.push(Array.isArray(result.genres) ? result.genres : []);
                        }
                    }

                    // Sort by reshetEpisodeId (ascending = air order) to get correct episode numbers
                    logger.debug("getEpisodes() => Sorting episodes by ID, oldest first");
                    seasonVideos.sort((a, b) => a.reshetEpisodeId - b.reshetEpisodeId);

                    // Set episode numbers based on sorted order (lowest reshetEpisodeId = episode 1)
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
        if (!this._seriesGenreChoices) this._seriesGenreChoices = new Map();
        this._seriesGenreChoices.set(id, {
            samples: genreSamples,
            anyFetched: anyFetched,
            episodeCount: episodeCount
        });
        return videos;
    }

    /**
     * Genres for one series. Fresh OTTTAGGenre samples win, most common first.
     * When every episode reused a published stream and getStream did not run,
     * keep the genres already published for this series. Otherwise leave empty.
     * meta.genres is an array, the same field Kan and Mako fill.
     */
    seriesGenresFor(id, pageLink) {
        const pending = this._seriesGenreChoices && this._seriesGenreChoices.get(id);
        if (!pending || !pending.anyFetched) {
            if (pending && pending.episodeCount > 0) {
                return this.publishedSeriesGenres(id, pageLink);
            }
            return [];
        }
        return rankSeriesGenres(pending.samples);
    }

    publishedSeriesGenres(seriesId, pageLink) {
        const index = this._seriesIndex;
        if (!index) return [];
        const link = normalizeSeriesLink(pageLink);
        const byId = seriesId != null ? index.byId.get(String(seriesId)) : null;
        if (byId) {
            const idLinkOk = !link || !byId.link || byId.link === link;
            if (idLinkOk) return genreListFromSeries(byId.series);
        }
        if (link && index.byLink.has(link)) {
            return genreListFromSeries(index.byLink.get(link).series);
        }
        return [];
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
        var fetched = await this.getStream(kalturaId, episode["title"]);
        var streams = [];
        var genres = [];
        var streamReused = false;
        if (Array.isArray(fetched)) {
            streams = fetched;
            if (Array.isArray(fetched.genres)) genres = fetched.genres;
            streamReused = fetched.streamReused === true;
        } else if (fetched && typeof fetched === "object") {
            if (Array.isArray(fetched.streams)) streams = fetched.streams;
            if (Array.isArray(fetched.genres)) genres = fetched.genres;
            streamReused = fetched.streamReused === true;
        }

        // Parse Israeli date format
        var released = parseIsraeliDate(episode["air_date"]);

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
        return { video: video, genres: genres, streamReused: streamReused };
    }

    async getStream(kalturaId, streamName){
        logger.trace("getStream() => Entering");
        var streams = [];
        var genres = [];
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
        var streamJsonObj = await utils.fetchData(RESHET.URL_STREAM, true, user_data, RESHET.HEADERS);
        if (streamJsonObj != undefined) {
            genres = genresFromKalturaResponse(streamJsonObj);
            var sources = streamJsonObj[2]["sources"];
            if (sources != undefined){
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
        }
        return { streams: streams, genres: genres };
    }

    async getJson(link){
        logger.trace("getJson() => Entering");
        logger.debug("getJson() => link: " + link);
        var retPage = await utils.fetchData(link);
        var jsonElem = retPage.querySelector("script#__NEXT_DATA__").text;
        var retJson = JSON.parse(jsonElem);
        logger.trace("getJson() => JSON: " + retJson);
        return retJson;
    }

    _reshetSeriesId(pageLink) {
        if (!this._reshetIdClaims) this._reshetIdClaims = new Map();
        const link = normalizeSeriesLink(pageLink);
        const base = reshetSeriesId(pageLink);
        const claimed = this._reshetIdClaims.get(base);
        if (!claimed || claimed === link) {
            this._reshetIdClaims.set(base, link);
            return base;
        }
        const suffix = crypto.createHash("sha1").update(link || String(pageLink)).digest("hex").slice(0, 8);
        const id = `${base}_${suffix}`;
        this._reshetIdClaims.set(id, link);
        return id;
    }

    setSeasonId(seasonName, seasonKey){
        if ((seasonName != undefined) &&(seasonName.startsWith("עונה "))){
            seasonName = seasonName.replace("עונה ","");
            return seasonName;
        } else {
            return seasonKey;
        }
    }
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = ReshetScraper;
module.exports.reshetSeriesId = reshetSeriesId;
module.exports.parseReshetGenreXml = parseReshetGenreXml;
module.exports.genresFromKalturaResponse = genresFromKalturaResponse;
module.exports.rankSeriesGenres = rankSeriesGenres;
