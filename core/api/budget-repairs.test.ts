// Review repairs of 2026-09-08 on 1674525..91688b8: the hard budgets are hard for mandatory material
// and for receipts too. Reduce the task and re-freeze, or leave it pending with a capacity error; never
// receipt an overage and run anyway.
import { expect, test } from "vitest";
import { TraceMemory, tokens, type ConsolidationAgentInput, type NotingAgentInput } from "../../test/source-fixture.ts";

function seeded(config: Record<string, unknown> = {}) {
  const calls: (ConsolidationAgentInput | NotingAgentInput)[] = [];
  const m = TraceMemory(":memory:", async raw => { calls.push(raw as ConsolidationAgentInput); return { outcome: "success", output: "", request: { probe: true } }; }, config);
  const p = m.store.createProject({ name: "review", declaredBy: "mark" });
  const s = m.store.createSession({ host: "review", startedAt: "2026-09-08", firstReplyAt: "2026-09-08", projectId: p.id, enrollmentChoice: true });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Synthetic source", assistantText: "Synthetic reply", startedAt: "2026-09-08" });
  const tools = m.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  const note = (text: string, extra: Record<string, unknown> = {}) => tools.find(tool => tool.name === "note")!.execute({ facts: [{ category: "observation", actor: "user", text, source: [`T${t.id}#user`], ...extra }] });
  const knowledge = (text: string) => tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", reason: "Initial admission of this conclusion.", text, category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] });
  return { m, calls, s, t, note, knowledge };
}

test("review 2026-09-08: mandatory reminders over the episodic budget reduce the Consolidation batch oldest-first and re-freeze; the excluded fact stays pending", async () => {
  const f = seeded();
  try {
    expect(f.note("Original evidence")).toContain("ok: F1");
    for (let i = 0; i < 20; i++) expect(f.knowledge(`Rule ${i}: ` + "word ".repeat(1000))).toContain("committed");
    // F2 negates F1, which twenty knowledge items cite: with F2 selected the review cues alone exceed
    // the episodic budget, so the batch shrinks to F1 and F2 waits for its own turn.
    expect(f.note("Withdraw the original evidence " + "word ".repeat(1000), { negate: [["F1", "strong"]] })).toContain("ok: F2");
    const r = await f.m.consolidate({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id, mode: "subagent" });
    expect(r.outcome).toBe("success");
    const input = f.calls[0] as ConsolidationAgentInput;
    expect(input.range.facts.map(fact => fact.id)).toEqual([1]);
    expect(input.material.reminders).toEqual([]);
    expect(tokens(input.text.fresh)).toBeLessThanOrEqual(30000);
    expect(input.material.receipts.some(receipt => receipt.includes("overage"))).toBe(false);
    expect(f.m.store.consolidationBatch(f.s.id, "main", f.t.id).map(fact => fact.id)).toEqual([2]); // still pending, never marked
  } finally { f.m.close(); }
});

test("review 2026-09-08: a Noting batch that cannot fit the episodic budget stays pending with a capacity error instead of running over it", async () => {
  const f = seeded({ render: { episodicBlockTokens: 1 } });
  try {
    await expect(f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id, mode: "subagent" })).rejects.toThrow(/Noting capacity/);
    expect(f.calls).toEqual([]);
    expect(f.m.store.listRuns(f.s.id)).toEqual([]);
    expect(f.m.pendingEntries(f.s.id, "main", f.t.id).length).toBeGreaterThan(0);
  } finally { f.m.close(); }
});

test("review 2026-09-08: a knowledge cap that cannot hold even its omission receipt is a capacity error, not an oversized block", () => {
  const f = seeded({ render: { knowledgeBlockTokens: 1 } });
  try {
    f.note("Evidence");
    expect(f.knowledge("A complete rule")).toContain("committed");
    expect(() => f.m.inject(f.s.id)).toThrow(/Knowledge capacity/);
  } finally { f.m.close(); }
});
