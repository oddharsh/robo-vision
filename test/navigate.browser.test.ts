// navigate.browser.test.ts: the real history adapter, wired. Which address
// the pane should be on after a click, a Human press or Back is decided in
// session.ts and checked in session.test.ts; which requests a link costs is
// copies.ts, checked in copies.test.ts. These three prove the browser does
// what both promise: pushState with no page load, Back from cache, and a real
// load for a page that serves nothing.
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

// what the pane holds, read through the toggle's interface, not its markup
type ShownCopy = { kind: string; url: string; copy?: { step: string; text: string } };
const pane = (p: Page) => p.evaluate(() => {
  const s = (document.querySelector("mode-toggle") as unknown as { shown: ShownCopy | null }).shown;
  return { url: s?.url, step: s?.copy?.step, text: s?.copy?.text ?? "", open: !(document.querySelector("#robo-vision-pane") as HTMLElement).hidden };
});
const settle = (p: Page, path: string) => p.waitForFunction((u) => {
  const s = (document.querySelector("mode-toggle") as unknown as { shown: ShownCopy | null } | null)?.shown;
  return s?.kind === "copy" && s.url === u;
}, `${O}${path}`);
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
