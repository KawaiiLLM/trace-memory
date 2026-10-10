import { renderToolNames, validateToolNames, type ToolNames } from "../prompts/tool-names.ts";

/** Ticket 137: when to look memory up, kept apart from the reading guide (which teaches only the
 * format). One source text; each host fills in the search tool name it actually exposes and places
 * the result once in the system prompt of the run that needs it. */
const RETRIEVAL_POLICY = `When to look up memory: only when the answer would change your next step. Do not open every listed address.
- Before asking the user something that may already be recorded.
- When the user refers to earlier work, or something seems familiar, that is not in view.
- When a knowledge item or fact title bears on a decision but is too compressed to act on: read its supporting facts, then the raw entries they cite.
- When you need exact wording, values, paths, commands, errors or commits behind a remembered claim, or the user asks why you believe it.
- Before stating what the user decided: follow the supports down to the user's own words.
Find topics and exact strings with {{tool.search}}; pass code to filter its hits.
Memory is a past record: open items may be stale, and current files, tool output and the user's latest message win when they conflict.`;

export function retrievalPolicy(names: ToolNames): string {
  return renderToolNames(RETRIEVAL_POLICY, validateToolNames(names));
}

/** A fresh worker's system prompt: its domain instructions, then the policy. */
export const withRetrievalPolicy = (instructions: string, names: ToolNames) => `${instructions}\n\n${retrievalPolicy(names)}`;
