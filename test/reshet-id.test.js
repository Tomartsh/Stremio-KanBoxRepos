const test = require("node:test");
const assert = require("node:assert/strict");
const ReshetScraper = require("../classes/ReshetScraper");
const { reshetSeriesId } = ReshetScraper;

const SHOWS = [
    ["/all-shows/todays-talk/", "il_reshet_todays_talk"],
    ["/all-shows/mamad-talk/", "il_reshet_mamad_talk"],
    ["/all-shows/13-in-the-afternoon/", "il_reshet_13_in_the_afternoon"],
    ["/all-shows/shnot-hashmonim-902985960/", "il_reshet_shnot_hashmonim_902985960"],
    ["/shows/free-hour/", "il_reshet_free_hour"]
];

test("reshet series ids come from the show slug and ignore list order", async () => {
    const forward = SHOWS.map(([path]) => reshetSeriesId("https://13tv.co.il" + path));
    const backward = [...SHOWS].reverse().map(([path]) => reshetSeriesId("https://13tv.co.il" + path.replace(/\/$/, "")));
    assert.deepEqual(forward, SHOWS.map(([, id]) => id));
    assert.deepEqual(backward, [...forward].reverse());

    const first = new ReshetScraper();
    const second = new ReshetScraper();
    first.getEpisodes = async () => [];
    second.getEpisodes = async () => [];
    const order = [
        { url: "/all-shows/the-voice/", title: "The Voice", poster: "", id: 3 },
        { url: "/all-shows/todays-talk/", title: "שיחת היום עם לוסי אהריש", poster: "", id: 255 }
    ];
    for (const show of order) await first.processOneReshetSeries(show);
    for (const show of [...order].reverse()) await second.processOneReshetSeries(show);
    assert.deepEqual(Object.keys(first.getJsonObject()).sort(), Object.keys(second.getJsonObject()).sort());
    assert.equal(first.getJsonObject().il_reshet_todays_talk.link, "https://13tv.co.il/all-shows/todays-talk");
    assert.equal(first.getJsonObject().il_reshet_the_voice.name, "The Voice");
    assert.equal(first.getJsonObject().il_reshet_255, undefined);
});

test("two reshet shows that share a slug do not overwrite each other", () => {
    const scraper = new ReshetScraper();
    const first = scraper._reshetSeriesId("https://13tv.co.il/all-shows/the-voice");
    const second = scraper._reshetSeriesId("https://13tv.co.il/shows/the-voice");
    assert.equal(first, "il_reshet_the_voice");
    assert.equal(second.startsWith("il_reshet_the_voice_"), true);
    assert.notEqual(first, second);
    assert.equal(scraper._reshetSeriesId("https://13tv.co.il/shows/the-voice/"), second);
});
