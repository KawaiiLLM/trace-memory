import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tokens } from "../../../src/core/render/index.ts";
import * as rendering from "../../../src/core/render/index.ts";
import { TraceMemory, type DreamingAgentInput } from "../../../src/core/api/index.ts";
import { skipRest, suppliedHandles } from "../../dreaming-skips.ts";
import { Store, type RunInput, type TaskClaim } from "../../../src/core/store/index.ts";
import { declarationContext } from "../project-declaration-context.ts";
import { ALL_POOLS } from "../../../src/core/store/processing.ts";
import { archive, clearSupports, entry, knowledgeBatch, legacyFacts, updateKnowledge } from "../../support/seed.ts";

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
        op: "create", title: "Fixture title", handle: "$1", author: "test", text, category: "constraint", scope,
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

function begin(f: Fixture, executor?: string) {
  const held = claim(f, executor);
  const range = f.store.retainKnowledgePoolRange(f.target, held);
  const executionId = f.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", origin: range.origin });
  const run = f.store.bindDreamingRun({ kind: "dreaming", sessionId: f.session.id, branch: f.target.branch,
    dreamingRangeId: range.id, executionId, claim: held, createdAt: "now" });
  return { held, range, run };
}

function consume(f: Fixture, outcome: "success" | "failure" | "cancelled" = "success") {
  const admitted = begin(f);
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
  consume(f);
  const originalSize = f.store.poolSizes(f.target).find(value => value.pool === pool)!.tokens;
  f.create("project", "short rule");
  const weight = f.store.pendingPoolWeight(pool, f.target);
  const budget = originalSize - 1;
  expect(weight).toBeLessThan(budget);
  f.store.setKnowledgeBudget("project", budget);
  expect(f.store.dreamingDue(f.target)).toBe(false);
  expect(f.store.admitKnowledgePool(f.target, "auto").outcome).toBe("empty");
  const held = claim(f);
  expect(() => f.store.freezeKnowledgePool(f.target, held)).toThrow(/No Dreamer run is due/);
  const range = f.store.retainKnowledgePoolRange(f.target, held);
  expect(range.eventIds).toHaveLength(1);
  const executionId = f.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", origin: range.origin });
  const run = f.store.bindDreamingRun({ kind: "dreaming", sessionId: f.session.id, branch: "main",
    dreamingRangeId: range.id, executionId, claim: held, createdAt: "now" });
  f.store.completeKnowledgePoolRange(run, "success", range.eventIds);
  f.store.releaseClaim(held);
  f.store.setKnowledgeBudget("project", 0);
  expect(f.store.dreamingDue(f.target)).toBe(false);
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
  consume(a);
  expect(a.store.pendingVersions("global", other.target)).toEqual([]);
  expect(a.store.pendingVersions(`project:${a.project.id}`, same.target)).toEqual([]);
});

test("64c current versions: repeated updates count once at the latest rendered revision and archives count zero", () => {
  const f = setup(), item = f.create("global", "v1"), admitted = begin(f);
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
    run: { kind: "manual", sessionId: session.id, branch: "left", createdAt: "now" }, operations: [{ op: "create", title: "Fixture title", handle: "$1",
      author: "test", text: "left only", category: "constraint", scope: "session", supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now" }] });
  if (!made.ok) throw new Error(made.problems.join("; "));
  store.setCurrentPath(session.id, "left", left.id, "lineage");
  expect(store.pendingVersions(`session:${session.id}`, { sessionId: session.id, branch: "left", headTurnId: left.id })).toHaveLength(1);
  store.setCurrentPath(session.id, "right", right.id, "lineage");
  expect(store.pendingVersions(`session:${session.id}`, { sessionId: session.id, branch: "right", headTurnId: right.id })).toEqual([]);
});

test("64c current versions: merge absorption yields one current identity and split yields the item and its children", () => {
  const merged = setup(), first = merged.create("global", "first"), second = merged.create("global", "second"), mergeRun = begin(merged);
  const merge = merged.store.commitConsolidationRun({ run: mergeRun.run, path: merged.target, operations: [{ op: "merge",
    intoKnowledgeId: first.knowledgeId, intoBaseCommit: first.commit, absorb: [{ knowledgeId: second.knowledgeId, baseCommit: second.commit }],
    text: "merged", category: "constraint", scope: "global", supports: [], topics: [], reason: "deduplicate", createdAt: "now" }] });
  if (!merge.ok) throw new Error(merge.problems.join("; "));
  expect(merged.store.pendingVersions("global", merged.target).map(v => v.revisionId)).toEqual([merge.committed[0]!.commit]);

  const split = setup(), parent = split.create("global", "mixed"), splitRun = begin(split);
  const result = split.store.commitConsolidationRun({ run: splitRun.run, path: split.target, operations: [{ op: "split",
    knowledgeId: parent.knowledgeId, baseCommit: parent.commit, text: "mixed, primary part", category: "constraint", scope: "global", topics: [], supports: [], reason: "separate", createdAt: "now",
    children: [{ title: "Fixture child", text: "one", category: "constraint", topics: [] }, { title: "Fixture child", text: "two", category: "constraint", topics: [] }] }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  // The split item continues as its primary part beside its two children: three current versions.
  expect(result.committed).toHaveLength(3);
  expect(result.committed[0]!.knowledgeId).toBe(parent.knowledgeId);
  expect(split.store.pendingVersions("global", split.target).map(v => v.revisionId)).toEqual(result.committed.map(v => v.commit));
});

test("64c current versions: legal P to Q to P declarations preserve pair semantics and an acyclic project graph", () => {
  const f = setup(), projectItem = f.create("project");
  consume(f);
  const globalItem = f.create("global"), sessionItem = f.create("session");
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

test.each(["update", "archive", "split"] as const)("126 writable set: one run may %s knowledge in each of the session's pools", op => {
  const f = setup(), items = (["global", "project", "session"] as const).map(scope => f.create(scope, `${scope} item`));
  const admitted = begin(f);
  const operation = (base: { knowledgeId: number; commit: number }, scope: "global" | "project" | "session") => op === "update"
    ? { op, knowledgeId: base.knowledgeId, baseCommit: base.commit, text: `${scope} rewritten`, category: "constraint" as const, scope,
      supports: [], topics: [], reason: "maintenance", createdAt: "now" }
    : op === "archive" ? { op, kind: "budget" as const, knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [], reason: "budget", createdAt: "now" }
    : { op, knowledgeId: base.knowledgeId, baseCommit: base.commit, text: `${scope} primary`, category: "constraint" as const, scope, topics: [], supports: [], reason: "separate", createdAt: "now",
      children: [{ title: "Fixture child", text: "one", category: "constraint" as const, topics: [] }, { title: "Fixture child", text: "two", category: "constraint" as const, topics: [] }] };
  const result = f.store.commitConsolidationRun({ run: admitted.run, path: f.target,
    operations: items.map((item, index) => operation(item, (["global", "project", "session"] as const)[index]!)) });
  expect(result.ok, JSON.stringify(result)).toBe(true);
  expect(items.map(item => f.store.currentCommit(item.knowledgeId, f.target)[0]?.id ?? null).every(id => !items.some(item => item.commit === id))).toBe(true);
});

/** Another project's item: never in this session's pools. */
function foreignItem(f: Fixture) {
  const other = setup(f.store, "elsewhere");
  return other.create("project", "another project's item");
}

test.each(["update", "archive", "split"] as const)("126 writable set: a %s base outside the session's pools is rejected without side effects", op => {
  const f = setup(), own = f.create("global"), foreign = foreignItem(f), admitted = begin(f);
  const operation = op === "update" ? { op, knowledgeId: foreign.knowledgeId, baseCommit: foreign.commit,
    text: "forbidden", category: "constraint" as const, scope: "project" as const, supports: [], topics: [], reason: "cross pool", createdAt: "now" }
    : op === "archive" ? { op, kind: "budget" as const, knowledgeId: foreign.knowledgeId, baseCommit: foreign.commit, supports: [], reason: "cross pool", createdAt: "now" }
    : { op, knowledgeId: foreign.knowledgeId, baseCommit: foreign.commit, text: "forbidden", category: "constraint" as const, scope: "project" as const, topics: [], supports: [], reason: "cross pool", createdAt: "now",
      children: [{ title: "Fixture child", text: "one", category: "constraint" as const, topics: [] }, { title: "Fixture child", text: "two", category: "constraint" as const, topics: [] }] };
  const before = { revisions: f.store.listKnowledgeRevisions(), links: f.store.listKnowledgeLinks(foreign.knowledgeId) };
  const result = f.store.commitConsolidationRun({ run: admitted.run, path: f.target, operations: [operation] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain(`outside the Dreamer pools global, project:${f.project.id}, session:${f.session.id}`);
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.listKnowledgeLinks(foreign.knowledgeId)).toEqual(before.links);
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toContain(own.commit);
});

test("64c merge scope: merge parents from two of the session's pools are refused without side effects", () => {
  const f = setup(), global = f.create("global"), project = f.create("project"), admitted = begin(f);
  const before = { revisions: f.store.listKnowledgeRevisions(), links: f.store.listKnowledgeLinks(project.knowledgeId) };
  const result = f.store.commitConsolidationRun({ run: admitted.run, path: f.target, operations: [{ op: "merge",
    intoKnowledgeId: global.knowledgeId, intoBaseCommit: global.commit,
    absorb: [{ knowledgeId: project.knowledgeId, baseCommit: project.commit }], text: "forbidden merge",
    category: "constraint", scope: "global", supports: [], topics: [], reason: "cross pool", createdAt: "now" }] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain("merge parents and result must share one scope");
  expect(f.store.listKnowledgeRevisions()).toEqual(before.revisions);
  expect(f.store.listKnowledgeLinks(project.knowledgeId)).toEqual(before.links);
});

test("64c pool authority: a valid write followed by a base outside the session's pools rolls the whole batch back", () => {
  const f = setup(), global = f.create("global"), foreign = foreignItem(f), admitted = begin(f);
  const before = f.store.listKnowledgeRevisions();
  const result = f.store.commitConsolidationRun({ run: admitted.run, path: f.target, operations: [
    { op: "update", knowledgeId: global.knowledgeId, baseCommit: global.commit, text: "would commit", category: "constraint",
      scope: "global", supports: [], topics: [], reason: "same pool", createdAt: "now" },
    { op: "archive", kind: "budget", knowledgeId: foreign.knowledgeId, baseCommit: foreign.commit, supports: [], reason: "wrong pool", createdAt: "now" },
  ] });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.problems.join(" ")).toContain("outside the Dreamer pools");
  expect(f.store.listKnowledgeRevisions()).toEqual(before);
  expect(f.store.currentCommit(global.knowledgeId, f.target)[0]!.id).toBe(global.commit);
});

test.each(["success", "failure"] as const)("64c current versions: %s records the frozen range and leaves later external revisions pending", outcome => {
  const f = setup(), first = f.create("global", "first"), admitted = begin(f);
  const later = f.create("global", "later external");
  f.store.completeKnowledgePoolRange(admitted.run, outcome, admitted.range.eventIds);
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toEqual([later.commit]);
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed ORDER BY revision_id").all())
    .toContainEqual({ pool: "global", revision_id: first.commit });
});

test("64c current versions: cancellation before the first commit records nothing and releases the reservation", () => {
  const f = setup(), item = f.create("global"), first = begin(f, "first");
  f.store.completeKnowledgePoolRange(first.run, "cancelled");
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toEqual([item.commit]);
  f.store.releaseClaim(first.held);
  const second = begin(f, "second");
  expect(second.range.eventIds).toEqual(first.range.eventIds);
});

test.each(["cancelled", "failure"] as const)("64c current versions: %s after a real scope-changing commit processes range and output owners", outcome => {
  const f = setup(), item = f.create("global"), admitted = begin(f);
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
    consume(f);
    expect(f.store.pendingPoolWeight(pool, f.target)).toBeGreaterThan(0);
    expect(f.store.dreamingDue(f.target, 1)).toBe(true);
    stores.splice(stores.indexOf(f.store), 1);
    f.store.close();

    const reopened = new Store(path); stores.push(reopened);
    expect(reopened.pendingPoolWeight(pool, f.target)).toBeGreaterThan(0);
    expect(reopened.dreamingDue(f.target, 1)).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("64c current versions: expired ownership does not reserve revisions and the stale runner cannot record", () => {
  const f = setup(), item = f.create("global"), stale = begin(f, "stale");
  f.store.invalidateExecutor("stale");
  const replacementClaim = claim(f, "replacement");
  const replacement = f.store.retainKnowledgePoolRange(f.target, replacementClaim);
  expect(replacement.eventIds).toEqual([item.commit]);
  expect(() => f.store.completeKnowledgePoolRange(stale.run, "failure")).toThrow(/no longer current and unexpired/);
  expect(f.store.pendingVersions("global", f.target).map(v => v.revisionId)).toEqual([item.commit]);
});

test("67: pool reads batch graph, processing history and rendering independently of identity count", () => {
  const f = setup();
  const graphInput = vi.spyOn(f.store, "commitGraphInput"), graph = vi.spyOn(f.store, "commitGraph");
  const prepare = vi.spyOn(f.store.db, "prepare"), render = vi.spyOn(rendering, "renderKnowledge");
  const processingReads: number[] = [];
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
      // also mentions "FROM knowledge_processed" in passing (its `kp` column) — count the processing
      // reads `knowledgePools` itself issues, not that substring. 104: batched per pool, never per identity.
      processingReads.push(prepare.mock.calls.filter(([sql]) => sql.includes("FROM knowledge_processed WHERE pool = ?")).length);
      expect(prepare.mock.calls.length).toBeLessThanOrEqual(25);
      console.info(JSON.stringify({ fixture: "67 pool projection", count, elapsedMs, prepares: prepare.mock.calls.length }));
    }
    expect(processingReads[1]).toBe(processingReads[0]);
    graphInput.mockClear();
    f.store.dreamingDue(f.target);
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
    const operations = Array.from({ length: 30 }, (_, i) => ({ op: "create" as const, title: "Fixture title", handle: `$${i}`, author: "test",
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

test("126 freeze: one range takes all three pools' pending oldest first within 10,000 rendered tokens; skips are recorded in each version's own pool", () => {
  const f = setup(), scopes = ["session", "global", "project", "global", "session", "project", "project", "global"] as const;
  const made = scopes.map((scope, i) => ({ scope, ...f.create(scope, `${scope} item ${i} ${"word ".repeat(1_800)}`) }));
  const pool = (scope: typeof scopes[number]) => scope === "global" ? "global" : scope === "project" ? `project:${f.project.id}` : `session:${f.session.id}`;
  const pending = new Map(f.store.knowledgePools(f.target).flatMap(value => value.pending.map(item => [item.revisionId, item.material] as const)));
  const slice = (count: number) => tokens(["Pending current knowledge:", ...made.slice(0, count).map(item => pending.get(item.commit)!)].join("\n"));
  const admitted = begin(f);
  const frozen = admitted.range.eventIds.length;
  expect(admitted.range.pool).toBe(ALL_POOLS);
  expect(admitted.range.eventIds).toEqual(made.slice(0, frozen).map(item => item.commit)); // oldest first across the pools
  expect(new Set(made.slice(0, frozen).map(item => item.scope))).toEqual(new Set(["global", "project", "session"]));
  expect(slice(frozen)).toBeLessThanOrEqual(10_000);
  expect(slice(frozen + 1)).toBeGreaterThan(10_000);
  expect(admitted.range.pendingRevisionIds).toEqual(made.map(item => item.commit));
  f.store.completeKnowledgePoolRange(admitted.run, "success", admitted.range.eventIds);
  expect(f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed ORDER BY revision_id").all())
    .toEqual(made.slice(0, frozen).map(item => ({ pool: pool(item.scope), revision_id: item.commit })));
  expect(f.store.knowledgePools(f.target).flatMap(value => value.pending.map(item => item.revisionId)).sort((x, y) => x - y))
    .toEqual(made.slice(frozen).map(item => item.commit));
});

test("85: freeze builds one pool projection; terminal consumption no longer reads pool suppression state", () => {
  const f = setup();
  f.store.setKnowledgeBudget("global", 100);
  const first = f.create("global", "evidence ".repeat(25));
  const project = f.create("project");
  const held = claim(f), graph = vi.spyOn(f.store, "commitGraphInput");
  try {
    const frozen = f.store.freezeKnowledgePool(f.target, held, 1);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(frozen.range.eventIds).toEqual([first.commit, project.commit]);
    const executionId = f.store.beginExecution({ sessionId: f.session.id, phase: "dreaming", origin: frozen.range.origin });
    const run = f.store.bindDreamingRun({ kind: "dreaming", sessionId: f.session.id, branch: "main",
      dreamingRangeId: frozen.range.id, executionId, claim: held, createdAt: "now" });
    const own = update(f, run, first, "maintained body");
    graph.mockClear();
    f.store.completeKnowledgePoolRange(run, "success");
    expect(graph).not.toHaveBeenCalled();
    expect(f.store.pendingVersions("global", f.target)).toEqual([]);
    expect(f.store.poolVersions("global", f.target).map(value => value.revision.id)).toEqual([own.commit]);
    // Frozen but neither skipped nor operated on: still pending.
    expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(value => value.revisionId)).toEqual([project.commit]);
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
  expect(f.store.dreamingDue(f.target, 1)).toBe(true);
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
  consume(f);
  const before = f.store.db.prepare("SELECT * FROM knowledge_processed").all();
  f.store.mergeProject(f.project.id, f.project.id);
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual(before);
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(v => v.revisionId)).not.toContain(item.commit);
});

test("104: two sessions sharing a pool start one Dreamer run", async () => {
  let release!: () => void, started = 0;
  const memory = TraceMemory(":memory:", async () => {
    started++;
    await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "cancelled", output: "fixture", request: {} };
  }, { dreaming: { triggerTokens: 1 } });
  const a = setup(memory.store, "shared"), b = setup(memory.store, "shared");
  a.create("project", "shared rule ".repeat(30));
  expect([a, b].map(value => memory.taskEligibility("dreaming", value.target).due)).toEqual([true, true]);
  const first = memory.dream(a.target);
  await vi.waitFor(() => expect(started).toBe(1));
  expect(await memory.dream(b.target)).toEqual({ outcome: "dropped" });
  release();
  expect((await first).outcome).toBe("cancelled");
  expect(started).toBe(1);
});

test.each(["A", "B"] as const)("126: two sessions due at once on the shared global pool run one at a time; %s first leaves the other only what it did not freeze", async opener => {
  let hold = true, release = () => {};
  const runs: { sessionId: number; frozen: number[] }[] = [];
  const memory = TraceMemory(":memory:", async raw => {
    const task = raw as DreamingAgentInput;
    task.acknowledgeRequest();
    runs.push({ sessionId: task.sessionId, frozen: suppliedHandles(task.material.changed).map(handle => {
      const [, id, ordinal] = /^K(\d+)@v(\d+)$/.exec(handle)!; return memory.store.resolveVersionOrdinal(Number(id), Number(ordinal)); }) });
    if (hold) await new Promise<void>(resolve => { release = resolve; });
    skipRest(task);
    return { outcome: "success", output: "deliberated", request: { fixture: "126 shared global" } };
  }, { dreaming: { triggerTokens: 1 } });
  const a = setup(memory.store, "A"), b = setup(memory.store, "B");
  const shared = a.create("global", "shared rule ".repeat(30));
  const own = { A: a.create("project", "A's project rule"), B: b.create("project", "B's project rule") };
  const [first, second] = opener === "A" ? [a, b] : [b, a];
  const [firstOwn, secondOwn] = opener === "A" ? [own.A, own.B] : [own.B, own.A];
  expect([a, b].map(value => memory.taskEligibility("dreaming", value.target).due)).toEqual([true, true]);
  const running = memory.dream(first.target);
  await vi.waitFor(() => expect(runs).toHaveLength(1));
  expect(await memory.dream(second.target)).toEqual({ outcome: "dropped" }); // one database-wide Dreamer seat
  const late = second.create("global", "late shared rule"); // written while the first run holds the global pool
  hold = false; release();
  expect((await running).outcome).toBe("success");
  expect(runs[0]).toEqual({ sessionId: first.session.id, frozen: [shared.commit, firstOwn.commit] });
  expect(memory.store.pendingVersions("global", second.target).map(value => value.revisionId)).toEqual([late.commit]);
  expect((await memory.dream(second.target)).outcome).toBe("success");
  expect(runs[1]).toEqual({ sessionId: second.session.id, frozen: [secondOwn.commit, late.commit].sort((x, y) => x - y) });
  for (const f of [a, b]) expect(memory.store.knowledgePools(f.target).flatMap(pool => pool.pending)).toEqual([]);
});

// 139: a story with a processed reference, a Changed, an Archived, a New and a supportless item, whose
// facts are dated `times` (a time that cannot be parsed yields no date). The ids and texts do not depend on `times`.
function datedStory(times: readonly [string, string, string]) {
  const f = setup(), pool = `project:${f.project.id}`;
  const source = entry(f.store, f.session.id, f.turn.id, "dated-evidence", "user");
  const [a, b, c] = legacyFacts(f.store, { kind: "manual", sessionId: f.session.id, branch: "main", createdAt: "now" }, times.map((createdAt, i) => ({
    sources: [{ entry: source, address: `T${f.turn.id}#E${source.entryOrdinal}` }], text: `fact ${i}`, category: "decision" as const, actor: "user" as const, createdAt,
  }))).facts.map(fact => fact.id) as [number, number, number];
  const make = (text: string, supports: number[]) => knowledgeBatch(f.store, f.target,
    [{ text, supports, scope: "project", category: "constraint" }], { kind: "manual", createdAt: "now" }).committed[0]!;
  const reference = make("reference rule", [a, b]), changed = make("changed rule", [a]), retired = make("retired rule", [a, b]);
  consume(f);
  const updated = updateKnowledge(f.store, f.target, changed.knowledgeId, changed.commit, "changed rule, newer", [c]);
  const archived = archive(f.store, f.target, retired.knowledgeId, retired.commit, [c], "budget");
  const fresh = make("new rule", [c]), bare = make("supportless rule", [c]);
  clearSupports(f.store, bare.commit);
  const read = () => f.store.knowledgePools(f.target).find(value => value.pool === pool)!;
  const weight = () => f.store.pendingPoolWeight(pool, f.target);
  return { read, weight, ids: { reference, updated, archive: { commit: archived }, fresh, bare }, facts: { a, b, c }, spy: () => vi.spyOn(f.store.db, "prepare") };
}

test("139: the Dreamer's material shows the UTC date range of the supports of the version shown, for every kind of item", () => {
  const story = datedStory(["2026-10-01T22:00:00-05:00", "2026-10-05T01:00:00.000Z", "2026-10-03T23:30:00.000Z"]), pool = story.read();
  const pending = new Map(pool.pending.map(item => [item.revisionId, item.shown]));
  const range = "(\\d+ tokens; facts 2026-10-02\\.\\.2026-10-05)";
  expect(pool.rendered.get(story.ids.reference.commit)).toMatch(new RegExp(range));
  expect(pending.get(story.ids.fresh.commit)).toMatch(/\(\d+ tokens; facts 2026-10-03\)/);
  expect(pending.get(story.ids.updated.commit)).toMatch(/Changed .*\n\[[^\n]*\(\d+ tokens; facts 2026-10-03\)/); // its own support, not merged with the earlier version's
  expect(pending.get(story.ids.archive.commit)).toMatch(new RegExp(`Archived .*:\\n[^\\n]*${range}`)); // the archived body's supports, not the archive's evidence
  expect(pending.get(story.ids.archive.commit)).toContain(`archive evidence: F${story.facts.c}`);
  expect(pending.get(story.ids.bare.commit)).not.toContain("facts 20");
});

test("139: the dates never count toward pool size, item tokens, pending weights or the pending cap", () => {
  const dated = datedStory(["2026-10-01T22:00:00-05:00", "2026-10-05T01:00:00.000Z", "2026-10-03T23:30:00.000Z"]);
  const plain = datedStory(["now", "now", "now"]);
  const withDates = dated.read(), without = plain.read();
  expect(without.pending.some(item => item.shown.includes("facts 20"))).toBe(false);
  const normalised = (text: string) => text.replace(/#[a-z]+\]/g, "#tag]");
  expect(withDates.pending.some(item => item.shown.includes("facts 20"))).toBe(true);
  expect(withDates.tokens).toBe(without.tokens);
  expect(withDates.pending.map(item => [item.tokens, normalised(item.material)])).toEqual(without.pending.map(item => [item.tokens, normalised(item.material)]));
  // The label on every item states the same cost, with or without dates.
  const cost = (text: string) => [...text.matchAll(/\((\d+) tokens[;)]/g)].map(match => match[1]);
  expect([...withDates.rendered.values()].map(cost)).toEqual([...without.rendered.values()].map(cost));
  // The weights the Dreamer is admitted by are the plain ones. What it is shown is longer, and the real
  // admission boundary is tested in dreaming.test.ts.
  expect(dated.weight()).toBeGreaterThan(0);
  expect(dated.weight()).toBe(plain.weight());
  for (const item of withDates.pending) expect(item.material).not.toContain("facts 20");
});

test("139: the fact dates of the whole material cost no per-item or per-fact query", () => {
  const story = datedStory(["2026-10-01T22:00:00-05:00", "2026-10-05T01:00:00.000Z", "2026-10-03T23:30:00.000Z"]);
  const prepare = story.spy();
  try {
    story.read();
    const reads = prepare.mock.calls.map(([sql]) => sql).filter(sql => /\bFROM facts\b/.test(sql));
    expect(reads.length).toBeLessThanOrEqual(1); // the single batched read of the graph input, shared with the citation checks
    for (const sql of reads) expect(sql).toContain("json_each");
  } finally { prepare.mockRestore(); }
});
