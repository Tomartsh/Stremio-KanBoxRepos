#!/usr/bin/env node

/**
 * Run one scraper and write output/<name>.zip on this machine.
 *
 * Does not upload to GitHub and does not touch Supabase. Those stay off
 * even if the surrounding environment sets the opposite flags.
 *
 * Usage:
 *   node scripts/scrape-local.js kan88
 *   node scripts/scrape-local.js kanDigital --slow
 *   node scripts/scrape-local.js kan88 --slow --budget-hours 20
 *
 * Kan HTML pages need a real Chrome. See scripts/check-kan-access.js.
 *   set KAN_BROWSER_CHANNEL=chrome
 *   set KAN_BROWSER_USER_DATA_DIR=D:\KanBox\kan-browser-profile
 */

process.env.SAVE_MODE = "local";
process.env.WRITE_TO_GITHUB = "false";
process.env.UPDATE_DATABASE = "false";

const { parseCommandLine } = require("../classes/pacing.js");

const scrapers = {
    kanDigital: () => new (require("../classes/KanDigitalScraper.js"))(),
    kanArchive: () => new (require("../classes/KanArchiveScraper.js"))(),
    kanKids: () => new (require("../classes/KanKidsScraper.js"))(),
    kanTeens: () => new (require("../classes/KanTeensScraper.js"))(),
    kanPodcasts: () => new (require("../classes/KanPodcastsScraper.js"))(),
    kan88: () => new (require("../classes/Kan88Scraper.js"))(),
    mako: () => new (require("../classes/MakoScraper.js"))(),
    reshet: () => new (require("../classes/ReshetScraper.js"))()
};

async function main() {
    let parsed;
    try {
        parsed = parseCommandLine(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
    const name = parsed.scraper;
    const factory = scrapers[name];
    if (!factory) {
        console.error("Usage: node scripts/scrape-local.js <" + Object.keys(scrapers).join("|") + "> [--slow|--no-slow] [--budget-hours N]");
        process.exit(1);
    }

    console.log(`Local scrape of ${name}. GitHub upload and Supabase updates are off.`);
    const scraper = factory();
    scraper.pacingOverrides = parsed.overrides;
    const outcome = await scraper.crawl(true, parsed.mode);
    if (outcome && outcome.skipped) {
        console.log(outcome.line);
        process.exit(0);
    }
    const count = Object.keys(scraper.getJsonObject ? scraper.getJsonObject() : {}).length;
    console.log(`Finished ${name} with ${count} series in memory.`);
    if (!outcome || outcome.published === false) {
        console.error(outcome && outcome.line
            ? outcome.line
            : "Nothing was written. The previous ZIP was left in place.");
        process.exit(outcome && outcome.blocked ? 3 : 2);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
