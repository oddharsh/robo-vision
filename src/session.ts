// session.ts: which page the machine pane is on, and how it got there.
//
// Machine mode lives in the address as ?robo-vision=machine, so a reload, the
// back button or a pasted link keeps it. A same-origin link in the pane does
// not load that page: its copy is fetched, drawn, and the address moves with
// pushState. Only a page that serves no copy is loaded for real, still
// carrying the param, and generates from its own DOM.
//
// That makes the address bar and the loaded document two different things,
// and every rule below is about keeping them straight:
//
//   - the DOCUMENT is the page the browser loaded. Its copy is the only one
//     generated from a live DOM; Human on it needs no load.
//   - the ADDRESS is whatever the pane last showed. Human on any other address
//     is a real load of that page.
//   - a .md address mirrors a page when one stands behind it (/x.md and /x),
//     and then the PAGE goes in the address bar, so a reload or Human lands on
//     HTML. A Markdown-only file keeps its own address, and Human returns to
//     the last real page instead of loading raw text.
//
// The browser is reached only through three adapters (history, copies, mode),
// so these rules run in `bun test` with a recorder standing in for each. The
// toggle passes the real ones and draws whatever show() is handed.

import type { MachineCopy } from "./source.ts";
import { PARAM, keyOf, withParam, isMarkdownUrl } from "./params.ts";

export type Mode = "human" | "machine";

/** the address bar and the document. The real one wraps history and location */
export interface PaneHistory {
  /** the address now, absolute */
  current(): string;
  push(url: string): void;
  replace(url: string): void;
  /** load a page for real, in place of this entry */
  load(url: string): void;
}

/** copies.ts, as the session needs it. Loaded on first use, with the view */
export interface PaneCopies {
  /** the loaded document's copy: its declarations, else generated from its DOM */
  forDocument(): Promise<MachineCopy>;
  /** any other page's, fetched without loading it; null if it serves none */
  forUrl(url: string): Promise<MachineCopy | null>;
  /** the HTML page a .md URL mirrors, verified to exist; null if none */
  pageBehind(mdUrl: string): Promise<string | null>;
}

export interface ModeState {
  get(): Mode;
  set(mode: Mode): void;
}

export type Shown =
  | { kind: "loading"; url: string }
  | { kind: "copy"; url: string; copy: MachineCopy }
  | { kind: "error"; url: string; message: string };

export interface SessionOptions {
  history: PaneHistory;
  copies: () => Promise<PaneCopies>;
  mode: ModeState;
  show: (s: Shown) => void;
}

export interface PaneSession {
  /** the visit began: apply a machine mode the URL or storage asked for */
  start(): Promise<void>;
  /** a Human or Machine press */
  choose(mode: Mode): Promise<void>;
  /** a same-origin link in the pane was followed */
  open(url: string): Promise<void>;
  /** back or forward moved the address */
  popstate(): Promise<void>;
  /** a link in the pane was hovered or focused: fetch ahead, render nothing */
  prefetch(url: string): void;
}

export function paneSession({ history, copies, mode, show }: SessionOptions): PaneSession {
  /** the page the browser actually loaded; pushState moves the address, not this */
  const document = keyOf(history.current());
  /** the most recent address that is a real page, for Human to return to from
   *  a Markdown-only file */
  let lastPage = document;
  /** the render in flight, so a slow page cannot land over a newer one */
  let showing = "";
  /** what the pane holds now */
  let shown = "";
  /** page -> the .md it was reached through; that copy is the one to show */
  const via = new Map<string, string>();

  const here = () => keyOf(history.current());
  const address = (m: Mode) => {
    const next = withParam(history.current(), m);
    if (next !== history.current()) history.replace(next);
  };

  async function present(url: string) {
    const key = keyOf(url);
    if (shown === key) return;
    showing = key;
    show({ kind: "loading", url: key });
    try {
      const c = await copies();
      const copy = key === document ? await c.forDocument() : await c.forUrl(via.get(key) ?? key);
      if (showing !== key) return; // superseded by a newer navigation
      if (!copy) {
        // serves nothing we can fetch: load it for real, still in machine
        // mode, and let that page generate from its own DOM
        history.load(withParam(key, "machine"));
        return;
      }
      shown = key;
      show({ kind: "copy", url: key, copy });
    } catch (e) {
      if (showing !== key) return;
      shown = "";
      show({ kind: "error", url: key, message: (e as Error).message });
    }
  }

  return {
    async start() {
      if (mode.get() !== "machine") return;
      address("machine");
      await present(here());
    },

    async choose(m) {
      if (m === "human" && here() !== document) {
        // a Markdown-only file has no human page: go back to the last real one
        const target = isMarkdownUrl(here()) ? lastPage : here();
        mode.set("human");
        // the page still loaded under the pane needs no load
        if (target === document) history.replace(withParam(target, "human"));
        else history.load(withParam(target, "human"));
        return;
      }
      // resolve BEFORE flipping: generation reads computed style, and once the
      // human region is display:none there is nothing visible left to read
      if (m === "machine") await copies().then((c) => c.forDocument()).catch(() => {});
      mode.set(m);
      address(m);
      if (m === "machine") await present(here());
    },

    async open(url) {
      let target = keyOf(url);
      if (isMarkdownUrl(target)) {
        // fetch the file and, alongside, ask whether the page it mirrors
        // exists. Only a verified page goes in the address bar
        const c = await copies();
        const [page] = await Promise.all([c.pageBehind(target), c.forUrl(target)]);
        if (page) {
          via.set(page, target);
          target = page;
        }
      }
      if (!isMarkdownUrl(target)) lastPage = target;
      history.push(withParam(target, "machine"));
      await present(target);
    },

    async popstate() {
      const url = new URL(history.current());
      const key = keyOf(url.href);
      if (!isMarkdownUrl(key)) lastPage = key;
      if (url.searchParams.get(PARAM) === "machine") {
        if (mode.get() !== "machine") mode.set("machine");
        await present(key);
      } else if (key === document) {
        if (mode.get() !== "human") mode.set("human");
      } else {
        // a human address the pane only visited: its page needs a real load
        history.load(url.href);
      }
    },

    prefetch(url) {
      const key = keyOf(url);
      void copies().then((c) => {
        void c.forUrl(key).catch(() => {});
        // a .md link also has its page verified early, so the click can go
        // straight to the right address
        if (isMarkdownUrl(key)) void c.pageBehind(key).catch(() => {});
      }, () => {});
    },
  };
}
