#!/usr/bin/env node

/**
 * Run one scraper in its own process and publish the way a normal crawl does.
 *
 * GitHub upload and Supabase follow WRITE_TO_GITHUB and UPDATE_DATABASE
 * (both on by default). This is the standalone entry for a long kanDigital
 * slow run. It takes locks/<scraper>.lock for the whole run so the nightly
 * runner, which starts the same crawl, skips that scraper until the lock
 * is released or goes stale.
 *
 * Usage (Windows station):
 *   cd /d D:\Development\Stremio-KanBoxRepos
 *   set KAN_SLOW=1
 *   set KAN_BUDGET_HOURS=20
 *   node scripts/run-scraper.js kanDigital --slow --budget-hours 20
 *   node scripts/run-scraper.js kanDigital --slow --budget-hours 20 --mode full
 */

const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../classes/.env") });

const { parseCommandLine } = require("../classes/pacing.js");
const { closeKanSession } = require("../classes/kanSession.js");

const scrapers = {
    kanDigital: () => new (require("../classes/KanDigitalScraper.js"))(),
    kanArchive: () => new (require("../classes/KanArchiveScraper.js"))(),
    kanKids: () => new (require("../classes/KanKidsScraper.js"))(),
    kanTeens: () => new (require("../classes/KanTeensScraper.js"))(),
    kanPodcasts: () => new (require("../classes/KanPodcastsScraper.js"))(),
    kan88: () => new (require("../classes/Kan88Scraper.js"))(),
    mako: () => new (require("../classes/MakoScraper.js"))(),
    reshet: () => new (require("../classes/ReshetScraper.js"))(),
    livetv: () => new (require("../classes/LiveTV.js"))()
};

function exitCode(outcome) {
    if (outcome && outcome.skipped) return 0;
    if (!outcome || outcome.published === false) return outcome && outcome.blocked ? 3 : 2;
    return 0;
}

async function main() {
    const parsed = parseCommandLine(process.argv.slice(2));
    const factory = scrapers[parsed.scraper];
    if (!factory) {
        console.error("Usage: node scripts/run-scraper.js <" + Object.keys(scrapers).join("|") + "> [--slow|--no-slow] [--budget-hours N] [--mode full|incremental]");
        console.error("kanDigital defaults to incremental. Pass --mode full to scrape every listed series.");
        return 1;
    }

    console.log(`Standalone scrape of ${parsed.scraper} (mode: ${parsed.mode}).`);
    const scraper = factory();
    scraper.pacingOverrides = parsed.overrides;
    try {
        const outcome = await scraper.crawl(true, parsed.mode);
        if (outcome && outcome.skipped) {
            console.log(outcome.line);
            return 0;
        }
        const count = Object.keys(scraper.getJsonObject ? scraper.getJsonObject() : {}).length;
        console.log(`Finished ${parsed.scraper} with ${count} series in memory.`);
        if (!outcome || outcome.published === false) {
            console.error(outcome && outcome.line
                ? outcome.line
                : "Nothing was published. The previous ZIP and Supabase rows were left unchanged.");
        }
        return exitCode(outcome);
    } finally {
        await closeKanSession();
    }
}

main().then((code) => {
    process.exit(code);
}).catch((error) => {
    console.error(error);
    process.exit(1);
});
