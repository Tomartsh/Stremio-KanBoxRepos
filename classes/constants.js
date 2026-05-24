module.exports = {
    // Rate Limiting Configuration (per domain)
    RATE_LIMITING: {
        DEFAULT_MIN_INTERVAL: 0,
        DEFAULT_MAX_PER_MINUTE: 1000,
        DEFAULT_JITTER: [10, 50],  // ← Add default jitter range [min, max]
        
        'mass.mako.co.il': {
            minInterval: 50,
            maxPerMinute: 200,
            jitter: [10, 100]  // ← 10-100ms jitter for Mako entitlement
        },
        'mako.co.il': {
            minInterval: 50,
            maxPerMinute: 300,
            jitter: [10, 100]   // ← 10-100ms jitter for Mako
        },
        'kan.org.il': {
            minInterval: 2000,       // 2 seconds minimum between requests (very airy)
            maxPerMinute: 25,        // Max 25 requests per minute (extremely conservative)
            jitter: [1000, 4000]     // Random 1-4 second jitter to appear human
        },
        '13tv.co.il': {
            minInterval: 0,
            maxPerMinute: 1000,
            jitter: [0, 0]      // ← NO jitter for Reshet
        }
    },

    // Fetch Method Configuration
    FETCH_METHOD_CONFIG: {
        // Domains that should NEVER switch from axios to got-scraping
        // (got-scraping gets blocked harder on these)
        AXIOS_ONLY_DOMAINS: [
            'mass.mako.co.il',
            'mako.co.il'  // Mako works better with axios
        ],

        // Domains that benefit from switching to got-scraping on errors
        PREFERS_GOT_SCRAPING: [
            'kan.org.il',      // Lobby/series pages work fine with got-scraping
            'kankids.org.il'   // Kids site also works with got-scraping
        ],

        RETRY_DELAY: 15000,        // Default delay between retry attempts
        REQUEST_TIMEOUT: 30000,    // 30 second timeout for requests
        MAX_RETRIES: 5,            // Maximum retry attempts
        MAX_CONCURRENT_REQUESTS: 10
    },

    // Scraper-Specific Configuration for Parallel Fetching
    //
    // IMPORTANT: These settings are tuned to avoid 403/rate limiting errors
    // - parallelFetching: true=parallel batches, false=sequential processing
    // - batchSize: Number of items to process in parallel (when parallelFetching=true)
    // - delayBetweenBatches: Delay in ms between batches (exponential backoff on errors)
    // - requestsPerSecond: Rate limiter setting (1-3 recommended for most sites)
    // - circuitBreakerThreshold: Consecutive failures before pausing (default: 5)
    // - circuitBreakerTimeout: Time in ms to pause after threshold (default: 60000 = 1min)
    //
    SCRAPER_CONFIG: {
        // Default behavior for all scrapers (conservative to avoid 403s)
        DEFAULT_PARALLEL_FETCHING: true,
        DEFAULT_BATCH_SIZE: 25,
        DEFAULT_DELAY_BETWEEN_BATCHES: 500, // 0.5 second delay between batches

        // Per-scraper overrides
        'KanArchiveScraper': {
            parallelFetching: false,       // Sequential - Kan Archive is sensitive
            batchSize: 5,                  // Conservative batch size
            delayBetweenBatches: 1000,     // 1s delay between requests
            requestsPerSecond: 1,          // Very conservative - old site infrastructure
            circuitBreakerThreshold: 3,    // Quick pause on failures
            circuitBreakerTimeout: 120000  // 2 minute pause after failures
        },

        'KanPodcastsScraper': {
            parallelFetching: false,       // Sequential - Cloudflare protected
            batchSize: 1,                  // Process one series at a time (extremely airy)
            delayBetweenBatches: 5000,     // 5s delay between series
            requestsPerSecond: 0.3,        // 1 request every 3+ seconds
            circuitBreakerThreshold: 2,    // Very quick pause on failures
            circuitBreakerTimeout: 300000  // 5 minute pause after failures
        },

        'Kan88Scraper': {
            parallelFetching: false,       // Sequential - Cloudflare protected
            batchSize: 5,                  // Small batch size
            delayBetweenBatches: 1000,     // 1s delay between requests
            requestsPerSecond: 1,          // Very conservative
            circuitBreakerThreshold: 3
        },

        'KanDigitalScraper': {
            parallelFetching: false,       // Sequential - recent issues with bans
            batchSize: 5,                  // Small batch size
            delayBetweenBatches: 1000,     // 1s delay between requests
            requestsPerSecond: 2,
            circuitBreakerThreshold: 5
        },

        'KanKidsScraper': {
            parallelFetching: false,       // Sequential - moderate protection
            batchSize: 10,                 // Medium batch size
            delayBetweenBatches: 500,      // 0.5s delay between requests
            requestsPerSecond: 2,
            circuitBreakerThreshold: 5
        },

        'KanTeensScraper': {
            parallelFetching: false,       // Sequential - moderate protection
            batchSize: 10,                 // Medium batch size
            delayBetweenBatches: 500,      // 0.5s delay between requests
            requestsPerSecond: 2,
            circuitBreakerThreshold: 5
        },

        'ReshetScraper': {
            parallelFetching: true,        // Can handle parallel requests
            batchSize: 15,                 // Larger batch size
            delayBetweenBatches: 1000,     // 1s delay between requests
            requestsPerSecond: 3,          // Higher rate limit tolerance
            circuitBreakerThreshold: 5
        }

        // Other scrapers will use defaults (sequential) unless specified here
    },
    
    LOG4JS: {
        LEVEL: "debug",
        MAX_SIZE: 10 * 1024 * 1024,  // 10MB max log file size
        BACKUP_FILES: 3,              // Keep 3 backup files
        FILENAME: "logs/Stremio-Repos.log",
        TYPE: "file"
    },

    SAVE_MODE: "github", // "local", "github", or "both"
    SAVE_FOLDER: "output",
    PREFIX: "il_",

    // Database Update Configuration
    WRITE_TO_GITHUB: true,     // Write JSON files to GitHub after scraping
    UPDATE_DATABASE: true,     // Update database after scraping

    // Incremental Scraping Configuration
    INCREMENTAL_SCRAPING: {
        enabled: true,         // Master switch - ENABLED to reduce 403s
        forceRefreshDays: 7,   // Re-scrape series older than X days

        // Per-scraper configuration
        // Only enabled scrapers will use incremental mode by default
        // All scrapers support incremental mode via URL parameter: &mode=incremental
        'KanDigitalScraper': {
            enabled: true,           // ENABLED - needs it due to HTTP 403 blocking
            forceRefreshDays: 3      // Refresh more frequently
        },
        'KanPodcastsScraper': {
            enabled: true,           // ENABLED - needs it due to size (266 series, thousands of episodes)
            forceRefreshDays: 3      // Refresh more frequently
        },
        'Kan88Scraper': {
            enabled: true,           // ENABLED - Cloudflare protection, benefits from reduced requests
            forceRefreshDays: 3      // Refresh more frequently
        }
        // All other scrapers default to enabled: false
        // Can be overridden via URL parameter: &mode=incremental or &mode=full
    },
    HEADERS: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Accept-Encoding': 'gzip, deflate, br, zstd',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Priority': 'u=0, i'
    },
    
    URL_JSON_BASE: "https://tomartsh.github.io/Stremio-KanBoxRepos/output/", 
    URLS_ASSETS_BASE: "https://raw.githubusercontent.com/tomartsh/Stremio-KanBoxAddon/main/assets/",

    //Kan constants
    KAN_URL_ADDRESS: "https://www.kan.org.il/lobby/kan11",
    KAN_DIGITAL_IMAGE_PREFIX: "https://www.kan.org.il",
    KAN_BASE_URL: "https://www.kan.org.il",

    // Kan-Box constants
    KAN_BOX_URL: 'https://www.kan.org.il/lobby/kan-box/',
    KAN_BOX_IGNORE_LIST: [
        'הליגה הלאומית',
        'דוקו מהארכיון',
        'בידור ואירוח מהארכיון',
        'ילדים ונוער מהארכיון',
        'תרבות ופנאי מהארכיון',
        'קומדיה וסאטירה מהארכיון',
        'אוצרות הארכיון',
        'ילדים ונוער'
    ],
    
    KAN_ARCHIVE: {
        IMAGE_PREFIX: "https://www.kan.org.il",
        URL_ADDRESS: "https://www.kan.org.il/lobby/series/",
    },

    HINUKHIT: {
        URL_TINY: "https://www.kankids.org.il/lobby-kids/tiny/",
        URL_TEENS: "https://www.kankids.org.il/lobby-kids/kids-teens",
        URL_KIDS_CONTENT_PREFIX: "https://www.kankids.org.il",
        SUBPREFIX_KIDS: "kids",
        SUBPREFIX_TEENS: "teens",
        // Kan-Box category for teens (single category to scrape)
        KAN_BOX_CATEGORY: 'ילדים ונוער'
    },

    KAN88_POCASTS_URL: "https://www.kan.org.il/content/kan/podcasts/kan88/",

    PODCASTS: {
        BASE_MOB_API: 'https://mobapi.kan.org.il/api/mobile/subClass',
        URL: "https://www.kan.org.il/lobby/podcasts-lobby/",
        KAN_CATEGORIES: "4451", 
        KAN_CHILDREN_CATEGORIES: "4562",
        SUBPREFIX: "podcasts",
        USER_AGENT: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    },

    //Mako constants (Keshet channel 12)
    MAKO: { 
        URL_VOD: "https://www.mako.co.il/mako-vod-index?platform=responsive",
        URL_BASE: "http://www.mako.co.il",
        URL_SUFFIX: "?platform=responsive",
        URL_SUFFIX_ALT: "?type=service",
        URL_EPISODE: (vcmid, channelId) => `https://www.mako.co.il/AjaxPage?jspName=playlist.jsp&vcmid=${vcmid}&videoChannelId=${channelId}&galleryChannelId=${vcmid}&isGallery=false&consumer=web_html5&encryption=no`,
        URL_ENTITLEMENT_SERVICES: "https://mass.mako.co.il/ClicksStatistics/entitlementsServicesV2.jsp",
    },

    //Channel 13 (Reshet) constants
    RESHET: {
        URL_VOD: "https://13tv.co.il/all-shows/all-shows-list/",
        URL_BASE: "https://13tv.co.il",
        HEADERS: {
            "accept": "*/*",
            "accept-language": "en",
            "content-type": "application/json",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "cross-site",
            "referrer": "https://13tv.co.il",
            "referrerPolicy": "strict-origin-when-cross-origin",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0"
        },
        PARTNER_ID: "2748741",
        URL_STREAM: "https://cdnapisec.kaltura.com/api_v3/service/multirequest"
    },

    
    //Sport5
    URL_SPORT5_VOD: "https://vod.sport5.co.il/HTML/External/VodCentertDS.txt",

    //Knesset
    KNESSET_URL_TV: "https://www.knesset.tv",

    //TMDB (The Movie Database) API
    TMDB: {
        API_KEY: process.env.TMDB_API_KEY || "",
        BASE_URL: "https://api.themoviedb.org/3",
        ENABLED: !!(process.env.TMDB_API_KEY && process.env.TMDB_API_KEY !== "your_tmdb_api_key_here"),
        SEARCH_ENDPOINT: "/search/tv",
        SERIES_ENDPOINT: "/tv",
        TIMEOUT: 10000, // 10 second timeout for TMDB requests
        LANGUAGE: "he" // Default to Hebrew for Israeli content
    }
};