
const { parse } = require('node-html-parser');
const path = require("path");
const axios = require('axios');
const { gotScraping } = require('got-scraping');
const AdmZip = require("adm-zip");
const fs = require('fs');

const {PREFIX } = require ("./constants");

let seriesIterator = 1000;

const log4js = require("log4js");
const {
    MAX_RETRIES, 
    REQUEST_TIMEOUT,
    HEADERS, 
    MAX_CONCURRENT_REQUESTS, 
    RETRY_DELAY, 
    LOG4JS_LEVEL,
    MAX_LOG_SIZE, 
    LOG_BACKUP_FILES,
    SAVE_MODE,
    SAVE_FOLDER 
} = require ("./constants");

log4js.configure({
    appenders: { 
        out: { type: "stdout" },
        Stremio: 
        { 
            type: "file", 
            filename: "logs/Stremio_addon.log", 
            maxLogSize: MAX_LOG_SIZE, 
            backups: LOG_BACKUP_FILES
        }
    },
    categories: { default: { appenders: ['Stremio','out'], level: LOG4JS_LEVEL } },
});

var logger = log4js.getLogger("utillities");

class Throttler {
    constructor(limit) {
        this.limit = limit;
        this.activeRequests = 0;
        this.queue = [];
    }

    async schedule(task) {
        return new Promise((resolve, reject) => {
            const executeTask = async () => {
                if (this.activeRequests >= this.limit) {
                    this.queue.push(executeTask);
                    return;
                }

                this.activeRequests++;
                try {
                    logger.trace("Throttler-schedule => running task");
                    const result = await task();
                    resolve(result);
                } catch (error) {
                    reject(error);
                } finally {
                    this.activeRequests--;
                    if (this.queue.length > 0) {
                        logger.trace("Throttler-schedule => Moving next in queue");
                        const nextTask = this.queue.shift();
                        nextTask();
                        logger.debug("Throttler-schedule => waiting in queue: " + this.queue.length);
                    }
                }
            };

            executeTask();
        });
    }
}

const throttler = new Throttler(MAX_CONCURRENT_REQUESTS);

// --- Persistent State Tracker ---
// This keeps track of which method works for which domain
const stickyMethods = new Map(); 

// --- Core Request Logic ---

/**
 * Main Fetcher: Determines which method to use and handles retries
 */

async function fetchWithRetries(url, asJson = false, params = {}, headers) {
    logger.trace("fetchWithRetries => Entering");
    logger.trace(`URL: ${url} \n    asJson: ${asJson} \n    Params: ${params}: \n   headers: ${headers}`);
    
    let hostname;
    try {
        hostname = new URL(url).hostname;
    } catch (e) {
        logger.error(`Invalid URL provided: ${url}`);
        return null;
    }

    return throttler.schedule(async () => {
        let currentMethod = stickyMethods.get(hostname) || 'axios';

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                logger.debug(`fetchWithRetries => [${currentMethod.toUpperCase()}] ->  ${url} try no. ${attempt}`);
                const data = await executeRequest(currentMethod, url, asJson, params, headers);
                // Success! Stick this method to the domain
                if (stickyMethods.get(hostname) !== currentMethod) {
                    logger.info(`Method "${currentMethod}" is now STICKY for ${hostname}`);
                    stickyMethods.set(hostname, currentMethod);
                }
                
                return data;

            } catch (error) {
                const status = error.response?.status || error.statusCode;
                logger.warn(`${currentMethod} failed (Status: ${status || 'Timeout'}): ${error.message}`);
                
                // If we get a 403 or 401, immediately rotate to a more powerful tool
                if (status === 403 || status === 401 || error.message.includes('timeout')) {
                    logger.warn(`Connection issue with ${currentMethod}. Switching to got-scraping...`);
                    currentMethod = 'got-scraping'; 
                    // Clear sticky so we don't keep trying a failing method
                    stickyMethods.delete(hostname);
                }

                if (attempt === MAX_RETRIES) {
                    logger.error(`Max retries reached for ${url}`);
                    throw error;

                }

                const delay = RETRY_DELAY * Math.pow(2, attempt - 1);
                logger.debug(`Waiting ${delay}ms before next attempt...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }

    });
}


/**
 * Entry Point: Your original fetchData wrapper
 */
async function fetchData(url, asJson = false, params = {}, headers = HEADERS) {
    try {
        logger.debug(`fetchData => For URL: ${url}`);
        // We pass the URL through to the retry logic
        return await fetchWithRetries(url, asJson, params, headers);
    } catch (error) {
        logger.error(`fetchData => Failed to fetch URL ${url} :`, error.message);
        return null; 
    }
}

/**
 * Library Selector: Executes the actual request
 */
async function executeRequest(method, url, asJson, params, headers) {
    switch (method) {
        case 'axios':
            const axRes = await axios.get(url, { 
                timeout: REQUEST_TIMEOUT, headers, params, 
                responseType: asJson ? 'json' : 'text' 
            });
            return asJson ? axRes.data : parse(axRes.data.toString());

        case 'got-scraping':
            const gotRes = await gotScraping({
                url, 
                headers, 
                searchParams: params,
                responseType: asJson ? 'json' : 'text',
                timeout: { request: REQUEST_TIMEOUT },
                headerGeneratorOptions: { 
                    browsers: [{ name: 'chrome' }, { name: 'firefox' }],
                    devices: ['desktop'] ,
                    strategies: ['mobile', 'desktop']
                }
            });
            return asJson ? gotRes.body : parse(gotRes.body.toString());

        default:
            throw new Error(`Unknown method: ${method}`);
    }
}

function getNextMethod(current) {
    return current === 'axios' ? 'got-scraping' : 'got-scraping';
}


//+===================================================================================
//
//  Utility functions
//+===================================================================================
function padWithLeadingZeros(num, totalLength) {
    return String(num).padStart(totalLength, '0');
}

async function writeJSONToFile(jsonObj, fileName){
    logger.debug("writeJSONToFile => Entering");
    //if (jsonObj == undefined){ return;}
    if (!jsonObj){ return;}

    var dateStr = getCurrentDateStr();
    dateStr = dateStr.split(":").join("_");

    const zip = new AdmZip()

    logger.debug("writeJSONToFile => handling repository files");
    const OUTPUT_DIR = path.join(__dirname, `../${SAVE_FOLDER}`); // Ensure correct relative path

    // Ensure output directory exists inside the function
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const jsonContent = JSON.stringify(jsonObj, null, 4);
    const jsonFileName = `${fileName}.json`;
    const zipFileName = `${fileName}.zip`;

    zip.addFile(jsonFileName, Buffer.from(jsonContent, "utf8"));

    if (SAVE_MODE === "local" || SAVE_MODE === "both") {
        fs.writeFileSync(jsonFilePath, jsonContent);
        
        // Use writeZip() which handles the buffer internally for local saving
        zip.writeZip(zipFilePath); 
        logger.debug(`writeJSONToFile => Saved locally .zip file: ${zipFileName}`);
    }

    if (SAVE_MODE === "github" || SAVE_MODE === "both") {
        // 3. Convert the populated zip object to a Buffer
        const zipBuffer = zip.toBuffer(); 
        logger.debug(`ZIP Buffer size: ${zipBuffer.length} bytes`); // Log this to verify!

        await uploadToGitHub(zipBuffer, zipFileName, `Adding ${zipFileName} ${dateStr}`);
    }

    const jsonFilePath = path.join(OUTPUT_DIR, jsonFileName);
    const zipFilePath = path.join(OUTPUT_DIR, zipFileName);

    logger.debug("writeJSONToFile => Exiting");
}

async function uploadToGitHub(fileContent, fileName, commitMessage, forceLarge = false) {
    logger.trace("uploadToGitHub => Entering");
    
    //Check the environemtn variables are in place
    const requiredEnv = ['REPO_TOKEN_SECRET', 'BRANCH_SECRET', 'REPO_OWNER_SECRET', 'REPO_NAME_SECRET'];
    requiredEnv.forEach(env => {
        if (!process.env[env]) logger.warn(`⚠️ Missing ${env} in env`);
    });
    
    const bufferContent = Buffer.isBuffer(fileContent)
        ? fileContent
        : Buffer.from(fileContent, "utf8");
    const fileSize = bufferContent.length;

    // Decide API based on file size or forced large flag
    const useReleasesAPI = forceLarge || fileSize >= 1000000;

    const GITHUB_API_URL = 'https://api.github.com';
    const githubFilePath = `${SAVE_FOLDER}/${fileName}`;
      
    const axiosConfig = {
        headers: {
            Authorization: `Bearer ${process.env.REPO_TOKEN_SECRET}`,
            "User-Agent": "Node.js",
            Accept: "application/vnd.github.v3+json"
        }
    };

    try {
        
        if (!useReleasesAPI) {
            // === Small file: /contents API ===
            let retryCount = 0;
            const maxRetries = 3;
            let success = false;
            
            while (retryCount < maxRetries && !success) {
                let sha = null;
                // Fetch latest SHA every attempt to avoid 409
                try {
                    const res = await axios.get(`${GITHUB_API_URL}/repos/${process.env.REPO_OWNER_SECRET}/${process.env.REPO_NAME_SECRET}/contents/${githubFilePath}`, axiosConfig);
                    sha = res.data.sha;
                } catch (err) {
                    if (!(err.response && err.response.status === 404)) throw err;
                }
                try {
                    const payload = {
                        message: commitMessage,
                        content: bufferContent.toString("base64"),
                        branch: process.env.BRANCH_SECRET,
                        ...(sha ? { sha } : {}),
                    };

                    const putRes = await axios.put(`${GITHUB_API_URL}/repos/${process.env.REPO_OWNER_SECRET}/${process.env.REPO_NAME_SECRET}/contents/${githubFilePath}`, payload, axiosConfig);
                    
                    logger.info(`uploadToGitHub => Uploaded: ${githubFilePath} → ${putRes.data.content.html_url}`);
                    success = true; // Break the loop
                } catch (putError) {
                    if (putError.response && putError.response.status === 409) {
                        retryCount++;
                        logger.warn(`uploadToGitHub => 409 Conflict. Retrying (${retryCount}/${maxRetries})...`);
                        // Wait a moment before retrying to allow GitHub DB to sync
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    } else {
                        throw putError; // Non-409 errors should stop immediately
                    }
                }
            
            }
            if (!success) throw new Error("Failed to upload after maximum retries due to 409 conflicts.");

        } else {
            // === Large file: Releases API ===
            logger.info(`uploadToGitHub => Large file, using Releases API: ${fileName}`);
            
            const repoPath = `${process.env.REPO_OWNER_SECRET}/${process.env.REPO_NAME_SECRET}`;
            const releasesUrl = `${GITHUB_API_URL}/repos/${process.env.REPO_OWNER_SECRET}/${process.env.REPO_NAME_SECRET}/releases`;
            const releaseName = "auto-upload";
            let release = null;

            // Find or create the release
            try {
                const releases = await axios.get(releasesUrl, axiosConfig);
                release = releases.data.find(r => r.name === releaseName);
            } catch (e) { 
                logger.warn("uploadToGitHub => Could not fetch releases:", e.message); 
            }

            if (!release) {
                logger.info("uploadToGitHub => Creating new release: " + releaseName);
                const res = await axios.post(releasesUrl, {
                    tag_name: "auto-upload",
                    name: releaseName,
                    body: "Automatically uploaded large files",
                }, axiosConfig);
                release = res.data;
            }

            // CHECK FOR EXISTING ASSET (The fix for your error)
            // We fetch the list of files already attached to this release
            const assetsUrl = `${GITHUB_API_URL}/repos/${repoPath}/releases/${release.id}/assets`;
            const assetsResponse = await axios.get(assetsUrl, axiosConfig);
            const existingAsset = assetsResponse.data.find(a => a.name === fileName);

            if (existingAsset) {
                logger.debug(`uploadToGitHub => Asset "${fileName}" already exists. Deleting asset ID: ${existingAsset.id} before re-upload.`);
                const deleteUrl = `${GITHUB_API_URL}/repos/${repoPath}/releases/assets/${existingAsset.id}`;
                await axios.delete(deleteUrl, axiosConfig);
            }

            // Upload the new file
            // Note: Uploads use 'uploads.github.com' instead of 'api.github.com'
            const uploadUrl = `https://uploads.github.com/repos/${repoPath}/releases/${release.id}/assets?name=${encodeURIComponent(fileName)}`;
            
            const res = await axios.post(uploadUrl, bufferContent, {
                headers: {
                    ...axiosConfig.headers,
                    "Content-Type": fileName.endsWith(".zip") ? "application/zip" : "application/json",
                    "Content-Length": fileSize,
                },
                timeout: 120000, // 2 minutes for large uploads
            });

            logger.info(`uploadToGitHub => Uploaded large file to release: ${res.data.browser_download_url}`);
        }   

    } catch (error) {
        logger.error("uploadToGitHub => Error uploading file:", error.response ? error.response.data : error.message);
    }

    logger.trace("uploadToGitHub => Exiting");
}

function getReleaseDate(str){
    var released = "";
    var releasedArr = [];
    var year = "";
    var month = "";
    var day = "";

    if (str.length > 0) {
        //check existing format
        const regexReshet = /^(\d{2})\/(\d{2})\/(\d{4})/;
        const regexKanPodcasts = /^(\d{1,2})\.(\d{1,2})\.(\d{4}) (\d{1,2}):(\d{1,2}):(\d{2})/;
        const regexMako = /^(\d{2})\.(\d{2})\.(\d{2})/;
        
        var processed = false;
        
        if ((regexReshet.test(str)) && (!processed)) {//example 03/06/2024
            releasedArr = str.split("/"); 
            year = releasedArr[2];
            month = releasedArr[1];
            day = releasedArr[0];
            processed = true;
        }

        if ((regexKanPodcasts.test(str)) && (!processed)) {
            releasedArr = str.split(".");
            year = releasedArr[2].split(" ")[0];
            month = releasedArr[1];
            day = releasedArr[0];

            if (month.length == 1){ 
                month = "0" + month;
            }
            if (day.length == 1){ day = "0" + day;}
            processed = true;
        } 
        
        if ((regexMako.test(str))  && (!processed)){
            releasedArr = str.split(".");
            year = releasedArr[2];
            month = releasedArr[1];
            day = releasedArr[0];
            processed = true;
        }

        if (processed){
            released = year + "-" + month + "-" + day + "T00:00:00.000Z";
        }else {
            released = "";
        }

        return released;
        
    }
    return str;
}

function getCurrentDateStr(){
    var currDate = new Date();
    var dateStr = currDate.getDate() + "-" + (currDate.getMonth() + 1).toString().padStart(2,'0') + "-" + currDate.getFullYear() + "_" + currDate.getHours() + ":" + currDate.getMinutes() + ":" + currDate.getSeconds();
    return dateStr;
}

function getImageFromUrl(url, subType){
    var retVal = url;
    if (retVal.includes("?")){
        retVal = retVal.substring(0,retVal.indexOf("?"));
    }
    if (retVal.startsWith("/")){
        if (subType == "d") {
            retVal = "https://www.kan.org.il" + retVal;
        } else if (subType == "k"){
            retVal = "https://www.kankids.org.il" + retVal;
        } else if (subType == "n"){
            retVal = "https://www.kankids.org.il" + retVal;
        } else if (subType == "a"){
            retVal = "https://www.kan.org.il" + retVal;
        } else if (subType == "p"){
            retVal = "https://www.kan.org.il" + retVal;
        } 
    }
    return retVal;
}

/**
 * Get the series genre
 * @param {*} str 
 * @returns array of genres of series
 */
function setGenreFromString(str) {
    if (str == "") { return "Kan";}
    
    var genres = [];
    //for (var check of genresArr){
    for (var check of str){
        check = check.trim();

        switch(check) {
            case "דרמה":
                genres.push("Drama");
                genres.push("דרמה");
                break;
            case "מתח":
                genres.push("Thriller");
                genres.push("מתח");
                break;
            case "פעולה":
                genres.push("Action");
                genres.push("פעולה");
                break;
            case "אימה":
                genres.push("Horror");
                genres.push("אימה");
                break;
            case "דוקו":
                genres.push("Documentary");
                genres.push("דוקו");
                break;
            case "אקטואליה":
                genres.push("Documentary");
                genres.push("אקטואליה");
                break;
            case "ארכיון":
                genres.push("Archive");
                genres.push("ארכיון");
                break;
            case "תרבות":
                genres.push("Culture");
                genres.push("תרבות");
                break;
            case "היסטוריה":
                genres.push("History");
                genres.push("היסטוריה");
                break;
            case "מוזיקה":
                genres.push("Music");
                genres.push("מוזיקה");
                break;
            case "תעודה":
                genres.push("Documentary");
                break;
            case "ספורט":
                genres.push("Sport");
                genres.push("ספורט");
                break;
            case "קומדיה":
                genres.push("Comedy");
                genres.push("קומדיה");
                break;
            case "ילדים":
                genres.push("Kids");
                genres.push("ילדים");
                break;
            case "ילדים ונוער":
                if (! genres.includes("Kids")) { genres.push("Kids"); }
                if (! genres.includes("ילדים ונוער")) { genres.push("ילדים ונוער"); }
                break;
            case "בישול":
                genres.push("Cooking");
                genres.push("בישול");
                break;
            case "קומדיה וסאטירה":
                if (! genres.includes("Comedy")) { genres.push("Comedy"); }
                if (! genres.includes("קומדיה וסאטירה")) { genres.push("קומדיה וסאטירה"); }
                break;
            case "אנימציה":
                if (! genres.includes("Animation")) { genres.push("Animation"); }
                if (! genres.includes("אנימציה")) { genres.push("אנימציה"); }
                break;
            case "מצוירים":
                if (! genres.includes("Animation")) { genres.push("Animation"); }
                if (! genres.includes("מצוירים")) { genres.push("מצוירים"); }
                genres.push("Animation");
                break;
            case "קטנטנים":
                if (! genres.includes("Kids")) { genres.push("Kids"); }
                if (! genres.includes("קטנטנים")) { genres.push("קטנטנים"); }
                break;      
            default:
                if (! genres.includes("Kan")) {
                    genres.push("Kan");
                    genres.push("כאן");
                }
                break;
        } 
    }
   return genres;
}

function getNameFromSeriesPage(name){
    if (name != "") {
        name = name.replace("כאן חינוכית | ","").trim();
        
        if (name.indexOf (" - פרקים מלאים לצפייה ישירה") > 0){
            name = name.substring(0,name.indexOf("-") - 1).trim();
        }
        if (name.indexOf (" - פרקים לצפייה ישירה") > 0){
            name = name.substring(0,name.indexOf("-") - 1).trim();
        }
        if (name.indexOf (" - פרקים מלאים") > 0){
            name = name.substring(0,name.indexOf("-") - 1).trim();
        }
        if (name.indexOf ("- לצפייה ישירה") > 0){
            name = name.substring(0,name.indexOf("-")).trim();
        }
        if (name.indexOf (" - סרט דוקו לצפייה") > 0){
            name = name.substring(0,name.indexOf("-") - 1).trim();
        }
        if (name.indexOf (" - הסרט המלא לצפייה ישיר") > 0){
            name = name.substring(0,name.indexOf("-") - 1).trim();
        }
        if (name.indexOf (" - תכניות מלאות לצפייה ישירה") > 0){
            name = name.substring(0,name.indexOf("-") - 1).trim();
        }
        if (name.indexOf ("- סרטונים מלאים לצפייה ישירה") > 0){
            name = name.substring(0,name.indexOf("-") - 1).trim();
        }

        if (name.indexOf ("239 360") > 0){
            name = name.replace("Poster 239 360","");
        }
        if (name.includes("Image Small 239X360")){
            name = name.replace("Image Small 239X360","");
        }
        if (name.includes("פוסטר קטן")){
            name = name.replace("פוסטר קטן","");
        }
        if (name.includes("Poster")){
            name = name.replace("Poster","");
        }
        if (name.includes("Title Logo")){
            name = name.replace("Title Logo","");
        }
        if (name.includes("1920X1080")){
            name = name.replace("1920X1080","");
        }
        if (name.startsWith("לוגו")){
            name = name.replace("לוגו","");
        }
        if (name.endsWith("לוגו")){
            name = name.replace("לוגו","");
        }
        if (name.endsWith("-")){
            name = name.replace("-","");
        }
        if (name.indexOf("|") > 0){
            name = name.substring(0,name.indexOf("|") -1).trim();
        }
        name = name.replace("_", " ");
    }
    return name.trim();
}

/**
 * Function used for Kan kids and teens only.
 * @param {*} link 
 * @returns JSON object to be used in teh video object 
 */
async function getStreams(link){
    logger.trace("getStreams => Entering");
    logger.trace("getStreams => Link: " + link);

    var doc = await fetchData(link);
    
    if (doc == undefined){
        logger.debug("getStreams => Error retrieving do from " + link);
    }
    var released = "";
    var videoUrl = "";
    var nameVideo = "";
    var descVideo = "";

    if (doc.querySelector("li.date-local") != undefined){
        released = utils.getReleaseDate(doc.querySelector("li.date-local").getAttribute("data-date-utc"));
    } 
    var scriptElems = doc.querySelectorAll("script");
    
    for (var scriptElem of scriptElems){         
        if (scriptElem.toString().includes("VideoObject")) {
            videoUrl = this.getEpisodeUrl(scriptElem.toString());
            break;
        }
    }
    
    if (videoUrl == "") {
        return "-1";
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
    };
    if (released != "") { streamsJSONObj["released"] = released;}
    logger.trace("getStreams => Exiting");
    return streamsJSONObj;
}

/**
 * returns a link from a JSON string
 * @param {*} link 
 * @returns URL formatted string
 */
function getEpisodeUrl(link){
    var startPoint = link.indexOf("contentUrl");
    link = link.substring(startPoint + 14);
    var endPoint = link.indexOf('\"');
    link = link.substring(0,endPoint);
        
    return link;
}

/**
 * Clean up string in order to retrieve episode URL
 * @param {*} str 
 * @returns the string of a URL from video page
 */
function getVideoNameFromEpisodePage(str){
    if (str.indexOf("|") > 0) {
        str = str.substring(str.indexOf('|'));
        str = str.replace("|", "");
    }
    str = str.trim();
    return str;
}

function generateSeriesId(link, subPrefix, seriesId = "0"){
    var retId = "";

    if (seriesId != "0"){
        retId = seriesId;
    } else {
    //if the link has a trailing  "/" then omit it
        if(link) {
            if (link.substring(link.length -1) == "/"){
                link = link.substring(0,link.length -1);
            }
            retId = link.substring(link.lastIndexOf("/") + 1, link.length);
            retId = retId.replace(/\D/g,'');
        }
    }
    if (retId == ""){
        retId = seriesIterator;
        seriesIterator++;
    }

    retId = PREFIX + "kan_" + subPrefix + "_" + retId;
    
    return retId;
}

async function sleeperTimer(delay = RETRY_DELAY) {
    logger.info("sleeperTimer => Start");
    await sleep(delay); // Sleep for 2 seconds
    console.log(`sleeperTimer => ${delay} ms`);
}


module.exports = {
    padWithLeadingZeros, 
    fetchData, 
    writeJSONToFile, 
    getCurrentDateStr, 
    getReleaseDate, 
    getImageFromUrl, 
    setGenreFromString, 
    getNameFromSeriesPage, 
    getStreams,
    getEpisodeUrl,
    getVideoNameFromEpisodePage,
    generateSeriesId,
    sleeperTimer    
};