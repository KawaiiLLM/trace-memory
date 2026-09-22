import { expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

const at = "2026-09-22T00:00:00Z";
function session(store: Store, host: string) {
  const project = store.findProjectByName("publication") ?? store.createProject({ name: "publication", declaredBy: "mark" });
  return store.createSession({ host, projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
}
function append(store: Store, sessionId: number, parentTurnId: number | null, id: string) {
  const turn = store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: id, startedAt: at });
  const entry = store.appendSourceEntry({ sessionId, turnId: turn.id, nativeLineage: "native", nativeId: id,
    role: "user", text: id, raw: "{}", calls: [] });
  return { turn, entry };
}

test("67: 20k-entry atomic publication loads identities once and never reloads the persisted path", () => {
  const store = new Store(":memory:");
  try {
    const owner = session(store, "long");
    let head: number | null = null;
    const ids: number[] = [];
    store.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        const value = append(store, owner.id, head, String(i));
        head = value.turn.id; ids.push(value.entry.id);
      }
    });
    const prepares = vi.spyOn(store.db, "prepare");
    const turns = vi.spyOn(store, "pathTurns");
    const start = performance.now();
    store.publishSourcePath(owner.id, "main", ids, head!, "native");
    const elapsed = performance.now() - start;
    const statements = prepares.mock.calls.map(([sql]) => sql);
    expect(statements.filter(sql => /SELECT .*FROM source_entries/.test(sql))).toHaveLength(1);
    expect(statements.some(sql => /SELECT entry_ids FROM source_paths/.test(sql))).toBe(false);
    expect(turns).toHaveBeenCalledTimes(1);
    expect(statements.length).toBeLessThanOrEqual(7);
    prepares.mockRestore(); turns.mockRestore();
    expect(store.selectedSourceEntryIds(owner.id, "main")).toEqual(ids);
    expect(store.db.prepare("SELECT lineage, branch, head_turn_id FROM session_lineage_cursors").all())
      .toEqual([{ lineage: "native", branch: "main", head_turn_id: head }]);
    console.info(JSON.stringify({ fixture: "67 atomic publication", entries: ids.length, elapsedMs: elapsed, prepares: statements.length }));
  } finally { store.close(); }
}, 60_000);

test("67: publication rejects malformed ownership/ancestry atomically and preserves independent lineages after reopen", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-67-publication-")), file = join(directory, "trace.db");
  let store = new Store(file);
  try {
    const owner = session(store, "owner"), other = session(store, "other");
    const root = append(store, owner.id, null, "root");
    const left = append(store, owner.id, root.turn.id, "left"), right = append(store, owner.id, root.turn.id, "right");
    const foreign = append(store, other.id, null, "foreign");
    store.publishSourcePath(owner.id, "left", [root.entry.id, left.entry.id], left.turn.id, "parent");
    store.publishSourcePath(owner.id, "right", [root.entry.id, right.entry.id], right.turn.id, "child");
    const before = () => ({ paths: store.db.prepare("SELECT * FROM source_paths ORDER BY branch").all(),
      cursors: store.db.prepare("SELECT * FROM session_lineage_cursors ORDER BY lineage").all() });
    const original = before();
    for (const invalid of [
      () => store.publishSourcePath(owner.id, "left", [root.entry.id, root.entry.id], root.turn.id, "parent"),
      () => store.publishSourcePath(owner.id, "left", [foreign.entry.id], root.turn.id, "parent"),
      () => store.publishSourcePath(owner.id, "left", [999_999], root.turn.id, "parent"),
      () => store.publishSourcePath(owner.id, "left", [root.entry.id, right.entry.id], left.turn.id, "parent"),
      () => store.publishSourcePath(owner.id, "left", [root.entry.id], foreign.turn.id, "parent"),
      () => store.publishSourcePath(owner.id, "left", [root.entry.id], root.turn.id, ""),
    ]) {
      expect(invalid).toThrow();
      expect(before()).toEqual(original);
    }
    // Fail after source publication, exercising actual transaction rollback rather than only validation.
    store.db.exec("CREATE TRIGGER reject_cursor BEFORE UPDATE ON session_lineage_cursors BEGIN SELECT RAISE(ABORT, 'cursor fault'); END");
    expect(() => store.publishSourcePath(owner.id, "left", [root.entry.id], root.turn.id, "parent")).toThrow("cursor fault");
    expect(before()).toEqual(original);
    store.db.exec("DROP TRIGGER reject_cursor");
    store.publishSourcePath(owner.id, "left", [root.entry.id], root.turn.id, "parent");
    const changed = before();
    store.close(); store = new Store(file);
    expect(before()).toEqual(changed);
    expect(store.selectedSourceEntryIds(owner.id, "right")).toEqual([root.entry.id, right.entry.id]);
    // Rewinding the head while retaining a longer native path is legal, as is a head beyond its tail.
    store.publishSourcePath(owner.id, "left", [root.entry.id, left.entry.id], root.turn.id, "parent");
    store.publishSourcePath(owner.id, "left", [root.entry.id], left.turn.id, "parent");
  } finally { store.close(); rmSync(directory, { recursive: true, force: true }); }
});
