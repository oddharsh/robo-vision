// source.ts: find the machine copy a page ALREADY has, and generate one only
// when every door comes up empty.
//
// The order is cheapest-and-most-explicit first:
//
//   in-page         the page carries its own machine region (Cloudflare's
//                   <section data-machine-only>). Zero requests.
//   link-alternate  <link rel="alternate" type="text/markdown" href>. The site
//                   declared its twin. Zero requests to find, one to read.
//   negotiated      the page URL again with Accept: text/markdown; once more
//                   with a throwaway param if a cache that ignores Accept
//                   answered for it.
//   md-suffix       the llms.txt convention: /foo -> /foo.md, / -> /index.html.md.
//   generated       nothing exists, so walk the DOM we already have.
//
// Every step that fetches is judged on the RESPONSE rather than the status
// code, because the two failures that matter both answer 200: a URL-keyed
// cache handing back the HTML it stored for the page, and a SPA fallback
// answering /anything.md with the app shell. Neither is a twin, and treating
// either as one would show a human "what the machine sees" as a page of markup.

import { BUST_PARAM } from "./params.ts";

export type Step = "in-page" | "link-alternate" | "negotiated" | "md-suffix" | "generated" | "md-link";

export interface Attempt {
  step: Step;
  url: string | null;
  hit: boolean;
  reason: string;
  /** wall time this step took, so a slow door is visible in the pane */
  ms?: number;
  /** how the request was sent, when that differs from plain (cache-busted, retried) */
  note?: string;
  /** what the response said, for a caller that audits rather than displays */
  status?: number;
  contentType?: string | null;
  /** the response carried Vary: Accept (or *) */
  varies?: boolean;
}

export interface MachineCopy {
  step: Step;
  /** true when this text is what an agent would actually be served */
  served: boolean;
  url: string | null;
  contentType: string | null;
  text: string;
  attempts: Attempt[];
}

export interface PageFacts {
  /** hrefs of <link rel="alternate" type="text/markdown">, in document order */
  alternates: string[];
  /** text of an author-supplied machine region, if the page has one */
  inPage: string | null;
}

export interface ResolveOptions {
  fetch?: typeof fetch;
  /** facts already read off the page; the browser has them for free */
  facts?: PageFacts;
  /** called only when nothing else hit */
  generate?: () => string | Promise<string>;
  /** skip steps, e.g. a CLI that has no DOM to generate from. A step skipped
   *  with a reason is recorded as an attempt, in its place in the order */
  skip?: (Step | { step: Step; reason: string })[];
  /** which doors to walk, in which order; defaults to ORDER */
  order?: Step[];
  /** extra request headers (a CLI identifies itself; a browser cannot) */
  headers?: Record<string, string>;
  /** retry negotiation with a throwaway query param when the plain answer
   *  came from a cache that cannot tell Markdown from HTML (default true) */
  cacheBust?: boolean;
}

/** the throwaway param; a name no page plausibly reads, so the origin ignores it */
export { BUST_PARAM };

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);

/**
 * Judge a response as a Markdown twin. Returns null on a hit, or the reason
 * it is not one. Exported because this judgement IS the library: the steps
 * are just places to point it.
 */
export function rejectReason(res: Response, body: string, url: string): string | null {
  if (!res.ok) return `HTTP ${res.status}`;
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  const isMdPath = /\.md(?:$|[?#])/.test(new URL(url).pathname + new URL(url).search);
  // text/plain is how a plain static host serves a .md file it has no type for,
  // so it counts only where the URL itself says Markdown
  if (!MARKDOWN_TYPES.has(type) && !(type === "text/plain" && isMdPath)) {
    return type ? `answered ${type}` : "no content-type";
  }
  // a typed-right response can still be a document: sniff before believing it.
  // Skip a BOM and any leading comments first: Shopify storefronts answer
  // Accept: text/markdown with `text/markdown` over the full HTML page, and a
  // theme that opens with <!-- BRAND --> put 664 KB of markup past a sniff
  // that only looked at the first tag (allbirds.com, 2026-09-23)
  const lead = body.slice(0, 4096).replace(/^\uFEFF/, "").replace(/^(?:\s*<!--[\s\S]*?-->)*\s*/, "");
  if (/^<(?:!doctype|html|head|body)\b/i.test(lead)) return "labelled Markdown, body is HTML";
  if (!body.trim()) return "empty body";
  return null;
}

/** the llms.txt-proposal spellings, at most two, cheapest first */
export function suffixCandidates(pageUrl: string): string[] {
  const u = new URL(pageUrl);
  if (!/^https?:$/.test(u.protocol)) return []; // about:blank, data:, file: have no .md next to them
  u.hash = "";
  u.search = "";
  const p = u.pathname;
  if (p.endsWith(".md")) return [];
  if (p === "/" || p.endsWith("/")) {
    const base = p === "/" ? "" : p.slice(0, -1);
    return [base ? `${base}.md` : "/index.md", `${p}index.html.md`].map((x) => new URL(x, u).href);
  }
  return [new URL(`${p.replace(/\.html?$/, "")}.md`, u).href];
}

/** every door, cheapest and most explicit first */
export const ORDER: Step[] = ["in-page", "link-alternate", "negotiated", "md-suffix", "generated"];

/** what one door answered: its copy, if it had one, and the requests it took */
export interface Door {
  step: Step;
  copy: MachineCopy | null;
  attempts: Attempt[];
}

// One walk, two readers. resolveMachineCopy() stops at the first door with a
// copy, because in a browser every further door costs the site a request.
// surveyMachineCopies() opens them all, because an audit wants to know whether
// the doors agree. The judgement and the order are the same code either way.
async function* walk(pageUrl: string, opts: ResolveOptions): AsyncGenerator<Door> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const why = new Map<Step, string | null>();
  for (const s of opts.skip ?? []) typeof s === "string" ? why.set(s, null) : why.set(s.step, s.reason);
  // nothing on a non-http page can be fetched; go straight to what the page has
  if (!/^https?:$/.test(new URL(pageUrl).protocol)) for (const s of ["link-alternate", "negotiated", "md-suffix"] as Step[]) why.set(s, null);

  // no generator handed in (a CLI has no DOM): there is no such door to open
  if (!opts.generate) why.set("generated", null);

  const now = () => globalThis.performance?.now() ?? Date.now();
  // `url` is what goes on the wire; `shown` is what the pane and the result
  // report, so a cache-busting param never leaks into a link someone copies
  const tryFetch = async (attempts: Attempt[], step: Step, url: string, init: RequestInit, shown = url, note = ""): Promise<{ copy: MachineCopy | null; status: number | null; varies: boolean }> => {
    const t0 = now();
    let res: Response;
    let body: string;
    try {
      res = await f(url, init);
      body = await res.text();
    } catch (e) {
      attempts.push({ step, url: shown, hit: false, reason: `fetch failed: ${(e as Error).message}`, ms: Math.round(now() - t0), ...(note && { note }) });
      return { copy: null, status: null, varies: false };
    }
    const reject = rejectReason(res, body, res.url || url);
    const contentType = res.headers.get("content-type");
    const varies = /(?:^|,)\s*(?:accept|\*)\s*(?:,|$)/i.test(res.headers.get("vary") ?? "");
    attempts.push({ step, url: shown, hit: !reject, reason: reject ?? `${contentType}, ${body.length} chars`, ms: Math.round(now() - t0), ...(note && { note }), status: res.status, contentType, varies });
    return { copy: reject ? null : { step, served: true, url: shown, contentType, text: body, attempts }, status: res.status, varies };
  };

  // the browser's HTTP cache keys on URL and honours Vary only when the server
  // SENDS it; a server negotiating without `Vary: accept` would have us read
  // back the HTML we loaded the page with. no-store sidesteps the question.
  const md = (accept: string): RequestInit => ({
    headers: { ...opts.headers, accept },
    cache: "no-store",
    redirect: "follow",
  });

  const facts = opts.facts;

  const open: Record<Exclude<Step, "md-link">, (attempts: Attempt[]) => Promise<MachineCopy | null>> = {
    "in-page": async (attempts) => {
      if (facts?.inPage?.trim()) return { step: "in-page", served: false, url: null, contentType: null, text: facts.inPage, attempts };
      attempts.push({ step: "in-page", url: null, hit: false, reason: facts ? "no machine region" : "no page facts" });
      return null;
    },

    "link-alternate": async (attempts) => {
      const alts = (facts?.alternates ?? []).map((h) => new URL(h, pageUrl).href);
      if (!alts.length) attempts.push({ step: "link-alternate", url: null, hit: false, reason: facts ? "none declared" : "no page facts" });
      for (const href of alts) {
        const { copy } = await tryFetch(attempts, "link-alternate", href, md("text/markdown, text/plain;q=0.5"));
        if (copy) return copy;
      }
      return null;
    },

    "negotiated": async (attempts) => {
      // markdown alone, no HTML fallback offered: a server that cannot comply
      // should say so (406) or send HTML, and rejectReason reads either one.
      //
      // Ask plainly first, because a plain request is what an agent sends and
      // its answer is what an agent gets, cached copy and all. Only when that
      // answer is not Markdown AND the response does not vary on Accept is the
      // shared cache a suspect: it keys on the URL and hands back whichever
      // representation it stored last. Then a throwaway param (CData's trick,
      // `?_mdcb=`) reaches the origin. Measured 2026-09-23: webflow.com answered
      // Markdown on 1 of 4 plain requests (all cache HITs, no Vary: Accept) and
      // 4 of 4 busted ones (all MISSes). Busting every time was tried and
      // rejected: cdata.com varies correctly, and busting it showed the origin's
      // fresh copy while agents were being served a 21-minute-old cached one
      // with a JSON-LD block the origin had since dropped.
      const plain = new URL(pageUrl);
      plain.hash = "";
      const first = await tryFetch(attempts, "negotiated", plain.href, md("text/markdown"), pageUrl);
      if (first.copy) return first.copy;
      const suspectCache = first.status !== null && first.status < 400 && !first.varies;
      if (opts.cacheBust !== false && suspectCache) {
        const wire = new URL(plain);
        wire.searchParams.set(BUST_PARAM, Math.random().toString(36).slice(2, 10));
        const busted = await tryFetch(attempts, "negotiated", wire.href, md("text/markdown"), pageUrl,
          "cache-busted: the plain answer was not Markdown and the response does not vary on Accept");
        if (busted.copy) return busted.copy;
      }
      return null;
    },

    "md-suffix": async (attempts) => {
      for (const url of suffixCandidates(pageUrl)) {
        const { copy } = await tryFetch(attempts, "md-suffix", url, md("text/markdown, text/plain;q=0.5"));
        if (copy) return copy;
      }
      return null;
    },

    "generated": async (attempts) => {
      const t0 = now();
      const text = await opts.generate!();
      attempts.push({ step: "generated", url: null, hit: true, reason: `${text.length} chars from the live DOM`, ms: Math.round(now() - t0) });
      return { step: "generated", served: false, url: null, contentType: null, text, attempts };
    },
  };

  for (const step of opts.order ?? ORDER) {
    if (step === "md-link") continue;
    const attempts: Attempt[] = [];
    if (why.has(step)) {
      const reason = why.get(step);
      if (reason == null) continue;
      attempts.push({ step, url: null, hit: false, reason });
      yield { step, copy: null, attempts };
      continue;
    }
    yield { step, copy: await open[step](attempts), attempts };
  }
}

/** the first door with a copy; its attempts are the whole trail that led there */
export async function resolveMachineCopy(pageUrl: string, opts: ResolveOptions = {}): Promise<MachineCopy> {
  const attempts: Attempt[] = [];
  for await (const door of walk(pageUrl, opts)) {
    attempts.push(...door.attempts);
    if (door.copy) return { ...door.copy, attempts };
  }
  throw Object.assign(new Error("no machine copy found and generation not available"), { attempts });
}

/**
 * Every door's answer, hit or miss, with no early exit. For an audit: whether
 * the declared twin, the negotiated answer and the .md file exist and agree.
 * It never throws for want of a copy, and it costs every request there is, so
 * it is not what a toggle on someone's site should call.
 */
export async function surveyMachineCopies(pageUrl: string, opts: ResolveOptions = {}): Promise<Door[]> {
  const doors: Door[] = [];
  for await (const door of walk(pageUrl, opts)) doors.push(door);
  return doors;
}

/** read PageFacts off a live Document (browser side) */
export function factsFromDocument(doc: Document, machineRegion = "[data-machine-only]"): PageFacts {
  const alternates = [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="alternate" i][type]')]
    .filter((l) => MARKDOWN_TYPES.has(l.type.toLowerCase()))
    .map((l) => l.getAttribute("href")!)
    .filter(Boolean);
  const region = doc.querySelector<HTMLElement>(machineRegion);
  return { alternates, inPage: region ? region.innerText || region.textContent : null };
}
