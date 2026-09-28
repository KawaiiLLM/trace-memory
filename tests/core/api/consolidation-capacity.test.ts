import { afterEach, expect, test } from "vitest";
import { freezeNoting, NOTING_CAPACITY } from "../../../src/core/noting/index.ts";
import { renderKnowledge, renderKnowledgeBlock, sessionKnowledgeNotice, tokens, budgetKnowledge } from "../../../src/core/render/index.ts";
import { recorded, seedSourceEntry, sourceSeededMemory } from "../../source-fixture.ts";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";

const memories: ReturnType<typeof sourceSeededMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture(texts: (string | { text: string; category: "constraint" | "open" | "reference" })[], pendingText: string | string[] = "target batch alpha") {
  const memory = sourceSeededMemory(":memory:", async () => { throw new Error("freeze tests do not run a model"); });
  memories.push(memory);
  const project = memory.store.createProject({ name: "capacity", declaredBy: "mark" });
  const session = memory.store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id,
    startedAt: "2026-09-16T00:00:00Z", firstReplyAt: "2026-09-16T00:00:00Z" });
  const evidence = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence",
    startedAt: "2026-09-16T00:00:00Z" });
  const noted = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: evidence.id, text: "knowledge evidence", source: [`T${evidence.id}#E1`], entryIds: [memory.store.sourcePath(session.id, "main", evidence.id)[0]!.id], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  // These pre-existing manually seeded bodies may exceed the 1k cap on NEW N writes.
  const created = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: texts.map((value, index) => ({
    op: "create" as const, handle: `$e${index + 1}`, author: "test", text: typeof value === "string" ? value : value.text,
    category: typeof value === "string" ? "constraint" as const : value.category,
    scope: "project" as const, topics: [], supports: [noted.facts[0]!.id], reason: "Capacity fixture", createdAt: "2026-09-16T00:00:00Z",
  })) });
  if (!created.ok) throw new Error(created.problems.join("; "));
  recorded(memory, session.id, "main", evidence.id);
  const pending = Array.isArray(pendingText) ? pendingText : [pendingText];
  const turn = memory.store.appendTurn({ sessionId: session.id, parentTurnId: evidence.id, kind: "turn", userPrompt: pending[0]!, startedAt: "2026-09-16T00:01:00Z" });
  for (const text of pending.slice(1)) seedSourceEntry(memory, turn.id, "user", text);
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, mode: "subagent" as const };
  const freeze = (capacity?: number) => freezeNoting(memory.store,
    { ...target, ...(capacity === undefined ? {} : { capacity: { inputTokens: capacity, prefixTokens: 0 } }) }, memory.config);
  return { memory, target, freeze, values: memory.store.currentKnowledge(memory.store.knowledgePath(session.id, "main", turn.id)),
    commits: created.committed.map(value => value.commit), pending: memory.pendingEntries(session.id, "main", turn.id).map(entry => entry.id) };
}

test("45: a whole applicable pool fitting its exact rendered capacity has no omission receipt", () => {
  const f = fixture(["whole applicable rule " + "word ".repeat(5_100)]);
  // 101: the block N receives carries its session's header, so the exact capacity prices it.
  const exact = budgetKnowledge(f.values, Infinity, value => renderKnowledge(value, `K${value.knowledge.id}#${f.memory.store.versionTag(value.knowledge.id, value.revision.id)}`),
    undefined, undefined, undefined, sessionKnowledgeNotice(f.target.sessionId)).cost;
  expect(exact).toBeGreaterThanOrEqual(5_000);
  setKnowledgeCapacity(f.memory, exact);
  const frozen = f.freeze();
  expect(tokens(renderKnowledgeBlock(frozen.prepared!.material.knowledge!))).toBeLessThanOrEqual(exact);
  expect(frozen.prepared!.supplied.knowledgeCommitIds).toEqual(f.commits);
  expect(frozen.prepared!.text).toContain(`K1#${f.memory.store.versionTag(1, f.commits[0]!)}`);
  expect(frozen.prepared).not.toHaveProperty("readKnowledgeCommits");
  expect(frozen.prepared!.material.receipts.filter(receipt => receipt.includes(" knowledge; expand:"))).toEqual([]);
  setKnowledgeCapacity(f.memory, exact - 1);
  const omitted = f.freeze();
  expect(omitted.prepared!.supplied.knowledgeCommitIds).toEqual([]);
  expect(omitted.prepared!.material.receipts).toContain("omitted 1 constraint knowledge; expand: K1");
  expect(omitted.prepared!.text).not.toContain(`K1#${f.memory.store.versionTag(1, f.commits[0]!)}`);
});

test("92: N keeps knowledge omissions and exact pending membership under hard model capacity", () => {
  const f = fixture([
    { category: "constraint", text: "oversized constraint " + "word ".repeat(6_000) },
    { category: "open", text: "oversized open " + "word ".repeat(6_000) },
    { category: "reference", text: "oversized reference " + "word ".repeat(6_000) },
  ], ["first pending entry", "second pending entry"]);
  setKnowledgeCapacity(f.memory, 5_000);
  const full = f.freeze();
  expect(full.entries.map(entry => entry.id)).toEqual(f.pending);
  expect(full.prepared!.selectedEntryIds).toEqual(f.pending);
  expect(full.prepared!.material.knowledge!.every(group => !group.text)).toBe(true);
  expect(full.prepared!.material.receipts).toEqual([
    "omitted 1 constraint knowledge; expand: K1",
    "omitted 1 open knowledge; expand: K2",
    "omitted 1 reference knowledge; expand: K3",
  ]);
  expect(full.prepared!.text).not.toContain(`K1#${f.memory.store.versionTag(1, f.commits[0]!)}`);
  const fitted = f.freeze(100_000);
  expect(fitted.prepared!.selectedEntryIds).toEqual(f.pending);
  // Even the oldest selected entry alone cannot overrun a tiny host window: no progress is written.
  expect(() => f.freeze(1)).toThrow(NOTING_CAPACITY);
  expect(f.memory.pendingEntries(f.target.sessionId, "main", f.target.headTurnId).map(entry => entry.id)).toEqual(f.pending);
});

test("64c/92: shortened N batch keeps newer knowledge; frozen selection survives a later budget update", () => {
  const f = fixture(["alpha " + "alpha ".repeat(3_000), "beta " + "beta ".repeat(3_000)],
    ["first pending entry", "second pending entry " + "word ".repeat(1_000)]);
  setKnowledgeCapacity(f.memory, 5_000);
  const full = f.freeze();
  expect(full.prepared!.selectedEntryIds).toEqual(f.pending);
  expect(full.prepared!.supplied.knowledgeCommitIds).toEqual([f.commits[1]]);
  let low = 0, high = 100_000;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    try {
      if (f.freeze(middle).entries.length === 2) high = middle;
      else low = middle + 1;
    } catch { low = middle + 1; }
  }
  const shortened = f.freeze(high - 1);
  expect(shortened.entries.map(entry => entry.id)).toEqual([f.pending[0]]);
  expect(shortened.prepared!.selectedEntryIds).toEqual([f.pending[0]]);
  expect(shortened.prepared!.supplied.knowledgeCommitIds).toEqual([f.commits[1]]);
  // A re-admitted exact batch cannot take that smaller prefix: all members stay pending.
  expect(() => freezeNoting(f.memory.store, { ...f.target, boundary: { exactEntryIds: f.pending },
    capacity: { inputTokens: high - 1, prefixTokens: 0 } }, f.memory.config)).toThrow(NOTING_CAPACITY);
  expect(f.memory.pendingEntries(f.target.sessionId, "main", f.target.headTurnId).map(entry => entry.id)).toEqual(f.pending);

  const before = structuredClone(full.prepared);
  setKnowledgeCapacity(f.memory, 10_000);
  expect(full.prepared).toEqual(before);
  const later = f.freeze();
  expect(later.prepared!.selectedEntryIds).toEqual(f.pending);
  expect(later.prepared!.supplied.knowledgeCommitIds).toEqual(f.commits);
});

test("64c/92: over-cap N knowledge retains newer commits and tags only kept bodies", () => {
  const f = fixture([
    "unrelated archive geometry " + "plain ".repeat(1_800),
    "target batch alpha " + "relevant ".repeat(1_800),
    "target batch alpha " + "relevant ".repeat(1_800),
  ]);
  const cap = 5_000;
  expect(budgetKnowledge(f.values, cap).commits).toEqual([f.commits[1], f.commits[2]]);
  setKnowledgeCapacity(f.memory, cap);
  const first = f.freeze();
  const second = f.freeze();
  expect(first.prepared).toEqual(second.prepared);
  expect(first.prepared!.supplied.knowledgeCommitIds).toEqual([f.commits[1], f.commits[2]]);
  for (const value of f.values.slice(1)) expect(first.prepared!.text)
    .toContain(`K${value.knowledge.id}#${f.memory.store.versionTag(value.knowledge.id, value.revision.id)}`);
  expect(first.prepared!.material.receipts.join("\n")).toContain("omitted 1 constraint knowledge");
  expect(first.prepared!.material.receipts.join("\n")).toContain("K1");
  expect(first.prepared!.text).not.toContain(`K1#${f.memory.store.versionTag(1, f.commits[0]!)}`);
});
