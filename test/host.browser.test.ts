// host.browser.test.ts: what the first real host taught. aadhar.sh adopted the
// built drop-in on 2026-10-09 and found four things the dry run of 34 sites
// could not, because the dry run injected robo-vision itself and never had to
// live with a host's deploys, its shell script, or its font:
//
//   1. a deploy deletes the hashed view an old cached entry asks for
//   2. a host loads its scripts from its own code, not from a written tag
//   3. a module runs after first paint, so a machine link flashed the page
//   4. system-ui read as a stranger on a site set in Verdana
//
// and, from re-running the dry run on these fixes, one regression of ours:
//
//   5. the eager build carried import.meta, so it could not even parse
//
// Real Chrome against dist/, served from a fake origin, as lazy.browser.test does.
import { test, expect, beforeAll, afterAll } from "bun:test";
import { chromium, type Browser, type Page, type Route } from "playwright-core";
import { PREPAINT } from "../src/prepaint.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const ORIGIN = "https://robo.test";
const ENTRY = "/__robo-vision/robo-vision.js";
let browser: Browser;

const doc = (head = "", body = `<script type="module" src="${ENTRY}"></script>`) =>
  `<!doctype html><html><head><title>host</title>${head}</head><body>
<main><h1>Host</h1><p>Nothing published, so Machine has to generate.</p></main>${body}</body></html>`;

beforeAll(async () => {
  const built = Bun.spawnSync(["bun", "scripts/build.ts"], { cwd: ROOT });
  if (built.exitCode !== 0) throw new Error(built.stderr.toString());
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);
afterAll(() => browser?.close());

interface Open {
  html: string;
  /** answer this path yourself; return false to fall through to dist/ */
  serve?: (path: string, route: Route) => Promise<boolean> | boolean;
  query?: string;
  stored?: string;
  init?: string;
}

async function open(o: Open): Promise<{ page: Page; log: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const log: string[] = [];
  await ctx.route(`${ORIGIN}/**`, async (route) => {
    const path = new URL(route.request().url()).pathname;
    log.push(path);
    if (o.serve && (await o.serve(path, route))) return;
    if (path.startsWith("/__robo-vision/")) {
      const file = Bun.file(ROOT + "dist/" + path.slice("/__robo-vision/".length));
      return (await file.exists())
        ? route.fulfill({ body: Buffer.from(await file.arrayBuffer()), contentType: "text/javascript" })
        : route.fulfill({ status: 404 });
    }
    if (path === "/") return route.fulfill({ body: o.html, contentType: "text/html" });
    return route.fulfill({ status: 404, body: "" }); // every Markdown probe misses
  });
  if (o.stored) await ctx.addInitScript(`localStorage.setItem("robo-vision:mode", ${JSON.stringify(o.stored)})`);
  if (o.init) await ctx.addInitScript(o.init);
  const page = await ctx.newPage();
  await page.goto(ORIGIN + "/" + (o.query ?? ""));
  return { page, log };
}

const docked = (page: Page) => page.waitForSelector("[data-robo-vision] .mt__btn");
const machine = async (page: Page) => {
  await page.click('[data-robo-vision] .mt__btn[data-mode="machine"]');
  await page.waitForSelector("#robo-vision-pane[data-filled], #robo-vision-pane .mv__error");
};

// ---- 1. the deploy that strands an old entry ------------------------------------

test("a view hash the deploy removed falls back to the fixed name", async () => {
  // the stranded browser: its cached entry names a chunk that 404s now
  const { page, log } = await open({ html: doc(), serve: (p, r) => (p.startsWith("/__robo-vision/chunks/") ? (r.fulfill({ status: 404 }), true) : false) });
  await docked(page);
  await machine(page);
  expect(await page.$eval("#robo-vision-pane", (p) => (p as HTMLElement).dataset.filled)).toBe("generated");
  const ours = log.filter((p) => p.startsWith("/__robo-vision/"));
  expect(ours.some((p) => p.startsWith("/__robo-vision/chunks/view-"))).toBe(true); // tried the hash first
  expect(ours).toContain("/__robo-vision/robo-vision.view.js");
  await page.context().close();
});

test("a healthy deploy never touches the fixed name", async () => {
  const { page, log } = await open({ html: doc() });
  await docked(page);
  await machine(page);
  expect(log).not.toContain("/__robo-vision/robo-vision.view.js");
  await page.context().close();
});

test("a fallback view from another release fails by name, not inside a click", async () => {
  const { page } = await open({
    html: doc(),
    serve: (p, r) => {
      if (p.startsWith("/__robo-vision/chunks/")) return (r.fulfill({ status: 404 }), true);
      if (p === "/__robo-vision/robo-vision.view.js") return (r.fulfill({ body: "export const renderPane = () => null;", contentType: "text/javascript" }), true);
      return false;
    },
  });
  await docked(page);
  await machine(page);
  const text = await page.$eval("#robo-vision-pane", (p) => p.textContent ?? "");
  expect(text).toContain("copyForThisPage");
  expect(text).toContain("reload");
  await page.context().close();
});

test("the fixed name sits beside the entry, outside chunks/", async () => {
  // a host marks chunks/* immutable; the alias must not fall under that rule
  expect(await Bun.file(ROOT + "dist/robo-vision.view.js").exists()).toBe(true);
  const glob = new Bun.Glob("dist/chunks/view-*.js");
  const hashed = [...glob.scanSync(ROOT)];
  expect(hashed.length).toBe(1);
  expect(await Bun.file(ROOT + "dist/robo-vision.view.js").text()).toBe(await Bun.file(ROOT + hashed[0]).text());
});

// ---- 2. the host's shell decides --------------------------------------------------

test("imported with no tag, it mounts nothing until the host calls mount()", async () => {
  const html = doc("", `<script type="module">import("${ENTRY}").then((m) => { window.__rv = m; });</script>`);
  const { page } = await open({ html });
  await page.waitForFunction(() => "__rv" in window);
  await page.waitForTimeout(600); // past load and idle, when a tag would have mounted
  expect(await page.$("[data-robo-vision]")).toBeNull();

  const first = await page.evaluate(async () => {
    const m = (window as unknown as { __rv: { mount: (o: object) => Promise<unknown> } }).__rv;
    const got = await m.mount({ corner: "top-left", labels: { machine: "Agent" } });
    const again = await m.mount({ corner: "bottom-right" });
    return { got: got !== null, again, corner: document.querySelector(".rv-dock")!.className, labels: [...document.querySelectorAll(".mt__btn")].map((b) => b.textContent) };
  });
  expect(first.got).toBe(true);
  expect(first.again).toBeNull(); // one dock per page; the first call's options stand
  expect(first.corner).toContain("rv-dock--top-left");
  expect(first.labels).toEqual(["Human", "Agent"]);
  await page.context().close();
});

test("a tag the host's script injects mounts from its own attributes", async () => {
  // aadhar.sh's shape: nav.js appends the tag on idle
  const html = doc("", `<script>requestIdleCallback(() => { const s = document.createElement("script"); s.type = "module"; s.src = "${ENTRY}"; s.dataset.corner = "top-right"; s.dataset.machineLabel = "Bot"; document.head.append(s); });</script>`);
  const { page } = await open({ html });
  await docked(page);
  const s = await page.evaluate(() => ({ corner: document.querySelector(".rv-dock")!.className, label: document.querySelectorAll(".mt__btn")[1].textContent }));
  expect(s.corner).toContain("rv-dock--top-right");
  expect(s.label).toBe("Bot");
  await page.context().close();
});

// ---- 3. no flash of the human page --------------------------------------------------

// Every animation frame, what a paint would have shown: the page's visibility
// and whether the pane was up. A module runs after the parser is done, and the
// browser is free to paint everything parsed before then, so these frames are
// exactly where the human page used to flash. Also records the reveal itself.
const WATCH = `window.__frames = [];
(function tick() {
  if (document.body) {
    const pane = document.getElementById("robo-vision-pane");
    window.__frames.push({ vis: getComputedStyle(document.body).visibility, pane: !!pane && pane.matches(":popover-open") });
  }
  requestAnimationFrame(tick);
})();
new MutationObserver(() => {
  if (window.__reveal || document.documentElement.hasAttribute("data-robo-vision-pending") || !window.__wasPending) {
    window.__wasPending ||= document.documentElement.hasAttribute("data-robo-vision-pending");
    return;
  }
  const pane = document.getElementById("robo-vision-pane");
  window.__reveal = { paneOpen: !!pane && pane.matches(":popover-open"), visibility: document.documentElement.style.visibility };
// document rather than documentElement: an init script runs before <html> exists
}).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-robo-vision-pending"] });`;

type Frame = { vis: string; pane: boolean };
const frames = (page: Page) => page.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);

/** hold the entry back, so the gap between parse and module is long enough to paint in */
const held = (ms: number) => async (path: string, route: Route) => {
  if (path !== ENTRY) return false;
  await new Promise((r) => setTimeout(r, ms));
  await route.fulfill({ body: Buffer.from(await Bun.file(ROOT + "dist/robo-vision.js").arrayBuffer()), contentType: "text/javascript" });
  return true;
};

test("the pre-paint snippet ships beside the entry, never inside it", async () => {
  expect(await Bun.file(ROOT + "dist/prepaint.js").text()).toBe(PREPAINT);
  // a string the HOST ships; inside the entry it was 530 dead bytes per visitor
  expect(await Bun.file(ROOT + "dist/robo-vision.js").text()).not.toContain("URLSearchParams(location.search)");
});

test("a machine link paints no frame of the human page, and reveals with the pane already up", async () => {
  const { page } = await open({ html: doc(`<script>${PREPAINT}</script>`), query: "?robo-vision=machine", init: WATCH, serve: held(400) });
  await page.waitForSelector("#robo-vision-pane:popover-open");
  await page.waitForTimeout(100);
  const all = await frames(page);
  const before = all.filter((f) => !f.pane);
  // the control: the held entry left frames for the page to paint in
  expect(before.length).toBeGreaterThan(5);
  expect(before.every((f) => f.vis === "hidden")).toBe(true);
  // and robo-vision, not the snippet's fail-open timer, is what showed it:
  // the first frame with the pane up already shows the page
  const after = all.filter((f) => f.pane);
  expect(after.length).toBeGreaterThan(0);
  expect(after.every((f) => f.vis === "visible")).toBe(true);
  const s = await page.evaluate(() => ({
    reveal: (window as unknown as { __reveal: unknown }).__reveal,
    pending: document.documentElement.hasAttribute("data-robo-vision-pending"),
    visibility: getComputedStyle(document.body).visibility,
  }));
  expect(s.reveal).toEqual({ paneOpen: true, visibility: "" }); // the pane was up before the page showed
  expect(s.pending).toBe(false);
  expect(s.visibility).toBe("visible");
  await page.context().close();
});

test("without the snippet, the same machine link does paint the human page first", async () => {
  // the control for the test above: it is the snippet that closes the gap
  const { page } = await open({ html: doc(), query: "?robo-vision=machine", init: WATCH, serve: held(400) });
  await page.waitForSelector("#robo-vision-pane:popover-open");
  expect((await frames(page)).some((f) => !f.pane && f.vis === "visible")).toBe(true);
  await page.context().close();
});

test("a machine link with no robo-vision to answer it shows the page after PENDING_MS", async () => {
  const { page } = await open({ html: doc(`<script>${PREPAINT}</script>`, ""), query: "?robo-vision=machine" });
  expect(await page.evaluate(() => getComputedStyle(document.body).visibility)).toBe("hidden");
  await page.waitForFunction(() => getComputedStyle(document.body).visibility === "visible", null, { timeout: 5000 });
  expect(await page.evaluate(() => document.documentElement.hasAttribute("data-robo-vision-pending"))).toBe(false);
  await page.context().close();
});

test("a human visit is never hidden", async () => {
  for (const o of [{}, { stored: "human" }, { query: "?robo-vision=human", stored: "machine" }, { query: "?robo-vision=bogus" }]) {
    const { page } = await open({ html: doc(`<script>${PREPAINT}</script>`), init: WATCH, ...o });
    await page.waitForTimeout(100);
    expect((await frames(page)).every((f) => f.vis === "visible")).toBe(true);
    expect(await page.evaluate(() => document.documentElement.hasAttribute("data-robo-vision-pending"))).toBe(false);
    await page.context().close();
  }
});

// ---- 4. the site's font ------------------------------------------------------------

const fonts = (page: Page) => page.evaluate(() => ({
  dock: getComputedStyle(document.querySelector(".rv-dock")!).fontFamily,
  button: getComputedStyle(document.querySelector(".mt__btn")!).fontFamily,
  pane: getComputedStyle(document.querySelector("#robo-vision-pane")!).fontFamily,
}));

test("the dock and the pane wear the font the page's body does", async () => {
  const { page } = await open({ html: doc("<style>body { font-family: Georgia, serif }</style>") });
  await docked(page);
  expect(await fonts(page)).toEqual({ dock: "Georgia, serif", button: "Georgia, serif", pane: "Georgia, serif" });
  await page.context().close();
});

test("only the family is the site's: a light or italic body leaves the toggle upright and regular", async () => {
  // inheriting weight gave react.dev's toggle its body weight in the dry run
  const { page } = await open({ html: doc("<style>body { font: italic 300 16px Georgia }</style>") });
  await docked(page);
  const s = await page.$eval(".mt__btn", (b) => ({ family: getComputedStyle(b).fontFamily, weight: getComputedStyle(b).fontWeight, style: getComputedStyle(b).fontStyle, size: getComputedStyle(b).fontSize }));
  expect(s).toEqual({ family: "Georgia", weight: "400", style: "normal", size: "13px" });
  await page.context().close();
});

test("a body with no font of its own gets system-ui, not Times", async () => {
  // bbc.com and nytimes.com set their font on a wrapper inside <body>
  const { page } = await open({ html: doc("<style>main { font-family: Georgia }</style>") });
  await docked(page);
  expect(await fonts(page)).toEqual({ dock: "system-ui, sans-serif", button: "system-ui, sans-serif", pane: "system-ui, sans-serif" });
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--rv-font-fallback"))).toBe(""); // nothing on the host's root
  await page.context().close();
});

test("a site's --rv-font wins over both", async () => {
  for (const head of ["<style>:root { --rv-font: Verdana } body { font-family: Georgia }</style>", "<style>:root { --rv-font: Verdana }</style>"]) {
    const { page } = await open({ html: doc(head) });
    await docked(page);
    expect((await fonts(page)).dock).toBe("Verdana");
    await page.context().close();
  }
});

// ---- 5. the eager build parses, and mounts both ways a host runs it -----------------

test("the eager build parses as a classic script", async () => {
  // import.meta and a static import are SyntaxErrors outside a module, which
  // kill the whole file before a line runs; a dynamic import() is legal there
  const eager = await Bun.file(ROOT + "dist/robo-vision.eager.js").text();
  expect(eager).not.toContain("import.meta");
  expect(() => new Function(eager)).not.toThrow(); // a function body parses as script, not module
});

for (const [how, body] of [
  ["a classic <script src> with options", `<script src="/__robo-vision/robo-vision.eager.js" data-corner="top-left" data-machine-label="Agent"></script>`],
  ["evaluated with no tag at all", `<script>fetch("/__robo-vision/robo-vision.eager.js").then((r) => r.text()).then((js) => (0, eval)(js));</script>`],
] as const) {
  test(`the eager build mounts and fills the pane: ${how}`, async () => {
    const errors: string[] = [];
    const { page } = await open({ html: doc("", body) });
    page.on("pageerror", (e) => errors.push(e.message));
    await docked(page);
    await machine(page);
    expect(await page.$eval("#robo-vision-pane", (p) => (p as HTMLElement).dataset.filled)).toBe("generated");
    if (how.includes("options")) expect(await page.$eval(".rv-dock", (d) => d.className)).toContain("rv-dock--top-left");
    expect(errors).toEqual([]);
    await page.context().close();
  });
}
