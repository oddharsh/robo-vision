// facts-dom.ts: PageFacts from a live Document, in the browser.
//
// Kept out of source.ts so the resolver, which the package publishes for
// Node, never names a DOM type: a Node project type-checking its
// dependencies has no `Document`, and one browser helper in source.ts put
// it in the published declarations. facts-html.ts is the same reader for
// HTML text; both judge a type attribute with source.ts's isMarkdownType().

import { isMarkdownType, type PageFacts } from "./source.ts";

export function factsFromDocument(doc: Document, machineRegion = "[data-machine-only]"): PageFacts {
  const alternates = [...doc.querySelectorAll<HTMLLinkElement>('link[rel~="alternate" i][type]')]
    .filter((l) => isMarkdownType(l.getAttribute("type")))
    .map((l) => l.getAttribute("href")!)
    .filter(Boolean);
  const region = doc.querySelector<HTMLElement>(machineRegion);
  return { alternates, inPage: region ? region.innerText || region.textContent : null };
}
