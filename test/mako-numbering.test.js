const test = require("node:test");
const assert = require("node:assert/strict");
const MakoScraper = require("../classes/MakoScraper");

// Mako's own label is in extraInfo ("פרק 2@15.10.26"); the scraper numbers by
// position and direction, so the tests check the two agree.
function vod(episode, date) {
    return { componentLayout: "vod", title: "episode " + episode, extraInfo: "פרק " + episode + "@" + date };
}

const AD = { componentLayout: "ad" };

async function numbersFor(vods) {
    const scraper = new MakoScraper();
    scraper.getEpisode = async episode => ({
        status: "1",
        episodeId: episode.title,
        episodeTitle: episode.title
    });
    scraper.getStream = async () => [];
    const videos = await scraper.getEpisodes({ channelId: "c", menu: [{ vods }] }, "il_mako_1", "1");
    return Object.fromEntries(videos.map(video => [video.title, video.episode]));
}

test("an ad in a newest-first season does not shift the numbers (הבריחה, October 2026)", async () => {
    // The list Mako returned for /mako-vod-keshet/the_escape on 2026-10-18.
    const numbers = await numbersFor([vod(2, "15.10.26"), vod(1, "10.10.26"), AD]);
    assert.deepEqual(numbers, { "episode 2": 2, "episode 1": 1 });
});

test("an ad between episodes does not shift a newest-first season", async () => {
    const numbers = await numbersFor([vod(3, "17.10.26"), AD, vod(2, "16.10.26"), vod(1, "15.10.26")]);
    assert.deepEqual(numbers, { "episode 3": 3, "episode 2": 2, "episode 1": 1 });
});

test("an ad does not shift an oldest-first season", async () => {
    const numbers = await numbersFor([AD, vod(1, "01.01.26"), vod(2, "08.01.26"), AD, vod(3, "15.01.26")]);
    assert.deepEqual(numbers, { "episode 1": 1, "episode 2": 2, "episode 3": 3 });
});

test("a season without ads is numbered as before", async () => {
    assert.deepEqual(
        await numbersFor([vod(3, "17.10.26"), vod(2, "16.10.26"), vod(1, "15.10.26")]),
        { "episode 3": 3, "episode 2": 2, "episode 1": 1 }
    );
    assert.deepEqual(
        await numbersFor([vod(1, "01.01.26"), vod(2, "08.01.26")]),
        { "episode 1": 1, "episode 2": 2 }
    );
});
