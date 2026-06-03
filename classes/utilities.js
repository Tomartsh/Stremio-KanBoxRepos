
const { parse } = require('node-html-parser');
const path = require("path");
const axios = require('axios');
const { gotScraping } = require('got-scraping');
const AdmZip = require("adm-zip");
const fs = require('fs');
const { chromium } = require('playwright');

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
/*
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
*/
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
 * 4. Explicit playwright (for Cloudflare-protected sites):
 *    const doc = await fetchData(url, false, {}, HEADERS, 'playwright');
 *
 * The system will still apply rate limiting and retry logic regardless of method.
 * =============================================================================
 */

// --- Playwright Browser Manager ---
// Manages a persistent browser instance for Playwright-based fetching
// Uses a single page with sequential navigation to avoid Cloudflare detection
class PlaywrightBrowserManager {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isLaunching = false;
        this.launchPromise = null;
        // Request queue for sequential processing
        this.requestQueue = [];
        this.isProcessing = false;
    }

    // Queue a request and process sequentially
    async queueRequest(requestFn) {
        return new Promise((resolve, reject) => {
            this.requestQueue.push({ requestFn, resolve, reject });
            this.processQueue();
        });
    }

    async processQueue() {
        if (this.isProcessing || this.requestQueue.length === 0) {
            return;
        }

        this.isProcessing = true;

        while (this.requestQueue.length > 0) {
            const { requestFn, resolve, reject } = this.requestQueue.shift();
            try {
                const result = await requestFn();
                resolve(result);
            } catch (error) {
                reject(error);
            }
            // Longer delay between requests to avoid Cloudflare rate limiting
            if (this.requestQueue.length > 0) {
                await new Promise(r => setTimeout(r, 2000));
            }
        }

        this.isProcessing = false;
    }

    // Acquire a slot for a new page (waits if at max capacity)
    async acquirePageSlot() {
        // Now handled by queue - just return immediately
        return;
    }

    // Release a page slot
    releasePageSlot() {
        // Now handled by queue - no-op
    }

    async getBrowser() {
        if (this.browser && this.browser.isConnected()) {
            return this.browser;
        }

        // Prevent multiple simultaneous launches
        if (this.isLaunching) {
            return this.launchPromise;
        }

        this.isLaunching = true;
        this.launchPromise = this._launchBrowser();

        try {
            this.browser = await this.launchPromise;
            return this.browser;
        } finally {
            this.isLaunching = false;
        }
    }

    async _launchBrowser() {
        logger.info('PlaywrightBrowserManager => Launching browser...');
        const browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-blink-features=AutomationControlled',
                '--disable-features=IsolateOrigins,site-per-process',
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu'
            ]
        });
        logger.info('PlaywrightBrowserManager => Browser launched successfully');
        return browser;
    }

    async getContext() {
        const browser = await this.getBrowser();

        if (!this.context || this.context.browser() !== browser) {
            this.context = await browser.newContext({
                userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                viewport: { width: 1920, height: 1080 },
                locale: 'he-IL',
                timezoneId: 'Asia/Jerusalem',
                extraHTTPHeaders: {
                    'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
                }
            });
            // Reset page when context changes
            this.page = null;
        }

        return this.context;
    }

    // Get a reusable page (avoids creating new pages for each request)
    async getPage() {
        const context = await this.getContext();

        if (!this.page || this.page.isClosed()) {
            this.page = await context.newPage();
            logger.debug('PlaywrightBrowserManager => Created new page');
        }

        return this.page;
    }

    async close() {
        if (this.page) {
            await this.page.close().catch(() => {});
            this.page = null;
        }
        if (this.context) {
            await this.context.close().catch(() => {});
            this.context = null;
        }
        if (this.browser) {
            await this.browser.close().catch(() => {});
            this.browser = null;
        }
        logger.info('PlaywrightBrowserManager => Browser closed');
    }
}

const playwrightManager = new PlaywrightBrowserManager();

// Cleanup on process exit
process.on('exit', () => {
    playwrightManager.close().catch(() => {});
});
process.on('SIGINT', async () => {
    await playwrightManager.close();
    process.exit(0);
});
process.on('SIGTERM', async () => {
    await playwrightManager.close();
    process.exit(0);
});

// --- Request Tracking for Rate Limiting ---
class RequestTracker {
    constructor() {
        this.requestsByDomain = new Map(); // domain -> array of timestamps
    }

    getRateLimits(hostname) {
        // Sort domains by length (longest first) to match most specific domain
        const domains = Object.keys(RATE_LIMITING)
            .filter(key => !['DEFAULT_MIN_INTERVAL', 'DEFAULT_MAX_PER_MINUTE', 'DEFAULT_JITTER'].includes(key))
            .sort((a, b) => b.length - a.length); // Longest first
        
        for (const domain of domains) {
            if (hostname.includes(domain)) {
                return RATE_LIMITING[domain];
            }
        }
        
        // Return defaults
        return {
            minInterval: RATE_LIMITING.DEFAULT_MIN_INTERVAL,
            maxPerMinute: RATE_LIMITING.DEFAULT_MAX_PER_MINUTE,
            jitter: RATE_LIMITING.DEFAULT_JITTER || [10, 50]  // ← Add default jitter
        };
    }

    async trackAndDelay(hostname) {
        const { minInterval, maxPerMinute, jitter: jitterRange } = this.getRateLimits(hostname);
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
        
        // Add random jitter based on domain configuration
        const [minJitter, maxJitter] = jitterRange || [10, 50];
        const jitterDuration = minJitter === maxJitter ? minJitter : 
            Math.floor(Math.random() * (maxJitter - minJitter)) + minJitter;
        
        if (jitterDuration > 0) {
            await this.sleep(jitterDuration);
        }
        
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
        // 3. Check if domain prefers got-scraping
        // 4. Default to 'axios'
        let currentMethod;
        if (preferredMethod) {
            currentMethod = preferredMethod;
            logger.debug(`fetchWithRetries => Using explicitly requested method: ${preferredMethod}`);
        } else if (stickyMethods.has(hostname)) {
            currentMethod = stickyMethods.get(hostname);
        } else {
            // Check if domain requires Playwright (Cloudflare-protected)
            const requiresPlaywright = FETCH_METHOD_CONFIG.REQUIRES_PLAYWRIGHT?.some(domain =>
                hostname.includes(domain)
            );
            if (requiresPlaywright) {
                currentMethod = 'playwright';
                logger.debug(`fetchWithRetries => Using Playwright for ${hostname} (Cloudflare-protected)`);
            } else {
                // Check if domain prefers got-scraping
                const prefersGotScraping = FETCH_METHOD_CONFIG.PREFERS_GOT_SCRAPING?.some(domain =>
                    hostname.includes(domain)
                );
                currentMethod = prefersGotScraping ? 'got-scraping' : 'axios';
                if (prefersGotScraping) {
                    logger.debug(`fetchWithRetries => Using got-scraping for ${hostname} (in PREFERS_GOT_SCRAPING list)`);
                }
            }
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
                
                // If we get a 403 or 401, escalate to more powerful tools
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

                    // Escalation chain: axios -> got-scraping -> playwright
                    if (currentMethod === 'axios') {
                        logger.warn(`Switching to got-scraping for ${hostname}...`);
                        currentMethod = 'got-scraping';
                        stickyMethods.delete(hostname);
                        const rateLimitDelay = 5000; // Short delay before trying got-scraping
                        await new Promise(r => setTimeout(r, rateLimitDelay));
                        continue;
                    } else if (currentMethod === 'got-scraping') {
                        logger.warn(`Switching to Playwright for ${hostname} (Cloudflare detected)...`);
                        currentMethod = 'playwright';
                        stickyMethods.delete(hostname);
                        const rateLimitDelay = 2000; // Short delay before trying Playwright
                        await new Promise(r => setTimeout(r, rateLimitDelay));
                        continue;
                    } else {
                        // Already using Playwright, add delay and retry
                        const rateLimitDelay = 30000 * attempt;
                        logger.warn(`Waiting ${rateLimitDelay}ms due to possible rate limiting...`);
                        await new Promise(r => setTimeout(r, rateLimitDelay));
                        continue;
                    }
                }

                // 404 means the page doesn't exist - no point retrying
                if (status === 404) {
                    logger.warn(`Page not found (404) for ${url} - skipping retries`);
                    throw error;
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

                if (attempt === FETCH_METHOD_CONFIG.MAX_RETRIES) {
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

        case 'playwright':
            // Queue the request for sequential processing to avoid Cloudflare rate limiting
            return await playwrightManager.queueRequest(async () => {
                const page = await playwrightManager.getPage();

                // Build URL with params if needed
                let fetchUrl = url;
                if (params && Object.keys(params).length > 0) {
                    const urlObj = new URL(url);
                    Object.entries(params).forEach(([key, value]) => {
                        urlObj.searchParams.append(key, value);
                    });
                    fetchUrl = urlObj.toString();
                }

                logger.trace(`executeRequest => [PLAYWRIGHT] Navigating to ${fetchUrl}`);

                // Navigate with retry for Cloudflare challenge
                const response = await page.goto(fetchUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: FETCH_METHOD_CONFIG.REQUEST_TIMEOUT
                });

                // Wait for Cloudflare challenge to complete if present
                const pageContent = await page.content();
                if (pageContent.includes('Just a moment') || pageContent.includes('Checking your browser')) {
                    logger.debug('executeRequest => [PLAYWRIGHT] Cloudflare challenge detected, waiting...');
                    await page.waitForTimeout(5000);
                    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
                }

                const status = response?.status() || 200;
                if (status >= 400) {
                    const error = new Error(`HTTP ${status}`);
                    error.statusCode = status;
                    error.response = { status };
                    throw error;
                }

                const content = await page.content();

                if (asJson) {
                    // Extract JSON from page - might be wrapped in HTML
                    const bodyText = await page.evaluate(() => document.body.innerText);
                    try {
                        return JSON.parse(bodyText);
                    } catch (e) {
                        // Try to find JSON in a <pre> tag
                        const preContent = await page.$eval('pre', el => el.textContent).catch(() => null);
                        if (preContent) {
                            return JSON.parse(preContent);
                        }
                        throw new Error('Failed to parse JSON from Playwright response');
                    }
                }

                return parse(content);
            });

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
            name = name.replaceAll("Image Small 239X360","");
        }
        if (name.includes("פוסטר קטן")){
            name = name.replaceAll("פוסטר קטן","");
        }
        if (name.includes("Poster")){
            name = name.replaceAll("Poster","");
        }
        if (name.includes("1920X1080")){
            name = name.replaceAll("1920X1080","");
        }
        // Remove trailing parenthesized numbers like (1), (2) left after image artifact cleanup
        name = name.replace(/\s*\(\d+\)\s*$/, '').trim();
        if (name.includes("Title Logo")){
            name = name.replaceAll("Title Logo","");
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

    // Try to get stream URL from redge-player element (new Kan player)
    var playerElem = doc.querySelector("[id^='redge-player-']");
    if (playerElem && playerElem.getAttribute("data-hls-url")) {
        videoUrl = playerElem.getAttribute("data-hls-url");
        // Ensure URL has protocol
        if (videoUrl.startsWith("//")) {
            videoUrl = "https:" + videoUrl;
        }
        logger.debug("getStreams => Found redge-player URL: " + videoUrl);
    } else {
        // Fallback to VideoObject method (legacy - Kaltura URLs, may not work)
        logger.debug("getStreams => No redge-player found, falling back to VideoObject");
        var scriptElems = doc.querySelectorAll("script");
        for (var scriptElem of scriptElems){
            if (scriptElem.toString().includes("VideoObject")) {
                videoUrl = getEpisodeUrl(scriptElem.toString());
                // Ensure URL has protocol
                if (videoUrl.startsWith("//")) {
                    videoUrl = "https:" + videoUrl;
                }
                break;
            }
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

/**
 * =============================================================================
 * ON-DEMAND STREAM RESOLVER
 * =============================================================================
 *
 * This function resolves stream URLs on-demand when a user plays an episode.
 * Instead of pre-fetching all episode streams during scraping (which triggers
 * Cloudflare rate limiting), we store episode page URLs and resolve them
 * when the user actually requests playback.
 *
 * Usage in Stremio addon stream handler:
 *   const { resolveStreamUrl } = require('./utilities.js');
 *   const stream = await resolveStreamUrl(episodeLink);
 *   if (stream) {
 *       return { streams: [{ url: stream.url, title: stream.title }] };
 *   }
 *
 * @param {string} episodePageUrl - The URL of the episode page (stored in episodeLink)
 * @returns {Promise<Object|null>} - Stream object with url, title, name, released or null on failure
 */
async function resolveStreamUrl(episodePageUrl) {
    logger.info(`resolveStreamUrl => Resolving stream for: ${episodePageUrl}`);

    if (!episodePageUrl) {
        logger.warn('resolveStreamUrl => No episode URL provided');
        return null;
    }

    try {
        // Fetch the episode page
        const doc = await fetchData(episodePageUrl);

        if (!doc) {
            logger.warn(`resolveStreamUrl => Failed to fetch episode page: ${episodePageUrl}`);
            return null;
        }

        let videoUrl = "";
        let nameVideo = "";
        let released = "";

        // Extract release date
        if (doc.querySelector("li.date-local") != undefined) {
            const dateStr = doc.querySelector("li.date-local").getAttribute("data-date-utc");
            if (dateStr) {
                // Parse DD.MM.YYYY HH:MM:SS format
                const match = dateStr.match(/(\d{2})\.(\d{2})\.(\d{4})\s*(\d{2})?:?(\d{2})?:?(\d{2})?/);
                if (match) {
                    const [, day, month, year, hour = "00", min = "00", sec = "00"] = match;
                    const date = new Date(`${year}-${month}-${day}T${hour}:${min}:${sec}`);
                    released = isNaN(date.getTime()) ? "" : date.toISOString();
                }
            }
        }

        // Try to get stream URL from redge-player element (Kan Digital video)
        var playerElem = doc.querySelector("[id^='redge-player-']");
        if (playerElem && playerElem.getAttribute("data-hls-url")) {
            videoUrl = playerElem.getAttribute("data-hls-url");
            if (videoUrl.startsWith("//")) {
                videoUrl = "https:" + videoUrl;
            }
            logger.debug("resolveStreamUrl => Found redge-player URL: " + videoUrl);
        }

        // Try podcast player: figure[data-player-src] or button.btn-play[data-player-src]
        if (!videoUrl) {
            const figureElem = doc.querySelector("figure[data-player-src]");
            if (figureElem) {
                videoUrl = figureElem.getAttribute("data-player-src");
                if (videoUrl && videoUrl.includes("?")) {
                    videoUrl = videoUrl.substring(0, videoUrl.indexOf("?"));
                }
                logger.debug("resolveStreamUrl => Found podcast figure stream: " + videoUrl);
            } else {
                const buttonElem = doc.querySelector("button.btn-play[data-player-src]");
                if (buttonElem) {
                    videoUrl = buttonElem.getAttribute("data-player-src");
                    if (videoUrl && videoUrl.includes("?")) {
                        videoUrl = videoUrl.substring(0, videoUrl.indexOf("?"));
                    }
                    logger.debug("resolveStreamUrl => Found podcast button stream: " + videoUrl);
                }
            }
        }

        // Fallback to VideoObject method (legacy - Kaltura URLs)
        if (!videoUrl) {
            logger.debug("resolveStreamUrl => Trying VideoObject fallback");
            var scriptElems = doc.querySelectorAll("script");
            for (var scriptElem of scriptElems) {
                if (scriptElem.toString().includes("VideoObject")) {
                    videoUrl = getEpisodeUrl(scriptElem.toString());
                    if (videoUrl.startsWith("//")) {
                        videoUrl = "https:" + videoUrl;
                    }
                    break;
                }
            }
        }

        if (!videoUrl) {
            logger.warn(`resolveStreamUrl => No stream URL found on page: ${episodePageUrl}`);
            return null;
        }

        // Extract video name/title
        if (doc.querySelectorAll("div.info-title h1.h2").length > 0) {
            nameVideo = doc.querySelectorAll("div.info-title h1.h2")[0].text.trim();
            nameVideo = getVideoNameFromEpisodePage(nameVideo);
        } else if (doc.querySelector("title")) {
            nameVideo = doc.querySelector("title").text.trim();
            nameVideo = getVideoNameFromEpisodePage(nameVideo);
        }

        const streamObj = {
            url: videoUrl,
            title: nameVideo,
            name: nameVideo,
            released: released
        };

        logger.info(`resolveStreamUrl => Successfully resolved stream: ${nameVideo}`);
        return streamObj;

    } catch (error) {
        logger.error(`resolveStreamUrl => Error resolving stream for ${episodePageUrl}: ${error.message}`);
        return null;
    }
}

function sleeperTimer(delay = FETCH_METHOD_CONFIG.RETRY_DELAY) {
    return new Promise(resolve => setTimeout(resolve, delay));
}

/**
 * =============================================================================
 * DELTA SYNC TRACKING
 * =============================================================================
 *
 * Track changes during scraping for efficient bulk database updates
 */

class DeltaTracker {
    constructor() {
        this.changes = {
            newSeries: [],
            updatedSeries: [],
            newVideos: [],
            updatedVideos: [],
            skippedSeries: 0,
            errors: []
        };
    }

    addNewSeries(seriesId, seriesData) {
        this.changes.newSeries.push({ id: seriesId, ...seriesData });
    }

    addUpdatedSeries(seriesId, seriesData) {
        this.changes.updatedSeries.push({ id: seriesId, ...seriesData });
    }

    addNewVideo(videoId, videoData) {
        this.changes.newVideos.push({ id: videoId, ...videoData });
    }

    addUpdatedVideo(videoId, videoData) {
        this.changes.updatedVideos.push({ id: videoId, ...videoData });
    }

    skipSeries() {
        this.changes.skippedSeries++;
    }

    addError(error, context) {
        this.changes.errors.push({ error: error.message, context, timestamp: new Date() });
    }

    getSummary() {
        return {
            newSeries: this.changes.newSeries.length,
            updatedSeries: this.changes.updatedSeries.length,
            newVideos: this.changes.newVideos.length,
            updatedVideos: this.changes.updatedVideos.length,
            skippedSeries: this.changes.skippedSeries,
            errors: this.changes.errors.length,
            totalChanges: this.changes.newSeries.length +
                          this.changes.updatedSeries.length +
                          this.changes.newVideos.length +
                          this.changes.updatedVideos.length
        };
    }

    hasChanges() {
        return this.getSummary().totalChanges > 0;
    }

    clear() {
        this.changes = {
            newSeries: [],
            updatedSeries: [],
            newVideos: [],
            updatedVideos: [],
            skippedSeries: 0,
            errors: []
        };
    }
}

/**
 * Extract release date from a date-local element
 * @param {HTMLElement} dateElement - The li.date-local element
 * @returns {string} - ISO date string or empty string
 */
function extractReleaseDate(dateElement) {
    if (!dateElement) return "";

    const dateUtc = dateElement.getAttribute("data-date-utc");
    if (!dateUtc) return "";

    try {
        // Parse common date formats
        // Format 1: DD.MM.YYYY HH:MM:SS (Israeli format)
        const matchIso = dateUtc.match(/(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
        if (matchIso) {
            const date = new Date(dateUtc);
            return isNaN(date.getTime()) ? "" : date.toISOString();
        }

        // Format 2: DD.MM.YYYY HH:MM:SS or D.M.YYYY HH:MM:SS (single/double digits)
        const matchIl = dateUtc.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})\s*(\d{2})?:?(\d{2})?:?(\d{2})?/);
        if (matchIl) {
            const [, day, month, year, hour = "00", min = "00", sec = "00"] = matchIl;
            // Pad single digits with leading zero
            const paddedDay = day.padStart(2, '0');
            const paddedMonth = month.padStart(2, '0');
            const date = new Date(`${year}-${paddedMonth}-${paddedDay}T${hour}:${min}:${sec}`);
            return isNaN(date.getTime()) ? "" : date.toISOString();
        }

        // Format 3: Try direct parsing
        const date = new Date(dateUtc);
        if (!isNaN(date.getTime())) {
            return date.toISOString();
        }

        logger.warn(`extractReleaseDate => Could not parse date format: ${dateUtc}`);
        return "";
    } catch (error) {
        logger.error(`extractReleaseDate => Error parsing date: ${error.message}`);
        return "";
    }
}

/**
 * Extract latest episode date from series list element (lightweight check)
 * @param {HTMLElement} seriesElem - Series element from list page
 * @returns {string} - ISO date string or empty string
 */
function extractLatestDateFromList(seriesElem) {
    if (!seriesElem) return "";

    // Try to find date element in series card
    const dateElem = seriesElem.querySelector("li.date-local");
    if (dateElem) {
        return extractReleaseDate(dateElem);
    }

    // Alternative: look for data attributes
    const dateAttr = seriesElem.getAttribute("data-date-utc");
    if (dateAttr) {
        const date = new Date(dateAttr);
        return isNaN(date.getTime()) ? "" : date.toISOString();
    }

    return "";
}

/**
 * Check if series has new episodes compared to database
 * @param {Object} listData - Series data from list page
 * @param {Object} dbSeries - Series data from database
 * @returns {boolean} - True if new episode detected
 */
function hasNewEpisode(listData, dbSeries) {
    if (!dbSeries) return true; // New series

    const listDate = listData.latestEpisodeDate;
    const dbDate = dbSeries.latest_episode_date;

    if (!listDate) return false; // Can't determine, assume no change
    if (!dbDate) return true; // DB has no date, treat as new

    return new Date(listDate) > new Date(dbDate);
}

/**
 * Check if series metadata changed (poster, description, etc.)
 * @param {Object} listData - Series data from list page
 * @param {Object} dbSeries - Series data from database
 * @returns {boolean} - True if metadata changed
 */
function hasSeriesChanged(listData, dbSeries) {
    if (!dbSeries) return true;

    // Check key fields for changes
    if (listData.name && listData.name !== dbSeries.name) return true;
    if (listData.poster && listData.poster !== dbSeries.poster) return true;
    if (listData.description && listData.description !== dbSeries.description) return true;

    return false;
}

/**
 * =============================================================================
 * SHARED DATABASE UPDATE FUNCTION
 * =============================================================================
 */

/**
 * Shared updateDatabase function for all scrapers
 * Updates database in bulk from JSON object
 * @param {string} scraperName - Scraper name (e.g., 'mako', 'kanteens')
 * @param {object} jsonData - The scraped JSON object
 * @param {object} logger - Logger instance
 */
async function updateDatabaseFromJSON(scraperName, jsonData, logger) {
    const DatabaseUpdater = require('./DatabaseUpdater');
    const dbUpdater = new DatabaseUpdater();

    logger.info(`updateDatabase => Starting bulk database update for ${scraperName}...`);

    try {
        const result = await dbUpdater.updateFromJSON(scraperName, jsonData);
        logger.info(`updateDatabase => ✅ Updated ${result.series} series, ${result.videos} videos, ${result.streams} streams in ${result.duration}s`);
        return result;
    } catch (error) {
        logger.error(`updateDatabase => ❌ Failed to update database: ${error.message}`);
        throw error;
    }
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
    sleeperTimer,
    resolveStreamUrl,
    extractReleaseDate,
    DeltaTracker,
    extractLatestDateFromList,
    hasNewEpisode,
    hasSeriesChanged,
    updateDatabaseFromJSON
};