# robo-vision (prototype)

A Human/Machine toggle whose machine view shows the copy an agent is actually
served, and generates one only when a site publishes nothing.

```
src/source.ts       find an existing machine copy; the judgement is rejectReason()
src/generate.ts     last resort: live DOM to Markdown
src/mode.ts         headless state: html[data-mode], storage, ?mode=, PREPAINT
src/mode-toggle.ts  <mode-toggle>, semantics only
src/xp.css          the Luna flavor (toolbar toggle pair, sunken well, status bar)
src/drop-in.ts      zero-markup mode: a docked toggle and a top-layer overlay
scripts/build.ts    dist/robo-vision.dropin.js, one IIFE with its skin inside
demo/serve.ts       six server behaviours, one page       bun demo/serve.ts 8841
probe.ts            the resolver against live sites      bun probe.ts <url>...
dryrun/             drop robo-vision into 34 live sites in real Chrome
test/               bun test (the generator tests drive real Chrome)
```

## Run it

No dependencies, just bun.

```
bun test
bun run demo                      # http://localhost:8841
bun run probe https://parallel.ai/ https://www.cloudflare.com/connect/ https://konghq.com/
```

The demo's token files (`demo/colors.css` and friends) are the aadhar.sh
Luna design system's own, copied verbatim.

## What the three sites built (probed 2026-09-23)

| site | toggle | machine copy the toggle shows | what an agent is served |
|---|---|---|---|
| parallel.ai | `data-mode` + Tailwind `machine:` variant | the same HTML, restyled | `/.md`, 21,485 chars, declared via `rel=alternate` |
| cloudflare.com/connect/ | `html[data-mode]`, localStorage, pre-paint | a hand-written `<pre>` in `[data-machine-only]` | HTML (`Accept: text/markdown` answers HTML) |
| konghq.com | `.agent` / `.not-agent` spans | every link rendered twice, in the page | HTML (no twin, no negotiation, `.md` 404s) |

In all three, the copy the toggle shows and the copy an agent receives are
different things. Parallel is the only one serving agents Markdown, and its
toggle doesn't show that Markdown.

## Resolution order

in-page, link-alternate, negotiated, md-suffix, generated. A fetched step hits
on the response BODY and TYPE, never the status: both traps answer 200 (a
URL-keyed cache returning the page's HTML, a SPA shell answering `/x.md`).

## Dry run (2026-09-23)

`bun scripts/build.ts && bun dryrun/run.ts` loads 34 live sites in Chrome with
their own CSP in force, injects the drop-in, clicks Machine, and records what
broke. `dryrun/report.ts`, `compare.ts` and `quality.ts` read the results.

The first run found seven problems. All seven are fixed, and the second run
reports no breakage beyond two pages with almost no text (a 403 bot wall on
nytimes.com, and google.com):

| found | where | fix |
|---|---|---|
| `<html data-mode>` is a theme attribute in the wild | docs.claude.com (`"system"`), cloudflare.com's own toggle | every name namespaced: `data-robo-vision-mode`, `?robo-vision=` |
| HTML labelled `text/markdown` got past the sniff | allbirds.com (Shopify), 664 KB of markup | skip BOM and leading comments before sniffing |
| a third-party popup covered the pane | allbirds.com (Attentive iframe) | dock and pane are `popover="manual"`, in the top layer |
| page CSS resized the toggle | apple.com (`box-sizing`) | state the box model instead of inheriting it |
| CSS layout glued text together | HN, GitHub, Kong, BBC | blocks decided by computed `display`, flex rows read as one line |
| open shadow roots skipped | MDN (37), GitHub (67), lit.dev (38) | the generator walks the rendered tree, slots included |
| the harness blamed sites' own CSP noise on us | Stripe, Webflow | only violations robo-vision could cause count |

Fixing those surfaced three more on the second run, each now a browser test:
`display:block` links and images (apple.com), lazy-load placeholders in
`currentSrc` (apple.com), and collapsed content (`hidden="until-found"`,
closed `<details>`), which is now kept rather than dropped.

Where the 34 got their copy: 12 served Markdown (declared, negotiated or
`.md`), 1 an in-page region, 21 generated. Webflow's negotiation is flaky
because it omits `Vary: Accept`, so it lands in either bucket run to run.

## Known costs

- a site with nothing published costs up to 3 requests before generating
  (negotiate + two suffix spellings on `/`), and each 404 logs as a console error
- the generated copy is the page after JavaScript; the status bar says it is
  not what agents receive
- `opacity: 0` counts as visible, so hover-swap images appear twice (allbirds);
  treating it as hidden would drop every fade-in-on-scroll section instead
- closed shadow roots are invisible to any script, so their content is lost
- the machine view needs the network on first toggle
- open call: in-page ranks above a served twin, so an author's hand-written
  region wins over what agents get
