// lazy.browser.test.ts: the built drop-in loads its view on intent, not on
// page load. Drives real Chrome against dist/, served from a fake origin, and
// asserts on which files were requested when.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page } from "playwright-core";

const ROOT = new URL("..", import.meta.url).pathname;
const ORIGIN = "https://robo.test";
let browser: Browser;

const PAGE = `<!doctype html><html><head><title>lazy</title></head><body>
<main><h1>Lazy</h1><p>Nothing published, so Machine has to generate.</p></main>
<script type="module" src="/__robo-vision/robo-vision.js"></script></body></html>`;

beforeAll(async () => {
  const built = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: ROOT });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);
afterAll(() => browser?.close());

// every request to the fake origin, in order, as a path
async function open(stored?: string): Promise<{ page: Page; log: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const log: string[] = [];
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    log.push(path);
    if (path.startsWith("/__robo-vision/")) {
      const file = Bun.file(ROOT + "dist/" + path.slice("/__robo-vision/".length));
      return (await file.exists())
        ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: "text/javascript" })
        : route.fulfill({ status: 404 });
    }
    if (path === "/") return route.fulfill({ body: PAGE, contentType: "text/html" });
    return route.fulfill({ status: 404, body: "" }); // every Markdown probe misses
  });
  if (stored) await ctx.addInitScript(`localStorage.setItem("robo-vision:mode", ${JSON.stringify(stored)})`);
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/");
  await page.waitForSelector("[data-robo-vision] .mt__btn");
  await page.waitForTimeout(300);
  return { page, log };
}

// strings that exist only in the resolver, the generator and the pane
const HEAVY = ["labelled Markdown, body is HTML", "hidden=until-found", "generated here from the live page", "mv__well"];

test("the entry carries none of the view: it lives in chunks", async () => {
  // A request log cannot see this. With the view imported statically by
  // mistake, the bundler inlined all of it into the entry and STILL emitted
  // 73-byte stub chunks, which a hover then fetched, so every load-order test
  // passed over a 23 KB entry. Only the bytes can tell the two apart.
  const entry = await Bun.file(ROOT + "dist/robo-vision.js").text();
  const glob = new Bun.Glob("dist/chunks/*.js");
  let lazy = "";
  for await (const f of glob.scan(ROOT)) lazy += await Bun.file(ROOT + f).text();
  for (const s of HEAVY) {
    expect(entry.includes(s), `entry must not contain ${JSON.stringify(s)}`).toBe(false);
    expect(lazy.includes(s), `chunks must contain ${JSON.stringify(s)}`).toBe(true);
  }
});

const chunks = (log: string[]) => log.filter((p) => p.startsWith("/__robo-vision/chunks/"));

test("page load fetches the entry and nothing else of ours", async () => {
  const { page, log } = await open();
  expect(log.filter((p) => p.startsWith("/__robo-vision/"))).toEqual(["/__robo-vision/robo-vision.js"]);
  await page.context().close();
});

test("hovering the toggle prefetches the view without fetching any copy", async () => {
  const { page, log } = await open();
  await page.hover('[data-robo-vision] .mt__btn[data-mode="machine"]');
  await page.waitForTimeout(300);
  expect(chunks(log).length).toBeGreaterThan(0);
  expect(log.some((p) => p.endsWith(".md"))).toBe(false); // intent loads code, never the copy
  await page.context().close();
});

test("clicking Machine fills the pane from the lazy view", async () => {
  const { page, log } = await open();
  const before = chunks(log).length;
  expect(before).toBe(0);
  await page.click('[data-robo-vision] .mt__btn[data-mode="machine"]');
  await page.waitForSelector("#robo-vision-pane[data-filled]");
  const pane = await page.evaluate(() => ({
    step: (document.querySelector("#robo-vision-pane") as HTMLElement).dataset.filled,
    text: document.querySelector("#robo-vision-pane pre")?.textContent ?? "",
    font: getComputedStyle(document.querySelector("#robo-vision-pane pre")!).fontFamily,
  }));
  expect(pane.step).toBe("generated");
  expect(pane.text).toContain("# Lazy");
  expect(pane.font).toContain("Courier"); // the pane's skin arrived with the view
  await page.context().close();
});

test("a stored machine mode loads the view straight away", async () => {
  const { page, log } = await open("machine");
  await page.waitForSelector("#robo-vision-pane[data-filled]");
  expect(chunks(log).length).toBeGreaterThan(0);
  await page.context().close();
});
