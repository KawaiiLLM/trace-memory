// 20a: the byte-level layout of core's own domain text. Core owns the titles, the block order and
// the separators of every memory consumer (user ruling 2026-09-08, revising 19b's ban on
// core-composed domain text), so the pins that used to live on the Pi adapter's composition module
// (hosts/pi/compose.test.ts, deleted with hosts/pi/compose.ts) live here, in the ruled order.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, compacted, renderEntry, tokens, type ConfigOverride, type ConsolidationAgentInput, type NotingAgentInput, type RunAgentResult } from "../../test/source-fixture.ts";
import type { Fact } from "../model/index.ts";
import { charge } from "../render/index.ts";
import { budgetMaterial, knowledgeBlock as knowledgeBlockOf, BLOCK, FACTS_TITLE, RAW_TITLE } from "./material.ts";

let directory: string, memory: ReturnType<typeof TraceMemory>, calls: (NotingAgentInput | ConsolidationAgentInput)[];
const time = "2026-09-08T00:00:00Z";
const ok = (): RunAgentResult => ({ outcome: "success", output: "[]", request: { fake: true } });

function open(config: ConfigOverride = {}) {
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => { calls.push(raw as NotingAgentInput); return ok(); }, config);
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
  expect(tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"], because: ["F1"] }], skipped: [] })).toContain('"committed"');
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

test("20a 2026-09-08: the Noter's fresh order is knowledge, historical facts, range, the selected Raw, then receipts", async () => {
  const { s, t } = seeded();
  const raw = views(s.id, t.id);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const input = calls[0]! as NotingAgentInput;
  expect(input.text.fresh).toBe([knowledgeBlock, "Recent facts (newest first):", memory.trace("F1"),
    `Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`, "Raw:", raw].join("\n\n"));
});

test("20a 2026-09-08 for ruling 08:53: the Noter's inherited increment is the range, the head reply and the source index alone", async () => {
  const { s, t } = seeded();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" });
  const input = calls[0]! as NotingAgentInput;
  expect(input.text.inherited).toBe(`Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}\n\n[Source entry id: T${t.id}#assistant]\n好的。\n\nSources:\nT${t.id}#user 用 pnpm，不要 npm | T${t.id}#assistant 好的。 | T${t.id}#t1 tool=Bash {"command":"pnpm install"}`);
  // The raw turns, the delivered facts and the injected knowledge are already in that conversation.
  expect(input.text.inherited).not.toContain("Raw:");
  expect(input.text.inherited).not.toContain("<knowledge>");
  expect(input.text.inherited).not.toContain("Recent facts");
});

test("20a 2026-09-08: the Consolidator's fresh order is knowledge, already-consolidated facts, range, the pending facts, the reminders, then receipts", async () => {
  const { s, first } = consolidated();
  await first;
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "subagent" });
  const input = calls[1]! as ConsolidationAgentInput;
  expect(input.text.fresh).toBe([knowledgeBlock, "Already-consolidated facts (newest first):", memory.trace("F1"),
    "Range: F2..F2", "Range facts:", memory.trace("F2"),
    "Negated-evidence reminder (review cues only; no status derived):", "none"].join("\n\n"));
});

test("20a 2026-09-08 for ruling 08:53: the Consolidator's inherited increment is the range, the exact fact list and the review cues alone", async () => {
  const { s, first } = consolidated();
  await first;
  await memory.consolidate({ sessionId: s.id, branch: "main", mode: "fork" });
  const input = calls[1]! as ConsolidationAgentInput;
  expect(input.text.inherited).toBe("Range: F2..F2\n\nFacts to integrate: F2\n\nNegated-evidence reminder (review cues only; no status derived):\nnone");
  expect(input.text.inherited).not.toContain("Range facts:");
  expect(input.text.inherited).not.toContain("<knowledge>");
});

test("20a 2026-09-08: the main agent's initial injection is knowledge and receipts only, and compact is knowledge, historical facts, pending Raw, receipts", async () => {
  const { s, t } = seeded();
  expect(memory.inject(s.id)).toBe(knowledgeBlock); // knowledge-only: no facts, no Raw, no range
  expect(compacted(memory.compact(s.id, "main", t.id))).toBe([knowledgeBlock,
    `<episodic>\nRecent facts (newest first):\n\n${memory.trace("F1")}\n\nRaw:\n\n${views(s.id, t.id)}\n</episodic>`].join("\n\n"));
});

test("20a 2026-09-08 scenario 2: two Noter tasks with the same knowledge and different Raw and ranges are byte-identical through the knowledge block", async () => {
  const { s, t } = seeded();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const second = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "再来一次", assistantText: "好。", startedAt: "2026-09-09T00:00:00Z" });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: second.id, mode: "subagent" });
  const [first, later] = calls as NotingAgentInput[];
  // A byte-layout test, not a provider-cache test: identical selected knowledge renders identically
  // when only the task range and the Raw change.
  expect(later!.text.fresh.startsWith(knowledgeBlock)).toBe(true);
  expect(first!.text.fresh.startsWith(knowledgeBlock)).toBe(true);
  expect(later!.range).not.toEqual(first!.range);
  expect(later!.material.entries).not.toEqual(first!.material.entries);
  // Facts precede the range; the range precedes the Raw of this batch.
  const order = ["Recent facts (newest first):", `Range: `, "Raw:"].map(part => later!.text.fresh.indexOf(part));
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(order[0]).toBeGreaterThan(knowledgeBlock.length - 1);
  // Nothing task-specific is inside the leading block.
  expect(knowledgeBlock).not.toContain("Range: ");
  for (const id of later!.material.entries.map(e => `entry ${e.id}`)) expect(knowledgeBlock).not.toContain(id);
});

test("20a 2026-09-08 scenario 2: budget receipts follow the dynamic material in both phases", async () => {
  const { s, t } = seeded();
  const raw = views(s.id, t.id);
  // A knowledge cap that holds the bounded omission receipt but not the one item: both phases then
  // carry that receipt. (Receipts no longer come from an episodic overage — since the review of
  // 2026-09-08 a budget the mandatory material cannot fit reduces or holds the task instead.)
  const receipt = "omitted 1 constraint knowledge; expand: K1";
  memory.config.render.knowledgeBlockTokens = tokens(receipt) + 1;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const noting = calls[0]! as NotingAgentInput;
  expect(noting.material.knowledge).toEqual([]);
  expect(noting.material.receipts).toEqual([receipt]);
  expect(noting.text.fresh.endsWith(`Raw:\n\n${raw}\n\nReceipts:\n${receipt}`)).toBe(true);
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
  const facts = [{ id: 9 } as Fact];
  const budget = (caps: { episodic: number; current?: number }) => budgetMaterial({ knowledge: [], current: view,
    framing, range, facts, factLine: () => line, caps: { knowledge: 1_000, current: caps.current ?? 1_000, episodic: caps.episodic } });
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
  expect(smallest).toBe(mandatory + charge([line])); // exactly at the budget, the fact is kept
  expect(budget({ episodic: smallest }).facts).toEqual([line]);
  expect(budget({ episodic: smallest }).receipts).toEqual([]);
  expect(budget({ episodic: smallest - 1 }).facts).toEqual([]); // one token under, it is omitted
  expect(budget({ episodic: smallest - 1 }).receipts).toContain("omitted 1 older facts; expand: F9");
  // Whatever the budget, everything emitted fits inside it — the retained facts and the receipts that
  // report the omitted ones. Only mandatory evidence may exceed it, and then it is receipted.
  const three = (episodic: number) => budgetMaterial({ knowledge: [], current: view, framing, range,
    facts: [9, 10, 11].map(id => ({ id }) as Fact), factLine: () => line, caps: { knowledge: 1_000, current: 1_000, episodic } });
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
  const many = Array.from({ length: 200 }, (_, i) => ({ id: i + 1 }) as Fact);
  const bounded = budgetMaterial({ knowledge: [], current: view, framing, range, facts: many, factLine: () => line,
    caps: { knowledge: 1_000, current: 1_000, episodic: mandatory + 60 } });
  expect(bounded.receipts).toEqual(["omitted 200 older facts; expand: F1, F2, F3, F4, F5, F6, F7, F8 and 192 more up to F200"]);
  expect(tokens(bounded.receipts.join("\n"))).toBeLessThan(60);
});

/** The same scenario end to end, at the ruled defaults: a task with more knowledge, more facts and
 * more Raw than any budget holds still sends a knowledge block within 10,000, a Raw block within
 * 10,000, and fresh material within the 30,000 total. */
test("20b 2026-09-08 scenario 3: at the default limits no consumer's block overflows its cap or the 30,000-token total", async () => {
  const { s, t } = seeded();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  for (let i = 0; i < 12; i++) tools.find(tool => tool.name === "note")!.execute({ facts: Array.from({ length: 20 }, (_, k) =>
    ({ category: "observation", actor: "user", text: `claim ${i}.${k} ` + "word ".repeat(40), source: [`T${t.id}#user`] })) });
  for (let i = 0; i < 30; i++) tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create",
    text: `rule ${i} ` + "word ".repeat(500), category: i % 2 ? "constraint" : "mechanism", scope: "project", supports: ["F1"], because: ["F1"] }], skipped: [] });
  for (let i = 0; i < 6; i++) memory.appendEntry({ sessionId: s.id, nativeLineage: "big", nativeId: `b${i}`, turnId: t.id,
    role: "assistant", text: `entry ${i} ` + "word ".repeat(3000), raw: "", calls: [] });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const material = calls.at(-1)!.material as NotingAgentInput["material"];
  const receipts = (kind: "knowledge" | "facts") => material.receipts.filter(r => r.includes(" knowledge; expand: ") === (kind === "knowledge"));
  expect(material.receipts.some(r => r.includes(" knowledge; expand: "))).toBe(true); // the caps really bind
  expect(tokens(knowledgeBlockOf(material)) + charge(receipts("knowledge"))).toBeLessThanOrEqual(memory.config.render.knowledgeBlockTokens);
  expect(tokens(material.entries.map(e => e.view).join(BLOCK))).toBeLessThanOrEqual(memory.config.noting.batchTokens);
  expect(charge([FACTS_TITLE, RAW_TITLE, `Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`, ...material.facts, ...receipts("facts")])
    + tokens(material.entries.map(e => e.view).join(BLOCK))).toBeLessThanOrEqual(memory.config.render.episodicBlockTokens);
  expect(tokens(calls.at(-1)!.text.fresh)).toBeLessThanOrEqual(30_000);
});
