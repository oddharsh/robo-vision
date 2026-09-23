# robo-vision (prototype)

A Human/Machine toggle whose machine view shows the copy an agent is actually
served, and generates one only when a site publishes nothing.

```
src/source.ts       find an existing machine copy; the judgement is rejectReason()
src/generate.ts     last resort: live DOM to Markdown
src/mode.ts         headless state: html[data-mode], storage, ?mode=, PREPAINT
src/mode-toggle.ts  <mode-toggle>, semantics only
src/base.css        the only CSS robo-vision ships: integrity rules, plus a
                    neutral look in @layer robo-vision that any site CSS beats
skins/xp*.css       one optional skin (aadhar.sh's XP Luna), built to dist/skins/xp.css
src/copies.ts       the data layer: a copy for any same-origin URL, no rendering
src/view.ts         the lazy half: renderPane(), plus copies.ts re-exported
src/drop-in.ts      zero-markup mode: a docked toggle and a top-layer overlay
scripts/build.ts    dist/robo-vision.js (+ chunks/) lazy, dist/robo-vision.eager.js single file
demo/serve.ts       six server behaviours, one page       bun demo/serve.ts 8841
probe.ts            the resolver against live sites      bun probe.ts <url>...
dryrun/             drop robo-vision into 34 live sites in real Chrome
test/               bun test (the generator tests drive real Chrome)
```

## Add it to a site

```html
<script type="module" src="/robo-vision/robo-vision.js"
        data-machine-label="Agent" data-corner="bottom-left"></script>
```

Host `dist/` at that path. No markup, no inline script or style for a CSP to
allow (styles are adopted as constructed sheets), no server changes.

It brings no look of its own worth keeping. The base follows the site's font
and color scheme, reads `--rv-bg`, `--rv-fg`, `--rv-accent`, `--rv-border`,
`--rv-radius`, `--rv-font`, `--rv-mono` and a few more from any ancestor, and
sits in `@layer robo-vision`, so a site restyles it by writing ordinary CSS
for `.rv-dock`, `.mt__btn`, `.mv__well` and friends: no `!important`, no
specificity games. Only the rules it needs to function are unlayered, so a
global reset like `* { box-sizing: content-box }` cannot break it. Labels,
titles and the corner are attributes. A skin is just more CSS:

```html
<link rel="stylesheet" href="/robo-vision/skins/xp.css">
```

## Overhead

Measured by A/B on six live sites (aadhar.sh, Cloudflare's docs, Wikipedia,
Hacker News, react.dev, BBC), five cold loads per arm, the same document with
and without the script tag:

| stage | cost |
|---|---|
| every page view | 1 request, 9,246 B (3.6 KB gzip), mounted after load on idle; +0 to 2 ms script, +1 to 14 ms main thread, CLS unchanged, load and LCP within noise; **no requests to the site** |
| first hover or focus | 2 requests, the view code, 12.9 KB (5.8 KB gzip) |
| clicking Machine | 1 to 4 requests to the site, median 267 ms to a served copy; generation itself 2 ms median, 15 ms worst (Wikipedia) |
| a section serving nothing | its first page pays the lookups; the rest of it, for the session, none |
| each link followed in the pane | ~1 request, ~9 KB, against 1.3 to 8.3 MB for a normal load |

Main-thread cost is style recalculation, which adding any stylesheet causes
and which scales with the host's DOM, not with robo-vision's rule count:
cutting its CSS from 6.9 KB to 1.9 KB saved bytes and no measurable time.

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

Negotiation asks plainly first, since that is the request an agent sends and
its answer, cached or not, is what an agent reads. When that answer is not
Markdown and the response does not vary on `Accept`, the shared cache cannot
tell the two representations apart, so the lookup retries once with a
throwaway `?_rv=` param that the cache has never seen (CData's trick). The pane
names the retry. Measured on webflow.com: Markdown on 2 of 4 lookups before,
4 of 4 after. Busting every request was tried and rejected, because on a site
that varies correctly (cdata.com) it shows the origin's fresh copy while agents
are served a cached one, and it costs the site a cache miss per toggle.

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
`.md`), 1 an in-page region, 21 generated. Webflow's negotiation was flaky
because it omits `Vary: Accept`, so its edge cache hands back whichever
representation it stored last. The cache-buster below fixed it.

## Staying in machine view

Machine mode lives in the address as `?robo-vision=machine`, the way
Parallel's machine view lives under `/ai/`, so a reload, the back button and a
pasted link all keep it. What differs is what a link costs. On Parallel a link
in machine view is a full page load (a new document plus route-data fetches).
Here a same-origin link in the pane fetches that page's copy and nothing else,
draws it, and moves the address with `pushState`:

| following one link | in the pane | normal page load |
|---|--:|--:|
| developers.cloudflare.com | 1 request, 8,590 B, 175 ms | 44 requests, 1,301,050 B, 621 ms |
| parallel.ai | 1 request, 9,259 B (+ a favicon, 2 ad pixels) | 94 requests, 8,258,734 B |

Fetching and rendering are separate modules. `copies.ts` returns a copy for
any same-origin URL without loading or drawing it, caches by URL, and
remembers which step this origin serves copies by, so after one `.md` hit the
next page is asked for its `.md` first. `renderPane()` draws a copy and never
fetches. They meet only at a link: hovering it fetches, clicking renders. A
page that serves no copy is loaded for real, still carrying the param, and
generates from its own DOM. Back and forward re-render from the cache; on
Parallel, Cloudflare's docs and react.dev, Back caused no reload.

## Known costs

- a site with nothing published costs up to 3 requests before generating
  (negotiate + two suffix spellings on `/`), and each 404 logs as a console error
- the generated copy is the page after JavaScript; the status bar says it is
  not what agents receive
- `opacity: 0` counts as visible, so hover-swap images appear twice (allbirds);
  treating it as hidden would drop every fade-in-on-scroll section instead
- closed shadow roots are invisible to any script, so their content is lost
- the machine view needs the network on first toggle
- on a section of a site that serves no Markdown, the first page pays for the
  lookups (a negotiation and up to two `.md` spellings, each a 404); the rest
  of that section, for the session, generates without asking
- in-pane navigation fires a site's own history listeners: Cloudflare's docs
  and Parallel sent their analytics beacons, which count it as a page view
- open call: in-page ranks above a served twin, so an author's hand-written
  region wins over what agents get
