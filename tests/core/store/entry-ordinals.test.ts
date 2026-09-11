import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
