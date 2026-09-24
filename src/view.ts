// view.ts: everything the machine view needs and the toggle does not.
//
// Loaded on first use, the way Speakeasy's toggle loads its agent-view chunk
// on click (survey, 2026-09-23). A visitor who never presses Machine never
// pays for the resolver, the generator, or the pane: this module is the bulk
// of the JavaScript, and the toggle that imports it is a few hundred bytes of
// state. <mode-toggle> starts the import on hover or focus, so by the time a
// click lands the code is usually already here.
//
// Fetching and rendering stay apart. copies.ts gets a copy for a URL and never
// touches the DOM; renderPane() draws one and never fetches. The only place
// they meet is a link in the pane: hovering fetches that page's copy, clicking
// hands the URL back to the toggle, which decides how to show it.

import type { MachineCopy, Step } from "./source.ts";

export { copyFor, copyForThisPage, humanPageFor, alias, type MachineCopy } from "./copies.ts";
import { copyFor, humanPageFor } from "./copies.ts";

const STEP_LABEL: Record<Step, string> = {
  "in-page": "the page's own machine region",
  "link-alternate": "declared twin (link rel=alternate)",
  "negotiated": "same URL, Accept: text/markdown",
  "md-suffix": ".md next to the page",
  "generated": "generated here from the live page",
  "md-link": "a .md file, linked from the last copy",
};

export interface RenderOptions {
  /** the page this copy describes; relative links resolve against it */
  page: string;
  /** a same-origin link was followed inside the pane */
  navigate?: (url: string) => void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// Markdown link targets and bare URLs become anchors; every other character
// stays the text it was, so the well's textContent is still exactly the copy
const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)|\bhttps?:\/\/[^\s<>()[\]"'`]+/g;

function linkify(text: string, opts: RenderOptions): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const target = m[1] ?? m[0].replace(/[.,;:!?]+$/, "");
    if (target.startsWith("#")) continue; // an anchor on a page the pane is not showing
    let url: URL;
    try { url = new URL(target, opts.page); } catch { continue; }
    if (!/^https?:$/.test(url.protocol)) continue;
    const at = m.index! + m[0].indexOf(target);
    frag.append(text.slice(last, at));
    const a = el("a", "mv__link", target);
    a.href = url.href;
    if (url.origin === location.origin && opts.navigate) wireSameOrigin(a, url.href, opts.navigate);
    frag.append(a);
    last = at + target.length;
  }
  frag.append(text.slice(last));
  return frag;
}

function wireSameOrigin(a: HTMLAnchorElement, url: string, navigate: (url: string) => void) {
  // intent fetches; only a click renders. A short dwell keeps a pointer that
  // merely crosses the link from costing the site a request.
  let timer = 0;
  // a .md link also has its page verified early, so the click can go straight
  // to the right address
  const fetchAhead = () => { void copyFor(url); if (new URL(url).pathname.endsWith(".md")) void humanPageFor(url); };
  a.addEventListener("pointerenter", () => { timer = window.setTimeout(fetchAhead, 80); });
  a.addEventListener("pointerleave", () => clearTimeout(timer));
  a.addEventListener("focus", fetchAhead);
  a.addEventListener("click", (e) => {
    // a modified click means a new tab or window: the browser's job, not ours
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(url);
  });
}

export function renderPane(copy: MachineCopy, opts: RenderOptions): DocumentFragment {
  const frag = document.createDocumentFragment();
  const well = el("pre", "mv__well");
  well.append(linkify(copy.text, opts)); // text nodes and anchors, never parsed HTML
  well.tabIndex = 0; // a scrollable region has to be reachable by keyboard
  well.setAttribute("aria-label", "Machine copy");

  const bar = el("div", "mv__status");
  bar.append(
    el("span", "mv__cell mv__cell--grow", STEP_LABEL[copy.step]),
    el("span", `mv__cell mv__cell--${copy.served ? "served" : "local"}`,
      copy.served ? "served to agents" : copy.step === "in-page" ? "on the page, not negotiated" : "not what agents receive"),
    el("span", "mv__cell mv__cell--mono", `${copy.text.length.toLocaleString()} chars`),
  );

  const how = el("details", "mv__how");
  how.append(el("summary", "", "How it was found"));
  const ol = el("ol", "mv__attempts");
  for (const a of copy.attempts) {
    const li = el("li", a.hit ? "is-hit" : "is-miss");
    li.append(el("b", "", a.step), document.createTextNode(` ${a.url ? new URL(a.url).pathname : ""} `), el("span", "", a.reason + (a.note ? ` (${a.note})` : "") + (a.ms != null ? `, ${a.ms} ms` : "")));
    ol.append(li);
  }
  how.append(ol);

  frag.append(well, bar, how);
  return frag;
}
