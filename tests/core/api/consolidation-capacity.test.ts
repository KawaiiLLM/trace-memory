import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { freezeConsolidation } from "../../../src/core/consolidation/index.ts";
import { budgetKnowledge } from "../../../src/core/render/index.ts";
import { budgetRelevantKnowledge } from "../../../src/core/render/knowledge-selection.ts";
import { setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture(texts: string[], pendingText = "target batch alpha") {
  const memory = TraceMemory(":memory:", async () => { throw new Error("freeze tests do not run a model"); });
  memories.push(memory);
  const project = memory.store.createProject({ name: "capacity", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id,
    startedAt: "2026-09-16T00:00:00Z", firstReplyAt: "2026-09-16T00:00:00Z" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence",
    startedAt: "2026-09-16T00:00:00Z" });
  const noted = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "knowledge evidence", source: [`T${turn.id}#user`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const created = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: texts.map((text, index) => ({
    op: "create" as const, handle: `$e${index + 1}`, author: "test", text, category: "constraint" as const,
    scope: "project" as const, topics: [], supports: [noted.facts[0]!.id], reason: "Capacity fixture", createdAt: "2026-09-16T00:00:00Z",
  })) });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const watermark = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [], consolidated: [noted.facts[0]!.id] });
  if (!watermark.ok) throw new Error(watermark.problems.join("; "));
  const pending = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "later" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: pendingText, source: [`T${turn.id}#user`], createdAt: "later",
  }] });
  if (!pending.ok) throw new Error(pending.problems.join("; "));
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, mode: "subagent" as const };
  return { memory, target, values: memory.store.listCurrentKnowledge(memory.store.knowledgePath(session.id, "main", turn.id)),
    commits: created.committed.map(value => value.commit) };
}

test("45: a whole applicable pool fitting its exact rendered capacity has no omission receipt", () => {
  const f = fixture(["whole applicable rule " + "word ".repeat(5_100)]);
  const exact = budgetKnowledge(f.values, Infinity).cost;
  expect(exact).toBeGreaterThanOrEqual(5_000);
  setKnowledgeInjection(f.memory, exact);
  const frozen = freezeConsolidation(f.memory.store, f.target, f.memory.config);
  expect(frozen.knowledgeCapacity).toBe(exact);
  expect(frozen.prepared!.supplied.knowledgeCommitIds).toEqual(f.commits);
  expect(frozen.prepared!.readKnowledgeCommits).toEqual([{ knowledgeId: 1, commit: f.commits[0]! }]);
  expect(frozen.prepared!.material.receipts.filter(receipt => receipt.includes(" knowledge; expand:"))).toEqual([]);
});

test("45: model-capacity negotiation drops the optional knowledge block whole before pending evidence", () => {
  const f = fixture([
    "large applicable alpha " + "one ".repeat(1_800),
    "large applicable beta " + "two ".repeat(1_800),
    "large applicable gamma " + "three ".repeat(1_800),
  ]);
  expect(f.memory.knowledgeBudgets().injection).toBe(20_000);
  const full = freezeConsolidation(f.memory.store, f.target, f.memory.config);
  expect(full.prepared!.supplied.knowledgeCommitIds).toEqual(f.commits);

  // Find the exact host capacity floor for the mandatory one-fact request. At that floor the
  // existing negotiation must remove all optional knowledge, not lower its own frozen allowance.
  const at = (inputTokens: number) => freezeConsolidation(f.memory.store,
    { ...f.target, capacity: { inputTokens, prefixTokens: 0 } }, f.memory.config);
  let low = 0, high = 100_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try { at(middle); high = middle; } catch { low = middle + 1; }
  }
  const trimmed = at(high);
  expect(trimmed.rangeFacts).toHaveLength(1);
  expect(trimmed.prepared!.supplied.knowledgeCommitIds).toEqual([]);
  expect(trimmed.prepared!.material.receipts).toEqual([
    `omitted all ${f.commits.length} current knowledge items; the model context left no room for the knowledge block; expand: trace K<n>`,
  ]);
  expect(trimmed.prepared!.text).toContain("target batch alpha");
});

test("45: over-cap Consolidation retains lexical relevance with stable ties and grants only kept commits", () => {
  const f = fixture([
    "unrelated archive geometry " + "plain ".repeat(1_800),
    "target batch alpha " + "relevant ".repeat(1_800),
    "target batch alpha " + "relevant ".repeat(1_800),
  ]);
  const cap = 5_000;
  expect(budgetRelevantKnowledge(f.values, cap, "target batch alpha").commits).toEqual([f.commits[1], f.commits[2]]);
  setKnowledgeInjection(f.memory, cap);
  const first = freezeConsolidation(f.memory.store, f.target, f.memory.config);
  const second = freezeConsolidation(f.memory.store, f.target, f.memory.config);
  expect(first.prepared).toEqual(second.prepared);
  expect(first.prepared!.supplied.knowledgeCommitIds).toEqual([f.commits[1], f.commits[2]]);
  expect(first.prepared!.readKnowledgeCommits).toEqual([
    { knowledgeId: 2, commit: f.commits[1]! }, { knowledgeId: 3, commit: f.commits[2]! },
  ]);
  expect(first.prepared!.material.receipts.join("\n")).toContain("omitted 1 constraint knowledge");
  expect(first.prepared!.material.receipts.join("\n")).toContain("K1");
  expect(first.prepared!.readKnowledgeCommits.some(value => value.commit === f.commits[0])).toBe(false);
});
