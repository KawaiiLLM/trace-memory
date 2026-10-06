import type { ToolNames } from "../prompts/tool-names.ts";

/** Tickets 118 (rulings 10–12) and 128: one shared guide; only native names and session vary. */
export function readingGuide(sessionId: number | undefined, names: ToolNames): string {
  const session = sessionId === undefined ? "<n>" : String(sessionId);
  return `Memory is read at trace:// addresses with ${names.read}${names.grep === undefined ? "" : ` or ${names.grep}`}, never a shell command. trace:// lists every address.
Address: trace://<layer>/S<n>/T<t>. Without /T<t>: the session's current head.
Layers: knowledge (what a fresh context there receives), compact (what compaction there injects), facts (the Turn's facts), raw (its Raw overview).
raw only: #E<k> gives one full entry and @role keeps one role, e.g. citation T12#E3@assistant of S7 is trace://raw/S7/T12#E3@assistant.
trace://K<id>, trace://F<id>: one knowledge item or fact.
Give a subagent trace://knowledge/S${session} for background or trace://compact/S${session} to continue, and tell it to use ${names.read}.`;
}
