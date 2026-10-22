import { randomUUID } from "node:crypto";
import type { TriggerOrigin } from "../model/index.ts";
import type { Store, RunInput, Phase } from "./index.ts";
import { ALL_POOLS } from "./processing.ts";

/** A logical task: the target session, the phase and its backlog key. Noting's key is its oldest
 * pending entry (`head`). 126: the Dreamer's task is (session, Dreamer), stored under the fixed pool
 * key `ALL_POOLS`. Rows written before 104 keep their revision `head`; rows from 104 to 126 keep the
 * one pool they named. */
export interface LogicalTask { sessionId: number; phase: Phase; head?: number; origin?: TriggerOrigin | null }
/** 146 ruling 13 (supersedes 144 stage 5 §3.1's four-step rotation): one pair of curate operations per run. The curate agent of a group
 * proposes, item by item, one operation of the pair or none; the project's rotation (`Store.nextCuratePair`) alternates the pairs in this order. */
export const CURATE_PAIRS = { "update-archive": ["update", "archive"], "merge-split": ["merge", "split"] } as const;
export type CuratePair = keyof typeof CURATE_PAIRS;
export type CurateOperation = (typeof CURATE_PAIRS)[CuratePair][number];
export const CURATE_ROTATION = Object.keys(CURATE_PAIRS) as CuratePair[];
/** The pair a curate operation belongs to. */
export const curatePairOf = (operation: CurateOperation): CuratePair => CURATE_ROTATION.find(pair => (CURATE_PAIRS[pair] as readonly string[]).includes(operation))!;
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
-- 144: the first task of a two-task run has passed and the second has not. The row says which task is next and
-- names the first task's run, whose body holds the files; one row per session and phase, replaced by a later pass.
CREATE TABLE IF NOT EXISTS task_handoffs (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  phase TEXT NOT NULL CHECK (phase IN ('noting','dreaming')),
  next_task TEXT NOT NULL,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  branch TEXT, entry_ids TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, phase)
);
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

/** 126: a session's per-pool Dreamer streaks become its one Dreamer streak, at the largest of their
 * counts, keeping that row's last reason and run. Executions keep the pool they ran under. Runs inside
 * Store's schema transaction, after `EXECUTIONS_SQL`: concurrent openers serialize there, and an open
 * that finds no per-pool streak changes nothing. */
export function migrateDreamerTask126(store: Store): void {
  const perPool = "phase = 'dreaming' AND pool IS NOT NULL";
  if (!store.db.prepare(`SELECT 1 FROM task_failures WHERE ${perPool} AND pool != ? LIMIT 1`).get(ALL_POOLS)) return;
  // SQLite takes the bare columns from the row holding MAX(count).
  const streaks = store.db.prepare(`SELECT session_id, MAX(count) AS count, last_reason, last_run_id, updated_at
    FROM task_failures WHERE ${perPool} GROUP BY session_id`).all();
  store.db.prepare(`DELETE FROM task_failures WHERE ${perPool}`).run();
  const insert = store.db.prepare(`INSERT INTO task_failures(session_id,phase,head,pool,count,last_reason,last_run_id,updated_at)
    VALUES (?,'dreaming',NULL,?,?,?,?,?)`);
  for (const row of streaks) insert.run(row.session_id!, ALL_POOLS, row.count!, row.last_reason ?? null, row.last_run_id ?? null, row.updated_at!);
}

/** Admission supplies the oldest selected stable member, never a leaf or an attempt id.
 * A refusal carries this identity back; it does not settle it. Unfinished executions remain
 * visible after interruption, without inferring a terminal outcome from an attempt audit. */
export function beginExecution(store: Store, task: LogicalTask): string {
  store.requireEnabled(task.sessionId);
  if (task.phase !== "noting" && task.phase !== "dreaming") throw new Error(`Unsupported live phase: ${task.phase}`);
  const head = task.phase === "noting" ? task.head ?? null : null, pool = task.phase === "dreaming" ? ALL_POOLS : null;
  if (task.phase === "noting" ? !Number.isSafeInteger(head) || head! <= 0 : task.head !== undefined)
    throw new Error(task.phase === "noting" ? "Logical task requires a stable backlog head" : "Dreamer logical task has no backlog head");
  const id = randomUUID(), origin = task.origin ?? null;
  store.db.prepare("INSERT INTO task_executions(id,session_id,phase,head,pool,updated_at,origin_session_id,origin_entry_ids) VALUES (?,?,?,?,?,?,?,?)")
    .run(id, task.sessionId, task.phase, head, pool, new Date().toISOString(), origin?.sessionId ?? null, origin ? JSON.stringify(origin.entryIds) : null);
  return id;
}

/** What a passed first task leaves for the second: the files live in the first task's run body, so a restarted or
 * borrowing executor finds them with this one indexed read. */
export interface Handoff { sessionId: number; phase: "noting" | "dreaming"; nextTask: string; runId: number; branch: string | null; entryIds: number[]; createdAt: string;
  /** Dreamer rows only (146 §3.4): the pair a resumed run repeats and, once a task has committed, the run's groups frozen as knowledge ids.
   * `run` on a batch is the kept run of its file; `verifyRun` is the group's applied verify. */
  detail?: HandoffDetail }
export interface HandoffDetail { pair?: CuratePair; groups?: { batches: { category: string; items: number[]; run?: number }[]; verifyRun?: number }[] }
export function readHandoff(store: Store, sessionId: number, phase: Handoff["phase"]): Handoff | null {
  const row = store.db.prepare("SELECT * FROM task_handoffs WHERE session_id = ? AND phase = ?").get(sessionId, phase);
  return row ? { sessionId, phase, nextTask: String(row.next_task), runId: Number(row.run_id), branch: row.branch === null ? null : String(row.branch),
    entryIds: row.entry_ids === null ? [] : JSON.parse(String(row.entry_ids)) as number[], createdAt: String(row.created_at),
    ...(row.detail === null ? {} : { detail: JSON.parse(String(row.detail)) as NonNullable<Handoff["detail"]> }) } : null;
}
export function writeHandoff(store: Store, handoff: Omit<Handoff, "createdAt">): void {
  store.db.prepare("INSERT OR REPLACE INTO task_handoffs(session_id,phase,next_task,run_id,branch,entry_ids,created_at,detail) VALUES (?,?,?,?,?,?,?,?)")
    .run(handoff.sessionId, handoff.phase, handoff.nextTask, handoff.runId, handoff.branch, JSON.stringify(handoff.entryIds), new Date().toISOString(),
      handoff.detail ? JSON.stringify(handoff.detail) : null);
}
/** A publication that processed any entry of the hand-off's batch ends the hand-off: the rest of that batch can no longer be taken whole. */
export function dropHandoffCovering(store: Store, sessionId: number, phase: Handoff["phase"], entryIds: readonly number[]): void {
  if (entryIds.length) store.db.prepare(`DELETE FROM task_handoffs WHERE session_id = ? AND phase = ? AND EXISTS (
    SELECT 1 FROM json_each(task_handoffs.entry_ids) WHERE value IN (SELECT value FROM json_each(?)))`).run(sessionId, phase, JSON.stringify(entryIds));
}

export function linkExecutionRun(store: Store, runId: number, input: RunInput): void {
  if (input.executionId === undefined) return;
  const row = store.db.prepare("SELECT * FROM task_executions WHERE id = ?").get(input.executionId);
  if (!row || row.session_id !== input.sessionId || row.phase !== input.kind || row.outcome !== null)
    throw new Error("Run requires its own unsettled execution");
  store.db.prepare("INSERT INTO execution_runs VALUES (?,?)").run(runId, input.executionId);
}

/** What a failed Dreamer task tells settlement: the task that failed, and the pair a resumed run repeats. */
export interface TaskFailure { task: string; pair?: CuratePair }

/** Caller owns the terminal decision.
 * Dreamer calls it alongside completeDreaming in the final-check transaction, not at a write. */
export function settleExecution(store: Store, id: string, outcome: ExecutionOutcome, runId: number, reason = "", failure?: TaskFailure): { automaticOff?: string } {
  return store.transaction(() => {
    const row = store.db.prepare("SELECT * FROM task_executions WHERE id = ?").get(id);
    if (!row) throw new Error("Unknown execution");
    if (row.outcome !== null) return {}; // authoritative outcome wins over later observers/audit
    const run = store.getRun(runId);
    if (!run || !store.db.prepare("SELECT 1 FROM execution_runs WHERE execution_id = ? AND run_id = ?").get(id, runId))
      throw new Error("Terminal run must belong to the execution");
    // `conflict` is the retired Dreamer exception: only old rows carry it, and nothing settles a new run that way.
    if (outcome === "conflict") throw new Error("Conflict settlement is retired");
    // 144 stage 4 §3.2: a Dreamer run is complete when its last run is a classify pass (or the no-work classify run) and no
    // hand-off remains for the session.
    const dreamerDone = () => JSON.parse(run!.response ?? "{}").task === "classify" && !store.handoff(Number(row.session_id), "dreaming");
    if (outcome === "success" && (run.outcome !== "success" || (row.phase === "dreaming" && !dreamerDone())))
      throw new Error("Execution success requires established business completion");
    const now = new Date().toISOString();
    store.db.prepare("UPDATE task_executions SET outcome = ?, terminal_run = ?, reason = ?, updated_at = ? WHERE id = ?")
      .run(outcome, runId, reason, now, id);
    const key = [row.session_id!, row.phase!, row.head ?? null, row.pool ?? null] as const;
    const task = "session_id = ? AND phase = ? AND head IS ? AND pool IS ?";
    if (outcome === "cancelled") return {};
    // 144 stage 5 §3.2: a Dreamer run whose final commit wrote `finished` is complete. A failure after it is recorded above and
    // nothing more: no hand-off is recreated and the retry counter stays as the commit reset it (Q14: not counted).
    if (outcome === "failure" && row.phase === "dreaming" && store.db.prepare(`SELECT 1 FROM execution_runs er JOIN run_bodies b ON b.run_id = er.run_id
      WHERE er.execution_id = ? AND json_extract(b.response, '$.finished') IS NOT NULL`).get(id)) {
      store.db.prepare("UPDATE task_executions SET reason = ? WHERE id = ?").run(`${reason}, run already finished`, id);
      return {};
    }
    // 144 stage 4 §3.4: the counter and the hand-off belong to the latest execution admitted for this task key. A later
    // row, still running or already finished, took the cycle over; this one writes only its own row.
    if (store.db.prepare(`SELECT 1 FROM task_executions WHERE ${task} AND rowid > (SELECT rowid FROM task_executions WHERE id = ?)`).get(...key, id)) return {};
    const counted = store.db.prepare(`UPDATE task_failures SET count = CASE WHEN ? THEN 0 ELSE count + 1 END,
      last_reason = ?, last_run_id = ?, updated_at = ? WHERE ${task}`).run(Number(outcome === "success"), reason, runId, now, ...key);
    if (!counted.changes) store.db.prepare(`INSERT INTO task_failures(session_id,phase,head,pool,count,last_reason,last_run_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(...key, outcome === "success" ? 0 : 1, reason, runId, now);
    if (row.phase === "dreaming" && outcome === "failure") keepDreamerRetry(store, Number(row.session_id), runId, failure);
    // 146 (maintainer, 2026-10-22): the Dreamer's streak works like the Noter's; the third consecutive failure switches memory off.
    const count = Number(store.db.prepare(`SELECT count FROM task_failures WHERE ${task}`).get(...key)!.count);
    if (count !== 3 || !store.enabled(Number(row.session_id))) return {};
    store.setEnrollment(Number(row.session_id), false);
    store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE session_id = ?").run(row.session_id!);
    const runs = store.db.prepare(`SELECT terminal_run FROM task_executions WHERE ${task}
      AND outcome = 'failure' ORDER BY updated_at DESC, rowid DESC LIMIT 3`).all(...key).reverse();
    return { automaticOff: `Trace Memory: S${row.session_id} ${row.phase} off after three failures (${runs.map(r => `R${r.terminal_run}`).join(", ")}); ${reason || "business completion failed"}. Use /trace on to resume.` };
  });
}

/** 146 §7: a failed Dreamer run leaves a hand-off whose next task is the one it stopped at (the first failure of a run that kept nothing creates
 * the row). Dreaming is due while a hand-off exists, so the next entry-end check resumes there: no wait for a threshold, and the Noter-operation
 * count and the failure streak are not touched here. */
function keepDreamerRetry(store: Store, sessionId: number, runId: number, failure: TaskFailure | undefined): void {
  const handoff = store.handoff(sessionId, "dreaming");
  const detail = { ...handoff?.detail, ...(handoff?.detail?.pair || !failure?.pair ? {} : { pair: failure.pair }) };
  writeHandoff(store, { sessionId, phase: "dreaming", nextTask: handoff?.nextTask ?? failure?.task ?? "curate", runId: handoff?.runId ?? runId, branch: null, entryIds: [], detail });
}
