// probe.ts: run the resolver against real sites from the command line.
// Same code the toggle runs, minus the one step a CLI cannot do (generate:
// there is no rendered DOM here). Page facts come from HTMLRewriter over the
// fetched HTML, so this reads what a first request sees, before any script.
//
//   bun probe.ts https://parallel.ai/ https://www.cloudflare.com/connect/ ...

import { resolveMachineCopy, type PageFacts } from "./src/source.ts";

const UA = "robo-vision-probe/0.1 (+https://aadhar.sh/bot)";
const urls = process.argv.slice(2);

// which toggle flavor, if any, the HTML carries. Markers read off each site's
// served markup on 2026-09-23; a site can rename them any day.
const FLAVORS: [string, RegExp][] = [
  ["sibling region (Cloudflare)", /data-machine-only|cf-mode-toggle/],
  ["restyle one DOM (Parallel)", /data-switch-mode=|machine:hidden/],
  ["doubled spans (Kong)", /class="agent"|class="not-agent"|\bnot-agent\b/],
];

async function facts(html: string): Promise<PageFacts> {
  const alternates: string[] = [];
  let inPage: string | null = null;
  let inRegion = 0;
  await new HTMLRewriter()
    .on('link[rel~="alternate"]', {
      element(e) {
        const t = (e.getAttribute("type") ?? "").toLowerCase();
        const h = e.getAttribute("href");
        if (h && (t === "text/markdown" || t === "text/x-markdown")) alternates.push(h);
      },
    })
    .on("[data-machine-only]", {
      element(e) { inPage ??= ""; inRegion++; e.onEndTag(() => { inRegion--; }); },
      text(t) { if (inRegion) inPage += t.text; },
    })
    .transform(new Response(html))
    .text();
  return { alternates, inPage };
}

for (const url of urls) {
  const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html" } });
  const html = await res.text();
  const pf = await facts(html);
  const flavor = FLAVORS.filter(([, re]) => re.test(html)).map(([n]) => n);
  console.log(`\n${url}  (HTML ${res.status}, ${(html.length / 1024).toFixed(0)} KB)`);
  console.log(`  toggle flavor: ${flavor.join(", ") || "none detected in first-response HTML"}`);
  try {
    const c = await resolveMachineCopy(res.url || url, { facts: pf, skip: ["generated"], headers: { "user-agent": UA } });
    for (const a of c.attempts) console.log(`  ${a.hit ? "HIT " : "miss"} ${a.step.padEnd(14)} ${a.url ?? ""}  ${a.reason}`);
    console.log(`  => ${c.step}${c.served ? " (served to agents)" : " (not negotiated)"}: ${c.text.length} chars, starts ${JSON.stringify(c.text.trim().slice(0, 70))}`);
    // an in-page region is what HUMANS see in machine mode; ask separately
    // whether an agent is served anything at all
    if (c.step === "in-page") {
      const served = await resolveMachineCopy(res.url || url, { facts: { ...pf, inPage: null }, skip: ["in-page", "generated"], headers: { "user-agent": UA } })
        .then((s) => `${s.step}, ${s.text.length} chars`, () => "nothing: an agent gets the HTML");
      console.log(`  agents served: ${served}`);
    }
  } catch (e) {
    for (const a of (e as { attempts: { hit: boolean; step: string; url: string | null; reason: string }[] }).attempts ?? [])
      console.log(`  miss ${a.step.padEnd(14)} ${a.url ?? ""}  ${a.reason}`);
    console.log("  => nothing published; the toggle would generate");
  }
}
