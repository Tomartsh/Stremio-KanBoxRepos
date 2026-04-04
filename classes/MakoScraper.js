
const constants = require("./constants.js");
const utils = require("./utilities.js");
const {
    LOG4JS,
    MAKO,
    PREFIX,
    TMDB
} = require("./constants");
const {fetchData, sleeperTimer} = require("./utilities.js");
const { v1: uuidv1 } = require('uuid');
const log4js = require("log4js");

log4js.configure({
    appenders: { 
        out: { type: "stdout" },
        Stremio: { 
            type: LOG4JS.TYPE, 
            filename: LOG4JS.FILENAME, 
            maxLogSize: LOG4JS.MAX_SIZE, 
            backups: LOG4JS.BACKUP_FILES,
        }
    },
    categories: { default: { appenders: ['Stremio','out'], level: LOG4JS.LEVEL } },
});

const logger = log4js.getLogger("MakoScraper");

class MakoScraper {
    constructor() {
        this._makoJSONObj = {};
        this._deviceId = "";
        this.seriesId = 100;
        this._tmdbEnabled = TMDB.ENABLED;
        this._tmdbCache = new Map(); // Cache TMDB results to avoid duplicate searches
    }

    async crawl(isDoWriteFile = false) {
        logger.trace("crawl() => Entering");
        this.generateDeviceID();
        logger.debug("crawl() => setting device ID to: " + this._deviceId);
        
        try {
            await this.getSeries();

            if (isDoWriteFile) {
                logger.info("crawl => writing JSON file");
                this.writeJSON(this._makoJSONObj);
            }
        } catch (error) {
            logger.error("crawl() => Fatal error:", error);
            throw error;
        }
        
        logger.debug("crawl() => Exiting");
    }

    /**
     * Validates that response is valid JSON and not an HTML error page
     */
    isValidJsonResponse(data) {
        if (!data) return false;
        if (typeof data === 'string') {
            // Check if it's HTML (error page)
            if (data.trim().startsWith('<!DOCTYPE html>') || 
                data.trim().startsWith('<html') ||
                data.includes('@@@page not found')) {
                return false;
            }
        }
        return true;
    }

    async getSeries() {
        const jsonPage = await fetchData(MAKO.URL_VOD, true);
        
        if (!this.isValidJsonResponse(jsonPage) || !jsonPage.items) {
            logger.error('getSeries => Invalid response from VOD page');
            return;
        }

        for (const series of jsonPage.items) {
            try {
                await this.processSeries(series);
            } catch (error) {
                logger.error(`getSeries => Error processing series "${series.title}":`, error.message);
                continue; // Continue with next series
            }
        }
    }

    async processSeries(series) {
        const videos = [];
        const title = series.title;
        const poster = series.pic;
        const seriesUrl = MAKO.URL_BASE + series.pageUrl;
        const id = PREFIX + "mako_" + this.seriesId;

        logger.debug(`processSeries => Processing: ${title} (${seriesUrl})`);

        const seasons = await fetchData(seriesUrl + MAKO.URL_SUFFIX, true);

        // Validate response
        if (!this.isValidJsonResponse(seasons)) {
            logger.error(`processSeries => Invalid response for ${title} at ${seriesUrl}${MAKO.URL_SUFFIX}`);
            return;
        }

        // Extract metadata
        const genres = seasons?.seo?.schema?.genre || [];
        const description = seasons?.seo?.description;
        const background = seasons?.hero?.pics?.[0]?.picUrl;

        // Search TMDB for this series
        let tmdbSeriesId = null;
        if (this._tmdbEnabled) {
            tmdbSeriesId = await this.searchTMDBSeries(title);
            if (tmdbSeriesId) {
                logger.info(`processSeries => Found TMDB ID ${tmdbSeriesId} for "${title}"`);
            } else {
                logger.debug(`processSeries => No TMDB ID found for "${title}"`);
            }
        }

        // Handle series without seasons structure
        if (!seasons.seasons) {
            await this.handleSeriesWithoutSeasons(seasons, id, seriesUrl, title, background, poster, description, genres, tmdbSeriesId);
            return;
        }

        // Process each season
        for (const season of seasons.seasons) {
            const seasonVideos = await this.processSeason(season, id, title, tmdbSeriesId);
            if (seasonVideos && seasonVideos.length > 0) {
                videos.push(...seasonVideos);
            }
        }

        if (videos.length > 0) {
            this.addToJsonObject(id, seriesUrl, title, background, poster, description, genres, videos, tmdbSeriesId);
            this.seriesId++;
            logger.info(`processSeries => Successfully processed ${title} with ${videos.length} episodes`);
        } else {
            logger.warn(`processSeries => No videos found for ${title}`);
        }
    }

    async handleSeriesWithoutSeasons(seasons, id, seriesUrl, title, background, poster, description, genres) {
        if (!seasons.menu?.[0]) {
            logger.warn(`handleSeriesWithoutSeasons => No menu found for ${title}`);
            return;
        }

        if (!seasons.menu[0].vods) {
            logger.warn(`handleSeriesWithoutSeasons => No VODs in menu for ${title}`);
            return;
        }

        const videos = await this.getEpisodes(seasons.menu, id, "-1", null);

        if (videos && videos.length > 0) {
            this.addToJsonObject(id, seriesUrl, title, background, poster, description, genres, videos, null);
            this.seriesId++;
            logger.info(`handleSeriesWithoutSeasons => Successfully processed ${title}`);
        }
    }

    async processSeason(season, seriesId, seriesTitle, tmdbSeriesId = null) {
        const seasonUrl = MAKO.URL_BASE + season.pageUrl;
        const seasonId = this.setSeasonId(season.seasonTitle, seasonUrl);

        logger.debug(`processSeason => Season ID: ${seasonId}, URL: ${seasonUrl}`);

        const seasonEpisodesPage = await fetchData(seasonUrl + MAKO.URL_SUFFIX, true);

        if (!this.isValidJsonResponse(seasonEpisodesPage)) {
            logger.error(`processSeason => Invalid response for season ${seasonId} at ${seasonUrl}`);
            return [];
        }

        const videos = await this.getEpisodes(seasonEpisodesPage, seriesId, seasonId, tmdbSeriesId);

        if (videos && videos.length > 0) {
            logger.debug(`processSeason => Found ${videos.length} episodes in season ${seasonId} of ${seriesTitle}`);
        }

        return videos || [];
    }

    async getEpisodes(seasonData, id, seasonId = "0", tmdbSeriesId = null) {
        logger.debug(`getEpisodes => SeasonID: ${seasonId}`);

        const videos = [];
        let episodes;
        let channelId;

        // Handle different season data structures
        if (seasonId === "-1") {
            // Single season without structure
            if (!seasonData[0]?.vods) {
                logger.warn('getEpisodes => No VODs found in season data');
                return videos;
            }
            seasonId = "1";
            episodes = seasonData[0].vods;
            channelId = seasonData[0].channelId;
        } else if (seasonData?.menu?.[0]?.vods) {
            episodes = seasonData.menu[0].vods;
            channelId = seasonData.channelId;
        } else {
            logger.warn('getEpisodes => Could not find episodes in expected structure');
            return videos;
        }

        if (!Array.isArray(episodes) || episodes.length === 0) {
            logger.warn('getEpisodes => Episodes array is empty or invalid');
            return videos;
        }

        logger.debug(`getEpisodes => Found ${episodes.length} episodes, channelId: ${channelId}`);

        let episodeNumber = episodes.length;

        for (const episode of episodes) {
            if (episode.componentLayout !== "vod") {
                continue;
            }

            try {
                const episodeData = await this.getEpisode(episode, id, seasonId, episodeNumber, channelId, tmdbSeriesId);
                
                if (episodeData.status !== "1") {
                    logger.warn(`getEpisodes => Skipping episode due to status: ${episodeData.status}`);
                    episodeNumber--;
                    continue;
                }

                const streams = await this.getStream(episodeData.episodeAjax, episodeData.episodeTitle, episodeNumber);

                const videoJsonObj = {
                    id: episodeData.episodeId,
                    title: episodeData.episodeTitle,
                    season: parseInt(seasonId) || 1,
                    episode: episodeNumber,
                    thumbnail: episodeData.episodePic,
                    episodeLink: episodeData.episodePage,
                    streams: streams
                };

                if (episodeData.episodeReleased) {
                    videoJsonObj.released = episodeData.episodeReleased;
                }

                if (episodeData.tmdbEpisodeId) {
                    videoJsonObj.tmdbEpisodeId = episodeData.tmdbEpisodeId;
                }
                
                videos.push(videoJsonObj);
                logger.debug(`getEpisodes => Added episode ${episodeNumber}: ${episodeData.episodeTitle}`);
                
            } catch (error) {
                logger.error(`getEpisodes => Error processing episode:`, error.message);
            }
            
            episodeNumber--;
        }

        return videos;
    }

    async getEpisode(episode, id, seasonId, episodeNo, channelId, tmdbSeriesId = null) {
        try {
            // Validate required fields
            if (!episode.pics?.[0]?.picUrl) {
                throw new Error('Missing episode picture');
            }
            if (!episode.itemVcmId) {
                throw new Error('Missing episode VCM ID');
            }
            if (!episode.pageUrl) {
                throw new Error('Missing episode page URL');
            }

            const episodePic = episode.pics[0].picUrl;
            let episodeReleased = "";
            let episodeTitle = episode.title || `Episode ${episodeNo}`;

            // Parse release date
            if (episode.extraInfo) {
                const dateStr = episode.extraInfo.includes("@")
                    ? episode.extraInfo.split("@")[1]
                    : episode.extraInfo;

                const date = new Date(dateStr);
                episodeReleased = isNaN(date.getTime()) ? "" : date.toISOString();
            }

            const tempEpisodeId = this.getEpisodeIdFromTitle(episodeTitle, episodeNo);
            const episodeId = `${id}:${seasonId}:${tempEpisodeId}`;
            const vcmid = episode.itemVcmId;
            const episodePage = MAKO.URL_BASE + episode.pageUrl;

            // Fetch episode data (this has the media/CDN info)
            const episodeAjax = await fetchData(MAKO.URL_EPISODE(vcmid, channelId), true);

            if (!this.isValidJsonResponse(episodeAjax)) {
                logger.warn(`getEpisode => Invalid response for episode ${episodeId}`);
                return { status: "0" };
            }

            // Search TMDB for this episode if we have a series ID
            let tmdbEpisodeId = null;
            if (this._tmdbEnabled && tmdbSeriesId) {
                tmdbEpisodeId = await this.searchTMDBEpisode(tmdbSeriesId, parseInt(seasonId), episodeNo);
                if (tmdbEpisodeId) {
                    logger.debug(`getEpisode => Found TMDB episode ID ${tmdbEpisodeId} for ${episodeId}`);
                }
            }

            return {
                status: "1",
                episodePic,
                episodeTitle,
                episodeId,
                episodePage,
                episodeReleased,
                vcmid,
                channelId, // Store this for later stream resolution
                episodeAjax,
                tmdbEpisodeId
            };
            
        } catch (error) {
            logger.error(`getEpisode => Error:`, error.message);
            return { status: "0" };
        }
    }

    async getStream(episodeAjax, episodeTitle, episodeNumber) {
        const streams = [];

        if (!episodeAjax?.media || !Array.isArray(episodeAjax.media)) {
            logger.warn('getStream => No media found in episode data');
            return streams;
        }

        const label = episodeTitle || ("פרק " + episodeNumber);
        let streamIndex = 1;

        for (let i = 0; i < episodeAjax.media.length; i++) {
            const cdn = episodeAjax.media[i];

            try {
                if (!cdn.url || !cdn.cdn) {
                    logger.warn('getStream => Missing URL or CDN info');
                    continue;
                }

                // Just store the raw stream info - NO ticket fetching
                const stream = {
                    url: cdn.url,
                    cdn: cdn.cdn,
                    cdnLB: cdn.cdnLB || 0,
                    name: label + " - stream " + streamIndex
                };
                streamIndex++;
                
                streams.push(stream);
                logger.debug(`getStream => Added stream info from ${cdn.cdn}`);
                
                // Small delay between processing CDNs (no need for large delays now)
                if (i < episodeAjax.media.length - 1) {
                    await sleeperTimer(200); // Just 200ms
                }
                
            } catch (error) {
                logger.error(`getStream => Error processing CDN ${cdn.cdn}:`, error.message);
            }
        }
        
        if (streams.length === 0) {
            logger.warn('getStream => No valid streams found for this episode');
        }

        return streams;
    }

    addToJsonObject(id, seriesUrl, title, background, poster, description, genres, videos, tmdbSeriesId = null) {
        const seriesObj = {
            id: id,
            link: seriesUrl,
            name: title,
            type: "series",
            subtype: "m",
            meta: {
                id: id,
                type: "series",
                name: title,
                link: seriesUrl,
                background: background,
                poster: poster,
                posterShape: "poster",
                logo: background,
                description: description,
                genres: genres,
                videos: videos
            }
        };

        // Add TMDB series ID if found
        if (tmdbSeriesId) {
            seriesObj.meta.tmdbId = tmdbSeriesId;
            seriesObj.tmdbId = tmdbSeriesId; // Also at top level for easy access
            logger.debug(`addToJsonObject => Added TMDB ID ${tmdbSeriesId} to series "${title}"`);
        }

        this._makoJSONObj[id] = seriesObj;

        logger.info(`addToJsonObject => Added series, ID: ${id}, Name: ${title}, Videos: ${videos.length}`);
    }

    generateDeviceID() {
        const uuidStr = uuidv1().toUpperCase();
        this._deviceId = `W${uuidStr.slice(0, 8)}${uuidStr.slice(9)}`;
    }

    setSeasonId(seasonName, seasonUrl) {
        if (!seasonName) {
            return seasonUrl;
        }
        
        let cleanName = seasonName.trim();
        if (cleanName.startsWith("עונה ")) {
            cleanName = cleanName.replace("עונה ", "");
        }
        
        return cleanName.trim();
    }

    getEpisodeIdFromTitle(str, tempEpisodeId) {
        if (!str || str.indexOf("@") < 1) {
            return tempEpisodeId;
        }
        
        let episodeId = str.split("@")[1];
        if (episodeId.startsWith("פרק ")) {
            episodeId = episodeId.replace("פרק ", "");
        }
        
        return episodeId.trim() || tempEpisodeId;
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

    writeJSON(makoJSONObj) {
        logger.trace("writeJSON => Entered");
        logger.debug(`writeJSON => Writing ${Object.keys(makoJSONObj).length} series to file`);
        utils.writeJSONToFile(makoJSONObj, "stremio-mako");
        logger.trace("writeJSON => Leaving");
    }
}

module.exports = MakoScraper;

/*const constants = require("./constants.js");
const utils = require("./utilities.js");
const {
    URL_MAKE_EPISODE,
    URL_MAKO_ENTITLEMENT_SERVICES,
    MAKO.URL_SUFFIX, 
    MAX_LOG_SIZE, 
    LOG_BACKUP_FILES, 
    LOG4JS_LEVEL,
    LOG_FILENAME, 
    MAKO.URL_BASE, 
    MAKO.URL_VOD, 
    PREFIX
} = require ("./constants");
const {fetchData, sleeperTimer} = require("./utilities.js");
const { v1: uuidv1 } = require('uuid');
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

var logger = log4js.getLogger("MakoScraper");

class MakoScraper{
    constructor(){
        this._makoJSONObj = {};
        this._devideId = "";
        this.seriesId = 100;
    }

    async crawl(isDoWriteFile = false){
        logger.trace("crawl() => Entering");
        this.generateDeviceID();
        logger.debug("crawl() => setting devide ID to: " + this._devideId);
        
        //await this.crawlMako();
        await this.getSeries();

        if (isDoWriteFile){
            logger.info("crawl => writing JSON file");
            this.writeJSON(this._makoJSONObj);
        }
        logger.debug("crawl() => Exiting");
    }

    async getSeries(){
        var jsonPage = await fetchData(MAKO.URL_VOD, true);     

        for (var series of jsonPage["items"]){
            var videos = [];
            var genres = [];
            var description;
            var background;
            var title = series["title"];
            var poster = series["pic"];
            var seriesUrl = MAKO.URL_BASE + series["pageUrl"];
            var id = PREFIX + "mako_" + this.seriesId;

            var seasons = await fetchData(seriesUrl + MAKO.URL_SUFFIX, true);
            if (seasons == undefined){ //if the link is bad do not cripple the process
                logger.error(`getSeries => Cannot get series at url: ${seriesUrl}${MAKO.URL_SUFFIX}. Moving to next series`);    
                continue; 
            } 
            if (typeof seasons === 'string' && seasons.startsWith("<!DOCTYPE html>")) { //In case we get a valud HTML file, just not the one we want.
                logger.error(`getSeries => Series Ppage not found at url: ${seriesUrl}${MAKO.URL_SUFFIX}. Moving to next series`);    
                continue; 
            } 
            genres = seasons?.seo?.schema?.genre || []; //get the genres
            description = seasons?.seo?.description;
            background = seasons?.hero?.pics?.[0]?.picUrl;
            
            if (seasons["seasons"] == undefined){
                logger.info(`getSeries => seasons is: ` + seasons ); 
                if ((seasons["menu"] == undefined) || (seasons?.menu?.[0] == undefined)){continue;}
                if (seasons?.menu?.[0]?.vods){
                    videos = await this.getEpisodes(seasons["menu"], id, "-1");
                    this.addToJsonObject(id, seriesUrl, title, background, poster, description,genres, videos);
                    this.seriesId++;
                    continue;
                } else {
                    logger.error(`getSeries => Cannot get series at url: ${seriesUrl}. Exiting`); 
                    continue;
                }  
            }
            for (var season of seasons["seasons"]){
                var seasonUrl = MAKO.URL_BASE + season["pageUrl"];
                var seasonId = this.setSeasonId(season["seasonTitle"],seasonUrl);
                logger.debug("getSeries => Season ID: " + seasonId + ". URL: " + seasonUrl); 
                
                //for each season get the episodes
                var seasonEpisodesPage = await fetchData(seasonUrl + MAKO.URL_SUFFIX, true); 
                if (seasonEpisodesPage == undefined){continue;}
                logger.debug(`getSeries => seasonEpisodesPage link:  ${seasonUrl}${MAKO.URL_SUFFIX}`); 
                var videosEpisodes = await this.getEpisodes(seasonEpisodesPage, id, seasonId);
                
                if (videosEpisodes == null) {
                    return;
                }
                for (var episode of videosEpisodes) {videos.push(episode);}
                logger.debug(`getSeries => ${title} Videos:  ${videos.length}` ); 
            }

            this.addToJsonObject(id, seriesUrl, title, background, poster, description,genres, videos);
            this.seriesId++;
        }
    }

    async getEpisodes(season, id, seasonId = "0"){
        logger.debug(`getEpisodes => SeasonID: ${seasonId}. Sesason: ${season}`);
        var videos = [];
        var retryVideos = [];
        var episodes;
        var channelId;        //var seasonUrl = MAKO.URL_BASE + season["pageUrl"];
        if (seasonId == "-1"){
            seasonId = 1;
            episodes = season[0]["vods"];
            channelId = season[0]["channelId"];
        } else if (season?.menu[0]?.vods) {
            episodes = season?.menu[0]?.vods;
            channelId = season["channelId"];
        } else {
            return videos;
        }
          
        logger.debug("getEpisodes => Season ID: " + seasonId + ". channelId: " + channelId);
        var noOfEpisodes;
        try {
            noOfEpisodes = episodes.length;
        } catch(error) {
            logger.error("getEpisodes => no videos at all !");
            return null;
        }
        
        var i = 1;
        for (var episode of episodes){
            if (episode["componentLayout"] != "vod") {continue;}

            var {
                status,
                episodePic,
                episodeTitle,
                episodeId,
                episodePage,
                episodeReleased,
                vcmid,
                episodeAjax
             } = await this.getEpisode(episode, id, seasonId, noOfEpisodes, channelId);

             //At the mment we are laying ground work for retry. We are not actually using it at the moment
             //check if we got a valid response. If not, store the data we need in an array to try again later
             if (status == "-1"){
                retryVideos.push({
                    episode: episode,
                    id: id,
                    seasonId: seasonId,
                    episodeNo: noOfEpisodes,
                    channelId: channelId
                });
                continue;
             }
             if (status == "0"){ continue;}
 
            logger.debug("getEpisodes => episode ID: " + episodeId + ". released: " + episodeReleased + " Episode Title: " + episodeTitle);
            
            var streams = await this.getStream(episodeAjax);

            var videoJsonObj = {
                id: episodeId,
                title: episodeTitle,
                season: seasonId,
                episode: noOfEpisodes,
                thumbnail: episodePic,
                episodeLink: episodePage,
                streams: streams
            }
            if (episodeReleased != "") {videoJsonObj["released"] = episodeReleased;}
            
            videos.push(videoJsonObj);
            noOfEpisodes--;
            i++;
        }
        return videos;
    }

    async getEpisode(episode, id, seasonId, episodeNo, channelId, retry = "0"){
        var episodePic = episode["pics"][0]["picUrl"];
        var episodeReleased = "";
        var episodeTitle = "";

        if (episode["title"] != ""){
            episodeTitle = episode["title"];
        }
        if ((episode["extraInfo"] != undefined) && (episode["extraInfo"] != "")){
            if (episode["extraInfo"].includes("@")){
                episodeReleased = episode["extraInfo"].split("@")[1];
            } else {
                episodeReleased = episode["extraInfo"]
            }
            const date = new Date(episodeReleased);
            episodeReleased = isNaN(date.getTime()) ? "" : date.toISOString();
        } 

        //var tempEpisodeId = this.getEpisodeIdFromTitle(episodeTitle,noOfEpisodes)
        var tempEpisodeId = this.getEpisodeIdFromTitle(episodeTitle,episodeNo)
        var  episodeId = id + ":" + seasonId +":" + tempEpisodeId;
        var vcmid = episode["itemVcmId"];
        var episodePage = MAKO.URL_BASE + episode["pageUrl"];

        var episodeAjax = await fetchData(URL_MAKE_EPISODE(vcmid, channelId), true);
        if (episodeAjax == undefined){
            if (retry == "0" ){
                return {status: "-1"};
            } else { 
                return {status: "0"} //This is already a retry, so fail it
            }; 
        }
        return {
            status: "1",
            episodePic: episodePic,
            episodeTitle: episodeTitle,
            episodeId: episodeId,
            episodePage: episodePage,
            episodeReleased: episodeReleased,
            vcmid: vcmid,
            episodeAjax: episodeAjax
        }
    }

    async getStream(episodeAjax){
        var streams = [];
        var cdns = episodeAjax["media"];

            
        for (var cdn of cdns){
            var link = URL_MAKO_ENTITLEMENT_SERVICES + "?et=gt&lp=" + cdn["url"] + "&rv=" + cdn["cdn"];
            var ticketPage = await fetchData(link, true);
            if (ticketPage == undefined ){continue;}
            //decode the ticket
            //var ticketRaw = ticketPage["tickets"][0]["ticket"];
            //var ticket = decodeURIComponent(ticketRaw);
            var url = "";
            if (ticketPage["tickets"][0]["url"].startsWith("/")){
                url = cdn["url"];
            } else {
                url = ticketPage["tickets"][0]["url"];
            }
            var vendor = ticketPage["tickets"][0]["vendor"];
            var stream = {
*/
                /*
                Mako has a time dependant ticket in order to play the stream, so we need to store the URL to create the stream
                and get the ticket when the stream is accessed
                */
/*
                url: cdn["url"],
                link: link,
                vendor: ticketPage["tickets"][0]["vendor"]
            }
            streams.push(stream);
        }
        return streams;
    }

    addToJsonObject(id, seriesUrl, title, background, poster, description, genres, videos, streams){
        this._makoJSONObj[id] = {
            id: id, 
            link: seriesUrl,
            name: title,
            type: "series",
            subtype: "m",
            meta:{
                id: id,
                type: "series",
                name: title,
                link: seriesUrl,
                background: background,
                poster: poster,
                posterShape: "poster",
                logo: background,
                description: description,
                genres: genres,
                videos: videos,
                makoStreams: streams
            }
        }

        logger.info("addToJsonObject => Added  series, ID: " + id + " Name: " + title + " Link: " + seriesUrl);
    }

    generateDeviceID(){
        // Generate a UUID (version 1)
        const uuidStr = uuidv1().toUpperCase();
        var deviceID = `W${uuidStr.slice(0, 8)}${uuidStr.slice(9)}`;
        this._devideId = deviceID;
    }

    setSeasonId(seasonName, seasonUrl){
        if (seasonName != undefined){
            if (seasonName.startsWith("עונה ")){
                seasonName = seasonName.replace("עונה ","");
            }
            seasonName = seasonName.trim();
            return seasonName;
        } else {
            return seasonUrl;
        }
    }

    getEpisodeIdFromTitle(str, tempEpisodeId){
        if (str.indexOf("@") < 1){
            return tempEpisodeId;
        }
        var episodeId = str.split("@")[1];
        if (episodeId.startsWith("פרק ")){
            episodeId = episodeId.replace("פרק ","");
            return episodeId;
        } 
        return tempEpisodeId
    }

    writeJSON(makoJSONObj){
        logger.trace("writeJSON => Entered");
        logger.debug("writeJSON => All tasks completed - writing file");
        utils.writeJSONToFile(makoJSONObj, "stremio-mako");

        logger.trace("writeJSON => Leaving");
    }

}
*/
/**********************************************************
 * Module Exports
 **********************************************************/
//module.exports = MakoScraper;
