
const constants = require("./constants.js");
const TmdbHelper = require("./TmdbHelper.js");
const utils = require("./utilities.js");
const {
    LOG4JS,
    MAKO,
    PREFIX,
    TMDB
} = require("./constants");
const {fetchData, sleeperTimer, DeltaTracker, updateDatabaseFromJSON} = require("./utilities.js");
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
        this.tmdbHelper = new TmdbHelper();
        
        this.deltaTracker = new DeltaTracker();
    }

    async crawl(isDoWriteFile = false) {
        logger.trace("crawl() => Entering");
        this.generateDeviceID();
        this.deltaTracker.clear();
        logger.debug("crawl() => setting device ID to: " + this._deviceId);

        try {
            await this.getSeries();

            const { WRITE_TO_GITHUB, UPDATE_DATABASE } = require("./constants");

            if (WRITE_TO_GITHUB || UPDATE_DATABASE) {
                logger.info("Delta Summary:", JSON.stringify(this.deltaTracker.getSummary()));

                if (WRITE_TO_GITHUB) {
                    logger.info("crawl => writing JSON file to GitHub");
                    this.writeJSON(this._makoJSONObj);
                }

                if (UPDATE_DATABASE) {
                    logger.info("crawl => updating database in bulk");
                    await this.updateDatabase(this._makoJSONObj);
                }
            } else if (isDoWriteFile) {
                // Backward compatibility
                logger.info("crawl => writing JSON file");
                logger.info("Delta Summary:", JSON.stringify(this.deltaTracker.getSummary()));
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
        tmdbSeriesId = await this.tmdbHelper.searchTMDBSeries(title);
        if (tmdbSeriesId) {
            logger.info(`processSeries => Found TMDB ID ${tmdbSeriesId} for "${title}"`);
        } else {
            logger.debug(`processSeries => No TMDB ID found for "${title}"`);
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

    async handleSeriesWithoutSeasons(seasons, id, seriesUrl, title, background, poster, description, genres, tmdbSeriesId = null) {
        if (!seasons.menu?.[0]) {
            logger.warn(`handleSeriesWithoutSeasons => No menu found for ${title}`);
            return;
        }

        if (!seasons.menu[0].vods) {
            logger.warn(`handleSeriesWithoutSeasons => No VODs in menu for ${title}`);
            return;
        }

        const videos = await this.getEpisodes(seasons.menu, id, "-1", tmdbSeriesId);

        if (videos && videos.length > 0) {
            this.addToJsonObject(id, seriesUrl, title, background, poster, description, genres, videos, tmdbSeriesId);
            this.seriesId++;
            logger.info(`handleSeriesWithoutSeasons => Successfully processed ${title}`);
        }
    }

    async processSeason(season, seriesId, seriesTitle, tmdbSeriesId = null) {
        const seasonUrl = MAKO.URL_BASE + season.pageUrl;
        const makoSeasonId = this.setSeasonId(season.seasonTitle, seasonUrl);

        logger.debug(`processSeason => Mako Season ID: ${makoSeasonId}, URL: ${seasonUrl}`);

        const seasonEpisodesPage = await fetchData(seasonUrl + MAKO.URL_SUFFIX, true);

        if (!this.isValidJsonResponse(seasonEpisodesPage)) {
            logger.error(`processSeason => Invalid response for season ${makoSeasonId} at ${seasonUrl}`);
            return [];
        }

        const videos = await this.getEpisodes(seasonEpisodesPage, seriesId, makoSeasonId, tmdbSeriesId);

        if (videos && videos.length > 0) {
            // Derive correct season year from actual release dates
            const correctedSeasonId = this.deriveSeasonFromDates(videos, makoSeasonId);

            if (correctedSeasonId !== makoSeasonId) {
                logger.info(`processSeason => Corrected season ID from ${makoSeasonId} to ${correctedSeasonId} for ${seriesTitle}`);
                // Update all videos with corrected season
                videos.forEach(video => {
                    video.season = parseInt(correctedSeasonId) || 1;
                });
            }

            logger.debug(`processSeason => Found ${videos.length} episodes in season ${correctedSeasonId} of ${seriesTitle}`);
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
                logger.info(`Added: S${seasonId} E${episodeNumber} - ${episodeData.episodeTitle}`);
                
            } catch (error) {
                logger.error(`getEpisodes => Error processing episode:`, error.message);
            }
            
            episodeNumber--;
        }

        return videos;
    }

    /**
     * Try multiple methods to get episode release date
     * Fallback chain: TMDB (by ID) -> TMDB (by S/E) -> extraInfo -> HTML page scraping
     * TMDB is prioritized as it's more reliable than Mako's extraInfo
     */
    async getEpisodeReleaseDate(episode, episodeId, episodePage, tmdbSeriesId, tmdbEpisodeId, seasonNum, episodeNum) {

        // Method 1: Try TMDB API with episode ID (most efficient if we have it)
        if (tmdbEpisodeId) {
            try {
                logger.debug(`🔍 ${episodeId}: Trying TMDB API with episode ID ${tmdbEpisodeId}...`);

                const tmdbUrl = `https://api.themoviedb.org/3/tv/episode/${tmdbEpisodeId}?api_key=${this._tmdbApiKey}&language=he`;
                const response = await fetch(tmdbUrl);

                if (response.ok) {
                    const data = await response.json();
                    if (data.air_date) {
                        const airDate = new Date(data.air_date);
                        if (!isNaN(airDate.getTime())) {
                            logger.info(`✅ ${episodeId}: Date from TMDB (by ID): ${airDate.toISOString().substring(0, 10)}`);
                            return airDate.toISOString();
                        }
                    }
                }
                logger.debug(`⚠️  ${episodeId}: TMDB (by ID): No air_date found`);
            } catch (error) {
                logger.debug(`⚠️  ${episodeId}: TMDB (by ID) error: ${error.message}`);
            }
        }

        // Method 2: Try TMDB API with series/season/episode numbers
        if (tmdbSeriesId) {
            tmdbEpisodeId = await this.tmdbHelper.searchTMDBEpisode(tmdbSeriesId, seasonNum, episodeNum);
            if (tmdbEpisodeId) {
                try {
                    logger.debug(`🔍 ${episodeId}: Trying TMDB API for S${seasonNum}E${episodeNum}...`);

                    const tmdbUrl = `https://api.themoviedb.org/3/tv/episode/${tmdbEpisodeId}?api_key=${this._tmdbApiKey}&language=he`;
                    const response = await fetch(tmdbUrl);

                    if (response.ok) {
                        const data = await response.json();
                        if (data.air_date) {
                            const airDate = new Date(data.air_date);
                            if (!isNaN(airDate.getTime())) {
                                logger.info(`✅ ${episodeId}: Date from TMDB (by S/E): ${airDate.toISOString().substring(0, 10)}`);
                                return airDate.toISOString();
                            }
                        }
                    }
                    logger.debug(`⚠️  ${episodeId}: TMDB (by S/E): No air_date found`);
                } catch (error) {
                    logger.debug(`⚠️  ${episodeId}: TMDB (by S/E) error: ${error.message}`);
                }
            }
        } else {
            logger.debug(`⏭️  ${episodeId}: TMDB not enabled or no series ID`);
        }

        // Method 3: Try extraInfo from Mako API (less reliable than TMDB)
        if (episode.extraInfo) {
            const dateStr = episode.extraInfo.includes("@")
                ? episode.extraInfo.split("@")[1]
                : episode.extraInfo;

            // Parse date - handle both DD.MM.YYYY and DD.MM.YY formats
            let parsedDate;
            const parts = dateStr.split('.');

            if (parts.length === 3) {
                const [day, month, year] = parts;
                // Handle 2-digit year (YY) vs 4-digit year (YYYY)
                const fullYear = year.length === 2
                    ? (parseInt(year) > 50 ? '19' + year : '20' + year)  // Assume 1950-2049 range
                    : year;

                parsedDate = new Date(`${fullYear}-${month}-${day}`);
            } else {
                // Try standard Date parsing as fallback
                parsedDate = new Date(dateStr);
            }

            if (!isNaN(parsedDate.getTime())) {
                logger.info(`📅 ${episodeId}: Date from extraInfo: ${parsedDate.toISOString().substring(0, 10)}`);
                return parsedDate.toISOString();
            } else {
                logger.warn(`⚠️  ${episodeId}: Invalid date in extraInfo: "${dateStr}"`);
            }
        } else {
            logger.debug(`🔍 ${episodeId}: No extraInfo field, trying next fallback...`);
        }

        // Method 4: Try fetching episode page and extracting date from HTML
        try {
            logger.debug(`🔍 ${episodeId}: Trying HTML page scraping...`);

            const response = await fetch(episodePage);
            if (response.ok) {
                const html = await response.text();

                // Look for date patterns in Hebrew format (DD.MM.YYYY) or ISO format
                const datePatterns = [
                    /(\d{2})\.(\d{2})\.(\d{4})/,  // DD.MM.YYYY
                    /(\d{4})-(\d{2})-(\d{2})/,   // YYYY-MM-DD
                    /(\d{1,2})\s+(בינו׳|פבר׳|מרץ|אפר׳|מאי|יוני|יולי|אוג׳|ספט׳|אוק׳|נוב׳|דצמ׳)\s+(\d{4})/  // Hebrew dates
                ];

                for (const pattern of datePatterns) {
                    const match = html.match(pattern);
                    if (match) {
                        let dateStr;
                        if (pattern === datePatterns[0]) {
                            // DD.MM.YYYY -> YYYY-MM-DD
                            dateStr = `${match[3]}-${match[2]}-${match[1]}`;
                        } else if (pattern === datePatterns[1]) {
                            // Already in YYYY-MM-DD format
                            dateStr = match[0];
                        } else {
                            // Hebrew date - skip for now (would need month mapping)
                            continue;
                        }

                        const date = new Date(dateStr);
                        if (!isNaN(date.getTime()) && date.getFullYear() > 2000 && date.getFullYear() < 2100) {
                            logger.info(`✅ ${episodeId}: Date from HTML: ${date.toISOString().substring(0, 10)}`);
                            return date.toISOString();
                        }
                    }
                }
                logger.debug(`⚠️  ${episodeId}: HTML: No date patterns found`);
            } else {
                logger.debug(`⚠️  ${episodeId}: HTML: Failed to fetch page (${response.status})`);
            }
        } catch (error) {
            logger.debug(`⚠️  ${episodeId}: HTML error: ${error.message}`);
        }

        // All methods failed
        logger.warn(`❌ ${episodeId}: Could not find release date (will be sorted by episode number)`);
        return "";
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
            let episodeTitle = episode.title || `Episode ${episodeNo}`;

            const tempEpisodeId = this.getEpisodeIdFromTitle(episodeTitle, episodeNo);
            const episodeId = `${id}:${seasonId}:${tempEpisodeId}`;
            const vcmid = episode.itemVcmId;
            const episodePage = MAKO.URL_BASE + episode.pageUrl;

            // Search TMDB for this episode FIRST (needed for date lookup)
            let tmdbEpisodeId = null;
            tmdbEpisodeId = await this.tmdbHelper.searchTMDBEpisode(tmdbSeriesId, parseInt(seasonId), episodeNo);
            if (tmdbEpisodeId) {
                logger.debug(`getEpisode => Found TMDB episode ID ${tmdbEpisodeId} for ${episodeId}`);
            }

            // Try multiple methods to get release date
            const episodeReleased = await this.getEpisodeReleaseDate(
                episode,
                episodeId,
                episodePage,
                tmdbSeriesId,
                tmdbEpisodeId,
                parseInt(seasonId),
                episodeNo
            );

            // Fetch episode data (this has the media/CDN info)
            const episodeAjax = await fetchData(MAKO.URL_EPISODE(vcmid, channelId), true);

            if (!this.isValidJsonResponse(episodeAjax)) {
                logger.warn(`getEpisode => Invalid response for episode ${episodeId}`);
                return { status: "0" };
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
        // Sort videos by released date (newest first) for news/current affairs shows
        const sortedVideos = videos.sort((a, b) => {
            if (!a.released) return 1;
            if (!b.released) return -1;
            return new Date(b.released) - new Date(a.released);
        });

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
                videos: sortedVideos
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

    /**
     * Derive correct season year from actual episode release dates
     * Mako sometimes labels seasons incorrectly (e.g., "2026" for episodes airing in 2025)
     * This method uses the actual release dates to determine the correct season year
     * @param {Array} videos - Array of video objects with release dates
     * @param {string} fallbackSeason - Season ID to use if no dates available
     * @returns {string} Corrected season ID (year)
     */
    deriveSeasonFromDates(videos, fallbackSeason) {
        const years = [];

        for (const video of videos) {
            if (video.released) {
                const date = new Date(video.released);
                if (!isNaN(date.getTime())) {
                    const year = date.getFullYear();
                    years.push(year);
                }
            }
        }

        if (years.length === 0) {
            logger.warn(`deriveSeasonFromDates => No valid release dates found, using fallback: ${fallbackSeason}`);
            return fallbackSeason;
        }

        // Use the most common year (mode) to handle cases where episodes span Dec/Jan
        const yearCounts = {};
        let maxCount = 0;
        let mostCommonYear = parseInt(fallbackSeason) || new Date().getFullYear();

        for (const year of years) {
            yearCounts[year] = (yearCounts[year] || 0) + 1;
            if (yearCounts[year] > maxCount) {
                maxCount = yearCounts[year];
                mostCommonYear = year;
            }
        }

        logger.debug(`deriveSeasonFromDates => Derived year ${mostCommonYear} from ${years.length} episodes (years: ${[...new Set(years)].join(', ')})`);
        return mostCommonYear.toString();
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

    async updateDatabase(makoJSONObj) {
        logger.trace("updateDatabase => Entered");
        logger.debug("updateDatabase => Starting bulk database update");

        try {
            const result = await updateDatabaseFromJSON('mako', makoJSONObj, logger);
            logger.info(`updateDatabase => ✅ Updated ${result.series} series, ${result.videos} videos, ${result.streams} streams in ${result.duration}s`);
        } catch (error) {
            logger.error(`updateDatabase => ❌ Failed to update database: ${error.message}`);
            throw error;
        }

        logger.trace("updateDatabase => Leaving");
    }

    writeJSON(makoJSONObj) {
        logger.trace("writeJSON => Entered");
        logger.debug(`writeJSON => Writing ${Object.keys(makoJSONObj).length} series to file`);
        utils.writeJSONToFile(makoJSONObj, "stremio-mako");
        logger.trace("writeJSON => Leaving");
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

module.exports = MakoScraper;

/*const constants = require("./constants.js");
const TmdbHelper = require("./TmdbHelper.js");
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
            logger.info(`Added: S${seasonId} E${noOfEpisodes} - ${episodeTitle}`);
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

            // Parse Israeli date format (DD.MM.YYYY or D.M.YYYY)
            episodeReleased = this.parseIsraeliDate(episodeReleased);
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
