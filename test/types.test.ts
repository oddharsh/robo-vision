// types.test.ts: the published declarations type-check in a Node project.
//
// robo-vision/resolve is the DOM-free entry, and its .d.ts files have to be
// too: a Node project with skipLibCheck off has no `Document`, and one browser
// helper living in source.ts once put it in source.d.ts (TS2304). TypeScript's
// default library includes the DOM, so only a consumer that names its own
// libraries, as this one does, can see the problem.
import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const tsc = (args: string[]) => Bun.spawnSync([ROOT + "node_modules/.bin/tsc", ...args], { cwd: ROOT });

test("a strict Node consumer with no DOM library compiles against robo-vision/resolve", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rv-types-"));
  try {
    const emit = tsc(["-p", "tsconfig.json", "--outDir", join(dir, "types")]);
    expect(emit.stdout.toString() + emit.stderr.toString()).toBe("");

    await Bun.write(join(dir, "use.mts"), `
import { fetchMachineCopy, checkPage, type Report } from "robo-vision/resolve";
const r = await fetchMachineCopy("https://example.test/");
const report: Report = await checkPage(r.url);
console.log(r.copy?.text.length, report.ok);
export {};
`);
    await Bun.write(join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        strict: true, noEmit: true, skipLibCheck: false,
        target: "es2022", module: "nodenext", moduleResolution: "nodenext",
        lib: ["es2022"], types: ["node"], typeRoots: [join(ROOT, "node_modules/@types")],
        allowImportingTsExtensions: true,
        paths: { "robo-vision/resolve": [join(dir, "types/resolve.d.ts")] },
      },
      files: [join(dir, "use.mts")],
    }));
    const check = tsc(["-p", join(dir, "tsconfig.json")]);
    expect(check.stdout.toString()).toBe("");
    expect(check.exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 60_000);
