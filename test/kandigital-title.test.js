const test = require("node:test");
const assert = require("node:assert/strict");
const { getNameFromSeriesPage } = require("../classes/utilities");
const {
    isValidSeriesTitle,
    stripSiteSuffix,
    pickSeriesTitle,
    repairVideoNames
} = require("../classes/kanDigitalParse");

function seriesPage({ title = "", ogTitle = "", h1 = "" } = {}) {
    return `<!doctype html><html><head>
        <title>${title}</title>
        ${ogTitle ? `<meta property="og:title" content="${ogTitle}">` : ""}
        </head><body>${h1 ? `<h1 class="visually-hidden">${h1}</h1>` : ""}</body></html>`;
}

const BAD_NAMES = [
    "",
    "   ",
    "5",
    "3",
    "06 30",
    "12.",
    "6  Image Big 1200X1800",
    "4  image_small_239X360",
    "5  image_small_239X360",
    "1200X1800",
    "239X360 דודו טסה",
    "משה להב239X360",
    "image small_239X360_שיר אחד_הביצועים",
    "Image Small",
    "640 × 360",
    "תמונת אורך פרק"
];

test("image alt and caption text is not a valid series title", () => {
    for (const name of BAD_NAMES) {
        assert.equal(isValidSeriesTitle(name), false, JSON.stringify(name));
    }
});

test("real titles stay valid, including ones with the word תמונות or תמונה", () => {
    const good = [
        "ההמצאות של המחר",
        "תמונות מחיי נישואים",
        "תמונה משפחתית",
        "תמונת ניצחון",
        "ערב עם שי שטרן",
        "פרק 5",
        "קופה ראשית 2",
        "Fauda"
    ];
    for (const name of good) {
        assert.equal(isValidSeriesTitle(name), true, name);
    }
});

test("site suffixes are stripped from page titles", () => {
    assert.equal(stripSiteSuffix("שבס | כאן"), "שבס");
    assert.equal(stripSiteSuffix("שבס - Kan"), "שבס");
    assert.equal(stripSiteSuffix("מיני די.וי.כאן"), "מיני די.וי");
    assert.equal(stripSiteSuffix("מיני די.וי.כאן11"), "מיני די.וי");
});

test("a bad lobby alt falls back to og:title, then h1, then <title>", () => {
    const og = pickSeriesTitle(seriesPage({ title: "טריפ של חמלה | כאן", ogTitle: "טריפ של חמלה", h1: "טריפ של חמלה.כאן" }), {
        imageAlt: "6  Image Big 1200X1800",
        clean: getNameFromSeriesPage
    });
    assert.equal(og.title, "טריפ של חמלה");
    assert.equal(og.source, "og:title");
    assert.deepEqual(og.rejected, ["6 Image Big 1200X1800"]);

    const h1 = pickSeriesTitle(seriesPage({ title: "x", h1: "מיני די.וי.כאן" }), {
        imageAlt: "5",
        clean: getNameFromSeriesPage
    });
    assert.equal(h1.title, "מיני די.וי");
    assert.equal(h1.source, "h1");

    const titleTag = pickSeriesTitle(seriesPage({ title: "סועאד זכי | כאן" }), {
        imageAlt: "תמונת אורך פרק",
        clean: getNameFromSeriesPage
    });
    assert.equal(titleTag.title, "סועאד זכי");
    assert.equal(titleTag.source, "title");
});

test("a valid lobby alt is kept, even when it contains תמונות", () => {
    const picked = pickSeriesTitle(seriesPage({ ogTitle: "something else" }), {
        imageAlt: "תמונות מחיי נישואים",
        clean: getNameFromSeriesPage
    });
    assert.equal(picked.title, "תמונות מחיי נישואים");
    assert.equal(picked.source, "imageAlt");
    assert.deepEqual(picked.rejected, []);
});

test("when the page has no valid title the previous catalog name is kept", () => {
    const picked = pickSeriesTitle(seriesPage({ title: "5", ogTitle: "4  image_small_239X360" }), {
        imageAlt: "5",
        previousName: "השם הקודם",
        clean: getNameFromSeriesPage
    });
    assert.equal(picked.title, "השם הקודם");
    assert.equal(picked.source, "previous");
});

test("with nothing valid anywhere the first non-empty name is kept so the series is not dropped", () => {
    const picked = pickSeriesTitle(seriesPage({}), { imageAlt: "5", previousName: "5" });
    assert.equal(picked.title, "5");
    assert.equal(pickSeriesTitle("", {}).title, "");
});

test("a single-title video that carried the bad series name gets the new title", () => {
    const videos = [
        { id: "a:1:1", name: "5", episodeLink: "https://www.kan.org.il/x/" },
        { id: "a:2:5", name: "18/11/22", episodeLink: "https://www.kan.org.il/y/" },
        { id: "a:1:2", name: "פרק 2", episodeLink: "https://www.kan.org.il/z/" }
    ];
    const repaired = repairVideoNames(videos, ["5"], "סרט טוב");
    assert.equal(repaired[0].name, "סרט טוב");
    assert.equal(repaired[1].name, "18/11/22");
    assert.equal(repaired[2].name, "פרק 2");
    assert.equal(videos[0].name, "5");
    assert.equal(repairVideoNames(videos, ["5"], "5")[0].name, "5");
});
