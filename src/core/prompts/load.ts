import { existsSync, readFileSync } from "node:fs";
import { DEFAULT_WRITING_LIMITS, renderLimits } from "./limits.ts";
import type { WritingLimits } from "../model/index.ts";
import { canonicalToolNames, renderToolNames, validateToolNames, type ToolNames } from "./tool-names.ts";

export type PromptFile = "noting.md" | "dreaming.md" | "classifying.md";
const INCLUDE = /<!-- include:\s*([^\s>]+)\s*-->/g;

/** A stage prompt with its shared blocks (`shared/<name>.md`) spliced in at `<!-- include: name -->`
 * markers; the hash callers compute covers the composed text. An unknown or malformed marker throws. */
export function composePrompt(file: PromptFile): string {
  const template = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const composed = template.replace(INCLUDE, (_, name: string) => {
    const url = new URL(`./shared/${name}.md`, import.meta.url);
    if (!/^[a-z]+$/.test(name) || !existsSync(url)) throw new Error(`${file}: unknown shared block "${name}"`);
    return readFileSync(url, "utf8").trimEnd();
  });
  if (/<!--\s*include/.test(composed)) throw new Error(`${file}: malformed include marker`);
  return composed;
}

export function loadPrompt(file: PromptFile, names: ToolNames = canonicalToolNames,
  limits: WritingLimits = DEFAULT_WRITING_LIMITS): string {
  return renderLimits(renderToolNames(composePrompt(file), validateToolNames(names)), limits);
}
