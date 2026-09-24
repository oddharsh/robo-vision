// navigate.browser.test.ts: staying in machine view from page to page.
//
// A fake origin serves four pages. /a has no Markdown twin, /b and /d have .md
// twins, /c has nothing at all. Every request is logged with its type, so
// "fetched a copy" and "loaded a page" cannot be confused: the whole point is
// that following a link in the pane costs a Markdown request, not a document.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

const ROOT = new URL("..", import.meta.url).pathname;
const O = "https://robo.test";
let browser: Browser;

const html = (title: string, body: string) => `<!doctype html><html><head><title>${title}</title></head><body>
<main><h1>${title}</h1>${body}</main>
<script type="module" src="/__robo-vision/robo-vision.js"></script></body></html>`;

const PAGES: Record<string, string> = {
  "/a": html("Page A", `<p>Start here. <a href="/b">to B</a> or <a href="/c">to C</a>.</p>`),
  "/b": html("Page B", `<p>B as HTML.</p>`),
  "/c": html("Page C", `<p>C serves no Markdown, so it generates.</p>`),
  "/d": html("Page D", `<p>D as HTML.</p>`),
  // a section that serves no Markdown anywhere
  "/n/a": html("Nothing A", `<p>No twin here. On to <a href="/n/b">N/B</a>.</p>`),
  "/n/b": html("Nothing B", `<p>None here either. Over to <a href="/b">B</a>, which has one.</p>`),
  // the page a .md mirrors; /m/only.md mirrors nothing, and /m/only is a 404
  "/m/mirror": html("Mirror page", `<p>The human page behind /m/mirror.md.</p>`),
};
const TWINS: Record<string, string> = {
  "/b.md": `# Page B, the twin\n\nOn to [C](/c) or [D](/d), or [back to A](/a). Also [a mirror](/m/mirror.md) and [a file](/m/only.md).\n`,
  "/m/mirror.md": `# Mirror, the twin\n\nBack to [B](/b), or on to [D](/d).\n`,
  "/m/only.md": `# Only Markdown\n\nNo page stands behind this file.\n`,
  "/d.md": `# Page D, the twin\n\nBack to [B](/b).\n`,
};

beforeAll(async () => {
  const built = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: ROOT });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);
afterAll(() => browser?.close());

async function site(): Promise<{ ctx: BrowserContext; log: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const log: string[] = [];
  await ctx.route(`${O}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname;
    if (path.startsWith("/__robo-vision/")) {
      const f = Bun.file(ROOT + "dist/" + path.slice(15));
      return route.fulfill({ body: Buffer.from(await f.arrayBuffer()), contentType: "text/javascript" });
    }
    const md = /markdown/.test(req.headers()["accept"] ?? "");
    log.push(`${req.method() === "HEAD" ? "head" : req.resourceType() === "document" ? "doc" : "fetch"} ${path}${url.search}`);
    if (TWINS[path]) return route.fulfill({ body: TWINS[path], contentType: "text/markdown" });
    // pages answer HTML whatever is asked, and say so honestly with Vary
    if (PAGES[path]) return route.fulfill({ body: PAGES[path], contentType: "text/html", headers: { vary: "Accept" } });
    return route.fulfill({ status: 404, body: md ? "" : "<!doctype html>404", contentType: "text/html" });
  });
  return { ctx, log };
}

const pane = (p: Page) => p.evaluate(() => {
  const el = document.querySelector("#robo-vision-pane") as HTMLElement;
  return { url: el.dataset.url, step: el.dataset.filled, text: el.querySelector("pre")?.textContent ?? "", open: !el.hidden };
});
const settle = (p: Page, path: string) => p.waitForFunction((u) => (document.querySelector("#robo-vision-pane") as HTMLElement)?.dataset.url === u, `${O}${path}`);
const since = (log: string[], n: number) => log.slice(n);

test("a link in the pane fetches that page's copy instead of loading the page", async () => {
  const { ctx, log } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/a`);
  await p.click('[data-robo-vision] .mt__btn[data-mode="machine"]');
  await settle(p, "/a");
  expect(p.url()).toBe(`${O}/a?robo-vision=machine`); // the address carries the mode

  const n = log.length;
  await p.click(`#robo-vision-pane a.mv__link[href="${O}/b"]`);
  await settle(p, "/b");
  expect(p.url()).toBe(`${O}/b?robo-vision=machine`);
  expect((await pane(p)).text).toContain("# Page B, the twin");
  const after = since(log, n);
  expect(after.some((l) => l.startsWith("doc"))).toBe(false); // no page load
  expect(after).toEqual(["fetch /b", "fetch /b.md"]); // negotiated, then the suffix
  await ctx.close();
});

test("hovering a link fetches its copy; the click then renders it with no request", async () => {
  const { ctx, log } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/b?robo-vision=machine`);
  await settle(p, "/b");
  const n = log.length;
  await p.hover(`#robo-vision-pane a.mv__link[href="${O}/d"]`);
  await p.waitForTimeout(300);
  // /b was served by its .md, so the origin is remembered as a suffix origin
  // and /d is asked for its .md first, with nothing negotiated
  expect(since(log, n)).toEqual(["fetch /d.md"]);
  const m = log.length;
  await p.click(`#robo-vision-pane a.mv__link[href="${O}/d"]`);
  await settle(p, "/d");
  expect(since(log, m)).toEqual([]);
  expect((await pane(p)).text).toContain("# Page D, the twin");
  await ctx.close();
});

test("back and forward move through the pane's pages from cache", async () => {
  const { ctx, log } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/a`);
  await p.click('[data-robo-vision] .mt__btn[data-mode="machine"]');
  await settle(p, "/a");
  await p.click(`#robo-vision-pane a.mv__link[href="${O}/b"]`);
  await settle(p, "/b");
  const n = log.length;
  await p.goBack();
  await settle(p, "/a");
  expect((await pane(p)).text).toContain("# Page A");
  await p.goForward();
  await settle(p, "/b");
  expect(since(log, n)).toEqual([]);
  await ctx.close();
});

test("a page that serves nothing is loaded for real, still in machine view", async () => {
  const { ctx, log } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/b?robo-vision=machine`);
  await settle(p, "/b");
  await Promise.all([p.waitForURL(`${O}/c?robo-vision=machine`), p.click(`#robo-vision-pane a.mv__link[href="${O}/c"]`)]);
  await settle(p, "/c");
  const c = await pane(p);
  expect(c.step).toBe("generated");
  expect(c.text).toContain("C serves no Markdown");
  expect(log).toContain("doc /c?robo-vision=machine");
  await ctx.close();
});

test("Human on a page the pane moved to loads that page for real", async () => {
  const { ctx } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/a`);
  await p.click('[data-robo-vision] .mt__btn[data-mode="machine"]');
  await settle(p, "/a");
  await p.click(`#robo-vision-pane a.mv__link[href="${O}/b"]`);
  await settle(p, "/b");
  await Promise.all([p.waitForURL(`${O}/b`), p.click('[data-robo-vision] .mt__btn[data-mode="human"]')]);
  await p.waitForSelector("[data-robo-vision] .mt__btn");
  expect(await p.evaluate(() => document.querySelector("h1")?.textContent)).toBe("Page B");
  expect(await p.evaluate(() => document.documentElement.getAttribute("data-robo-vision-mode"))).toBe("human");
  expect((await pane(p)).open).toBe(false);
  await ctx.close();
});

test("a pasted machine link opens in machine view with no stored preference", async () => {
  const { ctx } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/d?robo-vision=machine`);
  await settle(p, "/d");
  expect((await pane(p)).text).toContain("# Page D, the twin");
  expect(await p.evaluate(() => localStorage.getItem("robo-vision:mode"))).toBe(null);
  await ctx.close();
});

test("after one miss, the rest of that section generates without asking", async () => {
  const { ctx, log } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/n/a?robo-vision=machine`);
  await settle(p, "/n/a");
  // the first page of the section pays to find out
  expect(log.filter((l) => l.startsWith("fetch"))).toEqual(["fetch /n/a", "fetch /n/a.md"]);

  const n = log.length;
  await Promise.all([p.waitForURL(`${O}/n/b?robo-vision=machine`), p.click(`#robo-vision-pane a.mv__link[href="${O}/n/b"]`)]);
  await settle(p, "/n/b");
  // the second pays nothing: no negotiation, no .md, just the page itself
  expect(since(log, n)).toEqual(["doc /n/b?robo-vision=machine"]);
  const b = await p.evaluate(() => ({
    step: (document.querySelector("#robo-vision-pane") as HTMLElement).dataset.filled,
    how: [...document.querySelectorAll("#robo-vision-pane .mv__attempts li")].map((li) => li.textContent).join(" | "),
  }));
  expect(b.step).toBe("generated");
  expect(b.how).toContain("not asked: /n served no Markdown earlier this session");

  // another section is still asked, and still found
  const m = log.length;
  await p.click(`#robo-vision-pane a.mv__link[href="${O}/b"]`);
  await settle(p, "/b");
  expect(since(log, m)).toEqual(["fetch /b", "fetch /b.md"]);
  await ctx.close();
});

test("a .md link to a real page puts that page's address in the bar", async () => {
  const { ctx, log } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/b?robo-vision=machine`);
  await settle(p, "/b");
  const n = log.length;
  await p.click(`#robo-vision-pane a.mv__link[href="${O}/m/mirror.md"]`);
  await settle(p, "/m/mirror");
  expect(p.url()).toBe(`${O}/m/mirror?robo-vision=machine`);
  const after = since(log, n);
  expect(after.sort()).toEqual(["fetch /m/mirror.md", "head /m/mirror"]); // the copy, and the check
  const c = await pane(p);
  expect(c.text).toContain("# Mirror, the twin");
  expect(await p.evaluate(() => document.querySelector("#robo-vision-pane .mv__cell")?.textContent)).toBe("a .md file, linked from the last copy");

  // the site's lookup memory is untouched: /d is still asked for its .md first
  const m = log.length;
  await p.hover(`#robo-vision-pane a.mv__link[href="${O}/d"]`);
  await p.waitForTimeout(300);
  expect(since(log, m)).toEqual(["fetch /d.md"]);

  // and Human now loads the real page instead of a raw .md file
  await Promise.all([p.waitForURL(`${O}/m/mirror`), p.click('[data-robo-vision] .mt__btn[data-mode="human"]')]);
  await p.waitForSelector("[data-robo-vision] .mt__btn");
  expect(await p.evaluate(() => document.querySelector("h1")?.textContent)).toBe("Mirror page");
  await ctx.close();
});

test("a .md link with no page behind it keeps its address; Human goes back to a real page", async () => {
  const { ctx, log } = await site();
  const p = await ctx.newPage();
  await p.goto(`${O}/b?robo-vision=machine`);
  await settle(p, "/b");
  const n = log.length;
  await p.click(`#robo-vision-pane a.mv__link[href="${O}/m/only.md"]`);
  await settle(p, "/m/only.md");
  expect(p.url()).toBe(`${O}/m/only.md?robo-vision=machine`);
  expect(since(log, n).sort()).toEqual(["fetch /m/only.md", "head /m/only"]); // /m/only answered 404
  expect((await pane(p)).text).toContain("# Only Markdown");

  // /b is the document still loaded under the pane, so Human needs no load
  const m = log.length;
  await p.click('[data-robo-vision] .mt__btn[data-mode="human"]');
  await p.waitForFunction(() => document.documentElement.getAttribute("data-robo-vision-mode") === "human");
  expect(p.url()).toBe(`${O}/b`);
  expect(await p.evaluate(() => document.querySelector("h1")?.textContent)).toBe("Page B");
  expect((await pane(p)).open).toBe(false);
  expect(since(log, m).some((l) => l.startsWith("doc"))).toBe(false);
  await ctx.close();
});
