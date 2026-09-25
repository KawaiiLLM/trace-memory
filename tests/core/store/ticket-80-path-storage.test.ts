import { expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StaleSourcePathError, Store } from "../../../src/core/store/index.ts";

const at = "2026-09-23T00:00:00Z";
function fixture(store: Store) {
  const project = store.createProject({ name: "path-storage", declaredBy: "mark" });
  const owner = store.createSession({ host: "owner", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const foreign = store.createSession({ host: "foreign", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
  const add = (sessionId: number, parentTurnId: number | null, name: string) => {
    const turn = store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: name, startedAt: at });
    const entry = store.appendSourceEntry({ sessionId, turnId: turn.id, nativeLineage: "native", nativeId: name,
      role: "user", text: name, raw: "{}", calls: [] });
    return { turn, entry };
  };
  return { owner, foreign, add };
}

test("80: append validates persisted prefix and delta without reading its membership", () => {
  const store = new Store(":memory:");
  try {
    const { owner, foreign, add } = fixture(store);
    const a = add(owner.id, null, "a"), b = add(owner.id, a.turn.id, "b");
    const c = add(owner.id, b.turn.id, "c"), alternate = add(owner.id, a.turn.id, "alternate");
    const outsider = add(foreign.id, null, "outsider");
    store.publishSourcePath(owner.id, "main", [a.entry.id, b.entry.id], b.turn.id, "native");
    const before = store.sourcePathState(owner.id, "main")!;
    const spy = vi.spyOn(store.db, "prepare");
    const after = store.appendSourcePath(owner.id, "main", before, [c.entry.id], c.turn.id, "native");
    const sql = spy.mock.calls.map(([statement]) => statement);
    spy.mockRestore();
    expect(sql.filter(statement => /source_path_entries/.test(statement))).toEqual([
      expect.stringContaining("SELECT 1 FROM source_path_entries"),
      expect.stringContaining("INSERT INTO source_path_entries"),
    ]);
    expect(after).toEqual({ count: 3, tailId: c.entry.id, version: before.version });
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual([a.entry.id, b.entry.id, c.entry.id]);
    for (const ids of [[c.entry.id], [outsider.entry.id], [999999], [c.entry.id, c.entry.id]])
      expect(() => store.appendSourcePath(owner.id, "main", after, ids, c.turn.id, "native")).toThrow();
    expect(store.sourcePathState(owner.id, "main")).toEqual(after);
    const d = add(owner.id, c.turn.id, "d");
    const middleSibling = add(owner.id, b.turn.id, "middle sibling");
    expect(() => store.appendSourcePath(owner.id, "main", after,
      [middleSibling.entry.id, d.entry.id], d.turn.id, "native")).toThrow(/tail is not an extension/);
    expect(store.sourcePathState(owner.id, "main")).toEqual(after);
    store.selectSourcePath(owner.id, "main", [a.entry.id, alternate.entry.id, c.entry.id]);
    expect(() => store.appendSourcePath(owner.id, "main", after, [b.entry.id], c.turn.id, "native"))
      .toThrow(StaleSourcePathError); // same length and tail, different middle
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual([a.entry.id, alternate.entry.id, c.entry.id]);
  } finally { store.close(); }
});

test("80: non-descendant head and failed writes cannot change membership or cursor", () => {
  const store = new Store(":memory:");
  try {
    const { owner, add } = fixture(store);
    const a = add(owner.id, null, "a"), b = add(owner.id, a.turn.id, "b");
    const sibling = add(owner.id, a.turn.id, "sibling");
    store.publishSourcePath(owner.id, "main", [a.entry.id], a.turn.id, "native");
    const state = store.sourcePathState(owner.id, "main")!;
    expect(() => store.appendSourcePath(owner.id, "main", state, [b.entry.id], sibling.turn.id, "native")).toThrow(/head is not an extension/);
    expect(store.sourcePathState(owner.id, "main")).toEqual(state);
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual([a.entry.id]);
    expect(store.db.prepare("SELECT head_turn_id FROM session_lineage_cursors WHERE session_id = ?").get(owner.id))
      .toEqual({ head_turn_id: a.turn.id });
    const advance = add(owner.id, a.turn.id, "head-only");
    expect(store.appendSourcePath(owner.id, "main", state, [], advance.turn.id, "native")).toEqual(state);
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual([a.entry.id]);
    expect(store.db.prepare("SELECT head_turn_id FROM session_lineage_cursors WHERE session_id = ?").get(owner.id))
      .toEqual({ head_turn_id: advance.turn.id });
  } finally { store.close(); }
});

test("80: an empty append cannot publish a head owned by another session", () => {
  const store = new Store(":memory:");
  try {
    const { owner, foreign, add } = fixture(store);
    const root = add(owner.id, null, "root"), outsider = add(foreign.id, null, "outsider");
    store.publishSourcePath(owner.id, "empty", [], root.turn.id, "native");
    const state = store.sourcePathState(owner.id, "empty")!;
    expect(() => store.appendSourcePath(owner.id, "empty", state, [], outsider.turn.id, "native"))
      .toThrow(/head/);
    expect(store.sourcePathState(owner.id, "empty")).toEqual(state);
    expect(store.db.prepare("SELECT head_turn_id FROM session_lineage_cursors WHERE session_id = ?").get(owner.id))
      .toEqual({ head_turn_id: root.turn.id });
  } finally { store.close(); }
});

test("80: incremental ancestry cannot pass through another session's Turn", () => {
  const store = new Store(":memory:");
  try {
    const { owner, foreign, add } = fixture(store);
    const root = add(owner.id, null, "root");
    const outsider = add(foreign.id, root.turn.id, "outsider");
    const head = add(owner.id, outsider.turn.id, "head");
    store.publishSourcePath(owner.id, "main", [root.entry.id], root.turn.id, "native");
    const state = store.sourcePathState(owner.id, "main")!;
    expect(() => store.publishSourcePath(owner.id, "main", [root.entry.id, head.entry.id], head.turn.id, "native"))
      .toThrow(/ancestry/);
    expect(() => store.appendSourcePath(owner.id, "main", state, [head.entry.id], head.turn.id, "native"))
      .toThrow(/extension/);
    expect(store.sourcePathState(owner.id, "main")).toEqual(state);
  } finally { store.close(); }
});

test("80: whole-path membership is one ordered array with header and position checks", () => {
  const store = new Store(":memory:");
  try {
    const { owner, add } = fixture(store);
    const a = add(owner.id, null, "a"), b = add(owner.id, a.turn.id, "b"), c = add(owner.id, b.turn.id, "c");
    const ids = [c.entry.id, a.entry.id, b.entry.id];
    store.selectSourcePath(owner.id, "main", ids);
    const reads = vi.spyOn(store.db, "prepare");
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual(ids);
    const sql = reads.mock.calls.map(([statement]) => statement).join("\n");
    expect(sql).toContain("ORDER BY j.position");
    expect(sql).toContain("JOIN source_entries"); // ownership checked without loading Raw
    expect(sql).not.toContain("source_entry_raw");
    const membershipSql = reads.mock.calls.find(([statement]) => statement.includes("ORDER BY j.position"))![0];
    reads.mockRestore();
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${membershipSql}`).all(owner.id, "main", 0);
    expect(plan.some(row => /TEMP B-TREE/.test(String(row.detail)))).toBe(false);
    store.db.exec("PRAGMA reverse_unordered_selects = ON");
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual(ids);
    store.db.prepare("UPDATE source_paths SET length = 4 WHERE session_id = ?").run(owner.id);
    expect(() => store.selectedSourceEntryIds(owner.id, "main")).toThrow("stored source path is malformed");
    store.db.prepare("UPDATE source_paths SET length = 3, tail_entry_id = ? WHERE session_id = ?").run(c.entry.id, owner.id);
    expect(() => store.selectedSourceEntryIds(owner.id, "main")).toThrow("stored source path is malformed");
    store.db.prepare("UPDATE source_paths SET tail_entry_id = ? WHERE session_id = ?").run(b.entry.id, owner.id);
    store.db.prepare("UPDATE source_path_entries SET position = 5 WHERE path_id = (SELECT id FROM source_paths WHERE session_id = ?) AND position = 2")
      .run(owner.id);
    // Direct SQL corruption bypasses the write protocol; changing the version forces a full check.
    store.db.prepare("UPDATE source_paths SET version = version + 1 WHERE session_id = ?").run(owner.id);
    expect(() => store.selectedSourceEntryIds(owner.id, "main")).toThrow("stored source path is malformed");
    store.selectSourcePath(owner.id, "empty", []);
    expect(store.selectedSourceEntryIds(owner.id, "empty")).toEqual([]);
    expect(store.selectedSourceEntryIds(owner.id, "absent")).toBeNull();
  } finally { store.close(); }
});

test("80: old JSON paths migrate atomically with exact order and reopen without replay", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-80-path-")), file = join(directory, "trace.db");
  try {
    let store = new Store(file);
    const { owner, add } = fixture(store);
    const a = add(owner.id, null, "a"), b = add(owner.id, a.turn.id, "b");
    store.publishSourcePath(owner.id, "main", [b.entry.id, a.entry.id], b.turn.id, "native");
    store.close();
    const db = new DatabaseSync(file);
    db.exec("PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE; DROP TABLE source_path_entries; CREATE TABLE old_paths (session_id INTEGER NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL, entry_ids TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0, hwm_entry_id INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(session_id,branch));");
    db.prepare("INSERT INTO old_paths SELECT session_id,branch,?,version,hwm_entry_id FROM source_paths")
      .run(JSON.stringify([b.entry.id, a.entry.id]));
    db.exec("DROP TABLE source_paths; ALTER TABLE old_paths RENAME TO source_paths; COMMIT");
    db.close();
    const legacy = new DatabaseSync(file);
    expect(legacy.prepare("SELECT entry_ids FROM source_paths WHERE session_id = ?").get(owner.id))
      .toEqual({ entry_ids: JSON.stringify([b.entry.id, a.entry.id]) });
    legacy.prepare(`INSERT INTO source_paths(session_id,branch,entry_ids,version,hwm_entry_id) VALUES (?, 'zbad', ?, 0, 0)`)
      .run(owner.id, JSON.stringify([b.entry.id, b.entry.id]));
    legacy.close();
    expect(() => new Store(file)).toThrow(/stored source path is malformed|UNIQUE constraint/);
    const afterFailure = new DatabaseSync(file);
    expect(afterFailure.prepare("PRAGMA table_info(source_paths)").all().some(row => row.name === "entry_ids")).toBe(true);
    expect(afterFailure.prepare("SELECT 1 FROM sqlite_master WHERE name = 'source_path_entries'").get()).toBeUndefined();
    expect(afterFailure.prepare("SELECT branch,entry_ids FROM source_paths WHERE session_id = ? ORDER BY branch")
      .all(owner.id)).toEqual([
        { branch: "main", entry_ids: JSON.stringify([b.entry.id, a.entry.id]) },
        { branch: "zbad", entry_ids: JSON.stringify([b.entry.id, b.entry.id]) },
      ]);
    afterFailure.prepare("DELETE FROM source_paths WHERE session_id = ? AND branch = 'zbad'").run(owner.id);
    afterFailure.close();
    store = new Store(file);
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual([b.entry.id, a.entry.id]);
    expect(store.sourcePathState(owner.id, "main")).toEqual({ count: 2, tailId: a.entry.id, version: 0 });
    const header = store.db.prepare("SELECT id, branch FROM source_paths WHERE session_id = ?").get(owner.id)!;
    expect(store.db.prepare("SELECT path_id, position, entry_id FROM source_path_entries ORDER BY position").all())
      .toEqual([{ path_id: header.id, position: 0, entry_id: b.entry.id },
        { path_id: header.id, position: 1, entry_id: a.entry.id }]);
    expect(store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'source_path_entries'").get()!.sql)
      .toContain("WITHOUT ROWID");
    expect(store.db.prepare("PRAGMA table_info(source_path_entries)").all().map(row => row.name))
      .toEqual(["path_id", "position", "entry_id"]);
    expect(store.db.prepare("PRAGMA foreign_key_list(source_path_entries)").all().map(row => row.table))
      .toContain("source_paths");
    expect(() => store.db.prepare("INSERT INTO source_path_entries(path_id,position,entry_id) VALUES (?,?,?)")
      .run(Number(header.id), 2, b.entry.id)).toThrow(/UNIQUE constraint/);
    store.close(); store = new Store(file);
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual([b.entry.id, a.entry.id]);
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
