// serve.ts: one page, six ways a site can (or cannot) hold its machine copy.
// Each route is the same XP window over different server behaviour, so the
// status bar is the only thing that should differ between them.
//
//   bun demo/serve.ts [port]

import { PREPAINT } from "../src/mode.ts";

const port = Number(process.argv[2] ?? 8841);
const here = new URL(".", import.meta.url).pathname;

// split like the real build, so the demo exercises the lazy view: the toggle
// loads with the page, view.ts arrives on hover or first click
const built = await Bun.build({
  entrypoints: [`${here}../src/mode-toggle.ts`],
  target: "browser",
  format: "esm",
  splitting: true,
  minify: false,
  naming: { entry: "[name].js", chunk: "chunks/[name]-[hash].js" },
});
if (!built.success) throw new AggregateError(built.logs, "bundle failed");
const js = new Map<string, string>();
for (const o of built.outputs) js.set("/js/" + o.path.replace(/^\.\//, ""), await o.text());

const CASES = {
  bare:       "Nothing published. The toggle has to generate.",
  declared:   "A twin at an unconventional URL, declared with link rel=alternate.",
  negotiated: "The page URL answers Accept: text/markdown.",
  suffix:     "A twin at /suffix.md and no declaration. Found by convention.",
  inline:     "The page carries its own machine region, Cloudflare style.",
  poisoned:   "Every probe answers 200 with HTML. None may be believed.",
} as const;
type Case = keyof typeof CASES;

const twin = (c: Case) => `# ${c}: the served twin

This text lives on the server, apart from the HTML. An agent that asks for
Markdown gets exactly these bytes, which is why the status bar says so.

- case: \`${c}\`
- rule: ${CASES[c]}
`;

const page = (c: Case) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${c} · robo-vision</title>
<script>${PREPAINT}</script>
${c === "declared" ? `<link rel="alternate" type="text/markdown" href="/twins/declared-copy.md">` : ""}
<link rel="stylesheet" href="/demo.css">
<link rel="stylesheet" href="/base.css">
<link rel="stylesheet" href="/base-pane.css">
<link rel="stylesheet" href="/skins/xp.css">
<link rel="stylesheet" href="/skins/xp-pane.css">
</head>
<body>
<div class="ds-window">
  <div class="ds-titlebar">
    <span class="ds-tb-title"><span class="ds-tb-icon" aria-hidden="true"></span><span>${c} - robo-vision</span></span>
    <span class="ds-tb-controls" aria-hidden="true"><span class="min"></span><span class="max"></span><span class="close"></span></span>
  </div>
  <div class="toolbar">
    <nav class="cases" aria-label="Cases">${(Object.keys(CASES) as Case[])
      .map((k) => `<a href="/${k}"${k === c ? ' aria-current="page"' : ""}>${k}</a>`).join("")}</nav>
    <span class="toolbar__sep" aria-hidden="true"></span>
    <mode-toggle for="machine-pane"></mode-toggle>
  </div>
  <div class="ds-window-content">
    <main data-human-only>
      <h1>The ${c} case</h1>
      <p class="lede">${CASES[c]}</p>
      <p>This paragraph has <strong>bold</strong>, <em>emphasis</em>, <code>code</code>, and a
      <a href="/negotiated">relative link</a> that should come out absolute.</p>
      <h2>What the generator keeps</h2>
      <ul>
        <li>headings, paragraphs and links</li>
        <li>lists, including
          <ul><li>nested ones</li></ul>
        </li>
        <li>images that carry alt text</li>
      </ul>
      <table>
        <tr><th>element</th><th>generated as</th></tr>
        <tr><td>button</td><td>nothing</td></tr>
        <tr><td>script body</td><td>nothing</td></tr>
      </table>
      <p><button type="button">Buy now</button> (that button is a control, so it renders nothing)</p>
      <script type="application/json" id="answers">{"secret":"this must never appear in the machine copy"}</script>
      <p class="decoration" aria-hidden="true">※ decoration marked aria-hidden ※</p>
    </main>
    ${c === "inline" ? `<section data-machine-only hidden>
event   robo-vision demo
case    inline
note    authored by the page itself, the way /connect/ ships its own
</section>` : ""}
    <section id="machine-pane" data-machine-view hidden aria-label="Machine view"></section>
  </div>
</div>
<script type="module" src="/js/mode-toggle.js"></script>
</body>
</html>`;

const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
const md = (body: string) =>
  new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", vary: "accept" } });

const server = Bun.serve({
  port,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const accept = req.headers.get("accept") ?? "";
    if (pathname === "/") return Response.redirect(`/bare`, 302);
    if (js.has(pathname)) return new Response(js.get(pathname), { headers: { "content-type": "text/javascript" } });
    if (pathname === "/base.css" || pathname === "/base-pane.css") return new Response(Bun.file(`${here}../src${pathname}`));
    if (pathname.startsWith("/skins/")) return new Response(Bun.file(`${here}..${pathname}`));
    if (pathname === "/demo.css") return new Response(Bun.file(`${here}demo.css`));
    if (/^\/[a-z]+\.css$/.test(pathname)) return new Response(Bun.file(`${here}${pathname.slice(1)}`));

    if (pathname === "/twins/declared-copy.md") return md(twin("declared"));
    if (pathname === "/suffix.md") return new Response(twin("suffix"), { headers: { "content-type": "text/plain; charset=utf-8" } });
    // the SPA fallback: any .md under /poisoned answers the app shell with a 200
    if (pathname.startsWith("/poisoned")) return html(page("poisoned"));

    const c = pathname.slice(1) as Case;
    if (!(c in CASES)) return html("<!doctype html><title>404</title><p>not found</p>", 404);
    if (c === "negotiated" && /\btext\/markdown\b/.test(accept)) return md(twin("negotiated"));
    return html(page(c));
  },
});
console.log(`robo-vision demo on http://localhost:${server.port}/`);
