// build.ts: the drop-in, two ways from one source.
//
//   bun scripts/build.ts
//
//   dist/robo-vision.js          ES module, loaded with <script type="module">.
//                                The toggle and base styles; the resolver, the
//                                generator and the pane arrive from chunks/ on
//                                first use, Speakeasy-style.
//   dist/chunks/*.js             those, resolved relative to the entry's URL
//   dist/robo-vision.eager.js    one classic script with everything inlined,
//                                for a host that cannot serve module chunks
//   dist/skins/xp.css            optional: aadhar.sh's XP Luna skin
//
// The JavaScript carries only base.css: neutral, layered, and built to be
// restyled by whatever site it lands on. Skins are separate stylesheets a site
// links if it wants one; dist/skins/xp.css is aadhar.sh's, with the design
// system's tokens scoped to robo-vision's elements and cut to the ones it reads.

import { mkdir, rm } from "node:fs/promises";
import { shakeTokens, varsIn } from "./shake-tokens.ts";

const root = new URL("..", import.meta.url).pathname;
const dist = root + "dist/";
const read = (p: string) => Bun.file(root + p).text();

async function minifyCss(name: string, parts: string[]): Promise<string> {
  const tmp = `${dist}.tmp/${name}.css`;
  await Bun.write(tmp, (await Promise.all(parts.map(read))).join("\n"));
  const out = await Bun.build({ entrypoints: [tmp], minify: true });
  if (!out.success) throw new AggregateError(out.logs, `css ${name} failed`);
  return (await out.outputs[0].text()).trim();
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

// fonts.css is left out on purpose. Its @font-face rules cannot be scoped the
// way custom properties can, so adopting them redefined "Tahoma", "Verdana",
// "Trebuchet MS" and "Courier New" for the WHOLE host page: aadhar.sh, which
// sets its text in those families, went from CLS 0.001 to 0.168 with the dock
// mounted (5 of 5 runs, 2026-09-23). The design system marks them reference-
// only for the same reason; the font stacks in typography.css name the same
// system fonts and need no declaration to use them.
// up front: integrity rules plus the layered look of the toggle and dock
const css = await minifyCss("eager", ["src/base.css"]);
// on first use: the pane's contents
const paneCss = await minifyCss("pane", ["src/base-pane.css"]);

// the XP skin. fonts.css stays out: @font-face cannot be scoped the way custom
// properties can, and adopting it redefined Tahoma, Verdana, Trebuchet MS and
// Courier New for the WHOLE host page (aadhar.sh: CLS 0.001 to 0.168, 5 of 5
// runs, 2026-09-23). The font stacks in typography.css need no declaration.
const SKIN = ["skins/xp.css", "skins/xp-pane.css", "skins/xp-dock.css"];
const scope = ":where([data-robo-vision], .mt, [data-machine-view])";
const allTokens = (await Promise.all(["demo/colors.css", "demo/typography.css", "demo/bevels.css"].map(read))).join("\n").replace(/:root\b/g, scope);
const skinSrc = (await Promise.all(SKIN.map(read))).join("\n");
const shaken = shakeTokens(allTokens, varsIn(skinSrc));
await Bun.write(`${dist}.tmp/xp-tokens.css`, shaken.css);
const skinCss = await minifyCss("xp", ["dist/.tmp/xp-tokens.css", ...SKIN]);
await mkdir(dist + "skins", { recursive: true });
await Bun.write(dist + "skins/xp.css", skinCss + "\n");
await rm(`${dist}.tmp`, { recursive: true, force: true });

const define = {
  __ROBO_VISION_CSS__: JSON.stringify(css),
  __ROBO_VISION_PANE_CSS__: JSON.stringify(paneCss),
};

const lazy = await Bun.build({
  entrypoints: [root + "src/drop-in-entry.ts"],
  outdir: dist,
  format: "esm",
  splitting: true,
  target: "browser",
  minify: true,
  define,
  naming: { entry: "robo-vision.js", chunk: "chunks/[name]-[hash].js" },
});
if (!lazy.success) throw new AggregateError(lazy.logs, "lazy build failed");

const eager = await Bun.build({
  entrypoints: [root + "src/drop-in-entry.ts"],
  format: "iife",
  target: "browser",
  minify: true,
  define,
});
if (!eager.success) throw new AggregateError(eager.logs, "eager build failed");
await Bun.write(dist + "robo-vision.eager.js", await eager.outputs[0].text());

const gz = async (p: string) => Bun.gzipSync(new Uint8Array(await Bun.file(p).arrayBuffer()), { level: 9 }).length;
const row = async (p: string) => `${p.replace(dist, "dist/").padEnd(42)} ${String(Bun.file(p).size).padStart(6)} B  ${String(await gz(p)).padStart(6)} B gz`;
console.log(`css: ${css.length} B up front (base), ${paneCss.length} B with the view`);
console.log(`skin: dist/skins/xp.css ${skinCss.length} B, ${shaken.kept.length} of ${shaken.kept.length + shaken.dropped.length} tokens kept`);
for (const o of lazy.outputs) console.log(await row(o.path));
console.log(await row(dist + "robo-vision.eager.js"));
