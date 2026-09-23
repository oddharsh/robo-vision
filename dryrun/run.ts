// run.ts: drop robo-vision into live sites and record where it breaks.
//
//   bun scripts/build.ts && bun dryrun/run.ts [--only <substring>] [--jobs 4]
//
// Each site loads in real Chrome with its OWN CSP in force; nothing is
// bypassed. That models a site that hosts robo-vision itself, so the lazy
// build is served from the site's own origin at /__robo-vision/ (a Playwright
// route) and loaded with a module script, the way a deployment would load it,
// and its chunks arrive on hover or click like they would in production.
// Where the page's script-src refuses that path, the site would host the file
// wherever its policy allows, so the single-file build is evaluated over CDP
// instead and the fallback is recorded. Either way everything the code DOES
// (fetch, DOM writes, adopted styles) meets the page's real policy. Findings
// are facts the harness can check on its own; judging Markdown quality is
// left to the saved files.

import { chromium, type Page } from "playwright-core";
import { SITES, type Site } from "./sites.ts";
import { mkdir } from "node:fs/promises";

const root = new URL("..", import.meta.url).pathname;
const OUT = root + "dryrun/out/";
const DIST = root + "dist/";
const eager = await Bun.file(DIST + "robo-vision.eager.js").text();
const MOUNT = "/__robo-vision/";

const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const jobs = args.includes("--jobs") ? Number(args[args.indexOf("--jobs") + 1]) : 4;
const roster = only ? SITES.filter((s) => s.url.includes(only)) : SITES;

const slug = (u: string) => new URL(u).hostname.replace(/^www\./, "") + new URL(u).pathname.replace(/\/+$/, "").replace(/\//g, "_");

// the styles we expect the Machine button to compute to, read off a blank page
const STYLE_PROPS = ["fontFamily", "fontSize", "fontWeight", "paddingLeft", "paddingTop", "marginTop", "marginLeft", "borderTopWidth", "borderTopStyle", "height", "width", "minWidth", "backgroundColor", "color", "lineHeight", "textTransform", "textAlign", "letterSpacing", "boxSizing", "borderRadius", "verticalAlign", "boxShadow"] as const;

// installed before any page script: CSP violations, and a log of every fetch
// the resolver makes (it binds globalThis.fetch at call time, so a wrapper
// installed first sees them all)
const INIT = `
  window.__rv = { violations: [], fetches: [] };
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__rv.violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: (e.sample || "").slice(0, 80) });
  });
`;
const WRAP_FETCH = `
  (() => {
    const orig = window.fetch;
    window.fetch = function (input, init) {
      const url = String(input && input.url || input);
      const accept = init && init.headers && (init.headers.accept || init.headers.Accept) || "";
      if (!/markdown/.test(accept)) return orig.apply(this, arguments);
      const rec = { url, t0: performance.now(), status: null, ms: null, error: null };
      window.__rv.fetches.push(rec);
      return orig.apply(this, arguments).then(
        (r) => { rec.status = r.status; rec.ms = Math.round(performance.now() - rec.t0); return r; },
        (e) => { rec.error = String(e && e.message || e); rec.ms = Math.round(performance.now() - rec.t0); throw e; });
    };
  })();
`;

async function facts(page: Page) {
  return page.evaluate(() => {
    const html = document.documentElement;
    const attrs = Object.fromEntries([...html.attributes].map((a) => [a.name, a.value]));
    const all = document.querySelectorAll("*");
    let shadow = 0;
    for (const el of all) if ((el as Element).shadowRoot) shadow++;
    const meta = (n: string) => document.querySelector(`meta[name="${n}" i]`)?.getAttribute("content") ?? null;
    const w = window as unknown as Record<string, unknown>;
    const hints = [
      w.__NEXT_DATA__ || document.querySelector("script#__NEXT_DATA__") ? "next-pages" : null,
      document.querySelector('script[src*="/_next/"]') ? "next" : null,
      document.querySelector("astro-island") ? "astro-islands" : null,
      w.__NUXT__ || document.querySelector("#__nuxt") ? "nuxt" : null,
      document.querySelector("[ng-version]") ? "angular" : null,
      w.__sveltekit_dev || document.querySelector('[data-sveltekit-preload-data], script[type="module"][data-sveltekit-hydrate]') ? "sveltekit" : null,
      document.querySelector('link[href*="wp-content"], script[src*="wp-includes"]') ? "wordpress" : null,
      w.Shopify ? "shopify" : null,
      document.querySelector("html[data-wf-site]") ? "webflow" : null,
      w.___gatsby ? "gatsby" : null,
    ].filter(Boolean);
    const main = document.querySelector("main, [role=main]") ?? document.querySelector("article");
    return {
      title: document.title,
      htmlAttrs: attrs,
      generator: meta("generator"),
      hints,
      elements: all.length,
      shadowRoots: shadow,
      hasMain: !!document.querySelector("main, [role=main]"),
      mainChars: (main as HTMLElement | null)?.innerText.length ?? null,
      bodyChars: document.body?.innerText.length ?? 0,
      alternates: [...document.querySelectorAll('link[rel~="alternate" i][type]')].map((l) => `${(l as HTMLLinkElement).type} ${l.getAttribute("href")}`),
      machineOnly: !!document.querySelector("[data-machine-only]"),
      modeToggleTaken: !!customElements.get("mode-toggle"),
      trustedTypes: !!(window as unknown as { trustedTypes?: unknown }).trustedTypes,
    };
  });
}

async function styleOf(page: Page) {
  return page.evaluate((props) => {
    const b = document.querySelector('[data-robo-vision] .mt__btn[data-mode="machine"]') as HTMLElement | null;
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    // which scheme the dock actually resolved: CanvasText is light on dark
    const probe = document.createElement("span");
    probe.style.color = "CanvasText";
    b.parentElement!.append(probe);
    const [cr, cg, cb] = getComputedStyle(probe).color.match(/\d+/g)!.map(Number);
    probe.remove();
    return { rect: { x: r.x, y: r.y, w: r.width, h: r.height }, dark: cr + cg + cb > 382, css: Object.fromEntries(props.map((p) => [p, cs[p as keyof CSSStyleDeclaration] as string])) };
  }, STYLE_PROPS as unknown as string[]);
}

/** what the user would actually hit at a point: ours, or the page's */
async function topAt(page: Page, x: number, y: number) {
  return page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    if (!el) return { ours: false, what: "nothing" };
    const ours = !!el.closest("[data-robo-vision]");
    const d = (e: Element) => e.tagName.toLowerCase() + (e.id ? "#" + e.id : "") + (typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
    return { ours, what: d(el), zIndex: getComputedStyle(el).zIndex };
  }, [x, y] as [number, number]);
}

// one baseline per color scheme: the base's defaults are system colors, so a
// dark site turning the dock dark is the design working, and comparing it to a
// light baseline reported nuxt.com as "page CSS changed the toggle"
async function baseline(scheme: "light" | "dark") {
  const b = await chromium.launch({ channel: "chrome", headless: true });
  const page = await b.newPage({ viewport: { width: 1280, height: 900 } });
  await page.setContent(`<!doctype html><html><head><title>baseline</title><style>:root{color-scheme:${scheme}}</style></head><body><main><p>x</p></main></body></html>`);
  await page.evaluate(eager);
  // it mounts on idle now, so wait for it rather than read an empty page
  await page.waitForSelector("[data-robo-vision] .mt__btn");
  const s = await styleOf(page);
  await b.close();
  return s!;
}

type Base = NonNullable<Awaited<ReturnType<typeof styleOf>>>;
async function runSite(browser: Awaited<ReturnType<typeof chromium.launch>>, site: Site, bases: { light: Base; dark: Base }) {
  const dir = OUT + slug(site.url) + "/";
  await mkdir(dir, { recursive: true });
  const r: Record<string, unknown> = { ...site, findings: [] as string[] };
  const find = (f: string) => (r.findings as string[]).push(f);
  // service workers blocked: a site's worker would otherwise answer our path
  // before the route below ever sees it
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" });
  await ctx.addInitScript(INIT);
  const served: { path: string; t: number; bytes: number }[] = [];
  await ctx.route((u) => u.pathname.startsWith(MOUNT), async (route) => {
    const path = new URL(route.request().url()).pathname;
    const file = Bun.file(DIST + path.slice(MOUNT.length));
    if (!(await file.exists())) return route.fulfill({ status: 404, body: "" });
    const body = Buffer.from(await file.arrayBuffer());
    served.push({ path: path.slice(MOUNT.length), t: Date.now(), bytes: body.length });
    return route.fulfill({ body, contentType: "text/javascript", headers: { "cache-control": "no-store" } });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
  const t0 = Date.now();
  try {
    let res;
    try {
      res = await page.goto(site.url, { waitUntil: "load", timeout: 45_000 });
    } catch (e) {
      find(`load did not finish in 45s (${(e as Error).message.split("\n")[0].slice(0, 80)})`);
      res = null;
    }
    r.status = res?.status() ?? null;
    r.finalUrl = page.url();
    const h = res?.headers() ?? {};
    r.csp = h["content-security-policy"] ?? null;
    r.server = h["server"] ?? null;
    await page.waitForTimeout(1500);

    const before = await facts(page);
    r.before = before;
    if (before.modeToggleTaken) find("mode-toggle already defined by the page");

    await page.evaluate(WRAP_FETCH);
    const errBefore = errors.length;
    const vBefore = await page.evaluate(() => (window as unknown as { __rv: { violations: unknown[] } }).__rv.violations.length);
    // a name we are about to write, already in use by the page
    for (const k of Object.keys(before.htmlAttrs)) if (k.startsWith("data-robo-vision")) find(`page already uses <html ${k}>`);
    const tInject = Date.now();
    await page.evaluate((src) => {
      const s = document.createElement("script");
      s.type = "module";
      s.src = src;
      document.head.append(s);
    }, MOUNT + "robo-vision.js");
    const lazyOk = await page.waitForFunction(() => !!document.querySelector("[data-robo-vision] .mt__btn"), null, { timeout: 8_000 }).then(() => true, () => false);
    r.load = "lazy";
    if (!lazyOk) {
      const refused = await page.evaluate((m) => (window as unknown as { __rv: { violations: { directive: string; blocked: string }[] } }).__rv.violations
        .some((v) => /script-src/.test(v.directive) && v.blocked.includes(m)), MOUNT);
      r.load = refused ? "eager: script-src refuses a same-origin path" : "eager: module script did not mount";
      try {
        await page.evaluate(eager);
        await page.waitForFunction(() => !!document.querySelector("[data-robo-vision] .mt__btn"), null, { timeout: 8_000 }).catch(() => {});
      } catch (e) {
        find(`inject threw: ${(e as Error).message.split("\n")[0].slice(0, 160)}`);
      }
    }
    const defined = await page.evaluate(() => !!document.querySelector("[data-robo-vision] .mt__btn"));
    r.mounted = defined;
    if (!defined) {
      find("toggle did not mount");
      r.errors = errors.slice(errBefore);
      return r;
    }

    const afterInit = await page.evaluate(() => Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value])));
    for (const [k, v] of Object.entries(before.htmlAttrs)) {
      if (afterInit[k] !== v) find(`init changed <html ${k}>: ${JSON.stringify(v)} -> ${JSON.stringify(afterInit[k])}`);
    }

    // does the page's CSS reach into our toggle?
    const st = await styleOf(page);
    r.style = st;
    const base = bases[st?.dark ? "dark" : "light"];
    r.scheme = st?.dark ? "dark" : "light";
    const drift = st ? STYLE_PROPS.filter((p) => st.css[p] !== base.css[p]).map((p) => `${p}: ${base.css[p]} -> ${st.css[p]}`) : [];
    r.styleDrift = drift;
    if (drift.length) find(`page CSS changed the toggle (${drift.length} props)`);

    await page.screenshot({ path: dir + "human.png" });

    // click Machine the way a person would; fall back only if something sits on top
    const cx = st!.rect.x + st!.rect.w / 2, cy = st!.rect.y + st!.rect.h / 2;
    const hit = await topAt(page, cx, cy);
    r.toggleCovered = hit.ours ? null : hit;
    const tClick = Date.now();
    if (hit.ours) await page.mouse.click(cx, cy);
    else {
      find(`toggle covered by ${hit.what} (z ${hit.zIndex})`);
      await page.evaluate(() => (document.querySelector("mode-toggle") as unknown as { choose(m: string): Promise<void> }).choose("machine"));
    }

    const done = await page.waitForFunction(() => {
      const p = document.querySelector("#robo-vision-pane") as HTMLElement | null;
      return p && (p.dataset.filled || p.querySelector(".mv__error")) ? true : false;
    }, null, { timeout: 30_000 }).then(() => true, () => false);
    r.fillMs = Date.now() - tClick;
    // what of ours was fetched before anyone showed intent, and what after
    const at = (t: number) => (t < tClick ? "load" : "intent"); // the pointer only moves after tClick
    r.bytes = {
      load: served.filter((f) => f.t >= tInject && at(f.t) === "load").reduce((n, f) => n + f.bytes, 0),
      intent: served.filter((f) => at(f.t) === "intent").reduce((n, f) => n + f.bytes, 0),
      files: served.map((f) => `${at(f.t)} ${f.path}`),
    };
    r.fetches = await page.evaluate(() => (window as unknown as { __rv: { fetches: unknown[] } }).__rv.fetches);
    if (!done) find("machine view never filled in 30s");

    const pane = await page.evaluate(() => {
      const p = document.querySelector("#robo-vision-pane") as HTMLElement;
      const pre = p.querySelector("pre");
      const r = p.getBoundingClientRect();
      return {
        mode: document.documentElement.getAttribute("data-robo-vision-mode"),
        address: location.href,
        step: p.dataset.filled ?? null,
        error: p.querySelector(".mv__error")?.textContent ?? null,
        status: [...p.querySelectorAll(".mv__cell")].map((c) => c.textContent),
        attempts: [...p.querySelectorAll(".mv__attempts li")].map((li) => li.textContent!.trim()),
        text: pre?.textContent ?? "",
        hidden: p.hidden,
        display: getComputedStyle(p).display,
        rect: { w: r.width, h: r.height },
      };
    });
    r.pane = { ...pane, text: undefined, chars: pane.text.length, head: pane.text.slice(0, 240) };
    if (pane.error) find(`pane error: ${pane.error}`);
    if (done && (pane.display === "none" || pane.rect.w < 600)) find(`pane not showing (display ${pane.display}, ${pane.rect.w}x${pane.rect.h})`);
    await Bun.write(dir + "machine.md", pane.text);

    const over = await topAt(page, 640, 450);
    if (done && !over.ours) find(`pane covered by ${over.what} (z ${over.zIndex})`);
    await page.screenshot({ path: dir + "machine.png" });

    if (pane.step === "generated") {
      const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
      const src = before.mainChars ?? before.bodyChars;
      r.generatedRatio = src ? +(pane.text.length / src).toFixed(2) : null;
      const noise = pane.text.split("\n").filter((l) => /cookie|consent|accept all|privacy choices|sign in|log in|subscribe/i.test(l)).length;
      r.noiseLines = noise;
      if (words(pane.text) < 40) find(`generated only ${words(pane.text)} words`);
      // open roots are walked now; a CLOSED root is invisible to any script,
      // so the only honest record is how many open ones there were
      r.openShadowRoots = before.shadowRoots;
    }

    // back to Human: the page should be exactly as we found it
    await page.evaluate(() => (document.querySelector("mode-toggle") as unknown as { choose(m: string): Promise<void> }).choose("human"));
    const afterHuman = await page.evaluate(() => Object.fromEntries([...document.documentElement.attributes].map((a) => [a.name, a.value])));
    for (const [k, v] of Object.entries(before.htmlAttrs)) {
      if (afterHuman[k] !== v && afterInit[k] === v) find(`toggling changed <html ${k}>: ${JSON.stringify(v)} -> ${JSON.stringify(afterHuman[k])}`);
    }
    // anything we ADDED to <html> must be ours by name
    for (const k of Object.keys(afterHuman)) if (!(k in before.htmlAttrs) && !k.startsWith("data-robo-vision")) find(`added <html ${k}>`);

    // only violations robo-vision could have caused: after inject, AND either a
    // URL it fetched or a sink it writes. The first run blamed Stripe's own
    // inline styles and Webflow's ad trackers on us (71 and 9 violations).
    const all = await page.evaluate(() => (window as unknown as { __rv: { violations: { directive: string; blocked: string; sample: string }[] } }).__rv.violations);
    const fetched = new Set((r.fetches as { url: string }[]).map((f) => f.url));
    const ours = all.slice(vBefore).filter((v) => fetched.has(v.blocked) || /trusted-types/.test(v.directive) || /\b(?:mt|mv|rv)__|rv-(?:dock|overlay)/.test(v.sample));
    r.violations = { total: all.length, afterInject: all.length - vBefore, ours };
    if (ours.length) find(`CSP violations caused by robo-vision: ${[...new Set(ours.map((v) => v.directive))].join(", ")}`);
    r.errors = errors.slice(errBefore);
    if ((r.errors as string[]).some((e) => /robo|mode-toggle|mt__|mv__/i.test(e))) find("page errors mention robo-vision");
  } catch (e) {
    find(`harness error: ${(e as Error).message.split("\n")[0].slice(0, 200)}`);
  } finally {
    r.totalMs = Date.now() - t0;
    await Bun.write(dir + "result.json", JSON.stringify(r, null, 2));
    await ctx.close();
  }
  return r;
}

await mkdir(OUT, { recursive: true });
const bases = { light: await baseline("light"), dark: await baseline("dark") };
await Bun.write(OUT + "baseline.json", JSON.stringify(bases, null, 2));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const results: Record<string, unknown>[] = [];
const queue = [...roster];
await Promise.all(Array.from({ length: jobs }, async () => {
  for (let s = queue.shift(); s; s = queue.shift()) {
    const r = await runSite(browser, s, bases);
    results.push(r);
    const f = r.findings as string[];
    console.log(`${f.length ? "!" : "."} ${s.url}  ${(r.pane as { step?: string } | undefined)?.step ?? "-"}  ${f.length} finding(s)`);
  }
}));
await browser.close();
// a partial run (--only) replaces its own sites in results.json and keeps the rest
const prior: Record<string, unknown>[] = only && (await Bun.file(OUT + "results.json").exists()) ? await Bun.file(OUT + "results.json").json() : [];
const merged = [...prior.filter((p) => !results.some((r) => r.url === p.url)), ...results];
merged.sort((a, b) => SITES.findIndex((s) => s.url === a.url) - SITES.findIndex((s) => s.url === b.url));
await Bun.write(OUT + "results.json", JSON.stringify(merged, null, 2));
console.log(`\n${results.length} sites run, ${merged.length} in dryrun/out/results.json`);
