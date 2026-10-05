// copies.test.ts: the tab's copy fetching, with fetch and sessionStorage
// faked. What used to need Chrome to observe (which requests a link costs)
// is a property of copies.ts and the origin memory, not of the browser.
import { test, expect, beforeEach } from "bun:test";

const store = new Map<string, string>();
Object.assign(globalThis, {
  sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
});

const O = "https://robo.test";
type Route = { status?: number; type?: string; body?: string };
let routes: Record<string, Route> = {};
const log: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  log.push(`${method === "HEAD" ? "head" : "fetch"} ${url.pathname}`);
  const r = routes[`${method} ${url.pathname}`] ?? routes[url.pathname] ?? { status: 404, type: "text/html", body: "<!doctype html>404" };
  const res = new Response(method === "HEAD" ? null : r.body ?? "", { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html", vary: "Accept" } });
  Object.defineProperty(res, "url", { value: url.href });
  return res;
}) as typeof fetch;

// each test gets fresh module state (the copy cache lives in the module)
let n = 0;
const fresh = () => import(`../src/copies.ts?${++n}`) as Promise<typeof import("../src/copies.ts")>;
const PAGE = { type: "text/html", body: "<!doctype html><p>page</p>" };
beforeEach(() => { store.clear(); log.length = 0; routes = {}; });

test("after one .md hit, the next page is asked for its .md first", async () => {
  routes = { "/b": PAGE, "/b.md": { type: "text/markdown", body: "# B" }, "/d.md": { type: "text/markdown", body: "# D" } };
  const c = await fresh();
  await c.copyFor(`${O}/b`);
  expect(log).toEqual(["fetch /b", "fetch /b.md"]);
  log.length = 0;
  expect((await c.copyFor(`${O}/d`))!.text).toBe("# D");
  expect(log).toEqual(["fetch /d.md"]);
});

test("a section that served nothing is not asked again; another section still is", async () => {
  routes = { "/n/a": PAGE, "/n/b": PAGE, "/b": PAGE, "/b.md": { type: "text/markdown", body: "# B" } };
  const c = await fresh();
  expect(await c.copyFor(`${O}/n/a`)).toBeNull();
  log.length = 0;
  expect(await c.copyFor(`${O}/n/b`)).toBeNull();
  expect(log).toEqual([]);
  expect((await c.copyFor(`${O}/b`))!.text).toBe("# B");
});

test("a .md link is read as itself and leaves the origin's memory alone", async () => {
  routes = { "/m/x.md": { type: "text/markdown", body: "# X" }, "/d": PAGE, "/d.md": { type: "text/markdown", body: "# D" } };
  const c = await fresh();
  const x = await c.copyFor(`${O}/m/x.md`);
  expect(x!.step).toBe("md-link");
  log.length = 0;
  await c.copyFor(`${O}/d`);
  expect(log).toEqual(["fetch /d", "fetch /d.md"]); // negotiated first: nothing was learned
});

test("the page behind a .md: HTML at the stripped URL, nothing for a 404, GET when HEAD is refused", async () => {
  routes = { "/m/mirror": PAGE, "HEAD /m/picky": { status: 405 }, "/m/picky": PAGE };
  const c = await fresh();
  expect(await c.humanPageFor(`${O}/m/mirror.md`)).toBe(`${O}/m/mirror`);
  expect(await c.humanPageFor(`${O}/m/only.md`)).toBeNull();
  expect(await c.humanPageFor(`${O}/m/picky.md`)).toBe(`${O}/m/picky`);
  expect(log).toEqual(["head /m/mirror", "head /m/only", "head /m/picky", "fetch /m/picky"]);
});
