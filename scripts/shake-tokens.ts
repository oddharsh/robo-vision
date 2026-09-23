// shake-tokens.ts: keep only the custom properties something actually reads.
//
// The design system defines 105 tokens; the toggle and the pane read 33 of
// them directly, plus whatever those are built from (--ink is an oklch() of
// --hue-chrome, and so on). Everything else was shipped to every page view and
// read by nothing: half the drop-in's first file was CSS, mostly this.
//
// Scope: the token files, which are rule blocks of custom-property
// declarations, nested at most one @media deep. Not a general CSS parser, and
// it does not need to be: the build hands it only those files, and anything
// that is not a custom property is kept untouched.

const VAR = /var\(\s*(--[\w-]+)/g;

export function varsIn(css: string): Set<string> {
  return new Set([...css.matchAll(VAR)].map((m) => m[1]));
}

interface Rule { prelude: string; body: string | Rule[] }

function parse(css: string): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf("{", i);
    if (open < 0) break;
    const prelude = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    for (; j < css.length && depth; j++) {
      if (css[j] === "{") depth++;
      else if (css[j] === "}") depth--;
    }
    const inner = css.slice(open + 1, j - 1);
    rules.push({ prelude, body: inner.includes("{") ? parse(inner) : inner });
    i = j;
  }
  return rules;
}

function decls(body: string): { name: string; value: string; text: string }[] {
  return body.split(";").map((t) => t.trim()).filter(Boolean).map((text) => {
    const c = text.indexOf(":");
    return { name: text.slice(0, c).trim(), value: text.slice(c + 1).trim(), text };
  });
}

export function shakeTokens(css: string, used: Iterable<string>): { css: string; kept: string[]; dropped: string[] } {
  const rules = parse(css.replace(/\/\*[\s\S]*?\*\//g, ""));

  // every definition of every custom property, across all blocks and media
  const defs = new Map<string, string[]>();
  const walk = (rs: Rule[]) => {
    for (const r of rs) {
      if (typeof r.body !== "string") { walk(r.body); continue; }
      for (const d of decls(r.body)) if (d.name.startsWith("--")) defs.set(d.name, [...(defs.get(d.name) ?? []), d.value]);
    }
  };
  walk(rules);

  // the closure: a kept token keeps everything its value reads
  const need = new Set<string>();
  const queue = [...used];
  while (queue.length) {
    const n = queue.pop()!;
    if (need.has(n)) continue;
    need.add(n);
    for (const v of defs.get(n) ?? []) for (const r of varsIn(v)) queue.push(r);
  }

  const emit = (rs: Rule[]): string => rs.map((r) => {
    if (typeof r.body !== "string") {
      const inner = emit(r.body);
      return inner ? `${r.prelude}{${inner}}` : "";
    }
    const kept = decls(r.body).filter((d) => !d.name.startsWith("--") || need.has(d.name)).map((d) => d.text);
    return kept.length ? `${r.prelude}{${kept.join(";")}}` : "";
  }).join("\n");

  const all = [...defs.keys()];
  return { css: emit(rules), kept: all.filter((n) => need.has(n)), dropped: all.filter((n) => !need.has(n)) };
}
