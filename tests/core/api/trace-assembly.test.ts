import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, renderEntry, renderEntryWhole, memoryFiles, type ConfigOverride, hydrate } from "../../source-fixture.ts";

const time = "2026-09-09T00:00:00Z";
let directory: string, memory: ReturnType<typeof sourceSeededMemory>, sessionId: number;
const open = (config: ConfigOverride = {}) => sourceSeededMemory(join(directory, "trace.db"), async () => { throw Error("no model"); }, config);
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-23b-")); memory = open();
  const projectId = memory.store.createProject({ name: "assembly", declaredBy: "mark" }).id;
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId }).id;
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
const turn = (userPrompt: string, assistantText: string | null = null, parentTurnId: number | null = null) =>
  memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt, assistantText, startedAt: time });
const occurrence = (turnId: number, nativeId: string, entry: Partial<Parameters<typeof memory.appendEntry>[0]>) =>
  memory.appendEntry({ sessionId, nativeLineage: "fixture", nativeId, turnId, role: "assistant", text: "", raw: "{}", calls: [], ...entry });
const files = (headTurnId: number) => memoryFiles(memory, { sessionId, branch: "main", headTurnId });
const raw = (turnId: number) => `trace://raw/S${sessionId}/T${turnId}`;

test("multiple assistant occurrences retain entry order in the compressed overview", () => {
  const t = turn("what changed?", "first reply"); occurrence(t.id, "second-reply", { text: "second reply" });
  const text = files(t.id).read(raw(t.id)).content;
  expect(text.indexOf("first reply")).toBeLessThan(text.indexOf("second reply"));
  expect(text).toContain(`T${t.id}#E1@user`);
  expect(text).toContain(`T${t.id}#E3@assistant`);
});

test("multiple native results retain separate entry addresses, not one merged tool result", () => {
  const t = turn("run it");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo hi" }), result: "first result", status: "success" });
  occurrence(t.id, "retry", { role: "toolResult", calls: [{ ordinal: 1, name: "bash", callId: "call-1", result: "second result", status: "failure" }] });
  const text = files(t.id).read(raw(t.id)).content;
  expect(text).toContain(`[T${t.id}#E3@observation] bash success: first result`);
  expect(text).toContain(`[T${t.id}#E4@observation] bash failure: second result`);
  expect(files(t.id).read(`${raw(t.id)}#E4`).content).toContain("second result");
});

test("sibling branch contributes only its selected entries to an overview; exact E remains readable", () => {
  const t = turn("shared question", "shared reply");
  const shared = hydrate(memory.store.listSourceEntries(sessionId, t.id), memory.store).map(e => e.id);
  const sibling = occurrence(t.id, "sibling-reply", { text: "abandoned reply" });
  memory.selectEntries(sessionId, "main", shared);
  memory.selectEntries(sessionId, "fork", [...shared, sibling.id]);
  // 118 ruling 8 selects a named node from the session's current containing branch.
  memory.store.setCurrentPath(sessionId, "main", t.id, "fixture");
  expect(files(t.id).read(raw(t.id)).content).not.toContain("abandoned reply");
  memory.store.setCurrentPath(sessionId, "fork", t.id, "fixture");
  expect(memoryFiles(memory, { sessionId, branch: "fork", headTurnId: t.id }).read(raw(t.id)).content).toContain("abandoned reply");
  expect(files(t.id).read(`${raw(t.id)}#E${sibling.entryOrdinal}`).content).toContain("abandoned reply");
});

test("exact full entries retain complete arguments and results beyond the overview budget", () => {
  const t = turn("keep evidence"), command = "echo " + "x".repeat(4000), result = "z".repeat(4000);
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command }), result, status: "success" });
  const entries = hydrate(memory.store.listSourceEntries(sessionId, t.id), memory.store);
  expect(files(t.id).read(`${raw(t.id)}#E2`).content).toBe(renderEntryWhole(entries[1]!).content);
  expect(files(t.id).read(`${raw(t.id)}#E3`).content).toBe(renderEntryWhole(entries[2]!, memory.resultText).content);
  expect(files(t.id).read(`${raw(t.id)}#E2`).content).toContain(command);
  expect(files(t.id).read(`${raw(t.id)}#E3`).content).toContain(result);
  expect(files(t.id).read(raw(t.id)).content).not.toContain(command);
});

test("non-text user placeholder and tool-call-only assistant remain independently readable", () => {
  const t = turn("", "reply");
  memory.appendEntry({ sessionId, nativeLineage: "fixture", nativeId: "image", turnId: t.id, role: "user", text: "",
    raw: JSON.stringify({ role: "user", content: [{ type: "image", mimeType: "image/png", data: "synthetic" }] }), calls: [] });
  expect(files(t.id).read(raw(t.id)).content).toContain(`[T${t.id}#E2@user] user: [non-text content omitted]`);
  expect(files(t.id).read(`${raw(t.id)}#E2@user`).content).toContain("[non-text content omitted]");
  const quiet = turn("q");
  memory.store.appendToolCall({ turnId: quiet.id, name: "bash", input: JSON.stringify({ command: "echo" }), result: "out", status: "success" });
  expect(files(quiet.id).read(`${raw(quiet.id)}#E2@assistant`).content).toContain('bash(command="echo")');
  expect(() => files(quiet.id).read(`${raw(quiet.id)}#E2@user`)).toThrow(/role does not match/);
});

test("overview uses the bounded native renderer while exact result remains whole", () => {
  const t = turn("render me");
  memory.store.appendToolCall({ turnId: t.id, name: "bash", input: JSON.stringify({ command: "echo hi" }), result: "r".repeat(4000), status: "success" });
  const entries = hydrate(memory.store.listSourceEntries(sessionId, t.id), memory.store);
  const result = entries.find(e => e.role === "toolResult")!;
  expect(files(t.id).read(raw(t.id)).content).toContain(renderEntry(result, memory.config.render, memory.resultText).content);
  expect(files(t.id).read(`${raw(t.id)}#E3`).content).toContain("r".repeat(4000));
});

test("removed preview budget settings fail explicitly", () => {
  for (const key of ["commandTokens", "reportHeadTokens", "reportTailTokens"])
    expect(() => open({ render: { [key]: 2 } as never })).toThrow(`Removed setting render.${key}`);
});
