import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { TraceMemory, noVisibility } from "../../../src/core/api/index.ts";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";
import { tokens } from "../../../src/core/render/tokens.ts";

const roots: string[] = [];
const memories: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const offline = async () => { throw new Error("offline only"); };
function fixture(file = false) {
  let path = ":memory:";
  if (file) { const base = resolve(".scratch"); mkdirSync(base, { recursive: true }); const dir = mkdtempSync(join(base, "92-delivery-")); roots.push(dir); path = join(dir, "fixture.db"); }
  const memory = sourceSeededMemory(path, offline); memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "92", declaredBy: "mark" });
  const session = store.createSession({ host: "pi:92", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Evidence", startedAt: "now" });
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const note = memory.tools({ kind: "manual", ...target, currentTurnId: turn.id }).find(tool => tool.name === "note")!;
  const fact = JSON.parse(note.execute({ facts: [{ text: "User supplied evidence", source: [`T${turn.id}#E1`] }] })).factIds[0] as number;
  const content = { author: "fixture", category: "constraint" as const, scope: "project" as const, topics: [], supports: [fact], reason: "fixture", createdAt: "now" };
  const create = (text: string) => {
    const result = store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{ ...content, op: "create", handle: "$new", text }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  return { memory, store, project, session, turn, target, fact, content, create, path };
}

test("92 warm reader memo respects an older SQLite read snapshot across an external commit, then observes the new version at the same leaf", () => {
  const f = fixture(true), first = f.create("original");
  const external = TraceMemory(f.path, offline); memories.push(external);
  const offered = f.memory.injection(f.target);
  expect(offered.knowledgeCommitIds).toEqual([first.commit]);
  const retained = { ...noVisibility(), knowledgeCommitIds: new Set([first.commit]), knowledgeTokens: offered.knowledgeTokens };
  expect(f.memory.injection(f.target, retained).text).toBe(""); // warm 88 memo
  f.store.db.exec("BEGIN");
  const descriptor = f.store.db.prepare("SELECT MAX(id) n FROM knowledge_revisions").get()!.n;
  const changed = commitNoterKnowledge(external.store, { path: f.target, run: { sessionId: f.session.id, branch: "main", createdAt: "later" },
    operations: [{ ...f.content, op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, text: "new version" }] });
  if (!changed.ok) throw new Error(changed.problems.join("; "));
  expect(descriptor).toBe(first.commit);
  expect(f.memory.injection(f.target).knowledgeCommitIds).toEqual([first.commit]);
  expect(f.memory.injection(f.target, retained).text).toBe("");
  f.store.db.exec("COMMIT");
  const delta = f.memory.injection(f.target, retained);
  expect(delta.knowledgeCommitIds).toEqual([changed.committed[0]!.commit]);
  expect(delta.text).toContain("new version");
  expect(delta.text).toContain(`K${first.knowledgeId}@v1 is superseded by K${first.knowledgeId}@v2`);
  expect(delta.text).not.toMatch(/K\d+@\d+|is superseded by K\d+#/);
});

test("92 a globally current but reader-invisible successor hides the identity and cannot be named by old-state notices", () => {
  const f = fixture(), first = f.create("old project rule");
  const offered = f.memory.injection(f.target);
  const peer = f.store.createSession({ host: "pi:peer", projectId: f.project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = f.store.appendTurn({ sessionId: peer.id, kind: "turn", userPrompt: "Private rule", startedAt: "now" });
  const target = { sessionId: peer.id, branch: "main", headTurnId: turn.id };
  const note = f.memory.tools({ kind: "manual", ...target, currentTurnId: turn.id }).find(tool => tool.name === "note")!;
  const fact = JSON.parse(note.execute({ facts: [{ text: "Private evidence", source: [`T${turn.id}#E1`] }] })).factIds[0];
  const changed = commitNoterKnowledge(f.store, { path: target, run: { sessionId: peer.id, createdAt: "later" }, operations: [{ ...f.content,
    op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, text: "Secret successor", scope: "session", supports: [fact] }] });
  if (!changed.ok) throw new Error(changed.problems.join("; "));
  expect(f.memory.injection(f.target).knowledgeCommitIds).toEqual([]);
  const retained = { ...noVisibility(), knowledgeCommitIds: new Set([first.commit]), knowledgeTokens: offered.knowledgeTokens };
  const delta = f.memory.injection(f.target, retained);
  expect(delta.text).toBe(`Inherited knowledge status (these commits are not current authority):\nK${first.knowledgeId} no longer applies`);
  expect(delta.knowledgeStates).toEqual([{ fromCommit: first.commit, toCommits: [first.commit] }]);
  expect(delta.text).not.toContain("Secret"); expect(delta.text).not.toContain("@v2");
  expect(f.memory.injection(f.target, { ...retained, knowledgeStates: new Set([`${first.commit}>${first.commit}`]),
    knowledgeTokens: retained.knowledgeTokens! + delta.knowledgeTokens! }).text).toBe("");
  expect(f.memory.injection(target).knowledgeCommitIds).toEqual([changed.committed[0]!.commit]);
});

test("92 actual retained costs, including obsolete bodies and repeated carriers, govern exact-fit selection", () => {
  const f = fixture(), old = f.create("Retained original body"), next = f.create("New body");
  const offered = f.memory.injection(f.target, { ...noVisibility(), knowledgeCommitIds: new Set([old.commit]), knowledgeTokens: 0 });
  const cost = offered.knowledgeTokens!;
  expect(cost).toBe(tokens(offered.text));
  setKnowledgeCapacity(f.memory, 5000);
  const retained = { ...noVisibility(), knowledgeCommitIds: new Set([old.commit]), knowledgeTokens: 5000 - cost };
  const tag = vi.spyOn(f.store, "versionTag");
  try {
    expect(f.memory.injection(f.target, retained).knowledgeCommitIds).toEqual([next.commit]);
    expect(tag.mock.calls.some(([id]) => id === old.knowledgeId)).toBe(false); // retained text is not rendered again
  } finally { tag.mockRestore(); }
  expect(f.memory.injection(f.target, { ...retained, knowledgeTokens: retained.knowledgeTokens + 1 }).text).toBe("");
  // IDs grant membership, not a refund for text which remains in context.
  expect(f.memory.injection(f.target, { ...retained, knowledgeTokens: 5000 }).text).toBe("");
  expect(f.memory.injection(f.target, { ...retained, knowledgeCommitIds: new Set([old.commit, next.commit]) }).text).toBe("");
});

test("92 unchanged foreground checks reuse 88 reader projection and do not read Raw or build a fresh path snapshot", () => {
  const f = fixture();
  for (let n = 0; n < 20; n++) f.create(`Rule ${n}`);
  const first = f.memory.injection(f.target);
  const view = { ...noVisibility(), knowledgeCommitIds: new Set(first.knowledgeCommitIds), knowledgeTokens: first.knowledgeTokens };
  const path = vi.spyOn(f.store, "pathSnapshot"), prepare = vi.spyOn(f.store.db, "prepare");
  try {
    for (let n = 0; n < 20; n++) expect(f.memory.injection(f.target, view).text).toBe("");
    expect(path).not.toHaveBeenCalled();
    expect(prepare.mock.calls.some(([sql]) => /source_entry_raw/.test(String(sql)))).toBe(false);
  } finally { path.mockRestore(); prepare.mockRestore(); }
});
