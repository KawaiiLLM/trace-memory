import { afterEach, expect, test } from "vitest";
import { TraceMemory, memoryFiles, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { dreamerWrite } from "../../dreaming-skips.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("48/92: the trusted facade revives an archived identity from exact tagged bases", async () => {
  let old!: { knowledgeId: number; commit: number };
  let archiveCommit = 0;
  let returned!: { knowledgeId: number; commit: number };
  let trigger!: { knowledgeId: number; commit: number };
  const memory = TraceMemory(":memory:", async raw => {
    const task = raw as DreamingAgentInput;
    expect(task.prompt).toContain("find the archived identity by the object's name with `search` (every version is searched; archived ones are marked)");
    // Step 1 as the prompt writes it: its example code, run with this New item's word, finds the revival candidate.
    const example = /e\.g\. `(for \(const w of \[[^\]]*\][^`]*)`/.exec(task.prompt)![1]!.replace(/\[[^\]]*\]/, '["widget"]');
    const found = await task.tools.find(tool => tool.name === "search")!.execute({ layer: "knowledge", code: example });
    expect(found).toContain("Script completed");
    expect(found).toContain(`widget [K${old.knowledgeId}@v2] (archived)`);
    expect(found).toContain(`widget [K${old.knowledgeId}@v1] (superseded)`);
    expect(found).not.toContain(`K${returned.knowledgeId}@v1`); // the New item itself is current, not a candidate
    expect(task.prompt).toContain("read the archive commit and its parent completely");
    expect(task.material.changed).toContain(`New K${returned.knowledgeId}@v1:`);
    expect(task.material.changed).toContain("Returned widget state");
    task.tools.find(tool => tool.name === "check")!.execute({});
    const writer = task.tools.find(tool => tool.name === "memory")!;
    const operation = { op: "merge", id: `K${old.knowledgeId}#${store.versionTag(old.knowledgeId, archiveCommit)}`,
      absorb: [`K${returned.knowledgeId}#${store.versionTag(returned.knowledgeId, returned.commit)}`], text: "Returned widget state",
      category: "constraint", scope: "project", supports: [], topics: ["widget"], reason: "Revive the returning widget identity" };
    // 92 tags identify exact bases without a read ledger; archive revival authority remains.
    const result = dreamerWrite(writer, { operations: [operation, { op: "archive", kind: "budget", id: `K${trigger.knowledgeId}#${store.versionTag(trigger.knowledgeId, trigger.commit)}`,
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
    { turnId: turn.id, actor: "user", category: "decision", text: "Widget state", source: [`T${turn.id}#user`], entryIds: [entry.id], createdAt: "now" },
  ] });
  if (!factResult.ok) throw new Error(factResult.problems.join("; "));
  const fact = factResult.facts[0]!.id;
  const content = (text: string) => ({ text, category: "constraint" as const, scope: "project" as const,
    supports: [fact], topics: ["widget"], reason: "test", createdAt: "now" });
  const created = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, createdAt: "now" },
    operations: [{ op: "create", handle: "$old", author: "test", ...content("Original widget state") }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  old = created.committed[0]!;

  expect(memoryFiles(memory, path).read(`trace://K${old.knowledgeId}@v1`).content).toContain("Original widget state");
  const manual = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id });
  const archived = JSON.parse(manual.find(tool => tool.name === "memory")!.execute({ op: "archive", kind: "budget",
    id: `K${old.knowledgeId}#${store.versionTag(old.knowledgeId, old.commit)}`, supports: [`F${fact}`], reason: "Widget retired" }));
  expect(archived.committed[0]!.version).toBe(`K${old.knowledgeId}@v2`);
  archiveCommit = store.resolveVersionOrdinal(old.knowledgeId, 2);

  const returnedResult = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, createdAt: "now" },
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
