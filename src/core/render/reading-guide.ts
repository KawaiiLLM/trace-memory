import type { ToolNames } from "../prompts/tool-names.ts";

/** Ticket 118 rulings 10–12: one shared guide; only native names and session vary. */
export function readingGuide(sessionId: number | undefined, names: ToolNames): string {
  const session = sessionId === undefined ? "<n>" : String(sessionId);
  return `Memory is at /tm: virtual, so use ${names.read} or ${names.grep}, never a shell command. /tm lists every path.
Path: /tm/<layer>/S<n>/T<t>. Without /T<t>: the session's current head.
Layers: knowledge (what a fresh context there receives), compact (what compaction there injects), facts (the Turn's facts), raw (its Raw overview).
raw only: #E<k> gives one full entry and @role keeps one role, e.g. citation T12#E3@assistant of S7 is /tm/raw/S7/T12#E3@assistant.
/tm/K<id>, /tm/F<id>: one knowledge item or fact.
Give a subagent /tm/knowledge/S${session} for background or /tm/compact/S${session} to continue, and tell it to use ${names.read}.`;
}
