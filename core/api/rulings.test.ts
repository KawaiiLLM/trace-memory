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
  memory.store.setWatermark(s.id, "main", t.id); // recorded: the facts may enter an Integration batch
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
  expect(memory.trace("K1@1..K1@2")).toContain("F2");
  const runs = memory.store.listRuns(s.id);
  expect(runs.at(-1)).toMatchObject({ kind: "manual", outcome: "success", branch: "main", rangeFrom: "S1/T1", rangeTo: "S1/T1" });
  expect(JSON.parse(runs.at(-1)!.request!).operations[0].op).toBe("update");
  expect(JSON.parse(runs.at(-1)!.response!).results).toEqual(["ok"]);
});

test("2026-09-07: merge atomic", () => {
  const { create, write } = memoryWriter(); write([create, { ...create, text: "Avoid npm", supports: ["F2"] }]);
  const merge = { ...create, op: "merge", id: "K1", absorb: ["K2"], supports: ["F1", "F2"] };
  expect(write([merge, { op: "archive", id: "K999", because: [] }]).results[1]).toContain("rejected:");
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
    expect(memory.store.listIntegratedFacts(1)).toEqual([]);
    input.reportRequest({ messages: ["first", first.feedback] });
    expect(JSON.parse(tool.execute(batch)).committed).toHaveLength(1);
    expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
    expect(memory.store.integratedOnPath(2, memory.store.knowledgePath(s.id, "main"))).toBe(true);
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
  const content = (fact: string, text = "Use blue tiles") => ({ text, category: "constraint", scope: "project", supports: [fact], because: [fact] });
  expect(root.write([{ op: "create", ...content(root.fact) }]).committed[0].commit).toBe(1);
  const c = node(s.id, t.id, "C"), d = node(s.id, t.id, "D");
  const edit = (who: typeof root, text: string, fact = who.fact) => who.write([{ op: "update", id: "K1", ...content(fact, text) }]);
  const tips = (path: { sessionId: number; headTurnId: number }) => memory.store.currentCommit(1, path).map(r => r.id);
  const peer = (projectId = s.projectId) => {
    const other = memory.store.createSession({ host: "fake", projectId, startedAt: time, firstReplyAt: time });
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
    expect(memory.compact(path.sessionId, path.branch, path.headTurnId)).toContain(text);
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
  expect(next.write([{ op: "update", id: "K1", ...content(root.fact) }]).committed[0].commit).toBe(3);
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
  const rejected = d.write([{ op: "create", ...content(d.fact) }, { op: "update", id: "K1", ...content(d.fact) }]);
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
    expect(root.write([{ op: "update", id: "K1", ...content(root.fact, "First writer") }]).committed[0].commit).toBe(2);
    const stale = JSON.parse(writer[3]!.execute({ operations: [{ op: "create", ...content(other.fact) }, { op: "update", id: "K1", ...content(other.fact) }], skipped: [] }));
    expect(stale.results[1]).toContain("K1@2"); expect(second.store.getKnowledge(2)).toBeNull();
    writer[0]!.execute({ address: "K1" });
    const accepted = JSON.parse(writer[3]!.execute({ operations: [{ op: "update", id: "K1", ...content(other.fact, "Second writer") }], skipped: [] }));
    expect(accepted.committed[0].commit).toBe(3);
    expect(memory.store.currentCommit(1, root).map(r => r.id)).toEqual([3]);
    expect(second.store.getKnowledgeRevision(1, 3)?.parentId).toBe(2);
  } finally { second.close(); }
});

test("2026-09-07 A: archive has empty text and retires its parent only on its applicable path", () => {
  const { root, c, d, tips } = commitPaths();
  expect(c.write([{ op: "archive", id: "K1", because: [c.fact] }]).committed[0].commit).toBe(2);
  expect(memory.store.getKnowledgeRevision(1, 2)).toMatchObject({ op: "archive", text: "", supports: [], parentId: 1 });
  expect(tips(c)).toEqual([2]); expect(tips(d)).toEqual([1]); expect(tips(root)).toEqual([1]);
  expect(memory.inject(c)).not.toContain("K1@"); expect(memory.inject(d)).toContain("K1@1");
});

test("2026-09-07 A: sibling-branch facts are readable but supports and because require an adoption fact on this path", () => {
  const { c, d, content } = commitPaths();
  expect(c.tools[0]!.execute({ address: d.fact })).toContain(d.fact);
  for (const scope of ["session", "project", "global"]) for (const field of ["supports", "because"]) {
    const rejected = c.write([{ op: "create", ...content(c.fact), scope, [field]: [d.fact] }]);
    expect(rejected.results[0]).toContain("record an adoption fact on this path first");
    expect(memory.store.getKnowledge(2)).toBeNull();
  }
  const adopted = JSON.parse(c.tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Adopt the other branch's rule", quote: d.fact, source: [`T${c.headTurnId}#user`] }] }));
  expect(c.write([{ op: "create", ...content(`F${adopted.factIds[0]}`) }]).committed).toHaveLength(1);
});

test("2026-09-07: supports and because obey the session/project/global scope table", () => {
  const { c, peer, content } = commitPaths();
  const same = peer();
  const outside = peer(memory.store.createProject({ name: "outside", declaredBy: "mark" }).id);
  for (const scope of ["session", "project", "global"]) for (const field of ["supports", "because"]) for (const origin of [c, same, outside]) {
    const allowed = origin === c || scope === "global" || (scope === "project" && origin === same);
    const result = c.write([{ op: "create", ...content(c.fact), scope, [field]: [origin.fact] }]);
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
  expect(third.write([{ op: "update", id: "K1", ...content(third.fact) }]).results[0]).toContain("several tips");
  expect(() => memory.mark("K1", "verified", third)).toThrow("several tips");
  expect(memory.mark("K1@2", "verified", third)).toBe("K1@2: verified");
  third.tools[0]!.execute({ address: "K1@2" }); third.tools[0]!.execute({ address: "K1@3" });
  expect(third.write([{ op: "merge", id: "K1@2", absorb: ["K1@3"], ...content(third.fact, "Combined rule") }]).committed[0].commit).toBe(4);
  expect(tips(third)).toEqual([4]);
  expect(memory.store.getKnowledgeRevision(1, 4)?.parentId).toBe(2);
  expect(memory.store.listKnowledgeLinks(1)).toContainEqual({ fromKnowledge: 1, fromCommit: 3, kind: "merged_into", toKnowledge: 1, toCommit: 4 });
  expect(memory.store.listKnowledgeMarks(1)).toMatchObject([{ commitId: 2, kind: "verified" }]);
  expect(memory.trace("K1@4")).not.toContain("verified");
});

test("2026-09-07 B: store rechecks every base inside the transaction and rolls back an earlier create", () => {
  const { root, content } = commitPaths();
  root.write([{ op: "update", id: "K1", ...content(root.fact) }]);
  const result = memory.store.commitIntegrationRun({ path: root, run: { kind: "manual", sessionId: root.sessionId, createdAt: time }, operations: [
    { op: "create", handle: "$e1", author: "test", text: "Must roll back", category: "goal", scope: "project", supports: [1], because: [1], createdAt: time },
    { op: "archive", knowledgeId: 1, baseCommit: 1, because: [1], createdAt: time },
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
  root.write([{ op: "update", id: "K1", ...content(root.fact, "Unread successor") }]);
  expect(other.tools[0]!.execute({ address: "K1@1" })).not.toContain("Unread successor");
  expect(other.write([{ op: "update", id: "K1", ...content(other.fact) }]).results[0]).toContain("current: K1@2");
  other.tools[0]!.execute({ address: "K1@2" });
  expect(other.write([{ op: "update", id: "K1@2", ...content(other.fact) }]).committed[0].commit).toBe(3);
});

test("2026-09-07 A: scope applies before supersedence for first-prompt injection and bare path reads", () => {
  const { root, peer, content } = commitPaths();
  root.write([{ op: "update", id: "K1", ...content(root.fact, "Shared globally"), scope: "global" }]);
  const outsideProject = memory.store.createProject({ name: "outside", declaredBy: "mark" });
  const outside = peer(outsideProject.id);
  root.write([{ op: "update", id: "K1", ...content(root.fact, "Project only") }]);
  expect(memory.inject({ projectId: outsideProject.id })).toContain("K1@2");
  expect(memory.trace("K1", outside).split("\n")[0]).toContain("K1@2");
  root.write([{ op: "update", id: "K1", ...content(root.fact, "Session only"), scope: "session" }]);
  const ownProject = memory.store.getSession(root.sessionId)!.projectId;
  expect(memory.inject({ projectId: ownProject })).toContain("K1@3");
  expect(memory.inject({ projectId: outsideProject.id })).toContain("K1@2");
  expect(memory.inject(root)).toContain("K1@4");
});

test("2026-09-07: commit schema removes mutable heads and binds parents, links and marks to global ids", () => {
  const { root, content } = commitPaths();
  root.write([{ op: "create", ...content(root.fact, "Another identity") }]);
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

test("2026-09-07 A/B: Integration, NEAR and accounting use every current tip on the frozen path", async () => {
  const { root, c, d, peer, content, edit } = commitPaths();
  edit(c, "Use blue tiles on C"); edit(d, "Use blue tiles on D");
  const third = peer();
  const integrate = async (path: typeof third, expected: number[]) => {
    memory.close();
    memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
      const input = raw as import("./index.ts").IntegrationAgentInput;
      expect(input.readKnowledgeCommits.map(r => r.commit)).toEqual(expected);
      for (const id of expected) expect(input.input).toContain(`[K1@${id}]`);
      const batch = { operations: [{ op: "create", ...content(path.fact, "Use blue tiles") }], skipped: [] };
      input.reportRequest({ round: 1 });
      const first = JSON.parse(input.tools[3]!.execute(batch));
      for (const id of expected) expect(first.feedback.content).toContain(`[K1@${id}]`);
      if (expected.length > 1) for (const id of expected) expect(first.feedback.content).toContain(`-> K1@${id}`);
      input.reportRequest({ round: 2 });
      const result = JSON.parse(input.tools[3]!.execute(batch));
      expect(result.committed).toHaveLength(1);
      return { outcome: "success", request: { round: 2 }, output: "done" };
    });
    memory.store.setWatermark(path.sessionId, path.branch, path.headTurnId); // recorded up to the head: its facts may enter the batch
    return memory.integrate({ sessionId: path.sessionId, branch: path.branch, headTurnId: path.headTurnId });
  };
  const result = await integrate(third, [2, 3]);
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.diagnostics.some(d => d.kind === "uncited_facts")).toBe(false);
  // A sibling's support cannot cover this branch's user fact during accounting.
  memory.close();
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as import("./index.ts").IntegrationAgentInput;
    const own = input.readKnowledgeCommits.filter(r => r.knowledgeId === 1);
    expect(own.map(r => r.commit)).toEqual([2]);
    const batch = { operations: [{ op: "update", id: "K1", ...content(root.fact) }], skipped: [] };
    input.reportRequest({ round: 1 }); input.tools[3]!.execute(batch);
    input.reportRequest({ round: 2 }); input.tools[3]!.execute(batch);
    return { outcome: "success", request: { round: 2 }, output: "done" };
  });
  memory.store.setWatermark(c.sessionId, c.branch, c.headTurnId);
  const cResult = await memory.integrate({ sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId });
  if (cResult.outcome !== "success") throw new Error("expected success");
  expect(cResult.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [c.fact] });
});

test("2026-09-07 B: stale absorbed bases name the surviving current commit across merge links", () => {
  const { root, peer, content } = commitPaths();
  expect(root.write([{ op: "create", ...content(root.fact) }]).committed[0].commit).toBe(2);
  const other = peer();
  expect(root.write([{ op: "merge", id: "K1", absorb: ["K2"], ...content(root.fact) }]).committed[0].commit).toBe(3);
  root.write([{ op: "update", id: "K1", ...content(root.fact) }]);
  const rejected = other.write([{ op: "update", id: "K2", ...content(other.fact) }]);
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
  expect(c.write([{ op: "archive", id: "K1", because: [c.fact] }]).committed[0].commit).toBe(4);
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
  memory.store.setWatermark(c.sessionId, c.branch, c.headTurnId);
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
  expect(c.write([{ op: "update", id: "K1", ...content(`F${fact}`, "Use violet tiles") }]).committed[0].commit).toBe(2);
  for (const path of [root, d]) {
    expect(memory.branchSummary(path.sessionId, path.branch, path.headTurnId)).not.toContain(`[F${fact}]`);
    expect(memory.inject(path)).toContain("[K1@1]"); expect(memory.inject(path)).not.toContain("[K1@2]");
    expect(path.write([{ op: "create", ...content(`F${fact}`) }]).results[0]).toContain("record an adoption fact on this path first");
  }
  expect(memory.branchSummary(c.sessionId, c.branch, c.headTurnId)).toContain(`[F${fact}]`);
  expect(memory.inject(c)).toContain("[K1@2]");
});

test("2026-09-07: R<n> renders a run as a summary, full adds tool rounds and raw previews, a missing run is rejected", async () => {
  const { s, t } = session();
  calls.length = 0;
  await memory.record({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "subagent" });
  const run = memory.store.listRuns(s.id).at(-1)!;
  const summary = memory.trace(`R${run.id}`);
  expect(summary.split("\n")[0]).toBe(`R${run.id} recording ${run.outcome} ${run.createdAt}`);
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

test("2026-09-07: the Integration threshold triggers, the turn boundary cuts: whole recorded turns up to the threshold, the unrecorded head waits", async () => {
  const project = memory.store.createProject({ name: "batches", declaredBy: "mark" });
  const s = memory.store.createSession({ host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const turns = [1, 2, 3, 4].map((i, _, arr) => memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: `t${i}`, assistantText: "ok", startedAt: time, parentTurnId: undefined }));
  for (let i = 1; i < turns.length; i++) memory.store.db.prepare("UPDATE turns SET parent_turn_id = ? WHERE id = ?").run(turns[i - 1]!.id, turns[i]!.id);
  const seed = (turn: number, n: number, kind: "recording" | "manual" = "recording") => memory.store.commitRecordingRun({ run: { kind, sessionId: s.id, branch: "main", createdAt: time, rangeFrom: `S${s.id}/T${turn}`, rangeTo: `S${s.id}/T${turn}`, outcome: "success" } as never,
    facts: Array.from({ length: n }, (_, k) => ({ turnId: turn, category: "observation", actor: "user", text: `fact ${turn}.${k}`, source: [`T${turn}#user`], createdAt: time })) });
  seed(turns[0]!.id, 3); seed(turns[1]!.id, 3); seed(turns[2]!.id, 3);
  memory.store.setWatermark(s.id, "main", turns[2]!.id); // T1..T3 recorded, T4 (head) not yet
  seed(turns[3]!.id, 2, "manual"); // manual facts on the head being recorded
  const batch = memory.store.integrationBatch(s.id, "main", 5);
  expect(batch.map((f) => f.turnId)).toEqual([turns[0]!.id, turns[0]!.id, turns[0]!.id, turns[1]!.id, turns[1]!.id, turns[1]!.id]); // T1 and T2: 6 ≥ 5 at a turn boundary; T3 waits
  expect(batch.some((f) => f.turnId === turns[3]!.id)).toBe(false); // the unrecorded head never enters a batch
  expect(memory.store.integrationBatch(s.id, "main", 50)).toHaveLength(9); // below the threshold the batch is everything recorded
});

test("2026-09-07 review: a late fact on an early turn does not make the batch skip pending facts of later turns", () => {
  const project = memory.store.createProject({ name: "late-facts", declaredBy: "mark" });
  const s = memory.store.createSession({ host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id });
  const t1 = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "one", assistantText: "ok", startedAt: time, parentTurnId: undefined });
  const t2 = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "two", assistantText: "ok", startedAt: time, parentTurnId: t1.id });
  const seed = (turn: number, text: string) => memory.store.commitRecordingRun({ run: { kind: "manual", sessionId: s.id, branch: "main", createdAt: time, rangeFrom: `S${s.id}/T${turn}`, rangeTo: `S${s.id}/T${turn}`, outcome: "success" } as never,
    facts: [{ turnId: turn, category: "decision", actor: "user", text, source: [`T${turn}#user`], createdAt: time }] });
  seed(t1.id, "early decision"); seed(t2.id, "later decision"); seed(t1.id, "late supplement to the early decision"); // F3 lands on T1 after F2 on T2
  expect(memory.store.integrationBatch(s.id, "main", 2)).toEqual([]); // nothing recorded yet: no batch, whatever manual facts exist
  memory.store.setWatermark(s.id, "main", t2.id);
  const first = memory.store.integrationBatch(s.id, "main", 2);
  expect(first.map((f) => f.id)).toEqual([1, 3]); // T1 whole: F1 and the late F3
  expect(memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId: s.id, branch: "main", createdAt: time }, operations: [], integrated: first.map((f) => f.id) }).ok).toBe(true);
  expect(memory.store.integrationBatch(s.id, "main", 2).map((f) => f.id)).toEqual([2]); // F2 is still pending, not skipped
});
