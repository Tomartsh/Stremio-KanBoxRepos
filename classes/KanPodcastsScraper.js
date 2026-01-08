const utils = require("./utilities.js");
const {fetchData} = require("./utilities.js");
const {
    LOG4JS_LEVEL, 
    MAX_LOG_SIZE, 
    LOG_BACKUP_FILES,
    LOG_FILENAME,
    KAN_PARTNER_ID,
    KAN_MOBILE_API,
    KAN_PODCAST_CATEGORIES,
    KAN_BASE_URL
} = require("./constants.js");
const SUB_PREFIX = "podcasts";

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

    /***************************************************************************************************************
     * 
     * Podcasts Section
     *
    ***************************************************************************************************************/   

    async crawlPodcasts(){
        logger.trace("crawlPods => Entering");
        //get the podcasts series genre list
        // get the JSON from the site contaitning all the series.
        //var seriesJson = [];
        //var doc = await fetchData(PODCASTS_URL);

        //if (!doc) {
        //    logger.error("crawlVod => Could not retrieve data from Kan Podcasts. Skipping this crawl.");
        //    return; // Nothing to see here, go back to the beggining
        //}

        // get all script elements
        //var scriptElems = doc.querySelectorAll('script');
        
        //Initialize items as an empty array at the function level scope
        //let items = [];
        
        //const podcasts = [];
        let fromIndex = 1;      // Kan API is 1-indexed
        const pageSize = 200;   // Number of items per request
        let hasMore = true; 
        let totalCount = 0;

        while (hasMore) {
            // The endpoint identified in kan.py for podcast categories is 4451
            const url = `${KAN_MOBILE_API}${fromIndex}&id=${KAN_PODCAST_CATEGORIES}`;
            
            try {
                const data = await fetchData(url,true);
                const entries = data.entry || [];
                
                if (entries.length === 0) {
                    hasMore = false;
                    break;
                }

                for (const entry of entries) {
                    totalCount++;
                    logger.debug(`[${totalCount}] Title: ${entry.title}`);
                    
                    let entryID = entry.id;
                    let id = utils.generateSeriesId("", SUB_PREFIX, entry.id);
                    let title = entry.title;
                    let description = entry.description;
                    let pageUrl = entry.link?.href?.replace('?app=true', '') || '';

                    //exclude Kan 88 podcasts
                    if (pageUrl.includes("kan88")){continue; }

                    const headers = {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
                        'Accept': 'application/json'
                    };

                    const params = {
                        id: entryID,
                        type: 'program', // זה מה שגורם לשרת להחזיר פרקים
                        num: 100         // כמות פרקים מקסימלית
                    };

                    logger.debug(`URL is: ${pageUrl}`);
                    const response = await fetchData('https://mobapi.kan.org.il/api/mobile/subClass', true, params, headers);
                    const data = response.data;
                    logger.debug(`Data is: ${data}`);
                    if (data && data.entry) {
                        for (const episode of data.entry){
                            logger.debug ("Episode title: " + episode.title);
                        }
                    }
                }
            } catch (error) {
                logger.error("Failed to fetch podcasts:", error);
                 hasMore = false;
                }       
        } 
                        /*
                        allResults[cleanId] = data.entry.map(item => ({
                            title: item.title,
                            summary: item.summary,
                            // חילוץ הלינק ל-MP3 מתוך אובייקט הקישור או התוכן
                            mp3Url: item.content ? item.content.src : (item.link ? item.link.href : null),
                            date: item.updated, // תאריך עדכון הפרק
                            image: item.media_group?.[0]?.media_item?.[0]?.src || ""
                        })).filter(ep => ep.mp3Url && ep.mp3Url.includes('.mp3')); // סינון רק לפרקים עם לינק תקין
                    }
*/
/*
                    const episodesApiUrl = `https://mobapi.kan.org.il/api/v1/podcasts/${entryID}/episodes?partnerId=${KAN_PARTNER_ID}&from=1&size=200`;




                    const episodesUrl = `https://mobapi.kan.org.il/api/v1/programs/${entryID}/episodes`;
                    const episodes = await fetchData(episodesUrl,true, headers);

                    if (data && data.episodes) {
                        for (const episode of data.episodes) {
                            /*ep.title,
                            description: ep.description || '',
                            url: ep.externalUrl, // זהו הקישור הישיר ל-MP3
                            released: new Date(ep.publishDate).toISOString(),
                            id: `kan_ep_${ep.id}`
                            logger.debug(`episode title: ${episode.title}`)
                        }

                    }
                    let podcastImageUrl = '';
                    const mediaItems = entry.media_group?.[0]?.media_item || [];
                    
                    // We look specifically for the item with the key 'image_base_1x1'
                    const targetImage = mediaItems.find(item => item.key === 'image_base_1x1');
                    
                    if (targetImage && targetImage.src) {
                        podcastImageUrl = targetImage.src;
                    }
                    logger.debug(`id: ${id} \n title: ${title} \n pageUrl: ${pageUrl} \n podcastImageUrl: ${podcastImageUrl} \n description: ${description} \n episodesApiUrl: ${episodesApiUrl}`);
                    this.addToJsonObject(id,title,pageUrl,podcastImageUrl,description,"",[],"p","series");
                }
               
                // Pagination Logic:
            // If we received exactly 200 entries, there's likely a next "page".
            // We increment the index by 200 to get the next batch (1 -> 201 -> 401).
            if (entries.length === pageSize) {
                fromIndex += pageSize; 
            } else {
                // Received fewer than 200, so this is the last batch.
                hasMore = false;
            }
            } catch (error) {
               logger.error("Failed to fetch podcasts:", error);
                hasMore = false;
            }
        }
*/
/*
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

        items.forEach((item) => {
            // Extract specific data
            const title = item.ImageAlt; // Usually the show name
            //const fullImageUrl = `https://www.kan.org.il${item.Image}`;
            const pageUrl = item.Url;
            const description = item.Description;
            const season = item.Season;
            const genresName = item.Genres;

            //set the series URL
            if (pageUrl == undefined) { return;} // if there is not link to the series then skip
            if (pageUrl.includes("kan-actual")){return;} //we are skipping news item
            if (pageUrl.includes("archive")){return;} //we are skipping archive item. Have a a separate scraper for those 
            if (pageUrl.includes("podcasts")){return;} //we are skipping podcasts, we will deal with them later
            if ((! pageUrl.includes("/content/kan/")) && (! pageUrl.includes("dig/digital"))) { return; }//if URL does not contain this strin git is not digital
            if (pageUrl.startsWith("/")) { pageUrl = KAN_URL_ADDRESS + pageUrl; }

            var id = utils.generateSeriesId(pageUrl, SUB_PREFIX);
            var podcastImageUrl = KAN_DIGITAL_IMAGE_PREFIX + item.Image;

            this.addToJsonObject(id,title,pageUrl,podcastImageUrl,description,genresName,[],"p","series");
            
        });
        
        var docPodcastSeries = await fetchData(PODCASTS_URL);
        var genres = docPodcastSeries.querySelectorAll("div.podcast-row");
        logger.trace("crawlPods => Found " + genres.length + " genres");
        
        //go over the genres and add podcast series by genre
        for (var genre of genres) { //iterate over podcasts rows by genre
            var genresName = genre.querySelector("h4.title-elem.category-name").text.trim();
            logger.debug("crawlPodcasts => Genre " + genresName);
            
            var podcastsSeriesElements = genre.querySelectorAll("a.podcast-item");

            for (var podcastElement of podcastsSeriesElements){// iterate of the podcast series
                var podcastSeriesLink = this.getPodcastLink(podcastElement);
                if (podcastSeriesLink.includes("kan88")){continue; }
                
                //set ID
                var id = utils.generateSeriesId(podcastSeriesLink, SUB_PREFIX);

                //set title;
                var seriesTitle = this.getPodcastTitle(podcastElement,"");

                //set thumbnail image
                var podcastImageUrl = "";

                if (podcastElement.querySelector("img.img-full") != null){
                    podcastImageUrl = utils.getImageFromUrl(podcastElement.querySelector("img.img-full").getAttribute("src"),"p");
                }
                
                logger.debug("crawlPodcasts => podcastImageUrl: " + podcastImageUrl + " Name: " + seriesTitle);

                //set description
                var seriesDescription = "";
                if (podcastElement.querySelector("div.overlay div.text") != undefined){
                    seriesDescription = podcastElement.querySelector("div.overlay div.text").text.trim();
                } else {
                    seriesDescription = podcastElement.querySelector("div.description").text.trim(); //Kan 88 Podcast episodes
                }
                
                this.addToJsonObject(id,seriesTitle,podcastSeriesLink,podcastImageUrl,seriesDescription,genresName,[],"p","series");     
                await this.getpodcastEpisodeVideos(podcastSeriesLink, id);
                logger.debug("crawlPodcasts => Added podcast " + seriesTitle);
            }    
        }
*/
        logger.trace("crawlPodcasts => Exiting");
    }   

    getPodcastSeriesFromEntry(){

    }
    getPodcastTitle(podcastElement, seriesTempTitle){
        var seriesTitle = ""
        if (podcastElement.getAttribute("title") != undefined){ 
            seriesTitle = podcastElement.getAttribute("title").trim();
        } else { //Kan 88 Podcast episodes
            seriesTitle = seriesTempTitle;
        }

        seriesTitle = seriesTitle.replace("כאן 88 הסכתים - ","");
        seriesTitle = seriesTitle.replace(".כאן 88","");

        return seriesTitle;
    }
    
    getPodcastLink(podcastElement){
        var podcastSeriesLink = "";
        if (podcastElement.getAttribute("href") != null){
            podcastSeriesLink = podcastElement.getAttribute("href");
        } else{
            var podcastAnchorElem = podcastElement.querySelector("a");
            podcastSeriesLink = podcastAnchorElem.getAttribute("href");
        }
        return podcastSeriesLink;
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
        /*try {
            lastPageNo = podcastSeriesPageDoc.querySelector('li[class*="pagination-page__item"][title*="Last page"]').getAttribute('data-num');
        }catch{
            if (podcastSeriesPageDoc.querySelector('li[class*="pagination-page__item"]') == null){

                logger.debug("getpodcastEpisodeVideos => URL: " + podcastSeriesLink + " has only 1 page (exception)");
            }
            //lastPageNo = String(podcastSeriesPageDoc.querySelectorAll('li[class*="pagination-page__item"]').length);
            //if(lastPageNo==='0'){return {}; }
            lastPageNo = 1;
            logger.trace("getpodcastEpisodeVideos => URL: " + podcastSeriesLink + " has only 1 page");
        }*/
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
            streamElement.querySelector("div.item-content.hide-content").text.trim();
        }else {
            logger.trace("getPodcastStreams => No description for the episode !");
        }
        var urlRawElem = streamElement.querySelector("figure");
        var urlRaw
        if (urlRawElem != undefined ){
            urlRaw = urlRawElem.getAttribute("data-player-src");
            urlRaw = urlRaw.trim();
        } 
        if ((urlRaw == undefined) ||(urlRaw.length == 0)){
            return streams;
        }
        var url = urlRaw.substring(0,urlRaw.indexOf("?"));
        logger.trace("getPodcastStreams => Podcast stream name: " + episodeName + " description: " + description);
        
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

    setDescription(seriesElems){
        var description = "";
        if (seriesElems.length < 1) {return description;}
        description = seriesElems.text.trim() +".\n";

        return description;
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

        this._kanPodcastsJSONObj[key]["meta"]["videos"].push(video);

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