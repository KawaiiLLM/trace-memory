import { expect, test, vi } from "vitest";
import { Store } from "../../../src/core/store/index.ts";

test("67: per-Turn resume lookup uses the Turn index, never a session scan with an optional predicate", () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "indexed", declaredBy: "mark" });
    const session = store.createSession({ host: "indexed", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const entries: number[] = [], turns: number[] = [];
    store.transaction(() => {
      for (let i = 0; i < 300; i++) {
        const turn = store.appendTurn({ sessionId: session.id, parentTurnId: turns.at(-1), kind: "turn", userPrompt: "x", startedAt: "now" });
        turns.push(turn.id);
        entries.push(store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "native", nativeId: String(i),
          role: "user", text: "x", raw: "{}", calls: [] }).id);
      }
    });
    const prepare = vi.spyOn(store.db, "prepare");
    expect(store.listSourceEntries(session.id, turns[150]).map(value => value.id)).toEqual([entries[150]]);
    const queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    // 79: listSourceEntries returns metadata (item 1), so its SELECT names every hot column, not `id` alone.
    const query = queries.find(sql => sql.startsWith("SELECT id, session_id, native_lineage, native_id, turn_id") && sql.includes("FROM source_entries"))!;
    expect(query).not.toContain("IS NULL OR");
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN ${query}`).all(turns[150]!, session.id);
    expect(plan.map(row => String(row.detail)).join("\n")).toMatch(/SEARCH source_entries USING INDEX .*\(turn_id=\?\)/);
    expect(plan.some(row => String(row.detail).includes("(session_id=?)"))).toBe(false);
    expect(store.listSourceEntries(session.id).map(value => value.id)).toEqual(entries);
    expect(store.listSourceEntries(session.id + 999, turns[150])).toEqual([]);
    store.selectSourcePath(session.id, "selected", entries.slice(0, 100));
    expect(store.listSourceEntries(session.id, turns[150], "selected")).toEqual([]);
    expect(store.listSourceEntries(session.id, turns[50], "selected").map(value => value.id)).toEqual([entries[50]]);
  } finally { store.close(); }
});
