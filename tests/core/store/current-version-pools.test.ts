import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tokens } from "../../../src/core/render/index.ts";
import { Store, type RunInput, type TaskClaim } from "../../../src/core/store/index.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

type Fixture = ReturnType<typeof setup>;

function setup(store = new Store(":memory:"), projectName = "A", projectId?: number, host = `${projectName}-${Math.random()}`) {
  if (!stores.includes(store)) stores.push(store);
  const project = projectId === undefined
    ? store.findProjectByName(projectName) ?? store.createProject({ name: projectName, declaredBy: "mark" })
    : store.getProject(projectId)!;
  const session = store.createSession({ host, enrollmentChoice: true, projectId: project.id,
    projectDeclaration: "mark", startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const create = (scope: "global" | "project" | "session", text = `${scope} body`) => {
    const result = store.commitConsolidationRun({ path: target,
      run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: "now" }, operations: [{
        op: "create", handle: "$1", author: "test", text, category: "constraint", scope,
        supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now",
      }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  return { store, project, session, turn, fact: noted.facts[0]!, target, create };
}

function claim(f: Fixture, executor = `executor-${Math.random()}`): TaskClaim {
  const value = f.store.acquireClaim(f.target, "dreaming", executor);
  if (!value) throw new Error("claim unavailable");
  return value;
}

function begin(f: Fixture, pool: string, executor?: string) {
  const held = claim(f, executor);
  const range = f.store.retainKnowledgePoolRange(f.target, pool, held);
  const executionId = f.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = f.store.bindDreamingRun({ kind: "dreaming", sessionId: f.session.id, branch: f.target.branch,
    dreamingRangeId: range.id, executionId, claim: held, createdAt: "now" });
  return { held, range, run };
}

function consume(f: Fixture, pool: string, outcome: "success" | "failure" | "cancelled" = "success") {
  const admitted = begin(f, pool);
  f.store.completeKnowledgePoolRange(admitted.run, outcome);
  f.store.releaseClaim(admitted.held);
  return admitted;
}

function update(f: Fixture, run: RunInput, base: { knowledgeId: number; commit: number }, text: string,
  scope: "global" | "project" | "session" = "global") {
  const result = f.store.commitConsolidationRun({ run, path: f.target, operations: [{ op: "update",
    knowledgeId: base.knowledgeId, baseCommit: base.commit, text, category: "constraint", scope,
    supports: [], topics: [], reason: "maintenance", createdAt: "now" }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

test("64c current versions: global is shared, project is shared only within its project, and session stays local", () => {
  const a = setup(), same = setup(a.store, "A", a.project.id), other = setup(a.store, "B");
  const global = a.create("global"), project = a.create("project"), session = a.create("session");
  expect(a.store.pendingVersions("global", a.target).map(v => v.revisionId)).toEqual([global.commit]);
  expect(a.store.pendingVersions("global", other.target).map(v => v.revisionId)).toEqual([global.commit]);
  expect(a.store.pendingVersions(`project:${a.project.id}`, same.target).map(v => v.revisionId)).toEqual([project.commit]);
  expect(a.store.pendingVersions(`project:${other.project.id}`, other.target)).toEqual([]);
  expect(a.store.pendingVersions(`session:${a.session.id}`, a.target).map(v => v.revisionId)).toEqual([session.commit]);
  expect(a.store.pendingVersions(`session:${a.session.id}`, same.target)).toEqual([]);
  consume(a, "global");
  expect(a.store.pendingVersions("global", other.target)).toEqual([]);
  consume(a, `project:${a.project.id}`);
  expect(a.store.pendingVersions(`project:${a.project.id}`, same.target)).toEqual([]);
});

test("64c current versions: repeated updates count once at the latest rendered revision and archives count zero", () => {
  const f = setup(), item = f.create("global", "v1"), admitted = begin(f, "global");
  const v2 = update(f, admitted.run, item, "v2 with more body");
  const v3 = update(f, admitted.run, v2, "v3 is the only current body");
  const pending = f.store.pendingVersions("global", f.target);
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ knowledgeId: item.knowledgeId, revisionId: v3.commit });
  expect(pending[0]!.material).toContain("v3 is the only current body");
  expect(pending[0]!.material).not.toContain("v2 with more body");
  expect(pending[0]!.tokens).toBe(tokens(pending[0]!.material));

  const archived = f.store.commitConsolidationRun({ run: admitted.run, path: f.target, operations: [{ op: "archive",
    knowledgeId: item.knowledgeId, baseCommit: v3.commit, supports: [], reason: "done", createdAt: "now" }] });
  expect(archived.ok).toBe(true);
  expect(f.store.pendingVersions("global", f.target)).toEqual([]);
});

test("64c current versions: session visibility follows the selected branch and rewind to no current does not throw", () => {
  const store = new Store(":memory:"); stores.push(store);
  const project = store.createProject({ name: "branches", declaredBy: "mark" });
  const session = store.createSession({ host: "branches", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const root = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "root", startedAt: "now" });
  const left = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "left", startedAt: "now" });
  const right = store.appendTurn({ sessionId: session.id, parentTurnId: root.id, kind: "turn", userPrompt: "right", startedAt: "now" });
  const entry = (turnId: number, id: string) => store.appendSourceEntry({ sessionId: session.id, turnId, nativeLineage: "native", nativeId: id,
    role: "user", text: id, raw: id, calls: [] });
  const er = entry(root.id, "root"), el = entry(left.id, "left"), eg = entry(right.id, "right");
  store.selectSourcePath(session.id, "left", [er.id, el.id]);
  store.selectSourcePath(session.id, "right", [er.id, eg.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "left", createdAt: "now" }, facts: [{
    turnId: left.id, category: "decision", actor: "user", text: "left evidence", source: [`T${left.id}#user`], entryIds: [el.id], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const made = store.commitConsolidationRun({ path: { sessionId: session.id, branch: "left", headTurnId: left.id },
    run: { kind: "manual", sessionId: session.id, branch: "left", createdAt: "now" }, operations: [{ op: "create", handle: "$1",
      author: "test", text: "left only", category: "constraint", scope: "session", supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now" }] });
  if (!made.ok) throw new Error(made.problems.join("; "));
  store.setCurrentPath(session.id, "left", left.id, "lineage");
  expect(store.pendingVersions(`session:${session.id}`, { sessionId: session.id, branch: "left", headTurnId: left.id })).toHaveLength(1);
  store.setCurrentPath(session.id, "right", right.id, "lineage");
  expect(store.pendingVersions(`session:${session.id}`, { sessionId: session.id, branch: "right", headTurnId: right.id })).toEqual([]);
});

test("64c current versions: merge absorption yields one current identity and split yields two", () => {
  const merged = setup(), first = merged.create("global", "first"), second = merged.create("global", "second"), mergeRun = begin(merged, "global");
  const merge = merged.store.commitConsolidationRun({ run: mergeRun.run, path: merged.target, operations: [{ op: "merge",
    intoKnowledgeId: first.knowledgeId, intoBaseCommit: first.commit, absorb: [{ knowledgeId: second.knowledgeId, baseCommit: second.commit }],
    text: "merged", category: "constraint", scope: "global", supports: [], topics: [], reason: "deduplicate", createdAt: "now" }] });
  if (!merge.ok) throw new Error(merge.problems.join("; "));
  expect(merged.store.pendingVersions("global", merged.target).map(v => v.revisionId)).toEqual([merge.committed[0]!.commit]);

  const split = setup(), parent = split.create("global", "mixed"), splitRun = begin(split, "global");
  const result = split.store.commitConsolidationRun({ run: splitRun.run, path: split.target, operations: [{ op: "split",
    knowledgeId: parent.knowledgeId, baseCommit: parent.commit, supports: [], reason: "separate", createdAt: "now",
    children: [{ text: "one", category: "constraint", topics: [] }, { text: "two", category: "constraint", topics: [] }] }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  expect(split.store.pendingVersions("global", split.target).map(v => v.revisionId)).toEqual(result.committed.map(v => v.commit));
});

test("64c current versions: legal P to Q to P declarations preserve pair semantics and an acyclic project graph", () => {
  const f = setup(), projectItem = f.create("project"), globalItem = f.create("global"), sessionItem = f.create("session");
  consume(f, `project:${f.project.id}`);
  const beforeGlobal = f.store.pendingVersions("global", f.target).map(v => v.revisionId);
  const beforeSession = f.store.pendingVersions(`session:${f.session.id}`, f.target).map(v => v.revisionId);
  const q = f.store.createProject({ name: "Q", declaredBy: "mark" });
  f.store.declareProject(f.session.id, q.name, "mark");
  expect(f.store.pendingVersions(`project:${q.id}`, f.target)).toMatchObject([{ revisionId: projectItem.commit }]);
  expect(f.store.pendingVersions(`project:${q.id}`, f.target)[0]!.material).not.toContain("moved from");
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toEqual(beforeGlobal);
  expect(f.store.pendingVersions(`session:${f.session.id}`, f.target).map(v => v.revisionId)).toEqual(beforeSession);
  f.store.declareProject(f.session.id, f.project.name, "mark");
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target)).toEqual([]);
  expect([globalItem.commit, sessionItem.commit]).toEqual([beforeGlobal[0], beforeSession[0]]);
  expect(f.store.getProject(f.project.id)!.mergedInto).toBeNull();
  expect(f.store.getProject(q.id)!.mergedInto).toBeNull();
  expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_event%'").all()).toEqual([]);
});

test.each(["update", "archive", "split"] as const)("64c pool authority: global run rejects a project %s base without side effects", op => {
  const f = setup(), global = f.create("global"), project = f.create("project"), admitted = begin(f, "global");
  const operation = op === "update" ? { op, knowledgeId: project.knowledgeId, baseCommit: project.commit,
    text: "forbidden", category: "constraint" as const, scope: "project" as const, supports: [], topics: [], reason: "cross pool", createdAt: "now" }
    : op === "archive" ? { op, knowledgeId: project.knowledgeId, baseCommit: project.commit, supports: [], reason: "cross pool", createdAt: "now" }
    : { op, knowledgeId: project.knowledgeId, baseCommit: project.commit, supports: [], reason: "cross pool", createdAt: "now",
      children: [{ text: "one", category: "constraint" as const, topics: [] }, { text: "two", category: "constraint" as const, topics: [] }] };
  const before = { revisions: f.store.listKnowledgeRevisions(), links: f.store.listKnowledgeLinks(project.knowledgeId) };
  const result = f.store.commitConsolidationRun({ run: admitted.run, path: f.target, operations: [operation] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain(`outside Dreamer pool global`);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.listKnowledgeLinks(project.knowledgeId)).toEqual(before.links);
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toContain(global.commit);
});

test("64c pool authority: every merge parent must belong to the frozen pool", () => {
  const f = setup(), global = f.create("global"), project = f.create("project"), admitted = begin(f, "global");
  const before = { revisions: f.store.listKnowledgeRevisions(), links: f.store.listKnowledgeLinks(project.knowledgeId) };
  const result = f.store.commitConsolidationRun({ run: admitted.run, path: f.target, operations: [{ op: "merge",
    intoKnowledgeId: global.knowledgeId, intoBaseCommit: global.commit,
    absorb: [{ knowledgeId: project.knowledgeId, baseCommit: project.commit }], text: "forbidden merge",
    category: "constraint", scope: "global", supports: [], topics: [], reason: "cross pool", createdAt: "now" }] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain(`outside Dreamer pool global`);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.listKnowledgeLinks(project.knowledgeId)).toEqual(before.links);
});

test("64c pool authority: a valid same-pool write followed by a wrong-pool base rolls the whole batch back", () => {
  const f = setup(), global = f.create("global"), project = f.create("project"), admitted = begin(f, "global");
  const before = f.store.listKnowledgeRevisions();
  const result = f.store.commitConsolidationRun({ run: admitted.run, path: f.target, operations: [
    { op: "update", knowledgeId: global.knowledgeId, baseCommit: global.commit, text: "would commit", category: "constraint",
      scope: "global", supports: [], topics: [], reason: "same pool", createdAt: "now" },
    { op: "archive", knowledgeId: project.knowledgeId, baseCommit: project.commit, supports: [], reason: "wrong pool", createdAt: "now" },
  ] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain(`outside Dreamer pool global`);
  expect(f.store.listKnowledgeRevisions()).toEqual(before);
  expect(f.store.currentCommit(global.knowledgeId, f.target)[0]!.id).toBe(global.commit);
});

test.each(["success", "failure"] as const)("64c current versions: %s records the frozen range and leaves later external revisions pending", outcome => {
  const f = setup(), first = f.create("global", "first"), admitted = begin(f, "global");
  const later = f.create("global", "later external");
  f.store.completeKnowledgePoolRange(admitted.run, outcome);
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toEqual([later.commit]);
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed ORDER BY revision_id").all())
    .toContainEqual({ pool: "global", revision_id: first.commit });
});

test("64c current versions: cancellation before the first commit records nothing and releases the reservation", () => {
  const f = setup(), item = f.create("global"), first = begin(f, "global", "first");
  f.store.completeKnowledgePoolRange(first.run, "cancelled");
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toEqual([item.commit]);
  f.store.releaseClaim(first.held);
  const second = begin(f, "global", "second");
  expect(second.range.eventIds).toEqual(first.range.eventIds);
});

test.each(["cancelled", "failure"] as const)("64c current versions: %s after a real scope-changing commit processes range and output owners", outcome => {
  const f = setup(), item = f.create("global"), admitted = begin(f, "global");
  const changed = update(f, admitted.run, item, "narrowed", "project");
  f.store.completeKnowledgePoolRange(admitted.run, outcome);
  expect(f.store.pendingVersions("global", f.target)).toEqual([]);
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target)).toEqual([]);
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed ORDER BY revision_id").all()).toEqual([
    { pool: "global", revision_id: item.commit }, { pool: `project:${f.project.id}`, revision_id: changed.commit },
  ]);
});

test("64c over-budget residual baseline survives reopen without becoming a validity state", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-64c-residual-")), path = join(directory, "trace.db");
  try {
    const f = setup(new Store(path));
    f.create("project", "words ".repeat(250));
    f.create("project", "words ".repeat(250));
    f.create("project", "words ".repeat(250));
    const pool = `project:${f.project.id}`, weights = f.store.pendingVersions(pool, f.target).map(value => value.tokens);
    f.store.setKnowledgeBudget("project", Math.floor(Math.max(...weights) * 2.5));
    consume(f, pool);
    expect(f.store.pendingPoolWeight(pool, f.target)).toBeGreaterThan(0);
    expect(f.store.duePools(f.target).map(value => value.pool)).not.toContain(pool);
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();

    const reopened = new Store(path); stores.push(reopened);
    expect(reopened.pendingPoolWeight(pool, f.target)).toBeGreaterThan(0);
    expect(reopened.duePools(f.target).map(value => value.pool)).not.toContain(pool);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("64c current versions: expired ownership does not reserve revisions and the stale runner cannot record", () => {
  const f = setup(), item = f.create("global"), stale = begin(f, "global", "stale");
  f.store.invalidateExecutor("stale");
  const replacementClaim = claim(f, "replacement");
  const replacement = f.store.retainKnowledgePoolRange(f.target, "global", replacementClaim);
  expect(replacement.eventIds).toEqual([item.commit]);
  expect(() => f.store.completeKnowledgePoolRange(stale.run, "failure")).toThrow(/no longer current and unexpired/);
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toEqual([item.commit]);
});

test("64c current versions: same-project relabel is a processing no-op", () => {
  const f = setup(), item = f.create("project");
  consume(f, `project:${f.project.id}`);
  const before = f.store.db.prepare("SELECT * FROM knowledge_processed").all();
  f.store.mergeProject(f.project.id, f.project.id);
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual(before);
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(v => v.revisionId)).not.toContain(item.commit);
});
