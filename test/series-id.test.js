const test = require("node:test");
const assert = require("node:assert/strict");
const { generateSeriesId } = require("../classes/utilities");
const { buildSeriesIdentityIndex } = require("../classes/seriesIdentity");

const SLUGS = [
    ["https://www.kankids.org.il/content/kids/ktantanim-main/tamaris_garden/", "il_kan_kids_tamaris_garden"],
    ["https://www.kankids.org.il/content/kids/ktantanim-main/bluey/", "il_kan_kids_bluey"],
    ["https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad", "il_kan_kids_parpar_nehmad"],
    ["https://www.kankids.org.il/content/kids/ktantanim-main/charlie_and_lola/", "il_kan_kids_charlie_and_lola"]
];

test("slug series ids stay the same when the processing order changes", () => {
    const forward = SLUGS.map(([url]) => generateSeriesId(url, "kids"));
    const backward = [...SLUGS].reverse().map(([url]) => generateSeriesId(url, "kids"));
    assert.deepEqual(forward, SLUGS.map(([, id]) => id));
    assert.deepEqual(forward, [...backward].reverse());
    assert.equal(generateSeriesId(SLUGS[1][0], "kids"), "il_kan_kids_bluey");
    assert.equal(
        generateSeriesId("https://www.kankids.org.il/content/kids/ktantanim-main/bluey?currentPage=2&itemsToShow=100", "kids"),
        "il_kan_kids_bluey"
    );
});

test("numeric page ids are still the digits in the slug", () => {
    assert.equal(
        generateSeriesId("https://www.kankids.org.il/content/kids/p-1010382/", "kids"),
        "il_kan_kids_1010382"
    );
    assert.equal(
        generateSeriesId("https://www.kan.org.il/content/kan/kan-11/p-11766/?page=1&itemsToShow=1000", "digital"),
        "il_kan_digital_11766"
    );
    assert.equal(
        generateSeriesId("https://www.kan.org.il/content/kan/podcasts/p-4451/", "podcasts", "0"),
        "il_kan_podcasts_4451"
    );
});

test("series already in the published catalog keep that id", () => {
    const index = buildSeriesIdentityIndex({
        data: {
            il_kan_kids_1019: row("il_kan_kids_1019", "הגינה של תמרי", "https://www.kankids.org.il/content/kids/ktantanim-main/tamaris_garden/"),
            il_kan_kids_1020: row("il_kan_kids_1020", "בלואי", "https://www.kankids.org.il/content/kids/ktantanim-main/bluey/"),
            il_kan_kids_1021: row("il_kan_kids_1021", "פרפר נחמד", "https://www.kankids.org.il/content/kids/ktantanim-main/parpar_nehmad/"),
            il_kan_kids_1022: row("il_kan_kids_1022", "צ'רלי ולולה", "https://www.kankids.org.il/content/kids/ktantanim-main/charlie_and_lola/"),
            il_kan_teens_1000: row("il_kan_teens_1000", "הסדרתיים", "https://www.kankids.org.il/content/kids/hinuchit-main/the_serials/"),
            il_kan_teens_1018: row("il_kan_teens_1018", "המדריך לתזמורת לבני הנעורים", "https://www.kankids.org.il/content/kids/hinuchit-main/concert/"),
            il_kan_podcasts_1000: row("il_kan_podcasts_1000", "בלוקבסטר", "https://www.kan.org.il/content/kan/podcasts/blockbuster/"),
            il_kan_podcasts_1007: row("il_kan_podcasts_1007", "על פרשת דרכים", "https://www.kan.org.il/content/kan/podcasts/at-the-crossroads/")
        }
    });
    const options = { previousIndex: index };
    const urls = [
        "https://www.kankids.org.il/content/kids/ktantanim-main/bluey",
        "https://www.kankids.org.il/content/kids/ktantanim-main/tamaris_garden/",
        "https://www.kankids.org.il/content/kids/hinuchit-main/the_serials/",
        "https://www.kan.org.il/content/kan/podcasts/blockbuster"
    ];
    const expected = ["il_kan_kids_1020", "il_kan_kids_1019", "il_kan_teens_1000", "il_kan_podcasts_1000"];
    const forward = urls.map((url, index) => generateSeriesId(url, prefixFor(expected[index]), "0", options));
    const backward = [...urls].reverse().map((url, index) => {
        const id = [...expected].reverse()[index];
        return generateSeriesId(url, prefixFor(id), "0", options);
    });
    assert.deepEqual(forward, expected);
    assert.deepEqual(backward, [...expected].reverse());
    assert.equal(
        generateSeriesId("https://www.kankids.org.il/content/kids/hinuchit-main/concert", "teens", "0", options),
        "il_kan_teens_1018"
    );
    assert.equal(
        generateSeriesId("https://www.kan.org.il/content/kan/podcasts/moved/crossroads/", "podcasts", "0", {
            previousIndex: index,
            name: "על פרשת דרכים"
        }),
        "il_kan_podcasts_1007"
    );
    assert.equal(
        generateSeriesId("https://www.kankids.org.il/content/kids/ktantanim-main/brand_new_show/", "kids", "0", options),
        "il_kan_kids_brand_new_show"
    );
});

function prefixFor(id) {
    if (id.includes("_teens_")) return "teens";
    if (id.includes("_podcasts_")) return "podcasts";
    return "kids";
}

function row(id, name, link) {
    return {
        id,
        name,
        link,
        meta: { id, name, link, videos: [{ id: `${id}:1` }] }
    };
}
