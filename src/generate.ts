// generate.ts: the last resort. Walk the LIVE DOM and write Markdown.
//
// It runs in the browser, so it gets two things a build-time string converter
// has to fake: a parsed tree (no tokenizer, no quoting traps), and computed
// style, so "is this visible" is a question the engine answers rather than a
// guess from class names. That is also its limit, and the status bar says so:
// this is the page AFTER JavaScript, which is not what an agent that never runs
// your scripts receives.
//
// The two rules carried over from aadhar.sh's html-to-md.ts, because they are
// the ones that matter on any site:
//   1. script/style bodies never reach the output (an inline JSON block can be
//      an answer key, a config, a token)
//   2. interactive controls render nothing: a button label without its
//      behaviour reads as a claim

const DROP = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG", "CANVAS", "IFRAME", "OBJECT", "VIDEO", "AUDIO",
  "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "OUTPUT", "FORM", "DIALOG",
  "NAV", "ASIDE",
]);
const BLOCK = new Set([
  "P", "DIV", "SECTION", "ARTICLE", "MAIN", "HEADER", "FOOTER", "FIGURE", "FIGCAPTION",
  "UL", "OL", "LI", "PRE", "BLOCKQUOTE", "TABLE", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "DL", "DT", "DD",
]);

export interface GenerateOptions {
  /** where content lives; defaults to main, then article, then body */
  root?: Element;
  /** extra selectors to leave out (your toggle, your machine pane, chrome) */
  exclude?: string[];
}

export function generateMarkdown(doc: Document, opts: GenerateOptions = {}): string {
  const root = opts.root ?? doc.querySelector("main, [role=main]") ?? doc.querySelector("article") ?? doc.body;
  const exclude = ["[data-machine-view]", "mode-toggle", "[aria-hidden=true]", "[hidden]", ...(opts.exclude ?? [])].join(",");
  const base = doc.baseURI;
  const view = doc.defaultView;

  const hidden = (el: Element) => {
    if (el.matches(exclude)) return true;
    // the human region is display:none BECAUSE machine mode is on (a reload
    // with the mode stored lands here). Its display says nothing about the page.
    if (el.matches("[data-human-only]")) return false;
    if (!view) return false;
    const cs = view.getComputedStyle(el);
    return cs.display === "none" || cs.visibility === "hidden";
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

  // inline: returns one line of Markdown for an element's inline content
  const inline = (node: Node): string => {
    if (node.nodeType === 3) return esc((node.nodeValue ?? "").replace(/\s+/g, " "));
    if (node.nodeType !== 1) return "";
    const el = node as Element;
    if (DROP.has(el.tagName) || hidden(el)) return "";
    const kids = () => [...el.childNodes].map(inline).join("");
    switch (el.tagName) {
      case "BR": return "  \n";
      case "STRONG": case "B": { const t = kids().trim(); return t ? `**${t}**` : ""; }
      case "EM": case "I": { const t = kids().trim(); return t ? `_${t}_` : ""; }
      case "CODE": return "`" + (el.textContent ?? "").replace(/`/g, "ˋ") + "`";
      case "A": {
        const t = kids().trim();
        const href = abs(el.getAttribute("href") ?? "");
        return t && href ? `[${t}](${href})` : t;
      }
      case "IMG": {
        const alt = el.getAttribute("alt")?.trim(); // no alt means decorative, by the page's own claim
        const src = abs(el.getAttribute("src") ?? "");
        return alt && src ? `![${esc(alt)}](${src})` : "";
      }
      default: return kids();
    }
  };

  const out: string[] = [];
  const push = (s: string) => { const t = s.replace(/[ \t]+\n/g, "\n").trim(); if (t) out.push(t); };

  // block: flushes runs of inline content between block children
  const block = (el: Element, prefix = "") => {
    let run = "";
    const flush = () => { if (run.trim()) push(prefix + run.trim()); run = ""; };
    for (const n of el.childNodes) {
      if (n.nodeType !== 1) { run += inline(n); continue; }
      const c = n as Element;
      if (DROP.has(c.tagName) || hidden(c)) continue;
      if (!BLOCK.has(c.tagName)) { run += inline(c); continue; }
      flush();
      emit(c, prefix);
    }
    flush();
  };

  // a list is ONE block: its lines, nested lists indented under their item
  const list = (el: Element, prefix: string, depth = 0): string[] => {
    const lines: string[] = [];
    let i = 1;
    for (const li of el.children) {
      if (li.tagName !== "LI" || hidden(li)) continue;
      const marker = el.tagName === "OL" ? `${i++}. ` : "- ";
      const nested = [...li.children].filter((c) => c.tagName === "UL" || c.tagName === "OL");
      const text = [...li.childNodes].filter((c) => !nested.includes(c as Element)).map(inline).join("").trim();
      if (text) lines.push(prefix + "  ".repeat(depth) + marker + text);
      for (const n of nested) lines.push(...list(n, prefix, depth + 1));
    }
    return lines;
  };

  const emit = (el: Element, prefix: string) => {
    const t = el.tagName;
    if (/^H[1-6]$/.test(t)) return push(prefix + "#".repeat(+t[1]) + " " + inline(el).trim());
    if (t === "HR") return push(prefix + "---");
    if (t === "PRE") return push("```\n" + (el.textContent ?? "").replace(/\n$/, "") + "\n```");
    if (t === "BLOCKQUOTE") return block(el, prefix + "> ");
    if (t === "UL" || t === "OL") return push(list(el, prefix).join("\n"));
    if (t === "TABLE") {
      const rows = [...el.querySelectorAll("tr")].map((tr) =>
        [...tr.children].map((td) => inline(td).trim().replace(/\|/g, "\\|")));
      if (!rows.length) return;
      const w = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => "| " + Array.from({ length: w }, (_, k) => r[k] ?? "").join(" | ") + " |";
      return push([line(rows[0]), line(Array(w).fill("---")), ...rows.slice(1).map(line)].join("\n"));
    }
    return block(el, prefix);
  };

  const title = doc.title.trim();
  const hasH1 = !!root.querySelector("h1");
  if (title && !hasH1) out.push(`# ${esc(title)}`);
  block(root);
  return out.join("\n\n") + "\n";
}
