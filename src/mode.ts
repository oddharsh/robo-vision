// mode.ts: the headless half of the toggle. Cloudflare's /connect/ state
// machine, made generic: one attribute on <html>, one storage key, and an
// inline snippet that applies the stored mode before first paint.
//
// Every name is namespaced, and the dry run is why. The first version used
// Cloudflare's own spelling, <html data-mode>, and on docs.claude.com that is
// the THEME attribute ("system"), so toggling robo-vision reset the site's dark
// mode; on cloudflare.com/connect/ it is Cloudflare's own toggle, so ours drove
// theirs. `?mode=` has the same problem in the URL. A library that lands on
// pages it did not write owns no generic name.
//
// It owns STATE only. What "machine mode" looks like is the presenter's job,
// which is what lets one core drive Parallel's restyle, Kong's link rendering
// and Cloudflare's sibling region alike: each is CSS keyed on html[data-robo-vision-mode].

export type Mode = "human" | "machine";

export const ATTR = "data-robo-vision-mode";
export const KEY = "robo-vision:mode";
export const EVENT = "robo-vision:modechange";
import { PARAM, BUST_PARAM, keyOf, withParam } from "./params.ts";
export { PARAM, BUST_PARAM };

/** one page, one key: no fragment, and none of robo-vision's own params */
export function pageKey(url: string): string {
  return keyOf(new URL(url, location.href).href);
}

/** the same URL, carrying the mode the way Parallel's /ai prefix does: a
 *  reload, a back button or a pasted link stays in machine view */
export function withMode(url: string, mode: Mode): string {
  return withParam(new URL(url, location.href).href, mode);
}

const valid = (m: unknown): m is Mode => m === "human" || m === "machine";

/** a URL wins over storage, so a machine view can be linked to: ?robo-vision=machine */
function fromUrl(): Mode | null {
  const m = new URL(location.href).searchParams.get(PARAM);
  return valid(m) ? m : null;
}

function fromStorage(): Mode | null {
  try {
    const m = localStorage.getItem(KEY);
    return valid(m) ? m : null;
  } catch {
    return null; // private window, blocked storage: default human
  }
}

/** what this visit asked for before anything ran: the URL, then storage */
export function requestedMode(): Mode | null {
  return fromUrl() ?? fromStorage();
}

export function getMode(): Mode {
  const m = document.documentElement.getAttribute(ATTR);
  return valid(m) ? m : "human";
}

export function setMode(mode: Mode, { persist = true } = {}): void {
  if (getMode() === mode && document.documentElement.hasAttribute(ATTR)) return;
  document.documentElement.setAttribute(ATTR, mode);
  if (persist) {
    try {
      localStorage.setItem(KEY, mode);
    } catch { /* the attribute still applies for this page view */ }
  }
  document.dispatchEvent(new CustomEvent(EVENT, { detail: { mode } }));
}

/** call once at startup; returns the mode it settled on */
export function initMode(): Mode {
  const m = fromUrl() ?? fromStorage() ?? "human";
  // a ?mode= link is a one-off look, so it does not overwrite the saved choice
  setMode(m, { persist: false });
  return m;
}

/** set by the pre-paint snippet while a machine view is on its way; the page
 *  is hidden until the pane is up, so it never paints the human page first */
export const PENDING = "data-robo-vision-pending";
/** how long the snippet hides a page before showing it anyway. A host that
 *  inlines the snippet and then never loads robo-vision (a page it skipped,
 *  a failed fetch) costs a visitor this long, once, and no longer */
export const PENDING_MS = 3000;

/** show the page the snippet hid; the toggle calls it once the pane is up,
 *  in the same task, so the browser never paints the gap between the two */
export function reveal(): void {
  const d = document.documentElement;
  if (!d.hasAttribute(PENDING)) return;
  d.removeAttribute(PENDING);
  d.style.removeProperty("visibility");
}

// The pre-paint snippet that sets PENDING lives in prepaint.ts, a module the
// drop-in never imports: it is a string the HOST ships, and as a template
// built from JSON.stringify calls no bundler can prove it unused, so kept
// here it rode along in every visitor's entry as 530 bytes of dead text.
