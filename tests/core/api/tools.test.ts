import { afterEach, beforeEach, expect, test } from "vitest";
import { validateToolArguments } from "@earendil-works/pi-ai";
import { hydrate, sourceSeededMemory, toolRejected, type NotingAgentInput, type RunAgent, type ToolContext } from "../../source-fixture.ts";
import { toolDefinitions } from "../../../src/core/api/tools.ts";
import { factSources } from "../../support/seed.ts";
import { submit, verifyUnchanged } from "../../support/noter.ts";

let memory: ReturnType<typeof sourceSeededMemory>, agent: RunAgent;
const fact = (source = "T1#E1", extra: { source?: string[]; text?: string; [key: string]: unknown } = {}) => {
  const { source: addresses = [source], text = "project evidence", ...fields } = extra;
  return { title: "Project evidence", sources: factSources(addresses.map((address, index) => ({ address, text: index === 0 ? text : `Evidence at ${address}` }))), ...fields };
};
const manual = (sessionId = 1, currentTurnId = 1, branch = "main"): ToolContext => ({ kind: "manual", sessionId, currentTurnId, branch });
const record = () => memory.noting({ sessionId: 1, branch: "main", headTurnId: 1 });
beforeEach(() => {
  agent = async () => ({ outcome: "success", output: "", request: {} });
  memory = sourceSeededMemory(":memory:", raw => (raw as NotingAgentInput).kind === "noting" && (raw as NotingAgentInput).task !== "extract-facts" ? verifyUnchanged(raw, { request: {} }) : agent(raw));
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  memory.store.createSession({ enrollmentChoice: true, host: "pi:tools", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  memory.store.appendTurn({ sessionId: 1, kind: "turn", userPrompt: "project evidence", assistantText: "done", startedAt: "first source time" });
});
afterEach(() => memory.close());

for (const outcome of ["failure", "cancelled"] as const) test(`92: ${outcome} after writing both files publishes neither layer nor progress`, async () => {
  agent = async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ round: 1 });
    await submit(input, memory, { noteInput: [fact()], memoryInput: { files: null, op: "create", title: "Fixture title", text: "Project rule", category: "constraint", scope: "project", topics: [], supports: ["$1"], reason: "Joint extraction" } });
    expect(memory.store.listSessionFacts(1)).toEqual([]);
    expect(memory.store.getKnowledge(1)).toBeNull();
    return { outcome, output: "connection stopped", request: { round: 2 } };
  };
  expect(await record()).toMatchObject({ outcome });
  expect(memory.store.getRun(1)?.outcome).toBe(outcome);
  expect(JSON.parse(memory.store.getRun(1)!.response!).problems).toContain("connection stopped");
  expect(memory.store.listSessionFacts(1)).toEqual([]);
  expect(memory.store.getKnowledge(1)).toBeNull();
  expect(memory.store.sourcePath(1, "main", 1).every(e => !memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.listRuns(1)).toHaveLength(1);
});
for (const kind of ["Error", "AbortError"]) test(`92: thrown ${kind} after writing retains audit but publishes no facts`, async () => {
  agent = async raw => {
    const input = raw as NotingAgentInput; input.reportRequest({ actual: true });
    await submit(input, memory, { noteInput: [fact()], memoryInput: {} });
    const error = new Error("stopped"); error.name = kind; throw error;
  };
  expect((await record()).outcome).toBe(kind === "AbortError" ? "cancelled" : "failure");
  expect(JSON.parse(memory.store.getRun(1)!.request!)).toEqual({ actual: true });
  expect(memory.store.listBranchFacts(1, "main")).toEqual([]);
  expect(memory.store.sourcePath(1, "main", 1).every(e => !memory.store.entryNoted(e.id))).toBe(true);
});


test("manual schemas accept empty calls and require explicit code files for each knowledge operation", () => {
  const definitions = Object.fromEntries(toolDefinitions.map(tool => [tool.name, tool]));
  const valid = (name: "note" | "memory", arguments_: Record<string, unknown>) => {
    const tool = definitions[name]!;
    try { validateToolArguments(tool as never, { type: "toolCall", id: "call", name, arguments: arguments_ as never }); return true; }
    catch { return false; }
  };
  expect(valid("note", {})).toBe(true);
  expect(valid("memory", {})).toBe(true);
  expect(valid("note", { title: "Incomplete" })).toBe(false);
  expect(valid("note", { title: "Evidence", sources: "[T1#E1] Evidence" })).toBe(true);
  const create = { op: "create", title: "Rule", text: "Use pnpm", category: "constraint", scope: "project",
    topics: [], supports: ["F1"], reason: "User ruled" };
  expect(valid("memory", create)).toBe(false);
  expect(valid("memory", { ...create, files: null })).toBe(true);
  expect(valid("memory", { ...create, files: ["src/store.ts#opaque"] })).toBe(true);
  expect(valid("memory", { ...create, files: "None" })).toBe(false);
  const note = memory.tools(manual()).find(tool => tool.name === "note")!;
  expect(note.execute(fact())).toContain("ok: F1");
  const write = memory.tools(manual()).find(tool => tool.name === "memory")!;
  expect(write.execute(create)).toContain("files: required");
  expect(memory.store.listKnowledgeRevisions()).toEqual([]);
  const receipt = JSON.parse(write.execute({ ...create, files: ["src/store.ts#opaque"] }));
  const base = memory.store.listKnowledgeRevisions()[0]!;
  expect(receipt.results).toEqual(["ok"]);
  const update = { op: "update", id: `K${base.knowledgeId}#${memory.store.versionTag(base.knowledgeId, base.id)}`,
    edits: [{ old: "pnpm", new: "corepack pnpm" }], supports: ["F1"], reason: "Clarify" };
  expect(write.execute(update)).toContain("files: required");
  expect(JSON.parse(write.execute({ ...update, files: null })).results).toEqual(["ok"]);
  expect(memory.store.listKnowledgeRevisions().map(revision => revision.files)).toEqual([["src/store.ts#opaque"], null]);
  expect(valid("memory", { ...create, files: null, slot: 1 })).toBe(false);
});

// 135: Pi and Claude Code validate a call against the advertised schema before it reaches Core, so this
// is the contract of `edits` itself. It runs Pi's own validator over both variants, not Core's checks.
test("135: the advertised memory schema accepts exactly one body form per update and edits only on update", () => {
  const noter = toolDefinitions.find(t => t.name === "memory")!;
  const valid = (tool: typeof noter, args: Record<string, unknown>) => {
    try { validateToolArguments(tool as never, { type: "toolCall", id: "call", name: tool.name, arguments: args as never }); return true; }
    catch { return false; }
  };
  const base = { supports: ["F1"], reason: "Clarify" };
  const update = { ...base, files: null, op: "update", id: "K1#abcd" };
  const full = { text: "Use pnpm", category: "reference", scope: "project", topics: [] };
  const edits = [{ old: "npm", new: "pnpm" }];
  const archive = { files: null, ...base, op: "archive", id: "K1#abcd", kind: "invalid", text: "No longer holds; nothing replaces it." };
  const accepted: Array<[string, Record<string, unknown>]> = [
    ["complete text with its metadata", { ...update, ...full }],
    ["one edit, metadata inherited", { ...update, edits }],
    ["an edit deleting text", { ...update, edits: [{ old: "npm", new: "" }] }],
    ["ordered edits with replacement metadata", { ...update, edits: [...edits, { old: "a", new: "b" }], category: "open", scope: "session", topics: ["x"] }],
  ];
  const rejected: Array<[string, Record<string, unknown>]> = [
    ["text and edits together", { ...update, ...full, edits }],
    ["neither text nor edits", update],
    ["text without its metadata", { ...update, text: "Use pnpm" }],
    ["an empty edit list", { ...update, edits: [] }],
    ["an edit with an empty old", { ...update, edits: [{ old: "", new: "pnpm" }] }],
    ["an edit without new", { ...update, edits: [{ old: "npm" }] }],
    ["an edit with another field", { ...update, edits: [{ old: "npm", new: "pnpm", all: true }] }],
    ["edits on an archive", { ...archive, edits }],
  ];
  const noterOnly: Array<[string, Record<string, unknown>]> = [
    ["edits on a create", { files: null, ...base, op: "create", title: "Fixture title", ...full, edits }],
  ];
  for (const [what, args] of accepted) expect(valid(noter, args), `Noter and manual accept ${what}`).toBe(true);
  for (const [what, args] of [...rejected, ...noterOnly]) expect(valid(noter, args), `Noter and manual reject ${what}`).toBe(false);
});

test("manual input and result are audited; facts enter the branch without advancing Noting", () => {
  const input = fact();
  const result = memory.tools(manual()).find(tool => tool.name === "note")!.execute(input);
  const run = memory.store.listRuns(1)[0]!;
  expect(run).toMatchObject({ kind: "manual", sessionId: 1, branch: "main", rangeFrom: "S1/T1", rangeTo: "S1/T1", outcome: "success" });
  expect(JSON.parse(run.request!)).toEqual(input); expect(run.response).toBe(result);
  expect(memory.store.listSourceEntries(1).some(e => memory.store.entryNoted(e.id))).toBe(false);
  expect(memory.store.listBranchFacts(1, "main").map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "sibling")).toEqual([]);
  expect(memory.pendingEntries(1, "main", 1)).toHaveLength(2);
});

test("116: manual memory commits one operation at a time and rejects Noter-only fields", () => {
  const tools = memory.tools(manual());
  expect(tools.find(tool => tool.name === "note")!.execute(fact())).toContain("F1");
  const knowledge = tools.find(tool => tool.name === "memory")!;
  const create = { files: null, op: "create", title: "Fixture title", text: "rule", category: "constraint", scope: "project", topics: [], supports: ["F1"], reason: "evidence" };
  expect(knowledge.execute({ ...create, skipped: [] })).toContain("rejected:");
  expect(knowledge.execute({ ...create, supports: ["$1"] })).toContain("rejected:");
  expect(memory.store.getKnowledge(1)).toBeNull();
  expect(knowledge.execute(create)).toContain('"committed"');
  expect(JSON.parse(memory.store.listRuns(1).at(-1)!.request!)).toEqual(create);
  expect(memory.store.getKnowledgeRevision(1, 1)?.text).toBe("rule");
  const archive = { files: null, op: "archive", id: `K1#${memory.store.versionTag(1, 1)}`, kind: "invalid", text: "Superseded; nothing replaces it.", supports: ["F1"], reason: "superseded" };
  expect(knowledge.execute(archive)).toContain('"committed"');
  expect(JSON.parse(memory.store.listRuns(1).at(-1)!.request!)).toEqual(archive);
  expect(memory.store.getKnowledgeRevision(1, 2)?.op).toBe("archive");
  expect(knowledge.execute({})).toContain('"committed"');
  expect(JSON.parse(memory.store.listRuns(1).at(-1)!.request!)).toEqual({});
});

test("source time follows the first source, including tool sources; all sources are checked", () => {
  memory.store.appendTurn({ sessionId: 1, kind: "turn", parentTurnId: 1, assistantText: "later", startedAt: "later source time" });
  memory.store.appendToolCall({ turnId: 2, name: "bash", status: "success", result: "passed" });
  const note = memory.tools(manual(1, 2)).find(tool => tool.name === "note")!;
  const observation = hydrate(memory.store.listSourceEntries(1, 2), memory.store).find(entry => entry.role === "toolResult")!;
  const cited = `T2#E${observation.entryOrdinal}`;
  expect(note.execute(fact(cited, { source: [cited, "T1#E1"] }))).toContain("F1");
  expect(memory.store.getFact(1)!.roles).toEqual([{ role: "user" }, { role: "observation" }]);
  expect(memory.store.getFact(1)).toMatchObject({ turnId: 1, createdAt: "first source time" });
  expect(memory.store.db.prepare("SELECT f.source_time, r.kind, r.created_at FROM facts f JOIN runs r ON r.id = f.run_id WHERE f.id = 1").get())
    .toEqual({ source_time: "first source time", kind: "manual", created_at: memory.store.getRun(1)!.createdAt });
  expect(note.execute(fact("T1#E1", { source: ["T1#E1", "T999#E1"] }))).toContain("rejected:");
  expect(memory.store.listSessionFacts(1)).toHaveLength(1);
});

test("116: malformed manual call rejects only itself; valid calls commit immediately", () => {
  const note = memory.tools(manual()).find(tool => tool.name === "note")!;
  expect(note.execute(null)).toContain("rejected:");
  expect(note.execute(fact())).toContain("ok: F1");
  expect(note.execute(fact("T1#E1", { support: [[42, "weak"]] }))).toContain("rejected:");
  expect(memory.store.listSessionFacts(1).map(f => f.id)).toEqual([1]);
});

test("the Noter's batch is frozen: a sibling source is refused, and the run keeps no read ledger", async () => {
  memory.store.appendTurn({ sessionId: 1, kind: "turn", parentTurnId: 1, assistantText: "sibling", startedAt: "later" });
  agent = async raw => {
    const input = raw as NotingAgentInput;
    expect(await submit(input, memory, { noteInput: [fact("T2#E1")], memoryInput: {} })).toContain("invalid source");
    expect(await submit(input, memory, { noteInput: [fact("T1#E1")], memoryInput: {} })).toBeUndefined();
    return { outcome: "success", output: "corrected", request: {} };
  };
  expect((await record()).outcome).toBe("success");
  expect(memory.store.sourcePath(1, "main", 1).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.listSourceEntries(1).filter(e => e.turnId === 2).every(e => !memory.store.entryNoted(e.id))).toBe(true);
  expect(JSON.parse(memory.store.getRun(1)!.response!)).not.toHaveProperty("readKnowledgeCommits");
});

test("search keeps query, scope, layer, topk and code, and rejects every removed parameter and bad value", () => {
  memory.store.appendToolCall({ turnId: 1, name: "bash", status: "success", result: "x".repeat(2000) });
  memory.tools(manual()).find(tool => tool.name === "note")!.execute(fact());
  memory.tools(manual()).find(tool => tool.name === "note")!.execute(fact());
  const search = memory.tools(manual()).find(tool => tool.name === "search")!;
  const run = (input: unknown) => search.execute(input) as string;
  expect(run({ query: "project", layer: "facts", topk: 1 })).toMatch(/^\[F2\]/);
  expect(run({ query: "project", layer: "facts", topk: 1 })).not.toContain("[F1]");
  for (const removed of ["queries", "category", "versions", "fields", "cap", "itemBudget", "maxTokens", "cursor"])
    expect(run({ query: "project", [removed]: removed === "queries" ? ["a"] : 1 })).toBe("rejected: unexpected parameter");
  expect(run({ query: "project", scope: "facts" })).toContain("rejected:");
  expect(run({ query: "project", topk: 0 })).toContain("rejected:");
  expect(run({ query: "" })).toContain("rejected:");
  expect(run({ code: " " })).toContain("rejected:");
});

test("search reaches other projects' evidence; write sources stay bound to the session", () => {
  const p = memory.store.createProject({ name: "other", declaredBy: "mark" });
  memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  memory.store.appendTurn({ sessionId: 2, kind: "turn", userPrompt: "private evidence", startedAt: "now" });
  memory.tools(manual(2, 2)).find(tool => tool.name === "note")!.execute(fact("T2#E1", { text: "private evidence" }));
  const tools = memory.tools(manual());
  expect(tools.find(tool => tool.name === "search")!.execute({ query: "private", layer: "all", scope: "global" })).toContain("private evidence");
  expect(tools.find(tool => tool.name === "note")!.execute(fact("T2#E1"))).toContain("rejected:"); // a write may only cite its own session
});


test("manual facts belong to their turn on every branch containing that turn", async () => {
  memory.tools(manual(1, 1, "A"))[1]!.execute(fact());
  await memory.noting({ sessionId: 1, branch: "B", headTurnId: 1 });
  expect(memory.store.listBranchFacts(1, "A").map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "B", 1).map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "C")).toEqual([]); // no path known for C
  expect(memory.store.listConsolidatedProjectFacts(1)).toEqual([]);
});

test("reads return every knowledge item while injection still applies the scope rule", () => {
  const ownProject = memory.store.getSession(1)!.projectId;
  const otherProject = memory.store.createProject({ name: "elsewhere", declaredBy: "mark" }).id;
  for (const projectId of [ownProject, otherProject]) {
    const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId, startedAt: "now", firstReplyAt: "now" });
    memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  }
  for (const sessionId of [1, 2, 3]) {
    const note = memory.tools(manual(sessionId, sessionId))[1]!;
    note.execute(fact(`T${sessionId}#E1`));
    memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId, createdAt: "now" }, operations:
      (["global", "project", "session"] as const).map((scope, i) => ({ files: null, op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion." as const, handle: `$e${i + 1}`, author: "fake", text: `knowledge owner ${sessionId} scope ${scope}`, category: "understanding" as const, scope, supports: [sessionId], createdAt: "now" })) });
  }
  const [search] = memory.tools(manual());
  const hits = search!.execute({ query: "knowledge", layer: "knowledge" });
  for (const id of [1, 2, 3, 4, 5, 7]) expect(hits).toContain(`[K${id}@`);
  for (const id of [6, 8, 9]) expect(hits).not.toContain(`[K${id}@`);
  const unbound = memory.search("knowledge", "knowledge");
  for (const id of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(unbound).toContain(`[K${id}@`);
  // Injection keeps the scope rule: another session's session knowledge and another project's project knowledge stay out.
  for (const id of [6, 8, 9]) expect(memory.inject(1)).not.toContain(`[K${id}@`);
  memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "later" }, operations: [
    { files: null, op: "archive", kind: "invalid", text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: 3, baseCommit: 3, supports: [1], createdAt: "later" },
  ] });
  expect(memory.trace("K3@v1")).toContain("owner 1 scope session");
  expect(memory.trace("K3", { versions: "history" })).toContain("archive");
});

test("branch facts apply the full-source path rule: a fact citing a turn off the path stays out", () => {
  memory.store.appendTurn({ sessionId: 1, kind: "turn", parentTurnId: 1, userPrompt: "second", startedAt: "now" });
  memory.tools(manual(1, 2))[1]!.execute(fact("T1#E1", { source: ["T1#E1", "T2#E1"] }));
  expect(memory.store.listBranchFacts(1, "main", 2).map(f => f.id)).toEqual([1]);
  expect(memory.store.listBranchFacts(1, "main", 1)).toEqual([]); // T2 is not on the path that ends at T1
});

test("one reading of the model-facing result: a `rejected:` receipt and a batch `results` entry, for every consumer", () => {
  // The wire format is unchanged; what is shared is its interpretation. Both Pi adapters and the
  // test host classify a tool result through this one function instead of re-deriving the format —
  // core produces both spellings here, so a change to either has one place to make it.
  expect(toolRejected("search", "rejected: unknown or expired cursor")).toBe(true);
  expect(toolRejected("search", "[F1] a fact line")).toBe(false);
  // A batch writer answers with JSON: one rejected entry makes the whole call a refusal.
  expect(toolRejected("note", JSON.stringify({ results: ["ok: F1", "rejected: invalid source"] }))).toBe(true);
  expect(toolRejected("memory", JSON.stringify({ results: ["ok: K1@1"] }))).toBe(false);
  // Only the batch writers speak that JSON; a read tool's body that happens to contain it does not.
  expect(toolRejected("search", JSON.stringify({ results: ["rejected: not mine"] }))).toBe(false);
  expect(toolRejected("note", "not json at all")).toBe(false);
  // The real receipts a run produces, classified the same way.
  const search = memory.tools(manual()).find(tool => tool.name === "search")!, note = memory.tools(manual()).find(tool => tool.name === "note")!;
  expect(toolRejected("search", search.execute({ query: "a", queries: ["b"] }) as string)).toBe(true);
  expect(toolRejected("note", note.execute(fact("T9#E1")))).toBe(true);
  expect(toolRejected("note", note.execute(fact()))).toBe(false);
});

// Ticket 144 (stage 2 leftover): `inadmissible` is a kind the `memory` tool accepts, and like `invalid` it needs an explanation.
test("144: the memory tool archives with kind inadmissible, and the kind requires its explanation like invalid", () => {
  const tools = memory.tools(manual());
  tools.find(tool => tool.name === "note")!.execute(fact());
  const knowledge = tools.find(tool => tool.name === "memory")!;
  expect(knowledge.execute({ files: null, op: "create", title: "Fixture title", text: "A running log of the session", category: "constraint", scope: "project", topics: [], supports: ["F1"], reason: "evidence" })).toContain('"committed"');
  const archive = { files: null, op: "archive", id: `K1#${memory.store.versionTag(1, 1)}`, kind: "inadmissible", supports: ["F1"], reason: "not an understanding" };
  expect(knowledge.execute(archive)).toContain("rejected:"); // no explanation
  expect(memory.store.getKnowledgeRevision(1, 2)).toBeNull();
  expect(knowledge.execute({ ...archive, text: "A running log of one session, not an understanding; nothing replaces it." })).toContain('"committed"');
  expect(memory.store.getKnowledgeRevision(1, 2)).toMatchObject({ op: "archive", archiveKind: "inadmissible" });
  expect(toolDefinitions.find(t => t.name === "memory")!.description).toContain("inadmissible");
});
