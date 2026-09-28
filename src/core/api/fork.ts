import type { VisibleView } from "./visible.ts";

/** The host supplies its native context view and exact-node publication verdict; core owns the
 * selection and checks the same oldest batch it will freeze when pending has an absent entry. */
export function selectNotingMode(input: {
  requested: "fork" | "subagent";
  suppression?: string;
  publicationPending: boolean;
  visible: VisibleView;
  pending: () => readonly { id: number; nativeId: string; turnId: number }[];
  batch: () => readonly { id: number; nativeId: string; turnId: number }[];
}): { effectiveMode: "fork" | "subagent"; fallbackReason?: string } {
  if (input.requested !== "fork") return { effectiveMode: "subagent" };
  const fallback = (reason: string) => ({ effectiveMode: "subagent" as const, fallbackReason: reason });
  if (input.suppression) return fallback(input.suppression);
  if (input.publicationPending) return fallback("Knowledge publication: ordinary deliverable material has not landed in the exact parent context");
  if (!input.visible.raw.size)
    return fallback("Raw availability: the selected context holds no conversation entry of ours, so nothing establishes that this task's evidence is inherited");
  if (!input.pending().some(entry => !input.visible.raw.has(entry.nativeId))) return { effectiveMode: "fork" };
  const missing = input.batch().find(entry => !input.visible.raw.has(entry.nativeId));
  return missing ? fallback(`Raw availability: entry ${missing.id} (T${missing.turnId}, native ${missing.nativeId}) of this batch is not in the inherited context: no original source or bounded carrier is retained`)
    : { effectiveMode: "fork" };
}
