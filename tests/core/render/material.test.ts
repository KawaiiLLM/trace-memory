// 20a: the byte-level layout of core's own domain text. Core owns the titles, the block order and
// the separators of every memory consumer (user ruling 2026-09-08, revising 19b's ban on
// core-composed domain text), so the pins that used to live on the Pi adapter's composition module
// (hosts/pi/compose.test.ts, deleted with hosts/pi/compose.ts) live here, in the ruled order.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, NOTING_INCOMPLETE, sourceSeededMemory, compacted, renderEntry, tokens, visibleTarget, type ConfigOverride, type ConsolidationAgentInput, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import type { Fact } from "../../../src/core/model/index.ts";
import { freezeConsolidation } from "../../../src/core/consolidation/index.ts";
import { budgetFacts, budgetKnowledge, charge, finish, renderFact, renderKnowledge, renderKnowledgeBlock } from "../../../src/core/render/index.ts";
import { budgetMaterial, knowledgeBlock as knowledgeBlockOf, BLOCK, FACTS_TITLE, KNOWLEDGE_STATUS_TITLE, RAW_TITLE } from "../../../src/core/render/material.ts";

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
  return { s, t, read: (address: string) => tools.find(tool => tool.name === "trace")!.execute({ address, cap: Number.MAX_SAFE_INTEGER }) };
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
  expect(input.text).toBe(["Recent facts (by Turn):", `[T1] ${time} (selected facts)\n${memory.trace("F1")}`,
    `Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`, "Raw:", raw].join("\n\n"));
  // 25a supersedes ticket 20's leading knowledge block for this consumer, in both modes. The
  // knowledge itself is untouched — the injection still carries it, and the run still froze it.
  expect(input.text).not.toContain("<knowledge>");
  expect(input.text).not.toContain("The project uses pnpm");
  expect(memory.inject(s.id)).toBe(knowledgeBlock);
  expect(input.readKnowledgeCommits).toEqual([{ knowledgeId: 1, commit: 1 }]);
});

/** 29b (case 12) supersedes 20a's fixed inherited layout and 25a's "a Noter fork never adds
 * historical facts": the same builder produces this text, and the only reason it has no Raw block is
 * that the view proves every target entry visible. The optional history is still supplied, because
 * nothing proves the child can see F1 — a receipt in prose is not coverage. */
test("29b 2026-09-10: a fork whose whole target is visible injects no Raw and keeps the range, head reply and source index", async () => {
  const { s, t } = seeded();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork",
    visible: visibleTarget(memory, s.id, "main", t.id) });
  const input = calls[0]! as NotingAgentInput;
  expect(input.text).toBe(["Recent facts (by Turn):", `[T1] ${time} (selected facts)\n${memory.trace("F1")}`,
    `Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`, `[T${t.id}#E2@text] assistant: 好的。`,
    `Sources:\n[T${t.id}#E1@text] user:\n[... 13 characters truncated]\n[T${t.id}#E2@text] assistant:\n[... 3 characters truncated]\n[T${t.id}#E3@call-1] Bash(...)\n[... 12 characters truncated]\n[T${t.id}#E4@call-1] Bash success:\n[... 29 characters truncated]`].join("\n\n"));
  // The raw turns and the injected knowledge are already in that conversation.
  expect(input.text).not.toContain("Raw:");
  expect(input.text).not.toContain("<knowledge>");
  expect(input.material.entries).toEqual([]); // nothing newly supplied, and the whole target still frozen
  expect(input.entryIds.length).toBeGreaterThan(0);
  expect(input.supplied.entries).toEqual([]);
  expect(input.supplied.factIds).toEqual([1]);
});

test("25a 2026-09-09: the Consolidator's fresh order is knowledge, range, the pending facts, the reminders, then receipts — and no already-consolidated block", async () => {
  const { s, first } = consolidated();
  await first;
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  const input = calls[1]! as ConsolidationAgentInput;
  expect(input.text).toBe([knowledgeBlock,
    "Range: F2..F2", "Range facts:", `[T1] ${time} (selected facts)\n${memory.trace("F2")}`,
    "Negated-evidence reminder (review cues only; no status derived):", "none"].join("\n\n"));
  // F1 was consolidated before this task was frozen and is exactly what the removed history block
  // used to carry; it is still stored, still readable, and no longer supplied.
  expect(memory.store.listConsolidatedProjectFacts(memory.store.getSession(s.id)!.projectId).map(f => f.id)).toContain(1);
  expect("facts" in input.material).toBe(false);
  expect(input.text).not.toContain("Already-consolidated");
  expect(input.text).not.toContain(memory.trace("F1"));
});

test("20a for ruling 08:53, as 25b and 29b left it: the Consolidator prepares one text, and it carries the range facts", async () => {
  const { s, first } = consolidated();
  await first;
  await memory.consolidate({ sessionId: s.id, branch: "main" });
  // 29b: one prepared text per task in both phases; with an empty initial view it is the whole material.
  const input = calls[1]! as ConsolidationAgentInput;
  expect(typeof input.text).toBe("string");
  expect(input.text).toContain("Range: F2..F2");
  expect(input.text).toContain("Range facts:");
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
  expect(earlier!.text.startsWith(knowledgeBlock)).toBe(true);
  expect(later!.text.startsWith(knowledgeBlock)).toBe(true);
  expect(later!.range.facts.map(f => f.id)).not.toEqual(earlier!.range.facts.map(f => f.id));
  // The range precedes this task's own facts, which precede the review cues.
  const order = ["Range: ", "Range facts:", "Negated-evidence reminder"].map(part => later!.text.indexOf(part));
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
  expect(noting.text.endsWith(`Raw:\n\n${raw}\n\nReceipts:\n${factReceipt}`)).toBe(true);
  memory.config.render.episodicBlockTokens = 20_000;
  // The Consolidator still leads with knowledge, so its receipt is still the knowledge one.
  const receipt = "omitted 1 constraint knowledge; expand: K1";
  memory.config.consolidation.knowledgeTokens = tokens(receipt) + 1 + tokens("Receipts:") + 1; // the receipt, its separator and the heading `finish` adds
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  const consolidation = calls.at(-1)! as ConsolidationAgentInput;
  expect(consolidation.material.receipts).toEqual([receipt]);
  expect(consolidation.text.endsWith(`Negated-evidence reminder (review cues only; no status derived):\n\nnone\n\nReceipts:\n${receipt}`)).toBe(true);
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
  expect(calls.at(-1)!.text).not.toContain("<knowledge>");
  const historyCap = memory.config.render.episodicBlockTokens - memory.config.noting.batchTokens;
  expect(historyCap).toBe(10_000);
  expect(charge([FACTS_TITLE, ...material.facts, ...factReceipts])).toBeLessThanOrEqual(historyCap);
  expect(tokens(material.entries.map(e => e.view).join(BLOCK))).toBeLessThanOrEqual(memory.config.noting.batchTokens);
  expect(charge([FACTS_TITLE, RAW_TITLE, `Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`, ...material.facts, ...factReceipts])
    + tokens(material.entries.map(e => e.view).join(BLOCK))).toBeLessThanOrEqual(memory.config.render.episodicBlockTokens);
  expect(tokens(calls.at(-1)!.text)).toBeLessThanOrEqual(20_000);
});

test("25a 2026-09-09: at the default limits the Consolidator sends knowledge within 10,000 and its facts, cues and framing within 10,000", async () => {
  const { s, t } = overloaded();
  await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const input = calls.at(-1)! as ConsolidationAgentInput;
  const material = input.material;
  const knowledgeReceipts = material.receipts.filter(r => r.includes(" knowledge; expand: "));
  expect(knowledgeReceipts.length).toBeGreaterThan(0); // the knowledge cap really binds
  expect(tokens(knowledgeBlockOf(material)) + charge(knowledgeReceipts)).toBeLessThanOrEqual(memory.config.consolidation.knowledgeTokens);
  // The pending facts, their review cues and the framing around them share one allowance; there is
  // no episodic budget beside it any more, and no historical-fact block inside it.
  expect(charge([`Range: ${input.range.from}..${input.range.to}`, "Range facts:", ...material.rangeFacts,
    "Negated-evidence reminder (review cues only; no status derived):", ...material.reminders]))
    .toBeLessThanOrEqual(memory.config.consolidation.batchTokens);
  expect(material.receipts.some(r => r.includes(" older facts; expand: "))).toBe(false);
  expect(input.text).not.toContain("Already-consolidated");
  expect(memory.store.consolidationBatch(s.id, "main", t.id).length).toBeGreaterThan(0); // the rest stays pending
});

// ---- 21b 2026-09-08: the labels ride the one shared knowledge renderer, inside ticket 20's cap ----

test("21b 2026-09-08, narrowed by 25a: the three knowledge consumers render topics through the one renderer, and a multi-topic item appears once", async () => {
  const { s, t, read } = seeded();
  read("K1@1");
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "memory")!
    .execute({ operations: [{ op: "update", id: "K1@1", topics: ["packaging", "storage"], reason: "Classification cleanup: two subjects.",
      text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] });
  const labelled = "<knowledge>\n<constraint>\n[K1@2] [constraint/project] The project uses pnpm\n  supports: F1 · topics: [\"packaging\",\"storage\"]\n</constraint>\n</knowledge>";
  expect(memory.inject(s.id)).toBe(labelled);
  expect(compacted(memory.compact(s.id, "main", t.id)).startsWith(labelled)).toBe(true);
  // The Noter is the fourth consumer no longer: 25a gives it no knowledge block in either mode.
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect((calls.at(-1)! as NotingAgentInput).text).not.toContain("topics:");
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  const consolidation = calls.at(-1)! as ConsolidationAgentInput;
  expect(consolidation.text.startsWith(labelled)).toBe(true);
  // Two subjects, one automatic copy: grouping is a read projection, never a second injected line.
  for (const text of [memory.inject(s.id), consolidation.text]) expect(text.match(/\[K1@2\]/g)).toHaveLength(1);
});

test("21b 2026-09-08: rendered labels are charged to the knowledge cap, and the leading block stays byte-identical across tasks", async () => {
  const { s, t, read } = seeded();
  read("K1@1");
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "memory")!
    .execute({ operations: [{ op: "update", id: "K1@1", topics: ["packaging", "storage"], reason: "Classification cleanup: two subjects.",
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
 * enclosing title differs, which is what lets a fork inherit its history through the receipts.
 * 29d: the `<noted>` delivery payload this test used to compare against is retired, so the surviving
 * second producer of that same set is the branch carry — the ruled property (one renderer, two
 * titles) is unchanged, only its witness. */
test("25a 2026-09-09: the branch carry's fact payload and the Noter's history block are byte-identical between their titles", async () => {
  const project = memory.store.createProject({ name: "shared-renderer", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const first = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "记下来", assistantText: "好。", startedAt: time });
  const later = "2026-09-09T00:00:00Z";
  const second = memory.store.appendTurn({ sessionId: s.id, parentTurnId: first.id, kind: "turn", userPrompt: "再来一次", assistantText: "好。", startedAt: later });
  // One committed batch spanning two Turns and one multi-Turn citation.
  const write = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: later }, facts: [
      { turnId: second.id, category: "observation", actor: "user", text: "late claim", quote: null, source: [`T${second.id}#user`], createdAt: later },
      { turnId: first.id, category: "observation", actor: "user", text: "early claim", quote: null, source: [`T${first.id}#user`], createdAt: time },
      { turnId: first.id, category: "observation", actor: "user", text: "multi-source claim", quote: null, source: [`T${first.id}#user`, `T${second.id}#assistant`], createdAt: time },
    ] });
  if (!write.ok) throw new Error(write.problems.join("; "));
  const carry = memory.branchSummary(s.id, "main", second.id);
  // A later Noting task whose history is exactly that same selected set and annotation snapshot.
  memory.appendEntry({ sessionId: s.id, nativeLineage: "shared", nativeId: "e1", turnId: second.id, role: "assistant", text: "still here", raw: "", calls: [] });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: second.id, mode: "subagent" });
  const history = (calls.at(-1)! as NotingAgentInput).material.facts;
  expect(history.length).toBe(memory.store.listSessionFacts(s.id).length); // the same selected set
  expect(carry).toContain(`Facts:\n${history.join("\n")}\nCommits`);
});

/** 29b (capacity) supersedes ticket 25's "a fork is priced on the subagent material too": a fork pays
 * its inherited measure, the instructions and the text it actually sends, and never the cost of a
 * fresh representation it does not build. The fallback is not left unguarded — a re-admitted subagent
 * re-freezes with the empty initial state and refuses the batch on its own terms, which is the second
 * half of this case. */
test("29b 2026-09-10: a fork is priced as its inherited measure plus the instructions plus the text it supplies", async () => {
  const { s, t } = seeded();
  const prefix = 5_000;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", effectiveMode: "fork",
    visible: visibleTarget(memory, s.id, "main", t.id), capacity: { inputTokens: 60_000, prefixTokens: prefix } });
  const fork = calls[0]! as NotingAgentInput;
  const forkPrice = prefix + tokens(fork.prompt) + tokens(fork.text);
  expect(fork.material.entries).toEqual([]); // the Raw the child can already see is not in that price
  // The run above ended without calling note, so the whole batch is still pending (26a) and can be
  // frozen again: at exactly its own price it fits whole.
  calls.length = 0;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", effectiveMode: "fork",
    visible: visibleTarget(memory, s.id, "main", t.id), capacity: { inputTokens: forkPrice, prefixTokens: prefix } });
  expect((calls[0]! as NotingAgentInput).entryIds).toEqual(fork.entryIds);
  // The same batch as a fresh child is priced by its own terms — instructions, tool definitions and
  // the full material — and the fork's allowance minus its inherited measure does not cover them.
  await expect(memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent",
    capacity: { inputTokens: forkPrice - prefix, prefixTokens: 0 } })).rejects.toThrow(/Noting capacity/);
  expect(memory.pendingEntries(s.id, "main", t.id).length).toBeGreaterThan(0);
});

// ---- 29b 2026-09-10: one material builder, two initial states (parent 29, cases 10, 12, 13, 15) ----

/** `count` extra facts on the seeded Turn, oldest first, each long enough to be worth budgeting. */
function history(sessionId: number, turnId: number, count: number) {
  const note = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turnId }).find(tool => tool.name === "note")!;
  for (let i = 0; i < count; i++)
    note.execute({ facts: [{ category: "observation", actor: "user", text: `Older claim ${i} ` + "detail ".repeat(20), source: [`T${turnId}#user`] }] });
}

/** Case 10. The allowance is set to hold exactly three fact lines. With the newest facts visible, the
 * three the child cannot see fill it — a budget applied first and visibility subtracted afterwards
 * would leave one. Filtering first is also never filling: fewer needed facts make a smaller block. */
test("29b 2026-09-10 (case 10): visible facts leave the history allowance before it is filled, and the missing ones get all of it", async () => {
  const { s, t } = seeded();
  history(s.id, t.id, 5); // F2..F6 beside the seeded F1
  const facts = memory.store.listSessionFacts(s.id);
  const line = (fact: Fact) => renderFact(fact, memory.store.listFactRelations(fact.id));
  const turns = memory.store.factTurnTimes(facts);
  // An allowance around three fact lines, so the block is really bound by it.
  const room = charge(budgetFacts(facts, line, Number.MAX_SAFE_INTEGER, turns).recent.slice(0, 3));
  memory.close();
  open({ render: { episodicBlockTokens: DEFAULT_CONFIG.noting.batchTokens + room } });
  const seen = visibleTarget(memory, s.id, "main", t.id);
  const supplied = async (factIds: number[]) => {
    await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork",
      visible: { ...seen, factIds: new Set(factIds) } });
    return (calls.at(-1)! as NotingAgentInput).material.facts;
  };
  // Nothing proven visible: the allowance goes to the newest facts, and it really binds.
  const all = await supplied([]);
  expect(all.length).toBeGreaterThan(0);
  expect(all.length).toBeLessThan(facts.length);
  expect(all.join("\n")).toContain("[F6]");
  // The two newest are visible: the same number of facts still fits, and they are the older ones the
  // child cannot see. A budget applied first and visibility subtracted afterwards would leave fewer.
  const older = await supplied([5, 6]);
  expect(older).toHaveLength(all.length);
  expect(older.join("\n")).not.toContain("[F6]");
  expect(older.join("\n")).not.toContain("[F5]");
  expect(older.join("\n")).toContain("[F4]");
  // Never filler: with one fact missing the block holds one, not the three the allowance would take.
  const one = await supplied([1, 2, 3, 4, 5]);
  expect(one).toHaveLength(1);
  expect(one.join("\n")).toContain("[F6]");
  expect(charge(one)).toBeLessThan(charge(older));
});

/** Case 12. The frozen target is the processing target, not the injection: a fork that repeats no Raw
 * still writes for every entry of it, and ending without a submission is still incomplete. */
test("29b 2026-09-10 (case 12): a fork with no newly supplied Raw still commits its whole frozen target, and no call is still incomplete", async () => {
  const { s, t } = seeded();
  const seen = visibleTarget(memory, s.id, "main", t.id);
  const pending = memory.pendingEntries(s.id, "main", t.id).map(e => e.id);
  let committed: string | undefined;
  memory.close(); open();
  calls.length = 0;
  const noter = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    calls.push(input);
    committed = input.tools.find(tool => tool.name === "note")!.execute({ facts: [{ category: "observation", actor: "user", text: "Noted from the inherited context", source: [`T${t.id}#user`] }] }) as string;
    return { outcome: "success", output: "", request: { fake: true } };
  });
  try {
    const result = await noter.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", visible: seen });
    expect(result.outcome).toBe("success");
    const input = calls[0]! as NotingAgentInput;
    expect(input.material.entries).toEqual([]); // nothing repeated
    expect(input.entryIds).toEqual(pending); // the whole frozen target all the same
    expect(committed).toContain("ok: F");
    expect(noter.pendingEntries(s.id, "main", t.id)).toEqual([]); // every frozen entry advanced
  } finally { noter.close(); }
  // The other half: the same fork that ends without calling note is incomplete, not an empty success.
  const silent = sourceSeededMemory(join(directory, "test.sqlite"), async () => ({ outcome: "success", output: "nothing to record", request: { fake: true } }));
  try {
    memory.appendEntry({ sessionId: s.id, nativeLineage: "fixture", nativeId: "later", turnId: t.id, role: "assistant", text: "later entry", raw: "", calls: [] });
    const result = await silent.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork",
      visible: visibleTarget(silent, s.id, "main", t.id) });
    expect(result.outcome).toBe("failure");
    expect((result as { problems: string[] }).problems).toEqual([NOTING_INCOMPLETE]);
    expect(silent.pendingEntries(s.id, "main", t.id).length).toBeGreaterThan(0);
  } finally { silent.close(); }
});

/** Case 13. The empty initial state is not a special path: it produces the whole selected target and
 * the bounded optional material for both phases, and the run sends that text once. */
test("29b 2026-09-10 (case 13): an empty view and zero inherited cost produce the full material for both phases, sent once", async () => {
  const { s, t, first } = consolidated();
  await first;
  calls.length = 0;
  let rounds = 0;
  const worker = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput | ConsolidationAgentInput;
    calls.push(input);
    if (input.kind === "noting") {
      // Two tool rounds inside one run: the child keeps its own messages and nothing is resent.
      input.tools.find(tool => tool.name === "trace")!.execute({ address: `T${t.id}#user` }); rounds++;
      input.tools.find(tool => tool.name === "note")!.execute({ facts: [] }); rounds++;
    }
    return { outcome: "success", output: "", request: { fake: true } };
  });
  try {
    await worker.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
    const noting = calls[0]! as NotingAgentInput;
    expect(noting.material.entries.map(e => e.id)).toEqual(noting.entryIds); // the whole selected target
    expect(noting.material.head).toBe(null); // no repair parts: nothing was withheld
    expect(noting.material.sources).toEqual([]);
    expect(noting.text).toContain("Raw:");
    expect(noting.supplied.entries.map(e => e.id)).toEqual(noting.entryIds);
    expect(rounds).toBe(2);
    expect(calls).toHaveLength(1); // one prepared material, one dispatch: the second round adds nothing
    await worker.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
    const consolidation = calls[1]! as ConsolidationAgentInput;
    expect(consolidation.material.rangeFacts.join("\n")).toContain(consolidation.material.factAddresses[0]!);
    expect(consolidation.material.knowledgeNotes).toEqual([]);
    expect(consolidation.text).toContain("<knowledge>");
    expect(consolidation.supplied.factIds.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(2);
  } finally { worker.close(); }
});

/** Case 15. Knowledge is compared by exact commit: an unchanged visible commit is omitted, a visible
 * predecessor covers nothing, and what happened to a stale inherited commit is said inside the same
 * knowledge allowance rather than in an unbounded block of its own. */
test("29b 2026-09-10 (case 15): the knowledge block is the commit delta, and stale inherited commits are explained inside its allowance", async () => {
  const { s, t } = seeded();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  const memoryTool = () => tools.find(tool => tool.name === "memory")!;
  tools[0]!.execute({ address: "K1@1" });
  memoryTool().execute({ operations: [{ op: "update", id: "K1@1", topics: [], reason: "The rule was restated.", text: "The project uses pnpm only", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] });
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  const current = memory.store.listVisibleKnowledge(s.id, memory.store.getSession(s.id)!.projectId)[0]!.revision.id;
  expect(current).toBe(2);

  const freeze = (commits: number[], config = memory.config) => freezeConsolidation(memory.store,
    { sessionId: s.id, branch: "main", mode: "fork", effectiveMode: "fork",
      visible: { raw: new Map(), factIds: new Set(), knowledgeCommitIds: new Set(commits), injection: false, suppliedGeneration: 0 } }, config);
  // The visible predecessor covers nothing: the current commit is supplied and its predecessor named.
  const stale = freeze([1]);
  expect(stale.prepared!.material.knowledge.map(g => g.text).join("\n")).toContain(`[K1@${current}]`);
  expect(stale.prepared!.material.knowledgeNotes).toEqual([`K1@1 is superseded by K1@${current} above`]);
  expect(stale.prepared!.text).toContain("Inherited knowledge status");
  expect(stale.prepared!.supplied.knowledgeCommitIds).toEqual([current]);
  // The same commit, unchanged and visible: omitted, with nothing to explain.
  const unchanged = freeze([current]);
  expect(unchanged.prepared!.material.knowledge.map(g => g.text).join("")).toBe("");
  expect(unchanged.prepared!.material.knowledgeNotes).toEqual([]);
  expect(unchanged.prepared!.text).not.toContain("Inherited knowledge status");
  expect(unchanged.prepared!.supplied.knowledgeCommitIds).toEqual([]);
  // An archived revision is not current authority, and the status says so where the block cannot.
  tools[0]!.execute({ address: `K1@${current}` });
  memoryTool().execute({ operations: [{ op: "archive", id: `K1@${current}`, reason: "Withdrawn by the user.", supports: ["F1"] }], skipped: [] });
  expect(freeze([current]).prepared!.material.knowledgeNotes).toEqual([`K1@${current} is archived`]);
  // Charged inside the knowledge allowance: an allowance that the status line fills leaves the block
  // nothing, and the omission is receipted rather than emitted over budget.
  const note = `K1@${current} is archived`;
  const tight = { ...memory.config, consolidation: { ...memory.config.consolidation, knowledgeTokens: charge([KNOWLEDGE_STATUS_TITLE, note]) } };
  const squeezed = freeze([current], tight);
  expect(squeezed.prepared!.material.knowledgeNotes).toEqual([note]);
  expect(squeezed.prepared!.material.knowledge.map(g => g.text).join("")).toBe("");
});

test("32de: required exact versions outrank relevance; optional selection and framing share only the remainder", () => {
  const { s } = seeded();
  const base = memory.store.listVisibleKnowledge(s.id, memory.store.getSession(s.id)!.projectId)[0]!;
  const item = (id: number, category: typeof base.revision.category, text: string) => ({
    knowledge: { ...base.knowledge, id }, revision: { ...base.revision, id: id + 10, knowledgeId: id, category, text } });
  const low = item(1, "constraint", "unrelated required rule " + "word ".repeat(80));
  const high = item(2, "reference", "relevant optional rule " + "word ".repeat(80));
  const tie = item(3, "reference", high.revision.text);
  const values = [tie, high, low]; // relevance ties must not inherit reversed input order
  const required = new Set([low.revision.id]); // exact commit, deliberately NOT K id
  const priority = (a: typeof base, b: typeof base) => Number(b.knowledge.id !== 1) - Number(a.knowledge.id !== 1);
  const minimum = budgetKnowledge([low], Infinity).cost;
  const pair = budgetKnowledge([low, high], Infinity).cost;
  const select = (cap: number) => budgetKnowledge(values, cap, undefined, undefined, required, priority);
  const atFloor = select(minimum);
  expect(atFloor.commits).toEqual([11]);
  expect(atFloor.receipts).toEqual([]); // optional receipts cannot take required overflow
  expect(() => select(minimum - 1)).toThrow(/Knowledge capacity/);
  const atPair = select(pair);
  expect(atPair.commits).toEqual([11, 12]); // display/category order, not selection order
  expect(atPair.groups.find(g => g.category === "constraint")!.text).toBe(renderKnowledge(low));
  expect(atPair.groups.find(g => g.category === "reference")!.text).toBe(renderKnowledge(high));
  expect(select(pair - 1).commits).toEqual([11]); // incremental category framing is charged
  expect(pair).toBeGreaterThan(minimum + tokens(renderKnowledge(high)));
  for (let cap = minimum; cap <= pair + 80; cap++) {
    const selected = select(cap);
    expect(selected.commits).toContain(11);
    expect(selected.cost).toBeLessThanOrEqual(cap);
    const text = finish({ content: renderKnowledgeBlock(selected.groups), receipts: selected.receipts });
    expect(tokens(text)).toBeLessThanOrEqual(selected.cost);
    expect([...text.matchAll(/\[K\d+@(\d+)\]/g)].map(match => Number(match[1]))).toEqual(selected.commits);
    expect(select(cap)).toEqual(selected);
  }
  expect(select(pair + 80).receipts.length).toBeGreaterThan(0);
  expect(values.map(v => v.knowledge.id)).toEqual([3, 2, 1]); // no mutation of the caller's array
});

test("32de: required-only, priority-only and ordinary callers preserve their distinct selection contracts", () => {
  const { s } = seeded();
  const base = memory.store.listVisibleKnowledge(s.id, memory.store.getSession(s.id)!.projectId)[0]!;
  const values = [3, 2, 1].map(id => ({ knowledge: { ...base.knowledge, id },
    revision: { ...base.revision, id: id + 10, knowledgeId: id, text: "word ".repeat(100) } }));
  const cap = budgetKnowledge([values[0]!], Infinity).cost + 40;
  const priority = (a: typeof base, b: typeof base) => b.knowledge.id - a.knowledge.id;
  expect(budgetKnowledge(values, cap).commits).toEqual([11]);
  expect(budgetKnowledge(values, cap, undefined, undefined, new Set([13])).commits).toEqual([13]);
  expect(budgetKnowledge(values, cap, undefined, undefined, undefined, priority).commits).toEqual([13]);
  expect(budgetKnowledge(values, cap, undefined, undefined, new Set([11]), priority).commits).toEqual([11]);
});

test("32a: omitted inherited status names and stays inside the owning knowledge budget", () => {
  const budgeted = budgetMaterial({ knowledge: [], knowledgeNotes: ["word ".repeat(200)],
    knowledgeBudget: "consolidation.knowledgeTokens", current: "", framing: [], caps: { knowledge: 100, episodic: 100 } });
  expect(budgeted.knowledgeNotes).toEqual([]);
  expect(budgeted.receipts).toEqual(["omitted 1 inherited knowledge status lines; consolidation.knowledgeTokens is full"]);
  expect(charge(["Receipts:", ...budgeted.receipts])).toBeLessThanOrEqual(100);
});

/** Case 14. The Consolidator's processing target is the whole pending prefix, whether or not the
 * child can already read a fact; what is newly supplied is only the bodies it cannot. A fact address
 * is not a fact body, so the missing ones are injected whole, and this phase still receives no
 * automatic Raw block and no already-consolidated history block (25a). */
test("29e 2026-09-10 (case 14): a Consolidation fork's target is the union; only the missing fact bodies are injected", () => {
  const { s, t } = seeded();
  const note = (text: string) => memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text, source: [`T${t.id}#user`] }] });
  note("ALPHA the inherited claim");
  note("BETA the missing claim");
  const pending = memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id);
  expect(pending).toHaveLength(3); // `seeded`'s F1 (committed knowledge does not consolidate it) and the two above
  const frozen = freezeConsolidation(memory.store, { sessionId: s.id, branch: "main", mode: "fork", effectiveMode: "fork",
    visible: { raw: new Map(), factIds: new Set(pending.slice(0, 2)), knowledgeCommitIds: new Set(), injection: false, suppliedGeneration: 0 } }, memory.config);
  const prepared = frozen.prepared!;
  // The exact target is the union: both facts are integrated and both are addressed.
  expect(frozen.rangeFacts.map(f => f.id)).toEqual(pending);
  expect(prepared.material.factAddresses).toEqual(pending.map(id => `F${id}`));
  expect([prepared.range.from, prepared.range.to]).toEqual([`F${pending[0]}`, `F${pending.at(-1)}`]);
  // Only the missing one is a body, and it is the complete one — an address is not evidence.
  expect(prepared.supplied.factIds).toEqual([pending[2]!]);
  expect(prepared.text).toContain("BETA the missing claim");
  expect(prepared.text).not.toContain("ALPHA the inherited claim");
  // No automatic Raw, and no already-consolidated history block: F1 is neither supplied nor rendered.
  expect(prepared.supplied.entries).toEqual([]);
  expect(prepared.text).not.toContain(RAW_TITLE);
  expect(prepared.text).not.toContain(FACTS_TITLE);
  expect(prepared.text).not.toContain("Use pnpm");
  // A fresh child of the same freeze receives both bodies: the subtraction is the view's, not the task's.
  const fresh = freezeConsolidation(memory.store, { sessionId: s.id, branch: "main", mode: "subagent" }, memory.config);
  expect(fresh.rangeFacts.map(f => f.id)).toEqual(pending);
  expect(fresh.prepared!.supplied.factIds).toEqual(pending);
  expect(fresh.prepared!.text).toContain("ALPHA the inherited claim");
});
