import { randomUUID } from "node:crypto";
import type { TriggerOrigin } from "../model/index.ts";
import type { Store, RunInput, Phase } from "./index.ts";

export interface LogicalTask { sessionId: number; phase: Phase; head: number; origin?: TriggerOrigin | null }
export type ExecutionOutcome = "success" | "failure" | "cancelled" | "conflict";
export const EXECUTIONS_SQL = `
CREATE TABLE IF NOT EXISTS task_executions (
  id TEXT PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id),
  phase TEXT NOT NULL CHECK(phase IN ('noting','consolidation','dreaming')),
  head INTEGER NOT NULL CHECK(head > 0),
  outcome TEXT CHECK(outcome IN ('success','failure','cancelled','conflict')),
  terminal_run INTEGER REFERENCES runs(id), reason TEXT, updated_at TEXT NOT NULL,
  origin_session_id INTEGER REFERENCES sessions(id), origin_entry_ids TEXT
);
CREATE INDEX IF NOT EXISTS idx_execution_task ON task_executions(session_id,phase,head);
CREATE TABLE IF NOT EXISTS execution_runs (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id), execution_id TEXT NOT NULL REFERENCES task_executions(id)
);
CREATE TABLE IF NOT EXISTS task_failures (
  session_id INTEGER NOT NULL REFERENCES sessions(id), phase TEXT NOT NULL CHECK(phase IN ('noting','consolidation','dreaming')),
  head INTEGER NOT NULL CHECK(head > 0), count INTEGER NOT NULL CHECK(count >= 0),
  last_reason TEXT, last_run_id INTEGER REFERENCES runs(id), updated_at TEXT NOT NULL,
  PRIMARY KEY(session_id,phase,head)
);
`;

/** Admission supplies the oldest selected stable member, never a leaf or an attempt id.
 * A refusal carries this identity back; it does not settle it. Unfinished executions remain
 * visible after interruption, without inferring a terminal outcome from an attempt audit. */
export function beginExecution(store: Store, task: LogicalTask, previous?: string): string {
  store.requireEnabled(task.sessionId);
  if (task.phase !== "noting" && task.phase !== "dreaming") throw new Error(`Unsupported live phase: ${task.phase}`);
  if (!Number.isSafeInteger(task.head) || task.head <= 0) throw new Error("Logical task requires a stable backlog head");
  if (previous !== undefined) {
    const row = store.db.prepare("SELECT * FROM task_executions WHERE id = ?").get(previous);
    if (!row || row.session_id !== task.sessionId || row.phase !== task.phase || row.head !== task.head || row.outcome !== null)
      throw new Error("Fallback must continue the same unsettled logical task");
    return previous;
  }
  const id = randomUUID(), origin = task.origin ?? null;
  store.db.prepare("INSERT INTO task_executions(id,session_id,phase,head,updated_at,origin_session_id,origin_entry_ids) VALUES (?,?,?,?,?,?,?)")
    .run(id, task.sessionId, task.phase, task.head, new Date().toISOString(), origin?.sessionId ?? null, origin ? JSON.stringify(origin.entryIds) : null);
  return id;
}

export function linkExecutionRun(store: Store, runId: number, input: RunInput): void {
  if (input.executionId === undefined) return;
  const row = store.db.prepare("SELECT * FROM task_executions WHERE id = ?").get(input.executionId);
  if (!row || row.session_id !== input.sessionId || row.phase !== input.kind || row.outcome !== null)
    throw new Error("Run requires its own unsettled execution");
  store.db.prepare("INSERT INTO execution_runs VALUES (?,?)").run(runId, input.executionId);
}

/** Caller owns the terminal decision. Attempt refusal/rejection must never call this method.
 * Dreamer calls it alongside completeDreaming in the final-check transaction, not at a write. */
export function settleExecution(store: Store, id: string, outcome: ExecutionOutcome, runId: number, reason = "", dreamingAuthority?: RunInput): { automaticOff?: string } {
  return store.transaction(() => {
    const row = store.db.prepare("SELECT * FROM task_executions WHERE id = ?").get(id);
    if (!row) throw new Error("Unknown execution");
    if (row.outcome !== null) return {}; // authoritative outcome wins over later observers/audit
    const run = store.getRun(runId);
    if (!run || !store.db.prepare("SELECT 1 FROM execution_runs WHERE execution_id = ? AND run_id = ?").get(id, runId))
      throw new Error("Terminal run must belong to the execution");
    // Only the core's live Dreamer capability can issue the exception. Public settlement,
    // a fabricated run outcome/response, or another run's capability cannot waive a failure.
    if (outcome === "conflict") {
      if (!dreamingAuthority || store.dreamingRunId(dreamingAuthority) !== runId || dreamingAuthority.executionId !== id || run.outcome !== "conflict")
        throw new Error("Conflict settlement requires the core Dreamer termination authority");
    }
    if (outcome === "success" && (run.outcome !== "success" || (row.phase === "dreaming" &&
        !store.db.prepare("SELECT 1 FROM dreaming_ranges WHERE completed_run = ? AND closed_at IS NOT NULL").get(runId))))
      throw new Error("Execution success requires established business completion");
    const now = new Date().toISOString();
    store.db.prepare("UPDATE task_executions SET outcome = ?, terminal_run = ?, reason = ?, updated_at = ? WHERE id = ?")
      .run(outcome, runId, reason, now, id);
    const key = [row.session_id!, row.phase!, row.head!] as const;
    if (outcome === "cancelled" || outcome === "conflict") return {};
    store.db.prepare(`INSERT INTO task_failures VALUES (?,?,?,?,?,?,?) ON CONFLICT(session_id,phase,head)
      DO UPDATE SET count = CASE WHEN excluded.count = 0 THEN 0 ELSE task_failures.count + 1 END,
      last_reason = excluded.last_reason, last_run_id = excluded.last_run_id, updated_at = excluded.updated_at`)
      .run(...key, outcome === "success" ? 0 : 1, reason, runId, now);
    const count = Number(store.db.prepare("SELECT count FROM task_failures WHERE session_id = ? AND phase = ? AND head = ?").get(...key)!.count);
    if (count !== 3 || !store.enabled(Number(row.session_id))) return {};
    store.setEnrollment(Number(row.session_id), false);
    // Off blocks new writes, but an admitted Dreamer still needs its exact token to settle
    // skipped/own revisions on cancellation, just as in ordinary stop/off handling.
    store.db.prepare(`UPDATE task_claims AS c SET expires_at = 0 WHERE session_id = ?
      AND NOT (phase = 'dreaming' AND reserved = 0 AND expires_at > ? AND EXISTS (
        SELECT 1 FROM dreaming_ranges r WHERE r.session_id = c.session_id AND r.claim_token = c.token
          AND r.pool IS NOT NULL AND r.completed_run IS NULL AND r.closed_at IS NULL))`).run(row.session_id!, Date.now());
    const runs = store.db.prepare(`SELECT terminal_run FROM task_executions WHERE session_id = ? AND phase = ? AND head = ?
      AND outcome = 'failure' ORDER BY updated_at DESC, rowid DESC LIMIT 3`).all(...key).reverse();
    return { automaticOff: `Trace Memory: S${row.session_id} ${row.phase} off after three failures (${runs.map(r => `R${r.terminal_run}`).join(", ")}); ${reason || "business completion failed"}. Use /trace on to resume.` };
  });
}
