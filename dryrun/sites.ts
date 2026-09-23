// sites.ts: the dry-run roster. Picked for SPREAD rather than fame: every
// stack a site could plausibly be built on, every kind of page, and the whole
// range from "publishes Markdown twins" to "has never heard of an agent".
// `agent` is what we expected going in; the run records what is actually there.

export interface Site {
  url: string;
  stack: string;
  kind: "docs" | "marketing" | "news" | "shop" | "app" | "reference" | "blog" | "gov" | "forum" | "personal";
  agent: "native" | "partial" | "none";
  why: string;
}

export const SITES: Site[] = [
  // agent-native: expected to publish Markdown somewhere
  { url: "https://developers.cloudflare.com/workers/", stack: "Astro Starlight", kind: "docs", agent: "native", why: "twins + rel=alternate" },
  { url: "https://parallel.ai/", stack: "Next.js app router", kind: "marketing", agent: "native", why: "/.md declared, its own toggle" },
  { url: "https://www.cloudflare.com/connect/", stack: "Astro", kind: "marketing", agent: "partial", why: "in-page machine region, html[data-mode] of its own" },
  { url: "https://docs.claude.com/en/docs/intro", stack: "Mintlify", kind: "docs", agent: "native", why: "Mintlify serves .md" },
  { url: "https://docs.stripe.com/payments", stack: "custom (Stripe)", kind: "docs", agent: "native", why: ".md twins" },
  { url: "https://vercel.com/docs", stack: "Next.js", kind: "docs", agent: "native", why: "llms.txt, md routes" },
  { url: "https://aadhar.sh/garage/horizon", stack: "Workers + hand HTML", kind: "personal", agent: "native", why: "twins, negotiation, 135 KB of Markdown" },
  { url: "https://svelte.dev/docs/kit/introduction", stack: "SvelteKit", kind: "docs", agent: "native", why: "llms.txt family" },
  { url: "https://hono.dev/docs/", stack: "VitePress", kind: "docs", agent: "native", why: "llms.txt" },
  { url: "https://bun.com/docs", stack: "Mintlify", kind: "docs", agent: "native", why: "second Mintlify, to see if it is the platform" },

  // partial / none
  { url: "https://konghq.com/", stack: "Next.js pages router", kind: "marketing", agent: "partial", why: "doubled .agent spans, nothing served" },
  { url: "https://en.wikipedia.org/wiki/Web_crawler", stack: "MediaWiki (PHP)", kind: "reference", agent: "none", why: "huge DOM, infobox, citations" },
  { url: "https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/link", stack: "Rari + Lit", kind: "reference", agent: "partial", why: "strict CSP, web components" },
  { url: "https://github.com/oven-sh/bun", stack: "Rails + React", kind: "app", agent: "none", why: "strict CSP, Trusted Types" },
  { url: "https://news.ycombinator.com/", stack: "Arc", kind: "forum", agent: "none", why: "table layout, no <main>" },
  { url: "https://www.gov.uk/", stack: "Rails + govuk-frontend", kind: "gov", agent: "none", why: "accessibility-first markup" },
  { url: "https://www.nytimes.com/", stack: "custom React", kind: "news", agent: "none", why: "bot walls, consent, heavy JS" },
  { url: "https://www.bbc.com/news", stack: "Next.js", kind: "news", agent: "none", why: "news cards, lazy images" },
  { url: "https://www.allbirds.com/", stack: "Shopify", kind: "shop", agent: "none", why: "storefront, carousels, popups" },
  { url: "https://wordpress.org/news/", stack: "WordPress", kind: "blog", agent: "none", why: "the most common CMS there is" },
  { url: "https://ghost.org/blog/", stack: "Ghost", kind: "blog", agent: "none", why: "Handlebars themes" },
  { url: "https://webflow.com/", stack: "Webflow", kind: "marketing", agent: "none", why: "no-code, animation-heavy" },
  { url: "https://www.squarespace.com/", stack: "Squarespace", kind: "marketing", agent: "none", why: "no-code" },
  { url: "https://www.framer.com/", stack: "Framer", kind: "marketing", agent: "none", why: "no-code, absolute-positioned" },
  { url: "https://gohugo.io/documentation/", stack: "Hugo", kind: "docs", agent: "partial", why: "static site generator" },
  { url: "https://docusaurus.io/docs", stack: "Docusaurus", kind: "docs", agent: "none", why: "React SSG docs, data-theme on html" },
  { url: "https://angular.dev/", stack: "Angular", kind: "docs", agent: "partial", why: "Angular SSR, llms.txt" },
  { url: "https://nuxt.com/", stack: "Nuxt", kind: "marketing", agent: "partial", why: "Vue SSR" },
  { url: "https://react.dev/", stack: "Next.js", kind: "docs", agent: "partial", why: "big-traffic docs" },
  { url: "https://lit.dev/", stack: "Eleventy + Lit", kind: "docs", agent: "none", why: "content inside shadow roots" },
  { url: "https://excalidraw.com/", stack: "React SPA", kind: "app", agent: "none", why: "canvas app, almost no text in the DOM" },
  { url: "https://www.apple.com/", stack: "custom", kind: "marketing", agent: "none", why: "heavy imagery, little text" },
  { url: "https://www.google.com/", stack: "custom (Google)", kind: "app", agent: "none", why: "Trusted Types enforced" },
  { url: "https://ui.shadcn.com/docs", stack: "Next.js + Tailwind", kind: "docs", agent: "partial", why: "Tailwind preflight resets every button" },
];
