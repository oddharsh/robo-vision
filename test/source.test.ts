import { test, expect } from "bun:test";
import { resolveMachineCopy, rejectReason, suffixCandidates } from "../src/source.ts";

type Route = { status?: number; type?: string; body: string };
// a fake origin: routes keyed "<accept-kind> <path>", where accept-kind is md
// when the request asked for Markdown and html otherwise
function origin(routes: Record<string, Route>) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const accept = new Headers(init?.headers).get("accept") ?? "";
    const key = `${/markdown/.test(accept) ? "md" : "html"} ${url.pathname}`;
    seen.push(key);
    const r = routes[key] ?? routes[`* ${url.pathname}`] ?? { status: 404, type: "text/html", body: "<!doctype html>nope" };
    const res = new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html" } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  return { f, seen };
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

test("suffix spellings follow the llms.txt proposal", () => {
  expect(suffixCandidates("https://x.test/")).toEqual(["https://x.test/index.md", "https://x.test/index.html.md"]);
  expect(suffixCandidates("https://x.test/a/b?q=1#h")).toEqual(["https://x.test/a/b.md"]);
  expect(suffixCandidates("https://x.test/a/")).toEqual(["https://x.test/a.md", "https://x.test/a/index.html.md"]);
  expect(suffixCandidates("https://x.test/a.html")).toEqual(["https://x.test/a.md"]);
  expect(suffixCandidates("https://x.test/a.md")).toEqual([]);
});

test("rejectReason names the status before anything else", () => {
  expect(rejectReason(new Response("x", { status: 406 }), "x", PAGE)).toBe("HTTP 406");
});
