import { test, expect } from "bun:test";
import { surveyMachineCopies, resolveMachineCopy } from "../src/source.ts";
import { factsFromHtml } from "../src/facts-html.ts";
import { checkPage } from "../src/check.ts";
import { fetchMachineCopy } from "../src/resolve.ts";

type Route = { status?: number; type?: string; body: string; vary?: string };
// a fake origin, as in source.test.ts: routes keyed "<md|html> <path>"
function origin(routes: Record<string, Route>) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const key = `${/markdown/.test(accept) ? "md" : "html"} ${url.pathname}`;
    seen.push(key);
    const busted = url.searchParams.has("_rv");
    const r = (busted ? routes[`${key} busted`] : undefined) ?? routes[key] ?? routes[`* ${url.pathname}`] ?? { status: 404, type: "text/html", body: "<!doctype html>nope" };
    const res = new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html", ...(r.vary && { vary: r.vary }) } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  return { f, seen };
}

const PAGE = "https://example.test/docs/page";
const MD = "# Title\n\nbody\n";
const html = (head = "", body = "<main>hello</main>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const DECLARED = '<link rel="alternate" type="text/markdown" href="/docs/page.md">';
const rules = (r: { findings: { rule: string }[] }) => r.findings.map((x) => x.rule).sort();

// ---- factsFromHtml ---------------------------------------------------------

test("alternates are read whatever the attribute order or quoting", () => {
  const f = factsFromHtml(`<link href='/a.md' type="text/markdown" rel="alternate"><link rel=alternate type=text/x-markdown href=/b.md><link rel="alternate" type="application/rss+xml" href="/feed"><link rel="stylesheet" href="/x.css">`);
  expect(f.alternates).toEqual(["/a.md", "/b.md"]);
});

test("an href's entities are decoded", () => {
  expect(factsFromHtml('<link rel="alternate" type="text/markdown" href="/a.md?x=1&amp;y=2">').alternates).toEqual(["/a.md?x=1&y=2"]);
});

test("a link inside a comment or a script is not a declaration", () => {
  const f = factsFromHtml(`<!-- ${DECLARED} --><script>var s = '${DECLARED}';</script>`);
  expect(f.alternates).toEqual([]);
});

test("the machine region's text is read through nested tags of its own kind", () => {
  const f = factsFromHtml(html("", `<section data-machine-only><section><pre>key  value &lt;x&gt;</pre></section><p>tail</section><p>after</p>`));
  expect(f.inPage).toBe("key  value <x>tail");
});

test("script and style bodies inside the region never reach its text", () => {
  expect(factsFromHtml(`<div data-machine-only>a<script>secret()</script><style>.x{}</style>b</div>`).inPage).toBe("ab");
});

test("no region is null, not empty", () => expect(factsFromHtml(html()).inPage).toBeNull());

// ---- survey ----------------------------------------------------------------

test("a survey opens every door where resolve stops at the first", async () => {
  const routes = { "md /docs/page": { type: "text/markdown", body: MD, vary: "Accept" }, "md /docs/page.md": { type: "text/markdown", body: MD } };
  const a = origin(routes);
  const first = await resolveMachineCopy(PAGE, { fetch: a.f, facts: { alternates: [], inPage: null } });
  expect(first.step).toBe("negotiated");
  expect(a.seen).toEqual(["md /docs/page"]);

  const b = origin(routes);
  const doors = await surveyMachineCopies(PAGE, { fetch: b.f, facts: { alternates: [], inPage: null } });
  expect(doors.map((d) => `${d.step}:${!!d.copy}`)).toEqual(["in-page:false", "link-alternate:false", "negotiated:true", "md-suffix:true"]);
  expect(b.seen).toEqual(["md /docs/page", "md /docs/page.md"]);
});

test("a survey of a page with nothing does not throw", async () => {
  const doors = await surveyMachineCopies(PAGE, { fetch: origin({}).f, facts: { alternates: [], inPage: null } });
  expect(doors.every((d) => !d.copy)).toBe(true);
});

test("order picks the doors and their sequence", async () => {
  const { f, seen } = origin({ "md /docs/page": { type: "text/markdown", body: MD }, "md /docs/page.md": { type: "text/markdown", body: MD } });
  const c = await resolveMachineCopy(PAGE, { fetch: f, order: ["md-suffix", "negotiated"] });
  expect(c.step).toBe("md-suffix");
  expect(seen).toEqual(["md /docs/page.md"]);
});

test("a step skipped with a reason is recorded where it would have run", async () => {
  const c = await resolveMachineCopy(PAGE, { fetch: origin({}).f, facts: { alternates: [], inPage: null }, generate: () => "g", skip: [{ step: "negotiated", reason: "not asked" }, "md-suffix"] });
  expect(c.attempts.map((a) => `${a.step}:${a.reason}`)).toEqual(["in-page:no machine region", "link-alternate:none declared", "negotiated:not asked", "generated:1 chars from the live DOM"]);
});

// ---- checkPage -------------------------------------------------------------

test("a declared, varying, agreeing twin passes with no findings", async () => {
  const { f } = origin({
    "html /docs/page": { body: html(DECLARED) },
    "md /docs/page": { type: "text/markdown", body: MD, vary: "Accept" },
    "md /docs/page.md": { type: "text/markdown", body: MD + "\n" },
  });
  const r = await checkPage(PAGE, { fetch: f });
  expect(r.findings).toEqual([]);
  expect(r.ok).toBe(true);
  expect(r.served!.step).toBe("link-alternate");
});

test("a page that publishes nothing fails", async () => {
  const r = await checkPage(PAGE, { fetch: origin({ "html /docs/page": { body: html() }, "md /docs/page": { body: html(), vary: "Accept" } }).f });
  expect(rules(r)).toEqual(["nothing-served"]);
  expect(r.ok).toBe(false);
});

test("a declared twin that 404s is an error even when another door serves", async () => {
  const r = await checkPage(PAGE, { fetch: origin({ "html /docs/page": { body: html(DECLARED) }, "md /docs/page": { type: "text/markdown", body: MD, vary: "Accept" } }).f });
  expect(rules(r)).toEqual(["dead-alternate"]);
  expect(r.served!.step).toBe("negotiated");
});

test("Markdown only past the cache is an error; Markdown without Vary is a warning", async () => {
  const flaky = await checkPage(PAGE, { fetch: origin({
    "html /docs/page": { body: html(DECLARED) }, "md /docs/page.md": { type: "text/markdown", body: MD },
    "md /docs/page": { body: html() }, "md /docs/page busted": { type: "text/markdown", body: MD },
  }).f });
  expect(rules(flaky)).toEqual(["cache-ignores-accept"]);

  const unvaried = await checkPage(PAGE, { fetch: origin({
    "html /docs/page": { body: html(DECLARED) }, "md /docs/page.md": { type: "text/markdown", body: MD },
    "md /docs/page": { type: "text/markdown", body: MD },
  }).f });
  expect(rules(unvaried)).toEqual(["no-vary-accept"]);
  expect(unvaried.ok).toBe(true);
});

test("HTML under a Markdown label is named", async () => {
  const r = await checkPage(PAGE, { fetch: origin({ "html /docs/page": { body: html() }, "md /docs/page": { type: "text/markdown", body: "<!-- brand -->\n<!doctype html><html>", vary: "Accept" } }).f });
  expect(rules(r)).toEqual(["mislabelled-html", "nothing-served"]);
});

test("a served copy nobody declared, and an app shell at .md, are both reported", async () => {
  const r = await checkPage(PAGE, { fetch: origin({
    "html /docs/page": { body: html() }, "md /docs/page": { type: "text/markdown", body: MD, vary: "Accept" },
    "md /docs/page.md": { body: html() },
  }).f });
  expect(rules(r)).toEqual(["md-suffix-answers-html", "undeclared"]);
  expect(r.ok).toBe(true);
});

test("doors that serve different words disagree", async () => {
  const r = await checkPage(PAGE, { fetch: origin({
    "html /docs/page": { body: html(DECLARED) }, "md /docs/page.md": { type: "text/markdown", body: MD },
    "md /docs/page": { type: "text/markdown", body: "# Stale\n", vary: "Accept" },
  }).f });
  expect(rules(r)).toEqual(["doors-disagree"]);
});

test("a machine region is compared with what is served", async () => {
  const region = `<section data-machine-only><pre>hand written</pre></section>`;
  const only = await checkPage(PAGE, { fetch: origin({ "html /docs/page": { body: html("", region) }, "md /docs/page": { body: html(), vary: "Accept" } }).f });
  expect(rules(only)).toEqual(["in-page-only", "nothing-served"]);
  const drift = await checkPage(PAGE, { fetch: origin({ "html /docs/page": { body: html(DECLARED, region) }, "md /docs/page.md": { type: "text/markdown", body: MD }, "md /docs/page": { type: "text/markdown", body: MD, vary: "Accept" } }).f });
  expect(rules(drift)).toEqual(["in-page-drift"]);
});

test("a refused page is one finding, and no door is opened", async () => {
  const { f, seen } = origin({ "html /docs/page": { status: 403, body: "denied" } });
  const r = await checkPage(PAGE, { fetch: f });
  expect(rules(r)).toEqual(["page-unreachable"]);
  expect(seen).toEqual(["html /docs/page"]);
});

// ---- fetchMachineCopy ------------------------------------------------------

test("an agent gets the declared twin in two requests", async () => {
  const { f, seen } = origin({ "html /docs/page": { body: html(DECLARED) }, "md /docs/page.md": { type: "text/markdown", body: MD } });
  const r = await fetchMachineCopy(PAGE, { fetch: f });
  expect(r.copy!.text).toBe(MD);
  expect(seen).toEqual(["html /docs/page", "md /docs/page.md"]);
});

test("an agent gets the HTML back when nothing is served, region or not", async () => {
  const body = html("", "<div data-machine-only>for visitors</div>");
  const r = await fetchMachineCopy(PAGE, { fetch: origin({ "html /docs/page": { body }, "md /docs/page": { body, vary: "Accept" } }).f });
  expect(r.copy).toBeNull();
  expect(r.html).toBe(body);
  expect(r.attempts.length).toBeGreaterThan(0);
});
