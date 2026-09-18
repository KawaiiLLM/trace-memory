import { afterEach, expect, test } from "vitest";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import { consolidationToolDefinitions, dreamingToolDefinitions, toolDefinitions, validateReadInput } from "../../../src/core/api/tools.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
const success = { outcome: "success", output: "done", request: { exact: "request" } } as const satisfies RunAgentResult;

/** One project session with `count` supplied New items, each created on its own fact. */
function fixture(agent: (task: DreamingAgentInput) => Promise<RunAgentResult>, texts = ["durable rule"]) {
  const memory = TraceMemory(":memory:", task => agent(task as DreamingAgentInput), { dreaming: { triggerTokens: 1 } }); memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "P", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "root", role: "user", text: texts.join("\n"), raw: "{}", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: texts.map(text => ({
    turnId: turn.id, entryIds: [entry.id], category: "decision" as const, actor: "user" as const, text, source: [`T${turn.id}#E1`], createdAt: "now" })) });
  if (!facts.ok) throw Error(facts.problems.join());
  const content = (index: number) => ({ text: texts[index]!, category: "constraint" as const, scope: "project" as const, supports: [facts.facts[index]!.id], topics: [], reason: "fact", createdAt: "now" });
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" },
    operations: texts.map((_, index) => ({ op: "create" as const, handle: `$${index + 1}`, author: "test", ...content(index) })) });
  if (!created.ok) throw Error(created.problems.join());
  return { memory, store, items: created.committed, content, target };
}
const handle = (item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@${item.commit}`;
const tool = (task: DreamingAgentInput, name: string) => task.tools.find(t => t.name === name)!;

test("59: the memory schema branches on the phase — Dreamer skips name knowledge, the Consolidator's skipped facts are unchanged", () => {
  const items = (definitions: { name: string; parameters: Record<string, unknown> }[]) =>
    ((definitions.find(t => t.name === "memory")!.parameters.properties as any).skipped.items) as { required: string[]; properties: Record<string, unknown> };
  expect(items(dreamingToolDefinitions()).required).toEqual(["knowledge", "because"]);
  expect(items(dreamingToolDefinitions()).properties.knowledge).toEqual({ type: "string", pattern: "^K[1-9][0-9]*@[1-9][0-9]*$" });
  expect(items(consolidationToolDefinitions()).required).toEqual(["fact", "because"]);
  expect(items(toolDefinitions as any).required).toEqual(["fact", "because"]);
  expect(dreamingToolDefinitions().find(t => t.name === "memory")!.description).toContain("a skip accounts for the item and never certifies it");
  const search = toolDefinitions.find(t => t.name === "search")!.parameters as { properties: Record<string, unknown>; oneOf: unknown[] };
  expect(search.properties.queries).toMatchObject({ type: "array", minItems: 1 });
  expect(search.oneOf).toEqual([{ required: ["query"] }, { required: ["queries"] }]);
  expect(() => validateReadInput("search", { query: "a", queries: ["a"] })).toThrow("query and queries are exclusive");
  expect(() => validateReadInput("search", { queries: [] })).toThrow("queries must be a non-empty array of strings");
  expect(() => validateReadInput("search", {})).toThrow("query must be a string");
  expect(validateReadInput("search", { queries: ["a"] })).toEqual({ queries: ["a"] });
});

test("59: a skip of a supplied handle accounts for its event, is recorded with the run, and the successor-free leaf is still certified", async () => {
  const f = fixture(async task => {
    const check = tool(task, "check").execute({});
    expect(check).toContain(`- unaccounted: ${handle(f.items[0]!)}`);
    const receipt = JSON.parse(tool(task, "memory").execute({ operations: [], skipped: [{ knowledge: handle(f.items[0]!), because: "reads on its own; no duplicate, no conflicting fact" }] }));
    expect(receipt).toMatchObject({ results: ["ok"], committed: [] });
    expect(tool(task, "check").execute({})).toContain("Blockers: none");
    return success;
  });
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("success");
  if (!("runId" in result)) throw Error("missing run");
  const response = JSON.parse(f.store.getRun(result.runId)!.response!);
  expect(response.skipped).toEqual([{ knowledge: handle(f.items[0]!), because: "reads on its own; no duplicate, no conflicting fact" }]);
  expect(response.check).toMatchObject({ eventIds: [f.items[0]!.commit], resultIds: [f.items[0]!.commit], problems: [] });
  expect(f.store.isKnowledgeProcessed(f.items[0]!.commit)).toBe(true);
  expect(f.store.pendingKnowledgeEvents(f.target)).toEqual([]);
});

test("59: an untouched supplied leaf is reported unaccounted, blocks the final transaction and is not certified", async () => {
  let receipt = "";
  const f = fixture(async task => { receipt = tool(task, "check").execute({}); return success; }, ["first rule", "second rule"]);
  const result = await f.memory.dream(f.target);
  expect(receipt).toContain(`- unaccounted: ${handle(f.items[0]!)}, ${handle(f.items[1]!)}`);
  expect(result.outcome).toBe("failure");
  if (!("runId" in result)) throw Error("missing run");
  expect(result.problems).toContain(`unaccounted: ${handle(f.items[0]!)}, ${handle(f.items[1]!)}`);
  expect(f.items.every(item => !f.store.isKnowledgeProcessed(item.commit))).toBe(true);
  expect(f.store.db.prepare("SELECT * FROM dreaming_completions WHERE run_id = ?").all(result.runId)).toEqual([]);
});

test("59: skips of an unknown, processed-reference, consumed or reasonless handle are rejected like any illegal write", async () => {
  let reference!: { knowledgeId: number; commit: number };
  const f = fixture(async task => {
    const memory = tool(task, "memory");
    const skip = (skipped: unknown[], operations: unknown[] = []) => memory.execute({ operations, skipped });
    expect(skip([{ knowledge: "K999@999", because: "x" }])).toContain("rejected: K999@999: not a supplied handle of this run");
    expect(skip([{ knowledge: handle(reference), because: "x" }])).toContain(`rejected: ${handle(reference)}: not a supplied handle of this run`);
    expect(skip([{ knowledge: handle(f.items[0]!), because: " " }])).toContain("rejected: skipped requires knowledge and non-empty because only");
    expect(skip([{ fact: "F1", because: "the Consolidator's shape" }])).toContain("rejected: skipped requires knowledge and non-empty because only");
    expect(skip([{ knowledge: handle(f.items[0]!), because: "x" }, { knowledge: handle(f.items[0]!), because: "y" }])).toContain("rejected: duplicate skipped knowledge");
    // Consumed in the same batch, then consumed by an earlier batch of this run.
    const update = { op: "update", id: handle(f.items[0]!), text: "maintained rule", category: "constraint", scope: "project", supports: [], topics: [], reason: "maintain" };
    expect(skip([{ knowledge: handle(f.items[0]!), because: "x" }], [update])).toContain(`rejected: ${handle(f.items[0]!)}: already consumed by an operation of this batch`);
    expect(f.store.listKnowledgeRevisions()).toHaveLength(2); // a rejected batch writes nothing
    const own = JSON.parse(skip([], [update])).committed[0] as { knowledgeId: number; commit: number };
    expect(skip([{ knowledge: handle(f.items[0]!), because: "x" }])).toContain(`rejected: ${handle(f.items[0]!)}: already consumed by an operation of this run`);
    // An own result of this run is a supplied handle.
    expect(JSON.parse(skip([{ knowledge: handle(own), because: "own result reviewed" }]))).toMatchObject({ results: ["ok"] });
    expect(tool(task, "check").execute({})).toContain("Blockers: none");
    return success;
  });
  const created = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$reference", author: "test", ...f.content(0), text: "processed reference" }] });
  if (!created.ok) throw Error(created.problems.join());
  reference = created.committed[0]!;
  const range = f.store.retainDreamingRange(f.target, [reference.commit]);
  const run = f.store.recordRun({ kind: "dreaming", sessionId: f.target.sessionId, branch: f.target.branch, dreamingRangeId: range.id, outcome: "success", createdAt: "now" });
  f.store.completeDreaming(run.id, [reference.commit], [reference.commit]);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
});

test("59: a skipped handle whose root gains a path successor is accounted and, as today, not certified", async () => {
  const f = fixture(async task => {
    expect(JSON.parse(tool(task, "memory").execute({ operations: [], skipped: [{ knowledge: handle(f.items[0]!), because: "nothing to change" }] })).results).toEqual(["ok"]);
    const moved = f.store.commitConsolidationRun({ path: f.target, run: f.store.bindRunOrigin({ kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, f.store.triggerOrigin(f.target)),
      operations: [{ op: "update", knowledgeId: f.items[0]!.knowledgeId, baseCommit: f.items[0]!.commit, ...f.content(0), text: "external successor after the skip" }] });
    expect(moved.ok).toBe(true);
    expect(tool(task, "check").execute({})).toContain("Blockers: none");
    return success;
  });
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("success");
  if (!("runId" in result)) throw Error("missing run");
  expect(JSON.parse(f.store.getRun(result.runId)!.response!).check).toMatchObject({ eventIds: [f.items[0]!.commit], resultIds: [], consumedInputIds: [f.items[0]!.commit] });
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events").all().map(row => Number(row.event_id))).toEqual([f.items[0]!.commit]);
  expect(f.store.listKnowledgeRevisions().every(revision => !f.store.isKnowledgeProcessed(revision.id))).toBe(true);
});

test("59: a batched search returns one best hit per query under the shared options, echoes the query and names the empty ones", () => {
  const f = fixture(async () => success, ["alpha widget cache rule", "beta widget cache rule", "gamma schema migration rule"]);
  const who = { sessionId: f.target.sessionId, headTurnId: f.target.headTurnId, branch: "main" };
  const batched = f.memory.search(["widget cache", "schema", "nothing here"], "knowledge", who);
  const lines = batched.split("\n");
  // 59b: hits are in similarity order — the shorter "beta" body is the closer match for "widget cache".
  expect(lines.filter(line => line.startsWith('"widget cache": '))).toEqual([expect.stringContaining(`[${handle(f.items[1]!)}]`)]);
  expect(lines.filter(line => line.startsWith('"schema": '))).toEqual([expect.stringContaining(`[${handle(f.items[2]!)}]`)]);
  expect(batched).not.toContain(`[${handle(f.items[0]!)}]`);
  expect(batched).toContain('no hit: "nothing here"');
  expect(batched).toContain("searched: project sessions; global/project/session knowledge, current versions");
  const two = f.memory.search(["widget cache"], "knowledge", { ...who, cap: 2 });
  expect(two).toContain(`"widget cache": [${handle(f.items[0]!)}]`);
  expect(two).toContain(`"widget cache": [${handle(f.items[1]!)}]`);
  expect(two).not.toContain("no hit");
  // The single form is untouched: no echo, no empty-query receipt, cap still counts lines.
  const single = f.memory.search("widget cache", "knowledge", who);
  expect(single).toContain(`[${handle(f.items[0]!)}]`); expect(single).toContain(`[${handle(f.items[1]!)}]`);
  expect(single).not.toContain('"widget cache": '); expect(single).not.toContain("no hit");
  expect(f.memory.search("absent everywhere", "knowledge", who)).not.toContain("no hit");
  // 59b: the batched form orders each query's hits by lexical similarity, so cap 1 keeps the closest
  // match rather than the lowest K id; the single form keeps K-id order.
  const g = fixture(async () => success, ["cache seat rule for the whole widget family and every worker", "seat", "the seat rule"]);
  const whoG = { sessionId: g.target.sessionId, headTurnId: g.target.headTurnId, branch: "main" };
  const ranked = g.memory.search(["seat"], "knowledge", whoG).split("\n").filter(line => line.startsWith('"seat": '));
  expect(ranked).toEqual([expect.stringContaining(`[${handle(g.items[1]!)}]`)]);
  const singleOrder = g.memory.search("seat", "knowledge", whoG);
  expect(singleOrder.indexOf(`[${handle(g.items[0]!)}]`)).toBeLessThan(singleOrder.indexOf(`[${handle(g.items[1]!)}]`));
  // The Dreamer's bound tool takes the same form.
  const bound = f.memory.tools({ kind: "manual", sessionId: f.target.sessionId, branch: "main", currentTurnId: f.target.headTurnId });
  const search = bound.find(t => t.name === "search")!;
  expect(search.execute({ queries: ["schema"], layer: "knowledge" })).toContain(`"schema": [${handle(f.items[2]!)}]`);
  expect(search.execute({ query: "schema", queries: ["schema"] })).toContain("rejected: query and queries are exclusive");
});
