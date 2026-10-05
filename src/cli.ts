// cli.ts: `robo-vision check <url>...`, the audit from a terminal or CI.
//
//   npx robo-vision check https://example.com/docs/ [more urls]
//     --json     the reports as JSON, for another tool to read
//     --strict   warnings fail the run too
//     --ua <s>   the User-Agent to fetch as (sites answer fetchers differently)
//
// Exit code 0 when every page passes, 1 when any has an error finding, 2 on
// bad usage.

import { checkPage, type Report } from "./check.ts";

declare const __ROBO_VISION_VERSION__: string;
const VERSION = typeof __ROBO_VISION_VERSION__ === "string" ? __ROBO_VISION_VERSION__ : "dev";

const USAGE = `robo-vision ${VERSION}

  robo-vision check <url>... [--json] [--strict] [--ua <user-agent>]

Opens every door a page can serve Markdown through (a declared twin, content
negotiation, the .md suffix) and reports what an agent is served and what is
wrong with it. Exits 1 if any page has an error.`;

const args = process.argv.slice(2);
const flags = new Set<string>();
const urls: string[] = [];
let ua = `robo-vision/${VERSION} (+https://www.npmjs.com/package/robo-vision)`;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--ua") ua = args[++i] ?? ua;
  else if (a.startsWith("-")) flags.add(a);
  else urls.push(a);
}

if (flags.has("--version") || flags.has("-v")) {
  console.log(VERSION);
  process.exit(0);
}
if (flags.has("--help") || flags.has("-h") || urls[0] !== "check" || urls.length < 2) {
  console.log(USAGE);
  process.exit(flags.has("--help") || flags.has("-h") ? 0 : 2);
}

const MARK = { error: "error", warn: "warn ", info: "info " } as const;

function print(r: Report) {
  console.log(r.kind === "file"
    ? `\n${r.url}  (a Markdown file, HTTP ${r.page.status ?? "unreachable"})`
    : `\n${r.url}  (HTML ${r.page.status ?? "unreachable"}, ${(r.page.chars / 1024).toFixed(0)} KB)`);
  for (const d of r.doors) {
    // a region on the page takes no request, so it leaves no attempt behind
    if (d.copy && !d.attempts.length) console.log(`  HIT  ${d.step.padEnd(14)}   ${d.copy.text.length} chars on the page, shown to visitors`);
    for (const a of d.attempts) {
      console.log(`  ${a.hit ? "HIT " : "miss"} ${a.step.padEnd(14)} ${a.url ?? ""}  ${a.reason}${a.busted ? " (cache-busted)" : ""}`);
    }
  }
  const flaky = r.findings.some((f) => f.rule === "cache-ignores-accept");
  console.log(!r.served ? "  => agents are served HTML"
    : flaky ? `  => agents are served HTML or ${r.served.text.length.toLocaleString("en")} chars of Markdown, whichever the cache holds`
    : `  => agents are served ${r.served.text.length.toLocaleString("en")} chars of Markdown by ${r.served.step}`);
  // no rule can say whether the Markdown is about the page; a glance can
  if (r.served) console.log(`     starts ${JSON.stringify(r.served.text.trim().replace(/\s+/g, " ").slice(0, 70))}`);
  for (const f of r.findings) console.log(`  ${MARK[f.severity]} ${f.rule}: ${f.message}${f.url ? `\n        ${f.url}` : ""}`);
}

const reports: Report[] = [];
for (const url of urls.slice(1)) {
  let target: string;
  try { target = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).href; } catch {
    console.error(`not a URL: ${url}`);
    process.exit(2);
  }
  const r = await checkPage(target, { headers: { "user-agent": ua } });
  reports.push(r);
  if (!flags.has("--json")) print(r);
}

if (flags.has("--json")) console.log(JSON.stringify(reports, null, 2));

const failing = (r: Report) => r.findings.some((f) => f.severity === "error" || (flags.has("--strict") && f.severity === "warn"));
const bad = reports.filter(failing).length;
if (!flags.has("--json")) console.log(`\n${reports.length - bad} of ${reports.length} passed`);
process.exit(bad ? 1 : 0);
