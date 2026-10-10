// reroute.ts: a 404 for an agent, and which real page it probably meant.
//
// ry (github.com/ygwyg/ry) answers this on the site's own Worker for visitors.
// This answers it in the agent, with nothing asked of the site but what it
// already publishes, so it works the same on any host. Measured 2026-10-02 on
// 20 docs sites (9 on Vercel, 4 on Netlify, 5 on Cloudflare, 1 on nginx, 1
// proxied): every one answered a missing page with a real 404 status, so the
// status is a sound trigger. None served a soft 404 (a 200 page saying "not
// found"), which is the one host behaviour that would hide a miss from this.
//
// Two outcomes, and only one moves the agent:
//
//   rerouted     the URL differs from exactly one real page by case, a
//                trailing slash, .html or /index. Followed, and flagged.
//   suggestions  anything fuzzier (a typo, a renamed page) is ranked and
//                returned with scores. The agent decides; nothing is followed.
//
// The candidates are a closed set: the origin's own page list. A chooser can
// rank them and cannot invent one. The spelling chooser here needs nothing;
// a decision model (Clef, as ry uses, or any classifier) is the second adapter.

import { strippedPage, mediaType, looksLikeHtml, failedStatus } from "./source.ts";
import type { OriginMemory, PageEntry } from "./memory.ts";

/** where an origin's page list is read from, in the order given */
export type PageSource = "llms" | "sitemap";

export interface Suggestion extends PageEntry {
  /** 0 to 1, the chooser's own scale */
  score: number;
}

/** options in, a score per option out. It may return a subset, in any order */
export type Chooser = (missing: string, options: PageEntry[]) => Promise<Suggestion[]> | Suggestion[];

export interface RerouteOptions {
  /** where the page list comes from; default ["llms"] (llms.txt). Add
   *  "sitemap" for sites with no llms.txt, at the cost of larger reads */
  pages?: PageSource[];
  chooser?: Chooser;
  /** suggestions returned at most; default 5 */
  limit?: number;
  /** suggestions scoring below this are dropped; default 0.5 */
  minScore?: number;
  /** bytes read from any one list before it is cut off; default 5 MB */
  maxBytes?: number;
  /** sitemap files read when the root one is an index; default 10 */
  maxSitemaps?: number;
}

export interface Rerouted {
  from: string;
  to: string;
  /** what differed: "case", "trailing slash", ".html", "/index" */
  fix: string;
}

export interface RerouteResult {
  rerouted: Rerouted | null;
  suggestions: Suggestion[];
  /** which lists were read, and how many pages each gave. `failed` means a
   *  read did not arrive (a network error, a 5xx, a 429): what did arrive was
   *  used, nothing was remembered, and the next 404 asks again */
  sources: { source: PageSource | "seen"; pages: number; failed?: true }[];
}

// ---- reading the page list --------------------------------------------------

const MD_LINK = /\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)(?::\s*(.+))?/g;

// a link to a file is not a page a 404 could have meant
const ASSET = /\.(?:png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|gz|mp4|webm|mp3)$/i;

/** an llms.txt: the proposal's `- [Title](url): description` lines. Relative
 *  URLs resolve against `base`, the document they were read from */
export function pagesFromLlmsTxt(text: string, origin: string, base: string = origin): PageEntry[] {
  const out: PageEntry[] = [];
  for (const m of text.matchAll(MD_LINK)) {
    // ![alt](src) is an image, not a link
    if (m.index > 0 && text[m.index - 1] === "!") continue;
    let url: URL;
    try { url = new URL(m[2], base); } catch { continue; }
    if (url.origin !== origin || ASSET.test(url.pathname)) continue;
    url.hash = "";
    // llms.txt usually links the .md twin; the page is what a 404 was for
    const page = strippedPage(url.href) ?? url.href;
    out.push({ url: page, ...(m[1].trim() && { title: m[1].trim() }), ...(m[3]?.trim() && { description: m[3].trim() }) });
  }
  return out;
}

const LOC = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/g;

/** a sitemap or a sitemap index: its <loc> URLs, and whether they are sitemaps */
export function parseSitemap(xml: string): { index: boolean; locs: string[] } {
  const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  return { index: /<sitemapindex\b/.test(xml), locs: [...xml.matchAll(LOC)].map((m) => decode(m[1])) };
}

// A read either answered (200, or a 404 that says there is no such list) or
// failed to arrive. Only an answer is worth remembering: a 503 or a dropped
// connection says nothing about the site, and remembering it as "no pages"
// cost every later 404 on that origin its suggestions for the memory's hour.
type Read = { ok: boolean; failed: boolean; type: string; text: string };

async function readCapped(f: typeof fetch, url: string, maxBytes: number, accept: string): Promise<Read> {
  try {
    const res = await f(url, { headers: { accept }, redirect: "follow" });
    const type = mediaType(res.headers.get("content-type"));
    if (!res.ok || !res.body) { void res.body?.cancel(); return { ok: false, failed: failedStatus(res.status), type, text: "" }; }
    // a sitemap can run to 9 MB (cdata.com): stop reading at the cap
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      n += value.length;
      if (n >= maxBytes) { void reader.cancel(); break; }
    }
    const buf = new Uint8Array(n);
    let at = 0;
    for (const c of chunks) { buf.set(c.subarray(0, Math.min(c.length, n - at)), at); at += c.length; if (at >= n) break; }
    return { ok: true, failed: false, type, text: new TextDecoder().decode(buf) };
  } catch {
    return { ok: false, failed: true, type: "", text: "" };
  }
}


type Listed = { entries: PageEntry[]; failed: boolean };

/**
 * May a sitemap at `url` be read for `origin`? Only on the origin itself, or
 * on its host or a subdomain of it at the default port: example.com and
 * cdn.example.com for www.example.com. robots.txt and a sitemap index are the
 * site's to write, and a wider rule would let a site point the agent's host
 * at an address it picks (169.254.169.254, localhost:8080). No IP literal and
 * no localhost is a subdomain of a site's name, so this refuses those without
 * listing them. A redirect is still followed, as it is for the page itself.
 */
function onSite(url: string, origin: string): boolean {
  let u: URL;
  try { u = new URL(url, origin); } catch { return false; }
  const o = new URL(origin);
  if (u.origin === o.origin) return true;
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.port) return false;
  const site = o.hostname.replace(/^www\./, "");
  return u.hostname === site || u.hostname.endsWith(`.${site}`);
}

async function readLlms(f: typeof fetch, origin: string, o: Required<Pick<RerouteOptions, "maxBytes">>): Promise<Listed> {
  const r = await readCapped(f, `${origin}/llms.txt`, o.maxBytes, "text/markdown, text/plain");
  // a single-page app answers /llms.txt with its shell and a 200
  if (!r.ok || r.type === "text/html" || looksLikeHtml(r.text)) return { entries: [], failed: r.failed };
  return { entries: pagesFromLlmsTxt(r.text, origin), failed: false };
}

async function readSitemaps(f: typeof fetch, origin: string, o: Required<Pick<RerouteOptions, "maxBytes" | "maxSitemaps">>, start?: string): Promise<Listed> {
  // robots.txt names the sitemaps when they are not at the default address
  const robots = start ? null : await readCapped(f, `${origin}/robots.txt`, 256 * 1024, "text/plain");
  // any read that failed to arrive makes the whole list partial
  let failed = robots?.failed ?? false;
  const named = start ? [start] : robots?.ok ? [...robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]).filter((u) => onSite(u, origin)) : [];
  // unnamed, try the two defaults: /sitemap.xml (Next.js, most CMSs) and
  // /sitemap-index.xml (Astro's @astrojs/sitemap; docs.astro.build has only it)
  const queue = named.length ? named : [`${origin}/sitemap.xml`];
  const fallback = named.length ? null : `${origin}/sitemap-index.xml`;
  const seen = new Set<string>();
  const pages = new Set<string>();
  let budget = o.maxBytes;
  while (queue.length && seen.size < o.maxSitemaps && budget > 0) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    // compressed sitemaps (.xml.gz) would need a decompressor in every runtime
    if (/\.gz$/i.test(new URL(url, origin).pathname)) continue;
    const r = await readCapped(f, new URL(url, origin).href, budget, "application/xml, text/xml");
    failed ||= r.failed;
    if (!r.ok) continue;
    budget -= r.text.length;
    const { index, locs } = parseSitemap(r.text);
    for (const loc of locs) {
      let u: URL;
      try { u = new URL(loc, origin); } catch { continue; }
      // a child sitemap may sit on a CDN subdomain; a page must be the origin's
      if (index) { if (onSite(u.href, origin)) queue.push(u.href); }
      else if (u.origin === origin) { u.hash = ""; pages.add(u.href); }
    }
  }
  if (fallback && !pages.size && seen.size < o.maxSitemaps) {
    const next = await readSitemaps(f, origin, { ...o, maxSitemaps: o.maxSitemaps - seen.size }, fallback);
    return { entries: next.entries, failed: failed || next.failed };
  }
  return { entries: [...pages].map((url) => ({ url })), failed };
}

/** the origin's page list from each source in turn, remembered per origin */
export async function pageList(origin: string, opts: RerouteOptions & { fetch?: typeof fetch; memory?: OriginMemory } = {}): Promise<{ pages: PageEntry[]; sources: RerouteResult["sources"] }> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const o = { maxBytes: opts.maxBytes ?? 5_000_000, maxSitemaps: opts.maxSitemaps ?? 10 };
  const sources: RerouteResult["sources"] = [];
  // one entry per page: Netlify's llms.txt says /x and its sitemap says /x/,
  // so entries are keyed by canonical form and the first spelling is kept
  const byUrl = new Map<string, PageEntry>();
  const keyOf = (url: string) => { const u = new URL(url); return u.origin + canon(u.pathname) + u.search; };
  const add = (entries: PageEntry[]) => {
    for (const e of entries) { const k = keyOf(e.url); const had = byUrl.get(k); byUrl.set(k, had ? { ...e, ...had } : e); }
  };
  for (const source of opts.pages ?? ["llms"]) {
    let entries = opts.memory?.pages(origin, source) ?? null;
    let failed = false;
    if (!entries) {
      ({ entries, failed } = source === "llms" ? await readLlms(f, origin, o) : await readSitemaps(f, origin, o));
      if (!failed) opts.memory?.setPages(origin, source, entries);
    }
    sources.push({ source, pages: entries.length, ...(failed && { failed: true as const }) });
    add(entries);
  }
  // links in copies already read on this origin cost nothing more
  const seen = opts.memory?.pages(origin, "seen") ?? [];
  if (seen.length) { sources.push({ source: "seen", pages: seen.length }); add(seen); }
  return { pages: [...byUrl.values()], sources };
}

/** same-origin links in a Markdown copy, as pages this origin has. `base` is
 *  the page the copy is for: [Setup](setup) on /docs/guide/intro is
 *  /docs/guide/setup, not /setup */
export function linksIn(markdown: string, base: string): PageEntry[] {
  const origin = new URL(base).origin;
  return pagesFromLlmsTxt(markdown, origin, base).map(({ url, title }) => ({ url, ...(title && { title }) }));
}

// ---- exact fixes ------------------------------------------------------------

/** the forms of a path that name the same page on every common host */
function canon(pathname: string): string {
  let p = pathname.toLowerCase();
  p = p.replace(/\/index(?:\.html?)?$/, "/").replace(/\.html?$/, "");
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

function whatDiffered(from: string, to: string): string {
  const a = new URL(from).pathname, b = new URL(to).pathname;
  if (a.toLowerCase() === b.toLowerCase()) return "case";
  if (/\/index(?:\.html?)?$/i.test(a) || /\/index(?:\.html?)?$/i.test(b)) return "/index";
  if (/\.html?$/i.test(a) || /\.html?$/i.test(b)) return ".html";
  return "trailing slash";
}

/** the one real page this URL differs from only in spelling form, or null */
export function exactFix(missing: string, pages: PageEntry[]): Rerouted | null {
  const at = new URL(missing);
  const want = canon(at.pathname);
  // the same path is not a fix: the query rides along, so it would send the
  // agent back to the URL that just 404'd
  const hits = new Set(pages.map((p) => new URL(p.url)).filter((u) => canon(u.pathname) === want && u.pathname !== at.pathname).map((u) => u.origin + u.pathname));
  // two pages in one canonical form (/A and /a both exist) is not a fix
  if (hits.size !== 1) return null;
  const [path] = hits;
  const to = new URL(path);
  to.search = new URL(missing).search; // the query rides along, as ry keeps it
  return { from: missing, to: to.href, fix: whatDiffered(missing, to.href) };
}

// ---- the spelling chooser ---------------------------------------------------

function distance(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length];
}

const similarity = (a: string, b: string) => (!a && !b ? 1 : 1 - distance(a, b) / Math.max(a.length, b.length));
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const last = (path: string) => canon(path).split("/").filter(Boolean).at(-1) ?? "";

/**
 * Ranks pages by how the missing path is spelled: the whole path, its last
 * segment against each page's last segment, and against each page's title.
 * Catches typos and reordered words; a synonym (/jobs for /careers) is a
 * meaning, and needs a model adapter.
 */
export const spellingChooser: Chooser = (missing, options) => {
  const want = canon(new URL(missing).pathname);
  const wantLast = last(want);
  const parent = want.split("/").slice(0, -1).join("/");
  return options.map((o) => {
    const path = canon(new URL(o.url).pathname);
    let score = Math.max(
      similarity(want, path),
      similarity(wantLast, last(path)) * 0.95,
      o.title ? similarity(wantLast, slug(o.title)) * 0.9 : 0,
    );
    // the same section breaks a tie; it is not evidence enough to raise a score
    if (parent && path.split("/").slice(0, -1).join("/") === parent) score += 0.01;
    // 1 means the same page, and exactFix() has already ruled that out
    return { ...o, score: +Math.min(0.99, score).toFixed(3) };
  });
};

// ---- the whole step ---------------------------------------------------------

export async function reroute(missing: string, opts: RerouteOptions & { fetch?: typeof fetch; memory?: OriginMemory; dead?: string[] } = {}): Promise<RerouteResult> {
  const origin = new URL(missing).origin;
  const listed = await pageList(origin, opts);
  // pages the list names that were followed and turned out gone
  const dead = new Set((opts.dead ?? []).map((u) => { const x = new URL(u); return x.origin + x.pathname; }));
  const pages = listed.pages.filter((p) => { const x = new URL(p.url); return !dead.has(x.origin + x.pathname); });
  const { sources } = listed;
  const rerouted = exactFix(missing, pages);
  if (rerouted) return { rerouted, suggestions: [], sources };
  const options = pages.filter((p) => p.url !== missing);
  if (!options.length) return { rerouted: null, suggestions: [], sources };
  const scored = await (opts.chooser ?? spellingChooser)(missing, options);
  const suggestions = scored
    .filter((s) => s.score >= (opts.minScore ?? 0.5) && options.some((o) => o.url === s.url)) // closed set, even for a model
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 5);
  return { rerouted: null, suggestions, sources };
}
