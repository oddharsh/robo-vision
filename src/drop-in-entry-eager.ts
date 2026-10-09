// drop-in-entry-eager.ts: the single-file drop-in, dist/robo-vision.eager.js,
// for a host that cannot serve the view as a second file. Everything is in
// this one script, so the view "loads" at once; the pane's styles are adopted
// at startup rather than on first use, which is the one cost of this shape.
import { boot } from "./drop-in-boot.ts";
import * as view from "./drop-in-view.ts";

boot(() => Promise.resolve(view));
