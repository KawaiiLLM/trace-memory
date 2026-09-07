// Ruling test points: each test pins a user ruling that an implementation could silently deviate
// from. Names quote the ruling; dates are the conversation the ruling was made in (2026-09-06).
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, type NoteAgentInput, type RunAgentResult } from "./index.ts";
import { tokens } from "../render/index.ts";

let directory: string;
let memory: TraceMemory;
let calls: NoteAgentInput[];
const time = "2026-09-06T00:00:00Z";
const ok = (output: unknown): RunAgentResult => ({ outcome: "success", output: JSON.stringify(output), request: { fake: true } });

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-rulings-"));
  calls = [];
  memory = TraceMemory(join(directory, "test.sqlite"), async (raw) => { calls.push(raw as NoteAgentInput); return ok([]); });
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
  await memory.note({ sessionId: s.id, branch: "main", headTurnId: t.id, mode: "branch" });
  await memory.note({ sessionId: s.id, branch: "b2", headTurnId: t.id, mode: "subagent" });
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

// 09:43 "sessions of one project settle separately": pinned in core/api/settle.test.ts,
// "each session settles only its own branch facts and shares already-settled context".
