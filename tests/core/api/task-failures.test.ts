import { afterEach, expect, test, vi } from "vitest";
import { writeFileSync } from "node:fs";
import { block } from "../../support/workspace.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrate, sourceSeededMemory, type NotingAgentInput, type RunAgent, type TraceMemory } from "../../source-fixture.ts";
import { knowledge, legacyFacts } from "../../support/seed.ts";
import { Store } from "../../../src/core/store/index.ts";
import { ALL_POOLS } from "../../../src/core/store/processing.ts";
import type { DreamingAgentInput } from "../../../src/core/api/index.ts";
import { submit, submitEmpty, verifyUnchanged } from "../../support/noter.ts";

const memories: TraceMemory[] = [], dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const m of memories.splice(0)) m.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const request = { messages: [] };
const failed: RunAgent = async () => ({ outcome: "failure", output: "provider failed after retries", request });
const open = (file = ":memory:", agent: RunAgent = failed) => {
  // The scripted agent is the write task; a verify task finds nothing to correct.
  const m = sourceSeededMemory(file, raw => (raw as NotingAgentInput).kind === "noting" && (raw as NotingAgentInput).task !== "extract-facts" ? verifyUnchanged(raw, { request }) : agent(raw),
    { closedSessionScope: "global" }); memories.push(m); return m;
};
const file = () => { const dir = mkdtempSync(join(tmpdir(), "trace-task-failures-")); dirs.push(dir); return join(dir, "test.sqlite"); };
function seed(m: TraceMemory) {
  const p = m.store.findProjectByName("test") ?? m.store.createProject({ name: "test", declaredBy: "mark" });
  const s = m.store.createSession({ host: "test", enrollmentChoice: true, projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "pending evidence", startedAt: "now" });
  return { sessionId: s.id, branch: "main", headTurnId: t.id };
}
const note = (m: TraceMemory, target: ReturnType<typeof seed>, extra = {}) => m.noting({ ...target, model: "fake", ...extra });
const streaks = (m: TraceMemory) => m.store.db.prepare("SELECT * FROM task_failures ORDER BY session_id,phase,head,pool").all();
const execution = (m: TraceMemory, runId: number) => String(m.store.db.prepare("SELECT execution_id FROM execution_runs WHERE run_id = ?").get(runId)!.execution_id);
const boundUser = (m: TraceMemory, target: ReturnType<typeof seed>) =>
  hydrate(m.store.listSourceEntries(target.sessionId, target.headTurnId), m.store).find(entry => entry.role === "user")!;
const decision = (m: TraceMemory, target: ReturnType<typeof seed>, text: string) =>
  legacyFacts(m.store, { kind: "manual", sessionId: target.sessionId, createdAt: "now" }, [{
    sources: [{ entry: boundUser(m, target), address: `T${target.headTurnId}#user` }],
    text, category: "decision", actor: "user", createdAt: "now",
  }]);

test("32c: borrowed failures continue across executors, disable only the target and fence its other phase", async () => {
  const db = file(), first = open(db), target = seed(first), executor = seed(first), other = seed(first);
  first.store.closeSession(target.sessionId);
  const options = { borrowed: true, executorSessionId: executor.sessionId };
  await note(first, target, options);
  const second = open(db);
  await note(second, target, options);
  // Other target-phase work remains claimed while the third failure is settled.
  const fact = decision(second, target, "retained fact");
  const knowledge = second.store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: target.sessionId, createdAt: "now" }, operations: [{ files: null,
    op: "create", title: "Fixture title", handle: "$1", author: "test", text: "pending maintenance", category: "constraint", scope: "session",
    supports: [fact.facts[0]!.id], reason: "evidence", topics: [], createdAt: "now",
  }] });
  if (!knowledge.ok) throw Error(knowledge.problems.join("; "));
  const claim = second.store.acquireClaim(target, "dreaming", "another-process", false, () => true, 0)!; // trigger 0: this test needs the claim held, not a due Dreamer
  expect(claim).not.toBeNull();
  const result = await note(first, target, options);
  expect(result.automaticOff).toContain(`S${target.sessionId} noting`);
  expect(first.store.enabled(target.sessionId)).toBe(false);
  expect(first.store.enabled(executor.sessionId)).toBe(true);
  expect(first.store.enabled(other.sessionId)).toBe(true);
  expect(second.store.getClaim(target.sessionId, "dreaming")!.expiresAt).toBe(0);
  expect(first.store.listSessionFacts(target.sessionId)).toHaveLength(1);
  expect(first.pendingEntries(target.sessionId, target.branch, target.headTurnId)).not.toEqual([]);
  expect(streaks(first)[0]!.count).toBe(3);
  first.store.reopenSession(target.sessionId, first.executorId);
  expect(first.store.enabled(target.sessionId)).toBe(false);
  first.store.setEnrollment(target.sessionId, true);
  expect(streaks(first)).toEqual([]);
});

test("92: N auto-off fences a running D: its late pass changes nothing, its claim is released only at settlement, manual notes are refused", async () => {
  let scenario!: (input: DreamingAgentInput) => ReturnType<RunAgent>;
  let dreamCalls = 0;
  const m = open(":memory:", raw => {
    const input = raw as NotingAgentInput | DreamingAgentInput;
    if (input.kind === "dreaming") { dreamCalls++; return scenario(input); }
    return failed(raw);
  });
  const target = seed(m), other = seed(m);
  await note(m, target); await note(m, target);
  const noted = decision(m, target, "retained evidence");
  const [first] = [1, 2].map(n => knowledge(m.store, target, "session", "constraint", [noted.facts[0]!.id], `pending maintenance ${n}`));
  const manual = m.tools({ kind: "manual", ...target, currentTurnId: target.headTurnId }).find(t => t.name === "note")!;
  const revisions = () => m.store.listKnowledgeRevisions().length;
  let late!: () => string | undefined;
  scenario = async input => {
    input.reportRequest(request);
    const report = String(await input.tools.find(t => t.name === "check")!.execute({}));
    writeFileSync(/File: (\S+?\.md)/.exec(report)![1]!, block(`update K${first!.knowledgeId}@v1`, { reason: "maintenance" }, "maintained rule"));
    const claim = m.store.getClaim(target.sessionId, "dreaming")!;
    late = () => input.passEnd();
    expect(input.signal?.aborted).toBe(false);
    return new Promise(resolve => input.signal!.addEventListener("abort", () => {
      // The lease is fenced (expired) by the auto-off, but the claim is not released or taken over before the run settles.
      expect(m.store.getClaim(target.sessionId, "dreaming")).toMatchObject({ executorId: claim.executorId, token: claim.token });
      expect(late()).toBeUndefined();
      expect(manual.execute({ title: "Late note", sources: `[T${target.headTurnId}#E1] late note` })).toContain("Disabled");
      resolve({ outcome: "cancelled", output: "aborted", request });
    }, { once: true }));
  };
  m.config.dreaming.triggerOperations = 1;
  const before = revisions();
  const held = m.dream({ ...target, model: "fake" });
  expect((await note(m, target)).automaticOff).toBeTruthy();
  const cancelled = await held;
  expect(cancelled.outcome, JSON.stringify(cancelled)).toBe("cancelled");
  expect(late()).toBeUndefined();
  expect(revisions()).toBe(before);
  expect(m.store.getClaim(target.sessionId, "dreaming")).toBeNull();
  expect(m.store.listSessionFacts(target.sessionId)).toHaveLength(1);
  expect(m.store.enabled(other.sessionId)).toBe(true);
  expect(streaks(m).filter(r => r.phase === "dreaming")).toEqual([]);
  expect(await m.dream(target)).toEqual({ outcome: "dropped" });
  expect(await note(m, target)).toEqual({ outcome: "dropped" });
  expect(dreamCalls).toBe(1);
});

test.each([false, true])("92: the failure streak resets only after atomic terminal publication (audit failure: %s)", async auditFailure => {
  const m = open(); const target = seed(m);
  await note(m, target);
  const head = Number(streaks(m)[0]!.head);
  const claim = m.store.acquireClaim(target, "noting", "busy")!;
  expect((await note(m, target)).outcome).toBe("dropped");
  expect(streaks(m)[0]!.count).toBe(1); m.store.releaseClaim(claim);
  const db = file();
  let attempt = 0;
  const good = open(db, async raw => {
    const input = raw as NotingAgentInput;
    const text = `accepted attempt ${++attempt}`;
    await submit(input, good, { noteInput: [{ title: "Held evidence", sources: `[T${t.headTurnId}#E1] ${text}` }],
      memoryInput: { files: null, op: "create", title: "Fixture title", text, category: "constraint", scope: "session", supports: ["$1"], topics: [], reason: "joint extraction" } });
    expect(good.store.listSessionFacts(t.sessionId)).toEqual([]);
    expect(good.store.listKnowledgeRevisions()).toEqual([]);
    return { outcome: "success", output: "corrected", request };
  });
  const t = seed(good);
  if (auditFailure) good.store.db.exec(`CREATE TEMP TRIGGER reject_success_audit BEFORE INSERT ON runs
    WHEN NEW.outcome = 'success' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  const result = await note(good, t);
  expect(result.outcome, JSON.stringify(result)).toBe(auditFailure ? "failure" : "success");
  expect(streaks(good)[0]!.count).toBe(auditFailure ? 1 : 0);
  expect(good.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toHaveLength(auditFailure ? 1 : 0);
  if (auditFailure) {
    expect("problems" in result && result.problems?.join(" ")).toContain("audit unavailable");
    expect(good.store.listSessionFacts(t.sessionId)).toEqual([]);
    expect(good.store.listKnowledgeRevisions()).toEqual([]);
    expect(good.store.listRuns(t.sessionId).map(run => run.outcome)).toEqual(["failure"]);
    expect(good.store.db.prepare("SELECT outcome FROM task_executions").all()).toEqual([{ outcome: "failure" }]);
    good.store.db.exec("DROP TRIGGER reject_success_audit");
    const retried = await note(good, t);
    expect(retried.outcome, JSON.stringify(retried)).toBe("success");
    expect(streaks(good)[0]!.count).toBe(0);
    expect(good.store.db.prepare("SELECT outcome FROM task_executions ORDER BY rowid").all()).toEqual([{ outcome: "failure" }, { outcome: "success" }]);
  }
  const text = `accepted attempt ${auditFailure ? 2 : 1}`;
  expect(good.store.listSessionFacts(t.sessionId).map(fact => fact.text)).toEqual([text]);
  expect(good.store.listKnowledgeRevisions().map(revision => revision.text)).toEqual([text]);
  expect(good.pendingEntries(t.sessionId, t.branch, t.headTurnId)).toEqual([]);
  expect(m.store.db.prepare("SELECT head FROM task_failures").get()!.head).toBe(head);
});

test("92: Noting failure identity stays at the oldest pending entry while the live leaf advances", async () => {
  const m = open(), target = seed(m);
  const oldest = m.pendingEntries(target.sessionId, target.branch, target.headTurnId)[0]!.id;
  let head = target.headTurnId;
  for (let i = 1; i <= 3; i++) {
    head = m.store.appendTurn({ sessionId: target.sessionId, parentTurnId: head, kind: "turn", userPrompt: `later ${i}`, startedAt: "later" }).id;
    const result = await note(m, { ...target, headTurnId: head });
    expect(!!result.automaticOff).toBe(i === 3);
    expect(streaks(m)[0]!.head).toBe(oldest);
    expect(streaks(m)[0]!.count).toBe(i);
  }
  expect(m.pendingEntries(target.sessionId, target.branch, head)[0]!.id).toBe(oldest);
});

test("92: successful N publication resets its own task in the terminal transaction", async () => {
  let succeed = false;
  const m = open(":memory:", async raw => {
    if (!succeed) return failed(raw);
    submitEmpty(raw);
    return { outcome: "success", output: "done", request };
  }), target = seed(m);
  const oldest = m.pendingEntries(target.sessionId, target.branch, target.headTurnId)[0]!.id;
  expect((await note(m, target)).outcome).toBe("failure");
  expect(m.store.taskFailures(target.sessionId)).toMatchObject([{ phase: "noting", head: oldest, count: 1 }]);
  succeed = true;
  expect((await note(m, target)).outcome).toBe("success");
  expect(m.store.taskFailures(target.sessionId)).toMatchObject([{ phase: "noting", head: oldest, count: 0 }]);
  expect(m.pendingEntries(target.sessionId, "main", target.headTurnId)).toEqual([]);
});

test("32c: failed off transaction rolls back the outcome and count; claim cleanup cannot undo a committed off", async () => {
  const m = open(), target = seed(m);
  await note(m, target); await note(m, target);
  const enrollment = vi.spyOn(m.store, "setEnrollment").mockImplementation(() => { throw Error("off persistence failed"); });
  await expect(note(m, target)).rejects.toThrow("off persistence failed");
  expect(streaks(m)[0]!.count).toBe(2);
  expect(m.store.enabled(target.sessionId)).toBe(true);
  expect(m.store.getClaim(target.sessionId, "noting")).toBeNull();
  const run = m.store.listRuns(target.sessionId).at(-1)!;
  const id = execution(m, run.id);
  expect(m.store.db.prepare("SELECT outcome FROM task_executions WHERE id = ?").get(id)!.outcome).toBeNull();
  enrollment.mockRestore();
  expect(m.store.settleExecution(id, "failure", run.id, "provider failed").automaticOff).toBeTruthy();
  expect(m.store.settleExecution(id, "failure", run.id)).toEqual({});
  expect(streaks(m)[0]!.count).toBe(3);
  m.store.setEnrollment(target.sessionId, true);
  await note(m, target); await note(m, target);
  vi.spyOn(m.store, "releaseClaim").mockImplementation(() => { throw Error("cleanup failed"); });
  const third = await note(m, target);
  expect(third.automaticOff).toBeTruthy();
  expect(m.store.enabled(target.sessionId)).toBe(false);
  expect(streaks(m)[0]!.count).toBe(3);
});

test("32c migration: additive execution state survives reopen without inventing legacy outcomes", () => {
  const db = file(), m = open(db), target = seed(m);
  m.store.recordRun({ kind: "noting", sessionId: target.sessionId, outcome: "failure", createdAt: "legacy" });
  m.store.db.exec("DROP TABLE execution_runs; DROP TABLE task_executions; DROP TABLE task_failures;");
  m.close();
  const store = new Store(db);
  try {
    expect(store.listRuns(target.sessionId)).toHaveLength(1);
    expect(store.db.prepare("SELECT * FROM task_executions").all()).toEqual([]);
    expect(store.db.prepare("SELECT * FROM task_failures").all()).toEqual([]);
  } finally { store.close(); }
});
