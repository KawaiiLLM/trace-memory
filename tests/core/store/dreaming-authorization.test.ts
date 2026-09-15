import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store, type RunInput } from "../../../src/core/store/index.ts";

const stores: Store[] = [], directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(path = ":memory:") {
  const store = new Store(path); stores.push(store);
  const project = store.createProject({ name: "archive", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{ turnId: turn.id, source: [`T${turn.id}#user`], actor: "user", category: "decision", text: "rule", createdAt: "now" }] });
  if (!facts.ok) throw Error(facts.problems.join());
  const content = { supports: [facts.facts[0]!.id], reason: "evidence", text: "rule", category: "constraint" as const, scope: "project" as const, topics: [], createdAt: "now" };
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{ op: "create", handle: "$1", author: "test", ...content }] });
  if (!created.ok) throw Error(created.problems.join());
  const item = created.committed[0]!;
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const range = store.retainDreamingRange(target, [item.commit]);
  const claim = store.acquireClaim(target, "dreaming", "test")!;
  const run: RunInput = { kind: "dreaming", sessionId: session.id, branch: "main", claim, dreamingRangeId: range.id, executionId: store.beginExecution({ sessionId: session.id, phase: "dreaming", head: range.anchor }), createdAt: "now" };
  const archive = { op: "archive" as const, knowledgeId: item.knowledgeId, baseCommit: item.commit, supports: [], reason: "Retire lower-priority active memory; history retained", createdAt: "now" };
  return { store, content, item, target, run, archive };
}

test("32: only a trusted Dreamer archive may carry empty supports — role is authority, not evidence", () => {
  const f = fixture();
  expect(f.store.commitConsolidationRun({ run: f.run, path: f.target, operations: [f.archive] }).ok).toBe(false);
  const bound = f.store.bindDreamingRun(f.run);
  const accepted = f.store.commitConsolidationRun({ run: bound, path: f.target, operations: [f.archive] });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const revision = f.store.knowledgeRevision(accepted.committed[0]!.commit)!;
  expect(revision.actorRole).toBe("dreaming");
  expect(revision.parentId).toBe(f.item.commit);
  expect(revision.supports).toEqual([]);
  expect(f.store.listCurrentKnowledge(f.target)).toEqual([]);
  expect(f.store.isKnowledgeProcessed(revision.id)).toBe(false);
});

test("32d: trusted authority never grants empty-support create or a mixed partial batch", () => {
  const f = fixture();
  const run = f.store.bindDreamingRun(f.run);
  const result = f.store.commitConsolidationRun({ run, path: f.target, operations: [f.archive, { op: "create", handle: "$1", author: "test", ...f.content, supports: [] }] });
  expect(result.ok).toBe(false);
  expect(f.store.currentCommit(f.item.knowledgeId, f.target)[0]!.id).toBe(f.item.commit);
});

test("32d: simultaneous processes migrate the actor column under one short schema transaction", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-migration-")); directories.push(dir);
  const db = join(dir, "memory.sqlite"), f = fixture(db);
  f.store.db.exec("ALTER TABLE knowledge_revisions DROP COLUMN actor_role");
  f.store.close();
  const source = new URL("../../../src/core/store/index.ts", import.meta.url).href;
  const code = `import { DatabaseSync } from 'node:sqlite';
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (sql === 'PRAGMA table_info(knowledge_revisions)') {
        const all = statement.all.bind(statement);
        statement.all = (...args) => { const rows = all(...args); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150); return rows; };
      }
      return statement;
    };
    const { Store } = await import(${JSON.stringify(source)});
    const store = new Store(${JSON.stringify(db)}); store.close();`;
  await Promise.all([1, 2].map(() => promisify(execFile)(process.execPath, ["--input-type=module", "-e", code], { timeout: 5000 })));
  const reopened = new Store(db); stores.push(reopened);
  expect(reopened.db.prepare("PRAGMA table_info(knowledge_revisions)").all().filter(r => r.name === "actor_role")).toHaveLength(1);
  expect(reopened.knowledgeRevision(f.item.commit)?.actorRole).toBeUndefined();
  expect(() => reopened.db.prepare("UPDATE knowledge_revisions SET actor_role = 'noting' WHERE id = ?").run(f.item.commit)).toThrow(/CHECK/);
});

test.each(["manual", "noting", "consolidation", "dreaming"] as const)("32d: %s self-description grants no empty-support archive authority", kind => {
  const f = fixture();
  const result = f.store.commitConsolidationRun({ run: { kind, sessionId: f.target.sessionId, createdAt: "now", dreamingAuthority: {} }, path: f.target, operations: [f.archive] });
  expect(result.ok).toBe(false);
  expect(f.store.currentCommit(f.item.knowledgeId, f.target)[0]!.id).toBe(f.item.commit);
});

test("32d: archive provenance and exact-parent applicability survive reopen, including sibling exclusion", () => {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-provenance-")); directories.push(dir);
  const db = join(dir, "memory.sqlite"), f = fixture(db);
  const sibling = f.store.appendTurn({ sessionId: f.target.sessionId, kind: "turn", userPrompt: "sibling", startedAt: "now" });
  const siblingPath = { ...f.target, branch: "sibling", headTurnId: sibling.id };
  const bound = f.store.bindDreamingRun(f.run);
  const result = f.store.commitConsolidationRun({ run: bound, path: f.target, operations: [f.archive] });
  if (!result.ok) throw Error(result.problems.join());
  const commit = result.committed[0]!.commit;
  expect(f.store.commitApplies(f.store.knowledgeRevision(commit)!, siblingPath)).toBe(false);
  f.store.close();
  const memory = TraceMemory(db, async () => { throw Error("no provider"); }); stores.push(memory.store);
  expect(memory.store.knowledgeRevision(commit)).toMatchObject({ actorRole: "dreaming", parentId: f.item.commit, scope: "project", supports: [], reason: f.archive.reason });
  expect(memory.store.commitApplies(memory.store.knowledgeRevision(commit)!, siblingPath)).toBe(false);
  expect(memory.trace(`K${f.item.knowledgeId}@${commit}`)).toContain("maintenance judgment");
  expect(memory.trace(`K${f.item.knowledgeId}@${f.item.commit}`)).toContain("rule");
  expect(memory.trace("F1")).toContain("rule");
  expect(memory.search("rule", "knowledge", { versions: "all", fields: ["text", "status"] })).toContain("status: archived");
});

test("32d: current claim and family are enforced in the atomic Store write, not by reads", () => {
  const f = fixture(), run = f.store.bindDreamingRun(f.run);
  const outside = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", ...f.content }] });
  if (!outside.ok) throw Error(outside.problems.join());
  const item = outside.committed[0]!;
  expect(f.store.commitConsolidationRun({ run, path: f.target, operations: [f.archive, { ...f.archive, knowledgeId: item.knowledgeId, baseCommit: item.commit }] }).ok).toBe(false);
  expect(f.store.currentCommit(f.item.knowledgeId, f.target)[0]!.id).toBe(f.item.commit);
  f.store.releaseClaim(f.run.claim!);
  expect(f.store.commitConsolidationRun({ run, path: f.target, operations: [f.archive] }).ok).toBe(false);
});


test("32d: create plus merge is not a split; rejection has zero batch side effects", () => {
  const f = fixture();
  const other = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", ...f.content }] });
  if (!other.ok) throw Error(other.problems.join());
  const item = other.committed[0]!;
  // Both parents really are admitted family members; this is an operation-type violation.
  f.store.db.prepare("INSERT INTO dreaming_family VALUES (?, ?)").run(f.run.dreamingRangeId!, item.knowledgeId);
  const run = f.store.bindDreamingRun(f.run);
  const before = { revisions: f.store.listKnowledgeRevisions(), family: f.store.dreamingRange(f.run.dreamingRangeId!), links: f.store.listKnowledgeLinks(f.item.knowledgeId) };
  const merge = { op: "merge" as const, intoKnowledgeId: f.item.knowledgeId, intoBaseCommit: f.item.commit, absorb: [{ knowledgeId: item.knowledgeId, baseCommit: item.commit }], ...f.content };
  const result = f.store.commitConsolidationRun({ run, path: f.target, operations: [{ op: "create", handle: "$split", author: "test", ...f.content }, merge] });
  expect(result.ok).toBe(false);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.dreamingRange(f.run.dreamingRangeId!)).toEqual(before.family);
  expect(f.store.listKnowledgeLinks(f.item.knowledgeId)).toEqual(before.links);
  expect(f.store.commitConsolidationRun({ run, path: f.target, operations: [merge] }).ok).toBe(true);
});

test.each(["update", "archive"] as const)("34a: create plus authorized family %s cannot impersonate an explicit split", op => {
  const f = fixture(), run = f.store.bindDreamingRun(f.run);
  const result = f.store.commitConsolidationRun({ run, path: f.target, operations: [
    { op: "create", handle: "$split", author: "test", ...f.content },
    { ...f.content, ...f.archive, op, supports: op === "archive" ? [] : f.content.supports },
  ] });
  expect(result.ok).toBe(false);
  expect(f.store.listKnowledgeRevisions()).toHaveLength(1);
});

test("32d: an outside-family update cannot decorate create into a split", () => {
  const f = fixture(), run = f.store.bindDreamingRun(f.run);
  const outside = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", ...f.content }] });
  if (!outside.ok) throw Error(outside.problems.join());
  const item = outside.committed[0]!, before = f.store.listKnowledgeRevisions();
  expect(f.store.commitConsolidationRun({ run, path: f.target, operations: [
    { op: "create", handle: "$split", author: "test", ...f.content },
    { op: "update", knowledgeId: item.knowledgeId, baseCommit: item.commit, ...f.content },
  ] }).ok).toBe(false);
  expect(f.store.listKnowledgeRevisions()).toEqual(before);
});
