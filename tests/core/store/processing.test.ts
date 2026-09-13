import { afterEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type KnowledgeOperationInput } from "../../../src/core/store/index.ts";
import { renderKnowledge, tokens } from "../../../src/core/render/index.ts";
import { DEFAULT_KNOWLEDGE_BUDGETS, KNOWLEDGE_VIEW_VERSION, checkProcessedProjection, deriveKnowledgeBudgets, processedBlock } from "../../../src/core/store/processing.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { migrateDreaming } from "../../../src/core/store/migration.ts";
import * as rendering from "../../../src/core/render/index.ts";

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); vi.restoreAllMocks(); });
function fixture(store = new Store(":memory:"), project = "A") {
  if (!stores.includes(store)) stores.push(store);
  const p = store.findProjectByName(project) ?? store.createProject({ name: project, declaredBy: "mark" });
  const s = store.createSession({ host: "test", enrollmentChoice: true, projectId: p.id, projectDeclaration: "mark", startedAt: "now", firstReplyAt: "now" });
  const t = store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: s.id, createdAt: "now" }, facts: [{ turnId: t.id, category: "decision", actor: "user", text: "evidence", source: [`T${t.id}#user`], createdAt: "now" }] });
  if (!fact.ok) throw Error(fact.problems.join());
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const content = { topics: [], reason: "test", text: "knowledge", category: "constraint" as const, scope: "project" as const, supports: [fact.facts[0]!.id], createdAt: "now" };
  const write = (op: KnowledgeOperationInput, range?: number) => {
    const result = store.commitConsolidationRun({ path: target, run: { kind: range ? "dreaming" : "manual", dreamingRangeId: range, sessionId: s.id, branch: "main", createdAt: "now" }, operations: [op] });
    if (!result.ok) throw Error(result.problems.join());
    return result.committed[0]!;
  };
  const create = (text = "knowledge", scope: "global" | "project" | "session" = "project", range?: number) => write({ op: "create", handle: "$1", author: "test", ...content, text, scope }, range);
  const success = () => store.recordRun({ kind: "dreaming", sessionId: s.id, branch: "main", outcome: "success", createdAt: "now" }).id;
  return { store, p, s, t, target, content, write, create, success };
}

test("32b review: unchanged eligibility avoids graph loading; scope checks load and render once", () => {
  const memory = TraceMemory(":memory:", vi.fn()), a = fixture(memory.store);
  for (let i = 0; i < 30; i++) fixture(a.store);
  const commits = Array.from({ length: 10 }, (_, i) => a.create(`small ${i}`));
  const sql = vi.spyOn(a.store.db, "prepare"), render = vi.spyOn(rendering, "renderKnowledge");
  memory.taskEligibility("dreaming", a.target);
  const eligibilityGraphs = sql.mock.calls.filter(([s]) => s === "SELECT * FROM knowledge_revisions ORDER BY id").length;
  const eligibilityRenders = render.mock.calls.length;
  sql.mockClear(); render.mockClear();
  a.store.checkProcessedScopes(commits.map(c => c.commit));
  const scopeGraphs = sql.mock.calls.filter(([s]) => s === "SELECT * FROM knowledge_revisions ORDER BY id").length;
  console.log(JSON.stringify({ eligibilityGraphs, eligibilityRenders, scopeGraphs, scopeRenders: render.mock.calls.length, sessions: 31, commits: 10 }));
  expect(eligibilityGraphs).toBe(0);
  expect(eligibilityRenders).toBe(0);
  expect(scopeGraphs).toBe(1);
  expect(render).toHaveBeenCalledTimes(10);
  memory.close();
});

test("32b performance: metadata and fact checks are bounded per projection, placement uses two projections", () => {
  const a = fixture(), b = fixture(a.store, "B");
  for (let i = 0; i < 8; i++) fixture(a.store);
  let c = a.create();
  for (let i = 0; i < 40; i++) c = a.write({ op: "update", knowledgeId: c.knowledgeId, baseCommit: c.commit, ...a.content });
  const sql = vi.spyOn(a.store.db, "prepare"), facts = vi.spyOn(a.store, "factOnPath"), graphs = vi.spyOn(a.store, "commitGraph");
  a.store.completeDreaming(a.success(), [c.commit], [c.commit]);
  const points = () => sql.mock.calls.filter(([s]) => /SELECT (\*|session_id) FROM (facts|turns|runs|sessions) WHERE id = \?/.test(s)).length;
  expect(points()).toBeLessThan(30);
  expect(facts.mock.calls.length).toBeLessThanOrEqual(graphs.mock.calls.length);
  sql.mockClear(); facts.mockClear(); graphs.mockClear();
  a.store.declareProject(a.s.id, b.p.name, "mark");
  expect(sql.mock.calls.filter(([s]) => s === "SELECT * FROM knowledge_revisions ORDER BY id")).toHaveLength(2);
  expect(points()).toBeLessThan(50);
  expect(facts.mock.calls.length).toBeLessThanOrEqual(graphs.mock.calls.length);
  sql.mockClear();
  a.store.mergeProject(b.p.id, a.p.id);
  expect(sql.mock.calls.filter(([s]) => s === "SELECT * FROM knowledge_revisions ORDER BY id")).toHaveLength(2);
  expect(a.store.db.prepare("SELECT * FROM knowledge_placement_validations").all()).toHaveLength(2);
});

test.each([2, 12])("32b performance: %s settled ranges keep their own branch/head and unfinished derived results", count => {
  const a = fixture(), c = a.create();
  const readers = Array.from({ length: count }, () => fixture(a.store));
  const ranges = readers.map(r => a.store.retainDreamingRange(r.target, [c.commit]));
  const original = a.store.retainDreamingRange(a.target, [c.commit]);
  const derived = a.create("unfinished", "project", original.id);
  const later = a.store.appendTurn({ sessionId: a.s.id, parentTurnId: a.t.id, kind: "turn", userPrompt: "later", startedAt: "now" });
  const sibling = a.store.retainDreamingRange({ ...a.target, branch: "sibling", headTurnId: later.id }, [c.commit]);
  const input = vi.spyOn(a.store, "commitGraphInput"), graph = vi.spyOn(a.store, "commitGraph"), facts = vi.spyOn(a.store, "factOnPath");
  a.store.completeDreaming(readers[0]!.success(), [c.commit], [c.commit]);
  expect(facts.mock.calls.length).toBeLessThanOrEqual(graph.mock.calls.length);
  expect(input).toHaveBeenCalledTimes(1); // certification and shared range closure reuse one immutable graph input
  expect(graph.mock.calls.some(([p]) => p?.branch === "sibling" && p.headTurnId === later.id)).toBe(true);
  expect(ranges.every(r => a.store.dreamingRange(r.id) === null)).toBe(true);
  expect(a.store.dreamingRange(original.id)).not.toBeNull();
  expect(a.store.dreamingRange(sibling.id)).toBeNull();
  a.store.completeDreaming(a.success(), [], [derived.commit]);
  expect(a.store.dreamingRange(original.id)).toBeNull();
});

test.each(["global", "project", "session", "applicable"] as const)("32b performance: reused %s projection charges framing, accepts the cap and rejects one more token", scope => {
  const a = fixture(), c = a.create("body", scope === "applicable" ? "global" : scope);
  const value = { knowledge: a.store.getKnowledge(c.knowledgeId)!, revision: a.store.knowledgeRevision(c.commit)! };
  const owner = scope === "global" || scope === "applicable" ? "global" : `${scope}:${scope === "project" ? a.p.id : a.s.id}`;
  const cap = { global: 4000, project: 10000, session: 1000, applicable: 15000 }[scope];
  const projection = { owners: new Map([[c.commit, owner]]), paths: [{ path: a.target, values: [value] }],
    // Isolate the independent applicable guard; real projections also include the scope pools.
    pools: scope === "applicable" ? new Map() : new Map([[owner, new Map([[c.commit, value]])]]) };
  for (const expected of [cap, cap + 1]) {
    let low = 0, high = 20000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      value.revision.text = "一".repeat(mid);
      if (tokens(processedBlock([value])) < expected) low = mid + 1; else high = mid;
    }
    value.revision.text = "一".repeat(low);
    expect(tokens(processedBlock([value]))).toBe(expected);
    expect(tokens(value.revision.text)).toBeLessThan(expected);
    const check = checkProcessedProjection(projection, undefined, deriveKnowledgeBudgets(DEFAULT_KNOWLEDGE_BUDGETS));
    expect(check.problems).toHaveLength(expected === cap ? 0 : 1);
    expect(check.totals.find(t => scope === "applicable" ? t.scope.startsWith("applicable:") : t.scope === owner)?.tokens).toBe(expected);
  }
});

test("32b performance: after-projection audit failure rolls back assignment and every audit row", () => {
  const a = fixture(), b = fixture(a.store, "B"), commits = [a.create(), a.create()];
  a.store.completeDreaming(a.success(), commits.map(c => c.commit), commits.map(c => c.commit));
  a.store.db.exec(`CREATE TRIGGER fail_second_audit BEFORE INSERT ON knowledge_placement_validations
    WHEN (SELECT count(*) FROM knowledge_placement_validations) = 1 BEGIN SELECT RAISE(ABORT, 'audit failure'); END`);
  expect(() => a.store.declareProject(a.s.id, b.p.name, "mark")).toThrow("audit failure");
  expect(a.store.getSession(a.s.id)!.projectId).toBe(a.p.id);
  expect(a.store.db.prepare("SELECT * FROM knowledge_placement_validations").all()).toEqual([]);
  expect(commits.every(c => a.store.isKnowledgeProcessed(c.commit))).toBe(true);
  expect(a.store.pendingKnowledgeEvents(a.target)).toEqual([]);
});

test("32b review: construction closes only its connection and preserves initialization error", () => {
  const failure = new Error("schema failed"), close = vi.spyOn(DatabaseSync.prototype, "close");
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementationOnce(() => { throw failure; });
  expect(() => new Store(":memory:")).toThrow(failure);
  expect(close).toHaveBeenCalledTimes(1);
});

test("32b review: public spend and status include Dreaming without changing evidence counts", () => {
  const memory = TraceMemory(":memory:", vi.fn()), a = fixture(memory.store);
  const before = memory.progress(a.s.id, a.target.branch, a.t.id), run = a.success();
  expect(memory.spend(a.s.id).runs.dreaming).toBe(1);
  expect(memory.status(a.s.id)).toContain("1 dreaming");
  expect(memory.status(a.s.id)).toContain(`Last dreaming: run ${run} success`);
  expect(memory.progress(a.s.id, a.target.branch, a.t.id)).toEqual(before);
  memory.close();
});

test("footer progress partitions applicable current exact versions across processing, sharing and alternate paths", () => {
  const memory = TraceMemory(":memory:", vi.fn()), a = fixture(memory.store), peer = fixture(a.store);
  const first = a.create("original");
  const progress = (target: typeof a.target) => memory.progress(target.sessionId, target.branch, target.headTurnId);
  const split = (target: typeof a.target, expected: { knowledge: number; unprocessedKnowledge: number; processedKnowledge: number }) => {
    const value = progress(target);
    expect(value).toMatchObject(expected);
    expect(value.unprocessedKnowledge + value.processedKnowledge).toBe(value.knowledge);
  };

  split(a.target, { knowledge: 1, unprocessedKnowledge: 1, processedKnowledge: 0 });
  a.store.completeDreaming(a.success(), [first.commit], [first.commit]);
  split(a.target, { knowledge: 1, unprocessedKnowledge: 0, processedKnowledge: 1 });
  split(peer.target, { knowledge: 1, unprocessedKnowledge: 0, processedKnowledge: 1 }); // shared certification

  const later = a.store.appendTurn({ sessionId: a.s.id, parentTurnId: a.t.id, kind: "turn", userPrompt: "branch evidence", startedAt: "now" });
  const noted = a.store.commitNotingRun({ run: { kind: "manual", sessionId: a.s.id, branch: "alternate", createdAt: "now" }, facts: [{
    turnId: later.id, category: "decision", actor: "user", text: "revised", source: [`T${later.id}#user`], createdAt: "now" }] });
  if (!noted.ok) throw Error(noted.problems.join());
  const alternate = { sessionId: a.s.id, branch: "alternate", headTurnId: later.id };
  const updated = a.store.commitConsolidationRun({ path: alternate, run: { kind: "manual", sessionId: a.s.id, branch: "alternate", createdAt: "now" }, operations: [{
    op: "update", knowledgeId: first.knowledgeId, baseCommit: first.commit, ...a.content, text: "successor", supports: [noted.facts[0]!.id] }] });
  if (!updated.ok) throw Error(updated.problems.join());
  split(a.target, { knowledge: 1, unprocessedKnowledge: 0, processedKnowledge: 1 }); // predecessor remains current here
  split(alternate, { knowledge: 1, unprocessedKnowledge: 1, processedKnowledge: 0 }); // exact successor is new work
  expect(a.store.listCurrentKnowledge(alternate).map(value => value.revision.id)).toEqual([updated.committed[0]!.commit]);

  const archived = a.store.commitConsolidationRun({ path: alternate, run: { kind: "manual", sessionId: a.s.id, branch: "alternate", createdAt: "now" }, operations: [{
    op: "archive", knowledgeId: first.knowledgeId, baseCommit: updated.committed[0]!.commit,
    supports: [noted.facts[0]!.id], reason: "retired", createdAt: "now" }] });
  if (!archived.ok) throw Error(archived.problems.join());
  split(alternate, { knowledge: 0, unprocessedKnowledge: 0, processedKnowledge: 0 }); // archive and superseded versions are excluded
  split(a.target, { knowledge: 1, unprocessedKnowledge: 0, processedKnowledge: 1 });
  memory.close();
});

test("32b review: archive supplies its exact predecessor, not latest", () => {
  const a = fixture(), c = a.create("unique complete predecessor");
  const archived = a.write({ op: "archive", knowledgeId: c.knowledgeId, baseCommit: c.commit, supports: a.content.supports, reason: "retired", createdAt: "now" });
  const input = a.store.dreamingInput(a.target, [archived.commit]);
  expect(input.text).toContain("unique complete predecessor");
  expect(input).toHaveProperty("predecessors.0.revision.id", c.commit);
  expect(input.tokens).toBe(tokens(input.text));
});

test("32b review: cross-K chained successors are read without expanding frozen family", () => {
  const a = fixture(), c = a.create("absorbed"), b = a.create("middle"), d = a.create("final");
  const range = a.store.retainDreamingRange(a.target, [c.commit]);
  const merge = a.write({ op: "merge", intoKnowledgeId: b.knowledgeId, intoBaseCommit: b.commit, absorb: [{ knowledgeId: c.knowledgeId, baseCommit: c.commit }], ...a.content, text: "merged middle" });
  const final = a.write({ op: "merge", intoKnowledgeId: d.knowledgeId, intoBaseCommit: d.commit, absorb: [{ knowledgeId: b.knowledgeId, baseCommit: merge.commit }], ...a.content, text: "unique final body" });
  const input = a.store.dreamingInput(a.target, [c.commit]);
  expect(input.versions.map(v => v.revision.id)).toEqual([final.commit]);
  expect(input.text.match(/unique final body/g)).toHaveLength(1);
  expect(a.store.dreamingRange(range.id)?.knowledgeIds).toEqual([c.knowledgeId]);
  const archived = a.write({ op: "archive", knowledgeId: final.knowledgeId, baseCommit: final.commit, supports: a.content.supports, reason: "retired", createdAt: "now" });
  const after = a.store.dreamingInput(a.target, [c.commit]);
  expect(after.versions.map(v => v.revision.id)).toEqual([archived.commit]);
  expect(after.predecessors.map(v => v.revision.id)).toEqual([final.commit]);
  expect(after.text.match(/unique final body/g)).toHaveLength(1);
  expect(input.versions[0]!.revision.id).toBe(final.commit);
});

test.each([false, true])("32b frozen path: head advance ignores later-only supports (explicit selection: %s)", selected => {
  const a = fixture(), b = fixture(a.store), c = a.create("frozen body");
  const range = a.store.retainDreamingRange(a.target, [c.commit]);
  const turn = a.store.appendTurn({ sessionId: a.s.id, parentTurnId: a.t.id, kind: "turn", userPrompt: "later", startedAt: "now" });
  const noted = a.store.commitNotingRun({ run: { kind: "manual", sessionId: a.s.id, createdAt: "now" }, facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "later evidence", source: [`T${turn.id}#user`], createdAt: "now" }] });
  if (!noted.ok) throw Error(noted.problems.join());
  const advanced = { ...a.target, headTurnId: turn.id };
  const updated = a.store.commitConsolidationRun({ path: advanced, run: { kind: "manual", sessionId: a.s.id, branch: "main", createdAt: "now" }, operations: [{ op: "update", knowledgeId: c.knowledgeId, baseCommit: c.commit, ...a.content, supports: [noted.facts[0]!.id], text: "later-only body" }] });
  if (!updated.ok) throw Error(updated.problems.join());
  const later = updated.committed[0]!;
  const input = () => a.store.dreamingInput(advanced, selected ? [c.commit] : undefined);
  expect(input().versions.map(v => v.revision.id)).toEqual([c.commit]);
  expect(input()).toEqual(a.store.dreamingInput(a.target, selected ? [c.commit] : undefined));
  expect(input().events.map(e => e.id)).toEqual([c.commit]);
  expect(input().text).not.toContain("later-only body");
  expect(a.store.retainDreamingRange(advanced, [later.commit])).toEqual(range);
  // A path without an open range still resolves the caller's current head.
  expect(a.store.dreamingInput({ ...advanced, branch: "fresh" }).versions.map(v => v.revision.id)).toEqual([later.commit]);
  // These legacy-shaped direct runs have no authoritative origins. Once a successor exists in the
  // same target session, the ancestry-dependent write is refused instead of guessed.
  expect(() => a.write({ op: "update", knowledgeId: c.knowledgeId, baseCommit: c.commit, ...a.content,
    text: "unknown-origin competitor" }, range.id)).toThrow("trigger ancestry is unknown");
  expect(a.store.isKnowledgeProcessed(later.commit)).toBe(false);
});

test("32b review: sibling-only merge cannot replace input on the original path", () => {
  const a = fixture(), c = a.create("original branch body"), b = a.create("survivor");
  const turn = a.store.appendTurn({ sessionId: a.s.id, parentTurnId: a.t.id, kind: "turn", userPrompt: "sibling", startedAt: "now" });
  const noted = a.store.commitNotingRun({ run: { kind: "manual", sessionId: a.s.id, createdAt: "now" }, facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "sibling evidence", source: [`T${turn.id}#user`], createdAt: "now" }] });
  if (!noted.ok) throw Error(noted.problems.join());
  const sibling = { ...a.target, branch: "sibling", headTurnId: turn.id };
  const merged = a.store.commitConsolidationRun({ path: sibling, run: { kind: "manual", sessionId: a.s.id, branch: "sibling", createdAt: "now" }, operations: [{ op: "merge", intoKnowledgeId: b.knowledgeId, intoBaseCommit: b.commit, absorb: [{ knowledgeId: c.knowledgeId, baseCommit: c.commit }], ...a.content, supports: [noted.facts[0]!.id], text: "sibling merged body" }] });
  if (!merged.ok) throw Error(merged.problems.join());
  expect(a.store.dreamingInput(a.target, [c.commit]).versions.map(v => v.revision.id)).toEqual([c.commit]);
  expect(a.store.dreamingInput(sibling, [c.commit]).versions.map(v => v.revision.id)).toEqual([merged.committed[0]!.commit]);
});

test("32b review: shared settlement does not strand an unfinished derived range", () => {
  const memory = TraceMemory(":memory:", vi.fn()), a = fixture(memory.store), b = fixture(a.store);
  const c = a.create(), range = a.store.retainDreamingRange(a.target, [c.commit]);
  const otherRange = a.store.retainDreamingRange(b.target, [c.commit]);
  const derived = a.create("unfinished derived", "project", range.id);
  a.store.completeDreaming(b.success(), [c.commit], [c.commit]);
  expect(a.store.pendingKnowledgeEvents(a.target)).toMatchObject([{ id: derived.commit, kind: "version" }]);
  expect(a.store.dreamingRange(otherRange.id)).toBeNull();
  expect(memory.taskEligibility("dreaming", a.target)).toEqual({ due: true });
  const claim = a.store.acquireClaim(a.target, "dreaming", "retry");
  expect(claim).not.toBeNull();
  expect(a.store.retainDreamingRange(a.target, []).anchor).toBe(c.commit);
  if (claim) a.store.releaseClaim(claim);
  a.store.completeDreaming(b.success(), [], [derived.commit]);
  expect(memory.taskEligibility("dreaming", a.target)).toEqual({ due: false });
  expect(a.store.acquireClaim(a.target, "dreaming", "done")).toBeNull();
  expect(a.store.dreamingRange(range.id)).toBeNull();
  const next = a.create("new work");
  expect(a.store.retainDreamingRange(a.target, [next.commit]).anchor).toBe(next.commit);
  memory.close();
});

test.each([0, 1])("32b review: a copy failure rolls back the whole migration and restores FK=%s", initial => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`PRAGMA foreign_keys=OFF; CREATE TABLE runs(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT CHECK(kind IN ('manual','consolidation')));
      CREATE TABLE task_claims(id INTEGER PRIMARY KEY, phase TEXT CHECK(phase IN ('noting','consolidation')));
      CREATE TABLE child(run_id INTEGER REFERENCES runs(id)); INSERT INTO child VALUES (999);
      INSERT INTO runs(kind) VALUES ('manual'); PRAGMA foreign_keys=${initial}`);
    expect(() => migrateDreaming(db)).toThrow("foreign key violations");
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(initial);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_32b'").all()).toEqual([]);
    expect(() => db.exec("INSERT INTO runs(kind) VALUES ('dreaming')")).toThrow(/CHECK/);
    expect(db.prepare("SELECT * FROM runs").all()).toHaveLength(1);
    db.exec("DELETE FROM child");
    migrateDreaming(db);
    db.exec("INSERT INTO runs(kind) VALUES ('dreaming')");
  } finally { db.close(); }
});

test.each([0, 1])("32b review: locked real old tables restore FK=%s and preserve caller transactions", initial => {
  const dir = mkdtempSync(join(tmpdir(), "tm-32b-lock-")); dirs.push(dir);
  const file = join(dir, "old.sqlite"), db = new DatabaseSync(file), lock = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE runs(id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT CHECK(kind IN ('manual','consolidation'))); CREATE TABLE task_claims(id INTEGER PRIMARY KEY, phase TEXT CHECK(phase IN ('noting','consolidation'))); INSERT INTO runs(kind) VALUES ('manual')");
    db.exec(`PRAGMA foreign_keys=${initial}`);
    lock.exec("BEGIN IMMEDIATE");
    expect(() => migrateDreaming(db)).toThrow(/locked/);
    expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(initial);
    expect(db.isTransaction).toBe(false);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '%_32b'").all()).toEqual([]);
    lock.exec("ROLLBACK");
    db.exec("BEGIN");
    expect(() => migrateDreaming(db)).toThrow();
    expect(db.isTransaction).toBe(true);
    db.exec("ROLLBACK");
    migrateDreaming(db);
    expect(db.prepare("PRAGMA foreign_keys").get()!.foreign_keys).toBe(initial);
    expect(db.prepare("SELECT * FROM runs").all()).toHaveLength(1);
    db.exec("INSERT INTO runs(kind) VALUES ('dreaming')");
  } finally { lock.close(); db.close(); }
  const reopened = new DatabaseSync(file);
  try { expect(reopened.prepare("SELECT * FROM runs").all()).toHaveLength(2); } finally { reopened.close(); }
});

test("32: completion is per exact version and shared database-wide; settlement is a separate set", () => {
  const a = fixture(), b = fixture(a.store), foreign = fixture(a.store, "foreign");
  const c1 = a.create();
  const c2 = a.write({ op: "update", knowledgeId: c1.knowledgeId, baseCommit: c1.commit, ...a.content, text: "successor" });
  expect(a.store.pendingKnowledgeEvents(b.target).map(e => e.id)).toEqual([c1.commit, c2.commit]);
  const run = a.success();
  a.store.completeDreaming(run, [c1.commit], [c2.commit]);
  a.store.completeDreaming(run, [c1.commit], [c2.commit]);
  expect(a.store.isKnowledgeProcessed(c1.commit)).toBe(false);
  expect(a.store.dreamingInput(b.target).versions[0]!.processed).toBe(true);
  expect(a.store.pendingKnowledgeEvents(b.target).map(e => e.id)).toEqual([c2.commit]);
  expect(a.store.listCurrentKnowledge(foreign.target)).toEqual([]);
  expect(() => a.store.completeDreaming(run, [c2.commit], [c2.commit])).toThrow("different exact sets");
  const failed = a.store.recordRun({ kind: "dreaming", sessionId: a.s.id, outcome: "failure", createdAt: "now" });
  expect(() => a.store.completeDreaming(failed.id, [c2.commit], [])).toThrow("successful");
});

test("32: historical event weights, archive-before, one current input body and immutable render-version cache", () => {
  const a = fixture();
  let c = a.create("body-" + "x".repeat(12000));
  const ids = [c.commit];
  for (let i = 0; i < 2; i++) { c = a.write({ op: "update", knowledgeId: c.knowledgeId, baseCommit: c.commit, ...a.content, text: `body-${i}` + "x".repeat(12000) }); ids.push(c.commit); }
  const input = a.store.dreamingInput(a.target);
  expect(input.events.map(e => e.id)).toEqual(ids);
  expect(input.pendingTokens).toBeGreaterThan(input.tokens * 2);
  expect(input.text.match(/\[K1@/g)).toHaveLength(1);
  const prior = a.store.knowledgeRevision(c.commit)!;
  const weight = tokens(renderKnowledge({ knowledge: a.store.getKnowledge(c.knowledgeId)!, revision: prior }));
  c = a.write({ op: "archive", knowledgeId: c.knowledgeId, baseCommit: c.commit, supports: a.content.supports, reason: "retired", createdAt: "now" });
  expect(a.store.knowledgeEventWeight(c.commit)).toBe(weight);
  const render = vi.spyOn(a.store, "getKnowledgeRevision");
  for (let i = 0; i < 3; i++) a.store.pendingKnowledgeEvents(a.target);
  expect(render).not.toHaveBeenCalled();
  a.store.knowledgeEventWeight(c.commit, "next-render-version");
  expect(render).toHaveBeenCalled();
  expect(a.store.db.prepare("SELECT count(*) n FROM knowledge_weights WHERE commit_id = ?").get(c.commit)!.n).toBe(2);
  expect(a.store.pendingKnowledgeEvents(a.target)).toHaveLength(4);
});

test("32: 4999 does not trigger, 5000 does, and eligibility launches no provider", () => {
  const agent = vi.fn();
  const memory = TraceMemory(":memory:", agent);
  const a = fixture(memory.store);
  try {
    const c = a.create();
    // Boundary control operates on the immutable weight cache; renderer equality is pinned above.
    const set = (n: number) => a.store.db.prepare("UPDATE knowledge_weights SET tokens = ? WHERE commit_id = ? AND view_version = ?").run(n, c.commit, KNOWLEDGE_VIEW_VERSION);
    set(4999); expect(memory.taskEligibility("dreaming", a.target)).toEqual({ due: false });
    set(5000); expect(memory.taskEligibility("dreaming", a.target)).toEqual({ due: true });
    expect(memory.taskEligibility("dreaming", a.target)).toEqual({ due: true });
    expect(agent).not.toHaveBeenCalled();
    const claim = a.store.acquireClaim(a.target, "dreaming", "executor");
    expect(claim?.phase).toBe("dreaming");
    a.store.reopenSession(a.s.id, "new-executor");
    expect(a.store.getClaim(a.s.id, "dreaming")?.executorId).toBe("new-executor");
  } finally { memory.close(); }
});

test("34b: a failed Dreamer retains original events and exposes an uncertified own result", () => {
  const a = fixture();
  const c = a.create();
  const range = a.store.retainDreamingRange(a.target, [c.commit]);
  const updated = a.write({ op: "update", knowledgeId: c.knowledgeId, baseCommit: c.commit, ...a.content, text: "transformed" }, range.id);
  const derived = a.create("split family", "project", range.id);
  a.write({ op: "archive", knowledgeId: c.knowledgeId, baseCommit: updated.commit, supports: a.content.supports, reason: "transformed", createdAt: "now" }, range.id);
  expect(a.store.pendingKnowledgeEvents(a.target).map(e => e.id)).toEqual([c.commit, derived.commit]);
  expect(a.store.retainDreamingRange({ ...a.target, headTurnId: a.t.id }, [derived.commit])).toMatchObject({ id: range.id, anchor: c.commit, headTurnId: a.t.id });
  expect(a.store.dreamingInput(a.target).versions.map(v => v.knowledge.id)).toEqual([derived.knowledgeId, c.knowledgeId]);
  expect(a.store.isKnowledgeProcessed(derived.commit)).toBe(false);
  expect(a.store.dreamingRange(range.id)?.knowledgeIds).toEqual([c.knowledgeId, derived.knowledgeId]);
});

test("32: completion validation and certification roll back atomically; external later events stay pending", () => {
  const a = fixture(), c = a.create(), run = a.success();
  expect(() => a.store.completeDreaming(run, [c.commit], [c.commit], () => { throw Error("lost claim"); })).toThrow("lost claim");
  expect(a.store.isKnowledgeProcessed(c.commit)).toBe(false);
  expect(a.store.pendingKnowledgeEvents(a.target)).toHaveLength(1);
  const later = a.write({ op: "update", knowledgeId: c.knowledgeId, baseCommit: c.commit, ...a.content, text: "external" });
  a.store.completeDreaming(run, [c.commit], [c.commit]);
  expect(a.store.isKnowledgeProcessed(later.commit)).toBe(false);
  expect(a.store.pendingKnowledgeEvents(a.target).map(e => e.id)).toEqual([later.commit]);
});

test("34a: placement revalidation preserves certification while parent scope bounds a moved child", () => {
  const a = fixture(), b = fixture(a.store, "B"), author = fixture(a.store);
  const c = a.create();
  const updated = author.write({ op: "update", knowledgeId: c.knowledgeId, baseCommit: c.commit, ...author.content });
  a.store.completeDreaming(author.success(), [c.commit, updated.commit], [updated.commit]);
  a.store.declareProject(author.s.id, "B", "mark");
  expect(a.store.getKnowledge(c.knowledgeId)!.projectId).toBe(a.p.id);
  expect(a.store.listCurrentKnowledge(b.target).map(v => v.revision.id)).toEqual([]);
  a.store.declareProject(author.s.id, "A", "mark");
  expect(a.store.db.prepare("SELECT * FROM knowledge_placement_validations").all()).toHaveLength(2);
  expect(a.store.isKnowledgeProcessed(updated.commit)).toBe(true);
  expect(a.store.pendingKnowledgeEvents(author.target)).toEqual([]);
  expect(a.store.listKnowledgeRevisions(c.knowledgeId)).toHaveLength(2);
});

test.each(["merge", "declare"])("32: over-cap %s includes outside knowledge and rolls back assignments and audit", operation => {
  const a = fixture(), b = fixture(a.store, "B");
  const ca = a.create("一".repeat(9100)), cb = b.create("一".repeat(9100));
  a.store.completeDreaming(a.success(), [ca.commit], [ca.commit]);
  a.store.completeDreaming(b.success(), [cb.commit], [cb.commit]);
  expect(() => operation === "merge" ? a.store.mergeProject(a.p.id, b.p.id) : a.store.declareProject(a.s.id, "B", "mark")).toThrow(/processed knowledge.*exceeds 10000/);
  expect(a.store.getSession(a.s.id)!.projectId).toBe(a.p.id);
  expect(a.store.getProject(a.p.id)!.mergedInto).toBeNull();
  expect(a.store.getKnowledge(ca.knowledgeId)!.projectId).toBe(a.p.id);
  expect(a.store.db.prepare("SELECT * FROM knowledge_placement_validations").all()).toEqual([]);
  expect(a.store.pendingKnowledgeEvents(a.target)).toEqual([]);
});

test("32: shared global remainder prevents independent over-cap certification", () => {
  const a = fixture(), b = fixture(a.store, "B");
  const ca = a.create("一".repeat(3400), "global"), cb = b.create("一".repeat(3400), "global");
  a.store.completeDreaming(a.success(), [ca.commit], [ca.commit]);
  expect(() => a.store.completeDreaming(b.success(), [cb.commit], [cb.commit])).toThrow(/global.*exceeds 4000/);
  expect(a.store.isKnowledgeProcessed(cb.commit)).toBe(false);
});

test("32: existing CHECK constraints migrate without certifying legacy knowledge; placement audit survives reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-32b-")); dirs.push(dir);
  const file = join(dir, "old.sqlite");
  const a = fixture(new Store(file)), c = a.create(); a.store.close();
  const db = new DatabaseSync(file);
  // SQLite's rename rewrites the schema with quoted table names; old databases may carry these.
  db.exec("ALTER TABLE task_claims RENAME TO renamed_claims; ALTER TABLE renamed_claims RENAME TO task_claims; ALTER TABLE runs RENAME TO renamed_runs; ALTER TABLE renamed_runs RENAME TO runs");
  // Recreate the actual baseline constraint text, preserving all other schema/data.
  db.exec("PRAGMA writable_schema=ON");
  db.prepare("UPDATE sqlite_master SET sql = replace(sql, ?, ?) WHERE name IN ('runs','task_claims')").run("'consolidation','dreaming'", "'consolidation'");
  db.exec("PRAGMA writable_schema=OFF"); db.close();
  const old = new DatabaseSync(file);
  expect(() => old.prepare("INSERT INTO runs(kind,outcome,created_at) VALUES ('dreaming','success','now')").run()).toThrow(/CHECK/); old.close();
  const migrated = new Store(file); stores.push(migrated);
  expect(migrated.isKnowledgeProcessed(c.commit)).toBe(false);
  expect(migrated.pendingKnowledgeEvents(a.target)).toHaveLength(1);
  const run = migrated.recordRun({ kind: "dreaming", sessionId: a.s.id, outcome: "success", createdAt: "now" });
  migrated.completeDreaming(run.id, [c.commit], [c.commit]);
  migrated.declareProject(a.s.id, "B", "mark"); migrated.close();
  const reopened = new Store(file); stores.push(reopened);
  expect(reopened.isKnowledgeProcessed(c.commit)).toBe(true);
  expect(reopened.db.prepare("SELECT * FROM knowledge_placement_validations").all()).toHaveLength(1);
  expect(reopened.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
