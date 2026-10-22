import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { Store } from "../../../src/core/store/index.ts";
import { ALL_POOLS } from "../../../src/core/store/processing.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** A database whose execution tables still have the pre-104 shape: every task keyed by a head. */
function legacyDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "tm-logical-task-migration-")); dirs.push(dir);
  const file = join(dir, "trace.db"), store = new Store(file);
  const project = store.createProject({ name: "legacy", declaredBy: "mark" });
  const session = store.createSession({ host: "legacy", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const noting = store.recordRun({ kind: "noting", sessionId: session.id, outcome: "failure", createdAt: "old" });
  const dreaming = store.recordRun({ kind: "dreaming", sessionId: session.id, outcome: "failure", createdAt: "old" });
  store.close();
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA foreign_keys = OFF;
    DROP TABLE execution_runs; DROP TABLE task_executions; DROP TABLE task_failures;
    CREATE TABLE task_executions (
      id TEXT PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id),
      phase TEXT NOT NULL CHECK(phase IN ('noting','consolidation','dreaming')),
      head INTEGER NOT NULL CHECK(head > 0),
      outcome TEXT CHECK(outcome IN ('success','failure','cancelled','conflict')),
      terminal_run INTEGER REFERENCES runs(id), reason TEXT, updated_at TEXT NOT NULL,
      origin_session_id INTEGER REFERENCES sessions(id), origin_entry_ids TEXT);
    CREATE INDEX idx_execution_task ON task_executions(session_id,phase,head);
    CREATE TABLE execution_runs (run_id INTEGER PRIMARY KEY REFERENCES runs(id), execution_id TEXT NOT NULL REFERENCES task_executions(id));
    CREATE TABLE task_failures (
      session_id INTEGER NOT NULL REFERENCES sessions(id), phase TEXT NOT NULL CHECK(phase IN ('noting','consolidation','dreaming')),
      head INTEGER NOT NULL CHECK(head > 0), count INTEGER NOT NULL CHECK(count >= 0),
      last_reason TEXT, last_run_id INTEGER REFERENCES runs(id), updated_at TEXT NOT NULL,
      PRIMARY KEY(session_id,phase,head));`);
  db.prepare("INSERT INTO task_executions VALUES ('n', ?, 'noting', 5, 'failure', ?, 'noting failed', 'old', NULL, NULL)").run(session.id, noting.id);
  db.prepare("INSERT INTO task_executions VALUES ('d', ?, 'dreaming', 7, 'failure', ?, 'dreamer failed', 'old', NULL, NULL)").run(session.id, dreaming.id);
  db.prepare("INSERT INTO execution_runs VALUES (?, 'n'), (?, 'd')").run(noting.id, dreaming.id);
  db.prepare("INSERT INTO task_failures VALUES (?, 'noting', 5, 2, 'noting failed', ?, 'old'), (?, 'dreaming', 7, 3, 'dreamer failed', ?, 'old')")
    .run(session.id, noting.id, session.id, dreaming.id);
  db.close();
  return { file, sessionId: session.id };
}

test("104: an existing database gains the Dreamer's pool key with every execution and streak kept as it was", () => {
  const f = legacyDatabase();
  let store = new Store(f.file);
  try {
    expect(store.db.prepare("SELECT id, phase, head, pool, outcome, reason FROM task_executions ORDER BY id").all()).toEqual([
      { id: "d", phase: "dreaming", head: 7, pool: null, outcome: "failure", reason: "dreamer failed" },
      { id: "n", phase: "noting", head: 5, pool: null, outcome: "failure", reason: "noting failed" }]);
    expect(store.taskFailures(f.sessionId).map(({ phase, head, pool, count }) => ({ phase, head, pool, count }))).toEqual([
      { phase: "dreaming", head: 7, pool: null, count: 3 }, { phase: "noting", head: 5, pool: null, count: 2 }]);
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'idx_execution_task'").get()!.sql)).toContain("pool");
    expect(() => store.beginExecution({ sessionId: f.sessionId, phase: "dreaming", head: 9 })).toThrow("Dreamer logical task has no backlog head");
    const schema = store.db.prepare("PRAGMA schema_version").get()!.schema_version;
    store.close(); store = new Store(f.file);
    expect(store.db.prepare("PRAGMA schema_version").get()!.schema_version).toBe(schema);
    expect(store.taskFailures(f.sessionId)).toHaveLength(2);
  } finally { store.close(); }
});

/** A database from 104 to 126: Dreamer streaks and executions keyed by pool, a pre-104 revision-keyed
 * streak, a Noting streak, and closed and open pool ranges with their run labels. */
function perPoolDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "tm-dreamer-task-126-")); dirs.push(dir);
  const file = join(dir, "trace.db"), store = new Store(file);
  try {
    const project = store.createProject({ name: "per-pool", declaredBy: "mark" });
    const [first, second, third] = [1, 2, 3].map(n => store.createSession({ host: `per-pool-${n}`, projectId: project.id,
      enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" }));
    const turn = store.appendTurn({ sessionId: first!.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
    const pool = `project:${project.id}`;
    const run = (sessionId: number, label: string) => store.recordRun({ kind: "dreaming", sessionId, branch: "main", outcome: "failure",
      rangeFrom: label, rangeTo: label, createdAt: "old" }).id;
    const [projectRun, globalRun, sessionRun, otherRun] = [run(first!.id, `${pool}#1`), run(first!.id, "global#2"),
      run(first!.id, `session:${first!.id}#3`), run(second!.id, "global#4")];
    const execution = store.db.prepare(`INSERT INTO task_executions(id,session_id,phase,head,pool,outcome,terminal_run,reason,updated_at)
      VALUES (?,?,'dreaming',?,?,?,?,?,'old')`);
    execution.run("project-1", first!.id, null, pool, "failure", projectRun, "project over budget");
    execution.run("global-1", first!.id, null, "global", "failure", globalRun, "global over budget");
    execution.run("session-1", first!.id, null, `session:${first!.id}`, "success", sessionRun, "");
    execution.run("other-1", second!.id, null, "global", "failure", otherRun, "timeout");
    const failure = store.db.prepare(`INSERT INTO task_failures(session_id,phase,head,pool,count,last_reason,last_run_id,updated_at)
      VALUES (?,?,?,?,?,?,?,?)`);
    failure.run(first!.id, "dreaming", null, pool, 2, "project over budget", projectRun, "old-project");
    failure.run(first!.id, "dreaming", null, "global", 1, "global over budget", globalRun, "old-global");
    failure.run(first!.id, "dreaming", null, `session:${first!.id}`, 0, "", sessionRun, "old-session");
    failure.run(first!.id, "dreaming", 7, null, 1, "pre-104 revision streak", null, "older");
    failure.run(second!.id, "dreaming", null, "global", 1, "timeout", otherRun, "old-other");
    failure.run(third!.id, "noting", 5, null, 2, "noting failed", null, "old-noting");
    const range = store.db.prepare(`INSERT INTO dreaming_ranges(session_id,branch,head_turn_id,anchor,completed_run,pool,claim_token,closed_at,pending_revisions)
      VALUES (?,'main',?,NULL,?,?,?,?,'[]')`);
    range.run(first!.id, turn.id, projectRun, pool, "closed-token", "old");
    range.run(first!.id, turn.id, null, "global", "open-token", null);
    const snapshot = (table: string) => store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return { file, first: first!.id, second: second!.id, third: third!.id, projectRun, otherRun,
      executions: snapshot("task_executions"), ranges: snapshot("dreaming_ranges"), runs: store.listRuns(first!.id) };
  } finally { store.close(); }
}

const streak = (store: Store, sessionId: number) => store.taskFailures(sessionId)
  .map(({ phase, head, pool, count, lastReason, lastRunId }) => ({ phase, head, pool, count, lastReason, lastRunId }));

test("126: a session's per-pool Dreamer streaks become one at their largest count; executions, ranges and run labels stay as they were", () => {
  const f = perPoolDatabase();
  let store = new Store(f.file);
  try {
    expect(streak(store, f.first)).toEqual([
      { phase: "dreaming", head: null, pool: ALL_POOLS, count: 2, lastReason: "project over budget", lastRunId: f.projectRun },
      { phase: "dreaming", head: 7, pool: null, count: 1, lastReason: "pre-104 revision streak", lastRunId: null }]);
    expect(streak(store, f.second)).toEqual([
      { phase: "dreaming", head: null, pool: ALL_POOLS, count: 1, lastReason: "timeout", lastRunId: f.otherRun }]);
    expect(streak(store, f.third)).toEqual([
      { phase: "noting", head: 5, pool: null, count: 2, lastReason: "noting failed", lastRunId: null }]);
    expect(store.db.prepare("SELECT * FROM task_executions ORDER BY rowid").all()).toEqual(f.executions);
    expect(store.db.prepare("SELECT * FROM dreaming_ranges ORDER BY rowid").all()).toEqual(f.ranges);
    expect(store.listRuns(f.first)).toEqual(f.runs);
    expect(store.db.prepare("SELECT pool, claim_token FROM dreaming_ranges WHERE id = ?").get(Number(f.ranges[1]!.id))).toMatchObject({ pool: "global", claim_token: "open-token" });
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close(); store = new Store(f.file);
    expect(streak(store, f.first)[0]).toMatchObject({ pool: ALL_POOLS, count: 2 });
  } finally { store.close(); }
});

test("126: stores opened at once by several threads fold the per-pool streaks exactly once", async () => {
  const f = perPoolDatabase();
  const module = new URL("../../../src/core/store/index.ts", import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, () => new Promise<void>((resolve, reject) => {
    const child = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      import(workerData.module).then(({ Store }) => { new Store(workerData.file).close(); parentPort.postMessage('done'); })
        .catch(error => { throw error; });`, { eval: true, workerData: { module, file: f.file } });
    child.once("error", reject);
    child.once("exit", code => code === 0 ? resolve() : reject(new Error(`opener exited ${code}`)));
  })));
  const store = new Store(f.file);
  try {
    expect(store.db.prepare("SELECT session_id, pool, count FROM task_failures WHERE phase = 'dreaming' AND pool IS NOT NULL ORDER BY session_id").all())
      .toEqual([{ session_id: f.first, pool: ALL_POOLS, count: 2 }, { session_id: f.second, pool: ALL_POOLS, count: 1 }]);
  } finally { store.close(); }
});
