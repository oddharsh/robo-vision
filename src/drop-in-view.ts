// drop-in-view.ts: the lazy half of drop-in mode. view.ts, plus the pane's
// skin, adopted the moment this module arrives, so the pane's contents and the
// rules that style them land together.
import { adopt } from "./adopt.ts";

declare const __ROBO_VISION_PANE_CSS__: string;
adopt(__ROBO_VISION_PANE_CSS__);

export * from "./view.ts";
