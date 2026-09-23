// mode.ts: the headless half of the toggle. Cloudflare's /connect/ state
// machine, made generic: one attribute on <html>, one storage key, and an
// inline snippet that applies the stored mode before first paint.
//
// It owns STATE only. What "machine mode" looks like is the presenter's job,
// which is what lets one core drive Parallel's restyle, Kong's link rendering
// and Cloudflare's sibling region alike: each is CSS keyed on html[data-mode].

export type Mode = "human" | "machine";

export const ATTR = "data-mode";
export const KEY = "robo-vision:mode";
export const EVENT = "modechange";

const valid = (m: unknown): m is Mode => m === "human" || m === "machine";

/** a URL wins over storage, so a machine view can be linked to */
function fromUrl(): Mode | null {
  const m = new URL(location.href).searchParams.get("mode");
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

/**
 * Inline this in <head>, before any stylesheet that keys on data-mode. It is
 * the only piece that must be synchronous: a deferred module would paint the
 * human page first and then swap, which is the flash Cloudflare's own snippet
 * exists to prevent. Stringified so a build can hash it for CSP.
 */
export const PREPAINT = `(function(){try{var q=new URLSearchParams(location.search).get("mode"),m=q||localStorage.getItem(${JSON.stringify(KEY)});if(m==="machine"||m==="human")document.documentElement.setAttribute(${JSON.stringify(ATTR)},m)}catch(e){}})();`;
