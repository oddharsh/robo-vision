// quality.ts: crude, countable proxies for "did the generator get worse".
//   links and images: a drop means content was lost
//   glued: runs of 25+ letters/digits with no space that contain a lower-to-
//          upper case join ("ambitionsThe", "GATEWAYPAYLOADS" is caught by the
//          all-caps rule) and are not inside a URL
//   bun dryrun/quality.ts dryrun/run1 dryrun/out
const [a, b] = process.argv.slice(2);
type R = { url: string; pane?: { step: string | null } };
const results: R[] = await Bun.file(`${b}/results.json`).json();
const slug = (u: string) => new URL(u).hostname.replace(/^www\./, "") + new URL(u).pathname.replace(/\/+$/, "").replace(/\//g, "_");
const read = async (d: string, s: string) => (await Bun.file(`${d}/${s}/machine.md`).exists()) ? Bun.file(`${d}/${s}/machine.md`).text() : "";
const stats = (md: string) => {
  const prose = md.replace(/\]\([^)]*\)/g, "]").replace(/https?:\/\/\S+/g, "");
  return {
    links: (md.match(/\]\(https?:/g) ?? []).length,
    images: (md.match(/!\[/g) ?? []).length,
    glued: (prose.match(/\b[a-z]{3,}[A-Z][a-z]{2,}\w*|\b[A-Z]{12,}\b/g) ?? []).length,
  };
};
console.log("| site | links | images | glued joins |\n|---|--:|--:|--:|");
for (const r of results) {
  if (r.pane?.step !== "generated") continue;
  const x = stats(await read(a, slug(r.url))), y = stats(await read(b, slug(r.url)));
  const d = (p: number, q: number) => (p === q ? `${q}` : `${p} -> ${q}${q < p ? " (-)" : ""}`);
  console.log(`| ${slug(r.url)} | ${d(x.links, y.links)} | ${d(x.images, y.images)} | ${d(x.glued, y.glued)} |`);
}
