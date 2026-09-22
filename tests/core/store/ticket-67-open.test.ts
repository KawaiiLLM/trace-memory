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

test("67 opening an existing DELETE database never converts it to WAL", () => {
  const { file, store } = fixture();
  expect(store.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("delete");
  store.close();
  const sql = recordSql();
  const reopened = new Store(file); stores.push(reopened);
  expect(sql.filter(statement => /journal_mode\s*=/i.test(statement))).toEqual([]);
  expect(reopened.db.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("delete");
});

test("67 an explicitly converted WAL copy supports cross-process readers and writers", () => {
  const { file, store } = fixture();
  store.createProject({ name: "committed", declaredBy: "mark" });
  store.close();
  // This operator action is confined to the synthetic database, with every Store closed.
  const operator = new DatabaseSync(file);
  expect(operator.prepare("PRAGMA journal_mode = WAL").get()!.journal_mode).toBe("wal");
  operator.close();
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
