import type { RunAgentResult } from "./index.ts";
import type { RunInput, Store } from "../store/index.ts";

/** How both phases finalize the run audit of one provider attempt. The business commits and the
 * review protocols stay in the phases; what a run record says about the attempt is one rule here,
 * because two copies of it had already drifted (maintainability audit finding 1). */

/** The provider exception both phases record: an aborted run is a cancellation, anything else failed. */
export const agentException = (error: unknown): RunAgentResult =>
  ({ outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure",
    output: error instanceof Error ? error.message : String(error) });

/** A run that owes core the exact provider request and returned none. A host that declares it cannot
 * expose requests (`audit.available === false`) owes none; core records that limitation instead. */
export const requestMissing = (result: RunAgentResult) => result.request == null && result.audit?.available !== false;

/** Writes one attempt onto the frozen run record: the mode that ran, the request, the usage and the
 * host's optional metadata; `body` carries the phase's own response fields, in its own order.
 * The request rule: a result replaces the reported request only when it carries one, so a host that
 * reported one through `reportRequest` and then failed with `request: null` keeps what it reported
 * (the Noter used to overwrite it with `null`). Whether that is a problem is each phase's judgement. */
export function recordAttempt(run: RunInput, result: RunAgentResult, requestedMode: "fork" | "subagent", body: Record<string, unknown>) {
  run.mode = result.mode ?? requestedMode;
  if (result.request != null) run.request = JSON.stringify(result.request);
  run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null,
    // A cancelled run's usage is partial, and absent usage is unknown, never zero (review 2026-09-08).
    ...(result.outcome === "cancelled" ? { usageStatus: result.usage == null ? "unknown" : "partial" } : {}),
    ...body, requestedMode,
    ...(result.audit !== undefined ? { audit: result.audit } : {}),
    ...(result.verification !== undefined ? { verification: result.verification } : {}),
    ...(result.nativeLog !== undefined ? { nativeLog: result.nativeLog } : {}),
    ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
    ...(result.retries?.length ? { retries: result.retries } : {}) });
}

/** The audit update that follows a business commit: the batch is committed, so a failure to write its
 * audit record joins the run's problems and is never a business failure. */
export function updateCommitted(store: Store, runId: number, run: RunInput, problems: string[]): string[] {
  const after = [...problems];
  try { store.updateRun(runId, { ...run, outcome: "success" }); }
  catch (error) { after.push(`audit update failed after commit: ${String(error)}`); }
  return after;
}
