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

import { resolveMachineCopy, factsFromDocument, suffixCandidates, type Attempt, type MachineCopy, type Step } from "./source.ts";
import { generateMarkdown } from "./generate.ts";
import { pageKey } from "./mode.ts";

export type { MachineCopy };

const MEMO = "robo-vision:served-by";
type Fetched = "negotiated" | "md-suffix";
const FETCHED: Fetched[] = ["negotiated", "md-suffix"];
const ALL: Step[] = ["in-page", "link-alternate", "negotiated", "md-suffix", "generated"];

const cache = new Map<string, Promise<MachineCopy | null>>();

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
  const p = resolveMachineCopy(key, {
    facts: factsFromDocument(document),
    generate: () => generateMarkdown(document, { exclude: opts.exclude }),
  }).then((c) => { remember(c, key); return c; });
  cache.set(key, p);
  return p;
}

/** another same-origin page, fetched and never rendered; null if it serves nothing */
export function copyFor(url: string): Promise<MachineCopy | null> {
  const key = pageKey(url);
  const hit = cache.get(key);
  if (hit) return hit;
  const p = (async () => {
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
    return null;
  })();
  cache.set(key, p);
  // a miss is not remembered past this page: the next load may serve it
  p.then((c) => { if (!c) cache.delete(key); });
  return p;
}
