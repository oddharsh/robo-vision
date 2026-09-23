import { test, expect } from "bun:test";
import { resolveMachineCopy, rejectReason, suffixCandidates } from "../src/source.ts";

type Route = { status?: number; type?: string; body: string; vary?: string };
// a fake origin: routes keyed "<accept-kind> <path>", where accept-kind is md
// when the request asked for Markdown and html otherwise
function origin(routes: Record<string, Route>) {
  const seen: string[] = [];
  const urls: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const key = `${/markdown/.test(accept) ? "md" : "html"} ${url.pathname}`;
    seen.push(key);
    urls.push(url.href);
    const busted = url.searchParams.has("_rv");
    const r = (busted ? routes[`${key} busted`] : undefined) ?? routes[key] ?? routes[`* ${url.pathname}`] ?? { status: 404, type: "text/html", body: "<!doctype html>nope" };
    const res = new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html", ...(r.vary && { vary: r.vary }) } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  return { f, seen, urls };
}

const PAGE = "https://example.test/docs/page";
const MD = "# Title\n\nbody\n";

test("in-page region wins and costs zero requests", async () => {
  const { f, seen } = origin({});
  const c = await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: ["/x.md"], inPage: "key  value" } });
  expect(c.step).toBe("in-page");
  expect(c.served).toBe(false); // on the page, not negotiable
  expect(seen).toEqual([]);
});

test("a declared alternate is read before anything is guessed", async () => {
  const { f, seen } = origin({ "md /twins/odd-name.md": { type: "text/markdown", body: MD } });
  const c = await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: ["/twins/odd-name.md"], inPage: null } });
  expect(c.step).toBe("link-alternate");
  expect(c.served).toBe(true);
  expect(c.url).toBe("https://example.test/twins/odd-name.md");
  expect(seen).toEqual(["md /twins/odd-name.md"]);
});

test("negotiation answering HTML with a 200 is a miss, not a twin", async () => {
  // the URL-keyed cache case: status is fine, the body is the page
  const { f } = origin({ "md /docs/page": { type: "text/html", body: "<!doctype html><p>page</p>" } });
  const c = await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null }, generate: () => "gen" });
  expect(c.step).toBe("generated");
  const neg = c.attempts.find((a) => a.step === "negotiated")!;
  expect(neg.hit).toBe(false);
  expect(neg.reason).toBe("answered text/html");
});

test("a Markdown content-type over an HTML body is still refused", async () => {
  const { f } = origin({ "md /docs/page": { type: "text/markdown", body: "  <!DOCTYPE html><html>" } });
  const c = await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null }, generate: () => "gen" });
  expect(c.attempts.find((a) => a.step === "negotiated")!.reason).toBe("labelled Markdown, body is HTML");
});

test("HTML behind a leading comment and BOM is still HTML", async () => {
  // allbirds.com (Shopify), 2026-09-23: text/markdown over the whole storefront
  const { f } = origin({ "md /docs/page": { type: "text/markdown", body: "\uFEFF<!--\nDNAM BRANDS\n-->\n<!doctype html>\n<html>" } });
  const c = await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null }, generate: () => "gen" });
  expect(c.attempts.find((a) => a.step === "negotiated")!.reason).toBe("labelled Markdown, body is HTML");
});

test("Markdown that merely starts with a comment is kept", async () => {
  const { f } = origin({ "md /docs/page": { type: "text/markdown", body: "<!-- generated -->\n# Title\n" } });
  expect((await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null } })).step).toBe("negotiated");
});

test("text/plain is accepted at a .md URL and nowhere else", async () => {
  const plain = { type: "text/plain", body: MD };
  const a = origin({ "md /docs/page.md": plain });
  expect((await resolveMachineCopy(PAGE, { fetch: a.f, facts: { alternates: [], inPage: null } })).step).toBe("md-suffix");
  const b = origin({ "md /docs/page": plain });
  await expect(resolveMachineCopy(PAGE, { fetch: b.f, facts: { alternates: [], inPage: null } })).rejects.toThrow(/no machine copy/);
});

test("the SPA fallback on /anything.md does not count", async () => {
  const { f } = origin({ "* /docs/page.md": { type: "text/html", body: "<!doctype html><div id=app>" } });
  const c = await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null }, generate: () => "gen" });
  expect(c.step).toBe("generated");
  expect(c.served).toBe(false);
});

test("a dead declared alternate falls through to the next door", async () => {
  const { f } = origin({ "md /docs/page": { type: "text/markdown", body: MD } });
  const c = await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: ["/gone.md"], inPage: null } });
  expect(c.step).toBe("negotiated");
  expect(c.attempts.map((a) => `${a.step}:${a.hit}`)).toEqual(["in-page:false", "link-alternate:false", "negotiated:true"]);
});

test("generate is never called when a twin exists", async () => {
  let calls = 0;
  const { f } = origin({ "md /docs/page": { type: "text/markdown", body: MD } });
  await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null }, generate: () => (calls++, "gen") });
  expect(calls).toBe(0);
});

test("a plain Markdown answer is taken as is: it is what agents get", async () => {
  // cdata.com: varies on Accept, and its cached copy is what an agent reads
  const { f, urls } = origin({ "md /docs/page": { type: "text/markdown", body: MD, vary: "accept" } });
  const c = await resolveMachineCopy(PAGE + "#frag", { fetch: f, facts: { alternates: [], inPage: null } });
  expect(c.step).toBe("negotiated");
  expect(urls).toEqual([PAGE]);
  expect(c.url).toBe(PAGE + "#frag");
});

test("HTML from a cache that ignores Accept is retried with a throwaway param", async () => {
  // webflow.com: no Vary: Accept, so the edge hands back whichever it stored
  const { f, urls } = origin({
    "md /docs/page": { type: "text/html", body: "<!doctype html>cached page" },
    "md /docs/page busted": { type: "text/markdown", body: MD },
  });
  const c = await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null } });
  expect(c.step).toBe("negotiated");
  const page = urls.filter((u) => new URL(u).pathname === "/docs/page");
  expect(page.map((u) => new URL(u).searchParams.get("_rv") ?? "")).toEqual(["", expect.stringMatching(/^[a-z0-9]{4,}$/)]);
  expect(c.url).toBe(PAGE); // the param never reaches what the pane shows
  expect(c.attempts.at(-1)!.note).toContain("does not vary on Accept");
});

test("HTML that varies on Accept is an answer, not a cache fault", async () => {
  const { f, urls } = origin({ "md /docs/page": { type: "text/html", body: "<!doctype html>page", vary: "Accept-Encoding, Accept" } });
  await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null }, generate: () => "gen" });
  expect(urls.filter((u) => new URL(u).pathname === "/docs/page")).toHaveLength(1);
});

test("an error status is not retried either", async () => {
  const { f, urls } = origin({ "md /docs/page": { status: 406, type: "text/html", body: "<!doctype html>no" } });
  await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null }, generate: () => "gen" });
  expect(urls.filter((u) => new URL(u).pathname === "/docs/page")).toHaveLength(1);
});

test("cacheBust: false never adds the param", async () => {
  const { f, urls } = origin({
    "md /docs/page": { type: "text/html", body: "<!doctype html>cached page" },
    "md /docs/page busted": { type: "text/markdown", body: MD },
  });
  await resolveMachineCopy(PAGE, { fetch: f, facts: { alternates: [], inPage: null }, cacheBust: false, generate: () => "gen" });
  expect(urls.some((u) => u.includes("_rv="))).toBe(false);
});

test("suffix spellings follow the llms.txt proposal", () => {
  expect(suffixCandidates("https://x.test/")).toEqual(["https://x.test/index.md", "https://x.test/index.html.md"]);
  expect(suffixCandidates("https://x.test/a/b?q=1#h")).toEqual(["https://x.test/a/b.md"]);
  expect(suffixCandidates("https://x.test/a/")).toEqual(["https://x.test/a.md", "https://x.test/a/index.html.md"]);
  expect(suffixCandidates("https://x.test/a.html")).toEqual(["https://x.test/a.md"]);
  expect(suffixCandidates("https://x.test/a.md")).toEqual([]);
});

test("a page with no http address skips straight to generation", async () => {
  // about:blank used to throw out of suffixCandidates, so the pane showed an
  // error instead of the page's own content
  const { f, seen } = origin({});
  const c = await resolveMachineCopy("about:blank", { fetch: f, facts: { alternates: ["/twin.md"], inPage: null }, generate: () => "gen" });
  expect(c.step).toBe("generated");
  expect(seen).toEqual([]);
  expect(suffixCandidates("data:text/html,x")).toEqual([]);
});

test("rejectReason names the status before anything else", () => {
  expect(rejectReason(new Response("x", { status: 406 }), "x", PAGE)).toBe("HTTP 406");
});
