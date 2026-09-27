import { afterEach, expect, test, vi } from "vitest";
import { suppliedHandles } from "../../dreaming-skips.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hydrate, sourceSeededMemory, type NotingAgentInput, type RunAgent, type TraceMemory } from "../../source-fixture.ts";
import { legacyFacts } from "../../support/seed.ts";
import { Store } from "../../../src/core/store/index.ts";
import type { DreamingAgentInput } from "../../../src/core/api/index.ts";

const memories: TraceMemory[] = [], dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const m of memories.splice(0)) m.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const request = { messages: [] };
const failed: RunAgent = async () => ({ outcome: "failure", output: "provider failed after retries", request });
const open = (file = ":memory:", agent: RunAgent = failed) => {
  const m = sourceSeededMemory(file, agent, { closedSessionScope: "global" }); memories.push(m); return m;
};
const file = () => { const dir = mkdtempSync(join(tmpdir(), "trace-task-failures-")); dirs.push(dir); return join(dir, "test.sqlite"); };
function seed(m: TraceMemory) {
  const p = m.store.findProjectByName("test") ?? m.store.createProject({ name: "test", declaredBy: "mark" });
  const s = m.store.createSession({ host: "test", enrollmentChoice: true, projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "pending evidence", startedAt: "now" });
  return { sessionId: s.id, branch: "main", headTurnId: t.id };
}
const note = (m: TraceMemory, target: ReturnType<typeof seed>, extra = {}) => m.noting({ ...target, mode: "subagent", model: "fake", ...extra });
const streaks = (m: TraceMemory) => m.store.db.prepare("SELECT * FROM task_failures ORDER BY session_id,phase,head").all();
const execution = (m: TraceMemory, runId: number) => String(m.store.db.prepare("SELECT execution_id FROM execution_runs WHERE run_id = ?").get(runId)!.execution_id);
const boundUser = (m: TraceMemory, target: ReturnType<typeof seed>) =>
  hydrate(m.store.listSourceEntries(target.sessionId, target.headTurnId), m.store).find(entry => entry.role === "user")!;
const decision = (m: TraceMemory, target: ReturnType<typeof seed>, text: string) =>
  legacyFacts(m.store, { kind: "manual", sessionId: target.sessionId, createdAt: "now" }, [{
    sources: [{ entry: boundUser(m, target), address: `T${target.headTurnId}#user` }],
    text, category: "decision", actor: "user", createdAt: "now",
  }]);

for (const final of ["success", "failure"] as const) test(`32c: fork refusal + ${final} settles one execution; restart replay cannot count intermediate attempts`, async () => {
  const db = file();
  let m = open(db, async () => ({ outcome: "failure", output: "fork overflow", request, refused: { reason: "overflow" } }));
  const target = seed(m);
  const refused = await note(m, target, { mode: "fork" });
  expect(refused.outcome).toBe("dropped");
  expect(refused.executionId).toBeTruthy();
  expect(streaks(m)).toEqual([]);
  expect(m.store.db.prepare("SELECT outcome FROM task_executions").get()?.outcome).toBeNull();
  const ids = m.pendingEntries(target.sessionId, target.branch, target.headTurnId).map(e => e.id);
  m.close(); // crash/restart observation must not promote the refused run's failure audit
  m = open(db, async raw => {
    if (final === "success") {
      const input = raw as NotingAgentInput;
      input.tools.find(t => t.name === "note")!.execute({ facts: [] });
      input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] });
    }
    return { outcome: final, output: final, request };
  });
  expect(streaks(m)).toEqual([]);
  const result = await note(m, target, { executionId: refused.executionId, boundary: { exactEntryIds: ids } });
  expect(result.outcome).toBe(final);
  if (!("runId" in result) || result.runId === undefined) throw Error("missing terminal run");
  const terminal = result.runId;
  expect(execution(m, terminal)).toBe(refused.executionId);
  expect(m.store.db.prepare("SELECT * FROM task_executions").all()).toHaveLength(1);
  expect(streaks(m)[0]!.count).toBe(final === "success" ? 0 : 1);
  m.close(); m = open(db);
  for (let observer = 0; observer < 3; observer++) expect(m.store.settleExecution(refused.executionId!, final, terminal)).toEqual({});
  expect(streaks(m)[0]!.count).toBe(final === "success" ? 0 : 1);
  if (final === "failure") {
    await note(m, target);
    const third = await note(m, target);
    expect(third.automaticOff).toContain("off after three failures");
    expect(streaks(m)[0]!.count).toBe(3);
    expect(m.store.enabled(target.sessionId)).toBe(false);
  }
});

test("32c: borrowed failures continue across executors, disable only the target and fence its other phase", async () => {
  const db = file(), first = open(db), target = seed(first), executor = seed(first), other = seed(first);
  first.store.closeSession(target.sessionId);
  const options = { borrowed: true, executorSessionId: executor.sessionId };
  await note(first, target, options);
  const second = open(db);
  await note(second, target, options);
  // Other target-phase work remains claimed while the third failure is settled.
  const fact = decision(second, target, "retained fact");
  const knowledge = second.store.commitConsolidationRun({ path: target, run: { kind: "manual", sessionId: target.sessionId, createdAt: "now" }, operations: [{
    op: "create", handle: "$1", author: "test", text: "pending maintenance", category: "constraint", scope: "session",
    supports: [fact.facts[0]!.id], reason: "evidence", topics: [], createdAt: "now",
  }] });
  if (!knowledge.ok) throw Error(knowledge.problems.join("; "));
  const claim = second.store.acquireClaim(target, "dreaming", "another-process")!;
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

test("92: N auto-off fences late D writes, settles skips and own output, and preserves untouched pending", async () => {
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
  const created = m.store.commitConsolidationRun({ run: { kind: "manual", sessionId: target.sessionId, createdAt: "now" }, path: target, operations: [1, 2, 3].map(n => ({
    op: "create", handle: `$${n}`, author: "test", text: `pending maintenance ${n}`, category: "constraint", scope: "session",
    supports: [noted.facts[0]!.id], reason: "evidence", topics: [], createdAt: "now",
  })) });
  if (!created.ok) throw Error(created.problems.join("; "));
  const [first, second, untouched] = created.committed;
  const manual = m.tools({ kind: "manual", ...target, currentTurnId: target.headTurnId }).find(t => t.name === "note")!;
  let late!: () => string, own = 0;
  scenario = input => {
    const tool = input.tools.find(t => t.name === "memory")!;
    const update = { operations: [{ op: "update", id: `K${first!.knowledgeId}#${m.store.versionTag(first!.knowledgeId, first!.commit)}`,
      text: "maintained rule", category: "constraint", scope: "session", supports: [], reason: "maintenance", topics: [] }], skipped: [] };
    expect(tool.execute(update)).not.toContain("rejected:");
    own = m.store.currentCommit(first!.knowledgeId, target)[0]!.id;
    expect(own).not.toBe(first!.commit);
    expect(tool.execute({ operations: [], skipped: [{ knowledge: `K${second!.knowledgeId}@v1`, because: "reviewed unchanged" }] })).not.toContain("rejected:");
    const claim = m.store.getClaim(target.sessionId, "dreaming")!;
    late = () => tool.execute(update);
    expect(input.signal?.aborted).toBe(false);
    return new Promise(resolve => input.signal!.addEventListener("abort", () => {
      expect(m.store.getClaim(target.sessionId, "dreaming")).toEqual(claim);
      expect(late()).toContain("rejected:");
      expect(manual.execute({ facts: [{ title: "Late note", sources: [{ address: `T${target.headTurnId}#E1`, text: "late note" }] }] })).toContain("Disabled");
      resolve({ outcome: "cancelled", output: "aborted", request });
    }, { once: true }));
  };
  m.config.dreaming.triggerTokens = 1;
  const held = m.dream({ ...target, model: "fake" });
  expect((await note(m, target)).automaticOff).toBeTruthy();
  const cancelled = await held;
  expect(cancelled.outcome, JSON.stringify(cancelled)).toBe("cancelled");
  expect(late()).toContain("rejected:");
  expect(m.store.openDreamingRange(target.sessionId, target.branch)).toBeNull();
  expect(m.store.getClaim(target.sessionId, "dreaming")).toBeNull();
  const processed = m.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool=? ORDER BY revision_id").all(`session:${target.sessionId}`).map(row => Number(row.revision_id));
  expect(processed).toEqual([second!.commit, own].sort((a, b) => a - b));
  expect(m.store.pendingVersions(`session:${target.sessionId}`, target).map(r => r.revisionId)).toEqual([untouched!.commit]);
  expect(m.store.listSessionFacts(target.sessionId)).toHaveLength(1);
  expect(m.store.enabled(other.sessionId)).toBe(true);
  expect(streaks(m).filter(r => r.phase === "dreaming")).toEqual([]);
  expect(await m.dream(target)).toEqual({ outcome: "dropped" });
  expect(await note(m, target)).toEqual({ outcome: "dropped" });
  expect(dreamCalls).toBe(1);
});

test.each([false, true])("92: corrected refusal resets only after atomic terminal publication (audit failure: %s)", async auditFailure => {
  const m = open(); const target = seed(m);
  await note(m, target);
  const head = Number(streaks(m)[0]!.head);
  const claim = m.store.acquireClaim(target, "noting", "busy")!;
  expect((await note(m, target)).outcome).toBe("dropped");
  expect(streaks(m)[0]!.count).toBe(1); m.store.releaseClaim(claim);
  const db = file();
  let attempt = 0;
  const good = open(db, async raw => {
    const tools = (raw as NotingAgentInput).tools;
    expect(tools.find(t => t.name === "note")!.execute({ facts: [{ title: "Invalid citation", sources: [{ address: "T999#E1", text: "invalid citation" }] }] })).toContain("rejected");
    expect(tools.find(t => t.name === "note")!.execute({ facts: [], drop: ["$1"] })).not.toContain("rejected:");
    const text = `accepted attempt ${++attempt}`;
    expect(tools.find(tool => tool.name === "note")!.execute({ facts: [{ title: "Held evidence", sources: [{ address: `T${t.headTurnId}#E1`, text }] }] })).toContain("held: $2");
    expect(tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "create", text,
      category: "constraint", scope: "session", supports: ["$2"], topics: [], reason: "joint extraction" }], skipped: [] })).toContain("held");
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

test("68: Dreamer terminal outcomes consume accepted skips; a later range settles independently", async () => {
  let outcome: "failure" | "success" = "failure";
  const m = open(":memory:", async raw => {
    const input = raw as DreamingAgentInput;
    if (input.kind !== "dreaming") return { outcome, output: outcome, request };
    const handles = suppliedHandles(input.material.changed);
    input.tools.find(tool => tool.name === "memory")!.execute({ operations: [],
      skipped: handles.map(knowledge => ({ knowledge, because: "fixture reviewed unchanged" })) });
    return { outcome, output: outcome, request };
  });
  m.config.dreaming.triggerTokens = 1;
  const target = seed(m);
  const facts = decision(m, target, "evidence");
  const create = (handle: string) => {
    const result = m.store.commitConsolidationRun({ run: { kind: "manual", sessionId: target.sessionId, createdAt: "now" }, path: target, operations: [
      { op: "create", handle, author: "test", text: `${handle} ${"work ".repeat(600)}`, category: "constraint", scope: "session",
        supports: [facts.facts[0]!.id], reason: "test", topics: [], createdAt: "now" }] });
    if (!result.ok) throw Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  const first = create("$first"), pool = `session:${target.sessionId}`;
  m.store.setKnowledgeBudget("session", m.store.pendingPoolWeight(pool, target) * 2);
  const failed = await m.dream(target);
  expect(failed.outcome).toBe("failure");
  if (!("runId" in failed)) throw Error("missing failed run");
  expect(m.store.db.prepare("SELECT outcome FROM task_executions WHERE id = ?").get(execution(m, failed.runId))!.outcome).toBe("failure");
  expect(m.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ?").all(pool).map(row => Number(row.revision_id))).toEqual([first.commit]);
  expect(m.store.openDreamingRange(target.sessionId, target.branch)).toBeNull();
  expect((await m.dream(target)).outcome).toBe("empty");

  outcome = "success";
  const second = create("$second");
  m.store.setKnowledgeBudget("session", m.store.pendingPoolWeight(pool, target) * 2);
  const succeeded = await m.dream(target);
  expect(succeeded.outcome).toBe("success");
  if (!("runId" in succeeded)) throw Error("missing successful run");
  expect(m.store.db.prepare("SELECT outcome FROM task_executions WHERE id = ?").get(execution(m, succeeded.runId))!.outcome).toBe("success");
  expect(m.store.db.prepare("SELECT revision_id FROM knowledge_processed WHERE pool = ? ORDER BY revision_id").all(pool).map(row => Number(row.revision_id)))
    .toEqual([first.commit, second.commit]);
  expect(m.store.settleExecution(execution(m, succeeded.runId), "failure", succeeded.runId, "post-success audit")).toEqual({});
});

test("86: three Dreamer failures on one unchanged pending revision turn memory off; later oldest starts independently", async () => {
  let skip = false;
  const m = open(":memory:", async raw => {
    const input = raw as DreamingAgentInput;
    if (skip && input.kind === "dreaming") {
      input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [
        { knowledge: suppliedHandles(input.material.changed)[0], because: "Reviewed without a change" },
      ] });
      return { outcome: "success", output: "processed", request };
    }
    return failed(raw);
  });
  m.config.dreaming.triggerTokens = 1;
  const target = seed(m), pool = `session:${target.sessionId}`;
  const facts = decision(m, target, "evidence");
  const create = (text: string) => {
    const committed = m.store.commitConsolidationRun({ path: target,
      run: { kind: "manual", sessionId: target.sessionId, createdAt: "now" }, operations: [
        { op: "create", handle: "$1", author: "test", text, category: "constraint", scope: "session",
          topics: [], supports: [facts.facts[0]!.id], reason: "evidence", createdAt: "now" },
      ] });
    if (!committed.ok) throw Error(committed.problems.join("; "));
    return committed.committed[0]!;
  };
  const first = create("first task");
  for (let i = 1; i <= 3; i++) {
    const result = await m.dream(target);
    expect(result.outcome).toBe("failure");
    expect(streaks(m)).toMatchObject([{ phase: "dreaming", head: first.commit, count: i }]);
    expect(m.store.pendingVersions(pool, target).map(v => v.revisionId)).toEqual([first.commit]);
    expect(!!result.automaticOff).toBe(i === 3);
  }
  expect(m.store.enabled(target.sessionId)).toBe(false);
  m.store.setEnrollment(target.sessionId, true);
  skip = true;
  expect((await m.dream(target)).outcome).toBe("success");
  expect(m.store.pendingVersions(pool, target)).toEqual([]);
  const second = create("independent task");
  skip = false;
  expect((await m.dream(target)).outcome).toBe("failure");
  expect(streaks(m).filter(row => Number(row.count) > 0)).toMatchObject([{ phase: "dreaming", head: second.commit, count: 1 }]);
});

test("92: successful N publication resets its own task in the terminal transaction", async () => {
  let succeed = false;
  const m = open(":memory:", async raw => {
    if (!succeed) return failed(raw);
    const input = raw as NotingAgentInput;
    expect(input.tools.find(t => t.name === "note")!.execute({ facts: [] })).not.toContain("rejected:");
    expect(input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] })).not.toContain("rejected:");
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
