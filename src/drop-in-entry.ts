// drop-in-entry.ts: the lazy drop-in, dist/robo-vision.js. One script tag, or
// one import and a mount() call.
//
// The view (resolver, generator, pane) is a SEPARATE file the build writes to
// chunks/, and this entry reaches it by a URL resolved at runtime against its
// own. No bundler sees an import graph here, so none can reshape it: with a
// literal import() and code splitting on, Bun's splitter moved the modules the
// entry and the view both use (mode.ts, adopt.ts) into a shared chunk the
// entry had to import STATICALLY, a second request on every page load. The
// lazy tests caught it on 2026-10-09; this shape cannot regress that way.
//
// The view's name is a content hash, and the entry's is not, so a deploy can
// strand a browser between them: it holds the old entry for as long as the
// host caches it, the entry asks for a view hash the deploy just deleted, and
// the toggle dies on a 404. So the build also writes the view under a fixed
// name, robo-vision.view.js, beside the entry rather than in chunks/ (where a
// host's immutable rule for hashed files would catch it), and the entry falls
// back to it when the hashed file is gone.
import { mounter, optionsFrom, ownTag } from "./drop-in-boot.ts";
import type { ViewModule } from "./mode-toggle.ts";

declare const __ROBO_VISION_VIEW__: string; // "./chunks/view-<hash>.js", from the build
declare const __ROBO_VISION_VIEW_ALIAS__: string; // "./robo-vision.view.js"

const load = (path: string) => import(new URL(path, import.meta.url).href) as Promise<ViewModule>;

// what the toggle calls on the view; a view from another release that lacks
// one fails here, by name, instead of somewhere inside a click
const USED = ["copyForThisPage", "copyFor", "humanPageFor", "renderPane"] as const;
const checked = (v: ViewModule) => {
  const missing = USED.filter((k) => typeof v[k] !== "function");
  if (missing.length) throw new Error(`robo-vision's view changed under this page (no ${missing.join(", ")}); reload to fix`);
  return v;
};

export const mount = mounter(() => load(__ROBO_VISION_VIEW__).catch(() => load(__ROBO_VISION_VIEW_ALIAS__).then(checked)));
export type { MountOptions, Mounted } from "./drop-in-boot.ts";

const tag = ownTag(import.meta.url);
if (tag) void mount(optionsFrom(tag));
