import { afterEach, expect, test } from "vitest";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("48: the trusted facade revives an archived identity after complete exact reads", async () => {
  let old!: { knowledgeId: number; commit: number };
  let archiveCommit = 0;
  let returned!: { knowledgeId: number; commit: number };
  const memory = TraceMemory(":memory:", async raw => {
    const task = raw as DreamingAgentInput;
    expect(task.prompt).toContain("same object's same independently maintainable claim or state");
    expect(task.prompt).toContain("search using `versions: history`");
    expect(task.prompt).toContain("completely read the archive commit and its parent");
    expect(task.prompt).toContain("likely to return, prefer preserving its identity through merge or update over archive");
    expect(task.material.changed).toContain("New:");
    expect(task.material.changed).toContain("Returned widget state");
    task.tools.find(tool => tool.name === "check")!.execute({});
    const writer = task.tools.find(tool => tool.name === "memory")!;
    const operation = { op: "merge", id: `K${old.knowledgeId}@${archiveCommit}`,
      absorb: [`K${returned.knowledgeId}@${returned.commit}`], text: "Returned widget state",
      category: "constraint", scope: "project", supports: [], topics: ["widget"], reason: "Revive the returning widget identity" };
    expect(writer.execute({ operations: [operation], skipped: [] })).toContain("knowledge was not read as visible and active");
    const trace = task.tools.find(tool => tool.name === "trace")!;
    trace.execute({ address: `K${old.knowledgeId}@${archiveCommit}`, itemBudget: null });
    trace.execute({ address: `K${old.knowledgeId}@${old.commit}`, itemBudget: null });
    const result = writer.execute({ operations: [operation], skipped: [] });
    expect(result).toContain('"committed"');
    expect(task.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "revived", request: { exact: "request" } };
  }, { dreaming: { triggerTokens: 1 } });
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "revival", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "widget", startedAt: "now" });
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const factResult = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
    { turnId: turn.id, actor: "user", category: "decision", text: "Widget state", source: [`T${turn.id}#user`], createdAt: "now" },
  ] });
  if (!factResult.ok) throw new Error(factResult.problems.join("; "));
  const fact = factResult.facts[0]!.id;
  const content = (text: string) => ({ text, category: "constraint" as const, scope: "project" as const,
    supports: [fact], topics: ["widget"], reason: "test", createdAt: "now" });
  const created = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, createdAt: "now" },
    operations: [{ op: "create", handle: "$old", author: "test", ...content("Original widget state") }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  old = created.committed[0]!;

  const firstRange = store.retainDreamingRange(path, [old.commit]);
  const firstClaim = store.acquireClaim(path, "dreaming", "archive")!;
  const firstExecution = store.beginExecution({ sessionId: session.id, phase: "dreaming", head: firstRange.anchor, origin: firstRange.origin });
  const firstRun = store.bindDreamingRun(store.bindRunOrigin({ kind: "dreaming", sessionId: session.id, branch: "main",
    dreamingRangeId: firstRange.id, claim: firstClaim, executionId: firstExecution, createdAt: "now" }, firstRange.origin));
  const archived = store.commitConsolidationRun({ path, run: firstRun, operations: [{ op: "archive", knowledgeId: old.knowledgeId,
    baseCommit: old.commit, supports: [], reason: "Widget retired", createdAt: "now" }] });
  if (!archived.ok) throw new Error(archived.problems.join("; "));
  archiveCommit = archived.committed[0]!.commit;
  const firstRunId = store.dreamingRunId(firstRun)!;
  store.updateRun(firstRunId, { ...firstRun, outcome: "success" });
  store.completeDreaming(firstRunId, [old.commit], [archiveCommit]);
  store.releaseClaim(firstClaim);

  const returnedResult = store.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId: session.id, createdAt: "now" },
    operations: [{ op: "create", handle: "$returned", author: "test", ...content("Returned widget state") }] });
  if (!returnedResult.ok) throw new Error(returnedResult.problems.join("; "));
  returned = returnedResult.committed[0]!;

  const result = await memory.dream(path);
  expect(result.outcome).toBe("success");
  const current = store.listCurrentKnowledge(path);
  expect(current).toHaveLength(1);
  expect(current[0]!.knowledge.id).toBe(old.knowledgeId);
  expect(current[0]!.revision.parentId).toBe(archiveCommit);
  expect(store.listKnowledgeLinks(returned.knowledgeId)).toContainEqual(expect.objectContaining({ kind: "merged_into", toKnowledge: old.knowledgeId }));
  expect(memory.inject(path)).toContain("Returned widget state");
});
