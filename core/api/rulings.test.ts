// Ruling test points: each test pins a user ruling that an implementation could silently deviate
// from. Names identify the ruling and its conversation date.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, type RecordingAgentInput, type RunAgentResult } from "./index.ts";
import { tokens } from "./index.ts";

let directory: string;
let memory: TraceMemory;
let calls: RecordingAgentInput[];
const time = "2026-09-06T00:00:00Z";
const ok = (output: unknown): RunAgentResult => ({ outcome: "success", output: JSON.stringify(output), request: { fake: true } });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-rulings-"));
  calls = [];
  memory = TraceMemory(join(directory, "test.sqlite"), async (raw) => { calls.push(raw as RecordingAgentInput); return ok([]); });
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

function session() {
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  const s = memory.store.createSession({ host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "用 pnpm，不要 npm", assistantText: "好的。", startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command: "pnpm install" }), result: JSON.stringify({ stdout: "done", stderr: "" }), status: "success" });
  return { s, t };
}

test("Q12: token estimate weighs CJK at 0.75 per character and everything else at 0.25", () => {
  expect(tokens("abcd")).toBe(1);
  expect(tokens("地形值")).toBe(3);
  expect(tokens("mapC 地形")).toBe(Math.ceil(5 * 0.25 + 2 * 0.75));
  // A Chinese line must never be estimated as if it were ASCII: 40 characters is 30 tokens, not 10.
  expect(tokens("一".repeat(40))).toBe(30);
  // Characters, not UTF-16 code units: four astral emoji are four characters, one token.
  expect(tokens("😀😀😀😀")).toBe(1);
});

test("Q12 + render budgets: cuts are measured with the same estimate, so Chinese output is cut at its token cap, not at four characters per token", () => {
  const { s, t } = session();
  const han = "一".repeat(400), ascii = "a".repeat(400);
  const call = (command: string) => memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command }), result: JSON.stringify({ stdout: "" }), status: "success" });
  call(han); call(ascii);
  const rendered = memory.trace(`S${s.id}/T${t.id}`);
  expect(rendered).not.toContain(han);   // 300 tokens over a 120-token command cap: cut.
  expect(rendered).toContain(ascii);     // 100 tokens: kept whole.
  expect(rendered).toContain("[omitted 1 lines, 400 characters]");
});

test("08:53 with 2026-09-07 premise repair: branch uses conversation context; subagent carries the raw", async () => {
  const { s, t } = session();
  await memory.record({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "branch" });
  await memory.record({ sessionId: s.id, branch: "b2", headTurnId: t.id, mode: "subagent" });
  const [branch, subagent] = calls;
  expect(branch!.mode).toBe("branch");
  // The premise repair adds only the missing final reply and source index.
  expect(branch!.input).toBe(`Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}\n\n[Source entry id: T${t.id}#assistant]\n好的。\n\nSources:\nT${t.id}#user 用 pnpm，不要 npm | T${t.id}#assistant 好的。 | T${t.id}#t1 tool=Bash {"command":"pnpm install"}`);
  expect(branch!.subagentInput).toBe(subagent!.input);
  expect(branch!.prompt).toContain("already in this conversation");
  expect(subagent!.input).toContain("Raw:");
  expect(subagent!.input).toContain("用 pnpm，不要 npm");
});

test("09:43: trace accepts both T<n> and S<n>/T<n>; a mismatched session does not resolve", () => {
  const { s, t } = session();
  const plain = memory.trace(`T${t.id}`);
  expect(memory.trace(`S${s.id}/T${t.id}`)).toBe(plain);
  expect(() => memory.trace(`S${s.id + 1}/T${t.id}`)).toThrow("does not exist");
});

// 09:43 "sessions of one project integrate separately": pinned in core/api/integration.test.ts,
// "each session settles only its own branch facts and shares already-settled context".

// User, 2026-09-07: “mark可以合并掉，最终4个工具，trace search和两个分别操作事实和记忆。主agent允许用，但无需提示用，本身不是它的职责”
// User, 2026-09-07: “工具名叫note和memory”.
test("2026-09-07: four tools, no other model-facing surface", () => {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  expect(tools.map(t => t.name)).toEqual(["trace", "search", "note", "memory"]);
  for (const tool of tools) { expect(tool.parameters.type).toBe("object"); expect(typeof tool.execute).toBe("function"); }
  for (const tool of tools.slice(2)) expect(tool.description).toContain("runs are the normal writers");
  expect(tools[3]!.execute({ operations: [{ op: "create" }, { op: "archive" }], skipped: [] })).toContain("rejected:");
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

// “A Recording run commits at most one batch.”
test("2026-09-07: one batch per run", async () => {
  const { s, t } = session(); memory.close();
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as RecordingAgentInput;
    input.reportRequest({ round: 1 });
    const note = input.tools[2]!;
    const batch = { facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: [`T${t.id}#user`] }] };
    expect(note.execute(batch)).toContain("F1");
    expect(memory.store.getRun(1)?.outcome).toBe("success");
    expect(JSON.parse(memory.store.getRun(1)!.request!)).toEqual({ round: 1 });
    expect(memory.store.getWatermark(s.id, "main")?.lastRecordedTurn).toBe(t.id);
    expect(memory.store.listPendingDeliveries(s.id, "main")).toHaveLength(1);
    expect(note.execute(batch)).toContain("already committed");
    return { outcome: "success", output: "Done", request: { round: 2 } };
  });
  expect((await memory.record({ sessionId: s.id, branch: "main", headTurnId: t.id })).outcome).toBe("success");
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
    if (reject) (raw as RecordingAgentInput).tools[2]!.execute({ facts: [{ category: "invalid" }] });
    return { outcome: "success", output: "No more text", request: {} };
  });
  const input = { sessionId: s.id, branch: "main", headTurnId: t.id };
  expect((await memory.record(input)).outcome).toBe("bounced");
  expect(memory.store.getRun(1)?.outcome).toBe("bounced");
  expect(JSON.parse(memory.store.getRun(1)!.response!).toolCalls[0].input).toEqual({ facts: [{ category: "invalid" }] });
  expect(memory.store.getWatermark(s.id, "main")).toBeNull();
  reject = false;
  expect(await memory.record(input)).toMatchObject({ outcome: "success", facts: [] });
  expect(memory.store.getWatermark(s.id, "main")?.lastRecordedTurn).toBe(t.id);
  expect(memory.store.listPendingDeliveries(s.id, "main")).toEqual([]);
});

function memoryWriter() {
  const { s, t } = session();
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  tools[2]!.execute({ facts: ["Use pnpm", "Do not use npm"].map(text => ({ category: "decision", actor: "user", text, source: [`T${t.id}#user`] })) });
  const create = { op: "create", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], because: ["F2"] };
  return { s, t, write: (operations: unknown[]) => JSON.parse(tools[3]!.execute({ operations, skipped: [] })), create };
}

test("2026-09-07: one operation shape, inapplicable fields rejected", () => {
  const { create, write } = memoryWriter();
  write([create]);
  const update = { ...create, op: "update", id: "K1" };
  for (const operation of [create, update, { ...update, op: "merge", absorb: ["K2"] }, { op: "archive", id: "K1", because: [] }]) {
    const { because: _because, ...missing } = operation;
    expect(write([missing]).results[0]).toContain("rejected:");
  }
  const wrong = [{ ...create, id: "K1" }, { ...create, absorb: ["K1"] }, { ...update, absorb: ["K2"] },
    ...["text", "category", "scope", "supports", "absorb"].map(key => ({ op: "archive", id: "K1", because: [], [key]: key === "supports" || key === "absorb" ? [] : "x" })),
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
  expect(memory.store.getKnowledgeRevision(1, 1)).toMatchObject({ supports: [1], because: [2] });
  write([{ ...create, op: "update", id: "K1", text: "Avoid npm", supports: ["F2"], because: ["F1"] }]);
  expect(memory.store.getKnowledgeRevision(1, 2)).toMatchObject({ supports: [2], because: [1] });
  expect(memory.store.getKnowledgeRevision(1, 1)?.supports).toEqual([1]);
  expect(memory.trace("K1@1..2")).toContain("F2");
  const runs = memory.store.listRuns(s.id);
  expect(runs.at(-1)).toMatchObject({ kind: "manual", outcome: "success", branch: "main", rangeFrom: "S1/T1", rangeTo: "S1/T1" });
  expect(JSON.parse(runs.at(-1)!.request!).operations[0].op).toBe("update");
  expect(JSON.parse(runs.at(-1)!.response!).results).toEqual(["ok"]);
});

test("2026-09-07: merge atomic", () => {
  const { create, write } = memoryWriter(); write([create, { ...create, text: "Avoid npm", supports: ["F2"] }]);
  const merge = { ...create, op: "merge", id: "K1", absorb: ["K2"], supports: ["F1", "F2"] };
  expect(write([merge, { op: "archive", id: "K999", because: [] }]).results[1]).toContain("rejected:");
  expect(memory.store.getKnowledge(1)?.currentRevision).toBe(1);
  expect(memory.store.getKnowledge(2)?.status).toBe("active");
  expect(memory.store.listKnowledgeLinks(2)).toEqual([]);
  expect(write([merge]).results).toEqual(["ok"]);
  expect(memory.store.getKnowledge(2)).toMatchObject({ status: "merged", currentRevision: 1 });
  expect(memory.store.listKnowledgeLinks(2)).toEqual([{ fromKnowledge: 2, fromRev: 1, kind: "merged_into", toKnowledge: 1, toRev: 2 }]);
  expect(memory.trace("K2")).toContain("Avoid npm"); expect(memory.trace("K2")).toContain("K1@2");
});

test("2026-09-07: second submission commits, first does not", async () => {
  const { create, s } = memoryWriter(); memory.close();
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as import("./index.ts").IntegrationAgentInput;
    const batch = { operations: [create], skipped: [{ fact: "F2", because: "Already expressed." }] };
    input.reportRequest({ messages: ["first"] });
    const tool = input.tools[3]!;
    expect(tool.execute({ operations: [{ ...create, id: "K1" }], skipped: [] })).toContain("rejected:");
    const first = JSON.parse(tool.execute(batch));
    expect(first.feedback).toMatchObject({ role: "user" });
    expect(first.feedback.content).toContain("NEAR:"); expect(first.feedback.content).toContain("CLOSER:");
    expect(first.feedback.content).toContain("System-generated review guidance; not a human ruling or adoption evidence.");
    expect(memory.store.getKnowledge(1)).toBeNull();
    expect(memory.store.getWatermark(s.id, "main")?.lastIntegratedFact ?? null).toBeNull();
    input.reportRequest({ messages: ["first", first.feedback] });
    expect(JSON.parse(tool.execute(batch)).committed).toHaveLength(1);
    expect(memory.store.getKnowledge(1)?.currentRevision).toBe(1);
    expect(memory.store.getWatermark(s.id, "main")?.lastIntegratedFact).toBe(2);
    expect(tool.execute(batch)).toContain("already committed");
    return { outcome: "failure", output: "provider failed after commit", request: { messages: ["last"] } };
  });
  const result = await memory.integrate({ sessionId: s.id, branch: "main" });
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
  await memory.record({ sessionId: s.id, branch: "main", headTurnId: head.id });
  const input = calls[0]!;
  expect(input.mode).toBe("branch");
  expect(input.input).toContain(`[Source entry id: T${head.id}#assistant]\n${head.assistantText}`);
  expect(input.input).toContain(`Sources:\nT${first.id}#user`);
  expect(input.input).toContain(`T${head.id}#t1 tool=Bash`);
  expect(input.input).not.toContain("PRIVATE USER TAIL");
  expect(input.input).not.toContain("PRIVATE TOOL RESULT");
  expect(input.input).toBe(`Range: S1/T2..S1/T3

[Source entry id: T3#assistant]
Final-only finding: result result result result result result result result result result verified.

Sources:
T2#user 012345678901234567890123456789012345678901234567890123456789 | T2#assistant Earlier reply
T3#user Check it | T3#assistant Final-only finding: result result result result result resul | T3#t1 tool=Bash {"command":"check"}`);
});

test("2026-09-07: branch source previews keep one line and at most 60 Unicode characters without a final reply", async () => {
  const { s } = session();
  const t = memory.store.appendTurn({ sessionId: s.id, parentTurnId: null, kind: "turn",
    userPrompt: "😀".repeat(59) + "\nTAIL", assistantText: null, startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: "x".repeat(60) + "\nTAIL", result: null, status: "attempted" });
  await memory.record({ sessionId: s.id, branch: "main", headTurnId: t.id });
  expect(calls[0]!.input).toBe(`Range: S1/T2..S1/T2\n\nSources:\nT2#user ${"😀".repeat(59)}  | T2#t1 tool=Bash ${"x".repeat(60)}`);
});

test.each(["user", "assistant", "t1"] as const)("2026-09-07: trace source suffix #%s renders only its part", (part) => {
  const { s, t } = session();
  const tool = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[0]!;
  const expected = part === "user" ? `[Source entry id: T${t.id}#user]\n用 pnpm，不要 npm`
    : part === "assistant" ? `[Source entry id: T${t.id}#assistant]\n好的。`
    : `[T${t.id}#t1] tool=Bash status=success omitted=false\ncommand:\npnpm install\nstdout:\ndone`;
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
  expect(cut).toContain("omitted=true");
  expect(cut).not.toContain(output);
  expect(cut).not.toContain("#t1");
  const full = memory.trace(`T${t.id}#t2`, { full: true });
  expect(full).toBe(`[T${t.id}#t2] tool=Bash status=success omitted=false\ncommand:\nsecond\nreport:\n${output}`);
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
