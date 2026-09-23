// build.ts: the drop-in IIFE, one file with its skin inside.
//
//   bun scripts/build.ts   ->  dist/robo-vision.dropin.js
//
// The design-system tokens are authored on :root. On a host page, :root is the
// SITE's, so they are rescoped to [data-robo-vision] here; the dock and pane
// carry that attribute and everything under them inherits.

const root = new URL("..", import.meta.url).pathname;
const read = (p: string) => Bun.file(root + p).text();

const tokens = (await Promise.all(["demo/fonts.css", "demo/colors.css", "demo/typography.css", "demo/bevels.css"].map(read)))
  .join("\n")
  .replace(/:root\b/g, ":where([data-robo-vision])");
const css = [tokens, await read("src/xp.css"), await read("src/drop-in.css")].join("\n");

const out = await Bun.build({
  entrypoints: [root + "src/drop-in-entry.ts"],
  format: "iife",
  target: "browser",
  minify: true,
  define: { __ROBO_VISION_CSS__: JSON.stringify(css) },
});
if (!out.success) throw new AggregateError(out.logs, "build failed");
const js = await out.outputs[0].text();
await Bun.write(root + "dist/robo-vision.dropin.js", js);
console.log(`dist/robo-vision.dropin.js  ${(js.length / 1024).toFixed(1)} KB`);
