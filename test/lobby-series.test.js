const test = require("node:test");
const assert = require("node:assert/strict");
const { parse } = require("node-html-parser");
const { extractLobbySeries } = require("../classes/ScraperHelpers");

test("kids lobby JSON is read from the historical script slot", () => {
    const scripts = [0, 1, 2, 3].map(n => `<script>var unused${n} = 1;</script>`).join("");
    const html = `<div class="umb-block-list"><div>${scripts}
        <script>var payload = [{"Url":"/content/kids/bluey","Image":"/bluey.jpg","Genres":"קטנטנים"}];</script>
    </div></div>`;
    const series = extractLobbySeries(parse(html));
    assert.equal(series.length, 1);
    assert.equal(series[0].Url, "/content/kids/bluey");
});

test("kids lobby JSON is still found when it is not script index 4", () => {
    const html = `<div><script>var shows = [{"Url":"/only-show","Image":"/a.jpg"}];</script></div>`;
    const series = extractLobbySeries(parse(html));
    assert.equal(series[0].Url, "/only-show");
});

test("a missing lobby document fails instead of publishing an empty catalog", () => {
    assert.throws(() => extractLobbySeries(null), /did not load/);
    assert.throws(() => extractLobbySeries(parse("<html><body>no series</body></html>")), /series list/);
});
