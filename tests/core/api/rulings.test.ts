import { readHandle } from "../../read-handle-fixture.ts";
import { knowledgeStatusNotes } from "../../../src/core/api/read.ts";
import { compacted, recorded } from "../../source-fixture.ts";
// Ruling test points: each test pins a user ruling that an implementation could silently deviate
// from. Names identify the ruling and its conversation date.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG, REMOVED_SETTINGS, sourceSeededMemory, visibleTarget, canonicalFlatConfig, renderEntry, runMode, toolDefinitions, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import * as api from "../../source-fixture.ts";
import { tokens } from "../../source-fixture.ts";
import { countPathSnapshots } from "../../perf/fixture.ts";
import { freezeConsolidation } from "../../../src/core/consolidation/index.ts";
import { consolidationToolDefinitions, dreamingToolDefinitions } from "../../../src/core/api/tools.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { setKnowledgeInjection } from "../../knowledge-budget-fixture.ts";
import { visibleView } from "../../../src/hosts/pi/visible.ts";

let directory: string;
let memory: ReturnType<typeof sourceSeededMemory>;
let calls: NotingAgentInput[];
const time = "2026-09-06T00:00:00Z";
const ok = (output: unknown): RunAgentResult => ({ outcome: "success", output: JSON.stringify(output), request: { fake: true } });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-rulings-"));
  calls = [];
  // 26a: a Noting batch is completed only by a submission, so the default run submits the explicit
  // empty batch a Noter with nothing to record must send.
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async (raw) => { const input = raw as NotingAgentInput; calls.push(input);
    if (input.kind === "noting") input.tools.find(t => t.name === "note")!.execute({ facts: [] });
    return ok([]); });
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

/** 28a "Lending": the three compaction windows are one envelope with free lending between them, so a
 * test that wants a tight compaction budget shrinks all three; one key alone leaves the other two's
 * unused allowance as spare. The knowledge window keeps room for its own omission receipt, which is a
 * capacity floor of its own (20b). */
const compactionWindows = (knowledge: number, facts: number, raw: number) => {
  memory.config.compaction.overflowTokens = 0;
  setKnowledgeInjection(memory, Math.max(5_000, knowledge));
  memory.config.compaction.factsTokens = facts;
  memory.config.compaction.rawTokens = raw;
};
const defaultWindows = () => compactionWindows(memory.knowledgeBudgets().injection,
  DEFAULT_CONFIG.compaction.factsTokens, DEFAULT_CONFIG.compaction.rawTokens);
/** The per-window accounting of one custom replacement (28a item 6). */
const charged = (result: ReturnType<typeof memory.compact>) => {
  if ("native" in result) throw new Error(`expected a custom replacement, got: ${result.reason}`);
  return result.charged!;
};

function session() {
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command: "pnpm install" }), result: JSON.stringify({ stdout: "done", stderr: "" }), status: "success" });
  return { s, t };
}

test("2026-09-07: the estimate is segment-based, superseding the Q12 two-weight formula, and Chinese is still never priced as ASCII", () => {
  // Q12 ruled 0.75 per CJK character and 0.25 per other; measurement against a real tokenizer put that
  // 28% low on Chinese and 46% high on English prose, so the user ruled for per-segment pricing.
  expect(tokens("abcd")).toBe(1);
  expect(tokens("地形值")).toBe(3);
  expect(tokens("mapC 地形")).toBe(3);
  // The point Q12 protected still holds: 40 Chinese characters are 35 tokens, not the 10 that four
  // characters per token would give.
  expect(tokens("一".repeat(40))).toBe(35);
  // Characters, not UTF-16 code units: four astral emoji are four characters, not eight.
  expect(tokens("😀😀😀😀")).toBe(5);
  // A run of horizontal whitespace costs the one token o200k holds for it, whatever its width.
  expect(tokens("a b")).toBe(tokens("ab") + 1);
  expect(tokens(`a${" ".repeat(64)}b`)).toBe(tokens("a  b"));
});

test("Q12 + render budgets: cuts are measured with the same estimate, so Chinese output is cut at its token cap, not at four characters per token", () => {
  const { s, t } = session();
  const han = "一".repeat(400), ascii = "a".repeat(400);
  const call = (command: string) => memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command }), result: JSON.stringify({ stdout: "" }), status: "success" });
  call(han); call(ascii);
  const rendered = memory.trace(`S${s.id}/T${t.id}`);
  // 23c renders the arguments under one half of `B`; the cap is the same estimate either way.
  expect(rendered).not.toContain(han);   // 348 tokens over a 150-token arguments share: cut.
  expect(rendered).toContain(ascii);     // 58 tokens of the same 400 characters: kept whole.
  expect(rendered).toMatch(/command="一+"\[\.\.\. \d+ characters truncated\]"一+"/);
});

test("19b 2026-09-08 for ruling 08:53: core freezes one material; the parts an inherited run needs are the head reply and the source index", async () => {
  const { s, t } = session();
  // 17c 2026-09-08 supersedes concurrent sibling admission. A failed input probe leaves the
  // same evidence pending for the subagent comparison; exact branch bytes remain the ruling.
  const probe = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    calls.push(raw as NotingAgentInput); return { ...ok([]), outcome: "failure" };
  });
  const seen = visibleTarget(probe, s.id, "main", t.id);
  try { await probe.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", visible: seen }); }
  finally { probe.close(); }
  await memory.noting({ sessionId: s.id, branch: "b2", headTurnId: t.id, mode: "subagent" });
  const [branch, subagent] = calls;
  expect(branch!.mode).toBe("fork");
  // This older fixture ends with a result: its earlier assistant text is not a missing head reply.
  expect(branch!.material.head).toBeNull();
  expect(branch!.material.sources).toEqual([
    `[T${t.id}#E1] user: T${t.id}#E1@text`,
    `[T${t.id}#E2] assistant: T${t.id}#E2@text`,
    `[T${t.id}#E3] assistant: T${t.id}#E3@call-1`,
    `[T${t.id}#E4] toolResult: T${t.id}#E4@call-1`]);
  // 29b: one builder, not one material. The frozen target is the same in both modes; the parts differ
  // by exactly what the child could already see, so the fresh child gets the Raw and no repair parts.
  expect(subagent!.material.head).toBe(null);
  expect(subagent!.material.sources).toEqual([]);
  expect(subagent!.material.entries.map(e => e.id)).toEqual(branch!.entryIds);
  expect(branch!.material.entries).toEqual([]);
  expect(branch!.entryIds).toEqual(subagent!.entryIds);
  // No field of the material is a provider message, and the block layout is core's own since 20a
  // (pinned in core/render/material.test.ts).
  expect(Object.values(branch!.material).some(part => typeof part === "string" && part.includes("Range: "))).toBe(false);
  expect(branch!.prompt).toContain("already in this conversation");
  expect(subagent!.text).toContain("用 pnpm，不要 npm");
});

/** Knowledge to lead the block with: one manually written fact, consolidated by hand into K1. */
function seededKnowledge(sessionId: number, turnId: number) {
  const tools = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turnId });
  tools.find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: [`T${turnId}#user`] }] });
  tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] });
}

// User ruling 2026-09-08 (ticket 20 "Solution"): this explicitly revises 19b's ban on core-composed
// domain text, without restoring core-owned provider conversations or a custom model loop. The 19b
// pin "no core module builds a message sequence or a provider body, and no host receives composed
// domain text" is superseded by: core builds no provider message or body; core owns the domain text.
test("20a 2026-09-08: core owns the host-neutral domain text and still builds no provider message or body", async () => {
  const { s, t } = session();
  seededKnowledge(s.id, t.id);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const input = calls[0]!;
  // Domain text, from core, in core's own order — instructions stay their own field, not a system message.
  expect(input.text).toContain(input.material.entries[0]!.view);
  expect(input.text.startsWith("Recent facts (by Turn):")).toBe(true); // 25a: no leading knowledge block
  expect(input.prompt).toContain("Noting (fact extraction)");
  expect(input.text).not.toContain(input.prompt);
  // What core still does not build: a message sequence, a system slot, a provider body.
  const record = input as unknown as Record<string, unknown>;
  for (const key of ["messages", "system", "conversation", "body", "subagentInput"]) expect(key in record).toBe(false);
  expect(Array.isArray(record.input)).toBe(false);
  // The recorded provider request is the host's own object; core never produced it.
  expect(JSON.parse(memory.store.listRuns(s.id).at(-1)!.request!)).toEqual({ fake: true });
});

// Ticket 20 "Inherited context": core exposes the full task material and the domain increment
// required when context is inherited, both from the same frozen task; the host picks one.
test("20a 2026-09-08: the full text and the inherited increment come from one frozen task, and the writable range is identical in both modes", async () => {
  const { s, t } = session();
  // A failed probe run leaves the same evidence pending, so the second mode freezes the same task.
  const probe = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    calls.push(raw as NotingAgentInput); return { ...ok([]), outcome: "failure" };
  });
  const seen = visibleTarget(probe, s.id, "main", t.id);
  try { await probe.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", visible: seen }); }
  finally { probe.close(); }
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const [fork, fresh] = calls;
  expect(fork!.mode).toBe("fork"); expect(fresh!.mode).toBe("subagent");
  expect(fork!.entryIds).toEqual(fresh!.entryIds); // one writable range, whatever the execution mode
  expect(fork!.range).toEqual(fresh!.range);
  expect(fork!.readKnowledgeCommits).toEqual(fresh!.readKnowledgeCommits);
  // 29b: one builder over one frozen task, two initial states. What the fork does not send is exactly
  // what its own context already holds, and it is never a second copy of the full text.
  expect(fork!.text).not.toEqual(fresh!.text);
  expect(fork!.text).not.toContain(fresh!.material.entries[0]!.view);
  expect(fresh!.text).not.toContain(fork!.text);
});

// Ticket 20 "Stable prefix": keep task ranges, entry ids belonging only to the new batch, timestamps,
// run ids and omission counts out of the leading knowledge block. A byte-layout rule, not a cache claim.
// 25a supersedes this ruling's "all four consumers" for the Noter: it renders no knowledge block in
// either mode, so the identical-block pin covers the three consumers that still carry one, and the
// Noter is pinned to carry none.
test("20a 2026-09-08, narrowed by 25a: nothing task-specific enters the leading knowledge block, and the three knowledge consumers render it identically", async () => {
  const { s, t } = session();
  seededKnowledge(s.id, t.id);
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect(calls[0]!.text).not.toContain("<knowledge>"); // the fourth consumer no longer
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const consolidation = calls.at(-1)! as unknown as import("../../../src/core/api/index.ts").ConsolidationAgentInput;
  const block = consolidation.text.split("\n\nRange: ")[0]!;
  expect(block).toBe(memory.inject(s.id)); // the initial injection and the Consolidator share one block
  expect(compacted(memory.compact(s.id, "main", t.id)).startsWith(`${block}\n\n<episodic>`)).toBe(true);
  expect(block).not.toContain("Range: ");
  expect(block).not.toContain(`Range: ${consolidation.range.from}..${consolidation.range.to}`);
  expect(block).not.toContain("[entry ");
  expect(block).not.toContain("omitted");
  for (const line of consolidation.material.rangeFacts) expect(block).not.toContain(line); // no copy of this task's own facts
  expect(block).not.toMatch(/\bR\d+\b/); // no run id
  expect(block).not.toContain(memory.store.getTurn(t.id)!.startedAt); // no timestamp of this task
});

test("09:43: trace accepts both T<n> and S<n>/T<n>; a mismatched session does not resolve", () => {
  const { s, t } = session();
  const plain = memory.trace(`T${t.id}`);
  expect(memory.trace(`S${s.id}/T${t.id}`)).toBe(plain);
  expect(() => memory.trace(`S${s.id + 1}/T${t.id}`)).toThrow("does not exist");
});

// 09:43 "sessions of one project integrate separately": pinned in core/api/consolidation.test.ts,
// "each session settles only its own branch facts and shares already-settled context".

// User, 2026-09-07: four tools: trace, search, facts and knowledge writers; main agents may use them but have no memory duty.
// User, 2026-09-07: the writer tool names are note and memory.
test("2026-09-07: four tools, no other model-facing surface", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  expect(tools.map(t => t.name)).toEqual(["trace", "search", "note", "memory"]);
  for (const tool of tools) { expect(tool.parameters.type).toBe("object"); expect(typeof tool.execute).toBe("function"); }
  for (const tool of tools.slice(2)) expect(tool.description).toContain("runs are the normal writers");
  expect(tools[3]!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion." }, { op: "archive", reason: "Retired: the cited evidence withdraws this conclusion." }], skipped: [] })).toContain("rejected:");
});

// “if any fails, the result lists each item's outcome in order ... and nothing is written.”
test("2026-09-07: a rejected item writes nothing", () => {
  const { s, t } = session();
  const note = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[2]!;
  const fact = { category: "decision", actor: "user", text: "Use pnpm", source: [`T${t.id}#user`] };
  const rejected = JSON.parse(note.execute({ facts: [fact, { ...fact, actor: "tool" }] }));
  expect(rejected.results[0]).toBe("ok"); expect(rejected.results[1]).toContain("rejected:");
  expect(memory.store.listSessionFacts(s.id)).toEqual([]);
  const corrected = JSON.parse(note.execute({ facts: [fact, { ...fact, support: [["$1", "strong"]] }] }));
  expect(corrected.results).toEqual(["ok: F1", "ok: F2"]);
  expect(memory.trace("F2")).toContain("support F1 strong");
});

// “A Noting run commits at most one batch.”
test("2026-09-07: one batch per run", async () => {
  const { s, t } = session(); memory.close();
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ round: 1 });
    const note = input.tools[2]!;
    const batch = { facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: [`T${t.id}#user`] }] };
    expect(note.execute(batch)).toContain("F1");
    expect(memory.store.getRun(1)?.outcome).toBe("success");
    expect(JSON.parse(memory.store.getRun(1)!.request!)).toEqual({ round: 1 });
    expect(memory.store.sourcePath(s.id, "main", t.id).length).toBeGreaterThan(0);
    expect(memory.store.sourcePath(s.id, "main", t.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
    expect(note.execute(batch)).toContain("already committed");
    return { outcome: "success", output: "Done", request: { round: 2 } };
  });
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(memory.store.listSessionFacts(s.id)).toHaveLength(1);
  const run = memory.store.getRun(1)!;
  expect(JSON.parse(run.request!)).toEqual({ round: 2 });
  expect(JSON.parse(run.response!).toolCalls.map((c: { result: string }) => c.result)).toHaveLength(2);
});

// “a run whose last submission was rejected and never corrected ... is bounced ... watermark does not move”.
test("2026-09-07: bounced is not empty", async () => {
  const { s, t } = session(); memory.close();
  let reject = true;
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    (raw as NotingAgentInput).tools[2]!.execute({ facts: reject ? [{ category: "invalid" }] : [] });
    return { outcome: "success", output: "No more text", request: {} };
  });
  const input = { sessionId: s.id, branch: "main", headTurnId: t.id };
  expect((await memory.noting(input)).outcome).toBe("bounced");
  expect(memory.store.getRun(1)?.outcome).toBe("bounced");
  expect(JSON.parse(memory.store.getRun(1)!.response!).toolCalls[0].input).toEqual({ facts: [{ category: "invalid" }] });
  expect(memory.store.listSourceEntries(s.id).some(e => memory.store.entryNoted(e.id))).toBe(false);
  reject = false;
  expect(await memory.noting(input)).toMatchObject({ outcome: "success", facts: [] });
  expect(memory.store.sourcePath(s.id, "main", t.id).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(s.id, "main", t.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
});

function memoryWriter() {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  tools[2]!.execute({ facts: ["Use pnpm", "Do not use npm"].map(text => ({ category: "decision", actor: "user", text, source: [`T${t.id}#user`] })) });
  recorded(memory, s.id, "main", t.id); // recorded: the facts may enter an Consolidation batch
  const create = { op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"] };
  return { s, t, read: (address: string) => readHandle(tools, address), write: (operations: unknown[]) => JSON.parse(tools[3]!.execute({ operations, skipped: [] })), create };
}

test("2026-09-07: one operation shape, inapplicable fields rejected", () => {
  const { create, write } = memoryWriter();
  write([create]);
  const update = { ...create, op: "update", reason: "Substantive correction of the recorded conclusion.", id: "K1" };
  const archive = { op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: "K1", supports: ["F1"] };
  for (const operation of [create, update, { ...update, op: "merge", reason: "Merged duplicate knowledge into the survivor.", absorb: ["K2"] }, archive]) {
    for (const required of ["reason", "supports"]) {
      const missing = { ...operation } as Record<string, unknown>; delete missing[required];
      expect(write([missing]).results[0]).toContain("rejected:");
    }
  }
  const wrong = [{ ...create, id: "K1" }, { ...create, absorb: ["K1"] }, { ...update, absorb: ["K2"] },
    ...["text", "category", "scope", "absorb"].map(key => ({ ...archive, [key]: key === "absorb" ? [] : "x" })),
    { ...create, handle: "$e1" }, { ...create, status: "active" }];
  for (const operation of wrong) {
    const result = write([create, operation]);
    expect(result.results[0]).toBe("ok"); expect(result.results[1]).toContain("inapplicable field");
    expect(memory.store.getKnowledge(2)).toBeNull();
  }
  for (const key of ["text", "category", "scope", "supports"]) {
    const incomplete = { ...update } as Record<string, unknown>; delete incomplete[key];
    expect(write([incomplete]).results[0]).toContain("rejected:");
  }
});

test("2026-09-07: supports replaces, history keeps the old set", () => {
  const { create, write, read, s } = memoryWriter();
  const created = write([create]);
  expect(created.results).toEqual(["ok"]);
  expect(memory.store.getKnowledgeRevision(1, 1)).toMatchObject({ supports: [1], reason: "Initial admission of this conclusion." });
  write([{ ...create, op: "update", reason: "Substantive correction of the recorded conclusion.", id: read("K1@1"), text: "Avoid npm", supports: ["F2"] }]);
  expect(memory.store.getKnowledgeRevision(1, 2)).toMatchObject({ supports: [2], reason: "Substantive correction of the recorded conclusion." });
  expect(memory.store.getKnowledgeRevision(1, 1)?.supports).toEqual([1]);
  expect(memory.trace("K1@1..K1@2")).toContain("F2");
  const runs = memory.store.listRuns(s.id);
  expect(runs.at(-1)).toMatchObject({ kind: "manual", outcome: "success", branch: "main", rangeFrom: "S1/T1", rangeTo: "S1/T1" });
  expect(JSON.parse(runs.at(-1)!.request!).operations[0].op).toBe("update");
  expect(JSON.parse(runs.at(-1)!.response!).results).toEqual(["ok"]);
});

test("2026-09-07: merge atomic", () => {
  const { create, write, read } = memoryWriter(); write([create, { ...create, text: "Avoid npm", supports: ["F2"] }]);
  const merge = { ...create, op: "merge", reason: "Merged duplicate knowledge into the survivor.", id: read("K1@1"), absorb: [read("K2@2")], supports: ["F1", "F2"] };
  expect(write([merge, { op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: "K999", supports: [] }]).results[1]).toContain("rejected:");
  expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
  expect(memory.store.currentCommit(2)[0]?.op).toBe("create");
  expect(memory.store.listKnowledgeLinks(2)).toEqual([]);
  expect(write([merge]).results).toEqual(["ok"]);
  expect(memory.store.currentCommit(2)).toEqual([]);
  expect(memory.store.getKnowledge(2)).toMatchObject({ id: 2 });
  expect(memory.store.listKnowledgeLinks(2)).toEqual([{ fromKnowledge: 2, fromCommit: 2, kind: "merged_into", toKnowledge: 1, toCommit: 3 }]);
  expect(memory.trace("K2@2")).toContain("Avoid npm"); expect(memory.trace("K2")).toContain("K1@3");
});

test("2026-09-07: second submission commits, first does not", async () => {
  const { create, s } = memoryWriter(); memory.close();
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as import("../../../src/core/api/index.ts").ConsolidationAgentInput;
    const batch = { operations: [create], skipped: [{ fact: "F2", because: "Already expressed." }] };
    input.reportRequest({ messages: ["first"] });
    const tool = input.tools[3]!;
    expect(tool.execute({ operations: [{ ...create, id: "K1" }], skipped: [] })).toContain("rejected:");
    const first = JSON.parse(tool.execute(batch));
    expect(first.feedback).toMatchObject({ role: "user" });
    expect(first.feedback.content).toContain("NEAR:"); expect(first.feedback.content).toContain("CLOSER:");
    expect(first.feedback.content).toContain("System-generated review guidance; not a human ruling or adoption evidence.");
    expect(memory.store.getKnowledge(1)).toBeNull();
    expect(memory.store.listConsolidatedFacts(1)).toEqual([]);
    input.reportRequest({ messages: ["first", first.feedback] });
    expect(JSON.parse(tool.execute(batch)).committed).toHaveLength(1);
    expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
    expect(memory.store.consolidatedOnPath(2, memory.store.knowledgePath(s.id, "main"))).toBe(true);
    expect(tool.execute(batch)).toContain("already committed");
    return { outcome: "failure", output: "provider failed after commit", request: { messages: ["last"] } };
  });
  const result = await memory.consolidate({ sessionId: s.id, branch: "main" });
  if (result.outcome !== "success") throw new Error("committed run must stay successful");
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe("success"); expect(JSON.parse(run.request!)).toEqual({ messages: ["last"] });
  expect(JSON.parse(run.response!).problems).toEqual(["provider failed after commit"]);
  expect(JSON.parse(run.response!).toolCalls).toHaveLength(4);
});


test("2026-09-07: branch input premise repair appends the missing final reply and source index", async () => {
  const { s } = session();
  const first = memory.store.appendTurn({ sessionId: s.id, parentTurnId: null, kind: "turn",
    userPrompt: "0123456789".repeat(6) + " PRIVATE USER TAIL", assistantText: "Earlier reply", startedAt: time });
  const head = memory.store.appendTurn({ sessionId: s.id, parentTurnId: first.id, kind: "turn",
    userPrompt: "Check it", assistantText: "Final-only finding: " + "result ".repeat(10) + "verified.", startedAt: time });
  memory.store.appendToolCall({ turnId: head.id, name: "Bash", input: '{"command":"check"}', result: "PRIVATE TOOL RESULT", status: "success" });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: head.id, mode: "fork",
    visible: visibleTarget(memory, s.id, "main", head.id) });
  const input = calls[0]!;
  expect(input.mode).toBe("fork");
  expect(input.material.head).toBeNull(); // The last native entry is a result, not E2's earlier reply.
  expect(input.material.sources).toEqual([
    `[T2#E1] user: T2#E1@text`,
    `[T2#E2] assistant: T2#E2@text`,
    `[T3#E1] user: T3#E1@text`,
    `[T3#E2] assistant: T3#E2@text`,
    `[T3#E3] assistant: T3#E3@call-2`,
    `[T3#E4] toolResult: T3#E4@call-2`]);
  expect(input.text).not.toContain("PRIVATE USER TAIL");
  expect(input.material.sources.join("\n")).not.toContain("PRIVATE TOOL RESULT");
});

test("33: a branch source index uses shared identities, not a separate body preview",  async () => {
  const { s } = session();
  const t = memory.store.appendTurn({ sessionId: s.id, parentTurnId: null, kind: "turn",
    userPrompt: "😀".repeat(59) + "\nTAIL", assistantText: null, startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: "x".repeat(60) + "\nTAIL", result: null, status: "attempted" });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork",
    visible: visibleTarget(memory, s.id, "main", t.id) });
  expect(calls[0]!.material.head).toContain("[T2#E2@call-2] Bash(");
  expect(calls[0]!.material.sources).toEqual([
    "[T2#E1] user: T2#E1@text",
    "[T2#E2] assistant: T2#E2@call-2"]);
  expect(calls[0]!.material.sources.join("\n")).not.toContain("TAIL");
});

test.each(["user", "assistant", "t1"] as const)("2026-09-07: trace source suffix #%s renders only its part", (part) => {
  const { s, t } = session();
  const tool = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[0]!;
  // 23b: a source part reads as the entry view of that part — the addresses its labels carry, and for
  // a call both of its parts: the arguments the assistant sent and the result that came back.
  const expected = part === "user" ? `[T${t.id}#E1@text] user: 用 pnpm，不要 npm`
    : part === "assistant" ? `[T${t.id}#E2@text] assistant: 好的。`
    : `[T${t.id}#E3@call-1] Bash(command="pnpm install")\n[T${t.id}#E4@call-1] Bash success: {"stdout":"done","stderr":""}`;
  for (const base of [`T${t.id}`, `S${s.id}/T${t.id}`]) {
    expect(memory.trace(`${base}#${part}`)).toBe(expected);
    expect(tool.execute({ address: `${base}#${part}` })).toBe(expected);
  }
  expect(() => memory.trace(`S${s.id + 1}/T${t.id}#${part}`)).toThrow("does not exist");
});

test("2026-09-07: trace source suffix keeps standard tool cuts unless full", () => {
  const { t } = session();
  const output = "hidden evidence ".repeat(300);
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: '{"command":"second"}', result: output, status: "success" });
  const cut = memory.trace(`T${t.id}#t2`);
  expect(cut).toMatch(/\[\.\.\. \d+ characters truncated\]/); // 23c: the entry view's one marker family
  expect(cut).not.toContain(output);
  expect(cut).not.toContain("#t1");
  // 17a preserves the full argument object, including fields beyond command.
  const full = memory.trace(`T${t.id}#t2`, { full: true });
  // 23c: `full` is the same renderer with no budget — the same labels, the stored bytes uncut.
  expect(full).toBe(`[T${t.id}#E5@call-2] Bash(command="second")\n[T${t.id}#E6@call-2] Bash success: ${output}`);
  expect(memory.trace(`T${t.id}#t2`, { tool: 2, full: true })).toBe(full);
  expect(() => memory.trace(`T${t.id}#t2`, { tool: 1 })).toThrow("conflicts");
});

test("2026-09-07: trace rejects a missing source part with the reason", () => {
  const { s } = session();
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: null, assistantText: null, startedAt: time });
  const tool = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[0]!;
  for (const part of ["user", "assistant", "t1"]) for (const base of [`T${t.id}`, `S${s.id}/T${t.id}`]) {
    const reason = `source T${t.id}#${part} does not exist`;
    expect(() => memory.trace(`${base}#${part}`)).toThrow(reason);
    expect(tool.execute({ address: `${base}#${part}` })).toBe(`rejected: ${reason}`);
  }
});

// Knowledge commits (rulings A/B, 2026-09-07): all writes go through the host façade.
function commitPaths() {
  const { s, t } = session();
  const selectNativeAncestry = (sessionId: number, headTurnId: number, branch: string) => {
    const turns = memory.store.pathTurns({ sessionId, headTurnId });
    const entries = memory.store.listSourceEntries(sessionId).filter(entry => turns.has(entry.turnId));
    memory.selectEntries(sessionId, branch, entries.map(entry => entry.id));
    return entries.at(-1)!.id;
  };
  const node = (sessionId: number, parentTurnId: number | null, branch: string) => {
    const turn = memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: branch, startedAt: time });
    return writer(sessionId, turn.id, branch, selectNativeAncestry(sessionId, turn.id, branch));
  };
  const writer = (sessionId: number, headTurnId: number, branch: string, triggerEntryId: number) => {
    const tools = memory.tools({ kind: "manual", sessionId, currentTurnId: headTurnId, branch, triggerEntryId });
    const receipt = JSON.parse(tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: branch, source: [`T${headTurnId}#user`] }] }));
    expect(receipt.results[0]).toMatch(/^ok:/);
    const fact = `F${receipt.factIds[0]}`;
    // This branch fixture begins by reading its one shared rule, not every candidate in the database.
    if (memory.store.getKnowledge(1)) tools[0]!.execute({ address: "K1", cap: Number.MAX_SAFE_INTEGER });
    return { sessionId, headTurnId, branch, triggerEntryId, fact, tools,
      read: (address = "K1") => readHandle(tools, address),
      write: (operations: unknown[]) => JSON.parse(tools[3]!.execute({ operations, skipped: [] })) };
  };
  const root = writer(s.id, t.id, "main", selectNativeAncestry(s.id, t.id, "main"));
  const content = (fact: string, text = "Use blue tiles") => ({ text, category: "constraint", scope: "project", supports: [fact] });
  expect(root.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }]).committed[0].commit).toBe(1);
  root.read("K1@1");
  const c = node(s.id, t.id, "C"), d = node(s.id, t.id, "D");
  const edit = (who: typeof root, text: string, fact = who.fact) => who.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: who.read(), ...content(fact, text) }]);
  const tips = (path: { sessionId: number; headTurnId: number }) => memory.store.currentCommit(1, path).map(r => r.id);
  const peer = (projectId = s.projectId) => {
    const other = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId, startedAt: time, firstReplyAt: time });
    return node(other.id, null, "main");
  };
  return { root, c, d, node, peer, content, edit, tips };
}

test("2026-09-07 A: C/D paths see c2/c3, fork ancestor sees c1, D's later commit does not move C", () => {
  const { root, c, d, node, edit, tips } = commitPaths();
  expect(edit(c, "C version").committed[0].commit).toBe(2);
  expect(edit(d, "D version").committed[0].commit).toBe(3);
  const later = node(d.sessionId, d.headTurnId, "D");
  expect(edit(later, "D later version").committed[0].commit).toBe(4);
  expect(tips(root)).toEqual([1]); expect(tips(c)).toEqual([2]); expect(tips(d)).toEqual([3]); expect(tips(later)).toEqual([4]);
  for (const [path, text] of [[c, "C version"], [d, "D version"], [root, "Use blue tiles"]] as const) {
    expect(memory.inject(path)).toContain(text);
    expect(compacted(memory.compact(path.sessionId, path.branch, path.headTurnId))).toContain(text);
    expect(memory.trace("K1", path).split("\n")[1]).toContain(text);
  }
  expect(memory.store.getKnowledge(1)).not.toHaveProperty("currentRevision");
  expect(memory.store.getKnowledge(1)).not.toHaveProperty("status");
  expect(memory.store.getKnowledgeRevision(1, 4)).toMatchObject({ id: 4, parentId: 3 });
  expect(memory.store.getKnowledgeRevision(1, 4)).not.toHaveProperty("rev");
});

test("34a: a child cannot escape an inapplicable historical parent by citing shared evidence", () => {
  const { root, c, node, edit, tips, content } = commitPaths();
  expect(edit(c, "C version").committed[0].commit).toBe(2);
  const next = node(c.sessionId, c.headTurnId, "C");
  expect(next.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: next.read(), ...content(root.fact) }]).committed[0].commit).toBe(3);
  // Commit 3 cites only root evidence, but its exact parent remains child-only.
  expect(tips(root)).toEqual([1]);
  expect(edit(next, "Develop after revert").committed[0].commit).toBe(4);
  expect(tips(next)).toEqual([4]); expect(tips(root)).toEqual([1]);
  expect(memory.trace("K1@1..K1@4")).toContain("{+Develop+}");
  expect(memory.trace("K1..")).toContain("status: update");
});

test("2026-09-07 B/34b: pre-fork evidence applies to both branches without blocking an authorized sibling write", () => {
  const { root, c, d, content, edit, tips } = commitPaths();
  expect(edit(c, "Shared pre-fork correction", root.fact).committed[0].commit).toBe(2);
  expect(tips(c)).toEqual([2]); expect(tips(d)).toEqual([2]);
  const allowed = d.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(d.fact) },
    { op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@1", ...content(d.fact) }]);
  expect(allowed.results).toEqual(["ok", "ok"]);
  expect(allowed.committed.map((item: { commit: number }) => item.commit)).toEqual([3, 4]);
  expect(memory.store.getKnowledge(2)).not.toBeNull();
  expect(tips(d)).toEqual([2, 4]); // shared applicability does not collapse genuine sibling successors
});

test("2026-09-07 B: cross-session concurrent edits reject linearly, then re-read and resubmit", () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  const second = sourceSeededMemory(join(directory, "test.sqlite"), async () => ok([]));
  try {
    const writer = second.tools({ kind: "manual", sessionId: other.sessionId, currentTurnId: other.headTurnId, branch: "main" });
    readHandle(writer, "K1@1");
    expect(root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@1", ...content(root.fact, "First writer") }]).committed[0].commit).toBe(2);
    const stale = JSON.parse(writer[3]!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(other.fact) }, { op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@1", ...content(other.fact) }], skipped: [] }));
    expect(stale.results[1]).toContain("K1@2"); expect(second.store.getKnowledge(2)).toBeNull();
    writer[0]!.execute({ address: "K1" });
    const accepted = JSON.parse(writer[3]!.execute({ operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@2", ...content(other.fact, "Second writer") }], skipped: [] }));
    expect(accepted.committed[0].commit).toBe(3);
    expect(memory.store.currentCommit(1, root).map(r => r.id)).toEqual([3]);
    expect(second.store.getKnowledgeRevision(1, 3)?.parentId).toBe(2);
  } finally { second.close(); }
});

test("2026-09-07 A: archive has empty text and retires its parent only on its applicable path", () => {
  const { root, c, d, tips } = commitPaths();
  expect(c.write([{ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: "K1@1", supports: [c.fact] }]).committed[0].commit).toBe(2);
  expect(memory.store.getKnowledgeRevision(1, 2)).toMatchObject({ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", text: "", supports: [Number(c.fact.slice(1))], parentId: 1 });
  expect(tips(c)).toEqual([2]); expect(tips(d)).toEqual([1]); expect(tips(root)).toEqual([1]);
  expect(memory.inject(c)).not.toContain("K1@"); expect(memory.inject(d)).toContain("K1@1");
});

test("2026-09-07 A: sibling-branch facts are readable but supports requires an adoption fact on this path", () => {
  const { c, d, content } = commitPaths();
  expect(c.tools[0]!.execute({ address: d.fact })).toContain(d.fact);
  for (const scope of ["session", "project", "global"]) {
    const rejected = c.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(c.fact), scope, supports: [d.fact] }]);
    expect(rejected.results[0]).toContain("record an adoption fact on this path first");
    expect(memory.store.getKnowledge(2)).toBeNull();
  }
  const adopted = JSON.parse(c.tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Adopt the other branch's rule", quote: d.fact, source: [`T${c.headTurnId}#user`] }] }));
  expect(c.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(`F${adopted.factIds[0]}`) }]).committed).toHaveLength(1);
});

test("2026-09-07: supports obeys the session/project/global scope table", () => {
  const { c, peer, content } = commitPaths();
  const same = peer();
  const outside = peer(memory.store.createProject({ name: "outside", declaredBy: "mark" }).id);
  for (const scope of ["session", "project", "global"]) for (const origin of [c, same, outside]) {
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const result = c.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(c.fact), scope, supports: [origin.fact] }]);
    expect(!!result.committed).toBe(allowed);
  }
  expect(c.tools[0]!.execute({ address: outside.fact })).toContain(outside.fact);
});

test("2026-09-07 B: two tips surface as alternatives to a third session and merge by explicit commits", () => {
  const { c, d, peer, edit, content, tips } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  const third = peer();
  expect(tips(third)).toEqual([2, 3]);
  expect(memory.trace("K1")).not.toContain("[K1@2]");
  expect(memory.trace("K1")).toContain("[K1@3]");
  expect(memory.trace("K1", { versions: "all" })).toContain("Alternative K1@2");
  expect(memory.inject(third)).toContain("K1@2"); expect(memory.inject(third)).toContain("K1@3");
  expect(third.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(third.fact) }]).results[0]).toContain("current tips: K1@2, K1@3");
  expect(() => memory.mark("K1", "verified", third)).toThrow("several tips");
  expect(memory.mark("K1@2", "verified", third)).toBe("K1@2: verified");
  third.tools[0]!.execute({ address: "K1@2" }); third.tools[0]!.execute({ address: "K1@3" });
  expect(third.write([{ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", id: "K1@2", absorb: ["K1@3"], ...content(third.fact, "Combined rule") }]).committed[0].commit).toBe(4);
  expect(tips(third)).toEqual([4]);
  expect(memory.store.getKnowledgeRevision(1, 4)?.parentId).toBe(2);
  expect(memory.store.listKnowledgeLinks(1)).toContainEqual({ fromKnowledge: 1, fromCommit: 3, kind: "merged_into", toKnowledge: 1, toCommit: 4 });
  expect(memory.store.listKnowledgeMarks(1)).toMatchObject([{ commitId: 2, kind: "verified" }]);
  expect(memory.trace("K1@4")).not.toContain("verified");
});

// Footer progress retains `knowledge` as the applicable-current total in `listCurrentKnowledge`'s
// counting unit. The display partitions those exact versions into unprocessed and processed; two
// divergent tips remain two items. Consolidation membership is exact over the same path.
test("footer progress retains total current-tip semantics while exposing its exact-version split", () => {
  const { c, d, peer, edit, tips } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  const third = peer();
  expect(tips(third)).toEqual([2, 3]); // two divergent tips of K1 on this path
  const counted = memory.progress(third.sessionId, third.branch, third.headTurnId);
  expect(counted).toMatchObject({ knowledge: 2, unprocessedKnowledge: 2, processedKnowledge: 0 });
  expect(counted.unprocessedKnowledge + counted.processedKnowledge).toBe(counted.knowledge);
  expect(counted.knowledge).toBe(memory.store.listCurrentKnowledge({ sessionId: third.sessionId, headTurnId: third.headTurnId, branch: third.branch }).length);
  // This peer wrote one fact and consolidated nothing, so every applicable fact is still pending.
  expect(counted).toMatchObject({ facts: 1, unconsolidated: 1 });
  expect(counted.entries).toBe(memory.pendingEntries(third.sessionId, third.branch, third.headTurnId).length);
  const consolidated = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: third.sessionId, branch: third.branch, createdAt: time },
    operations: [], consolidated: [Number(third.fact.slice(1))] });
  expect(consolidated.ok).toBe(true);
  const after = memory.progress(third.sessionId, third.branch, third.headTurnId);
  expect(after).toMatchObject({ facts: 1, unconsolidated: 0, knowledge: 2, unprocessedKnowledge: 2, processedKnowledge: 0 }); // fact queue empties; Knowledge is unchanged
  expect(after.unconsolidated).toBe(memory.store.consolidationBatch(third.sessionId, third.branch, third.headTurnId).length);
  // The root path sees one tip of the same identity: the count follows the path, not the knowledge row.
  expect(memory.progress(1, "main", 1).knowledge).toBe(1);
});

test("2026-09-07 B: store rechecks every base inside the transaction and rolls back an earlier create", () => {
  const { root, content } = commitPaths();
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: root.read(), ...content(root.fact) }]);
  const origin = memory.store.triggerOrigin(root, root.triggerEntryId);
  const run = memory.store.bindRunOrigin({ kind: "manual", sessionId: root.sessionId, createdAt: time }, origin);
  const result = memory.store.commitConsolidationRun({ path: root, run, operations: [
    { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "Must roll back", category: "goal", scope: "project", supports: [1], createdAt: time },
    { op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: 1, baseCommit: 1, supports: [1], createdAt: time },
  ] });
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("stale batch committed");
  expect(result.problems.join(" ")).toContain("K1@2");
  expect(memory.store.getKnowledge(2)).toBeNull();
  expect(memory.store.listKnowledgeRevisions(1)).toHaveLength(2);
});

test("2026-09-07 B: reading a historical commit never refreshes the base to an unread successor", () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@1", ...content(root.fact, "Unread successor") }]);
  expect(other.tools[0]!.execute({ address: "K1@1" })).not.toContain("Unread successor");
  expect(other.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@1", ...content(other.fact) }]).results[0]).toContain("current: K1@2");
  other.tools[0]!.execute({ address: "K1@2" });
  expect(other.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@2", ...content(other.fact) }]).committed[0].commit).toBe(3);
});

test("search previews and cursor fragments never refresh a knowledge write base", () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  root.write([{ op: "update", topics: [], reason: "A substantive correction.", id: "K1@1",
    ...content(root.fact, `Unread successor ${"中文😀".repeat(3000)}`) }]);
  const edit = (id = "K1@1") => other.write([{ op: "update", topics: [], reason: "A substantive correction.", id, ...content(other.fact) }]);
  let page = other.tools[1]!.execute({ query: "Unread successor", layer: "knowledge", maxTokens: 256 });
  expect(page).not.toContain("rejected:");
  expect(edit().results[0]).toContain("current: K1@2");
  let count = 0;
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
    // Even a misleading K address on the final cursor page must not authorize a complete reread.
    page = other.tools[0]!.execute({ address: "K1", cursor });
    expect(page).not.toContain("rejected:");
    expect(++count).toBeLessThan(100);
  }
  expect(edit().results[0]).toContain("current: K1@2");
  expect(edit("K1@2").results[0]).toContain("knowledge was not read");
  page = other.tools[0]!.execute({ address: "K1", full: true });
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
    expect(tokens(page)).toBeLessThanOrEqual(2000);
    expect(edit("K1@2").results[0]).toContain("knowledge was not read");
    page = other.tools[0]!.execute({ address: `cursor=${cursor}` });
  }
  expect(tokens(page)).toBeLessThanOrEqual(2000);
  expect(edit("K1@2").committed[0].commit).toBe(3);
});

test("trace K1 cap=1 replaces stale read bases only on the final page", () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  expect(root.write([{ op: "update", topics: [], reason: "New version.", id: "K1@1", ...content(root.fact) }]).committed[0].commit).toBe(2);
  const edit = (id = "K1@1") => other.write([{ op: "update", topics: [], reason: "Correct rule.", id, ...content(other.fact) }]);
  let page = other.tools[0]!.execute({ address: "K1", cap: 1 }), count = 0;
  expect(page).toContain("cursor=");
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
    expect(edit().results[0]).toContain("current: K1@2");
    expect(edit("K1@2").results[0]).toContain("knowledge was not read");
    page = other.tools[0]!.execute({ address: `cursor=${cursor}` });
    expect(page).not.toContain("rejected:");
    expect(++count).toBeLessThan(100);
  }
  expect(edit().results[0]).toContain("knowledge was not read");
  expect(edit("K1@2").committed[0].commit).toBe(3);
  expect(memory.store.getKnowledgeRevision(1, 3)?.parentId).toBe(2);
});

test.each([false, true])("trace cap=1 completes the frozen K read through actual cursors (address form=%s)", addressForm => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  expect(root.write([{ op: "create", topics: [], reason: "New rule.", ...content(root.fact, "Second knowledge") }]).committed[0].commit).toBe(2);
  const edit = () => other.write([{ op: "update", topics: [], reason: "Correct rule.", id: "K2@2", ...content(other.fact) }]);
  let page = other.tools[0]!.execute({ address: "K2", cap: 1 });
  let count = 0;
  while (true) {
    expect(page).not.toContain("rejected:");
    const cursor = /cursor=(\S+)/.exec(page)?.[1];
    if (!cursor) break;
    expect(edit().results[0]).toContain("knowledge was not read");
    page = other.tools[0]!.execute(addressForm ? { address: `cursor=${cursor}` } : { address: "K1", cursor });
    expect(++count).toBeLessThan(100);
  }
  expect(count).toBeGreaterThan(1);
  expect(edit().committed[0]).toMatchObject({ knowledgeId: 2, commit: 3 });
  expect(memory.store.getKnowledgeRevision(2, 3)?.parentId).toBe(2);
});

test("a mixed multi-K read authorizes only its completed identities; abandoned cursors authorize nothing", () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  const operation = (id: string) => ({ op: "update", topics: [], reason: "Correct rule.", id, ...content(other.fact) });
  expect(root.write([2, 3].map(id => ({ op: "create", topics: [], reason: "New rule.", ...content(root.fact, `Rule ${id}`) }))).committed.map((k: { commit: number }) => k.commit)).toEqual([2, 3]);
  expect(root.write([{ ...operation("K1@1"), ...content(root.fact, "Unrelated new rule") }])).toMatchObject({ committed: [{ commit: 4 }] });
  const abandoned = other.tools[0]!.execute({ address: "K1", cap: 1 });
  const abandonedCursor = /cursor=(\S+)/.exec(abandoned)![1];
  // Existing cache eviction drops the unread obligation, never completes it.
  for (let i = 0; i < 16; i++) other.tools[0]!.execute({ address: "K2", cap: 1 });
  expect(other.tools[0]!.execute({ address: `cursor=${abandonedCursor}` })).toContain("unknown or expired cursor");
  let page = other.tools[0]!.execute({ address: "K2,F1-F2,K3@3", cap: 1 }), count = 0;
  expect(page).toContain("cursor=");
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
    expect(++count).toBeLessThan(100);
    for (const id of ["K2@2", "K3@3"]) expect(other.write([operation(id)]).results[0]).toContain("knowledge was not read");
    page = other.tools[0]!.execute({ address: "K1", cursor });
    expect(page).not.toContain("rejected:");
  }
  expect(other.write([operation("K1@1")]).results[0]).toContain("current: K1@4");
  expect(other.write([operation("K2@2"), operation("K3@3")]).committed.map((k: { commit: number }) => k.commit)).toEqual([5, 6]);
  expect(memory.store.getKnowledgeRevision(2, 5)?.parentId).toBe(2);
  expect(memory.store.getKnowledgeRevision(3, 6)?.parentId).toBe(3);
});

test.each(["K2", "K2@2", "K2,F1-F2,K1", "F1-F2,K2@2,K1,K2"])("paged %s records the delivered old version, never the later successor", address => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  expect(root.write([{ op: "create", topics: [], reason: "New rule.", ...content(root.fact, "FROZEN-SECOND") }]).committed[0].commit).toBe(2);
  const edit = (id: string) => other.write([{ op: "update", topics: [], reason: "Correct rule.", id, ...content(other.fact) }]);
  let page = other.tools[0]!.execute({ address, cap: 1 });
  expect(page).toContain("cursor=");
  expect(edit("K2@2").results[0]).toContain("knowledge was not read");
  expect(root.write([{ op: "update", topics: [], reason: "Concurrent correction.", id: root.read("K2@2"), ...content(root.fact, "UNREAD-LATEST") }]).committed[0].commit).toBe(3);
  const pages = [page];
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
    expect(edit("K2@2").results[0]).toContain("knowledge was not read");
    page = other.tools[0]!.execute({ address: `cursor=${cursor}` });
    expect(page).not.toContain("rejected:");
    pages.push(page); expect(pages.length).toBeLessThan(100);
  }
  expect(pages.length).toBeGreaterThan(2);
  expect(pages.join("\n")).toContain("FROZEN-SECOND");
  expect(pages.join("\n")).not.toContain("UNREAD-LATEST");
  // A stale refusal (not a missing-handle refusal) proves the OLD commit was recorded.
  expect(edit("K2@2").results[0]).toContain("current: K2@3");
  expect(edit("K2@3").results[0]).toContain("knowledge was not read");
  expect(edit("K2").results[0]).toContain("exact read K@commit is required; current tips: K2@3");
  other.tools[0]!.execute({ address: "K2" });
  expect(edit("K2@3").committed[0].commit).toBe(4);
  expect(memory.store.getKnowledgeRevision(2, 4)?.parentId).toBe(3);
});

test("41a: project/current defaults, version expansion and exact addresses preserve read scope", () => {
  const { c, d, edit } = commitPaths();
  edit(c, "FILTER-C"); edit(d, "FILTER-D");
  const current = memory.search("FILTER", "knowledge", c);
  expect(current).toContain("[K1@2]");
  expect(current).not.toContain("[K1@3]");
  expect(current).toContain("searched: project sessions; global/project/session knowledge, current versions");
  const history = memory.search("", "knowledge", { ...c, versions: "history" });
  expect(history).not.toContain("[K1@1]"); expect(history).toContain("[K1@2]"); expect(history).not.toContain("[K1@3]");
  const all = memory.search("", "knowledge", { ...c, versions: "all" });
  expect(all).toContain("[K1@2]");
  for (const commit of [1, 3]) expect(all).not.toContain(`[K1@${commit}]`);
  const trace = memory.trace("K1", c);
  expect(trace).toContain("K1 path current: K1@2");
  expect(trace).not.toContain("Applicable history on this path:");
  expect(memory.trace("K1", { ...c, versions: "history" })).toContain("Applicable history on this path:");
  expect(memory.trace("K1", { ...c, versions: "all" })).toContain("Other branches' tips:");
  expect(memory.trace("K1@3", c)).toContain("FILTER-D");
  expect(memory.trace("K1@2..K1@3", c)).toContain("[-C-]{+D+}");
});

test("41a: category and unified scope filter candidates and cursor options are frozen", () => {
  const { root, c, peer } = commitPaths();
  const sameProject = peer(), foreign = peer(memory.store.createProject({ name: "foreign-41a", declaredBy: "mark" }).id);
  const create = (who: typeof root, text: string, category: "open" | "reference", scope: "project" | "global") =>
    who.write([{ op: "create", text, category, scope, supports: [who.fact], reason: "41a fixture", topics: [] }]).committed[0];
  const shared = create(sameProject, "SAME-PROJECT-41A", "open", "project");
  const global = create(foreign, "FOREIGN-GLOBAL-41A", "reference", "global");
  const search = c.tools.find(tool => tool.name === "search")!;
  const facts = search.execute({ query: "main", layer: "facts" });
  expect(facts).toContain(`[F${sameProject.fact.slice(1)}]`);
  expect(facts).not.toContain(`[F${foreign.fact.slice(1)}]`);
  expect(search.execute({ query: "main", layer: "facts", scope: "global" })).toContain(`[F${foreign.fact.slice(1)}]`);
  expect(search.execute({ query: "41A", category: "open" })).toContain(`[K${shared.knowledgeId}@${shared.commit}]`);
  expect(search.execute({ query: "41A", category: "open" })).not.toContain(`[K${global.knowledgeId}@${global.commit}]`);
  expect(search.execute({ query: "FOREIGN-GLOBAL", layer: "knowledge" })).toContain(`[K${global.knowledgeId}@${global.commit}]`);
  expect(search.execute({ query: "FOREIGN-GLOBAL", layer: "knowledge", scope: "session" })).not.toContain(`[K${global.knowledgeId}@${global.commit}]`);
  expect(search.execute({ query: "41A", layer: "facts", category: "open" })).toContain("rejected: category filter requires layer knowledge");
  let page = search.execute({ query: "", layer: "knowledge", versions: "all", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(page)![1]!;
  expect(search.execute({ query: "", cursor, versions: "history" })).toContain("rejected: cursor versions is frozen");
  page = search.execute({ query: "", cursor, versions: "all" });
  expect(page).not.toContain("rejected:");
});

test("41b: search previews budget text independently of long fact evidence metadata", () => {
  const { c } = commitPaths();
  const receipt = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: c.sessionId, branch: c.branch, createdAt: time },
    facts: [{ turnId: c.headTurnId, category: "observation", actor: "user", text: "PREVIEW-FACT " + "word ".repeat(300),
      quote: "quote ".repeat(2000), source: [`T${c.headTurnId}#user`], createdAt: time }], entryIds: [] });
  if (!receipt.ok) throw new Error(receipt.problems.join("; "));
  const factId = receipt.facts[0]!.id;
  const search = c.tools.find(tool => tool.name === "search")!;
  const preview = search.execute({ query: "PREVIEW-FACT", layer: "facts" });
  expect(preview).toContain(`[F${factId}] [observation/user]`);
  expect(preview).toContain("characters truncated");
  expect(preview).not.toContain("quote:"); expect(preview).not.toContain("source:");
  expect(preview).toContain("preview: text only");
  expect(preview.split("\n").filter((line: string) => line.startsWith(`[F${factId}]`))).toHaveLength(1);
  const tiny = search.execute({ query: "PREVIEW-FACT", layer: "facts", itemBudget: 1 });
  expect(tiny).toContain(`[F${factId}] [observation/user] [...`);
});

test("41 review: fact and knowledge previews are one physical line with head-only Unicode-safe cuts", () => {
  const { c } = commitPaths();
  const longFactText = "FACT-LONG-41 " + "alpha 😀 ".repeat(180) + "\nFACT-LONG-TAIL";
  const factReceipt = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: c.sessionId, branch: c.branch, createdAt: time },
    facts: [{ turnId: c.headTurnId, category: "observation", actor: "user", text: longFactText,
      source: [`T${c.headTurnId}#user`], createdAt: time }], entryIds: [] });
  if (!factReceipt.ok) throw new Error(factReceipt.problems.join("; "));
  const factId = factReceipt.facts[0]!.id;
  const longKnowledgeText = "KNOWLEDGE-LONG-41 " + "beta 🚀 ".repeat(180) + "\nKNOWLEDGE-LONG-TAIL";
  const created = c.write([{ op: "create", text: longKnowledgeText, category: "reference", scope: "project",
    supports: [c.fact], topics: ["metadata\nline"], reason: "reason\nline" }]).committed[0];
  const search = c.tools.find(tool => tool.name === "search")!;
  const hit = (result: string) => result.split("\n\nReceipts:")[0]!;

  const fact = hit(search.execute({ query: "FACT-LONG-41", layer: "facts" }));
  expect(fact).not.toContain("\n"); expect(fact).toContain("characters truncated"); expect(fact).not.toContain("FACT-LONG-TAIL");
  const knowledge = hit(search.execute({ query: "KNOWLEDGE-LONG-41", layer: "knowledge" }));
  expect(knowledge).not.toContain("\n"); expect(knowledge).toContain("characters truncated"); expect(knowledge).not.toContain("KNOWLEDGE-LONG-TAIL");

  const fullFact = hit(search.execute({ query: "FACT-LONG-41", layer: "facts", itemBudget: null }));
  expect(fullFact).not.toContain("\n"); expect(fullFact).toContain(" ⏎ FACT-LONG-TAIL"); expect(fullFact).toContain("😀");
  const fullKnowledge = hit(search.execute({ query: "KNOWLEDGE-LONG-41", layer: "knowledge", versions: "history",
    itemBudget: null, fields: ["text", "topics", "reason", "status"] }));
  expect(fullKnowledge).not.toContain("\n"); expect(fullKnowledge).toContain(" ⏎ KNOWLEDGE-LONG-TAIL");
  expect(fullKnowledge).toContain('topics: ["metadata\\nline"]'); expect(fullKnowledge).toContain("reason: reason ⏎ line");
  expect(hit(search.execute({ query: "FACT-LONG-41", layer: "facts", itemBudget: 1 }))).toMatch(/^\[F\d+\] \[observation\/user\] \[\.\.\. \d+ characters truncated\]$/);
  expect(hit(search.execute({ query: "KNOWLEDGE-LONG-41", layer: "knowledge", itemBudget: 1 }))).toMatch(/^\[K\d+@\d+\] \[reference\/project\] \[\.\.\. \d+ characters truncated\]$/);

  expect(memory.trace(`F${factId}`, { itemBudget: null, pageBudget: null })).toContain(longFactText);
  expect(memory.trace(`K${created.knowledgeId}@${created.commit}`, { itemBudget: null, pageBudget: null })).toContain(longKnowledgeText);
});

test("41b: fields control knowledge trace and only actual complete text delivery grants a handle", () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  const reader = memory.tools({ kind: "manual", sessionId: other.sessionId, currentTurnId: other.headTurnId, branch: "reader-41b", triggerEntryId: other.triggerEntryId });
  const write = (tools: typeof reader, text: string) => JSON.parse(tools[3]!.execute({ operations: [{ op: "update", id: "K1@1",
    ...content(other.fact, text), topics: [], reason: "41b update" }], skipped: [] }));
  const noText = reader[0]!.execute({ address: "K1@1", fields: ["supports", "reason"] });
  expect(noText).toContain("change supports"); expect(noText).not.toContain("Use blue tiles"); expect(noText).not.toContain("reason:");
  expect(write(reader, "NO-TEXT-FAIL").results[0]).toContain("knowledge was not read");
  reader[1]!.execute({ query: "Use blue tiles", layer: "knowledge", itemBudget: null, fields: ["text", "supports"] });
  expect(write(reader, "SEARCH-FAIL").results[0]).toContain("knowledge was not read");
  reader[0]!.execute({ address: "K1@1" });
  expect(write(reader, "FINITE-COMPLETE").committed[0].commit).toBe(2);
  const fresh = peer();
  const freshTools = memory.tools({ kind: "manual", sessionId: fresh.sessionId, currentTurnId: fresh.headTurnId, branch: "full-reader-41b", triggerEntryId: fresh.triggerEntryId });
  freshTools[0]!.execute({ address: "K1@2", full: true });
  const committed = JSON.parse(freshTools[3]!.execute({ operations: [{ op: "update", id: "K1@2", ...content(fresh.fact, "FULL-COMPLETE"), topics: [], reason: "41b full" }], skipped: [] }));
  expect(committed.committed[0].commit).toBe(3);
  expect(root.tools[0]!.execute({ address: "K1@1", versions: "all", fields: ["reason"] })).not.toContain("reason:");
  expect(root.tools[0]!.execute({ address: "K1", versions: "history", fields: ["reason"] })).toContain("reason:");
});

test("41 review: search history defaults show existing statuses while current and explicit fields stay compact", () => {
  const { c, d, edit } = commitPaths();
  edit(c, "SEARCH-STATUS-C"); edit(d, "SEARCH-STATUS-D");
  const path = { sessionId: c.sessionId, headTurnId: c.headTurnId, branch: c.branch };
  const hits = (result: string) => result.split("\n\nReceipts:")[0]!;

  const current = memory.search("", "knowledge", path);
  expect(current).toContain("[K1@2]"); expect(current).not.toContain("status:");
  expect(current).toContain("preview: text only");
  const history = memory.search("", "knowledge", { ...path, versions: "history" });
  expect(history).not.toContain("[K1@1]");
  expect(memory.search("Use blue tiles", "knowledge", { ...path, versions: "history" })).toContain("status: superseded on this path by K1@2");
  expect(history).toContain("[K1@2]"); expect(history).toContain("status: current on this path");
  expect(history).toContain("preview: fields text, status");
  const all = memory.search("", "knowledge", { ...path, versions: "all" });
  expect(all).not.toContain("[K1@3]");
  expect(memory.search("SEARCH-STATUS-D", "knowledge", { ...path, versions: "all" })).toContain("status: another branch");

  const textOnly = memory.search("", "knowledge", { ...path, versions: "all", fields: ["text"] });
  expect(textOnly).not.toContain("status:"); expect(textOnly).toContain("preview: text only");
  const identityOnly = memory.search("", "knowledge", { ...path, versions: "all", fields: [] });
  expect(hits(identityOnly)).toBe("[K1@2] [constraint/project]");
  expect(identityOnly).toContain("preview: identity only"); expect(identityOnly).toMatch(/omitted fields: .*status/);

  c.write([{ op: "create", text: "SECOND-STATUS", category: "reference", scope: "project", supports: [c.fact], topics: [], reason: "Cursor fixture." }]);
  const first = memory.search("", "knowledge", { ...path, versions: "all", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  expect(memory.search("", "knowledge", { ...path, cursor, fields: ["text", "status"], cap: 1 })).not.toContain("unknown or expired cursor");
  const changed = memory.search("", "knowledge", { ...path, versions: "all", cap: 1 });
  const changedCursor = /cursor=(\S+)/.exec(changed)![1]!;
  expect(() => memory.search("", "knowledge", { ...path, cursor: changedCursor, fields: ["text"], cap: 1 })).toThrow("cursor fields is frozen");
  expect(memory.search("", "knowledge", { ...path, cursor: changedCursor, cap: 1 })).not.toContain("unknown or expired cursor");

  const factCurrent = hits(memory.search("C", "facts", path));
  expect(hits(memory.search("C", "facts", { ...path, versions: "all" }))).toBe(factCurrent);
  const rawCurrent = hits(memory.search("C", "raw", path));
  expect(hits(memory.search("C", "raw", { ...path, versions: "all" }))).toBe(rawCurrent);

  const archived = c.write([{ op: "create", text: "ARCHIVE-STATUS", category: "constraint", scope: "project",
    supports: [c.fact], topics: [], reason: "Archive status fixture." }]).committed[0];
  c.read(`K${archived.knowledgeId}@${archived.commit}`);
  c.write([{ op: "archive", id: `K${archived.knowledgeId}@${archived.commit}`, supports: [c.fact], reason: "Archive status fixture." }]);
  expect(memory.search("ARCHIVE-STATUS", "knowledge", { ...path, versions: "history" })).toContain("status: archived on this path");

  const searchFields = (toolDefinitions.find(tool => tool.name === "search")!.parameters.properties as Record<string, any>).fields;
  expect(searchFields).not.toHaveProperty("default");
});

test("41 review: history defaults include reasons and partition applicable from other branches", () => {
  const { root, c, d, edit, content } = commitPaths();
  edit(c, "HISTORY-C"); edit(d, "HISTORY-D");
  const linear = root.write([{ op: "create", ...content(root.fact, "LINEAR-HISTORY"), topics: [], reason: "Linear reason." }]).committed[0];
  const path = { sessionId: c.sessionId, headTurnId: c.headTurnId, branch: c.branch };

  expect(memory.trace("K1", path)).not.toContain("reason:");
  expect(memory.trace("K1@1", { ...path, versions: "history" })).not.toContain("reason:");
  const history = memory.trace("K1", { ...path, versions: "history" });
  expect(history.match(/^  K1@\d+ .* reason: /gm)).toHaveLength(2);
  const all = memory.trace("K1", { ...path, versions: "all" });
  expect(all).toContain("[K1@2] [constraint/project] HISTORY-C");
  expect(all).not.toContain("All branch commits:");
  expect(all).toContain("Other branches' commits:");
  const applicableSection = all.split("Applicable history on this path:")[1]!.split("Other branches' tips:")[0]!;
  const otherSection = all.split("Other branches' commits:")[1]!;
  const commits = (section: string, knowledgeId = 1) => [...section.matchAll(new RegExp(`^  K${knowledgeId}@(\\d+)`, "gm"))].map(match => Number(match[1]));
  const applicable = commits(applicableSection), other = commits(otherSection);
  expect(applicable).toEqual([1, 2]); expect(other).toEqual([3]);
  expect(new Set([...applicable, ...other])).toEqual(new Set([1, 2, 3]));
  expect(applicable.some(commit => other.includes(commit))).toBe(false);

  const noOtherBranch = memory.trace(`K${linear.knowledgeId}`, { ...path, versions: "all" });
  expect(commits(noOtherBranch.split("Applicable history on this path:")[1]!.split("Other branches' tips:")[0]!, linear.knowledgeId)).toEqual([linear.commit]);
  expect(commits(noOtherBranch.split("Other branches' commits:")[1]!, linear.knowledgeId)).toEqual([]);
  expect(noOtherBranch.match(new RegExp(`^  K${linear.knowledgeId}@${linear.commit}`, "gm"))).toHaveLength(1);

  expect(memory.trace("K1", { ...path, versions: "history", fields: ["text"] })).not.toContain("reason:");
  expect(memory.trace("K1", { ...path, versions: "history", fields: ["reason"] })).toContain("reason:");
  expect(memory.trace("K1..", { fields: ["text"] })).not.toContain("reason:");
  expect(memory.trace("K1..").match(/^  K1@\d+ .* reason: /gm)).toHaveLength(3);

  const first = memory.trace("K1", { ...path, versions: "history", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  const defaults = ["text", "supports", "topics", "status", "links", "marks", "reason"] as const;
  expect(memory.trace(`cursor=${cursor}`, { ...path, versions: "history", fields: defaults, cap: 1 })).not.toContain("unknown or expired cursor");
  const changed = memory.trace("K1", { ...path, versions: "history", cap: 1 });
  const changedCursor = /cursor=(\S+)/.exec(changed)![1]!;
  expect(() => memory.trace(`cursor=${changedCursor}`, { ...path, fields: defaults.slice(0, -1), cap: 1 })).toThrow("cursor fields is frozen");
  expect(memory.trace(`cursor=${changedCursor}`, { ...path, cap: 1 })).not.toContain("unknown or expired cursor");
  const traceFields = (toolDefinitions.find(tool => tool.name === "trace")!.parameters.properties as Record<string, any>).fields;
  expect(traceFields).not.toHaveProperty("default");
});

test("41 repair: knowledge search shows requested reasons only for history and all previews", () => {
  const { c, d, edit } = commitPaths();
  edit(c, "REASON-TEXT-C"); edit(d, "REASON-TEXT-D");
  const current = memory.search("", "knowledge", { ...c, fields: ["reason"] });
  expect(current).not.toContain("reason:");
  expect(current).toContain("preview: identity only");
  expect(current).toMatch(/omitted fields: .*reason/);

  const history = memory.search("", "knowledge", { ...c, versions: "history", fields: ["reason"] });
  expect(history).not.toContain("reason: Initial admission of this conclusion.");
  expect(memory.search("Use blue tiles", "knowledge", { ...c, versions: "history", fields: ["reason"] })).toContain("reason: Initial admission of this conclusion.");
  expect(history).toContain("reason: Substantive correction of the recorded conclusion.");
  expect(history).not.toContain("REASON-TEXT-C");
  expect(history).toContain("preview: fields reason; omitted fields:");
  expect(history.match(/reason:/g)).toHaveLength(1);

  const mixed = memory.search("", "knowledge", { ...c, versions: "all", fields: ["text", "reason"] });
  expect(mixed).toContain("REASON-TEXT-C");
  expect(mixed).not.toContain("REASON-TEXT-D");
  expect(mixed.match(/reason: Substantive correction of the recorded conclusion\./g)).toHaveLength(1);
  expect(memory.search("REASON-TEXT-D", "knowledge", { ...c, versions: "all", fields: ["reason"] })).toContain("reason: Substantive correction of the recorded conclusion.");
  expect(mixed).toContain("preview: fields text, reason; omitted fields:");

  const longReason = "because ".repeat(200).trim();
  c.write([{ op: "create", ...{ text: "LONG-REASON-TEXT", category: "constraint", scope: "project", supports: [c.fact] },
    topics: [], reason: longReason }]);
  const long = memory.search("LONG-REASON-TEXT", "knowledge", { ...c, versions: "history", fields: ["text", "reason"] });
  expect(long).toContain("characters truncated");
  expect(long).toContain(`reason: ${longReason}`);
});

test("41b: fields and budgets freeze across pages; public pages cap at 8000 while internal null remains", () => {
  const { c, content } = commitPaths();
  c.write(["SECOND-41B", "THIRD-41B"].map(text => ({ op: "create", ...content(c.fact, text), topics: [], reason: "41b fixture" })));
  const search = c.tools.find(tool => tool.name === "search")!, trace = c.tools.find(tool => tool.name === "trace")!;
  expect(search.execute({ query: "", layer: "knowledge", maxTokens: 8001 })).toContain("rejected: maxTokens");
  expect(trace.execute({ address: "K1", pageBudget: 8001 })).toContain("rejected: pageBudget");
  const searchProperties = search.parameters.properties as Record<string, unknown>, traceProperties = trace.parameters.properties as Record<string, unknown>;
  expect(searchProperties.maxTokens).toMatchObject({ maximum: 8000, default: 2000 });
  expect(traceProperties.pageBudget).toMatchObject({ maximum: 8000, default: 2000 });
  let page = search.execute({ query: "", layer: "knowledge", versions: "all", fields: ["text", "supports"], itemBudget: 20, cap: 1 });
  const cursor = /cursor=(\S+)/.exec(page)![1]!;
  expect(search.execute({ query: "", cursor, fields: ["text"] })).toContain("rejected: cursor fields is frozen");
  expect(search.execute({ query: "", cursor, itemBudget: 21 })).toContain("rejected: cursor itemBudget is frozen");
  page = search.execute({ query: "", cursor });
  expect(page).not.toContain("rejected:");
  expect(memory.trace("K1@1", { pageBudget: null })).toContain("[K1@1]");
});

test("34a: recursive parent scope bounds first-prompt injection and path reads", () => {
  const { root, peer, content } = commitPaths();
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: root.read(), ...content(root.fact, "Shared globally"), scope: "global" }]);
  const outsideProject = memory.store.createProject({ name: "outside", declaredBy: "mark" });
  const outside = peer(outsideProject.id);
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: root.read(), ...content(root.fact, "Project only") }]);
  expect(memory.inject({ projectId: outsideProject.id })).not.toContain("K1@");
  expect(memory.trace("K1", outside).split("\n")[0]).toBe("K1 path current: none");
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: root.read(), ...content(root.fact, "Session only"), scope: "session" }]);
  const ownProject = memory.store.getSession(root.sessionId)!.projectId;
  expect(memory.inject({ projectId: ownProject })).toContain("K1@3");
  expect(memory.inject({ projectId: outsideProject.id })).not.toContain("K1@");
  expect(memory.inject(root)).toContain("K1@4");
});

test("2026-09-07: commit schema removes mutable heads and binds parents, links and marks to global ids", () => {
  const { root, content } = commitPaths();
  root.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact, "Another identity") }]);
  const columns = (table: string) => memory.store.db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  expect(columns("knowledge")).not.toContain("status"); expect(columns("knowledge")).not.toContain("current_revision");
  expect(columns("knowledge_revisions")).not.toContain("rev"); expect(columns("knowledge_revisions")).toContain("parent_id");
  expect(memory.store.getKnowledgeRevision(2, 2)?.id).toBe(2); expect(memory.store.getKnowledgeRevision(2, 1)).toBeNull();
  for (const sql of [
    "INSERT INTO knowledge_links VALUES (1, 2, 'merged_into', 1, 1)",
    "INSERT INTO knowledge_links VALUES (1, 1, 'merged_into', 1, 2)",
    "INSERT INTO knowledge_marks VALUES (1, 2, 'verified', 'now')",
    "UPDATE knowledge_revisions SET parent_id = 999 WHERE id = 1",
  ]) expect(() => memory.store.db.exec(sql)).toThrow(/FOREIGN KEY/);
  expect(memory.store.mark(2, "verified")).toBe(2);
  expect(memory.store.listKnowledgeMarks(2)).toMatchObject([{ commitId: 2 }]);
});

test("2026-09-07 A/B: Consolidation, NEAR and accounting use every current tip on the frozen path", async () => {
  const { root, c, d, peer, content, edit } = commitPaths();
  edit(c, "Use blue tiles on C"); edit(d, "Use blue tiles on D");
  const third = peer();
  const integrate = async (path: typeof third, expected: number[]) => {
    memory.close();
    memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
      const input = raw as import("../../../src/core/api/index.ts").ConsolidationAgentInput;
      expect(input.readKnowledgeCommits.map(r => r.commit)).toEqual(expected);
      for (const id of expected) expect(input.material.knowledge.map(g => g.text).join("\n")).toContain(`[K1@${id}]`);
      const batch = { operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(path.fact, "Use blue tiles") }], skipped: [] };
      input.reportRequest({ round: 1 });
      const first = JSON.parse(input.tools[3]!.execute(batch));
      for (const id of expected) expect(first.feedback.content).toContain(`[K1@${id}]`);
      if (expected.length > 1) for (const id of expected) expect(first.feedback.content).toContain(`-> K1@${id}`);
      input.reportRequest({ round: 2 });
      const result = JSON.parse(input.tools[3]!.execute(batch));
      expect(result.committed).toHaveLength(1);
      return { outcome: "success", request: { round: 2 }, output: "done" };
    });
    recorded(memory, path.sessionId, path.branch, path.headTurnId); // recorded up to the head: its facts may enter the batch
    return memory.consolidate({ sessionId: path.sessionId, branch: path.branch, headTurnId: path.headTurnId });
  };
  const result = await integrate(third, [2, 3]);
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.diagnostics.some(d => d.kind === "uncited_facts")).toBe(false);
  // A sibling's support cannot cover this branch's user fact during accounting.
  memory.close();
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as import("../../../src/core/api/index.ts").ConsolidationAgentInput;
    const own = input.readKnowledgeCommits.filter(r => r.knowledgeId === 1);
    expect(own.map(r => r.commit)).toEqual([2]);
    const batch = { operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@2", ...content(root.fact) }], skipped: [] };
    input.reportRequest({ round: 1 }); input.tools[3]!.execute(batch);
    input.reportRequest({ round: 2 }); input.tools[3]!.execute(batch);
    return { outcome: "success", request: { round: 2 }, output: "done" };
  });
  recorded(memory, c.sessionId, c.branch, c.headTurnId);
  const cResult = await memory.consolidate({ sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId });
  if (cResult.outcome !== "success") throw new Error("expected success");
  expect(cResult.diagnostics).not.toContainEqual({ kind: "uncited_facts", facts: [c.fact] });
});

test("2026-09-07 B: stale absorbed bases name the surviving current commit across merge links", () => {
  const { root, peer, content } = commitPaths();
  expect(root.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }]).committed[0].commit).toBe(2);
  const other = peer();
  other.read("K2@2");
  expect(root.write([{ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", id: root.read(), absorb: [root.read("K2")], ...content(root.fact) }]).committed[0].commit).toBe(3);
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: root.read(), ...content(root.fact) }]);
  const rejected = other.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K2@2", ...content(other.fact) }]);
  expect(rejected.results[0]).toContain("current: K1@4");
  expect(memory.store.getKnowledge(2)).not.toBeNull();
  expect(memory.store.currentCommit(2, other)).toEqual([]);
});

test("16b: path trace separates applicable history, parents, children and sibling tips", () => {
  const { root, c, d, edit } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  const trace = memory.trace("K1", { ...c, versions: "all" });
  expect(trace).toContain("K1 path current: K1@2");
  expect(trace).toContain("parents: K1@1");
  const [history, others] = trace.split("Applicable history on this path:")[1]!.split("Other branches' tips:");
  expect(history).toContain("K1@1 create"); expect(history).toContain("K1@2 update"); expect(history).not.toContain("K1@3");
  expect(others).toContain("[K1@3]");
  expect(memory.trace("K1", root)).toContain("K1 path current: K1@1");
  const tree = memory.trace("K1..");
  expect(tree).toContain("children: K1@2, K1@3");
  for (const id of [1, 2, 3]) expect(tree).toContain(`[K1@${id}]`);
  expect(memory.trace("K1").split("\n")[0]).not.toMatch(/current/i);
  expect(memory.trace("K1@1")).toContain("children: K1@2, K1@3");
});

test("16b: commit addresses are global, full diffs allow siblings and reverse order, missing stays missing", () => {
  const { c, d, edit } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  expect(memory.trace("K1@2..K1@3")).toContain("[-C-]{+D+} version");
  expect(memory.trace("K1@3..K1@2")).toContain("[-D-]{+C+} version");
  expect(memory.trace("K1@2..K1@2")).toContain("Commits: none");
  expect(memory.trace("K1@2..3")).toBe(memory.trace("K1@2..K1@3"));
  expect(memory.trace("K1@3..2")).toBe(memory.trace("K1@3..K1@2"));
  for (const address of ["K1@2..K2@3", "K1@2..", "K1@2..K1@9007199254740992"]) {
    expect(() => memory.trace(address)).toThrow("invalid trace address");
    expect(c.tools[0]!.execute({ address })).toContain("rejected: invalid trace address");
  }
  for (const address of ["K1@57", "K1@2..K1@57"]) {
    expect(() => memory.trace(address)).toThrow("does not exist");
    expect(c.tools[0]!.execute({ address })).toContain("does not exist");
  }
  expect(c.tools[0]!.execute({ address: "K1@3" })).toContain("D version");
  expect(c.tools[0]!.execute({ address: "K1.." })).toContain("D version");
});

test("16b: search notes describe the supplied path, including archives and unrestricted siblings", () => {
  const { root, c, d, edit } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  const hits = memory.search("", "knowledge", { ...c, versions: "all", fields: ["text", "status"] }).split("\n");
  expect(memory.search("Use blue tiles", "knowledge", { ...c, versions: "all" })).toContain("superseded on this path by K1@2");
  expect(hits.find(l => l.startsWith("[K1@2]"))).toContain("current on this path");
  expect(memory.search("D version", "knowledge", { ...c, versions: "all" })).toContain("another branch");
  expect(memory.search("C version", "knowledge", { ...root, versions: "all", fields: ["text", "status"] })).toContain("another branch");
  expect(c.tools[0]!.execute({ address: "K1" })).toContain("C version");
  expect(c.write([{ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: c.read(), supports: [c.fact] }]).committed[0].commit).toBe(4);
  expect(memory.search("C version", "knowledge", { ...c, versions: "history", fields: ["text", "status"] })).toContain("archived on this path");
  expect(memory.search("D version", "knowledge", { ...d, fields: ["text", "status"] })).toContain("current on this path");
});

test("16b: marks address commits, bare writes bind the path and reject multiple tips", () => {
  const { c, d, edit, peer } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  expect(memory.mark("K1", "verified", c)).toBe("K1@2: verified");
  expect(memory.mark("K1@3", "flagged", c)).toBe("K1@3: flagged");
  expect(memory.inject(c)).toContain("verified"); expect(memory.inject(c)).not.toContain("flagged");
  expect(memory.mark("K1@3", "clear", c)).toBe("K1@3: clear");
  expect(() => memory.mark("K1", "verified", peer())).toThrow("several tips");
  expect(() => memory.mark("K1@57", "verified", c)).toThrow("does not exist");
});

test("16b: branch carry fixture uses evidence ancestry, includes commits and raw; tags delimit and lines stay byte for byte", () => {
  const { c, d, node, edit } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  recorded(memory, c.sessionId, c.branch, c.headTurnId);
  const tail = memory.store.appendTurn({ sessionId: c.sessionId, parentTurnId: c.headTurnId, kind: "turn", userPrompt: "Unrecorded <work> & more", assistantText: "Pending", startedAt: time });
  node(c.sessionId, tail.id, c.branch); // Same branch label, but after the leaving position.
  const carry = memory.branchSummary(c.sessionId, c.branch, tail.id);
  expect(carry.match(/<branch_carry>/g)).toHaveLength(1);
  expect(carry.match(/<\/branch_carry>/g)).toHaveLength(1);
  expect(carry).toContain("Unrecorded <work> & more"); // never escaped (ruling 15:14)
  expect(carry).not.toContain("[F3]"); expect(carry).not.toContain("[F4]"); expect(carry).not.toContain("[K1@3]");
  expect(carry).toContain("[K1@1]"); expect(carry).toContain("[K1@2]");
  expect(carry).toMatchSnapshot();
});

test("16b: a fact whose only source is an injected compaction message lacks a raw source", () => {
  const { root, c, d } = commitPaths();
  const injected = memory.store.appendTurn({ sessionId: c.sessionId, parentTurnId: c.headTurnId, kind: "compaction", assistantText: "<knowledge>Only injected: violet tiles</knowledge>", startedAt: time });
  const tools = memory.tools({ kind: "manual", sessionId: c.sessionId, branch: c.branch, currentTurnId: injected.id });
  const before = memory.store.listSessionFacts(c.sessionId);
  const fact = { category: "observation", actor: "agent", text: "Only injected: violet tiles", source: [`T${injected.id}#assistant`] };
  expect(tools[2]!.execute({ facts: [fact] })).toContain("expected a raw source on the current branch");
  expect(tools[2]!.execute({ facts: [{ ...fact, source: [] }] })).toContain("rejected:");
  expect(tools[2]!.execute({ facts: [{ ...fact, source: [`T${d.headTurnId}#user`] }] })).toContain("expected a raw source on the current branch");
  expect(memory.store.listSessionFacts(c.sessionId)).toEqual(before);
  expect(tools[2]!.execute({ facts: [{ ...fact, text: "User required pnpm", source: [`T${root.headTurnId}#user`] }] })).toContain("ok: F");
});

test("16b: every raw source of a multi-source fact constrains carry, current and citations", () => {
  const { root, c, d, content } = commitPaths();
  memory.store.updateTurn(c.headTurnId, { assistantText: "Use violet tiles" });
  const turns = memory.store.pathTurns(c);
  const entries = memory.store.listSourceEntries(c.sessionId).filter(entry => turns.has(entry.turnId));
  memory.selectEntries(c.sessionId, c.branch, entries.map(entry => entry.id));
  const tools = memory.tools({ kind: "manual", sessionId: c.sessionId, branch: c.branch,
    currentTurnId: c.headTurnId, triggerEntryId: entries.at(-1)!.id });
  const fact = JSON.parse(tools[2]!.execute({ facts: [{ category: "decision", actor: "agent", text: "Use violet tiles", source: [`T${root.headTurnId}#user`, `T${c.headTurnId}#assistant`] }] })).factIds[0];
  const id = readHandle(tools, "K1");
  const updated = JSON.parse(tools[3]!.execute({ operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id, ...content(`F${fact}`, "Use violet tiles") }], skipped: [] }));
  expect(updated.committed[0].commit).toBe(2);
  for (const path of [root, d]) {
    expect(memory.branchSummary(path.sessionId, path.branch, path.headTurnId)).not.toContain(`[F${fact}]`);
    expect(memory.inject(path)).toContain("[K1@1]"); expect(memory.inject(path)).not.toContain("[K1@2]");
    expect(path.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(`F${fact}`) }]).results[0]).toContain("record an adoption fact on this path first");
  }
  expect(memory.branchSummary(c.sessionId, c.branch, c.headTurnId)).toContain(`[F${fact}]`);
  expect(memory.inject(c)).toContain("[K1@2]");
});

test("2026-09-07: R<n> renders a run as a summary, full adds tool rounds and raw previews, a missing run is rejected", async () => {
  const { s, t } = session();
  calls.length = 0;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const run = memory.store.listRuns(s.id).at(-1)!;
  const summary = memory.trace(`R${run.id}`);
  expect(summary.split("\n")[0]).toBe(`R${run.id} noting ${run.outcome} ${run.createdAt}`);
  expect(summary).toContain(`S${s.id} / branch main`); expect(summary).toContain("usage:"); expect(summary).toContain("problems:");
  expect(summary).not.toContain("request (preview");
  const full = memory.trace(`R${run.id}`, { full: true });
  expect(full).toContain("request (preview"); expect(full).toContain("response (preview");
  expect(() => memory.trace("R999")).toThrow("does not exist");
});

test("2026-09-07: R<n> shows the rejection reason of a manual write instead of claiming no problems", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "bad source", source: ["T999#user"] }] });
  const run = memory.store.listRuns(s.id).at(-1)!;
  expect(run.outcome).toBe("bounced");
  const summary = memory.trace(`R${run.id}`);
  expect(summary).not.toContain("problems: none");
  expect(summary).toMatch(/problems: .*(invalid source|rejected)/);
});

// ---- 20b 2026-09-08: three earlier rulings are superseded, recorded here by their own names ----

// 17b, 2026-09-08: "noting.batchTokens defaults to 50,000 compressed-view tokens". Superseded by
// ticket 20 on 2026-09-08: the Noting trigger and the batch ceiling are both 10,000 normal-view
// tokens. Ticket 20 also made that ceiling compact's inner Raw cap, and ticket 25 amendment 3
// (2026-09-09, 25c) supersedes that second half: a foreground backlog is not a Noter batch, so
// compact measures pending Raw against the shared episodic envelope alone. The 10,000 ceiling itself
// stands, for the phase it was always about.
test("20b 2026-09-08, second half superseded by 25c: the Noting batch ceiling is 10,000 and compact no longer shares it", async () => {
  expect(DEFAULT_CONFIG.noting.batchTokens).toBe(10_000);
  expect(DEFAULT_CONFIG.noting.triggerTokens).toBe(10_000);
  const { s, t } = session();
  const big = (id: string) => memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(4000), raw: "", calls: [] });
  for (const id of ["a", "b", "c", "d", "e", "f"]) big(id);
  // Over 12,000 view tokens (30: each entry is worth at most `render.entryTokens`, 2,000): over
  // `noting.batchTokens`, inside the compaction envelope. Before 25c this escalated on the inner
  // cap; the bounded views keep every entry, and the Noter's ceiling is not a knob compact reads at
  // all — moving it changes nothing here.
  expect(tokens(memory.pendingEntries(s.id, "main", t.id).map(e => renderEntry(e, memory.config.render).content).join("\n\n")))
    .toBeGreaterThan(DEFAULT_CONFIG.noting.batchTokens);
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(false);
  memory.config.noting.batchTokens = 50;
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(false);
  memory.config.noting.batchTokens = DEFAULT_CONFIG.noting.batchTokens;
  // The budgets compact still answers to are its three windows and their envelope (28a): below the
  // same Raw it is missed, and 30 left one thing to do about that — delegate to the native compaction.
  compactionWindows(1_000, 100, 100);
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(true);
  defaultWindows();
  // Noting is unchanged: its batch still stops at 10,000 and leaves the rest pending.
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const views = calls[0]!.material.entries.map(e => e.view);
  expect(tokens(views.join("\n\n"))).toBeLessThanOrEqual(DEFAULT_CONFIG.noting.batchTokens);
  expect(memory.pendingEntries(s.id, "main", t.id).length).toBeGreaterThan(0); // the rest waits; 50,000 would have taken it
});

// 25c, 2026-09-09: "compaction's two budgets are the knowledge cap and one shared 20,000-token
// episodic envelope, and nothing else". Superseded by ticket 28a: compaction has three material
// windows with 20k/10k/10k default baselines (32a/35d) — database-derived knowledge, pending facts
// (`compaction.factsTokens`) and pending Raw (`compaction.rawTokens`) — over one envelope that is
// their sum. `render.episodicBlockTokens` is not retired; it stayed the Noter's history envelope, and
// compaction no longer reads it. Required material is placed first and is never trimmed; what is left
// refills with recent consolidated facts and then recent already-extracted Raw.
test("28: three windows, one envelope — required material first, refills into the spare, never a trimmed pending window", () => {
  expect(DEFAULT_CONFIG.compaction).toEqual({ factsTokens: 10_000, rawTokens: 10_000, overflowTokens: 10_000 });
  expect(memory.knowledgeBudgets().injection).toBe(20_000);
  expect(DEFAULT_CONFIG.render.episodicBlockTokens).toBe(20_000); // untouched, and the Noter's
  expect(REMOVED_SETTINGS["render.episodicBlockTokens"]).toBeUndefined(); // nothing was retired here
  const { s, t } = session();
  // Pending facts and pending Raw of one path, plus one consolidated fact and one extracted entry.
  const write = (text: string, turnId = t.id) => {
    const tools = memory.tools({ kind: "manual", sessionId: s.id, currentTurnId: turnId, branch: "main" });
    return JSON.parse(tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text, source: [`T${turnId}#user`] }] })).factIds[0] as number;
  };
  const history = write("CONSOLIDATED HISTORY");
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "consolidation", createdAt: time },
    operations: [], consolidated: [history] });
  const pending = write("PENDING FACT");
  const extracted = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "done", turnId: t.id, role: "assistant", text: "EXTRACTED RAW", raw: "", calls: [] });
  expect(memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    facts: [], entryIds: memory.store.sourcePath(s.id, "main", t.id).map(e => e.id) }).ok).toBe(true);
  const open = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "open", turnId: t.id, role: "assistant", text: "PENDING RAW", raw: "", calls: [] });

  // Everything fits: required material and both refills, inside the 40,000-token envelope.
  const full = memory.compact(s.id, "main", t.id);
  const text = compacted(full), windows = charged(full);
  expect(windows.envelope).toBe(50_000);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  expect(text).toContain("CONSOLIDATED HISTORY"); // manual write has no frozen source set to prove completeness
  for (const marker of ["PENDING FACT", "PENDING RAW", "EXTRACTED RAW"]) expect(text).toContain(marker);
  // The Noter's envelope is not compact's: moving it changes not one byte here.
  memory.config.render.episodicBlockTokens = 40;
  expect(compacted(memory.compact(s.id, "main", t.id))).toBe(text);
  memory.config.render.episodicBlockTokens = DEFAULT_CONFIG.render.episodicBlockTokens;

  // No spare: the refills are gone and the required material is untouched — never trimmed to fit.
  compactionWindows(Math.max(1, windows.knowledge), windows.required.facts, windows.required.raw);
  const required = compacted(memory.compact(s.id, "main", t.id));
  expect(required).toContain("PENDING FACT"); expect(required).toContain("PENDING RAW");
  expect(required).not.toContain("CONSOLIDATED HISTORY"); expect(required).not.toContain("EXTRACTED RAW");
  expect(memory.pendingEntries(s.id, "main", t.id).map(e => e.id)).toEqual([open.id]);
  expect(memory.store.entryNoted(extracted.id)).toBe(true); // no processing was reset by any of it

  // Required material that does not fit even after lending delegates, naming the window and the
  // numbers; it never trims the pending window and never starts a worker (28b owns recovery).
  compactionWindows(10, 1, 1);
  const delegated = memory.compact(s.id, "main", t.id);
  expect("native" in delegated).toBe(true);
  expect("native" in delegated && delegated.reason).toContain("compaction.rawTokens");
  expect("text" in delegated).toBe(false);
  expect(calls).toHaveLength(0);
  defaultWindows();
});

test("45: Consolidator capacity is the frozen database policy and the retired config key is rejected", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, currentTurnId: t.id, branch: "main" });
  expect(tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Evidence", source: [`T${t.id}#user`] }] })).toContain("ok: F1");
  for (let i = 0; i < 12; i++) expect(tools[3]!.execute({ operations: [{ op: "create", topics: [],
    reason: "Durable rule", text: `Rule ${i}: ` + "word ".repeat(1_500), category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] })).toContain("committed");
  for (const override of [{ render: { knowledgeBlockTokens: 10_000 } }, { consolidation: { knowledgeTokens: 10_000 } }])
    expect(() => api.validateConfig(override as never)).toThrow(/Removed setting .*knowledge.*Tokens/);
  const config = api.validateConfig({});
  expect(config.consolidation).not.toHaveProperty("knowledgeTokens");
  const input = { sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" as const };

  setKnowledgeInjection(memory, 10_000);
  const admitted = freezeConsolidation(memory.store, input, config);
  expect(admitted.knowledgeCapacity).toBe(10_000);
  expect(admitted.prepared!.material.receipts.join("\n")).toContain("knowledge; expand:");
  expect(tokens(admitted.prepared!.text)).toBeGreaterThan(0);

  setKnowledgeInjection(memory, 20_000);
  const enlarged = freezeConsolidation(memory.store, input, config);
  expect(enlarged.knowledgeCapacity).toBe(20_000);
  expect(enlarged.prepared!.supplied.knowledgeCommitIds.length).toBeGreaterThan(admitted.prepared!.supplied.knowledgeCommitIds.length);
  // The earlier task owns its already-rendered policy snapshot; a later Settings edit cannot mutate it.
  expect(admitted.knowledgeCapacity).toBe(10_000);
  expect(admitted.prepared!.material.receipts.join("\n")).toContain("knowledge; expand:");

  setKnowledgeInjection(memory, 5_000); // all three owner budgets are zero; only the fixed allowance remains
  const zeroOwners = freezeConsolidation(memory.store, input, config);
  expect(memory.knowledgeBudgets()).toMatchObject({ global: 0, project: 0, session: 0, injection: 5_000 });
  expect(zeroOwners.knowledgeCapacity).toBe(5_000);
  expect(zeroOwners.prepared!.supplied.knowledgeCommitIds.length).toBeLessThan(admitted.prepared!.supplied.knowledgeCommitIds.length);
});

// ---- 20c 2026-09-08: the compaction rule is superseded, recorded here by its own name ----

// The specification's "Compaction is instant and never calls a model" (spec.md; user story 6).
// Superseded by ticket 20 on 2026-09-08, and superseded ONLY by the native fallback: core still calls
// no model, and there is no summarizer inside core. When no complete representation of every selected
// entry fits, compact returns an explicit request for native compaction, and Pi's own compaction —
// which may call a model, and may fail or be cancelled — runs under Pi's outcome handling. Neither
// the bounded views nor any summary becomes a source, a fact or a receipt.
test("20c 2026-09-08: 'compaction never calls a model' is superseded only by Pi's native fallback, and core calls none", async () => {
  const { s, t } = session();
  const sources = memory.store.listSourceEntries(s.id).length;
  const pending = memory.pendingEntries(s.id, "main", t.id).map(e => e.id);
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(false);
  // Still local, deterministic work with more Raw: every entry is bounded by `render.entryTokens`.
  for (const id of ["a", "b", "c"]) memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(8000), raw: "", calls: [] });
  expect("native" in memory.compact(s.id, "main", t.id)).toBe(false);
  // Over the enclosing budget: the one route to a model, and it is Pi's, not core's (30 removed the
  // second rendering that used to stand between them).
  compactionWindows(1_000, 10, 10);
  const delegated = memory.compact(s.id, "main", t.id);
  expect("native" in delegated).toBe(true);
  expect(delegated).not.toHaveProperty("text"); // a request, never an empty or manufactured summary
  expect("native" in delegated && delegated.reason).toBeTruthy();
  expect(calls).toHaveLength(0); // nothing reached this façade's runAgent at all
  // Nothing changed the sources, the facts or the processing progress it read.
  expect(memory.store.listSourceEntries(s.id).length).toBe(sources + 3);
  expect(memory.store.listSessionFacts(s.id)).toHaveLength(0);
  expect(pending.length).toBeGreaterThan(0);
  expect(memory.pendingEntries(s.id, "main", t.id).map(e => e.id)).toEqual(expect.arrayContaining(pending));
  // Normal Noter input keeps using the same bounded views; the compact-only view exists nowhere else.
  defaultWindows();
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.material.entries.every(e => !e.view.includes("compact-only"))).toBe(true);
  expect(calls[0]!.text).not.toContain("compact-only");
});

// ---- 23 2026-09-09: the entry view's rulings, each recorded by the name it supersedes ----

// 17a, 2026-09-08: "arguments and result permanently reserve half each" of one call budget `B`. Ticket
// 23a superseded it with a quarter and three quarters; 23c (user, 2026-09-09) restored the halves.
// Ticket 30 supersedes the shared budget itself: a call part and a result part have independent
// allowances, `render.toolInputTokens` (`C`) and `render.toolResultTokens` (`R`), and neither is ever
// borrowed, swapped or averaged with the other. `render.entryTokens` (`E`) still binds the whole
// entry, however many parts it has.
test("30: one Raw entry view — C and R are independent, E binds the whole entry", () => {
  const { s, t } = session();
  const long = JSON.stringify({ command: "echo " + "a".repeat(20_000) });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: long, result: "b".repeat(20_000), status: "success" });
  const entries = memory.store.listSourceEntries(s.id);
  const of = (role: string) => entries.filter(e => e.role === role && e.calls.length).at(-1)!;
  const size = (role: string, profile: api.EntryProfile) => tokens(renderEntry(of(role), profile, memory.resultText).content);
  const profile = (entryTokens: number, toolInputTokens: number, toolResultTokens: number): api.EntryProfile =>
    ({ entryTokens, toolInputTokens, toolResultTokens });
  // The shipped profile gives each part its own 100, not two halves of one budget.
  expect([DEFAULT_CONFIG.render.toolInputTokens, DEFAULT_CONFIG.render.toolResultTokens]).toEqual([100, 100]);
  for (const role of ["assistant", "toolResult"]) {
    const filled = size(role, DEFAULT_CONFIG.render);
    expect([role, filled <= 100 && filled > 95]).toEqual([role, true]);
  }
  // Asymmetric budgets: what the other side does not use never enlarges this one.
  for (const [c, r] of [[50, 100], [100, 50], [1_000, 100], [100, 1_000]] as const) {
    const p = profile(100_000, c, r);
    expect([c, r, size("assistant", p) <= c && size("assistant", p) > c - 5]).toEqual([c, r, true]);
    expect([c, r, size("toolResult", p) <= r && size("toolResult", p) > r - 5]).toEqual([c, r, true]);
  }
  // `E` binds the whole entry: a tighter `E` cuts the same parts further, and every part still fits
  // its own cap. `C` and `R` are maxima inside `E`, never additions to it.
  for (const entryTokens of [60, 200, 2_000]) {
    for (const role of ["assistant", "toolResult"]) {
      const rendered = renderEntry(of(role), profile(entryTokens, 1_000, 1_000), memory.resultText).content;
      expect([entryTokens, role, tokens(rendered) <= entryTokens]).toEqual([entryTokens, role, true]);
    }
  }
});

// 17a, 2026-09-08: `toolCallTokens` defaulted to 1,000; ticket 23 made it 300 with 1,000 as a hard
// ceiling and kept `entryTokens` at 10,000. Superseded by ticket 30: the profile is `entryTokens`
// 2,000, `toolInputTokens` 100 and `toolResultTokens` 100, the ceiling still applies to each part
// budget, and the three retired keys fail by name with guidance instead of acquiring new meanings.
test("30: the shipped profile is 2,000/100/100 and the retired B and secondary keys fail by name", () => {
  expect(DEFAULT_CONFIG.render).toMatchObject({ entryTokens: 2_000, toolInputTokens: 100, toolResultTokens: 100 });
  expect(Object.keys(DEFAULT_CONFIG.render)).not.toContain("toolCallTokens");
  const open = (render: Record<string, number>) => sourceSeededMemory(join(directory, "ceiling.sqlite"), async () => ok([]), { render });
  expect(() => open({ toolInputTokens: 1_001 })).toThrow("Invalid render.toolInputTokens: at most 1000");
  expect(() => open({ toolResultTokens: 1_001 })).toThrow("Invalid render.toolResultTokens: at most 1000");
  const ceiling = open({ toolInputTokens: 1_000 });
  try { expect(ceiling.config.render.toolInputTokens).toBe(1_000); } finally { ceiling.close(); }
  for (const key of ["toolCallTokens", "secondaryToolCallTokens", "secondaryEntryTokens"]) {
    expect(REMOVED_SETTINGS[`render.${key}`]).toBeTruthy();
    expect(() => open({ [key]: 100 })).toThrow(`Removed setting render.${key}`);
  }
  // An explicitly configured `E` is honoured as written: nothing is halved, ignored or rewritten.
  const explicit = open({ entryTokens: 10_000 });
  try { expect(explicit.config.render.entryTokens).toBe(10_000); } finally { explicit.close(); }
  // 30 (GPT ruling 2026-09-10): the smaller views change no phase limit. The trigger, the batch
  // ceilings and the target limits keep their values, and no entry-count cap joins them. Noting's
  // lexical review threshold is an ordinary loaded setting beside them.
  expect(DEFAULT_CONFIG.noting).toEqual({ forkModeDefault: false, batchTokens: 10_000, triggerTokens: 10_000, nearThreshold: 0.40, maxToolRounds: 0 });
  expect(DEFAULT_CONFIG.consolidation).toMatchObject({ triggerTokens: 5_000, batchTokens: 10_000 });
  expect(api.validateConfig({ noting: { nearThreshold: 0 } }).noting.nearThreshold).toBe(0);
  expect(api.validateConfig({ noting: { nearThreshold: 1 } }).noting.nearThreshold).toBe(1);
  for (const invalid of [-0.001, 1.001, Infinity, Number.NaN])
    expect(() => api.validateConfig({ noting: { nearThreshold: invalid } })).toThrow("Invalid noting.nearThreshold");
});

// 28a "Windows": the two new compaction keys are ordinary token settings — the same finite positive
// integer validation, the same unknown-key rejection by name — and nothing existing was reinterpreted
// or silently retired to make room for them.
test("28a configuration: compaction.factsTokens and compaction.rawTokens are validated like every other token key", () => {
  const open = (compaction: Record<string, number>) => sourceSeededMemory(join(directory, "windows.sqlite"), async () => ok([]), { compaction } as never);
  expect(DEFAULT_CONFIG.compaction).toEqual({ factsTokens: 10_000, rawTokens: 10_000, overflowTokens: 10_000 });
  for (const key of ["factsTokens", "rawTokens", "overflowTokens"] as const) {
    expect(() => open({ [key]: 0 })).toThrow(`Invalid compaction.${key}: expected a positive safe integer`);
    expect(() => open({ [key]: 1.5 })).toThrow(`Invalid compaction.${key}: expected a positive safe integer`);
    const set = open({ [key]: 4_321 });
    try { expect(set.config.compaction[key]).toBe(4_321); } finally { set.close(); }
  }
  expect(() => open({ episodicBlockTokens: 100 })).toThrow("Unknown setting compaction.episodicBlockTokens");
  // Nothing lost a meaning here, so nothing joined the removed list; `render.episodicBlockTokens` is
  // still a live setting, now read only by the Noter's history envelope.
  expect(REMOVED_SETTINGS["render.episodicBlockTokens"]).toBeUndefined();
  expect(REMOVED_SETTINGS["compaction.factsTokens"]).toBeUndefined();
  const noter = sourceSeededMemory(join(directory, "noter.sqlite"), async () => ok([]), { render: { episodicBlockTokens: 12_345 } });
  try { expect(noter.config.render.episodicBlockTokens).toBe(12_345); } finally { noter.close(); }
});

// 20c, 2026-09-08: compaction's second tier was a separate compact-only renderer with its own version
// and its own excerpt rules; ticket 23 made it the one entry renderer under a tier-2 profile.
// Superseded by ticket 30: there is no second tier at all. Compaction renders the one bounded view of
// every selected entry, and a set that still does not fit delegates to the host's native compaction
// (28 amendment 9: no recovery worker here).
test("30: 23's tier-2 profile is superseded; compaction has one bounded view and the native delegation", () => {
  const { s, t } = session();
  for (const id of ["a", "b", "c"]) memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(8000), raw: "", calls: [] });
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false);
  const text = compacted(result);
  for (const entry of memory.pendingEntries(s.id, "main", t.id)) expect(text).toContain(renderEntry(entry, memory.config.render, memory.resultText).content);
  expect(text).toContain("\nRaw:\n");
  expect(text).not.toContain("tier-2 entry views"); // one view, one title
  expect(text).not.toContain("compact-only");
  expect("SECONDARY_VIEW_VERSION" in api).toBe(false); // the version constant went with the renderer
  expect("secondaryRawTitle" in api).toBe(false); // and the tier-2 block title went with the tier
  // The remaining escalation is the native one, and it names the cap it missed.
  compactionWindows(1_000, 100, 100);
  const delegated = memory.compact(s.id, "main", t.id);
  expect("native" in delegated && delegated.reason).toContain("compaction.rawTokens");
});

// 29a, 2026-09-10: a tier-2 compact view established no coverage, so `visibleView` recorded only
// tier-1 views. Superseded by ticket 30 "Visibility and fork": a marked compressed view is visible
// Raw whether or not it was truncated, and a retained view is never compared with the current
// profile to demand a richer replacement. Unmarked material still counts for nothing.
test("30: a marked compressed view is visible Raw; a budget change adds no richness gate", () => {
  const binding = { db: "db", session: 7, pi: "pi-1" };
  const carrier = (entries: unknown[]) => ({ id: "c", type: "compaction",
    details: { traceMemory: { ...binding, supplied: { entries, factIds: [], knowledgeCommitIds: [] } } } });
  // The one representation new writers emit, and both legacy tiers, are all visible Raw.
  const view = visibleView([carrier([
    { id: 1, nativeId: "e1", view: "bounded" },
    { id: 2, nativeId: "e2", tier: 1 },
    { id: 3, nativeId: "e3", tier: 2 },
  ])], binding);
  expect([...view.raw.keys()].sort()).toEqual(["e1", "e2", "e3"]);
  expect([...new Set(view.raw.values())]).toEqual(["view"]);
  // No richness gate: the same carrier counts under a much tighter and a much wider profile, because
  // nothing compares what it holds with what the current configuration would render.
  for (const render of [{ entryTokens: 40, toolInputTokens: 1, toolResultTokens: 1 }, { entryTokens: 100_000, toolInputTokens: 1_000, toolResultTokens: 1_000 }]) {
    const m = sourceSeededMemory(join(directory, "richness.sqlite"), async () => ok([]), { render });
    try { expect([...visibleView([carrier([{ id: 1, nativeId: "e1", view: "bounded" }])], binding).raw.keys()]).toEqual(["e1"]); }
    finally { m.close(); }
  }
  // Unmarked material still establishes nothing: a bare id, an unknown representation, a foreign
  // database's carrier, and a native compaction's own details.
  expect(visibleView([carrier([{ id: 4, nativeId: "e4" }, { nativeId: "e5", view: "bounded" }])], binding).raw.has("e4")).toBe(false);
  expect(visibleView([carrier([{ id: 6, nativeId: "e6", tier: 3 }])], binding).raw.has("e6")).toBe(false);
  expect(visibleView([{ id: "c", type: "compaction", details: { traceMemory: { db: "other", session: 7, pi: "pi-1",
    supplied: { entries: [{ id: 7, nativeId: "e7", view: "bounded" }], factIds: [], knowledgeCommitIds: [] } } } }], binding).raw.size).toBe(0);
  expect(visibleView([{ id: "c", type: "compaction", details: { readFiles: [], modifiedFiles: [] } }], binding).raw.size).toBe(0);
});

// 17b, 2026-09-08: "Consolidation triggers at fifty applicable unconsolidated committed facts" with
// no batch ceiling. Superseded by ticket 20 on 2026-09-08: 5,000 rendered fact tokens trigger it and
// one batch takes at most 10,000 of the same rendered representation.
test("20b 2026-09-08: 17b's fifty-fact Consolidation trigger and unbounded batch are superseded by 5,000 trigger tokens and a 10,000-token batch", () => {
  expect(DEFAULT_CONFIG.consolidation).toMatchObject({ triggerTokens: 5_000, batchTokens: 10_000 });
  expect("triggerUnconsolidatedFacts" in DEFAULT_CONFIG.consolidation).toBe(false);
  const { s, t } = session();
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: Array.from({ length: 60 }, (_, i) => ({ category: "observation", actor: "user", text: `claim ${i}`, source: [`T${t.id}#user`] })) });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  expect(memory.store.consolidationBatch(s.id, "main", t.id).length).toBeGreaterThan(50); // a count would be due
  expect(tokens(memory.store.consolidationBatch(s.id, "main", t.id).map(f => memory.trace(`F${f.id}`)).join("\n"))).toBeLessThan(5_000);
  expect(memory.taskEligibility("consolidation", target).due).toBe(false);
});

// 17b, 2026-09-08: the knowledge budget was a soft cap — constraints, open items and disputes were
// exempt from it. Superseded by ticket 20 and confirmed by the user on 2026-09-08: the cap is hard,
// constraints keep first priority inside it, and omitted items remain stored and traceable.
test("20b 2026-09-08: the knowledge-category soft-cap exemption is superseded; constraints keep first priority inside a hard cap", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  expect(tools.find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: [`T${t.id}#user`] }] })).toContain("ok: F1");
  const write = (category: string, text: string) => expect(tools.find(tool => tool.name === "memory")!
    .execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text, category, scope: "project", supports: ["F1"] }], skipped: [] })).toContain('"committed"');
  for (let i = 0; i < 6; i++) write("constraint", `constraint ${i} ` + "word ".repeat(1_000));
  write("reference", "reference tail");
  const cap = 5_000;
  setKnowledgeInjection(memory, cap);
  const injected = memory.inject(s.id);
  expect(injected).toContain("<constraint>"); // first priority, kept
  expect(injected).not.toContain("reference tail"); // lower priority, omitted
  expect(tokens(injected)).toBeLessThanOrEqual(cap); // the exemption is gone: no category bypasses it
  expect(injected).not.toContain("Receipts:"); // 34c foreground publication never emits omission-only accounting
  expect(memory.trace("K6")).toContain("[K6@"); // omitted is not deleted
  expect(t.id).toBeGreaterThan(0);
});

test("2026-09-07 superseded 2026-09-08 (17b): the Consolidation threshold triggers, the turn boundary no longer cuts; partly recorded Turns are eligible", async () => {
  const project = memory.store.createProject({ name: "batches", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const turns = [1, 2, 3, 4].map((i, _, arr) => memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: `t${i}`, assistantText: "ok", startedAt: time, parentTurnId: undefined }));
  for (let i = 1; i < turns.length; i++) memory.store.db.prepare("UPDATE turns SET parent_turn_id = ? WHERE id = ?").run(turns[i - 1]!.id, turns[i]!.id);
  const seed = (turn: number, n: number, kind: "noting" | "manual" = "noting") => memory.store.commitNotingRun({ run: { kind, sessionId: s.id, branch: "main", createdAt: time, rangeFrom: `S${s.id}/T${turn}`, rangeTo: `S${s.id}/T${turn}`, outcome: "success" } as never,
    facts: Array.from({ length: n }, (_, k) => ({ turnId: turn, category: "observation", actor: "user", text: `fact ${turn}.${k}`, source: [`T${turn}#user`], createdAt: time })) });
  seed(turns[0]!.id, 3); seed(turns[1]!.id, 3); seed(turns[2]!.id, 3);
  recorded(memory, s.id, "main", turns[2]!.id); // T1..T3 recorded, T4 (head) not yet
  seed(turns[3]!.id, 2, "manual"); // manual facts on the head being recorded
  const batch = memory.store.consolidationBatch(s.id, "main", turns[3]!.id);
  expect(batch.map(f => f.id)).toEqual(Array.from({ length: 11 }, (_, i) => i + 1));
  expect(batch.filter(f => f.turnId === turns[3]!.id)).toHaveLength(2);

});

test("2026-09-07 review: a late fact on an early turn does not make the batch skip pending facts of later turns", () => {
  const project = memory.store.createProject({ name: "late-facts", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const t1 = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "one", assistantText: "ok", startedAt: time, parentTurnId: undefined });
  const t2 = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "two", assistantText: "ok", startedAt: time, parentTurnId: t1.id });
  const seed = (turn: number, text: string) => memory.store.commitNotingRun({ run: { kind: "manual", sessionId: s.id, branch: "main", createdAt: time, rangeFrom: `S${s.id}/T${turn}`, rangeTo: `S${s.id}/T${turn}`, outcome: "success" } as never,
    facts: [{ turnId: turn, category: "decision", actor: "user", text, source: [`T${turn}#user`], createdAt: time }] });
  seed(t1.id, "early decision"); seed(t2.id, "later decision"); seed(t1.id, "late supplement to the early decision"); // F3 lands on T1 after F2 on T2
  // "Nothing before the first Noting" was superseded on 2026-09-08 by 17b.
  expect(memory.store.consolidationBatch(s.id, "main", t2.id).map(f => f.id)).toEqual([1, 2, 3]);
  recorded(memory, s.id, "main", t2.id);
  const first = memory.store.consolidationBatch(s.id, "main", t2.id);
  expect(first.map((f) => f.id)).toEqual([1, 2, 3]); // no Turn grouping
  expect(memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: time }, operations: [], consolidated: [1, 3] }).ok).toBe(true);
  expect(memory.store.consolidationBatch(s.id, "main", t2.id).map((f) => f.id)).toEqual([2]); // F2 is still pending, not skipped
});

test("18b 2026-09-08: a frozen manual boundary excludes entries and facts added after it was captured, even though they are on-path", async () => {
  const { s, t } = session();
  const entry1 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u1", turnId: t.id, role: "user", text: "first", raw: "first", calls: [] });
  memory.selectEntries(s.id, "main", [entry1.id]);
  const boundary = { maxEntryId: entry1.id }; // frozen before the second entry exists
  const t2 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "second", startedAt: time });
  const entry2 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u2", turnId: t2.id, role: "user", text: "second", raw: "second", calls: [] });
  memory.selectEntries(s.id, "main", [entry1.id, entry2.id]);
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t2.id, mode: "subagent", boundary });
  expect(result.outcome).toBe("success");
  expect(calls[0]!.entryIds).toEqual([entry1.id]); // the later on-path entry stays outside the frozen target
  expect(memory.pendingEntries(s.id, "main", t2.id).map(e => e.id)).toEqual([entry2.id]); // it remains pending

  // Same guarantee for Consolidation's frozen fact-id set.
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[2]!.execute({ facts: [
    { category: "observation", actor: "user", text: "Frozen fact", source: [`T${t.id}#user`] } ] });
  const frozenFacts = memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id);
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[2]!.execute({ facts: [
    { category: "observation", actor: "user", text: "Later fact", source: [`T${t.id}#user`] } ] });
  const cresult = await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent", boundary: { allowedFactIds: frozenFacts } });
  expect(cresult.outcome).toBe("success");
  if (cresult.outcome === "success") expect(cresult.range.facts.map(f => f.id)).toEqual(frozenFacts);
  expect(memory.store.consolidationBatch(s.id, "main", t.id)).toHaveLength(1); // the later fact stays outside the frozen target
});

// ---- 19c: the execution mode is fork; branch remains the evidence path (ticket 19 "Naming and compatibility") ----

test("19c 2026-09-08: the legacy branchModeDefault spelling is accepted, mapped onto forkModeDefault, and not kept", () => {
  const legacy = sourceSeededMemory(join(directory, "alias.sqlite"), async () => ok([]), { noting: { branchModeDefault: false } });
  try {
    expect(legacy.config.noting.forkModeDefault).toBe(false);              // the old key still selects the mode
    expect(Object.hasOwn(legacy.config.noting, "branchModeDefault")).toBe(false); // only the canonical key survives
  } finally { legacy.close(); }
  // Both spellings supplied and agreeing: the canonical one wins, silently.
  const agreeing = sourceSeededMemory(join(directory, "agreeing.sqlite"), async () => ok([]), { noting: { branchModeDefault: false, forkModeDefault: false } });
  try { expect(agreeing.config.noting.forkModeDefault).toBe(false); } finally { agreeing.close(); }
});

test("19c 2026-09-08: both execution-mode spellings with different values fail the load naming both keys", () => {
  const load = () => sourceSeededMemory(join(directory, "conflict.sqlite"), async () => ok([]), { noting: { branchModeDefault: true, forkModeDefault: false } });
  expect(load).toThrow(/noting\.branchModeDefault/);
  expect(load).toThrow(/noting\.forkModeDefault/);
  expect(load).toThrow(/Conflicting settings/);
});

test("24 amendment 2 2026-09-09, as 29e left it: configure replaces each phase's execution-mode default, validated like the load path, and nothing else", async () => {
  // A saved global preference must reach tasks admitted afterwards without a reload. Admission reads
  // its mode from the configuration frozen at construction, so exactly those two booleans may move —
  // 29e restored Consolidation's, which 25b had retired; every other key is still refused below.
  expect(memory.config.noting.forkModeDefault).toBe(false);
  memory.configure({ noting: { forkModeDefault: true } });
  expect(memory.config.noting.forkModeDefault).toBe(true);
  memory.configure({ noting: { forkModeDefault: false } });
  expect(memory.config.noting.forkModeDefault).toBe(false);
  expect(memory.config.noting.batchTokens).toBe(DEFAULT_CONFIG.noting.batchTokens); // nothing else moved
  // The other phase exposes the same key and also defaults to subagent.
  expect(memory.config.consolidation.forkModeDefault).toBe(false);
  memory.configure({ consolidation: { forkModeDefault: true } });
  expect(memory.config.consolidation.forkModeDefault).toBe(true);
  expect(memory.config.consolidation.batchTokens).toBe(DEFAULT_CONFIG.consolidation.batchTokens);
  memory.configure({ consolidation: { forkModeDefault: false } });
  // A task admitted after the call runs in the new mode; the run record keeps what it was launched with.
  const { s, t } = session();
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
  expect(memory.store.listRuns(s.id).at(-1)!.mode).toBe("subagent");
  // The load path's own rules: the legacy spelling is accepted and mapped, a bad type, a removed key
  // and any other section or key are refused by name — and a refusal changes nothing.
  memory.configure({ noting: { branchModeDefault: true } });
  expect(memory.config.noting.forkModeDefault).toBe(true);
  expect(() => memory.configure({ noting: { forkModeDefault: 1 as unknown as boolean } })).toThrow("Invalid noting.forkModeDefault");
  expect(() => memory.configure({ noting: { branchModeDefault: false, forkModeDefault: true } })).toThrow("Conflicting settings");
  expect(() => memory.configure({ noting: { batchTokens: 5 } })).toThrow("noting.batchTokens is not reconfigurable at runtime");
  expect(() => memory.configure({ render: { entryTokens: 5 } })).toThrow("Unknown setting render");
  expect(() => memory.configure({ consolidation: { triggerUnconsolidatedFacts: 5 } as never })).toThrow("Removed setting");
  expect(() => memory.configure({ consolidation: { forkModeDefault: 1 as unknown as boolean } })).toThrow("Invalid consolidation.forkModeDefault");
  expect(() => memory.configure({ noting: { nearThreshold: 0.5 } })).toThrow("noting.nearThreshold is not reconfigurable at runtime");
  expect(() => memory.configure({ consolidation: { nearThreshold: 0.5 } })).toThrow("consolidation.nearThreshold is not reconfigurable at runtime");
  expect(memory.config.noting.forkModeDefault).toBe(true);
  expect(memory.config.consolidation.nearThreshold).toBe(DEFAULT_CONFIG.consolidation.nearThreshold);
  expect(memory.config.render.entryTokens).toBe(DEFAULT_CONFIG.render.entryTokens);
});

// ---- 25 amendment 2 2026-09-09, as 29e superseded it: Consolidation has two execution modes again ----

test("25b/29e: the retired inverse Consolidation mode key is refused by name at load, in every configuration space", () => {
  // 25b removed the key; 29e restored the choice under `consolidation.forkModeDefault`. The old key
  // stays a removed setting rather than becoming an alias, because it is the INVERSE boolean: reading
  // a saved `true` as fork mode would switch the meaning of the value. A saved value of either
  // polarity fails the load naming the key and the one remedy. No file is rewritten.
  expect(REMOVED_SETTINGS["consolidation.subagentModeDefault"]).toBe("use consolidation.forkModeDefault (the inverse boolean: true means fork)");
  const message = `Removed setting consolidation.subagentModeDefault: ${REMOVED_SETTINGS["consolidation.subagentModeDefault"]}`;
  for (const saved of [true, false]) {
    const load = () => sourceSeededMemory(join(directory, `saved-${saved}.sqlite`), async () => ok([]), { consolidation: { subagentModeDefault: saved } as never });
    expect(load).toThrow(message);
    // The flat `section.key` space every host loads its settings files through, and the runtime surface.
    expect(() => canonicalFlatConfig({ "consolidation.subagentModeDefault": saved })).toThrow(message);
    expect(() => memory.configure({ consolidation: { subagentModeDefault: saved } as never })).toThrow(message);
  }
  expect(Object.hasOwn(DEFAULT_CONFIG.consolidation, "subagentModeDefault")).toBe(false); // and the menu that builds itself from the defaults shows it nowhere
  expect(DEFAULT_CONFIG.consolidation.forkModeDefault).toBe(false); // the restored key keeps this phase's existing default
});

test("29: Consolidation may fork; borrowed work, manual catchup and recovery workers stay subagent", async () => {
  const { s, t } = session();
  const note = (text: string) => memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text, source: [`T${t.id}#user`] }] });
  note("Keep pnpm");
  // 29e (parent 29 "Restore Consolidator fork without weakening review", superseding 25b): the mode
  // exists again, so an explicit request runs — neither refused by name nor normalized behind the
  // caller. The run record keeps it, as it always kept Noting's.
  expect((await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("fork");
  const forked = memory.store.listRuns(s.id).at(-1)!;
  expect([forked.kind, forked.mode]).toEqual(["consolidation", "fork"]);
  // The default is unchanged: a request that says nothing gets a subagent, because
  // `consolidation.forkModeDefault` is false. 29e restored the option, not a new default.
  note("Keep vitest");
  expect((await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
  expect(JSON.parse(memory.store.listRuns(s.id).at(-1)!.response!).requestedMode).toBe("subagent");
  // With the preference on, the same silent request forks.
  memory.configure({ consolidation: { forkModeDefault: true } });
  note("Keep sqlite");
  expect((await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("fork");
  // Borrowed closed-session work stays fresh-context whatever the preference says, exactly as
  // Noting's does: the façade replaces the mode of a borrowed task at its admission.
  const tail = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: memory.store.getSession(s.id)!.projectId });
  const tailTurn = memory.store.appendTurn({ sessionId: tail.id, kind: "turn", userPrompt: "closed tail", assistantText: "ok", startedAt: time });
  memory.tools({ kind: "manual", sessionId: tail.id, branch: "main", currentTurnId: tailTurn.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep esbuild", source: [`T${tailTurn.id}#user`] }] });
  memory.store.closeSession(tail.id);
  expect((await memory.consolidate({ sessionId: tail.id, branch: "main", headTurnId: tailTurn.id, borrowed: true, executorSessionId: s.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
  // A manual catchup asks for a subagent explicitly, beside the allowable fact set it froze (18b), and
  // ticket 28's recovery workers will reach this line the same way: the requested mode is what runs,
  // so the restored preference turns neither of them into a fork.
  note("Keep node:sqlite");
  const frozen = memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id);
  expect((await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent", boundary: { allowedFactIds: frozen } })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
});

test("25 amendment 2 2026-09-09: a stored fork-mode Consolidation run keeps its recorded mode and is never rewritten", async () => {
  const { s, t } = session();
  // A run this database recorded before the mode was retired, exactly as it was written then.
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", mode: "fork", model: "old/model",
    rangeFrom: "F1", rangeTo: "F1", createdAt: time }, operations: [] });
  const historical = memory.store.listRuns(s.id).at(-1)!.id;
  expect(memory.trace(`R${historical}`)).toContain("mode fork"); // read back as what it was, not relabelled
  // New work in the same database records the one mode and leaves the old row alone.
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  expect((await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(memory.store.getRun(historical)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).filter(r => r.kind === "consolidation").map(r => r.mode)).toEqual(["fork", "subagent"]);
});

test("19c 2026-09-08: new work records the canonical fork spelling, in the task input and in the run record", async () => {
  const { s, t } = session();
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" })).outcome).toBe("success"); // explicit task override
  expect(calls.at(-1)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).at(-1)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).some(r => r.mode === "branch")).toBe(false);
});

test("19c 2026-09-08: a stored branch-mode run reads as legacy request-copy execution and is never rewritten", async () => {
  const seed = (m: ReturnType<typeof sourceSeededMemory>) => {
    const project = m.store.createProject({ name: "historical", declaredBy: "mark" });
    const s = m.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
    const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
    return { s, t };
  };
  const path = join(directory, "historical.sqlite");
  const before = sourceSeededMemory(path, async raw => { calls.push(raw as NotingAgentInput); return ok([]); });
  const { s, t } = seed(before);
  // A pre-rename row, exactly as the deleted request-copy runner wrote it. No migration touches it.
  before.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", mode: "branch", model: "old/model",
    rangeFrom: `S${s.id}/T${t.id}`, rangeTo: `S${s.id}/T${t.id}`, createdAt: time }, facts: [] });
  const legacy = before.store.listRuns(s.id).at(-1)!.id;
  before.close();
  const after = sourceSeededMemory(path, async raw => { const input = raw as NotingAgentInput; calls.push(input);
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] }); return ok([]); });
  try {
    expect(after.store.getRun(legacy)!.mode).toBe("branch");   // reopening the database migrates nothing
    expect(after.trace(`R${legacy}`)).toContain("mode legacy request-copy execution (branch)");
    expect(after.trace(`R${legacy}`)).not.toContain("mode fork"); // an old run is never described as a native fork
    expect(runMode("fork")).toBe("fork"); expect(runMode("subagent")).toBe("subagent"); // new modes read as themselves
    // Reading it, and running new work in the same database afterwards, leave the stored value alone.
    expect((await after.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
    expect(after.trace(`R${legacy}`)).toContain("legacy request-copy execution");
    expect(after.store.getRun(legacy)!.mode).toBe("branch");
    expect(after.store.listRuns(s.id).map(r => r.mode)).toEqual(["branch", "subagent"]);
  } finally { after.close(); }
});

// ---- 21a 2026-09-08: three earlier rulings are superseded, recorded here by their own names ----

// User, 2026-09-07: "every operation has one shape: op, id, absorb, text, category, scope, supports,
// because; because is always required" and "archive carries only op, id, because". Superseded by
// ticket 21 on 2026-09-08: one `supports` list is the commit's evidence for every operation, archive
// included, and `reason` is its commit message. The commit-level `because` array is removed from new
// write input and rejected by name; `skipped[].because` is untouched.
// User, 2026-09-07: "an archive commit has empty supports". Superseded the same day: an archive keeps
// the evidence it cites, so its applicability is read from the same field as every other commit.
// User, 2026-09-07: "supports proves only the new text". Superseded: supports supplies the commit's
// evidence, including the complete result's basis and the correction or withdrawal that justified it.
test("21a 2026-09-08: the two-array write shape and the empty-supports archive are superseded by supports plus reason", () => {
  const { create, write, read } = memoryWriter();
  const operation = toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, any>;
  const schema = operation.operations.items;
  expect(schema.required).toEqual(["op", "supports", "reason"]);
  expect(schema.properties).not.toHaveProperty("because");
  expect(schema.properties.reason).toEqual({ type: "string", minLength: 1 });
  expect(operation.skipped.items.properties.because).toEqual({ type: "string", minLength: 1 }); // unchanged protocol
  const factSchema = (toolDefinitions.find(t => t.name === "note")!.parameters.properties as Record<string, any>).facts.items;
  expect(factSchema.properties).not.toHaveProperty("reason"); // facts gain no commit metadata and the surface stays four tools
  expect(write([create]).committed).toHaveLength(1);
  expect(write([{ op: "archive", id: read("K1@1"), supports: ["F1"], reason: "Withdrawn by the user." }]).committed).toHaveLength(1);
  expect(memory.store.getKnowledgeRevision(1, 2)?.supports).toEqual([1]); // no longer cleared
});

// Ticket 21 "Applicability" and "Branch scenario", scenario 5: one citation rule for every commit.
test("21a 2026-09-08: an archive's supports face the same session/project/global table as any other commit", () => {
  const { c, peer, content } = commitPaths();
  const same = peer(), outside = peer(memory.store.createProject({ name: "outside 21a", declaredBy: "mark" }).id);
  for (const scope of ["session", "project", "global"]) for (const origin of [c, same, outside]) {
    const created = c.write([{ op: "create", topics: [], ...content(c.fact), scope, reason: "Admitted for the archive scope check." }]);
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const archived = c.write([{ op: "archive", id: c.read(`K${created.committed[0].knowledgeId}@${created.committed[0].commit}`), supports: [origin.fact],
      reason: `Retired on ${origin.branch} evidence.` }]);
    expect(!!archived.committed).toBe(allowed);
  }
  // Naming the foreign fact in the reason does not adopt it: the reason is prose, never a citation.
  const created = c.write([{ op: "create", topics: [], ...content(c.fact), scope: "session", reason: "Admitted for the reason-bypass check." }]);
  expect(c.write([{ op: "archive", id: c.read(`K${created.committed[0].knowledgeId}@${created.committed[0].commit}`), supports: [outside.fact],
    reason: `The user adopted ${outside.fact} on this path.` }]).results[0]).toContain("rejected:");
});

// ---- 21b 2026-09-08: topics classify revisions and change nothing else ----

// Ticket 21 "History and scope", scenario 14: a shared label is not a shared status.
test("21b 2026-09-08: a shared label alters no applicability, keeps its history labels and never collapses two applicable tips", () => {
  const { c, d, peer, content, tips } = commitPaths();
  const label = (who: typeof c, text: string) => who.write([{ op: "update", id: who.read(), topics: ["tiling"],
    reason: "Substantive correction, filed under its subject.", ...content(who.fact, text) }]);
  label(c, "C version"); label(d, "D version");
  const third = peer();
  expect(tips(third)).toEqual([2, 3]); // two divergent tips of one identity, both labelled "tiling"
  const groups = (who: { sessionId: number; headTurnId: number; branch: string }) => memory.topicGroups(who.sessionId, who.headTurnId, who.branch);
  // Grouping is a projection of the same path-selected set: divergent tips stay separate entries and
  // no largest id is chosen. C's path still sees only C's tip.
  expect(groups(third).topics).toEqual([{ topic: "tiling", commits: [{ knowledgeId: 1, commit: 2 }, { knowledgeId: 1, commit: 3 }] }]);
  expect(groups(c).topics).toEqual([{ topic: "tiling", commits: [{ knowledgeId: 1, commit: 2 }] }]);
  // An archive inherits the label; explicit search keeps its history labels, automatic material drops it.
  expect(third.write([{ op: "archive", id: "K1@2", supports: [third.fact], reason: "Retired on this path." }]).results[0]).toContain("knowledge was not read");
  third.read("K1@2"); // The default representative K1@3 does not certify the omitted alternative.
  expect(third.write([{ op: "archive", id: "K1@2", supports: [third.fact], reason: "Retired on this path." }]).committed).toHaveLength(1);
  expect(memory.store.getKnowledgeRevision(1, 4)!.topics).toEqual(["tiling"]);
  const hits = memory.search("tiling", "knowledge", { versions: "all", fields: ["text", "status"] }).split("\n").filter(l => l.startsWith("[K"));
  expect(hits).toHaveLength(1); // One K: equal topic scores choose the newest current candidate (archive).
  expect(hits[0]).toContain("[K1@4]");
  expect(hits[0]).toContain("status: archived");
  expect(memory.search("C version", "knowledge", { versions: "all" })).toContain("status: archived");
  expect(memory.search("D version", "knowledge", { versions: "all" })).toContain("status: tip");
  expect(groups(third).topics).toEqual([{ topic: "tiling", commits: [{ knowledgeId: 1, commit: 3 }] }]);
  expect(memory.inject(third)).toContain("[K1@3]");
  expect(memory.inject(third)).not.toContain("[K1@4]");
  // The label is metadata beside the conclusion, never new factual prose inside it.
  expect(memory.store.getKnowledgeRevision(1, 3)!.text).toBe("D version");
});

// Ticket 21 "Out of Scope" and scenario 17: no registry, no catalog, no fifth tool, no new duty.
test("21b 2026-09-08: topics are revision metadata only — no fact or note field, no fifth tool and no injected catalog", () => {
  const { create, write, s } = memoryWriter();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: 1 });
  expect(tools.map(t => t.name)).toEqual(["trace", "search", "note", "memory"]);
  const factSchema = (toolDefinitions.find(t => t.name === "note")!.parameters.properties as Record<string, any>).facts.items;
  expect(factSchema.properties).not.toHaveProperty("topics");
  expect(tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Labelled fact", source: ["T1#user"], topics: ["packaging"] }] })).toContain("rejected:");
  const schema = (toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, any>).operations.items;
  expect(schema.properties.topics).toEqual({ type: "array", items: { type: "string", minLength: 1 } });
  // Required for the content operations, rejected on archive, through the one existing branch.
  expect(schema.allOf.at(-1)).toEqual({ if: { properties: { op: { const: "archive" } } },
    then: { not: { anyOf: ["text", "category", "scope", "topics"].map(key => ({ required: [key] })) } },
    else: { required: ["text", "category", "scope", "topics"] } });
  expect(schema.required).toEqual(["op", "supports", "reason"]);
  // A label is written by the ordinary batch, with no model call and no independent catalog block.
  expect(write([{ ...create, topics: ["packaging"] }]).committed).toHaveLength(1);
  const injected = memory.inject(s.id);
  expect(injected).toContain('· topics: ["packaging"]');
  expect(injected.match(/topics:/g)).toHaveLength(1); // the label rides its own knowledge line, nothing more
  expect(injected).not.toContain("<topics>");
  expect(calls).toEqual([]); // storing a label calls no model
});

test("26 amendment 5 (26a) 2026-09-09: a Noter completes a batch only by calling note; ending without a submission is incomplete, never zero-fact success", async () => {
  const { s, t } = session(); memory.close();
  let submit = false;
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    if (submit) input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    return { outcome: "success", output: "I answered a question and wrote nothing.", request: { fake: true }, usage: { tokens: 3 } };
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  // R20's failure mode: a run that submits nothing must not advance its 96 selected entries.
  expect(await memory.noting(target)).toMatchObject({ outcome: "failure", problems: [api.NOTING_INCOMPLETE] });
  expect(memory.store.getRun(1)!.outcome).toBe("failure"); // the existing outcome value; no new one, no schema change
  expect(memory.store.listSourceEntries(s.id).some(e => memory.store.entryNoted(e.id))).toBe(false);
  // The prompt says what the runner enforces.
  const prompt = readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8");
  expect(prompt).toContain("note({facts: []})");
  expect(prompt).not.toContain("Stopping without submitting is a normal zero-fact success");
  // An explicit empty submission is the completion, and (29d) it writes no delivery intent — as no commit does.
  submit = true;
  expect(await memory.noting(target)).toMatchObject({ outcome: "success", facts: [] });
  expect(memory.store.sourcePath(s.id, "main", t.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_deliveries'").all()).toEqual([]);
});

/** 26 amendment 2 (26c design §1, defect D3): one shared prefix and two children — a fact on the
 * prefix, a fact on the selected child, a fact on its sibling. Manual writes, so the facts carry no
 * entry bindings and applicability is answered from the Turn ancestry and the citable addresses. */
function pathFacts() {
  const { s, t } = session();
  const write = (headTurnId: number, branch: string, text: string): number => {
    const tools = memory.tools({ kind: "manual", sessionId: s.id, currentTurnId: headTurnId, branch });
    const receipt = JSON.parse(tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text, source: [`T${headTurnId}#user`] }] }));
    expect(receipt.results[0]).toMatch(/^ok:/);
    return receipt.factIds[0] as number;
  };
  const child = (branch: string, parentTurnId: number, prompt: string) =>
    memory.store.appendTurn({ sessionId: s.id, parentTurnId, kind: "turn", userPrompt: prompt, assistantText: `${branch} reply`, startedAt: time });
  const shared = write(t.id, "main", "SHARED PREFIX");
  const selected = child("C", t.id, "C prompt"), sibling = child("D", t.id, "D prompt");
  return { s, t, selected, sibling, shared, child,
    onPath: write(selected.id, "C", "ON PATH"), siblingOnly: write(sibling.id, "D", "SIBLING ONLY") };
}

test("26 amendment 2: compaction and the Noter's history take only path-applicable facts", async () => {
  const { s, selected, shared, onPath, siblingOnly, child } = pathFacts();
  const path = { sessionId: s.id, branch: "C", headTurnId: selected.id };
  const store = memory.store;
  // The list both consumers read, and the list they must read: `listSessionFacts`' freshness order
  // (`source_time DESC, id DESC`) with the sibling's fact removed — filtered, never re-queried through
  // `listBranchFacts`, which orders by fact id ascending and would reverse what `budgetFacts` selects.
  expect(store.listSessionFacts(s.id).map(f => f.id)).toEqual([siblingOnly, onPath, shared]);
  expect(store.listSessionFacts(s.id).filter(f => store.factOnPath(f, path)).map(f => f.id)).toEqual([onPath, shared]);
  expect(store.listBranchFacts(s.id, "C", selected.id).map(f => f.id)).toEqual([shared, onPath]);

  // --- compaction: the applicable facts are carried, the sibling's is not, and the whole operation
  // answers membership from one snapshot rather than rebuilding it per fact.
  const snapshots = countPathSnapshots();
  const measure = (run: () => string) => { snapshots.reset(); const text = run(); return { text, snapshots: snapshots.snapshots() }; };
  const small = measure(() => compacted(memory.compact(s.id, "C", selected.id)));
  expect(small.snapshots).toBe(1);
  expect(small.text).toContain(`[F${shared}]`); expect(small.text).toContain(`[F${onPath}]`);
  expect(small.text).not.toContain(`[F${siblingOnly}]`); expect(small.text).not.toContain("SIBLING ONLY");

  // --- the same with a long Raw backlog, each entry cut to `render.entryTokens`: same membership,
  // still one snapshot (30: there is no second rendering pass to charge a second one to).
  const body = "word ".repeat(12_000);
  let head = selected.id;
  for (const i of [1, 2, 3]) head = child("C", head, `FILLER_${i} ${body}`).id;
  const long = measure(() => {
    const result = memory.compact(s.id, "C", head);
    expect("native" in result).toBe(false);
    return compacted(result);
  });
  expect(long.snapshots).toBe(1);
  expect(long.text).toContain(`[F${shared}]`); expect(long.text).toContain(`[F${onPath}]`);
  expect(long.text).not.toContain(`[F${siblingOnly}]`); expect(long.text).not.toContain("SIBLING ONLY");

  // --- the freshness order survives the filter. 28a: a pending fact is required and is never
  // squeezed out, so consolidating both path facts is what makes them refill (a) — optional history
  // in the spare. With an envelope holding the required material and the receipt alone, the block
  // keeps the Raw and the receipt enumerates the candidates the refill was given, newest first: the
  // sibling's fact is not among them, because it is not omitted for budget but absent for membership.
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "C", kind: "consolidation", createdAt: time },
    operations: [], consolidated: [onPath, shared] });
  const measured = charged(memory.compact(s.id, "C", selected.id));
  const receipt = tokens(`omitted 2 older facts; expand: F${onPath}, F${shared}`) + tokens("Receipts:") + 2;
  const total = measured.knowledge + measured.required.facts + measured.required.raw + receipt;
  compactionWindows(Math.max(1, measured.knowledge), total - measured.knowledge - measured.required.raw, measured.required.raw);
  const squeezed = compacted(memory.compact(s.id, "C", selected.id));
  expect(squeezed).not.toContain(`[F${onPath}]`); expect(squeezed).not.toContain(`[F${shared}]`);
  expect(squeezed).toContain(`omitted 2 older facts; expand: F${onPath}, F${shared}`); // manual bindings remain eligible
  defaultWindows();

  // --- the Noter's freeze: the same list in the same order, from one snapshot. The write-tool
  // binding builds its own later, which is a different operation, so the freeze is measured directly.
  const target = { sessionId: s.id, branch: "C", headTurnId: selected.id, mode: "subagent" as const };
  snapshots.reset();
  const frozen = freezeNoting(store, target, memory.config);
  expect(snapshots.snapshots()).toBe(1);
  snapshots.restore();
  expect(frozen.facts.map(f => f.id)).toEqual([onPath, shared]);

  // --- and the history block the subagent actually receives.
  calls.length = 0;
  expect(await memory.noting(target)).toMatchObject({ outcome: "success" });
  const material = calls[0] as NotingAgentInput;
  const history = material.material.facts.join("\n");
  expect(history).toContain(`[F${shared}] `); expect(history).toContain(`[F${onPath}] `);
  expect(history).not.toContain(`[F${siblingOnly}]`); expect(history).not.toContain("SIBLING ONLY");
  expect(material.text).not.toContain("SIBLING ONLY");
});

// ---- 27 review 2026-09-10: one run record per attempt, exact membership, the cancellation fence ----

test("27 review: each attempt is its own run record", async () => {
  // User ruling 2026-09-10, superseding 27c's "one run record for both attempts" (ticket text, never
  // a ruling): a refused attempt that sent a request is finalized by core before the refusal goes
  // back to the host, and the run the re-admission makes charges only itself.
  const { s, t } = session(); memory.close();
  const sent: (string | undefined)[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    sent.push(input.fallbackReason);
    if (sent.length === 1) return { outcome: "failure", output: "context overflow: prompt is too long", mode: "fork",
      request: { fork: true }, usage: { input: 1234, output: 7 }, retries: [{ attempt: 1, error: "overloaded" }],
      nativeLog: "/tmp/fork-attempt.jsonl", refused: { reason: "context overflow: prompt is too long" } };
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    return { outcome: "success", output: "done", mode: "subagent", request: { fresh: true }, usage: { input: 5, output: 1 }, fallbackReason: input.fallbackReason };
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const first = await memory.noting({ ...target, mode: "fork" }) as { outcome: string; refused?: { reason: string }; runId?: number };
  expect(first.outcome).toBe("dropped");
  expect(first.runId).toBe(1); // the attempt that sent a request has a record, and the host is told which
  const attempt = memory.store.getRun(1)!;
  expect(attempt.mode).toBe("fork");
  expect(attempt.outcome).toBe("failure");
  expect(attempt.request).toBe(JSON.stringify({ fork: true }));
  const attemptBody = JSON.parse(attempt.response!);
  expect(attemptBody.requestedMode).toBe("fork");
  expect(attemptBody.usage).toEqual({ input: 1234, output: 7 });
  expect(attemptBody.retries).toEqual([{ attempt: 1, error: "overloaded" }]);
  expect(attemptBody.nativeLog).toBe("/tmp/fork-attempt.jsonl");
  expect(attemptBody.problems).toEqual(["context overflow: prompt is too long"]);
  expect(attemptBody.fallbackReason).toBeUndefined(); // the reason belongs to the run that fell back
  expect(memory.store.listSourceEntries(s.id).some(e => memory.store.entryNoted(e.id))).toBe(false);

  // The re-admission, as the host makes it: the reason names the first record, and the run records
  // only its own spend — never the attempt's 1234 tokens a second time.
  const reason = `${first.refused!.reason} (fork attempt recorded as R${first.runId})`;
  const second = await memory.noting({ ...target, mode: "fork", effectiveMode: "subagent", fallbackReason: reason, forkAttempt: first.refused });
  expect(second.outcome).toBe("success");
  const run = memory.store.getRun(2)!;
  expect(run.mode).toBe("subagent");
  const body = JSON.parse(run.response!);
  expect(body.usage).toEqual({ input: 5, output: 1 });
  expect(body.fallbackReason).toBe(reason);
  expect(memory.store.listRuns(s.id).filter(r => r.kind === "noting").map(r => r.mode)).toEqual(["fork", "subagent"]);
});

test("27 amendment 6: frozen membership survives fallback or the task stays pending", async () => {
  // The frozen batch is taken whole or not at all. A capacity that holds only its oldest entry used
  // to pop the newer one and report success on the subset; now the batch waits.
  const { s, t } = session();
  const e1 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u1", turnId: t.id, role: "user", text: "first evidence", raw: "first evidence", calls: [] });
  const t2 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "second", startedAt: time });
  const e2 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u2", turnId: t2.id, role: "user", text: "second evidence", raw: "second evidence", calls: [] });
  memory.selectEntries(s.id, "main", [e1.id, e2.id]);
  const target = { sessionId: s.id, branch: "main", headTurnId: t2.id, mode: "subagent" as const };
  // What the batch really costs, priced the way the freeze prices it: instructions, tool definitions
  // and the prepared fresh text. The oldest entry's own price is the allowance that fits one, not two.
  const instructions = readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8");
  const priced = (exactEntryIds: number[]) => {
    const frozen = freezeNoting(memory.store, { ...target, boundary: { exactEntryIds } }, memory.config);
    return tokens(instructions) + tokens(JSON.stringify(toolDefinitions)) + tokens(frozen.prepared!.text);
  };
  const capacity = { inputTokens: priced([e1.id]), prefixTokens: 0 };
  expect(priced([e1.id, e2.id])).toBeGreaterThan(capacity.inputTokens);
  await expect(memory.noting({ ...target, boundary: { exactEntryIds: [e1.id, e2.id] }, capacity }))
    .rejects.toThrow(api.NOTING_CAPACITY);
  expect(calls).toEqual([]); // nothing ran on a smaller batch
  expect(memory.pendingEntries(s.id, "main", t2.id).map(e => e.id)).toEqual([e1.id, e2.id]);

  // With room, the same boundary runs on exactly those entries, and the audit says so.
  const ran = await memory.noting({ ...target, boundary: { exactEntryIds: [e1.id, e2.id] } });
  expect(ran.outcome).toBe("success");
  expect(calls[0]!.entryIds).toEqual([e1.id, e2.id]);
  expect(calls[0]!.entryAudit.entries.map(e => e.id)).toEqual([e1.id, e2.id]);

  // A member another executor already processed drops the task with its reason, and re-processes
  // nothing: this is the claim fence a fresh freeze would otherwise walk straight past.
  const t3 = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t2.id, kind: "turn", userPrompt: "third", startedAt: time });
  const e3 = memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: "u3", turnId: t3.id, role: "user", text: "third evidence", raw: "third evidence", calls: [] });
  memory.selectEntries(s.id, "main", [e1.id, e2.id, e3.id]);
  const before = calls.length;
  const dropped = await memory.noting({ ...target, headTurnId: t3.id, boundary: { exactEntryIds: [e2.id, e3.id] } }) as { outcome: string; reason?: string };
  expect(dropped.outcome).toBe("dropped");
  expect(dropped.reason).toContain(api.NOTING_MEMBERSHIP);
  expect(dropped.reason).toContain(`entries ${e2.id} of the frozen batch`);
  expect(calls).toHaveLength(before); // no model call, and no run
  expect(memory.pendingEntries(s.id, "main", t3.id).map(e => e.id)).toEqual([e3.id]);
});

/** Ticket 29 "One material-selection mechanism" (2026-09-10), as 29b implements it. A task has two
 * different sets: the processing target, frozen regardless of what the child can see, and the material
 * that must be newly supplied — the target minus what the view proves visible at the same identity and
 * the same representation, and only then the injection budget. Never a budget-limited prefix with
 * visibility subtracted afterwards. */
test("29: one material builder — filter visible, then budget", async () => {
  const { s, t } = session();
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "observation", actor: "user", text: "Recorded earlier", source: [`T${t.id}#user`] }] });
  const entries = memory.pendingEntries(s.id, "main", t.id);
  // A failing probe leaves the same evidence pending, so every view below freezes the same task.
  const probe = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    calls.push(raw as NotingAgentInput); return { ...ok([]), outcome: "failure" };
  });
  const view = (raw: Map<string, "source" | "view">, factIds: number[] = []) =>
    ({ raw, factIds: new Set(factIds), knowledgeCommitIds: new Set<number>(), injection: false, suppliedGeneration: 0 });
  const freeze = async (visible: ReturnType<typeof view>) => {
    calls.length = 0;
    await probe.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork", visible });
    return calls[0]!;
  };
  try {
    const none = await freeze(view(new Map()));
    const carried = await freeze(view(new Map(entries.map(e => [e.nativeId, "view" as const]))));
    const factSeen = await freeze(view(new Map(entries.map(e => [e.nativeId, "source" as const])), [1]));
    // The processing target is frozen regardless of visibility: three views, one target.
    expect(carried.entryIds).toEqual(none.entryIds);
    expect(factSeen.entryIds).toEqual(none.entryIds);
    // Same identity, permitted representation: a tier-1 carrier view withholds the body exactly as a
    // retained source entry does, and an empty data delta keeps the mandatory framing.
    expect(none.material.entries.map(e => e.id)).toEqual(none.entryIds);
    expect(carried.material.entries).toEqual([]);
    expect(carried.text).toContain(`Range: ${carried.range.from}..${carried.range.to}`);
    expect(carried.material.sources.length).toBeGreaterThan(0);
    // Filter, then budget: the visible fact leaves the optional block, and the block gets smaller
    // rather than refilled — the allowance is a ceiling, never a target.
    expect(none.material.facts.join("\n")).toContain("[F1]");
    expect(factSeen.material.facts).toEqual([]);
    expect(tokens(factSeen.text)).toBeLessThan(tokens(carried.text));
    // What the text really carries is what a carrier may state — never what the task considered.
    expect(none.supplied.entries.map(e => e.id)).toEqual(none.entryIds);
    expect(none.supplied.factIds).toEqual([1]);
    expect(carried.supplied.entries).toEqual([]);
    expect(factSeen.supplied.factIds).toEqual([]);
  } finally { probe.close(); }
});

test("27: cancellation between refusal and re-admission launches no fallback", async () => {
  // Parent 27 line 83: "User cancellation, stop, shutdown, claim loss or disabled enrollment must
  // not launch fallback work." The refused attempt carries the generation it was admitted under;
  // `cancelTasks()` advances it, with or without stopping, and the re-admission drops.
  const { s, t } = session(); memory.close();
  const generations: unknown[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput & { cancellation?: number };
    generations.push(input.cancellation);
    if (generations.length === 1) return { outcome: "failure", output: "context overflow", request: null, refused: { reason: "context overflow" } };
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    return ok([]);
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const first = await memory.noting({ ...target, mode: "fork" }) as { outcome: string; refused?: unknown };
  expect(first.outcome).toBe("dropped");
  expect(memory.store.listRuns(s.id)).toEqual([]); // this refusal sent nothing, so it recorded nothing
  const frozen = generations[0] as number;

  memory.cancelTasks(); // /trace stop, between the refusal and the re-admission — no stopping flag
  const dropped = await memory.noting({ ...target, mode: "fork", effectiveMode: "subagent",
    fallbackReason: "context overflow", forkAttempt: first.refused, cancellation: frozen });
  expect(dropped).toEqual({ outcome: "dropped", reason: api.CANCELLED_BEFORE_FALLBACK });
  expect(generations).toHaveLength(1); // no fresh request
  expect(memory.store.listRuns(s.id)).toEqual([]);
  expect(memory.pendingEntries(s.id, "main", t.id).length).toBeGreaterThan(0);

  // The cancellation stopped this executor's pending fallback, not the executor: a task admitted
  // after it carries the current generation and runs.
  expect((await memory.noting({ ...target, mode: "subagent" })).outcome).toBe("success");
  expect(generations).toHaveLength(2);
});

test("28 amendment 3: cancellation is a signal — the signalled task's tools close and its claim goes, and no other task is touched", async () => {
  // "Admission accepts this compaction's `AbortSignal`; core wires it into its existing task
  // cancellation so that only this task's tools close and only its claim is invalidated." The
  // executor-wide `cancelTasks` is untouched: what follows uses neither it nor `stopping`.
  const { s, t } = session(); memory.close();
  let releaseNoting = () => {};
  const held = new Promise<void>(resolve => { releaseNoting = resolve; });
  const submissions: unknown[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    if (input.kind !== "noting") return ok([]); // the Consolidation below commits through its own tool
    await held; // still in flight when the signal fires
    submissions.push(input.tools.find(tool => tool.name === "note")!.execute({ facts: [
      { category: "observation", actor: "user", text: "a fact this cancelled run tries to commit", source: [`T${t.id}#user`] }] }));
    return ok([]);
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" as const };
  const controller = new AbortController();
  const cancelled = memory.noting({ ...target, signal: controller.signal });
  // A second task, of the other phase, running under no signal of its own: the one this must not touch.
  const others = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "the durable claim of the untouched task", source: [`T${t.id}#user`] }] });
  expect(String(others)).not.toContain("rejected");
  const untouched = memory.consolidate(target);

  controller.abort();
  releaseNoting();
  const result = await cancelled;
  // Its tools are closed: the submission after the abort is rejected, and nothing of it is committed.
  expect(String(submissions[0])).toContain("rejected: run has finished");
  expect(memory.store.listSessionFacts(s.id).map(f => f.text)).toEqual(["the durable claim of the untouched task"]);
  expect(result.outcome).not.toBe("success");
  // Its claim is gone, so the same target is admissible again — the executor was not stopped.
  expect(memory.store.getClaim(s.id, "noting")).toBeNull();
  expect((await untouched).outcome).toBe("success"); // the unsignalled task of the other phase ran to completion
  expect(memory.taskEligibility("noting", { sessionId: s.id, branch: "main", headTurnId: t.id })).toBeDefined();
});

test("28 amendment 3: a signal already aborted at admission cancels that task before its first request", async () => {
  const { s, t } = session(); memory.close();
  const requests: unknown[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    requests.push(raw); (raw as NotingAgentInput).tools.find(tool => tool.name === "note")!.execute({ facts: [] }); return ok([]);
  });
  const controller = new AbortController(); controller.abort();
  const result = await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent", signal: controller.signal });
  expect(result.outcome).not.toBe("success");
  expect(requests).toEqual([]);
  expect(memory.pendingEntries(s.id, "main", t.id).length).toBeGreaterThan(0); // nothing advanced
});

// ---- 29e: Consolidation's exact fact target and its cancellation fence (parent 29 cases 19 and 20)

test("29e (parent 27 amendment 6, case 19): a Consolidation fork's exact fact target survives fallback or the task stays pending", async () => {
  // The twin of "27 amendment 6" above, for the phase 29e restored the mode to. The frozen batch is
  // taken whole or not at all: a fallback window that holds only its oldest fact leaves the batch
  // pending rather than consolidating a subset and marking the rest processed.
  const { s, t } = session();
  const note = (text: string) => memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text, source: [`T${t.id}#user`] }] });
  note("The first durable claim of this batch");
  note("The second durable claim of this batch");
  const [f1, f2] = memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id);
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" as const };
  // What the batch really costs, priced the way the freeze prices a fresh child: instructions, tool
  // definitions and the prepared text. The oldest fact's own price is the allowance that fits one.
  const instructions = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  const priced = (exactFactIds: number[]) => {
    const frozen = freezeConsolidation(memory.store, { ...target, boundary: { exactFactIds } }, memory.config);
    return tokens(instructions) + tokens(JSON.stringify(consolidationToolDefinitions())) + tokens(frozen.prepared!.text);
  };
  const capacity = { inputTokens: priced([f1!]), prefixTokens: 0 };
  expect(priced([f1!, f2!])).toBeGreaterThan(capacity.inputTokens);
  await expect(memory.consolidate({ ...target, boundary: { exactFactIds: [f1!, f2!] }, capacity }))
    .rejects.toThrow(api.CONSOLIDATION_CAPACITY);
  expect(calls).toEqual([]); // nothing ran on a smaller batch
  expect(memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id)).toEqual([f1, f2]);

  // With room, the same boundary runs on exactly those facts, and the range says so.
  const ran = await memory.consolidate({ ...target, boundary: { exactFactIds: [f1!, f2!] } });
  expect(ran.outcome).toBe("success");
  if (ran.outcome === "success") expect(ran.range.facts.map(f => f.id)).toEqual([f1, f2]);

  // A member another executor already consolidated drops the task with its reason, and re-processes
  // nothing: the claim fence a fresh freeze would otherwise walk straight past.
  note("The third durable claim of this batch");
  const f3 = memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id);
  expect(f3).toEqual([f3[0]]); // f1 and f2 are consolidated now
  const before = calls.length;
  const dropped = await memory.consolidate({ ...target, boundary: { exactFactIds: [f2!, f3[0]!] } }) as { outcome: string; reason?: string };
  expect(dropped.outcome).toBe("dropped");
  expect(dropped.reason).toContain(api.CONSOLIDATION_MEMBERSHIP);
  expect(dropped.reason).toContain(`facts F${f2} of the frozen batch`);
  expect(calls).toHaveLength(before); // no model call, and no run
  expect(memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id)).toEqual(f3);
});

test("29e (27d repair 4, case 20): a Consolidation task cancelled between refusal and re-admission launches no fallback", async () => {
  // Parent 27 line 83, for the restored phase: the refused attempt carries the generation it was
  // admitted under, `cancelTasks()` advances it, and the re-admission drops without launching.
  const { s, t } = session();
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  memory.close();
  const generations: unknown[] = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as { cancellation?: number };
    generations.push(input.cancellation);
    if (generations.length === 1) return { outcome: "failure", output: "context overflow", request: null, refused: { reason: "context overflow" } };
    return ok([]); // a run that submits nothing succeeds with zero knowledge and advances the range
  });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const first = await memory.consolidate({ ...target, mode: "fork" }) as { outcome: string; refused?: unknown };
  expect(first.outcome).toBe("dropped");
  const runs = () => memory.store.listRuns(s.id).filter(r => r.kind === "consolidation"); // the manual `note` above has its own record
  expect(runs()).toEqual([]); // this refusal sent nothing, so it recorded nothing
  const frozen = generations[0] as number;

  memory.cancelTasks(); // /trace stop, between the refusal and the re-admission
  const dropped = await memory.consolidate({ ...target, mode: "fork", effectiveMode: "subagent",
    fallbackReason: "context overflow", forkAttempt: first.refused, cancellation: frozen });
  expect(dropped).toEqual({ outcome: "dropped", reason: api.CANCELLED_BEFORE_FALLBACK });
  expect(generations).toHaveLength(1); // no fresh request
  expect(runs()).toEqual([]);
  expect(memory.store.consolidationBatch(s.id, "main", t.id).length).toBeGreaterThan(0); // the facts stay pending

  // The cancellation stopped this executor's pending fallback, not the executor: a task admitted
  // after it carries the current generation and runs.
  expect((await memory.consolidate({ ...target, mode: "subagent" })).outcome).toBe("success");
  expect(generations).toHaveLength(2);
});


test("29/31 stale status follows the selected path, not a later sibling merge", () => {
  const { root, c, d, content } = commitPaths();
  expect(c.write([{ op: "archive", id: "K1@1", reason: "Withdraw this path's rule.", supports: [c.fact] }]).committed[0].commit).toBe(2);
  expect(d.write([{ op: "create", topics: [], reason: "Separate duplicate.", ...content(d.fact, "Duplicate") }]).committed[0].commit).toBe(3);
  // Ticket 44: the older K1 address survives; K2 is the absorbed duplicate.
  expect(d.write([{ op: "merge", topics: [], id: d.read("K1@1"), absorb: [d.read("K2@3")], reason: "Merge on D only.", ...content(d.fact, "Merged rule") }]).committed[0].commit).toBe(4);
  const status = (path: typeof root, commits: number[]) => knowledgeStatusNotes(memory.store, memory.store.listCurrentKnowledge(path), commits, path);
  expect(status(c, [1])).toEqual(["K1@1 is archived"]);
  expect(status(d, [3])).toEqual(["K2@3 is merged into K1@4"]);
  expect(status(root, [1])).toEqual([]); // the predecessor is still current at the common ancestor
});

test("29/31 archived divergent tip is not superseded by the surviving same-K sibling", () => {
  const { c, d, peer, edit } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  expect(c.write([{ op: "archive", id: c.read("K1@2"), reason: "Withdraw C only.", supports: [c.fact] }]).committed[0].commit).toBe(4);
  const selected = peer();
  const current = memory.store.listCurrentKnowledge(selected);
  expect(current.map(k => k.revision.id)).toEqual([3]);
  expect(knowledgeStatusNotes(memory.store, current, [2], selected)).toEqual(["K1@2 is archived"]);
  expect(knowledgeStatusNotes(memory.store, current, [1], selected)).toEqual([
    "K1@1 is superseded by K1@3 above", "K1@1 is archived",
  ]); // both applicable descendants, never an arbitrary global winner
  const seen = { raw: new Map<string, "source" | "view">(), factIds: new Set<number>(),
    knowledgeCommitIds: new Set([2]), injection: true, suppliedGeneration: 0 };
  expect(memory.injection(selected, seen).text).toContain("K1@2 is archived");
});

/** Ticket 40 N0 (2026-09-14): a correction keeps the object's identity. The Sol replay read the
 * id-in-text rejection as "delete" and dropped K213@271 and five other audited objects on
 * resubmission; the prompt and the rejection reason now both say where the span goes. */
test("40 N0: the verbatim span naming the object goes in quote, which the id check does not cover", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8");
  expect(prompt).toContain("goes in `quote`, which the id check does not cover");
  expect(prompt).toContain("A resubmission after a rejection changes only what was rejected and never drops an object's identity, a condition, a negation or an evidence level.");
  expect(prompt).toContain("A finding that names several independently maintainable objects is one fact per object.");
  const { s, t } = session();
  const note = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!;
  const fact = (changes: Record<string, unknown>) => ({ category: "observation", actor: "agent",
    text: "The audited knowledge item names its object in the text instead of the quote.", source: [`T${t.id}#user`], ...changes });
  const rejected = JSON.parse(note.execute({ facts: [fact({ text: "K213@271 names its object in the text instead of the quote." })] }));
  expect(rejected.results[0]).toContain("rejected:");
  expect(rejected.results[0]).toContain("move the verbatim span to quote");
  expect(memory.store.listSessionFacts(s.id)).toEqual([]);
  const accepted = JSON.parse(note.execute({ facts: [fact({ quote: "K213@271" })] }));
  expect(accepted.results[0]).toMatch(/^ok:/);
  expect(memory.store.getFact(accepted.factIds[0])!.quote).toBe("K213@271");
});

/** Ticket 40 N5b (2026-09-14): the per-fact relation check, and its three limits: a negate needs the
 * raw to state, or unambiguously establish, the replacement of the same object (the first N5 replay
 * negated eight review findings from one summary count), only the superseded current state is
 * negated, and a target that neither NEAR nor a fact search surfaces gets no relation. */
test("40 N5b: a new-state fact negates the superseded current state only on a stated replacement of the same object; no fitting target means no relation", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8");
  expect(prompt).toContain("negates the fact that recorded the superseded current state, strong when the raw states the replacement");
  expect(prompt).toContain("a fix report negates the finding it fixes");
  expect(prompt).toContain("negates the truncation ruling weakly and supports the paging proposal");
  expect(prompt).toContain("A `negate` is written only when the raw states, or by unambiguous reference establishes, that the new fact replaces the same object under the same scope");
  expect(prompt).toContain("a summary count (\"7 fixes done\"), a shared ticket or topic proximity does not negate each member item");
  expect(prompt).toContain("write no relation and do not substitute `weak` for missing evidence");
  expect(prompt).toContain("Only the fact that recorded the superseded current state is negated");
  expect(prompt).toContain("stays true after beta.5 is published");
  expect(prompt).toContain("`search` the fact layer for the object by name, and when nothing fitting is found write no relation: never guess, never force");
});

/** Ticket 45 narrows ticket 40 C4: supplied complete versions are the first read; literal search
 * remains the exception path and never becomes an evidence or stale-successor shortcut. */
test("45: Consolidator reads the bounded supplied block first and preserves necessary read exceptions", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  expect(prompt).toContain("When this block is supplied, it holds the applicable set up to the database-derived capacity; its receipt lists the whole items the capacity could not hold.");
  expect(prompt).toContain("Read the supplied block first for what this range closes and for the item a claim continues.");
  expect(prompt).toContain("A complete exact version supplied here needs no reread.");
  expect(prompt).toContain("a fact's `quote`, a review cue or a targeted search hit points to an item not supplied complete");
  expect(prompt).toContain("the knowledge block is absent, an item's history is needed before correction, evidence or a competing successor must be checked");
  expect(prompt).toContain("a legal fact outside the range is needed, or a stale-base refusal requires the applicable successor to be read again");
  expect(prompt).toContain("`search` matches one contiguous literal substring over the versions applicable here and does not combine keywords");
  expect(prompt).toContain("No hit means change the word, never stack words.");
  expect(prompt).toContain("Read an exact current version before writing only when it was not supplied complete in the knowledge block or inherited context.");
  expect(prompt).not.toContain("within its own 10,000-token allowance");
  expect(prompt).not.toContain("the `open`, `goal` and `reference` ones are traced before deciding what this range closes");
  expect(prompt.indexOf("### Finding what this range closes")).toBeLessThan(prompt.indexOf("### Correction-driven edits"));
});

test("noting admission (2026-09-16 ruling): the anchor test replaces the code-or-git exclusion", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8");
  expect(prompt).toContain("Record what later work will need and cannot look up: a decision or ruling with its reason — why the design takes this shape, why a threshold has this value, what it replaced — even when it lands in code in the same batch, because the code keeps only the current value.");
  expect(prompt).toContain("How existing code happens to be written is looked up when needed and is not a fact.");
  expect(prompt).not.toContain("re-derivable from code or git");
});

/** Ticket 54 (rulings of 2026-09-18): pruning and merging are the Dreamer's work; `check` is the
 * acceptance that sets the next round's intensity. The opening check and finishing on budget grounds are gone. */
test("56: split by maintenance need, rewrite only what fails the standalone test, archive finished work of every category", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/dreaming.md", import.meta.url), "utf8");
  // A: the standard's identity test replaces "split again while a child is still compound"; generic examples, no batch ids.
  expect(prompt).toContain("one object, one independently maintainable claim or state, one identity — a child is warranted only when a later fact would change it while its sibling stands");
  // 57 replaced the "Split: … Do not split: …" example lists with two principles (pinned there).
  expect(prompt).toContain("A split that leaves a child unable to stand on its own, or that produces two bodies a reader would always consult together, is the compound it started from and is not made.");
  expect(prompt).not.toContain("split again while a child is still compound");
  // C: the trigger narrows to the standalone test; 54's readability rules stay verbatim (pinned there).
  expect(prompt).toContain("The survivor of a merge or split, and any item whose body fails the standalone test — a clause whose subject, condition or actor cannot be resolved by a reader who never saw the conversation.");
  expect(prompt).toContain("A body that already reads on its own is left as it is: expanding it into full sentences, adding attribution it already carries in a few characters, or reordering it is the same class of forbidden edit as shortening-only.");
  expect(prompt).not.toContain("Every survivor the round touched");
  // B: persistent states update; finished work items of every category archive on the fact that finishes them.
  expect(prompt).toContain("Persistent object states (an installed version, a pinned exclusion, a configured default) are updated, not archived, when the state changes; finished work items — a ticket's delivery, merge or acceptance record with nothing unresolved left in it — are archived on the fact that finishes them, whatever their category.");
  // 57 rewords the protected-meaning sentence (the folded pointer counts too; pinned there).
  expect(prompt).toContain("A record that still names an unresolved item is not finished: split the unresolved item out first (step A), then archive the finished remainder.");
  expect(prompt).not.toContain("An `open` item whose completion or abandonment a fact states");
  // Maintainer 2026-09-18: when unsure, read the original through trace, never code; every operation carries a reason (the memory tool schema already requires it).
  expect(prompt).toContain("When a fact leaves you unsure what a claim means or whether it still holds, read the original: `trace` the fact's source entries. The conversation's Raw outranks the extracted fact, and code is never the authority for what was decided.");
  expect(prompt).toContain("A conflict the facts and their traced originals do not settle becomes one `dispute` item naming both sides");
  expect(prompt).toContain("Each operation has a nonempty reason.");
});

test("54: the Dreamer loop is split, merge, resolve, rewrite, check; the failed check sets the intensity; an archive has one of three reasons", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/dreaming.md", import.meta.url), "utf8");
  // The ruling.
  expect(prompt).toContain("The goal is a readable, non-redundant, non-contradictory memory; the caps are acceptance criteria, not the objective.");
  expect(prompt).toContain("`check` is the final acceptance; when acceptance fails, run another pruning round. Pruning is never done for `check`'s sake — `check` judges the intensity of pruning.");
  expect(prompt).toContain("Do not call `check` before the round: nothing in core needs it, and the receipt must not set the agenda.");
  // A: split first (ruled 2026-09-18); 57 rewords the precedence clause to the per-item form (pinned there).
  // B: only the same claim stated twice merges; the three production merges are the anti-pattern (ruled 2026-09-18 on revival).
  expect(prompt).toContain("the same claim stated twice, never two claims about one subject: a definition and the rules that use it, a rule and the record of the fix that applied it, a sub-ticket's state and the umbrella that lists the sub-tickets, stay separate");
  expect(prompt).toContain("A later ruling on an object whose earlier rule or proposal is archived continues that identity — revive and merge, the body states the current rule alone.");
  // C: resolve.
  expect(prompt).toContain("A later ruling (a fact recording the user's decision or correction) wins over an earlier one; a later fact that is a proposal, a report or an assistant's choice never overrides a ruling. The loser is archived with that fact in `supports` and named in `reason`.");
  expect(prompt).toContain("A conflict the facts and their traced originals do not settle becomes one `dispute` item naming both sides");
  // D: readability, not brevity and not verbosity (ruled 2026-09-18).
  expect(prompt).toContain("full sentences in the conversation's language, present tense for what holds now, the object, the claim, its conditions, its status and who decided it stated in words");
  expect(prompt).toContain("The project's vocabulary counts as understood (CONTEXT.md; N/C/D, claim, placement, path) — what fails is a clause whose subject, condition or actor cannot be resolved; attribution is a few characters (`助手选择`, `用户裁定`), never a sentence; a body states the current rule only — history is for tracing through the version chain and the cited facts, never resident (a body that narrates its own evolution bloats the context).");
  expect(prompt).toContain("Shortening is never a goal: an update whose only change is fewer characters is forbidden; a rewrite that removes more than half of a body must name in its reason where the removed detail survives; a rewrite that lengthens a body beyond what its missing attribution or specifics need is forbidden too.");
  // Check closes the round; a round with nothing to do names the changed block.
  expect(prompt).toContain("No blocker: finish. A cap exceeded: another round at the next intensity below.");
  expect(prompt).toContain("A round with nothing to consolidate, resolve or rewrite is reported as such — with the changed block named — never as \"budget fine\".");
  // Protected meaning kept verbatim; a survivor preserves scope; exactly three archive reasons.
  expect(prompt).toContain("Every split, merge, rewrite and archive must preserve — a split across its two children together, an archive through its named survivor or the cited fact, and at the second intensity by stating in the reason what reason (c) loses, which is never a KEEP item: ");
  expect(prompt).toContain("unique user constraints and corrections; user-versus-agent attribution; proposal-versus-decision status; attempted, reported, completed and verified distinctions; uncertainty; conditions; exceptions; rationale; identifiers; exact errors and diagnostics; useful completed work that prevents repetition; unresolved decisions, blockers and next actions; and still-valid subject labels.");
  expect(prompt).toContain("a `global` item is never archived into a `project` twin, a project item never into a session one — and states every unique qualification; categories may differ, scope may not narrow");
  expect(prompt).toContain("An archive has exactly one of three reasons, stated in `reason`:");
  expect(prompt).toContain("(c) at the second intensity only, low value under the KEEP test");
  expect(prompt).toContain("\"Still valid, lower priority, needed for the budget\" is not a reason.");
  // Intensity and KEEP (57 rewords the first-round sentence to the per-item form; pinned there).
  expect(prompt).toContain("Second round (a cap still exceeded): archive redundancy into named survivors across categories, retire low-value items — routine progress notes with no unresolved decision, session-local detail, `reference` pointers the artifact itself holds — under the KEEP test. Third: report to the maintainer with the numbers and finish on the final `check` without further loss; that run ends uncertified");
  expect(prompt).toContain("KEEP, never retired for a cap: user rulings and corrections, rule language (must/never/always), a body that states why, external-system limits, an item whose object is likely to return, unresolved decisions and blockers.");
  // Removed: the opening check as the agenda, and finishing because the budget is fine.
  expect(prompt).not.toContain("Actual check first");
  expect(prompt).not.toContain("budget work");
});

/** Ticket 57 (rulings of 2026-09-18, second set): one item at a time through split → merge → resolve → rewrite,
 * deciding once and committing before the next item; two principles replace the example lists; status beside a ruling. */
test("57: the Dreamer deliberates one item at a time on two principles; status beside a ruling is compound", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/dreaming.md", import.meta.url), "utf8");
  // The unit of work is one item; splitting precedes merging within it, never as a pool-wide pass.
  expect(prompt).toContain("The unit of work is one item: take each item under `New:` and `Changed:` through A–D below in this order, deciding once, then commit that item's operations and take the next item.");
  expect(prompt).toContain("Splitting precedes merging within an item, because only atomic items compare for overlap, and never as a pass over the whole pool followed by a search for duplicates.");
  for (const heading of ["### A. Split?", "### B. Merge?", "### C. Resolve?", "### D. Rewrite?", "### Check."]) expect(prompt).toContain(heading);
  expect(prompt).toContain("Call `check` after the last item's operations are committed.");
  // Principle 1: one item, one thing, sized by a clear description; the illustrations, not rules.
  expect(prompt).toContain("Two principles decide, not a list of cases. (1) One item, one thing, sized by what a clear description of that thing needs: too long when a reader hunts for the subject or when one change would force rewriting the whole body, too short when a piece cannot be read without its sibling; a split is warranted when the two pieces would be read and changed apart, a merge when one body would describe the thing more clearly than two.");
  expect(prompt).toContain("Findings about different mechanisms are different things; the clauses of one contract read and changed together are one.");
  // Principle 2: knowledge is macro; an over-detailed body is a rewrite, not a split.
  expect(prompt).toContain("(2) Knowledge is macro: a body holds decisions, mechanisms, constraints and their reasons; identifiers, function and parameter names, counts and hashes stay in the facts and the original and enter a body only when the claim cannot be stated without them (`trace` reaches them when needed). A body long only by such detail is trimmed (D), not split.");
  expect(prompt).toContain("session-local narration, step-by-step history and the detail principle 2 keeps out of a body dropped unless they are the point");
  // The example lists are gone.
  expect(prompt).not.toContain("Split: a user's rule");
  expect(prompt).not.toContain("Do not split: the clauses");
  // A split-out piece is checked for a home before it becomes a new identity.
  expect(prompt).toContain("A piece that would be split out is checked for an existing home before it is created: if a current item already carries it, the piece merges there instead of becoming a new identity.");
  // Status beside a ruling: compound by the category test; finished status folded, its record archived; follow-up is its own open.
  expect(prompt).toContain("A body that mixes a ruling or mechanism with implementation status is compound — the category test says so: status and progress are `open`, rulings are `constraint`/`mechanism`/…; a body that cannot be given one category is two things.");
  expect(prompt).toContain("A finished status with no follow-up (merged, implemented, installed) is folded into the ruling's body in a few characters (`已合入main`, `已实现`) as the traceable pointer, and the delivery record it came from is archived on its finishing fact (C); a status with follow-up is its own `open` item, created only after the home check (B).");
  expect(prompt).toContain("The protected-meaning entry \"useful completed work that prevents repetition\" is met by the archived version and its cited facts, plus the few characters folded into the ruling the status stood beside; it does not keep a finished record resident.");
  // The first round is the per-item work; its only archives are C's, on a cited fact.
  expect(prompt).toContain("First round: A–D over every item, closed by `check`; its only archives are C's, on a cited fact.");
  expect(prompt).not.toContain("closed by D");
});

test("59: every supplied item is accounted for by an operation or a skip; New items search history once, in a batch", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/dreaming.md", import.meta.url), "utf8");
  // The loop's opening: an item ends the round in an operation or a skip; the check reports the rest; a skip certifies nothing.
  expect(prompt).toContain("Every supplied item ends the round either in an operation or in a skip with a reason, and the check reports the ones that are neither; a skip is not a certificate.");
  // Step B, before the first New item: one batched history search; a hit is read in full before the revival decision.
  expect(prompt).toContain("Before the first `New:` item is decided, one `search` with `queries` — for each New item the shortest common noun of its object, the word an older body would use, one query per object and never the item's own phrase — `layer: knowledge`, `versions: history`, `cap: 3` (the item's own self-hit leads, the older identity follows); a hit is a revival candidate to read in full (`trace`) before deciding whether the New item continues that identity.");
  // The memory call names the skip shape; the empty-skip literal is gone.
  expect(prompt).toContain('Call memory({operations, skipped}); a skip is `{knowledge: "K12@57", because}` naming a supplied item this round leaves without an operation.');
  expect(prompt).not.toContain("skipped: []");
  // The check tool's receipt and the memory tool's description carry the same contract.
  expect(dreamingToolDefinitions().find(tool => tool.name === "memory")!.description).toContain("a skip accounts for the item and never certifies it");
});

test("47: read-version descriptions name current, history and all without making inapplicable revisions write bases", () => {
  const trace = toolDefinitions.find(tool => tool.name === "trace")!;
  const search = toolDefinitions.find(tool => tool.name === "search")!;
  const versions = (trace.parameters.properties as Record<string, { description?: string }>).versions!.description!;
  expect(versions).toContain("current = active current tips applicable on this path");
  expect(versions).toContain("history = additionally applicable superseded and archived revisions");
  expect(versions).toContain("all = additionally other branches' revisions within the selected scope, including their history and archives");
  expect(versions).toContain("never write bases here");
  expect(trace.description).toContain("versions=all additionally adds other branches' revisions, including their history and archives");
  expect(trace.description).toContain("revisions not applicable here are never write bases");
  expect(search.description).toContain("history additionally includes applicable superseded and archived revisions");
  expect(search.description).toContain("all additionally includes other branches' revisions in scope, including their history and archives");
  expect(search.description).toContain("reading never bypasses write validation");
});

test("46: a rule and the choice under it are two items; sub-items are their own opens; an empty receipt is a complete block", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  // The two atomicity sentences sit beside 44's, which stay as they are.
  expect(prompt).toContain("the goal text holds the intent alone and nothing is archived. The pinned development baseline is its own `reference` state item, updated as it moves. Each staffing choice is its own item with the role named first");
  expect(prompt).toContain("A user's rule and the assistant's choice, practice or implementation made under it are two items — the rule is the `constraint`, the choice is the assistant's current choice, updated when the choice changes — and neither absorbs the other when the range states them together; a `goal` never absorbs a user's rule stated beside it, which stays its own `constraint`.");
  expect(prompt).toContain("A work item with named sub-items holds only the shared target, order and current step; each sub-item with its own scope and acceptance is its own `open`, continued on its own id.");
  // The empty receipt is a complete block; 45's sentences around it stay as they are.
  expect(prompt).toContain("its receipt lists the whole items the capacity could not hold. When the receipt is empty, the block — with the versions already visible in an inherited context — is the whole applicable set: a claim no supplied item maintains has no existing item, so create it without a search to confirm absence. Read the supplied block first for what this range closes and for the item a claim continues.");
  // Steps 2 and 3 of the search procedure apply only without a complete block.
  expect(prompt).toContain("2. Without one, and only when the block is absent or its receipt is not empty (with a complete block, the item a claim continues is found by reading the block), `search` a single distinctive literal word taken from the old state:");
  expect(prompt).toContain("3. No hit means change the word, never stack words.");
});

test("45: overflow receipts are not a reading checklist; omitted items need a specific read cue", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  expect(prompt).toContain("it is not a reading checklist");
  expect(prompt).toContain("Read a receipted item only when a fact's `quote`, a review cue or a targeted search hit points to it.");
  expect(prompt).toContain("Do not enumerate or trace the receipt to reconstruct the omitted pool.");
  expect(prompt).toContain("Lower lexical relevance does not prove an item irrelevant; preserve the necessary read exceptions above.");
  expect(prompt).toContain("a negated-support reminder, a CLOSER entry or a targeted search hit — `trace` it if the needed version was not supplied complete");
  expect(prompt).not.toContain("when an id is receipted");
  expect(prompt).not.toContain("in the block's omission receipt — `trace` it first");
  expect(prompt).not.toContain("inspect any receipted item that may maintain a claim");
});

/** Ticket 40 C1 as reversed by ticket 44: a persistent object's current state remains one
 * `reference` item, and finished work now closes by updating the same identity rather than archive. */
test("44 C6 reverses 40 C1: state and finished-work arcs update one identity", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  expect(prompt).toContain("as the v1.2 persistent-object state exception, a new-state fact updates that item with itself as the only support");
  expect(prompt).toContain("never a fresh create and never an archive while the object exists");
  expect(prompt).toContain("A negated-support reminder or a CLOSER entry supplies a check target, never a conclusion");
  expect(prompt).toContain("A summary report that does not prove per-item closure leaves the item unchanged; retirement is not a substitute for a justified update.");
  expect(prompt).toContain("A finished work item (fixes awaiting commit, a task awaiting results) is updated on the fact that ends it to state concisely that it ended and on what, holding no chain of completed events.");
  expect(prompt).toContain("A fact reporting a knowledge clause stale supports an update that removes the clause, not one that asserts the opposite state.");
  expect(prompt).not.toContain("completed results that must not be redone");
  expect(prompt).not.toContain("is archived on the fact that ends it");
});

/** Ticket 40 C2 (2026-09-14): no event narrative in knowledge text; the conditions and the
 * evidence level stay, so "installed" is not read as "running". */
test("40 C2: knowledge text carries no completion narrative but keeps the qualifiers", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  expect(prompt).toContain("The text carries no completion status or verification narrative of the work that produced the claim");
  expect(prompt).toContain("a rule stands on its own, a state item states the state, and the event stays in the fact layer where the item's supports point at it");
  expect(prompt).toContain("a qualifier that governs the next action or the evidence level stays");
  expect(prompt).toContain("so that \"installed\" is not read as \"running\"");
});

/** Ticket 40 C5 as reversed by ticket 44: approval changes the ban's category on the same K;
 * intent, baseline and each role's staffing are independently maintainable claims. */
test("44 C6 reverses 40 C5: approval updates same K and atomizes intent, baseline and staffing", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  expect(prompt).toContain("approval to start work updates the constraint that forbade it into the `goal` on the same id, changing category from `constraint` to `goal`");
  expect(prompt).toContain("the goal text holds the intent alone and nothing is archived");
  expect(prompt).toContain("The pinned development baseline is its own `reference` state item, updated as it moves.");
  expect(prompt).toContain("Each staffing choice is its own item with the role named first");
  expect(prompt).toContain("create one only if no corresponding identity exists");
  expect(prompt).toContain("A dispatch, pause, resume or completion report stays in the fact layer unless it changes a work item's target, progress or next step, in which case it updates that work item's `open`");
  expect(prompt).not.toContain("archives the constraint that forbade it and creates a `goal`");
});

test("44 C6 pins one-K identity continuity, causal supports and role/default separation", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  expect(prompt).toContain("A knowledge item is the versioned arc of one object.");
  expect(prompt).toContain("its state, its category, or its wording — is an update of the same id; retiring it belongs to the Dreamer");
  expect(prompt).toContain("the same object's same independently maintainable conclusion or state, whether the item is in the block or in the omission receipt");
  expect(prompt).toContain("a second item for it is never created");
  expect(prompt).toContain("an implementation-subagent default of Sol high, then Astra high, then Sol medium continues as versions of the same K");
  expect(prompt).toContain("A ticket-specific staffing override is separate and must not replace a broader global or project default; implementation and review roles are separate claims.");
  expect(prompt).toContain("`supports` names every fact of this range that moved the item to the submitted version");
  expect(prompt).toContain("Earlier versions' supports are inherited, not copied.");
  expect(prompt).toContain("The v1.2 persistent-object state exception above still cites the new-state fact alone.");
  expect(prompt).not.toContain("`supports` contains only the facts explicitly grounding this change");
  expect(prompt).not.toContain("List only facts that establish this admission/correction/withdrawal");
});

/** Ticket 40 N1 (2026-09-14, D2 ruled per subject): the atomicity rule is an executable split check
 * that runs before category selection; "comparison values are one claim" licensed the 28–46% merge
 * rate and is narrowed to the before-and-after values of one measurement. */
test("40 N1: claims that could be acted on separately are split, one fact per finding, plan element and compared subject", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8");
  expect(prompt).toContain("When one passage holds claims that could be approved, withdrawn, verified or completed separately, split them, each keeping its own conditions and exceptions.");
  expect(prompt).toContain("a statistic yields one fact per compared subject when each subject's numbers could be wrong on their own");
  expect(prompt).toContain("The before-and-after values of one measurement are one claim; a decision with its necessary reason is one claim.");
  expect(prompt).toContain("Conditions and exceptions travel with the claim they qualify and are never dropped to shorten it.");
  expect(prompt).not.toContain("comparison values are one claim");
});

/** Ticket 40 N4 (2026-09-14, D1 ruled yes): the deletion test alone dropped 11–12 of 34 user
 * instructions once their work completed in the same batch; the instruction that starts work is
 * recorded, because the answer and the event support it and the accounting checks it. */
test("40 N4: the user's instruction, question or plan approval that starts work is recorded even when the work completes in the same batch", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8");
  expect(prompt).toContain("The user's instruction or question that starts a piece of work, and the user's approval of a plan, are recorded even when the work completes in the same batch: they are what the answer and the event support, and what the Consolidator's accounting checks.");
});

/** Ticket 58 (2026-09-18): an approval or implementation fact names its object and supports it when
 * the object is in view; the Consolidator reads adoption from the adopting user fact's content and
 * scope, never from co-occurrence, a general authorisation or an implementation report, and the body
 * says whose decision it is in a few characters. Neither prompt names the case. */
test("58: an approval or implementation fact names its object and supports it when it is in view", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/noting.md", import.meta.url), "utf8");
  expect(prompt).toContain("An approval or an implementation states the object it approves or carries out and supports that object's record when it is in view: \"implement the spec and the tickets\" supports the facts that recorded the spec and the tickets, not the proposals made under them; a user requirement with no antecedent supports nothing. A proposal its author frames as changing an existing design or rule, or as conditional on the user's confirmation, keeps that framing in its own text.");
  expect(prompt).not.toMatch(/Engine|F1841|K386/);
});

test("58: the Consolidator reads adoption from the adopting user fact and states whose decision it is", () => {
  const prompt = readFileSync(new URL("../../../src/core/prompts/consolidation.md", import.meta.url), "utf8");
  expect(prompt).toContain("a support edge is neither required nor sufficient: adoption is read from the content and scope of a user fact that adopts that object — through its support edge when the object was in the Noter's view, otherwise by the object it names, bound to the identity whose cited chain carries the proposal, the approval becoming that version's change support — never from co-occurrence in a batch, a general authorisation that names no object, or an implementation report; a proposal without an adopting user fact stays a proposal, and an approval of one change adopts no other decision because both sit in one batch or one body.");
  expect(prompt).toContain("Authority comes from the user, and memory never manufactures it: every decision records where it came from and what the user's stance on it is, exactly as the facts state — the user's words stand as the user's; the assistant's proposals and acts stand as the assistant's, carrying no authority until a user fact grants it explicitly and for that object. Where the assistant changed or went beyond what the user had said and the facts leave the user's stance unsettled, the item is `open` with the question stated, not resolved either way, and what the user had said keeps its identity. The body says this in a few characters, in the conversation's language — never a bare \"current choice\" or \"confirmed\"; the reason describes the change and is not attribution.");
  expect(prompt).toContain("Single review findings, explanations of code and unadopted agent proposals fail unless they establish a rule or leave the user's stance on something the user had said unsettled (then `open`, below); a user's design proposal that the work proceeds under passes as a proposal — stated as the user's proposal, one identity until a user fact adopts or drops it — so that its adoption has an identity to continue.");
  expect(prompt).not.toContain('"the current choice"');
  expect(prompt).not.toMatch(/Engine|F1841|K386/);
});
