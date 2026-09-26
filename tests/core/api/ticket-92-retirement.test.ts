import { expect, test } from "vitest";
import { sourceSeededMemory, type NotingAgentInput } from "../../source-fixture.ts";
import { MEMORY_PHASES } from "../../../src/hosts/phase-settings.ts";
import { historicalConsolidation } from "../../noting-knowledge-fixture.ts";

function fixture() {
  const invoked: string[] = [];
  const memory = sourceSeededMemory(":memory:", async raw => {
    const task = raw as NotingAgentInput; invoked.push(task.kind);
    task.reportRequest({ fixture: "retirement" });
    task.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    return { outcome: "success", output: "done", request: { fixture: "retirement" } };
  });
  const store = memory.store;
  const project = store.createProject({ name: "retirement", declaredBy: "mark" });
  const session = store.createSession({ projectId: project.id, host: "pi:retirement", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return { memory, store, session, project, turn, target, invoked };
}

test("92/07: only N/D admit; historical C audit and costs keep original labels", async () => {
  const f = fixture();
  try {
    expect(MEMORY_PHASES).toEqual(["noting", "dreaming"]);
    expect("consolidate" in f.memory).toBe(false);
    const run = f.store.recordRun({ kind: "consolidation", sessionId: f.session.id, branch: "main", createdAt: "2026-01-01T00:00:00Z", outcome: "success",
      response: JSON.stringify({ nativeLog: "/historical/consolidator.jsonl", usage: { input: 100, output: 20, cost: { total: 0.5 } } }) });
    expect(f.memory.trace(`R${run.id}`, { full: true })).toContain("consolidation");
    expect(f.memory.trace(`R${run.id}`, { full: true })).toContain("/historical/consolidator.jsonl");
    expect(f.memory.spend(f.session.id).runs.consolidation).toBe(1);
    expect(f.memory.spend(f.session.id).costs.consolidation).toBe(0.5);
    expect(f.memory.spend(f.session.id).cost).toBe(0.5);
    expect((await f.memory.noting(f.target)).outcome).toBe("success");
    expect(f.invoked).toEqual(["noting"]);
    expect(f.memory.status(f.session.id, "main", f.turn.id)).not.toContain("to consolidate");
  } finally { f.memory.close(); }
});

test("92/07: historical unconsolidated facts neither block project movement nor get certified", () => {
  const f = fixture();
  try {
    const written = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "now" }, facts: [{
      turnId: f.turn.id, category: "observation", actor: "user", text: "historical pending fact ".repeat(800), source: [`T${f.turn.id}#user`], createdAt: "now",
    }] });
    if (!written.ok) throw new Error(written.problems.join("; "));
    const before = f.store.listSessionFacts(f.session.id);
    expect(f.memory.declareProject(f.session.id, "new-project", "mark", f.target)).toContain("new-project");
    expect(f.store.listSessionFacts(f.session.id)).toEqual(before);
    expect(f.store.listConsolidatedFacts(written.runId)).toEqual([]);
    expect(f.store.consolidationBatch(f.session.id, "main", f.turn.id).map(fact => fact.id)).toEqual(before.map(fact => fact.id));
  } finally { f.memory.close(); }
});

test("92/07: history processing rows survive and cannot supply a live C seat", () => {
  const f = fixture();
  try {
    const facts = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "now" }, facts: [{
      turnId: f.turn.id, category: "observation", actor: "user", text: "historical", source: [`T${f.turn.id}#user`], createdAt: "now",
    }] });
    if (!facts.ok) throw new Error(facts.problems.join("; "));
    historicalConsolidation(f.store, f.session.id, facts.facts.map(fact => fact.id));
    const old = f.store.listRuns(f.session.id).find(run => run.kind === "consolidation")!;
    f.store.db.prepare("INSERT INTO task_claims(session_id,phase,executor_id,token,expires_at,borrowed,reserved) VALUES (?,?,?,?,?,0,0)")
      .run(f.session.id, "consolidation", "legacy", "old-token", Date.now() + 100000);
    f.store.reopenSession(f.session.id, "new-executor");
    expect(f.store.listConsolidatedFacts(old.id).map(fact => fact.id)).toEqual(facts.facts.map(fact => fact.id));
    const moved = f.memory.declareProject(f.session.id, "history-moved", "mark", f.target);
    expect(moved).toContain("history-moved");
    expect(f.store.db.prepare("SELECT token FROM task_claims WHERE phase='consolidation'").get()?.token).toBe("old-token");
  } finally { f.memory.close(); }
});
