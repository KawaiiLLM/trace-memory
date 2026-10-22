import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store, type RunInput, type KnowledgePath } from "../../../src/core/store/index.ts";
import { session as seedSession, entry as seedEntry, legacyFact, knowledge as seedKnowledge } from "../../support/seed.ts";

const stores: Store[] = [], directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(path = ":memory:", prepare?: (store: Store, target: KnowledgePath, supports: number[]) => void) {
  const store = new Store(path); stores.push(store);
  const project = store.createProject({ name: "archive", declaredBy: "mark" });
  const session = seedSession(store, project.id, "test");
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const entry = seedEntry(store, session.id, turn.id, "trigger", "user", "rule");
  store.selectSourcePath(session.id, "main", [entry.id]);
  const selected = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const evidence = legacyFact(store, selected, [{ entry, address: `T${turn.id}#user` }], "rule", "decision");
  const content = { supports: [evidence.id], reason: "evidence", text: "rule", category: "constraint" as const, scope: "project" as const, topics: [], createdAt: "now" };
  const item = seedKnowledge(store, selected, "project", content.category, content.supports, content.text);
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  prepare?.(store, target, content.supports);
  // The run of a Dreamer pass, as `commitTaskPass` records it; the claim fence has its own test below.
  const run: RunInput = { kind: "dreaming", sessionId: session.id, branch: "main", createdAt: "now" };
  const archive = { op: "archive" as const, kind: "invalid" as const, text: "Retired: the user withdrew this rule and nothing replaces it; the grounds are in the cited fact.", knowledgeId: item.knowledgeId, baseCommit: item.commit, supports: [], reason: "Retire lower-priority active memory; history retained", createdAt: "now" };
  /** One Dreamer pass's operations: each commits or is refused on its own. */
  const pass = (operations: Parameters<Store["commitWorkspaceRun"]>[0]["operations"], as: RunInput = run) => store.commitWorkspaceRun({ run: as, path: target, operations });
  return { store, content, item, target, run, archive, pass };
}

test("64b: writer branch visibility refuses a live session base while visible bases remain writable", () => {
  const setup = (writerBranch: "left" | "right") => {
    const store = new Store(":memory:"); stores.push(store);
    const project = store.createProject({ name: `writer-${writerBranch}`, declaredBy: "mark" });
    const session = seedSession(store, project.id, `writer-${writerBranch}`);
    const root = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
    const left = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "left", startedAt: "now" });
    const right = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "right", startedAt: "now" });
    const entry = (turnId: number, nativeId: string) => seedEntry(store, session.id, turnId, nativeId, "user");
    const rootEntry = entry(root.id, "root"), leftEntry = entry(left.id, "left"), rightEntry = entry(right.id, "right");
    store.selectSourcePath(session.id, "left", [rootEntry.id, leftEntry.id]);
    store.selectSourcePath(session.id, "right", [rootEntry.id, rightEntry.id]);
    const note = (turnId: number, branch: string, sourceEntry: ReturnType<typeof seedEntry>, text: string) =>
      legacyFact(store, { sessionId: session.id, branch, headTurnId: turnId },
        [{ entry: sourceEntry, address: `T${turnId}#user` }], text, "decision");
    const rootFact = note(root.id, "left", rootEntry, "shared evidence");
    const leftFact = note(left.id, "left", leftEntry, "session evidence");
    const writerFact = note(writerBranch === "left" ? left.id : right.id, writerBranch,
      writerBranch === "left" ? leftEntry : rightEntry, "writer evidence");
    const create = (scope: "session" | "project" | "global", factId: number) => {
      return seedKnowledge(store, { sessionId: session.id, branch: scope === "session" ? "left" : writerBranch,
        headTurnId: scope === "session" ? left.id : writerBranch === "left" ? left.id : right.id },
        scope, "constraint", [factId], `${scope} base`);
    };
    const sessionBase = create("session", leftFact.id), projectBase = create("project", rootFact.id), globalBase = create("global", rootFact.id);
    store.setCurrentPath(session.id, "left", left.id, "native-left");
    store.setCurrentPath(session.id, "right", right.id, "native-right");
    const target = { sessionId: session.id, branch: writerBranch, headTurnId: writerBranch === "left" ? left.id : right.id,
      triggerEntryId: writerBranch === "left" ? leftEntry.id : rightEntry.id };
    const run: RunInput = { kind: "dreaming", sessionId: session.id, branch: writerBranch, createdAt: "now" };
    return { store, session, target, run, sessionBase, projectBase, globalBase, writerFact };
  };
  const operation = (base: { knowledgeId: number; commit: number }, factId: number, text: string) => ({ op: "update" as const,
    knowledgeId: base.knowledgeId, baseCommit: base.commit, text, category: "constraint" as const, scope: text.startsWith("session") ? "session" as const : "project" as const,
    supports: [factId], topics: [], reason: "writer visibility regression", createdAt: "now" });

  const wrong = setup("right");
  expect(wrong.store.knowledgeRevision(wrong.sessionBase.commit)).not.toBeNull(); // exact history authority is not write visibility
  expect(wrong.store.baseProblem(wrong.sessionBase.knowledgeId, wrong.sessionBase.commit, wrong.target)).not.toBeNull();
  expect(wrong.store.baseProblem(wrong.projectBase.knowledgeId, wrong.projectBase.commit, wrong.target)).toBeNull();
  expect(wrong.store.baseProblem(wrong.globalBase.knowledgeId, wrong.globalBase.commit, wrong.target)).toBeNull();
  const before = wrong.store.listKnowledgeRevisions();
  // Each operation of a pass commits or is refused on its own (stage 4): the invisible base is refused and writes nothing.
  const refused = wrong.store.commitWorkspaceRun({ run: wrong.run, path: wrong.target, operations: [
    operation(wrong.sessionBase, wrong.writerFact.id, "session invisible on right"),
  ] });
  expect(refused.results.map(result => result.ok)).toEqual([false]);
  expect(wrong.store.listKnowledgeRevisions()).toEqual(before);

  const correct = setup("left");
  const accepted = correct.store.commitWorkspaceRun({ run: correct.run, path: correct.target, operations: [
    operation(correct.projectBase, correct.writerFact.id, "project visible on left"),
  ] });
  expect(accepted.results.map(result => result.ok)).toEqual([true]);
  expect(accepted.results[0]).toMatchObject({ ok: true, committed: [expect.anything()] });
});

test("64b: only a Dreamer pass may submit empty supports, which inherit the exact parent supports", () => {
  const f = fixture();
  // The manual path, and a Dreamer run self-described to it, grant no such authority.
  expect(f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, path: f.target, operations: [f.archive] }).ok).toBe(false);
  expect(f.store.commitConsolidationRun({ run: f.run, path: f.target, operations: [f.archive] }).ok).toBe(false);
  const done = f.pass([f.archive]);
  const accepted = done.results[0]!;
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const revision = f.store.knowledgeRevision(accepted.committed[0]!.commit)!;
  expect(revision.actorRole).toBe("dreaming");
  expect(revision.parentId).toBe(f.item.commit);
  expect(revision.supports).toEqual(f.content.supports);
  expect(f.store.listFactsByRun(done.runId)).toEqual([]);
  expect(f.store.currentKnowledge(f.target)).toEqual([]);
  expect(f.store.db.prepare("SELECT 1 FROM knowledge_processed WHERE revision_id = ?").get(revision.id)).toBeUndefined();
});

test.each(["update", "archive"] as const)("64b: empty-support %s materializes the parent's supports", op => {
  const f = fixture();
  const operation = op === "archive" ? f.archive : { op, knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit,
    text: "maintained rule", category: "constraint" as const, scope: "project" as const, supports: [],
    topics: [], reason: "Maintenance rewrite.", createdAt: "now" };
  const result = f.pass([operation]).results[0]!;
  expect(result.ok).toBe(true);
  if (result.ok) expect(f.store.knowledgeRevision(result.committed[0]!.commit)?.supports).toEqual(f.content.supports);
});

test.each(["update", "archive"] as const)("inherited cross-project supports do not block a Dreamer empty-support %s", op => {
  let item!: { knowledgeId: number; commit: number }, citedId = 0;
  const f = fixture(":memory:", (store, target) => {
    const sibling = seedSession(store, store.getSession(target.sessionId)!.projectId, "sibling");
    const turn = store.appendTurn({ sessionId: sibling.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
    const source = seedEntry(store, sibling.id, turn.id, "evidence", "user", "evidence");
    store.selectSourcePath(sibling.id, "main", [source.id]);
    const cited = legacyFact(store, { sessionId: sibling.id, branch: "main", headTurnId: turn.id },
      [{ entry: source, address: `T${turn.id}#user` }], "sibling rule", "decision");
    citedId = cited.id;
    item = seedKnowledge(store, target, "project", "constraint", [cited.id], "project rule");
    store.db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?")
      .run(store.createProject({ name: "moved", declaredBy: "mark" }).id, sibling.id);
  });
  const operation = op === "archive" ? { ...f.archive, knowledgeId: item.knowledgeId, baseCommit: item.commit }
    : { op, knowledgeId: item.knowledgeId, baseCommit: item.commit, text: "maintained rule", category: "constraint" as const,
      scope: "project" as const, supports: [], topics: [], reason: "Maintenance rewrite.", createdAt: "now" };
  const result = f.pass([operation]).results[0]!;
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (result.ok) expect(f.store.knowledgeRevision(result.committed[0]!.commit)).toMatchObject({ op, supports: [citedId] });
});

test("64b: empty-support merge unions both exact parents and split copies its exact parent", () => {
  let second!: { knowledgeId: number; commit: number }, secondFactId = 0;
  const merged = fixture(":memory:", (store, target) => {
    const entry = store.listSourceEntries(target.sessionId)[0]!;
    const secondFact = legacyFact(store, target,
      [{ entry, address: `T${target.headTurnId}#user` }], "second rule", "decision");
    secondFactId = secondFact.id;
    second = seedKnowledge(store, target, "project", "constraint", [secondFact.id], "second rule");
  });
  const merge = merged.pass([{ op: "merge",
    intoKnowledgeId: merged.item.knowledgeId, intoBaseCommit: merged.item.commit,
    absorb: [{ knowledgeId: second.knowledgeId, baseCommit: second.commit }],
    text: "merged rules", category: "constraint", scope: "project", supports: [], topics: [], reason: "Merge redundancy.", createdAt: "now",
  }]).results[0]!;
  expect(merge.ok).toBe(true);
  if (merge.ok) expect(merged.store.knowledgeRevision(merge.committed[0]!.commit)?.supports)
    .toEqual([merged.content.supports[0], secondFactId]);

  const split = fixture();
  const result = split.pass([{ op: "split",
    knowledgeId: split.item.knowledgeId, baseCommit: split.item.commit, text: "primary claim", category: "constraint", scope: "project", topics: [],
    supports: [], reason: "Separate claims.", createdAt: "now",
    children: [{ title: "Fixture child", text: "first", category: "constraint", topics: [] }, { title: "Fixture child", text: "second", category: "constraint", topics: [] }],
  }]).results[0]!;
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.committed.map(value => split.store.knowledgeRevision(value.commit)!.supports))
    .toEqual([split.content.supports, split.content.supports, split.content.supports]);
});

test("64b: explicit evidence is not augmented and an operation with invalid evidence is refused without a write", () => {
  const f = fixture();
  const evidence = legacyFact(f.store, f.target,
    [{ entry: f.store.getSourceEntry(f.target.triggerEntryId!)!, address: `T${f.target.headTurnId}#user` }], "replacement evidence", "decision");
  const another = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{
    op: "create", title: "Fixture title", handle: "$2", author: "test", ...f.content, text: "another rule",
  }] });
  if (!another.ok) throw Error(another.problems.join());
  const before = f.store.listKnowledgeRevisions();
  // A pass is not atomic (stage 4: each operation commits or is refused on its own): the refused one writes nothing and does not stop the other.
  const done = f.pass([
    { op: "archive", kind: "invalid", text: f.archive.text, knowledgeId: another.committed[0]!.knowledgeId, baseCommit: another.committed[0]!.commit,
      supports: [999_999], reason: "Invalid evidence.", createdAt: "now" },
    { op: "update", knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit, text: "evidence rewrite", category: "constraint", scope: "project",
      supports: [evidence.id], topics: [], reason: "Apply evidence.", createdAt: "now" },
  ]);
  expect(done.results.map(result => result.ok)).toEqual([false, true]);
  expect(f.store.listKnowledgeRevisions()).toHaveLength(before.length + 1);
  expect(f.store.currentCommit(another.committed[0]!.knowledgeId, f.target)[0]!.id).toBe(another.committed[0]!.commit);
  const accepted = done.results[1]!;
  if (accepted.ok) expect(f.store.knowledgeRevision(accepted.committed[0]!.commit)?.supports).toEqual([evidence.id]);
});

test("64b: empty legacy parent support remains empty", () => {
  const f = fixture();
  f.store.db.prepare("UPDATE knowledge_revisions SET supports = '[]' WHERE id = ?").run(f.item.commit);
  const done = f.pass([f.archive]);
  const result = done.results[0]!;
  expect(result.ok).toBe(true);
  if (result.ok) expect(f.store.knowledgeRevision(result.committed[0]!.commit)?.supports).toEqual([]);
  expect(f.store.listFactsByRun(done.runId)).toEqual([]);
});

test("32d: a Dreamer pass never grants an empty-support create", () => {
  const f = fixture();
  const done = f.pass([{ op: "create", title: "Fixture title", handle: "$1", author: "test", ...f.content, supports: [] }]);
  expect(done.results[0]).toMatchObject({ ok: false });
  expect(f.store.listKnowledgeRevisions()).toHaveLength(1);
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
  const result = f.store.commitConsolidationRun({ run: { kind, sessionId: f.target.sessionId, createdAt: "now" }, path: f.target, operations: [f.archive] });
  expect(result.ok).toBe(false);
  expect(f.store.currentCommit(f.item.knowledgeId, f.target)[0]!.id).toBe(f.item.commit);
});

test("64b: inherited archive provenance and direct-support applicability survive reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-provenance-")); directories.push(dir);
  const db = join(dir, "memory.sqlite"), f = fixture(db);
  const sibling = f.store.appendTurn({ sessionId: f.target.sessionId, kind: "turn", userPrompt: "sibling", startedAt: "now" });
  const siblingEntry = f.store.appendSourceEntry({ sessionId: f.target.sessionId, turnId: sibling.id, nativeLineage: "fixture",
    nativeId: "sibling", role: "user", text: "sibling", raw: "sibling", calls: [] });
  f.store.selectSourcePath(f.target.sessionId, "sibling", [siblingEntry.id]);
  const siblingPath = { ...f.target, branch: "sibling", headTurnId: sibling.id };
  const result = f.pass([f.archive]).results[0]!;
  if (!result.ok) throw Error(result.reason);
  const commit = result.committed[0]!.commit;
  const parent = f.store.knowledgeRevision(f.item.commit)!;
  const inherited = f.store.knowledgeRevision(commit)!;
  const supports = parent.supports;
  expect(inherited.supports).toEqual(supports);
  f.store.setCurrentPath(f.target.sessionId, "sibling", sibling.id, "test-lineage");
  expect(f.store.commitApplies(parent, siblingPath)).toBe(false);
  expect(f.store.commitApplies(inherited, siblingPath)).toBe(false);
  f.store.setCurrentPath(f.target.sessionId, "main", f.target.headTurnId, "test-lineage");
  expect(f.store.commitApplies(parent, f.target)).toBe(true);
  expect(f.store.commitApplies(inherited, f.target)).toBe(true);
  f.store.close();
  const memory = TraceMemory(db, async () => { throw Error("no provider"); }); stores.push(memory.store);
  expect(memory.store.knowledgeRevision(commit)).toMatchObject({ actorRole: "dreaming", parentId: f.item.commit, scope: "project", supports, reason: f.archive.reason });
  expect(memory.store.commitApplies(memory.store.knowledgeRevision(commit)!, f.target)).toBe(true);
  expect(memory.trace(`K${f.item.knowledgeId}@v2`)).toContain(`change supports: F${supports[0]}`);
  expect(memory.trace(`K${f.item.knowledgeId}@v1`)).toContain("rule");
  expect(memory.trace("F1")).toContain("rule");
  expect(memory.search("rule", "knowledge")).toContain("(archived)");
});

// 143's frozen scope is gone; the claim fence is not: a pass whose claim has lapsed or been released writes nothing.
test("an expired Dreamer claim cannot write", () => {
  const f = fixture(), claim = { sessionId: f.target.sessionId, phase: "dreaming" as const, executorId: "test", token: "live", expiresAt: Date.now() + 60_000, borrowed: false, reserved: false };
  f.store.db.prepare("INSERT INTO task_claims (session_id, phase, executor_id, token, expires_at, borrowed, reserved) VALUES (?, 'dreaming', 'test', 'live', ?, 0, 0)")
    .run(claim.sessionId, claim.expiresAt);
  const run = { ...f.run, claim };
  const before = f.store.listKnowledgeRevisions();
  f.store.releaseClaim(claim);
  expect(() => f.pass([f.archive], run)).toThrow(/claim/);
  expect(f.store.listKnowledgeRevisions()).toEqual(before);
});
