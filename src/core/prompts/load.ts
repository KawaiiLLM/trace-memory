import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_WRITING_LIMITS, renderLimits } from "./limits.ts";
import type { WritingLimits } from "../model/index.ts";
import { canonicalToolNames, renderToolNames, validateToolNames, type ToolNames } from "./tool-names.ts";

/** Every prompt file under `src/core/prompts/` (stage prompts, then `tasks/<name>.md`), the one list the CC bundle
 * build composes from, so a file listed here cannot be missing from the bundle. */
export const PROMPT_FILES = ["noting.md", "dreaming.md", "classifying.md",
  "tasks/noting-write-facts.md", "tasks/noting-write-knowledge.md", "tasks/noting-verify-facts.md", "tasks/noting-verify-knowledge.md",
  "tasks/curate.md"] as const;
export type PromptFile = (typeof PROMPT_FILES)[number];
const INCLUDE = /<!-- include:\s*([^\s>]+)\s*-->/g;

/** A stage prompt with its shared blocks (`shared/<name>.md`) spliced in at `<!-- include: name -->`
 * markers; the hash callers compute covers the composed text. An unknown or malformed marker throws. */
export function composePrompt(file: PromptFile): string {
  const template = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const composed = template.replace(INCLUDE, (_, name: string) => {
    const url = new URL(`./shared/${name}.md`, import.meta.url);
    if (!/^[a-z][a-z-]*$/.test(name) || !existsSync(url)) throw new Error(`${file}: unknown shared block "${name}"`);
    return readFileSync(url, "utf8").trimEnd();
  });
  if (/<!--\s*include/.test(composed)) throw new Error(`${file}: malformed include marker`);
  return composed;
}

export function loadPrompt(file: PromptFile, names: ToolNames = canonicalToolNames,
  limits: WritingLimits = DEFAULT_WRITING_LIMITS): string {
  return renderLimits(renderToolNames(composePrompt(file), validateToolNames(names)), limits);
}
