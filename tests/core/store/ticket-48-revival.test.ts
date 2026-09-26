import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture() {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected non-Dreamer phase"); });
  const memory = TraceMemory(":memory:", scenarios.agent); memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "revival", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const root = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
  const entry = store.appendSourceEntry({ sessionId: session.id, turnId: root.id, nativeLineage: "fixture", nativeId: "revival-trigger",
    role: "user", text: "root", raw: "root", calls: [] });
  store.selectSourcePath(session.id, "main", [entry.id]);
  store.setCurrentPath(session.id, "main", root.id, "fixture");
  const path = { sessionId: session.id, branch: "main", headTurnId: root.id, triggerEntryId: entry.id };
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" }, facts: [
    { turnId: root.id, entryIds: [entry.id], category: "decision", actor: "user", text: "The object exists", source: [`T${root.id}#user`], createdAt: "now" },
  ] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const fact = noted.facts[0]!.id;
  const content = (text: string) => ({ text, category: "constraint" as const, scope: "project" as const,
    supports: [fact], reason: "test", topics: ["object"], createdAt: "now" });
  const create = (text: string) => {
    const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" },
      operations: [{ op: "create", handle: `$${text}`, author: "test", ...content(text) }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const tag = (item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}#${store.versionTag(item.knowledgeId, item.commit)}`;
  const history = (item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, item.commit)}`;
  return { memory, scenarios, store, project, session, root, entry, path, fact, content, create, tag, history };
}

async function archive(f: ReturnType<typeof fixture>, item: { knowledgeId: number; commit: number }, sequence: number) {
  const trigger = createDreamerTrigger(f.memory, f.path, f.fact, sequence, "project");
  let archived!: { knowledgeId: number; commit: number };
  const result = await f.scenarios.run(f.memory, f.path, input => {
    const request = { fixture: "archive revival predecessor", sequence }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    for (const value of [item, trigger]) trace.execute({ address: f.tag(value), itemBudget: null });
    const receipt = JSON.parse(write.execute({ operations: [
      { op: "archive", id: f.tag(item), supports: [], reason: "Object ended" },
      { op: "archive", id: f.tag(trigger), supports: [], reason: "Retire archive trigger" },
    ], skipped: [] }));
    expect(receipt.committed.find((value: { knowledgeId: number }) => value.knowledgeId === item.knowledgeId)).toMatchObject({ version: `K${item.knowledgeId}@v2` });
    archived = { knowledgeId: item.knowledgeId, commit: f.store.resolveVersionOrdinal(item.knowledgeId, 2) };
    return { outcome: "success", output: "archived", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  return archived;
}

test("48: a trusted Dreamer revives an archived older identity through merge only", async () => {
  const f = fixture();
  const old = f.create("Object state before retirement");
  const archived = await archive(f, old, 1);
  const returned = f.create("Object state after return");
  const trigger = createDreamerTrigger(f.memory, f.path, f.fact, 2, "project");
  let revived!: { knowledgeId: number; commit: number };
  const result = await f.scenarios.run(f.memory, f.path, input => {
    const request = { fixture: "revive archived identity" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    for (const value of [archived, returned, trigger]) trace.execute({ address: f.tag(value), itemBudget: null });
    const operation = { op: "merge", id: f.tag(archived), absorb: [f.tag(returned)],
      text: "Object state after return", category: "constraint", scope: "project", supports: [], reason: "Object returned", topics: ["object"] };
    const receipt = JSON.parse(write.execute({ operations: [operation,
      { op: "archive", id: f.tag(trigger), supports: [], reason: "Retire revival trigger" }], skipped: [] }));
    expect(receipt.committed.find((value: { knowledgeId: number }) => value.knowledgeId === old.knowledgeId)).toMatchObject({ version: `K${old.knowledgeId}@v3` });
    revived = { knowledgeId: old.knowledgeId, commit: f.store.resolveVersionOrdinal(old.knowledgeId, 3) };
    return { outcome: "success", output: "revived", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(revived.knowledgeId).toBe(old.knowledgeId);
  expect(f.store.knowledgeRevision(revived.commit)?.parentId).toBe(archived.commit);
  expect(f.store.listKnowledgeLinks(returned.knowledgeId)).toContainEqual(expect.objectContaining({
    fromKnowledge: returned.knowledgeId, fromCommit: returned.commit, kind: "merged_into", toKnowledge: old.knowledgeId, toCommit: revived.commit,
  }));
  expect(f.store.currentKnowledge(f.path).filter(item => item.knowledge.id !== trigger.knowledgeId).map(item => [item.knowledge.id, item.revision.id]))
    .toEqual([[old.knowledgeId, revived.commit]]);
});

test("76: an archive base accepts a Dreamer revival through update as well as through merge", async () => {
  const f = fixture();
  const old = f.create("Old identity"), archived = await archive(f, old, 1), active = f.create("Returned identity");
  const trigger = createDreamerTrigger(f.memory, f.path, f.fact, 2, "project");
  const result = await f.scenarios.run(f.memory, f.path, input => {
    const request = { fixture: "archive accepts update revival" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    for (const value of [archived, active, trigger]) trace.execute({ address: f.tag(value), itemBudget: null });
    // 76: baseProblem's archived-base acceptance for a Dreamer revival now covers a plain update too,
    // not merge alone ("D reviews an archive... to revoke or adjust it, D updates the archived version").
    expect(write.execute({ operations: [{ op: "update", id: f.tag(archived),
      text: "Updated archive", category: "constraint", scope: "project", topics: ["object"], supports: [], reason: "Revive through update" }],
      skipped: [{ knowledge: f.history(active), because: "Not merged here." }] })).toContain('"committed"');
    expect(write.execute({ operations: [{ op: "archive", id: f.tag(trigger),
      supports: [], reason: "Retire revival trigger" }], skipped: [] })).toContain("committed");
    return { outcome: "success", output: "revived by update", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(f.store.currentCommit(old.knowledgeId, f.path)[0]?.text).toBe("Updated archive");
});

test("64b/48: a later invalid operation rolls revival, links and revisions back atomically", async () => {
  const f = fixture();
  const old = f.create("Old identity"), archived = await archive(f, old, 1), active = f.create("Returned identity");
  const trigger = createDreamerTrigger(f.memory, f.path, f.fact, 2, "project");
  const result = await f.scenarios.run(f.memory, f.path, input => {
    const request = { fixture: "atomic revival rollback" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    for (const value of [archived, active, trigger]) trace.execute({ address: f.tag(value), itemBudget: null });
    const before = { revisions: f.store.listKnowledgeRevisions(), links: f.store.listKnowledgeLinks(active.knowledgeId) };
    expect(write.execute({ operations: [
      { op: "merge", id: f.tag(archived), absorb: [f.tag(active)],
        text: "Revived identity", category: "constraint", scope: "project", topics: ["object"], supports: [], reason: "Revive identity" },
      { op: "update", id: f.tag(active), text: "Consumed base reused", category: "constraint",
        scope: "project", topics: ["object"], supports: [], reason: "Invalid consumed-base reuse" },
    ], skipped: [] })).toContain("rejected:");
    expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
    expect(f.store.listKnowledgeLinks(active.knowledgeId)).toEqual(before.links);
    expect(write.execute({ operations: [{ op: "archive", id: f.tag(trigger),
      supports: [], reason: "Retire rollback trigger" }], skipped: [] })).toContain("committed");
    return { outcome: "success", output: "rollback verified", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
});
