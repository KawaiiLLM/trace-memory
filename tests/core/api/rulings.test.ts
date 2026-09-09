import { compacted, recorded } from "../../source-fixture.ts";
// Ruling test points: each test pins a user ruling that an implementation could silently deviate
// from. Names identify the ruling and its conversation date.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSOLIDATION_SUBAGENT_ONLY, DEFAULT_CONFIG, REMOVED_SETTINGS, TraceMemory, canonicalFlatConfig, renderEntry, runMode, toolDefinitions, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import * as api from "../../source-fixture.ts";
import { tokens } from "../../source-fixture.ts";

let directory: string;
let memory: TraceMemory;
let calls: NotingAgentInput[];
const time = "2026-09-06T00:00:00Z";
const ok = (output: unknown): RunAgentResult => ({ outcome: "success", output: JSON.stringify(output), request: { fake: true } });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-rulings-"));
  calls = [];
  memory = TraceMemory(join(directory, "test.sqlite"), async (raw) => { calls.push(raw as NotingAgentInput); return ok([]); });
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

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
  const probe = TraceMemory(join(directory, "test.sqlite"), async raw => {
    calls.push(raw as NotingAgentInput); return { ...ok([]), outcome: "failure" };
  });
  try { await probe.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" }); }
  finally { probe.close(); }
  await memory.noting({ sessionId: s.id, branch: "b2", headTurnId: t.id, mode: "subagent" });
  const [branch, subagent] = calls;
  expect(branch!.mode).toBe("fork");
  // The premise repair supplies the missing final reply and the source index as their own parts.
  expect(branch!.material.head).toBe(`[T${t.id}#assistant]: 好的。`);
  expect(branch!.material.sources).toEqual([`T${t.id}#user 用 pnpm，不要 npm | T${t.id}#assistant 好的。 | T${t.id}#t1 tool=Bash {"command":"pnpm install"}`]);
  // One frozen material serves both modes; no field of it is a provider message, and the block layout
  // of each mode is core's own since 20a, pinned in core/render/material.test.ts.
  expect(branch!.material).toEqual(subagent!.material);
  expect(Object.values(branch!.material).some(part => typeof part === "string" && part.includes("Range: "))).toBe(false);
  expect(branch!.prompt).toContain("already in this conversation");
  expect(subagent!.text.fresh).toContain("用 pnpm，不要 npm");
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
  expect(input.text.fresh).toContain(input.material.entries[0]!.view);
  expect(input.text.fresh.startsWith("Recent facts (by Turn):")).toBe(true); // 25a: no leading knowledge block
  expect(input.prompt).toContain("Noting (fact extraction)");
  expect(input.text.fresh).not.toContain(input.prompt);
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
  const probe = TraceMemory(join(directory, "test.sqlite"), async raw => {
    calls.push(raw as NotingAgentInput); return { ...ok([]), outcome: "failure" };
  });
  try { await probe.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" }); }
  finally { probe.close(); }
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const [fork, fresh] = calls;
  expect(fork!.mode).toBe("fork"); expect(fresh!.mode).toBe("subagent");
  expect(fork!.material).toEqual(fresh!.material);
  expect(fork!.entryIds).toEqual(fresh!.entryIds); // one writable range, whatever the execution mode
  expect(fork!.range).toEqual(fresh!.range);
  expect(fork!.readKnowledgeCommits).toEqual(fresh!.readKnowledgeCommits);
  // Both representations are prepared for both modes, from that one frozen task.
  expect(fork!.text).toEqual(fresh!.text);
  // The increment is what an inherited conversation lacks, not a second copy of the full text.
  expect(fork!.text.inherited).not.toContain(fork!.material.entries[0]!.view);
  expect(fork!.text.fresh).not.toContain(fork!.text.inherited);
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
  expect(calls[0]!.text.fresh).not.toContain("<knowledge>"); // the fourth consumer no longer
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const consolidation = calls.at(-1)! as unknown as import("../../../src/core/api/index.ts").ConsolidationAgentInput;
  const block = consolidation.text.fresh.split("\n\nRange: ")[0]!;
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
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ round: 1 });
    const note = input.tools[2]!;
    const batch = { facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: [`T${t.id}#user`] }] };
    expect(note.execute(batch)).toContain("F1");
    expect(memory.store.getRun(1)?.outcome).toBe("success");
    expect(JSON.parse(memory.store.getRun(1)!.request!)).toEqual({ round: 1 });
    expect(memory.store.sourcePath(s.id, "main", t.id).length).toBeGreaterThan(0);
    expect(memory.store.sourcePath(s.id, "main", t.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
    expect(memory.store.listPendingDeliveries(s.id, "main")).toHaveLength(1);
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
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
    if (reject) (raw as NotingAgentInput).tools[2]!.execute({ facts: [{ category: "invalid" }] });
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
  expect(memory.store.listPendingDeliveries(s.id, "main")).toEqual([]);
});

function memoryWriter() {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  tools[2]!.execute({ facts: ["Use pnpm", "Do not use npm"].map(text => ({ category: "decision", actor: "user", text, source: [`T${t.id}#user`] })) });
  recorded(memory, s.id, "main", t.id); // recorded: the facts may enter an Consolidation batch
  const create = { op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"] };
  return { s, t, write: (operations: unknown[]) => JSON.parse(tools[3]!.execute({ operations, skipped: [] })), create };
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
  const { create, write, s } = memoryWriter();
  const created = write([create]);
  expect(created.results).toEqual(["ok"]);
  expect(memory.store.getKnowledgeRevision(1, 1)).toMatchObject({ supports: [1], reason: "Initial admission of this conclusion." });
  write([{ ...create, op: "update", reason: "Substantive correction of the recorded conclusion.", id: "K1", text: "Avoid npm", supports: ["F2"] }]);
  expect(memory.store.getKnowledgeRevision(1, 2)).toMatchObject({ supports: [2], reason: "Substantive correction of the recorded conclusion." });
  expect(memory.store.getKnowledgeRevision(1, 1)?.supports).toEqual([1]);
  expect(memory.trace("K1@1..K1@2")).toContain("F2");
  const runs = memory.store.listRuns(s.id);
  expect(runs.at(-1)).toMatchObject({ kind: "manual", outcome: "success", branch: "main", rangeFrom: "S1/T1", rangeTo: "S1/T1" });
  expect(JSON.parse(runs.at(-1)!.request!).operations[0].op).toBe("update");
  expect(JSON.parse(runs.at(-1)!.response!).results).toEqual(["ok"]);
});

test("2026-09-07: merge atomic", () => {
  const { create, write } = memoryWriter(); write([create, { ...create, text: "Avoid npm", supports: ["F2"] }]);
  const merge = { ...create, op: "merge", reason: "Merged duplicate knowledge into the survivor.", id: "K1", absorb: ["K2"], supports: ["F1", "F2"] };
  expect(write([merge, { op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: "K999", supports: [] }]).results[1]).toContain("rejected:");
  expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
  expect(memory.store.currentCommit(2)[0]?.op).toBe("create");
  expect(memory.store.listKnowledgeLinks(2)).toEqual([]);
  expect(write([merge]).results).toEqual(["ok"]);
  expect(memory.store.currentCommit(2)).toEqual([]);
  expect(memory.store.getKnowledge(2)).toMatchObject({ id: 2 });
  expect(memory.store.listKnowledgeLinks(2)).toEqual([{ fromKnowledge: 2, fromCommit: 2, kind: "merged_into", toKnowledge: 1, toCommit: 3 }]);
  expect(memory.trace("K2")).toContain("Avoid npm"); expect(memory.trace("K2")).toContain("K1@3");
});

test("2026-09-07: second submission commits, first does not", async () => {
  const { create, s } = memoryWriter(); memory.close();
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
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
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: head.id });
  const input = calls[0]!;
  expect(input.mode).toBe("fork");
  expect(input.material.head).toBe(`[T${head.id}#assistant]: ${head.assistantText}`);
  expect(input.material.sources).toEqual([
    `T2#user 012345678901234567890123456789012345678901234567890123456789 | T2#assistant Earlier reply`,
    `T3#user Check it | T3#assistant Final-only finding: result result result result result resul | T3#t1 tool=Bash {"command":"check"}`]);
  expect(input.material.head).not.toContain("PRIVATE USER TAIL");
  expect(input.material.sources.join("\n")).not.toContain("PRIVATE TOOL RESULT");
});

test("2026-09-07: branch source previews keep one line and at most 60 Unicode characters without a final reply", async () => {
  const { s } = session();
  const t = memory.store.appendTurn({ sessionId: s.id, parentTurnId: null, kind: "turn",
    userPrompt: "😀".repeat(59) + "\nTAIL", assistantText: null, startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: "x".repeat(60) + "\nTAIL", result: null, status: "attempted" });
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id });
  expect(calls[0]!.material.head).toBe(null);
  expect(calls[0]!.material.sources).toEqual([`T2#user ${"😀".repeat(59)}  | T2#t1 tool=Bash ${"x".repeat(60)}`]);
});

test.each(["user", "assistant", "t1"] as const)("2026-09-07: trace source suffix #%s renders only its part", (part) => {
  const { s, t } = session();
  const tool = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[0]!;
  // 23b: a source part reads as the entry view of that part — the addresses its labels carry, and for
  // a call both of its parts: the arguments the assistant sent and the result that came back.
  const expected = part === "user" ? `[T${t.id}#user]: 用 pnpm，不要 npm`
    : part === "assistant" ? `[T${t.id}#assistant]: 好的。`
    : `[T${t.id}#t1] Bash(command="pnpm install")\n[T${t.id}#t1] Bash success: {"stdout":"done","stderr":""}`;
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
  expect(full).toBe(`[T${t.id}#t2] Bash(command="second")\n[T${t.id}#t2] Bash success: ${output}`);
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
  const node = (sessionId: number, parentTurnId: number | null, branch: string) => {
    const turn = memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: branch, startedAt: time });
    return writer(sessionId, turn.id, branch);
  };
  const writer = (sessionId: number, headTurnId: number, branch: string) => {
    const tools = memory.tools({ kind: "manual", sessionId, currentTurnId: headTurnId, branch });
    const receipt = JSON.parse(tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: branch, source: [`T${headTurnId}#user`] }] }));
    expect(receipt.results[0]).toMatch(/^ok:/);
    const fact = `F${receipt.factIds[0]}`;
    return { sessionId, headTurnId, branch, fact, tools,
      write: (operations: unknown[]) => JSON.parse(tools[3]!.execute({ operations, skipped: [] })) };
  };
  const root = writer(s.id, t.id, "main");
  const content = (fact: string, text = "Use blue tiles") => ({ text, category: "constraint", scope: "project", supports: [fact] });
  expect(root.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }]).committed[0].commit).toBe(1);
  const c = node(s.id, t.id, "C"), d = node(s.id, t.id, "D");
  const edit = (who: typeof root, text: string, fact = who.fact) => who.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(fact, text) }]);
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

test("2026-09-07 A: revert then develop on one path follows commit ancestry, including an inapplicable intermediate", () => {
  const { root, c, node, edit, tips, content } = commitPaths();
  expect(edit(c, "C version").committed[0].commit).toBe(2);
  const next = node(c.sessionId, c.headTurnId, "C");
  expect(next.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact) }]).committed[0].commit).toBe(3);
  // Commit 3 cites only root evidence, so it supersedes commit 1 even where commit 2 does not apply.
  expect(tips(root)).toEqual([3]);
  expect(edit(next, "Develop after revert").committed[0].commit).toBe(4);
  expect(tips(next)).toEqual([4]); expect(tips(root)).toEqual([3]);
  expect(memory.trace("K1@1..K1@4")).toContain("{+Develop+}");
  expect(memory.trace("K1..")).toContain("K1@3 update");
});

test("2026-09-07 B: pre-fork evidence applies to both branches and rejects the sibling's stale base atomically", () => {
  const { root, c, d, content, edit, tips } = commitPaths();
  expect(edit(c, "Shared pre-fork correction", root.fact).committed[0].commit).toBe(2);
  expect(tips(c)).toEqual([2]); expect(tips(d)).toEqual([2]);
  const rejected = d.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(d.fact) }, { op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(d.fact) }]);
  expect(rejected.results).toHaveLength(2); expect(rejected.results[1]).toContain("current: K1@2");
  expect(memory.store.getKnowledge(2)).toBeNull();
  expect(d.tools[0]!.execute({ address: "K1" })).toContain("K1@2");
  expect(edit(d, "After rereading").committed[0].commit).toBe(3);
});

test("2026-09-07 B: cross-session concurrent edits reject linearly, then re-read and resubmit", () => {
  const { root, peer, content } = commitPaths();
  const other = peer();
  const second = TraceMemory(join(directory, "test.sqlite"), async () => ok([]));
  try {
    const writer = second.tools({ kind: "manual", sessionId: other.sessionId, currentTurnId: other.headTurnId, branch: "main" });
    expect(root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact, "First writer") }]).committed[0].commit).toBe(2);
    const stale = JSON.parse(writer[3]!.execute({ operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(other.fact) }, { op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(other.fact) }], skipped: [] }));
    expect(stale.results[1]).toContain("K1@2"); expect(second.store.getKnowledge(2)).toBeNull();
    writer[0]!.execute({ address: "K1" });
    const accepted = JSON.parse(writer[3]!.execute({ operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(other.fact, "Second writer") }], skipped: [] }));
    expect(accepted.committed[0].commit).toBe(3);
    expect(memory.store.currentCommit(1, root).map(r => r.id)).toEqual([3]);
    expect(second.store.getKnowledgeRevision(1, 3)?.parentId).toBe(2);
  } finally { second.close(); }
});

test("2026-09-07 A: archive has empty text and retires its parent only on its applicable path", () => {
  const { root, c, d, tips } = commitPaths();
  expect(c.write([{ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: "K1", supports: [c.fact] }]).committed[0].commit).toBe(2);
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
  expect(memory.trace("K1")).toContain("Alternative K1@2");
  expect(memory.trace("K1")).toContain("Alternative K1@3 (newest-created)");
  expect(memory.inject(third)).toContain("K1@2"); expect(memory.inject(third)).toContain("K1@3");
  expect(third.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(third.fact) }]).results[0]).toContain("several tips");
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

// Ticket 24a "Footer counts": the footer's `memory` right-hand number is the applicable current
// knowledge in `listCurrentKnowledge`'s own counting unit, so the two divergent tips of one identity
// that this path sees are the two items they are — one identity is not counted once, and neither tip
// is chosen over the other. The left-hand number is exact Consolidation membership over the same
// path, never "every applicable fact minus the cited ones".
test("24a 2026-09-09: the footer counts use current-tip semantics, and pending facts are exact membership rather than total minus cited", () => {
  const { c, d, peer, edit, tips } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  const third = peer();
  expect(tips(third)).toEqual([2, 3]); // two divergent tips of K1 on this path
  const counted = memory.progress(third.sessionId, third.branch, third.headTurnId);
  expect(counted.knowledge).toBe(2);
  expect(counted.knowledge).toBe(memory.store.listCurrentKnowledge({ sessionId: third.sessionId, headTurnId: third.headTurnId, branch: third.branch }).length);
  // This peer wrote one fact and consolidated nothing, so every applicable fact is still pending.
  expect(counted).toMatchObject({ facts: 1, unconsolidated: 1 });
  expect(counted.entries).toBe(memory.pendingEntries(third.sessionId, third.branch, third.headTurnId).length);
  const consolidated = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: third.sessionId, branch: third.branch, createdAt: time },
    operations: [], consolidated: [Number(third.fact.slice(1))] });
  expect(consolidated.ok).toBe(true);
  const after = memory.progress(third.sessionId, third.branch, third.headTurnId);
  expect(after).toMatchObject({ facts: 1, unconsolidated: 0, knowledge: 2 }); // the fact stays applicable, the queue empties
  expect(after.unconsolidated).toBe(memory.store.consolidationBatch(third.sessionId, third.branch, third.headTurnId).length);
  // The root path sees one tip of the same identity: the count follows the path, not the knowledge row.
  expect(memory.progress(1, "main", 1).knowledge).toBe(1);
});

test("2026-09-07 B: store rechecks every base inside the transaction and rolls back an earlier create", () => {
  const { root, content } = commitPaths();
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact) }]);
  const result = memory.store.commitConsolidationRun({ path: root, run: { kind: "manual", sessionId: root.sessionId, createdAt: time }, operations: [
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
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact, "Unread successor") }]);
  expect(other.tools[0]!.execute({ address: "K1@1" })).not.toContain("Unread successor");
  expect(other.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(other.fact) }]).results[0]).toContain("current: K1@2");
  other.tools[0]!.execute({ address: "K1@2" });
  expect(other.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1@2", ...content(other.fact) }]).committed[0].commit).toBe(3);
});

test("2026-09-07 A: scope applies before supersedence for first-prompt injection and bare path reads", () => {
  const { root, peer, content } = commitPaths();
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact, "Shared globally"), scope: "global" }]);
  const outsideProject = memory.store.createProject({ name: "outside", declaredBy: "mark" });
  const outside = peer(outsideProject.id);
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact, "Project only") }]);
  expect(memory.inject({ projectId: outsideProject.id })).toContain("K1@2");
  expect(memory.trace("K1", outside).split("\n")[0]).toContain("K1@2");
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact, "Session only"), scope: "session" }]);
  const ownProject = memory.store.getSession(root.sessionId)!.projectId;
  expect(memory.inject({ projectId: ownProject })).toContain("K1@3");
  expect(memory.inject({ projectId: outsideProject.id })).toContain("K1@2");
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
    memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
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
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as import("../../../src/core/api/index.ts").ConsolidationAgentInput;
    const own = input.readKnowledgeCommits.filter(r => r.knowledgeId === 1);
    expect(own.map(r => r.commit)).toEqual([2]);
    const batch = { operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact) }], skipped: [] };
    input.reportRequest({ round: 1 }); input.tools[3]!.execute(batch);
    input.reportRequest({ round: 2 }); input.tools[3]!.execute(batch);
    return { outcome: "success", request: { round: 2 }, output: "done" };
  });
  recorded(memory, c.sessionId, c.branch, c.headTurnId);
  const cResult = await memory.consolidate({ sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId });
  if (cResult.outcome !== "success") throw new Error("expected success");
  expect(cResult.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [c.fact] });
});

test("2026-09-07 B: stale absorbed bases name the surviving current commit across merge links", () => {
  const { root, peer, content } = commitPaths();
  expect(root.write([{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...content(root.fact) }]).committed[0].commit).toBe(2);
  const other = peer();
  expect(root.write([{ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", id: "K1", absorb: ["K2"], ...content(root.fact) }]).committed[0].commit).toBe(3);
  root.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(root.fact) }]);
  const rejected = other.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K2", ...content(other.fact) }]);
  expect(rejected.results[0]).toContain("current: K1@4");
  expect(memory.store.getKnowledge(2)).not.toBeNull();
  expect(memory.store.currentCommit(2, other)).toEqual([]);
});

test("16b: path trace separates applicable history, parents, children and sibling tips", () => {
  const { root, c, d, edit } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  const trace = memory.trace("K1", c);
  expect(trace).toContain("K1 path current: K1@2");
  expect(trace).toContain("parents: K1@1");
  const [history, others] = trace.split("Applicable history on this path:")[1]!.split("Other branches' tips:");
  expect(history).toContain("K1@1 create"); expect(history).toContain("K1@2 update"); expect(history).not.toContain("K1@3");
  expect(others).toContain("[K1@3]");
  expect(memory.trace("K1", root)).toContain("K1 path current: K1@1");
  const tree = memory.trace("K1..");
  expect(tree).toContain("children: K1@2, K1@3");
  for (const id of [1, 2, 3]) expect(tree).toContain(`[K1@${id}]`);
  expect(memory.trace("K1")).not.toMatch(/current/i);
  expect(memory.trace("K1@1")).toContain("children: K1@2, K1@3");
});

test("16b: commit addresses are global, full diffs allow siblings and reverse order, missing stays missing", () => {
  const { c, d, edit } = commitPaths();
  edit(c, "C version"); edit(d, "D version");
  expect(memory.trace("K1@2..K1@3")).toContain("[-C-]{+D+} version");
  expect(memory.trace("K1@3..K1@2")).toContain("[-D-]{+C+} version");
  expect(memory.trace("K1@2..K1@2")).toContain("Commits: none");
  for (const address of ["K1@1..2", "K1@2..3", "K1@2..K2@3", "K1@2..", "K1@2..K1@9007199254740992"]) {
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
  const hits = memory.search("", "knowledge", c).split("\n");
  expect(hits.find(l => l.startsWith("[K1@1]"))).toContain("superseded on this path by K1@2");
  expect(hits.find(l => l.startsWith("[K1@2]"))).toContain("current on this path");
  expect(hits.find(l => l.startsWith("[K1@3]"))).toContain("another branch");
  expect(memory.search("C version", "knowledge", root)).toContain("another branch");
  expect(c.tools[0]!.execute({ address: "K1" })).toContain("C version");
  expect(c.write([{ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: "K1", supports: [c.fact] }]).committed[0].commit).toBe(4);
  expect(memory.search("C version", "knowledge", c)).toContain("archived on this path");
  expect(memory.search("D version", "knowledge", d)).toContain("current on this path");
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
  const fact = JSON.parse(c.tools[2]!.execute({ facts: [{ category: "decision", actor: "agent", text: "Use violet tiles", source: [`T${root.headTurnId}#user`, `T${c.headTurnId}#assistant`] }] })).factIds[0];
  expect(c.write([{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: "K1", ...content(`F${fact}`, "Use violet tiles") }]).committed[0].commit).toBe(2);
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
// tokens, and that ceiling is the one effective Raw ceiling compact shares.
test("20b 2026-09-08: 17b's 50,000-token Noting batch is superseded by a 10,000-token ceiling shared with compact", async () => {
  expect(DEFAULT_CONFIG.noting.batchTokens).toBe(10_000);
  expect(DEFAULT_CONFIG.noting.triggerTokens).toBe(10_000);
  const { s, t } = session();
  const big = (id: string) => memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(4000), raw: "", calls: [] });
  big("a"); big("b"); big("c");
  // compact measures the same Raw against the same ceiling instead of a second knob of its own: these
  // primary views are over it, so 20c's compact escalates rather than keeping them; raising that one
  // ceiling (there is no second) puts the same Raw back inside tier 1.
  expect(memory.compact(s.id, "main", t.id).tier).toBe("secondary");
  memory.config.noting.batchTokens = 100_000; memory.config.render.episodicBlockTokens = 200_000;
  expect(memory.compact(s.id, "main", t.id).tier).toBe("primary");
  memory.config.noting.batchTokens = DEFAULT_CONFIG.noting.batchTokens;
  memory.config.render.episodicBlockTokens = DEFAULT_CONFIG.render.episodicBlockTokens;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const views = calls[0]!.material.entries.map(e => e.view);
  expect(tokens(views.join("\n\n"))).toBeLessThanOrEqual(DEFAULT_CONFIG.noting.batchTokens);
  expect(memory.pendingEntries(s.id, "main", t.id).length).toBeGreaterThan(0); // the rest waits; 50,000 would have taken it
});

// ---- 20c 2026-09-08: the compaction rule is superseded, recorded here by its own name ----

// The specification's "Compaction is instant and never calls a model" (spec.md; user story 6).
// Superseded by ticket 20 on 2026-09-08, and superseded ONLY by the native fallback: core still calls
// no model in any tier, and there is no summarizer inside core. When no complete representation of
// every selected entry fits, compact returns an explicit request for native compaction, and Pi's own
// compaction — which may call a model, and may fail or be cancelled — runs under Pi's outcome
// handling. Neither the secondary views nor any summary becomes a source, a fact or a receipt.
test("20c 2026-09-08: 'compaction never calls a model' is superseded only by Pi's native fallback, and no core tier calls one", async () => {
  const { s, t } = session();
  const sources = memory.store.listSourceEntries(s.id).length;
  const pending = memory.pendingEntries(s.id, "main", t.id).map(e => e.id);
  expect(memory.compact(s.id, "main", t.id).tier).toBe("primary");
  // Over the shared Raw ceiling: the lossier secondary views, still deterministic local work.
  for (const id of ["a", "b", "c"]) memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(4000), raw: "", calls: [] });
  expect(memory.compact(s.id, "main", t.id).tier).toBe("secondary");
  // Over the enclosing budget even then: the one route to a model, and it is Pi's, not core's.
  memory.config.render.episodicBlockTokens = 10;
  const delegated = memory.compact(s.id, "main", t.id);
  expect(delegated.tier).toBe("native");
  expect(delegated).not.toHaveProperty("text"); // a request, never an empty or manufactured summary
  expect(delegated.tier === "native" && delegated.reason).toBeTruthy();
  expect(calls).toHaveLength(0); // no tier reached this façade's runAgent at all
  // No tier changed the sources, the facts or the processing progress it read.
  expect(memory.store.listSourceEntries(s.id).length).toBe(sources + 3);
  expect(memory.store.listSessionFacts(s.id)).toHaveLength(0);
  expect(pending.length).toBeGreaterThan(0);
  expect(memory.pendingEntries(s.id, "main", t.id).map(e => e.id)).toEqual(expect.arrayContaining(pending));
  // Normal Noter input keeps using the primary views; the compact-only view exists nowhere else.
  memory.config.render.episodicBlockTokens = DEFAULT_CONFIG.render.episodicBlockTokens;
  await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.material.entries.every(e => !e.view.includes("compact-only"))).toBe(true);
  expect(calls[0]!.text.fresh).not.toContain("compact-only");
});

// ---- 23 2026-09-09: the entry view's rulings, each recorded by the name it supersedes ----

// 17a, 2026-09-08: "arguments and result permanently reserve half each" of one call budget. Ticket 23a
// superseded it with a quarter for the arguments and three quarters for the result; ticket 23c (user,
// 2026-09-09) supersedes that in turn and restores the halves, on the measurement that the quarter cut
// 218 of 337 bash commands on the real log while three quarters still cut 573 of 835 results, and that
// at `B = 300` the halves total 286K tokens against 312K. The split is still fixed and never
// redistributed: arguments are rendered before their result exists and views are immutable.
test("23c 2026-09-09: 23a's quarter/three-quarter call split is superseded; arguments and result each take one half of B", () => {
  const { s, t } = session();
  const long = JSON.stringify({ command: "echo " + "a".repeat(5_000) });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: long, result: "b".repeat(5_000), status: "success" });
  const entries = memory.store.listSourceEntries(s.id);
  const size = (role: string) => tokens(renderEntry(entries.filter(e => e.role === role && e.calls.length).at(-1)!, memory.config.render).content);
  const half = Math.floor(DEFAULT_CONFIG.render.toolCallTokens / 2);
  // Each fills its own half, within one cut unit of it; neither is a quarter or three quarters of `B`.
  for (const role of ["assistant", "toolResult"]) expect([role, size(role) <= half && size(role) > half - 5]).toEqual([role, true]);
  expect(size("assistant")).toBeGreaterThan(Math.floor(DEFAULT_CONFIG.render.toolCallTokens / 4));
  expect(size("toolResult")).toBeLessThan(Math.floor(DEFAULT_CONFIG.render.toolCallTokens * 3 / 4));
});

// 17a, 2026-09-08: `toolCallTokens` defaulted to 1,000. Superseded by ticket 23: the default is 300
// and 1,000 becomes the hard ceiling, rejected above; `entryTokens` keeps its 17a value.
test("23 2026-09-09: 17a's 1,000-token per-call default becomes 300 with 1,000 as a hard ceiling, and entryTokens is unchanged", () => {
  expect(DEFAULT_CONFIG.render).toMatchObject({ toolCallTokens: 300, entryTokens: 10_000, secondaryToolCallTokens: 100, secondaryEntryTokens: 1_000 });
  const open = (render: Record<string, number>) => TraceMemory(join(directory, "ceiling.sqlite"), async () => ok([]), { render });
  expect(() => open({ toolCallTokens: 1_001 })).toThrow("Invalid render.toolCallTokens: at most 1000");
  const ceiling = open({ toolCallTokens: 1_000 });
  try { expect(ceiling.config.render.toolCallTokens).toBe(1_000); } finally { ceiling.close(); }
});

// 20c, 2026-09-08: compaction's second tier was a separate compact-only renderer with its own version
// and its own excerpt rules. Superseded by ticket 23: tier 2 is the one entry renderer under the
// tier-2 profile. The three-tier escalation and the native tier are unchanged.
test("23 2026-09-09: 20c's separate compact-only renderer is superseded; tier 2 is the one renderer under the tier-2 profile", () => {
  const { s, t } = session();
  for (const id of ["a", "b", "c"]) memory.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId: id, turnId: t.id,
    role: "assistant", text: `${id} ` + "word ".repeat(4000), raw: "", calls: [] });
  const result = memory.compact(s.id, "main", t.id);
  expect(result.tier).toBe("secondary");
  const text = compacted(result);
  const profile = { toolCallTokens: DEFAULT_CONFIG.render.secondaryToolCallTokens, entryTokens: DEFAULT_CONFIG.render.secondaryEntryTokens };
  for (const entry of memory.pendingEntries(s.id, "main", t.id)) expect(text).toContain(renderEntry(entry, profile, memory.resultText).content);
  expect(text).not.toContain("compact-only");
  expect("SECONDARY_VIEW_VERSION" in api).toBe(false); // the version constant went with the renderer
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
  expect(memory.taskEligibility("consolidation", target, "subagent").due).toBe(false);
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
  for (let i = 0; i < 6; i++) write("constraint", `constraint ${i} ` + "word ".repeat(60));
  write("reference", "reference tail");
  const cap = 200;
  memory.config.render.knowledgeBlockTokens = cap;
  const injected = memory.inject(s.id);
  expect(injected).toContain("<constraint>"); // first priority, kept
  expect(injected).not.toContain("reference tail"); // lower priority, omitted
  const block = injected.split("\n\nReceipts:")[0]!, receipts = injected.split("\n\nReceipts:")[1]!;
  expect(tokens(block) + tokens(receipts)).toBeLessThanOrEqual(cap); // the exemption is gone: no category bypasses it
  expect(receipts).toContain("constraint knowledge; expand: K"); // some constraints were omitted, and are named
  const omitted = /expand: (K\d+)/.exec(receipts)![1]!;
  expect(memory.trace(omitted)).toContain(`[${omitted}@`); // omitted is not deleted
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
  const cresult = await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent", boundary: { factIds: frozenFacts } });
  expect(cresult.outcome).toBe("success");
  if (cresult.outcome === "success") expect(cresult.range.facts.map(f => f.id)).toEqual(frozenFacts);
  expect(memory.store.consolidationBatch(s.id, "main", t.id)).toHaveLength(1); // the later fact stays outside the frozen target
});

// ---- 19c: the execution mode is fork; branch remains the evidence path (ticket 19 "Naming and compatibility") ----

test("19c 2026-09-08: the legacy branchModeDefault spelling is accepted, mapped onto forkModeDefault, and not kept", () => {
  const legacy = TraceMemory(join(directory, "alias.sqlite"), async () => ok([]), { noting: { branchModeDefault: false } });
  try {
    expect(legacy.config.noting.forkModeDefault).toBe(false);              // the old key still selects the mode
    expect(Object.hasOwn(legacy.config.noting, "branchModeDefault")).toBe(false); // only the canonical key survives
  } finally { legacy.close(); }
  // Both spellings supplied and agreeing: the canonical one wins, silently.
  const agreeing = TraceMemory(join(directory, "agreeing.sqlite"), async () => ok([]), { noting: { branchModeDefault: false, forkModeDefault: false } });
  try { expect(agreeing.config.noting.forkModeDefault).toBe(false); } finally { agreeing.close(); }
});

test("19c 2026-09-08: both execution-mode spellings with different values fail the load naming both keys", () => {
  const load = () => TraceMemory(join(directory, "conflict.sqlite"), async () => ok([]), { noting: { branchModeDefault: true, forkModeDefault: false } });
  expect(load).toThrow(/noting\.branchModeDefault/);
  expect(load).toThrow(/noting\.forkModeDefault/);
  expect(load).toThrow(/Conflicting settings/);
});

test("24 amendment 2 2026-09-09, as 25 amendment 2 left it: configure replaces the one execution-mode default, validated like the load path, and nothing else", async () => {
  // A saved global preference must reach tasks admitted afterwards without a reload. Admission reads
  // its mode from the configuration frozen at construction, so exactly that boolean may move —
  // Consolidation's was retired with the mode it chose (25b), and is refused below like any other key.
  expect(memory.config.noting.forkModeDefault).toBe(true);
  memory.configure({ noting: { forkModeDefault: false } });
  expect(memory.config.noting.forkModeDefault).toBe(false);
  expect(memory.config.noting.batchTokens).toBe(DEFAULT_CONFIG.noting.batchTokens); // nothing else moved
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
  expect(() => memory.configure({ consolidation: { nearThreshold: 0.5 } })).toThrow("Unknown setting consolidation");
  expect(memory.config.noting.forkModeDefault).toBe(true);
  expect(memory.config.consolidation.nearThreshold).toBe(DEFAULT_CONFIG.consolidation.nearThreshold);
  expect(memory.config.render.entryTokens).toBe(DEFAULT_CONFIG.render.entryTokens);
});

// ---- 25 amendment 2 2026-09-09: Consolidation has one execution mode ----

test("25 amendment 2 2026-09-09: the retired Consolidation mode preference is refused by name at load, in every configuration space", () => {
  // The mode is gone, so the key that chose it is a removed setting, not an alias: a saved value —
  // `true`, which asked for what happens anyway, as much as `false` — fails the load naming the key
  // and the only remedy there is. Nothing is normalized and no file is rewritten.
  expect(REMOVED_SETTINGS["consolidation.subagentModeDefault"]).toBe(CONSOLIDATION_SUBAGENT_ONLY);
  const message = `Removed setting consolidation.subagentModeDefault: ${CONSOLIDATION_SUBAGENT_ONLY}`;
  for (const saved of [true, false]) {
    const load = () => TraceMemory(join(directory, `saved-${saved}.sqlite`), async () => ok([]), { consolidation: { subagentModeDefault: saved } as never });
    expect(load).toThrow(message);
    // The flat `section.key` space every host loads its settings files through, and the runtime surface.
    expect(() => canonicalFlatConfig({ "consolidation.subagentModeDefault": saved })).toThrow(message);
    expect(() => memory.configure({ consolidation: { subagentModeDefault: saved } as never })).toThrow(message);
  }
  expect(Object.hasOwn(DEFAULT_CONFIG.consolidation, "subagentModeDefault")).toBe(false); // and the menu that builds itself from the defaults shows it nowhere
});

test("25 amendment 2 2026-09-09: an explicit Consolidation fork request is refused with the same sentence, and the default run is a subagent with normal attribution", async () => {
  const { s, t } = session();
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id }).find(tool => tool.name === "note")!
    .execute({ facts: [{ category: "decision", actor: "user", text: "Keep pnpm", source: [`T${t.id}#user`] }] });
  const pending = memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id);
  // Refused, not quietly run as a subagent: the caller learns the mode no longer exists.
  await expect(memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "fork" }))
    .rejects.toThrow(`Invalid consolidation mode fork: ${CONSOLIDATION_SUBAGENT_ONLY}`);
  expect(memory.store.listRuns(s.id).filter(r => r.kind === "consolidation")).toEqual([]); // no run, no claim, no progress
  expect(memory.store.consolidationBatch(s.id, "main", t.id).map(f => f.id)).toEqual(pending);
  // The same for the mode a host reports it will actually run in.
  await expect(memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id, effectiveMode: "fork" }))
    .rejects.toThrow(CONSOLIDATION_SUBAGENT_ONLY);
  // The request that says nothing gets the one mode, recorded as itself on the task and on the run.
  expect((await memory.consolidate({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
  expect(calls.at(-1)!.mode).toBe("subagent");
  const run = memory.store.listRuns(s.id).at(-1)!;
  expect([run.kind, run.mode, run.model]).toEqual(["consolidation", "subagent", "session"]);
  expect(JSON.parse(run.response!).requestedMode).toBe("subagent");
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
  expect((await memory.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success"); // configuration default
  expect(calls.at(-1)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).at(-1)!.mode).toBe("fork");
  expect(memory.store.listRuns(s.id).some(r => r.mode === "branch")).toBe(false);
});

test("19c 2026-09-08: a stored branch-mode run reads as legacy request-copy execution and is never rewritten", async () => {
  const seed = (m: TraceMemory) => {
    const project = m.store.createProject({ name: "historical", declaredBy: "mark" });
    const s = m.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
    const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
    return { s, t };
  };
  const path = join(directory, "historical.sqlite");
  const before = TraceMemory(path, async raw => { calls.push(raw as NotingAgentInput); return ok([]); });
  const { s, t } = seed(before);
  // A pre-rename row, exactly as the deleted request-copy runner wrote it. No migration touches it.
  before.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", mode: "branch", model: "old/model",
    rangeFrom: `S${s.id}/T${t.id}`, rangeTo: `S${s.id}/T${t.id}`, createdAt: time }, facts: [] });
  const legacy = before.store.listRuns(s.id).at(-1)!.id;
  before.close();
  const after = TraceMemory(path, async raw => { calls.push(raw as NotingAgentInput); return ok([]); });
  try {
    expect(after.store.getRun(legacy)!.mode).toBe("branch");   // reopening the database migrates nothing
    expect(after.trace(`R${legacy}`)).toContain("mode legacy request-copy execution (branch)");
    expect(after.trace(`R${legacy}`)).not.toContain("mode fork"); // an old run is never described as a native fork
    expect(runMode("fork")).toBe("fork"); expect(runMode("subagent")).toBe("subagent"); // new modes read as themselves
    // Reading it, and running new work in the same database afterwards, leave the stored value alone.
    expect((await after.noting({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
    expect(after.trace(`R${legacy}`)).toContain("legacy request-copy execution");
    expect(after.store.getRun(legacy)!.mode).toBe("branch");
    expect(after.store.listRuns(s.id).map(r => r.mode)).toEqual(["branch", "fork"]);
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
  const { create, write } = memoryWriter();
  const operation = toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, any>;
  const schema = operation.operations.items;
  expect(schema.required).toEqual(["op", "supports", "reason"]);
  expect(schema.properties).not.toHaveProperty("because");
  expect(schema.properties.reason).toEqual({ type: "string", minLength: 1 });
  expect(operation.skipped.items.properties.because).toEqual({ type: "string", minLength: 1 }); // unchanged protocol
  const factSchema = (toolDefinitions.find(t => t.name === "note")!.parameters.properties as Record<string, any>).facts.items;
  expect(factSchema.properties).not.toHaveProperty("reason"); // facts gain no commit metadata and the surface stays four tools
  expect(write([create]).committed).toHaveLength(1);
  expect(write([{ op: "archive", id: "K1", supports: ["F1"], reason: "Withdrawn by the user." }]).committed).toHaveLength(1);
  expect(memory.store.getKnowledgeRevision(1, 2)?.supports).toEqual([1]); // no longer cleared
});

// Ticket 21 "Applicability" and "Branch scenario", scenario 5: one citation rule for every commit.
test("21a 2026-09-08: an archive's supports face the same session/project/global table as any other commit", () => {
  const { c, peer, content } = commitPaths();
  const same = peer(), outside = peer(memory.store.createProject({ name: "outside 21a", declaredBy: "mark" }).id);
  for (const scope of ["session", "project", "global"]) for (const origin of [c, same, outside]) {
    const created = c.write([{ op: "create", topics: [], ...content(c.fact), scope, reason: "Admitted for the archive scope check." }]);
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const archived = c.write([{ op: "archive", id: `K${created.committed[0].knowledgeId}`, supports: [origin.fact],
      reason: `Retired on ${origin.branch} evidence.` }]);
    expect(!!archived.committed).toBe(allowed);
  }
  // Naming the foreign fact in the reason does not adopt it: the reason is prose, never a citation.
  const created = c.write([{ op: "create", topics: [], ...content(c.fact), scope: "session", reason: "Admitted for the reason-bypass check." }]);
  expect(c.write([{ op: "archive", id: `K${created.committed[0].knowledgeId}`, supports: [outside.fact],
    reason: `The user adopted ${outside.fact} on this path.` }]).results[0]).toContain("rejected:");
});

// ---- 21b 2026-09-08: topics classify revisions and change nothing else ----

// Ticket 21 "History and scope", scenario 14: a shared label is not a shared status.
test("21b 2026-09-08: a shared label alters no applicability, keeps its history labels and never collapses two applicable tips", () => {
  const { c, d, peer, content, tips } = commitPaths();
  const label = (who: typeof c, text: string) => who.write([{ op: "update", id: "K1", topics: ["tiling"],
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
  expect(third.write([{ op: "archive", id: "K1@2", supports: [third.fact], reason: "Retired on this path." }]).committed).toHaveLength(1);
  expect(memory.store.getKnowledgeRevision(1, 4)!.topics).toEqual(["tiling"]);
  const hits = memory.search("tiling", "knowledge").split("\n").filter(l => l.startsWith("[K"));
  expect(hits).toHaveLength(3); // the two tips and the archive; the unlabelled root commit is not a hit
  expect(hits.find(l => l.startsWith("[K1@4]"))).toContain("note: archived");
  expect(hits.find(l => l.startsWith("[K1@2]"))).toContain("note: archived"); // retired, not presented as a current rule
  expect(hits.find(l => l.startsWith("[K1@3]"))).toContain("note: tip");
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
