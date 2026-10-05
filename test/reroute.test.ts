import { test, expect } from "bun:test";
import { originMemory, mapStore } from "../src/memory.ts";
import { reroute, exactFix, pagesFromLlmsTxt, parseSitemap, spellingChooser, type Chooser } from "../src/reroute.ts";
import { fetchMachineCopy } from "../src/resolve.ts";

const O = "https://example.test";
const LLMS = `# Example

## Docs

- [Getting started](https://example.test/docs/getting-started.md): install and first run
- [Pricing](/pricing): what it costs
- [Careers](/careers)
- [Elsewhere](https://other.test/x)
`;
type Route = { status?: number; type?: string; body: string };
function site(routes: Record<string, Route>) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const md = /markdown/.test(new Headers(init?.headers).get("accept") ?? "") && !url.pathname.endsWith(".txt");
    const key = `${md ? "md " : ""}${url.pathname}`;
    seen.push(key);
    const r = routes[key] ?? { status: 404, type: "text/html", body: "<!doctype html>not found" };
    const res = new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html", vary: "Accept" } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  return { f, seen };
}
const page = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body>${title}</body></html>`;

// ---- reading lists ----------------------------------------------------------

test("llms.txt entries become same-origin pages, .md twins as their pages", () => {
  expect(pagesFromLlmsTxt(LLMS, O)).toEqual([
    { url: `${O}/docs/getting-started`, title: "Getting started", description: "install and first run" },
    { url: `${O}/pricing`, title: "Pricing", description: "what it costs" },
    { url: `${O}/careers`, title: "Careers" },
  ]);
});

test("a sitemap index is told apart from a sitemap", () => {
  expect(parseSitemap(`<sitemapindex><sitemap><loc>${O}/a.xml</loc></sitemap></sitemapindex>`)).toEqual({ index: true, locs: [`${O}/a.xml`] });
  expect(parseSitemap(`<urlset><url><loc><![CDATA[${O}/p?a=1&amp;b=2]]></loc></url></urlset>`).locs).toEqual([`${O}/p?a=1&b=2`]);
});

// ---- exact fixes ------------------------------------------------------------

test("case, slash, .html and /index are fixed when exactly one page matches", () => {
  const pages = [{ url: `${O}/docs/intro` }, { url: `${O}/about/` }];
  expect(exactFix(`${O}/Docs/Intro`, pages)).toMatchObject({ to: `${O}/docs/intro`, fix: "case" });
  expect(exactFix(`${O}/about`, pages)).toMatchObject({ to: `${O}/about/`, fix: "trailing slash" });
  expect(exactFix(`${O}/docs/intro.html`, pages)).toMatchObject({ to: `${O}/docs/intro`, fix: ".html" });
  expect(exactFix(`${O}/about/index.html`, pages)).toMatchObject({ to: `${O}/about/`, fix: "/index" });
  expect(exactFix(`${O}/docs/intro/?v=2`, pages)!.to).toBe(`${O}/docs/intro?v=2`);
});

test("two pages in one canonical form is not a fix", () => {
  expect(exactFix(`${O}/A/`, [{ url: `${O}/A` }, { url: `${O}/a` }])).toBeNull();
});

// ---- choosing ---------------------------------------------------------------

test("a typo ranks its page first, below the certainty of an exact fix", async () => {
  const ranked = (await spellingChooser(`${O}/docs/getting-stared`, pagesFromLlmsTxt(LLMS, O))).sort((a, b) => b.score - a.score);
  expect(ranked[0].url).toBe(`${O}/docs/getting-started`);
  expect(ranked[0].score).toBeGreaterThan(0.8);
  expect(ranked[0].score).toBeLessThan(1);
});

test("a chooser cannot add a page the origin does not list", async () => {
  const { f } = site({ "/llms.txt": { type: "text/plain", body: LLMS } });
  const liar: Chooser = () => [{ url: `${O}/invented`, score: 0.99 }, { url: `${O}/careers`, score: 0.8 }];
  const r = await reroute(`${O}/jobs`, { fetch: f, chooser: liar });
  expect(r.suggestions.map((s) => s.url)).toEqual([`${O}/careers`]);
});

test("an app shell at /llms.txt is no list", async () => {
  const r = await reroute(`${O}/pricng`, { fetch: site({ "/llms.txt": { body: page("App") } }).f });
  expect(r).toEqual({ rerouted: null, suggestions: [], sources: [{ source: "llms", pages: 0 }] });
});

test("an app shell that opens with a comment is no list, whatever its type says", async () => {
  // typed text/plain, so only the sniff can tell; the comment hid it from the
  // old one, and the shell's own Markdown-looking text was read as pages
  const shell = "<!-- build 4f2a -->\n<!doctype html><html><body><p>See [docs](/docs).</p></body></html>";
  const r = await reroute(`${O}/pricng`, { fetch: site({ "/llms.txt": { type: "text/plain", body: shell } }).f });
  expect(r.sources).toEqual([{ source: "llms", pages: 0 }]);
});

test("the sitemap is read only when asked for, through robots.txt and an index", async () => {
  const routes = {
    "/robots.txt": { type: "text/plain", body: `User-agent: *\nSitemap: ${O}/sm-index.xml\n` },
    "/sm-index.xml": { type: "application/xml", body: `<sitemapindex><sitemap><loc>${O}/sm-1.xml</loc></sitemap></sitemapindex>` },
    "/sm-1.xml": { type: "application/xml", body: `<urlset><url><loc>${O}/guides/deploying/</loc></url></urlset>` },
  };
  const plain = site(routes);
  await reroute(`${O}/guides/deploying`, { fetch: plain.f });
  expect(plain.seen).toEqual(["/llms.txt"]);
  const both = site(routes);
  const r = await reroute(`${O}/guides/deploying`, { fetch: both.f, pages: ["llms", "sitemap"] });
  expect(r.rerouted).toMatchObject({ to: `${O}/guides/deploying/`, fix: "trailing slash" });
  expect(both.seen).toEqual(["/llms.txt", "/robots.txt", "/sm-index.xml", "/sm-1.xml"]);
});

test("with no sitemap named, /sitemap-index.xml is tried after /sitemap.xml (Astro's default)", async () => {
  const { f, seen } = site({
    "/robots.txt": { type: "text/plain", body: "User-agent: *\nAllow: /\n" },
    "/sitemap-index.xml": { type: "application/xml", body: `<sitemapindex><sitemap><loc>${O}/sitemap-0.xml</loc></sitemap></sitemapindex>` },
    "/sitemap-0.xml": { type: "application/xml", body: `<urlset><url><loc>${O}/en/install/</loc></url></urlset>` },
  });
  const r = await reroute(`${O}/en/install`, { fetch: f, pages: ["sitemap"] });
  expect(r.rerouted!.to).toBe(`${O}/en/install/`);
  expect(seen).toEqual(["/robots.txt", "/sitemap.xml", "/sitemap-index.xml", "/sitemap-0.xml"]);
});

test("a list that failed to arrive is not remembered; a 404 is", async () => {
  const memory = originMemory();
  let down = true;
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    if (down) throw new TypeError("network down");
    const res = new Response(LLMS, { headers: { "content-type": "text/plain" } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  const first = await reroute(`${O}/creers`, { fetch: f, memory });
  expect(first.suggestions).toEqual([]);
  expect(first.sources).toEqual([{ source: "llms", pages: 0, failed: true }]);
  down = false;
  const second = await reroute(`${O}/creers`, { fetch: f, memory });
  expect(second.suggestions[0].url).toBe(`${O}/careers`); // asked again, and found

  // a server error is a failure too; a 404 is an answer, and kept
  const s503 = site({ "/llms.txt": { status: 503, body: "busy" } });
  const m2 = originMemory();
  await reroute(`${O}/x`, { fetch: s503.f, memory: m2 });
  await reroute(`${O}/y`, { fetch: s503.f, memory: m2 });
  expect(s503.seen).toEqual(["/llms.txt", "/llms.txt"]);
  const s404 = site({});
  const m3 = originMemory();
  await reroute(`${O}/x`, { fetch: s404.f, memory: m3 });
  await reroute(`${O}/y`, { fetch: s404.f, memory: m3 });
  expect(s404.seen).toEqual(["/llms.txt"]);
});

test("a sitemap read that partly failed is used once, not remembered", async () => {
  const memory = originMemory();
  let child: Route = { status: 502, body: "bad gateway" };
  const routes: Record<string, Route> = {
    "/robots.txt": { type: "text/plain", body: `Sitemap: ${O}/sm.xml\n` },
    "/sm.xml": { type: "application/xml", body: `<sitemapindex><sitemap><loc>${O}/a.xml</loc></sitemap><sitemap><loc>${O}/b.xml</loc></sitemap></sitemapindex>` },
    "/a.xml": { type: "application/xml", body: `<urlset><url><loc>${O}/guides/one/</loc></url></urlset>` },
  };
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const r = path === "/b.xml" ? child : routes[path] ?? { status: 404, body: "" };
    const res = new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html" } });
    Object.defineProperty(res, "url", { value: new URL(String(input)).href });
    return res;
  }) as typeof fetch;
  const first = await reroute(`${O}/guides/one`, { fetch: f, memory, pages: ["sitemap"] });
  expect(first.rerouted!.to).toBe(`${O}/guides/one/`); // what did arrive is still used
  expect(first.sources).toEqual([{ source: "sitemap", pages: 1, failed: true }]);
  child = { type: "application/xml", body: `<urlset><url><loc>${O}/guides/two/</loc></url></urlset>` };
  const second = await reroute(`${O}/guides/two`, { fetch: f, memory, pages: ["sitemap"] });
  expect(second.rerouted!.to).toBe(`${O}/guides/two/`);
});

test("a list is read once per origin", async () => {
  const { f, seen } = site({ "/llms.txt": { type: "text/plain", body: LLMS } });
  const memory = originMemory();
  await reroute(`${O}/a`, { fetch: f, memory });
  await reroute(`${O}/b`, { fetch: f, memory });
  expect(seen).toEqual(["/llms.txt"]);
});

// ---- the agent's fetch ------------------------------------------------------

test("a 404 one slash off is followed and flagged", async () => {
  const { f } = site({
    "/llms.txt": { type: "text/plain", body: LLMS },
    "/pricing": { body: page("Pricing") },
    "md /pricing": { type: "text/markdown", body: "# Pricing\n" },
  });
  const r = await fetchMachineCopy(`${O}/pricing/`, { fetch: f, memory: null });
  expect(r.rerouted).toEqual({ from: `${O}/pricing/`, to: `${O}/pricing`, fix: "trailing slash" });
  expect(r.copy!.text).toBe("# Pricing\n");
});

test("a 404 that is a typo is suggested, never followed", async () => {
  const { f, seen } = site({ "/llms.txt": { type: "text/plain", body: LLMS }, "/careers": { body: page("Careers") } });
  const r = await fetchMachineCopy(`${O}/creers`, { fetch: f, memory: null });
  expect(r.copy).toBeNull();
  expect(r.status).toBe(404);
  expect(r.rerouted).toBeUndefined();
  expect(r.suggestions![0].url).toBe(`${O}/careers`);
  expect(seen).toEqual(["/creers", "/llms.txt"]);
});

test("reroute: false returns the 404 alone", async () => {
  const { seen, f } = site({});
  const r = await fetchMachineCopy(`${O}/x`, { fetch: f, memory: null, reroute: false });
  expect(r.suggestions).toBeUndefined();
  expect(seen).toEqual(["/x"]);
});

test("memory: the door that worked is asked first, a quiet section not at all", async () => {
  const routes = {
    "/docs/a": { body: page("A") }, "/docs/b": { body: page("B") }, "md /docs/a.md": { type: "text/markdown", body: "# A\n" }, "md /docs/b.md": { type: "text/markdown", body: "# B\n" },
    "/blog/a": { body: page("Blog A") }, "/blog/b": { body: page("Blog B") },
  };
  const { f, seen } = site(routes);
  const memory = originMemory(mapStore());
  await fetchMachineCopy(`${O}/docs/a`, { fetch: f, memory });
  seen.length = 0;
  await fetchMachineCopy(`${O}/docs/b`, { fetch: f, memory });
  expect(seen).toEqual(["/docs/b", "md /docs/b.md"]);

  await fetchMachineCopy(`${O}/blog/a`, { fetch: f, memory });
  seen.length = 0;
  const r = await fetchMachineCopy(`${O}/blog/b`, { fetch: f, memory });
  expect(seen).toEqual(["/blog/b"]);
  expect(r.copy).toBeNull();
});

test("a remembered miss expires", async () => {
  let t = 0;
  const memory = originMemory(mapStore(), { ttl: 1000, now: () => t });
  memory.noteNothing(`${O}/blog/a`, true);
  expect(memory.servesNothing(`${O}/blog/z`)).toBe(true);
  t = 1001;
  expect(memory.servesNothing(`${O}/blog/z`)).toBe(false);
});

test("links in a copy become pages a later 404 can be matched against", async () => {
  const { f } = site({
    "/docs/a": { body: page("A") }, "md /docs/a": { type: "text/markdown", body: "See [Webhooks](/docs/webhooks).\n" },
  });
  const memory = originMemory();
  await fetchMachineCopy(`${O}/docs/a`, { fetch: f, memory });
  const r = await fetchMachineCopy(`${O}/docs/webhoks`, { fetch: f, memory });
  expect(r.suggestions![0]).toMatchObject({ url: `${O}/docs/webhooks`, title: "Webhooks" });
});
