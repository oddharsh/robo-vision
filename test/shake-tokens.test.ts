import { test, expect } from "bun:test";
import { shakeTokens } from "../scripts/shake-tokens.ts";

const CSS = `
/* a comment with a { brace } in it */
:root {
  --hue: 263;
  --blue: oklch(50% 0.2 var(--hue));
  --ink: oklch(20% 0 var(--hue-chrome, 95));
  --unused: red;
  --grad: linear-gradient(var(--blue), var(--also-unused-no));
  color-scheme: light;
}
@media (color-gamut: p3) {
  :root { --blue: oklch(50% 0.3 var(--hue)); --unused: blue; }
}
@media (prefers-contrast: more) {
  :root { --unused: black; }
}`;

test("keeps what is read, and everything that is read FROM", () => {
  const { css, kept, dropped } = shakeTokens(CSS, ["--grad"]);
  expect(kept.sort()).toEqual(["--blue", "--grad", "--hue"]);
  expect(dropped.sort()).toEqual(["--ink", "--unused"]);
  expect(css).toMatch(/--hue:\s*263/);
  expect(css).toContain("oklch(50% 0.3 var(--hue))"); // the p3 override of a kept token survives
  expect(css).not.toContain("--unused");
});

test("non-custom declarations are never touched", () => {
  expect(shakeTokens(CSS, []).css).toMatch(/color-scheme:\s*light/);
});

test("a media block left empty disappears whole", () => {
  expect(shakeTokens(CSS, ["--blue"]).css).not.toContain("prefers-contrast");
});

test("a var() fallback naming an undefined token keeps nothing extra", () => {
  const { kept } = shakeTokens(CSS, ["--ink"]);
  expect(kept).toEqual(["--ink"]);
});
