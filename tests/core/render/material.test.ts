// 20a: the byte-level layout of core's own domain text. Core owns the titles, the block order and
// the separators of every memory consumer (user ruling 2026-09-08, revising 19b's ban on
// core-composed domain text), so the pins that used to live on the Pi adapter's composition module
// (hosts/pi/compose.test.ts, deleted with hosts/pi/compose.ts) live here, in the ruled order.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, compacted, renderEntry, tokens, type ConfigOverride, type NotingAgentInput, type RunAgentResult , hydrate } from "../../source-fixture.ts";
import type { Fact } from "../../../src/core/model/index.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";
import { KNOWLEDGE_RECENCY_NOTICE, sessionKnowledgeNotice, budgetFacts, budgetKnowledge, charge, finish, renderFact, renderFactGroups, renderKnowledge, renderKnowledgeBlock, wholeKnowledge, xmlBlock } from "../../../src/core/render/index.ts";
import { budgetMaterial, compactText, rawWindowTokens, injectionText, knowledgeBlock as knowledgeBlockOf, BLOCK, FACTS_TITLE, KNOWLEDGE_STATUS_TITLE, RAW_TITLE } from "../../../src/core/render/material.ts";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";
import { curateWrite } from "../../support/dreamer.ts";
import { fact as seedFact, facts as seedFacts, knowledge as seedKnowledge, legacyFacts, receiptCommit, scoreAll } from "../../support/seed.ts";
import { memoryFiles } from "../../../src/core/api/files.ts";
import { readingGuide } from "../../../src/core/render/reading-guide.ts";
import { canonicalToolNames, validateToolNames } from "../../../src/core/prompts/tool-names.ts";
import { ccPluginToolNames, ccWorkerToolNames } from "../../../src/hosts/cc/tool-names.ts";
import { submitEmpty, verifyUnchanged } from "../../support/noter.ts";

test("the reading guide names only available native tools within its framing ceiling", () => {
  const pi = readingGuide(Number.MAX_SAFE_INTEGER, validateToolNames(canonicalToolNames));
  expect(pi.split("\n")[0]).toContain("with read or grep, never a shell command.");
  expect(tokens(pi)).toBeLessThanOrEqual(200);
  for (const names of [ccPluginToolNames, ccWorkerToolNames]) {
    const cc = readingGuide(Number.MAX_SAFE_INTEGER, validateToolNames(names));
    expect(cc.split("\n")[0]).toContain("with Read, never a shell command.");
    expect(cc).not.toMatch(/grep/i);
    expect(tokens(cc)).toBeLessThanOrEqual(200);
  }
});

let directory: string, memory: ReturnType<typeof sourceSeededMemory>, calls: NotingAgentInput[];
const time = "2026-09-08T00:00:00Z";
const tag = (knowledgeId: number, commit: number) => `K${knowledgeId}#${memory.store.versionTag(knowledgeId, commit)}`;

/** Core ends the Noter\u2019s material with this line, so both tasks of a run begin with the same request. */
const CHECK_FIRST = "\n\nCall check first: it names your task and your two files.";
const ok = (): RunAgentResult => ({ outcome: "success", output: "[]", request: { fake: true } });

/** These cases size items in thousands of tokens, as items written before the caps are (ticket 144); the caps are lifted here, not in each case. */
const uncapped: ConfigOverride = { writing: { bodyTokens: 1_000_000 } };
function open(config: ConfigOverride = uncapped) {
  // The default stand-in writes no files, so each run fails its check and leaves its batch pending for the next call.
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
  const path = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const user = hydrate(memory.store.listSourceEntries(s.id, t.id), memory.store).find(e => e.role === "user")!;
  expect(seedFact(memory, path, "Package manager decision", [{ entry: user, text: "Use pnpm" }]).id).toBe(1);
  expect(seedKnowledge(memory.store, path, "project", "constraint", [1], "The project uses pnpm",
    { run: { kind: "manual", createdAt: time }, operation: { createdAt: time, topics: [], title: "Package manager" } }).knowledgeId).toBe(1);
  scoreAll(memory.store); // the Knowledge base carries scored items; unscored ones ride the temporary allowance (144 §7)
  // 118: identity framing stays in the block; the complete injection carries one guide.
  knowledgeBlock = `<knowledge>\n${sessionKnowledgeNotice(s.id)}\n## constraint (1)\n[K1#${memory.store.versionTag(1, 1)}] [constraint/project] Package manager\nThe project uses pnpm\n  change supports: F1\n</knowledge>`;
  return { s, t, user, read: (address: string) => memoryFiles(memory, path).read(`trace://${address}`).content };
}
let knowledgeBlock: string;
/** Fresh N alone shows the body's cap-check token count after the category tag. */
const withSize = (block: string) => block.replace("[constraint/project] Package manager", `[constraint/project] (${tokens("The project uses pnpm")}/${memory.config.writing.bodyTokens} tokens) Package manager`);
const views = (sessionId: number, head: number) =>
  hydrate(memory.pendingEntries(sessionId, "main", head), memory.store).map(e => renderEntry(e, memory.config.render).content).join("\n\n");

/** A Dreamer's pass: one operation on the item `address` names (`K<id>#<tag>`), applied as a curate file. */
async function maintain(path: { sessionId: number; branch: string; headTurnId: number }, operation: Record<string, unknown>, address: string) {
  const selectedEntries = hydrate(memory.store.sourcePath(path.sessionId, path.branch, path.headTurnId), memory.store);
  memory.selectEntries(path.sessionId, path.branch, selectedEntries.map(entry => entry.id));
  const target = { ...path, triggerEntryId: selectedEntries.at(-1)!.id };
  const [, id, versionTag] = /^K(\d+)#([a-z]+)$/.exec(address)!;
  const knowledgeId = Number(id), baseCommit = memory.store.resolveVersionTag(knowledgeId, versionTag!);
  const supports = ((operation.supports as string[] | undefined) ?? []).map(value => Number(value.slice(1)));
  return curateWrite(memory, target, [operation.op === "archive"
    ? { op: "archive", kind: "invalid", knowledgeId, baseCommit, supports, reason: String(operation.reason), createdAt: time,
        text: "The user withdrew this and nothing replaces it; the grounds are in the cited evidence." }
    : { op: "update", knowledgeId, baseCommit, text: String(operation.text), category: operation.category as "constraint", scope: operation.scope as "project",
        topics: operation.topics as string[], supports, reason: String(operation.reason), createdAt: time }]);
}

test("92: fresh N names its target and range, then shares compact Knowledge, facts and Raw layout", async () => {
  const { s, t } = seeded();
  const raw = views(s.id, t.id);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const input = calls[0]! as NotingAgentInput;
  expect(input.material.harness).toBe("fake");
  expect(input.text).toContain(`Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`);
  expect(input.material.facts).toHaveLength(1);
  expect(input.material.facts[0]).toContain("[F1] Package manager decision");
  expect(input.material.entries.map(entry => entry.id)).toEqual(input.entryIds);
  expect(input.text).toContain(raw);
  expect(knowledgeBlockOf(input.material)).toBe(withSize(knowledgeBlock));
  expect(input.supplied.knowledgeCommitIds).toEqual([1]);
  expect(memory.inject(s.id)).toBe(`${readingGuide(s.id, canonicalToolNames)}\n\n${knowledgeBlock}`);
  expect(input).not.toHaveProperty("readKnowledgeCommits");
});

// 92 “C删掉” retires the C-only fresh Range-facts layout and C factAddresses tests.
// Shared text layout remains pinned above; exact N membership remains in case 12 below.

test("20a 2026-09-08: the main agent's initial injection is knowledge and receipts only, and compact is knowledge, historical facts, pending Raw, receipts", async () => {
  const { s, t } = seeded();
  const injection = `${readingGuide(s.id, canonicalToolNames)}\n\n${knowledgeBlock}`;
  expect(memory.inject(s.id)).toBe(injection); // knowledge-only: no facts, no Raw, no range
  const compact = compacted(memory.compact(s.id, "main", t.id));
  expect(compact.startsWith(injection)).toBe(true);
  expect(compact).toContain("[F1] Package manager decision");
  expect(compact).toContain(views(s.id, t.id));
});

test("20a/92: N tasks with different Raw and facts retain byte-identical Knowledge blocks", () => {
  const { s, t, user } = seeded();
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const earlier = freezeNoting(memory.store, target, memory.config);
  seedFact(memory, { sessionId: s.id, branch: "main", headTurnId: t.id }, "Package manager follow-up", [{ entry: user, text: "Still pnpm" }]);
  memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeLineage: "next", nativeId: "next", role: "user", text: "Next task", raw: "", calls: [] });
  const later = freezeNoting(memory.store, target, memory.config);
  expect(earlier.entries.map(entry => entry.id)).not.toEqual(later.entries.map(entry => entry.id));
  expect(earlier.prepared!.supplied.factIds).not.toEqual(later.prepared!.supplied.factIds);
  expect(knowledgeBlockOf(earlier.prepared!.material)).toBe(withSize(knowledgeBlock));
  expect(knowledgeBlockOf(later.prepared!.material)).toBe(withSize(knowledgeBlock));
  const text = later.prepared!.text;
  expect(text.indexOf("Range: ")).toBeLessThan(text.indexOf("<knowledge>"));
  expect(text.indexOf("</knowledge>")).toBeLessThan(text.indexOf(FACTS_TITLE));
  expect(text.indexOf(FACTS_TITLE)).toBeLessThan(text.indexOf(RAW_TITLE));
  expect(knowledgeBlock).not.toContain("Range: ");
  expect(knowledgeBlock).not.toContain("Still pnpm");
  expect(text).not.toContain("Negated-evidence reminder");
});

test("20a/92: N facts and Knowledge budget receipts follow the dynamic material", async () => {
  const { s, t, user } = seeded();
  const raw = views(s.id, t.id);
  memory.config.compaction.temporaryTokens = 1; // isolate full-fact receipts from the new title index
  // Facts have an independent window; its omission receipt follows the complete Raw block.
  const factReceipt = "omitted 1 older facts; expand: trace://F1";
  memory.config.compaction.factsTokens = charge([factReceipt]) + charge(["Receipts:"]);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const noting = calls[0]! as NotingAgentInput;
  expect(knowledgeBlockOf(noting.material)).toBe(withSize(knowledgeBlock));
  expect(noting.material.facts).toEqual([]);
  expect(noting.material.receipts).toEqual([factReceipt]);
  expect(noting.text.endsWith(`Raw:\n\n${raw}\n</episodic>\n\nReceipts:\n${factReceipt}${CHECK_FIRST}`)).toBe(true);
  memory.config.compaction.factsTokens = 10_000;
  // A legal oversized manual item pressures the same Knowledge selector used by N.
  const receipt = "omitted 2 constraint knowledge; expand: trace://K2, trace://K1";
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  tools.find(tool => tool.name === "memory")!.execute({ op: "create", title: "Fixture title", topics: [],
    reason: "Exercise a database-derived omission boundary.", text: "The project uses pnpm " + "word ".repeat(5_200),
    category: "constraint", scope: "project", supports: ["F1"] });
  scoreAll(memory.store);
  setKnowledgeCapacity(memory, 5_000);
  seedFact(memory, { sessionId: s.id, branch: "main", headTurnId: t.id }, "Package manager retained", [{ entry: user, text: "Keep pnpm" }]);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const next = calls.at(-1)!;
  expect(next.material.receipts).toEqual([receipt]);
  expect(next.text.endsWith(`Receipts:\n${receipt}${CHECK_FIRST}`)).toBe(true);
  expect(next.text).not.toContain("Negated-evidence reminder");
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
  expect(budget({ episodic: smallest - 1 }).receipts).toContain("omitted 1 older facts; expand: trace://F9");
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
  const omission = "omitted 200 older facts; expand: trace://F1, trace://F2, trace://F3, trace://F4, trace://F5, trace://F6, trace://F7, trace://F8 and 192 more up to trace://F200";
  // 118 paths make the receipt longer; the exact emitted receipt and its heading still fit.
  const receiptBudget = charge([omission]) + charge(["Receipts:"]);
  const boundedAt = (room: number) => budgetMaterial({ knowledge: [], current: view, framing, range, facts: many, factLine: () => line, factTurns,
    caps: { knowledge: 1_000, current: 1_000, episodic: mandatory + room } });
  const bounded = boundedAt(receiptBudget);
  expect(bounded.receipts).toEqual([omission]);
  expect(omission.match(/trace:\/\/F\d+/g)).toHaveLength(9); // Eight paths plus the final endpoint, not 200.
  expect(bounded.over.episodic).toBe(0);
  expect(boundedAt(receiptBudget - 1).over.episodic).toBe(1);
});

/** The same scenario end to end, at the ruled defaults: a task with more knowledge, more facts and
 * more Raw than any budget holds still sends each block within its own 10,000-token allowance. */
function overloaded() {
  const { s, t, user } = seeded();
  const path = { sessionId: s.id, branch: "main", headTurnId: t.id };
  for (let i = 0; i < 12; i++) seedFacts(memory, path, Array.from({ length: 20 }, (_, k) => ({
    title: `claim ${i}.${k}`, sources: [{ entry: user, text: `claim ${i}.${k} ` + "word ".repeat(40) }],
  })));
  for (let i = 0; i < 30; i++) seedKnowledge(memory.store, path, "project", i % 2 ? "constraint" : "understanding", [1],
    `rule ${i} ` + "word ".repeat(500), { run: { kind: "manual", createdAt: time }, operation: { createdAt: time, topics: [] } });
  for (let i = 0; i < 6; i++) memory.appendEntry({ sessionId: s.id, nativeLineage: "big", nativeId: `b${i}`, turnId: t.id,
    role: "assistant", text: `entry ${i} ` + "word ".repeat(3000), raw: "", calls: [] });
  scoreAll(memory.store);
  return { s, t };
}

test("25a/92: default N material has independent 10k facts and Raw windows plus Knowledge within K", async () => {
  const { s, t } = overloaded();
  memory.config.compaction.temporaryTokens = 1;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const material = calls.at(-1)!.material as NotingAgentInput["material"];
  const factReceipts = material.receipts.filter(r => r.includes(" older facts; expand: "));
  expect(factReceipts).toHaveLength(1); // the history cap really binds
  expect(material.receipts.some(r => r.includes(" knowledge; expand: "))).toBe(false); // the default K fits this fixture
  expect(knowledgeBlockOf(material)).toContain("<knowledge>");
  expect(tokens(knowledgeBlockOf(material))).toBeLessThanOrEqual(memory.knowledgeBudgets().injection + memory.config.compaction.temporaryTokens);
  const historyCap = memory.config.compaction.factsTokens;
  expect(historyCap).toBe(10_000);
  expect(tokens(compactText({ facts: material.facts, receipts: factReceipts }))).toBeLessThanOrEqual(historyCap);
  const rawReceipts = material.receipts.filter(receipt => !factReceipts.includes(receipt));
  expect(rawWindowTokens(material.entries.map(e => e.view), rawReceipts)).toBeLessThanOrEqual(memory.config.noting.batchTokens);
  expect(material.entries.map(entry => entry.id)).toEqual(calls.at(-1)!.entryIds);
});

test("45/92: N sends Knowledge within the database-derived cap without borrowing from facts or Raw", async () => {
  const { s, t } = overloaded();
  memory.config.compaction.temporaryTokens = 1;
  const knowledge = memory.store.currentKnowledge({ sessionId: s.id, branch: "main", headTurnId: t.id });
  // Leave room for omission receipts but less than another whole item; the receipt must actually emit.
  const cap = wholeKnowledge(knowledge.slice(-15), value => renderKnowledge(value, tag(value.knowledge.id, value.revision.id), true)).cost + 200;
  expect(cap).toBeLessThan(10_000);
  setKnowledgeCapacity(memory, cap);
  const pending = memory.store.pendingEntryIds(s.id, "main", t.id);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const input = calls.at(-1)!;
  const material = input.material;
  const knowledgeReceipts = material.receipts.filter(r => r.includes(" knowledge; expand: "));
  expect(knowledgeReceipts.length).toBeGreaterThan(0); // the knowledge cap really binds
  expect(tokens(injectionText({ knowledge: material.knowledge, receipts: knowledgeReceipts }))).toBeLessThanOrEqual(cap);
  const factReceipts = material.receipts.filter(receipt => receipt.includes(" older facts; expand: "));
  expect(factReceipts.length).toBeGreaterThan(0);
  expect(tokens(compactText({ facts: material.facts, receipts: factReceipts }))).toBeLessThanOrEqual(10_000);
  expect(input.text).not.toContain("Already-consolidated");
  expect(input.entryIds.length).toBeLessThan(pending.length);
  expect(memory.store.pendingEntryIds(s.id, "main", t.id)).toEqual(pending); // capture-only run publishes neither layer
});

// ---- 21b 2026-09-08: the labels ride the one shared knowledge renderer, inside ticket 20's cap ----

test("21b/92: foreground, compact and N render topics through one renderer, with a multi-topic item once", async () => {
  const { s, t, read } = seeded();
  read("K1@v1");
  const changed = (await maintain({ sessionId: s.id, branch: "main", headTurnId: t.id }, { op: "update", id: tag(1, 1),
    topics: ["packaging", "storage"], reason: "Classification cleanup: two subjects.", text: "The project uses pnpm",
    category: "constraint", scope: "project", supports: ["F1"] }, tag(1, 1)))[0]!;
  const labelled = `<knowledge>\n${sessionKnowledgeNotice(s.id)}\n## constraint (1)\n[${tag(1, changed.commit)}] [constraint/project] Package manager\nThe project uses pnpm\n  change supports: F1 · topics: ["packaging","storage"]\n</knowledge>`;
  const injection = `${readingGuide(s.id, canonicalToolNames)}\n\n${labelled}`;
  expect(memory.inject(s.id)).toBe(injection);
  expect(compacted(memory.compact(s.id, "main", t.id)).startsWith(injection)).toBe(true);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const noting = calls.at(-1)!;
  expect(knowledgeBlockOf(noting.material)).toBe(withSize(labelled));
  // Two subjects, one body in every consumer, not a duplicated line per topic.
  for (const text of [memory.inject(s.id), compacted(memory.compact(s.id, "main", t.id)), noting.text])
    expect(text.match(new RegExp(`\\[${tag(1, changed.commit)}\\]`, "g"))).toHaveLength(1);
});

test("21b 2026-09-08: rendered labels are charged to the knowledge cap, and the leading block stays byte-identical across tasks", async () => {
  const { s, t, read } = seeded();
  read("K1@v1");
  const changed = (await maintain({ sessionId: s.id, branch: "main", headTurnId: t.id }, { op: "update", id: tag(1, 1),
    topics: ["packaging", "storage"], reason: "Classification cleanup: two subjects.", text: "The project uses pnpm " + "word ".repeat(900),
    category: "constraint", scope: "project", supports: ["F1"] }, tag(1, 1)))[0]!;
  const value = memory.store.listVisibleKnowledge(s.id, memory.store.getSession(s.id)!.projectId)[0]!;
  const bare = { ...value, revision: { ...value.revision, topics: [] } };
  // The smallest cap that still keeps this one item whole; below the receipt's own cost the budget
  // reports a capacity error instead, which is not "kept" either.
  const fits = (item: typeof value, cap: number) => { try { return budgetKnowledge([item], cap).groups.some(g => g.text); } catch { return false; } };
  const minimum = (item: typeof value) => {
    let low = 0, high = 20_000;
    while (low + 1 < high) { const middle = Math.floor((low + high) / 2); if (fits(item, middle)) high = middle; else low = middle; }
    return high;
  };
  // 20b charges every rendered line: the labelled revision needs a strictly larger cap than the same
  // revision without them, so labels cannot ride along outside the budget.
  expect(minimum(value)).toBeGreaterThan(minimum(bare));
  const fullInjection = memory.inject(s.id);
  const guidePrefix = `${readingGuide(s.id, canonicalToolNames)}\n\n`;
  expect(fullInjection.startsWith(guidePrefix)).toBe(true);
  const exactForeground = tokens(fullInjection.slice(guidePrefix.length));
  setKnowledgeCapacity(memory, exactForeground);
  expect(memory.inject(s.id)).toContain(`[${tag(1, changed.commit)}]`);
  // Pool budgets trigger maintenance; they do not reject a policy change. Foreground selection
  // omits a whole body that no longer fits without removing it from storage or dropping its topics.
  setKnowledgeCapacity(memory, exactForeground - 1);
  memory.config.compaction.temporaryTokens = 0; // with a temporary allowance the misfit would show as a title
  expect(memory.inject(s.id)).not.toContain(`[${tag(1, changed.commit)}]`);
  expect(memory.store.knowledgeRevision(changed.commit)!.topics).toEqual(["packaging", "storage"]);
  // Restore enough room for the subject and the explicitly accounted worker trigger.
  setKnowledgeCapacity(memory, 12_000);
  // Identical selected revisions and topics retain their bytes when N's preceding facts change.
  const user = hydrate(memory.store.listSourceEntries(s.id, t.id), memory.store).find(e => e.role === "user")!;
  const note = (text: string) => seedFact(memory, { sessionId: s.id, branch: "main", headTurnId: t.id },
    "Package manager evidence", [{ entry: user, text }]);
  note("Keep pnpm");
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  note("Still pnpm");
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const [first, later] = calls;
  expect(later!.supplied.factIds).not.toEqual(first!.supplied.factIds);
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
  const { s, t, user } = seeded();
  memory.config.compaction.temporaryTokens = 1;
  for (let i = 0; i < 8; i++) seedFact(memory, { sessionId: s.id, branch: "main", headTurnId: t.id },
    `History ${i}`, [{ entry: user, text: `history ${i} ` + "word ".repeat(120) }]);
  // Independent facts cap: a small Raw batch cannot enlarge it.
  const room = 400;
  memory.config.compaction.factsTokens = room;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  const material = calls.at(-1)!.material as NotingAgentInput["material"];
  const raw = tokens(material.entries.map(e => e.view).join(BLOCK));
  expect(raw).toBeLessThan(memory.config.noting.batchTokens / 10); // the batch nowhere near its ceiling
  expect(tokens(compactText({ facts: material.facts, receipts: material.receipts }))).toBeLessThanOrEqual(room);
  expect(material.facts.length).toBeGreaterThan(0);
  expect(material.receipts.some(r => r.includes(" older facts; expand: "))).toBe(true); // the rest is named, not hidden
});

/** Ticket 25 "One full-fact renderer": for one selected fact set and annotation snapshot, the
 * foreground `<noted>` receipt and the Noter subagent's history block are the same bytes. Only the
 * enclosing title differs.
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
  const path = { sessionId: s.id, branch: "main", headTurnId: second.id };
  const entries = hydrate(memory.store.listSourceEntries(s.id), memory.store);
  const firstUser = entries.find(e => e.turnId === first.id && e.role === "user")!;
  const secondUser = entries.find(e => e.turnId === second.id && e.role === "user")!;
  const secondAssistant = entries.find(e => e.turnId === second.id && e.role === "assistant")!;
  legacyFacts(memory.store, { kind: "noting", sessionId: s.id, branch: path.branch, createdAt: later }, [
    { sources: [{ entry: secondUser, address: `T${second.id}#user` }], text: "late claim", category: "observation", actor: "user", createdAt: later },
    { sources: [{ entry: firstUser, address: `T${first.id}#user` }], text: "early claim", category: "observation", actor: "user", createdAt: time },
    { sources: [{ entry: firstUser, address: `T${first.id}#user` },
      { entry: secondAssistant, address: `T${second.id}#assistant` }], text: "multi-source claim", category: "observation", actor: "user", createdAt: time },
  ]);
  const carry = memory.branchSummary(s.id, "main", second.id);
  // A later Noting task whose history is exactly that same selected set and annotation snapshot.
  memory.appendEntry({ sessionId: s.id, nativeLineage: "shared", nativeId: "e1", turnId: second.id, role: "assistant", text: "still here", raw: "", calls: [] });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: second.id });
  const history = (calls.at(-1)! as NotingAgentInput).material.facts;
  expect(history.length).toBe(memory.store.listSessionFacts(s.id).length); // the same selected set
  expect(carry).toContain(`Facts:\n${history.join("\n")}\nCommits`);
});

// ---- 29b 2026-09-10: one material builder, two initial states (parent 29, cases 10, 12, 13, 15) ----

/** `count` extra facts on the seeded Turn, oldest first, each long enough to be worth budgeting. */
function history(sessionId: number, turnId: number, count: number) {
  const user = hydrate(memory.store.listSourceEntries(sessionId, turnId), memory.store).find(e => e.role === "user")!;
  for (let i = 0; i < count; i++) seedFact(memory, { sessionId, branch: "main", headTurnId: turnId },
    `Older claim ${i}`, [{ entry: user, text: `Older claim ${i} ` + "detail ".repeat(20) }]);
}

/** Case 10. The allowance is set to hold exactly three fact lines. With the newest facts visible, the
 * three the child cannot see fill it — a budget applied first and visibility subtracted afterwards
 * would leave one. Filtering first is also never filling: fewer needed facts make a smaller block. */
test("29b/92: compact filters retained facts before budgeting", async () => {
  const { s, t } = seeded();
  history(s.id, t.id, 5); // F2..F6 beside the seeded F1
  const facts = memory.store.listSessionFacts(s.id);
  const line = (fact: Fact) => renderFact(fact, memory.store.listFactRelations(fact.id));
  const turns = memory.store.factTurnTimes(facts);
  // An allowance around three fact lines, so the block is really bound by it.
  const room = charge([xmlBlock("episodic", ""), FACTS_TITLE])
    + charge(renderFactGroups(facts.slice(-3), line, turns))
    + charge(["Receipts:", "omitted 3 older facts; expand: trace://F3, trace://F2, trace://F1"]);
  memory.config.compaction.factsTokens = room;
  memory.config.compaction.rawTokens = 0;
  const supplied = (factIds: number[]) => {
    const compact = memory.compact(s.id, "main", t.id, { ...noVisibility(), factIds: new Set(factIds) });
    if ("native" in compact) throw new Error(compact.reason);
    return compact.material!.facts!;
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

/** Case 13. The empty initial state is not a special path: it produces the whole selected target and
 * the bounded optional material for both phases, and the run sends that text once. */
test("29b/92 (case 13): fresh N receives one full material dispatch across its two tool rounds", async () => {
  const { s, t } = seeded();
  calls.length = 0;
  let rounds = 0;
  const worker = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    if (input.task === "verify") return verifyUnchanged(input, { request: { fake: true } });
    calls.push(input);
    if (input.kind === "noting") {
      // Two tool rounds inside one run: the child keeps its own messages and nothing is resent.
      memoryFiles(worker, input.reader!).read(`trace://raw/S${s.id}/T${t.id}#E1@user`); rounds++;
      submitEmpty(input); rounds++;
    }
    return { outcome: "success", output: "", request: { fake: true } };
  });
  try {
    await worker.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
    const noting = calls[0]! as NotingAgentInput;
    expect(noting.material.entries.map(e => e.id)).toEqual(noting.entryIds); // the whole selected target
    expect(noting.text).toContain("Raw:");
    expect(noting.supplied.entries.map(e => e.id)).toEqual(noting.entryIds);
    expect(rounds).toBe(2);
    expect(calls).toHaveLength(1); // one prepared material, one dispatch: the second round adds nothing
    expect(noting.text).toContain("<knowledge>");
    expect(noting.supplied.factIds.length).toBeGreaterThan(0);
    expect(noting.supplied.knowledgeCommitIds).toEqual([1]);
    expect(worker.store.listRuns(s.id).filter(run => run.kind === "consolidation")).toEqual([]);
  } finally { worker.close(); }
});

/** Case 15. Knowledge is compared by exact commit: an unchanged visible commit is omitted, a visible
 * predecessor covers nothing, and what happened to a stale inherited commit is said inside the same
 * knowledge allowance rather than in an unbounded block of its own. */
test("29b/92: foreground Knowledge is an exact-version delta with stale state notices inside its allowance", async () => {
  const { s, t } = seeded();
  const files = memoryFiles(memory, { sessionId: s.id, branch: "main", headTurnId: t.id });
  files.read("trace://K1@v1");
  const changed = (await maintain({ sessionId: s.id, branch: "main", headTurnId: t.id }, { op: "update", id: tag(1, 1),
    topics: [], reason: "The rule was restated.", text: "The project uses pnpm only", category: "constraint", scope: "project", supports: ["F1"] }, tag(1, 1)))[0]!;
  seedFact(memory, { sessionId: s.id, branch: "main", headTurnId: t.id }, "Package manager retained",
    [{ entry: hydrate(memory.store.listSourceEntries(s.id, t.id), memory.store).find(e => e.role === "user")!, text: "Keep pnpm" }]);
  const current = memory.store.listVisibleKnowledge(s.id, memory.store.getSession(s.id)!.projectId)[0]!.revision.id;
  expect(current).toBe(changed.commit);

  // Knowledge publication belongs to the foreground, not to the retired C fork.
  const delivery = (commits: number[]) => memory.injection({ sessionId: s.id, branch: "main", headTurnId: t.id },
    { ...noVisibility(), knowledgeCommitIds: new Set(commits), knowledgeTokens: 0 });
  scoreAll(memory.store);
  const stale = delivery([1]);
  expect(stale.text).toContain(`[${tag(1, current)}]`);
  expect(stale.text).toContain("K1@v1 is superseded by K1@v2");
  expect(stale.text).toContain("Inherited knowledge status");
  expect(stale.knowledgeCommitIds).toEqual([current]);
  const unchanged = delivery([current]);
  expect(unchanged.text).toBe("");
  expect(unchanged.knowledgeCommitIds).toEqual([]);
  files.read(`trace://${tag(1, current)}`);
  await maintain({ sessionId: s.id, branch: "main", headTurnId: t.id }, { op: "archive", kind: "invalid", text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", id: tag(1, current),
    reason: "Withdrawn by the user.", supports: ["F1"] }, tag(1, current));
  setKnowledgeCapacity(memory, 5_000);
  const squeezed = delivery([current]);
  expect(squeezed.text).toContain("K1@v2 is archived");
  expect(squeezed.text).not.toContain("<knowledge>");
  expect(squeezed.knowledgeCommitIds).toEqual([]);
  expect(tokens(squeezed.text)).toBeLessThanOrEqual(5_000);
  expect(squeezed.knowledgeTokens).toBe(tokens(squeezed.text.replace(`${readingGuide(s.id, canonicalToolNames)}\n\n`, "")));
});

// 132 supersedes 64c's single chronological list: categories group, revision order only holds inside a group.
test("132: knowledge is grouped by category with counted headers; selection and omission over a cap are unchanged", () => {
  const { s } = seeded();
  const base = memory.store.listVisibleKnowledge(s.id, memory.store.getSession(s.id)!.projectId)[0]!;
  const item = (id: number, commit: number, category: typeof base.revision.category, createdAt = "2000") => ({
    knowledge: { ...base.knowledge, id }, revision: { ...base.revision, id: commit, knowledgeId: id,
      category, createdAt, text: "whole body " + "word ".repeat(300) },
  });
  // Legacy mechanism renders in understanding and dispute in open; goal has no item, so renders nothing.
  const pool = [item(1, 9, "constraint", "1900"), item(2, 6, "reference"), item(3, 4, "mechanism"), item(100, 1, "constraint", "2099"), item(4, 7, "dispute"), item(5, 8, "open")];
  const whole = wholeKnowledge(pool);
  expect(whole.groups.map(g => g.category)).toEqual(["constraint", "understanding", "open", "reference"]);
  expect(whole.groups.map(g => g.text.split("\n", 1)[0])).toEqual(["## constraint (2)", "## understanding (1)", "## open (2)", "## reference (1)"]);
  expect(whole.commits).toEqual([1, 9, 4, 7, 8, 6]); // glossary category order; oldest to newest inside a group
  expect(wholeKnowledge([...pool].reverse())).toEqual(whole);
  const block = renderKnowledgeBlock(whole.groups);
  expect([...block.matchAll(/\[K\d+@(\d+)\]/g)].map(match => Number(match[1]))).toEqual(whole.commits);
  expect(block).toContain(KNOWLEDGE_RECENCY_NOTICE);
  // Headers are charged: the rendered block, headers included, fits the reported cost.
  expect(tokens(block)).toBeLessThanOrEqual(whole.cost);

  // Over a cap that holds the newest two of three, the oldest is omitted and receipted exactly as before.
  const [newest, middle, oldest] = [item(1, 9, "constraint"), item(2, 6, "reference"), item(100, 1, "constraint")];
  const values = [newest, oldest, middle];
  const cap = wholeKnowledge([newest, middle]).cost + charge(["omitted 1 constraint knowledge; expand: trace://K100", "Receipts:"]);
  const selected = budgetKnowledge(values, cap);
  expect(selected.commits).toEqual([9, 6]);
  expect(selected.receipts).toEqual(["omitted 1 constraint knowledge; expand: trace://K100"]);
  expect(budgetKnowledge([...values].reverse(), cap)).toEqual(selected);
  const text = finish({ content: renderKnowledgeBlock(selected.groups), receipts: selected.receipts });
  expect(text).toContain("## constraint (1)");
  expect(tokens(text)).toBeLessThanOrEqual(selected.cost);
  expect(selected.cost).toBeLessThanOrEqual(cap);
});

test("64c/92: foreground and fresh N keep the same newer items and receipt omitted older knowledge", () => {
  const { s, t } = seeded();
  const write = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "memory")!;
  const committed = ["constraint", "understanding", "reference"].flatMap(category => {
    const receipt = JSON.parse(write.execute({ op: "create", title: "Fixture title", category, scope: "project", text: `new ${category} ` + "word ".repeat(2_000),
      topics: [], supports: ["F1"], reason: "durable conclusion" }));
    return receipt.committed;
  });
  const commits = committed.map((value: { knowledgeId: number; version: string }) =>
    receiptCommit(memory.store, value));
  setKnowledgeCapacity(memory, 5_000);
  scoreAll(memory.store);
  memory.config.compaction.temporaryTokens = 0; // nothing for titles: what misses the base is omitted with a receipt
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const injected = memory.injection(target);
  const frozen = freezeNoting(memory.store, { ...target }, memory.config);
  expect(injected.knowledgeCommitIds).toEqual(commits.slice(1));
  expect(frozen.prepared!.supplied.knowledgeCommitIds).toEqual(injected.knowledgeCommitIds);
  for (const text of [injected.text, frozen.prepared!.text]) {
    expect(text).toContain(KNOWLEDGE_RECENCY_NOTICE);
    expect(text).toContain("omitted 2 constraint knowledge; expand: trace://K2, trace://K1");
    expect(text).not.toContain("[K1#");
    expect(text).not.toContain("[K2#");
  }
  expect(tokens(injected.text)).toBeLessThanOrEqual(5_000);
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
  expect(atPair.groups.map(g => g.text).join("\n")).toBe(`## constraint (1)\n${renderKnowledge(low)}\n## reference (1)\n${renderKnowledge(high)}`);
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
  expect(budgetKnowledge(values, cap).commits).toEqual([13]);
  expect(budgetKnowledge(values, cap, undefined, undefined, new Set([13])).commits).toEqual([13]);
  expect(budgetKnowledge(values, cap, undefined, undefined, undefined, priority).commits).toEqual([13]);
  expect(budgetKnowledge(values, cap, undefined, undefined, new Set([11]), priority).commits).toEqual([11]);
});

test("32a/45: inherited status omission framing stays inside its budget with no active bodies", () => {
  const cap = 5_000;
  const notes = Array.from({ length: 357 }, (_, index) =>
    `K${index + 1}@v1 is superseded by K${index + 1}@v2 above`);
  const budgeted = budgetMaterial({ knowledge: [], knowledgeNotes: notes,
    knowledgeBudget: "database-derived Consolidator knowledge capacity", current: "", framing: [],
    caps: { knowledge: cap, episodic: cap } });
  expect(budgeted.knowledgeNotes.length).toBeLessThan(notes.length);
  expect(budgeted.receipts).toEqual([
    `omitted ${notes.length - budgeted.knowledgeNotes.length} inherited knowledge status lines; database-derived Consolidator knowledge capacity is full`,
  ]);
  const emitted = injectionText({ knowledge: budgeted.knowledge, receipts: budgeted.receipts }, budgeted.knowledgeNotes);
  expect(tokens(emitted)).toBeLessThanOrEqual(cap); // actual emitted text, independent of the selection's charge
  expect(charge([KNOWLEDGE_STATUS_TITLE, ...budgeted.knowledgeNotes, "Receipts:", ...budgeted.receipts])).toBeLessThanOrEqual(cap);
});

test("45: inherited status competes with active bodies and omission receipt floors fail explicitly", () => {
  const { s } = seeded();
  const base = memory.store.listVisibleKnowledge(s.id, memory.store.getSession(s.id)!.projectId)[0]!;
  const values = [1, 2].map(index => ({ knowledge: { ...base.knowledge, id: index }, revision: {
    ...base.revision, id: index, knowledgeId: index, text: `active ${index} ` + "word ".repeat(2_500),
  } }));
  const cap = wholeKnowledge(values).cost;
  const plain = budgetMaterial({ knowledge: values, current: "", framing: [], caps: { knowledge: cap, episodic: cap } });
  expect(plain.knowledgeCommitIds).toEqual([1, 2]);
  const mixed = budgetMaterial({ knowledge: values, knowledgeNotes: ["K9@v1 is superseded by K9@v2 above"],
    knowledgeBudget: "database-derived Consolidator knowledge capacity", current: "", framing: [],
    caps: { knowledge: cap, episodic: cap } });
  expect(mixed.knowledgeNotes).toHaveLength(1);
  expect(mixed.knowledgeCommitIds).toEqual([2]);
  expect(mixed.receipts).toEqual(["omitted 1 constraint knowledge; expand: trace://K1"]);
  const emitted = injectionText({ knowledge: mixed.knowledge, receipts: mixed.receipts }, mixed.knowledgeNotes);
  expect(tokens(emitted)).toBeLessThanOrEqual(cap);

  expect(() => budgetMaterial({ knowledge: [], knowledgeNotes: ["status"], knowledgeBudget: "tiny status cap",
    current: "", framing: [], caps: { knowledge: 1, episodic: 1 } })).toThrow(/inherited status omission receipt alone.*tiny status cap/);
});

// 92 “C删掉” retires case 14's fact-queue/fork subtraction contract.
// N's full frozen processing target versus supplied Raw is tested by case 12;
// its no-facts supplement and compact's filter-before-budget rule remain above.
