import { afterEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory } from "../../source-fixture.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("92/03: pre-tag revision metadata backfills once without rewriting knowledge rows; later open never repairs", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-92-tag-upgrade-")); dirs.push(dir);
  const file = join(dir, "memory.sqlite");
  const open = () => sourceSeededMemory(file, async () => ({ outcome: "failure" as const, output: "not invoked" }));
  const old = open();
  const project = old.store.createProject({ name: "older", declaredBy: "mark" });
  const session = old.store.createSession({ projectId: project.id, host: "pi:old", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true });
  const turn = old.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "old", assistantText: "", startedAt: "now" });
  const note = old.tools({ kind: "manual", sessionId: session.id, currentTurnId: turn.id, branch: "main" }).find(tool => tool.name === "note")!;
  const factId = JSON.parse(note.execute({ facts: [{ text: "Old evidence", source: [`T${turn.id}#E1`] }] })).factIds[0];
  const receipt = JSON.parse(old.tools({ kind: "manual", sessionId: session.id, currentTurnId: turn.id, branch: "main" })
    .find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", text: "Old body", category: "reference", scope: "session", topics: ["old"], reason: "old reason", supports: [`F${factId}`] }], skipped: [] }));
  const id = receipt.committed[0].knowledgeId;
  const revision = old.store.resolveVersionOrdinal(id, Number(receipt.committed[0].version.split("@v")[1]));
  const before = old.store.db.prepare("SELECT * FROM knowledge_revisions WHERE id=?").get(revision);
  old.store.db.exec("DROP TABLE knowledge_version_tags"); // Exact pre-upgrade shape: existing immutable revisions, absent new metadata table.
  old.close();
  const prepare = DatabaseSync.prototype.prepare;
  const fault = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    const statement = prepare.call(this, sql);
    if (sql.startsWith("INSERT INTO knowledge_version_tags")) {
      const run = statement.run.bind(statement);
      vi.spyOn(statement, "run").mockImplementation((...args) => { run(...args); throw new Error("tag upgrade after insert"); });
    }
    return statement;
  });
  try { expect(open).toThrow("tag upgrade after insert"); }
  finally { fault.mockRestore(); }
  const failed = new DatabaseSync(file);
  try {
    expect(failed.prepare("SELECT name FROM sqlite_master WHERE name='knowledge_version_tags'").get()).toBeUndefined();
    expect(failed.prepare("SELECT * FROM knowledge_revisions WHERE id=?").get(revision)).toEqual(before);
  } finally { failed.close(); }
  const upgraded = open();
  expect(upgraded.store.db.prepare("SELECT * FROM knowledge_revisions WHERE id=?").get(revision)).toEqual(before);
  expect(upgraded.store.versionOrdinal(id, revision)).toBe(1);
  const tag = upgraded.store.versionTag(id, revision);
  upgraded.close();
  const queries: string[] = [];
  const scan = vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
    queries.push(sql); return prepare.call(this, sql);
  });
  let again: ReturnType<typeof open>;
  try { again = open(); } finally { scan.mockRestore(); }
  try {
    expect(queries).not.toContain("SELECT knowledge_id AS knowledgeId, id AS commitId FROM knowledge_revisions ORDER BY id");
    expect(again.store.versionTag(id, revision)).toBe(tag);
    again.store.db.prepare("DELETE FROM knowledge_version_tags WHERE commit_id=?").run(revision);
  } finally { again.close(); }
  const damaged = open();
  try { expect(() => damaged.store.versionTag(id, revision)).toThrow("unknown knowledge version"); }
  finally { damaged.close(); }
});
