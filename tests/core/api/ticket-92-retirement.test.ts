import { expect, test } from "vitest";
import { hydrate, sourceSeededMemory, type NotingAgentInput } from "../../source-fixture.ts";
import { legacyFacts } from "../../support/seed.ts";
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
    expect(f.memory.status(f.session.id, "main", f.turn.id)).not.toContain("Last consolidation:");
    const run = f.store.recordRun({ kind: "consolidation", sessionId: f.session.id, branch: "main", createdAt: "2026-01-01T00:00:00Z", outcome: "success",
      response: JSON.stringify({ nativeLog: "/historical/consolidator.jsonl", usage: { input: 100, output: 20, cost: { total: 0.5 } } }) });
    expect(f.memory.trace(`R${run.id}`, { full: true })).toContain("consolidation");
    expect(f.memory.trace(`R${run.id}`, { full: true })).toContain("/historical/consolidator.jsonl");
    expect(f.memory.spend(f.session.id).runs.consolidation).toBe(1);
    expect(f.memory.spend(f.session.id).costs.consolidation).toBe(0.5);
    expect(f.memory.spend(f.session.id).cost).toBe(0.5);
    expect(f.memory.status(f.session.id, "main", f.turn.id)).toContain(`Last consolidation: run ${run.id} success`);
    expect((await f.memory.noting(f.target)).outcome).toBe("success");
    expect(f.invoked).toEqual(["noting"]);
    expect(f.memory.status(f.session.id, "main", f.turn.id)).not.toContain("to consolidate");
  } finally { f.memory.close(); }
});

test("92/07: historical unconsolidated facts neither block project movement nor get certified", () => {
  const f = fixture();
  try {
    const user = hydrate(f.store.listSourceEntries(f.session.id, f.turn.id), f.store).find(entry => entry.role === "user")!;
    const written = legacyFacts(f.store, { kind: "manual", sessionId: f.session.id, createdAt: "now" }, [{
      sources: [{ entry: user, address: `T${f.turn.id}#user` }], category: "observation", actor: "user", text: "historical pending fact ".repeat(800), createdAt: "now",
    }]);
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
    const user = hydrate(f.store.listSourceEntries(f.session.id, f.turn.id), f.store).find(entry => entry.role === "user")!;
    const facts = legacyFacts(f.store, { kind: "manual", sessionId: f.session.id, createdAt: "now" }, [{
      sources: [{ entry: user, address: `T${f.turn.id}#user` }], category: "observation", actor: "user", text: "historical", createdAt: "now",
    }]);
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
