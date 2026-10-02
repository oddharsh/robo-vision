// probe.ts: run the resolver against real sites from the command line.
// Same code the toggle runs, minus the one step a CLI cannot do (generate:
// there is no rendered DOM here). Page facts come from the fetched HTML, so
// this reads what a first request sees, before any script. `robo-vision check`
// (src/cli.ts) is the audit built on the same survey; this adds only the
// guess at which toggle a site built.
//
//   bun probe.ts https://parallel.ai/ https://www.cloudflare.com/connect/ ...

import { surveyMachineCopies } from "./src/source.ts";
import { factsFromHtml } from "./src/facts-html.ts";

const UA = "robo-vision-probe/0.1 (+https://aadhar.sh/bot)";
const urls = process.argv.slice(2);

// which toggle flavor, if any, the HTML carries. Markers read off each site's
// served markup on 2026-09-23; a site can rename them any day.
const FLAVORS: [string, RegExp][] = [
  ["sibling region (Cloudflare)", /data-machine-only|cf-mode-toggle/],
  ["restyle one DOM (Parallel)", /data-switch-mode=|machine:hidden/],
  ["doubled spans (Kong)", /class="agent"|class="not-agent"|\bnot-agent\b/],
];

for (const url of urls) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
  const html = await res.text();
  const flavor = FLAVORS.filter(([, re]) => re.test(html)).map(([n]) => n);
  console.log(`\n${url}  (HTML ${res.status}, ${(html.length / 1024).toFixed(0)} KB)`);
  console.log(`  toggle flavor: ${flavor.join(", ") || "none detected in first-response HTML"}`);
  // every door, not the first hit: an in-page region is what HUMANS see in
  // machine mode, and whether an agent is served anything is a separate answer
  const doors = await surveyMachineCopies(res.url || url, { facts: factsFromHtml(html), headers: { "user-agent": UA } });
  for (const d of doors) {
    if (d.copy && !d.attempts.length) console.log(`  HIT  ${d.step.padEnd(14)}   ${d.copy.text.length} chars on the page`);
    for (const a of d.attempts) console.log(`  ${a.hit ? "HIT " : "miss"} ${a.step.padEnd(14)} ${a.url ?? ""}  ${a.reason}`);
  }
  const shown = doors.find((d) => d.copy)?.copy;
  const served = doors.find((d) => d.copy?.served)?.copy;
  if (!shown) console.log("  => nothing published; the toggle would generate");
  else console.log(`  => ${shown.step}${shown.served ? " (served to agents)" : " (not negotiated)"}: ${shown.text.length} chars, starts ${JSON.stringify(shown.text.trim().slice(0, 70))}`);
  if (shown && !shown.served) console.log(`  agents served: ${served ? `${served.step}, ${served.text.length} chars` : "nothing: an agent gets the HTML"}`);
}
