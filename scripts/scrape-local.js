#!/usr/bin/env node

/**
 * Run one scraper and write output/<name>.zip on this machine.
 *
 * Does not upload to GitHub and does not touch Supabase. Those stay off
 * even if the surrounding environment sets the opposite flags.
 *
 * Usage:
 *   node scripts/scrape-local.js kan88
 *   node scripts/scrape-local.js kanKids
 *
 * Kan 88 and the other kan.org.il HTML pages need Playwright's Chromium:
 *   npx playwright install chromium
 */

process.env.SAVE_MODE = "local";
process.env.WRITE_TO_GITHUB = "false";
process.env.UPDATE_DATABASE = "false";

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
    const name = process.argv[2];
    const factory = scrapers[name];
    if (!factory) {
        console.error("Usage: node scripts/scrape-local.js <" + Object.keys(scrapers).join("|") + ">");
        process.exit(1);
    }

    console.log(`Local scrape of ${name}. GitHub upload and Supabase updates are off.`);
    const scraper = factory();
    await scraper.crawl(true, "full");
    const count = Object.keys(scraper.getJsonObject ? scraper.getJsonObject() : {}).length;
    console.log(`Finished ${name} with ${count} series in memory.`);
    if (count === 0) {
        console.error("Nothing was written. The previous ZIP was left in place.");
        process.exit(2);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
