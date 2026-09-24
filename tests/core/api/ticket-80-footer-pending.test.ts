import { expect, test, vi } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";

const time = "2026-09-24T00:00:00Z";
function fixture() {
  const memory = TraceMemory(":memory:", async () => ({ outcome: "failure", output: "no model" }));
  const store = memory.store;
  const project = store.createProject({ name: "footer", declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: time });
  const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "n", nativeId: "root",
    role: "user", text: "root", raw: "root", calls: [] });
  store.publishSourcePath(session.id, "main", [entry.id], turn.id, "n");
  return { memory, store, session, turn, entry };
}

test("80: footer hits never walk retained ancestors, including successive forward heads", () => {
  const { memory, store, session, turn } = fixture();
  try {
    let head = turn.id;
    memory.progress(session.id, "main", head);
    const ancestry = vi.spyOn(store, "pathTurns"), facts = vi.spyOn(store, "listBranchFacts");
    for (let i = 0; i < 8; i++) {
      expect(memory.progress(session.id, "main", head).entries).toBe(1);
      head = store.appendTurn({ sessionId: session.id, parentTurnId: head, kind: "turn", userPrompt: "next", startedAt: time }).id;
      store.appendSourcePath(session.id, "main", store.sourcePathState(session.id, "main")!, [], head, "n");
      expect(memory.progress(session.id, "main", head).entries).toBe(1);
    }
    expect(ancestry).not.toHaveBeenCalled();
    expect(facts).not.toHaveBeenCalled();
  } finally { memory.close(); }
});

test("80: Noting and a footer miss share one pending rebuild after invalidation", () => {
  const { memory, store, session, turn, entry } = fixture();
  try {
    memory.progress(session.id, "main", turn.id);
    // An uncovered, non-prefix mutation requires the pending set to be rebuilt once.
    const second = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "n", nativeId: "second",
      role: "user", text: "second", raw: "second", calls: [] });
    store.appendSourcePath(session.id, "main", store.sourcePathState(session.id, "main")!, [second.id], turn.id, "n");
    expect(store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
      facts: [], entryIds: [second.id] }).ok).toBe(true);
    const cold = vi.spyOn(store as any, "pathSourceMeta");
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    memory.taskEligibility("noting", target);
    expect(cold).toHaveBeenCalledTimes(1);
    expect(memory.progress(session.id, "main", turn.id).entries).toBe(1);
    expect(cold).toHaveBeenCalledTimes(1);
    expect(store.pendingEntryIds(session.id, "main", turn.id)).toEqual([entry.id]);
  } finally { memory.close(); }
});

test("80: a footer cache never leaks facts to a newer sibling head", () => {
  const { memory, store, session, turn } = fixture();
  try {
    const child = store.appendTurn({ sessionId: session.id, parentTurnId: turn.id, kind: "turn", userPrompt: "child", startedAt: time });
    const source = store.appendSourceEntry({ sessionId: session.id, turnId: child.id, nativeLineage: "n", nativeId: "child",
      role: "user", text: "child", raw: "child", calls: [] });
    store.appendSourcePath(session.id, "main", store.sourcePathState(session.id, "main")!, [source.id], child.id, "n");
    expect(store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time }, facts: [{
      turnId: child.id, entryIds: [source.id], category: "observation", actor: "user", text: "child fact",
      source: [`T${child.id}#E1`], createdAt: time,
    }] }).ok).toBe(true);
    expect(memory.progress(session.id, "main", child.id).facts).toBe(1);
    const sibling = store.appendTurn({ sessionId: session.id, parentTurnId: turn.id, kind: "turn", userPrompt: "sibling", startedAt: time });
    expect(memory.progress(session.id, "main", sibling.id).facts).toBe(0);
  } finally { memory.close(); }
});
