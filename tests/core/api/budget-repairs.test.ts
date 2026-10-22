// Review repairs of 2026-09-08 on 1674525..91688b8: the hard budgets are hard for mandatory material
// and for receipts too. Reduce the task and re-freeze, or leave it pending with a capacity error; never
// receipt an overage and run anyway.
import { expect, test } from "vitest";
import { receiptCommit, scoreAll } from "../../support/seed.ts";
import { sourceSeededMemory, tokens, renderEntry, type NotingAgentInput , hydrate } from "../../source-fixture.ts";
import type { Fact } from "../../../src/core/model/index.ts";
import { renderFact, renderKnowledgeDiff } from "../../../src/core/render/index.ts";
import { memoryFiles } from "../../../src/core/api/index.ts";
import { budgetMaterial, compactText, injectionText, notingText, rawWindowTokens, FACTS_TITLE, RAW_TITLE } from "../../../src/core/render/material.ts";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";
import { curateWrite } from "../../support/dreamer.ts";
import { submitEmpty, largestTaskPromptTokens } from "../../support/noter.ts";

function seeded(config: Record<string, unknown> = {}) {
  const calls: NotingAgentInput[] = [];
  // 116: explicit empty N output requires one empty call to each tool.
  const fallback = async (raw: unknown) => { const input = raw as NotingAgentInput; if (input.task !== "verify") calls.push(input); // one entry per batch: the write task
    if (input.kind === "noting") {
      submitEmpty(input);
    }
    return { outcome: "success" as const, output: "", request: { probe: true } }; };
  const m = sourceSeededMemory(":memory:", fallback, { writing: { bodyTokens: 1_000_000 }, ...config });
  const p = m.store.createProject({ name: "review", declaredBy: "mark" });
  const s = m.store.createSession({ host: "review", startedAt: "2026-09-08", firstReplyAt: "2026-09-08", projectId: p.id, enrollmentChoice: true });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Synthetic source", assistantText: "Synthetic reply", startedAt: "2026-09-08" });
  const tools = m.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  const note = (text: string, extra: Record<string, unknown> = {}) => tools.find(tool => tool.name === "note")!.execute({ title: "Review evidence", sources: `[T${t.id}#E1] ${text}`, ...extra });
  const knowledge = (text: string) => { const receipt = tools.find(tool => tool.name === "memory")!.execute({ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text, category: "constraint", scope: "project", supports: ["F1"] }); scoreAll(m.store); return receipt; };
  return { m, calls, s, t, note, knowledge };
}

test("92: fresh N has separate fact and knowledge windows without reviving C progress", async () => {
  const f = seeded();
  try {
    expect(f.note("Original evidence")).toContain("ok: F1");
    for (let i = 0; i < 20; i++) expect(f.knowledge(`Rule ${i}: ` + "word ".repeat(900))).toContain("committed");
    expect(f.note("Withdraw the original evidence " + "word ".repeat(900), { negate: [["F1", "strong"]] })).toContain("ok: F2");
    const r = await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id });
    expect(r.outcome).toBe("success");
    const input = f.calls[0] as NotingAgentInput;
    expect(input.material.facts.join("\n")).toContain("Withdraw the original evidence");
    expect(input.material.knowledge!.map(group => group.text).join("\n")).toContain("Rule 19:");
    expect(input.material.receipts.some(receipt => receipt.includes("overage"))).toBe(false);
    expect(input.supplied.factIds).toEqual([2, 1]); // selection is newest-first; rendered Turn groups sort F IDs
    const factReceipts = input.material.receipts.filter(receipt => receipt.includes(" older facts; expand:"));
    const knowledgeReceipts = input.material.receipts.filter(receipt => receipt.includes(" knowledge; expand:"));
    expect(tokens(compactText({ facts: input.material.facts, receipts: factReceipts }))).toBeLessThanOrEqual(f.m.config.compaction.factsTokens);
    expect(tokens(injectionText({ knowledge: input.material.knowledge, receipts: knowledgeReceipts })))
      .toBeLessThanOrEqual(f.m.knowledgeBase() + f.m.config.compaction.temporaryTokens);
    expect(rawWindowTokens(input.material.entries.map(entry => entry.view), [])).toBeLessThanOrEqual(f.m.config.noting.batchTokens);
    expect(f.m.pendingEntries(f.s.id, "main", f.t.id)).toEqual([]);
  } finally { f.m.close(); }
});

test("review 2026-09-08: the oldest Noting entry dispatches despite exceeding its soft episodic ceiling", async () => {
  const f = seeded({ render: { episodicBlockTokens: 1 } });
  try {
    const pending = hydrate(f.m.pendingEntries(f.s.id, "main", f.t.id), f.m.store);
    expect(pending.length).toBeGreaterThan(0);
    expect((await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id })).outcome).toBe("success");
    expect(f.calls).toHaveLength(1);
    expect((f.calls[0] as NotingAgentInput).entryIds).toContain(pending[0]!.id);
    expect(f.m.store.listRuns(f.s.id)).toHaveLength(2); // one per task
  } finally { f.m.close(); }
});

test("34c: a knowledge cap that cannot hold a complete foreground item emits nothing", () => {
  const f = seeded();
  try {
    setKnowledgeCapacity(f.m, 5_000);
    f.m.config.compaction.temporaryTokens = 0; // with a temporary allowance the misfit would show as a title
    f.note("Evidence");
    expect(f.knowledge("A complete rule " + "word ".repeat(6_000))).toContain("committed");
    expect(f.m.inject(f.s.id)).toBe("");
  } finally { f.m.close(); }
});

// ---- Review of 91688b8..12fa278 (2026-09-08): capacity by effective mode, optional history first,
// tier 1 capacity errors escalate, and the `Receipts:` heading is charged.

// 25a removed the Consolidator's optional historical facts, so this review pin now names the phase
// that still has optional material: a Noting batch whose selected entries are mandatory and whose
// historical facts are not. The rule — optional history yields before selected evidence — is unchanged.
test("review 2026-09-08, on Noting since 25a: a smaller model window trims the optional historical facts before it drops a selected entry", async () => {
  const f = seeded();
  try {
    await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id });
    const bare = f.calls[0] as NotingAgentInput;
    const size = (input: NotingAgentInput) => tokens(input.prompt) + largestTaskPromptTokens() + tokens(JSON.stringify(input.tools)) + tokens(input.text);
    for (let i = 0; i < 4; i++) expect(f.note("Optional historical evidence " + "word ".repeat(1500))).toContain(`ok: F${i + 1}`);
    const next = f.m.store.appendTurn({ sessionId: f.s.id, parentTurnId: f.t.id, kind: "turn", userPrompt: "Second request", assistantText: "Second reply", startedAt: "2026-09-08" });
    const entries = hydrate(f.m.pendingEntries(f.s.id, "main", next.id), f.m.store).length;
    const capacity = size(bare) + 500;
    const result = await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: next.id, capacity: { inputTokens: capacity } });
    expect(result.outcome).toBe("success");
    const run = f.calls.at(-1) as NotingAgentInput;
    expect(run.entryIds).toHaveLength(entries); // every selected entry ran
    expect(run.material.facts.length).toBeLessThan(4); // the optional history gave way first
    expect(size(run)).toBeLessThanOrEqual(capacity);
  } finally { f.m.close(); }
});

test("review 2026-09-08, rescaled by 73: a view that cannot hold its labels ends the Raw span and is omitted with a receipt, never delegated", () => {
  const f = seeded();
  try {
    f.m.config.render.toolInputTokens = 4;
    f.m.store.appendToolCall({ turnId: f.t.id, name: "bash", input: "pwd", result: "done", status: "success" });
    const pending = hydrate(f.m.pendingEntries(f.s.id, "main", f.t.id), f.m.store);
    expect(() => pending.map(e => renderEntry(e, f.m.config.render))).toThrow(/capacity/);
    // 30/73: there is no second, tighter rendering to escalate to and no fallback either — the entry
    // whose bounded view cannot fit its own profile ends the Raw span (73 What to build 1.2), and
    // compact still succeeds rather than delegating or throwing.
    const result = f.m.compact(f.s.id, "main", f.t.id);
    expect("native" in result).toBe(false);
    if ("native" in result) throw new Error("unreachable");
    // The tool call whose input cannot fit its own label ends the Raw span there — the newer tool
    // result survives (it renders fine on its own), everything at or before the call is omitted.
    expect(result.supplied.entries.map(e => e.id)).not.toContain(pending.find(e => e.role === "assistant" && e.calls.length)!.id);
  } finally { f.m.close(); }
});

test("review 2026-09-08: the Receipts heading is charged to the budgets it is emitted under", () => {
  const f = seeded();
  try {
    setKnowledgeCapacity(f.m, 5_000);
    f.m.config.compaction.temporaryTokens = 0; // with a temporary allowance the misfit would show as a title
    f.note("Evidence");
    expect(f.knowledge("word ".repeat(6_000))).toContain("committed");
    // 34c foreground publication emits no omission-only block when no complete item fits.
    expect(f.m.inject(f.s.id)).toBe("");
  } finally { f.m.close(); }
  // At the default caps, no padding of the current material leaves the rendered text over the
  // episodic budget with `over.episodic` still zero.
  const facts = Array.from({ length: 200 }, (_, i) => ({ id: 200 - i, turnId: 1, runId: 1, createdAt: "2026-09-08", category: "observation", actor: "user", text: "short fact", quote: null, status: null, source: ["T1#user"] } as Fact));
  const line = (fact: Fact) => renderFact(fact, []);
  const range = { from: "S1/T1", to: "S1/T1" };
  for (let padding = 9000; padding < 9800; padding++) {
    const current = "[Source entry id: T1#user]\nHello" + " word".repeat(padding);
    const b = budgetMaterial({ knowledge: [], facts, factLine: line, factTurns: new Map([[1, "2026-09-08"]]), current, framing: [FACTS_TITLE, RAW_TITLE], range, caps: { knowledge: 10000, episodic: 20000, current: 10000 } });
    const text = notingText({ knowledge: b.knowledge, facts: b.facts, entries: [{ id: 1, view: current }], receipts: b.receipts }, range);
    if (!b.over.episodic) expect(tokens(text)).toBeLessThanOrEqual(20000);
  }
}, 30000);

// ---- Review of 12fa278..05133d4 (2026-09-08): the Noting freeze runs the material it priced, and
// topic sets are compared and shown as arrays.

test("review 2026-09-08: Noting runs the prepared material the capacity negotiation priced, not a fresh render that restores the trimmed history", async () => {
  const f = seeded();
  try {
    await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: f.t.id });
    const size = (input: NotingAgentInput) => tokens(input.prompt) + largestTaskPromptTokens() + tokens(JSON.stringify(input.tools)) + tokens(input.text);
    const capacity = size(f.calls[0] as NotingAgentInput) + 500;
    for (let i = 0; i < 4; i++) expect(f.note("Optional historical evidence " + "word ".repeat(1500))).toContain(`ok: F${i + 1}`);
    const next = f.m.store.appendTurn({ sessionId: f.s.id, parentTurnId: f.t.id, kind: "turn", userPrompt: "Next request", assistantText: "Okay", startedAt: "2026-09-08" });
    const result = await f.m.noting({ sessionId: f.s.id, branch: "main", headTurnId: next.id, capacity: { inputTokens: capacity } });
    expect(result.outcome).toBe("success");
    const run = f.calls.at(-1) as NotingAgentInput;
    expect(run.material.facts.length).toBeLessThan(4); // the history the negotiation trimmed stays trimmed
    expect(size(run)).toBeLessThanOrEqual(capacity);
  } finally { f.m.close(); }
});

test("review 2026-09-08: topic sets that join to the same text are still different sets in the diff and the knowledge line", async () => {
  const f = seeded();
  try {
    expect(f.note("Use SQLite")).toContain("ok: F1");
    const memory = f.m.tools({ kind: "manual", sessionId: f.s.id, branch: "main", currentTurnId: f.t.id }).find(tool => tool.name === "memory")!;
    const content = { text: "Use SQLite", category: "constraint", scope: "project", supports: ["F1"], reason: "Classify this conclusion." };
    expect(memory.execute({ op: "create", title: "Fixture title", ...content, topics: ["a, b"] })).toContain("committed");
    const entries = hydrate(f.m.store.sourcePath(f.s.id, "main", f.t.id), f.m.store);
    f.m.selectEntries(f.s.id, "main", entries.map(entry => entry.id));
    const path = { sessionId: f.s.id, branch: "main", headTurnId: f.t.id, triggerEntryId: entries.at(-1)!.id };
    expect(memoryFiles(f.m, path).read("trace://K1@v1").content).toContain("K1#");
    const updatedCommit = curateWrite(f.m, path, [{ op: "update", knowledgeId: 1, baseCommit: f.m.store.currentCommit(1, path)[0]!.id, text: content.text,
      category: "constraint", scope: "project", supports: [1], topics: ["a", "b"], reason: content.reason, createdAt: "2026-09-08" }])[0]!.commit;
    const files = memoryFiles(f.m, { sessionId: f.s.id, branch: "main", headTurnId: f.t.id });
    expect(files.read("trace://K1@v1").content).toContain('topics: ["a, b"]');
    expect(files.read(`trace://K1@v${f.m.store.versionOrdinal(1, updatedCommit)}`).content).toContain('topics: ["a","b"]');
    expect(renderKnowledgeDiff(f.m.store.knowledgeRevision(1)!, f.m.store.knowledgeRevision(updatedCommit)!, []))
      .toContain('topics: ["a, b"] -> ["a","b"]');
  } finally { f.m.close(); }
});
