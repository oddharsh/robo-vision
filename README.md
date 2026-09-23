# robo-vision (prototype)

A Human/Machine toggle whose machine view shows the copy an agent is actually
served, and generates one only when a site publishes nothing.

```
src/source.ts       find an existing machine copy; the judgement is rejectReason()
src/generate.ts     last resort: live DOM to Markdown
src/mode.ts         headless state: html[data-mode], storage, ?mode=, PREPAINT
src/mode-toggle.ts  <mode-toggle>, semantics only
src/xp.css          the Luna flavor (toolbar toggle pair, sunken well, status bar)
demo/serve.ts       six server behaviours, one page       bun demo/serve.ts 8841
probe.ts            the resolver against live sites      bun probe.ts <url>...
test/               bun test
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

## Known costs

- a site with nothing published costs up to 3 requests before generating
  (negotiate + two suffix spellings on `/`), and each 404 logs as a console error
- the generated copy is the page after JavaScript; the status bar says it is
  not what agents receive
- the machine view needs the network on first toggle
- open call: in-page ranks above a served twin, so an author's hand-written
  region wins over what agents get
