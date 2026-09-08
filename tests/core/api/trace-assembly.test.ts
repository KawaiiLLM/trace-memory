// 23b: an explicit `trace` of a Turn without `full` is that Turn's selected source entries, in path
// order, each rendered by the entry renderer under the tier-1 profile. The per-tool branches of the
// old Turn preview — a read or search as its path, a bash command with its stdout and stderr, a report
// head and tail — and the tool-name regex that chose between them are gone, and so are the three
// budgets that shaped them. `full` is unchanged: the stored arguments and result envelope, uncut.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, renderEntry, type ConfigOverride } from "../../source-fixture.ts";

const time = "2026-09-09T00:00:00Z";
let directory: string, memory: ReturnType<typeof TraceMemory>, sessionId: number;
const open = (config: ConfigOverride = {}) =>
  TraceMemory(join(directory, "trace.db"), async () => { throw new Error("these cases call no model"); }, config);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-23b-"));
  memory = open();
  const projectId = memory.store.createProject({ name: "assembly", declaredBy: "mark" }).id;
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId }).id;
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

const header = (turnId: number) => `[S${sessionId}/T${turnId}] ${time} [turn]`;
const turn = (userPrompt: string, assistantText: string | null = null, parentTurnId: number | null = null) =>
  memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt, assistantText, startedAt: time });
/** A native occurrence the fixture host records on its own, beside the ones the Turn shape mirrors. */
const occurrence = (turnId: number, nativeId: string, entry: Partial<Parameters<typeof memory.appendEntry>[0]>) =>
  memory.appendEntry({ sessionId, nativeLineage: "fixture", nativeId, turnId, role: "assistant", text: "", raw: "{}", calls: [], ...entry });

test("23b golden: a Turn with several assistant messages shows each one, in path order", () => {
  const t = turn("what changed?", "first reply");
  occurrence(t.id, "second-reply", { text: "second reply" });
  expect(memory.trace(`T${t.id}`)).toBe([header(t.id),
    `[Source entry id: T${t.id}#user]`, "what changed?",
    `[Source entry id: T${t.id}#assistant]`, "first reply",
    `[Source entry id: T${t.id}#assistant]`, "second reply"].join("\n"));
});

test("23b golden: a call with several native result occurrences shows each occurrence", () => {
  const t = turn("run it");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo hi" }), result: "first result", status: "success" });
  occurrence(t.id, "retry", { role: "toolResult", calls: [{ ordinal: 1, name: "bash", callId: "call-1", result: "second result", status: "failure" }] });
  expect(memory.trace(`T${t.id}`)).toBe([header(t.id),
    `[Source entry id: T${t.id}#user]`, "run it",
    `[T${t.id}#t1] bash`, "command: echo hi",
    `[T${t.id}#t1] bash success`, "first result",
    `[T${t.id}#t1] bash failure`, "second result"].join("\n"));
  // Both occurrences are the same address; `full` still shows them as the stored evidence (22c).
  expect(memory.trace(`T${t.id}`, { full: true })).toContain("multiple results");
});

test("23b golden: a sibling branch's entries never appear in this branch's trace", () => {
  const t = turn("shared question", "shared reply");
  const shared = memory.store.listSourceEntries(sessionId, t.id).map(e => e.id);
  const sibling = occurrence(t.id, "sibling-reply", { text: "abandoned reply" });
  memory.selectEntries(sessionId, "main", shared);
  memory.selectEntries(sessionId, "fork", [...shared, sibling.id]);
  const bound = { sessionId, headTurnId: t.id, branch: "main" };
  expect(memory.trace(`T${t.id}`, bound)).toBe([header(t.id),
    `[Source entry id: T${t.id}#user]`, "shared question",
    `[Source entry id: T${t.id}#assistant]`, "shared reply"].join("\n"));
  expect(memory.trace(`T${t.id}`, { ...bound, branch: "fork" })).toContain("abandoned reply");
  // An unbound read names no branch and stays unrestricted, as 17a ruled for shared-call fork results.
  expect(memory.trace(`T${t.id}`)).toContain("abandoned reply");
});

test("23b golden: tool selection renders one call and keeps every other call's label and omission receipt", () => {
  const t = turn("two calls");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo one" }), result: "output one", status: "success" });
  memory.store.appendToolCall({ turnId: t.id, name: "read", input: JSON.stringify({ file_path: "/tmp/x.md" }), result: "y".repeat(40), status: "success" });
  expect(memory.trace(`T${t.id}`, { tool: 1 })).toBe([header(t.id),
    `[Source entry id: T${t.id}#user]`, "two calls",
    `[T${t.id}#t1] bash`, "command: echo one",
    `[T${t.id}#t1] bash success`, "output one",
    `[T${t.id}#t2] read`, "[omitted 9 characters]",
    `[T${t.id}#t2] read success`, "[omitted 40 characters; middle not inspected]",
    "", "Receipts:",
    `T${t.id}: 1 omitted calls (including partial calls)`,
    `expand: trace({"address":"T${t.id}","tool":2,"full":true})`].join("\n"));
  // The unselected call is sealed at its floor even though its payload would have fitted the budget.
  expect(memory.trace(`T${t.id}`, { tool: 1 })).not.toContain("/tmp/x.md");
  expect(memory.trace(`T${t.id}`)).toContain("file_path: /tmp/x.md"); // no selection: every call renders
  expect(memory.trace(`T${t.id}`)).not.toContain("Receipts:"); // and nothing was omitted to receipt
});

test("23b golden: full renders the stored arguments and result envelope, uncut", () => {
  const t = turn("keep the evidence");
  const input = JSON.stringify({ command: "echo " + "x".repeat(4_000), timeout: 30 });
  const result = JSON.stringify({ stdout: "z".repeat(4_000), exitCode: 0 });
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input, result, status: "success" });
  expect(memory.trace(`T${t.id}#t1`, { full: true }))
    .toBe(`[T${t.id}#t1] tool=bash status=success omitted=false\ninput:\n${input}\nresult:\n${result}`);
  expect(memory.trace(`T${t.id}#t1`)).not.toContain(input); // without full, the same evidence under B
});

test("23b: a read of a tool result without full is the entry renderer's tier-1 rendering of that entry", () => {
  const t = turn("render me");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo hi" }), result: "r".repeat(4_000), status: "success" });
  const entries = memory.store.listSourceEntries(sessionId, t.id);
  const views = entries.map(e => renderEntry(e, memory.config.render, memory.resultText).content);
  expect(memory.trace(`T${t.id}`)).toBe([header(t.id), ...views].join("\n") +
    `\n\nReceipts:\nT${t.id}: 1 omitted calls (including partial calls)\nexpand: trace({"address":"T${t.id}","tool":1,"full":true})`);
  const result = entries.find(e => e.role === "toolResult")!;
  expect(memory.trace(`T${t.id}#t1`)).toContain(renderEntry(result, memory.config.render, memory.resultText).content);
});

test("23b: the per-tool branches of the Turn preview, the tool-name regex and the stdout/stderr constants are gone from src", () => {
  const source = readFileSync(new URL("../../../src/core/render/index.ts", import.meta.url), "utf8");
  const code = source.split("\n").filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join("\n");
  for (const gone of ["STDOUT_HEAD_TOKENS", "STDOUT_TAIL_TOKENS", "STDERR_TAIL_TOKENS",
    "read_file", "memoryWrite", "stdout", "stderr", "report", "commandTokens", "reportHeadTokens", "reportTailTokens"]) {
    expect([gone, code.includes(gone)]).toEqual([gone, false]);
  }
});

test("23b 2026-09-09: the three explicit-preview budgets are rejected at load, by name, with the replacement named", () => {
  for (const key of ["commandTokens", "reportHeadTokens", "reportTailTokens"]) {
    expect(() => open({ render: { [key]: 2 } as never }))
      .toThrow(`Removed setting render.${key}: use render.toolCallTokens (one budget for the whole tool call)`);
  }
});
