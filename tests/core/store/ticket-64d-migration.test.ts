import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { Store } from "../../../src/core/store/index.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function legacyFixture(extension = false, splitInvisible = false) {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-64d-")); dirs.push(dir);
  const path = join(dir, "trace.db");
  const store = new Store(path);
  const project = store.createProject({ name: "P", declaredBy: "mark" });
  const session = store.createSession({ host: "pi", enrollmentChoice: true, projectId: project.id,
    projectDeclaration: "mark", startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "e", startedAt: "now" });
  const noting = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "e", source: [`T${turn.id}#user`], createdAt: "now",
  }] });
  if (!noting.ok) throw new Error(noting.problems.join("; "));
  const created = store.commitConsolidationRun({ path: { sessionId: session.id, branch: "main", headTurnId: turn.id },
    run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" }, operations: [{
      op: "create", handle: "$1", author: "test", text: "root", category: "constraint", scope: "global",
      supports: [noting.facts[0]!.id], topics: [], reason: "root", createdAt: "now",
    }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const root = created.committed[0]!, rootRevision = store.knowledgeRevision(root.commit)!;
  let splitFacts: number[] = [];
  if (splitInvisible) {
    const left = store.appendTurn({ sessionId: session.id, parentTurnId: turn.id, kind: "turn", userPrompt: "left", startedAt: "left" });
    const right = store.appendTurn({ sessionId: session.id, parentTurnId: turn.id, kind: "turn", userPrompt: "right", startedAt: "right" });
    const leftEntry = store.appendSourceEntry({ sessionId: session.id, turnId: left.id, nativeLineage: "left", nativeId: "left", role: "user", text: "left", raw: "left", calls: [] });
    const rightEntry = store.appendSourceEntry({ sessionId: session.id, turnId: right.id, nativeLineage: "right", nativeId: "right", role: "user", text: "right", raw: "right", calls: [] });
    store.selectSourcePath(session.id, "left", [leftEntry.id]); store.selectSourcePath(session.id, "right", [rightEntry.id]);
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "split" }, facts: [
      { turnId: left.id, category: "decision", actor: "user", text: "left", source: [`T${left.id}#user`], entryIds: [leftEntry.id], createdAt: "left" },
      { turnId: right.id, category: "decision", actor: "user", text: "right", source: [`T${right.id}#user`], entryIds: [rightEntry.id], createdAt: "right" },
    ] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    splitFacts = noted.facts.map(fact => fact.id);
    store.setCurrentPath(session.id, "left", left.id, "left"); store.setCurrentPath(session.id, "right", right.id, "right");
  }
  store.close();

  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys=ON");
  const child = Number(db.prepare(`INSERT INTO knowledge_revisions
    (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    VALUES (?,?,?,?,?,'[]','change','update','legacy child','[]',?,?,'dreaming')`)
    .run(root.knowledgeId, root.commit, "child", "constraint", "global", rootRevision.runId, "later").lastInsertRowid);
  const emptyKnowledge = Number(db.prepare("INSERT INTO knowledge(origin_session_id,project_id,author) VALUES (?,?,?)")
    .run(session.id, project.id, "legacy").lastInsertRowid);
  const emptyRoot = Number(db.prepare(`INSERT INTO knowledge_revisions
    (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    VALUES (?,NULL,'empty root','open','global','[]','change','create','legacy empty','[]',?,'later','consolidation')`)
    .run(emptyKnowledge, rootRevision.runId).lastInsertRowid);
  let splitInvisibleRevision: number | undefined, leftVisibleRevision: number | undefined;
  if (splitInvisible) {
    const identity = Number(db.prepare("INSERT INTO knowledge(origin_session_id,project_id,author) VALUES (?,?,?)")
      .run(session.id, project.id, "legacy").lastInsertRowid);
    splitInvisibleRevision = Number(db.prepare(`INSERT INTO knowledge_revisions
      (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
      VALUES (?,NULL,'cross cursor','constraint','session',?,'change','create','legacy','[]',?,'later','consolidation')`)
      .run(identity, JSON.stringify(splitFacts), rootRevision.runId).lastInsertRowid);
    const leftIdentity = Number(db.prepare("INSERT INTO knowledge(origin_session_id,project_id,author) VALUES (?,?,?)")
      .run(session.id, project.id, "legacy").lastInsertRowid);
    leftVisibleRevision = Number(db.prepare(`INSERT INTO knowledge_revisions
      (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
      VALUES (?,NULL,'left only','constraint','session',?,'change','create','legacy','[]',?,'later','consolidation')`)
      .run(leftIdentity, JSON.stringify([splitFacts[0]]), rootRevision.runId).lastInsertRowid);
  }
  db.exec(`
    CREATE TABLE dreaming_completions(run_id INTEGER PRIMARY KEY REFERENCES runs(id), event_ids TEXT NOT NULL, result_ids TEXT NOT NULL);
    CREATE TABLE processed_knowledge_versions(commit_id INTEGER PRIMARY KEY REFERENCES knowledge_revisions(id), run_id INTEGER NOT NULL REFERENCES dreaming_completions(run_id));
    CREATE TABLE settled_knowledge_events(event_id INTEGER PRIMARY KEY REFERENCES knowledge_revisions(id), run_id INTEGER NOT NULL REFERENCES dreaming_completions(run_id));
    CREATE TABLE dreaming_range_versions(range_id INTEGER NOT NULL REFERENCES dreaming_ranges(id), commit_id INTEGER NOT NULL REFERENCES knowledge_revisions(id), PRIMARY KEY(range_id,commit_id));
    CREATE TABLE knowledge_weights(commit_id INTEGER NOT NULL REFERENCES knowledge_revisions(id), view_version TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY(commit_id,view_version));
    CREATE TABLE knowledge_marks(knowledge_id INTEGER, commit_id INTEGER);
    CREATE TABLE knowledge_placement_validations(id INTEGER PRIMARY KEY);
    CREATE TABLE dreaming_family(id INTEGER PRIMARY KEY, range_id INTEGER REFERENCES dreaming_ranges(id));
  `);
  db.prepare("INSERT INTO dreaming_completions VALUES (?, '[]', ?)").run(rootRevision.runId, JSON.stringify([child]));
  db.prepare("INSERT INTO processed_knowledge_versions VALUES (?, ?)").run(child, rootRevision.runId);
  if (splitInvisibleRevision !== undefined) db.prepare("INSERT INTO processed_knowledge_versions VALUES (?, ?)").run(splitInvisibleRevision, rootRevision.runId);
  if (leftVisibleRevision !== undefined) db.prepare("INSERT INTO processed_knowledge_versions VALUES (?, ?)").run(leftVisibleRevision, rootRevision.runId);
  db.prepare("UPDATE knowledge_budget_policy SET global_tokens=4000,project_tokens=10000,session_tokens=1000 WHERE id=1").run();
  if (extension) db.exec("CREATE TABLE extension_mark(id INTEGER PRIMARY KEY, mark_id INTEGER REFERENCES knowledge_marks(commit_id))");
  db.close();
  return { path, child, emptyRoot, splitInvisibleRevision, leftVisibleRevision, runId: rootRevision.runId! };
}

const retired = ["processed_knowledge_versions", "settled_knowledge_events", "dreaming_completions",
  "dreaming_range_versions", "dreaming_family", "knowledge_placement_validations", "knowledge_marks", "knowledge_weights"];

test("64d migrates legacy supports, old defaults and real current processing provenance once", () => {
  const fixture = legacyFixture();
  const store = new Store(fixture.path);
  expect(store.knowledgeRevision(fixture.child)?.supports).toHaveLength(1);
  expect(store.knowledgeRevision(fixture.emptyRoot)?.supports).toEqual([]);
  expect(store.knowledgeBudgets()).toMatchObject({ global: 4000, project: 15000, session: 1000 });
  expect(store.db.prepare("SELECT * FROM knowledge_processed WHERE revision_id=?").get(fixture.child))
    .toMatchObject({ pool: "global", revision_id: fixture.child, run_id: fixture.runId });
  expect(store.migration64d).toMatchObject({ budgetSource: "old-default", budgetWasCustom: false });
  expect(store.migration64d.backfilledRevisionIds).toEqual([fixture.child]);
  expect(store.migration64d.remainingEmptyRevisionIds).toContain(fixture.emptyRoot);
  expect(store.migration64d.seeded).toEqual({ global: 1, project: 0, session: 0 });
  for (const table of retired) expect(store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)).toBeUndefined();
  store.close();

  const reopened = new Store(fixture.path);
  expect(reopened.migration64d).toMatchObject({ legacySchema: false, budgetSource: "current", budgetWasCustom: false });
  expect(reopened.migration64d.backfilledRevisionIds).toEqual([]);
  expect(reopened.migration64d.seeded).toEqual({ global: 0, project: 0, session: 0 });
  expect(reopened.db.prepare("SELECT count(*) n FROM knowledge_processed").get()!.n).toBe(1);
  reopened.close();
});

test("64d backfills nested archive, multi-parent merge, split, and empty ancestry in id order", () => {
  const fixture = legacyFixture();
  const db = new DatabaseSync(fixture.path);
  const root = db.prepare("SELECT id,knowledge_id,supports,run_id FROM knowledge_revisions WHERE parent_id IS NULL AND supports <> '[]' ORDER BY id LIMIT 1").get() as
    { id: number; knowledge_id: number; supports: string; run_id: number };
  const makeRoot = (text: string) => {
    const k = Number(db.prepare("INSERT INTO knowledge(origin_session_id,project_id,author) SELECT origin_session_id,project_id,author FROM knowledge WHERE id=?")
      .run(root.knowledge_id).lastInsertRowid);
    return Number(db.prepare(`INSERT INTO knowledge_revisions
      (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
      VALUES (?,NULL,?,'constraint','global',?,'change','create','root','[]',?,'root','consolidation')`)
      .run(k, text, root.supports, root.run_id).lastInsertRowid);
  };
  const second = makeRoot("second"), third = makeRoot("third");
  const merge = Number(db.prepare(`INSERT INTO knowledge_revisions
    (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    VALUES (?,?,?,'constraint','global','[]','change','merge','merge','[]',?,'merge','dreaming')`)
    .run(root.knowledge_id, root.id, "merged", root.run_id).lastInsertRowid);
  for (const parent of [second, third]) {
    const knowledgeId = Number(db.prepare("SELECT knowledge_id FROM knowledge_revisions WHERE id=?").get(parent)!.knowledge_id);
    db.prepare("INSERT INTO knowledge_links VALUES (?,?,'merged_into',?,?)").run(knowledgeId, parent, root.knowledge_id, merge);
  }
  const splitKnowledge = Number(db.prepare("INSERT INTO knowledge(origin_session_id,project_id,author) SELECT origin_session_id,project_id,author FROM knowledge WHERE id=?")
    .run(root.knowledge_id).lastInsertRowid);
  const split = Number(db.prepare(`INSERT INTO knowledge_revisions
    (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    VALUES (?,?,?,'constraint','global','[]','change','split','split','[]',?,'split','dreaming')`)
    .run(splitKnowledge, merge, "split", root.run_id).lastInsertRowid);
  db.prepare("INSERT INTO knowledge_links VALUES (?,?, 'split_from',?,?)").run(root.knowledge_id, merge, splitKnowledge, split);
  const archive = Number(db.prepare(`INSERT INTO knowledge_revisions
    (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    VALUES (?,?,?,'constraint','global','[]','change','archive','archive','[]',?,'archive','dreaming')`)
    .run(splitKnowledge, split, "", root.run_id).lastInsertRowid);
  const emptyChild = Number(db.prepare(`INSERT INTO knowledge_revisions
    (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    SELECT knowledge_id,id,'empty child',category,scope,'[]','change','update','empty child',topics,run_id,'empty child','dreaming'
    FROM knowledge_revisions WHERE id=?`).run(fixture.emptyRoot).lastInsertRowid);
  db.close();

  const store = new Store(fixture.path);
  const expected = JSON.parse(root.supports);
  for (const id of [merge, split, archive]) expect(store.knowledgeRevision(id)?.supports).toEqual(expected);
  expect(store.knowledgeRevision(emptyChild)?.supports).toEqual([]);
  expect(store.migration64d.remainingEmptyRevisionIds).toEqual(expect.arrayContaining([fixture.emptyRoot, emptyChild]));
  store.close();
});

test("64d rejects malformed merge ancestry and rolls back backfill and policy together", () => {
  const fixture = legacyFixture();
  const db = new DatabaseSync(fixture.path);
  const root = db.prepare("SELECT knowledge_id,id,category,scope,run_id FROM knowledge_revisions WHERE id=?").get(fixture.child)! as
    { knowledge_id: number; id: number; category: string; scope: string; run_id: number };
  db.prepare(`INSERT INTO knowledge_revisions
    (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    VALUES (?,?,?, ?,?,'[]','change','merge','bad merge','[]',?,'bad','dreaming')`)
    .run(root.knowledge_id, root.id, "bad", root.category, root.scope, root.run_id);
  db.close();
  expect(() => new Store(fixture.path)).toThrow(/merge has no absorbed-parent link/);
  const unchanged = new DatabaseSync(fixture.path, { readOnly: true });
  expect(unchanged.prepare("SELECT supports FROM knowledge_revisions WHERE id=?").get(fixture.child)!.supports).toBe("[]");
  expect(unchanged.prepare("SELECT project_tokens FROM knowledge_budget_policy WHERE id=1").get()!.project_tokens).toBe(10000);
  unchanged.close();
});

test("64d seeds and dry-run measures exact active lineage cursors without pooling siblings", () => {
  const fixture = legacyFixture(false, true);
  const store = new Store(fixture.path);
  expect(fixture.splitInvisibleRevision).toBeTypeOf("number");
  expect(store.db.prepare("SELECT 1 FROM knowledge_processed WHERE revision_id=?").get(fixture.splitInvisibleRevision!)).toBeUndefined();
  expect(store.db.prepare("SELECT 1 FROM knowledge_processed WHERE revision_id=?").get(fixture.leftVisibleRevision!)).toBeDefined();
  expect(store.migration64d.seeded).toEqual({ global: 0, project: 0, session: 1 });
  store.close();

  const output = execFileSync(process.execPath, ["scripts/dry-run-64d-migration.ts", fixture.path],
    { cwd: join(import.meta.dirname, "../../.."), encoding: "utf8" });
  const report = JSON.parse(output) as { measurements: { lineage: string | null; mode: string;
    pools: { pool: string; current: number }[] }[] };
  const left = report.measurements.find(value => value.lineage === "left")!;
  const right = report.measurements.find(value => value.lineage === "right")!;
  expect(left.mode).toBe("cursor"); expect(right.mode).toBe("cursor");
  expect(left.pools.find(pool => pool.pool.startsWith("session:"))?.current).toBe(1);
  expect(right.pools.find(pool => pool.pool.startsWith("session:"))?.current).toBe(0);
});

test("64d rebuilds a real pre-64c range, preserves links, and closes unfinished audit without a run", () => {
  const fixture = legacyFixture();
  const db = new DatabaseSync(fixture.path);
  db.exec(`PRAGMA foreign_keys=OFF; DROP INDEX idx_dreaming_open_range;
    CREATE TABLE dreaming_ranges_old (
      id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL,
      head_turn_id INTEGER NOT NULL REFERENCES turns(id), anchor INTEGER NOT NULL REFERENCES knowledge_revisions(id),
      completed_run INTEGER REFERENCES runs(id), origin_session_id INTEGER REFERENCES sessions(id), origin_entry_ids TEXT
    );
    DROP TABLE dreaming_ranges; ALTER TABLE dreaming_ranges_old RENAME TO dreaming_ranges;
    CREATE UNIQUE INDEX idx_dreaming_open_range ON dreaming_ranges(session_id,branch) WHERE completed_run IS NULL;
    PRAGMA foreign_keys=ON;`);
  const owner = db.prepare("SELECT t.session_id, f.turn_id FROM facts f JOIN turns t ON t.id=f.turn_id ORDER BY f.id LIMIT 1").get() as { session_id: number; turn_id: number };
  const rangeId = Number(db.prepare(`INSERT INTO dreaming_ranges(session_id,branch,head_turn_id,anchor,completed_run,origin_session_id,origin_entry_ids)
    VALUES (?,'main',?,?,NULL,NULL,NULL)`).run(owner.session_id, owner.turn_id, fixture.child).lastInsertRowid);
  db.prepare("INSERT INTO dreaming_range_events VALUES (?,?)").run(rangeId, fixture.child);
  db.prepare("INSERT INTO dreaming_family(id,range_id) VALUES (1,?)").run(rangeId);
  db.close();

  const store = new Store(fixture.path);
  const range = store.db.prepare("SELECT * FROM dreaming_ranges WHERE id=?").get(rangeId)!;
  expect(range).toMatchObject({ completed_run: null, pool: null, claim_token: null, pending_revisions: "[]" });
  expect(range.closed_at).toBeTypeOf("string");
  expect(store.db.prepare("SELECT * FROM dreaming_range_events WHERE range_id=?").get(rangeId)).toMatchObject({ event_id: fixture.child });
  const anchor = store.db.prepare("PRAGMA table_info(dreaming_ranges)").all().find(row => row.name === "anchor")!;
  expect(anchor.notnull).toBe(0);
  expect(String(store.db.prepare("SELECT sql FROM sqlite_master WHERE name='idx_dreaming_open_range'").get()!.sql)).toContain("closed_at IS NULL");
  store.close();
});

test("64d reports a missing legacy budget policy as absent, not customized", () => {
  const fixture = legacyFixture();
  const db = new DatabaseSync(fixture.path);
  db.exec("DROP TABLE knowledge_budget_policy"); db.close();
  const store = new Store(fixture.path);
  expect(store.knowledgeBudgets()).toMatchObject({ global: 4000, project: 15000, session: 1000 });
  expect(store.migration64d).toMatchObject({ budgetBefore: null, budgetSource: "absent", budgetWasCustom: false });
  store.close();
});

test("64d preserves a customised legacy budget policy", () => {
  const fixture = legacyFixture();
  const db = new DatabaseSync(fixture.path);
  db.prepare("UPDATE knowledge_budget_policy SET project_tokens=12345 WHERE id=1").run(); db.close();
  const store = new Store(fixture.path);
  expect(store.knowledgeBudgets()).toMatchObject({ global: 4000, project: 12345, session: 1000 });
  expect(store.migration64d).toMatchObject({ budgetSource: "custom", budgetWasCustom: true });
  store.close();
});

test("64d refuses an unknown incoming foreign key and rolls back the whole migration", () => {
  const fixture = legacyFixture(true);
  expect(() => new Store(fixture.path)).toThrow(/extension_mark references retired table knowledge_marks/);
  const db = new DatabaseSync(fixture.path, { readOnly: true });
  expect(db.prepare("SELECT supports FROM knowledge_revisions WHERE id=?").get(fixture.child)!.supports).toBe("[]");
  expect(db.prepare("SELECT project_tokens FROM knowledge_budget_policy WHERE id=1").get()!.project_tokens).toBe(10000);
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_marks'").get()).toBeDefined();
  db.close();
});
