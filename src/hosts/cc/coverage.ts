import { classifySourceRecord, type CcNativeRecord } from "./transcript.ts";
import { ccOriginalRaw, type CcOriginalCandidate } from "./coverage-original.ts";

export interface CcRawCandidate { nativeId: string; record: CcNativeRecord; afterBoundary: boolean }

/** Only independently retained original source blocks establish CC fork coverage.
 * Raw represented solely by a compact carrier uses fresh Noting. */
export function ccInheritedRaw(selected: readonly CcRawCandidate[], api: unknown): Map<string, "source"> {
  const originals: CcOriginalCandidate[] = selected.map(entry => ({ ...entry,
    kind: classifySourceRecord(entry.record)?.kind ?? "compaction" }));
  return ccOriginalRaw(originals, api);
}
