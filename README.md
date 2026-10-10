# robo-vision (prototype)

A Human/Machine toggle whose machine view shows the copy an agent is actually
served, and generates one only when a site publishes nothing.

```
src/source.ts       find an existing machine copy; the judgement is rejectReason()
src/generate.ts     last resort: live DOM to Markdown
src/mode.ts         headless state: html[data-robo-vision-mode], storage, ?robo-vision=
src/mode-toggle.ts  <mode-toggle>, semantics only
src/session.ts      which page the pane is on: links, Human, Back, the .md rule
src/base.css        the only CSS robo-vision ships: integrity rules, plus a
                    neutral look any site CSS for its classes beats
src/copies.ts       the data layer: a copy for any same-origin URL, no rendering
src/view.ts         the lazy half: renderPane(), plus copies.ts re-exported
src/drop-in.ts      zero-markup mode: a docked toggle and a top-layer overlay
src/facts-html.ts   the page's declarations read from HTML text, where there is no DOM
src/facts-dom.ts    the same, read off a live Document; browser only, never published
src/check.ts        the audit: every door opened, the answers compared, faults named
src/memory.ts       what an origin has shown: the door that worked, sections that serve nothing
src/reroute.ts      a 404, and which of the origin's real pages it meant
src/resolve.ts      the package's DOM-free entry, plus fetchMachineCopy() for agents
src/cli.ts          robo-vision check <url>
scripts/build.ts    dist/robo-vision.js (+ chunks/, robo-vision.view.js) lazy,
                    dist/robo-vision.eager.js single file, dist/prepaint.js,
                    dist/resolve.js and dist/cli.js for Node
src/prepaint.ts     the snippet a host inlines in <head>
demo/serve.ts       six server behaviours, one page       bun demo/serve.ts 8841
dryrun/             drop robo-vision into 34 live sites in real Chrome
test/               bun test (the generator tests drive real Chrome)
```

## Add it to a site

```html
<script type="module" src="/robo-vision/robo-vision.js"
        data-machine-label="Agent" data-corner="bottom-left"></script>
```

Host `dist/` at that path, or load it from a CDN that mirrors npm
(`https://cdn.jsdelivr.net/npm/robo-vision@0.1/dist/robo-vision.js`). No markup, no inline script or style for a CSP to
allow (styles are adopted as constructed sheets), no server changes.

A `<script src>` naming robo-vision means "put the toggle on this page", and
a tag your own code injects counts the same. A site whose shell script decides
which pages get the toggle imports it with no tag instead, and nothing mounts
until it says so:

```js
const { mount } = await import("/robo-vision/robo-vision.js");
mount({ corner: "top-right", labels: { machine: "Agent" } }); // resolves to { dock, pane }
```

Either way it mounts at once for a visitor who asked for machine view, and
otherwise after the page's load event, when the main thread is idle. One dock
per page: a second `mount()` resolves to `null` and the first one's options
stand.

### Hosting it across deploys

Ship all of `dist/` together. Cache it like this:

| file | cache | why |
|---|---|---|
| `robo-vision.js` | short (minutes) | a fixed name; a new release has to reach visitors |
| `chunks/view-<hash>.js` | immutable | its name changes whenever its bytes do |
| `robo-vision.view.js` | short | the same view under a fixed name |

The fixed-name view is for the browser a deploy strands: it holds last
release's entry, which asks for a view hash the deploy just deleted. The entry
falls back to `robo-vision.view.js` when the hashed file is gone, and says so
by name if that view is from a release it cannot drive. It sits beside the
entry rather than in `chunks/`, so a host's immutable rule for `chunks/*` never
catches it. (On Cloudflare, a second `_headers` rule under that glob would
COMBINE with it into two `max-age` values rather than replace it.)

### No flash of the page in machine view

robo-vision is a module, and a module runs after the page has painted, so a
link to `?robo-vision=machine` shows the human page for a moment before the
pane covers it. `dist/prepaint.js` closes that gap. Inline its contents in
`<head>` (the build prints the digest a hash-based CSP needs), or load it there
as a classic script:

```html
<script>/* the contents of dist/prepaint.js, 530 bytes */</script>
```

It applies the requested mode to `<html>`, and for a machine view it hides the
page until the pane is up, then both appear in the same frame. The hide is a
CSSOM write, which a CSP that forbids inline styles still allows. If
robo-vision never arrives on that page, the page shows anyway after 3 seconds,
so inline it only where the toggle loads, and load the toggle at once (not on
idle) when `<html data-robo-vision-mode="machine">` is set.

### Its look is the site's

It brings no look of its own. The dock and the pane wear the font `<body>`
does; on a page whose `<body>` sits at the browser's default because the font
is set on a wrapper inside it (bbc.com, nytimes.com), they get `system-ui`
instead of Times. Only the family is inherited, so a light or italic body
leaves the toggle regular and upright. Colours follow the site's color scheme
through system colors, and the base reads `--rv-bg`, `--rv-fg`, `--rv-accent`,
`--rv-accent-fg`, `--rv-border`, `--rv-radius`, `--rv-font`, `--rv-mono` and a
few more from any ancestor, `:root` included. Labels, titles and the corner are
attributes.

To know what the pane shows, read the toggle rather than the pane:

```js
document.addEventListener("robo-vision:shown", (e) => {
  // e.detail: { kind: "loading" | "copy" | "error", url, copy?, message? }
  if (e.detail.kind === "copy") analytics.track("machine-view", { door: e.detail.copy.step, served: e.detail.copy.served });
});
document.querySelector("mode-toggle").shown; // the same value, now
```

The event bubbles from the toggle, so a drop-in site hears it on `document`.
`copy` carries the text, the door that found it, whether agents are served
it, and each attempt with a verdict code. The pane's markup is for styling:
its classes and `data-filled` / `data-url` are stable hooks for CSS, and its
wording can change in any release.

For anything the variables do not cover, a site writes ordinary CSS for
`.rv-dock`, `.mt`, `.mt__btn`, `.mv__well` and friends. Every base look rule
has the specificity of one element (`button:where(.mt__btn)`), which sets the
contract:

| the site writes | specificity | outcome |
|---|---|---|
| `.mt__btn { ... }` | 0,1,0 | the site wins |
| `button { padding: 0 }`, a reset | 0,0,1 | ties; robo-vision's sheet is adopted later and wins |
| `* { box-sizing: content-box }` | 0,0,0 | robo-vision wins |

The rules it needs to function (hiding the page in machine view, the overlay's
box, the box model) are plain class selectors, so a global reset cannot break
it. A site's look for robo-vision lives in that site's stylesheet; this
repository ships no skins. `demo/demo.css` shows the pattern in a few lines.

## Check what a site serves agents

```
npx robo-vision check https://docs.stripe.com/checkout/quickstart https://webflow.com/
```

The toggle stops at the first door with a copy, because each further door
costs the site a request. `check` opens all of them and compares the answers.
It exits 1 when a page has an error, so it can gate a deploy; `--strict` fails
on warnings too, `--json` prints the reports, and `--ua` sets the User-Agent.

| rule | severity | what it caught |
|---|---|---|
| `nothing-served` | error | no door serves Markdown, so an agent gets the HTML (konghq.com) |
| `cache-ignores-accept` | error | Markdown only past the cache: the origin negotiates and the edge answers HTML (webflow.com) |
| `mislabelled-html` | error | `text/markdown` over an HTML body (Shopify storefronts) |
| `dead-alternate` | error | a declared twin that is not there |
| `empty-copy` | error | a Markdown type with nothing in it |
| `page-unreachable` | error | the page refused this fetcher (a bot wall), so nothing else was asked |
| `no-vary-accept` | warn | negotiated Markdown with no `Vary: Accept` |
| `undeclared` | warn | Markdown is served and no `rel=alternate` says so (docs.stripe.com) |
| `doors-disagree` | warn | two doors serve different words |
| `in-page-only`, `in-page-drift` | warn | a machine region shown to visitors that agents are not served (cloudflare.com/connect) |
| `md-suffix-answers-html` | info | a catch-all route answering `/x.md` with the app shell and a 200 |

It fetches from wherever it runs and says who it is, so a site that treats
fetchers differently by address or User-Agent can answer it differently than
it answers a browser.

## Use the resolver from an agent

```ts
import { fetchMachineCopy } from "robo-vision/resolve";

const r = await fetchMachineCopy(url);
if (r.copy) use(r.copy.text);                 // the site's own Markdown
else if (r.suggestions?.length) pick(r.suggestions); // a 404, and the real pages it may have meant
else use(myOwnHtmlToText(r.html));
```

One request for the page, then one to three for its copy. `copy` is the site's
own Markdown and has passed `judge()`, so an app shell answering 200 at `/x.md`
and HTML under a Markdown label both come back as `null`. `html` is the page it
had to fetch anyway. Nothing here touches a DOM: it runs in Node 18+, Bun and
Workers.

**It remembers each origin** for an hour, in a Map: the door that served last
is asked first, and a section that served nothing is not asked again. A site
that serves `.md` twins costs 2 requests a page after the first. Pass
`memory: originMemory(store)` to keep it elsewhere (any `get`/`set` of strings),
or `memory: null`.

**On a 404 it reads the site's page list** and does one of two things:

| the URL | result |
|---|---|
| differs from exactly one real page by case, a trailing slash, `.html` or `/index` | that page is read, and `rerouted` says what was fixed |
| anything fuzzier: a typo, a renamed page | nothing is followed; `suggestions` ranks real pages with a score |

The list is `llms.txt` by default (one request, with titles) plus the links in
copies already read on that origin. `reroute: { pages: ["llms", "sitemap"] }`
adds the sitemap, found through `robots.txt`, then `/sitemap.xml`, then
`/sitemap-index.xml`, with indexes walked and reads capped at 5 MB.
`reroute: false` returns the bare 404.

The candidates are a closed set: a chooser ranks the origin's own pages and
anything else it returns is dropped. The built-in chooser scores spelling,
which catches typos and misses synonyms (`/jobs` for `/careers`). For those,
plug in a decision model, the way [ry](https://github.com/ygwyg/ry) uses
Cloudflare's Clef for visitors:

```ts
import { fetchMachineCopy, type Chooser } from "robo-vision/resolve";

const clef: Chooser = async (missing, options) => {
  const out = await env.AI.run("@cf/cloudflare/clef-flash", {
    question: `Which page did a request for ${new URL(missing).pathname} mean?`,
    options: options.map((o) => ({ id: o.url, label: o.title ?? new URL(o.url).pathname })),
  });
  return options.map((o) => ({ ...o, score: out.probabilities[o.url] ?? 0 }));
};
await fetchMachineCopy(url, { reroute: { chooser: clef } });
```

(The request shape above is illustrative; check Clef's docs for the current
one.) Any classifier fits: the seam is options in, a score per option out.

Nothing in this depends on the site's host. It reads a status code, `llms.txt`
and sitemaps, which every host serves the same way. Measured 2026-10-02 on 20
docs sites (9 Vercel, 4 Netlify, 5 Cloudflare, 2 other): all 20 answered a
missing page with a real 404, so none hid a miss behind a 200.
`bun test/hosts.live.ts` reruns a sample from each:

| host | site | asked for | result |
|---|---|---|---|
| Vercel | nextjs.org | `.../instalation` | suggested `.../installation`, 0.984 |
| Vercel | react.dev | `/learn/thinking-in-reakt` | suggested `/learn/thinking-in-react`, 0.968 |
| Netlify | docs.netlify.com | `.../environment-variabls` | suggested `.../environment-variables`, 0.988 |
| Netlify | vuejs.org | `/guide/Introduction` | the host answers it (200) |
| Cloudflare | hono.dev | `.../cloudflare-worker` | suggested `.../cloudflare-workers`, 0.985 |
| Cloudflare | developers.cloudflare.com | `.../fetch-handler` | suggested `/workers/runtime-apis/handlers/`, 0.81 |
| Cloudflare | docs.astro.build | `.../instalation/` | weak: the page is `/en/install-and-setup/`, a rename a model catches and spelling does not |

## Overhead

Measured by A/B on six live sites (aadhar.sh, Cloudflare's docs, Wikipedia,
Hacker News, react.dev, BBC), five cold loads per arm, the same document with
and without the script tag:

| stage | cost |
|---|---|
| every page view | 1 request, 10,115 B (4.0 KB gzip), mounted after load on idle; +0 to 2 ms script, +1 to 14 ms main thread, CLS unchanged, load and LCP within noise; **no requests to the site** |
| first hover or focus | 2 requests, the view code, 13.2 KB (5.9 KB gzip) |
| clicking Machine | 1 to 4 requests to the site, median 267 ms to a served copy; generation itself 2 ms median, 15 ms worst (Wikipedia) |
| a section serving nothing | its first page pays the lookups; the rest of it, for the session, none |
| each link followed in the pane | ~1 request, ~9 KB, against 1.3 to 8.3 MB for a normal load |

Main-thread cost is style recalculation, which adding any stylesheet causes
and which scales with the host's DOM, not with robo-vision's rule count:
cutting its CSS from 6.9 KB to 1.9 KB saved bytes and no measurable time.

## Run it

No runtime dependencies, just bun (TypeScript is there to emit declarations).

```
bun test
bun run build                     # dist/, everything the npm package ships
bun run check https://parallel.ai/ https://www.cloudflare.com/connect/ https://konghq.com/
bun run demo                      # http://localhost:8841
```

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

in-page, link-alternate, negotiated, md-suffix, generated. A URL that is itself a `.md` file is
answered by the file alone (`md-url`), in one request. A fetched step hits
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
fetches. Between them, `session.ts` decides which page the pane is on: a
hovered link asks it to fetch ahead, a click asks it to go there, and Human and
Back ask it which page to land on. It reaches the browser only through three
adapters (history, copies, the mode attribute), so its rules run in `bun test`
against a recorder. A page that serves no copy is loaded for real, still
carrying the param, and generates from its own DOM. Back and forward re-render from the cache; on
Parallel, Cloudflare's docs and react.dev, Back caused no reload.

Some sites link one Markdown file to another (Stripe's copies point at
`/checkout/quickstart.md`, not `/checkout/quickstart`). Left in the address
bar, a `.md` URL strands a reload or the Human button on a raw text file with
no toggle. So a `.md` link is fetched as it is and, alongside, one `HEAD`
asks whether the page it mirrors exists (`/x.md` to `/x`, `/index.md` to
`/`). A 200 that is HTML puts that page in the address bar: Stripe's six
links all pass. Anything else keeps the `.md` address, and Human returns to
the last real page instead: nuxt.com's `/design.md` and `/sitemap.md` are
Markdown-only, and their stripped URLs are 404s. A reload on a Markdown-only
file still shows it as raw text, since there is no page to fall back to.

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
