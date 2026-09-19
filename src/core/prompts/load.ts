import { readFileSync } from "node:fs";

const MARKER = "<!-- categories -->";

/** A stage prompt with the shared category definitions spliced in at its marker; the hash callers compute covers the composed text. */
export function loadPrompt(file: "noting.md" | "consolidation.md" | "dreaming.md"): string {
  const template = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  if (!template.includes(MARKER)) return template;
  const categories = readFileSync(new URL("./categories.md", import.meta.url), "utf8").trimEnd();
  return template.replace(MARKER, categories);
}
