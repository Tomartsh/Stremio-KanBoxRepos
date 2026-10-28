const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { parse } = require("node-html-parser");
const { KAN_BOX_IGNORE_LIST } = require("../classes/constants");
const {
    parseKanBoxLobby,
    selectLobbySeries,
    parseSeriesPage,
    numberDigitalEpisodes,
    planSeriesRefresh,
    videoFromEpisodeCard,
    videoFromMovieCard,
    carryPreviousEpisodeFields
} = require("../classes/kanDigitalParse");

const fixtureDir = path.join(__dirname, "fixtures/kandigital");

function readFixture(name) {
    return fs.readFileSync(path.join(fixtureDir, name), "utf8");
}

const SERIES_12832 = "https://www.kan.org.il/content/kan/kan-11/p-12832/";
const SERIES_682519 = "https://www.kan.org.il/content/kan/kan-11/p-682519/";

test("Kan-Box lobby fixture yields unique series roots, not episode URLs", () => {
    const html = readFixture("lobby-raw.html");
    const entries = parseKanBoxLobby(html);
    const urls = [...new Set(entries.map((entry) => entry.seriesUrl))];

    assert.ok(urls.length >= 30, `expected many series roots, got ${urls.length}`);
    assert.ok(urls.includes(SERIES_12832));
    assert.ok(urls.includes(SERIES_682519));
    assert.ok(urls.every((url) => /\/p-\d+\/$/.test(url)));
    assert.equal(urls.some((url) => /\/s\d+\//.test(url)), false);
    assert.equal(urls.some((url) => /\/p-\d+\/\d+\//.test(url)), false);

    const fresh = entries.filter((entry) => {
        return entry.category === "חדש מהקופסה" && entry.seriesUrl === SERIES_682519;
    });
    assert.equal(fresh.length, 1);
    assert.ok(entries.some((entry) => entry.category === "ילדים ונוער"));

    const selected = selectLobbySeries(entries, KAN_BOX_IGNORE_LIST);
    assert.equal(selected.some((entry) => entry.category === "ילדים ונוער"), false);
    assert.ok(selected.some((entry) => entry.seriesUrl === SERIES_12832));
    assert.equal(new Set(selected.map((entry) => entry.seriesUrl)).size, selected.length);

    const fromDoc = parseKanBoxLobby(parse(html));
    assert.equal(fromDoc.length, entries.length);
});

test("a series listed under an ignored heading is kept when another section has it", () => {
    const shared = "https://www.kan.org.il/content/kan/kan-11/p-1/";
    const kidsOnly = "https://www.kan.org.il/content/kan/kan-11/p-2/";
    const selected = selectLobbySeries([
        { category: "ילדים ונוער", seriesUrl: shared },
        { category: "דרמה", seriesUrl: shared },
        { category: "ילדים ונוער", seriesUrl: kidsOnly }
    ], KAN_BOX_IGNORE_LIST);
    assert.deepEqual(selected, [{ category: "דרמה", seriesUrl: shared }]);
});

test("Kupara series page yields seasons s1-s6 and episodes under that series", () => {
    const parsed = parseSeriesPage(readFixture("kupara-raw.html"), SERIES_12832);
    assert.deepEqual(parsed.seasonUrls, [1, 2, 3, 4, 5, 6].map((season) => {
        return `https://www.kan.org.il/content/kan/kan-11/p-12832/s${season}/`;
    }));
    assert.ok(parsed.episodes.length > 0);
    assert.ok(parsed.episodes.every((episode) => episode.url.includes("/p-12832/")));
    assert.ok(parsed.episodes.some((episode) => episode.season === 6 && episode.url.includes("/s6/1098487/")));
    assert.equal(parsed.episodes.some((episode) => episode.url.includes("/p-12832/1098489/")), false);
    assert.equal(parsed.movieUrl, null);

    const known = parsed.episodes.find((episode) => episode.url.endsWith("/s6/1098487/"));
    assert.equal(known.title, "פרק 1 - אבא גנוב");
    assert.equal(known.season, 6);
});

test("Kupara season page yields season 6 episodes", () => {
    const parsed = parseSeriesPage(
        readFixture("kupara-s6-raw.html"),
        "https://www.kan.org.il/content/kan/kan-11/p-12832/s6/"
    );
    const seasonSix = parsed.episodes.filter((episode) => episode.season === 6);
    assert.ok(seasonSix.length > 0);
    assert.ok(seasonSix.every((episode) => episode.url.includes("/p-12832/s6/")));
});

test("program-grid series page yields titles and durations for season 3", () => {
    const parsed = parseSeriesPage(readFixture("series-kan11.html"), SERIES_682519);
    assert.ok(parsed.episodes.length > 0);
    assert.equal(parsed.seasonUrls.length, 0);
    assert.equal(parsed.movieUrl, null);
    assert.ok(parsed.episodes.every((episode) => episode.season === 3));
    assert.ok(parsed.episodes.every((episode) => episode.title.trim().length > 0));
    assert.ok(parsed.episodes.every((episode) => /^\d{2}:\d{2}:\d{2}$/.test(episode.duration)));
    assert.equal(parsed.episodes[0].title, "פרק 23 - הילה קורח");
    assert.equal(parsed.episodes[0].duration, "00:38:46");
    assert.equal(parsed.episodes[0].url, "https://www.kan.org.il/content/kan/kan-11/p-682519/s3/1067700/");
});

test("a single-season page lists /p-N/id/ episodes and skips the trailer card", () => {
    const maNisgar = parseSeriesPage(
        readFixture("series-p-13779.html"),
        "https://www.kan.org.il/content/kan/kan-11/p-13779/"
    );
    const numbered = numberDigitalEpisodes(maNisgar.episodes);
    assert.equal(maNisgar.episodes.length, 44);
    assert.equal(maNisgar.seasonUrls.length, 0);
    assert.equal(maNisgar.movieUrl, null);
    assert.equal(maNisgar.episodes.some((episode) => episode.url.endsWith("/919238/")), false);
    assert.ok(maNisgar.episodes.every((episode) => episode.season === 1));
    assert.ok(maNisgar.episodes.every((episode) => /\/p-13779\/\d+\//.test(episode.url) && !/\/s\d+\//.test(episode.url)));
    const first = numbered.find((episode) => episode.url.endsWith("/96241/"));
    const last = numbered.find((episode) => episode.url.endsWith("/105742/"));
    assert.equal(first.episodeNo, 1);
    assert.equal(last.episodeNo, 44);
    assert.equal(last.title, "פרק 44");
    assert.ok(first.image.startsWith("https://www.kan.org.il/media/"));

    const tequma = parseSeriesPage(
        readFixture("series-p-13871.html"),
        "https://www.kan.org.il/content/kan/kan-11/p-13871/"
    );
    const tequmaNumbers = numberDigitalEpisodes(tequma.episodes);
    assert.equal(tequma.episodes.length, 22);
    assert.equal(tequma.episodes.some((episode) => episode.url.endsWith("/880716/")), false);
    assert.ok(tequma.episodes.every((episode) => episode.season === 1 && episode.url.includes("/p-13871/")));
    assert.equal(tequmaNumbers.find((episode) => episode.url.endsWith("/114689/")).episodeNo, 1);
    assert.equal(tequmaNumbers.find((episode) => episode.url.endsWith("/114752/")).episodeNo, 22);
});

test("single-title page uses the hero watch link and ignores the trailer card", () => {
    const parsed = parseSeriesPage(
        readFixture("movie-p525000-raw.html"),
        "https://www.kan.org.il/content/kan/kan-11/p-525000/"
    );
    assert.equal(parsed.movieUrl, "https://www.kan.org.il/content/kan/kan-11/p-525000/525002/");
    assert.equal(parsed.episodes.length, 0);
    assert.equal(parsed.seasonUrls.length, 0);
});

test("legacy card-links and the old watch button still parse", () => {
    const seasons = parseSeriesPage(`
        <div class="seasons-item">
            <a class="card-link" href="/content/kan/kan-11/p-50/s2/200/" title="fallback">
                <div class="card-title">גמר</div>
                <div class="card-text">תיאור</div>
            </a>
            <a class="card-link" href="https://www.kan.org.il/content/kan/kan-11/p-50/s2/100/">
                <div class="card-title">פתיחה</div>
            </a>
        </div>
        <a href="/content/kan/kan-11/p-50/s1/">עונה 1</a>
        <a class="card-link" href="/content/kan/kan-11/p-9/s1/3/">
            <div class="card-title">סדרה אחרת</div>
        </a>
    `, "https://www.kan.org.il/content/kan/kan-11/p-50/");

    assert.deepEqual(seasons.seasonUrls, ["https://www.kan.org.il/content/kan/kan-11/p-50/s1/"]);
    assert.equal(seasons.episodes.length, 2);
    assert.equal(seasons.episodes[0].season, 2);
    assert.equal(seasons.episodes[0].title, "גמר");
    assert.equal(seasons.episodes[0].description, "תיאור");
    assert.equal(seasons.episodes[0].url, "https://www.kan.org.il/content/kan/kan-11/p-50/s2/200/");
    assert.equal(seasons.movieUrl, null);

    const numbered = numberDigitalEpisodes(seasons.episodes);
    assert.equal(numbered.find((episode) => episode.url.endsWith("/200/")).episodeNo, 2);
    assert.equal(numbered.find((episode) => episode.url.endsWith("/100/")).episodeNo, 1);

    const fromTitle = numberDigitalEpisodes([
        { url: "https://www.kan.org.il/content/kan/kan-11/p-1/s3/a/", title: "פרק 23 - אורח", duration: "00:38:46", season: 3 },
        { url: "https://www.kan.org.il/content/kan/kan-11/p-1/s3/b/", title: "פרק 1 - פתיחה", duration: "00:30:00", season: 3 }
    ]);
    assert.equal(fromTitle[0].episodeNo, 23);
    assert.equal(fromTitle[1].episodeNo, 1);

    const buttonOnly = parseSeriesPage(
        '<a class="btn with-arrow" href="/content/kan/kan-11/p-7/77/"></a>',
        "https://www.kan.org.il/content/kan/kan-11/p-7/"
    );
    assert.equal(buttonOnly.movieUrl, "https://www.kan.org.il/content/kan/kan-11/p-7/77/");

    const heroWins = parseSeriesPage(`
        <a class="btn with-arrow" href="/content/kan/kan-11/p-7/1/"></a>
        <a class="hero-vod-cta" href="/content/kan/kan-11/p-525000/525002/">לצפייה</a>
    `, "https://www.kan.org.il/content/kan/kan-11/p-525000/");
    assert.equal(heroWins.movieUrl, "https://www.kan.org.il/content/kan/kan-11/p-525000/525002/");
});

test("relative lobby hrefs are trimmed to an absolute series root", () => {
    const entries = parseKanBoxLobby(`
        <section class="content-row-section">
            <div class="component-header"><h2>דרמה</h2></div>
            <a class="cr-item" href="/content/kan/kan-11/p-1108042/s1/1108046/">
                <h3 class="cr-title">אחרי הדאבל | פרק 2</h3>
            </a>
            <a class="cr-item" href="/content/kids/hinuchit-main/the_serials/">
                <h3 class="cr-title">kids</h3>
            </a>
        </section>
    `);
    assert.deepEqual(entries, [{
        category: "דרמה",
        seriesUrl: "https://www.kan.org.il/content/kan/kan-11/p-1108042/"
    }]);
});

test("cr-item episodes stay inside the requested series", () => {
    const parsed = parseSeriesPage(`
        <a class="cr-item" href="https://www.kan.org.il/content/kan/kan-11/p-12832/s6/1/" aria-label="מתווית">
            <h3 class="cr-title"></h3>
        </a>
        <a class="cr-item" href="https://www.kan.org.il/content/kan/kan-11/p-999/s1/2/">
            <h3 class="cr-title">סדרה אחרת</h3>
        </a>
    `, SERIES_12832);
    assert.equal(parsed.episodes.length, 1);
    assert.equal(parsed.episodes[0].title, "מתווית");
    assert.equal(parsed.episodes[0].season, 6);
    assert.equal(parsed.episodes[0].url, "https://www.kan.org.il/content/kan/kan-11/p-12832/s6/1/");
});

test("episode cards become videos without an episode-page fetch", () => {
    const numbered = numberDigitalEpisodes([{
        url: "https://www.kan.org.il/content/kan/kan-11/p-1/s3/a/",
        title: "אורח",
        subtitle: "עונה 3, פרק 23",
        image: "https://www.kan.org.il/media/a.jpg?width=490",
        duration: "00:38:46",
        season: 3,
        description: ""
    }, {
        url: "https://www.kan.org.il/content/kan/kan-11/p-12385/s4/1/",
        title: "פרק 1",
        season: 4
    }]);
    assert.equal(numbered[0].episodeNo, 23);

    const video = videoFromEpisodeCard(numbered[0], "il_kan_digital_1");
    assert.equal(video.id, "il_kan_digital_1:3:23");
    assert.equal(video.name, "אורח");
    assert.equal(video.season, 3);
    assert.equal(video.episode, 23);
    assert.equal(video.thumbnail, "https://www.kan.org.il/media/a.jpg?width=490");
    assert.equal(video.episodeLink, "https://www.kan.org.il/content/kan/kan-11/p-1/s3/a/");
    assert.deepEqual(video.streams, []);
    assert.equal(video.duration, "00:38:46");
    assert.equal(Object.hasOwn(video, "released"), false);
    assert.equal(videoFromEpisodeCard(numbered[1], "il_kan_digital_1"), null);

    const carried = carryPreviousEpisodeFields([video], [{
        episodeLink: "https://www.kan.org.il/content/kan/kan-11/p-1/s3/a",
        released: "2020-01-02T00:00:00.000Z",
        thumbnail: "https://www.kan.org.il/media/og-1200.jpg",
        description: "תיאור מעמוד הפרק"
    }]);
    assert.equal(carried[0].released, "2020-01-02T00:00:00.000Z");
    assert.equal(carried[0].thumbnail, video.thumbnail);
    assert.equal(carried[0].description, "תיאור מעמוד הפרק");

    const movie = videoFromMovieCard(
        "https://www.kan.org.il/content/kan/kan-11/p-525000/525002/",
        "il_kan_digital_525000",
        "סרט",
        "תקציר מהעמוד",
        "https://www.kan.org.il/media/poster.jpg"
    );
    assert.equal(movie.episodeLink, "https://www.kan.org.il/content/kan/kan-11/p-525000/525002/");
    assert.deepEqual(movie.streams, []);
    assert.equal(Object.hasOwn(movie, "released"), false);
});

test("an unchanged series is reused and a partial season page is fetched", () => {
    const seasonUrl = "https://www.kan.org.il/content/kan/kan-11/p-9/s2/";
    const full = [1, 2, 3].map((n) => ({
        season: 2,
        episodeLink: `https://www.kan.org.il/content/kan/kan-11/p-9/s2/${n}/`
    }));
    const samePage = full.map((video) => ({ season: 2, url: video.episodeLink }));
    const unchanged = planSeriesRefresh(full, samePage, [seasonUrl]);
    assert.deepEqual(unchanged, { reuse: true, seasonUrls: [], keepUnseenSeasons: false });

    const partial = planSeriesRefresh(full, [samePage[0]], [seasonUrl]);
    assert.equal(partial.reuse, false);
    assert.deepEqual(partial.seasonUrls, [seasonUrl]);
    assert.equal(partial.keepUnseenSeasons, true);

    const added = planSeriesRefresh(
        full,
        samePage.concat([{ season: 2, url: "https://www.kan.org.il/content/kan/kan-11/p-9/s2/4/" }]),
        [seasonUrl]
    );
    assert.equal(added.reuse, false);
    assert.deepEqual(added.seasonUrls, []);
    assert.equal(added.keepUnseenSeasons, true);

    const newSeason = "https://www.kan.org.il/content/kan/kan-11/p-9/s3/";
    const grown = planSeriesRefresh(full, samePage, [seasonUrl, newSeason]);
    assert.equal(grown.reuse, false);
    assert.deepEqual(grown.seasonUrls, [newSeason]);
    assert.equal(grown.keepUnseenSeasons, false);
});

test("missing markup does not throw", () => {
    assert.deepEqual(parseKanBoxLobby(""), []);
    assert.deepEqual(parseKanBoxLobby(null), []);
    assert.deepEqual(parseSeriesPage("", SERIES_12832), {
        seasonUrls: [],
        episodes: [],
        movieUrl: null
    });
    assert.deepEqual(numberDigitalEpisodes(null), []);
});
