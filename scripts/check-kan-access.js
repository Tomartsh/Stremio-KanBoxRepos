#!/usr/bin/env node

/**
 * Load one Kan page the same way the scrapers do, and say which failure it was.
 *
 * Exit 0: the page loaded.
 * Exit 3: Cloudflare challenge or block (log line contains CLOUDFLARE CHALLENGE or CLOUDFLARE BLOCK).
 * Exit 4: the browser could not start (log line contains KAN BROWSER UNAVAILABLE).
 *
 * From the Windows scraper machine:
 *
 *   set KAN_BROWSER_CHANNEL=chrome
 *   set KAN_BROWSER_EXECUTABLE=C:\Program Files\Google\Chrome\Application\chrome.exe
 *   set KAN_BROWSER_USER_DATA_DIR=D:\KanBox\kan-browser-profile
 *   set KAN_BROWSER_HEADLESS=false
 *   node scripts/check-kan-access.js https://www.kan.org.il/lobby/kan-box/
 */

const {
    getKanSession,
    closeKanSession,
    KanBlockedError,
    KanBrowserError,
    isChallengeDocument
} = require("../classes/kanSession");

async function main() {
    const url = process.argv[2] || "https://www.kan.org.il/lobby/kan-box/";
    const session = getKanSession();
    try {
        const doc = await session.fetch(url);
        const text = doc && typeof doc.toString === "function" ? doc.toString() : "";
        if (isChallengeDocument(text)) {
            console.error(`CLOUDFLARE CHALLENGE still present: ${url}`);
            process.exitCode = 3;
            return;
        }
        const titleNode = doc && typeof doc.querySelector === "function" ? doc.querySelector("title") : null;
        const title = titleNode && titleNode.text ? String(titleNode.text).trim() : "(none)";
        console.log(`CLEAR ${url}`);
        console.log(`title: ${title}`);
        console.log(`bytes: ${text.length}`);
        if (session.browserUserAgent) console.log(`browser-ua: ${session.browserUserAgent}`);
    } catch (error) {
        if (error instanceof KanBrowserError || (error && error.code === "BROWSER")) {
            console.error(error.message);
            process.exitCode = 4;
            return;
        }
        if (error instanceof KanBlockedError || (error && error.code === "BLOCKED")) {
            console.error(error.message);
            process.exitCode = 3;
            return;
        }
        console.error(error && error.stack ? error.stack : error);
        process.exitCode = 1;
    } finally {
        await closeKanSession();
    }
}

main();
