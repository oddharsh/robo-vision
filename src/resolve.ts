// resolve.ts: everything in robo-vision that needs no browser. The package's
// `robo-vision/resolve` entry, for a CLI, a CI job, a Worker or an agent.

export {
  resolveMachineCopy, surveyMachineCopies, judge, rejectReason, isMarkdownType, suffixCandidates, ORDER, BUST_PARAM,
  type Attempt, type Door, type MachineCopy, type PageFacts, type ResolveOptions, type Step, type Verdict,
} from "./source.ts";
export { factsFromHtml } from "./facts-html.ts";
export { checkPage, type CheckOptions, type Finding, type Report, type Severity } from "./check.ts";

export { originMemory, mapStore, resolveRemembered, type OriginMemory, type Store, type PageEntry, type MemoryOptions } from "./memory.ts";
export { reroute, pageList, spellingChooser, exactFix, pagesFromLlmsTxt, parseSitemap, type Chooser, type Suggestion, type Rerouted, type RerouteOptions, type RerouteResult, type PageSource } from "./reroute.ts";

import type { Attempt, MachineCopy, ResolveOptions } from "./source.ts";
import { factsFromHtml } from "./facts-html.ts";
import { originMemory, resolveRemembered, type OriginMemory } from "./memory.ts";
import { reroute as findPage, linksIn, type RerouteOptions, type Rerouted, type Suggestion } from "./reroute.ts";

export interface Fetched {
  /** the Markdown the site serves for this page, or null if it serves none */
  copy: MachineCopy | null;
  /** the page's HTML, already in hand, for the caller's own fallback */
  html: string;
  /** the page that was read; differs from the URL asked for when rerouted */
  url: string;
  status: number;
  attempts: Attempt[];
  /** the URL asked for was a 404 and differed from one real page only in
   *  case, a trailing slash, .html or /index: that page was read instead */
  rerouted?: Rerouted;
  /** the URL was a 404 and nothing was followed: the origin's real pages
   *  ranked by the chooser, best first. Empty when it publishes no list */
  suggestions?: Suggestion[];
}

export interface FetchOptions extends Pick<ResolveOptions, "fetch" | "headers" | "cacheBust"> {
  /** what this origin has shown before. Default: one memory for the process,
   *  in a Map, believed for an hour. Pass originMemory(store) to keep it
   *  elsewhere, or null to remember nothing */
  memory?: OriginMemory | null;
  /** what to do on a 404; false returns the 404 alone */
  reroute?: RerouteOptions | false;
}

const shared = originMemory();

/**
 * For an agent's fetch tool: the site's own Markdown when it publishes one,
 * and the HTML it had to fetch anyway when it does not. One request for the
 * page, then one to three for the copy; fewer once the origin is known. A copy
 * returned here passed the same judgement the toggle uses, so a 200 that is
 * really an app shell, or HTML under a Markdown label, comes back as
 * `copy: null` rather than as text.
 *
 * On a 404 it reads the origin's page list (llms.txt by default; a sitemap if
 * asked) and either follows an exact fix, flagged in `rerouted`, or returns
 * ranked `suggestions` and follows nothing.
 */
export async function fetchMachineCopy(url: string, opts: FetchOptions = {}): Promise<Fetched> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const memory = opts.memory === undefined ? shared : opts.memory;
  const res = await f(url, { headers: { ...opts.headers, accept: "text/html" }, redirect: "follow" });
  const html = await res.text();
  const page = res.url || url;
  const base = { html, url: page, status: res.status };

  if (res.status === 404 && opts.reroute !== false) {
    const r = await findPage(page, { ...opts.reroute, fetch: f, memory: memory ?? undefined });
    if (r.rerouted) {
      const next = await fetchMachineCopy(r.rerouted.to, { ...opts, reroute: false });
      return { ...next, rerouted: { ...r.rerouted, from: url } };
    }
    return { ...base, copy: null, attempts: [], suggestions: r.suggestions };
  }
  if (!res.ok) return { ...base, copy: null, attempts: [] };

  // an in-page region is shown to visitors, never served; an agent skips it.
  // A declared alternate is always read, since a declaration costs no guess
  try {
    const copy = await resolveRemembered(page, memory, { ...opts, fetch: f, facts: factsFromHtml(html), order: ["link-alternate", "negotiated", "md-suffix"] });
    // the links in a copy are pages this origin has, for a later 404
    if (memory) {
      const origin = new URL(page).origin;
      const known = memory.pages(origin, "seen") ?? [];
      const have = new Set(known.map((p) => p.url));
      const fresh = linksIn(copy.text, page).filter((p) => !have.has(p.url));
      if (fresh.length) memory.setPages(origin, "seen", [...known, ...fresh].slice(-2000));
    }
    return { ...base, copy, attempts: copy.attempts };
  } catch (e) {
    return { ...base, copy: null, attempts: (e as { attempts?: Attempt[] }).attempts ?? [] };
  }
}
