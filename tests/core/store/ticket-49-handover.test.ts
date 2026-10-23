import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitNoterKnowledge, historicalConsolidation } from "../../noting-knowledge-fixture.ts";
import { Store, type KnowledgeOperationInput, type KnowledgePath } from "../../../src/core/store/index.ts";
import { entry, legacyFacts } from "../../support/seed.ts";
import { coverKnowledge } from "../../support/dreamer.ts";

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function session(store: Store, projectId: number, declaration: "undeclared" | "mark" = "mark") {
  const value = store.createSession({ host: `test-${Math.random()}`, projectId, projectDeclaration: declaration,
    enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: value.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const source = entry(store, value.id, turn.id, `user-${turn.id}`, "user", "evidence");
  const noted = legacyFacts(store, { kind: "manual", sessionId: value.id, branch: "main", createdAt: "now" }, [
    { sources: [{ entry: source, address: `T${turn.id}#user` }], category: "decision", actor: "user", text: "evidence", createdAt: "now" },
  ]);
  return { value, turn, fact: noted.facts[0]!, path: { sessionId: value.id, branch: "main", headTurnId: turn.id } };
}

function create(store: Store, owner: ReturnType<typeof session>, text: string, scope: "project" | "global" | "session" = "project") {
  const operation: KnowledgeOperationInput = { files: null, op: "create", title: "Fixture title", handle: "$1", author: "test", text, category: "constraint", scope,
    supports: [owner.fact.id], topics: [], reason: "test", createdAt: "now" };
  const result = store.commitConsolidationRun({ path: owner.path, run: { kind: "manual", sessionId: owner.value.id, createdAt: "now" },
    operations: [operation] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  historicalConsolidation(store, owner.value.id, [owner.fact.id]);
  return result.committed[0]!;
}

/** A passed curate over the session's pools (stage 4 §2.1): every live item of the session's three pools becomes covered. */
function processPool(store: Store, path: KnowledgePath) {
  coverKnowledge(store, path, store.curateItems(path).map(item => item.value.revision.id));
}
/** The live versions of one of the session's pools that no curate has covered, oldest first: what a project move must leave uncovered. */
const uncovered = (store: Store, path: KnowledgePath, pool: string) =>
  store.curateItems(path).filter(item => item.pool === pool && !item.covered).map(item => item.value.revision.id);

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
  processPool(store, author.path);
  const counts = Object.fromEntries(["facts", "knowledge", "knowledge_revisions"].map(table =>
    [table, store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count]));

  store.declareProject(author.value.id, target.name, "mark", ready(author.path));

  expect(store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id").all(sourcePool)
    .map(row => Number(row.revision_id))).toEqual([first.commit, second.commit]);
  expect(uncovered(store, reader.path, targetPool)).toEqual([first.commit, second.commit]);
  expect(Object.fromEntries(["facts", "knowledge", "knowledge_revisions"].map(table =>
    [table, store.db.prepare(`SELECT count(*) AS count FROM ${table}`).get()!.count]))).toEqual(counts);

  store.close(); stores.splice(stores.indexOf(store), 1);
  store = new Store(file); stores.push(store);
  expect(uncovered(store, reader.path, targetPool)).toEqual([first.commit, second.commit]);
  processPool(store, reader.path);
  expect(uncovered(store, reader.path, targetPool)).toEqual([]);
});

test("86 moved project versions become pending again on a round trip, without clearing other pools", () => {
  const store = new Store(":memory:"); stores.push(store);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id), reader = session(store, target.id);
  const item = create(store, author, "current project version");
  const sourcePool = `project:${implicit.id}`, targetPool = `project:${target.id}`;
  processPool(store, author.path);

  store.declareProject(author.value.id, target.name, "mark", ready(author.path));
  expect(uncovered(store, reader.path, targetPool)).toEqual([item.commit]);
  processPool(store, reader.path);
  expect(uncovered(store, reader.path, targetPool)).toEqual([]);

  store.declareProject(author.value.id, implicit.name, "mark", ready(author.path));
  expect(uncovered(store, author.path, sourcePool)).toEqual([item.commit]);
  expect(store.db.prepare("SELECT pool, revision_id FROM knowledge_processed WHERE revision_id = ? ORDER BY pool").all(item.commit)).toEqual([
    { pool: targetPool, revision_id: item.commit },
  ]);
  expect(store.listKnowledgeRevisions(item.knowledgeId).map(revision => revision.id)).toEqual([item.commit]);
});

test("86: moving only the initiating session unprocesses only its project versions, not destination, global or session versions", () => {
  const store = new Store(":memory:"); stores.push(store);
  const source = store.createProject({ name: "source", declaredBy: "mark" });
  const target = store.createProject({ name: "destination", declaredBy: "mark" });
  const moving = session(store, source.id), other = session(store, source.id), reader = session(store, target.id);
  const moved = create(store, moving, "moved project");
  const stationary = create(store, other, "stationary project");
  const targetItem = create(store, reader, "destination project");
  const global = create(store, moving, "global unchanged", "global");
  const local = create(store, moving, "session unchanged", "session");
  const from = `project:${source.id}`, into = `project:${target.id}`;
  processPool(store, moving.path); // 126: one run processes the source project, global and session pools
  processPool(store, reader.path);
  store.declareProject(moving.value.id, target.name, "mark", ready(moving.path));
  expect(uncovered(store, reader.path, into)).toContain(moved.commit);
  expect(uncovered(store, reader.path, into)).not.toContain(targetItem.commit);
  expect(uncovered(store, other.path, from)).not.toContain(stationary.commit);
  expect(uncovered(store, moving.path, "global")).not.toContain(global.commit);
  expect(uncovered(store, moving.path, `session:${moving.value.id}`)).not.toContain(local.commit);
});

test("86: moved current revision becomes uncovered and counts as a Noter change, while another writer's covered ancestor stays covered", () => {
  const store = new Store(":memory:"); stores.push(store);
  const target = store.createProject({ name: "mixed-target", declaredBy: "mark" });
  const source = store.createProject({ name: "mixed-source", declaredBy: "mark" });
  const author = session(store, target.id), moving = session(store, target.id);
  const original = create(store, author, "first author original text");
  const pool = `project:${target.id}`;
  processPool(store, author.path);
  const revised = commitNoterKnowledge(store, { path: moving.path, run: { sessionId: moving.value.id, branch: "main", createdAt: "now" }, operations: [
    { files: null, op: "update", knowledgeId: original.knowledgeId, baseCommit: original.commit, text: "second author revised text",
      category: "constraint", scope: "project", supports: [moving.fact.id], topics: [], reason: "new evidence", createdAt: "now" },
  ] });
  if (!revised.ok) throw Error(revised.problems.join("; "));
  const current = revised.committed[0]!;
  processPool(store, moving.path);
  store.declareProject(moving.value.id, source.name, "mark", ready(moving.path));
  store.declareProject(moving.value.id, target.name, "mark", ready(moving.path));
  expect(store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id").all(pool)
    .map(row => Number(row.revision_id))).toEqual([original.commit]);
  expect(uncovered(store, author.path, pool)).toEqual([current.commit]);
  // The moved current version is the Noter's, so it counts toward the next Dreamer run; the original stays covered and does not.
  expect(store.noterOperations(author.path)).toBe(1);
});

// 64c/126, spec 2.1: coverage records the pool a version had when the run's input was frozen, so a version that a sibling's
// declaration moves to another pool mid-run is not covered in its new pool and counts there again.
test("126: a frozen version that a sibling's declaration moves out of the run's pools mid-run stays uncovered in its new pool", () => {
  const store = new Store(":memory:"); stores.push(store);
  const source = store.createProject({ name: "shared-source", declaredBy: "mark" });
  const target = store.createProject({ name: "moved-target", declaredBy: "mark" });
  const runner = session(store, source.id), mover = session(store, source.id);
  const moved = create(store, mover, "item written by the session that moves");
  const shown = store.curateItems(runner.path).map(item => ({ id: item.value.revision.id, pool: item.pool }));
  expect(shown).toEqual([{ id: moved.commit, pool: `project:${source.id}` }]);
  store.declareProject(mover.value.id, target.name, "mark", ready(mover.path));
  const claim = store.acquireClaim(runner.path, "dreaming", "runner")!;
  store.commitTaskPass({ run: { kind: "dreaming", sessionId: runner.value.id, branch: "main", createdAt: "now", claim, projectId: source.id }, path: runner.path,
    cover: () => shown, handoff: () => null });
  expect(store.db.prepare("SELECT pool FROM knowledge_processed WHERE revision_id = ?").all(moved.commit).map(row => row.pool)).toEqual([`project:${source.id}`]);
  expect(uncovered(store, mover.path, `project:${target.id}`)).toEqual([moved.commit]);
});
