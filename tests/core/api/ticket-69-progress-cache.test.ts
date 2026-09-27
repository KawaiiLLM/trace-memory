// Ticket 69 "Pi foreground stalls": `progress` splits into a live half (`entries`, what an ingested
// entry alone can change) and a cached half (`facts`, `knowledge`,
// `changedKnowledge`, what only a committed run can change), invalidated by `Store.progressSignal` — a
// cheap composite that changes exactly when a commit could change one of them, for ANY connection to
// the database file, not only this one.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";

const time = "2026-09-09T00:00:00Z";
let directory: string, dbPath: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "trace-memory-69-progress-")); dbPath = join(directory, "trace.db"); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function seeded() {
  const memory = TraceMemory(dbPath, async () => ({ outcome: "failure" as const, output: "no model in this test" }));
  const store = memory.store, project = store.createProject({ name: "A", declaredBy: "mark" });
  const sessionId = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time }).id;
  const turnId = store.appendTurn({ sessionId, kind: "turn", userPrompt: "first", assistantText: "answer", startedAt: time }).id;
  const entry = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u1", role: "user", text: "hi", raw: "hi", calls: [] });
  memory.selectEntries(sessionId, "main", [entry.id]);
  return { memory, store, sessionId, turnId, entryId: entry.id };
}

test("ticket 69: a cached refresh issues no listBranchFacts or currentKnowledge query", () => {
  const { memory, sessionId, turnId } = seeded();
  try {
    const first = memory.progress(sessionId, "main", turnId); // primes the cache
    const facts = vi.spyOn(Store.prototype, "listBranchFacts"), knowledge = vi.spyOn(Store.prototype, "currentKnowledge");
    try {
      const second = memory.progress(sessionId, "main", turnId);
      expect(second).toEqual(first);
      expect(facts).not.toHaveBeenCalled();
      expect(knowledge).not.toHaveBeenCalled();
    } finally { facts.mockRestore(); knowledge.mockRestore(); }
  } finally { memory.close(); }
});

test("ticket 69: entries always stays live across a cached refresh", () => {
  const { memory, store, sessionId, turnId } = seeded();
  try {
    memory.progress(sessionId, "main", turnId); // primes the cache
    const before = memory.progress(sessionId, "main", turnId).entries;
    const second = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "user", text: "more", raw: "more", calls: [] });
    memory.selectEntries(sessionId, "main", [...store.pendingEntryIds(sessionId, "main", turnId), second.id]);
    const after = memory.progress(sessionId, "main", turnId).entries;
    expect(after).toBeGreaterThan(before);
  } finally { memory.close(); }
});

test("ticket 69: the cache invalidates on a commit made through a second Store connection to the same file", () => {
  const { memory, sessionId, turnId, entryId } = seeded();
  const observer = TraceMemory(dbPath, async () => ({ outcome: "failure" as const, output: "no model" }));
  try {
    const before = memory.progress(sessionId, "main", turnId);
    expect(before.facts).toBe(0);
    const committed = observer.store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time },
      facts: [{ turnId, category: "observation", actor: "user", text: "seen via a second connection", source: ["T" + turnId + "#user"], entryIds: [entryId], createdAt: time }] });
    if (!committed.ok) throw new Error(committed.problems.join("; "));
    const after = memory.progress(sessionId, "main", turnId);
    expect(after.facts).toBe(1);
    expect(after).not.toHaveProperty("unconsolidated");
    expect(observer.store.consolidationBatch(sessionId, "main", turnId)).toHaveLength(1);
  } finally { memory.close(); observer.close(); }
});

test("ticket 69: the cache invalidates on N knowledge publication and D settlement through another connection", () => {
  const { memory, sessionId, turnId, entryId } = seeded();
  const store = new Store(dbPath);
  try {
    const noted = store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time },
      facts: [{ turnId, category: "observation", actor: "user", text: "fact one", source: ["T" + turnId + "#user"], entryIds: [entryId], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const primed = memory.progress(sessionId, "main", turnId);
    expect(primed).toMatchObject({ facts: 1, knowledge: 0 });
    const consolidated = commitNoterKnowledge(store, { run: { sessionId, branch: "main", createdAt: time },
      operations: [{ op: "create", handle: "$k", author: "test", text: "durable rule", category: "constraint", scope: "session",
        supports: [noted.facts[0]!.id], topics: [], reason: "evidence", createdAt: time }] });
    if (!consolidated.ok) throw new Error(consolidated.problems.join("; "));
    const afterConsolidation = memory.progress(sessionId, "main", turnId);
    expect(afterConsolidation).toMatchObject({ facts: 1, knowledge: 1, changedKnowledge: 1 });
    expect(store.consolidationBatch(sessionId, "main", turnId)).toHaveLength(1);
    // A Dreamer commit against this pool, run through the ordinary claim/range/execution pipeline.
    const path = { sessionId, branch: "main", headTurnId: turnId };
    const claim = store.acquireClaim(path, "dreaming", "ticket-69-test")!;
    const range = store.retainKnowledgePoolRange(path, `session:${sessionId}`, claim);
    const executionId = store.beginExecution({ sessionId, phase: "dreaming", head: range.anchor, origin: range.origin });
    const run = store.bindDreamingRun({ kind: "dreaming", sessionId, branch: "main", dreamingRangeId: range.id, executionId, claim, createdAt: time });
    store.completeKnowledgePoolRange(run, "success", range.eventIds); // reviewed, no operation needed
    store.releaseClaim(claim);
    const afterDreaming = memory.progress(sessionId, "main", turnId);
    expect(afterDreaming).toMatchObject({ facts: 1, knowledge: 1, changedKnowledge: 0 });
  } finally { store.close(); memory.close(); }
});

test("ticket 69: merging another project into this session's project invalidates the cached knowledge count", () => {
  const { memory, store, sessionId, turnId } = seeded();
  try {
    const other = store.createProject({ name: "B", declaredBy: "mark" });
    const donor = store.createSession({ host: "test", enrollmentChoice: true, projectId: other.id, startedAt: time, firstReplyAt: time }).id;
    const donorTurn = store.appendTurn({ sessionId: donor, kind: "turn", userPrompt: "rule", assistantText: "ok", startedAt: time }).id;
    const donorEntry = store.appendSourceEntry({ sessionId: donor, turnId: donorTurn, nativeLineage: "d", nativeId: "d1", role: "user", text: "rule", raw: "rule", calls: [] });
    memory.selectEntries(donor, "main", [donorEntry.id]);
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: donor, createdAt: time },
      facts: [{ turnId: donorTurn, entryIds: [donorEntry.id], category: "decision", actor: "user", text: "rule", source: [`T${donorTurn}#E1`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: donor, createdAt: time }, operations: [{
      op: "create", handle: "$rule", author: "test", text: "project rule", category: "constraint", scope: "project",
      supports: [noted.facts[0]!.id], topics: [], reason: "fixture", createdAt: time }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const before = memory.progress(sessionId, "main", turnId); // primes the cache for project A
    store.mergeProject(other.id, store.getSession(sessionId)!.projectId!);
    const after = memory.progress(sessionId, "main", turnId);
    expect(after.knowledge).toBe(before.knowledge + 1);
  } finally { memory.close(); }
});
