import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type KnowledgeOperationInput, type KnowledgePath, type TaskTarget } from "../../../src/core/store/index.ts";

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(store: Store, projectId: number, declaration: "undeclared" | "mark" = "mark") {
  const value = store.createSession({ host: `test-${Math.random()}`, projectId, projectDeclaration: declaration,
    enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: value.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: value.id, createdAt: "now" }, facts: [
    { turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: "now" },
  ] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  return { value, turn, fact: noted.facts[0]!, path: { sessionId: value.id, branch: "main", headTurnId: turn.id } };
}

function create(store: Store, owner: ReturnType<typeof session>, text: string, scope: "project" | "global" | "session" = "project") {
  const operation: KnowledgeOperationInput = { op: "create", handle: "$1", author: "test", text, category: "constraint", scope,
    supports: [owner.fact.id], topics: [], reason: "test", createdAt: "now" };
  const result = store.commitConsolidationRun({ path: owner.path, run: { kind: "manual", sessionId: owner.value.id, createdAt: "now" },
    operations: [operation], consolidated: [owner.fact.id] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

function processPool(store: Store, path: TaskTarget, pool: string) {
  const claim = store.acquireClaim(path, "dreaming", `processor-${Math.random()}`);
  if (!claim) throw new Error("Dreamer claim unavailable");
  try {
    const range = store.retainKnowledgePoolRange(path, pool, claim);
    const executionId = store.beginExecution({ sessionId: path.sessionId, phase: "dreaming", head: range.anchor, origin: range.origin });
    const run = store.bindDreamingRun({ kind: "dreaming", sessionId: path.sessionId, branch: path.branch,
      dreamingRangeId: range.id, executionId, claim, createdAt: "now" });
    store.completeKnowledgePoolRange(run, "success");
  } finally { store.releaseClaim(claim); }
}

const ready = (path: KnowledgePath) => ({ path, atTrigger: () => false });

test("64c hand-over keeps source processing history and makes current project versions pending in the destination", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-64c-handover-")); dirs.push(dir);
  const file = join(dir, "trace.db");
  let store = new Store(file); stores.push(store);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id, "undeclared"), reader = session(store, target.id);
  const first = create(store, author, "first"), second = create(store, author, "second");
  const sourcePool = `project:${implicit.id}`, targetPool = `project:${target.id}`;
  processPool(store, author.path, sourcePool);
  const counts = Object.fromEntries(["facts", "knowledge", "knowledge_revisions"].map(table =>
    [table, store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count]));

  store.declareProject(author.value.id, target.name, "mark", ready(author.path));

  expect(store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id").all(sourcePool)
    .map(row => Number(row.revision_id))).toEqual([first.commit, second.commit]);
  expect(store.pendingVersions(targetPool, reader.path).map(value => value.revisionId)).toEqual([first.commit, second.commit]);
  expect(Object.fromEntries(["facts", "knowledge", "knowledge_revisions"].map(table =>
    [table, store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count]))).toEqual(counts);

  store.close(); stores.splice(stores.indexOf(store), 1);
  store = new Store(file); stores.push(store);
  expect(store.pendingVersions(targetPool, reader.path).map(value => value.revisionId)).toEqual([first.commit, second.commit]);
  processPool(store, reader.path, targetPool);
  expect(store.pendingVersions(targetPool, reader.path)).toEqual([]);
});

test("64c project processing is keyed by destination pool and revision across a round trip", () => {
  const store = new Store(":memory:"); stores.push(store);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id), reader = session(store, target.id);
  const item = create(store, author, "current project version");
  const sourcePool = `project:${implicit.id}`, targetPool = `project:${target.id}`;
  processPool(store, author.path, sourcePool);

  store.declareProject(author.value.id, target.name, "mark", ready(author.path));
  expect(store.pendingVersions(targetPool, reader.path).map(value => value.revisionId)).toEqual([item.commit]);
  processPool(store, reader.path, targetPool);
  expect(store.pendingVersions(targetPool, reader.path)).toEqual([]);

  store.declareProject(author.value.id, implicit.name, "mark", ready(author.path));
  expect(store.pendingVersions(sourcePool, author.path)).toEqual([]);
  expect(store.db.prepare("SELECT pool, revision_id FROM knowledge_processed WHERE revision_id = ? ORDER BY pool").all(item.commit)).toEqual([
    { pool: sourcePool, revision_id: item.commit }, { pool: targetPool, revision_id: item.commit },
  ]);
  expect(store.listKnowledgeRevisions(item.knowledgeId).map(revision => revision.id)).toEqual([item.commit]);
});

test("64c hand-over may cross the target budget; budget triggers but never blocks destination processing", () => {
  const store = new Store(":memory:"); stores.push(store);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id, "undeclared"), reader = session(store, target.id);
  const words = Math.ceil(store.knowledgeBudgets().project * 0.6);
  const moved = create(store, author, "moved ".repeat(words));
  const existing = create(store, reader, "existing ".repeat(words));
  const sourcePool = `project:${implicit.id}`, targetPool = `project:${target.id}`;
  processPool(store, author.path, sourcePool);
  processPool(store, reader.path, targetPool);
  const before = store.poolSizes(reader.path).find(total => total.pool === targetPool)!.tokens;

  store.declareProject(author.value.id, target.name, "mark", ready(author.path));

  const after = store.poolSizes(reader.path).find(total => total.pool === targetPool)!;
  expect(after.tokens).toBeGreaterThan(before);
  expect(after.tokens).toBeGreaterThan(after.budget);
  expect(store.pendingVersions(targetPool, reader.path).map(value => value.revisionId)).toEqual([moved.commit]);
  expect(store.duePools(reader.path).map(value => value.pool)).toContain(targetPool);
  expect(() => processPool(store, reader.path, targetPool)).not.toThrow();
  expect(store.pendingVersions(targetPool, reader.path)).toEqual([]);
  expect(store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id").all(targetPool)
    .map(row => Number(row.revision_id))).toEqual([moved.commit, existing.commit].sort((a, b) => a - b));
});
