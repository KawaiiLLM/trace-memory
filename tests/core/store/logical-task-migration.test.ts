import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../../src/core/store/index.ts";

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
  return { file, sessionId: session.id, pool: `project:${project.id}` };
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
    // A new Dreamer failure counts on its pool, beside the kept revision-keyed streak.
    const execution = store.beginExecution({ sessionId: f.sessionId, phase: "dreaming", pool: f.pool });
    const run = store.recordRun({ kind: "dreaming", sessionId: f.sessionId, executionId: execution, outcome: "failure", createdAt: "new" });
    store.settleExecution(execution, "failure", run.id, "pool failed");
    expect(store.taskFailures(f.sessionId).filter(row => row.phase === "dreaming").map(({ head, pool, count }) => ({ head, pool, count })))
      .toEqual([{ head: null, pool: f.pool, count: 1 }, { head: 7, pool: null, count: 3 }]);
    expect(() => store.beginExecution({ sessionId: f.sessionId, phase: "dreaming", head: 9 })).toThrow("Dreamer logical task requires its pool");
    const schema = store.db.prepare("PRAGMA schema_version").get()!.schema_version;
    store.close(); store = new Store(f.file);
    expect(store.db.prepare("PRAGMA schema_version").get()!.schema_version).toBe(schema);
    expect(store.taskFailures(f.sessionId)).toHaveLength(3);
  } finally { store.close(); }
});
