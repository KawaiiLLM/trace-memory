// Review repairs of 2026-09-08 on 1674525..91688b8: the hard budgets are hard for mandatory material
// and for receipts too. Reduce the task and re-freeze, or leave it pending with a capacity error; never
// receipt an overage and run anyway.
import { expect, test } from "vitest";
import { TraceMemory, tokens, renderEntry, type ConsolidationAgentInput, type NotingAgentInput } from "../../source-fixture.ts";
import type { Fact } from "../../../src/core/model/index.ts";
import { renderFact } from "../../../src/core/render/index.ts";
import { budgetMaterial, notingText, FACTS_TITLE, RAW_TITLE } from "../../../src/core/render/material.ts";

function seeded(config: Record<string, unknown> = {}) {
  const calls: (ConsolidationAgentInput | NotingAgentInput)[] = [];
  const m = TraceMemory(":memory:", async raw => { calls.push(raw as ConsolidationAgentInput); return { outcome: "success", output: "", request: { probe: true } }; }, config);
  const p = m.store.createProject({ name: "review", declaredBy: "mark" });
  const s = m.store.createSession({ host: "review", startedAt: "2026-09-08", firstReplyAt: "2026-09-08", projectId: p.id, enrollmentChoice: true });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Synthetic source", assistantText: "Synthetic reply", startedAt: "2026-09-08" });
  const tools = m.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  const note = (text: string, extra: Record<string, unknown> = {}) => tools.find(tool => tool.name === "note")!.execute({ facts: [{ category: "observation", actor: "user", text, source: [`T${t.id}#user`], ...extra }] });
  const knowledge = (text: string) => tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text, category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] });
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

// ---- Review of 91688b8..12fa278 (2026-09-08): capacity by effective mode, optional history first,
// tier 1 capacity errors escalate, and the `Receipts:` heading is charged.

test("review 2026-09-08: capacity is priced by the effective mode; a requested fork resolved to subagent is not charged the inherited head reply", async () => {
  const f = seeded();
  try {
    await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id, mode: "subagent" });
    // A 40,000-token assistant reply: its primary view is bounded (10K), but the fork increment would
    // carry the whole head reply; a subagent run carries only the bounded view.
    f.m.appendEntry({ sessionId: f.s.id, turnId: f.t.id, nativeLineage: "fixture", nativeId: "long-assistant", role: "assistant", text: "word ".repeat(40000), raw: "", calls: [] });
    const input = { sessionId: f.s.id, branch: "main", headTurnId: f.t.id, capacity: { inputTokens: 30000, prefixTokens: 0 }, effectiveMode: "subagent" as const };
    expect((await f.m.noting({ ...input, mode: "fork" })).outcome).toBe("success");
    const run = f.calls.at(-1) as NotingAgentInput;
    expect(run.mode).toBe("fork"); // the requested mode is still what the task carries for the audit
  } finally { f.m.close(); }
});

// 25a removed the Consolidator's optional historical facts, so this review pin now names the phase
// that still has optional material: a Noting batch whose selected entries are mandatory and whose
// historical facts are not. The rule — optional history yields before selected evidence — is unchanged.
test("review 2026-09-08, on Noting since 25a: a smaller model window trims the optional historical facts before it drops a selected entry", async () => {
  const f = seeded();
  try {
    await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id, mode: "subagent" });
    const bare = f.calls[0] as NotingAgentInput;
    const size = (input: NotingAgentInput) => tokens(input.prompt) + tokens(JSON.stringify(input.tools)) + tokens(input.text.fresh);
    for (let i = 0; i < 4; i++) expect(f.note("Optional historical evidence " + "word ".repeat(1500))).toContain(`ok: F${i + 1}`);
    const next = f.m.store.appendTurn({ sessionId: f.s.id, parentTurnId: f.t.id, kind: "turn", userPrompt: "Second request", assistantText: "Second reply", startedAt: "2026-09-08" });
    const entries = f.m.pendingEntries(f.s.id, "main", next.id).length;
    const capacity = size(bare) + 500;
    const result = await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: next.id, mode: "subagent", capacity: { inputTokens: capacity, prefixTokens: 0 } });
    expect(result.outcome).toBe("success");
    const run = f.calls.at(-1) as NotingAgentInput;
    expect(run.entryIds).toHaveLength(entries); // every selected entry ran
    expect(run.material.facts.length).toBeLessThan(4); // the optional history gave way first
    expect(size(run)).toBeLessThanOrEqual(capacity);
  } finally { f.m.close(); }
});

test("review 2026-09-08: a tier-1 view that cannot hold its labels escalates compact to the tier-2 profile instead of failing", () => {
  const f = seeded();
  try {
    f.m.config.render.toolCallTokens = 10;
    f.m.store.appendToolCall({ turnId: f.t.id, name: "bash", input: "pwd", result: "done", status: "success" });
    const pending = f.m.pendingEntries(f.s.id, "main", f.t.id);
    expect(() => pending.map(e => renderEntry(e, f.m.config.render))).toThrow(/capacity/);
    const tier2 = { toolCallTokens: f.m.config.render.secondaryToolCallTokens, entryTokens: f.m.config.render.secondaryEntryTokens };
    expect(tokens(pending.map(e => renderEntry(e, tier2).content).join("\n\n"))).toBeLessThan(10000);
    const result = f.m.compact(f.s.id, "main", f.t.id);
    expect(result.tier).toBe("secondary");
  } finally { f.m.close(); }
});

test("review 2026-09-08: the Receipts heading is charged to the budgets it is emitted under", () => {
  const f = seeded({ render: { knowledgeBlockTokens: 12 } });
  try {
    f.note("Evidence");
    expect(f.knowledge("word ".repeat(100))).toContain("committed");
    // A cap of 12 holds the omission receipt but not its heading: a capacity error, never 15 tokens.
    expect(() => f.m.inject(f.s.id)).toThrow(/Knowledge capacity/);
  } finally { f.m.close(); }
  // At the default caps, no padding of the current material leaves the rendered text over the
  // episodic budget with `over.episodic` still zero.
  const facts = Array.from({ length: 200 }, (_, i) => ({ id: 200 - i, turnId: 1, runId: 1, createdAt: "2026-09-08", category: "observation", actor: "user", text: "short fact", quote: null, status: null, source: ["T1#user"] } as Fact));
  const line = (fact: Fact) => renderFact(fact, []);
  const range = { from: "S1/T1", to: "S1/T1" };
  for (let padding = 9000; padding < 9800; padding++) {
    const current = "[Source entry id: T1#user]\nHello" + " word".repeat(padding);
    const b = budgetMaterial({ knowledge: [], facts, factLine: line, factTurns: new Map([[1, "2026-09-08"]]), current, framing: [FACTS_TITLE, RAW_TITLE], range, caps: { knowledge: 10000, episodic: 20000, current: 10000 } });
    const text = notingText({ knowledge: b.knowledge, facts: b.facts, entries: [{ id: 1, view: current }], receipts: b.receipts, head: null, sources: [] }, range);
    if (!b.over.episodic) expect(tokens(text)).toBeLessThanOrEqual(20000);
  }
}, 30000);

// ---- Review of 12fa278..05133d4 (2026-09-08): the Noting freeze runs the material it priced, and
// topic sets are compared and shown as arrays.

test("review 2026-09-08: Noting runs the prepared material the capacity negotiation priced, not a fresh render that restores the trimmed history", async () => {
  const f = seeded();
  try {
    await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id, mode: "subagent" });
    const size = (input: NotingAgentInput) => tokens(input.prompt) + tokens(JSON.stringify(input.tools)) + tokens(input.text.fresh);
    const capacity = size(f.calls[0] as NotingAgentInput) + 500;
    for (let i = 0; i < 4; i++) expect(f.note("Optional historical evidence " + "word ".repeat(1500))).toContain(`ok: F${i + 1}`);
    const next = f.m.store.appendTurn({ sessionId: f.s.id, parentTurnId: f.t.id, kind: "turn", userPrompt: "Next request", assistantText: "Okay", startedAt: "2026-09-08" });
    const result = await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: next.id, mode: "subagent", capacity: { inputTokens: capacity, prefixTokens: 0 } });
    expect(result.outcome).toBe("success");
    const run = f.calls.at(-1) as NotingAgentInput;
    expect(run.material.facts.length).toBeLessThan(4); // the history the negotiation trimmed stays trimmed
    expect(size(run)).toBeLessThanOrEqual(capacity);
  } finally { f.m.close(); }
});

test("review 2026-09-08: topic sets that join to the same text are still different sets in the diff and the knowledge line", () => {
  const f = seeded();
  try {
    expect(f.note("Use SQLite")).toContain("ok: F1");
    const memory = f.m.tools({ kind: "manual", sessionId: f.s.id, branch: "main", currentTurnId: f.t.id }).find(tool => tool.name === "memory")!;
    const content = { text: "Use SQLite", category: "constraint", scope: "project", supports: ["F1"], reason: "Classify this conclusion." };
    expect(memory.execute({ operations: [{ op: "create", ...content, topics: ["a, b"] }], skipped: [] })).toContain("committed");
    expect(memory.execute({ operations: [{ op: "update", id: "K1@1", ...content, topics: ["a", "b"] }], skipped: [] })).toContain("committed");
    expect(f.m.trace("K1@1..K1@2")).toContain('topics: ["a, b"] -> ["a","b"]');
    expect(f.m.trace("K1@1")).toContain('topics: ["a, b"]');
  } finally { f.m.close(); }
});
