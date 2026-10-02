// check.ts: audit what a page serves an agent, and name what is wrong with it.
//
// The toggle shows one copy. This opens every door (surveyMachineCopies) and
// compares the answers, because the faults worth catching are disagreements:
// a declared twin that 404s, a cache that answers Markdown on one request and
// HTML on the next, a hand-written region that says something the served copy
// does not. Each finding below was first met on a live site in the dry run or
// the survey; the comment on each names where.
//
// No DOM anywhere in this file: it runs in Node, Bun, a Worker and CI.

import { surveyMachineCopies, type Attempt, type Door, type MachineCopy, type ResolveOptions } from "./source.ts";
import { factsFromHtml } from "./facts-html.ts";

export type Severity = "error" | "warn" | "info";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  url?: string | null;
}

export interface Report {
  url: string;
  /** the first response an HTML fetcher gets */
  page: { status: number | null; contentType: string | null; chars: number };
  doors: Door[];
  /** the copy an agent is served, by the first door that serves one */
  served: MachineCopy | null;
  findings: Finding[];
  /** no finding of severity error */
  ok: boolean;
}

export interface CheckOptions extends Pick<ResolveOptions, "fetch" | "headers" | "cacheBust"> {
  /** attribute marking an author-written machine region */
  machineRegion?: string;
}

// whitespace differs between a file and a negotiated response for dull
// reasons (a trailing newline, CRLF); only a difference in words is drift
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

const fetched = (a: Attempt) => a.status !== undefined;
const isHtml = (a: Attempt) => /^text\/html\b/i.test(a.contentType ?? "");

export async function checkPage(url: string, opts: CheckOptions = {}): Promise<Report> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  const findings: Finding[] = [];
  const add = (severity: Severity, rule: string, message: string, at?: string | null) => findings.push({ rule, severity, message, ...(at !== undefined && { url: at }) });

  let html = "";
  let page: Report["page"] = { status: null, contentType: null, chars: 0 };
  let finalUrl = url;
  let reached = false;
  try {
    const res = await f(url, { headers: { ...opts.headers, accept: "text/html" }, redirect: "follow" });
    html = await res.text();
    finalUrl = res.url || url;
    page = { status: res.status, contentType: res.headers.get("content-type"), chars: html.length };
    // a bot wall (nytimes.com and cdata.com answered headless Chrome 403):
    // nothing below can be trusted, since the doors are likely walled too
    reached = res.ok;
    if (!res.ok) add("error", "page-unreachable", `the page answered HTTP ${res.status}; a fetcher identified like this one is being refused`, finalUrl);
  } catch (e) {
    add("error", "page-unreachable", `the page could not be fetched: ${(e as Error).message}`, url);
  }

  const facts = factsFromHtml(html, opts.machineRegion);
  const doors = !reached ? [] : await surveyMachineCopies(finalUrl, { fetch: f, headers: opts.headers, cacheBust: opts.cacheBust, facts });
  const door = (step: string) => doors.find((d) => d.step === step);
  const servedDoors = doors.filter((d) => d.copy?.served);
  const served = servedDoors[0]?.copy ?? null;

  if (reached && !served) {
    add("error", "nothing-served", "no door serves Markdown: an agent that fetches this page gets its HTML", finalUrl);
  }

  for (const d of doors) for (const a of d.attempts) {
    // Shopify storefronts answer Accept: text/markdown with the full HTML
    // page under a text/markdown label (allbirds.com, 664 KB)
    if (a.reason === "labelled Markdown, body is HTML") add("error", "mislabelled-html", `${a.step} answered ${a.contentType} over an HTML body; an agent that trusts the label reads markup as Markdown`, a.url);
    if (a.reason === "empty body") add("error", "empty-copy", `${a.step} answered a Markdown type with an empty body`, a.url);
  }

  // a declaration is a promise: every declared twin should be there
  for (const a of door("link-alternate")?.attempts ?? []) {
    if (a.url && !a.hit) add("error", "dead-alternate", `the page declares a Markdown twin that is not one: ${a.reason}`, a.url);
  }

  const neg = door("negotiated");
  if (neg) {
    const plain = neg.attempts.find((a) => fetched(a) && !a.note);
    const busted = neg.attempts.find((a) => fetched(a) && a.note);
    // webflow.com: Markdown on 1 of 4 plain requests, 4 of 4 past the cache
    if (busted?.hit) add("error", "cache-ignores-accept", "the origin negotiates Markdown, but the cache in front of it answered HTML and the response has no Vary: Accept; agents get whichever representation was cached last", neg.copy?.url);
    else if (plain?.hit && !plain.varies) add("warn", "no-vary-accept", "negotiation answered Markdown without Vary: Accept; a shared cache keyed on the URL can hand that Markdown to a browser, or the HTML to an agent", plain.url);
  }

  // a single-page app answers /anything.md with its shell and a 200
  for (const a of door("md-suffix")?.attempts ?? []) {
    if (a.status === 200 && isHtml(a)) add("info", "md-suffix-answers-html", "the .md spelling answers 200 with HTML (a catch-all route); a fetcher that trusts the status reads the app shell", a.url);
  }

  if (served && !facts.alternates.length) {
    add("warn", "undeclared", `Markdown is served by ${served.step} but the page declares no <link rel="alternate" type="text/markdown">; a fetcher has to guess it is there`, served.url);
  }

  // every door that serves should serve the same words
  for (const d of servedDoors.slice(1)) {
    if (squash(d.copy!.text) !== squash(served!.text)) {
      add("warn", "doors-disagree", `${served!.step} serves ${served!.text.length} chars and ${d.step} serves ${d.copy!.text.length}; which copy an agent reads depends on how it asks`, d.copy!.url);
    }
  }

  // cloudflare.com/connect: a hand-written <pre> of 2,181 chars shown by the
  // site's toggle, next to an edge conversion of 11,653 served to agents
  if (facts.inPage?.trim()) {
    if (!served) add("warn", "in-page-only", `the page shows visitors a machine region (${facts.inPage.length} chars) that no agent is served`);
    else if (squash(facts.inPage) !== squash(served.text)) add("warn", "in-page-drift", `the page's machine region (${facts.inPage.length} chars) differs from the copy agents are served (${served.text.length} chars)`, served.url);
  }

  return { url: finalUrl, page, doors, served, findings, ok: !findings.some((x) => x.severity === "error") };
}
