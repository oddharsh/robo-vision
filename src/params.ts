// params.ts: names shared by the resolver and the toggle's state, kept apart
// from both so the resolver imports nothing that knows about a browser.

/** the mode param: ?robo-vision=machine */
export const PARAM = "robo-vision";
/** the negotiation cache-buster (source.ts); stripped wherever a URL is a key */
export const BUST_PARAM = "_rv";

/** one page, one key: an absolute URL with no fragment and none of robo-vision's own params */
export function keyOf(url: string): string {
  const u = new URL(url);
  u.hash = "";
  u.searchParams.delete(PARAM);
  u.searchParams.delete(BUST_PARAM);
  return u.href;
}

/** the same absolute URL, carrying the mode the way Parallel's /ai prefix does:
 *  a reload, a back button or a pasted link stays in machine view */
export function withParam(url: string, mode: "human" | "machine"): string {
  const u = new URL(url);
  if (mode === "machine") u.searchParams.set(PARAM, "machine");
  else u.searchParams.delete(PARAM);
  return u.href;
}

/** a URL whose path names a Markdown file */
export const isMarkdownUrl = (url: string) => new URL(url).pathname.endsWith(".md");
