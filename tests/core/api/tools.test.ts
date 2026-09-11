import { recorded } from "../../source-fixture.ts";
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, toolRejected, type NotingAgentInput, type RunAgent, type ToolContext } from "../../source-fixture.ts";

let memory: ReturnType<typeof sourceSeededMemory>, agent: RunAgent;
const fact = (source = "T1#user", extra = {}) => ({ category: "observation", actor: "user", text: "project evidence", source: [source], ...extra });
const manual = (sessionId = 1, currentTurnId = 1, branch = "main"): ToolContext => ({ kind: "manual", sessionId, currentTurnId, branch });
const record = () => memory.noting({ sessionId: 1, branch: "main", headTurnId: 1 });
beforeEach(() => {
  agent = async () => ({ outcome: "success", output: "", request: {} });
  memory = sourceSeededMemory(":memory:", raw => agent(raw));
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  memory.store.appendTurn({ sessionId: 1, kind: "turn", userPrompt: "project evidence", assistantText: "done", startedAt: "first source time" });
});
afterEach(() => memory.close());

for (const outcome of ["failure", "cancelled"] as const) test(`2026-09-07 transaction ruling: ${outcome} after commit cannot undo the successful run`, async () => {
  agent = async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ round: 1 });
    expect(input.tools[2]!.execute({ facts: [fact()] })).toContain("F1");
    expect(memory.store.getRun(1)).toMatchObject({ outcome: "success", request: JSON.stringify({ round: 1 }) });
    expect(JSON.parse(memory.store.getRun(1)!.response!).toolCalls[0].result).toContain("F1");
    return { outcome, output: "connection stopped", request: { round: 2 } };
  };
  expect(await record()).toMatchObject({ outcome: "success", facts: [{ id: 1 }] });
  expect(memory.store.getRun(1)?.outcome).toBe("success");
  expect(JSON.parse(memory.store.getRun(1)!.response!).problems[0]).toContain("after commit: connection stopped");
  expect(memory.store.sourcePath(1, "main", 1).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(1, "main", 1).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.listRuns(1)).toHaveLength(1);
});
for (const kind of ["Error", "AbortError"]) test(`thrown ${kind} after commit retains facts and the known request`, async () => {
  agent = async raw => {
    const input = raw as NotingAgentInput; input.reportRequest({ actual: true });
    input.tools[2]!.execute({ facts: [fact()] });
    const error = new Error("stopped"); error.name = kind; throw error;
  };
  expect((await record()).outcome).toBe("success");
  expect(JSON.parse(memory.store.getRun(1)!.request!)).toEqual({ actual: true });
  expect(memory.store.listBranchFacts(1, "main")).toHaveLength(1);
});

test("a rejected Noting batch can be corrected in the same provider loop", async () => {
  agent = async raw => {
    const input = raw as NotingAgentInput, note = input.tools[2]!;
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

test("manual input and result are the run request and response; facts enter the branch at once and Consolidation ranges once their turn is recorded, without advancing Noting", async () => {
  const input = { facts: [fact()] };
  const result = memory.tools(manual())[2]!.execute(input);
  const run = memory.store.listRuns(1)[0]!;
  expect(run).toMatchObject({ kind: "manual", sessionId: 1, branch: "main", rangeFrom: "S1/T1", rangeTo: "S1/T1", outcome: "success" });
  expect(JSON.parse(run.request!)).toEqual(input); expect(run.response).toBe(result);
  expect(memory.store.listSourceEntries(1).some(e => memory.store.entryNoted(e.id))).toBe(false);
  expect(memory.store.listBranchFacts(1, "main").map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "sibling")).toEqual([]);
  let range: unknown;
  agent = async raw => { range = (raw as { range: unknown }).range; return { outcome: "cancelled", output: "test", request: {} }; };
  // The unrecorded-Turn gate is superseded by 17b on 2026-09-08; committed facts are eligible.
  expect((await memory.consolidate({ sessionId: 1, branch: "main" })).outcome).toBe("cancelled");
  recorded(memory, 1, "main", 1);
  await memory.consolidate({ sessionId: 1, branch: "main" });
  expect(range).toMatchObject({ facts: [{ id: 1 }] });
});

test("source time follows the first source, including tool sources; all sources are checked", () => {
  memory.store.appendTurn({ sessionId: 1, kind: "turn", parentTurnId: 1, assistantText: "later", startedAt: "later source time" });
  memory.store.appendToolCall({ turnId: 2, name: "bash", status: "success", result: "passed" });
  const note = memory.tools(manual(1, 2))[2]!;
  expect(note.execute({ facts: [fact("T2#t1", { source: ["T2#t1", "T1#user"] })] })).toContain("F1");
  expect(memory.store.getFact(1)).toMatchObject({ turnId: 2, createdAt: "later source time" });
  expect(memory.store.db.prepare("SELECT f.source_time, r.kind, r.created_at FROM facts f JOIN runs r ON r.id = f.run_id WHERE f.id = 1").get())
    .toEqual({ source_time: "later source time", kind: "manual", created_at: memory.store.getRun(1)!.createdAt });
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
  const context: ToolContext = { kind: "noting", sessionId: 1, branch: "frozen", range: { from: "S1/T1", to: "S1/T1" }, readKnowledgeCommits: [{ knowledgeId: 9, commit: 2 }] };
  const note = memory.tools(context)[2]!;
  context.range.to = "S1/T2"; context.branch = "mutated"; context.readKnowledgeCommits[0]!.commit = 3;
  expect(note.execute({ facts: [fact("T2#assistant")] })).toContain("rejected:");
  expect(note.execute({ facts: [fact()] })).toContain("F1");
  expect(memory.store.sourcePath(1, "frozen", 1).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(1, "frozen", 1).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(JSON.parse(memory.store.getRun(1)!.response!).readKnowledgeCommits).toEqual([{ knowledgeId: 9, commit: 2 }]);
});

test("trace and search use parameter options, share scoped pagination, and reject obsolete address flags", () => {
  memory.store.appendToolCall({ turnId: 1, name: "bash", status: "success", result: "x".repeat(2000) });
  memory.tools(manual())[2]!.execute({ facts: [fact(), fact()] });
  const [trace, search] = memory.tools(manual());
  expect(trace!.execute({ address: "T1", tool: 1, full: true })).toContain("x".repeat(2000));
  expect(trace!.execute({ address: "T1" })).toContain('trace({"address":"T1#E4@call-1","itemBudget":null,"toolCallBudget":null,"toolResultBudget":null})');
  for (const address of ["T1 tool=1 full", "T1 cap=0", "F1 cap=1"]) expect(trace!.execute({ address })).toContain("rejected:");
  const first = search!.execute({ query: "project", layer: "facts", cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1];
  expect(search!.execute({ query: "project", layer: "facts", cursor })).toContain("[F2]");
  expect(search!.execute({ query: "project", scope: "facts" })).toContain("rejected:");
  expect(trace!.execute({ address: "T1", cap: 0 })).toContain("rejected:");
});

test("reads reach any project's evidence; write sources stay bound to the session; cursors to their owner", () => {
  const p = memory.store.createProject({ name: "other", declaredBy: "mark" });
  memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  memory.store.appendTurn({ sessionId: 2, kind: "turn", userPrompt: "private evidence", startedAt: "now" });
  memory.tools(manual(2, 2))[2]!.execute({ facts: [fact("T2#user", { text: "private evidence" })] });
  const tools = memory.tools(manual());
  for (const address of ["F1", "F1..", "T2", "S2", "S2/T2", "T1,T2"]) expect(tools[0]!.execute({ address })).not.toContain("rejected:");
  expect(tools[1]!.execute({ query: "private", layer: "all" })).toContain("private evidence");
  expect(tools[2]!.execute({ facts: [fact("T2#user")] })).toContain("rejected:"); // a write may only cite its own session
  const page = memory.tools(manual(2, 2))[0]!.execute({ address: "T2", cap: 1 });
  expect(tools[0]!.execute({ address: "T1", cursor: /cursor=(\S+)/.exec(page)![1] })).toContain("rejected:");
});


test("manual facts belong to their turn: a branch whose path includes that turn consolidates them", async () => {
  memory.tools(manual(1, 1, "A"))[2]!.execute({ facts: [fact()] });
  await memory.noting({ sessionId: 1, branch: "B", headTurnId: 1 });
  expect(memory.store.listBranchFacts(1, "A").map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "B", 1).map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "C")).toEqual([]); // no path known for C
  expect((await memory.consolidate({ sessionId: 1, branch: "B", headTurnId: 1 })).outcome).not.toBe("empty");
});

test("reads return every knowledge item while injection still applies the scope rule", () => {
  const ownProject = memory.store.getSession(1)!.projectId;
  const otherProject = memory.store.createProject({ name: "elsewhere", declaredBy: "mark" }).id;
  for (const projectId of [ownProject, otherProject]) {
    const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId, startedAt: "now", firstReplyAt: "now" });
    memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  }
  for (const sessionId of [1, 2, 3]) {
    const note = memory.tools(manual(sessionId, sessionId))[2]!;
    note.execute({ facts: [fact(`T${sessionId}#user`)] });
    memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: "now" }, operations:
      (["global", "project", "session"] as const).map((scope, i) => ({ op: "create", topics: [], reason: "Initial admission of this conclusion." as const, handle: `$e${i + 1}`, author: "fake", text: `knowledge owner ${sessionId} scope ${scope}`, category: "term" as const, scope, supports: [sessionId], createdAt: "now" })) });
  }
  const [trace, search] = memory.tools(manual());
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(trace!.execute({ address: `K${id}` })).toContain(`[K${id}@${id}]`); // reads are unrestricted
  const hits = search!.execute({ query: "knowledge", layer: "knowledge" });
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(hits).toContain(`[K${id}@`);
  // Injection keeps the scope rule: another session's session knowledge and another project's project knowledge stay out.
  for (const id of [6, 8, 9]) expect(memory.inject(1)).not.toContain(`[K${id}@`);
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: 1, createdAt: "later" }, operations: [
    { op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: 3, baseCommit: 3, supports: [1], createdAt: "later" },
  ] });
  expect(trace!.execute({ address: "K3@3" })).toContain("owner 1 scope session");
  expect(trace!.execute({ address: "K3" })).toContain("archive");
});

test("branch facts apply the full-source path rule: a fact citing a turn off the path stays out", () => {
  memory.store.appendTurn({ sessionId: 1, kind: "turn", parentTurnId: 1, userPrompt: "second", startedAt: "now" });
  memory.tools(manual(1, 2))[2]!.execute({ facts: [fact("T1#user", { source: ["T1#user", "T2#user"] })] });
  expect(memory.store.listBranchFacts(1, "main", 2).map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "main", 1)).toEqual([]); // T2 is not on the path that ends at T1
});

test("one reading of the model-facing result: a `rejected:` receipt and a batch `results` entry, for every consumer", () => {
  // The wire format is unchanged; what is shared is its interpretation. Both Pi adapters and the
  // test host classify a tool result through this one function instead of re-deriving the format —
  // core produces both spellings here, so a change to either has one place to make it.
  expect(toolRejected("trace", "rejected: unknown or expired cursor")).toBe(true);
  expect(toolRejected("trace", "[F1] a fact line")).toBe(false);
  // A batch writer answers with JSON: one rejected entry makes the whole call a refusal.
  expect(toolRejected("note", JSON.stringify({ results: ["ok: F1", "rejected: invalid source"] }))).toBe(true);
  expect(toolRejected("memory", JSON.stringify({ results: ["ok: K1@1"] }))).toBe(false);
  // Only the batch writers speak that JSON; a read tool's body that happens to contain it does not.
  expect(toolRejected("search", JSON.stringify({ results: ["rejected: not mine"] }))).toBe(false);
  expect(toolRejected("note", "not json at all")).toBe(false);
  // The real receipts a run produces, classified the same way.
  const [trace, , note] = memory.tools(manual());
  expect(toolRejected("trace", trace!.execute({ address: "F404" }))).toBe(true);
  expect(toolRejected("note", note!.execute({ facts: [fact("T9#user")] }))).toBe(true);
  expect(toolRejected("note", note!.execute({ facts: [fact()] }))).toBe(false);
});
