import { afterEach, expect, test } from "vitest";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("48: the trusted facade revives an archived identity after complete exact reads", async () => {
  let old!: { knowledgeId: number; commit: number };
  let archiveCommit = 0;
  let returned!: { knowledgeId: number; commit: number };
  let trigger!: { knowledgeId: number; commit: number };
  const memory = TraceMemory(":memory:", async raw => {
    const task = raw as DreamingAgentInput;
    expect(task.prompt).toContain("when a current item continues the same independent claim as an archived one, merge into the archived identity so the history stays traceable");
    expect(task.prompt).toContain("find the archived identity by the object's name with `versions: history`");
    expect(task.prompt).toContain("read the archive commit and its parent completely");
    expect(task.prompt).toContain("topical relation alone does not revive");
    expect(task.material.changed).toContain(`New K${returned.knowledgeId}@${returned.commit}:`);
    expect(task.material.changed).toContain("Returned widget state");
    task.tools.find(tool => tool.name === "check")!.execute({});
    const writer = task.tools.find(tool => tool.name === "memory")!;
    const operation = { op: "merge", id: `K${old.knowledgeId}@${archiveCommit}`,
      absorb: [`K${returned.knowledgeId}@${returned.commit}`], text: "Returned widget state",
      category: "constraint", scope: "project", supports: [], topics: ["widget"], reason: "Revive the returning widget identity" };
    // 76: the archive's own rendering in the frozen pending material already registers the archive
    // version (and the body it removed) as read, so the revival merge needs no separate trace first.
    const result = writer.execute({ operations: [operation, { op: "archive", id: `K${trigger.knowledgeId}@${trigger.commit}`,
      supports: [], reason: "Retire the explicit revival trigger." }], skipped: [] });
    expect(result).toContain('"committed"');
    expect(task.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "revived", request: { exact: "request" } };
  });
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "revival", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "widget", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "widget", role: "user", text: "widget", raw: "widget", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
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

  const manual = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id });
  manual.find(tool => tool.name === "trace")!.execute({ address: `K${old.knowledgeId}@${old.commit}`, itemBudget: null });
  const archived = JSON.parse(manual.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "archive",
    id: `K${old.knowledgeId}@${old.commit}`, supports: [`F${fact}`], reason: "Widget retired" }], skipped: [] }));
  archiveCommit = archived.committed[0]!.commit;

  const returnedResult = store.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId: session.id, createdAt: "now" },
    operations: [{ op: "create", handle: "$returned", author: "test", ...content("Returned widget state") }] });
  if (!returnedResult.ok) throw new Error(returnedResult.problems.join("; "));
  returned = returnedResult.committed[0]!;
  trigger = createDreamerTrigger(memory, path, fact, 1, "project");

  const result = await memory.dream(path);
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  const current = store.currentKnowledge(path);
  expect(current).toHaveLength(1);
  expect(current[0]!.knowledge.id).toBe(old.knowledgeId);
  expect(current[0]!.revision.parentId).toBe(archiveCommit);
  expect(store.listKnowledgeLinks(returned.knowledgeId)).toContainEqual(expect.objectContaining({ kind: "merged_into", toKnowledge: old.knowledgeId }));
  expect(memory.inject(path)).toContain("Returned widget state");
});
