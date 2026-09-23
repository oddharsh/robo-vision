// drop-in-entry.ts: the drop-in's body. One script tag, no markup.
//
// WHEN it mounts is the part that costs the host page. Mounting adopts a
// stylesheet, and adding a sheet makes the browser recalculate style for the
// whole document: measured at 5 to 17 ms per page load across six live sites.
// A visitor who arrives in machine view needs the dock at once. Everyone else
// gets it after the page's own load event, when the main thread is idle, so
// robo-vision never competes with the page's first paint or its LCP element.
import { dropIn } from "./drop-in.ts";
import { requestedMode } from "./mode.ts";

declare const __ROBO_VISION_CSS__: string;

const go = () => dropIn({ css: __ROBO_VISION_CSS__ });

const whenBody = () => (document.body ? go() : document.addEventListener("DOMContentLoaded", go, { once: true }));
const whenIdle = () => {
  const idle = () => ("requestIdleCallback" in window ? requestIdleCallback(go, { timeout: 2000 }) : setTimeout(go, 1));
  if (document.readyState === "complete") idle();
  else addEventListener("load", idle, { once: true });
};

if (requestedMode() === "machine") whenBody();
else whenIdle();
