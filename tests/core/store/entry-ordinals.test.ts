import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Store, type SourceInput } from "../../../src/core/store/index.ts";
import { parseTurnAddress, traceTargets, callSelector } from "../../../src/core/model/address.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-ordinals-")); dirs.push(dir);
  const path = join(dir, "test.sqlite"), store = new Store(path);
  const project = store.createProject({ name: "entry-test", declaredBy: "mark" });
  const session = store.createSession({ projectId: project.id, host: "test", startedAt: "time", firstReplyAt: "time", enrollmentChoice: true });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: "time" });
  const input = (id: string): SourceInput => ({ sessionId: session.id, turnId: turn.id, nativeId: id, nativeLineage: "original", role: "user", text: id, raw: id, calls: [] });
  return { path, store, session, turn, input };
}
test("33: E ordinals survive restart and sibling selection; native identity is reused", () => {
  const f = fixture(); let store = f.store;
  try {
    const a = store.appendSourceEntry(f.input("a")), b = store.appendSourceEntry(f.input("b"));
    store.selectSourcePath(f.session.id, "left", [a.id, b.id]);
    store.close(); store = new Store(f.path);
    expect(store.appendSourceEntry(f.input("a"))).toEqual(a);
    const c = store.appendSourceEntry(f.input("c"));
    store.selectSourcePath(f.session.id, "right", [a.id, c.id]);
    expect(store.listSourceEntries(f.session.id, f.turn.id, "right").map(e => e.entryOrdinal)).toEqual([1, 3]);
    expect(store.listSourceEntries(f.session.id, f.turn.id, "left").map(e => e.entryOrdinal)).toEqual([1, 2]);
    const other = new Store(f.path);
    try { expect(other.appendSourceEntry(f.input("d")).entryOrdinal).toBe(4); expect(store.appendSourceEntry(f.input("e")).entryOrdinal).toBe(5); }
    finally { other.close(); }
  } finally { store.close(); }
});
test("33: legacy schema upgrade is deterministic and never rewrites raw or source strings", () => {
  const f = fixture(); let store = f.store;
  try {
    const a = store.appendSourceEntry(f.input("a")), b = store.appendSourceEntry(f.input("b"));
    const before = store.db.prepare("SELECT id, content FROM source_entries ORDER BY id").all();
    store.db.exec("DROP INDEX idx_source_turn_ordinal; ALTER TABLE source_entries DROP COLUMN entry_ordinal");
    store.close(); store = new Store(f.path);
    expect(store.getSourceEntry(a.id)!.entryOrdinal).toBe(1); expect(store.getSourceEntry(b.id)!.entryOrdinal).toBe(2);
    expect(store.db.prepare("SELECT id, content FROM source_entries ORDER BY id").all()).toEqual(before);
    expect(store.appendSourceEntry(f.input("c")).entryOrdinal).toBe(3);
  } finally { store.close(); }
});
test("entry/cleanup integration: ordinal and block upgrade preserves the retired delivery table and legacy citations", () => {
  const f = fixture(); let store = f.store;
  try {
    const a = store.appendSourceEntry(f.input("a")), b = store.appendSourceEntry(f.input("b"));
    store.selectSourcePath(f.session.id, "main", [b.id]);
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "time" }, facts: [{ turnId: f.turn.id,
      category: "observation", actor: "user", text: "legacy fact", source: [`T${f.turn.id}#user`], createdAt: "time" }] });
    if (!noted.ok) throw Error(noted.problems.join());
    store.db.exec(`CREATE TABLE pending_deliveries (run_id INTEGER NOT NULL REFERENCES runs(id), session_id INTEGER NOT NULL REFERENCES sessions(id), branch TEXT, delivered_at TEXT)`);
    store.db.prepare("INSERT INTO pending_deliveries VALUES (?, ?, 'main', NULL)").run(noted.runId, f.session.id);
    const schema = store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'pending_deliveries'").get();
    const rows = store.db.prepare("SELECT * FROM pending_deliveries").all();
    const raw = store.db.prepare("SELECT id, content FROM source_entries ORDER BY id").all();
    const fact = store.getFact(noted.facts[0]!.id);
    store.db.exec(`DROP INDEX idx_source_turn_ordinal; DROP INDEX idx_source_unnormalized;
      ALTER TABLE source_entries DROP COLUMN entry_ordinal;
      ALTER TABLE source_entries DROP COLUMN blocks; ALTER TABLE source_entries DROP COLUMN addresses`);
    let normalized = 0;
    const normalize = (input: SourceInput) => { normalized++; return [{ kind: "text" as const, text: input.text }]; };
    for (let reopen = 0; reopen < 2; reopen++) {
      store.close(); store = new Store(f.path, normalize);
      expect(normalized).toBe(2);
      expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'pending_deliveries'").get()).toEqual(schema);
      expect(store.db.prepare("SELECT * FROM pending_deliveries").all()).toEqual(rows);
      expect(store.db.prepare("SELECT id, content FROM source_entries ORDER BY id").all()).toEqual(raw);
      expect(store.getFact(noted.facts[0]!.id)).toEqual(fact);
      expect(store.listSourceEntries(f.session.id, f.turn.id, "main").map(e => e.entryOrdinal)).toEqual([2]);
      expect(store.getSourceEntry(a.id)!.blocks).toEqual([{ kind: "text", text: "a" }]);
      expect(store.appendSourceEntry(f.input("b")).id).toBe(b.id);
      expect(store.db.prepare("SELECT addresses FROM source_entries WHERE id = ?").get(b.id)!.addresses).toContain(`T${f.turn.id}#E2@text`);
    }
    expect(store.appendSourceEntry(f.input("c")).entryOrdinal).toBe(3);
    expect(normalized).toBe(3);
  } finally { store.close(); }
});

test("33: normalization runs once on upgrade or ingestion, not on reads or restart", () => {
  const f = fixture();
  const original = f.store.appendSourceEntry(f.input("legacy"));
  f.store.close();
  let calls = 0;
  const normalize = (input: SourceInput) => { calls++; return [{ kind: "text" as const, text: input.text }]; };
  let store = new Store(f.path, normalize);
  try {
    expect(calls).toBe(1); // one legacy row upgraded from the host's own representation
    expect(store.getSourceEntry(original.id)!.raw).toBe(original.raw);
    store.appendSourceEntry(f.input("new"));
    expect(calls).toBe(2);
    for (let i = 0; i < 4; i++) {
      store.getSourceEntry(original.id);
      store.appendSourceEntry(f.input("new")); // identity reuse is not a second decode
      store.listSourceEntries(f.session.id);
    }
    expect(calls).toBe(2);
    store.close(); store = new Store(f.path, normalize);
    expect(calls).toBe(2);
    expect(store.getSourceEntry(original.id)!.blocks).toEqual([{ kind: "text", text: "legacy" }]);
  } finally { store.close(); }
});

test("33: concurrent connections allocate unique ordinals and reuse the same native identity", async () => {
  const f = fixture();
  try {
    const module = new URL("../../../src/core/store/index.ts", import.meta.url).href;
    await Promise.all(Array.from({ length: 4 }, (_, worker) => new Promise<void>((resolve, reject) => {
      const child = new Worker(`
        const { workerData, parentPort } = require('node:worker_threads');
        import(workerData.module).then(({ Store }) => {
          const store = new Store(workerData.path);
          try {
            for (const nativeId of ['shared', ...Array.from({length: 5}, (_, n) => workerData.worker + '-' + n)]) {
              store.appendSourceEntry({...workerData.input, nativeId});
            }
          } finally { store.close(); }
          parentPort.postMessage('done');
        }).catch(error => { throw error; });`, { eval: true, workerData: { module, path: f.path, worker, input: f.input("shared") } });
      child.once("error", reject);
      child.once("exit", code => code === 0 ? resolve() : reject(new Error(`ordinal worker exited ${code}`)));
    })));
    const entries = f.store.listSourceEntries(f.session.id, f.turn.id);
    expect(entries).toHaveLength(21);
    expect(entries.map(entry => entry.entryOrdinal)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(entries.filter(entry => entry.nativeId === "shared")).toHaveLength(1);
  } finally { f.store.close(); }
});

test("33: comma inheritance, selector scope, mixed K commits and opaque IDs", () => {
  expect(traceTargets("T792#E2,E7@text,K7@2..K7@4,F2-F9,F101..")).toEqual(["T792#E2,E7@text", "K7@2..K7@4", "F2-F9", "F101.."]);
  expect(parseTurnAddress("T792#E2..E7@assistant")).toMatchObject({ turn: 792, entries: [{ from: 2, to: 7 }], selector: { kind: "role", role: "assistant" } });
  for (const id of ["call-a:b.c|d", "text", "comma,id@#[]", "工具😀", "a\n\"b"]) {
    const address = `T1#E2@${callSelector(id)}`;
    expect(traceTargets(`${address},F1`)).toEqual([address, "F1"]);
    expect(parseTurnAddress(address)?.selector).toEqual({ kind: "call", id });
  }
  for (const bad of ["T1#E2@text@thinking", "T1#E7..E2", "T1#E2,E0", "T1#E2@F*", "T1#E2@text,E7", "T1#E2,", "T01#E1", "T1#E9007199254740992"]) expect(() => traceTargets(bad), bad).toThrow();
});
