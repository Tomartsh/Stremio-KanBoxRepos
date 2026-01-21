const utils = require("./utilities.js");
const {fetchData} = require("./utilities.js");
const {
    LOG4JS_LEVEL, 
    MAX_LOG_SIZE, 
    LOG_BACKUP_FILES,
    LOG_FILENAME,
    KAN_URL_ADDRESS,
    KAN_DIGITAL_IMAGE_PREFIX,
} = require("./constants.js");
const SUB_PREFIX = "dogital";
const SUBTYPE = "d";

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

const EXPORT_FILENAME = "stremio-kandigital";
var logger = log4js.getLogger("KanDigitalScraper");

class KanDigitalScraper {

    constructor() {
        this._kanDigitalJSONObj = {};
        this.seriesIdIterator = 1000;
        this.isRunning = false;
    }

    async crawl(isDoWriteFile = false){
        logger.info("Started Crawling");
        this.isRunning = true;
        await this.crawlVod();
        logger.info("Done Crawling");     

        if (isDoWriteFile){
            logger.info("crawl => writing JSON file");
            this.writeJSON();
        }
        this.isRunning = false;
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
                // Extract the JSON portion
                const jsonMatch = scriptContent.match(/digitalSeries:\s*(\[[\s\S]*?\])/);

                if (jsonMatch && jsonMatch[1]) {
                    let rawJsonString = jsonMatch[1].trim();
                
                    //Parse it
                    items = JSON.parse(rawJsonString);

                    logger.debug(`Success! Found ${items.length} Digital Series items.`);
                }
            } catch (error) {
                logger.error("Found the script, but failed to parse the JSON. It might not be strict JSON format.");
            }
        } else {
             logger.debug("Could not find a script containing 'digitalSeries: ['");
        }

        for (const item of items) { //iterate over series
            const title = item.ImageAlt; // Usually the show name
            const pageUrl = item.Url; //URL of the series episodes
            const description = item.Description;
            const season = item.Season;

            //set the series URL
            if (pageUrl == undefined) { return;} // if there is not link to the series then skip
            if (pageUrl.includes("kan-actual")){return;} //we are skipping news item
            if (pageUrl.includes("archive")){return;} //we are skipping archive item. Have a a separate scraper for those 
            if (pageUrl.includes("podcasts")){return;} //we are skipping podcasts, we will deal with them later
            if ((! pageUrl.includes("/content/kan/")) && (! pageUrl.includes("dig/digital"))) { return; }//if URL does not contain this strin git is not digital
            if (pageUrl.startsWith("/")) { pageUrl = KAN_URL_ADDRESS + pageUrl; }

            var id = utils.generateSeriesId(pageUrl, SUB_PREFIX);
            var imgUrl = KAN_DIGITAL_IMAGE_PREFIX + item.Image;

            //get the doc of the series
            try{
                var seriesPageDoc = await fetchData(`${pageUrl}?page=1&itemsToShow=1000`);
            } catch (e){
                logger.error(`crawlVod => could not retrieve series page doc from URL ${pageUrl}. Error: ${e}`);
                return;
            }

            //set series genres
            const genres = this.setGenre(seriesPageDoc.querySelector("div.info-genre"));

            //Get the seasons number
            var seasons = seriesPageDoc.querySelectorAll("div.seasons-item");
            var videoObj = [];
            if ((seasons != undefined) && (seasons.length> 0)){ //generate videos object with media links(streams)
                logger.debug("getSeries => seasons " + title + " length: " + seasons.length);
                videoObj = await this.getVideos(seasons, id);

                //this.addToJsonObject(id, title, pageUrl,imgUrl,description,genres,videoObj,"series")
            } else {
                // probably no episodes, only a single movie
                if (! seriesPageDoc.querySelector("a.btn.with-arrow")){
                    continue
                }
                var moveiLink = seriesPageDoc.querySelector("a.btn.with-arrow").getAttribute("href");
                videoObj = await this.getVideo(moveiLink, id);
            } 
            if ((videoObj == null) || (videoObj.length == 0)){
                logger.warn(`crawlVod => could not find videos for series ${title} @ URL ${pageUrl}`);
            } else {    
                 this.addToJsonObject(id, title, pageUrl, imgUrl,description,genres,videoObj,"series");   
            } 
        };

        //start working on each series
        //await this.getSeries();
        
        logger.trace("crawl() => Exiting");
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
            if (name && episodeLink) {
                const episodeId = `${id}:1:1`;
                
                videosList.push({
                    name: name,
                    episode: episodeId,
                    description: desc,
                    thumbnail: thumb,
                    episodeLink: url,
                    released: released,
                    streams: {
                        url: episodeLink,
                        type: "series",
                        name: name,
                        description: desc
                    }
                });
                logger.info(`getVideo => Successfully extracted VideoObject: ${name}`);
                return videosList;

            } else {
                logger.warn(`getVideo => Missing a required field for ${episodeLink}`);
                return videosList;
            }
                
        } catch (e) {
            logger.debug("getVideo => Error processing VideoObject: " + e);
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
        for (var i = 0 ; i < noOfSeasons; i++){//iterate over seasons
            var seasonNo = noOfSeasons - i;
            var seasonEpisodesElems = videosElems[i].querySelectorAll("a.card-link");
            
            for (var iter = 0; iter < seasonEpisodesElems.length; iter ++) {//iterate over episodes
                logger.trace("getVideos => season: " + seasonNo + " episode: " + (iter +1));
                var seasonEpisodesElem = seasonEpisodesElems[iter];
                var episodePageLink = seasonEpisodesElem.getAttribute("href");

                if (episodePageLink.contains("p-12385/s4")){//season 4 of this series yields no episode. Skipping.
                    return videosArr;
                }
                if (episodePageLink.startsWith("/")){
                    episodePageLink = KAN_DIGITAL_IMAGE_PREFIX;
                }
                var title = "";
                if (seasonEpisodesElem.querySelector("div.card-title")) {
                    title = seasonEpisodesElem.querySelector("div.card-title").text.trim();
                } else {
                    title = seasonEpisodesElem.attrs("title");
                }
                var description = "";
                if (seasonEpisodesElem.querySelector("div.card-text") != undefined) {
                    description = seasonEpisodesElem.querySelector("div.card-text").text.trim();
                }
                var  videoId = id + ":" + seasonNo + ":" + (iter + 1);

                var episodeLogoUrl = "";
                if (seasonEpisodesElem.querySelector("div.card-img")){
                    var elemImage = seasonEpisodesElem.querySelector("div.card-img");
                    try {
                        if ((elemImage != null) && (elemImage.querySelector("img.img-full") != null)) {
                            var elemEpisodeLogo = elemImage.querySelector("img.img-full");
                            
                            if (elemEpisodeLogo != null) {
                                episodeLogoUrl = utils.getImageFromUrl(elemEpisodeLogo.attrs["src"],SUBTYPE);
                            }
                            logger.trace("getVideos => episodeLogoUrl location: " + episodeLogoUrl);                          
                        }
                    } catch(ex) {
                        logger.error("getVideos => episodeLogoUrl:" + ex);                       
                    }
                }
                logger.trace ("getVideos => episodeLogoUrl: " + episodeLogoUrl + " Name: " + title); 


                //get streams
                var streams = await this.getStreams(episodePageLink);

                //check streams is not empty, and if so, remove from list
                if (streams ){
                    var episodeNo = iter +1;
                    /*var streamsArr = [
                        {
                            url: streams.url,
                            type: streams.type,
                            name: streams.name,
                            description: streams.description
                            released: 
                        }
                    ];*/
                    videosArr.push ({
                        id: videoId,
                        name: title,
                        season: seasonNo,
                        episode: episodeNo ,
                        description: description,
                        thumbnail: episodeLogoUrl,
                        episodeLink: episodePageLink,
                        released: streams.released,
                        streams: [streams]
                    });
                    //this.addVideoToMeta(id, videoId, title, seasonNo, episodeNo, description, episodeLogoUrl, episodePageLink, streams.released, streamsArr);
                    logger.debug(`getVideos => processed episode : ${title}\n    season:${seasonNo}, episode: ${iter +1}`);
                } else {
                    logger.warn(`getVideos => Episode has no media : ${title}\n    season: ${seasonNo}, episode: ${iter +1}`);
                }
            }
        } 
        return videosArr;     
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
        var descVideo = "";

        if (doc.querySelector("li.date-local") != undefined){
            const date = new Date(doc.querySelector("li.date-local").getAttribute("data-date-utc"));
            released = isNaN(date.getTime()) ? "" : date.toISOString();
            //released = utils.getReleaseDate(doc.querySelector("li.date-local").getAttribute("data-date-utc"));
        } 
        var scriptElems = doc.querySelectorAll("script");
        
        for (var scriptElem of scriptElems){         
            if (scriptElem.toString().includes("VideoObject")) {
                videoUrl = this.getEpisodeUrl(scriptElem.toString());
                break;
            }
        }
        
        if (doc.querySelectorAll("div.info-title h1.h2").length > 0){
            nameVideo = doc.querySelectorAll("div.info-title h1.h2")[0].text.trim();
            nameVideo = this.getVideoNameFromEpisodePage(nameVideo);
        } else if (doc.querySelector("title")) {
            nameVideo = doc.querySelector("title").text.trim();
            nameVideo = this.getVideoNameFromEpisodePage(nameVideo);
        }

        if (doc.querySelector("div.info-description") != null){
            descVideo = doc.querySelector("div.info-description").text.trim();
        }

        var streamsJSONObj = {
            url: videoUrl,
            type: "series",
            name: nameVideo,
            description: descVideo,
            released: released
        };

        //if (released != "") {streamsJSONObj["released"] = released;}
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
        
        this._kanDigitalJSONObj[key]["meta"]["videos"].push(video);

    }

    addToJsonObject(id, seriesTitle, seriesPage, imgUrl, seriesDescription, genres, videosList, type){
        this._kanDigitalJSONObj[id] =  {
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
                posterShape: "poster",
                logo: imgUrl,
                description: seriesDescription,
                genres: genres,
                videos: videosList
            }
        }
        logger.info(`addToJsonObject => Added  series, ID: ${id} Name: ${seriesTitle} Link: ${seriesPage}`);
    }

    writeJSON(){
        logger.trace("writeJSON => Entered");
        logger.debug("writeJSON => All tasks completed - writing file");
        utils.writeJSONToFile(this._kanDigitalJSONObj, EXPORT_FILENAME);

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