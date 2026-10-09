// drop-in-entry.ts: the lazy drop-in, dist/robo-vision.js. One script tag.
//
// The view (resolver, generator, pane) is a SEPARATE file the build writes to
// chunks/, and this entry reaches it by a URL resolved at runtime against its
// own. No bundler sees an import graph here, so none can reshape it: with a
// literal import() and code splitting on, Bun's splitter moved the modules the
// entry and the view both use (mode.ts, adopt.ts) into a shared chunk the
// entry had to import STATICALLY, a second request on every page load. The
// lazy tests caught it on 2026-10-09; this shape cannot regress that way.
import { boot } from "./drop-in-boot.ts";
import type { ViewModule } from "./mode-toggle.ts";

declare const __ROBO_VISION_VIEW__: string; // "./chunks/view-<hash>.js", from the build

boot(() => import(new URL(__ROBO_VISION_VIEW__, import.meta.url).href) as Promise<ViewModule>);
