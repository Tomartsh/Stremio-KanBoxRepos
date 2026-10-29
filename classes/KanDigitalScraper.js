const utils = require("./utilities.js");
const {fetchData, getNameFromSeriesPage, DeltaTracker, extractLatestDateFromList, hasNewEpisode, hasSeriesChanged, updateDatabaseFromJSON} = require("./utilities.js");
const {
    LOG4JS,
    KAN_URL_ADDRESS,
    KAN_DIGITAL_IMAGE_PREFIX,
    KAN_BOX_URL,
    KAN_BOX_IGNORE_LIST,
    INCREMENTAL_SCRAPING,
    SCRAPER_CONFIG
} = require("./constants.js");
const { safeExecute } = require("./ScraperHelpers.js");
const { rethrowIfKanBlocked } = require("./kanSession.js");
const { loadPreviousCatalog } = require("./catalogGate.js");
const {
    parseKanBoxLobby,
    selectLobbySeries,
    parseSeriesMeta,
    parseSeriesPage,
    seasonUrlsToFetch,
    planSeriesRefresh,
    videoFromEpisodeCard,
    videoFromMovieCard,
    carryPreviousEpisodeFields,
    mergeSeededVideos,
    numberDigitalEpisodes
} = require("./kanDigitalParse.js");
const BaseScraper = require("./BaseScraper.js");
const SUB_PREFIX = "digital";
const SUBTYPE = "d";

/**
 * Each known series is fetched again once per forceRefreshDays. The day
 * bucket is stable, so a nightly run refreshes about 1/N of the catalog
 * and leaves the rest on the previous episodes.
 */
function seasonNumberFromUrl(url) {
    const match = String(url || "").match(/\/s(\d+)\/?(?:\?|$)/);
    return match ? parseInt(match[1], 10) : null;
}

function pageIsChallenge(doc) {
    if (!doc || typeof doc.querySelector !== "function") return true;
    const titleNode = doc.querySelector("title");
    const title = titleNode && titleNode.text ? String(titleNode.text) : "";
    return /רק רגע|Just a moment|Attention Required|cf-browser-verification/i.test(title);
}

function seriesDueForRefresh(seriesId, options = {}) {
    const days = Math.max(1, Number(options.forceRefreshDays) || 3);
    const now = options.now instanceof Date ? options.now : new Date();
    const day = Math.floor(now.getTime() / 86400000);
    const bucket = ((day % days) + days) % days;
    let hash = 0;
    const text = String(seriesId || "");
    for (let i = 0; i < text.length; i++) {
        hash = (Math.imul(hash, 33) + text.charCodeAt(i)) >>> 0;
    }
    return (hash % days) === bucket;
}

const log4js = require("log4js");
var logger = log4js.getLogger("KanDigitalScraper");

class KanDigitalScraper extends BaseScraper {

    constructor() {
        // Initialize BaseScraper with the scraper name
        super('KanDigital', { exportFilename: "stremio-kandigital", databaseKey: 'kandigital' });

        // Override the logger to use the specific name
        this.logger = logger;

        // Initialize KanDigital-specific properties
        this._kanDigitalJSONObj = {};
        this.seriesIdIterator = 1000;

        // Source tracking counters (Kan 11 lobby vs Kan-Box)
        this._sourceCounts = {
            'kan11_lobby': 0,
            'kan_box': 0,
            'skipped_duplicate': 0,
            'total_unique': 0
        };
        this._handledThisRun = new Set();
    }

    /**
     * Supabase scrape_state is not the source of "unchanged" for this
     * scraper. A missing database must not turn the nightly back into a
     * full fetch of every series page.
     */
    async initializeStateManager() {
        this.logger.info("KanDigital refresh uses the previous catalog and a rotating slice");
    }

    /**
     * The nightly runner passes mode=full for every scraper. For kanDigital
     * that selects a full pass over both lobbies and is what ran for 15 hours.
     * Incremental stays the default. --mode force-full or
     * KAN_DIGITAL_FORCE_FULL=1 still scrapes every listed series.
     */
    determineScrapeMode(mode) {
        if (mode === "force-full" || process.env.KAN_DIGITAL_FORCE_FULL === "1") return false;
        if (mode === "full") {
            this.logger.warn(
                "KanDigital => mode=full is the nightly runner's historical flag. " +
                "This run stays incremental. Pass --mode force-full to scrape every listed series."
            );
            return true;
        }
        return super.determineScrapeMode(mode);
    }

    /**
     * Main scraping logic - required by BaseScraper
     */
    async crawlContent() {
        await this.seedPreviousCatalog();

        await safeExecute(
            () => this.crawlVod(),
            "crawlContent.crawlVod",
            this.logger
        );

        await safeExecute(
            () => this.crawlKanBox(),
            "crawlContent.crawlKanBox",
            this.logger
        );

        // Log source summary
        this.logger.info('=== KanDigital Scraper - Source Summary ===');
        this.logger.info(`From Kan 11 lobby (digitalSeries): ${this._sourceCounts['kan11_lobby']} series`);
        this.logger.info(`From Kan-Box categories: ${this._sourceCounts['kan_box']} series`);
        this.logger.info(`Total unique series added: ${this._sourceCounts['total_unique']}`);
        this.logger.info(`Total series in JSON object: ${Object.keys(this._jsonObj).length}`);
        this.logger.info('===========================================');
    }

    /**
     * Previous catalog from the published ZIP (remote, then local). Used to
     * reuse episode rows and to keep release dates that only exist there.
     * Does not call Supabase.
     */
    async loadPreviousSeries() {
        this._previousById = new Map();
        if (this.previousCatalogOverride === null) return;
        try {
            let loaded = this.previousCatalogOverride;
            if (loaded === undefined) {
                loaded = await loadPreviousCatalog(this.getExportFilename(), {
                    logger: this.logger,
                    remote: this.previousCatalogRemote
                });
                this.previousCatalogCache = loaded;
            }
            const data = loaded && loaded.data;
            if (!data) return;
            for (const [id, series] of Object.entries(data)) {
                if (series && series.meta && Array.isArray(series.meta.videos)) {
                    this._previousById.set(id, series);
                }
            }
            this.logger.info(`KanDigital previous catalog: ${this._previousById.size} series`);
        } catch (error) {
            this.logger.warn(`KanDigital previous catalog unavailable: ${error.message}`);
        }
    }

    /**
     * Start from the previous published catalog. Series the budget never
     * reaches, and series that are no longer in either lobby, stay in the
     * object that gets published. A later successful scrape replaces its row.
     */
    async seedPreviousCatalog() {
        await this.loadPreviousSeries();
        const loaded = this.previousCatalogOverride !== undefined
            ? this.previousCatalogOverride
            : this.previousCatalogCache;
        if (loaded && !this.previousCatalogCache) this.previousCatalogCache = loaded;
        const data = loaded && loaded.data;
        if (!data || typeof data !== "object") return 0;
        const copy = {};
        for (const [id, series] of Object.entries(data)) {
            if (!series || typeof series !== "object" || Array.isArray(series)) continue;
            if (!series.meta && series.id == null && series.name == null) continue;
            copy[id] = JSON.parse(JSON.stringify(series));
        }
        this._jsonObj = copy;
        this._seededIds = new Set(Object.keys(copy));
        this.logger.info(`KanDigital seeded ${this._seededIds.size} series from the previous catalog`);
        return this._seededIds.size;
    }

    refreshIntervalDays() {
        const config = INCREMENTAL_SCRAPING.KanDigitalScraper || {};
        return config.forceRefreshDays || INCREMENTAL_SCRAPING.forceRefreshDays || 3;
    }

    shouldReuseCachedSeries(seriesId) {
        if (!this.incrementalMode || this.scrapeMode === "full") return false;
        const previous = this.previousVideosFor(seriesId);
        if (!previous || !previous.length) return false;
        if (!this._jsonObj[seriesId]) return false;
        return !seriesDueForRefresh(seriesId, {
            now: this.refreshClock || new Date(),
            forceRefreshDays: this.refreshIntervalDays()
        });
    }

    noteHandled(seriesId) {
        if (!this._handledThisRun) this._handledThisRun = new Set();
        this._handledThisRun.add(seriesId);
    }

    alreadyHandled(seriesId) {
        return !!(this._handledThisRun && this._handledThisRun.has(seriesId));
    }

    previousVideosFor(seriesId) {
        const series = this._previousById && this._previousById.get(seriesId);
        return series && series.meta && series.meta.videos;
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
                // Extract the JSON array using bracket counting for robustness
                // This correctly handles nested objects and arrays
                const arrayStartIndex = scriptContent.indexOf('digitalSeries:') + 'digitalSeries:'.length;
                if (arrayStartIndex >= 0) {
                    const afterKey = scriptContent.substring(arrayStartIndex).trim();

                    if (afterKey.startsWith('[')) {
                        let bracketCount = 0;
                        let inString = false;
                        let escapeNext = false;
                        let endIdx = -1;

                        for (let i = 0; i < afterKey.length; i++) {
                            const ch = afterKey[i];

                            if (escapeNext) {
                                escapeNext = false;
                                continue;
                            }

                            if (ch === '\\') {
                                escapeNext = true;
                                continue;
                            }

                            if (ch === '"' && !escapeNext) {
                                inString = !inString;
                                continue;
                            }

                            if (!inString) {
                                if (ch === '[') {
                                    bracketCount++;
                                } else if (ch === ']') {
                                    bracketCount--;
                                    if (bracketCount === 0) {
                                        endIdx = i + 1;
                                        break;
                                    }
                                }
                            }
                        }

                        if (endIdx > 0) {
                            let rawJsonString = afterKey.substring(0, endIdx);

                            // Parse it
                            items = JSON.parse(rawJsonString);

                            logger.info(`Success! Found ${items.length} Digital Series items (via bracket counting).`);

                            // Warn if pagination detected
                            if (items.length === 100 || items.length === 50 || items.length === 20) {
                                logger.warn(`⚠️  Found exactly ${items.length} series - this might be a pagination limit`);
                                logger.warn(`⚠️  Last series ID: ${items[items.length - 1]?.Url || 'unknown'}`);
                            }
                        } else {
                            logger.error('Could not find closing bracket for digitalSeries array');
                        }
                    } else {
                        logger.error('digitalSeries key does not point to an array');
                    }
                }
            } catch (error) {
                logger.error(`Failed to parse digitalSeries JSON: ${error.message}`);
                logger.error("The website structure might have changed");
            }
        } else {
             logger.error("Could not find a script containing 'digitalSeries: [' - website structure may have changed");
        }

        // Process series using batch processor
        logger.info(`crawlVod => Found ${items.length} digital series to process`);
        await this.processBatch(
            items,
            async (item, index) => {
                return await this.processOneDigitalSeries(item, 'kan11_lobby');
            },
            "digital-series"
        );

        logger.trace("crawl() => Exiting");
    }

    /***********************************************************
     *
     * Kan-Box handling
     *
     ***********************************************************/
    async crawlKanBox(){
        logger.trace("crawlKanBox => Entering");
        logger.info("crawlKanBox => Starting Kan-Box scraping");

        try {
            // Fetch Kan-Box lobby page. Cards are a.cr-item inside content rows;
            // each href is trimmed to the series root before we visit it.
            logger.info(`crawlKanBox => Fetching: ${KAN_BOX_URL}`);
            const response = await fetchData(KAN_BOX_URL, false);
            if (!response) {
                throw new Error("empty Kan-Box response");
            }

            const entries = parseKanBoxLobby(response);
            const categoryNames = new Set(entries.map((entry) => entry.category));
            logger.info(`crawlKanBox => Found ${entries.length} series rows in ${categoryNames.size} categories`);

            // Ignore list matches the section heading. A series that also appears
            // under a category we keep is still scraped.
            const categoriesToScrape = selectLobbySeries(entries, KAN_BOX_IGNORE_LIST);
            const ignoredRows = entries.filter((entry) => KAN_BOX_IGNORE_LIST.includes(entry.category)).length;

            logger.info(`crawlKanBox => Ignored category rows: ${ignoredRows}`);
            logger.info(`crawlKanBox => To scrape: ${categoriesToScrape.length} series`);

            let totalSeriesFound = 0;
            let duplicateCount = 0;

            for (const entry of categoriesToScrape) {
                const fullSeriesUrl = entry.seriesUrl;
                if (!fullSeriesUrl) continue;

                const seriesId = utils.generateSeriesId(fullSeriesUrl, SUB_PREFIX);

                // Seeded catalog rows are not duplicates. Skip only a series
                // the Kan 11 lobby already handled in this run.
                if (this.alreadyHandled(seriesId)) {
                    logger.debug(`crawlKanBox => Duplicate found: ${seriesId} - skipping`);
                    this.deltaTracker.skipSeries();
                    duplicateCount++;
                    continue;
                }

                const item = {
                    Url: fullSeriesUrl,
                    Image: '',
                    ImageAlt: '',
                    TitleHint: '',
                    Description: `From Kan-Box category: ${entry.category}`
                };

                try {
                    const result = await this.processOneDigitalSeries(item, 'kan_box');
                    if (result) {
                        totalSeriesFound++;
                        logger.info(`crawlKanBox => Added series from ${entry.category}: ${result.title}`);
                    }
                } catch (error) {
                    rethrowIfKanBlocked(error);
                    logger.error(`crawlKanBox => Error processing series ${fullSeriesUrl}: ${error.message}`);
                }
            }

            logger.info(`crawlKanBox => Completed scraping`);
            logger.info(`crawlKanBox => Total new series added: ${totalSeriesFound}`);
            logger.info(`crawlKanBox => Total duplicates skipped: ${duplicateCount}`);

        } catch (error) {
            logger.error(`crawlKanBox => Fatal error: ${error.message}`);
            throw error;
        }

        logger.trace("crawlKanBox => Exiting");
    }

    /**
     * Process a single digital series (extracted from crawlVod for batch processing)
     */
    async processOneDigitalSeries(item, source = 'kan11_lobby') {
        let title = getNameFromSeriesPage(item.ImageAlt || ''); // Clean image artifacts from name
        let pageUrl = item.Url; //URL of the series episodes
        let description = item.Description;

        //set the series URL
        if (pageUrl == undefined) {
            logger.debug("processOneDigitalSeries => No pageUrl, skipping");
            return null;
        }
        if (pageUrl.includes("kan-actual")){
            logger.debug("processOneDigitalSeries => Skipping news item");
            return null;
        }
        if (pageUrl.includes("archive")){
            logger.debug("processOneDigitalSeries => Skipping archive item");
            return null;
        }
        if (pageUrl.includes("podcasts")){
            logger.debug("processOneDigitalSeries => Skipping podcast item");
            return null;
        }
        if ((! pageUrl.includes("/content/kan/")) && (! pageUrl.includes("dig/digital"))) {
            logger.debug("processOneDigitalSeries => URL doesn't match digital series pattern");
            return null;
        }
        if (pageUrl.startsWith("/")) { pageUrl = KAN_URL_ADDRESS + pageUrl; }

        var id = utils.generateSeriesId(pageUrl, SUB_PREFIX);
        var imgUrl = KAN_DIGITAL_IMAGE_PREFIX + item.Image;
        this.noteHandled(id);

        if (this.shouldReuseCachedSeries(id)) {
            const cached = this._jsonObj[id];
            const cachedName = (cached && cached.name) || title;
            const cachedCount = cached && cached.meta && cached.meta.videos ? cached.meta.videos.length : 0;
            logger.info(`processOneDigitalSeries => Keeping ${cachedCount} cached episodes for ${cachedName || id}`);
            this.deltaTracker.skipSeries();
            return { id, title: cachedName, source, cached: true };
        }

        //get the doc of the series
        var seriesPageDoc;
        try{
            seriesPageDoc = await fetchData(`${pageUrl}?page=1&itemsToShow=1000`);
        } catch (e){
            rethrowIfKanBlocked(e);
            logger.error(`processOneDigitalSeries => could not retrieve series page doc from URL ${pageUrl}. Error: ${e}`);
            return null;
        }
        if (!seriesPageDoc || pageIsChallenge(seriesPageDoc)) {
            logger.warn(`processOneDigitalSeries => series page unavailable for ${pageUrl}; keeping seeded episodes`);
            return null;
        }

        // Extract image from series page if not provided or if the image URL is incomplete
        // NOTE: All img.img-fluid on KAN series pages are brand logo SVGs, never posters.
        // The series poster is NOT in any <img> element - use og:image meta tag instead.
        if (!item.Image || item.Image === '') {
            // Primary: og:image meta tag (available on all series pages, share-image quality)
            const ogImgMeta = seriesPageDoc.querySelector('meta[property="og:image"]');
            if (ogImgMeta && ogImgMeta.getAttribute('content')) {
                const ogContent = ogImgMeta.getAttribute('content');
                if (ogContent && !ogContent.includes('brandlogo') && !ogContent.includes('.svg')) {
                    imgUrl = utils.getImageFromUrl(ogContent, SUBTYPE);
                    logger.debug(`processOneDigitalSeries => Got image from og:image: ${imgUrl}`);
                }
            }
            // Fallback: twitter:image if og:image was not suitable
            if (!imgUrl || imgUrl === KAN_DIGITAL_IMAGE_PREFIX || imgUrl.includes('brandlogo') || imgUrl.includes('.svg')) {
                const twImgMeta = seriesPageDoc.querySelector('meta[name="twitter:image"]');
                if (twImgMeta && twImgMeta.getAttribute('content')) {
                    const twContent = twImgMeta.getAttribute('content');
                    if (twContent && !twContent.includes('brandlogo') && !twContent.includes('.svg')) {
                        imgUrl = utils.getImageFromUrl(twContent, SUBTYPE);
                        logger.debug(`processOneDigitalSeries => Got image from twitter:image: ${imgUrl}`);
                    }
                }
            }
        }

        //verify there is a name to the series - cascading fallback selectors
        if (title.trim() == ""){
            logger.info("processOneDigitalSeries => Title is empty. Attempting to retrieve it");
            
            // Try TitleHint from lobby page image data first (zero cost - already have it)
            if (item.TitleHint && item.TitleHint.trim()) {
                title = getNameFromSeriesPage(item.TitleHint);
                logger.debug("processOneDigitalSeries => Got title from TitleHint (lobby image)");
            }
        }
        if (title.trim() == ""){
            // Fallback 1: img.img-fluid title attribute
            const imgFluid = seriesPageDoc.querySelector("img.img-fluid");
            if (imgFluid && imgFluid.getAttribute("title")){
                title = getNameFromSeriesPage(imgFluid.getAttribute("title"));
                logger.debug("processOneDigitalSeries => Got title from img.img-fluid title attr");
            }
        }
        if (title.trim() == ""){
            // Fallback 2: h2.title.h1
            const h2title = seriesPageDoc.querySelector("h2.title.h1");
            if (h2title){
                title = getNameFromSeriesPage(h2title.text.trim());
                logger.debug("processOneDigitalSeries => Got title from h2.title.h1");
            }
        }
        if (title.trim() == ""){
            // Fallback 3: og:title meta tag
            const ogTitle = seriesPageDoc.querySelector('meta[property="og:title"]');
            if (ogTitle && ogTitle.getAttribute("content")){
                title = getNameFromSeriesPage(ogTitle.getAttribute("content"));
                logger.debug("processOneDigitalSeries => Got title from og:title");
            }
        }
        if (title.trim() == ""){
            // Fallback 4: h1 tag
            const h1 = seriesPageDoc.querySelector("h1");
            if (h1 && h1.text && h1.text.trim()){
                title = getNameFromSeriesPage(h1.text.trim());
                logger.debug("processOneDigitalSeries => Got title from h1");
            }
        }
        if (title.trim() == ""){
            // Fallback 5: <title> tag (clean up site name suffix)
            const titleTag = seriesPageDoc.querySelector("title");
            if (titleTag && titleTag.text){
                let raw = titleTag.text.trim();
                // Remove common suffixes like " | כאן" or " - Kan"
                raw = raw.split(/\s*[|\-–—]\s*(כאן|Kan|KAN)\s*$/i)[0] || raw;
                if (raw.trim()) {
                    title = getNameFromSeriesPage(raw.trim());
                    logger.debug("processOneDigitalSeries => Got title from <title> tag");
                }
            }
        }

        //set series genres
        const genres = this.setGenre(seriesPageDoc.querySelector("div.info-genre"));
        const pageMeta = parseSeriesMeta(seriesPageDoc);
        if (pageMeta.description) description = pageMeta.description;

        // Episode title, number, image, and duration come from the season card.
        // The episode page is not fetched: release date is not on the card, so
        // it is copied from the previous catalog when the episode URL is known
        // and left blank for new episodes. Streams stay empty and resolve on play.
        const parsedSeries = parseSeriesPage(seriesPageDoc, pageUrl);
        const previousVideos = this.previousVideosFor(id);
        const seasonUrls = seasonUrlsToFetch(seriesPageDoc, pageUrl, parsedSeries);
        const plan = (this.incrementalMode && previousVideos && previousVideos.length)
            ? planSeriesRefresh(previousVideos, parsedSeries.episodes, parsedSeries.seasonUrls)
            : { reuse: false, seasonUrls, keepUnseenSeasons: false };

        var videoObj = [];
        if (plan.reuse) {
            videoObj = previousVideos.map((video) => Object.assign({}, video));
            logger.info(`processOneDigitalSeries => Reusing ${videoObj.length} episodes for ${title || pageUrl} (series page unchanged)`);
        } else {
            const collected = await this.collectDigitalEpisodes(
                seriesPageDoc,
                pageUrl,
                parsedSeries,
                title,
                plan.seasonUrls
            );
            const episodes = collected.episodes || [];
            let scraped = [];
            if (episodes.length > 0) {
                scraped = carryPreviousEpisodeFields(this.videosFromParsedEpisodes(episodes, id), previousVideos);
                if (plan.keepUnseenSeasons && previousVideos) {
                    const rebuilt = new Set(scraped.map((video) => Number(video.season)));
                    for (const previous of previousVideos) {
                        if (!rebuilt.has(Number(previous.season))) scraped.push(Object.assign({}, previous));
                    }
                }
            } else if (parsedSeries.movieUrl) {
                const movie = videoFromMovieCard(parsedSeries.movieUrl, id, title, description, imgUrl);
                scraped = movie ? carryPreviousEpisodeFields([movie], previousVideos) : [];
            }
            const before = scraped.length;
            videoObj = mergeSeededVideos(scraped, previousVideos, {
                failedSeasons: collected.failedSeasons
            });
            if (previousVideos && videoObj.length > before) {
                logger.warn(
                    `processOneDigitalSeries => Parsed ${before} episodes for ${title || id}; ` +
                    `kept seeded episodes the page did not return (${videoObj.length} now)`
                );
            }
        }

        if (videoObj.length === 0 && !plan.reuse) {
            logger.debug("processOneDigitalSeries => No video button found, skipping");
            return null;
        }
        if ((videoObj == null) || (videoObj.length == 0)){
            logger.warn(`processOneDigitalSeries => could not find videos for series ${title} @ URL ${pageUrl}`);
            return null;
        } else {
            // last minute checks before add the series
            //check that we have a valid name for the series

            this.recordSeriesDelta(id, title, videoObj.length);
            this.addToJsonObject(id, title, pageUrl, imgUrl,description,genres,videoObj,SUBTYPE,"series");
            // Track which source this series came from
            this._sourceCounts[source] = (this._sourceCounts[source] || 0) + 1;
            this._sourceCounts['total_unique'] += 1;
            logger.info(`processOneDigitalSeries => [SOURCE: ${source}] Added series: ${title} (URL: ${pageUrl})`);
            return { id, title, source };
        }
    }

    /**
     * Episodes already on the series page, plus any season page that is not
     * already covered by a div.seasons-item. Season pages are read once.
     */
    async collectDigitalEpisodes(seriesPageDoc, pageUrl, parsedSeries, title, seasonUrlsOverride) {
        const episodes = [];
        const seen = new Set();
        const addEpisodes = (list) => {
            for (const episode of list || []) {
                if (!episode || !episode.url || seen.has(episode.url)) continue;
                seen.add(episode.url);
                episodes.push(episode);
            }
        };
        addEpisodes(parsedSeries.episodes);

        // An explicit list, including [], is the refresh plan. Undefined
        // falls back to every season page that is not already on this document.
        const seasonUrls = seasonUrlsOverride != null
            ? seasonUrlsOverride
            : seasonUrlsToFetch(seriesPageDoc, pageUrl, parsedSeries);
        const failedSeasons = [];

        if (seasonUrls.length > 0) {
            const seasonLabels = seasonUrls.map((url) => {
                const match = String(url).match(/\/(s\d+)\/?$/);
                return match ? match[1] : url;
            });
            logger.info(`processOneDigitalSeries => Fetching ${seasonUrls.length} season page(s) for ${title}: ${seasonLabels.join(", ")}`);
        }

        for (const seasonUrl of seasonUrls) {
            let fetchUrl = seasonUrl;
            if (fetchUrl.startsWith("/")) {
                fetchUrl = KAN_DIGITAL_IMAGE_PREFIX + fetchUrl;
            }
            fetchUrl = fetchUrl.split("?")[0];
            logger.info(`processOneDigitalSeries => Fetching season page: ${fetchUrl}`);
            const seasonNo = seasonNumberFromUrl(seasonUrl);
            try {
                const seasonDoc = await fetchData(`${fetchUrl}?page=1&itemsToShow=1000`);
                if (!seasonDoc || pageIsChallenge(seasonDoc)) {
                    if (seasonNo != null) failedSeasons.push(seasonNo);
                    logger.warn(`processOneDigitalSeries => Season page unavailable, keeping seeded episodes: ${fetchUrl}`);
                    continue;
                }
                const seasonParsed = parseSeriesPage(seasonDoc, pageUrl || fetchUrl);
                addEpisodes(seasonParsed.episodes);
            } catch (error) {
                rethrowIfKanBlocked(error);
                if (seasonNo != null) failedSeasons.push(seasonNo);
                logger.error(`processOneDigitalSeries => Error fetching season ${fetchUrl}: ${error.message}`);
            }
        }

        return { episodes, failedSeasons };
    }

    recordSeriesDelta(seriesId, title, videoCount) {
        const payload = { name: title || "", videoCount };
        if (this._seededIds && this._seededIds.has(seriesId)) {
            this.deltaTracker.addUpdatedSeries(seriesId, payload);
        } else {
            this.deltaTracker.addNewSeries(seriesId, payload);
        }
    }

    /**
     * Turn parsed episode cards into video objects. Season numbers come from
     * the /sN/ path. Episode numbers come from the card title when it says
     * "פרק N", otherwise from the legacy newest-first position.
     */
    videosFromParsedEpisodes(episodes, id) {
        const jobs = numberDigitalEpisodes(episodes);
        const videosArr = [];
        for (const job of jobs) {
            const video = videoFromEpisodeCard(job, id);
            if (!video) continue;
            videosArr.push(video);
            logger.info(`Added: S${video.season} E${video.episode} - ${video.name}`);
        }
        logger.debug(`getVideos => ${videosArr.length} episode(s) from series cards for ${id}`);
        return videosArr;
    }

    /**********************************************************
     * receive the video elements with ID of series and
     * retrieve the list of videos and streams
     * @param {*} videosElems
     * @param {*} id
     * @returns Array of video json objects
     *********************************************************/
    async getVideos(videosElems, id){
        const episodes = [];
        const seen = new Set();
        const elements = videosElems || [];
        logger.info(`getVideos => Processing ${elements.length} season element(s) for series ID: ${id}`);

        for (const element of elements) {
            const parsed = parseSeriesPage(element && element.toString ? element.toString() : "", "");
            for (const episode of parsed.episodes) {
                if (!episode.url || seen.has(episode.url)) continue;
                seen.add(episode.url);
                episodes.push(episode);
            }
        }

        return this.videosFromParsedEpisodes(episodes, id);
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

    static seriesDueForRefresh(seriesId, options) {
        return seriesDueForRefresh(seriesId, options);
    }
}


/**********************************************************
 * Module Exports
 **********************************************************/
module.exports = KanDigitalScraper;


// Run scraper if executed directly
if (require.main === module) {
    require('dotenv').config({ path: './classes/.env' });
    const scraper = new KanDigitalScraper();

    scraper.crawl().catch(error => {
        logger.error('Fatal error:', error);
        process.exit(1);
    });
}
