import { afterEach, expect, test, vi } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { type KnowledgeRevision } from "../../../src/core/model/index.ts";
import { type KnowledgePath, Store } from "../../../src/core/store/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { suppliedHandles } from "../../dreaming-skips.ts";

const at = "2026-09-21T12:00:00.000Z";
const tag = (store: Store, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}#${store.versionTag(item.knowledgeId, item.commit)}`;
const history = (store: Store, item: { knowledgeId: number; commit: number }) => `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, item.commit)}`;
const publishedCommit = (store: Store, item: { knowledgeId: number; version: string }) =>
  store.resolveVersionOrdinal(item.knowledgeId, Number(/@v(\d+)$/.exec(item.version)![1]));
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
  return { id, knowledgeId, parentId, op, runId, text: `revision ${id}`, category: "constraint", scope: "global",
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
    operations: [{ op: "create", handle: "$new", author: "test", text, category: "constraint", scope,
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

test("64b stateless graph: genuine alternative split operations keep only the operation with the later applicable subtree", async () => {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected non-Dreamer phase"); });
  const memory = TraceMemory(":memory:", scenarios.agent); open.push(memory);
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
  const split = async (path: typeof aPath, support: number, labels: [string, string]) => {
    const trigger = createDreamerTrigger(memory, path, support, ++sequence, "global");
    let children: number[] = [];
    const dreamed = await scenarios.run(memory, path, input => {
      const request = { fixture: `alternative split ${sequence}` }; input.reportRequest(request);
      const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
      trace.execute({ address: tag(store, base), itemBudget: null, pageBudget: 8000 });
      trace.execute({ address: tag(store, trigger), itemBudget: null, pageBudget: 8000 });
      const receipt = JSON.parse(write.execute({ operations: [
        { op: "split", id: tag(store, base), supports: [`F${support}`], reason: "Alternative atomic split.",
          children: labels.map(text => ({ text, category: "constraint", topics: [] })) },
        { op: "archive", id: tag(store, trigger), supports: [`F${support}`], reason: "Retire trigger." },
      ], skipped: [] }));
      children = receipt.committed.filter((item: { op: string }) => item.op === "split").map((item: { knowledgeId: number; version: string }) => publishedCommit(store, item));
      expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
      return { outcome: "success", output: labels.join("/"), request };
    });
    expect(dreamed.outcome).toBe("success"); expect(children).toHaveLength(2);
    return children;
  };

  const first = await split(aPath, aFact.id, ["first A", "first B"]);
  compareCommittedGraph(store, aPath);
  store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);
  const second = await split(bPath, bFact.id, ["second A", "second B"]);
  compareCommittedGraph(store, bPath);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);
  const graph = store.commitGraph(bPath);
  expect(first.every(id => graph.applicable.has(id) && !graph.effective.has(id))).toBe(true);
  expect(second.every(id => graph.effective.has(id) && graph.resolved.some(item => item.id === id))).toBe(true);
});

test("64b stateless graph: admitted deep branch defeats a restored sibling from the common base", async () => {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected non-Dreamer phase"); });
  const memory = TraceMemory(":memory:", scenarios.agent); open.push(memory);
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
  const update = async (path: typeof aPath, prior: { knowledgeId: number; commit: number }, support: number, text: string) => {
    const trigger = createDreamerTrigger(memory, path, support, ++sequence, "global");
    let result!: { knowledgeId: number; commit: number };
    const dreamed = await scenarios.run(memory, path, input => {
      const request = { fixture: `64b deep fork ${sequence}` }; input.reportRequest(request);
      const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
      trace.execute({ address: tag(store, prior), itemBudget: null, pageBudget: 8000 });
      trace.execute({ address: tag(store, trigger), itemBudget: null, pageBudget: 8000 });
      const receipt = JSON.parse(write.execute({ operations: [
        { op: "update", id: tag(store, prior), text, category: "constraint", scope: "global",
          supports: [`F${support}`], reason: "Advance the selected branch.", topics: [] },
        { op: "archive", id: tag(store, trigger), supports: [`F${support}`], reason: "Retire trigger." },
      ], skipped: [] }));
      const published = receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === prior.knowledgeId);
      result = { knowledgeId: prior.knowledgeId, commit: publishedCommit(store, published) };
      expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
      return { outcome: "success", output: text, request };
    });
    expect(dreamed.outcome).toBe("success");
    return result;
  };

  const second = await update(aPath, base, aFact.id, "A branch second");
  compareCommittedGraph(store, aPath);
  store.setCurrentPath(a.id, "rewind", a0.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);
  const third = await update(bPath, base, bFact.id, "B sibling third");
  compareCommittedGraph(store, bPath);
  store.setCurrentPath(b.id, "rewind", b0.turn.id, "test-lineage");
  compareCommittedGraph(store, aPath);
  store.setCurrentPath(a.id, "main", a1.turn.id, "test-lineage");
  compareCommittedGraph(store, aPath);
  const fourth = await update(aPath, second, aFact.id, "A branch fourth");
  compareCommittedGraph(store, aPath);
  store.setCurrentPath(b.id, "main", b1.turn.id, "test-lineage");
  compareCommittedGraph(store, bPath);

  const graph = store.commitGraph(bPath);
  expect(graph.applicable.has(third.commit)).toBe(true);
  expect(graph.effective.has(third.commit)).toBe(false);
  expect(graph.effective.has(fourth.commit)).toBe(true);
  expect(store.currentCommit(base.knowledgeId, bPath).map(item => item.id)).toEqual([fourth.commit]);
});

test("64b stateless graph: direct-only scope, merge/split provenance and cross-identity stale guidance", async () => {
  const scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("unexpected non-Dreamer phase"); });
  const memory = TraceMemory(":memory:", scenarios.agent); open.push(memory);
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
  const siblingTrigger = createDreamerTrigger(memory, aPath, aFact.id, 1, "global");
  let absorbedSibling = { commit: 0 }, splitSibling = { commit: 0 };
  const siblingRun = await scenarios.run(memory, aPath, input => {
    const request = { fixture: "64b restorable sibling branches" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    for (const item of [scopedParent, survivor, absorbed, splitParent, siblingTrigger])
      trace.execute({ address: tag(store, item), itemBudget: null, pageBudget: 8000 });
    const operated = new Set([absorbed, splitParent, siblingTrigger]
      .map(item => history(store, item)));
    const unchangedSupplied = suppliedHandles(input.material.changed).filter(knowledge => !operated.has(knowledge));
    const receipt = JSON.parse(write.execute({ operations: [
      { op: "update", id: tag(store, absorbed), text: "restorable absorbed sibling",
        category: "constraint", scope: "global", supports: [`F${cFact.id}`], reason: "Create competing merge sibling.", topics: [] },
      { op: "update", id: tag(store, splitParent), text: "restorable split-source sibling",
        category: "constraint", scope: "global", supports: [`F${cFact.id}`], reason: "Create competing split sibling.", topics: [] },
      { op: "archive", id: tag(store, siblingTrigger), supports: [`F${aFact.id}`], reason: "Retire first trigger." },
    ], skipped: unchangedSupplied.map(knowledge => ({ knowledge, because: "Not part of the sibling construction." })) }));
    absorbedSibling = { commit: publishedCommit(store, receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === absorbed.knowledgeId)) };
    splitSibling = { commit: publishedCommit(store, receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === splitParent.knowledgeId)) };
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "siblings created", request };
  });
  expect(siblingRun.outcome, JSON.stringify(siblingRun)).toBe("success");
  store.setCurrentPath(c.id, "rewind", c0.turn.id, "test-lineage");
  expect(store.currentCommit(absorbed.knowledgeId, bPath).map(revision => revision.id)).toEqual([absorbed.commit]);
  expect(store.currentCommit(splitParent.knowledgeId, bPath).map(revision => revision.id)).toEqual([splitParent.commit]);
  const sessionTrigger = createDreamerTrigger(memory, aPath, aFact.id, 1, "session");
  let scopedChild = 0, mergeCommit = 0, splitChildren: number[] = [];
  const scopeChange = await scenarios.run(memory, aPath, input => {
    const request = { fixture: "64b stateless session scope change" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    for (const item of [scopedParent, sessionTrigger])
      trace.execute({ address: tag(store, item), itemBudget: null, pageBudget: 8000 });
    const receipt = JSON.parse(write.execute({ operations: [
      { op: "update", id: tag(store, scopedParent), text: "global child with B support",
        category: "constraint", scope: "global", supports: [`F${bFact.id}`], reason: "Direct child evidence changes scope.", topics: [] },
      { op: "archive", id: tag(store, sessionTrigger), supports: [`F${aFact.id}`], reason: "Retire session trigger." },
    ], skipped: [] }));
    scopedChild = publishedCommit(store, receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === scopedParent.knowledgeId));
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "scope changed", request };
  });
  expect(scopeChange.outcome).toBe("success");
  compareCommittedGraph(store, bPath);

  const trigger = createDreamerTrigger(memory, aPath, aFact.id, 2, "global");
  const commit = vi.spyOn(store, "commitConsolidationRun");
  const result = await scenarios.run(memory, aPath, input => {
    const request = { fixture: "64b stateless cross-identity graph" }; input.reportRequest(request);
    const trace = input.tools.find(tool => tool.name === "trace")!, write = input.tools.find(tool => tool.name === "memory")!;
    for (const item of [survivor, absorbed, splitParent, trigger])
      trace.execute({ address: tag(store, item), itemBudget: null, pageBudget: 8000 });
    const receipt = JSON.parse(write.execute({ operations: [
      { op: "merge", id: tag(store, survivor), absorb: [tag(store, absorbed)],
        text: "merged result with B support", category: "constraint", scope: "global", supports: [`F${bFact.id}`],
        reason: "Merge distinct identities.", topics: [] },
      { op: "split", id: tag(store, splitParent), supports: [`F${bFact.id}`], reason: "Split into atomic results.",
        children: [{ text: "split result one", category: "constraint", topics: [] }, { text: "split result two", category: "constraint", topics: [] }] },
      { op: "archive", id: tag(store, trigger), supports: [`F${aFact.id}`], reason: "Retire trigger." },
    ], skipped: [] }));
    mergeCommit = publishedCommit(store, receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === survivor.knowledgeId));
    splitChildren = receipt.committed.filter((item: { op: string }) => item.op === "split").map((item: { knowledgeId: number; version: string }) => publishedCommit(store, item));

    const admittedRun = commit.mock.calls.at(-1)![0].run;
    store.setCurrentPath(c.id, "main", c1.turn.id, "test-lineage");
    const stale = store.commitConsolidationRun({ path: aPath, run: admittedRun, operations: [{ op: "archive",
      knowledgeId: absorbed.knowledgeId, baseCommit: absorbedSibling.commit, supports: [bFact.id], reason: "Stale restored merge sibling.", createdAt: at }] });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.problems.join(" ")).toContain(`current: K${survivor.knowledgeId}@${mergeCommit}`);
    const staleSplit = store.commitConsolidationRun({ path: aPath, run: admittedRun, operations: [{ op: "archive",
      knowledgeId: splitParent.knowledgeId, baseCommit: splitSibling.commit, supports: [bFact.id], reason: "Stale restored split sibling.", createdAt: at }] });
    expect(staleSplit.ok).toBe(false);
    if (!staleSplit.ok) for (const child of splitChildren) expect(staleSplit.problems.join(" ")).toContain(`@${child}`);
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "graph maintained", request };
  });
  expect(result.outcome, JSON.stringify(result)).toBe("success");
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
