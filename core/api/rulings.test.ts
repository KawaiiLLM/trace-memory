// Ruling test points: each test pins a user ruling that an implementation could silently deviate
// from. Names quote the ruling; dates are the conversation the ruling was made in (2026-09-06).
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

test("08:53: in branch mode the appended note message carries only the range; subagent mode carries the raw", async () => {
  const { s, t } = session();
  await memory.record({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "branch" });
  await memory.record({ sessionId: s.id, branch: "b2", headTurnId: t.id, mode: "subagent" });
  const [branch, subagent] = calls;
  expect(branch!.mode).toBe("branch");
  // "fork模式只有最后一个": the range and the instruction (the prompt), nothing else.
  expect(branch!.input).toBe(`Range: S${s.id}/T${t.id}..S${s.id}/T${t.id}`);
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
  expect(tools[3]!.execute({ operations: [{ op: "create" }, { op: "archive" }], skipped: [] })).toContain("not implemented until ticket 10");
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
