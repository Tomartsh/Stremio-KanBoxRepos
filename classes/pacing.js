/**
 * Per-scraper pacing. Edit config/pacing.json; do not hardcode timings.
 *
 * Resolution order:
 *   1. defaults
 *   2. scrapers.<name>
 *   3. environment variables
 *   4. CLI / query overrides
 *
 * KAN_SLOW=0 or --no-slow drops back to defaults (then numeric overrides
 * still apply). KAN_SLOW=1 or --slow on a scraper that is not already slow
 * copies kanDigital's slow timings, then applies numeric overrides.
 */

const fs = require("fs");
const path = require("path");

const PACING_FILE = path.join(__dirname, "..", "config", "pacing.json");

const PACING_SCRAPERS = Object.freeze([
    "kanDigital",
    "kanTeens",
    "kanKids",
    "kan88",
    "kanArchive",
    "kanPodcasts",
    "mako",
    "reshet"
]);

const NUMERIC_FIELDS = Object.freeze([
    "minIntervalMs",
    "requestDelayMinMs",
    "requestDelayMaxMs",
    "pauseEveryPages",
    "pauseMinMs",
    "pauseMaxMs",
    "blockBackoffMinMs",
    "blockBackoffMaxMs",
    "budgetMs",
    "maxRetries",
    "maxPerMinute"
]);

const SLOW_PROFILE_FIELDS = Object.freeze([
    "minIntervalMs",
    "requestDelayMinMs",
    "requestDelayMaxMs",
    "pauseEveryPages",
    "pauseMinMs",
    "pauseMaxMs",
    "blockBackoffMinMs",
    "blockBackoffMaxMs",
    "budgetMs",
    "maxRetries"
]);

const ALLOWED_FIELDS = new Set([
    "slow",
    "governHttp",
    ...NUMERIC_FIELDS
]);

const SCRAPER_KEYS = {
    KanDigital: "kanDigital",
    KanTeens: "kanTeens",
    KanKids: "kanKids",
    Kan88: "kan88",
    KanArchive: "kanArchive",
    KanPodcasts: "kanPodcasts",
    Mako: "mako",
    Reshet: "reshet"
};

const FLAG_MAP = {
    "budget-hours": "budgetHours",
    "budget-ms": "budgetMs",
    "request-delay-min-ms": "requestDelayMinMs",
    "request-delay-max-ms": "requestDelayMaxMs",
    "min-interval-ms": "minIntervalMs",
    "pause-every-pages": "pauseEveryPages",
    "pause-min-ms": "pauseMinMs",
    "pause-max-ms": "pauseMaxMs",
    "block-backoff-min-ms": "blockBackoffMinMs",
    "block-backoff-max-ms": "blockBackoffMaxMs",
    "max-retries": "maxRetries",
    "max-per-minute": "maxPerMinute"
};

const QUERY_MAP = {
    slow: "slow",
    budgethours: "budgetHours",
    budgetms: "budgetMs",
    requestdelayminms: "requestDelayMinMs",
    requestdelaymaxms: "requestDelayMaxMs",
    minintervalms: "minIntervalMs",
    pauseeverypages: "pauseEveryPages",
    pauseminms: "pauseMinMs",
    pausemaxms: "pauseMaxMs",
    blockbackoffminms: "blockBackoffMinMs",
    blockbackoffmaxms: "blockBackoffMaxMs",
    maxretries: "maxRetries",
    maxperminute: "maxPerMinute",
    governhttp: "governHttp"
};

let cachedFile = null;

function pacingKeyFor(name) {
    if (!name) return "";
    if (SCRAPER_KEYS[name]) return SCRAPER_KEYS[name];
    const text = String(name);
    const known = PACING_SCRAPERS.find((key) => key.toLowerCase() === text.toLowerCase());
    return known || text;
}

function isPlainObject(value) {
    return !!value && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function merge(base, extra) {
    const out = clone(base);
    if (!extra) return out;
    for (const [key, value] of Object.entries(extra)) {
        if (value !== undefined) out[key] = value;
    }
    return out;
}

function invalid(message) {
    const error = new Error(`Invalid pacing config: ${message}`);
    error.code = "PACING_CONFIG";
    return error;
}

function parseBoolean(value, label) {
    if (typeof value === "boolean") return value;
    const text = String(value).trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(text)) return true;
    if (["0", "false", "no", "off"].includes(text)) return false;
    throw invalid(`${label} must be true or false`);
}

function parseRetries(value, label) {
    if (value == null || value === "") return null;
    const text = String(value).trim().toLowerCase();
    if (["unlimited", "null", "none", "infinite"].includes(text)) return null;
    if (typeof value === "number" && Number.isInteger(value) && value >= 0) return value;
    if (/^\d+$/.test(text)) return Number(text);
    throw invalid(`${label} must be a non-negative integer or "unlimited"`);
}

function parseMillis(value, label, { allowNull = false } = {}) {
    if (value == null || value === "") {
        if (allowNull) return null;
        throw invalid(`${label} is required`);
    }
    const number = typeof value === "number" ? value : Number(String(value).trim());
    if (!Number.isInteger(number) || number < 0) {
        throw invalid(`${label} must be a non-negative integer number of milliseconds`);
    }
    return number;
}

function assertRange(config, minKey, maxKey) {
    if (config[minKey] > config[maxKey]) {
        throw invalid(`${minKey} (${config[minKey]}) is greater than ${maxKey} (${config[maxKey]})`);
    }
}

function rejectUnknown(object, label) {
    if (!isPlainObject(object)) throw invalid(`${label} must be an object`);
    for (const key of Object.keys(object)) {
        if (!ALLOWED_FIELDS.has(key)) throw invalid(`${label} has unknown field "${key}"`);
    }
}

function validatePacingFile(file) {
    if (!isPlainObject(file)) throw invalid("root must be an object");
    if (!isPlainObject(file.defaults)) throw invalid("defaults section is required");
    if (!isPlainObject(file.scrapers)) throw invalid("scrapers section is required");
    rejectUnknown(file.defaults, "defaults");
    for (const key of ["slow", "minIntervalMs", "requestDelayMinMs", "requestDelayMaxMs", "pauseEveryPages", "pauseMinMs", "pauseMaxMs", "blockBackoffMinMs", "blockBackoffMaxMs", "maxRetries", "governHttp"]) {
        if (file.defaults[key] === undefined) throw invalid(`defaults.${key} is required`);
    }
    finalize(merge(file.defaults, {}), "defaults");

    const seen = new Set(Object.keys(file.scrapers));
    for (const name of PACING_SCRAPERS) {
        if (!seen.has(name)) throw invalid(`scrapers.${name} is required`);
    }
    for (const name of seen) {
        if (!PACING_SCRAPERS.includes(name)) throw invalid(`unknown scraper "${name}"`);
        rejectUnknown(file.scrapers[name], `scrapers.${name}`);
        finalize(merge(file.defaults, file.scrapers[name]), name);
    }
    return file;
}

function finalize(config, label) {
    const resolved = {
        slow: parseBoolean(config.slow, `${label}.slow`),
        governHttp: parseBoolean(config.governHttp, `${label}.governHttp`),
        minIntervalMs: parseMillis(config.minIntervalMs, `${label}.minIntervalMs`),
        requestDelayMinMs: parseMillis(config.requestDelayMinMs, `${label}.requestDelayMinMs`),
        requestDelayMaxMs: parseMillis(config.requestDelayMaxMs, `${label}.requestDelayMaxMs`),
        pauseEveryPages: parseMillis(config.pauseEveryPages, `${label}.pauseEveryPages`),
        pauseMinMs: parseMillis(config.pauseMinMs, `${label}.pauseMinMs`),
        pauseMaxMs: parseMillis(config.pauseMaxMs, `${label}.pauseMaxMs`),
        blockBackoffMinMs: parseMillis(config.blockBackoffMinMs, `${label}.blockBackoffMinMs`),
        blockBackoffMaxMs: parseMillis(config.blockBackoffMaxMs, `${label}.blockBackoffMaxMs`),
        budgetMs: parseMillis(config.budgetMs, `${label}.budgetMs`, { allowNull: true }),
        maxRetries: parseRetries(config.maxRetries, `${label}.maxRetries`),
        maxPerMinute: parseMillis(config.maxPerMinute, `${label}.maxPerMinute`, { allowNull: true })
    };
    if (config.budgetHours != null && config.budgetHours !== "") {
        const hours = Number(config.budgetHours);
        if (!Number.isFinite(hours) || hours <= 0) throw invalid(`${label}.budgetHours must be a positive number`);
        if (config.budgetMs == null) resolved.budgetMs = Math.round(hours * 60 * 60 * 1000);
    }
    assertRange(resolved, "requestDelayMinMs", "requestDelayMaxMs");
    assertRange(resolved, "pauseMinMs", "pauseMaxMs");
    assertRange(resolved, "blockBackoffMinMs", "blockBackoffMaxMs");
    if (resolved.budgetMs === 0) throw invalid(`${label}.budgetMs must be null or a positive duration`);
    if (resolved.maxPerMinute === 0) throw invalid(`${label}.maxPerMinute must be null or a positive integer`);
    if (!resolved.slow && resolved.maxRetries == null) resolved.maxRetries = 1;
    if (resolved.slow && resolved.maxRetries == null && resolved.budgetMs == null) {
        throw invalid(`${label} slow mode needs a budget or maxRetries, otherwise a 403 retry loop never ends`);
    }
    return resolved;
}

function loadPacingFile(filePath = PACING_FILE) {
    let parsed;
    try {
        parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
        throw invalid(`could not read ${filePath} (${error.message})`);
    }
    return validatePacingFile(parsed);
}

function getPacingFile() {
    if (!cachedFile) cachedFile = loadPacingFile();
    return cachedFile;
}

function slowProfile(file) {
    const digital = (file.scrapers && file.scrapers.kanDigital) || {};
    const profile = { slow: true };
    for (const key of SLOW_PROFILE_FIELDS) {
        if (digital[key] !== undefined) profile[key] = digital[key];
    }
    return profile;
}

function overridesFromEnv(env) {
    const out = {};
    if (!env) return out;
    if (env.KAN_SLOW != null && env.KAN_SLOW !== "") out.slow = env.KAN_SLOW;
    if (env.KAN_GOVERN_HTTP != null && env.KAN_GOVERN_HTTP !== "") out.governHttp = env.KAN_GOVERN_HTTP;
    const numeric = {
        KAN_MIN_INTERVAL_MS: "minIntervalMs",
        KAN_REQUEST_DELAY_MIN_MS: "requestDelayMinMs",
        KAN_REQUEST_DELAY_MAX_MS: "requestDelayMaxMs",
        KAN_PAUSE_EVERY_PAGES: "pauseEveryPages",
        KAN_PAUSE_MIN_MS: "pauseMinMs",
        KAN_PAUSE_MAX_MS: "pauseMaxMs",
        KAN_BLOCK_BACKOFF_MIN_MS: "blockBackoffMinMs",
        KAN_BLOCK_BACKOFF_MAX_MS: "blockBackoffMaxMs",
        KAN_BUDGET_MS: "budgetMs",
        KAN_MAX_RETRIES: "maxRetries",
        KAN_MAX_PER_MINUTE: "maxPerMinute"
    };
    for (const [name, field] of Object.entries(numeric)) {
        if (env[name] != null && env[name] !== "") out[field] = env[name];
    }
    if (env.KAN_BUDGET_HOURS != null && env.KAN_BUDGET_HOURS !== "" && out.budgetMs == null) {
        out.budgetHours = env.KAN_BUDGET_HOURS;
    }
    return out;
}

function normalizeInput(overrides) {
    if (!overrides) return {};
    const out = { ...overrides };
    if (out.budgetHours != null && out.budgetHours !== "" && out.budgetMs == null) {
        const hours = Number(out.budgetHours);
        if (!Number.isFinite(hours) || hours <= 0) throw invalid("budgetHours must be a positive number");
        out.budgetMs = Math.round(hours * 60 * 60 * 1000);
    }
    delete out.budgetHours;
    return out;
}

function resolvePacing(scraperName, overrides = {}, env = process.env) {
    const file = getPacingFile();
    const key = pacingKeyFor(scraperName);
    const section = (file.scrapers && file.scrapers[key]) || {};
    const fromEnv = normalizeInput(overridesFromEnv(env));
    const fromCli = normalizeInput(overrides);
    const slowFromCli = Object.prototype.hasOwnProperty.call(fromCli, "slow") ? fromCli.slow : undefined;
    const slowFromEnv = Object.prototype.hasOwnProperty.call(fromEnv, "slow") ? fromEnv.slow : undefined;
    const slowRaw = slowFromCli !== undefined ? slowFromCli : slowFromEnv;
    const slowRequest = slowRaw === undefined ? undefined : parseBoolean(slowRaw, "slow");

    let resolved = merge(file.defaults, section);
    if (slowRequest === true && resolved.slow !== true) {
        resolved = merge(resolved, slowProfile(file));
    } else if (slowRequest === false) {
        resolved = merge(file.defaults, { slow: false });
    }

    const numeric = (obj) => {
        const copy = { ...obj };
        delete copy.slow;
        return copy;
    };
    resolved = merge(merge(resolved, numeric(fromEnv)), numeric(fromCli));
    if (slowRequest !== undefined) resolved.slow = slowRequest;
    return finalize(resolved, key || "pacing");
}

function formatDuration(ms) {
    if (ms == null || !Number.isFinite(ms)) return "none";
    const sign = ms < 0 ? "-" : "";
    let seconds = Math.round(Math.abs(ms) / 1000);
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    seconds -= minutes * 60;
    if (hours && minutes) return `${sign}${hours}h ${minutes}m`;
    if (hours) return `${sign}${hours}h`;
    if (minutes && seconds) return `${sign}${minutes}m ${seconds}s`;
    if (minutes) return `${sign}${minutes}m`;
    return `${sign}${seconds}s`;
}

function formatPacing(pacing) {
    const retries = pacing.maxRetries == null ? "unlimited" : String(pacing.maxRetries);
    const perMinute = pacing.maxPerMinute == null ? "domain-default" : String(pacing.maxPerMinute);
    return [
        `slow=${pacing.slow}`,
        `minInterval=${formatDuration(pacing.minIntervalMs)}`,
        `requestDelay=${formatDuration(pacing.requestDelayMinMs)}-${formatDuration(pacing.requestDelayMaxMs)}`,
        `pauseEvery=${pacing.pauseEveryPages} pages`,
        `pause=${formatDuration(pacing.pauseMinMs)}-${formatDuration(pacing.pauseMaxMs)}`,
        `blockBackoff=${formatDuration(pacing.blockBackoffMinMs)}-${formatDuration(pacing.blockBackoffMaxMs)}`,
        `budget=${formatDuration(pacing.budgetMs)}`,
        `maxRetries=${retries}`,
        `governHttp=${pacing.governHttp}`,
        `maxPerMinute=${perMinute}`
    ].join(" ");
}

function assignFlag(target, field, value) {
    if (value == null) throw invalid(`missing value for ${field}`);
    if (field === "maxRetries") target.maxRetries = value;
    else if (field === "slow" || field === "governHttp") target[field] = value;
    else if (field === "budgetHours") target.budgetHours = value;
    else target[field] = value;
}

function parseCommandLine(argv) {
    const positional = [];
    const overrides = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--slow") {
            overrides.slow = true;
            continue;
        }
        if (arg === "--no-slow") {
            overrides.slow = false;
            continue;
        }
        if (arg === "--govern-http") {
            overrides.governHttp = true;
            continue;
        }
        if (arg === "--no-govern-http") {
            overrides.governHttp = false;
            continue;
        }
        if (arg === "--mode") {
            positional.mode = argv[++i];
            continue;
        }
        if (arg.startsWith("--")) {
            const name = arg.slice(2);
            const field = FLAG_MAP[name];
            if (!field) throw invalid(`unknown option --${name}`);
            const value = argv[++i];
            if (value == null || value.startsWith("--")) throw invalid(`missing value for --${name}`);
            assignFlag(overrides, field, value);
            continue;
        }
        positional.push(arg);
    }
    const scraper = positional[0] || "";
    // kanDigital's nightly entry omits --mode. Incremental is the default
    // there so the run stays inside the time budget. --mode full still
    // forces a full scrape. Other scrapers keep the full default.
    const mode = positional.mode || (scraper === "kanDigital" ? "incremental" : "full");
    return { scraper, mode, overrides };
}

function pacingOverridesFromQuery(query) {
    const overrides = {};
    if (!query) return overrides;
    for (const [rawKey, rawValue] of Object.entries(query)) {
        const field = QUERY_MAP[String(rawKey).toLowerCase()];
        if (!field || rawValue == null || rawValue === "") continue;
        overrides[field] = rawValue;
    }
    return overrides;
}

getPacingFile();

module.exports = {
    PACING_FILE,
    PACING_SCRAPERS,
    pacingKeyFor,
    validatePacingFile,
    loadPacingFile,
    getPacingFile,
    resolvePacing,
    formatPacing,
    formatDuration,
    parseCommandLine,
    pacingOverridesFromQuery,
    overridesFromEnv
};
