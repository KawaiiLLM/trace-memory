import { expect, test, vi } from "vitest";
import { sourceSeededMemory } from "./source-fixture.ts";

test("116: each manual fact call rechecks same-Turn source selection", () => {
  const memory = sourceSeededMemory(":memory:", async () => { throw Error("offline fixture"); });
  try {
    const project = memory.store.createProject({ name: "manual-path", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:fixture", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "first evidence", assistantText: "second evidence", startedAt: "now" });
    const entries = memory.store.sourcePath(session.id, "main", turn.id);
    expect(entries).toHaveLength(2);
    memory.selectEntries(session.id, "main", entries.map(entry => entry.id));
    const note = memory.tools({ kind: "manual", sessionId: session.id, currentTurnId: turn.id, branch: "main" }).find(tool => tool.name === "note")!;
    const scan = vi.spyOn(memory.store, "sourcePath");
    const first = `T${turn.id}#E1`, second = `T${turn.id}#E2`;
    for (let i = 0; i < 6; i++)
      expect(note.execute({ title: "Two sources", sources: `[${first}] First evidence\n[${second}] Second evidence` })).not.toContain("rejected:");
    expect(scan).toHaveBeenCalledTimes(6);
    expect(memory.store.factEntries(1)).toEqual(entries.map(entry => entry.id));

    memory.selectEntries(session.id, "main", [entries[1]!.id]);
    scan.mockClear();
    expect(note.execute({ title: "No longer selected", sources: `[${first}] First evidence` })).toContain("invalid source");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(memory.store.listSessionFacts(session.id)).toHaveLength(6);
    scan.mockClear();
    expect(note.execute({ title: "Still selected", sources: `[${second}] Second evidence` })).not.toContain("rejected:");
    expect(scan).toHaveBeenCalledTimes(1);
    expect(memory.store.factEntries(7)).toEqual([entries[1]!.id]);
  } finally { memory.close(); }
});
