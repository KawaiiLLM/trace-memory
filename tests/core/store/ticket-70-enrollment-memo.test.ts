import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../../src/core/store/index.ts";

// 70 finding 2 — Store.transaction's enrollment memo (`enrolledCache`) is installed before BEGIN
// succeeds and is cleared only when the outermost transaction ends. Two ways that goes stale:
//   1. a rolled-back nested savepoint leaves changes it made to the shared memo in place even
//      though the database reverted;
//   2. a failed top-level BEGIN IMMEDIATE leaves the memo installed outside any transaction, where
//      it is never invalidated by another connection's write.

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tm-70-enrollment-memo-"));
  dbPath = join(dir, "test.sqlite");
  store = new Store(dbPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function session() {
  const project = store.createProject({ name: `p-${Math.random()}`, declaredBy: "marker" });
  return store.createSession({ enrollmentChoice: true, host: `h-${Math.random()}`,
    startedAt: "2026-01-01T00:00:00Z", firstReplyAt: "2026-01-01T00:00:05Z", projectId: project.id });
}

test("a rolled-back nested savepoint does not leave the enrollment memo stale for the rest of the outer transaction", () => {
  const { id: sessionId } = session();
  store.transaction(() => {
    expect(() => store.transaction(() => {
      store.setEnrollment(sessionId, false);
      expect(store.enabled(sessionId)).toBe(false); // memoized false inside the doomed savepoint
      throw new Error("rollback this savepoint");
    })).toThrow("rollback this savepoint");
    // The savepoint rolled back: the database is still enrolled. The memo must not still say false.
    expect(store.enabled(sessionId)).toBe(true);
  });
});

test("a failed top-level BEGIN IMMEDIATE does not leave the enrollment memo installed outside any transaction", () => {
  const { id: sessionId } = session();
  const exec = DatabaseSync.prototype.exec;
  const sqliteError = Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR", errcode: 5 });
  const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function(this: DatabaseSync, statement: string) {
    if (statement === "BEGIN IMMEDIATE") throw sqliteError;
    return exec.call(this, statement);
  });
  try {
    expect(() => store.transaction(() => {})).toThrow("database is locked");
  } finally { spy.mockRestore(); }

  // Reading enabled() here, outside any transaction, must not install a memo that outlives this call.
  expect(store.enabled(sessionId)).toBe(true);

  // A second connection commits an enrollment change while the (bug: still-installed) memo exists.
  const other = new Store(dbPath);
  try { other.setEnrollment(sessionId, false); } finally { other.close(); }

  expect(store.enabled(sessionId)).toBe(false);
});
