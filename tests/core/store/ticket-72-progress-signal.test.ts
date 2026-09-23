// Ticket 72 "CC executor checks Consolidation and Dreaming only when armed": completes 69's
// `Store.progressSignal` — a cheap composite that changes exactly when a commit could change
// `consolidationBatch`, `duePools` or the footer's cached counts. This covers the two inputs 69's own
// signal missed (a knowledge-budget edit, another session's current-path cursor) plus a third Pi's
// review found while implementing this ticket (a non-append rewrite of a current path's membership
// under an unchanged cursor), and asserts a pure Raw append re-arms nothing.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

const time = "2026-09-23T00:00:00Z";
const stores: Store[] = [], dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) if (!store.closed) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function open(): Store {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-72-signal-"));
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
  return { store, project, sessionId, turnId, entry };
}

test("72: a knowledge-budget edit changes the signal", () => {
  const store = open();
  const { sessionId } = seeded(store);
  const before = store.progressSignal(sessionId);
  const result = store.setKnowledgeBudget("session", 1);
  expect(result.changed).toBe(true);
  expect(store.progressSignal(sessionId)).not.toBe(before);
});

test("72: an over-budget suppression state change (knowledge_pool_state) changes the signal", () => {
  const store = open();
  const { sessionId, turnId, entry } = seeded(store);
  const noted = store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId, entryIds: [entry.id], category: "observation", actor: "user", text: "a fact", source: [`T${turnId}#E1`], createdAt: time }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const consolidated = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "$k", author: "test", text: "a durable rule that is long enough to carry weight", category: "constraint",
      scope: "session", supports: [noted.facts[0]!.id], topics: [], reason: "evidence", createdAt: time }], consolidated: [noted.facts[0]!.id] });
  if (!consolidated.ok) throw new Error(consolidated.problems.join("; "));
  const path = { sessionId, branch: "main", headTurnId: turnId };
  const claim = store.acquireClaim(path, "dreaming", "ticket-72-test")!;
  const range = store.retainKnowledgePoolRange(path, `session:${sessionId}`, claim);
  // Shrink the budget after the range froze (so retain-time selection already succeeded), so the
  // pool reads as over budget once this run completes.
  store.setKnowledgeBudget("session", 1);
  const executionId = store.beginExecution({ sessionId, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = store.bindDreamingRun({ kind: "dreaming", sessionId, branch: "main", dreamingRangeId: range.id, executionId, claim, createdAt: time });
  const before = store.progressSignal(sessionId);
  store.completeKnowledgePoolRange(run, "success", range.eventIds); // no operation: leaves the pool over budget and suppressed
  store.releaseClaim(claim);
  expect(store.progressSignal(sessionId)).not.toBe(before);
});

test("72: another session's branch switch (a current-path cursor) changes the signal", () => {
  const store = open();
  const { sessionId } = seeded(store);
  const other = seeded(store); // a distinct session with its own current-path cursor
  const before = store.progressSignal(sessionId);
  const turn2 = store.appendTurn({ sessionId: other.sessionId, kind: "turn", userPrompt: "second", assistantText: "ok", startedAt: time }).id;
  const entry2 = store.appendSourceEntry({ sessionId: other.sessionId, turnId: turn2, nativeLineage: "n2", nativeId: "u2", role: "user", text: "hi2", raw: "hi2", calls: [] });
  store.selectSourcePath(other.sessionId, "side", [entry2.id]);
  // Same lineage as `seeded()` used, a different branch: a real branch switch (not a second lineage).
  store.setCurrentPath(other.sessionId, "side", turn2, "lineage-a");
  expect(store.progressSignal(sessionId)).not.toBe(before);
});

test("72: a session's head moving back to an ancestor changes the signal", () => {
  const store = open();
  const { sessionId, turnId } = seeded(store);
  const child = store.appendTurn({ sessionId, parentTurnId: turnId, kind: "turn", userPrompt: "second", assistantText: "ok", startedAt: time }).id;
  store.setCurrentPath(sessionId, "main", child, "lineage-a"); // ordinary forward move
  const before = store.progressSignal(sessionId);
  store.setCurrentPath(sessionId, "main", turnId, "lineage-a"); // back to the ancestor
  expect(store.progressSignal(sessionId)).not.toBe(before);
  // A later forward move back to the same head this cursor had already visited makes the same items
  // visible again as the backward move had hidden, so it must re-arm too, not only the backward move.
  const afterBack = store.progressSignal(sessionId);
  store.setCurrentPath(sessionId, "main", child, "lineage-a");
  expect(store.progressSignal(sessionId)).not.toBe(afterBack);
});

test("72: an entry removed from, then restored to, a current path under an unchanged cursor changes the signal both times", () => {
  const store = open();
  const { sessionId, turnId, entry } = seeded(store);
  const entry2 = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "toolResult", text: "", raw: "r2",
    calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
  store.publishSourcePath(sessionId, "main", [entry.id, entry2.id], turnId, "lineage-a");
  const before = store.progressSignal(sessionId);
  store.publishSourcePath(sessionId, "main", [entry.id], turnId, "lineage-a"); // shortened: same cursor throughout
  expect(store.progressSignal(sessionId)).not.toBe(before);
  const afterRemoval = store.progressSignal(sessionId);
  store.publishSourcePath(sessionId, "main", [entry.id, entry2.id], turnId, "lineage-a"); // restored
  expect(store.progressSignal(sessionId)).not.toBe(afterRemoval);
});

test("72: a pure Raw append changes nothing in the signal", () => {
  const store = open();
  const { sessionId, turnId, entry } = seeded(store);
  const before = store.progressSignal(sessionId);
  const entry2 = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "toolResult", text: "", raw: "r2",
    calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
  store.publishSourcePath(sessionId, "main", [entry.id, entry2.id], turnId, "lineage-a"); // ordinary extension, same head/branch
  expect(store.progressSignal(sessionId)).toBe(before);
  const child = store.appendTurn({ sessionId, parentTurnId: turnId, kind: "turn", userPrompt: "second", assistantText: "ok", startedAt: time }).id;
  const entry3 = store.appendSourceEntry({ sessionId, turnId: child, nativeLineage: "n", nativeId: "u3", role: "user", text: "more", raw: "more", calls: [] });
  store.publishSourcePath(sessionId, "main", [entry.id, entry2.id, entry3.id], child, "lineage-a"); // forward head move, still ordinary
  expect(store.progressSignal(sessionId)).toBe(before);
});
