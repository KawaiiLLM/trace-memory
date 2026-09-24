import { afterEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function legacy() {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-85-migration-"));
  dirs.push(dir);
  const path = join(dir, "trace.db");
  const store = new Store(path);
  store.close();
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE knowledge_pool_state (
    pool TEXT PRIMARY KEY, last_over_size INTEGER NOT NULL, last_over_budget INTEGER NOT NULL,
    residual_revisions TEXT NOT NULL DEFAULT '[]')`);
  db.prepare("INSERT INTO knowledge_pool_state VALUES (?,?,?,?)").run("global", 5000, 4000, "[]");
  db.close();
  return path;
}

const hasState = (db: DatabaseSync) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'knowledge_pool_state'").get();

test("85: normal Store open drops legacy suppression table atomically and a second open does no work", () => {
  const path = legacy();
  const upgraded = new Store(path);
  expect(hasState(upgraded.db)).toBe(false);
  const version = upgraded.db.prepare("PRAGMA schema_version").get()!.schema_version;
  upgraded.close();
  const reopened = new Store(path);
  expect(hasState(reopened.db)).toBe(false);
  expect(reopened.db.prepare("PRAGMA schema_version").get()!.schema_version).toBe(version);
  reopened.close();
});

test("85: failure after dropping pool state rolls back the drop and keeps its rows", () => {
  const path = legacy();
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO knowledge_processed(pool,revision_id,run_id) VALUES (?,?,?)").run("global", 999999, 999999);
  db.close();
  // Observe the actual DROP before the final foreign-key check fails (not a pre-DROP rejection).
  const exec = DatabaseSync.prototype.exec;
  let dropped = false;
  const observed = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql === "DROP TABLE IF EXISTS knowledge_pool_state") dropped = true;
  });
  try { expect(() => new Store(path)).toThrow(/foreign key violations/); }
  finally { observed.mockRestore(); }
  expect(dropped).toBe(true);
  const check = new DatabaseSync(path);
  expect(hasState(check)).toBe(true);
  expect(check.prepare("SELECT last_over_size,last_over_budget FROM knowledge_pool_state WHERE pool='global'").get())
    .toEqual({ last_over_size: 5000, last_over_budget: 4000 });
  check.prepare("DELETE FROM knowledge_processed WHERE revision_id = 999999").run();
  check.close();
  const upgraded = new Store(path);
  expect(hasState(upgraded.db)).toBe(false);
  upgraded.close();
});
