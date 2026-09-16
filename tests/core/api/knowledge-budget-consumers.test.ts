import { afterEach, expect, test } from "vitest";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { processedBlock } from "../../../src/core/store/processing.ts";
import { tokens } from "../../../src/core/render/index.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture() {
  let captured: DreamingAgentInput | undefined;
  const memory = TraceMemory(":memory:", async raw => {
    captured = raw as DreamingAgentInput;
    return { outcome: "failure", output: "capture only", request: {} };
  }, { dreaming: { triggerTokens: 1 } });
  memories.push(memory);
  const project = memory.store.createProject({ name: "budgets", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const noted = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  let sequence = 0;
  const create = (text: string, scope: "global" | "project" | "session" = "project", topics: string[] = [], category: "constraint" | "open" | "goal" = "constraint") => {
    const result = memory.store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" }, operations: [{
      op: "create", handle: `$${++sequence}`, author: "test", text, category, scope,
      supports: [noted.facts[0]!.id], topics, reason: "consumer fixture", createdAt: "now",
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  return { memory, session, target, create, captured: () => captured };
}

test("35d ordinary delivery and compact Knowledge use the same increased database-derived capacity", () => {
  const f = fixture();
  f.memory.setKnowledgeBudget("project", 15_000); // injection becomes 25,000
  const large = f.create("body ".repeat(21_000), "project", ["charged-topic"]);
  const delivery = f.memory.injection(f.target);
  expect(tokens(delivery.text)).toBeGreaterThan(20_000);
  expect(tokens(delivery.text)).toBeLessThanOrEqual(25_000);
  expect(delivery.knowledgeCommitIds).toEqual([large.commit]);
  expect(delivery.text).toContain('topics: ["charged-topic"]');

  const compact = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  expect("native" in compact).toBe(false);
  if ("native" in compact) return;
  expect(compact.supplied.knowledgeCommitIds).toEqual([large.commit]);
  expect(compact.charged!.knowledge).toBeLessThanOrEqual(25_000);
  expect(compact.text).toContain('topics: ["charged-topic"]');
});

test("35d a lower or zero policy changes both consumers without changing Fact and Raw bases", () => {
  const f = fixture();
  f.create("body ".repeat(6_000));
  f.memory.setKnowledgeBudget("global", 0);
  f.memory.setKnowledgeBudget("project", 0);
  f.memory.setKnowledgeBudget("session", 0);
  expect(f.memory.knowledgeBudgets()).toMatchObject({ applicable: 0, injection: 5_000, dreamingProcessedInput: 5_000 });
  expect(f.memory.injection(f.target).text).toBe("");
  const compact = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  expect("native" in compact).toBe(false); // required Knowledge may use the existing required-only overflow
  if (!("native" in compact)) {
    expect(compact.charged!.knowledge).toBeGreaterThan(5_000);
    expect(compact.charged!.facts).toBeLessThanOrEqual(10_000);
    expect(compact.charged!.raw).toBeLessThanOrEqual(10_000);
  }
});

test("35d an all-zero policy admits a new Dreamer with the derived 5000-token processed window", async () => {
  const f = fixture();
  f.memory.setKnowledgeBudget("global", 0);
  f.memory.setKnowledgeBudget("project", 0);
  f.memory.setKnowledgeBudget("session", 0);
  f.create("changed");
  await f.memory.dream(f.target);
  expect(f.captured()?.admittedProcessedInputCap).toBe(5_000);
});

test("35d a larger database window never bypasses actual provider input capacity", async () => {
  const f = fixture();
  f.memory.setKnowledgeBudget("project", 15_000);
  f.create("changed ".repeat(1_000));
  await expect(f.memory.dream({ ...f.target, capacity: { inputTokens: 100, prefixTokens: 0 } })).rejects
    .toThrow(/frozen material and tools exceed model input allowance/);
  expect(f.captured()).toBeUndefined();
  expect(f.memory.store.pendingKnowledgeEvents(f.target)).not.toEqual([]);
});

test("35d a running Dreamer keeps its admitted ceiling while checks read current policy and a retry uses the new ceiling", async () => {
  let memory!: ReturnType<typeof TraceMemory>, calls = 0, prompt = "";
  memory = TraceMemory(":memory:", async raw => {
    const task = raw as DreamingAgentInput;
    calls++;
    if (calls === 1) {
      prompt = task.prompt;
      expect(task.admittedProcessedInputCap).toBe(20_000);
      const check = task.tools.find(tool => tool.name === "check")!;
      expect(check.execute({})).toContain("Current database capacities: applicable 15000; injection 20000");
      memory.setKnowledgeBudget("project", 15_000);
      const current = check.execute({});
      expect(current).toContain("Current database capacities: applicable 20000; injection 25000");
      expect(current).toContain("frozen admitted processed-input ceiling: 20000");
      expect(task.prompt).toBe(prompt);
    } else {
      expect(task.admittedProcessedInputCap).toBe(25_000);
      expect(task.prompt).toBe(prompt);
    }
    return { outcome: "failure", output: "scripted stop", request: { calls } };
  }, { dreaming: { triggerTokens: 1 } });
  memories.push(memory);
  const project = memory.store.createProject({ name: "frozen", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const fact = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "fact", source: [`T${turn.id}#user`], createdAt: "now",
  }] });
  if (!fact.ok) throw new Error(fact.problems.join("; "));
  const created = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{
    op: "create", handle: "$1", author: "test", text: "changed", category: "constraint", scope: "project",
    supports: [fact.facts[0]!.id], topics: [], reason: "trigger", createdAt: "now",
  }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  expect((await memory.dream(target)).outcome).toBe("failure");
  expect((await memory.dream(target)).outcome).toBe("failure");
  expect(calls).toBe(2);
  expect(memory.store.getClaim(session.id, "dreaming")).toBeNull();
  expect(memory.store.isKnowledgeProcessed(created.committed[0]!.commit)).toBe(false);
});

test("35d newly admitted Dreamer request fits above the retired 20k processed-input window", async () => {
  const f = fixture();
  f.memory.setKnowledgeBudget("project", 15_000);
  const commits = [f.create("一".repeat(3_900), "global", [], "constraint"),
    f.create("一".repeat(14_900), "project", [], "open"), f.create("一".repeat(900), "session", [], "goal")];
  const values = commits.map(commit => {
    const revision = f.memory.store.knowledgeRevision(commit.commit)!;
    return { knowledge: f.memory.store.getKnowledge(revision.knowledgeId)!, revision };
  });
  // Fill each independent owner representation exactly to its current cap. Shared applicable
  // rendering removes duplicate outer framing; Dreamer's own title adds it back to cross 20k.
  for (const [index, cap] of [4_000, 15_000, 1_000].entries()) {
    const value = values[index]!;
    while (tokens(processedBlock([value])) < cap) value.revision.text += "一";
    while (tokens(processedBlock([value])) > cap) value.revision.text = value.revision.text.slice(0, -1);
  }
  for (const value of values) f.memory.store.db.prepare("UPDATE knowledge_revisions SET text = ? WHERE id = ?").run(value.revision.text, value.revision.id);
  expect(f.memory.store.checkProcessedScopes(commits.map(commit => commit.commit)).problems).toEqual([]);
  const eventIds = commits.map(commit => commit.commit);
  const range = f.memory.store.retainDreamingRange(f.target, eventIds);
  const run = f.memory.store.recordRun({ kind: "dreaming", sessionId: f.session.id, branch: f.target.branch,
    dreamingRangeId: range.id, outcome: "success", createdAt: "now" });
  f.memory.store.completeDreaming(run.id, eventIds, eventIds);
  f.create("new admission trigger", "project");
  await f.memory.dream(f.target);
  const admitted = f.captured();
  expect(admitted).toBeDefined();
  expect(tokens(admitted!.text)).toBeGreaterThan(20_000);
  expect(tokens(admitted!.material.processed)).toBeLessThanOrEqual(25_000);
  expect(admitted!.material.processed.match(/\[K\d+@/g)).toHaveLength(3);
});
