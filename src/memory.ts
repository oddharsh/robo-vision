// memory.ts: what an origin has shown about how it serves copies.
//
// Each origin tends to serve every page the same way, so the door that worked
// last is tried first next time: after one .md hit, the next page is asked for
// its .md before anything is negotiated.
//
// The negative is remembered too. A site that serves no Markdown cost 3 failed
// requests per page (a negotiation and up to two .md spellings, each a 404 in
// the site's logs) before giving up: median 494 ms to a pane in the dry run,
// nearly all of it waiting on those misses. After one miss the rest of the
// SECTION (first path segment) is not asked. Scoped to a section rather than
// the origin because a site often serves Markdown under /docs/ and nothing on
// its marketing pages; a miss on / must not stop /docs/ from being asked.
//
// And the origin's list of real pages (reroute.ts), which costs a request to
// read and is the same for every 404 on that origin.
//
// WHERE it is kept is the caller's: a tab keeps it in sessionStorage
// (copies.ts), an agent in a Map for the life of its process. Nothing here
// touches a DOM.

import { resolveMachineCopy, suffixCandidates, failedStatus, ORDER, type Attempt, type MachineCopy, type ResolveOptions, type Step } from "./source.ts";
import { keyOf } from "./params.ts";

/** string keys to string values; null deletes. sessionStorage fits, so does a Map */
export interface Store {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

/** the first path segment: the unit a "serves nothing" mark covers */
export const sectionOf = (url: string) => new URL(url).pathname.split("/")[1] ?? "";

export function mapStore(): Store {
  const m = new Map<string, string>();
  return { get: (k) => m.get(k) ?? null, set: (k, v) => void (v === null ? m.delete(k) : m.set(k, v)) };
}

/** the doors that are guesses: nothing on the page says they are there */
export type Guessed = "negotiated" | "md-suffix";

/** a page the origin says it has */
export interface PageEntry {
  url: string;
  title?: string;
  description?: string;
}

export interface OriginMemory {
  /** the guessed door that last served a copy on this origin, if any has */
  servedBy(url: string): Guessed | null;
  /** the guessed doors, the one that last worked first */
  order(url: string): Guessed[];
  /** a copy was found for `page`: remember which door served it */
  learn(page: string, copy: MachineCopy): void;
  /** this URL's section was asked earlier and served no Markdown */
  servesNothing(url: string): boolean;
  noteNothing(url: string, nothing: boolean): void;
  /** the origin's page list as read from one source; null if not read yet */
  pages(origin: string, source: string): PageEntry[] | null;
  setPages(origin: string, source: string, entries: PageEntry[]): void;
}

export interface MemoryOptions {
  /** how long a fact is believed, in ms. A tab's session is its own limit, so
   *  it passes Infinity; a long-lived process should not trust a miss forever */
  ttl?: number;
  now?: () => number;
}

export function originMemory(store: Store = mapStore(), { ttl = 3_600_000, now = Date.now }: MemoryOptions = {}): OriginMemory {
  // a store can refuse (a private window, a full quota): the memory is an
  // optimisation, so a refusal reads as "nothing known"
  const read = <T>(key: string): T | null => {
    try {
      const raw = store.get(key);
      if (!raw) return null;
      const { t, v } = JSON.parse(raw) as { t: number; v: T };
      return now() - t > ttl ? null : v;
    } catch { return null; }
  };
  const write = (key: string, v: unknown) => {
    try { store.set(key, v === null ? null : JSON.stringify({ t: now(), v })); } catch { /* fine without it */ }
  };

  const origin = (url: string) => new URL(url).origin;
  const served = (url: string) => `robo-vision:${origin(url)}:served-by`;
  const none = (url: string) => `robo-vision:${origin(url)}:none:${sectionOf(url)}`;
  const list = (o: string, source: string) => `robo-vision:${o}:pages:${source}`;

  const servedBy = (url: string) => read<Guessed>(served(url));

  return {
    servedBy,
    order: (url) => (servedBy(url) === "md-suffix" ? ["md-suffix", "negotiated"] : ["negotiated", "md-suffix"]),
    learn(page, copy) {
      // a declared alternate that happens to sit at the .md spelling tells us
      // the suffix works on this origin, which the next page can use without
      // its HTML
      let step: Guessed | null = null;
      if (copy.step === "negotiated" || copy.step === "md-suffix") step = copy.step;
      else if (copy.step === "link-alternate" && copy.url && suffixCandidates(page).includes(keyOf(copy.url))) step = "md-suffix";
      if (step) write(served(page), step);
    },
    servesNothing: (url) => read<boolean>(none(url)) === true,
    noteNothing: (url, nothing) => write(none(url), nothing ? true : null),
    pages: (o, source) => read<PageEntry[]>(list(o, source)),
    setPages: (o, source, entries) => write(list(o, source), entries),
  };
}

// ---- the policy: resolving with what the origin has shown -------------------
//
// Every caller used to apply the memory itself, and the three disagreed: the
// loaded page ignored the learned door order, a linked page never cleared a
// quiet mark, and the agent's fetch let a declared twin leave one standing.
// This is the one place the rules live:
//
//   - the guessed doors are asked in the order that worked last on the origin,
//     in whatever slots the caller's own order gives them
//   - in a section marked quiet they are not asked at all, and the first is
//     recorded as skipped, with the reason
//   - a served copy, by any door, clears the mark: the section serves Markdown
//   - a result marks the section quiet only if the guessed doors were asked,
//     every answer arrived, and none hit. A page that skipped them, or stopped
//     at an in-page region before reaching them, proves nothing either way;
//     nor does a dropped connection or a 503, which says nothing about the
//     site and would have cost every page in the section its copy for the hour

const GUESSED: Step[] = ["negotiated", "md-suffix"];

/** were the guessed doors asked, and did every answer arrive? */
function guessed(attempts: Attempt[]): { asked: boolean } {
  const answers = attempts.filter((a) => GUESSED.includes(a.step) && a.verdict !== undefined);
  const arrived = answers.every((a) => a.verdict !== "fetch-failed" && !(a.status !== undefined && failedStatus(a.status)));
  return { asked: answers.length > 0 && arrived };
}

/**
 * resolveMachineCopy, with the origin's memory applied and updated. The
 * caller's options say which doors exist (its facts, its generator, its
 * order); the memory says how to ask the guessed ones. Throws as
 * resolveMachineCopy does. A null memory resolves plainly.
 */
export async function resolveRemembered(url: string, memory: OriginMemory | null, opts: ResolveOptions = {}): Promise<MachineCopy> {
  if (!memory) return resolveMachineCopy(url, opts);
  const base = opts.order ?? ORDER;
  const quiet = memory.servesNothing(url);
  // the learned order, dealt into the slots the caller gave its guessed doors
  const learned = memory.order(url).filter((s) => base.includes(s));
  let next = 0;
  const order = base.map((s) => (GUESSED.includes(s) ? learned[next++] : s));
  const skip: ResolveOptions["skip"] = [...(opts.skip ?? [])];
  if (quiet) {
    const first = order.find((s) => GUESSED.includes(s));
    for (const s of order.filter((x) => GUESSED.includes(x))) {
      skip.push(s === first ? { step: s, reason: `not asked: /${sectionOf(url)} served no Markdown on an earlier page` } : s);
    }
  }
  try {
    const copy = await resolveMachineCopy(url, { ...opts, order, skip });
    memory.learn(url, copy);
    if (copy.served) memory.noteNothing(url, false);
    else if (guessed(copy.attempts).asked) memory.noteNothing(url, true);
    return copy;
  } catch (e) {
    if (guessed((e as { attempts?: Attempt[] }).attempts ?? []).asked) memory.noteNothing(url, true);
    throw e;
  }
}
