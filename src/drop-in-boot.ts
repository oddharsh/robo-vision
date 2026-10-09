// drop-in-boot.ts: what both drop-in entries share. Reads the options off the
// script tag and mounts at the right moment.
//
// WHEN it mounts is the part that costs the host page. Mounting adopts a
// stylesheet, and adding a sheet makes the browser recalculate style for the
// whole document: measured at 5 to 17 ms per page load across six live sites.
// A visitor who arrives in machine view needs the dock at once. Everyone else
// gets it after the page's own load event, when the main thread is idle, so
// robo-vision never competes with the page's first paint or its LCP element.
//
// Configuration rides on the script tag itself, so adopting robo-vision needs
// no JavaScript of the site's own:
//   <script type="module" src="/robo-vision/robo-vision.js"
//           data-corner="bottom-left" data-machine-label="Agent"></script>
import { dropIn, type DropInOptions } from "./drop-in.ts";
import { requestedMode } from "./mode.ts";

declare const __ROBO_VISION_CSS__: string;

export function boot(loadView: DropInOptions["loadView"]): void {
  const tag = document.querySelector<HTMLScriptElement>('script[src*="robo-vision"][data-corner], script[src*="robo-vision"][data-human-label], script[src*="robo-vision"][data-machine-label]');
  const cfg = tag?.dataset ?? {};
  const go = () => dropIn({
    css: __ROBO_VISION_CSS__,
    corner: cfg.corner as DropInOptions["corner"],
    labels: { human: cfg.humanLabel, machine: cfg.machineLabel },
    loadView,
  });
  const whenBody = () => (document.body ? go() : document.addEventListener("DOMContentLoaded", go, { once: true }));
  const whenIdle = () => {
    const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(go, { timeout: 2000 }) : setTimeout(go, 1));
    if (document.readyState === "complete") idle();
    else addEventListener("load", idle, { once: true });
  };
  if (requestedMode() === "machine") whenBody();
  else whenIdle();
}
