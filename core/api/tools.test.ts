import { afterEach, beforeEach, expect, test } from "vitest";
import { TraceMemory, type RecordingAgentInput, type RunAgent, type ToolContext } from "./index.ts";

let memory: TraceMemory, agent: RunAgent;
const fact = (source = "T1#user", extra = {}) => ({ category: "observation", actor: "user", text: "project evidence", source: [source], ...extra });
const manual = (sessionId = 1, currentTurnId = 1, branch = "main"): ToolContext => ({ kind: "manual", sessionId, currentTurnId, branch });
const record = () => memory.record({ sessionId: 1, branch: "main", headTurnId: 1 });
beforeEach(() => {
  agent = async () => ({ outcome: "success", output: "", request: {} });
  memory = TraceMemory(":memory:", raw => agent(raw));
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  memory.store.createSession({ host: "fake", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  memory.store.appendTurn({ sessionId: 1, kind: "turn", userPrompt: "project evidence", assistantText: "done", startedAt: "first source time" });
});
afterEach(() => memory.close());

for (const outcome of ["failure", "cancelled"] as const) test(`2026-09-07 transaction ruling: ${outcome} after commit cannot undo the successful run`, async () => {
  agent = async raw => {
    const input = raw as RecordingAgentInput;
    input.reportRequest({ round: 1 });
    expect(input.tools[2]!.execute({ facts: [fact()] })).toContain("F1");
    expect(memory.store.getRun(1)).toMatchObject({ outcome: "success", request: JSON.stringify({ round: 1 }) });
    expect(JSON.parse(memory.store.getRun(1)!.response!).toolCalls[0].result).toContain("F1");
    expect(memory.store.listPendingDeliveries(1, "main")).toHaveLength(1);
    return { outcome, output: "connection stopped", request: { round: 2 } };
  };
  expect(await record()).toMatchObject({ outcome: "success", facts: [{ id: 1 }] });
  expect(memory.store.getRun(1)?.outcome).toBe("success");
  expect(JSON.parse(memory.store.getRun(1)!.response!).problems[0]).toContain("after commit: connection stopped");
  expect(memory.store.getWatermark(1, "main")?.lastRecordedTurn).toBe(1);
  expect(memory.store.listRuns(1)).toHaveLength(1);
});
for (const kind of ["Error", "AbortError"]) test(`thrown ${kind} after commit retains facts and the known request`, async () => {
  agent = async raw => {
    const input = raw as RecordingAgentInput; input.reportRequest({ actual: true });
    input.tools[2]!.execute({ facts: [fact()] });
    const error = new Error("stopped"); error.name = kind; throw error;
  };
  expect((await record()).outcome).toBe("success");
  expect(JSON.parse(memory.store.getRun(1)!.request!)).toEqual({ actual: true });
  expect(memory.store.listBranchFacts(1, "main")).toHaveLength(1);
});

test("a rejected Recording batch can be corrected in the same provider loop", async () => {
  agent = async raw => {
    const input = raw as RecordingAgentInput, note = input.tools[2]!;
    expect(JSON.parse(note.execute({ facts: [fact(), fact("T1#user", { support: [["$3", "strong"]] })] })).results).toEqual(["ok", expect.stringContaining("rejected:")]);
    expect(memory.store.listRuns(1)).toEqual([]);
    expect(memory.store.listSessionFacts(1)).toEqual([]);
    expect(note.execute({ facts: [fact(), fact("T1#assistant", { support: [["$1", "weak"]] })] })).toContain("F2");
    return { outcome: "success", output: "done", request: { messages: ["request", "rejection", "correction"] } };
  };
  expect((await record()).outcome).toBe("success");
  expect(memory.store.listRuns(1)).toHaveLength(1);
  expect(JSON.parse(memory.store.getRun(1)!.response!).toolCalls).toHaveLength(2);
});

test("manual input and result are the run request and response; facts enter branch and Integration ranges without advancing Recording", async () => {
  const input = { facts: [fact()] };
  const result = memory.tools(manual())[2]!.execute(input);
  const run = memory.store.listRuns(1)[0]!;
  expect(run).toMatchObject({ kind: "manual", sessionId: 1, branch: "main", rangeFrom: "S1/T1", rangeTo: "S1/T1", outcome: "success" });
  expect(JSON.parse(run.request!)).toEqual(input); expect(run.response).toBe(result);
  expect(memory.store.getWatermark(1, "main")).toBeNull();
  expect(memory.store.listBranchFacts(1, "main").map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "sibling")).toEqual([]);
  let range: unknown;
  agent = async raw => { range = (raw as { range: unknown }).range; return { outcome: "cancelled", output: "test", request: {} }; };
  await memory.integrate({ sessionId: 1, branch: "main" });
  expect(range).toMatchObject({ facts: [{ id: 1 }] });
});

test("source time follows the first source, including tool sources; all sources are checked", () => {
  memory.store.appendTurn({ sessionId: 1, kind: "turn", parentTurnId: 1, assistantText: "later", startedAt: "later source time" });
  memory.store.appendToolCall({ turnId: 2, name: "bash", status: "success", result: "passed" });
  const note = memory.tools(manual(1, 2))[2]!;
  expect(note.execute({ facts: [fact("T2#t1", { source: ["T2#t1", "T1#user"] })] })).toContain("F1");
  expect(memory.store.getFact(1)).toMatchObject({ turnId: 2, createdAt: "later source time" });
  expect(note.execute({ facts: [fact("T1#user", { source: ["T1#user", "T999#assistant"] })] })).toContain("rejected:");
  expect(memory.store.listSessionFacts(1)).toHaveLength(1);
});

test("malformed items still produce results for every item, and reject the entire batch", () => {
  expect(memory.tools(manual())[2]!.execute(null)).toContain("rejected:");
  expect(memory.store.listBranchFacts(1, "main")).toEqual([]);
  const result = JSON.parse(memory.tools(manual())[2]!.execute({ facts: [fact(), fact("T1#user", { support: [[42, "weak"]] }), null] }));
  expect(result.results).toEqual(["ok", expect.stringContaining("rejected:"), expect.stringContaining("rejected:")]);
  expect(memory.store.listSessionFacts(1)).toEqual([]);
});

test("tools freeze context, reject sibling and late sources, and preserve read revisions", () => {
  memory.store.appendTurn({ sessionId: 1, kind: "turn", parentTurnId: 1, assistantText: "sibling", startedAt: "later" });
  const context: ToolContext = { kind: "recording", sessionId: 1, branch: "frozen", range: { from: "S1/T1", to: "S1/T1" }, readKnowledgeRevisions: [{ knowledgeId: 9, rev: 2 }] };
  const note = memory.tools(context)[2]!;
  context.range.to = "S1/T2"; context.branch = "mutated"; context.readKnowledgeRevisions[0]!.rev = 3;
  expect(note.execute({ facts: [fact("T2#assistant")] })).toContain("rejected:");
  expect(note.execute({ facts: [fact()] })).toContain("F1");
  expect(memory.store.getWatermark(1, "frozen")?.lastRecordedTurn).toBe(1);
  expect(JSON.parse(memory.store.getRun(1)!.response!).readKnowledgeRevisions).toEqual([{ knowledgeId: 9, rev: 2 }]);
});

test("trace and search use parameter options, share scoped pagination, and reject obsolete address flags", () => {
  memory.store.appendToolCall({ turnId: 1, name: "bash", status: "success", result: "x".repeat(2000) });
  memory.tools(manual())[2]!.execute({ facts: [fact(), fact()] });
  const [trace, search] = memory.tools(manual());
  expect(trace!.execute({ address: "T1", tool: 1, full: true })).toContain("x".repeat(2000));
  expect(trace!.execute({ address: "T1" })).toContain('trace({"address":"T1","tool":1,"full":true})');
  for (const address of ["T1 tool=1 full", "T1 cap=0", "F1 cap=1"]) expect(trace!.execute({ address })).toContain("rejected:");
  const first = search!.execute({ query: "project", layer: "facts", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1];
  expect(search!.execute({ query: "project", layer: "facts", cursor })).toContain("[F2]");
  expect(search!.execute({ query: "project", scope: "facts" })).toContain("rejected:");
  expect(trace!.execute({ address: "T1", cap: 0 })).toContain("rejected:");
});

test("read tools bind facts and raw to the project, write sources to the session, and cursors to their owner", () => {
  const p = memory.store.createProject({ name: "other", declaredBy: "mark" });
  memory.store.createSession({ host: "fake", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  memory.store.appendTurn({ sessionId: 2, kind: "turn", userPrompt: "private evidence", startedAt: "now" });
  memory.tools(manual(2, 2))[2]!.execute({ facts: [fact("T2#user", { text: "private evidence" })] });
  const tools = memory.tools(manual());
  for (const address of ["F1", "F1..", "T2", "S2", "S2/T2", "T1,T2"]) expect(tools[0]!.execute({ address })).toContain("rejected:");
  expect(tools[1]!.execute({ query: "private", layer: "all" })).not.toContain("private evidence");
  expect(tools[2]!.execute({ facts: [fact("T2#user")] })).toContain("rejected:");
  const page = memory.tools(manual(2, 2))[0]!.execute({ address: "T2", cap: 1 });
  expect(tools[0]!.execute({ address: "T1", cursor: /cursor=(\S+)/.exec(page)![1] })).toContain("rejected:");
});


test("manual facts on a common ancestor remain bound to their calling branch", async () => {
  memory.tools(manual(1, 1, "A"))[2]!.execute({ facts: [fact()] });
  await memory.record({ sessionId: 1, branch: "B", headTurnId: 1 });
  expect(memory.store.listBranchFacts(1, "A").map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "B")).toEqual([]);
  expect(await memory.integrate({ sessionId: 1, branch: "B" })).toEqual({ outcome: "empty" });
});

test("bound knowledge reads include global/project/own-session history and exclude other sessions and projects", () => {
  const ownProject = memory.store.getSession(1)!.projectId;
  const otherProject = memory.store.createProject({ name: "elsewhere", declaredBy: "mark" }).id;
  for (const projectId of [ownProject, otherProject]) {
    const s = memory.store.createSession({ host: "fake", projectId, startedAt: "now", firstReplyAt: "now" });
    memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  }
  for (const sessionId of [1, 2, 3]) {
    const note = memory.tools(manual(sessionId, sessionId))[2]!;
    note.execute({ facts: [fact(`T${sessionId}#user`)] });
    memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: "now" }, operations:
      (["global", "project", "session"] as const).map((scope, i) => ({ op: "new" as const, handle: `$e${i + 1}`, author: "fake", text: `knowledge owner ${sessionId} scope ${scope}`, category: "term" as const, scope, supports: [sessionId], createdAt: "now" })) });
  }
  const [trace, search] = memory.tools(manual());
  for (const id of [1, 2, 3, 4, 5, 7]) expect(trace!.execute({ address: `K${id}` })).toContain(`[K${id}@1]`);
  for (const id of [6, 8, 9]) expect(trace!.execute({ address: `K${id}` })).toContain("rejected:");
  const hits = search!.execute({ query: "knowledge", layer: "knowledge" });
  for (const id of [6, 8, 9]) expect(hits).not.toContain(`[K${id}@`);
  memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId: 1, createdAt: "later" }, operations: [
    { op: "archive", knowledgeId: 3, expectedRevision: 1, because: [1], createdAt: "later" },
  ] });
  expect(trace!.execute({ address: "K3@1" })).toContain("owner 1 scope session");
  expect(trace!.execute({ address: "K3" })).toContain("archived");
});
