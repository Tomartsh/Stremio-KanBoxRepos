const utils = require("./utilities.js");
const {
    LOG4JS,
    RESHET,
    PREFIX,
    SCRAPER_CONFIG
} = require ("./constants");
const {fetchData, writeLog, extractReleaseDate, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
const { parseIsraeliDate } = require("./ScraperHelpers.js");
const log4js = require("log4js");
const BaseScraper = require("./BaseScraper.js");

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

        logger.info("crawlVOD() => Exiting");
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

        var videos = await this.getEpisodes(seriesReshetName, id)
        if (videos == "-1"){
            logger.error("processOneReshetSeries => Invalid KulturaId or page non existing. Skipping");
            return null;
        }

        this.addToJsonObject(id, title, RESHET.URL_BASE + seriesUrl, picUrl, "",  "", videos, "r", "series")
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

    async getJson(link){
        logger.trace("getJson() => Entering");
        logger.debug("getJson() => link: " + link);
        var retPage = await fetchData(link);
        var jsonElem = retPage.querySelector("script#__NEXT_DATA__").text;
        var retJson = JSON.parse(jsonElem);
        logger.trace("getJson() => JSON: " + retJson);
        return retJson;
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
