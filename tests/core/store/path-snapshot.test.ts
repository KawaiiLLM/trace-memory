// 22a: every applicability question of one operation is answered from one path snapshot. The
// contract these cases pin is public: the same facts, commits and receipts as the per-fact rebuild
// (`factOnPath` with its own default arguments — the pre-22a behaviour), membership that is built
// once however many facts are involved, and no Raw payload loaded to answer an identity question.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { Store, type KnowledgePath } from "../../../src/core/store/index.ts";
import type { Fact } from "../../../src/core/model/index.ts";
import { countPathBuilds, countSourceReads } from "../../perf/fixture.ts";

const time = "2026-09-09T00:00:00Z";
let dir: string, dbPath: string, memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-snapshot-"));
  dbPath = join(dir, "trace.db");
  memory = sourceSeededMemory(dbPath, async () => { throw new Error("these cases call no model"); });
});
afterEach(() => { memory.close(); rmSync(dir, { recursive: true, force: true }); });

/** A session of `turns` Turns, each with a user prompt, a tool call with its result and a reply, and
 * one fact per Turn. Every `unbound`-th fact is written without entry bindings — the older shape
 * whose applicability is answered from the citable addresses. */
function history(turns: number, options: { unbound?: number } = {}) {
  const store = memory.store;
  const projectId = store.createProject({ name: `p${turns}`, declaredBy: "marker" }).id;
  const session = store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId });
  let parent: number | null = null;
  const turnIds: number[] = [];
  for (let i = 0; i < turns; i++) {
    const turn = store.appendTurn({ sessionId: session.id, parentTurnId: parent, kind: "turn", userPrompt: `prompt ${i}`, startedAt: time });
    store.appendToolCall({ turnId: turn.id, name: "read", input: `{"i":${i}}`, result: `result ${i}`, status: "success" });
    store.updateTurn(turn.id, { assistantText: `answer ${i}`, endedAt: time });
    parent = turn.id; turnIds.push(turn.id);
  }
  const entries = store.listSourceEntries(session.id);
  memory.selectEntries(session.id, "main", entries.map(e => e.id));
  const committed = store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
    entryIds: entries.map(e => e.id),
    facts: turnIds.map((turnId, i) => ({ turnId, category: "observation" as const, actor: "user" as const, text: `fact ${i}`,
      source: [`T${turnId}#user`], createdAt: time,
      ...(options.unbound && i % options.unbound === 0 ? {} : { entryIds: [entries.find(e => e.turnId === turnId && e.role === "user")!.id] }) })) });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  const path: KnowledgePath = { sessionId: session.id, headTurnId: turnIds.at(-1)!, branch: "main" };
  const knowledge = store.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "$k1", author: "fake", text: "consolidated", category: "mechanism", scope: "session",
      supports: [committed.facts[0]!.id, committed.facts[1]!.id], reason: "pin the snapshot", topics: [], createdAt: time }],
    consolidated: [committed.facts[0]!.id] });
  if (!knowledge.ok) throw new Error(knowledge.problems.join("; "));
  return { session, path, turnIds, entries, facts: committed.facts, knowledgeId: knowledge.committed[0]!.knowledgeId };
}

/** The pre-22a answer: rebuild the path for every fact, through `factOnPath`'s own default snapshot. */
const uncached = (path: KnowledgePath): Fact[] =>
  memory.store.listSessionFacts(path.sessionId).filter(f => memory.store.factOnPath(f, path)).sort((a, b) => a.id - b.id);

test("22a: applicability is answered from one membership per operation, whatever the fact count", () => {
  const small = history(8), large = history(16);
  const builds = countPathBuilds();
  const measure = (run: () => unknown) => { builds.reset(); run(); return builds.builds(); };
  for (const [a, b] of [
    [measure(() => memory.store.listBranchFacts(small.session.id, "main", small.path.headTurnId)),
      measure(() => memory.store.listBranchFacts(large.session.id, "main", large.path.headTurnId))],
    [measure(() => memory.store.consolidationBatch(small.session.id, "main", small.path.headTurnId!)),
      measure(() => memory.store.consolidationBatch(large.session.id, "main", large.path.headTurnId!))],
    [measure(() => memory.branchSummary(small.session.id, "main", small.path.headTurnId!)),
      measure(() => memory.branchSummary(large.session.id, "main", large.path.headTurnId!))],
    [measure(() => memory.store.citationProblem(small.facts.map(f => f.id), "session", small.path)),
      measure(() => memory.store.citationProblem(large.facts.map(f => f.id), "session", large.path))],
    [measure(() => memory.store.listCurrentKnowledge(small.path)), measure(() => memory.store.listCurrentKnowledge(large.path))],
  ]) {
    expect(a).toBe(b); // twice the facts, the same number of path builds
    expect(a).toBeLessThanOrEqual(3);
  }
  builds.restore();
});

test("22a: an identity question loads no Raw payload, and rendering reads each entry once", () => {
  const { session, path, entries } = history(8);
  const reads = countSourceReads();
  const measure = (run: () => unknown) => { reads.reset(); run(); return reads.reads(); };
  expect(measure(() => memory.store.listBranchFacts(session.id, "main", path.headTurnId))).toBe(0);
  expect(measure(() => memory.store.consolidationBatch(session.id, "main", path.headTurnId!))).toBe(0);
  expect(measure(() => memory.store.citationProblem([1, 2], "session", path))).toBe(0);
  expect(measure(() => memory.store.listCurrentKnowledge(path))).toBe(0);
  // Branch carry renders the pending entries, so it reads them — once each, not once per fact.
  expect(measure(() => memory.branchSummary(session.id, "main", path.headTurnId!))).toBeLessThanOrEqual(entries.length);
  reads.restore();
});

test("22a: the shared snapshot returns exactly what the per-fact rebuild returns, bindings or addresses", () => {
  for (const unbound of [0, 3]) {
    const { session, path } = history(6, { unbound });
    expect(memory.store.listBranchFacts(session.id, "main", path.headTurnId)).toEqual(uncached(path));
    expect(memory.store.consolidationBatch(session.id, "main", path.headTurnId!).map(f => f.id))
      .toEqual(uncached(path).filter(f => !memory.store.consolidatedOnPath(f.id, path)).map(f => f.id));
    expect(memory.store.citationProblem(uncached(path).map(f => f.id), "session", path)).toBeNull();
  }
});

test("22a: a same-Turn sibling occurrence stays off this branch, with bindings and without", () => {
  const { session, path, turnIds, entries } = history(3, { unbound: 2 });
  const store = memory.store;
  // A second assistant occurrence inside the last Turn that only the sibling branch selects.
  const sibling = store.appendSourceEntry({ sessionId: session.id, nativeLineage: "fixture", nativeId: "sibling-1",
    turnId: turnIds.at(-1)!, role: "assistant", text: "sibling reply", raw: "{}", calls: [] });
  memory.selectEntries(session.id, "sibling", [...entries.map(e => e.id), sibling.id]);
  const bound = store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "sibling", createdAt: time },
    facts: [{ turnId: turnIds.at(-1)!, category: "observation", actor: "agent", text: "from the sibling occurrence",
      source: [`T${turnIds.at(-1)}#assistant`], createdAt: time, entryIds: [sibling.id] }] });
  if (!bound.ok) throw new Error(bound.problems.join("; "));
  const siblingPath: KnowledgePath = { sessionId: session.id, headTurnId: turnIds.at(-1)!, branch: "sibling" };
  expect(store.listBranchFacts(session.id, "sibling", siblingPath.headTurnId).map(f => f.id)).toContain(bound.facts[0]!.id);
  expect(store.listBranchFacts(session.id, "main", path.headTurnId).map(f => f.id)).not.toContain(bound.facts[0]!.id);
  expect(store.listBranchFacts(session.id, "main", path.headTurnId)).toEqual(uncached(path));
  expect(store.listBranchFacts(session.id, "sibling", siblingPath.headTurnId)).toEqual(uncached(siblingPath));
});

test("32b performance: batch and ordinary applicability agree for bindings, fallback, foreign facts and historical tips", () => {
  const { session, path, turnIds, entries, facts, knowledgeId } = history(3, { unbound: 2 });
  const store = memory.store;
  const sibling = store.appendSourceEntry({ sessionId: session.id, nativeLineage: "fixture", nativeId: "batch-sibling",
    turnId: turnIds.at(-1)!, role: "assistant", text: "sibling", raw: "{}", calls: [] });
  memory.selectEntries(session.id, "sibling", [...entries.map(e => e.id), sibling.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: time }, facts: [{
    turnId: turnIds.at(-1)!, category: "observation", actor: "agent", text: "withdrawal", source: [`T${turnIds.at(-1)}#assistant`], entryIds: [sibling.id], createdAt: time }] });
  if (!noted.ok) throw Error(noted.problems.join());
  const siblingPath = { ...path, branch: "sibling" };
  const base = store.currentCommit(knowledgeId, path)[0]!;
  const archived = store.commitConsolidationRun({ path: siblingPath, run: { kind: "manual", sessionId: session.id, createdAt: time }, operations: [{
    op: "archive", knowledgeId, baseCommit: base.id, supports: [noted.facts[0]!.id], reason: "sibling only", createdAt: time }] });
  if (!archived.ok) throw Error(archived.problems.join());
  const foreign = history(2);
  const shared = store.commitConsolidationRun({ path: siblingPath, run: { kind: "manual", sessionId: session.id, createdAt: time }, operations: [{
    op: "create", handle: "$shared", author: "test", scope: "global", category: "mechanism", text: "shared", topics: [],
    supports: [...facts, ...noted.facts, ...foreign.facts].map(f => f.id), reason: "all evidence shapes", createdAt: time }] });
  if (!shared.ok) throw Error(shared.problems.join());
  const input = store.commitGraphInput();
  for (const p of [path, siblingPath, { ...path, headTurnId: turnIds[0]! }, foreign.path]) {
    const ordinary = input.revisions.filter(r => store.commitApplies(r, p));
    const graph = store.commitGraph(p, undefined, undefined, input);
    expect([...graph.applicable]).toEqual(ordinary.map(r => r.id));
    for (const f of [...facts, ...noted.facts, ...foreign.facts])
      expect(store.factOnPath(f, p, store.pathSnapshot(p), input.metadata)).toBe(store.factOnPath(f, p));
  }
  expect(store.commitGraph(path).current.map(r => r.id)).toContain(base.id);
  expect(store.commitGraph(siblingPath).current.map(r => r.id)).not.toContain(base.id);
});

test("22a: a snapshot never outlives its operation, so another connection's writes are seen", () => {
  const { session, path, turnIds, entries } = history(4);
  const before = memory.store.listBranchFacts(session.id, "main", path.headTurnId).length;
  const other = new Store(dbPath);
  try {
    // Another executor commits a fact, consolidates an existing one and moves the branch's ancestry.
    const written = other.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
      facts: [{ turnId: turnIds.at(-1)!, category: "observation", actor: "user", text: "from another executor",
        source: [`T${turnIds.at(-1)}#user`], createdAt: time, entryIds: [entries.find(e => e.turnId === turnIds.at(-1) && e.role === "user")!.id] }] });
    if (!written.ok) throw new Error(written.problems.join("; "));
    expect(memory.store.listBranchFacts(session.id, "main", path.headTurnId).length).toBe(before + 1);
    expect(memory.store.consolidationBatch(session.id, "main", path.headTurnId!).map(f => f.id)).toContain(written.facts[0]!.id);
    const consolidated = other.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId: session.id, branch: "main", createdAt: time },
      operations: [], consolidated: [written.facts[0]!.id] });
    if (!consolidated.ok) throw new Error(consolidated.problems.join("; "));
    expect(memory.store.consolidationBatch(session.id, "main", path.headTurnId!).map(f => f.id)).not.toContain(written.facts[0]!.id);
    // A relation is an annotation on a rendered fact, not membership: the next read renders it.
    const carry = memory.branchSummary(session.id, "main", path.headTurnId!);
    const related = other.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: time },
      facts: [{ turnId: turnIds.at(-1)!, category: "observation", actor: "user", text: "negates the first",
        source: [`T${turnIds.at(-1)}#user`], createdAt: time, negate: [{ target: "F1", strength: "strong" }],
        entryIds: [entries.find(e => e.turnId === turnIds.at(-1) && e.role === "user")!.id] }] });
    if (!related.ok) throw new Error(related.problems.join("; "));
    expect(memory.branchSummary(session.id, "main", path.headTurnId!)).not.toBe(carry);
    // A shorter selected ancestry from the other connection takes its entries off this branch.
    other.selectSourcePath(session.id, "main", entries.filter(e => e.turnId === turnIds[0]).map(e => e.id));
    expect(memory.store.listBranchFacts(session.id, "main", path.headTurnId).map(f => f.text)).toEqual(["fact 0"]);
    expect(memory.store.listBranchFacts(session.id, "main", path.headTurnId)).toEqual(uncached(path).filter(f => f.text === "fact 0"));
  } finally { other.close(); }
});
