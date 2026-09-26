// Ticket 72 item 5 "The footer cache survives a head that moves forward": 69's `progress` cache keyed
// on the exact head, so every sent message (a new Turn) missed it. The cache now keys on
// (sessionId, branch) plus the completed signal, and reuses an entry when the requested head
// descends from the cached one — invalidated by a branch switch (a different cache key), a head moved
// back, a non-append path rewrite, or any commit (both caught by the signal or the ancestry check).
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store } from "../../../src/core/store/index.ts";

const time = "2026-09-23T00:00:00Z";
let directory: string, dbPath: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "trace-memory-72-footer-")); dbPath = join(directory, "trace.db"); });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

function seeded() {
  const memory = TraceMemory(dbPath, async () => ({ outcome: "failure" as const, output: "no model in this test" }));
  const store = memory.store, project = store.createProject({ name: "A", declaredBy: "mark" });
  const sessionId = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time }).id;
  const turnId = store.appendTurn({ sessionId, kind: "turn", userPrompt: "first", assistantText: "answer", startedAt: time }).id;
  const entry = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u1", role: "user", text: "hi", raw: "hi", calls: [] });
  memory.selectEntries(sessionId, "main", [entry.id]);
  return { memory, store, sessionId, turnId };
}

test("72: sending a message (a forward head) reuses the cached counts, no facts/knowledge query", () => {
  const { memory, store, sessionId, turnId } = seeded();
  try {
    const before = memory.progress(sessionId, "main", turnId); // primes the cache at `turnId`
    const nextTurn = store.appendTurn({ sessionId, parentTurnId: turnId, kind: "turn", userPrompt: "second", assistantText: "answer", startedAt: time }).id;
    const facts = vi.spyOn(Store.prototype, "listBranchFacts"), knowledge = vi.spyOn(Store.prototype, "currentKnowledge");
    try {
      const after = memory.progress(sessionId, "main", nextTurn); // a forward head: descends from `turnId`
      expect(after).toMatchObject({ facts: before.facts, knowledge: before.knowledge, changedKnowledge: before.changedKnowledge });
      expect(facts).not.toHaveBeenCalled();
      expect(knowledge).not.toHaveBeenCalled();
    } finally { facts.mockRestore(); knowledge.mockRestore(); }
  } finally { memory.close(); }
});

test("72: a branch switch does not reuse another branch's cache", () => {
  const { memory, store, sessionId, turnId } = seeded();
  try {
    memory.progress(sessionId, "main", turnId); // primes "main"
    const otherEntry = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "toolResult", text: "", raw: "r2",
      calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
    memory.selectEntries(sessionId, "side", [otherEntry.id]);
    const facts = vi.spyOn(Store.prototype, "listBranchFacts");
    try {
      memory.progress(sessionId, "side", turnId); // a different branch: its own cache key, computed fresh
      expect(facts).toHaveBeenCalled();
    } finally { facts.mockRestore(); }
  } finally { memory.close(); }
});

test("72: a head moved back to an ancestor recomputes, not reuses", () => {
  const { memory, store, sessionId, turnId } = seeded();
  try {
    const child = store.appendTurn({ sessionId, parentTurnId: turnId, kind: "turn", userPrompt: "second", assistantText: "answer", startedAt: time }).id;
    memory.progress(sessionId, "main", child); // primes the cache at the descendant head
    const facts = vi.spyOn(Store.prototype, "listBranchFacts");
    try {
      const result = memory.progress(sessionId, "main", turnId); // back to the ancestor: the cached head does not descend from it
      expect(facts).toHaveBeenCalled();
      expect(result.facts).toBe(0);
    } finally { facts.mockRestore(); }
  } finally { memory.close(); }
});

test("72: a non-append path rewrite under an unchanged cursor recomputes", () => {
  const { memory, store, sessionId, turnId } = seeded();
  try {
    const entry2 = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "toolResult", text: "", raw: "r2",
      calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
    store.publishSourcePath(sessionId, "main", [store.selectedSourceEntryIds(sessionId, "main")![0]!, entry2.id], turnId, "test-lineage");
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId, createdAt: time },
      facts: [{ turnId, entryIds: [entry2.id], category: "decision", actor: "user", text: "rule", source: [`T${turnId}#E2`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId, createdAt: time }, operations: [{
      op: "create", handle: "$rule", author: "test", text: "a durable rule", category: "constraint", scope: "session",
      supports: [noted.facts[0]!.id], topics: [], reason: "fixture", createdAt: time }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const before = memory.progress(sessionId, "main", turnId); // primes with knowledge = 1
    expect(before.knowledge).toBe(1);
    // Shorten the path, dropping the supporting entry, with session/lineage/branch/head all unchanged.
    store.publishSourcePath(sessionId, "main", [store.selectedSourceEntryIds(sessionId, "main")![0]!], turnId, "test-lineage");
    const after = memory.progress(sessionId, "main", turnId);
    expect(after.knowledge).toBe(0); // the rewrite is observed, not masked by the (same-head) cache
  } finally { memory.close(); }
});
