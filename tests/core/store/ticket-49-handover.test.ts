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

function certify(store: Store, path: TaskTarget, commit: number) {
  const range = store.retainDreamingRange(path, [commit]);
  const run = store.recordRun({ kind: "dreaming", sessionId: path.sessionId, branch: path.branch,
    dreamingRangeId: range.id, outcome: "success", createdAt: "now" });
  store.completeDreaming(run.id, [commit], [commit]);
}

const ready = (path: KnowledgePath) => ({ path, atTrigger: () => false });

test("49: undeclared hand-over revokes only current project certificates and preserves prior history", () => {
  const store = new Store(":memory:"); stores.push(store);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id, "undeclared"), reader = session(store, target.id);
  const first = create(store, author, "first"); certify(store, author.path, first.commit);
  const update = store.commitConsolidationRun({ path: author.path, run: { kind: "manual", sessionId: author.value.id, createdAt: "later" }, operations: [
    { op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, text: "second", category: "constraint", scope: "project",
      supports: [author.fact.id], topics: [], reason: "change", createdAt: "later" },
  ] });
  if (!update.ok) throw new Error(update.problems.join("; "));
  const second = update.committed[0]!; certify(store, author.path, second.commit);
  expect(store.isKnowledgeProcessed(first.commit)).toBe(true);
  expect(store.isKnowledgeProcessed(second.commit)).toBe(true);

  store.declareProject(author.value.id, target.name, "mark", ready(author.path));

  expect(store.isKnowledgeProcessed(first.commit)).toBe(true);
  expect(store.isKnowledgeProcessed(second.commit)).toBe(false);
  expect(store.listKnowledgeRevisions(first.knowledgeId).map(revision => revision.id)).toEqual([first.commit, second.commit]);
  expect(store.db.prepare("SELECT 1 FROM settled_knowledge_events WHERE event_id = ?").get(second.commit)).toBeUndefined();
  expect(store.pendingKnowledgeEvents(reader.path).map(event => event.id)).toContain(second.commit);
  expect(store.dreamingInput(reader.path).text).toContain("Changed:");
  expect(store.dreamingInput(reader.path).text).not.toContain("New:");
});

test("49: every certified project revision current on a stored sibling path is handed over", () => {
  const store = new Store(":memory:"); stores.push(store);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id, "undeclared");
  const first = create(store, author, "root"); certify(store, author.path, first.commit);
  const other = store.appendTurn({ sessionId: author.value.id, parentTurnId: author.turn.id, kind: "turn", userPrompt: "other sibling", startedAt: "later" });
  const sibling = store.appendTurn({ sessionId: author.value.id, parentTurnId: author.turn.id, kind: "turn", userPrompt: "sibling", startedAt: "later" });
  const siblingFact = store.commitNotingRun({ run: { kind: "manual", sessionId: author.value.id, createdAt: "later" }, facts: [
    { turnId: sibling.id, category: "decision", actor: "user", text: "sibling evidence", source: [`T${sibling.id}#user`], createdAt: "later" },
  ] });
  if (!siblingFact.ok) throw new Error(siblingFact.problems.join("; "));
  const siblingPath = { sessionId: author.value.id, branch: "sibling", headTurnId: sibling.id };
  const changed = store.commitConsolidationRun({ path: siblingPath, run: { kind: "manual", sessionId: author.value.id, createdAt: "later" }, operations: [
    { op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, text: "sibling current", category: "constraint", scope: "project",
      supports: [siblingFact.facts[0]!.id], topics: [], reason: "branch change", createdAt: "later" },
  ] });
  if (!changed.ok) throw new Error(changed.problems.join("; "));
  const second = changed.committed[0]!; certify(store, siblingPath, second.commit);
  const otherPath = { sessionId: author.value.id, branch: "other", headTurnId: other.id };
  expect(store.commitGraph(otherPath).current.map(revision => revision.id)).toEqual([first.commit]);
  expect(store.commitGraph(siblingPath).current.map(revision => revision.id)).toEqual([second.commit]);

  store.declareProject(author.value.id, target.name, "mark", ready(author.path));
  expect(store.isKnowledgeProcessed(first.commit)).toBe(false);
  expect(store.isKnowledgeProcessed(second.commit)).toBe(false);
  expect(store.pendingKnowledgeEvents(otherPath).map(event => event.id)).toContain(first.commit);
  expect(store.pendingKnowledgeEvents(siblingPath).map(event => event.id)).toContain(second.commit);
});

test("49: hand-over can cross the target cap, leaves its certified pool unchanged, and final certification still enforces the cap", () => {
  const store = new Store(":memory:"); stores.push(store);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id, "undeclared"), reader = session(store, target.id);
  const moved = create(store, author, "moved ".repeat(6000)); certify(store, author.path, moved.commit);
  const existing = create(store, reader, "existing ".repeat(6000)); certify(store, reader.path, existing.commit);
  const before = store.checkProcessedScopes([], reader.path).totals
    .find(total => total.scope === `project:${target.id}`)!.tokens;

  store.declareProject(author.value.id, target.name, "mark", ready(author.path));

  const after = store.checkProcessedScopes([], reader.path).totals
    .find(total => total.scope === `project:${target.id}`)!.tokens;
  expect(after).toBe(before);
  expect(store.isKnowledgeProcessed(moved.commit)).toBe(false);
  const changed = store.dreamingInput(reader.path).text;
  expect(changed).toContain("New:");
  expect(changed).not.toContain("Changed:");
  const range = store.retainDreamingRange(reader.path, [moved.commit]);
  const run = store.recordRun({ kind: "dreaming", sessionId: reader.value.id, branch: reader.path.branch,
    dreamingRangeId: range.id, outcome: "success", createdAt: "later" });
  expect(() => store.completeDreaming(run.id, [moved.commit], [moved.commit])).toThrow(/project:.*exceeds 10000/);
  expect(store.isKnowledgeProcessed(existing.commit)).toBe(true);
});

test("49: retained placement audits migrate to immutable revisions and survive hand-over", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-49-audit-")); dirs.push(dir);
  const file = join(dir, "trace.db");
  let store = new Store(file);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id, "undeclared"), moved = create(store, author, "knowledge");
  certify(store, author.path, moved.commit);
  store.db.prepare("INSERT INTO knowledge_placement_validations(commit_id,old_owner,new_owner,view_version,created_at) VALUES (?,?,?,?,?)")
    .run(moved.commit, `project:${implicit.id}`, `project:${implicit.id}`, "old", "then");
  store.close();

  const legacy = new DatabaseSync(file);
  legacy.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
  legacy.exec(`CREATE TABLE knowledge_placement_validations_old (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    commit_id INTEGER NOT NULL REFERENCES processed_knowledge_versions(commit_id),
    old_owner TEXT NOT NULL, new_owner TEXT NOT NULL, view_version TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO knowledge_placement_validations_old SELECT * FROM knowledge_placement_validations;
    DROP TABLE knowledge_placement_validations;
    ALTER TABLE knowledge_placement_validations_old RENAME TO knowledge_placement_validations;
    COMMIT; PRAGMA foreign_keys = ON;`);
  legacy.close();

  store = new Store(file); stores.push(store);
  expect(String((store.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'knowledge_placement_validations'").get() as { sql: string }).sql))
    .toContain("REFERENCES knowledge_revisions(id)");
  store.declareProject(author.value.id, target.name, "mark", ready(author.path));
  expect(store.db.prepare("SELECT commit_id,created_at FROM knowledge_placement_validations").all())
    .toEqual([{ commit_id: moved.commit, created_at: "then" }]);
  expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  store.close(); store = new Store(file); stores.push(store);
  expect(store.db.prepare("SELECT count(*) AS count FROM knowledge_placement_validations").get()!.count).toBe(1);
});

test("49: declaration failure after relabel rolls back membership, certificates, settlement, and audits", () => {
  const store = new Store(":memory:"); stores.push(store);
  const implicit = store.createProject({ name: "implicit", declaredBy: "mark" });
  const target = store.createProject({ name: "target", declaredBy: "mark" });
  const author = session(store, implicit.id, "undeclared"), moved = create(store, author, "knowledge");
  certify(store, author.path, moved.commit);
  store.db.prepare("INSERT INTO knowledge_placement_validations(commit_id,old_owner,new_owner,view_version,created_at) VALUES (?,?,?,?,?)")
    .run(moved.commit, "old", "old", "test", "before");
  store.db.exec(`CREATE TRIGGER fail_declaration BEFORE UPDATE OF project_declaration ON sessions
    WHEN NEW.id = ${author.value.id} BEGIN SELECT RAISE(ABORT, 'injected declaration failure'); END`);

  expect(() => store.declareProject(author.value.id, target.name, "mark", ready(author.path))).toThrow("injected declaration failure");
  expect(store.getSession(author.value.id)!.projectId).toBe(implicit.id);
  expect(store.getProject(implicit.id)!.mergedInto).toBeNull();
  expect(store.isKnowledgeProcessed(moved.commit)).toBe(true);
  expect(store.db.prepare("SELECT 1 FROM settled_knowledge_events WHERE event_id = ?").get(moved.commit)).toBeDefined();
  expect(store.db.prepare("SELECT count(*) AS count FROM knowledge_placement_validations").get()!.count).toBe(1);
});
