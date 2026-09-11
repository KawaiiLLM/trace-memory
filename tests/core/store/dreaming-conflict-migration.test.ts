import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { migrateDreaming } from "../../../src/core/store/migration.ts";

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function legacy() {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-conflict-migration-")); dirs.push(dir);
  const file = join(dir, "old.sqlite"), store = new Store(file); stores.push(store);
  const project = store.createProject({ name: "legacy", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const executionId = store.beginExecution({ sessionId: session.id, phase: "dreaming", head: 1 });
  const run = store.recordRun({ kind: "dreaming", sessionId: session.id, executionId, outcome: "failure", createdAt: "old" });
  store.settleExecution(executionId, "failure", run.id, "legacy failure");
  const removed = store.recordRun({ kind: "manual", sessionId: session.id, outcome: "success", createdAt: "removed" });
  store.db.prepare("DELETE FROM runs WHERE id = ?").run(removed.id);
  store.db.exec(`CREATE TABLE migration_child(run_id INTEGER REFERENCES runs(id), execution_id TEXT REFERENCES task_executions(id));
    CREATE TABLE migration_audit(id INTEGER);
    CREATE TRIGGER execution_update AFTER UPDATE ON task_executions BEGIN INSERT INTO migration_audit VALUES (new.terminal_run); END;`);
  store.db.prepare("INSERT INTO migration_child VALUES (?,?)").run(run.id, executionId);
  // Reconstruct the actual old CHECKs, not a mocked migration flag. Keep every column and FK.
  store.db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  try {
    for (const name of ["runs", "task_executions"]) {
      const sql = String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)!.sql);
      const objects = store.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger') AND sql IS NOT NULL").all(name);
      const sequence = store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(name);
      store.db.exec(sql.replace(new RegExp(`CREATE TABLE (?:IF NOT EXISTS )?${name}`, "i"), `CREATE TABLE ${name}_old`).replace(",'conflict'", ""));
      store.db.exec(`INSERT INTO ${name}_old SELECT * FROM ${name}; DROP TABLE ${name}; ALTER TABLE ${name}_old RENAME TO ${name}`);
      if (sequence) store.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = ?").run(sequence.seq!, name);
      for (const object of objects) store.db.exec(String(object.sql));
    }
    store.db.exec("COMMIT");
  } finally { if (store.db.isTransaction) store.db.exec("ROLLBACK"); store.db.exec("PRAGMA foreign_keys = ON"); }
  return { file, store, sessionId: session.id, executionId, runId: run.id, removedId: removed.id };
}

test("old runs/execution CHECKs migrate together, preserving audits, streaks, references, indexes, triggers and sequences", () => {
  const f = legacy();
  expect(() => f.store.db.prepare("UPDATE runs SET outcome = 'conflict' WHERE id = ?").run(f.runId)).toThrow(/CHECK/);
  expect(() => f.store.db.prepare("UPDATE task_executions SET outcome = 'conflict' WHERE id = ?").run(f.executionId)).toThrow(/CHECK/);
  const before = f.store.taskFailures(f.sessionId);
  f.store.close();
  const s = new Store(f.file); stores.push(s);
  expect(s.getRun(f.runId)?.outcome).toBe("failure");
  expect(s.taskFailures(f.sessionId)).toEqual(before);
  expect(s.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(s.db.prepare("SELECT * FROM migration_child").get()).toMatchObject({ run_id: f.runId, execution_id: f.executionId });
  expect(s.db.prepare("SELECT run_id FROM execution_runs WHERE execution_id = ?").get(f.executionId)?.run_id).toBe(f.runId);
  expect(s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_execution_task'").get()).toBeTruthy();
  s.db.prepare("UPDATE task_executions SET reason = 'updated' WHERE id = ?").run(f.executionId);
  expect(s.db.prepare("SELECT * FROM migration_audit").all()).toHaveLength(1);
  const next = s.recordRun({ kind: "dreaming", sessionId: f.sessionId, outcome: "conflict", createdAt: "new" });
  expect(next.id).toBeGreaterThan(f.removedId);
  // Direct SQL demonstrates CHECK migration only; public core settlement still requires authority.
  s.db.prepare("UPDATE task_executions SET outcome = 'conflict' WHERE id = ?").run(f.executionId);
  expect(() => s.db.prepare("UPDATE task_executions SET outcome = 'invented' WHERE id = ?").run(f.executionId)).toThrow(/CHECK/);
  s.close();
  const again = new Store(f.file); stores.push(again);
  expect(again.getRun(next.id)?.outcome).toBe("conflict");
  expect(again.taskFailures(f.sessionId)).toEqual(before);
});

test("failed conflict CHECK migration rolls back both tables and restores foreign-key enforcement", () => {
  const f = legacy();
  f.store.db.exec("PRAGMA foreign_keys = OFF; INSERT INTO migration_child VALUES (99999, 'missing'); PRAGMA foreign_keys = ON");
  expect(() => migrateDreaming(f.store.db)).toThrow("foreign key violations");
  expect(f.store.db.isTransaction).toBe(false);
  expect(f.store.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
  for (const name of ["runs", "task_executions"]) expect(String(f.store.db.prepare("SELECT sql FROM sqlite_master WHERE name = ?").get(name)!.sql)).not.toContain("'conflict'");
  expect(f.store.getRun(f.runId)?.outcome).toBe("failure");
  expect(f.store.taskFailures(f.sessionId)[0]?.count).toBe(1);
  expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_32b'").all()).toEqual([]);
});
