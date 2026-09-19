import { existsSync, readFileSync } from "node:fs";

const INCLUDE = /<!-- include: ([a-z]+) -->/g;

/** A stage prompt with its shared blocks (`shared/<name>.md`) spliced in at `<!-- include: name -->`
 * markers; the hash callers compute covers the composed text. An unknown block name throws at load. */
export function loadPrompt(file: "noting.md" | "consolidation.md" | "dreaming.md"): string {
  const template = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  return template.replace(INCLUDE, (_, name: string) => {
    const url = new URL(`./shared/${name}.md`, import.meta.url);
    if (!existsSync(url)) throw new Error(`${file}: unknown shared block "${name}"`);
    return readFileSync(url, "utf8").trimEnd();
  });
}
