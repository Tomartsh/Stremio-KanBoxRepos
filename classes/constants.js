module.exports = {
    UPDATE_LIST: true, // update the series list as well as creating the JSON object
    
    // Rate Limiting Configuration (per domain)
    RATE_LIMITING: {
        DEFAULT_MIN_INTERVAL: 1000,        // 1 second between requests (default)
        DEFAULT_MAX_PER_MINUTE: 180,        // 180 requests per minute (default)
        
        // Domain-specific overrides
        // NOTE: More specific domains should come first (mass.mako.co.il before mako.co.il)
        'mass.mako.co.il': {
            minInterval: 500,              // 0.5 second between mass.mako requests (entitlement service)
            maxPerMinute: 120                // 120 requests per minute (very conservative)
        },
        'mako.co.il': {
            minInterval: 50,              // 0.05 seconds between Mako requests
            maxPerMinute: 180                // 180 Mako requests per minute
        },
        'kan.org.il': {
            minInterval: 50,              // 0.05 seconds between Kan requests
            maxPerMinute: 250                // 250 Kan requests per minute
        },
        '13tv.co.il': {
            minInterval: 50,              // 0.05 seconds between Reshet requests
            maxPerMinute: 250                // 250 Reshet requests per minute
        }
    },

    // Fetch Method Configuration
    FETCH_METHOD_CONFIG: {
        // Domains that should NEVER switch from axios to got-scraping
        // (got-scraping gets blocked harder on these)
        AXIOS_ONLY_DOMAINS: [
            'mass.mako.co.il'
        ],
        
        // Domains that benefit from switching to got-scraping on errors
        PREFERS_GOT_SCRAPING: [
            'kan.org.il',
            'kankids.org.il'
        ],
        RETRY_DELAY: 15000,//default delay between requests
        REQUEST_TIMEOUT: 7000,
        MAX_RETRIES: 5,  
        MAX_CONCURRENT_REQUESTS: 2
    },
    
    LOG4JS: {
        LEVEL: "debug",
        MAX_SIZE: 10  * 1024 * 1024, // = 5Mb
        BACKUP_FILES: 3, // keep 5 backup files'
        FILENAME: "logs/Stremio-Repos.log",
        TYPE: "file"
    },

    SAVE_MODE: "github", // "local", "github", or "both"
    SAVE_FOLDER: "output",
    PREFIX: "il_",
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
    URLS_ASSETS_BASE: "https://tomartsh.github.io/Stremio-KanBoxRepos/assets/",

    //Kan constants
    KAN_URL_ADDRESS: "https://www.kan.org.il/lobby/kan11",
    KAN_ARCHIVE_URL_ADDRESS: "https://www.kan.org.il/lobby/series/",
    KAN_DIGITAL_IMAGE_PREFIX: "https://www.kan.org.il",
    KAN_BASE_URL: "https://www.kan.org.il",
    
    HINUKHIT: {
        URL_TINY: "https://www.kankids.org.il/lobby-kids/tiny/",
        URL_TEENS: "https://www.kankids.org.il/lobby-kids/kids-teens",
        URL_KIDS_CONTENT_PREFIX: "https://www.kankids.org.il",
        SUBPREFIX_KIDS: "kids",
        SUBPREFIX_TEENS: "teens"
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
    KNESSET_URL_TV: "https://www.knesset.tv"
};