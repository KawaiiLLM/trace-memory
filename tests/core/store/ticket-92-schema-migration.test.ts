import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../../src/core/store/index.ts";
import { renderKnowledge, renderKnowledgePreview, wholeKnowledge } from "../../../src/core/render/index.ts";
import { knowledgeReadSelection } from "../../../src/core/api/knowledge-read.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "tm-92-migrate-")); dirs.push(dir);
  const path = join(dir, "memory.sqlite"), store = new Store(path);
  const project = store.createProject({ name: "legacy-92", declaredBy: "mark" });
  const session = store.createSession({ projectId: project.id, host: "pi:legacy", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: "now" });
  const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeId: "before", nativeLineage: "root", role: "user", text: "original user", raw: "original user", calls: [] });
  const run = { kind: "manual" as const, sessionId: session.id, createdAt: "now" };
  const old = { turnId: turn.id, category: "event" as const, actor: "user" as const, status: "completed" as const,
    quote: "original", source: [`T${turn.id}#user`], text: "legacy fact", createdAt: "now", entryIds: [entry.id] };
  const first = store.commitNotingRun({ run, facts: [old] });
  if (!first.ok) throw new Error(first.problems.join("; "));
  const second = store.commitNotingRun({ run, facts: [{ ...old, text: "legacy correction", support: [{ target: `F${first.facts[0]!.id}`, strength: "strong" }] }] });
  if (!second.ok) throw new Error(second.problems.join("; "));
  const facts = [first.facts[0]!.id, second.facts[0]!.id];
  const knowledgeId = Number(store.db.prepare("INSERT INTO knowledge (project_id, origin_session_id, author) VALUES (?, ?, 'legacy')")
    .run(project.id, session.id).lastInsertRowid);
  store.db.prepare(`INSERT INTO knowledge_revisions (knowledge_id,parent_id,text,category,scope,supports,support_semantics,op,reason,topics,run_id,created_at,actor_role)
    VALUES (?,NULL,'legacy knowledge','mechanism','session',?,'change','create','original','[]',?,?,'manual')`)
    .run(knowledgeId, JSON.stringify(facts), first.runId, "now");
  return { path, store, session, turn, entry, facts };
}

function sql(db: DatabaseSync, table: string): string {
  return String((db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string }).sql);
}
function downgrade(db: DatabaseSync) {
  db.exec("PRAGMA foreign_keys=OFF");
  const oldFacts = sql(db, "facts").replace(/category TEXT CHECK \(category IS NULL OR category IN /, "category TEXT NOT NULL CHECK (category IN ")
    .replace(/actor TEXT CHECK \(actor IS NULL OR actor IN /, "actor TEXT NOT NULL CHECK (actor IN ")
    .replace("CHECK (category IS NULL AND status IS NULL OR category IS NOT NULL AND ((status IS NOT NULL) = (category = 'event')))",
      "CHECK ((status IS NOT NULL) = (category = 'event'))")
    .replace("  source_roles TEXT,\n", "");
  const oldKnowledge = sql(db, "knowledge_revisions").replace("'constraint','understanding','open'", "'constraint','open'")
    .replace("'noting','consolidation','dreaming','manual'", "'consolidation','dreaming','manual'");
  for (const [table, old] of [["facts", oldFacts], ["knowledge_revisions", oldKnowledge]] as const) {
    const objects = db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name=? AND type IN ('index','trigger') AND sql IS NOT NULL")
      .all(table) as { sql: string }[];
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name).filter(name => name !== "source_roles");
    db.exec(old.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_before92`));
    db.exec(`INSERT INTO ${table}_before92 (${cols.join(",")}) SELECT ${cols.join(",")} FROM ${table}; DROP TABLE ${table}; ALTER TABLE ${table}_before92 RENAME TO ${table}`);
    for (const object of objects) db.exec(object.sql);
  }
  db.exec("PRAGMA foreign_keys=ON");
}

test("92 schema upgrade retains legacy rows, source bindings, relation, indexes, ids and second-open state", () => {
  const f = fixture();
  f.store.db.exec("CREATE INDEX legacy_fact_text ON facts(text); CREATE TRIGGER legacy_fact_keep AFTER INSERT ON facts BEGIN SELECT 1; END");
  const before = f.facts.map(id => f.store.getFact(id));
  const relations = f.store.listFactRelationsOnPathOf(f.facts, { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
  downgrade(f.store.db);
  expect(sql(f.store.db, "facts")).toContain("actor TEXT NOT NULL");
  const originalSequence = Number((f.store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='facts'").get() as { seq: number }).seq);
  f.store.db.prepare("UPDATE sqlite_sequence SET seq = ? WHERE name = 'facts'").run(originalSequence + 20);
  f.store.close();
  let store = new Store(f.path);
  try {
    expect(sql(store.db, "facts")).toContain("category IS NULL AND status IS NULL");
    expect(sql(store.db, "knowledge_revisions")).toContain("'understanding'");
    expect(f.facts.map(id => store.getFact(id))).toEqual(before);
    expect(store.factEntries(f.facts[0]!)).toEqual([f.entry.id]);
    expect(store.listFactRelationsOnPathOf(f.facts, { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id })).toEqual(relations);
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect((store.db.prepare("SELECT seq FROM sqlite_sequence WHERE name='facts'").get() as { seq: number }).seq).toBe(originalSequence + 20);
    const later = store.commitNotingRun({ run: { kind: "manual", sessionId: f.session.id, createdAt: "now" },
      facts: [{ turnId: f.turn.id, text: "after upgrade", source: [`T${f.turn.id}#E1`], entryIds: [f.entry.id], createdAt: "now" }] });
    if (!later.ok) throw new Error(later.problems.join("; "));
    expect(later.facts[0]!.id).toBe(originalSequence + 21);
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_fact_text'").get()).toEqual({ name: "legacy_fact_text" });
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='legacy_fact_keep'").get()).toEqual({ name: "legacy_fact_keep" });
    expect(store.db.prepare("SELECT category FROM knowledge_revisions").get()).toEqual({ category: "mechanism" });
    const knowledge = store.currentKnowledge({ sessionId: f.session.id, branch: "main", headTurnId: f.turn.id });
    expect(knowledge).toHaveLength(1);
    expect(renderKnowledge(knowledge[0]!)).toContain("[understanding/session]");
    expect(renderKnowledgePreview(knowledge[0]!, "current", new Set(["text"]))).toContain("[understanding/session]");
    const list = wholeKnowledge(knowledge).groups;
    expect(list).toHaveLength(1);
    expect(list[0]!.text).toContain("[understanding/session] legacy knowledge");
    const selection = knowledgeReadSelection(store, { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id, category: "understanding" });
    expect(selection.representatives([...selection.byCommit.values()])).toHaveLength(1);
    expect(knowledgeReadSelection(store, { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id, category: "open" })
      .representatives([...selection.byCommit.values()])).toHaveLength(0);
    const afterSql = sql(store.db, "facts"); store.close(); store = new Store(f.path);
    expect(sql(store.db, "facts")).toBe(afterSql);
    expect(f.facts.map(id => store.getFact(id))).toEqual(before);
    expect(store.getFact(originalSequence + 21)).not.toBeNull();
  } finally { store.close(); }
});

test("92: only five new knowledge categories write through Store; old revisions remain readable", () => {
  const f = fixture();
  try {
    const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
    for (const category of ["constraint", "understanding", "goal", "open", "reference"] as const) {
      const result = f.store.commitConsolidationRun({ path,
        run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
        operations: [{ op: "create", handle: `$${category}`, author: "manual", text: `new ${category}`, category,
          scope: "session", supports: [f.facts[0]!], reason: "new category", topics: [], createdAt: "now" }] });
      expect(result.ok).toBe(true);
    }
    const rejected = f.store.commitConsolidationRun({ path,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
      operations: [{ op: "create", handle: "$old", author: "manual", text: "wrong", category: "mechanism",
        scope: "session", supports: [f.facts[0]!], reason: "old category", topics: [], createdAt: "now" }] });
    expect(rejected.ok).toBe(false);
    expect(f.store.db.prepare("SELECT category FROM knowledge_revisions ORDER BY id").all().map(row => row.category))
      .toEqual(["mechanism", "constraint", "understanding", "goal", "open", "reference"]);
  } finally { f.store.close(); }
});

test("92 archive normalizes inherited legacy categories while explicit legacy writes stay forbidden", () => {
  for (const [legacy, current] of [["mechanism", "understanding"], ["term", "understanding"], ["dispute", "open"]] as const) {
    const f = fixture();
    try {
      const base = f.store.db.prepare("SELECT id,knowledge_id FROM knowledge_revisions").get() as { id: number; knowledge_id: number };
      f.store.db.prepare("UPDATE knowledge_revisions SET category=? WHERE id=?").run(legacy, base.id);
      const path = { sessionId: f.session.id, branch: "main", headTurnId: f.turn.id };
      const invalidUpdate = f.store.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId: f.session.id, createdAt: "now" },
        operations: [{ op: "update", knowledgeId: base.knowledge_id, baseCommit: base.id, text: "invalid new revision",
          category: legacy, scope: "session", supports: [f.facts[0]!], reason: "old category", topics: [], createdAt: "now" }] });
      expect(invalidUpdate.ok).toBe(false);
      const archive = f.store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: f.session.id, createdAt: "now" },
        operations: [{ op: "archive", knowledgeId: base.knowledge_id, baseCommit: base.id,
          supports: [f.facts[0]!], reason: "Retire legacy item", createdAt: "now" }] });
      if (!archive.ok) throw new Error(archive.problems.join("; "));
      expect(f.store.getKnowledgeRevision(base.knowledge_id, base.id)!.category).toBe(legacy);
      expect(f.store.getKnowledgeRevision(base.knowledge_id, archive.committed[0]!.commit)!.category).toBe(current);
      const rejected = f.store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: f.session.id, createdAt: "now" },
        operations: [{ op: "create", handle: "$old", author: "manual", text: "invalid", category: legacy,
          scope: "session", supports: [f.facts[0]!], reason: "invalid category", topics: [], createdAt: "now" }] });
      expect(rejected.ok).toBe(false);
    } finally { f.store.close(); }
  }
});

test("92 schema rollback is all-or-nothing when the second table has an unknown CHECK shape", () => {
  const f = fixture(); downgrade(f.store.db);
  f.store.db.exec("CREATE TRIGGER legacy_fact_keep AFTER INSERT ON facts BEGIN SELECT 1; END");
  // A valid old database with a second-table CHECK variant: facts rebuild first, then the upgrade refuses it.
  const oldKnowledge = sql(f.store.db, "knowledge_revisions");
  const knowledgeObjects = f.store.db.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='knowledge_revisions' AND type IN ('index','trigger') AND sql IS NOT NULL").all() as { sql: string }[];
  f.store.db.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE knowledge_revisions_backup AS SELECT * FROM knowledge_revisions;
    DROP TABLE knowledge_revisions;
    ${oldKnowledge.replace("'constraint','open'", "'constraint','goal','open'")};
    INSERT INTO knowledge_revisions SELECT * FROM knowledge_revisions_backup;
    DROP TABLE knowledge_revisions_backup;
    PRAGMA foreign_keys=ON`);
  for (const object of knowledgeObjects) f.store.db.exec(object.sql);
  const db = f.store.db;
  const names = ["facts", "fact_sources", "fact_relations", "knowledge", "knowledge_revisions", "sqlite_sequence"];
  const rows = Object.fromEntries(names.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]));
  const objects = db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type,name").all();
  expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  f.store.close();
  expect(() => new Store(f.path)).toThrow(/92 migration refused unknown knowledge_revisions schema/);
  const reopened = new DatabaseSync(f.path);
  try {
    expect(reopened.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE type IN ('table','index','trigger') ORDER BY type,name").all()).toEqual(objects);
    for (const name of names) expect(reopened.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()).toEqual(rows[name]);
    expect(reopened.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { reopened.close(); }
});
