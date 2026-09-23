// drop-in.ts: robo-vision on a page that was never marked up for it.
//
// The marked-up form hides the site's [data-human-only] region and shows the
// machine pane in its place. A site that has done no work has no such region,
// so drop-in mode docks the toggle in a corner and lays the machine pane OVER
// the page as a fixed overlay. The page underneath is left alone: nothing is
// hidden, re-parented, or restyled, which is what makes it safe to try on a
// site you did not write.
//
//   import { dropIn } from "robo-vision/drop-in";
//   dropIn({ corner: "bottom-right" });

import "./mode-toggle.ts";

export interface DropInOptions {
  corner?: "bottom-right" | "bottom-left" | "top-right" | "top-left";
  /** CSS to adopt (tokens + a flavor); the IIFE build passes the XP skin */
  css?: string;
}

export const MARK = "data-robo-vision";

export function dropIn(opts: DropInOptions = {}): { dock: HTMLElement; pane: HTMLElement } | null {
  if (document.querySelector(`[${MARK}]`)) return null; // idempotent: one dock per page

  if (opts.css) {
    // adopted rather than a <style> tag: a constructed sheet is not an inline
    // style element, so it lands on pages whose CSP refuses inline styles
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(opts.css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }

  const pane = document.createElement("section");
  pane.id = "robo-vision-pane";
  pane.className = "rv-overlay";
  pane.setAttribute(MARK, "pane");
  pane.setAttribute("data-machine-view", "");
  pane.setAttribute("aria-label", "Machine view");
  pane.hidden = true;

  const dock = document.createElement("div");
  dock.className = `rv-dock rv-dock--${opts.corner ?? "bottom-right"}`;
  dock.setAttribute(MARK, "dock");
  const toggle = document.createElement("mode-toggle");
  toggle.setAttribute("for", pane.id);
  dock.append(toggle);

  // both go in the top layer where the browser has it (Chrome 114, Safari 17,
  // Firefox 125); elsewhere they fall back to the z-index in drop-in.css
  const topLayer = "showPopover" in HTMLElement.prototype;
  if (topLayer) {
    pane.setAttribute("popover", "manual");
    dock.setAttribute("popover", "manual");
  }
  document.body.append(pane, dock);
  if (topLayer) dock.showPopover();
  return { dock, pane };
}
