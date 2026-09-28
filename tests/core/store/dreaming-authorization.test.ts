import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store, type RunInput } from "../../../src/core/store/index.ts";
import { session as seedSession, entry as seedEntry, legacyFact, knowledge as seedKnowledge } from "../../support/seed.ts";

const stores: Store[] = [], directories: string[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(path = ":memory:") {
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
  const claim = store.acquireClaim(target, "dreaming", "test")!;
  const range = store.retainKnowledgePoolRange(target, `project:${project.id}`, claim);
  const run: RunInput = { kind: "dreaming", sessionId: session.id, branch: "main", claim, dreamingRangeId: range.id, executionId: store.beginExecution({ sessionId: session.id, phase: "dreaming", head: range.anchor, origin: range.origin }), createdAt: "now" };
  const archive = { op: "archive" as const, kind: "budget" as const, knowledgeId: item.knowledgeId, baseCommit: item.commit, supports: [], reason: "Retire lower-priority active memory; history retained", createdAt: "now" };
  return { store, content, item, target, run, archive };
}

test("64b: writer branch visibility rejects a live session base atomically while visible bases remain writable", () => {
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
    const claim = store.acquireClaim(target, "dreaming", `writer-${writerBranch}`)!;
    const range = store.retainKnowledgePoolRange(target, `project:${project.id}`, claim);
    const raw: RunInput = { kind: "dreaming", sessionId: session.id, branch: writerBranch, claim, dreamingRangeId: range.id,
      executionId: store.beginExecution({ sessionId: session.id, phase: "dreaming", head: range.anchor, origin: range.origin }), createdAt: "now" };
    return { store, session, target, run: store.bindDreamingRun(raw), sessionBase, projectBase, globalBase, writerFact };
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
  const rejected = wrong.store.commitConsolidationRun({ run: wrong.run, path: wrong.target, operations: [
    operation(wrong.projectBase, wrong.writerFact.id, "project would otherwise commit"),
    operation(wrong.sessionBase, wrong.writerFact.id, "session invisible on right"),
  ] });
  expect(rejected.ok).toBe(false);
  expect(wrong.store.listKnowledgeRevisions()).toEqual(before);

  const correct = setup("left");
  const accepted = correct.store.commitConsolidationRun({ run: correct.run, path: correct.target, operations: [
    operation(correct.projectBase, correct.writerFact.id, "project visible on left"),
  ] });
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect(accepted.committed).toHaveLength(1);
});

test("64b: only a trusted Dreamer may submit empty supports, which inherit the exact parent supports", () => {
  const f = fixture();
  expect(f.store.commitConsolidationRun({ run: f.run, path: f.target, operations: [f.archive] }).ok).toBe(false);
  const bound = f.store.bindDreamingRun(f.run);
  const accepted = f.store.commitConsolidationRun({ run: bound, path: f.target, operations: [f.archive] });
  expect(accepted.ok).toBe(true);
  if (!accepted.ok) return;
  const revision = f.store.knowledgeRevision(accepted.committed[0]!.commit)!;
  expect(revision.actorRole).toBe("dreaming");
  expect(revision.parentId).toBe(f.item.commit);
  expect(revision.supports).toEqual(f.content.supports);
  expect(f.store.listFactsByRun(f.store.dreamingRunId(bound)!)).toEqual([]);
  expect(f.store.currentKnowledge(f.target)).toEqual([]);
  expect(f.store.db.prepare("SELECT 1 FROM knowledge_processed WHERE revision_id = ?").get(revision.id)).toBeUndefined();
});

test.each(["update", "archive"] as const)("64b: empty-support %s materializes the parent's supports", op => {
  const f = fixture();
  const run = f.store.bindDreamingRun(f.run);
  const operation = op === "archive" ? f.archive : { op, knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit,
    text: "maintained rule", category: "constraint" as const, scope: "project" as const, supports: [],
    topics: [], reason: "Maintenance rewrite.", createdAt: "now" };
  const result = f.store.commitConsolidationRun({ run, path: f.target, operations: [operation] });
  expect(result.ok).toBe(true);
  if (result.ok) expect(f.store.knowledgeRevision(result.committed[0]!.commit)?.supports).toEqual(f.content.supports);
});

test("64b: empty-support merge unions both exact parents and split copies its exact parent", () => {
  const merged = fixture();
  const mergedEntry = merged.store.getSourceEntry(merged.target.triggerEntryId!)!;
  const secondFact = legacyFact(merged.store, merged.target,
    [{ entry: mergedEntry, address: `T${merged.target.headTurnId}#user` }], "second rule", "decision");
  const second = merged.store.commitConsolidationRun({ run: { kind: "manual", sessionId: merged.target.sessionId, createdAt: "now" }, operations: [{
    op: "create", handle: "$2", author: "test", ...merged.content, text: "second rule", supports: [secondFact.id],
  }] });
  if (!second.ok) throw Error(second.problems.join());
  const run = merged.store.bindDreamingRun(merged.run);
  const merge = merged.store.commitConsolidationRun({ run, path: merged.target, operations: [{ op: "merge",
    intoKnowledgeId: merged.item.knowledgeId, intoBaseCommit: merged.item.commit,
    absorb: [{ knowledgeId: second.committed[0]!.knowledgeId, baseCommit: second.committed[0]!.commit }],
    text: "merged rules", category: "constraint", scope: "project", supports: [], topics: [], reason: "Merge redundancy.", createdAt: "now",
  }] });
  expect(merge.ok).toBe(true);
  if (merge.ok) expect(merged.store.knowledgeRevision(merge.committed[0]!.commit)?.supports)
    .toEqual([merged.content.supports[0], secondFact.id]);

  const split = fixture();
  const splitRun = split.store.bindDreamingRun(split.run);
  const result = split.store.commitConsolidationRun({ run: splitRun, path: split.target, operations: [{ op: "split",
    knowledgeId: split.item.knowledgeId, baseCommit: split.item.commit, supports: [], reason: "Separate claims.", createdAt: "now",
    children: [{ text: "first", category: "constraint", topics: [] }, { text: "second", category: "constraint", topics: [] }],
  }] });
  expect(result.ok).toBe(true);
  if (result.ok) expect(result.committed.map(value => split.store.knowledgeRevision(value.commit)!.supports))
    .toEqual([split.content.supports, split.content.supports]);
});

test("64b: explicit evidence is not augmented and invalid evidence rolls back the whole batch", () => {
  const f = fixture();
  const evidence = legacyFact(f.store, f.target,
    [{ entry: f.store.getSourceEntry(f.target.triggerEntryId!)!, address: `T${f.target.headTurnId}#user` }], "replacement evidence", "decision");
  const another = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{
    op: "create", handle: "$2", author: "test", ...f.content, text: "another rule",
  }] });
  if (!another.ok) throw Error(another.problems.join());
  const run = f.store.bindDreamingRun(f.run);
  const before = f.store.listKnowledgeRevisions();
  const invalid = f.store.commitConsolidationRun({ run, path: f.target, operations: [
    { op: "update", knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit, text: "evidence rewrite", category: "constraint", scope: "project",
      supports: [evidence.id], topics: [], reason: "Apply evidence.", createdAt: "now" },
    { op: "archive", kind: "budget", knowledgeId: another.committed[0]!.knowledgeId, baseCommit: another.committed[0]!.commit,
      supports: [999_999], reason: "Invalid evidence.", createdAt: "now" },
  ] });
  expect(invalid.ok).toBe(false);
  expect(f.store.listKnowledgeRevisions()).toEqual(before);
  const accepted = f.store.commitConsolidationRun({ run, path: f.target, operations: [{ op: "update",
    knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit, text: "evidence rewrite", category: "constraint", scope: "project",
    supports: [evidence.id], topics: [], reason: "Apply evidence.", createdAt: "now",
  }] });
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect(f.store.knowledgeRevision(accepted.committed[0]!.commit)?.supports).toEqual([evidence.id]);
});

test("64b: empty legacy parent support remains empty and Dreamer admission needs no trigger entry", () => {
  const f = fixture();
  f.store.db.prepare("UPDATE knowledge_revisions SET supports = '[]' WHERE id = ?").run(f.item.commit);
  f.store.db.prepare("UPDATE dreaming_ranges SET origin_session_id = NULL, origin_entry_ids = NULL WHERE id = ?").run(f.run.dreamingRangeId!);
  const run = f.store.bindDreamingRun(f.run);
  const result = f.store.commitConsolidationRun({ run, path: f.target, operations: [f.archive] });
  expect(result.ok).toBe(true);
  if (result.ok) expect(f.store.knowledgeRevision(result.committed[0]!.commit)?.supports).toEqual([]);
  expect(f.store.listFactsByRun(f.store.dreamingRunId(run)!)).toEqual([]);
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

test("64b: inherited archive provenance and direct-support applicability survive reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-provenance-")); directories.push(dir);
  const db = join(dir, "memory.sqlite"), f = fixture(db);
  const sibling = f.store.appendTurn({ sessionId: f.target.sessionId, kind: "turn", userPrompt: "sibling", startedAt: "now" });
  const siblingEntry = f.store.appendSourceEntry({ sessionId: f.target.sessionId, turnId: sibling.id, nativeLineage: "fixture",
    nativeId: "sibling", role: "user", text: "sibling", raw: "sibling", calls: [] });
  f.store.selectSourcePath(f.target.sessionId, "sibling", [siblingEntry.id]);
  const siblingPath = { ...f.target, branch: "sibling", headTurnId: sibling.id };
  const bound = f.store.bindDreamingRun(f.run);
  const result = f.store.commitConsolidationRun({ run: bound, path: f.target, operations: [f.archive] });
  if (!result.ok) throw Error(result.problems.join());
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
  expect(memory.search("rule", "knowledge", { versions: "all", fields: ["text", "status"] })).toContain("status: archived");
});

test("64b: the seat claim, not a frozen family, fences the atomic Store write", () => {
  const f = fixture(), run = f.store.bindDreamingRun(f.run);
  const outside = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", ...f.content }] });
  if (!outside.ok) throw Error(outside.problems.join());
  const item = outside.committed[0]!;
  const accepted = f.store.commitConsolidationRun({ run, path: f.target, operations: [f.archive,
    { ...f.archive, knowledgeId: item.knowledgeId, baseCommit: item.commit }] });
  expect(accepted.ok).toBe(true);
  if (accepted.ok) expect(accepted.committed).toHaveLength(2);

  const expired = fixture(), expiredRun = expired.store.bindDreamingRun(expired.run);
  const before = expired.store.listKnowledgeRevisions();
  expired.store.releaseClaim(expired.run.claim!);
  expect(expired.store.commitConsolidationRun({ run: expiredRun, path: expired.target, operations: [expired.archive] }).ok).toBe(false);
  expect(expired.store.listKnowledgeRevisions()).toEqual(before);
});


test("32d: create plus merge is not a split; rejection has zero batch side effects", () => {
  const f = fixture();
  const other = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", ...f.content }] });
  if (!other.ok) throw Error(other.problems.join());
  const item = other.committed[0]!;
  // Both parents are current; this is an operation-type violation, not a stale-base rejection.
  const run = f.store.bindDreamingRun(f.run);
  const before = { revisions: f.store.listKnowledgeRevisions(), range: f.store.dreamingRange(f.run.dreamingRangeId!), links: f.store.listKnowledgeLinks(f.item.knowledgeId) };
  const merge = { op: "merge" as const, intoKnowledgeId: f.item.knowledgeId, intoBaseCommit: f.item.commit, absorb: [{ knowledgeId: item.knowledgeId, baseCommit: item.commit }], ...f.content };
  const result = f.store.commitConsolidationRun({ run, path: f.target, operations: [{ op: "create", handle: "$split", author: "test", ...f.content }, merge] });
  expect(result.ok).toBe(false);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.dreamingRange(f.run.dreamingRangeId!)).toEqual(before.range);
  expect(f.store.listKnowledgeLinks(f.item.knowledgeId)).toEqual(before.links);
  expect(f.store.commitConsolidationRun({ run, path: f.target, operations: [merge] }).ok).toBe(true);
});

test("44: trusted Dreamer is bound by the older merge-survivor rule", () => {
  const f = fixture();
  const newer = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" },
    operations: [{ op: "create", handle: "$2", author: "test", ...f.content, text: "duplicate" }] });
  if (!newer.ok) throw Error(newer.problems.join());
  const item = newer.committed[0]!;
  const run = f.store.bindDreamingRun(f.run);
  const reverse = f.store.commitConsolidationRun({ run, path: f.target, operations: [{ op: "merge",
    intoKnowledgeId: item.knowledgeId, intoBaseCommit: item.commit,
    absorb: [{ knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit }], ...f.content }] });
  expect(reverse.ok).toBe(false);
  if (!reverse.ok) expect(reverse.problems.join(" ")).toContain(`use K${f.item.knowledgeId}@${f.item.commit} as the survivor`);
  expect(f.store.currentCommit(f.item.knowledgeId, f.target)[0]!.id).toBe(f.item.commit);
  expect(f.store.currentCommit(item.knowledgeId, f.target)[0]!.id).toBe(item.commit);
  const accepted = f.store.commitConsolidationRun({ run, path: f.target, operations: [{ op: "merge",
    intoKnowledgeId: f.item.knowledgeId, intoBaseCommit: f.item.commit,
    absorb: [{ knowledgeId: item.knowledgeId, baseCommit: item.commit }], ...f.content }] });
  expect(accepted.ok).toBe(true);
});

test.each(["update", "archive"] as const)("34a: create plus authorized family %s cannot impersonate an explicit split", op => {
  const f = fixture(), run = f.store.bindDreamingRun(f.run);
  const result = f.store.commitConsolidationRun({ run, path: f.target, operations: [
    { op: "create", handle: "$split", author: "test", ...f.content },
    op === "archive" ? { ...f.archive, supports: [] } : { ...f.content, op: "update", knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit },
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
