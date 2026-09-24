import type { CcSessionBinding } from "./binding.ts";
import { selectedCcVisibleRecords } from "./injection.ts";
import type { CcNativeRecord } from "./transcript.ts";

export interface CcContextEvidence {
  presence: "confirmed" | "unavailable";
  reason?: string;
  estimatedMessagesTokens?: number;
  memory?: { knowledge: number; facts: number; raw: number; unclassified: number };
}

/** The native retention resolver is authoritative for source ancestry, but a JSONL attachment's
 * `content` is NOT proof of the bytes Claude Code admitted to Messages: long additionalContext is
 * replaced by a preview and file reference, and synthetic prompt snapshots have no one-to-one
 * transcript counterpart. Return unknown until the current carrier's rendered bytes AND all current
 * Messages text are proven from the same context. Never substitute the full body/DB injection. */
export function ccContextEvidence(records: readonly CcNativeRecord[], _binding: CcSessionBinding,
  _dbPath: string): CcContextEvidence {
  try { selectedCcVisibleRecords(records); }
  catch (error) { return { presence: "unavailable", reason: error instanceof Error ? error.message : String(error) }; }
  return { presence: "unavailable", reason: "Native transcript cannot prove exact current Messages denominator and rendered hook previews" };
}
