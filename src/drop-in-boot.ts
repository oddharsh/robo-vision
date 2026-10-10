// drop-in-boot.ts: what both drop-in entries share. Finds the script tag that
// loaded robo-vision, reads its options, and mounts at the right moment.
//
// WHETHER it mounts on its own is the host's call. A <script src> naming
// robo-vision means "put the toggle on this page", so the entry mounts from
// that tag's data attributes. A module imported with no tag (a site's own shell
// script deciding which pages get the toggle) mounts nothing until it calls
// mount(). aadhar.sh is where this came from: its shell loads every script it
// owns from nav.js, so the toggle arrived through a tag the shell injected,
// which happened to work because a dynamic tag is still a tag.
//
// WHEN it mounts is the part that costs the host page. Mounting adopts a
// stylesheet, and adding a sheet makes the browser recalculate style for the
// whole document: measured at 5 to 17 ms per page load across six live sites.
// A visitor who arrives in machine view needs the dock at once. Everyone else
// gets it after the page's own load event, when the main thread is idle, so
// robo-vision never competes with the page's first paint or its LCP element.
//
//   <script type="module" src="/robo-vision/robo-vision.js"
//           data-corner="bottom-left" data-machine-label="Agent"></script>
//
//   const { mount } = await import("/robo-vision/robo-vision.js");
//   mount({ corner: "top-right", labels: { machine: "Agent" } });
import { dropIn, type DropInOptions } from "./drop-in.ts";
import { requestedMode } from "./mode.ts";

declare const __ROBO_VISION_CSS__: string;

export interface MountOptions {
  corner?: DropInOptions["corner"];
  /** button text, e.g. { machine: "Agent" }; defaults Human / Machine */
  labels?: DropInOptions["labels"];
}

/** the dock and the pane, or null when this page already had a dock */
export type Mounted = { dock: HTMLElement; pane: HTMLElement } | null;

/**
 * The <script> that loaded robo-vision, or null when nothing did. The exact
 * URL first, so the right tag's options are read when a page carries two; then
 * any script whose src names robo-vision, because a CDN can redirect a short
 * URL (unpkg's /robo-vision to /robo-vision@0.1.0/dist/robo-vision.js) and
 * import.meta.url is where the module LANDED, not the src that asked for it.
 */
export function ownTag(url: string | null): HTMLScriptElement | null {
  const scripts = [...document.querySelectorAll<HTMLScriptElement>("script[src]")];
  return scripts.find((s) => s.src === url) ?? scripts.find((s) => s.src.includes("robo-vision")) ?? null;
}

export function optionsFrom(tag: HTMLScriptElement): MountOptions {
  const d = tag.dataset;
  return { corner: d.corner as MountOptions["corner"], labels: { human: d.humanLabel, machine: d.machineLabel } };
}

function schedule(go: () => void): void {
  if (requestedMode() === "machine") {
    if (document.body) go();
    else document.addEventListener("DOMContentLoaded", go, { once: true });
    return;
  }
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(go, { timeout: 2000 }) : setTimeout(go, 1));
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
}

/** a mount() bound to the way this build loads its view */
export function mounter(loadView: DropInOptions["loadView"]): (opts?: MountOptions) => Promise<Mounted> {
  return (opts = {}) => new Promise((resolve) => schedule(() => resolve(dropIn({
    css: __ROBO_VISION_CSS__,
    corner: opts.corner,
    labels: opts.labels,
    loadView,
  }))));
}
