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

import { suffixCandidates, type MachineCopy } from "./source.ts";
import { keyOf } from "./params.ts";

/** string keys to string values; null deletes. sessionStorage fits, so does a Map */
export interface Store {
  get(key: string): string | null;
  set(key: string, value: string | null): void;
}

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
  const none = (url: string) => `robo-vision:${origin(url)}:none:${new URL(url).pathname.split("/")[1] ?? ""}`;
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
