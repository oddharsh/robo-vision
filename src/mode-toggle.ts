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
//
// This file is the part every visitor loads: state, keyboard, top layer. The
// resolver, the generator and the pane live in view.ts and arrive through
// `loadView` on first use; the imports below from it are types only, which the
// bundler erases.

import type { MachineCopy } from "./view.ts";
import { getMode, setMode, initMode, EVENT, type Mode } from "./mode.ts";

export type ViewModule = typeof import("./view.ts");

export class ModeToggle extends HTMLElement {
  /** how the view code arrives; drop-in mode swaps in a loader that also
   *  brings the pane's skin */
  loadView: () => Promise<ViewModule> = () => import("./view.ts");

  #view: Promise<ViewModule> | null = null;
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
    // intent to use: start fetching the code, never the copy (the copy costs
    // the site requests, and a hover is not a click)
    const prefetch = () => void this.#loadView().catch(() => {});
    this.addEventListener("pointerenter", prefetch, { once: true });
    this.addEventListener("focusin", prefetch, { once: true });
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
    if (mode === "machine") await this.#ensureCopy().catch(() => {});
    setMode(mode);
    if (mode === "machine") await this.#fill();
  }

  #loadView(): Promise<ViewModule> {
    // a failed load is not cached, so a flaky network gets another try
    this.#view ??= this.loadView().catch((e) => { this.#view = null; throw e; });
    return this.#view;
  }

  #ensureCopy(): Promise<MachineCopy> {
    this.#copy ??= this.#loadView().then((v) => v.resolve({ exclude: this.getAttribute("exclude")?.split(",") }));
    return this.#copy;
  }

  async #fill() {
    const pane = this.pane;
    if (!pane || pane.dataset.filled) return;
    this.#show(pane, true);
    pane.setAttribute("aria-busy", "true");
    pane.replaceChildren(Object.assign(document.createElement("p"), { className: "mv__loading", textContent: "Reading the machine copy…" }));
    try {
      const [view, copy] = await Promise.all([this.#loadView(), this.#ensureCopy()]);
      pane.dataset.filled = copy.step;
      pane.replaceChildren(view.renderPane(copy));
    } catch (e) {
      // one failed attempt per click: choose() and this share the promise, and
      // clearing it here lets the NEXT click try again
      this.#copy = null;
      pane.replaceChildren(Object.assign(document.createElement("p"), { className: "mv__error", textContent: `No machine copy: ${(e as Error).message}` }));
    } finally {
      pane.removeAttribute("aria-busy");
    }
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

customElements.define("mode-toggle", ModeToggle);
