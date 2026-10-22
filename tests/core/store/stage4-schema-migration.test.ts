// Ticket 144, Stage 4: the columns the Dreamer's curate, verify and classify tasks need. An existing database keeps
// every row as it was, the new columns start empty or defaulted, and a second open changes nothing.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { writeHandoff } from "../../../src/core/store/executions.ts";
import { entry, knowledgeBatch, session as seedSession } from "../../support/seed.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const NEW_COLUMNS = { knowledge: ["score", "scored_commit", "scored_run"], task_handoffs: ["detail"],
  knowledge_deliveries: ["titles", "temporary_tokens"] } as const;
const rows = (store: Store, table: string, skip: readonly string[] = []) => (store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, unknown>[])
  .map(row => Object.fromEntries(Object.entries(row).filter(([name]) => !skip.includes(name))));

function database(budgets = true) {
  const dir = mkdtempSync(join(tmpdir(), "tm-stage4-migrate-")); dirs.push(dir);
  const file = join(dir, "memory.sqlite");
  const store = new Store(file);
  const project = store.createProject({ name: "stage4", declaredBy: "mark" });
  const session = seedSession(store, project.id, "pi:stage4");
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: "now" });
  const source = entry(store, session.id, turn.id, "evidence", "user", "Use pnpm");
  store.selectSourcePath(session.id, "main", [source.id]);
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
    { turnId: turn.id, text: "evidence", category: "decision", actor: "user", source: [`T${turn.id}#user`], entryIds: [source.id], createdAt: "now" }] });
  if (!fact.ok) throw new Error(fact.problems.join("; "));
  knowledgeBatch(store, path, [{ scope: "project", category: "constraint", supports: [fact.facts[0]!.id], title: "Rule", text: "Rule body" }]);
  const run = store.recordRun({ kind: "dreaming", sessionId: session.id, branch: "main", outcome: "success", createdAt: "now" });
  writeHandoff(store, { sessionId: session.id, phase: "dreaming", nextTask: "curate", runId: run.id, branch: null, entryIds: [] });
  store.db.prepare("INSERT INTO knowledge_deliveries(owner, commits, states, knowledge_tokens, created_at) VALUES ('pi:stage4', '[1]', '[]', 7, 'now')").run();
  if (budgets) store.db.exec("UPDATE knowledge_budget_policy SET global_tokens = 5000, project_tokens = 7000, session_tokens = 300");
  return { file, store, session, run };
}

test("a database without the columns keeps every row, defaults the new columns, derives the base from the pool budgets, and a second open changes nothing", () => {
  const f = database();
  const tables = Object.keys(NEW_COLUMNS) as (keyof typeof NEW_COLUMNS)[];
  const before = Object.fromEntries(tables.map(table => [table, rows(f.store, table, NEW_COLUMNS[table])]));
  for (const table of tables) for (const column of NEW_COLUMNS[table]) f.store.db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  f.store.db.exec("DROP TABLE knowledge_base_policy");
  const revisions = rows(f.store, "knowledge_revisions");
  f.store.close();
  for (let opens = 0; opens < 2; opens++) {
    const upgraded = new Store(f.file);
    try {
      for (const table of tables) {
        expect(rows(upgraded, table, NEW_COLUMNS[table]), table).toEqual(before[table]);
        for (const column of NEW_COLUMNS[table]) expect(upgraded.db.prepare(`PRAGMA table_info(${table})`).all().some(row => row.name === column), `${table}.${column}`).toBe(true);
      }
      expect(rows(upgraded, "knowledge_revisions")).toEqual(revisions);
      expect(rows(upgraded, "knowledge")[0]).toMatchObject({ score: null, scored_commit: null, scored_run: null });
      expect(rows(upgraded, "task_handoffs")[0]).toMatchObject({ detail: null });
      expect(rows(upgraded, "knowledge_deliveries")[0]).toMatchObject({ titles: "[]", temporary_tokens: 0 });
      expect(rows(upgraded, "knowledge_base_policy")).toEqual([{ id: 1, base_tokens: opens === 0 ? 12_300 : 999 }]);
      expect(upgraded.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      upgraded.db.exec("UPDATE knowledge_base_policy SET base_tokens = 999"); // a later open must not derive it again
    } finally { upgraded.close(); }
  }
});

test("a fresh database has a base of 20,000, scores within 1 to 100, and a hand-off that round-trips its detail", () => {
  const f = database(false);
  try {
    expect(rows(f.store, "knowledge_base_policy")).toEqual([{ id: 1, base_tokens: 20_000 }]);
    // A process on older code inserts into the budget table positionally; the table keeps the shape it had.
    f.store.db.exec("DELETE FROM knowledge_budget_policy");
    f.store.db.prepare("INSERT OR IGNORE INTO knowledge_budget_policy VALUES (1,?,?,?)").run(1, 2, 3);
    expect(f.store.handoff(f.session.id, "dreaming")!.detail).toBeUndefined();
    const detail = { pair: "update-archive" as const, groups: [{ batches: [{ category: "constraint", items: [1], run: f.run.id }] }] };
    writeHandoff(f.store, { sessionId: f.session.id, phase: "dreaming", nextTask: "verify", runId: f.run.id, branch: null, entryIds: [], detail });
    expect(f.store.handoff(f.session.id, "dreaming")!.detail).toEqual(detail);
    expect(() => f.store.db.exec("UPDATE knowledge SET score = 101")).toThrow();
    f.store.db.exec("UPDATE knowledge SET score = 100");
  } finally { f.store.close(); }
});
