import { tokens } from "./tokens.ts";
import { KNOWLEDGE_STATUS_TITLE } from "./material.ts";

/** Compatibility for carriers written before render-time accounting. Delimiters are not escaped:
 * an extra/misplaced marker makes the partition ambiguous, never evidence for a smaller charge.
 * This parses only accounting, never actual body membership or authority. */
export function legacyKnowledgeTokens(text: string, diagnose: (message: string) => void = console.warn): number {
  const ambiguous = () => {
    diagnose("Trace Memory: ambiguous legacy memory carrier; charging its entire content as Knowledge.");
    return tokens(text);
  };
  const sections: string[] = [];
  let rest = text, knowledgeSeen = false, episodicSeen = false;
  while (rest) {
    const block = rest.match(/^<(knowledge|episodic)>\n([\s\S]*?)\n<\/\1>(?=\n\n|$)/);
    if (block) {
      // Literal markers in legal bodies cannot be reliably distinguished from framing.
      if (/<\/?(?:knowledge|episodic)>/.test(block[2]!)) return ambiguous();
      if (block[1] === "knowledge") {
        if (knowledgeSeen || episodicSeen) return ambiguous();
        knowledgeSeen = true;
        sections.push(block[0]);
      } else episodicSeen = true;
      rest = rest.slice(block[0].length).replace(/^\n\n/, "");
      continue;
    }
    if (rest.startsWith(KNOWLEDGE_STATUS_TITLE + "\n")) {
      if (episodicSeen) return ambiguous();
      const end = rest.indexOf("\n\n");
      const status = end < 0 ? rest : rest.slice(0, end);
      if (/<\/?(?:knowledge|episodic)>/.test(status)) return ambiguous();
      sections.push(status);
      rest = end < 0 ? "" : rest.slice(end + 2);
      continue;
    }
    if (rest.startsWith("Receipts:\n")) {
      const lines = rest.slice("Receipts:\n".length).split("\n");
      if (lines.some(line => !/^omitted /.test(line) || /<\/?(?:knowledge|episodic)>/.test(line))) return ambiguous();
      const knowledge = lines.filter(line => /knowledge|\bK\d/.test(line));
      // Only known non-K omissions can be excluded. Unknown receipt families are conservative.
      if (lines.some(line => !knowledge.includes(line) && !/raw|Raw|facts|\b[FT]\d/.test(line))) return ambiguous();
      if (knowledge.length) sections.push("Receipts:\n" + knowledge.join("\n"));
      rest = "";
      continue;
    }
    return ambiguous();
  }
  return tokens(sections.join("\n\n"));
}
