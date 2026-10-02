// resolve.ts: everything in robo-vision that needs no browser. The package's
// `robo-vision/resolve` entry, for a CLI, a CI job, a Worker or an agent.

export {
  resolveMachineCopy, surveyMachineCopies, judge, rejectReason, suffixCandidates, ORDER, BUST_PARAM,
  type Attempt, type Door, type MachineCopy, type PageFacts, type ResolveOptions, type Step, type Verdict,
} from "./source.ts";
export { factsFromHtml } from "./facts-html.ts";
export { checkPage, type CheckOptions, type Finding, type Report, type Severity } from "./check.ts";

import { resolveMachineCopy, type Attempt, type MachineCopy, type ResolveOptions } from "./source.ts";
import { factsFromHtml } from "./facts-html.ts";

export interface Fetched {
  /** the Markdown the site serves for this page, or null if it serves none */
  copy: MachineCopy | null;
  /** the page's HTML, already in hand, for the caller's own fallback */
  html: string;
  url: string;
  status: number;
  attempts: Attempt[];
}

/**
 * For an agent's fetch tool: the site's own Markdown when it publishes one,
 * and the HTML it had to fetch anyway when it does not. One request for the
 * page, then one to three for the copy. A copy returned here passed the same
 * judgement the toggle uses, so a 200 that is really an app shell, or HTML
 * under a Markdown label, comes back as `copy: null` rather than as text.
 */
export async function fetchMachineCopy(url: string, opts: Pick<ResolveOptions, "fetch" | "headers" | "cacheBust"> = {}): Promise<Fetched> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const res = await f(url, { headers: { ...opts.headers, accept: "text/html" }, redirect: "follow" });
  const html = await res.text();
  const page = res.url || url;
  const base = { html, url: page, status: res.status };
  if (!res.ok) return { ...base, copy: null, attempts: [] };
  try {
    // an in-page region is shown to visitors, never served; an agent skips it
    const copy = await resolveMachineCopy(page, { ...opts, fetch: f, facts: factsFromHtml(html), skip: ["in-page", "generated"] });
    return { ...base, copy, attempts: copy.attempts };
  } catch (e) {
    return { ...base, copy: null, attempts: (e as { attempts?: Attempt[] }).attempts ?? [] };
  }
}
