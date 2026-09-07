import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, type RecordingAgentInput, type RunAgentResult, type ConfigOverride } from "./index.ts";
import fixture from "../../test/fixtures/recording/turns.json";
import memories from "../../test/fixtures/recording/facts.json";

let directory: string;
let memory: ReturnType<typeof TraceMemory>;
let sessionId: number;
let calls: RecordingAgentInput[];
type ScriptResult = RunAgentResult & { noteInput?: unknown };
let script: ((input: RecordingAgentInput) => Promise<ScriptResult>)[];
const time = "2026-08-16 02:54";
const request = { system: "actual host system", messages: [{ role: "user", content: "actual provider input" }], tools: [] };
const success = (batches: { facts: unknown[] }[]): ScriptResult => ({ outcome: "success", output: "Done.", noteInput: batches.length ? { facts: batches.flatMap((b) => b.facts) } : undefined, request, usage: { tokens: 12 } });
const fact = (extra = {}) => ({ category: "observation", actor: "agent", text: memories.base, source: ["T1#assistant"], ...extra });
const batch = (turnId: number, facts = [fact()]) => ({ turn: `S${sessionId}/T${turnId}`, title: "mapC terrain", topic: "terrain", facts: facts.map((f) => ({ ...f, source: f.source[0] === "T1#assistant" ? [`T${turnId}#assistant`] : f.source })) });
function open(config: ConfigOverride = {}) {
  memory = TraceMemory(join(directory, "test.sqlite"), async (raw) => {
    const input = raw as RecordingAgentInput;
    calls.push(input);
    const next = script.shift();
    if (!next) throw new Error("unexpected model call");
    const result = await next(input);
    if (result.request !== undefined) input.reportRequest(result.request);
    if (result.noteInput !== undefined) input.tools.find((t) => t.name === "note")!.execute(result.noteInput);
    return result;
  }, config);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-recording-")); calls = []; script = []; open();
  const project = memory.store.createProject({ name: "fixture", declaredBy: "mark" });
  sessionId = memory.store.createSession({ host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id }).id;
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
function turn(parentTurnId: number | null = null, index = 0) {
  const f = fixture[index]!;
  const t = memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: f.userPrompt, assistantText: f.assistantText, startedAt: time });
  for (const c of f.calls) memory.store.appendToolCall({ turnId: t.id, name: c.name, input: c.input, result: c.result, status: c.status });
  return t;
}
const recording = (headTurnId: number, branch = "main") => memory.record({ sessionId, branch, headTurnId, model: "fake-model", mode: "subagent" });
function deferred() {
  let resolve!: (result: ScriptResult) => void;
  const promise = new Promise<ScriptResult>((r) => { resolve = r; });
  script.push(async () => promise);
  return resolve;
}
function unchanged(branch = "main") {
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  expect(memory.store.getWatermark(sessionId, branch)).toBeNull();
  expect(memory.store.listPendingDeliveries(sessionId, branch)).toEqual([]);
}

test("a turn arriving during the model call waits for the next trigger", async () => {
  const first = turn(), resolve = deferred();
  const pending = recording(first.id);
  const second = turn(first.id, 1);
  expect(calls[0]!.range.to).toBe(`S${sessionId}/T${first.id}`);
  expect(calls[0]!.input).not.toContain(second.userPrompt!);
  resolve(success([batch(first.id)]));
  const result = await pending;
  expect(result.outcome).toBe("success");
  expect(memory.store.getWatermark(sessionId, "main")?.lastRecordedTurn).toBe(first.id);
  script.push(async () => success([batch(second.id, [fact({ source: [`T${second.id}#user`], support: [["F1", "weak"]] })])]));
  await recording(second.id);
  expect(calls[1]!.input).toContain(second.userPrompt!);
  expect(calls[1]!.input).toContain("Recent facts (newest first):\n\n[F1]");
  expect(calls[1]!.input).not.toContain(first.userPrompt!);
  expect(memory.store.getWatermark(sessionId, "main")?.lastRecordedTurn).toBe(second.id);
  expect(memory.store.listSessionFacts(sessionId)).toHaveLength(2);
  expect(await recording(second.id)).toEqual({ outcome: "empty" });
  expect(calls).toHaveLength(2);
});

test("switching branch while pending preserves the old delivery and excludes the sibling", async () => {
  const root = turn(), old = turn(root.id, 1), resolve = deferred();
  const selection = { sessionId, branch: "old", headTurnId: old.id };
  const pending = memory.record(selection);
  const sibling = turn(root.id);
  selection.branch = "new"; selection.headTurnId = sibling.id;
  script.push(async () => success([]));
  await memory.record(selection);
  resolve(success([batch(old.id)]));
  await pending;
  expect(memory.store.getWatermark(sessionId, "old")?.lastRecordedTurn).toBe(old.id);
  expect(memory.store.getWatermark(sessionId, "new")?.lastRecordedTurn).toBe(sibling.id);
  expect(memory.store.listPendingDeliveries(sessionId, "old").map((d) => d.branch)).toEqual(["old"]);
  expect(memory.store.listPendingDeliveries(sessionId, "new")).toEqual([]);
  expect(calls[1]!.input).not.toContain(`[S${sessionId}/T${old.id}]`);
  expect(memory.store.getRun(2)?.branch).toBe("old");
});

test("duplicate trigger is dropped, including another façade on the same file", async () => {
  const t = turn(), resolve = deferred(), pending = recording(t.id);
  expect(await recording(t.id)).toEqual({ outcome: "dropped" });
  const other = TraceMemory(join(directory, "test.sqlite"), async () => { throw new Error("must not run"); });
  try { expect(await other.record({ sessionId, branch: "main", headTurnId: t.id })).toEqual({ outcome: "dropped" }); }
  finally { other.close(); }
  expect(memory.store.getRun(1)).toBeNull();
  resolve(success([])); await pending;
  expect(calls).toHaveLength(1);
  expect(memory.store.getRun(2)).toBeNull();
});

for (const outcome of ["failure", "cancelled"] as const) test(`${outcome} records only the attempt and allows a retry`, async () => {
  const t = turn(); script.push(async () => ({ outcome, output: "provider stopped", request }));
  const result = await recording(t.id);
  expect(result.outcome).toBe(outcome); unchanged();
  expect(memory.store.getRun(1)?.outcome).toBe(outcome);
  expect(JSON.parse(memory.store.getRun(1)!.request!)).toEqual(request);
  script.push(async () => success([])); expect((await recording(t.id)).outcome).toBe("success");
});
for (const name of ["Error", "AbortError"]) test(`thrown ${name} records an attempt without fabricating a request`, async () => {
  const t = turn(); script.push(async () => { const e = new Error("stopped"); e.name = name; throw e; });
  expect((await recording(t.id)).outcome).toBe(name === "AbortError" ? "cancelled" : "failure");
  unchanged(); expect(memory.store.getRun(1)?.request).toBeNull();
});

for (const [label, changes, problem] of [
  ["category", { category: "open" }, "category"],
  ["actor", { actor: "tool" }, "actor"],
  ["unknown fact", { support: [["F999", "weak"]] }, "F999"],
  ["self handle", { support: [["$1", "weak"]] }, "$1"],
  ["zero handle", { support: [["$0", "weak"]] }, "$0"],
  ["forward handle", { support: [["$2", "weak"]] }, "$2"],
  ["malformed handle", { support: [["$x", "weak"]] }, "target"],
  ["relation shape", { support: ["F1"] }, "expected [target, strength]"],
  ["embedded id", { text: "See F101" }, "must not embed"],
  ["event status", { category: "event" }, "status"],
] as const) test(`bounces ${label} with problems and only a run record`, async () => {
  const t = turn(), output = [batch(t.id, [fact(changes)])];
  script.push(async () => success(output));
  const result = await recording(t.id);
  expect(result.outcome).toBe("bounced");
  if (result.outcome !== "bounced") throw new Error("expected bounce");
  expect(result.problems.join("\n")).toContain(problem);
  unchanged();
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe("bounced");
  expect(JSON.parse(run.response!).toolCalls[0].input).toEqual({ facts: output.flatMap((b) => b.facts) });
  expect(JSON.parse(run.response!).problems).toEqual(result.problems);
});

test("final text is never parsed; a successful reply without provider request fails", async () => {
  const t = turn(); script.push(async () => ({ outcome: "success", output: "[", request }));
  expect((await recording(t.id)).outcome).toBe("success");
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  const next = turn(t.id);
  script.push(async () => ({ outcome: "success", output: "[]" }));
  expect((await recording(next.id)).outcome).toBe("failure");
  expect(memory.store.getWatermark(sessionId, "main")?.lastRecordedTurn).toBe(t.id);
});

test("model cannot write to a late turn outside the frozen range", async () => {
  const first = turn(), resolve = deferred(), pending = recording(first.id), late = turn(first.id, 1);
  resolve(success([batch(late.id)]));
  expect((await pending).outcome).toBe("bounced"); unchanged();
});

test("empty output recordings the range; compactions cannot acquire facts", async () => {
  const t = memory.store.appendTurn({ sessionId, kind: "compaction", startedAt: time });
  script.push(async () => success([batch(t.id)]));
  expect((await recording(t.id)).outcome).toBe("bounced"); unchanged();
  script.push(async () => success([])); await recording(t.id);
  expect(memory.store.getWatermark(sessionId, "main")?.lastRecordedTurn).toBe(t.id);
  expect(memory.store.listPendingDeliveries(sessionId, "main")).toHaveLength(0);
});

test("read knowledge revisions and exact provider request are recorded, even when a knowledge item moves", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await recording(first.id);
  const created = memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: time }, operations: [
    { op: "new", handle: "$e1", author: "fake", category: "mechanism", scope: "project", text: memories.knowledge, supports: [1], createdAt: time },
  ] });
  expect(created.ok).toBe(true);
  const second = turn(first.id, 1), resolve = deferred(), pending = recording(second.id);
  expect(calls[1]!.readKnowledgeRevisions).toEqual([{ knowledgeId: 1, rev: 1 }]);
  expect(calls[1]!.input).toContain("[K1@1]");
  memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: time }, operations: [
    { op: "edit", knowledgeId: 1, expectedRevision: 1, category: "mechanism", scope: "project", text: memories.editedKnowledge, supports: [1], because: [1], createdAt: time },
  ] });
  resolve(success([])); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  const run = memory.store.getRun(result.runId)!;
  expect(JSON.parse(run.response!).readKnowledgeRevisions).toEqual([{ knowledgeId: 1, rev: 1 }]);
  expect(JSON.parse(run.request!)).toEqual(request);
  expect(run.model).toBe("fake-model"); expect(run.promptHash).toMatch(/^[0-9a-f]{64}$/);
  expect(run.request).not.toBe(calls[1]!.input);
});

const golden = (name: string) => readFileSync(new URL(`../../test/fixtures/recording/${name}.txt`, import.meta.url), "utf8").trimEnd();
const small = { render: { commandTokens: 20, stdoutHeadTokens: 8, stdoutTailTokens: 8 } };
test("fixture turn golden and recording input use identical rendering with receipts last", async () => {
  memory.close(); open(small);
  const first = turn(); turn(first.id, 1);
  expect(memory.trace("T1")).toBe(golden("turn"));
  expect(memory.trace("T2")).toBe(golden("read"));
  script.push(async (input) => {
    const rendered = memory.trace("T1"), [content, receipts] = rendered.split("\n\nReceipts:\n");
    expect(input.input).toContain(content!); expect(input.input.endsWith(receipts!)).toBe(true);
    expect(input.tools[0]!.execute({ address: "T1", tool: 2, full: true })).toBe(memory.trace("T1", { tool: 2, full: true }));
    return success([]);
  });
  const result = await memory.record({ sessionId, branch: "main", headTurnId: first.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error("expected success");
  expect(JSON.parse(memory.store.getRun(result.runId)!.response!).fetched[0].input).toEqual({ address: "T1", tool: 2, full: true });
  expect(calls[0]!.tools[0]!.execute({ address: "T1" })).toContain("finished");
});

test("fixture fact goldens include quote, sources and both relation directions across turns", async () => {
  const first = turn(), second = turn(first.id, 1);
  script.push(async () => success([
    batch(first.id, [fact({ quote: memories.quote })]),
    batch(second.id, [fact({ category: "interpretation", text: memories.interpretation, source: ["T2#assistant"], support: [["$1", "weak"]] }),
      fact({ category: "observation", text: memories.observation, source: ["T2#assistant"], negate: [["$1", "strong"]] })]),
  ]));
  expect((await recording(second.id)).outcome).toBe("success");
  expect([1, 2, 3].map((id) => memory.trace(`F${id}`)).join("\n\n")).toBe(golden("facts"));
});

test("full expands selected calls; cap is the listing budget and address flags are rejected", () => {
  const t = turn();
  const full = memory.trace(`T${t.id}`, { tool: 2, full: true });
  expect(full).toContain(JSON.parse(fixture[0]!.calls[1]!.result!).stdout);
  expect(full).toContain("tool=Bash status=success omitted=false");
  expect(memory.trace(`T${t.id}`, { cap: 1 })).toContain("cursor=");
  expect(() => memory.trace("T1", { tool: 99 })).toThrow("does not exist");
  expect(() => memory.trace("T1 cap=0")).toThrow("invalid trace address");
});

test("raw exceeding the episodic budget is retained, while older facts are dropped", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await recording(first.id);
  memory.close(); open({ render: { episodicBlockTokens: 1 } });
  const second = turn(first.id, 1); script.push(async () => success([])); await recording(second.id);
  expect(calls[1]!.input).toContain(second.assistantText!);
  expect(calls[1]!.input).toContain("raw overage:");
  expect(calls[1]!.input).toContain("omitted 1 older facts; expand: F1");
});

test("stdout keeps head and tail; stderr keeps tail; reports keep head and tail", () => {
  memory.close(); open({ render: { commandTokens: 1, stdoutHeadTokens: 1, stdoutTailTokens: 1,
    stderrTailTokens: 1, reportHeadTokens: 1, reportTailTokens: 1 } });
  const t = memory.store.appendTurn({ sessionId, kind: "turn", userPrompt: "uncut user", assistantText: "uncut assistant", startedAt: time });
  memory.store.appendToolCall({ turnId: t.id, name: "Bash", input: JSON.stringify({ command: "a\nbbbbb\nc" }),
    result: JSON.stringify({ stdout: "a\nbbbbb\nc", stderr: "first\nlast" }), status: "failure" });
  memory.store.appendToolCall({ turnId: t.id, name: "report", result: "a\nbbbbb\nc", status: "success" });
  memory.store.appendToolCall({ turnId: t.id, name: "Search", input: JSON.stringify({ path: "/fixture" }), result: "hidden match", status: "success" });
  const rendered = memory.trace(`T${t.id}`);
  expect(rendered).toContain("command:\na\n\n[omitted 2 lines, 7 characters]");
  expect(rendered).toContain("stdout:\na\n\n[omitted 1 lines, 6 characters]\nc");
  expect(rendered).toContain("stderr:\n[omitted 1 lines, 6 characters]\nlast");
  expect(rendered).toContain("report:\na\n\n[omitted 1 lines, 6 characters]\nc");
  expect(rendered).toContain("Search /fixture\n[omitted 12 characters of result]");
  expect(rendered).not.toContain("hidden match");
  expect(memory.trace(`T${t.id}`, { tool: 3, full: true })).toContain("hidden match");
});

test("knowledge budgets keep protected categories and omit whole later categories", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await recording(first.id);
  const categories = ["constraint", "open", "dispute", "goal", "mechanism", "term", "reference"] as const;
  memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: time }, operations: categories.map((category, i) => ({
    op: "new" as const, handle: `$e${i + 1}`, author: "fake", category, scope: "project" as const, text: memories.knowledge, supports: [1], createdAt: time,
  })) });
  memory.close(); open({ render: { knowledgeBlockTokens: 0 } });
  const second = turn(first.id, 1); script.push(async () => success([])); await recording(second.id);
  const input = calls[1]!.input;
  for (const category of categories.slice(0, 3)) expect(input).toContain(`[${category}/project]`);
  for (const category of categories.slice(3)) {
    expect(input).not.toContain(`[${category}/project]`);
    expect(input).toContain(`omitted 1 ${category} knowledge; expand: K`);
  }
});

test("recent facts are ordered by timestamp freshness rather than insertion id", async () => {
  const first = turn();
  const later = memory.store.appendTurn({ sessionId, parentTurnId: first.id, kind: "turn", assistantText: "later", startedAt: "2026-08-16 03:00" });
  script.push(async () => success([batch(later.id), batch(first.id)])); await recording(later.id);
  const second = turn(later.id, 1); script.push(async () => success([])); await recording(second.id);
  expect(calls[1]!.input.indexOf("[F1]")).toBeLessThan(calls[1]!.input.indexOf("[F2]"));
});

test("reopening the database preserves the run, facts, watermark and delivery", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await recording(first.id);
  const traced = memory.trace("F1"); memory.close(); open();
  expect(memory.trace("F1")).toBe(traced);
  expect(memory.store.getWatermark(sessionId, "main")?.lastRecordedTurn).toBe(first.id);
  expect(memory.store.listPendingDeliveries(sessionId, "main")).toHaveLength(1);
  expect(memory.store.getRun(1)?.outcome).toBe("success");
});

test("opening a pre-ticket-09 database migrates event status and run enums without losing facts or deliveries", async () => {
  const t = turn();
  const committed = memory.store.commitRecordingRun({ run: { kind: "recording", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId: t.id, category: "event", actor: "agent", text: "completed: tests passed", source: [`T${t.id}#assistant`], createdAt: time }],
    watermark: { sessionId, branch: "main", lastRecordedTurn: t.id }, pendingDelivery: { sessionId, branch: "main" } });
  expect(committed.ok).toBe(true);
  const before = memory.trace("F1");
  // Reconstruct the previous persisted layout through the facade's store, then reopen it.
  const db = memory.store.db;
  db.exec("PRAGMA foreign_keys = OFF");
  const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'").get() as { sql: string }).sql;
  db.exec(sql.replace('CREATE TABLE runs', 'CREATE TABLE old_runs').replace(",'manual'", "").replace(",'bounced'", ""));
  db.exec("INSERT INTO old_runs SELECT * FROM runs; DROP TABLE runs; ALTER TABLE old_runs RENAME TO runs; ALTER TABLE facts DROP COLUMN status;");
  memory.close(); open();
  expect(memory.trace("F1")).toBe(before);
  expect(memory.store.getFact(1)).toMatchObject({ text: "tests passed", status: "completed" });
  expect(memory.search("passed", "facts")).toContain("completed: tests passed");
  expect(memory.store.getWatermark(sessionId, "main")?.lastRecordedTurn).toBe(t.id);
  expect(memory.store.listPendingDeliveries(sessionId, "main")).toHaveLength(1);
  const note = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: t.id })[2]!;
  expect(note.execute({ facts: [{ ...fact(), category: "bad" }] })).toContain("rejected:");
  expect(note.execute({ facts: [fact()] })).toContain("F2");
  expect(memory.store.listRuns(sessionId).map(r => [r.kind, r.outcome])).toEqual([["recording", "success"], ["manual", "bounced"], ["manual", "success"]]);
  expect(memory.store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
