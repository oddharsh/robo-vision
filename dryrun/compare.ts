// compare.ts: one run against another, per site.
//   bun dryrun/compare.ts dryrun/run1 dryrun/out
type R = { url: string; findings: string[]; pane?: { step: string | null; chars: number } };
const [a, b] = process.argv.slice(2);
const load = async (d: string): Promise<Map<string, R>> =>
  new Map((await Bun.file(`${d}/results.json`).json() as R[]).map((r) => [r.url, r]));
const A = await load(a), B = await load(b);
const host = (u: string) => new URL(u).hostname.replace(/^www\./, "") + new URL(u).pathname.replace(/\/$/, "");
console.log(`| site | step | chars | findings before | findings after |\n|---|---|--:|---|---|`);
for (const [url, rb] of B) {
  const ra = A.get(url);
  const step = ra?.pane?.step === rb.pane?.step ? rb.pane?.step : `${ra?.pane?.step} -> ${rb.pane?.step}`;
  const chars = ra?.pane?.chars === rb.pane?.chars ? `${rb.pane?.chars}` : `${ra?.pane?.chars} -> ${rb.pane?.chars}`;
  const f = (r?: R) => (r?.findings.length ? r.findings.map((x) => x.replace(/\|/g, "\\|")).join("<br>") : "none");
  console.log(`| ${host(url)} | ${step} | ${chars} | ${f(ra)} | ${f(rb)} |`);
}
