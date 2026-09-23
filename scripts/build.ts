// build.ts: the drop-in, two ways from one source.
//
//   bun scripts/build.ts
//
//   dist/robo-vision.js          ES module, loaded with <script type="module">.
//                                The toggle and its skin; the resolver, the
//                                generator and the pane arrive from chunks/ on
//                                first use, Speakeasy-style.
//   dist/chunks/*.js             those, resolved relative to the entry's URL
//   dist/robo-vision.eager.js    one classic script with everything inlined,
//                                for a host that cannot serve module chunks
//
// The design-system tokens are authored on :root. On a host page, :root is the
// SITE's, so they are rescoped to [data-robo-vision] here; the dock and pane
// carry that attribute and everything under them inherits. Both CSS groups are
// minified: they were shipped with their comments until 2026-09-23, which made
// the stylesheet larger than all of the JavaScript.

import { mkdir, rm } from "node:fs/promises";

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
const tokens = (await Promise.all(["demo/colors.css", "demo/typography.css", "demo/bevels.css"].map(read)))
  .join("\n")
  .replace(/:root\b/g, ":where([data-robo-vision])");
await Bun.write(`${dist}.tmp/tokens.css`, tokens);

// up front: what the toggle, the dock and the overlay's first paint need
const css = await minifyCss("eager", ["dist/.tmp/tokens.css", "src/xp.css", "src/drop-in.css"]);
// on first use: the pane's contents
const paneCss = await minifyCss("pane", ["src/xp-pane.css", "src/drop-in-pane.css"]);
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
console.log(`css: ${css.length} B up front (tokens + toggle + dock), ${paneCss.length} B with the view`);
for (const o of lazy.outputs) console.log(await row(o.path));
console.log(await row(dist + "robo-vision.eager.js"));
