import { expect, test } from "vitest";
import type { Fact } from "../../../src/core/model/index.ts";
import { budgetFacts, charge, renderFact, renderFactGroups } from "../../../src/core/render/index.ts";
import { sourceSeededMemory, type ConsolidationAgentInput, type NotingAgentInput } from "../../source-fixture.ts";

const fact = (id: number, turnId: number, text = `claim ${id}`): Fact => ({ id, turnId, text,
  category: "observation", actor: "user", quote: null, source: [`T${turnId}#user`], createdAt: "recorded time" });
const line = (f: Fact) => renderFact(f, []);
const early = "2026-01-01T00:00:00Z", late = "2026-01-02T00:00:00Z";
const times = new Map([[10, late], [20, early]]);

test("fact groups use owning Turn time then F id, retain multi-Turn citations, and do not mutate the input", () => {
  const multi = { ...fact(2, 20), source: ["T20#user", "T10#assistant"], quote: "verbatim" };
  const facts = [fact(7, 10), fact(8, 20), fact(3, 10), multi];
  const before = structuredClone(facts);
  expect(renderFactGroups(facts, line, times)).toEqual([
    `[T20] ${early} (selected facts)\n${line(multi)}`,
    line(facts[1]!),
    `[T10] ${late} (selected facts)\n${line(facts[2]!)}`,
    line(facts[0]!),
  ]);
  expect(facts).toEqual(before);
  const text = renderFactGroups(facts, line, times).join("\n");
  expect(text.match(/\[F2\]/g)).toHaveLength(1);
  expect(text).toContain("source: T20#user, T10#assistant");
  expect(text).toContain('quote: "verbatim"');
  expect(renderFactGroups([], line, new Map())).toEqual([]);
  expect(() => renderFactGroups(facts, line, new Map())).toThrow("missing Turn");
});

test("fact groups compare timestamp instants, break ties by Turn id, and keep unknown times explicit", () => {
  const turns = new Map([[1, "2026-01-01T01:00:00+02:00"], [2, "2026-01-01T00:00:00Z"],
    [3, "2025-12-31T23:00:00Z"], [4, "unknown"]]);
  const text = renderFactGroups([fact(1, 4), fact(2, 2), fact(3, 3), fact(4, 1)], line, turns).join("\n");
  expect([...text.matchAll(/^\[T(\d+)\]/gm)].map(m => Number(m[1]))).toEqual([1, 3, 2, 4]);
  expect(text).toContain("[T4] unknown (selected facts)");
});

test("history selection keeps its priority prefix, charges a heading once, then sorts the selected facts", () => {
  const recent = fact(8, 10), sameTurn = fact(3, 10), older = fact(2, 20);
  const candidates = [recent, sameTurn, older];
  const grouped = renderFactGroups([recent, sameTurn], line, times);
  const cap = charge(grouped);
  const result = budgetFacts(candidates, line, cap, times);
  expect(result.recent).toEqual(grouped); // F3 then F8, although F8 had selection priority
  expect(result.receipts).toEqual(["omitted 1 older facts; expand: F2"]);
  expect(result.recent.join("\n").match(/selected facts/g)).toHaveLength(1);
  expect(budgetFacts([recent], line, charge([line(recent)]), times).recent).toEqual([]); // header is not free
  const one = charge(renderFactGroups([recent], line, times));
  expect(budgetFacts(candidates, line, one, times).recent).toEqual(renderFactGroups([recent], line, times));
  expect(budgetFacts([fact(9, 10, "large ".repeat(1000)), older], line, one, times).recent).toEqual([]); // never skip the priority head
  for (let budget = 0; budget <= cap + 40; budget++) {
    const selected = budgetFacts(candidates, line, budget, times);
    expect(charge(selected.recent)).toBeLessThanOrEqual(budget);
  }
});

test("carry, compact, Noter history and the Consolidator range share the one fact-group renderer", async () => {
  const calls: (NotingAgentInput | ConsolidationAgentInput)[] = [];
  const m = sourceSeededMemory(":memory:", async input => {
    calls.push(input as NotingAgentInput | ConsolidationAgentInput);
    return { outcome: "failure", output: "leave work pending", request: {} };
  });
  try {
    const projectId = m.store.createProject({ name: "p", declaredBy: "mark" }).id;
    const s = m.store.createSession({ host: "fake", projectId, startedAt: early, firstReplyAt: early, enrollmentChoice: true });
    const a = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "early", assistantText: "early reply", startedAt: early });
    const b = m.store.appendTurn({ sessionId: s.id, parentTurnId: a.id, kind: "turn", userPrompt: "late", assistantText: "late reply", startedAt: late });
    const write = m.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: late }, facts: [
        { ...fact(1, b.id, "late fact"), createdAt: late },
        { ...fact(2, a.id, "early fact"), createdAt: early },
        { ...fact(3, a.id, "multi-source fact"), source: [`T${a.id}#user`, `T${b.id}#assistant`], createdAt: early },
      ] });
    if (!write.ok) throw new Error(write.problems.join("; "));
    const expected = renderFactGroups(write.facts, f => m.trace(`F${f.id}`), m.store.factTurnTimes(write.facts)).join("\n");
    expect([...expected.matchAll(/\[F(\d+)\]/g)].map(match => Number(match[1]))).toEqual([2, 3, 1]);
    // 29d retired the fifth consumer this list used to open with, the per-prompt `<noted>` delivery;
    // the remaining four still share the one renderer, which is what the ruling is about.
    expect(m.branchSummary(s.id, "main", b.id)).toContain(`Facts:\n${expected}\nCommits`);
    const compact = m.compact(s.id, "main", b.id);
    expect(compact.tier).toBe("primary");
    if (compact.tier === "native") throw new Error(compact.reason);
    expect(compact.text).toContain(`Recent facts (by Turn):\n\n${expected}\n\nRaw:`);
    await m.noting({ sessionId: s.id, branch: "main", headTurnId: b.id, mode: "subagent" });
    expect((calls.at(-1)! as NotingAgentInput).material.facts.join("\n")).toBe(expected);
    await m.consolidate({ sessionId: s.id, branch: "main", headTurnId: b.id, mode: "subagent" });
    const input = calls.at(-1)! as ConsolidationAgentInput;
    expect(input.material.rangeFacts.join("\n")).toBe(expected);
    expect(input.range.facts.map(f => f.id)).toEqual([1, 2, 3]); // selection/progress stay arrival-ordered
    expect(m.store.consolidationBatch(s.id, "main", b.id).map(f => f.id)).toEqual([1, 2, 3]); // failure advances nothing
    const integrated = m.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: late },
      operations: [], consolidated: [1, 2, 3] });
    expect(integrated.ok).toBe(true);
    expect(m.store.listConsolidatedProjectFacts(projectId).map(f => f.id)).toEqual([1, 3, 2]); // history selection is newest-first
    const next = m.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: late },
      facts: [{ ...fact(4, b.id, "next fact"), createdAt: late }] });
    expect(next.ok).toBe(true);
    await m.consolidate({ sessionId: s.id, branch: "main", headTurnId: b.id, mode: "subagent" });
    // 25a: the Consolidator receives no already-consolidated history block at all; F1–F3 are stored,
    // consolidated and readable, and only the newly pending F4 is supplied as its range.
    const later = calls.at(-1)! as ConsolidationAgentInput, next4 = [m.store.getFact(4)!];
    expect(later.material.rangeFacts.join("\n")).toBe(renderFactGroups(next4, f => m.trace(`F${f.id}`), m.store.factTurnTimes(next4)).join("\n"));
    expect("facts" in later.material).toBe(false);
    expect(later.text).not.toContain(expected);
    expect(m.trace("F2")).not.toContain("(selected facts)"); // explicit single-fact reads stay unchanged
  } finally { m.close(); }
});

test("Consolidation cannot dispatch a fact when only its ungrouped line fits the batch ceiling", async () => {
  let dispatched = false;
  const m = sourceSeededMemory(":memory:", async () => { dispatched = true; return { outcome: "failure", output: "unexpected" }; });
  try {
    const projectId = m.store.createProject({ name: "p", declaredBy: "mark" }).id;
    const s = m.store.createSession({ host: "fake", projectId, startedAt: early, firstReplyAt: early, enrollmentChoice: true });
    const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "question", assistantText: "answer", startedAt: early });
    const write = m.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: early },
      facts: [{ ...fact(1, t.id), createdAt: early }] });
    expect(write.ok).toBe(true);
    m.config.consolidation.batchTokens = charge([m.trace("F1")]);
    await expect(m.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" })).rejects.toThrow(/capacity/);
    expect(dispatched).toBe(false);
    expect(m.store.consolidationBatch(s.id, "main", t.id).map(f => f.id)).toEqual([1]);
  } finally { m.close(); }
});

test("negated-evidence reminders and CLOSER feedback also use Turn groups without losing their roles", async () => {
  let input: ConsolidationAgentInput | undefined, feedback: string | undefined;
  const m = sourceSeededMemory(":memory:", async raw => {
    input = raw as ConsolidationAgentInput;
    const receipt = await input.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
      skipped: input.range.facts.map(f => ({ fact: `F${f.id}`, because: "Review only." })) });
    feedback = input.reviewFeedback(String(receipt));
    return { outcome: "failure", output: "leave review uncommitted", request: {} };
  }, { consolidation: { nearThreshold: 0 } });
  try {
    const projectId = m.store.createProject({ name: "p", declaredBy: "mark" }).id;
    const s = m.store.createSession({ host: "fake", projectId, startedAt: early, firstReplyAt: early, enrollmentChoice: true });
    const a = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "old evidence", startedAt: early });
    const b = m.store.appendTurn({ sessionId: s.id, parentTurnId: a.id, kind: "turn", userPrompt: "correction", startedAt: late });
    const noted = m.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: early },
      facts: [{ ...fact(1, a.id), createdAt: early }] });
    expect(noted.ok).toBe(true);
    const integrated = m.store.commitConsolidationRun({ path: { sessionId: s.id, branch: "main", headTurnId: a.id },
      run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: early }, consolidated: [1],
      operations: [{ op: "create", handle: "k", author: "fake", text: "Investigate the evidence", category: "goal", scope: "session",
        supports: [1], reason: "Initial evidence", topics: [], createdAt: early }] });
    expect(integrated.ok).toBe(true);
    const correction = m.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: late },
      facts: [{ ...fact(2, b.id), createdAt: late, negate: [{ target: "F1", strength: "strong" }] }] });
    expect(correction.ok).toBe(true);
    await m.consolidate({ sessionId: s.id, branch: "main", headTurnId: b.id, mode: "subagent" });
    const reminder = input!.material.reminders[0]!;
    expect(reminder).toContain("Cited fact: F1; Negating fact: F2");
    expect(reminder).toContain(`[T${a.id}] ${early} (selected facts)\n${m.trace("F1")}`);
    expect(reminder).toContain(`[T${b.id}] ${late} (selected facts)\n${m.trace("F2")}`);
    expect(reminder.indexOf("[F1]")).toBeLessThan(reminder.indexOf("[F2]"));
    expect(feedback).toContain("CLOSER:");
    expect(feedback).toContain(`[T${b.id}] ${late} (selected facts)\nJaccard`);
    expect(feedback).toContain(m.trace("F2"));
    expect(m.store.consolidationBatch(s.id, "main", b.id).map(f => f.id)).toEqual([2]);
  } finally { m.close(); }
});
