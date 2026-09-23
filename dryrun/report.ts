// report.ts: results.json -> a Markdown table plus a count of each finding class.
//   bun dryrun/report.ts > dryrun/out/report.md

const root = new URL("..", import.meta.url).pathname;
type R = {
  url: string; stack: string; kind: string; agent: string; status: number | null; csp: string | null;
  findings: string[]; fillMs?: number; mounted?: boolean;
  pane?: { step: string | null; chars: number; status: string[] };
  before?: { shadowRoots: number; hasMain: boolean; elements: number };
  generatedRatio?: number | null; noiseLines?: number; styleDrift?: string[];
};
const results: R[] = await Bun.file(root + "dryrun/out/results.json").json();

const host = (u: string) => new URL(u).hostname.replace(/^www\./, "") + new URL(u).pathname.replace(/\/$/, "");
const enforcesTT = (csp: string | null) => !!csp && /require-trusted-types-for/.test(csp);
// collapse a finding to its class, so 12 different z-indexes count as one problem
const klass = (f: string) => f
  .replace(/<html ([\w-]+)>.*/, "<html $1>")
  .replace(/\(.*\)/, "")
  .replace(/covered by .*/, "covered by page element")
  .replace(/only \d+ words/, "only N words")
  .replace(/^\d+ shadow roots/, "N shadow roots")
  .replace(/pane error: .*/, "pane error")
  .trim();

const lines: string[] = [];
lines.push(`# robo-vision dry run\n`);
lines.push(`${results.length} sites. Machine copy found (served) on ${results.filter((r) => r.pane?.status?.[1] === "served to agents").length}; in-page on ${results.filter((r) => r.pane?.step === "in-page").length}; generated on ${results.filter((r) => r.pane?.step === "generated").length}; no copy on ${results.filter((r) => !r.pane?.step).length}.\n`);

const counts = new Map<string, string[]>();
for (const r of results) for (const f of r.findings) counts.set(klass(f), [...(counts.get(klass(f)) ?? []), host(r.url)]);
lines.push(`## Finding classes\n`);
lines.push(`| finding | sites | where |\n|---|--:|---|`);
for (const [k, v] of [...counts].sort((a, b) => b[1].length - a[1].length)) lines.push(`| ${k} | ${v.length} | ${v.slice(0, 6).join(", ")}${v.length > 6 ? ", ..." : ""} |`);

lines.push(`\n## Per site\n`);
lines.push(`| site | stack | agent | HTTP | step | chars | fill ms | TT | findings |\n|---|---|---|--:|---|--:|--:|---|---|`);
for (const r of results) {
  lines.push(`| ${host(r.url)} | ${r.stack} | ${r.agent} | ${r.status ?? "-"} | ${r.pane?.step ?? "-"} | ${r.pane?.chars ?? "-"} | ${r.fillMs ?? "-"} | ${enforcesTT(r.csp) ? "yes" : ""} | ${r.findings.map((f) => f.replace(/\|/g, "\\|")).join("<br>") || "none"} |`);
}
console.log(lines.join("\n"));
