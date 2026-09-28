import { randomUUID } from "node:crypto";
import type { TriggerOrigin } from "../model/index.ts";
import type { Store, RunInput, Phase } from "./index.ts";

/** A logical task: the target session, the phase and its backlog key. Noting's key is its oldest
 * pending entry (`head`); since 104 the Dreamer's is its pool, and `head` stays empty. Rows written
 * before 104 keep their revision `head` and no pool. */
export interface LogicalTask { sessionId: number; phase: Phase; head?: number; pool?: string; origin?: TriggerOrigin | null }
export type ExecutionOutcome = "success" | "failure" | "cancelled" | "conflict";
const TASK_KEY_SQL = `head INTEGER CHECK(head > 0), pool TEXT CHECK(pool IS NULL OR phase = 'dreaming' AND head IS NULL)`;
export const TASK_EXECUTIONS_TABLE = `CREATE TABLE IF NOT EXISTS task_executions (
  id TEXT PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id),
  phase TEXT NOT NULL CHECK(phase IN ('noting','consolidation','dreaming')),
  ${TASK_KEY_SQL},
  outcome TEXT CHECK(outcome IN ('success','failure','cancelled','conflict')),
  terminal_run INTEGER REFERENCES runs(id), reason TEXT, updated_at TEXT NOT NULL,
  origin_session_id INTEGER REFERENCES sessions(id), origin_entry_ids TEXT,
  CHECK(head IS NOT NULL OR pool IS NOT NULL)
)`;
export const TASK_FAILURES_TABLE = `CREATE TABLE IF NOT EXISTS task_failures (
  session_id INTEGER NOT NULL REFERENCES sessions(id), phase TEXT NOT NULL CHECK(phase IN ('noting','consolidation','dreaming')),
  ${TASK_KEY_SQL}, count INTEGER NOT NULL CHECK(count >= 0),
  last_reason TEXT, last_run_id INTEGER REFERENCES runs(id), updated_at TEXT NOT NULL,
  CHECK(head IS NOT NULL OR pool IS NOT NULL)
)`;
export const EXECUTIONS_SQL = `
${TASK_EXECUTIONS_TABLE};
CREATE INDEX IF NOT EXISTS idx_execution_task ON task_executions(session_id,phase,head,pool);
CREATE TABLE IF NOT EXISTS execution_runs (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id), execution_id TEXT NOT NULL REFERENCES task_executions(id)
);
${TASK_FAILURES_TABLE};
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_failure_head ON task_failures(session_id,phase,head) WHERE head IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_failure_pool ON task_failures(session_id,phase,pool) WHERE pool IS NOT NULL;
`;

/** 104: give an existing database the pool key, keeping every row as it was. Runs inside Store's
 * schema transaction, foreign keys off, before `EXECUTIONS_SQL` creates the new indexes. */
export function migrateTaskPool104(store: Store, rebuild: (table: string, createSql: string) => void): void {
  const columns = (table: string) => (store.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
  const executions = columns("task_executions"), failures = columns("task_failures");
  if (executions.length && !executions.includes("pool")) rebuild("task_executions", TASK_EXECUTIONS_TABLE);
  if (failures.length && !failures.includes("pool")) rebuild("task_failures", TASK_FAILURES_TABLE);
}

/** Admission supplies the oldest selected stable member, never a leaf or an attempt id.
 * A refusal carries this identity back; it does not settle it. Unfinished executions remain
 * visible after interruption, without inferring a terminal outcome from an attempt audit. */
export function beginExecution(store: Store, task: LogicalTask, previous?: string): string {
  store.requireEnabled(task.sessionId);
  if (task.phase !== "noting" && task.phase !== "dreaming") throw new Error(`Unsupported live phase: ${task.phase}`);
  const head = task.phase === "noting" ? task.head ?? null : null, pool = task.phase === "dreaming" ? task.pool ?? null : null;
  if (task.phase === "noting" ? !Number.isSafeInteger(head) || head! <= 0 || task.pool !== undefined : !pool || task.head !== undefined)
    throw new Error(task.phase === "noting" ? "Logical task requires a stable backlog head" : "Dreamer logical task requires its pool");
  if (previous !== undefined) {
    const row = store.db.prepare("SELECT * FROM task_executions WHERE id = ?").get(previous);
    if (!row || row.session_id !== task.sessionId || row.phase !== task.phase || row.head !== head || row.pool !== pool || row.outcome !== null)
      throw new Error("Fallback must continue the same unsettled logical task");
    return previous;
  }
  const id = randomUUID(), origin = task.origin ?? null;
  store.db.prepare("INSERT INTO task_executions(id,session_id,phase,head,pool,updated_at,origin_session_id,origin_entry_ids) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, task.sessionId, task.phase, head, pool, new Date().toISOString(), origin?.sessionId ?? null, origin ? JSON.stringify(origin.entryIds) : null);
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
    const key = [row.session_id!, row.phase!, row.head ?? null, row.pool ?? null] as const;
    const task = "session_id = ? AND phase = ? AND head IS ? AND pool IS ?";
    if (outcome === "cancelled" || outcome === "conflict") return {};
    const counted = store.db.prepare(`UPDATE task_failures SET count = CASE WHEN ? THEN 0 ELSE count + 1 END,
      last_reason = ?, last_run_id = ?, updated_at = ? WHERE ${task}`).run(Number(outcome === "success"), reason, runId, now, ...key);
    if (!counted.changes) store.db.prepare(`INSERT INTO task_failures(session_id,phase,head,pool,count,last_reason,last_run_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(...key, outcome === "success" ? 0 : 1, reason, runId, now);
    const count = Number(store.db.prepare(`SELECT count FROM task_failures WHERE ${task}`).get(...key)!.count);
    if (count !== 3 || !store.enabled(Number(row.session_id))) return {};
    store.setEnrollment(Number(row.session_id), false);
    // Off blocks new writes, but an admitted Dreamer still needs its exact token to settle
    // skipped/own revisions on cancellation, just as in ordinary stop/off handling.
    store.db.prepare(`UPDATE task_claims AS c SET expires_at = 0 WHERE session_id = ?
      AND NOT (phase = 'dreaming' AND reserved = 0 AND expires_at > ? AND EXISTS (
        SELECT 1 FROM dreaming_ranges r WHERE r.session_id = c.session_id AND r.claim_token = c.token
          AND r.pool IS NOT NULL AND r.completed_run IS NULL AND r.closed_at IS NULL))`).run(row.session_id!, Date.now());
    const runs = store.db.prepare(`SELECT terminal_run FROM task_executions WHERE ${task}
      AND outcome = 'failure' ORDER BY updated_at DESC, rowid DESC LIMIT 3`).all(...key).reverse();
    return { automaticOff: `Trace Memory: S${row.session_id} ${row.phase} off after three failures (${runs.map(r => `R${r.terminal_run}`).join(", ")}); ${reason || "business completion failed"}. Use /trace on to resume.` };
  });
}
