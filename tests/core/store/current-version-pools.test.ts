import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tokens } from "../../../src/core/render/index.ts";
import * as rendering from "../../../src/core/render/index.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store, type RunInput, type TaskClaim } from "../../../src/core/store/index.ts";
import { declarationContext } from "../project-declaration-context.ts";

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
  const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture",
    nativeId: `evidence-${turn.id}`, role: "user", text: "evidence", raw: "evidence", calls: [] });
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`],
    entryIds: [entry.id], createdAt: "now",
  }] });
  if (noted.ok) expect(store.factEntries(noted.facts[0]!.id)).toEqual([entry.id]);
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
  f.store.completeKnowledgePoolRange(admitted.run, outcome, admitted.range.eventIds);
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

test("85: direct Dreaming claim and range allow below-threshold pending, never an empty over-budget range", () => {
  const f = setup(), pool = `project:${f.project.id}`;
  f.create("project", "long durable rule ".repeat(150));
  consume(f, pool);
  const originalSize = f.store.poolSizes(f.target).find(value => value.pool === pool)!.tokens;
  f.create("project", "short rule");
  const weight = f.store.pendingPoolWeight(pool, f.target);
  const budget = originalSize - 1;
  expect(weight).toBeLessThan(budget);
  f.store.setKnowledgeBudget("project", budget);
  expect(f.store.duePools(f.target)).toEqual([]);
  expect(f.store.admitKnowledgePool(f.target, "auto").outcome).toBe("empty");
  const held = claim(f);
  expect(() => f.store.freezeKnowledgePool(f.target, held)).toThrow(/No Knowledge pool is due/);
  const range = f.store.retainKnowledgePoolRange(f.target, pool, held);
  expect(range.eventIds).toHaveLength(1);
  const executionId = f.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = f.store.bindDreamingRun({ kind: "dreaming", sessionId: f.session.id, branch: "main",
    dreamingRangeId: range.id, executionId, claim: held, createdAt: "now" });
  f.store.completeKnowledgePoolRange(run, "success", range.eventIds);
  f.store.releaseClaim(held);
  f.store.setKnowledgeBudget("project", 0);
  expect(f.store.duePools(f.target)).toEqual([]);
  expect(f.store.acquireClaim(f.target, "dreaming", "empty")).toBeNull();
  expect(f.store.admitKnowledgePool(f.target, "auto").outcome).toBe("empty");
});

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

  const archived = f.store.commitConsolidationRun({ run: admitted.run, path: f.target, operations: [{ op: "archive", kind: "budget",
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
  f.store.declareProject(f.session.id, q.name, "mark", declarationContext(f.store, f.target));
  expect(f.store.pendingVersions(`project:${q.id}`, f.target)).toMatchObject([{ revisionId: projectItem.commit }]);
  expect(f.store.pendingVersions(`project:${q.id}`, f.target)[0]!.material).not.toContain("moved from");
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toEqual(beforeGlobal);
  expect(f.store.pendingVersions(`session:${f.session.id}`, f.target).map(v => v.revisionId)).toEqual(beforeSession);
  f.store.declareProject(f.session.id, f.project.name, "mark", declarationContext(f.store, f.target));
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(v => v.revisionId)).toEqual([projectItem.commit]);
  expect([globalItem.commit, sessionItem.commit]).toEqual([beforeGlobal[0], beforeSession[0]]);
  expect(f.store.getProject(f.project.id)!.mergedInto).toBeNull();
  expect(f.store.getProject(q.id)!.mergedInto).toBeNull();
  expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'knowledge_event%'").all()).toEqual([]);
});

test.each(["update", "archive", "split"] as const)("64c pool authority: global run rejects a project %s base without side effects", op => {
  const f = setup(), global = f.create("global"), project = f.create("project"), admitted = begin(f, "global");
  const operation = op === "update" ? { op, knowledgeId: project.knowledgeId, baseCommit: project.commit,
    text: "forbidden", category: "constraint" as const, scope: "project" as const, supports: [], topics: [], reason: "cross pool", createdAt: "now" }
    : op === "archive" ? { op, kind: "budget" as const, knowledgeId: project.knowledgeId, baseCommit: project.commit, supports: [], reason: "cross pool", createdAt: "now" }
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
    { op: "archive", kind: "budget", knowledgeId: project.knowledgeId, baseCommit: project.commit, supports: [], reason: "wrong pool", createdAt: "now" },
  ] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain(`outside Dreamer pool global`);
  expect(f.store.listKnowledgeRevisions()).toEqual(before);
  expect(f.store.currentCommit(global.knowledgeId, f.target)[0]!.id).toBe(global.commit);
});

test.each(["success", "failure"] as const)("64c current versions: %s records the frozen range and leaves later external revisions pending", outcome => {
  const f = setup(), first = f.create("global", "first"), admitted = begin(f, "global");
  const later = f.create("global", "later external");
  f.store.completeKnowledgePoolRange(admitted.run, outcome, admitted.range.eventIds);
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
    { pool: `project:${f.project.id}`, revision_id: changed.commit },
  ]);
});

test("85: pending residual eligibility survives reopen without pool suppression state", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm-64c-residual-")), path = join(directory, "trace.db");
  try {
    const f = setup(new Store(path));
    for (let i = 0; i < 14; i++) f.create("project", `rule ${i} ` + "words ".repeat(800));
    const pool = `project:${f.project.id}`;
    expect(tokens(["Pending current knowledge:", ...f.store.pendingVersions(pool, f.target).map(value => value.material)].join("\n"))).toBeGreaterThan(10_000);
    f.store.setKnowledgeBudget("project", 30_000);
    consume(f, pool);
    expect(f.store.pendingPoolWeight(pool, f.target)).toBeGreaterThan(0);
    expect(f.store.duePools(f.target, 1).map(value => value.pool)).toContain(pool);
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();

    const reopened = new Store(path); stores.push(reopened);
    expect(reopened.pendingPoolWeight(pool, f.target)).toBeGreaterThan(0);
    expect(reopened.duePools(f.target, 1).map(value => value.pool)).toContain(pool);
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

test("67: pool reads batch graph, processing history and rendering independently of identity count", () => {
  const f = setup();
  const graphInput = vi.spyOn(f.store, "commitGraphInput"), graph = vi.spyOn(f.store, "commitGraph");
  const prepare = vi.spyOn(f.store.db, "prepare"), render = vi.spyOn(rendering, "renderKnowledge");
  try {
    for (const count of [3, 60]) {
      for (let i = count === 3 ? 0 : 3; i < count; i++) f.create((["global", "project", "session"] as const)[i % 3]!);
      graphInput.mockClear(); graph.mockClear(); prepare.mockClear(); render.mockClear();
      const start = performance.now();
      const pools = f.store.knowledgePools(f.target);
      const elapsedMs = performance.now() - start;
      expect(pools.flatMap(pool => pool.versions)).toHaveLength(count);
      expect(pools.flatMap(pool => pool.pending)).toHaveLength(count);
      expect(graphInput).toHaveBeenCalledTimes(1);
      expect(graph).toHaveBeenCalledTimes(1);
      expect(render).toHaveBeenCalledTimes(count);
      // Ticket 80: the graph memo's own cache check runs `progressSignal`, whose one combined query
      // also mentions "FROM knowledge_processed" in passing (its `kp` column) — match the exact
      // processing-history query `knowledgePools` itself issues, not that substring.
      expect(prepare.mock.calls.filter(([sql]) => sql.includes("SELECT p.pool, p.revision_id FROM knowledge_processed"))).toHaveLength(1);
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(25);
      console.info(JSON.stringify({ fixture: "67 pool projection", count, elapsedMs, prepares: prepare.mock.calls.length }));
    }
    graphInput.mockClear();
    f.store.duePools(f.target);
    expect(graphInput).toHaveBeenCalledTimes(1);
  } finally { graphInput.mockRestore(); graph.mockRestore(); prepare.mockRestore(); render.mockRestore(); }
});

test.each(["current", "archive-parent"] as const)("92: pool metadata batching rejects a missing %s version tag", shape => {
  const f = setup(), item = f.create("global");
  if (shape === "archive-parent") {
    const archived = f.store.commitConsolidationRun({ path: f.target,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
      operations: [{ op: "archive", kind: "budget", knowledgeId: item.knowledgeId, baseCommit: item.commit,
        supports: [f.fact.id], reason: "Retire body", createdAt: "now" }] });
    expect(archived.ok).toBe(true);
  }
  expect(f.store.knowledgePools(f.target).flatMap(pool => pool.pending)).toHaveLength(1);
  f.store.db.prepare("DELETE FROM knowledge_version_tags WHERE commit_id = ?").run(item.commit);
  expect(() => f.store.knowledgePools(f.target)).toThrow(`unknown knowledge version K${item.knowledgeId}`);
  expect(f.store.db.prepare("SELECT * FROM knowledge_version_tags WHERE commit_id = ?").get(item.commit)).toBeUndefined();
});

test("67: create batches skip writer graphs while consuming operations recheck after prior mutations", () => {
  const f = setup(), graph = vi.spyOn(f.store, "commitGraphInput");
  try {
    const operations = Array.from({ length: 30 }, (_, i) => ({ op: "create" as const, handle: `$${i}`, author: "test",
      text: `body ${i}`, category: "constraint" as const, scope: "global" as const, supports: [f.fact.id], topics: [], reason: "test", createdAt: "now" }));
    const created = f.store.commitConsolidationRun({ path: f.target,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" }, operations });
    expect(created.ok).toBe(true);
    expect(graph).not.toHaveBeenCalled();
    const before = f.store.listKnowledgeRevisions();
    const bad = f.store.commitConsolidationRun({ path: f.target,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
      operations: [operations[0]!, { ...operations[1]!, supports: [999_999] }] });
    expect(bad.ok).toBe(false);
    expect(f.store.listKnowledgeRevisions()).toEqual(before);
    const base = before[0]!;
    const archive = { op: "archive" as const, kind: "budget" as const, knowledgeId: base.knowledgeId, baseCommit: base.id,
      supports: [f.fact.id], reason: "test", createdAt: "now" };
    graph.mockClear();
    const consumed = f.store.commitConsolidationRun({ path: f.target,
      run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" }, operations: [archive, archive] });
    expect(consumed.ok).toBe(false);
    expect(graph).toHaveBeenCalledTimes(2);
    expect(f.store.listKnowledgeRevisions()).toEqual(before);
  } finally { graph.mockRestore(); }
});

test("85: freeze builds one pool projection; terminal consumption no longer reads pool suppression state", () => {
  const f = setup();
  f.store.setKnowledgeBudget("global", 100);
  const first = f.create("global", "evidence ".repeat(25));
  f.create("project");
  const held = claim(f), graph = vi.spyOn(f.store, "commitGraphInput");
  try {
    const frozen = f.store.freezeKnowledgePool(f.target, held, 1);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(frozen.pool.pool).toBe("global");
    expect(frozen.range.eventIds).toContain(first.commit);
    const executionId = f.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", head: frozen.range.anchor, origin: frozen.range.origin });
    const run = f.store.bindDreamingRun({ kind: "dreaming", sessionId: f.session.id, branch: "main",
      dreamingRangeId: frozen.range.id, executionId, claim: held, createdAt: "now" });
    const own = update(f, run, first, "maintained body");
    graph.mockClear();
    f.store.completeKnowledgePoolRange(run, "success");
    expect(graph).not.toHaveBeenCalled();
    expect(f.store.pendingVersions("global", f.target)).toEqual([]);
    expect(f.store.poolVersions("global", f.target).map(value => value.revision.id)).toEqual([own.commit]);
    expect(f.store.pendingVersions(`project:${f.project.id}`, f.target)).toHaveLength(1);
  } finally { graph.mockRestore(); }
});

test("67: atomic admission preserves competing seats, reserved takeover and expired-claim fences", () => {
  const f = setup(), other = setup(f.store, "B");
  f.store.setKnowledgeBudget("global", 100);
  f.create("global", "evidence ".repeat(25));
  const first = f.store.admitKnowledgePool(f.target, "first", false, undefined, 1);
  expect(first.outcome).toBe("admitted");
  if (first.outcome !== "admitted") throw new Error("first admission failed");
  expect(f.store.admitKnowledgePool(other.target, "competitor", false, undefined, 1)).toEqual({ outcome: "dropped" });
  expect(f.store.admitKnowledgePool(f.target, "first", false, undefined, 1)).toEqual({ outcome: "dropped" });
  expect(f.store.getClaim(f.session.id, "dreaming")!.token).toBe(first.claim.token);

  f.store.reopenSession(f.session.id, "replacement");
  const reserved = f.store.getClaim(f.session.id, "dreaming")!;
  expect(reserved.reserved).toBe(true);
  const replacement = f.store.admitKnowledgePool(f.target, "replacement", false, undefined, 1);
  expect(replacement.outcome).toBe("admitted");
  if (replacement.outcome !== "admitted") throw new Error("reserved takeover failed");
  expect(replacement.claim.token).toBe(reserved.token);
  expect(replacement.claim.reserved).toBe(false);
  expect(() => f.store.freezeKnowledgePool(f.target, first.claim, 1)).toThrow(/claim/);
  expect(f.store.dreamingRange(first.range.id)).toBeNull();

  f.store.db.prepare("UPDATE task_claims SET expires_at = ? WHERE token = ?").run(Date.now() - 1, replacement.claim.token);
  const competing = f.store.admitKnowledgePool(other.target, "competitor", false, undefined, 1);
  expect(competing.outcome).toBe("admitted");
  expect(() => f.store.freezeKnowledgePool(f.target, replacement.claim, 1)).toThrow(/claim/);
  expect(f.store.dreamingRange(replacement.range.id)).toBeNull();
});

test("67: admission observes intervening knowledge mutation and preserves enrollment/borrowed guards", () => {
  const f = setup(), executor = setup(f.store, "executor");
  f.store.setKnowledgeBudget("global", 100);
  const item = f.create("global", "evidence ".repeat(25));
  expect(f.store.knowledgePools(f.target, 1).some(pool => pool.due)).toBe(true);
  f.store.setEnrollment(executor.session.id, false);
  expect(f.store.admitKnowledgePool(f.target, "executor", false, executor.session.id, 1)).toEqual({ outcome: "dropped" });
  expect(f.store.admitKnowledgePool(f.target, "borrowed", true, undefined, 1)).toEqual({ outcome: "dropped" });
  f.store.setEnrollment(f.session.id, false);
  expect(f.store.admitKnowledgePool(f.target, "disabled", false, undefined, 1)).toEqual({ outcome: "dropped" });
  f.store.setEnrollment(f.session.id, true);
  const archived = f.store.commitConsolidationRun({ path: f.target,
    run: { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" },
    operations: [{ op: "archive", kind: "budget", knowledgeId: item.knowledgeId, baseCommit: item.commit,
      supports: [f.fact.id], reason: "no longer required", createdAt: "now" }] });
  expect(archived.ok).toBe(true);
  expect(f.store.admitKnowledgePool(f.target, "fresh")).toEqual({ outcome: "empty" });
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
});

test("67: facade Dreamer eligibility and explicit pending status each share their pool work", () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("no model expected"); });
  const f = setup(memory.store), graph = vi.spyOn(memory.store, "commitGraphInput");
  try {
    f.create("global"); f.create("project"); f.create("session");
    graph.mockClear();
    expect(memory.taskEligibility("dreaming", f.target).due).toBe(false);
    expect(graph).toHaveBeenCalledTimes(1);
    graph.mockClear();
    expect(memory.dreamingPending(f.target).state).toBe("known");
    expect(graph).toHaveBeenCalledTimes(1);
  } finally { graph.mockRestore(); memory.close(); stores.splice(stores.indexOf(memory.store), 1); }
});

test("64c current versions: same-project relabel is a processing no-op", () => {
  const f = setup(), item = f.create("project");
  consume(f, `project:${f.project.id}`);
  const before = f.store.db.prepare("SELECT * FROM knowledge_processed").all();
  f.store.mergeProject(f.project.id, f.project.id);
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual(before);
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(v => v.revisionId)).not.toContain(item.commit);
});
