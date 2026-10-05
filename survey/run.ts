// survey/run.ts: how other sites build their Human/Machine split, measured
// rather than read from their blog posts.
//
//   bun survey/run.ts [--only <substring>]
//
// For each site: load it in Chrome, find the control that switches to the
// machine side by its LABEL (every site names it differently), click it the
// way a person would, and diff the page before and after. The diff answers
// the mechanism questions directly: which attribute or class flipped, what got
// stored and where, whether the URL changed, whether a request went out for
// Markdown, and how much of the DOM changed. Then robo-vision's own resolver
// asks what an AGENT is served at the same URL, so the two can be compared.

import { chromium, type Page } from "playwright-core";
import { mkdir } from "node:fs/promises";
import { resolveMachineCopy } from "../src/source.ts";
import { factsFromHtml } from "../src/facts-html.ts";

export const SITES: { url: string; note: string }[] = [
  { url: "https://parallel.ai/", note: "the one everybody cites; Rauch amplified it 2026-01-29" },
  { url: "https://www.cloudflare.com/connect/", note: "sibling machine region, floating pill" },
  { url: "https://konghq.com/", note: "doubled .agent/.not-agent spans" },
  { url: "https://oneofftech.xyz/", note: "Tailwind agent: variant, hidden <template> of Markdown" },
  { url: "https://krowdev.com/showcase/reader-mode-showcase/", note: "human | agent | all, ?reader=" },
  { url: "https://www.flyvolo.ai/", note: "user-agent detection + cookie + toggle, two React renders" },
  { url: "https://www.speakeasy.com/", note: "inspired by Parallel, 'a gimmick, and we built it anyway'" },
  { url: "https://www.buildfm.com/resource-center/markdown-is-eating-the-world", note: "Turndown.js in the browser, lazy + cached" },
  { url: "https://www.cdata.com/", note: "Human-Agent toggle, LinkedIn 2026-08-18" },
  { url: "https://yawn.ai/", note: "Human/Agent above the hero; jobs page defaults to Agent" },
  { url: "https://strandsagents.com/", note: "For humans / For agents hero panel, per-visit" },
  { url: "https://ai-sdk.dev/", note: "For humans / For agents; Strands' inspiration" },
  { url: "https://docsalot.dev/", note: "visible switch to the Markdown version" },
  { url: "https://4agent.dev/tools/agenthaus", note: "For Human / For Agent tabs on a directory page" },
  { url: "https://getmarkdown.app/", note: "the SaaS: a floating .md button any site can paste in" },
];

const OUT = new URL("./out/", import.meta.url).pathname;
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1] : null;
const slug = (u: string) => new URL(u).hostname.replace(/^www\./, "") + new URL(u).pathname.replace(/\/+$/, "").replace(/\//g, "_");

// the labels sites use for the machine side, after trimming glyphs like ◉ ○
// ("ai" matched an unrelated link on krowdev and was dropped; a single-button
// toggle says "Switch to Agent")
const MACHINE = /^(?:(?:switch to |view as |show )?(?:machine|agent|agents|the agent)(?: view| mode)?|for agents?|llm|markdown|md|\.md)$/i;
const HUMAN = /^(?:human|humans|for humans?|human view)$/i;

async function snapshot(page: Page) {
  return page.evaluate(() => {
    const attrs = (el: Element | null) => el ? Object.fromEntries([...el.attributes].map((a) => [a.name, a.value.slice(0, 120)])) : {};
    const store = (s: Storage) => { try { return Object.fromEntries(Object.keys(s).map((k) => [k, (s.getItem(k) ?? "").slice(0, 80)])); } catch { return {}; } };
    return {
      url: location.href,
      html: attrs(document.documentElement),
      body: attrs(document.body),
      local: store(localStorage),
      session: store(sessionStorage),
      cookies: document.cookie.split(/;\s*/).filter(Boolean).map((c) => c.split("=")[0]),
      textLen: document.body.innerText.length,
      text: document.body.innerText.slice(0, 600),
      pres: document.querySelectorAll("pre, textarea").length,
      mono: (() => { const f = getComputedStyle(document.body).fontFamily; return f.slice(0, 80); })(),
    };
  });
}

// find the machine-side control: smallest visible clickable element whose own
// label matches, walking open shadow roots too
async function findControl(page: Page) {
  return page.evaluate(([m, h]) => {
    const MACHINE = new RegExp(m, "i"), HUMAN = new RegExp(h, "i");
    // drop radio glyphs and emoji, which sites use as the control's icon
    const norm = (s: string) => s.replace(/[◉○●◯•|]|\p{Extended_Pictographic}/gu, " ").replace(/\s+/g, " ").trim();
    const all: Element[] = [];
    const walk = (root: Document | ShadowRoot) => {
      for (const el of root.querySelectorAll("*")) { all.push(el); if ((el as Element).shadowRoot) walk((el as Element).shadowRoot!); }
    };
    walk(document);
    const clickable = (el: Element) =>
      el.matches("button, a, label, [role=button], [role=radio], [role=tab], [role=switch], [role=option], [role=menuitemradio], input") ||
      getComputedStyle(el).cursor === "pointer";
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none"; };
    const label = (el: Element) => norm(el.getAttribute("aria-label") || (el as HTMLElement).innerText || el.textContent || "");
    const pick = (re: RegExp) => all
      .filter((el) => clickable(el) && visible(el) && re.test(label(el)))
      // a control beats a link: krowdev's article says "agents" in a plain
      // <a> smaller than its real "Switch to Agent" button
      .sort((a, b) => {
        const link = (el: Element) => (el.tagName === "A" && !el.getAttribute("role") ? 1 : 0);
        const area = (el: Element) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
        return link(a) - link(b) || area(a) - area(b);
      })[0];
    const mc = pick(MACHINE), hc = pick(HUMAN);
    if (!mc) return null;
    // the group both live in: nearest common ancestor, if there is a human side
    let group: Element | null = mc.parentElement;
    if (hc) while (group && !group.contains(hc)) group = group.parentElement;
    const r = mc.getBoundingClientRect();
    const describe = (el: Element | null) => el ? {
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      aria: Object.fromEntries([...el.attributes].filter((a) => /^aria-|^data-|^role$|^type$|^name$/.test(a.name)).map((a) => [a.name, a.value.slice(0, 60)])),
      label: label(el).slice(0, 40),
      cls: typeof el.className === "string" ? el.className.slice(0, 120) : "",
    } : null;
    const pos = getComputedStyle(group ?? mc).position;
    return {
      machine: describe(mc),
      human: describe(hc ?? null),
      group: group ? { tag: group.tagName.toLowerCase(), role: group.getAttribute("role"), aria: group.getAttribute("aria-label"), html: group.outerHTML.slice(0, 700), position: pos } : null,
      x: r.x + r.width / 2, y: r.y + r.height / 2,
      inShadow: !document.contains(mc),
    };
  }, [MACHINE.source, HUMAN.source]);
}

async function survey(browser: Awaited<ReturnType<typeof chromium.launch>>, site: (typeof SITES)[number]) {
  const dir = OUT + slug(site.url) + "/";
  await mkdir(dir, { recursive: true });
  const r: Record<string, unknown> = { ...site };
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
  const page = await ctx.newPage();
  const requests: { url: string; type: string; accept: string | null; t: number }[] = [];
  let clickAt = Infinity;
  page.on("request", (q) => {
    if (Date.now() >= clickAt) requests.push({ url: q.url(), type: q.resourceType(), accept: q.headers()["accept"] ?? null, t: Date.now() - clickAt });
  });
  try {
    const res = await page.goto(site.url, { waitUntil: "load", timeout: 45_000 }).catch(() => null);
    r.status = res?.status() ?? null;
    await page.waitForTimeout(2500);
    const altLinks = await page.evaluate(() => [...document.querySelectorAll('link[rel~="alternate" i]')].map((l) => `${l.getAttribute("type")} ${l.getAttribute("href")}`).filter((s) => /markdown|text\/plain/.test(s)));
    r.alternates = altLinks;
    const before = await snapshot(page);
    await page.screenshot({ path: dir + "human.png" });
    const ctl = await findControl(page);
    r.control = ctl;
    if (!ctl) {
      r.finding = "no machine-side control found by label";
    } else {
      // count DOM churn caused by the click
      await page.evaluate(() => {
        const w = window as unknown as { __mut: { added: number; removed: number; attrs: Record<string, number> } };
        w.__mut = { added: 0, removed: 0, attrs: {} };
        new MutationObserver((ms) => {
          for (const m of ms) {
            w.__mut.added += m.addedNodes.length;
            w.__mut.removed += m.removedNodes.length;
            if (m.type === "attributes") w.__mut.attrs[m.attributeName!] = (w.__mut.attrs[m.attributeName!] ?? 0) + 1;
          }
        }).observe(document, { subtree: true, childList: true, attributes: true });
      });
      clickAt = Date.now();
      await page.mouse.click(ctl.x, ctl.y);
      await page.waitForTimeout(2500);
      const after = await snapshot(page);
      r.mutations = await page.evaluate(() => (window as unknown as { __mut: unknown }).__mut);
      const diff = (a: Record<string, string>, b: Record<string, string>) => {
        const out: Record<string, string> = {};
        for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (a[k] !== b[k]) out[k] = `${a[k] ?? "(none)"} -> ${b[k] ?? "(none)"}`;
        return out;
      };
      r.changed = {
        url: before.url !== after.url ? `${before.url} -> ${after.url}` : null,
        html: diff(before.html, after.html),
        body: diff(before.body, after.body),
        local: diff(before.local, after.local),
        session: diff(before.session, after.session),
        cookies: after.cookies.filter((c) => !before.cookies.includes(c)),
        textLen: `${before.textLen} -> ${after.textLen}`,
        pres: `${before.pres} -> ${after.pres}`,
        font: before.mono !== after.mono ? `${before.mono} -> ${after.mono}` : null,
      };
      r.afterText = after.text;
      r.requests = requests.filter((q) => !/\.(png|jpe?g|webp|avif|gif|svg|woff2?|ico)(\?|$)/.test(q.url) && !/analytics|collect|gtag|segment|posthog|sentry|hotjar|doubleclick|clarity/.test(q.url)).slice(0, 12);
      await page.screenshot({ path: dir + "machine.png" });
    }
    // what an agent gets at the same URL, with the page's own declarations
    try {
      // the declarations, read by the same rule the toggle uses; in-page is
      // what the site shows people, so it is not asked here
      const facts = { ...factsFromHtml(await page.content()), inPage: null };
      const c = await resolveMachineCopy(page.url(), { facts, skip: ["in-page", "generated"] });
      r.agentsServed = { step: c.step, url: c.url, chars: c.text.length, head: c.text.slice(0, 160) };
    } catch (e) {
      r.agentsServed = { step: null, attempts: (e as { attempts?: { step: string; reason: string }[] }).attempts?.map((a) => `${a.step}: ${a.reason}`) };
    }
  } catch (e) {
    r.error = (e as Error).message.split("\n")[0];
  } finally {
    await Bun.write(dir + "result.json", JSON.stringify(r, null, 2));
    await ctx.close();
  }
  return r;
}

await mkdir(OUT, { recursive: true });
// --headful for sites that refuse headless Chrome (cdata.com answers it 403)
const browser = await chromium.launch({ channel: "chrome", headless: !process.argv.includes("--headful") });
const roster = only ? SITES.filter((s) => s.url.includes(only)) : SITES;
const results: Record<string, unknown>[] = [];
const queue = [...roster];
await Promise.all(Array.from({ length: 4 }, async () => {
  for (let s = queue.shift(); s; s = queue.shift()) {
    const r = await survey(browser, s);
    results.push(r);
    const c = r.control as { machine?: { label: string } } | null;
    console.log(`${c ? "." : "?"} ${s.url}  control=${c?.machine?.label ?? "-"}  agents=${(r.agentsServed as { step?: string })?.step ?? "-"}`);
  }
}));
await browser.close();
// a partial run replaces its own sites and keeps the rest
const prior: Record<string, unknown>[] = only && (await Bun.file(OUT + "results.json").exists()) ? await Bun.file(OUT + "results.json").json() : [];
const merged = [...prior.filter((p) => !results.some((r) => r.url === p.url)), ...results]
  .sort((a, b) => SITES.findIndex((s) => s.url === a.url) - SITES.findIndex((s) => s.url === b.url));
await Bun.write(OUT + "results.json", JSON.stringify(merged, null, 2));
