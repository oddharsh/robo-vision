// generate.browser.test.ts: the generator in real Chrome, on one fixture per
// failure the dry run found. Needs Chrome installed (channel "chrome").
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser } from "playwright-core";

let browser: Browser;
let md = "";

const FIXTURE = `<!doctype html><html><head><title>fixture</title><base href="https://example.test/"></head><body><main>
<h1>Title</h1>
<table><tr><td>1.</td><td><a href="/a">Story</a></td></tr><tr><td></td><td>291 points</td></tr></table>
<div style="display:flex"><strong>12038</strong><span>Branches</span></div>
<a href="/card"><div>Headline</div><div>Standfirst</div></a>
<x-card><em>slotted</em></x-card>
<div style="display:contents"><p>contents child</p></div>
<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>
<div style="display:none">gone</div>
<details><summary>Question</summary><p>Closed answer</p></details>
<div hidden="until-found">Findable text</div>
<p><button>Buy now</button> after the button</p>
<a href="/mac" style="display:block"><img alt="A Mac" src="/mac.jpg"><span>Learn more</span></a>
<picture><img style="display:block" alt="Block image" src="/p.jpg"></picture>
<picture><source srcset="data:image/gif;base64,R0lGODlhAQABAHAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw=="><img alt="Lazy image" src="/lazy.jpg"></picture>
<div style="display:flex"><a href="/l" style="display:block">Learn</a><a href="/b" style="display:block">Buy</a></div>
<script type="application/json">{"secret":"answer key"}</script>
</main>
<script>
customElements.define("x-card", class extends HTMLElement {
  constructor() { super(); this.attachShadow({ mode: "open" }).innerHTML = "<h2>Shadow heading</h2><p>Shadow text <slot></slot></p>"; }
});
</script></body></html>`;

beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [new URL("./fixtures/gen-entry.ts", import.meta.url).pathname], format: "iife", target: "browser" });
  const js = await built.outputs[0].text();
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  await page.setContent(FIXTURE);
  await page.evaluate(js);
  md = await page.evaluate(() => (globalThis as unknown as { __gen: (d: Document) => string }).__gen(document));
}, 30_000);
afterAll(() => browser?.close());

test("layout-table rows are separate lines, cells are spaced", () => {
  expect(md).toContain("1. [Story](https://example.test/a)");
  expect(md).toMatch(/\n\n291 points\n/);
});

test("flex children are set apart", () => expect(md).toContain("**12038** Branches"));

test("block children inside a link stay separate phrases", () => expect(md).toContain("[Headline Standfirst](https://example.test/card)"));

test("open shadow roots and slots render as the page does", () => {
  expect(md).toContain("## Shadow heading");
  expect(md).toContain("Shadow text _slotted_");
});

test("display:contents children join the flow", () => expect(md).toMatch(/\n\ncontents child\n/));

test("a table with header cells is a pipe table", () => expect(md).toContain("| a | b |\n| --- | --- |\n| 1 | 2 |"));

test("a display:block link keeps its URL, alone or in a flex row", () => {
  expect(md).toContain("[![A Mac](https://example.test/mac.jpg)Learn more](https://example.test/mac)");
  expect(md).toContain("[Learn](https://example.test/l) [Buy](https://example.test/b)");
});

test("a lazy placeholder in currentSrc does not hide the real src", () => expect(md).toContain("![Lazy image](https://example.test/lazy.jpg)"));

test("a display:block image is kept", () => expect(md).toContain("![Block image](https://example.test/p.jpg)"));

test("collapsed content is kept: closed details, hidden=until-found", () => {
  expect(md).toContain("Question");
  expect(md).toContain("Closed answer");
  expect(md).toContain("Findable text");
});

test("hidden, controls and script bodies never appear", () => {
  expect(md).not.toContain("gone");
  expect(md).not.toContain("Buy now");
  expect(md).not.toContain("answer key");
  expect(md).toContain("after the button");
});
