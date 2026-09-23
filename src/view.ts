// view.ts: everything the machine view needs and the toggle does not.
//
// Loaded on first use, the way Speakeasy's toggle loads its agent-view chunk
// on click (survey, 2026-09-23). A visitor who never presses Machine never
// pays for the resolver, the generator, or the pane: this module is the bulk
// of the JavaScript, and the toggle that imports it is a few hundred bytes of
// state. <mode-toggle> starts the import on hover or focus, so by the time a
// click lands the code is usually already here.

import { resolveMachineCopy, factsFromDocument, type MachineCopy, type Step } from "./source.ts";
import { generateMarkdown } from "./generate.ts";

export type { MachineCopy };

const STEP_LABEL: Record<Step, string> = {
  "in-page": "the page's own machine region",
  "link-alternate": "declared twin (link rel=alternate)",
  "negotiated": "same URL, Accept: text/markdown",
  "md-suffix": ".md next to the page",
  "generated": "generated here from the live page",
};

/** find (or, last, generate) the copy for the page this runs on */
export function resolve(opts: { exclude?: string[] } = {}): Promise<MachineCopy> {
  return resolveMachineCopy(location.href, {
    facts: factsFromDocument(document),
    generate: () => generateMarkdown(document, { exclude: opts.exclude }),
  });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

export function renderPane(copy: MachineCopy): DocumentFragment {
  const frag = document.createDocumentFragment();
  const well = el("pre", "mv__well");
  well.textContent = copy.text; // text, never HTML: this is somebody's Markdown
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
