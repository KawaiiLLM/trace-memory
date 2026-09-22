import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { freezeConsolidation } from "../../../src/core/consolidation/index.ts";
import { renderKnowledgeBlock, tokens, wholeKnowledge } from "../../../src/core/render/index.ts";
import { budgetKnowledge } from "../../../src/core/render/index.ts";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture(texts: (string | { text: string; category: "constraint" | "open" | "reference" })[], pendingText: string | string[] = "target batch alpha") {
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
  const created = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: texts.map((value, index) => ({
    op: "create" as const, handle: `$e${index + 1}`, author: "test", text: typeof value === "string" ? value : value.text,
    category: typeof value === "string" ? "constraint" as const : value.category,
    scope: "project" as const, topics: [], supports: [noted.facts[0]!.id], reason: "Capacity fixture", createdAt: "2026-09-16T00:00:00Z",
  })) });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const watermark = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [], consolidated: [noted.facts[0]!.id] });
  if (!watermark.ok) throw new Error(watermark.problems.join("; "));
  const pending = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "later" }, facts: (Array.isArray(pendingText) ? pendingText : [pendingText]).map(text => ({
    turnId: turn.id, category: "decision" as const, actor: "user" as const, text, source: [`T${turn.id}#user`], createdAt: "later",
  })) });
  if (!pending.ok) throw new Error(pending.problems.join("; "));
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, mode: "subagent" as const };
  return { memory, target, values: memory.store.currentKnowledge(memory.store.knowledgePath(session.id, "main", turn.id)),
    commits: created.committed.map(value => value.commit) };
}

test("45: a whole applicable pool fitting its exact rendered capacity has no omission receipt", () => {
  const f = fixture(["whole applicable rule " + "word ".repeat(5_100)]);
  const exact = wholeKnowledge(f.values).cost;
  expect(exact).toBeGreaterThanOrEqual(5_000);
  setKnowledgeCapacity(f.memory, exact);
  const frozen = freezeConsolidation(f.memory.store, f.target, f.memory.config);
  expect(frozen.knowledgeCapacity).toBe(exact);
  expect(tokens(renderKnowledgeBlock(frozen.prepared!.material.knowledge))).toBeLessThanOrEqual(exact);
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

test("45: receipt-only optional knowledge is dropped before mandatory fact membership shrinks", () => {
  const f = fixture([
    { category: "constraint", text: "oversized constraint " + "word ".repeat(6_000) },
    { category: "open", text: "oversized open " + "word ".repeat(6_000) },
    { category: "reference", text: "oversized reference " + "word ".repeat(6_000) },
  ], ["first mandatory fact", "second mandatory fact"]);
  setKnowledgeCapacity(f.memory, 5_000);
  const receiptOnly = freezeConsolidation(f.memory.store, f.target, f.memory.config);
  expect(receiptOnly.rangeFacts).toHaveLength(2);
  expect(receiptOnly.prepared!.material.knowledge.every(group => !group.text)).toBe(true);
  expect(receiptOnly.prepared!.material.receipts).toEqual([
    "omitted 1 constraint knowledge; expand: K1",
    "omitted 1 open knowledge; expand: K2",
    "omitted 1 reference knowledge; expand: K3",
  ]);

  const at = (inputTokens: number) => freezeConsolidation(f.memory.store,
    { ...f.target, capacity: { inputTokens, prefixTokens: 0 } }, f.memory.config);
  let low = 0, high = 100_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try {
      if (at(middle).rangeFacts.length === 2) high = middle;
      else low = middle + 1;
    } catch { low = middle + 1; }
  }
  const fitted = at(high);
  expect(fitted.rangeFacts).toHaveLength(2);
  expect(fitted.prepared!.material.receipts).toEqual([
    "omitted all 3 current knowledge items; the model context left no room for the knowledge block; expand: trace K<n>",
  ]);
  expect(tokens(fitted.prepared!.text)).toBeLessThan(tokens(receiptOnly.prepared!.text));
});

test("64c: shortening the fact range keeps the newest knowledge while the admitted policy stays frozen", () => {
  const f = fixture([
    "alpha " + "alpha ".repeat(3_000),
    "beta " + "beta ".repeat(3_000),
  ], ["alpha", "beta ".repeat(6_000)]);
  setKnowledgeCapacity(f.memory, 5_000);
  const full = freezeConsolidation(f.memory.store, f.target, f.memory.config);
  expect(full.rangeFacts).toHaveLength(2);
  expect(full.prepared!.supplied.knowledgeCommitIds).toEqual([f.commits[1]]);

  const at = (inputTokens: number) => freezeConsolidation(f.memory.store,
    { ...f.target, capacity: { inputTokens, prefixTokens: 0 } }, f.memory.config);
  let low = 0, high = 100_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try {
      if (at(middle).rangeFacts.length === 2) high = middle;
      else low = middle + 1;
    } catch { low = middle + 1; }
  }
  const shortened = at(high - 1);
  expect(shortened.rangeFacts.map(fact => fact.text)).toEqual(["alpha"]);
  expect(shortened.prepared!.supplied.knowledgeCommitIds).toEqual([f.commits[1]]);

  setKnowledgeCapacity(f.memory, 10_000);
  expect(full.knowledgeCapacity).toBe(5_000);
  expect(full.prepared!.supplied.knowledgeCommitIds).toEqual([f.commits[1]]);
  const later = freezeConsolidation(f.memory.store, f.target, f.memory.config);
  expect(later.knowledgeCapacity).toBe(10_000);
  expect(later.prepared!.supplied.knowledgeCommitIds).toEqual(f.commits);
});

test("64c: over-cap Consolidation retains newer commits and grants only kept commits", () => {
  const f = fixture([
    "unrelated archive geometry " + "plain ".repeat(1_800),
    "target batch alpha " + "relevant ".repeat(1_800),
    "target batch alpha " + "relevant ".repeat(1_800),
  ]);
  const cap = 5_000;
  expect(budgetKnowledge(f.values, cap).commits).toEqual([f.commits[1], f.commits[2]]);
  setKnowledgeCapacity(f.memory, cap);
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
