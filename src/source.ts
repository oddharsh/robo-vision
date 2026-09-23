// source.ts: find the machine copy a page ALREADY has, and generate one only
// when every door comes up empty.
//
// The order is cheapest-and-most-explicit first:
//
//   in-page         the page carries its own machine region (Cloudflare's
//                   <section data-machine-only>). Zero requests.
//   link-alternate  <link rel="alternate" type="text/markdown" href>. The site
//                   declared its twin. Zero requests to find, one to read.
//   negotiated      the page URL again with Accept: text/markdown.
//   md-suffix       the llms.txt convention: /foo -> /foo.md, / -> /index.html.md.
//   generated       nothing exists, so walk the DOM we already have.
//
// Every step that fetches is judged on the RESPONSE rather than the status
// code, because the two failures that matter both answer 200: a URL-keyed
// cache handing back the HTML it stored for the page, and a SPA fallback
// answering /anything.md with the app shell. Neither is a twin, and treating
// either as one would show a human "what the machine sees" as a page of markup.

export type Step = "in-page" | "link-alternate" | "negotiated" | "md-suffix" | "generated";

export interface Attempt {
  step: Step;
  url: string | null;
  hit: boolean;
  reason: string;
  /** wall time this step took, so a slow door is visible in the pane */
  ms?: number;
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
  /** skip steps, e.g. a CLI that has no DOM to generate from */
  skip?: Step[];
  /** extra request headers (a CLI identifies itself; a browser cannot) */
  headers?: Record<string, string>;
}

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

export async function resolveMachineCopy(pageUrl: string, opts: ResolveOptions = {}): Promise<MachineCopy> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const skip = new Set(opts.skip ?? []);
  const attempts: Attempt[] = [];
  const done = (step: Step, served: boolean, url: string | null, contentType: string | null, text: string): MachineCopy =>
    ({ step, served, url, contentType, text, attempts });

  const now = () => globalThis.performance?.now() ?? Date.now();
  const tryFetch = async (step: Step, url: string, init: RequestInit): Promise<MachineCopy | null> => {
    const t0 = now();
    let res: Response;
    let body: string;
    try {
      res = await f(url, init);
      body = await res.text();
    } catch (e) {
      attempts.push({ step, url, hit: false, reason: `fetch failed: ${(e as Error).message}`, ms: Math.round(now() - t0) });
      return null;
    }
    const why = rejectReason(res, body, res.url || url);
    attempts.push({ step, url, hit: !why, reason: why ?? `${res.headers.get("content-type")}, ${body.length} chars`, ms: Math.round(now() - t0) });
    return why ? null : done(step, true, res.url || url, res.headers.get("content-type"), body);
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

  if (!skip.has("in-page")) {
    if (facts?.inPage?.trim()) return done("in-page", false, null, null, facts.inPage);
    attempts.push({ step: "in-page", url: null, hit: false, reason: facts ? "no machine region" : "no page facts" });
  }

  if (!skip.has("link-alternate")) {
    const alts = (facts?.alternates ?? []).map((h) => new URL(h, pageUrl).href);
    if (!alts.length) attempts.push({ step: "link-alternate", url: null, hit: false, reason: facts ? "none declared" : "no page facts" });
    for (const href of alts) {
      const hit = await tryFetch("link-alternate", href, md("text/markdown, text/plain;q=0.5"));
      if (hit) return hit;
    }
  }

  if (!skip.has("negotiated")) {
    // markdown alone, no HTML fallback offered: a server that cannot comply
    // should say so (406) or send HTML, and rejectReason reads either one
    const hit = await tryFetch("negotiated", pageUrl, md("text/markdown"));
    if (hit) return hit;
  }

  if (!skip.has("md-suffix")) {
    for (const url of suffixCandidates(pageUrl)) {
      const hit = await tryFetch("md-suffix", url, md("text/markdown, text/plain;q=0.5"));
      if (hit) return hit;
    }
  }

  if (!skip.has("generated") && opts.generate) {
    const t0 = now();
    const text = await opts.generate();
    attempts.push({ step: "generated", url: null, hit: true, reason: `${text.length} chars from the live DOM`, ms: Math.round(now() - t0) });
    return done("generated", false, null, null, text);
  }

  throw Object.assign(new Error("no machine copy found and generation not available"), { attempts });
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
