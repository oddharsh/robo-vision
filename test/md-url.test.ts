// md-url.test.ts: a URL that is itself a Markdown file is answered by itself.
// Before, only the tab's pane knew this (by running another door and
// relabelling the result): an agent paid 2 requests for a "negotiated" copy,
// and check warned that the file declared no twin.
import { test, expect } from "bun:test";
import { resolveMachineCopy, surveyMachineCopies } from "../src/source.ts";
import { fetchMachineCopy } from "../src/resolve.ts";
import { checkPage } from "../src/check.ts";

const O = "https://example.test";
type Route = { status?: number; type?: string; body: string };
function site(routes: Record<string, Route>) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const accept = new Headers(init?.headers).get("accept") ?? "";
    seen.push(`${/markdown/.test(accept) ? "md" : "html"} ${url.pathname}`);
    const r = routes[url.pathname] ?? { status: 404, type: "text/html", body: "<!doctype html>404" };
    const res = new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html" } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  return { f, seen };
}
const FILE = { "/docs/x.md": { type: "text/markdown", body: "# X\n\nSee [Y](/docs/y).\n" } };

test("the resolver answers a .md URL with the file itself, and asks nothing else", async () => {
  const { f, seen } = site(FILE);
  const c = await resolveMachineCopy(`${O}/docs/x.md`, { fetch: f, facts: { alternates: [], inPage: null }, generate: () => "never" });
  expect(c.step).toBe("md-url");
  expect(c.served).toBe(true);
  expect(seen).toEqual(["md /docs/x.md"]);
  expect((await surveyMachineCopies(`${O}/docs/x.md`, { fetch: f })).map((d) => d.step)).toEqual(["md-url"]);
});

test("a page URL never opens the md-url door", async () => {
  const doors = await surveyMachineCopies(`${O}/docs/x`, { fetch: site({}).f, facts: { alternates: [], inPage: null } });
  expect(doors.map((d) => d.step)).not.toContain("md-url");
});

test("text/plain counts at a .md URL; an app shell there does not", async () => {
  const plain = await resolveMachineCopy(`${O}/a.md`, { fetch: site({ "/a.md": { type: "text/plain", body: "# A" } }).f });
  expect(plain.step).toBe("md-url");
  await expect(resolveMachineCopy(`${O}/a.md`, { fetch: site({ "/a.md": { body: "<!doctype html><div id=app>" } }).f })).rejects.toThrow();
});

test("an agent spends one request on a .md URL", async () => {
  const { f, seen } = site(FILE);
  const r = await fetchMachineCopy(`${O}/docs/x.md`, { fetch: f, memory: null });
  expect(r.copy!.step).toBe("md-url");
  expect(r.status).toBe(200);
  expect(seen).toEqual(["md /docs/x.md"]);
});

test("a .md URL that answers HTML hands the agent that HTML, from the same request", async () => {
  const shell = "<!doctype html><div id=app></div>";
  const { f, seen } = site({ "/x.md": { body: shell } });
  const r = await fetchMachineCopy(`${O}/x.md`, { fetch: f, memory: null });
  expect(r.copy).toBeNull();
  expect(r.html).toBe(shell);
  expect(seen).toEqual(["md /x.md"]);
});

test("a missing .md file gets the same 404 handling as a page", async () => {
  const llms = "- [Install](/docs/install.md)\n";
  const { f } = site({ "/llms.txt": { type: "text/plain", body: llms } });
  const r = await fetchMachineCopy(`${O}/docs/instal.md`, { fetch: f, memory: null });
  expect(r.status).toBe(404);
  expect(r.suggestions![0].url).toBe(`${O}/docs/install`);
});

test("check audits a .md URL as a file: no page rules, no HTML fetch", async () => {
  const { f, seen } = site(FILE);
  const r = await checkPage(`${O}/docs/x.md`, { fetch: f });
  expect(r.kind).toBe("file");
  expect(r.findings).toEqual([]);
  expect(r.served!.step).toBe("md-url");
  expect(seen).toEqual(["md /docs/x.md"]);

  const bad = await checkPage(`${O}/y.md`, { fetch: site({ "/y.md": { type: "text/markdown", body: "<!-- t -->\n<!doctype html>" } }).f });
  expect(bad.findings.map((x) => x.rule).sort()).toEqual(["mislabelled-html", "nothing-served"]);
  const gone = await checkPage(`${O}/z.md`, { fetch: site({}).f });
  expect(gone.findings.map((x) => x.rule)).toEqual(["page-unreachable"]);
});

test("a .md URL that redirects to its page gets that page's doors, from the HTML already in hand", async () => {
  const seen: string[] = [];
  // /docs/x.md redirects to /docs/x, an HTML page that declares its twin
  const routes: Record<string, { type: string; body: string }> = {
    "/docs/x": { type: "text/html", body: '<!doctype html><link rel="alternate" type="text/markdown" href="/raw/x"><p>X</p>' },
    "/raw/x": { type: "text/markdown", body: "# X\n" },
  };
  const f = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    seen.push(url.pathname);
    const at = url.pathname === "/docs/x.md" ? new URL("/docs/x", O) : url;
    const r = routes[at.pathname];
    const res = r ? new Response(r.body, { headers: { "content-type": r.type } }) : new Response("<!doctype html>404", { status: 404, headers: { "content-type": "text/html" } });
    Object.defineProperty(res, "url", { value: at.href });
    return res;
  }) as typeof fetch;
  const r = await fetchMachineCopy(`${O}/docs/x.md`, { fetch: f, memory: null });
  expect(r.url).toBe(`${O}/docs/x`);
  expect(r.copy!.step).toBe("link-alternate");
  expect(r.attempts[0]).toMatchObject({ step: "md-url", verdict: "not-markdown" });
  expect(seen).toEqual(["/docs/x.md", "/raw/x"]); // the page's HTML was not fetched twice
});
