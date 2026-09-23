// mode-toggle.ts: <mode-toggle>, the presenter.
//
// The element renders SEMANTICS and no styles: a radiogroup of two radios, and
// a machine pane it fills on first use. The flavor is a stylesheet keyed on
// its classes and on html[data-robo-vision-mode], so the same element is a floating pill on
// one site and an XP toolbar toggle on another (see xp.css).
//
//   <mode-toggle for="machine-pane"></mode-toggle>
//   <div data-human-only>...the page...</div>
//   <section id="machine-pane" data-machine-view hidden></section>
//
// Light DOM on purpose: the page's own tokens and fonts reach it with no
// ::part plumbing, which is the whole point of letting a site restyle it.

import { resolveMachineCopy, factsFromDocument, type MachineCopy, type Step } from "./source.ts";
import { generateMarkdown } from "./generate.ts";
import { getMode, setMode, initMode, EVENT, type Mode } from "./mode.ts";

const STEP_LABEL: Record<Step, string> = {
  "in-page": "the page's own machine region",
  "link-alternate": "declared twin (link rel=alternate)",
  "negotiated": "same URL, Accept: text/markdown",
  "md-suffix": ".md next to the page",
  "generated": "generated here from the live page",
};

export class ModeToggle extends HTMLElement {
  #copy: Promise<MachineCopy> | null = null;
  #buttons: HTMLButtonElement[] = [];

  connectedCallback() {
    if (this.#buttons.length) return;
    this.setAttribute("role", "radiogroup");
    this.setAttribute("aria-label", this.getAttribute("label") ?? "View mode");
    this.classList.add("mt");
    this.#buttons = (["human", "machine"] as Mode[]).map((mode) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mt__btn";
      b.dataset.mode = mode;
      b.setAttribute("role", "radio");
      b.textContent = mode === "human" ? "Human" : "Machine";
      b.title = mode === "human" ? "The page as designed" : "What an agent reads";
      b.addEventListener("click", () => this.choose(mode));
      return b;
    });
    this.append(...this.#buttons);
    this.addEventListener("keydown", (e) => {
      // radiogroup keyboard contract: arrows move AND select, one tab stop
      if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      e.preventDefault();
      const next: Mode = getMode() === "human" ? "machine" : "human";
      this.choose(next).then(() => this.#buttons.find((b) => b.dataset.mode === next)?.focus());
    });
    document.addEventListener(EVENT, () => this.#sync());
    const m = initMode();
    this.#sync();
    if (m === "machine") this.#fill();
  }

  get pane(): HTMLElement | null {
    const id = this.getAttribute("for");
    return id ? document.getElementById(id) : document.querySelector("[data-machine-view]");
  }

  async choose(mode: Mode) {
    // resolve BEFORE flipping: generation reads computed style, and once the
    // human region is display:none there is nothing visible left to read
    if (mode === "machine") await this.#ensureCopy();
    setMode(mode);
    if (mode === "machine") await this.#fill();
  }

  #ensureCopy(): Promise<MachineCopy> {
    this.#copy ??= resolveMachineCopy(location.href, {
      facts: factsFromDocument(document),
      generate: () => generateMarkdown(document, { exclude: this.getAttribute("exclude")?.split(",") }),
    });
    return this.#copy;
  }

  async #fill() {
    const pane = this.pane;
    if (!pane || pane.dataset.filled) return;
    this.#show(pane, true);
    pane.setAttribute("aria-busy", "true");
    pane.replaceChildren(Object.assign(document.createElement("p"), { className: "mv__loading", textContent: "Reading the machine copy…" }));
    let copy: MachineCopy;
    try {
      copy = await this.#ensureCopy();
    } catch (e) {
      pane.replaceChildren(Object.assign(document.createElement("p"), { className: "mv__error", textContent: `No machine copy: ${(e as Error).message}` }));
      pane.removeAttribute("aria-busy");
      return;
    }
    pane.dataset.filled = copy.step;
    pane.removeAttribute("aria-busy");
    pane.replaceChildren(renderPane(copy));
  }

  #sync() {
    const mode = getMode();
    for (const b of this.#buttons) {
      const on = b.dataset.mode === mode;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    }
    const pane = this.pane;
    if (pane) this.#show(pane, mode === "machine");
  }

  // A pane marked popover="manual" lives in the browser's TOP LAYER, which no
  // z-index on the page can reach. The dry run is why: on allbirds.com an
  // Attentive signup iframe sat over a z-index 2147483646 overlay, and a bigger
  // number was never going to be the answer.
  #show(pane: HTMLElement, on: boolean) {
    pane.hidden = !on;
    if (!pane.hasAttribute("popover") || !("showPopover" in pane)) return;
    const open = pane.matches(":popover-open");
    if (on && !open) {
      pane.showPopover();
      this.#raiseDock();
    } else if (!on && open) pane.hidePopover();
  }

  // top-layer order is show order, so a dock shown before the pane ends up
  // UNDER it; re-showing puts it back on top without losing focus
  #raiseDock() {
    const dock = this.closest<HTMLElement>("[popover]");
    if (!dock?.matches(":popover-open")) return;
    const focused = document.activeElement;
    dock.hidePopover();
    dock.showPopover();
    if (focused instanceof HTMLElement && dock.contains(focused)) focused.focus();
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderPane(copy: MachineCopy): DocumentFragment {
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
    li.append(el("b", "", a.step), document.createTextNode(` ${a.url ? new URL(a.url).pathname : ""} `), el("span", "", a.reason + (a.ms != null ? `, ${a.ms} ms` : "")));
    ol.append(li);
  }
  how.append(ol);

  frag.append(well, bar, how);
  return frag;
}

customElements.define("mode-toggle", ModeToggle);
