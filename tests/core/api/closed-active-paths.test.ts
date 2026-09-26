import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type RunAgent, type NotingAgentInput } from "../../source-fixture.ts";

const at = "2026-09-25T00:00:00Z";
type Phase = "noting";
function fixture(db = ":memory:") {
  let requests = 0;
  const agent: RunAgent = async raw => {
    requests++;
    const input = raw as NotingAgentInput;
    if (input.kind === "noting") {
      input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
      input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    }
    return { outcome: "success", output: "", request: {} };
  };
  const memory = sourceSeededMemory(db, agent);
  const store = memory.store;
  const project = store.createProject({ name: "cursor-borrow", declaredBy: "mark" });
  const session = (closed: boolean) => {
    const s = store.createSession({ host: "fixture", projectId: project.id, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    if (closed) store.closeSession(s.id);
    return s.id;
  };
  const executor = session(false), target = session(false);
  const turn = (parentTurnId: number | null, text: string) => store.appendTurn({ sessionId: target, kind: "turn", parentTurnId,
    userPrompt: text, assistantText: `reply ${text}`, startedAt: at });
  const root = turn(null, "root"), left = turn(root.id, "left"), later = turn(left.id, "later"), right = turn(root.id, "right");
  const entries = (ids: number[]) => store.listSourceEntries(target).filter(e => ids.includes(e.turnId)).map(e => e.id);
  memory.selectEntries(target, "left", entries([root.id, left.id, later.id]));
  memory.selectEntries(target, "right", entries([root.id, right.id]));
  memory.selectEntries(target, "abandoned", entries([root.id]));
  const fact = (turnId: number, branch: string) => {
    const result = store.commitNotingRun({ run: { kind: "manual", sessionId: target, branch, createdAt: at }, facts: [
      { turnId, category: "observation", actor: "user", text: `fact ${turnId}`, source: [`T${turnId}#user`], createdAt: at } ] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.facts[0]!.id;
  };
  const facts = { root: fact(root.id, "left"), left: fact(left.id, "left"), later: fact(later.id, "left"), right: fact(right.id, "right") };
  store.setCurrentPath(target, "left", left.id, "one");
  store.closeSession(target);
  const candidates = (phase: Phase) => store.closedTasks(phase, executor, "project");
  const run = (_phase: Phase, branch: string, headTurnId: number) =>
    memory.noting({ sessionId: target, branch, headTurnId, borrowed: true, executorSessionId: executor });
  return { memory, store, executor, target, root, left, later, right, facts, candidates, run, get requests() { return requests; } };
}

test.each(["noting"] as const)("%s selects active ancestors, rewound exact head, retained lineages and reactivation", async phase => {
  const f = fixture();
  try {
    const target = (branch: string, headTurnId: number) => ({ sessionId: f.target, branch, headTurnId });
    expect(f.candidates(phase)).toEqual([target("left", f.left.id)]);
    expect(f.candidates(phase)).not.toContainEqual(target("left", f.later.id));
    expect(f.store.pendingEntries(f.target, "left", f.left.id).map(e => e.turnId)).toContain(f.root.id);
    f.store.setCurrentPath(f.target, "right", f.right.id, "two");
    f.store.setCurrentPath(f.target, "left", f.left.id, "duplicate");
    expect(f.candidates(phase)).toEqual([target("left", f.left.id), target("right", f.right.id)]);
    const before = f.requests;
    f.store.setCurrentPath(f.target, "right", f.right.id, "one");
    f.store.setCurrentPath(f.target, "right", f.right.id, "duplicate");
    expect(f.requests).toBe(before); // navigation alone does not launch a worker
    expect(f.candidates(phase)).toEqual([target("right", f.right.id)]);
    expect((await f.run(phase, "left", f.left.id)).outcome).toBe("dropped");
    expect(f.requests).toBe(before);
    expect((await f.run(phase, "right", f.right.id)).outcome).toBe("success");
    expect(f.requests).toBe(before + 1);
    f.store.setCurrentPath(f.target, "left", f.later.id, "one");
    expect(f.candidates(phase)).toContainEqual(target("left", f.later.id));
    if (phase === "noting") expect(f.store.pendingEntries(f.target, "left", f.later.id).map(e => e.turnId))
      .toEqual([f.left.id, f.left.id, f.later.id, f.later.id]); // shared root was processed on right
  } finally { f.memory.close(); }
});

test.each(["noting"] as const)("%s no-cursor compatibility and invalid cursor fail the whole scan", phase => {
  const f = fixture();
  try {
    f.store.db.prepare("DELETE FROM session_lineage_cursors WHERE session_id = ?").run(f.target);
    expect(f.candidates(phase).map(t => t.branch)).toEqual(["abandoned", "left", "right"]);
    f.store.setCurrentPath(f.target, "left", f.left.id, "one");
    expect(f.candidates(phase).map(t => t.branch)).toEqual(["left"]);
    f.store.db.prepare("UPDATE session_lineage_cursors SET head_turn_id = ? WHERE session_id = ?").run(f.right.id, f.target);
    expect(() => f.candidates(phase)).toThrow(/invalid borrowed cursor/);
  } finally { f.memory.close(); }
});

test.each(["noting"] as const)("%s rejects a candidate moved through another connection before admission", async phase => {
  const dir = mkdtempSync(join(tmpdir(), "tm-89-cursor-"));
  const path = join(dir, "memory.db");
  const f = fixture(path);
  const other = sourceSeededMemory(path, async () => ({ outcome: "success", output: "", request: {} }));
  try {
    expect(f.candidates(phase)).toEqual([{ sessionId: f.target, branch: "left", headTurnId: f.left.id }]);
    other.store.db.prepare("UPDATE session_lineage_cursors SET head_turn_id = ? WHERE session_id = ? AND lineage = ?")
      .run(f.right.id, f.target, "one");
    await expect(f.run(phase, "left", f.left.id)).rejects.toThrow(/invalid borrowed cursor/);
    expect(f.requests).toBe(0);
    expect(f.store.getClaim(f.target, phase)).toBeNull();
    other.store.setCurrentPath(f.target, "right", f.right.id, "one");
    const before = f.requests;
    expect((await f.run(phase, "left", f.left.id)).outcome).toBe("dropped");
    expect(f.requests).toBe(before);
    expect(f.store.getClaim(f.target, phase)).toBeNull();
    expect(f.store.pendingEntries(f.target, "left", f.left.id).length).toBeGreaterThan(0);
    expect(f.store.consolidationBatch(f.target, "left", f.left.id).length).toBeGreaterThan(0);
    expect(f.candidates(phase)).toEqual([{ sessionId: f.target, branch: "right", headTurnId: f.right.id }]);
  } finally { other.close(); f.memory.close(); rmSync(dir, { recursive: true, force: true }); }
});
