// params.ts: names shared by the resolver and the toggle's state, kept apart
// from both so the resolver imports nothing that knows about a browser.

/** the negotiation cache-buster (source.ts); stripped wherever a URL is a key */
export const BUST_PARAM = "_rv";
