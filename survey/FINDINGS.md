# How other sites build the Human/Machine split (surveyed 2026-09-23)

`bun survey/run.ts` loads each site in Chrome, finds the machine-side control
by its label, clicks it, and diffs the page before and after: attributes,
storage, URL, network requests, DOM churn, text length. It then runs
robo-vision's resolver to see what an agent is actually served at that URL.
cdata.com needs `--headful`, because it answers headless Chrome with a 403.

## The eleven that are live

| site | control | state lives in | where the machine copy comes from | what agents are served |
|---|---|---|---|---|
| parallel.ai | `○ HUMAN ◉ MACHINE` spans, floating, no ARIA | `data-mode` on a div, and the URL (`/` becomes `/ai`) | the same DOM restyled by a Tailwind `machine:` variant, link targets shown | `/.md`, 21,485 chars, declared by `rel=alternate` |
| cloudflare.com/connect | fixed `role=radiogroup`, `aria-checked` radios | `html[data-mode]`, localStorage `cf-mode`, pre-paint script | a hand-written `<pre>` in the page, 2,181 chars | Markdown for Agents edge conversion, 11,653 chars, only sometimes (no `Vary: Accept`) |
| konghq.com | spans in a `<fieldset>` | `html[data-mode=agent]`, the URL (`?mode=agent`) | every label doubled as `.agent` / `.not-agent` spans | HTML |
| oneofftech.xyz | two buttons, no pressed state | `html[data-agent]`, sessionStorage `oot-mode` | the same DOM restyled by a Tailwind `agent:` variant, font to Fira Mono | `/index.md`, 2,325 chars, exported at build from the page's hidden `<template>` |
| speakeasy.com | one fixed "Agent view" button | `html.agent-mode`, localStorage `speakeasy-view-mode` | **fetches `/index.md`** on click, view code lazy-loaded | the same twin, by negotiation |
| buildfm.com | `role=radiogroup`, `aria-checked` radios | nothing | Turndown.js in the browser, into a modal overlay | a separate `.md`, 8,176 chars |
| cdata.com | fixed `role=group`, `aria-pressed` buttons | nothing | **fetches the same URL with `Accept: text/markdown` and a cache-buster (`?_mdcb=`)** | that same negotiated copy, 29,060 chars |
| docsalot.dev | two links | the URL | MACHINE is a plain link to `/index.md` | the same file, by negotiation |
| ai-sdk.dev | `aria-pressed` buttons, hero panel | nothing | a different panel of agent setup instructions | HTML |
| 4agent.dev | two buttons, one panel | nothing | a different panel for agents | HTML |
| krowdev.com | one "Switch to Agent" button | nothing observed | clicking changed nothing; the `human \| agent \| all` control and `?reader=` from its March post are gone | `.md`, 10,037 chars, declared |

## Gone, or never shipped

- **flyvolo.ai**: the "dual-mode" aviation site from the February post now hosts an unrelated product.
- **yawn.ai**: no Human/Agent toggle on the homepage.
- **strandsagents.com**: the For humans / For agents PR merged in `strands-agents/harness-sdk`, and the live homepage has only a TS/Python switch.
- **getmarkdown.app** is a paid script-tag SaaS: a floating "Copy as Markdown" button that converts in the visitor's browser and hands the result to an LLM. It has no view switch.

## Six ways to build it

1. **Restyle the same DOM** (Parallel, OneOffTech). CSS variant keyed on an attribute. Cheap, and no second copy to drift, but the result is Markdown-flavoured HTML rather than the Markdown agents fetch.
2. **Author a second copy into the page** (Cloudflare's `<pre>`, Kong's doubled spans). Hand-maintained, so it drifts from anything served.
3. **Generate in the browser** (FM, via Turndown). A third copy, alongside the page and the served twin.
4. **Fetch the served copy** (Speakeasy, CData). The toggle shows what agents get. Two of eleven.
5. **Link to the twin** (docsalot). Zero JavaScript; the machine view is a different document.
6. **Swap in content for agents** (ai-sdk.dev, 4agent.dev, and the Strands PR). A persona toggle ("install our MCP server") rather than a second representation of the page. A different product, and robo-vision should not try to be it.

## What robo-vision should take from this

- **CData's cache-buster beats `cache: "no-store"`.** `no-store` only skips the browser's cache; the edge cache that makes Webflow's and Cloudflare's negotiation flaky keys on the URL, and a unique query param is the one thing that misses it. **Adopted, conditionally:** robo-vision asks plainly first and busts only when the answer was not Markdown and the response lacks `Vary: Accept`. Busting unconditionally was measured and rejected: CData itself varies correctly, and a busted request showed its origin's fresh copy (26,839 chars) while agents were served a 21-minute-old cached one (29,060 chars, with a JSON-LD block since dropped).
- **Speakeasy lazy-loads the view** (`agent-view-content.*.js` arrives on click). robo-vision's drop-in ships 33 KB up front; the resolver and generator could arrive on first toggle.
- **`data-mode` is taken three times over** in this survey alone (Parallel, Cloudflare, Kong), on top of docs.claude.com's theme. Namespacing was right.
- **A machine URL** (Parallel's `/ai`, Kong's `?mode=agent`) is common. robo-vision's `?robo-vision=machine` covers it.
- **Accessibility is uneven.** Only Cloudflare and FM expose the state as radios, and CData and ai-sdk as pressed buttons. Parallel, Kong, OneOffTech and 4agent expose none. robo-vision's radiogroup with roving tabindex is at the top of this range.
- **Toggles are short-lived.** Of fourteen found through posts and searches, two are gone (VOLO, yawn), one never reached the live site (Strands), and one is inert (krowdev), all in the eight months since Rauch's post about Parallel's toggle (2026-01-29). Worth weighing before anyone builds one by hand; it's also the case for a library that keeps working after the launch post.
