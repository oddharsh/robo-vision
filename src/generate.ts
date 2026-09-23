// generate.ts: the last resort. Walk the LIVE DOM and write Markdown.
//
// It runs in the browser, so it gets two things a build-time string converter
// has to fake: a parsed tree (no tokenizer, no quoting traps), and computed
// style. Both decide the output. "Is this visible" and "is this a block" are
// answered by the engine rather than guessed from tag names, and the tree
// walked is the one the page RENDERS, open shadow roots and slots included.
// That is also its limit, and the status bar says so: this is the page after
// JavaScript, which an agent that never runs your scripts does not receive.
//
// The two rules carried over from aadhar.sh's html-to-md.ts, because they are
// the ones that matter on any site:
//   1. script/style bodies never reach the output (an inline JSON block can be
//      an answer key, a config, a token)
//   2. interactive controls render nothing: a button label without its
//      behaviour reads as a claim
//
// The dry run (34 sites, 2026-09-23) rewrote the rest. A tag-name idea of
// "block" glued every CSS-laid-out page into one line: Hacker News is table
// rows, GitHub and Kong are flex items, and BBC wraps each headline and its
// standfirst in one <a> of block children ("...ambitionsThe BBC visits...").
// Open shadow roots held 37 of MDN's components and 38 of lit.dev's.

const DROP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "VIDEO", "AUDIO",
  "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "OUTPUT", "FORM", "DIALOG",
  "NAV", "ASIDE", "LINK", "META",
]);

export interface GenerateOptions {
  /** where content lives; defaults to main, then article, then body */
  root?: Element;
  /** extra selectors to leave out (your toggle, your machine pane, chrome) */
  exclude?: string[];
}

export function generateMarkdown(doc: Document, opts: GenerateOptions = {}): string {
  const root = opts.root ?? doc.querySelector("main, [role=main]") ?? doc.querySelector("article") ?? doc.body;
  // collapsed is not hidden: hidden="until-found" (Wikipedia's navboxes) and a
  // closed <details> (every FAQ) are content the page offers one click away,
  // and a served twin would carry it. The two used to disagree: the [hidden]
  // selector dropped the first while the second slipped through untested.
  const exclude = ["[data-machine-view]", "[data-robo-vision]", "mode-toggle", "[aria-hidden=true]", "[hidden]:not([hidden=until-found])", ...(opts.exclude ?? [])].join(",");
  const base = doc.baseURI;
  const view = doc.defaultView;

  // one getComputedStyle per element: hidden() and kind() both need it
  const styles = new WeakMap<Element, CSSStyleDeclaration | null>();
  const style = (el: Element) => {
    if (!styles.has(el)) styles.set(el, view ? view.getComputedStyle(el) : null);
    return styles.get(el)!;
  };

  const hidden = (el: Element) => {
    if (DROP.has(el.tagName) || el.matches(exclude)) return true;
    // the human region is display:none BECAUSE machine mode is on (a reload
    // with the mode stored lands here). Its display says nothing about the page.
    if (el.matches("[data-human-only]")) return false;
    const cs = style(el);
    return !!cs && (cs.display === "none" || cs.visibility === "hidden");
  };

  // how the ENGINE lays it out. contents: the box vanishes and its children
  // take its place. cell: inline, but set apart from its neighbours.
  type Kind = "block" | "inline" | "cell" | "contents";
  const kind = (el: Element): Kind => {
    const d = style(el)?.display ?? "";
    if (d === "contents" || el.tagName === "SLOT") return "contents";
    if (d === "table-cell") return "cell";
    if (!d) return /^(P|DIV|SECTION|ARTICLE|MAIN|HEADER|FOOTER|UL|OL|LI|PRE|BLOCKQUOTE|TABLE|TR|H[1-6]|HR|FIGURE|FIGCAPTION|DL|DT|DD)$/.test(el.tagName) ? "block" : "inline";
    return d.startsWith("inline") || d === "ruby" ? "inline" : "block";
  };

  // the rendered tree: a host's shadow root in place of its light children,
  // and a slot's assigned nodes in place of its fallback content
  const kids = (el: Element): Node[] => {
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    if (el.tagName === "SLOT") {
      const assigned = (el as HTMLSlotElement).assignedNodes({ flatten: true });
      if (assigned.length) return assigned;
    }
    return [...el.childNodes];
  };

  // an inline box that holds blocks is drawn as blocks: <x-card> defaults to
  // display:inline and its shadow root holds an <h2>. <a> is the exception,
  // because breaking it up would lose the link; its blocks read as phrases.
  const holding = new WeakMap<Element, boolean>();
  const holdsBlocks = (el: Element): boolean => {
    if (!holding.has(el)) {
      holding.set(el, kids(el).some((x) => {
        if (x.nodeType !== 1 || hidden(x as Element)) return false;
        const k = kind(x as Element);
        return k === "block" || (k !== "cell" && (x as Element).tagName !== "A" && holdsBlocks(x as Element));
      }));
    }
    return holding.get(el)!;
  };

  // a flex ROW of short phrases is one line, not a stack of paragraphs:
  // flex items compute to display:block, so GitHub's "12038 Branches" and
  // Kong's tag strips would otherwise come out one word per paragraph
  const STRUCT = "h1,h2,h3,h4,h5,h6,p,li,pre,table,blockquote,ul,ol";
  // blocks that emit() writes its own way, whatever is inside them
  const STRUCTURAL = /^(?:H[1-6]|PRE|UL|OL|TABLE|BLOCKQUOTE|HR)$/;
  const phraseRow = (el: Element) => {
    const cs = style(el);
    return !!cs && /^(?:inline-)?flex$/.test(cs.display) && cs.flexDirection.startsWith("row") && !el.shadowRoot && !el.querySelector(STRUCT);
  };

  const abs = (href: string) => {
    try {
      const u = new URL(href, base);
      return /^(?:https?|mailto):$/.test(u.protocol) ? u.href : null; // javascript:, data: address nothing
    } catch {
      return null;
    }
  };

  const esc = (s: string) => s.replace(/([\\`*_[\]])/g, "\\$1");
  const tidy = (s: string) => s.replace(/[ \t]+/g, " ").replace(/ ?\n ?/g, "\n").trim();

  // inline: one run of Markdown for a node's inline content. A block that turns
  // up inside inline context (a <div> inside an <a>) is set apart by spaces, so
  // the run still reads as separate phrases.
  const inline = (node: Node): string => {
    if (node.nodeType === 3) return esc((node.nodeValue ?? "").replace(/\s+/g, " "));
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    if (hidden(el)) return "";
    const inner = () => kids(el).map(inline).join("");
    const k = kind(el);
    const pad = (s: string) => (k === "block" || k === "cell" ? ` ${s} ` : s);
    switch (el.tagName) {
      case "BR": return "\\\n";
      case "STRONG": case "B": { const t = tidy(inner()); return t ? pad(`**${t}**`) : ""; }
      case "EM": case "I": { const t = tidy(inner()); return t ? pad(`_${t}_`) : ""; }
      case "CODE": return pad("`" + (el.textContent ?? "").replace(/`/g, "ˋ") + "`");
      case "A": {
        const t = tidy(inner());
        const href = abs(el.getAttribute("href") ?? "");
        return pad(t && href ? `[${t}](${href})` : t);
      }
      case "IMG": {
        const alt = el.getAttribute("alt")?.trim(); // no alt means decorative, by the page's own claim
        // currentSrc is the file the engine chose, which is right once an image
        // has loaded. Before that, a lazy loader's placeholder can hold it:
        // apple.com reports a 1x1 data: GIF for every tile below the fold, while
        // the real URL sits in src. First candidate that addresses something wins.
        const src = [(el as HTMLImageElement).currentSrc, el.getAttribute("src"), el.getAttribute("data-src")]
          .map((c) => (c ? abs(c) : null)).find(Boolean) ?? null;
        return alt && src ? pad(`![${esc(alt)}](${src})`) : "";
      }
      default: return pad(inner());
    }
  };

  const out: string[] = [];
  const push = (s: string) => { const t = s.replace(/[ \t]+\n/g, "\n").trim(); if (t) out.push(t); };

  // block: walk a node list, flushing runs of inline content between blocks
  const blockNodes = (nodes: Node[], prefix: string) => {
    let run = "";
    const flush = () => { const t = tidy(run); if (t) push(prefix + t.replace(/\n/g, `\n${prefix}`)); run = ""; };
    for (const n of nodes) {
      if (n.nodeType !== 1) { run += inline(n); continue; }
      const c = n as Element;
      if (hidden(c)) continue;
      const k = kind(c);
      if (k === "contents") {
        // no box of its own: its children join this context, block or not
        const inner = kids(c);
        if (inner.some((x) => x.nodeType === 1 && kind(x as Element) === "block")) { flush(); blockNodes(inner, prefix); }
        else run += inner.map(inline).join("");
        continue;
      }
      if (k === "inline" && c.tagName !== "A" && holdsBlocks(c)) { flush(); blockNodes(kids(c), prefix); continue; }
      if (k !== "block") { run += inline(c); continue; }
      flush();
      // a block-level link is still a link: Markdown cannot wrap blocks in one,
      // so it becomes a paragraph of its own. Treating it as a container lost
      // every URL on apple.com, whose links are display:block
      if (c.tagName === "A") { const t = tidy(inline(c)).replace(/\n/g, " "); if (t) push(prefix + t); continue; }
      // a block with no blocks inside is one paragraph of inline content. The
      // container path would walk its children, and an <img> has none: that
      // lost all 7 images on apple.com, which sets display:block on them
      if (!STRUCTURAL.test(c.tagName) && !holdsBlocks(c)) { const t = tidy(inline(c)); if (t) push(prefix + t.replace(/\n/g, `\n${prefix}`)); continue; }
      emit(c, prefix);
    }
    flush();
  };

  // a list is ONE block: its lines, nested lists indented under their item
  const list = (el: Element, prefix: string, depth = 0): string[] => {
    const lines: string[] = [];
    let i = 1;
    for (const li of kids(el)) {
      if (li.nodeType !== 1 || (li as Element).tagName !== "LI" || hidden(li as Element)) continue;
      const item = li as Element;
      const marker = el.tagName === "OL" ? `${i++}. ` : "- ";
      const nested = kids(item).filter((c): c is Element => c.nodeType === 1 && /^(UL|OL)$/.test((c as Element).tagName));
      const text = tidy(kids(item).filter((c) => !nested.includes(c as Element)).map(inline).join("")).replace(/\n/g, " ");
      if (text) lines.push(prefix + "  ".repeat(depth) + marker + text);
      for (const n of nested) lines.push(...list(n, prefix, depth + 1));
    }
    return lines;
  };

  const emit = (el: Element, prefix: string) => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return push(prefix + "#".repeat(+t[1]) + " " + tidy(inline(el)).replace(/\n/g, " "));
    if (t === "HR") return push(prefix + "---");
    if (t === "PRE") return push("```\n" + (el.textContent ?? "").replace(/\n$/, "") + "\n```");
    if (t === "BLOCKQUOTE") return blockNodes(kids(el), prefix + "> ");
    if (t === "UL" || t === "OL") return push(list(el, prefix).join("\n"));
    // a table with header cells is data and becomes a pipe table; one without
    // is layout (Hacker News is nothing but), so its rows are read as blocks
    if (t === "TABLE" && el.querySelector("th")) {
      const rows = [...el.querySelectorAll("tr")].filter((tr) => !hidden(tr)).map((tr) =>
        [...tr.children].filter((td) => !hidden(td)).map((td) => tidy(inline(td)).replace(/\n/g, " ").replace(/\|/g, "\\|")));
      if (!rows.length) return;
      const w = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => "| " + Array.from({ length: w }, (_, k) => r[k] ?? "").join(" | ") + " |";
      return push([line(rows[0]), line(Array(w).fill("---")), ...rows.slice(1).map(line)].join("\n"));
    }
    if (phraseRow(el)) return push(prefix + tidy(kids(el).map(inline).join("")).replace(/\n/g, " "));
    return blockNodes(kids(el), prefix);
  };

  const title = doc.title.trim();
  const hasH1 = !!root.querySelector("h1");
  if (title && !hasH1) out.push(`# ${esc(title)}`);
  blockNodes(kids(root), "");
  return out.join("\n\n") + "\n";
}
