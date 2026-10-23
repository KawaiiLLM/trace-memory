import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { curateNow } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

function fixture() {
  const memory = TraceMemory(":memory:", async () => { throw new Error("unexpected non-Dreamer phase"); }); memories.push(memory);
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
      operations: [{ files: null, op: "create", title: "Fixture title", handle: `$${text}`, author: "test", ...content(text) }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const tag = (item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}#${store.versionTag(item.knowledgeId, item.commit)}`;
  const history = (item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, item.commit)}`;
  return { memory, store, project, session, root, entry, path, fact, content, create, tag, history };
}

function archive(f: ReturnType<typeof fixture>, item: { knowledgeId: number; commit: number }) {
  const result = curateNow(f.memory, f.path, block(`archive ${f.history(item)}`, { kind: "invalid", reason: "Object ended" }, "The object ended and nothing replaces it; the user said so."));
  expect(result.blocks[0]).toMatchObject({ status: "applied", versions: [`K${item.knowledgeId}@v2`] });
  return { knowledgeId: item.knowledgeId, commit: f.store.resolveVersionOrdinal(item.knowledgeId, 2) };
}

test("48: a trusted Dreamer revives an archived older identity through merge only", () => {
  const f = fixture();
  const old = f.create("Object state before retirement");
  const archived = archive(f, old);
  const returned = f.create("Object state after return");
  const result = curateNow(f.memory, f.path, block(`merge ${f.history(archived)}`, { absorb: f.history(returned), reason: "Object returned", topics: "object" }, "Object state after return"));
  expect(result.blocks[0]).toMatchObject({ status: "applied", versions: [`K${old.knowledgeId}@v3`] });
  const revived = { knowledgeId: old.knowledgeId, commit: f.store.resolveVersionOrdinal(old.knowledgeId, 3) };
  expect(f.store.knowledgeRevision(revived.commit)?.parentId).toBe(archived.commit);
  expect(f.store.listKnowledgeLinks(returned.knowledgeId)).toContainEqual(expect.objectContaining({
    fromKnowledge: returned.knowledgeId, fromCommit: returned.commit, kind: "merged_into", toKnowledge: old.knowledgeId, toCommit: revived.commit,
  }));
  expect(f.store.currentKnowledge(f.path).map(item => [item.knowledge.id, item.revision.id])).toEqual([[old.knowledgeId, revived.commit]]);
});

test("76: an archive base accepts a Dreamer revival through update as well as through merge", () => {
  const f = fixture();
  const old = f.create("Old identity"), archived = archive(f, old);
  f.create("Returned identity");
  // 76: baseProblem's archived-base acceptance for a Dreamer revival covers a plain update too, not merge alone.
  const result = curateNow(f.memory, f.path, block(`update ${f.history(archived)}`, { reason: "Revive through update", topics: "object" }, "Updated archive"));
  expect(result.blocks[0]).toMatchObject({ status: "applied" });
  expect(f.store.currentCommit(old.knowledgeId, f.path)[0]?.text).toBe("Updated archive");
});
