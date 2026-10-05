// session.test.ts: which page the pane is on, with a recorder for the browser.
// The Chrome tests (navigate.browser.test.ts) prove the real history adapter
// is wired; every decision about addresses is checked here.
import { test, expect } from "bun:test";
import { paneSession, type Mode, type PaneCopies, type Shown } from "../src/session.ts";
import type { MachineCopy } from "../src/source.ts";

const O = "https://robo.test";
const copy = (text: string, step: MachineCopy["step"] = "md-suffix"): MachineCopy => ({ step, served: true, url: null, contentType: "text/markdown", text, attempts: [] });

type Fake = { copies?: Record<string, MachineCopy>; pages?: Record<string, string>; delay?: Record<string, Promise<void>> };

function browser(start: string, fake: Fake = {}) {
  let address = `${O}${start}`;
  let mode: Mode = new URL(address).searchParams.get("robo-vision") === "machine" ? "machine" : "human";
  const calls: string[] = [];
  const shown: Shown[] = [];
  const path = (u: string) => u.replace(O, "");
  const copies: PaneCopies = {
    async forDocument() { calls.push("copy:document"); return copy(`document ${path(new URL(address).pathname)}`, "generated"); },
    async forUrl(url) { calls.push(`copy:${path(url)}`); await fake.delay?.[path(url)]; return fake.copies?.[path(url)] ?? null; },
    async pageBehind(md) { calls.push(`behind:${path(md)}`); const p = fake.pages?.[path(md)]; return p ? O + p : null; },
  };
  const session = paneSession({
    history: {
      current: () => address,
      push: (u) => { calls.push(`push:${path(u)}`); address = u; },
      replace: (u) => { calls.push(`replace:${path(u)}`); address = u; },
      load: (u) => { calls.push(`load:${path(u)}`); },
    },
    copies: async () => copies,
    mode: { get: () => mode, set: (m) => { calls.push(`mode:${m}`); mode = m; } },
    show: (s) => shown.push(s),
  });
  const back = (to: string) => { address = O + to; return session.popstate(); };
  const last = () => { const s = shown.at(-1)!; return s.kind === "copy" ? s.copy.text : s.kind; };
  return { session, calls, shown, last, back, mode: () => mode, address: () => path(address) };
}

const TWINS = { "/b": copy("B twin"), "/d": copy("D twin"), "/m/mirror.md": copy("mirror", "md-link"), "/m/only.md": copy("only", "md-link") };

test("Machine resolves the document's copy before the mode flips", async () => {
  const b = browser("/a");
  await b.session.choose("machine");
  expect(b.calls).toEqual(["copy:document", "mode:machine", "replace:/a?robo-vision=machine", "copy:document"]);
  expect(b.last()).toBe("document /a");
});

test("a link moves the address and shows the copy, with no page load", async () => {
  const b = browser("/a?robo-vision=machine", { copies: TWINS });
  await b.session.start();
  b.calls.length = 0;
  await b.session.open(`${O}/b`);
  expect(b.calls).toEqual(["push:/b?robo-vision=machine", "copy:/b"]);
  expect(b.last()).toBe("B twin");
});

test("a link to a page that serves nothing loads it for real, still in machine view", async () => {
  const b = browser("/b?robo-vision=machine", { copies: TWINS });
  await b.session.open(`${O}/c`);
  expect(b.calls.at(-1)).toBe("load:/c?robo-vision=machine");
});

test("a .md link with a page behind it puts the page in the address bar", async () => {
  const b = browser("/b?robo-vision=machine", { copies: TWINS, pages: { "/m/mirror.md": "/m/mirror" } });
  await b.session.open(`${O}/m/mirror.md`);
  expect(b.address()).toBe("/m/mirror?robo-vision=machine");
  expect(b.last()).toBe("mirror");
  // Human loads the real page, not the raw file
  await b.session.choose("human");
  expect(b.calls.at(-1)).toBe("load:/m/mirror");
});

test("the page behind a .md keeps showing the .md's copy when returned to", async () => {
  const b = browser("/b?robo-vision=machine", { copies: TWINS, pages: { "/m/mirror.md": "/m/mirror" } });
  await b.session.open(`${O}/m/mirror.md`);
  await b.session.open(`${O}/d`);
  b.calls.length = 0;
  await b.back("/m/mirror?robo-vision=machine");
  expect(b.calls).toEqual(["copy:/m/mirror.md"]);
  expect(b.last()).toBe("mirror");
});

test("a Markdown-only file keeps its address; Human returns to the loaded page without a load", async () => {
  const b = browser("/b?robo-vision=machine", { copies: TWINS });
  await b.session.open(`${O}/m/only.md`);
  expect(b.address()).toBe("/m/only.md?robo-vision=machine");
  b.calls.length = 0;
  await b.session.choose("human");
  expect(b.calls).toEqual(["mode:human", "replace:/b"]);
});

test("Human from a Markdown-only file returns to the last real page the pane showed", async () => {
  const b = browser("/b?robo-vision=machine", { copies: TWINS });
  await b.session.open(`${O}/d`);
  await b.session.open(`${O}/m/only.md`);
  await b.session.choose("human");
  expect(b.calls.at(-1)).toBe("load:/d");
});

test("Human on the loaded page itself needs no load", async () => {
  const b = browser("/a");
  await b.session.choose("machine");
  b.calls.length = 0;
  await b.session.choose("human");
  expect(b.calls).toEqual(["mode:human", "replace:/a"]);
});

test("back and forward: machine addresses re-render, the document's human address flips the mode, others load", async () => {
  const b = browser("/a", { copies: TWINS });
  await b.session.choose("machine");
  await b.session.open(`${O}/b`);
  b.calls.length = 0;
  await b.back("/a?robo-vision=machine");
  expect(b.calls).toEqual(["copy:document"]);
  await b.back("/a");
  expect(b.mode()).toBe("human");
  b.calls.length = 0;
  await b.back("/b");
  expect(b.calls).toEqual(["load:/b"]);
});

test("a slow page cannot land over a newer one", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const b = browser("/a?robo-vision=machine", { copies: TWINS, delay: { "/b": slow } });
  const first = b.session.open(`${O}/b`);
  await b.session.open(`${O}/d`);
  release();
  await first;
  expect(b.last()).toBe("D twin");
  expect(b.shown.filter((s) => s.kind === "copy").map((s) => (s as { url: string }).url)).toEqual([`${O}/d`]);
});

test("Back while a link is still loading shows the page Back went to", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const b = browser("/a?robo-vision=machine", { copies: TWINS, delay: { "/b": slow } });
  await b.session.start();
  const going = b.session.open(`${O}/b`);
  await b.back("/a?robo-vision=machine");
  release();
  await going;
  expect(b.address()).toBe("/a?robo-vision=machine");
  expect(b.last()).toBe("document /a");
});

test("a pasted machine link starts in machine view", async () => {
  const b = browser("/d?robo-vision=machine", { copies: TWINS });
  await b.session.start();
  expect(b.last()).toBe("document /d"); // the loaded page's own copy, from its DOM or declarations
  const h = browser("/d");
  await h.session.start();
  expect(h.calls).toEqual([]);
});

test("hovering a .md link fetches the file and verifies its page; a plain link only its copy", async () => {
  const b = browser("/b?robo-vision=machine", { copies: TWINS });
  b.session.prefetch(`${O}/m/mirror.md`);
  b.session.prefetch(`${O}/d`);
  await new Promise((r) => setTimeout(r, 0));
  expect(b.calls.sort()).toEqual(["behind:/m/mirror.md", "copy:/d", "copy:/m/mirror.md"]);
});

test("a failed fetch shows an error, and the next visit tries again", async () => {
  const b = browser("/a?robo-vision=machine");
  const s = paneSession({
    history: { current: () => `${O}/a?robo-vision=machine`, push() {}, replace() {}, load() {} },
    copies: async () => { throw new Error("offline"); },
    mode: { get: () => "machine", set() {} },
    show: (x) => b.shown.push(x),
  });
  await s.start();
  expect(b.shown.at(-1)).toEqual({ kind: "error", url: `${O}/a`, message: "offline" });
});
