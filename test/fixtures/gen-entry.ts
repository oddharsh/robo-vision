import { generateMarkdown } from "../../src/generate.ts";
(globalThis as unknown as { __gen: typeof generateMarkdown }).__gen = generateMarkdown;
