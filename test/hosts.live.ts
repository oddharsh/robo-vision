// hosts.live.ts: fetchMachineCopy against real sites on each host, for the
// one thing that differs by host: how a missing page is answered. Not part
// of `bun test` (it needs the network and the sites change).
//
//   bun test/hosts.live.ts
import { fetchMachineCopy, originMemory } from "../src/resolve.ts";

const CASES: [host: string, url: string][] = [
  ["vercel", "https://nextjs.org/docs/app/getting-started/instalation"],
  ["vercel", "https://react.dev/learn/thinking-in-reakt"],
  ["vercel", "https://bun.sh/docs/installation/"],
  ["netlify", "https://docs.netlify.com/build/configure-builds/environment-variabls"],
  ["netlify", "https://vuejs.org/guide/Introduction"],
  ["netlify", "https://www.gatsbyjs.com/docs/how-to/routing/creating-routes"],
  ["cloudflare", "https://developers.cloudflare.com/workers/runtime-apis/fetch-handler"],
  ["cloudflare", "https://hono.dev/docs/getting-started/cloudflare-worker"],
  ["cloudflare", "https://docs.astro.build/en/getting-started/instalation/"],
];

for (const [host, url] of CASES) {
  const t = Date.now();
  const r = await fetchMachineCopy(url, { memory: originMemory(), reroute: { pages: ["llms", "sitemap"] } });
  const ms = Date.now() - t;
  const what = r.rerouted ? `followed (${r.rerouted.fix}) -> ${new URL(r.rerouted.to).pathname}, ${r.copy ? `${r.copy.step} copy` : "HTML"}`
    : r.suggestions?.length ? `suggested ${r.suggestions.slice(0, 2).map((s) => `${new URL(s.url).pathname} ${s.score}`).join(", ")}`
    : r.status === 404 ? "404, nothing to suggest" : `HTTP ${r.status}, ${r.copy ? r.copy.step : "no copy"}`;
  console.log(`${host.padEnd(10)} ${new URL(url).host.padEnd(26)} ${String(ms).padStart(5)} ms  ${what}`);
}
