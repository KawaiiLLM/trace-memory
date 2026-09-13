import type { ChargedWindows, MemoryComposition, SuppliedMaterial } from "../../core/api/index.ts";

/** Synchronous request/reply channel shared by Pi extension instances. */
export const CURRENT_CONTEXT_SNAPSHOT_EVENT = "trace-memory:current-context-snapshot:v1";
export const CURRENT_CONTEXT_SNAPSHOT_VERSION = 1 as const;

export interface CurrentContextSourceEntry {
  id: number;
  nativeLineage: string;
  nativeId: string;
  turnId: number;
}

export interface CurrentContextSnapshot {
  available: true;
  node: {
    nativeSessionId: string;
    nativeLeafId: string;
    memorySessionId: number;
    projectId: number;
    branch: string;
    headTurnId: number;
    /** Exact persisted source membership used to render this result, in ancestry order. */
    sourceEntries: CurrentContextSourceEntry[];
  };
  text: string;
  estimatedTokens: number;
  composition: MemoryComposition;
  charged: ChargedWindows;
  supplied: SuppliedMaterial;
}

export type CurrentContextSnapshotUnavailableReason =
  | "missing-provider"
  | "provider-conflict"
  | "not-initialized"
  | "closed"
  | "disabled"
  | "node-not-ready"
  | "capacity"
  | "data-error";

export interface CurrentContextSnapshotUnavailable {
  available: false;
  reason: CurrentContextSnapshotUnavailableReason;
  message: string;
  /** The allocator's contributing required windows, when it refused capacity. */
  over?: { knowledge: boolean; facts: boolean; raw: boolean };
}

export type CurrentContextSnapshotProviderResult = CurrentContextSnapshot
  | (Omit<CurrentContextSnapshotUnavailable, "reason"> & {
      reason: Exclude<CurrentContextSnapshotUnavailableReason, "missing-provider" | "provider-conflict">;
    });
export type CurrentContextSnapshotResult = CurrentContextSnapshot | CurrentContextSnapshotUnavailable;

export interface CurrentContextSnapshotRequest {
  version: typeof CURRENT_CONTEXT_SNAPSHOT_VERSION;
  reply(result: CurrentContextSnapshotProviderResult): void;
}

export interface SnapshotEventBus {
  emit(channel: string, data: unknown): void;
}

/**
 * Request the active Trace Memory extension's current-node snapshot. Providers reply during the
 * synchronous event dispatch. No reply therefore means no provider; multiple replies mean that stale
 * or duplicate providers are registered. Neither case waits on a timer or guesses a result.
 */
export function requestCurrentContextSnapshot(events: SnapshotEventBus): CurrentContextSnapshotResult {
  const replies: CurrentContextSnapshotProviderResult[] = [];
  let accepting = true;
  const request: CurrentContextSnapshotRequest = {
    version: CURRENT_CONTEXT_SNAPSHOT_VERSION,
    reply(result) {
      if (accepting) replies.push(result);
    },
  };
  events.emit(CURRENT_CONTEXT_SNAPSHOT_EVENT, request);
  accepting = false;
  if (!replies.length) return { available: false, reason: "missing-provider", message: "Trace Memory current-context snapshot provider is not registered" };
  if (replies.length > 1) return { available: false, reason: "provider-conflict", message: `Trace Memory current-context snapshot received ${replies.length} provider replies` };
  return replies[0]!;
}

export function isCurrentContextSnapshotRequest(value: unknown): value is CurrentContextSnapshotRequest {
  if (!value || typeof value !== "object") return false;
  const request = value as Partial<CurrentContextSnapshotRequest>;
  return request.version === CURRENT_CONTEXT_SNAPSHOT_VERSION && typeof request.reply === "function";
}
