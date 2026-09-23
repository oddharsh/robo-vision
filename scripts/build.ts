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
//
// The only CSS is base.css (and base-pane.css with the view): neutral, and
// restyled by whatever site it lands on with ordinary CSS. A site's own look
// for robo-vision belongs in that site's stylesheet, not in this repository.

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

// up front: integrity rules plus the neutral look of the toggle and dock
const css = await minifyCss("eager", ["src/base.css"]);
// on first use: the pane's contents
const paneCss = await minifyCss("pane", ["src/base-pane.css"]);

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
for (const o of lazy.outputs) console.log(await row(o.path));
console.log(await row(dist + "robo-vision.eager.js"));
