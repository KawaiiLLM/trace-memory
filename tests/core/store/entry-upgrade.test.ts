import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store, type SourceInput } from "../../../src/core/store/index.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { SourceNormalizationError } from "../../../src/core/model/source.ts";

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-entry-upgrade-")); dirs.push(dir);
  const path = join(dir, "test.sqlite"), store = new Store(path);
  const projectId = store.createProject({ name: "upgrade", declaredBy: "mark" }).id;
  const sessionId = store.createSession({ projectId, host: "test", startedAt: "time", firstReplyAt: "time", enrollmentChoice: true }).id;
  const turnId = store.appendTurn({ sessionId, kind: "turn", startedAt: "time" }).id;
  const call = { callId: "private-call-id", ordinal: 7, name: "bash", input: "{}", result: "original result bytes", status: "success" };
  const input = (nativeId: string, content: unknown[], calls = [call]): SourceInput => ({ sessionId, turnId, nativeId, nativeLineage: "private-lineage", role: "assistant",
    text: "legacy projection", raw: JSON.stringify({ role: "assistant", content }), calls });
  const block = { type: "toolCall", id: call.callId, name: "bash", arguments: {} };
  return { path, store, sessionId, turnId, call, input, block };
}

test("upgrade isolates recognized malformed rows, preserves evidence and ordinals, and never retries them", () => {
  const f = fixture();
  const inputs = [f.input("good", [{ type: "text", text: "normal text" }], []),
    f.input("missing-map", [f.block], []), f.input("duplicate-native", [f.block, f.block]),
    f.input("wrong-map", [{ ...f.block, id: "unmapped" }]),
    { ...f.input("missing-result-map", []), role: "toolResult" as const, text: "", raw: JSON.stringify({ role: "toolResult", toolCallId: "missing", content: [{ type: "text", text: "original result" }] }) },
    f.input("good-call", [f.block])];
  const entries = inputs.map(input => f.store.appendSourceEntry(input));
  f.store.selectSourcePath(f.sessionId, "main", entries.map(e => e.id));
  const fact = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.sessionId, createdAt: "time" }, facts: [{ turnId: f.turnId, category: "observation", actor: "agent", text: "Existing evidence", source: ["T1#t7"], entryIds: [entries[2]!.id], createdAt: "time" }] });
  expect(fact.ok).toBe(true);
  const before = f.store.db.prepare("SELECT id, content, entry_ordinal FROM source_entries ORDER BY id").all();
  const facts = f.store.db.prepare("SELECT * FROM facts").all();
  const bindings = f.store.db.prepare("SELECT * FROM fact_sources").all();
  f.store.close();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const normalize = vi.fn(piSourceBlocks);
  let m = TraceMemory(f.path, async () => { throw Error("offline only"); }, {}, undefined, normalize);
  try {
    expect(normalize).toHaveBeenCalledTimes(inputs.length);
    expect(warning).toHaveBeenCalledTimes(4);
    for (const [line] of warning.mock.calls) {
      expect(line).toMatch(/entry=\d+ turn=1; call mapping mismatch$/);
      expect(line).not.toMatch(/private|original|legacy projection/);
    }
    expect(m.store.db.prepare("SELECT id, content, entry_ordinal FROM source_entries ORDER BY id").all()).toEqual(before);
    expect(m.store.db.prepare("SELECT * FROM facts").all()).toEqual(facts);
    expect(m.store.db.prepare("SELECT * FROM fact_sources").all()).toEqual(bindings);
    for (const entry of entries.slice(1, 5)) {
      expect(m.store.getSourceEntry(entry.id)).toEqual(entry);
      expect(m.store.db.prepare("SELECT blocks FROM source_entries WHERE id = ?").get(entry.id)!.blocks).toBe("null");
      const note = m.tools({ kind: "manual", sessionId: f.sessionId, branch: "main", currentTurnId: f.turnId }).find(t => t.name === "note")!;
      for (const selector of ["text", "thinking", "private-call-id"]) expect(note.execute({ facts: [{ category: "observation", actor: "agent", text: "No invented fragments", source: [`T1#E${entry.entryOrdinal}@${selector}`] }] })).toContain("invalid source");
    }
    expect(m.trace("T1#E3", { full: true })).toContain("legacy projection");
    expect(m.trace("T1#E5", { full: true })).toContain("original result bytes");
    const legacyNote = m.tools({ kind: "manual", sessionId: f.sessionId, branch: "main", currentTurnId: f.turnId }).find(t => t.name === "note")!;
    expect(legacyNote.execute({ facts: [{ category: "observation", actor: "agent", text: "Legacy evidence remains usable", source: ["T1#E3", "T1#t7"] }] })).not.toContain("rejected:");
    expect(m.trace("T1#t7", { full: true })).toContain("bash");
    expect(m.trace("T1#E1@text")).toContain("normal text");
    expect(m.trace("T1#E6@private-call-id")).toContain("bash");
    expect(m.store.getSourceEntry(entries[2]!.id)!.calls[0]!.ordinal).toBe(7);
    m.close(); m = TraceMemory(f.path, async () => { throw Error("offline only"); }, {}, undefined, normalize);
    expect(normalize).toHaveBeenCalledTimes(inputs.length);
    expect(warning).toHaveBeenCalledTimes(4);
    expect(() => m.appendEntry({ ...inputs[1]!, nativeId: "new-invalid" })).toThrow(SourceNormalizationError);
    expect(m.appendEntry({ ...inputs[0]!, nativeId: "new-valid" }).entryOrdinal).toBe(7);
  } finally { m.close(); }
});

test("upgrade never swallows unexpected decoder or database transaction errors", () => {
  const f = fixture();
  f.store.appendSourceEntry(f.input("row", [f.block]));
  f.store.appendSourceEntry(f.input("bad-row", [f.block], []));
  f.store.close();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const failure = new Error("unexpected decoder failure");
  expect(() => new Store(f.path, () => { throw failure; })).toThrow(failure);
  const db = new DatabaseSync(f.path);
  db.exec("CREATE TRIGGER refuse_upgrade BEFORE UPDATE ON source_entries WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'transaction refused'); END");
  expect(() => new Store(f.path, piSourceBlocks)).toThrow("transaction refused");
  expect(db.prepare("SELECT blocks FROM source_entries").all().map(row => row.blocks)).toEqual([null, null]);
  db.exec("DROP TRIGGER refuse_upgrade"); db.close();
  const store = new Store(f.path, piSourceBlocks);
  try {
    expect(store.getSourceEntry(1)!.blocks).toHaveLength(1);
    expect(store.getSourceEntry(2)!.blocks).toBeUndefined();
  } finally { store.close(); }
});
