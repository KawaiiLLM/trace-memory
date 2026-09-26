// Ticket 72's commit-sensitive signal survives C retirement: completes 69's
// `Store.progressSignal` — a cheap composite that changes exactly when a commit could change
// historical fact processing, `duePools` or the footer's cached counts. This covers the two inputs 69's own
// signal missed (a knowledge-budget edit, another session's current-path cursor) plus a third Pi's
// review found while implementing this ticket (a non-append rewrite of a current path's membership
// under an unchanged cursor), and asserts a pure Raw append re-arms nothing.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Store } from "../../../src/core/store/index.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { declarationContext } from "../project-declaration-context.ts";

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

test("85: settling a Dreaming range changes the signal through processing records, not pool state", () => {
  const store = open();
  const { sessionId, turnId, entry } = seeded(store);
  const noted = store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId, entryIds: [entry.id], category: "observation", actor: "user", text: "a fact", source: [`T${turnId}#E1`], createdAt: time }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const consolidated = commitNoterKnowledge(store, { run: { sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "$k", author: "test", text: "a durable rule that is long enough to carry weight", category: "constraint",
      scope: "session", supports: [noted.facts[0]!.id], topics: [], reason: "evidence", createdAt: time }] });
  if (!consolidated.ok) throw new Error(consolidated.problems.join("; "));
  const path = { sessionId, branch: "main", headTurnId: turnId };
  const claim = store.acquireClaim(path, "dreaming", "ticket-72-test")!;
  const range = store.retainKnowledgePoolRange(path, `session:${sessionId}`, claim);
  // Shrink the budget after the range froze; range settlement still writes processing records.
  store.setKnowledgeBudget("session", 1);
  const executionId = store.beginExecution({ sessionId, phase: "dreaming", head: range.anchor, origin: range.origin });
  const run = store.bindDreamingRun({ kind: "dreaming", sessionId, branch: "main", dreamingRangeId: range.id, executionId, claim, createdAt: time });
  const before = store.progressSignal(sessionId);
  store.completeKnowledgePoolRange(run, "success", range.eventIds); // skip records, no pool-state write
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

test("72: after a removal and a restore, subsequent pure appends to that same row do not bump", () => {
  const store = open();
  const { sessionId, turnId, entry } = seeded(store);
  const entry2 = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "toolResult", text: "", raw: "r2",
    calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
  store.publishSourcePath(sessionId, "main", [entry.id, entry2.id], turnId, "lineage-a");
  store.publishSourcePath(sessionId, "main", [entry.id], turnId, "lineage-a"); // remove
  store.publishSourcePath(sessionId, "main", [entry.id, entry2.id], turnId, "lineage-a"); // restore
  const afterRestore = store.progressSignal(sessionId);
  // A genuinely new entry, never before part of this row, appended after the restore: high-water-mark
  // exactness (not a sticky "once rewritten, always bump" flag) means this must not bump.
  const entry3 = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u3", role: "toolResult", text: "", raw: "r3",
    calls: [{ ordinal: 1, name: "tool", callId: "c2", status: "ok" }] });
  store.publishSourcePath(sessionId, "main", [entry.id, entry2.id, entry3.id], turnId, "lineage-a");
  expect(store.progressSignal(sessionId)).toBe(afterRestore);
});

test("72: after a branch switch and a return, subsequent new Turns on that cursor do not bump", () => {
  const store = open();
  const { sessionId, turnId } = seeded(store);
  const sideEntry = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "side1", role: "toolResult", text: "", raw: "s1",
    calls: [{ ordinal: 1, name: "tool", callId: "cs1", status: "ok" }] });
  store.selectSourcePath(sessionId, "side", [sideEntry.id]);
  store.setCurrentPath(sessionId, "side", turnId, "lineage-a"); // switch away
  store.setCurrentPath(sessionId, "main", turnId, "lineage-a"); // and back to "main", same head as before
  const afterReturn = store.progressSignal(sessionId);
  // A genuinely new Turn, with an id above every head this cursor has ever held (global AUTOINCREMENT
  // order), advanced to after the return: must not bump.
  const child = store.appendTurn({ sessionId, parentTurnId: turnId, kind: "turn", userPrompt: "second", assistantText: "ok", startedAt: time }).id;
  store.setCurrentPath(sessionId, "main", child, "lineage-a");
  expect(store.progressSignal(sessionId)).toBe(afterReturn);
});

test("72: a head moved back to an ancestor bumps, and a new Turn created from that ancestor, above the mark, does not", () => {
  const store = open();
  const { sessionId, turnId } = seeded(store);
  const child = store.appendTurn({ sessionId, parentTurnId: turnId, kind: "turn", userPrompt: "second", assistantText: "ok", startedAt: time }).id;
  store.setCurrentPath(sessionId, "main", child, "lineage-a"); // ordinary forward move; high-water mark = child
  const before = store.progressSignal(sessionId);
  store.setCurrentPath(sessionId, "main", turnId, "lineage-a"); // back to the ancestor: bumps (turnId < mark)
  expect(store.progressSignal(sessionId)).not.toBe(before);
  const afterBack = store.progressSignal(sessionId);
  // A brand-new Turn grown from the ancestor: its id is above the high-water mark (AUTOINCREMENT is
  // global, so any Turn created now exceeds `child`), so advancing to it must not bump.
  const grandchild = store.appendTurn({ sessionId, parentTurnId: turnId, kind: "turn", userPrompt: "third", assistantText: "ok", startedAt: time }).id;
  store.setCurrentPath(sessionId, "main", grandchild, "lineage-a");
  expect(store.progressSignal(sessionId)).toBe(afterBack);
});

test("72: a restore of a removed tail entry still bumps", () => {
  const store = open();
  const { sessionId, turnId, entry } = seeded(store);
  const tail = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "tail1", role: "toolResult", text: "", raw: "t1",
    calls: [{ ordinal: 1, name: "tool", callId: "ct1", status: "ok" }] });
  store.publishSourcePath(sessionId, "main", [entry.id, tail.id], turnId, "lineage-a");
  store.publishSourcePath(sessionId, "main", [entry.id], turnId, "lineage-a"); // drop the tail entry
  const afterDrop = store.progressSignal(sessionId);
  store.publishSourcePath(sessionId, "main", [entry.id, tail.id], turnId, "lineage-a"); // restore the tail entry
  expect(store.progressSignal(sessionId)).not.toBe(afterDrop);
});

test("72: backfill on an existing database sets the high-water mark from current contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-72-backfill-"));
  dirs.push(dir);
  const dbPath = join(dir, "trace.db");
  const pre = new Store(dbPath);
  const { sessionId, turnId, entry } = seeded(pre);
  const entry2 = pre.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "toolResult", text: "", raw: "r2",
    calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
  pre.publishSourcePath(sessionId, "main", [entry.id, entry2.id], turnId, "lineage-a");
  pre.close();
  // Simulate a database from before ticket 72: both tables without their version and high-water-mark
  // columns or the version indexes, the exact pre-72 shape. Reopening through Store must add them back
  // before anything indexes them (review 2026-09-23: the schema script indexed `version` first and a
  // real pre-72 database failed to open) and backfill from the row's current contents.
  const raw = new DatabaseSync(dbPath);
  raw.exec("DROP INDEX idx_source_paths_version; DROP INDEX idx_session_lineage_cursors_version");
  for (const [table, columns] of [["source_paths", ["version", "hwm_entry_id"]], ["session_lineage_cursors", ["version", "hwm_head_turn_id"]]] as const)
    for (const column of columns) raw.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  raw.close();
  const reopened = new Store(dbPath);
  stores.push(reopened);
  const row = reopened.db.prepare("SELECT hwm_entry_id FROM source_paths WHERE session_id = ? AND branch = 'main'").get(sessionId) as { hwm_entry_id: number };
  expect(row.hwm_entry_id).toBe(Math.max(entry.id, entry2.id));
  const cursorRow = reopened.db.prepare("SELECT hwm_head_turn_id FROM session_lineage_cursors WHERE session_id = ?").get(sessionId) as { hwm_head_turn_id: number };
  expect(cursorRow.hwm_head_turn_id).toBe(turnId);
  expect(reopened.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE '%\\_version' ESCAPE '\\' ORDER BY name").all().map(r => r.name))
    .toEqual(["idx_session_lineage_cursors_version", "idx_source_paths_version"]);
});

test("72: one session's rewrite or cursor move changes the signal while another session holds a higher version", () => {
  // Review 2026-09-23: per-row counters read through a table-wide MAX hid session B's first bump
  // behind session A's third, so B's knowledge count dropped while the signal stood still.
  const store = open();
  const a = seeded(store);
  const bSession = store.createSession({ host: "test", enrollmentChoice: true, projectId: a.project.id, startedAt: time, firstReplyAt: time }).id;
  const bTurn = store.appendTurn({ sessionId: bSession, kind: "turn", userPrompt: "b", assistantText: "b", startedAt: time }).id;
  const b = [1, 2].map(n => store.appendSourceEntry({ sessionId: bSession, turnId: bTurn, nativeLineage: "b", nativeId: `b${n}`, role: "user", text: `b${n}`, raw: `b${n}`, calls: [] }).id);
  store.publishSourcePath(bSession, "main", b, bTurn, "lineage-b");
  const a2 = store.appendSourceEntry({ sessionId: a.sessionId, turnId: a.turnId, nativeLineage: "n", nativeId: "u2", role: "user", text: "u2", raw: "u2", calls: [] }).id;
  for (const ids of [[a.entry.id, a2], [a.entry.id], [a.entry.id, a2], [a.entry.id]]) // three bumps on A's path
    store.publishSourcePath(a.sessionId, "main", ids, a.turnId, "lineage-a");
  let before = store.progressSignal(bSession);
  store.publishSourcePath(bSession, "main", [b[0]!], bTurn, "lineage-b"); // B's first rewrite
  expect(store.progressSignal(bSession)).not.toBe(before);

  store.selectSourcePath(a.sessionId, "side", [a.entry.id]);
  for (const branch of ["side", "main", "side"]) store.setCurrentPath(a.sessionId, branch, a.turnId, "lineage-a"); // A's cursor bumps
  store.selectSourcePath(bSession, "side", b);
  before = store.progressSignal(bSession);
  store.setCurrentPath(bSession, "side", bTurn, "lineage-b"); // B's first branch switch
  expect(store.progressSignal(bSession)).not.toBe(before);
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

// Ticket 80, ruled "B": before this, `progressSignal(sessionId)` read only THIS session's own
// `project_id` (a single point lookup), so another session's declaration or reassignment left the
// signal unchanged even though it changes which project knowledge THIS session's graph shows (a
// "project"-scoped revision's applicability follows its owning session's *current* project, not the
// project it was created under). Pi reproduced this through a second connection: A and B share a
// project; B is moved to another project; A's signal must change so its memoized graph, footer
// `knowledge` count and C/D arming all follow.
test("80: another session's project reassignment changes the signal, even though this session's own project_id is untouched", () => {
  const store = open();
  const a = seeded(store);
  const b = seeded(store); // a distinct session, initially in its own project
  const before = store.progressSignal(a.sessionId);
  const untouched = store.getSession(a.sessionId)!.projectId;
  store.declareProject(b.sessionId, "elsewhere", "mark", declarationContext(store, { sessionId: b.sessionId, branch: "main", headTurnId: b.turnId }));
  expect(store.progressSignal(a.sessionId)).not.toBe(before);
  expect(store.getSession(a.sessionId)!.projectId).toBe(untouched); // A's own assignment never moved
});

test("80: a session joining the reader's own project also changes the signal", () => {
  const store = open();
  const a = seeded(store);
  const b = seeded(store);
  const project = store.getSession(a.sessionId)!.projectId;
  const before = store.progressSignal(a.sessionId);
  store.db.prepare("UPDATE sessions SET project_id = ? WHERE id = ?").run(project, b.sessionId);
  expect(store.progressSignal(a.sessionId)).not.toBe(before);
});
