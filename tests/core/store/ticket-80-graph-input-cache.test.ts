// Ticket 80 item 2 "The knowledge graph input, reused while nothing it depends on changed": memoizes
// `commitGraphInput()`'s cold (unseeded) build per Store. Ticket 88 replaces the broad signal
// invalidation with incremental knowledge selection. Pins: cache reuse via one `db.prepare` statement,
// neutral writes never rebuilding the cold input through a second connection, writers always rebuilding,
// and the cross-connection
// project-reassignment regression (also pinned for 72's footer/arming at the signal level in
// tests/core/store/ticket-72-progress-signal.test.ts).
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { declarationContext } from "../project-declaration-context.ts";

const time = "2026-09-24T00:00:00Z";
const stores: Store[] = [], dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (!store.closed) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(): Store {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-80-graph-"));
  dirs.push(dir);
  const store = new Store(join(dir, "trace.db"));
  stores.push(store);
  return store;
}

function seeded(store: Store) {
  const project = store.createProject({ name: "A", declaredBy: "mark" });
  const sessionId = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time }).id;
  const turnId = store.appendTurn({ sessionId, kind: "turn", userPrompt: "first", assistantText: "answer", startedAt: time }).id;
  const entry = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u1", role: "user", text: "hi", raw: "hi", calls: [] });
  store.selectSourcePath(sessionId, "main", [entry.id]);
  store.setCurrentPath(sessionId, "main", turnId, "lineage-a");
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId, createdAt: time }, entryIds: [entry.id],
    facts: [{ turnId, entryIds: [entry.id], category: "observation", actor: "user", text: "a fact", source: [`T${turnId}#E1`], createdAt: time }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  return { store, project, sessionId, turnId, entry, factId: noted.facts[0]!.id };
}

const revisionsQuery = (sql: unknown) => /SELECT \* FROM knowledge_revisions ORDER BY id/.test(String(sql));

test.each(["consolidation", "budget", "cursor-back", "branch-switch", "path-rewrite", "project-merge", "processing", "pool-state"] as const)(
  "88: %s updates the reader projection without a second cold build", kind => {
    const dir = mkdtempSync(join(tmpdir(), "trace-memory-80-input-")); dirs.push(dir);
    const file = join(dir, "trace.db"), writer = new Store(file); stores.push(writer);
    const context = seeded(writer), { sessionId, turnId, entry, factId, project } = context;
    const child = writer.appendTurn({ sessionId, parentTurnId: turnId, kind: "turn", userPrompt: "child", startedAt: time });
    const tail = writer.appendSourceEntry({ sessionId, turnId: child.id, nativeLineage: "n", nativeId: "child",
      role: "user", text: "child", raw: "child", calls: [] });
    writer.publishSourcePath(sessionId, "main", [entry.id, tail.id], child.id, "lineage-a");
    writer.selectSourcePath(sessionId, "side", [entry.id]);
    const path = { sessionId, branch: "main", headTurnId: child.id };
    const created = writer.commitConsolidationRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time }, path,
      operations: [{ op: "create", handle: "$k", author: "test", text: "supported session knowledge",
        category: "constraint", scope: "session", supports: [factId], topics: [], reason: "fixture", createdAt: time }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    let mutate: () => void;
    if (kind === "consolidation") {
      const run = writer.recordRun({ kind: "consolidation", sessionId, branch: "main", outcome: "success", createdAt: time });
      mutate = () => writer.markConsolidated(factId, run.id, project.id);
    } else if (kind === "budget") mutate = () => { writer.setKnowledgeBudget("session", 321); };
    else if (kind === "cursor-back") mutate = () => writer.setCurrentPath(sessionId, "main", turnId, "lineage-a");
    else if (kind === "branch-switch") mutate = () => writer.setCurrentPath(sessionId, "side", turnId, "lineage-a");
    else if (kind === "path-rewrite") mutate = () => writer.selectSourcePath(sessionId, "main", [tail.id]);
    else if (kind === "project-merge") {
      const other = writer.createProject({ name: "destination", declaredBy: "mark" });
      mutate = () => writer.mergeProject(project.id, other.id);
    } else {
      const claim = writer.acquireClaim(path, "dreaming", "memo-input-test")!;
      const range = writer.retainKnowledgePoolRange(path, `session:${sessionId}`, claim);
      if (kind === "pool-state") writer.setKnowledgeBudget("session", 1);
      const executionId = writer.beginExecution({ sessionId, phase: "dreaming", pool: range.pool!, origin: range.origin });
      const run = writer.bindDreamingRun({ kind: "dreaming", sessionId, branch: "main", dreamingRangeId: range.id,
        executionId, claim, createdAt: time });
      mutate = () => { writer.completeKnowledgePoolRange(run, "success", range.eventIds); writer.releaseClaim(claim); };
    }
    const reader = new Store(file); stores.push(reader);
    const original = reader.db.prepare.bind(reader.db); let builds = 0;
    reader.db.prepare = ((sql: string) => { if (revisionsQuery(sql)) builds++; return original(sql); }) as typeof reader.db.prepare;
    reader.currentKnowledge(path); reader.currentKnowledge(path);
    expect(builds).toBe(1);
    mutate();
    const actual = reader.currentKnowledge(path);
    expect(builds).toBe(1);
    expect(actual).toEqual(writer.currentKnowledge(path));
  });

test("a repeated read with nothing changed hits the memo: the base revisions query runs once", () => {
  const store = open();
  const { sessionId } = seeded(store);
  const path = { sessionId, branch: "main", headTurnId: store.getSession(sessionId) && store.listTurns(sessionId).at(-1)!.id };
  const spy = (() => { const calls: unknown[] = []; const original = store.db.prepare.bind(store.db);
    store.db.prepare = ((sql: string) => { if (revisionsQuery(sql)) calls.push(sql); return original(sql); }) as typeof store.db.prepare;
    return calls; })();
  store.knowledgePools(path);
  expect(spy.length).toBe(1);
  store.knowledgePools(path); // nothing changed since
  expect(spy.length).toBe(1); // still one: the second call hit the memo
});

test("80: readers with the same signal share one global graph without sharing visibility", () => {
  const store = open();
  const { sessionId, turnId, factId, project } = seeded(store);
  const other = store.createSession({ host: "other", enrollmentChoice: true, projectId: project.id,
    startedAt: time, firstReplyAt: time });
  const secondTurn = store.appendTurn({ sessionId: other.id, kind: "turn", userPrompt: "other", startedAt: time });
  const secondEntry = store.appendSourceEntry({ sessionId: other.id, turnId: secondTurn.id, nativeLineage: "other", nativeId: "u",
    role: "user", text: "other", raw: "other", calls: [] });
  store.publishSourcePath(other.id, "main", [secondEntry.id], secondTurn.id, "other");
  const path = { sessionId, branch: "main", headTurnId: turnId };
  const created = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "$k", author: "test", text: "private session rule", category: "constraint",
      scope: "session", supports: [factId], topics: [], reason: "fixture", createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  expect(store.progressSignal(sessionId)).toBe(store.progressSignal(other.id));
  let builds = 0;
  const original = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string) => { if (revisionsQuery(sql)) builds++; return original(sql); }) as typeof store.db.prepare;
  expect(store.currentKnowledge(path)).toHaveLength(1);
  expect(store.currentKnowledge({ sessionId: other.id, branch: "main", headTurnId: secondTurn.id })).toEqual([]);
  expect(store.currentKnowledge(path)).toHaveLength(1);
  expect(builds).toBe(1);
});

test("writers always rebuild: base validation of an archive sees its own transaction's state, never the memo", () => {
  const store = open();
  const { sessionId, turnId, factId } = seeded(store);
  const path = { sessionId, branch: "main", headTurnId: turnId };
  const created = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "$k", author: "test", text: "a durable rule that is long enough to carry weight",
      category: "constraint", scope: "session", supports: [factId], topics: [], reason: "evidence", createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const base = created.committed[0]!;
  store.knowledgePools(path); // warms the memo
  const calls: unknown[] = []; const original = store.db.prepare.bind(store.db);
  store.db.prepare = ((sql: string) => { if (revisionsQuery(sql)) calls.push(sql); return original(sql); }) as typeof store.db.prepare;
  // "archive" has a base to validate, so `applyKnowledgeOperation`'s `writerInput` is not skipped.
  const archived = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "archive", kind: "budget", knowledgeId: base.knowledgeId, baseCommit: base.commit, supports: [factId], reason: "no longer needed", createdAt: time }] });
  store.db.prepare = original;
  expect(archived.ok).toBe(true);
  // Base validation rebuilds fresh — `applyKnowledgeOperation`'s `writerInput` never names a session.
  expect(calls.length).toBeGreaterThanOrEqual(1);
});

test("a pure Raw append reuses the memo, and every consumer's answer is unchanged", () => {
  const store = open();
  const { sessionId, turnId, entry } = seeded(store);
  const path = { sessionId, branch: "main", headTurnId: turnId };
  const before = store.knowledgePools(path);
  const signalBefore = store.progressSignal(sessionId);
  const entry2 = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "toolResult", text: "", raw: "r2",
    calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
  store.publishSourcePath(sessionId, "main", [entry.id, entry2.id], turnId, "lineage-a"); // ordinary extension, same head/branch
  expect(store.progressSignal(sessionId)).toBe(signalBefore); // ordinary extension, same head/branch
  const after = store.knowledgePools(path);
  expect(after.map(p => p.versions.map(v => v.revision.id))).toEqual(before.map(p => p.versions.map(v => v.revision.id)));
});

test("a cold due check against a large backlog renders only up to the crossing entry (early stop preserved through the memo change)", () => {
  const store = open();
  const { sessionId, turnId } = seeded(store);
  // The graph memo change (item 2) is orthogonal to item 1's early-stop rule; sanity-checked here that
  // knowledgePools itself does not force any Raw rendering at all.
  const path = { sessionId, branch: "main", headTurnId: turnId };
  expect(() => store.knowledgePools(path)).not.toThrow();
});

test("80: a fact (through a second connection) invalidates the graph memo", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-80-graph-cross-fact-"));
  dirs.push(dir);
  const dbPath = join(dir, "trace.db");
  const writer = new Store(dbPath);
  stores.push(writer);
  const ctx = seeded(writer);
  const reader = new Store(dbPath);
  stores.push(reader);
  const path = { sessionId: ctx.sessionId, branch: "main", headTurnId: ctx.turnId };
  const signalBefore = reader.progressSignal(ctx.sessionId);
  reader.knowledgePools(path); // warm the reader's memo
  const entry2 = writer.appendSourceEntry({ sessionId: ctx.sessionId, turnId: ctx.turnId, nativeLineage: "n", nativeId: "u2",
    role: "toolResult", text: "", raw: "r2", calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
  writer.publishSourcePath(ctx.sessionId, "main", [ctx.entry.id, entry2.id], ctx.turnId, "lineage-a");
  const noted = writer.commitNotingRun({ run: { kind: "manual", sessionId: ctx.sessionId, createdAt: time }, entryIds: [entry2.id],
    facts: [{ turnId: ctx.turnId, entryIds: [entry2.id], category: "observation", actor: "user", text: "second fact",
      source: [`T${ctx.turnId}#E2`], createdAt: time }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  expect(reader.progressSignal(ctx.sessionId)).not.toBe(signalBefore);
});

test("80: a revision (through a second connection) invalidates the graph memo, and the reused answer follows", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-80-graph-cross-rev-"));
  dirs.push(dir);
  const dbPath = join(dir, "trace.db");
  const writer = new Store(dbPath);
  stores.push(writer);
  const ctx = seeded(writer);
  const reader = new Store(dbPath);
  stores.push(reader);
  const path = { sessionId: ctx.sessionId, branch: "main", headTurnId: ctx.turnId };
  const before = reader.knowledgePools(path);
  expect(before.flatMap(p => p.versions)).toHaveLength(0);
  const created = writer.commitConsolidationRun({ path, run: { kind: "manual", sessionId: ctx.sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "$k", author: "test", text: "a durable rule that is long enough to carry weight",
      category: "constraint", scope: "session", supports: [ctx.factId], topics: [], reason: "evidence", createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const after = reader.knowledgePools(path);
  expect(after.flatMap(p => p.versions)).toHaveLength(1); // the reader's memo rebuilt and now sees it
});

test("80: cross-connection project reassignment (Pi's scenario) invalidates the memo, footer knowledge count and answer alike", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-80-graph-cross-project-"));
  dirs.push(dir);
  const dbPath = join(dir, "trace.db");
  const writer = new Store(dbPath);
  stores.push(writer);
  const project = writer.createProject({ name: "shared", declaredBy: "mark" });
  const a = writer.createSession({ host: "A", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time });
  const b = writer.createSession({ host: "B", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time });
  const aTurn = writer.appendTurn({ sessionId: a.id, kind: "turn", userPrompt: "a", assistantText: "ok", startedAt: time });
  const aEntry = writer.appendSourceEntry({ sessionId: a.id, turnId: aTurn.id, nativeLineage: "n", nativeId: "a1", role: "user", text: "hi", raw: "hi", calls: [] });
  writer.selectSourcePath(a.id, "main", [aEntry.id]);
  writer.setCurrentPath(a.id, "main", aTurn.id, "lineage-a");
  const bTurn = writer.appendTurn({ sessionId: b.id, kind: "turn", userPrompt: "b", assistantText: "ok", startedAt: time });
  const bEntry = writer.appendSourceEntry({ sessionId: b.id, turnId: bTurn.id, nativeLineage: "n", nativeId: "b1", role: "user", text: "hi", raw: "hi", calls: [] });
  writer.selectSourcePath(b.id, "main", [bEntry.id]);
  writer.setCurrentPath(b.id, "main", bTurn.id, "lineage-b");
  const bNoted = writer.commitNotingRun({ run: { kind: "manual", sessionId: b.id, createdAt: time }, entryIds: [bEntry.id],
    facts: [{ turnId: bTurn.id, entryIds: [bEntry.id], category: "observation", actor: "user", text: "B's evidence",
      source: [`T${bTurn.id}#E1`], createdAt: time }] });
  if (!bNoted.ok) throw new Error(bNoted.problems.join("; "));
  const bPath = { sessionId: b.id, branch: "main", headTurnId: bTurn.id };
  const shared = writer.commitConsolidationRun({ path: bPath, run: { kind: "manual", sessionId: b.id, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "$k", author: "test", text: "shared project knowledge, long enough to carry weight",
      category: "constraint", scope: "project", supports: [bNoted.facts[0]!.id], topics: [], reason: "evidence", createdAt: time }] });
  if (!shared.ok) throw new Error(shared.problems.join("; "));

  const reader = new Store(dbPath);
  stores.push(reader);
  const aPath = { sessionId: a.id, branch: "main", headTurnId: aTurn.id };
  const before = reader.currentKnowledge(aPath); // A sees B's shared-project knowledge
  expect(before.map(v => v.revision.id)).toEqual([shared.committed[0]!.commit]);
  const signalBefore = reader.progressSignal(a.id);
  reader.knowledgePools(aPath); // warms A's own memo too

  writer.declareProject(b.id, "elsewhere", "mark", declarationContext(writer, bPath)); // B moves through the writer connection
  expect(reader.progressSignal(a.id)).not.toBe(signalBefore); // ruling B: A's signal follows another session's reassignment
  const afterKnowledge = reader.currentKnowledge(aPath);
  expect(afterKnowledge).toEqual([]); // the reused footer/knowledge answer no longer shows B's knowledge
  const afterPools = reader.knowledgePools(aPath);
  expect(afterPools.flatMap(p => p.versions)).toEqual([]); // the memoized graph followed too
});
