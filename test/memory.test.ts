// memory.test.ts: the origin-memory policy, through resolveRemembered().
// Every caller (the tab's loaded page, its linked pages, an agent's fetch)
// goes through this one call, so these are the rules for all three.
import { test, expect } from "bun:test";
import { originMemory, mapStore, resolveRemembered, type OriginMemory } from "../src/memory.ts";

const O = "https://example.test";
type Route = { status?: number; type?: string; body: string };
function site(routes: Record<string, Route>) {
  const seen: string[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const md = /markdown/.test(new Headers(init?.headers).get("accept") ?? "");
    seen.push(`${md ? "md " : ""}${url.pathname}`);
    const r = routes[`${md ? "md " : ""}${url.pathname}`] ?? routes[url.pathname] ?? { status: 404, body: "<!doctype html>404" };
    const res = new Response(r.body, { status: r.status ?? 200, headers: { "content-type": r.type ?? "text/html", vary: "Accept" } });
    Object.defineProperty(res, "url", { value: url.href });
    return res;
  }) as typeof fetch;
  return { f, seen };
}
const HTML = { body: "<!doctype html><p>page</p>" };
const MD = (t: string) => ({ type: "text/markdown", body: `# ${t}\n` });
const none = { alternates: [], inPage: null };

test("the guessed doors are asked in the order that worked last, in the caller's slots", async () => {
  const { f, seen } = site({ "/a.md": MD("A"), "/b.md": MD("B"), "/b": HTML });
  const memory = originMemory();
  await resolveRemembered(`${O}/a`, memory, { fetch: f, facts: none });
  seen.length = 0;
  const c = await resolveRemembered(`${O}/b`, memory, { fetch: f, facts: none, generate: () => "generated" });
  expect(c.step).toBe("md-suffix");
  expect(seen).toEqual(["md /b.md"]); // negotiation not asked: .md answered first
  expect(c.attempts.map((a) => a.step)).toEqual(["in-page", "link-alternate", "md-suffix"]);
});

test("a quiet section skips the guessed doors with a reason, and asks nothing", async () => {
  const { f, seen } = site({});
  const memory = originMemory();
  memory.noteNothing(`${O}/blog/a`, true);
  const c = await resolveRemembered(`${O}/blog/b`, memory, { fetch: f, facts: none, generate: () => "generated" });
  expect(seen).toEqual([]);
  expect(c.step).toBe("generated");
  expect(c.attempts.find((a) => a.step === "negotiated")!.reason).toBe("not asked: /blog served no Markdown on an earlier page");
});

test("a declared twin clears a quiet mark", async () => {
  const { f } = site({ "/docs/b.md": MD("B") });
  const memory = originMemory();
  memory.noteNothing(`${O}/docs/a`, true);
  const c = await resolveRemembered(`${O}/docs/b`, memory, { fetch: f, facts: { alternates: ["/docs/b.md"], inPage: null } });
  expect(c.step).toBe("link-alternate");
  expect(memory.servesNothing(`${O}/docs/c`)).toBe(false);
});

test("asking and missing marks the section; generating after a skip, or stopping in-page, does not", async () => {
  const { f } = site({ "/n/a": HTML });
  const asked = originMemory();
  await resolveRemembered(`${O}/n/a`, asked, { fetch: f, facts: none, generate: () => "generated" });
  expect(asked.servesNothing(`${O}/n/z`)).toBe(true);

  const inPage = originMemory();
  await resolveRemembered(`${O}/n/a`, inPage, { fetch: f, facts: { alternates: [], inPage: "hand written" }, generate: () => "g" });
  expect(inPage.servesNothing(`${O}/n/z`)).toBe(false);
});

test("a lookup that finds nothing marks the section only if the guessed doors were asked", async () => {
  const { f } = site({});
  const memory: OriginMemory = originMemory();
  await expect(resolveRemembered(`${O}/x/a`, memory, { fetch: f, order: ["link-alternate"] })).rejects.toThrow();
  expect(memory.servesNothing(`${O}/x/b`)).toBe(false);
  await expect(resolveRemembered(`${O}/x/a`, memory, { fetch: f, order: ["negotiated", "md-suffix"] })).rejects.toThrow();
  expect(memory.servesNothing(`${O}/x/b`)).toBe(true);
});

test("a null memory resolves plainly", async () => {
  const { f, seen } = site({ "md /a": MD("A") });
  const c = await resolveRemembered(`${O}/a`, null, { fetch: f, facts: none });
  expect(c.step).toBe("negotiated");
  expect(seen).toEqual(["md /a"]);
});

test("a guessed door that never answered marks nothing: a 503 or a dropped connection says nothing about the section", async () => {
  const down = site({ "md /docs/a": { status: 503, body: "busy" }, "/docs/a.md": { status: 503, body: "busy" } });
  const memory = originMemory();
  await expect(resolveRemembered(`${O}/docs/a`, memory, { fetch: down.f, order: ["negotiated", "md-suffix"] })).rejects.toThrow();
  expect(memory.servesNothing(`${O}/docs/b`)).toBe(false);

  const reset = (async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;
  await expect(resolveRemembered(`${O}/docs/a`, memory, { fetch: reset, order: ["negotiated", "md-suffix"] })).rejects.toThrow();
  expect(memory.servesNothing(`${O}/docs/b`)).toBe(false);
});

// ---- bounds: a long-lived agent visits origins without end ------------------

test("a map store drops its oldest entry past the cap, and a read keeps an entry fresh", () => {
  const s = mapStore({ entries: 2 });
  s.set("a", "1");
  s.set("b", "2");
  s.get("a"); // read: now the newest
  s.set("c", "3");
  expect([s.get("a"), s.get("b"), s.get("c")]).toEqual(["1", null, "3"]);
});

test("a map store holds to its size budget, and refuses a value bigger than all of it", () => {
  const s = mapStore({ chars: 10 });
  s.set("a", "1234");
  s.set("b", "5678");
  expect(s.get("a")).toBe("1234"); // 10 chars, keys included: at the budget
  s.set("c", "9");
  expect(s.get("b")).toBeNull(); // b was oldest once a was read
  s.set("d", "x".repeat(20));
  expect(s.get("d")).toBeNull();
  expect(s.get("c")).toBe("9");
});

test("an expired fact is deleted when read, not kept until overwritten", () => {
  let t = 0;
  const store = mapStore();
  const memory = originMemory(store, { ttl: 1000, now: () => t });
  memory.noteNothing(`${O}/blog/a`, true);
  const key = `robo-vision:${O}:none:blog`;
  expect(store.get(key)).not.toBeNull();
  t = 1001;
  expect(memory.servesNothing(`${O}/blog/z`)).toBe(false);
  expect(store.get(key)).toBeNull();
});

test("a scoped memory shares a store without sharing facts", () => {
  const store = mapStore();
  const a = originMemory(store, { scope: "tenant-a" });
  const b = originMemory(store, { scope: "tenant-b" });
  a.noteNothing(`${O}/blog/a`, true);
  a.setPages(O, "seen", [{ url: `${O}/private/plan` }]);
  expect(b.servesNothing(`${O}/blog/z`)).toBe(false);
  expect(b.pages(O, "seen")).toBeNull();
  expect(originMemory(store, { scope: "tenant-a" }).pages(O, "seen")).toEqual([{ url: `${O}/private/plan` }]);
});
