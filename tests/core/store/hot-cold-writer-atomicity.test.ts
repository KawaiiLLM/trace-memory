// 79 acceptance: "Every writer writes both rows in one transaction (a failure between them leaves
// neither)." Both split writers -- the source entry (hot `source_entries` row + `source_entry_raw`
// payload row) and the run (hot `runs` row + `run_bodies` row) -- go through `this.transaction`
// (`appendSourceEntry`, `insertRun`), so a thrown error between the two INSERTs must roll both back,
// not just the second. Pinned by forcing the second INSERT of each pair to throw and checking that the
// first row never lands either.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { Store } from "../../../src/core/store/index.ts";

let dir: string, dbPath: string, store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-79-atomicity-"));
  dbPath = join(dir, "trace.db");
  store = new Store(dbPath);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

/** Makes the next `db.prepare` call whose SQL matches `pattern` return a statement whose `.run()`
 * throws, and every other call unaffected. Installed on the live `store.db`, so it fires inside the
 * writer's own `this.transaction`, exactly as a real mid-transaction failure (a full disk, a busy
 * timeout past its budget) would. */
function explodeOn(store: Store, pattern: RegExp): () => void {
  const original = store.db.prepare.bind(store.db);
  (store.db as unknown as { prepare: typeof store.db.prepare }).prepare = ((sql: string) => {
    if (!pattern.test(sql)) return original(sql);
    // The writers this test targets only ever call `.run()` on the statement they prepare here
    // (an INSERT), so a minimal stand-in that just throws on `.run()` is enough -- no native
    // StatementSync proxying, which node:sqlite's binding does not support cleanly.
    return { run: () => { throw new Error(`injected failure: ${sql}`); } } as unknown as ReturnType<typeof original>;
  }) as typeof store.db.prepare;
  return () => { (store.db as unknown as { prepare: typeof store.db.prepare }).prepare = original; };
}

const counts = (store: Store) => ({
  sourceEntries: (store.db.prepare("SELECT COUNT(*) n FROM source_entries").get() as { n: number }).n,
  sourceEntryRaw: (store.db.prepare("SELECT COUNT(*) n FROM source_entry_raw").get() as { n: number }).n,
  runs: (store.db.prepare("SELECT COUNT(*) n FROM runs").get() as { n: number }).n,
  runBodies: (store.db.prepare("SELECT COUNT(*) n FROM run_bodies").get() as { n: number }).n,
});

test("79 item 0/2: a failure writing the source entry's Raw payload row leaves neither row", () => {
  const project = store.createProject({ name: "atomicity", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: "t", userPrompt: "q" });
  const before = counts(store);
  const restore = explodeOn(store, /INSERT INTO source_entry_raw/);
  try {
    expect(() => store.appendSourceEntry({ sessionId: session.id, nativeLineage: "fx", nativeId: "m1", turnId: turn.id,
      role: "user", text: "hello", raw: "hello", calls: [] })).toThrow(/injected failure/);
  } finally { restore(); }
  // Neither the hot row nor the payload row survived: not an orphaned source_entries row with no
  // source_entry_raw counterpart (which getSourceEntry's INNER JOIN would then simply never surface,
  // silently hiding the leak instead of proving its absence).
  expect(counts(store)).toEqual(before);
});

test("79 item 0/2: a failure writing the run's body row leaves neither row (recordRun)", () => {
  const project = store.createProject({ name: "atomicity-run", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
  const before = counts(store);
  const restore = explodeOn(store, /INSERT INTO run_bodies/);
  try {
    expect(() => store.recordRun({ kind: "manual", sessionId: session.id, createdAt: "t", outcome: "success",
      request: JSON.stringify({ a: 1 }), response: JSON.stringify({ b: 2 }) })).toThrow(/injected failure/);
  } finally { restore(); }
  expect(counts(store)).toEqual(before);
});

test("79 item 0/2: a failure writing the run's hot row leaves the body row unwritten too", () => {
  const project = store.createProject({ name: "atomicity-run-hot", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
  const before = counts(store);
  const restore = explodeOn(store, /INSERT INTO runs\b/);
  try {
    expect(() => store.recordRun({ kind: "manual", sessionId: session.id, createdAt: "t", outcome: "success",
      request: JSON.stringify({ a: 1 }), response: JSON.stringify({ b: 2 }) })).toThrow(/injected failure/);
  } finally { restore(); }
  expect(counts(store)).toEqual(before);
});

test("79 item 0/2: the ordinary path still writes both rows together (control)", () => {
  const project = store.createProject({ name: "atomicity-control", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "fixture", projectId: project.id, startedAt: "t", firstReplyAt: "t" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: "t", userPrompt: "q" });
  const before = counts(store);
  const entry = store.appendSourceEntry({ sessionId: session.id, nativeLineage: "fx", nativeId: "m1", turnId: turn.id,
    role: "user", text: "hello", raw: "hello", calls: [] });
  const run = store.recordRun({ kind: "manual", sessionId: session.id, createdAt: "t", outcome: "success",
    request: JSON.stringify({ a: 1 }), response: JSON.stringify({ b: 2 }) });
  expect(counts(store)).toEqual({ sourceEntries: before.sourceEntries + 1, sourceEntryRaw: before.sourceEntryRaw + 1,
    runs: before.runs + 1, runBodies: before.runBodies + 1 });
  expect(store.getSourceEntry(entry.id)?.raw).toBe("hello");
  expect(store.getRun(run.id)?.request).toBe(JSON.stringify({ a: 1 }));
});
