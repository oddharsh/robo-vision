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
// What the origin has shown about how it serves copies (the door that worked
// last, the sections that serve nothing) is memory.ts, kept here in
// sessionStorage so it lasts the tab's session and no longer. A declared
// alternate is always read, since a declaration is evidence and costs no guess.

import { resolveMachineCopy, strippedPage, mediaType, type MachineCopy } from "./source.ts";
import { factsFromDocument } from "./facts-dom.ts";
import { originMemory, resolveRemembered } from "./memory.ts";
import { generateMarkdown } from "./generate.ts";
import { keyOf as pageKey, isMarkdownUrl } from "./params.ts";

export type { MachineCopy };

const cache = new Map<string, Promise<MachineCopy | null>>();

// sessionStorage throws in a private window or when blocked; memory.ts reads
// a throw as "nothing known"
const memory = originMemory(
  { get: (k) => sessionStorage.getItem(k), set: (k, v) => (v === null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v)) },
  { ttl: Infinity },
);

/** the document the browser loaded; cached for the life of the page */
export function copyForThisPage(page: string, opts: { exclude?: string[] } = {}): Promise<MachineCopy> {
  const key = pageKey(page);
  const hit = cache.get(key);
  if (hit) return hit as Promise<MachineCopy>;
  const p = resolveRemembered(key, memory, {
    facts: factsFromDocument(document),
    generate: () => generateMarkdown(document, { exclude: opts.exclude }),
  });
  cache.set(key, p);
  // a failure is not kept: the next press of Machine asks again, as copyFor's
  // misses do. Only this promise is dropped, never a newer one under the key
  p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
  return p;
}


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
    const p = resolveMachineCopy(key, { facts: { alternates: [key], inPage: null }, order: ["link-alternate"] })
      .then((c): MachineCopy => ({ ...c, step: "md-link", attempts: c.attempts.filter((a) => a.url).map((a) => ({ ...a, step: "md-link" })) }))
      .catch(() => null);
    cache.set(key, p);
    p.then((c) => { if (!c) cache.delete(key); });
    return p;
  }
  // only the doors a request can answer; in a quiet section neither is
  // asked, and null sends the caller to load the page for real, where it
  // generates without asking either
  const p = resolveRemembered(key, memory, { order: ["negotiated", "md-suffix"] }).catch(() => null);
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

export { strippedPage };

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
      if (!r.ok || mediaType(r.headers.get("content-type")) !== "text/html") return null;
      const final = new URL(r.url || candidate);
      return final.origin === new URL(candidate).origin ? pageKey(final.href) : null;
    } catch {
      return null;
    }
  })();
  pages.set(key, p);
  return p;
}
