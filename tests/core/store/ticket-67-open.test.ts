import { afterEach, expect, test, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../../src/core/store/index.ts";

const directories: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const store of stores.splice(0)) store.close();
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-67-open-")); directories.push(dir);
  const file = join(dir, "test.db"), store = new Store(file); stores.push(store);
  return { file, store };
}
function recordSql() {
  const sql: string[] = [];
  const prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, statement: string) {
    sql.push(statement); return prepare.call(this, statement);
  });
  return sql;
}
function child(source: string) {
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", source], {
    encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "pipe"],
  }));
}

test("67 unchanged Store opens do not scan foreign keys or immutable bodies", () => {
  const { file, store } = fixture();
  store.close();
  const sql = recordSql();
  const start = performance.now();
  const reopened = new Store(file, () => { throw Error("no legacy Raw expected"); }); stores.push(reopened);
  expect(sql.filter(statement => /foreign_key_check/i.test(statement))).toEqual([]);
  expect(sql.filter(statement => /SELECT .*(?:FROM facts|FROM knowledge_revisions)/i.test(statement))).toEqual([]);
  expect(sql.length).toBeLessThan(80); // bounded metadata probes, independent of database contents
  expect(reopened.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
  expect(reopened.migration64d).toMatchObject({ legacySchema: false, budgetSource: "current" });
  console.log(JSON.stringify({ scenario: "unchanged-store-open", milliseconds: performance.now() - start, prepares: sql.length }));
});

test("67 actual schema migration checks foreign keys once and rolls back on violation", () => {
  const { file, store } = fixture();
  store.db.exec(`DROP INDEX idx_source_unnormalized;
    PRAGMA foreign_keys = OFF;
    CREATE TABLE extension_probe(session_id INTEGER REFERENCES sessions(id));
    INSERT INTO extension_probe VALUES (999999);
    PRAGMA foreign_keys = ON`);
  store.close();
  const sql = recordSql();
  expect(() => new Store(file)).toThrow("Store migration: foreign key violations");
  expect(sql.filter(statement => /foreign_key_check/i.test(statement))).toHaveLength(1);
  const raw = new DatabaseSync(file);
  try {
    expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_source_unnormalized'").get()).toBeUndefined();
    raw.exec("DELETE FROM extension_probe");
  } finally { raw.close(); }
  sql.length = 0;
  const migrated = new Store(file); stores.push(migrated);
  expect(sql.filter(statement => /foreign_key_check/i.test(statement))).toHaveLength(1);
  expect(migrated.db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(1);
  migrated.close(); sql.length = 0;
  const reopened = new Store(file); stores.push(reopened);
  expect(sql.filter(statement => /foreign_key_check/i.test(statement))).toHaveLength(0);
});

test("67 undecoded-entry selection uses its partial index instead of scanning Raw", () => {
  const { store } = fixture();
  const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT id, content, entry_ordinal, blocks
    FROM source_entries WHERE blocks IS NULL ORDER BY id`).all();
  expect(plan.some(row => String(row.detail).includes("idx_source_unnormalized"))).toBe(true);
});

test("67 file initialization sets WAL before schema transactions and preserves it across reopen", () => {
  const transactions: boolean[] = [], prepare = DatabaseSync.prototype.prepare;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, statement: string) {
    if (statement === "PRAGMA journal_mode = WAL") transactions.push(this.isTransaction);
    return prepare.call(this, statement);
  });
  const { file, store } = fixture();
  expect(store.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
  const project = store.createProject({ name: "preserved", declaredBy: "mark" });
  store.close();
  const raw = new DatabaseSync(file);
  try { expect(raw.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal"); }
  finally { raw.close(); }
  const reopened = new Store(file); stores.push(reopened);
  expect(reopened.getProject(project.id)!.name).toBe("preserved");
  expect(reopened.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
  expect(transactions).toEqual([false, false]);
});

test("67 opening an existing DELETE fixture enables WAL without changing its data", () => {
  const { file, store } = fixture();
  const project = store.createProject({ name: "legacy", declaredBy: "mark" });
  store.close();
  const legacy = new DatabaseSync(file);
  try { expect(legacy.prepare("PRAGMA journal_mode = DELETE").get()!.journal_mode).toBe("delete"); }
  finally { legacy.close(); }
  const sql = recordSql();
  const reopened = new Store(file); stores.push(reopened);
  expect(sql).toContain("PRAGMA journal_mode = WAL");
  expect(sql.some(statement => /foreign_key_check/i.test(statement))).toBe(false);
  expect(reopened.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
  expect(reopened.getProject(project.id)!.name).toBe("legacy");
});

test("67 in-memory Store keeps MEMORY mode without requesting unsupported WAL", () => {
  const sql = recordSql(), store = new Store(":memory:"); stores.push(store);
  expect(sql).not.toContain("PRAGMA journal_mode = WAL");
  expect(store.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("memory");
});

test.each(["refused", "exception", "locked"] as const)("67 WAL %s fails before schema writes and closes the connection", failure => {
  const dir = mkdtempSync(join(tmpdir(), "tm-67-wal-failure-")); directories.push(dir);
  const file = join(dir, "test.db"), prepare = DatabaseSync.prototype.prepare;
  const sqliteError = failure === "locked"
    ? Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 })
    : new Error("injected WAL configuration failure");
  let opened!: DatabaseSync;
  vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function(this: DatabaseSync, statement: string) {
    if (statement === "PRAGMA journal_mode = WAL") {
      opened = this;
      if (failure !== "refused") throw sqliteError;
      // SQLite can return the original mode instead of the requested one. Use its real
      // read statement to simulate that response; do not manufacture a successful mode.
      return prepare.call(this, "PRAGMA journal_mode");
    }
    return prepare.call(this, statement);
  });
  const exec = vi.spyOn(DatabaseSync.prototype, "exec");
  let caught: unknown;
  try { new Store(file); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  const error = caught as Error;
  if (failure === "refused") {
    expect(error.message).toBe("Store requires WAL journal mode; SQLite returned delete");
    expect(error.message).not.toContain("database is locked");
  } else {
    expect(error.message).toContain(`Store WAL initialization failed before the schema transaction: ${sqliteError.message}`);
    expect(error.message).toContain("backup/manual WAL conversion completed before restart");
    expect(error.message).not.toContain("SQLite returned");
    expect(error.cause).toBe(sqliteError);
    if (failure === "locked") expect(error.cause).toMatchObject({ code: "ERR_SQLITE_ERROR", errcode: 5 });
  }
  expect(exec.mock.calls.some(([statement]) => /BEGIN|CREATE TABLE/i.test(statement))).toBe(false);
  expect(() => opened.prepare("SELECT 1")).toThrow(/not open/i);
  const check = new DatabaseSync(file);
  try { expect(check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).toEqual([]); }
  finally { check.close(); }
});

test("67 a later schema lock failure is not mislabeled as WAL initialization failure", () => {
  const { file, store } = fixture(); store.close();
  const sqliteError = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const exec = DatabaseSync.prototype.exec;
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, statement: string) {
    if (statement === "PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE") throw sqliteError;
    return exec.call(this, statement);
  });
  let caught: unknown;
  try { new Store(file); } catch (error) { caught = error; }
  expect(caught).toBe(sqliteError);
  expect((caught as Error).message).not.toContain("WAL initialization");
});

test("67 Store-initialized WAL supports cross-process readers and writers", () => {
  const { file, store } = fixture();
  store.createProject({ name: "committed", declaredBy: "mark" });
  store.close();
  const reopened = new Store(file); stores.push(reopened);
  expect(reopened.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal");
  const importStore = `import { Store } from ${JSON.stringify(new URL("../../../src/core/store/index.ts", import.meta.url).href)};`;
  reopened.db.exec("BEGIN");
  try {
    expect(reopened.db.prepare("SELECT count(*) AS n FROM projects").get()!.n).toBe(1);
    const result = child(`${importStore}
      const started = performance.now(), store = new Store(${JSON.stringify(file)});
      try { store.createProject({ name: 'child-write', declaredBy: 'mark' });
        console.log(JSON.stringify({ ok: true, elapsedMs: performance.now()-started })); }
      finally { store.close(); }`);
    expect(result.ok).toBe(true);
    expect(result.elapsedMs).toBeLessThan(5_000); // normal busy timeout, not a larger test-only wait
    expect(reopened.db.prepare("SELECT count(*) AS n FROM projects").get()!.n).toBe(1); // stable reader snapshot
    console.log(JSON.stringify({ scenario: "wal-writer-beside-reader", ...result }));
  } finally { reopened.db.exec("ROLLBACK"); }
  reopened.transaction(() => {
    reopened.createProject({ name: "uncommitted", declaredBy: "mark" });
    const result = child(`import { DatabaseSync } from 'node:sqlite';
      const started = performance.now(), db = new DatabaseSync(${JSON.stringify(file)}, { readOnly: true });
      try { const row = db.prepare('SELECT count(*) AS n FROM projects').get();
        console.log(JSON.stringify({ count: Number(row.n), elapsedMs: performance.now()-started })); }
      finally { db.close(); }`);
    expect(result.count).toBe(2);
    expect(result.elapsedMs).toBeLessThan(5_000);
    console.log(JSON.stringify({ scenario: "wal-reader-beside-writer", ...result }));
  });
});
