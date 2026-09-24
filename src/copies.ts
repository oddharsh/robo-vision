// copies.ts: the data layer. Machine copies by URL, with no rendering.
//
// Two ways in, and nothing here touches the pane:
//
//   copyForThisPage()  the document the browser actually loaded: the page's own
//                      declarations and, last, generation from its live DOM
//   copyFor(url)       any other same-origin page, fetched WITHOUT loading it:
//                      only the steps a request can answer (negotiation, the
//                      .md suffix). null means that page serves nothing, and
//                      the caller loads it for real instead
//
// That split is what makes machine-mode navigation cheap. Parallel keeps you in
// its machine view by moving you to /ai/... and doing a full page load per link
// (a new HTML document plus 11 route-data fetches, measured 2026-09-23). Here a
// link costs one Markdown request, a hover can fetch it before the click, and
// the same function serves anything else that wants a copy without a view.
//
// Each origin tends to serve every page the same way, so the step that worked
// last is tried first next time: after one .md hit, the next page is asked for
// its .md before anything is negotiated.
//
// The negative is remembered too. A site that serves no Markdown cost 3 failed
// requests per page (a negotiation and up to two .md spellings, each a 404 in
// the site's logs and the console) before generating: median 494 ms to a pane
// in the dry run, nearly all of it waiting on those misses. After one miss the
// rest of the SECTION (first path segment) skips straight to generating.
// Scoped to a section rather than the origin because a site often serves
// Markdown under /docs/ and nothing on its marketing pages; a miss on / must
// not stop /docs/ from being asked. A declared alternate is always read, since
// a declaration is evidence and costs no guess.

import { resolveMachineCopy, factsFromDocument, suffixCandidates, type Attempt, type MachineCopy, type Step } from "./source.ts";
import { generateMarkdown } from "./generate.ts";
import { pageKey } from "./mode.ts";

export type { MachineCopy };

const MEMO = "robo-vision:served-by";
type Fetched = "negotiated" | "md-suffix";
const FETCHED: Fetched[] = ["negotiated", "md-suffix"];
const ALL: Step[] = ["in-page", "link-alternate", "negotiated", "md-suffix", "generated"];

const cache = new Map<string, Promise<MachineCopy | null>>();

const section = (url: string) => `robo-vision:none:${new URL(url).pathname.split("/")[1] ?? ""}`;
function servesNothing(url: string): boolean {
  try { return sessionStorage.getItem(section(url)) === "1"; } catch { return false; }
}
function noteNothing(url: string, nothing: boolean): void {
  try {
    if (nothing) sessionStorage.setItem(section(url), "1");
    else sessionStorage.removeItem(section(url));
  } catch { /* fine without it */ }
}
const skipped = (url: string): Attempt => ({
  step: "negotiated", url: null, hit: false,
  reason: `not asked: /${new URL(url).pathname.split("/")[1] ?? ""} served no Markdown earlier this session`,
});

function preferred(): Fetched[] {
  let memo: string | null = null;
  try { memo = sessionStorage.getItem(MEMO); } catch { /* storage refused: default order */ }
  return memo === "md-suffix" ? ["md-suffix", "negotiated"] : FETCHED;
}

// a declared alternate that happens to sit at the .md spelling tells us the
// suffix works on this origin, which the next page can use without its HTML
function remember(copy: MachineCopy, page: string): void {
  let step: Fetched | null = null;
  if (copy.step === "negotiated" || copy.step === "md-suffix") step = copy.step;
  else if (copy.step === "link-alternate" && copy.url && suffixCandidates(page).includes(pageKey(copy.url))) step = "md-suffix";
  if (!step) return;
  try { sessionStorage.setItem(MEMO, step); } catch { /* fine without it */ }
}

/** the document the browser loaded; cached for the life of the page */
export function copyForThisPage(page: string, opts: { exclude?: string[] } = {}): Promise<MachineCopy> {
  const key = pageKey(page);
  const hit = cache.get(key);
  if (hit) return hit as Promise<MachineCopy>;
  const guessless = servesNothing(key);
  const p = resolveMachineCopy(key, {
    facts: factsFromDocument(document),
    generate: () => generateMarkdown(document, { exclude: opts.exclude }),
    skip: guessless ? ["negotiated", "md-suffix"] : [],
  }).then((c) => {
    remember(c, key);
    if (guessless) c.attempts.splice(2, 0, skipped(key));
    // only a page that was actually asked can prove the section serves nothing
    else noteNothing(key, c.step === "generated");
    if (c.served) noteNothing(key, false);
    return c;
  });
  cache.set(key, p);
  return p;
}

const isMarkdownUrl = (url: string) => new URL(url).pathname.endsWith(".md");

/** another same-origin page, fetched and never rendered; null if it serves nothing */
export function copyFor(url: string): Promise<MachineCopy | null> {
  const key = pageKey(url);
  const hit = cache.get(key);
  if (hit) return hit;
  if (isMarkdownUrl(key)) {
    // a link straight to a .md file (Stripe's Markdown links to its other
    // pages this way): read it as the Markdown it says it is, outside the
    // per-origin strategy memory, since it says nothing about how the site
    // serves copies for its ordinary page URLs
    const p = resolveMachineCopy(key, { facts: { alternates: [key], inPage: null }, skip: ["in-page", "negotiated", "md-suffix", "generated"] })
      .then((c): MachineCopy => ({ ...c, step: "md-link", attempts: c.attempts.filter((a) => a.url).map((a) => ({ ...a, step: "md-link" })) }))
      .catch(() => null);
    cache.set(key, p);
    p.then((c) => { if (!c) cache.delete(key); });
    return p;
  }
  const p = (async () => {
    // known empty: skip the requests; the caller loads the page for real and
    // that page generates without asking either
    if (servesNothing(key)) return null;
    const tried: Attempt[] = [];
    for (const step of preferred()) {
      try {
        const c = await resolveMachineCopy(key, { facts: { alternates: [], inPage: null }, skip: ALL.filter((s) => s !== step) });
        c.attempts.unshift(...tried);
        remember(c, key);
        return c;
      } catch (e) {
        tried.push(...((e as { attempts?: Attempt[] }).attempts ?? []));
      }
    }
    noteNothing(key, true);
    return null;
  })();
  cache.set(key, p);
  // a miss is not remembered past this page: the next load may serve it
  p.then((c) => { if (!c) cache.delete(key); });
  return p;
}

// ---- the page a Markdown file mirrors ------------------------------------
//
// Following a .md link used to leave that .md URL in the address bar, and a
// reload or the Human button then loaded the file itself: Chrome shows it as
// raw text, robo-vision is not on it, and there is no way back. Stripping the
// suffix fixes that where the .md mirrors a page (Stripe: 6 of 6 links, and
// Cloudflare's docs) and breaks it where the file is Markdown-only (nuxt.com's
// /sitemap.md and /design.md: both stripped URLs are 404s). So the stripped
// URL is asked about first, and only a 200 that is HTML earns the address bar.

/** "/x.md" -> "/x", by the llms.txt spellings; null if it is not a .md URL */
export function strippedPage(mdUrl: string): string | null {
  const u = new URL(mdUrl);
  const p = u.pathname;
  if (!p.endsWith(".md")) return null;
  if (p.endsWith("/index.md")) u.pathname = p.slice(0, -"index.md".length);
  else if (p === "/.md") u.pathname = "/"; // parallel.ai's root twin
  else u.pathname = p.slice(0, -".md".length); // also .html.md -> .html
  return u.href;
}

const pages = new Map<string, Promise<string | null>>();

/** the verified human page behind a .md URL, or null if there is none */
export function humanPageFor(mdUrl: string): Promise<string | null> {
  const key = pageKey(mdUrl);
  const hit = pages.get(key);
  if (hit) return hit;
  const candidate = strippedPage(key);
  const p = !candidate ? Promise.resolve(null) : (async () => {
    const ask = async (method: "HEAD" | "GET") => {
      const r = await fetch(candidate, { method, headers: { accept: "text/html" }, redirect: "follow", cache: "no-store" });
      if (method === "GET") void r.body?.cancel(); // the status and type are the answer
      return r;
    };
    try {
      let r = await ask("HEAD");
      if (r.status === 405 || r.status === 501) r = await ask("GET"); // a server that refuses HEAD
      const type = (r.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!r.ok || type !== "text/html") return null;
      const final = new URL(r.url || candidate);
      return final.origin === new URL(candidate).origin ? pageKey(final.href) : null;
    } catch {
      return null;
    }
  })();
  pages.set(key, p);
  return p;
}

/** file a copy under a second address, so reload, back and Human find it there */
export function alias(pageUrl: string, copy: Promise<MachineCopy | null>): void {
  cache.set(pageKey(pageUrl), copy);
}
