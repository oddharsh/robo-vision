// facts-html.ts: PageFacts from HTML text, where there is no Document.
//
// The browser reads them off the live DOM (factsFromDocument). A CLI, a CI job
// or an agent has only the first response's markup, which is also the honest
// input for them: it is the page before any script ran, and that is the page a
// fetcher receives. A tag scanner rather than a parser, so it runs unchanged
// in Node, Bun and a Worker with nothing to install. It needs two things only:
// <link rel="alternate" type="text/markdown"> and the text of one region.

import type { PageFacts } from "./source.ts";

const MARKDOWN_TYPES = new Set(["text/markdown", "text/x-markdown"]);

// a comment, a whole script or style element, or one tag
const TOKEN = /<!--[\s\S]*?-->|<(script|style)\b[\s\S]*?<\/\1\s*>|<(\/?)([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi;
const ATTR = /([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|(\w+));/gi, (m, dec, hex, name) =>
  dec ? String.fromCodePoint(+dec) : hex ? String.fromCodePoint(parseInt(hex, 16)) : ENTITIES[name.toLowerCase()] ?? m);

function attrs(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of raw.matchAll(ATTR)) out.set(m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ""));
  return out;
}

/** read PageFacts off HTML text; `machineRegion` is an attribute name */
export function factsFromHtml(html: string, machineRegion = "data-machine-only"): PageFacts {
  const alternates: string[] = [];
  let inPage: string | null = null;
  // the region being read: its tag name, how many of that tag are open inside
  // it, and where its text resumes. Counting only the opener's own tag name
  // keeps an unclosed <p> or <li> inside the region from throwing the depth off
  let region: { tag: string; depth: number; from: number; text: string } | null = null;

  for (const m of html.matchAll(TOKEN)) {
    const [token, , closing, name, rawAttrs] = m;
    const at = m.index!;
    if (region) {
      region.text += html.slice(region.from, at);
      region.from = at + token.length;
    }
    if (!name) continue; // a comment, or a script or style with its body
    const tag = name.toLowerCase();

    if (region) {
      if (tag !== region.tag) continue;
      region.depth += closing ? -1 : 1;
      if (region.depth === 0) {
        inPage = decode(region.text);
        region = null;
      }
      continue;
    }
    if (closing) continue;

    const a = attrs(rawAttrs);
    if (tag === "link") {
      const rel = (a.get("rel") ?? "").toLowerCase().split(/\s+/);
      const href = a.get("href");
      if (href && rel.includes("alternate") && MARKDOWN_TYPES.has((a.get("type") ?? "").toLowerCase())) alternates.push(href);
    }
    // the first region only, as querySelector takes the first in the browser
    if (inPage === null && a.has(machineRegion)) region = { tag, depth: 1, from: at + token.length, text: "" };
  }
  // markup cut off inside the region: what was read is still its text
  if (region) inPage = decode(region.text + html.slice(region.from));
  return { alternates, inPage };
}
