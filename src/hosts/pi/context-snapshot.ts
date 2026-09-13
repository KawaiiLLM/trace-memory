import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { MemoryComposition, SuppliedMaterial } from "../../core/api/index.ts";

export const CURRENT_CONTEXT_SNAPSHOT_EVENT = "trace-memory:current-context-snapshot:v1";

export type CurrentContextSnapshotResult = {
  available: true;
  node: { nativeSessionId: string; nativeLeafId: string };
  text: string;
  estimatedTokens: number;
  composition: MemoryComposition;
  supplied: SuppliedMaterial;
} | {
  available: false;
  reason: "missing-provider" | "provider-conflict" | "not-initialized" | "closed"
    | "disabled" | "node-not-ready" | "capacity" | "data-error";
  message: string;
};

/** The payload is a reply callback; providers must reply synchronously on the caller's event bus. */
export function requestCurrentContextSnapshot(events: Pick<EventBus, "emit">): CurrentContextSnapshotResult {
  const replies: CurrentContextSnapshotResult[] = [];
  events.emit(CURRENT_CONTEXT_SNAPSHOT_EVENT, (result: CurrentContextSnapshotResult) => replies.push(result));
  if (!replies.length) return { available: false, reason: "missing-provider", message: "Trace Memory snapshot provider is not registered" };
  if (replies.length > 1) return { available: false, reason: "provider-conflict", message: "Multiple Trace Memory snapshot providers replied" };
  return replies[0]!;
}
