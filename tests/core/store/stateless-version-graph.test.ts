import { afterEach, expect, test, vi } from "vitest";
import { TraceMemory, memoryFiles } from "../../../src/core/api/index.ts";
import { type KnowledgeRevision } from "../../../src/core/model/index.ts";
import { type KnowledgePath, Store } from "../../../src/core/store/index.ts";
import { curateWrite } from "../../support/dreamer.ts";
import { receiptCommit } from "../../support/seed.ts";

const at = "2026-09-21T12:00:00.000Z";
const tag = (store: Store, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}#${store.versionTag(item.knowledgeId, item.commit)}`;
const history = (store: Store, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, item.commit)}`;
const publishedCommit = (store: Store, item: { knowledgeId: number; version: string }) =>
  receiptCommit(store, item);
const open: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const memory of open.splice(0)) memory.close(); });

function append(store: Store, sessionId: number, parentTurnId: number | null, nativeId: string) {
  const turn = store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: nativeId, startedAt: at });
  const entry = store.appendSourceEntry({ sessionId, nativeLineage: `lineage-${sessionId}`, nativeId, turnId: turn.id,
    role: "user", text: nativeId, raw: JSON.stringify({ role: "user", content: nativeId }), calls: [] });
  return { turn, entry };
}

function fact(store: Store, path: KnowledgePath, turnId: number, entryId: number, text: string) {
  const result = store.commitNotingRun({ run: { kind: "manual", sessionId: path.sessionId, branch: path.branch, createdAt: at }, facts: [{
    turnId, category: "decision", actor: "user", text, source: [`T${turnId}#user`], entryIds: [entryId], createdAt: at,
  }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.facts[0]!;
}

function revision(id: number, parentId: number | null, op: KnowledgeRevision["op"] = parentId === null ? "create" : "update",
  knowledgeId = 1, runId: number | null = id): KnowledgeRevision {
  return { id, knowledgeId, parentId, op, runId, title: null, text: `revision ${id}`, category: "constraint", scope: "global",
    supports: [id], supportSemantics: "change", reason: "Pure graph fixture.", topics: [], createdAt: at };
}

function effective(revisions: KnowledgeRevision[], parents: Map<number, number[]>, grounded = revisions): Set<number> {
  const resolver = (Store.prototype as unknown as { effectiveRevisions(
    revisions: KnowledgeRevision[], parents: Map<number, number[]>, grounded: KnowledgeRevision[]): Set<number> }).effectiveRevisions;
  return resolver.call(Store.prototype, revisions, parents, grounded);
}

function compareCommittedGraph(store: Store, path: KnowledgePath) {
  const cached = store.commitGraph(path, undefined, undefined, store.commitGraphInput(undefined, path.sessionId));
  const fresh = store.commitGraph(path);
  expect([...cached.applicable].sort()).toEqual([...fresh.applicable].sort());
  expect([...cached.effective].sort()).toEqual([...fresh.effective].sort());
  expect(cached.resolved.map(item => item.id)).toEqual(fresh.resolved.map(item => item.id));
  expect(cached.current.map(item => item.id)).toEqual(fresh.current.map(item => item.id));
}

function create(store: Store, path: KnowledgePath, support: number, scope: "session" | "project" | "global", text: string) {
  const result = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: path.sessionId, branch: path.branch, createdAt: at },
    operations: [{ op: "create", title: "Fixture title", handle: "$new", author: "test", text, category: "constraint", scope,
      supports: [support], reason: "Seed stateless graph fixture.", topics: [], createdAt: at }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.committed[0]!;
}

test("64b stateless graph: a later descendant wins over a restored sibling from their common base", () => {
  const revisions = [revision(1, null), revision(2, 1), revision(3, 1), revision(4, 2)];
  const parents = new Map([[1, []], [2, [1]], [3, [1]], [4, [2]]]);
  expect(effective(revisions, parents)).toEqual(new Set([1, 2, 4]));
});

test("64b stateless graph: malformed parent graphs fail explicitly", () => {
  expect(() => effective([revision(1, null)], new Map([[1, [9]]]))).toThrow("missing commit 9");
  expect(() => effective([revision(1, 2), revision(2, 1)], new Map([[1, [2]], [2, [1]]]))).toThrow("lineage cycle at commit");
});

test("64b stateless graph: split lanes coexist and advance independently", () => {
  const revisions = [revision(1, null), revision(2, 1, "split", 2, 7), revision(3, 1, "split", 3, 7),
    revision(4, 2, "update", 2), revision(5, 3, "update", 3)];
  const parents = new Map([[1, []], [2, [1]], [3, [1]], [4, [2]], [5, [3]]]);
  expect(effective(revisions, parents)).toEqual(new Set([1, 2, 3, 4, 5]));
});

test("64b stateless graph: a later alternative split operation replaces the earlier pair atomically", () => {
  const revisions = [revision(1, null), revision(2, 1, "split", 2, 7), revision(3, 1, "split", 3, 7),
    revision(4, 1, "split", 4, 8), revision(5, 1, "split", 5, 8)];
  const parents = new Map([[1, []], [2, [1]], [3, [1]], [4, [1]], [5, [1]]]);
  expect(effective(revisions, parents)).toEqual(new Set([1, 4, 5]));
});

test("64b stateless graph: an ineffective merge no longer hides its independent absorbed identity", () => {
  const revisions = [revision(1, null, "create", 1), revision(2, null, "create", 2), revision(3, 1, "update", 1),
    revision(4, 1, "merge", 1), revision(5, 3, "update", 1)];
  const parents = new Map([[1, []], [2, []], [3, [1]], [4, [1, 2]], [5, [3]]]);
  expect(effective(revisions, parents)).toEqual(new Set([1, 2, 3, 5]));
});

test("64b stateless graph: genuine alternative split operations keep only the operation with the later applicable subtree", () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("unexpected non-Dreamer phase"); }); open.push(memory);
  const store = memory.store, project = store.createProject({ name: "alternative-splits", declaredBy: "mark" });
  const a = store.createSession({ enrollmentChoice: true, host: "split-A", startedAt: at, firstReplyAt: at, projectId: project.id });
  const b = store.createSession({ enrollmentChoice: true, host: "split-B", startedAt: at, firstReplyAt: at, projectId: project.id });
  const a0 = append(store, a.id, null, "a-root"), a1 = append(store, a.id, a0.turn.id, "a-split");
  const b0 = append(store, b.id, null, "b-root"), b1 = append(store, b.id, b0.turn.id, "b-split");
  store.selectSourcePath(a.id, "main", [a0.entry.id, a1.entry.id]); store.selectSourcePath(a.id, "rewind", [a0.entry.id]);
  store.selectSourcePath(b.id, "main", [b0.entry.id, b1.entry.id]);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage"); store.setCurrentPath(b.id, "main", b1.turn.id, "test-lineage");
  const aPath = { sessionId: a.id, branch: "main", headTurnId: a1.turn.id, triggerEntryId: a1.entry.id };
  const bPath = { sessionId: b.id, branch: "main", headTurnId: b1.turn.id, triggerEntryId: b1.entry.id };
  const rootFact = fact(store, aPath, a0.turn.id, a0.entry.id, "stable split base");
  const aFact = fact(store, aPath, a1.turn.id, a1.entry.id, "first split support");
  const bFact = fact(store, bPath, b1.turn.id, b1.entry.id, "second split support");
  const base = create(store, aPath, rootFact.id, "global", "split base");
  let sequence = 0;
  const split = (path: typeof aPath, support: number, labels: [string, string]) => {
    const committed = curateWrite(memory, path, [{ op: "split", knowledgeId: base.knowledgeId, baseCommit: store.currentCommit(base.knowledgeId, path)[0]!.id,
      text: `primary ${++sequence}`, category: "constraint", scope: "global", topics: [], supports: [support], reason: "Alternative atomic split.", createdAt: at,
      children: labels.map(text => ({ title: "Fixture child", text, category: "constraint" as const, topics: [] })) }]);
    const children = committed.filter(item => item.knowledgeId !== base.knowledgeId).map(item => item.commit);
    expect(children).toHaveLength(2);
    return children;
  };

  const first = split(aPath, aFact.id, ["first A", "first B"]);
  compareCommittedGraph(store, aPath);
  store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);
  const second = split(bPath, bFact.id, ["second A", "second B"]);
  compareCommittedGraph(store, bPath);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);
  const graph = store.commitGraph(bPath);
  expect(first.every(id => graph.applicable.has(id) && !graph.effective.has(id))).toBe(true);
  expect(second.every(id => graph.effective.has(id) && graph.resolved.some(item => item.id === id))).toBe(true);
});

test("64b stateless graph: admitted deep branch defeats a restored sibling from the common base", () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("unexpected non-Dreamer phase"); }); open.push(memory);
  const store = memory.store, project = store.createProject({ name: "deep-fork", declaredBy: "mark" });
  const a = store.createSession({ enrollmentChoice: true, host: "deep-A", startedAt: at, firstReplyAt: at, projectId: project.id });
  const b = store.createSession({ enrollmentChoice: true, host: "deep-B", startedAt: at, firstReplyAt: at, projectId: project.id });
  const a0 = append(store, a.id, null, "a-root"), a1 = append(store, a.id, a0.turn.id, "a-fact");
  const b0 = append(store, b.id, null, "b-root"), b1 = append(store, b.id, b0.turn.id, "b-fact");
  store.selectSourcePath(a.id, "main", [a0.entry.id, a1.entry.id]);
  store.selectSourcePath(a.id, "rewind", [a0.entry.id]);
  store.selectSourcePath(b.id, "main", [b0.entry.id, b1.entry.id]);
  store.selectSourcePath(b.id, "rewind", [b0.entry.id]);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  store.setCurrentPath(b.id, "main", b1.turn.id, "test-lineage");
  const aPath = { sessionId: a.id, branch: "main", headTurnId: a1.turn.id, triggerEntryId: a1.entry.id };
  const bPath = { sessionId: b.id, branch: "main", headTurnId: b1.turn.id, triggerEntryId: b1.entry.id };
  const rootFact = fact(store, aPath, a0.turn.id, a0.entry.id, "stable root support");
  const aFact = fact(store, aPath, a1.turn.id, a1.entry.id, "A branch support");
  const bFact = fact(store, bPath, b1.turn.id, b1.entry.id, "B sibling support");
  const base = create(store, aPath, rootFact.id, "global", "common base");
  let sequence = 0;
  const update = (path: typeof aPath, prior: { knowledgeId: number; commit: number }, support: number, text: string) => {
    ++sequence;
    const [result] = curateWrite(memory, path, [{ op: "update", knowledgeId: prior.knowledgeId, baseCommit: prior.commit, text, category: "constraint", scope: "global",
      supports: [support], reason: "Advance the selected branch.", topics: [], createdAt: at }]);
    return result!;
  };

  const second = update(aPath, base, aFact.id, "A branch second");
  compareCommittedGraph(store, aPath);
  store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);
  const third = update(bPath, base, bFact.id, "B sibling third");
  compareCommittedGraph(store, bPath);
  store.setCurrentPath(b.id, "rewind", b0.turn.id, "test-lineage");
  compareCommittedGraph(store, aPath);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  compareCommittedGraph(store, aPath);
  const fourth = update(aPath, second, aFact.id, "A branch fourth");
  compareCommittedGraph(store, aPath);
  store.setCurrentPath(b.id, "main", b1.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);

  const graph = store.commitGraph(bPath);
  expect(graph.applicable.has(third.commit)).toBe(true);
  expect(graph.effective.has(third.commit)).toBe(false);
  expect(graph.effective.has(fourth.commit)).toBe(true);
  expect(store.currentCommit(base.knowledgeId, bPath).map(item => item.id)).toEqual([fourth.commit]);
});

test("64b stateless graph: direct-only scope, merge/split provenance and cross-identity stale guidance", () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("unexpected non-Dreamer phase"); }); open.push(memory);
  const store = memory.store, project = store.createProject({ name: "stateless-graph", declaredBy: "mark" });
  const a = store.createSession({ enrollmentChoice: true, host: "graph-A", startedAt: at, firstReplyAt: at, projectId: project.id });
  const b = store.createSession({ enrollmentChoice: true, host: "graph-B", startedAt: at, firstReplyAt: at, projectId: project.id });
  const c = store.createSession({ enrollmentChoice: true, host: "graph-C", startedAt: at, firstReplyAt: at, projectId: project.id });
  const a0 = append(store, a.id, null, "a-root"), a1 = append(store, a.id, a0.turn.id, "a-child");
  const b0 = append(store, b.id, null, "b-root");
  const c0 = append(store, c.id, null, "c-root"), c1 = append(store, c.id, c0.turn.id, "c-child");
  store.selectSourcePath(a.id, "main", [a0.entry.id, a1.entry.id]);
  store.selectSourcePath(a.id, "rewind", [a0.entry.id]);
  store.selectSourcePath(b.id, "main", [b0.entry.id]);
  store.selectSourcePath(c.id, "main", [c0.entry.id, c1.entry.id]);
  store.selectSourcePath(c.id, "rewind", [c0.entry.id]);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  store.setCurrentPath(b.id, "main", b0.turn.id, "test-lineage");
  store.setCurrentPath(c.id, "main", c1.turn.id, "test-lineage");
  const aPath = { sessionId: a.id, branch: "main", headTurnId: a1.turn.id, triggerEntryId: a1.entry.id };
  const bPath = { sessionId: b.id, branch: "main", headTurnId: b0.turn.id };
  const cPath = { sessionId: c.id, branch: "main", headTurnId: c1.turn.id };
  const aFact = fact(store, aPath, a1.turn.id, a1.entry.id, "A-only parent support");
  const bFact = fact(store, bPath, b0.turn.id, b0.entry.id, "B direct result support");
  const cFact = fact(store, cPath, c1.turn.id, c1.entry.id, "restorable sibling support");

  const scopedParent = create(store, aPath, aFact.id, "session", "session parent");
  const survivor = create(store, aPath, aFact.id, "global", "merge survivor parent");
  const absorbed = create(store, aPath, aFact.id, "global", "merge absorbed parent");
  const splitParent = create(store, aPath, aFact.id, "global", "split parent");
  const [absorbedSibling, splitSibling] = curateWrite(memory, aPath, [
    { op: "update", knowledgeId: absorbed.knowledgeId, baseCommit: absorbed.commit, text: "restorable absorbed sibling",
      category: "constraint", scope: "global", supports: [cFact.id], reason: "Create competing merge sibling.", topics: [], createdAt: at },
    { op: "update", knowledgeId: splitParent.knowledgeId, baseCommit: splitParent.commit, text: "restorable split-source sibling",
      category: "constraint", scope: "global", supports: [cFact.id], reason: "Create competing split sibling.", topics: [], createdAt: at },
  ]) as [{ knowledgeId: number; commit: number }, { knowledgeId: number; commit: number }];
  store.setCurrentPath(c.id, "rewind", c0.turn.id, "test-lineage");
  expect(store.currentCommit(absorbed.knowledgeId, bPath).map(revision => revision.id)).toEqual([absorbed.commit]);
  expect(store.currentCommit(splitParent.knowledgeId, bPath).map(revision => revision.id)).toEqual([splitParent.commit]);
  const [scopedResult] = curateWrite(memory, aPath, [{ op: "update", knowledgeId: scopedParent.knowledgeId, baseCommit: scopedParent.commit, text: "global child with B support",
    category: "constraint", scope: "global", supports: [bFact.id], reason: "Direct child evidence changes scope.", topics: [], createdAt: at }]);
  const scopedChild = scopedResult!.commit;
  compareCommittedGraph(store, bPath);

  const [mergeResult, , ...splitResults] = curateWrite(memory, aPath, [
    { op: "merge", intoKnowledgeId: survivor.knowledgeId, intoBaseCommit: survivor.commit, absorb: [{ knowledgeId: absorbed.knowledgeId, baseCommit: absorbed.commit }],
      text: "merged result with B support", category: "constraint", scope: "global", supports: [bFact.id], reason: "Merge distinct identities.", topics: [], createdAt: at },
    { op: "split", knowledgeId: splitParent.knowledgeId, baseCommit: splitParent.commit, text: "split primary part", category: "constraint", scope: "global", topics: [],
      supports: [bFact.id], reason: "Split into atomic results.", createdAt: at,
      children: [{ title: "Fixture child", text: "split result one", category: "constraint", topics: [] }, { title: "Fixture child", text: "split result two", category: "constraint", topics: [] }] },
  ]);
  const mergeCommit = mergeResult!.commit, splitChildren = splitResults.map(item => item.commit);
  // The restored siblings' bases are stale now: refused, and the refusal names the current results.
  store.setCurrentPath(c.id, "main", c1.turn.id, "test-lineage");
  const stale = store.commitWorkspaceRun({ path: aPath, run: { kind: "dreaming", sessionId: a.id, branch: "main", createdAt: at }, operations: [
    { op: "archive", kind: "invalid", knowledgeId: absorbed.knowledgeId, baseCommit: absorbedSibling.commit, text: "The restored merge sibling no longer holds; the merge replaces it.", supports: [bFact.id], reason: "Stale restored merge sibling.", createdAt: at },
    { op: "archive", kind: "invalid", knowledgeId: splitParent.knowledgeId, baseCommit: splitSibling.commit, text: "The restored split sibling no longer holds; the split replaces it.", supports: [bFact.id], reason: "Stale restored split sibling.", createdAt: at }] });
  const [staleMerge, staleSplit] = stale.results;
  expect(staleMerge).toMatchObject({ ok: false, stale: true });
  if (!staleMerge!.ok) expect(staleMerge!.reason).toContain(`current: K${survivor.knowledgeId}@v${store.versionOrdinal(survivor.knowledgeId, mergeCommit)}`);
  expect(staleSplit).toMatchObject({ ok: false, stale: true });
  if (!staleSplit!.ok) for (const child of splitChildren) expect(staleSplit!.reason).toContain(`K${store.knowledgeRevision(child)!.knowledgeId}@v1`);
  expect(splitChildren).toHaveLength(2);
  compareCommittedGraph(store, bPath);

  store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);
  const graph = store.commitGraph(bPath);
  for (const parent of [scopedParent.commit, survivor.commit, absorbed.commit, splitParent.commit])
    expect(graph.applicable.has(parent)).toBe(false);
  for (const resultCommit of [scopedChild, mergeCommit, ...splitChildren]) {
    expect(graph.applicable.has(resultCommit)).toBe(true);
    expect(graph.effective.has(resultCommit)).toBe(true);
  }
  expect(store.currentKnowledge(bPath).find(item => item.knowledge.id === scopedParent.knowledgeId)?.revision)
    .toMatchObject({ id: scopedChild, scope: "global" });
  expect(store.currentCommit(survivor.knowledgeId, bPath).map(revision => revision.id)).toEqual([mergeCommit]);
  expect(store.currentCommit(absorbed.knowledgeId, bPath)).toEqual([]);
  expect(store.commitGraph(bPath).effective.has(absorbedSibling.commit)).toBe(false);
  expect(store.commitGraph(bPath).effective.has(splitSibling.commit)).toBe(false);
  expect(splitChildren.every(id => store.currentCommit(store.knowledgeRevision(id)!.knowledgeId, bPath)[0]?.id === id)).toBe(true);
});
