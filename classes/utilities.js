
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
    LOG4JS,
    HEADERS, 
    SAVE_MODE,
    SAVE_FOLDER,
    RATE_LIMITING,
    FETCH_METHOD_CONFIG
} = require ("./constants");

log4js.configure({
    appenders: { 
        out: { type: "stdout" },
        Stremio: 
        { 
            type: "file", 
            filename: "logs/Stremio_addon.log", 
            maxLogSize: LOG4JS.MAX_SIZE, 
            backups: LOG4JS.BACKUP_FILES
        }
    },
    categories: { default: { appenders: ['Stremio','out'], level: LOG4JS.LEVEL } },
});

var logger = log4js.getLogger("utillities");


/**
 * =============================================================================
 * FETCH METHOD SELECTION
 * =============================================================================
 * 
 * The fetchData function now supports explicit method selection:
 * 
 * Usage Examples:
 * 
 * 1. Auto method (default behavior - uses axios first, switches on errors):
 *    const doc = await fetchData(url);
 *    const jsonData = await fetchData(url, true);
 * 
 * 2. Explicit axios (useful for endpoints that block got-scraping):
 *    const doc = await fetchData(url, false, {}, HEADERS, 'axios');
 * 
 * 3. Explicit got-scraping (useful for sites that need advanced scraping):
 *    const doc = await fetchData(url, false, {}, HEADERS, 'got-scraping');
 * 
 * The system will still apply rate limiting and retry logic regardless of method.
 * =============================================================================
 */

// --- Request Tracking for Rate Limiting ---
class RequestTracker {
    constructor() {
        this.requestsByDomain = new Map(); // domain -> array of timestamps
    }

    getRateLimits(hostname) {
        // Sort domains by length (longest first) to match most specific domain
        const domains = Object.keys(RATE_LIMITING)
            .filter(key => key !== 'DEFAULT_MIN_INTERVAL' && key !== 'DEFAULT_MAX_PER_MINUTE')
            .sort((a, b) => b.length - a.length); // Longest first
        
        for (const domain of domains) {
            if (hostname.includes(domain)) {
                return RATE_LIMITING[domain];
            }
        }
        
        // Return defaults
        return {
            minInterval: RATE_LIMITING.DEFAULT_MIN_INTERVAL,
            maxPerMinute: RATE_LIMITING.DEFAULT_MAX_PER_MINUTE
        };
    }

    async trackAndDelay(hostname) {
        const { minInterval, maxPerMinute } = this.getRateLimits(hostname);
        const now = Date.now();
        
        if (!this.requestsByDomain.has(hostname)) {
            this.requestsByDomain.set(hostname, []);
        }
        
        const timestamps = this.requestsByDomain.get(hostname);
        
        // Clean old timestamps (older than 1 minute)
        while (timestamps.length > 0 && now - timestamps[0] > 60000) {
            timestamps.shift();
        }
        
        // Check per-minute rate limit
        if (timestamps.length >= maxPerMinute) {
            const oldestRequest = timestamps[0];
            const waitTime = 60000 - (now - oldestRequest) + 100;
            logger.warn(`RequestTracker => Rate limit for ${hostname}: waiting ${waitTime}ms (${timestamps.length}/${maxPerMinute} requests)`);
            await this.sleep(waitTime);
        }
        
        // Check minimum interval
        if (timestamps.length > 0) {
            const lastRequest = timestamps[timestamps.length - 1];
            const timeSinceLastRequest = now - lastRequest;
            
            if (timeSinceLastRequest < minInterval) {
                const waitTime = minInterval - timeSinceLastRequest;
                await this.sleep(waitTime);
            }
        }
        
        // Add random jitter (100-500ms) to appear more human-like
        const jitter = Math.floor(Math.random() * 400) + 100;
        await this.sleep(jitter);
        
        // Record this request
        timestamps.push(Date.now());
        
        logger.trace(`RequestTracker => ${hostname}: ${timestamps.length} requests in last minute`);
    }
    
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
    
    getStats(hostname) {
        const timestamps = this.requestsByDomain.get(hostname) || [];
        const now = Date.now();
        const recentRequests = timestamps.filter(t => now - t < 60000);
        const limits = this.getRateLimits(hostname);
        
        return {
            requestsLastMinute: recentRequests.length,
            totalRequests: timestamps.length,
            maxPerMinute: limits.maxPerMinute,
            minInterval: limits.minInterval
        };
    }
}

const requestTracker = new RequestTracker();

// --- Throttler for Concurrent Requests ---
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

const throttler = new Throttler(FETCH_METHOD_CONFIG.MAX_CONCURRENT_REQUESTS);

// --- Persistent State Tracker ---
// This keeps track of which method works for which domain
const stickyMethods = new Map(); 

// --- Enhanced Header Generation ---
function getEnhancedHeaders(url, baseHeaders = HEADERS) {
    const hostname = new URL(url).hostname;
    
    // Base headers that work for most sites
    const enhancedHeaders = {
        ...baseHeaders,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9,he;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
        'DNT': '1',
        'Connection': 'keep-alive',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
    };
    
    // Add domain-specific headers if needed
    if (hostname.includes('mako.co.il')) {
        enhancedHeaders['Referer'] = 'https://www.mako.co.il/mako-vod';
        enhancedHeaders['Origin'] = 'https://www.mako.co.il';
        enhancedHeaders['Accept-Language'] = 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7';
    }
    
    return enhancedHeaders;
}

// --- Response Validation ---
function validateResponse(data, url, asJson) {
    // Check if we got HTML when expecting JSON
    if (asJson) {
        const bodyStr = typeof data === 'string' ? data : JSON.stringify(data);
        
        if (bodyStr.trim().startsWith('<!DOCTYPE') || 
            bodyStr.trim().startsWith('<html') ||
            bodyStr.includes('@@@page not found')) {
            throw new Error('Received HTML page instead of JSON - possible rate limiting or block');
        }
    }
    
    return true;
}

// --- Core Request Logic ---

/**
 * Main Fetcher: Determines which method to use and handles retries
 */

async function fetchWithRetries(url, asJson = false, params = {}, headers, preferredMethod = null) {
    logger.trace("fetchWithRetries => Entering");
    logger.trace(`URL: ${url} \n    asJson: ${asJson} \n    Params: ${params}: \n   headers: ${headers} \n    preferredMethod: ${preferredMethod}`);
    
    let hostname;
    try {
        hostname = new URL(url).hostname;
    } catch (e) {
        logger.error(`Invalid URL provided: ${url}`);
        return null;
    }

    // Apply rate limiting delay before making request
    await requestTracker.trackAndDelay(hostname);

    return throttler.schedule(async () => {
        // Determine initial method:
        // 1. If preferredMethod is specified, use it
        // 2. Otherwise, use sticky method for this domain
        // 3. Default to 'axios'
        let currentMethod;
        if (preferredMethod) {
            currentMethod = preferredMethod;
            logger.debug(`fetchWithRetries => Using explicitly requested method: ${preferredMethod}`);
        } else {
            currentMethod = stickyMethods.get(hostname) || 'axios';
        }

        let lastError; // Track the last error for final throw

        for (let attempt = 1; attempt <= FETCH_METHOD_CONFIG.MAX_RETRIES; attempt++) {
            try {
                logger.debug(`fetchWithRetries => [${currentMethod.toUpperCase()}] ->  ${url} try no. ${attempt}`);
                const data = await executeRequest(currentMethod, url, asJson, params, headers);
                
                // Validate the response
                validateResponse(data, url, asJson);
                
                // Success! Stick this method to the domain
                if (stickyMethods.get(hostname) !== currentMethod) {
                    logger.trace(`Method "${currentMethod}" is now STICKY for ${hostname}`);
                    stickyMethods.set(hostname, currentMethod);
                }
                
                return data;

            } catch (error) {
                lastError = error;
                const status = error.response?.status || error.statusCode;
                const errorMsg = error.message || 'Unknown error';
                logger.warn(`${currentMethod} failed (Status: ${status || 'Timeout'}): ${errorMsg}`);
                
                // If we get a 403 or 401, immediately rotate to a more powerful tool
                if (status === 403 || status === 401) {
                    logger.warn(`Authorization issue (${status}) with ${currentMethod}.`);
    
                    // Check if this domain should stay with axios
                    const shouldStayWithAxios = FETCH_METHOD_CONFIG.AXIOS_ONLY_DOMAINS.some(domain => 
                        hostname.includes(domain)
                    );
                    
                    if (shouldStayWithAxios) {
                        logger.warn(`Keeping axios for ${hostname} (in AXIOS_ONLY list), adding long delay...`);
                        const rateLimitDelay = 60000 * attempt; // 1min, 2min, 3min...
                        await new Promise(r => setTimeout(r, rateLimitDelay));
                        continue;
                    }
                    
                    // For other domains, switching to got-scraping may help
                    logger.warn(`Switching to got-scraping for ${hostname}...`);
                    currentMethod = 'got-scraping';
                    stickyMethods.delete(hostname);
                    
                    const rateLimitDelay = 30000 * attempt;
                    logger.warn(`Waiting ${rateLimitDelay}ms due to possible rate limiting...`);
                    await new Promise(r => setTimeout(r, rateLimitDelay));
                    continue;
                }

                if (status === 429) {
                    logger.warn(`Rate limit (429) detected. Long delay before retry...`);
                    const rateLimitDelay = 60000 * attempt; // 1min, 2min, 3min...
                    await new Promise(r => setTimeout(r, rateLimitDelay));
                    continue;
                }
                
                if (errorMsg.includes('timeout') || errorMsg.includes('ETIMEDOUT')) {
                    // Check if this domain should stay with axios
                    const shouldStayWithAxios = FETCH_METHOD_CONFIG.AXIOS_ONLY_DOMAINS.some(domain => 
                        hostname.includes(domain)
                    );
                    
                    if (!shouldStayWithAxios) {
                        logger.warn(`Timeout with ${currentMethod}. Switching to got-scraping...`);
                        currentMethod = 'got-scraping';
                        stickyMethods.delete(hostname);
                    } else {
                        logger.warn(`Timeout with ${currentMethod} for ${hostname} (AXIOS_ONLY domain). Will retry with axios...`);
                    }
                }
                
                if (errorMsg.includes('HTML page instead of JSON')) {
                    logger.warn(`Got HTML instead of JSON - possible blocking. Switching method and adding delay...`);
                    currentMethod = 'got-scraping';
                    stickyMethods.delete(hostname);
                    await new Promise(r => setTimeout(r, 5000));
                }

                if (attempt === FETCH_METHOD_CONFIG.NAX_RETRIES) {
                    logger.error(`Max retries reached for ${url}`);
                    throw error;

                }

                const baseDelay = FETCH_METHOD_CONFIG.RETRY_DELAY * Math.pow(2, attempt - 1);

                const jitter = Math.floor(Math.random() * 1000);
                const delay = baseDelay + jitter;

                logger.debug(`Waiting ${delay}ms before next attempt...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }

        throw lastError; 

    });
}


/**
 * Entry Point: Your original fetchData wrapper
 * @param {string} url - The URL to fetch
 * @param {boolean} asJson - Whether to parse response as JSON
 * @param {object} params - Request parameters (for POST requests)
 * @param {object} headers - HTTP headers
 * @param {string|null} preferredMethod - Preferred fetch method: 'axios', 'got-scraping', or null for auto
 * @returns {Promise} - Parsed HTML document or JSON object
 */
async function fetchData(url, asJson = false, params = {}, headers = HEADERS, preferredMethod = null) {
    try {
        logger.trace(`fetchData => For URL: ${url}`);
        const enhancedHeaders = getEnhancedHeaders(url, headers);
        // We pass the URL through to the retry logic
        return await fetchWithRetries(url, asJson, params, headers, preferredMethod);
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
            const axiosConfig = { 
                timeout: FETCH_METHOD_CONFIG.REQUEST_TIMEOUT, 
                headers, 
                params, 
                responseType: asJson ? 'json' : 'text',
                validateStatus: (status) => status < 500 // Don't throw on 4xx
            };
            
            const axRes = await axios.get(url, axiosConfig);
            
            // Check for error status codes
            if (axRes.status >= 400) {
                const error = new Error(`HTTP ${axRes.status}`);
                error.response = axRes;
                error.statusCode = axRes.status;
                throw error;
            }
            
            return asJson ? axRes.data : parse(axRes.data.toString());

        case 'got-scraping':
            const gotConfig = {
                url, 
                headers, 
                searchParams: params,
                responseType: asJson ? 'json' : 'text',
                timeout: { request: FETCH_METHOD_CONFIG.REQUEST_TIMEOUT },
                throwHttpErrors: false, // Don't throw on 4xx/5xx
                http2: true,
                decompress: true,
                followRedirect: true,
                maxRedirects: 5,
                headerGeneratorOptions: { 
                    browsers: [
                        { name: 'chrome', minVersion: 120 }, 
                        { name: 'firefox', minVersion: 120 }
                    ],
                    devices: ['desktop'],
                    locales: ['en-US', 'he-IL'],
                    operatingSystems: ['windows', 'macos']
                }
            };
            
            const gotRes = await gotScraping(gotConfig);
            
            // Check for error status codes
            if (gotRes.statusCode >= 400) {
                const error = new Error(`HTTP ${gotRes.statusCode}`);
                error.statusCode = gotRes.statusCode;
                error.response = { status: gotRes.statusCode };
                throw error;
            }
            
            return asJson ? gotRes.body : parse(gotRes.body.toString());

        default:
            throw new Error(`Unknown method: ${method}`);
    }
}



//+===================================================================================
//
//  Utility functions
//+===================================================================================

/**
 * Sleep/delay utility
 */
function sleeperTimer(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/*
function padWithLeadingZeros(num, totalLength) {
    return String(num).padStart(totalLength, '0');
}
*/

/**
 * Write JSON to file and create ZIP with date
 */
async function writeJSONToFile(jsonObj, fileName) {
    logger.debug("writeJSONToFile => Entering");
    
    if (!jsonObj) { 
        logger.warn("writeJSONToFile => No JSON object provided");
        return;
    }

    const dateStr = getDateString('YYYYmmdd_HHmm');

    const zip = new AdmZip();

    logger.debug("writeJSONToFile => handling repository files");
    const OUTPUT_DIR = path.join(__dirname, `../${SAVE_FOLDER}`);

    const jsonFileName = `${fileName}.json`;
    const zipFileName = `${fileName}.zip`;

    const jsonFilePath = path.join(OUTPUT_DIR, jsonFileName);
    const zipFilePath = path.join(OUTPUT_DIR, zipFileName);
    
    // Ensure output directory exists
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    // Add timestamp at the top level
    const jsonWithTimestamp = {
        timestamp: new Date().toISOString(),
        data: jsonObj
    };

    const jsonContent = JSON.stringify(jsonWithTimestamp, null, 4);

    zip.addFile(jsonFileName, Buffer.from(jsonContent, "utf8"));

    if (SAVE_MODE === "local" || SAVE_MODE === "both") {
        fs.writeFileSync(jsonFilePath, jsonContent);
        zip.writeZip(zipFilePath);
        logger.info(`writeJSONToFile => Saved locally .zip file: ${zipFileName}`);
    }

    if (SAVE_MODE === "github" || SAVE_MODE === "both") {
        // Convert the populated zip object to a Buffer
        const zipBuffer = zip.toBuffer(); 
        logger.debug(`writeJSONToFile => ZIP Buffer size: ${zipBuffer.length} bytes`);
        await uploadToGitHub(zipBuffer, zipFileName, `Adding ${zipFileName} ${dateStr}`);
    }

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
    //const useReleasesAPI = forceLarge || fileSize >= 1000000;
    const useReleasesAPI = forceLarge;

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

/**
 * Get formatted date string
 */
function getDateString(format = 'YYYYmmdd_HHmm') {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    
    if (format === 'YYYYmmdd') {
        return `${year}${month}${day}`;
    } else if (format === 'YYYYmmdd_HHmm') {
        return `${year}${month}${day}_${hours}${minutes}`;
    } else if (format === 'YYYYmmdd_HH_mm') {
        return `${year}${month}${day}_${hours}_${minutes}`;
    }
    
    return `${year}${month}${day}_${hours}${minutes}`;
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
        if (name.indexOf (".כאן 11") > 0){
            name = name.replace("כאן 11.","");
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
        const date = new Date(doc.querySelector("li.date-local").getAttribute("data-date-utc"));
        released = isNaN(date.getTime()) ? "" : date.toISOString();
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

function sleeperTimer(delay = FETCH_METHOD_CONFIG.RETRY_DELAY) {
    return new Promise(resolve => setTimeout(resolve, delay));
}

module.exports = {
    fetchData, 
    writeJSONToFile, 
    getImageFromUrl, 
    setGenreFromString, 
    getNameFromSeriesPage, 
    getStreams,
    getEpisodeUrl,
    getVideoNameFromEpisodePage,
    generateSeriesId,
    sleeperTimer 
};