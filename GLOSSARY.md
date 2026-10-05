# Glossary

The words this codebase uses for its domain. Module-design words (module,
interface, seam, adapter, depth) follow the `/codebase-design` skill.

**Copy**: a Markdown rendering of a page, as robo-vision shows it in the pane.
_Avoid_: version, export.

**Served**: a copy an agent would receive by asking the site. A copy is served
or it is generated; only a served copy says what agents read.

**Twin**: a served copy at its own URL (`/x.md` for `/x`), declared or not.

**Door**: one way a page's copy can be found: in-page, link-alternate,
negotiated, md-suffix, generated. The resolver walks them in that order.
_Avoid_: step (the code's type is `Step`; prose says door).

**Machine region**: an author-written block on the page for machine view
(`[data-machine-only]`). Shown to visitors; never served.

**Pane**: where the machine view draws a copy.

**Document**: the page the browser loaded. Its copy is the only one generated
from a live DOM, and Human on it needs no load.

**Address**: what the address bar shows. In machine view it follows the pane
with `pushState`, so it can differ from the document.

**Session**: the rules that keep the address and the document straight across
links, Human and Back (`session.ts`).

**Origin memory**: what an origin has shown about serving copies: the door
that worked last, the sections that serve nothing, its page list
(`memory.ts`).

**Reroute**: on a 404, the origin's real page that differs only in case, a
trailing slash, `.html` or `/index`. Anything fuzzier is a **suggestion**,
and is never followed.
