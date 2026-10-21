// Ticket 144, Stage 3: the hand-off row between the Noter's two tasks, and the first task's run record.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";

const dirs: string[] = [], stores: Store[] = [], memories: { close(): void }[] = [];
afterEach(() => { for (const m of memories.splice(0)) try { m.close(); } catch { /* already closed */ } for (const s of stores.splice(0)) try { s.close(); } catch { /* already closed */ } for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function open() {
  const dir = mkdtempSync(join(tmpdir(), "tm-144-handoff-")); dirs.push(dir);
  const file = join(dir, "t.sqlite"), memory = sourceSeededMemory(file, async () => { throw new Error("no agent runs here"); }), store = memory.store; memories.push(memory);
  const project = store.createProject({ name: "p", declaredBy: "mark" });
  const session = store.createSession({ enrollmentChoice: true, host: "t", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "u", assistantText: "a", startedAt: "now" });
  const entries = store.sourcePath(session.id, "main", turn.id);
  return { file, store, memory, session, turn, entries };
}
const run = (sessionId: number, extra = {}) => ({ kind: "noting" as const, sessionId, branch: "main", createdAt: "now", ...extra });

test("the first task's pass writes its run and the hand-off together; a later pass replaces the row", () => {
  const { store, session, entries } = open();
  const ids = entries.map(entry => entry.id);
  const first = store.commitWriteTask({ run: run(session.id, { response: JSON.stringify({ task: "write", files: { facts: "a", knowledge: "b" } }) }), handoff: { nextTask: "verify", branch: "main", entryIds: ids } });
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  expect(store.getRun(first.runId)).toMatchObject({ outcome: "success" });
  expect(store.handoff(session.id, "noting")).toMatchObject({ runId: first.runId, nextTask: "verify", branch: "main", entryIds: ids });
  const second = store.commitWriteTask({ run: run(session.id), handoff: { nextTask: "verify", branch: "main", entryIds: ids } });
  expect(second.ok && store.handoff(session.id, "noting")!.runId).toBe(second.ok && second.runId);
  expect(store.db.prepare("SELECT count(*) AS n FROM task_handoffs").get()).toEqual({ n: 1 });
  // The pass owns no fact and processes no entry.
  expect(ids.some(id => store.entryNoted(id))).toBe(false);
});

test("a publication covering the row's entries deletes it; one covering none of them keeps it", () => {
  const { store, session, entries } = open();
  const ids = entries.map(entry => entry.id);
  store.commitWriteTask({ run: run(session.id), handoff: { nextTask: "verify", branch: "main", entryIds: ids } });
  expect(store.commitNotingRun({ run: run(session.id), facts: [], entryIds: [] }).ok).toBe(true);
  expect(store.handoff(session.id, "noting")).not.toBeNull();
  expect(store.commitNotingRun({ run: run(session.id), facts: [], entryIds: [ids[0]!] }).ok).toBe(true);
  expect(store.handoff(session.id, "noting")).toBeNull();
});

test("a stale claim fences the pass: a failure run is recorded and no hand-off is written", () => {
  const { store, session, entries } = open();
  const stale = { sessionId: session.id, phase: "noting" as const, token: "gone", executorId: "e", expiresAt: 0 } as never;
  const result = store.commitWriteTask({ run: run(session.id, { claim: stale }), handoff: { nextTask: "verify", branch: "main", entryIds: entries.map(entry => entry.id) } });
  expect(result.ok).toBe(false);
  expect(store.handoff(session.id, "noting")).toBeNull();
  expect(store.listRuns(session.id).map(r => r.outcome)).toEqual(["failure"]);
});

test("a database from before the table gains it on open, with no row invented", () => {
  const { file, store, memory, session } = open();
  store.db.exec("DROP TABLE task_handoffs");
  memory.close();
  const reopened = new Store(file); stores.push(reopened);
  expect(reopened.handoff(session.id, "noting")).toBeNull();
  expect(reopened.db.prepare("SELECT count(*) AS n FROM task_handoffs").get()).toEqual({ n: 0 });
});

test("a first-task pass is not a processed head: the legacy head inference needs a run that owns entries", () => {
  const { store, session, turn, entries } = open();
  const later = store.appendTurn({ sessionId: session.id, parentTurnId: turn.id, kind: "turn", userPrompt: "later", startedAt: "later" });
  const legacy = { sessionId: session.id, branch: "legacy", rangeTo: `S${session.id}/T${later.id}` };
  // A branch with no native path state: only runs say how far it got.
  store.recordRun({ kind: "noting", ...legacy, outcome: "success", createdAt: "now" });
  expect(store.knowledgePath(session.id, "legacy").headTurnId).toBeNull(); // the pass of task 1 moves nothing
  const processed = store.commitNotingRun({ run: { kind: "noting", ...legacy, createdAt: "now" }, facts: [], entryIds: [entries[0]!.id] });
  expect(processed.ok).toBe(true);
  expect(store.knowledgePath(session.id, "legacy").headTurnId).toBe(later.id);
});
