// Ticket 144: knowledge versions gain a nullable title. An existing database keeps every row as it was.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { entry, legacyKnowledge, session } from "../../support/seed.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function database() {
  const dir = mkdtempSync(join(tmpdir(), "tm-title-migrate-")); dirs.push(dir);
  const file = join(dir, "memory.sqlite"), store = new Store(file);
  const project = store.createProject({ name: "titles", declaredBy: "mark" });
  const s = session(store, project.id, "pi:titles");
  const turn = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "now" });
  const source = entry(store, s.id, turn.id, "evidence", "user", "Use pnpm");
  store.selectSourcePath(s.id, "main", [source.id]);
  const path = { sessionId: s.id, branch: "main", headTurnId: turn.id };
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: s.id, createdAt: "now" }, facts: [
    { turnId: turn.id, text: "evidence", category: "decision", actor: "user", source: [`T${turn.id}#user`], entryIds: [source.id], createdAt: "now" }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const first = legacyKnowledge(store, path, { text: "First legacy rule", category: "constraint", scope: "project", supports: [noted.facts[0]!.id] });
  const second = legacyKnowledge(store, path, { text: "Second legacy rule", category: "reference", scope: "project", supports: [noted.facts[0]!.id], topics: ["a"] });
  return { file, store, path, fact: noted.facts[0]!.id, first, second };
}

test("a database without the column keeps every knowledge row, gets NULL titles, and writes titled versions afterwards", () => {
  const f = database();
  const before = f.store.db.prepare("SELECT * FROM knowledge_revisions ORDER BY id").all().map(({ title: _title, ...row }) => row);
  expect(before).toHaveLength(2);
  f.store.db.exec("ALTER TABLE knowledge_revisions DROP COLUMN title");
  f.store.close();
  for (let opens = 0; opens < 2; opens++) { // the second open finds the column and changes nothing
    const upgraded = new Store(f.file);
    try {
      const rows = upgraded.db.prepare("SELECT * FROM knowledge_revisions ORDER BY id").all() as Record<string, unknown>[];
      expect(rows.map(({ title, ...row }) => { expect(title).toBeNull(); return row; })).toEqual(before);
      expect(upgraded.getKnowledgeRevision(f.first.knowledgeId, f.first.commit)).toMatchObject({ text: "First legacy rule", title: null });
      expect(upgraded.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally { upgraded.close(); }
  }
});

test("a new version is titled while the legacy versions it follows stay untitled", () => {
  const f = database();
  try {
    const updated = f.store.commitConsolidationRun({ path: f.path, run: { kind: "manual", sessionId: f.path.sessionId, branch: "main", createdAt: "now" },
      operations: [{ op: "update", knowledgeId: f.first.knowledgeId, baseCommit: f.first.commit, title: "First rule", text: "First rule, clarified",
        category: "constraint", scope: "project", supports: [f.fact], topics: [], reason: "clarify", createdAt: "now" }] });
    if (!updated.ok) throw new Error(updated.problems.join("; "));
    expect(f.store.getKnowledgeRevision(f.first.knowledgeId, updated.committed[0]!.commit)!.title).toBe("First rule");
    expect(f.store.getKnowledgeRevision(f.first.knowledgeId, f.first.commit)!.title).toBeNull();
    expect(f.store.getKnowledgeRevision(f.second.knowledgeId, f.second.commit)!.title).toBeNull();
  } finally { f.store.close(); }
});

// A derived title is how a legacy row renders; the Store never writes one. Every new live version arrives titled.
test("a direct Store write of a new live version without a title is refused, and nothing is stored", () => {
  const f = database();
  try {
    const run = { kind: "manual" as const, sessionId: f.path.sessionId, branch: "main", createdAt: "now" };
    const common = { supports: [f.fact], topics: [], reason: "no title", createdAt: "now" };
    const before = f.store.listKnowledgeRevisions();
    const untitled = [
      { op: "create" as const, handle: "$1", author: "test", text: "Untitled rule", category: "constraint" as const, scope: "project" as const, ...common },
      // A legacy base has no title to inherit.
      { op: "update" as const, knowledgeId: f.first.knowledgeId, baseCommit: f.first.commit, text: "Edited", category: "constraint" as const, scope: "project" as const, ...common },
    ];
    for (const operation of untitled) {
      const result = f.store.commitConsolidationRun({ path: f.path, run, operations: [operation] });
      expect(result.ok, operation.op).toBe(false);
      expect(!result.ok && result.problems.join("; "), operation.op).toContain("requires a title");
    }
    expect(f.store.listKnowledgeRevisions()).toEqual(before);
  } finally { f.store.close(); }
});
