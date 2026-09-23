// mode-toggle.ts: <mode-toggle>, the presenter.
//
// The element renders SEMANTICS and no styles: a radiogroup of two radios, and
// a machine pane it fills on first use. Its look is base.css plus whatever the
// host site writes for its classes and html[data-robo-vision-mode], so the same
// element can be a floating pill on one site and a toolbar control on another.
//
//   <mode-toggle for="machine-pane" human-label="Human" machine-label="Agent"></mode-toggle>
//   <div data-human-only>...the page...</div>
//   <section id="machine-pane" data-machine-view hidden></section>
//
// Light DOM on purpose: the page's own tokens and fonts reach it with no
// ::part plumbing, which is the whole point of letting a site restyle it.
//
// This file is the part every visitor loads: state, keyboard, history, top
// layer. The resolver, the generator and the pane live in view.ts and arrive
// through `loadView` on first use; the imports below from it are types only,
// which the bundler erases.
//
// STAYING IN MACHINE VIEW. While machine mode is on, the address carries
// ?robo-vision=machine, the way Parallel's machine view lives under /ai/, so a
// reload, the back button or a pasted link keeps it. A same-origin link in the
// pane does not load that page: its copy is fetched (copies.ts), drawn in the
// pane, and the address moves with pushState. Only a page that serves no copy
// is loaded for real, still carrying the param, and generates from its DOM.

import type { MachineCopy } from "./view.ts";
import { getMode, setMode, initMode, pageKey, withMode, EVENT, PARAM, type Mode } from "./mode.ts";

export type ViewModule = typeof import("./view.ts");

export class ModeToggle extends HTMLElement {
  /** how the view code arrives; drop-in mode swaps in a loader that also
   *  brings the pane's skin */
  loadView: () => Promise<ViewModule> = () => import("./view.ts");

  #view: Promise<ViewModule> | null = null;
  #buttons: HTMLButtonElement[] = [];
  /** the page the browser actually loaded; pushState moves the address, not this */
  #document = pageKey(location.href);
  /** the render in flight, so a slow page cannot land over a newer one */
  #showing = "";

  connectedCallback() {
    if (this.#buttons.length) return;
    this.setAttribute("role", "radiogroup");
    this.setAttribute("aria-label", this.getAttribute("label") ?? "View mode");
    this.classList.add("mt");
    this.#buttons = (["human", "machine"] as Mode[]).map((mode) => {
      // no type attribute: these never sit in a form, and Tailwind's preflight
      // (and resets like it) target [type='button'], whose attribute
      // specificity would outrank base.css's one-element rules
      const b = document.createElement("button");
      b.className = "mt__btn";
      b.dataset.mode = mode;
      b.setAttribute("role", "radio");
      // labels are the site's to choose: Parallel says HUMAN / MACHINE, CData
      // HUMAN / AGENT, ai-sdk "For humans" / "For agents"
      b.textContent = this.getAttribute(`${mode}-label`) ?? (mode === "human" ? "Human" : "Machine");
      b.title = this.getAttribute(`${mode}-title`) ?? (mode === "human" ? "The page as designed" : "What an agent reads");
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
    window.addEventListener("popstate", () => this.#popstate());
    const m = initMode();
    this.#sync();
    if (m === "machine") {
      this.#address("machine", "replace");
      void this.#present(location.href);
    }
  }

  get pane(): HTMLElement | null {
    const id = this.getAttribute("for");
    return id ? document.getElementById(id) : document.querySelector("[data-machine-view]");
  }

  async choose(mode: Mode) {
    if (mode === "human" && pageKey(location.href) !== this.#document) {
      // the pane moved to another page; its human view is a real load away
      setMode("human");
      location.replace(withMode(location.href, "human"));
      return;
    }
    // resolve BEFORE flipping: generation reads computed style, and once the
    // human region is display:none there is nothing visible left to read
    if (mode === "machine") await this.#loadView().then((v) => v.copyForThisPage(this.#document, this.#opts())).catch(() => {});
    setMode(mode);
    this.#address(mode, "replace");
    if (mode === "machine") await this.#present(location.href);
  }

  /** follow a same-origin link inside the pane */
  async navigate(url: string) {
    history.pushState({ robo: true }, "", withMode(url, "machine"));
    await this.#present(url);
  }

  #opts() {
    return { exclude: this.getAttribute("exclude")?.split(",") };
  }

  #loadView(): Promise<ViewModule> {
    // a failed load is not cached, so a flaky network gets another try
    this.#view ??= this.loadView().catch((e) => { this.#view = null; throw e; });
    return this.#view;
  }

  #address(mode: Mode, how: "replace" | "push") {
    const next = withMode(location.href, mode);
    if (next === location.href) return;
    if (how === "push") history.pushState(history.state, "", next);
    else history.replaceState(history.state, "", next);
  }

  // back and forward move between pages the pane showed and the page the
  // browser loaded; anything else has to be loaded for real
  #popstate() {
    const url = new URL(location.href);
    const machine = url.searchParams.get(PARAM) === "machine";
    const here = pageKey(url.href) === this.#document;
    if (machine) {
      if (getMode() !== "machine") setMode("machine");
      void this.#present(url.href);
    } else if (here) {
      if (getMode() !== "human") setMode("human");
    } else {
      location.reload();
    }
  }

  async #present(url: string) {
    const pane = this.pane;
    if (!pane) return;
    const key = pageKey(url);
    if (pane.dataset.url === key && pane.dataset.filled) return this.#show(pane, true);
    this.#showing = key;
    this.#show(pane, true);
    pane.setAttribute("aria-busy", "true");
    pane.replaceChildren(Object.assign(document.createElement("p"), { className: "mv__loading", textContent: "Reading the machine copy…" }));
    try {
      const view = await this.#loadView();
      const copy: MachineCopy | null = key === this.#document
        ? await view.copyForThisPage(this.#document, this.#opts())
        : await view.copyFor(key);
      if (this.#showing !== key) return; // superseded by a newer navigation
      if (!copy) {
        // serves nothing we can fetch: load it for real, still in machine
        // mode, and let that page generate from its own DOM
        location.replace(withMode(key, "machine"));
        return;
      }
      pane.dataset.filled = copy.step;
      pane.dataset.url = key;
      pane.replaceChildren(view.renderPane(copy, { page: key, navigate: (u) => void this.navigate(u) }));
      pane.scrollTop = 0;
    } catch (e) {
      delete pane.dataset.filled;
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
