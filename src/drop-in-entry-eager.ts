// drop-in-entry-eager.ts: the single-file drop-in, dist/robo-vision.eager.js,
// for a host that cannot serve the view as a second file. Everything is in
// this one script, so the view "loads" at once; the pane's styles are adopted
// at startup rather than on first use, which is the one cost of this shape.
//
// A classic script, so it is always a tag, and always mounts. currentScript is
// set while a classic script runs, injected or not, so its options are read
// from the right tag.
import { mounter, optionsFrom, ownTag } from "./drop-in-boot.ts";
import * as view from "./drop-in-view.ts";

const tag = (document.currentScript as HTMLScriptElement | null) ?? ownTag(null);
void mounter(() => Promise.resolve(view))(tag ? optionsFrom(tag) : {});
