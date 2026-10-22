import { afterEach, expect, test } from "vitest";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { dreamerFixture } from "../../support/dreamer.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { fixtureTitle, legacyFacts } from "../../support/seed.ts";

const memories: Parameters<typeof dreamerFixture>[0] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture(runAgent?: Parameters<typeof TraceMemory>[1]) {
  const captured: DreamingAgentInput[] = [];
  const memory = TraceMemory(":memory:", async raw => {
    captured.push(raw as DreamingAgentInput);
    return runAgent ? runAgent(raw) : { outcome: "failure", output: "capture only", request: {} };
  }, { writing: { bodyTokens: 1_000_000 } });
  memories.push(memory);
  const project = memory.store.createProject({ name: "budgets", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "budget",
    role: "user", text: "evidence", raw: "evidence", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const noted = legacyFacts(memory.store, { kind: "manual", sessionId: session.id, createdAt: "now" }, [{
    sources: [{ entry, address: `T${turn.id}#user` }], category: "decision", actor: "user", text: "evidence", createdAt: "now",
  }]);
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  let sequence = 0;
  const create = (text: string, scope: "global" | "project" | "session" = "project", topics: string[] = [], category: "constraint" | "open" | "goal" = "constraint") => {
    const result = memory.store.commitConsolidationRun({ path: target,
      run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" }, operations: [{
        op: "create", title: fixtureTitle(text), handle: `$${++sequence}`, author: "test", text, category, scope,
        supports: [noted.facts[0]!.id], topics, reason: "consumer fixture", createdAt: "now",
      }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  return { memory, session, target, create, captured };
}

function zeroBase(memory: ReturnType<typeof TraceMemory>) {
  memory.setKnowledgeBudget("global", 0);
  memory.setKnowledgeBudget("project", 0);
  memory.setKnowledgeBudget("session", 0);
}

test("73: foreground and compact Knowledge share the base plus the configured shared allowance", () => {
  const f = fixture();
  f.memory.config.compaction.sharedAllowanceTokens = 25_000;
  const cap = f.memory.knowledgeBudgets().injection + f.memory.config.compaction.sharedAllowanceTokens;
  const large = f.create("body ".repeat(30_000), "project", ["charged-topic"]);
  const delivery = f.memory.injection(f.target);
  expect(tokens(delivery.text)).toBeGreaterThan(20_000);
  expect(tokens(delivery.text)).toBeLessThanOrEqual(cap);
  expect(delivery.knowledgeCommitIds).toEqual([large.commit]);
  expect(delivery.text).toContain('topics: ["charged-topic"]');

  const compact = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  expect("native" in compact).toBe(false);
  if ("native" in compact) return;
  expect(compact.supplied.knowledgeCommitIds).toEqual([large.commit]);
  expect(compact.charged!.knowledge).toBeGreaterThan(20_000);
  expect(compact.charged!.knowledge).toBeLessThanOrEqual(cap);
  expect(compact.text).toContain('topics: ["charged-topic"]');
});

test("73: zero Knowledge base borrows only the configured shared allowance", () => {
  const f = fixture();
  const item = f.create("body ".repeat(6_000));
  zeroBase(f.memory);
  expect(f.memory.knowledgeBudgets()).toEqual({
    global: 0, project: 0, session: 0, applicable: 0, injection: 0,
  });
  f.memory.config.compaction.sharedAllowanceTokens = 20_000;
  const borrowed = f.memory.injection(f.target);
  expect(borrowed.knowledgeCommitIds).toEqual([item.commit]);
  expect(tokens(borrowed.text)).toBeLessThanOrEqual(20_000);

  f.memory.config.compaction.sharedAllowanceTokens = 0;
  expect(f.memory.injection(f.target).text).toBe("");
  const compact = f.memory.compact(f.session.id, "main", f.target.headTurnId);
  expect("native" in compact).toBe(false);
  if (!("native" in compact)) {
    expect(compact.supplied.knowledgeCommitIds).toEqual([]);
    expect(compact.charged!.facts).toBeLessThanOrEqual(10_000);
    expect(compact.charged!.raw).toBeLessThanOrEqual(10_000);
  }
});

test("73: an unsafe combined envelope refuses instead of wrapping, not a trigger sum any more", () => {
  const f = fixture();
  f.create("changed");
  f.memory.config.compaction.sharedAllowanceTokens = Number.MAX_SAFE_INTEGER;
  expect(() => f.memory.injection(f.target)).toThrow(/derived foreground Knowledge capacity must be a safe integer/);
  expect(() => f.memory.compact(f.session.id, "main", f.target.headTurnId)).toThrow(/compact envelope must be a safe integer/);
});

test("64c a larger configured Knowledge window never bypasses actual provider input capacity", async () => {
  const f = dreamerFixture(memories);
  f.item("changed ".repeat(1_000));
  await expect(f.memory.dream({ ...f.target, capacity: { inputTokens: 100 } })).rejects
    .toThrow(/Dreaming capacity: the knowledge prefix and tools exceed the model input allowance/);
  expect(f.dreamer.inputs).toEqual([]);
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  expect(await f.dream()).toMatchObject({ outcome: "success" }); // left pending: it runs once the model can take it
});
