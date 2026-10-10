import { afterEach, expect, test } from "vitest";
import { roomyPoolBudget } from "../../knowledge-budget-fixture.ts";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import { dreamingToolDefinitions, toolDefinitions } from "../../../src/core/api/tools.ts";
import { knowledge } from "../../support/seed.ts";

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
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "root", role: "user", text: texts.join("\n"), raw: "{}", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: texts.map(text => ({
    turnId: turn.id, entryIds: [entry.id], category: "decision" as const, actor: "user" as const, text, source: [`T${turn.id}#E1`], createdAt: "now" })) });
  if (!facts.ok) throw Error(facts.problems.join());
  const content = (index: number) => ({ text: texts[index]!, category: "constraint" as const, scope: "project" as const, supports: [facts.facts[index]!.id], topics: [], reason: "fact", createdAt: "now" });
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" },
    operations: texts.map((_, index) => ({ op: "create" as const, handle: `$${index + 1}`, author: "test", ...content(index) })) });
  if (!created.ok) throw Error(created.problems.join());
  const pool = `project:${project.id}`;
  store.setKnowledgeBudget("project", roomyPoolBudget(store.pendingPoolWeight(pool, target)));
  return { memory, store, project, pool, items: created.committed, content, target };
}
const handle = (item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@${item.commit}`;
const tool = (task: DreamingAgentInput, name: string) => task.tools.find(t => t.name === name)! as { execute(input: unknown): string };

test("59/68/127: the memory schema branches on phase and says accepted Dreamer skips process exact frozen versions", () => {
  const dreamer = dreamingToolDefinitions().find(t => t.name === "memory")!;
  // 127: a skip is its own call, `{skip, because}`, with no operation field.
  expect((dreamer.parameters as any).else.then.required).toEqual(["skip", "because"]);
  expect((dreamer.parameters.properties as any).skip).toMatchObject({ type: "string", pattern: "^K[1-9][0-9]*@v[1-9][0-9]*$" });
  expect((dreamer.parameters.properties as any).because).toEqual({ type: "string", minLength: 1 });
  for (const key of ["skipped", "skip"]) expect((toolDefinitions.find(t => t.name === "memory")!.parameters.properties as Record<string, unknown>)).not.toHaveProperty(key);
  expect(dreamer.description)
    .toContain("skip with because names an exact untagged K@vN history address for a frozen version that was deliberated and intentionally left unchanged; it requires no full-body read and grants no mutation authority; it marks that version processed without changing it");
});

test("64c: a skip is audited but terminal success processes the frozen pair independently of the skip", async () => {
  const f = fixture(async task => {
    expect(tool(task, "check").execute({})).toContain(`frozen versions not deliberated: K${f.items[0]!.knowledgeId}@v1`); // 104
    const receipt = JSON.parse(tool(task, "memory").execute({ skip: `K${f.items[0]!.knowledgeId}@v1`, because: "reviewed; no maintenance needed" }));
    expect(receipt).toMatchObject({ results: ["ok"], committed: [] });
    expect(tool(task, "check").execute({})).toContain("Blockers: none");
    return success;
  });
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("success");
  if (!("runId" in result)) throw Error("missing run");
  const response = JSON.parse(f.store.getRun(result.runId)!.response!);
  expect(response.skipped).toEqual([{ knowledge: `K${f.items[0]!.knowledgeId}@v1`, because: "reviewed; no maintenance needed" }]);
  expect(response.check).toMatchObject({ frozenRevisionIds: [f.items[0]!.commit], ownRevisionIds: [], problems: [] });
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed").all())
    .toEqual([{ pool: f.pool, revision_id: f.items[0]!.commit }]);
});

test("68/104: untouched frozen items are not an admission failure; they fail the run and remain pending", async () => {
  const f = fixture(async task => {
    expect(tool(task, "check").execute({})).toContain("frozen versions not deliberated");
    return success;
  }, ["first rule", "second rule"]);
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("failure");
  expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id").all(f.pool)).toEqual([]);
  expect(f.store.pendingVersions(f.pool, f.target).map(item => item.revisionId)).toEqual(f.items.map(item => item.commit));
});

// 127 replaces the atomic skip batch: one skip per call, each refused on its own with today's checks.
test("127: one skip per call keeps the skip refusals, and a malformed call refuses only itself", async () => {
  let finished = false;
  const f = fixture(async task => {
    const memory = tool(task, "memory"), skip = (knowledge: string, because = "reviewed") => memory.execute({ skip: knowledge, because });
    const [first, second] = f.items, version = (item: { knowledgeId: number }) => `K${item.knowledgeId}@v1`;
    const revisions = f.store.listKnowledgeRevisions().length;
    expect(skip("K999@v999")).toContain("rejected: M1: K999@v999: not a supplied handle of this run");
    const later = knowledge(f.store, f.target, "project", "constraint", f.content(0).supports, "later rule", { run: { kind: "manual", createdAt: "now" } });
    expect(skip(version(later))).toContain(`rejected: M2: ${version(later)}: skip must name an exact frozen version from this run`);
    expect(skip(version(first!), " ")).toContain("rejected: M3: skip requires a non-empty because");
    expect(memory.execute({ skip: version(first!), because: "mixed", op: "update" })).toContain("rejected: M4: a skip call carries only skip and because");
    expect(memory.execute({ operations: [], skipped: [{ knowledge: version(first!), because: "old shape" }] }))
      .toBe("rejected: memory expects one item, one scalar drop; operations: unexpected field; skipped: unexpected field");
    expect(memory.execute({ knowledge: version(first!), because: "old field" })).toContain("knowledge: unexpected field");
    expect(tool(task, "check").execute({})).toContain("memory expects one item");
    expect(f.store.listKnowledgeRevisions()).toHaveLength(revisions + 1);
    expect(JSON.parse(skip(version(first!)))).toMatchObject({ results: ["ok"], committed: [] });
    expect(tool(task, "check").execute({})).not.toContain("memory expects one item"); // cleared by the well-formed call
    expect(skip(version(first!))).toContain(`rejected: M5: ${version(first!)}: version was already consumed by this run`);
    const update = { op: "update", id: `K${second!.knowledgeId}#${f.store.versionTag(second!.knowledgeId, second!.commit)}`, text: "maintained rule",
      category: "constraint", scope: "project", supports: [], topics: [], reason: "maintain" };
    expect(memory.execute(update)).toContain('"committed"');
    expect(skip(version(second!))).toContain(`rejected: M6: ${version(second!)}: version was already consumed by this run`);
    finished = true; // the run's expected failure must not hide an assertion error above
    return success;
  }, ["first rule", "second rule"]);
  const result = await f.memory.dream(f.target);
  expect(finished).toBe(true);
  expect(result.outcome).toBe("failure");
  if (!("problems" in result)) throw Error("missing problems");
  expect(result.problems.filter(problem => /^M\d+: /.test(problem)).map(problem => problem.split(":")[0])).toEqual(["M1", "M2", "M3", "M4", "M5", "M6"]);
  expect(result.problems.join("\n")).not.toContain("memory expects one item");
});
