// drop-in-entry.ts: the IIFE's body. One script tag, no markup.
import { dropIn } from "./drop-in.ts";

declare const __ROBO_VISION_CSS__: string;

const go = () => dropIn({ css: __ROBO_VISION_CSS__ });
if (document.body) go();
else document.addEventListener("DOMContentLoaded", go, { once: true });
