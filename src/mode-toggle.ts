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
// Which page the pane is on, and what Human and Back do from there, is
// session.ts. This element hands it the real history, the lazy copies and the
// mode attribute, and draws what it is told to show.

import { getMode, setMode, initMode, reveal, EVENT, type Mode } from "./mode.ts";
import { paneSession, type PaneSession, type Shown } from "./session.ts";

export type ViewModule = typeof import("./view.ts");
export type { Shown };

/** fired on the toggle whenever what the pane holds changes; it bubbles, so a
 *  listener on document hears it from a drop-in toggle it never held */
export const SHOWN_EVENT = "robo-vision:shown";

export class ModeToggle extends HTMLElement {
  /** how the view code arrives; drop-in mode swaps in a loader that also
   *  brings the pane's skin */
  //
  // By a URL resolved at runtime against this file's own, never a literal
  // import("./view.ts"): a bundler that sees the literal either splits it and
  // may hoist shared modules into a chunk the entry imports eagerly, or inlines
  // the whole view into the file every visitor loads. Either way the lazy half
  // stops being lazy. Ship view.js beside this file, or set loadView yourself.
  loadView: () => Promise<ViewModule> = () => import(new URL("./view.js", import.meta.url).href) as Promise<ViewModule>;

  #view: Promise<ViewModule> | null = null;
  /** the view once it has arrived; show() only draws copies it fetched */
  #loaded: ViewModule | null = null;
  #buttons: HTMLButtonElement[] = [];
  #shown: Shown | null = null;
  /** the page the browser loaded; after pushState, location is the pane's
   *  address and no longer this */
  #document = location.href;
  #session: PaneSession = paneSession({
    history: {
      current: () => location.href,
      push: (url) => history.pushState({ robo: true }, "", url),
      replace: (url) => history.replaceState(history.state, "", url),
      load: (url) => location.replace(url),
    },
    copies: () => this.#loadView().then((v) => ({
      forDocument: () => v.copyForThisPage(this.#document, this.#opts()),
      forUrl: v.copyFor,
      pageBehind: v.humanPageFor,
    })),
    mode: { get: getMode, set: (m) => setMode(m) },
    show: (s) => this.#draw(s),
  });

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
    window.addEventListener("popstate", () => void this.#session.popstate());
    initMode();
    this.#sync();
    // the pane is open now, so the page the pre-paint snippet hid can show;
    // same task as the open, so nothing paints in between
    reveal();
    void this.#session.start();
  }

  /**
   * What the pane holds: a copy, a lookup in flight, or an error, each with the
   * page it is for. null until the pane is first used. It stays set while the
   * pane is closed, since the pane still holds it. Read this, or listen for
   * SHOWN_EVENT, rather than reading the pane's markup: the markup's classes
   * are for styling, and its wording can change in any release.
   */
  get shown(): Shown | null {
    return this.#shown;
  }

  get pane(): HTMLElement | null {
    const id = this.getAttribute("for");
    return id ? document.getElementById(id) : document.querySelector("[data-machine-view]");
  }

  choose(mode: Mode): Promise<void> {
    return this.#session.choose(mode);
  }

  /** follow a same-origin link inside the pane */
  navigate(url: string): Promise<void> {
    return this.#session.open(url);
  }

  #opts() {
    return { exclude: this.getAttribute("exclude")?.split(",") };
  }

  #loadView(): Promise<ViewModule> {
    // a failed load is not cached, so a flaky network gets another try
    this.#view ??= this.loadView().then((v) => (this.#loaded = v)).catch((e) => { this.#view = null; throw e; });
    return this.#view;
  }

  #draw(s: Shown) {
    this.#shown = s;
    this.#paint(s);
    // after painting, so a listener that looks at the pane finds it drawn
    this.dispatchEvent(new CustomEvent<Shown>(SHOWN_EVENT, { detail: s, bubbles: true }));
  }

  #paint(s: Shown) {
    const pane = this.pane;
    if (!pane) return;
    const note = (className: string, textContent: string) => Object.assign(document.createElement("p"), { className, textContent });
    if (s.kind === "loading") {
      pane.setAttribute("aria-busy", "true");
      pane.replaceChildren(note("mv__loading", "Reading the machine copy…"));
      return;
    }
    pane.removeAttribute("aria-busy");
    // data-filled and data-url are styling hooks (a border for generated
    // copies, say); toggle.shown is where the data is
    if (s.kind === "error") {
      delete pane.dataset.filled;
      pane.replaceChildren(note("mv__error", `No machine copy: ${s.message}`));
      return;
    }
    pane.dataset.filled = s.copy.step;
    pane.dataset.url = s.url;
    pane.replaceChildren(this.#loaded!.renderPane(s.copy, {
      page: s.url,
      navigate: (u) => void this.#session.open(u),
      prefetch: (u) => this.#session.prefetch(u),
    }));
    pane.scrollTop = 0;
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
