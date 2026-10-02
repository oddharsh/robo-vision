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
