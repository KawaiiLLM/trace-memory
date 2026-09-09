// 20a: the byte-level layout of core's own domain text. Core owns the titles, the block order and
// the separators of every memory consumer (user ruling 2026-09-08, revising 19b's ban on
// core-composed domain text), so the pins that used to live on the Pi adapter's composition module
// (hosts/pi/compose.test.ts, deleted with hosts/pi/compose.ts) live here, in the ruled order.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, compacted, renderEntry, tokens, type ConfigOverride, type ConsolidationAgentInput, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import type { Fact } from "../../../src/core/model/index.ts";
import { budgetKnowledge, charge } from "../../../src/core/render/index.ts";
import { budgetMaterial, knowledgeBlock as knowledgeBlockOf, BLOCK, FACTS_TITLE, RAW_TITLE } from "../../../src/core/render/material.ts";

let directory: string, memory: ReturnType<typeof sourceSeededMemory>, calls: (NotingAgentInput | ConsolidationAgentInput)[];
const time = "2026-09-08T00:00:00Z";
const ok = (): RunAgentResult => ({ outcome: "success", output: "[]", request: { fake: true } });

function open(config: ConfigOverride = {}) {
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => { calls.push(raw as NotingAgentInput); return ok(); }, config);
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "trace-memory-material-")); calls = []; open(); });
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

/** One turn with a tool call, one manually written fact and one knowledge item committed from it. */
function seeded() {
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command: "pnpm install" }), result: JSON.stringify({ stdout: "done", stderr: "" }), status: "success" });
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  expect(tools.find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: [`T${t.id}#user`] }] })).toContain("ok: F1");
  expect(tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] })).toContain('"committed"');
  return { s, t };
}
/** The same session after one Consolidation run: F1 is history, F2 is this task's pending fact. */
function consolidated() {
  const { s, t } = seeded();
  const note = (text: string) => memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text, source: [`T${t.id}#user`] }] });
  return { s, t, first: memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" }).then(() => note("Keep pnpm")) };
}
const knowledgeBlock = "<knowledge>\n<constraint>\n[K1@1] [constraint/project] The project uses pnpm\n  supports: F1\n</constraint>\n</knowledge>";
const views = (sessionId: number, head: number) =>
  memory.pendingEntries(sessionId, "main", head).map(e => renderEntry(e, memory.config.render).content).join("\n\n");

test("25a 2026-09-09: the Noter's fresh order is historical facts, range, the selected Raw, then receipts — and no knowledge block", async () => {
  const { s, t } = seeded();
  const raw = views(s.id, t.id);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const input = calls[0]! as NotingAgentInput;
  expect(input.text.fresh).toBe(["Recent facts (by Turn):", `[T1] ${time} (selected facts)\n${memory.trace("F1")}`,
    `Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`, "Raw:", raw].join("\n\n"));
  // 25a supersedes ticket 20's leading knowledge block for this consumer, in both modes. The
  // knowledge itself is untouched — the injection still carries it, and the run still froze it.
  expect(input.text.fresh).not.toContain("<knowledge>");
  expect(input.text.fresh).not.toContain("The project uses pnpm");
  expect(memory.inject(s.id)).toBe(knowledgeBlock);
  expect(input.readKnowledgeCommits).toEqual([{ knowledgeId: 1, commit: 1 }]);
});

test("20a 2026-09-08 for ruling 08:53: the Noter's inherited increment is the range, the head reply and the source index alone", async () => {
  const { s, t } = seeded();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" });
  const input = calls[0]! as NotingAgentInput;
  expect(input.text.inherited).toBe(`Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}\n\n[T${t.id}#assistant]: 好的。\n\nSources:\nT${t.id}#user 用 pnpm，不要 npm | T${t.id}#assistant 好的。 | T${t.id}#t1 tool=Bash {"command":"pnpm install"}`);
  // The raw turns, the delivered facts and the injected knowledge are already in that conversation.
  expect(input.text.inherited).not.toContain("Raw:");
  expect(input.text.inherited).not.toContain("<knowledge>");
  expect(input.text.inherited).not.toContain("Recent facts");
});

test("25a 2026-09-09: the Consolidator's fresh order is knowledge, range, the pending facts, the reminders, then receipts — and no already-consolidated block", async () => {
  const { s, first } = consolidated();
  await first;
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  const input = calls[1]! as ConsolidationAgentInput;
  expect(input.text.fresh).toBe([knowledgeBlock,
    "Range: F2..F2", "Range facts:", `[T1] ${time} (selected facts)\n${memory.trace("F2")}`,
    "Negated-evidence reminder (review cues only; no status derived):", "none"].join("\n\n"));
  // F1 was consolidated before this task was frozen and is exactly what the removed history block
  // used to carry; it is still stored, still readable, and no longer supplied.
  expect(memory.store.listConsolidatedProjectFacts(memory.store.getSession(s.id)!.projectId).map(f => f.id)).toContain(1);
  expect("facts" in input.material).toBe(false);
  expect(input.text.fresh).not.toContain("Already-consolidated");
  expect(input.text.fresh).not.toContain(memory.trace("F1"));
});

test("20a for ruling 08:53, as 25b left it: the Consolidator prepares its fresh text alone, no inherited increment", async () => {
  const { s, first } = consolidated();
  await first;
  await memory.consolidate({ sessionId: s.id, branch: "main" });
  // 25b: this phase runs one mode, so core prepares one representation; the fresh text carries the range facts.
  const input = calls[1]! as ConsolidationAgentInput;
  expect(input.text.inherited).toBeUndefined();
  expect(input.text.fresh).toContain("Range: F2..F2");
  expect(input.text.fresh).toContain("Range facts:");
  expect(input.material.factAddresses).toEqual(["F2"]); // the exact membership stays available to the host
});

test("20a 2026-09-08: the main agent's initial injection is knowledge and receipts only, and compact is knowledge, historical facts, pending Raw, receipts", async () => {
  const { s, t } = seeded();
  expect(memory.inject(s.id)).toBe(knowledgeBlock); // knowledge-only: no facts, no Raw, no range
  expect(compacted(memory.compact(s.id, "main", t.id))).toBe([knowledgeBlock,
    `<episodic>\nRecent facts (by Turn):\n\n[T1] ${time} (selected facts)\n${memory.trace("F1")}\n\nRaw:\n\n${views(s.id, t.id)}\n</episodic>`].join("\n\n"));
});

test("20a 2026-09-08 scenario 2, retargeted by 25a: two Consolidator tasks with the same knowledge and different pending facts are byte-identical through the knowledge block", async () => {
  const { s, t, first } = consolidated();
  await first;
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" }); // F2
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Still pnpm", source: [`T${t.id}#user`] }] });
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" }); // F3
  const [, earlier, later] = calls as ConsolidationAgentInput[];
  // A byte-layout test, not a provider-cache test: identical selected knowledge renders identically
  // when only the range and the pending facts change. The Noter is no longer a consumer of this
  // block at all (25a), so the pin moved to the phase that still leads with one.
  expect(earlier!.text.fresh.startsWith(knowledgeBlock)).toBe(true);
  expect(later!.text.fresh.startsWith(knowledgeBlock)).toBe(true);
  expect(later!.range.facts.map(f => f.id)).not.toEqual(earlier!.range.facts.map(f => f.id));
  // The range precedes this task's own facts, which precede the review cues.
  const order = ["Range: ", "Range facts:", "Negated-evidence reminder"].map(part => later!.text.fresh.indexOf(part));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order[0]).toBeGreaterThan(knowledgeBlock.length - 1);
  // Nothing task-specific is inside the leading block.
  expect(knowledgeBlock).not.toContain("Range: ");
  for (const address of later!.material.factAddresses) expect(knowledgeBlock).not.toContain(address);
});

test("20a 2026-09-08 scenario 2: budget receipts follow the dynamic material in both phases", async () => {
  const { s, t } = seeded();
  const raw = views(s.id, t.id);
  // The Noter has no knowledge block to receipt since 25a, so its budgeted optional material is the
  // historical facts: a history allowance that holds the bounded omission receipt but not the one
  // fact. (Receipts never come from an episodic overage — since the review of 2026-09-08 a budget
  // the mandatory material cannot fit reduces or holds the task instead.)
  const factReceipt = "omitted 1 older facts; expand: F1";
  memory.config.render.episodicBlockTokens = memory.config.noting.batchTokens + charge([factReceipt]) + charge(["Receipts:"]);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const noting = calls[0]! as NotingAgentInput;
  expect(noting.material.knowledge).toBeUndefined();
  expect(noting.material.facts).toEqual([]);
  expect(noting.material.receipts).toEqual([factReceipt]);
  expect(noting.text.fresh.endsWith(`Raw:\n\n${raw}\n\nReceipts:\n${factReceipt}`)).toBe(true);
  memory.config.render.episodicBlockTokens = 20_000;
  // The Consolidator still leads with knowledge, so its receipt is still the knowledge one.
  const receipt = "omitted 1 constraint knowledge; expand: K1";
  memory.config.render.knowledgeBlockTokens = tokens(receipt) + 1 + tokens("Receipts:") + 1; // the receipt, its separator and the heading `finish` adds
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  const consolidation = calls.at(-1)! as ConsolidationAgentInput;
  expect(consolidation.material.receipts).toEqual([receipt]);
  expect(consolidation.text.fresh.endsWith(`Negated-evidence reminder (review cues only; no status derived):\n\nnone\n\nReceipts:\n${receipt}`)).toBe(true);
});

// ---------------------------------------------------------------- 20b: the shared material budgets

/** Ticket 20 acceptance scenario 3, at the one function that budgets the shared material. The caps
 * are exercised at their exact boundaries, with the block titles, the range line, the joining
 * separators and the omission receipts all charged — none of them may overflow a cap in silence. */
test("20b 2026-09-08 scenario 3: exactly-at fits and one over does not, with labels, separators and receipts charged", () => {
  const view = "[Source entry id: T1#user]\n" + "word ".repeat(40);
  const line = "[F9] 2026-09-08T00:00:00Z [observation/user] " + "word ".repeat(20) + "\n  source: T1#user";
  const range = { from: "S1/T1", to: "S1/T2" }, framing = [FACTS_TITLE, RAW_TITLE];
  const facts = [{ id: 9, turnId: 1 } as Fact];
  const factTurns = new Map([[1, time]]);
  const groupedLine = `[T1] ${time} (selected facts)\n${line}`;
  const budget = (caps: { episodic: number; current?: number }) => budgetMaterial({ knowledge: [], current: view,
    framing, range, facts, factLine: () => line, factTurns, caps: { knowledge: 1_000, current: caps.current ?? 1_000, episodic: caps.episodic } });
  // The inner ceiling counts the current material with its own source label: exactly at it is silent,
  // one token below it is a receipt, never a cut view.
  expect(budget({ episodic: 5_000, current: tokens(view) }).receipts).toEqual([]);
  expect(budget({ episodic: 5_000, current: tokens(view) - 1 }).receipts)
    .toEqual([`raw ceiling: 1 tokens over ${tokens(view) - 1}; all unrecorded raw kept`]);
  // The enclosing budget: the smallest episodic budget that keeps the one historical fact is strictly
  // larger than the mandatory material plus that fact's own line, because the receipt that would
  // report its omission is reserved as well.
  const mandatory = tokens(view) + charge([...framing, `Range: ${range.from}..${range.to}`]);
  const smallest = [...Array(600).keys()].find(episodic => budget({ episodic }).facts.length === 1)!;
  expect(smallest).toBe(mandatory + charge([groupedLine])); // exactly at the budget, the fact is kept
  expect(budget({ episodic: smallest }).facts).toEqual([groupedLine]);
  expect(budget({ episodic: smallest }).receipts).toEqual([]);
  expect(budget({ episodic: smallest - 1 }).facts).toEqual([]); // one token under, it is omitted
  expect(budget({ episodic: smallest - 1 }).receipts).toContain("omitted 1 older facts; expand: F9");
  // Whatever the budget, everything emitted fits inside it — the retained facts and the receipts that
  // report the omitted ones. Only mandatory evidence may exceed it, and then it is receipted.
  const three = (episodic: number) => budgetMaterial({ knowledge: [], current: view, framing, range,
    facts: [9, 10, 11].map(id => ({ id, turnId: 1 }) as Fact), factLine: () => line, factTurns, caps: { knowledge: 1_000, current: 1_000, episodic } });
  for (let episodic = mandatory; episodic < mandatory + 4 * tokens(line); episodic++) {
    const budgeted = three(episodic);
    const emitted = mandatory + charge(budgeted.facts) + charge(budgeted.receipts);
    const overflowed = budgeted.receipts.some(r => r.startsWith("raw overage:"));
    expect([episodic, emitted <= episodic || overflowed]).toEqual([episodic, true]);
  }
  // Mandatory evidence is never dropped for the budget; the excess is receipted instead.
  const tight = budget({ episodic: 1 });
  expect(tight.facts).toEqual([]);
  expect(tight.receipts[0]).toMatch(/^raw overage: \d+ tokens; all unrecorded raw kept$/);
  // A large omitted list stays a bounded receipt rather than an enumeration that defeats the cap.
  const many = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, turnId: 1 }) as Fact);
  const bounded = budgetMaterial({ knowledge: [], current: view, framing, range, facts: many, factLine: () => line, factTurns,
    caps: { knowledge: 1_000, current: 1_000, episodic: mandatory + 60 } });
  expect(bounded.receipts).toEqual(["omitted 200 older facts; expand: F1, F2, F3, F4, F5, F6, F7, F8 and 192 more up to F200"]);
  expect(tokens(bounded.receipts.join("\n"))).toBeLessThan(60);
});

/** The same scenario end to end, at the ruled defaults: a task with more knowledge, more facts and
 * more Raw than any budget holds still sends each block within its own 10,000-token allowance. */
function overloaded() {
  const { s, t } = seeded();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  for (let i = 0; i < 12; i++) tools.find(tool => tool.name === "note")!.execute({ facts: Array.from({ length: 20 }, (_, k) =>
    ({ category: "observation", actor: "user", text: `claim ${i}.${k} ` + "word ".repeat(40), source: [`T${t.id}#user`] })) });
  for (let i = 0; i < 30; i++) tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.",
    text: `rule ${i} ` + "word ".repeat(500), category: i % 2 ? "constraint" : "mechanism", scope: "project", supports: ["F1"] }], skipped: [] });
  for (let i = 0; i < 6; i++) memory.appendEntry({ sessionId: s.id, nativeLineage: "big", nativeId: `b${i}`, turnId: t.id,
    role: "assistant", text: `entry ${i} ` + "word ".repeat(3000), raw: "", calls: [] });
  return { s, t };
}

test("25a 2026-09-09: at the default limits the Noter sends history within 10,000 and Raw within 10,000, with no knowledge block at all", async () => {
  const { s, t } = overloaded();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const material = calls.at(-1)!.material as NotingAgentInput["material"];
  const factReceipts = material.receipts.filter(r => r.includes(" older facts; expand: "));
  expect(factReceipts).toHaveLength(1); // the history cap really binds
  expect(material.receipts.some(r => r.includes(" knowledge; expand: "))).toBe(false); // nothing knowledge is budgeted here
  expect(knowledgeBlockOf(material)).toBe("");
  expect(calls.at(-1)!.text.fresh).not.toContain("<knowledge>");
  const historyCap = memory.config.render.episodicBlockTokens - memory.config.noting.batchTokens;
  expect(historyCap).toBe(10_000);
  expect(charge([FACTS_TITLE, ...material.facts, ...factReceipts])).toBeLessThanOrEqual(historyCap);
  expect(tokens(material.entries.map(e => e.view).join(BLOCK))).toBeLessThanOrEqual(memory.config.noting.batchTokens);
  expect(charge([FACTS_TITLE, RAW_TITLE, `Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`, ...material.facts, ...factReceipts])
    + tokens(material.entries.map(e => e.view).join(BLOCK))).toBeLessThanOrEqual(memory.config.render.episodicBlockTokens);
  expect(tokens(calls.at(-1)!.text.fresh)).toBeLessThanOrEqual(20_000);
});

test("25a 2026-09-09: at the default limits the Consolidator sends knowledge within 10,000 and its facts, cues and framing within 10,000", async () => {
  const { s, t } = overloaded();
  await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const input = calls.at(-1)! as ConsolidationAgentInput;
  const material = input.material;
  const knowledgeReceipts = material.receipts.filter(r => r.includes(" knowledge; expand: "));
  expect(knowledgeReceipts.length).toBeGreaterThan(0); // the knowledge cap really binds
  expect(tokens(knowledgeBlockOf(material)) + charge(knowledgeReceipts)).toBeLessThanOrEqual(memory.config.render.knowledgeBlockTokens);
  // The pending facts, their review cues and the framing around them share one allowance; there is
  // no episodic budget beside it any more, and no historical-fact block inside it.
  expect(charge([`Range: ${input.range.from}..${input.range.to}`, "Range facts:", ...material.rangeFacts,
    "Negated-evidence reminder (review cues only; no status derived):", ...material.reminders]))
    .toBeLessThanOrEqual(memory.config.consolidation.batchTokens);
  expect(material.receipts.some(r => r.includes(" older facts; expand: "))).toBe(false);
  expect(input.text.fresh).not.toContain("Already-consolidated");
  expect(memory.store.consolidationBatch(s.id, "main", t.id).length).toBeGreaterThan(0); // the rest stays pending
});

// ---- 21b 2026-09-08: the labels ride the one shared knowledge renderer, inside ticket 20's cap ----

test("21b 2026-09-08, narrowed by 25a: the three knowledge consumers render topics through the one renderer, and a multi-topic item appears once", async () => {
  const { s, t } = seeded();
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "memory")!
    .execute({ operations: [{ op: "update", id: "K1", topics: ["packaging", "storage"], reason: "Classification cleanup: two subjects.",
      text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] });
  const labelled = "<knowledge>\n<constraint>\n[K1@2] [constraint/project] The project uses pnpm\n  supports: F1 · topics: [\"packaging\",\"storage\"]\n</constraint>\n</knowledge>";
  expect(memory.inject(s.id)).toBe(labelled);
  expect(compacted(memory.compact(s.id, "main", t.id)).startsWith(labelled)).toBe(true);
  // The Noter is the fourth consumer no longer: 25a gives it no knowledge block in either mode.
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect((calls.at(-1)! as NotingAgentInput).text.fresh).not.toContain("topics:");
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  const consolidation = calls.at(-1)! as ConsolidationAgentInput;
  expect(consolidation.text.fresh.startsWith(labelled)).toBe(true);
  // Two subjects, one automatic copy: grouping is a read projection, never a second injected line.
  for (const text of [memory.inject(s.id), consolidation.text.fresh]) expect(text.match(/\[K1@2\]/g)).toHaveLength(1);
});

test("21b 2026-09-08: rendered labels are charged to the knowledge cap, and the leading block stays byte-identical across tasks", async () => {
  const { s, t } = seeded();
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "memory")!
    .execute({ operations: [{ op: "update", id: "K1", topics: ["packaging", "storage"], reason: "Classification cleanup: two subjects.",
      text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] });
  const value = memory.store.listVisibleKnowledge(s.id, memory.store.getSession(s.id)!.projectId)[0]!;
  const bare = { ...value, revision: { ...value.revision, topics: [] } };
  // The smallest cap that still keeps this one item whole; below the receipt's own cost the budget
  // reports a capacity error instead, which is not "kept" either.
  const fits = (item: typeof value, cap: number) => { try { return budgetKnowledge([item], cap).groups.some(g => g.text); } catch { return false; } };
  const minimum = (item: typeof value) => { let cap = 1; while (!fits(item, cap)) cap++; return cap; };
  // 20b charges every rendered line: the labelled revision needs a strictly larger cap than the same
  // revision without them, so labels cannot ride along outside the budget.
  expect(minimum(value)).toBeGreaterThan(minimum(bare));
  memory.config.render.knowledgeBlockTokens = minimum(value) - 1;
  expect(memory.inject(s.id)).toContain("omitted 1 constraint knowledge; expand: K1");
  memory.config.render.knowledgeBlockTokens = minimum(value);
  // Identical selected revisions and topics render the same leading bytes when only the range and the
  // pending facts change. Pinned on the Consolidator since 25a removed the Noter's knowledge block.
  const note = (text: string) => memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text, source: [`T${t.id}#user`] }] });
  note("Keep pnpm");
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  note("Still pnpm");
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  const [first, later] = calls as ConsolidationAgentInput[];
  expect(later!.range.facts.map(f => f.id)).not.toEqual(first!.range.facts.map(f => f.id));
  expect(knowledgeBlockOf(later!.material)).toBe(knowledgeBlockOf(first!.material));
  expect(knowledgeBlockOf(later!.material)).toContain('· topics: ["packaging","storage"]');
});

// ------------------------------- 25a: two independent allowances, one shared full-fact renderer ---

/** Ticket 25 "Noter material contract": the Noter's history and its Raw batch are two caps, not one
 * shared pool. The Raw ceiling is reserved out of the episodic budget whether or not the batch fills
 * it, which is what keeps the two from trading space. Exercised at `budgetMaterial`, the function
 * that implements it, and then end to end through a real freeze. */
test("25a 2026-09-09: the history and Raw allowances are independent — neither's unused space enlarges the other", () => {
  const line = "[F9] 2026-09-08T00:00:00Z [observation/user] " + "word ".repeat(20) + "\n  source: T1#user";
  const facts = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, turnId: 1 }) as Fact);
  const factTurns = new Map([[1, time]]);
  const range = { from: "S1/T1", to: "S1/T2" }, framing = [FACTS_TITLE, RAW_TITLE];
  const history = charge([`[T1] ${time} (selected facts)`, ...Array(4).fill(line)]); // room for about four facts
  const budget = (current: string, cap = history) => budgetMaterial({ current, framing, range, facts,
    factLine: () => line, factTurns, history: cap, caps: { episodic: 20_000, current: 10_000 } });
  const tiny = budget("[Source entry id: T1#user]\nshort");
  const full = budget("[Source entry id: T1#user]\n" + "word ".repeat(3_000)); // near the Raw ceiling
  expect(tiny.facts.length).toBeGreaterThan(0);
  expect(tiny.facts.length).toBeLessThan(facts.length); // the history cap really binds
  expect(tiny.facts).toEqual(full.facts); // a small Raw batch buys no extra history
  expect(charge([FACTS_TITLE, ...tiny.facts, ...tiny.receipts])).toBeLessThanOrEqual(history + charge([FACTS_TITLE]));
  // The converse: the Raw ceiling is the same whether the history block is full, trimmed or empty.
  const over = (cap: number) => budget("[Source entry id: T1#user]\n" + "word ".repeat(20_000), cap).over.current;
  expect(over(0)).toBe(over(history));
  expect(over(0)).toBe(over(20_000));
  expect(over(0)).toBeGreaterThan(0); // the Raw ceiling really binds
});

test("25a 2026-09-09: a Noter freeze keeps its history inside the reserved allowance even when the Raw batch is tiny", async () => {
  const { s, t } = seeded();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  for (let i = 0; i < 8; i++) tools.find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "observation", actor: "user", text: `history ${i} ` + "word ".repeat(120), source: [`T${t.id}#user`] }] });
  // Nine tenths of the episodic budget is the reserved Raw ceiling; the room left for history is what
  // this freeze may use, however little of that ceiling this one short batch actually needs.
  const room = 400;
  memory.config.render.episodicBlockTokens = memory.config.noting.batchTokens + room;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const material = calls.at(-1)!.material as NotingAgentInput["material"];
  const raw = tokens(material.entries.map(e => e.view).join(BLOCK));
  expect(raw).toBeLessThan(memory.config.noting.batchTokens / 10); // the batch nowhere near its ceiling
  expect(charge([FACTS_TITLE, ...material.facts, ...material.receipts])).toBeLessThanOrEqual(room + charge([FACTS_TITLE]));
  expect(material.facts.length).toBeGreaterThan(0);
  expect(material.receipts.some(r => r.includes(" older facts; expand: "))).toBe(true); // the rest is named, not hidden
});

/** Ticket 25 "One full-fact renderer": for one selected fact set and annotation snapshot, the
 * foreground `<noted>` receipt and the Noter subagent's history block are the same bytes. Only the
 * enclosing title differs, which is what lets a fork inherit its history through the receipts. */
test("25a 2026-09-09: the <noted> receipt payload and the Noter's history block are byte-identical between their titles", async () => {
  const project = memory.store.createProject({ name: "shared-renderer", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const first = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "记下来", assistantText: "好。", startedAt: time });
  const later = "2026-09-09T00:00:00Z";
  const second = memory.store.appendTurn({ sessionId: s.id, parentTurnId: first.id, kind: "turn", userPrompt: "再来一次", assistantText: "好。", startedAt: later });
  // One committed batch with a pending delivery, spanning two Turns and one multi-Turn citation.
  const write = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: later },
    pendingDelivery: { sessionId: s.id, branch: "main" }, facts: [
      { turnId: second.id, category: "observation", actor: "user", text: "late claim", quote: null, source: [`T${second.id}#user`], createdAt: later },
      { turnId: first.id, category: "observation", actor: "user", text: "early claim", quote: null, source: [`T${first.id}#user`], createdAt: time },
      { turnId: first.id, category: "observation", actor: "user", text: "multi-source claim", quote: null, source: [`T${first.id}#user`, `T${second.id}#assistant`], createdAt: time },
    ] });
  if (!write.ok) throw new Error(write.problems.join("; "));
  const delivered = memory.deliver(s.id, "main");
  // A later Noting task whose history is exactly that same selected set and annotation snapshot.
  memory.appendEntry({ sessionId: s.id, nativeLineage: "shared", nativeId: "e1", turnId: second.id, role: "assistant", text: "still here", raw: "", calls: [] });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: second.id, mode: "subagent" });
  const history = (calls.at(-1)! as NotingAgentInput).material.facts;
  expect(history.length).toBe(memory.store.listSessionFacts(s.id).length); // the same selected set
  expect(delivered.text).toBe(`<noted>\n${history.join("\n")}\n</noted>`);
});

/** Ticket 25 "Noter material contract": a fork is priced on the subagent material too, so the
 * fallback that may run it as a subagent can never be a task the window cannot hold. */
test("25a 2026-09-09: a fork freeze prices the complete subagent material, not only its inherited increment", async () => {
  const { s, t } = seeded();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const bare = calls[0]! as NotingAgentInput;
  const fixed = tokens(bare.prompt) + tokens(JSON.stringify(bare.tools));
  const forkPrice = tokens(bare.prompt) + tokens(bare.text.inherited!);
  const subagentPrice = fixed + tokens(bare.text.fresh);
  expect(forkPrice).toBeLessThan(subagentPrice); // the increment alone is the cheaper representation
  memory.appendEntry({ sessionId: s.id, nativeLineage: "fixture", nativeId: "second", turnId: t.id, role: "assistant", text: "another entry", raw: "", calls: [] });
  // An allowance that the inherited increment fits and the subagent material does not: a fork task is
  // still rejected, because the fallback would have to send the subagent material.
  await expect(memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork",
    capacity: { inputTokens: forkPrice, prefixTokens: 0 } })).rejects.toThrow(/Noting capacity/);
  expect(memory.pendingEntries(s.id, "main", t.id).length).toBeGreaterThan(0);
});
