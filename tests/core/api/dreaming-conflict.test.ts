import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { freezeDreaming } from "../../../src/core/dreaming/index.ts";

const memories: ReturnType<typeof TraceMemory>[] = [], dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const m of memories.splice(0)) m.close(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const success = { outcome: "success", request: { exact: "offline request" }, output: "reviewed", usage: { input: 10, output: 5, cost: { total: 0.25 } } } as const;
class Barrier {
  release!: () => void;
  readonly wait = new Promise<void>(resolve => { this.release = resolve; });
}
function fixture(body = "durable rule") {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-external-conflict-")); dirs.push(dir);
  const db = join(dir, "memory.sqlite");
  let agent: (task: DreamingAgentInput) => Promise<RunAgentResult> = async () => success;
  const memory = TraceMemory(db, task => agent(task as DreamingAgentInput), { dreaming: { triggerTokens: 1 } }); memories.push(memory);
  const store = memory.store;
  const p = store.createProject({ name: "shared", declaredBy: "mark" });
  const s = store.createSession({ host: "offline", projectId: p.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const t = store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: body, startedAt: "now" });
  const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const facts = store.commitNotingRun({ run: { kind: "manual", sessionId: s.id, createdAt: "now" }, facts: [{ turnId: t.id, text: body, category: "decision", actor: "user", source: [`T${t.id}#user`], createdAt: "now" }] });
  if (!facts.ok) throw Error(facts.problems.join());
  const content = { text: body, category: "constraint" as const, scope: "project" as const, supports: [facts.facts[0]!.id], topics: [], reason: "evidence", createdAt: "now" };
  const created = store.commitConsolidationRun({ run: { kind: "manual", sessionId: s.id, createdAt: "now" }, operations: [{ op: "create", handle: "$1", author: "test", ...content }] });
  if (!created.ok) throw Error(created.problems.join());
  const item = created.committed[0]!;
  const other = TraceMemory(db, async () => { throw Error("No external provider"); }); memories.push(other);
  const os = other.store.createSession({ host: "offline", projectId: p.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const ot = other.store.appendTurn({ sessionId: os.id, kind: "turn", userPrompt: "external executor", startedAt: "now" });
  const otherPath = { sessionId: os.id, branch: "main", headTurnId: ot.id };
  const write = (merge = false) => {
    const base = other.store.currentCommit(item.knowledgeId, otherPath)[0]!;
    const run = { kind: "manual" as const, sessionId: os.id, createdAt: "now" };
    let operations: Parameters<typeof store.commitConsolidationRun>[0]["operations"];
    if (merge) {
      const created = other.store.commitConsolidationRun({ run, operations: [{ op: "create", handle: "$outside", author: "external", ...content, text: "outside survivor" }] });
      if (!created.ok) throw Error(created.problems.join());
      const outside = created.committed[0]!;
      operations = [{ op: "merge", intoKnowledgeId: outside.knowledgeId, intoBaseCommit: outside.commit, absorb: [{ knowledgeId: item.knowledgeId, baseCommit: base.id }], ...content, text: "external merged result" }];
    } else operations = [{ op: "update", knowledgeId: item.knowledgeId, baseCommit: base.id, ...content, text: `external update after ${base.id}` }];
    const result = other.store.commitConsolidationRun({ run, path: otherPath, operations });
    if (!result.ok) throw Error(result.problems.join());
    return result.committed[0]!;
  };
  const setAgent = (next: typeof agent) => { agent = next; };
  const count = () => store.taskFailures(s.id).find(f => f.phase === "dreaming")?.count ?? 0;
  const race = async (options: { merge?: boolean; before?: (task: DreamingAgentInput) => void; after?: (task: DreamingAgentInput) => void; result?: RunAgentResult; signal?: AbortSignal } = {}) => {
    const frozen = new Barrier(), changed = new Barrier();
    setAgent(async task => { options.before?.(task); frozen.release(); await changed.wait; options.after?.(task); return options.result ?? success; });
    const pending = memory.dream({ ...target, signal: options.signal });
    await frozen.wait;
    let external!: ReturnType<typeof write>;
    try { external = write(options.merge); } finally { changed.release(); }
    return { result: await pending, external };
  };
  return { memory, store, other, otherPath, db, target, item, content, setAgent, count, race, write };
}
const tool = (task: DreamingAgentInput, name: string) => task.tools.find(t => t.name === name)!;

test.each([0, 2])("consumed inputs complete successfully at streak %s; success resets before later real failures", async initial => {
  const f = fixture();
  f.setAgent(async () => ({ ...success, outcome: "failure", output: "provider failed" }));
  for (let i = 0; i < initial; i++) expect((await f.memory.dream(f.target)).outcome).toBe("failure");
  expect(f.count()).toBe(initial);
  const consumed: number[] = [];
  for (let i = 0; i < 4; i++) {
    const selected = f.store.pendingKnowledgeEvents(f.target)[0]!.id;
    const { result, external } = await f.race();
    consumed.push(selected);
    expect(result.outcome).toBe("success");
    expect(result.automaticOff).toBeUndefined();
    expect(f.count()).toBe(0);
    expect(f.store.isKnowledgeProcessed(external.commit)).toBe(false);
    expect(f.store.enabled(f.target.sessionId)).toBe(true);
  }
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events ORDER BY event_id").all().map(row => Number(row.event_id))).toEqual(consumed);
  expect(f.store.db.prepare("SELECT commit_id FROM processed_knowledge_versions").all()).toEqual([]);
  expect(f.store.db.prepare("SELECT * FROM dreaming_completions").all()).toHaveLength(4);
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: true });
  f.setAgent(async () => ({ ...success, outcome: "failure", output: "real provider failure" }));
  for (let i = 0; i < 3; i++) {
    const result = await f.memory.dream(f.target);
    expect(result.outcome).toBe("failure");
    expect(Math.max(...f.store.taskFailures(f.target.sessionId).map(row => row.count))).toBe(i + 1);
    expect(!!result.automaticOff).toBe(i === 2);
  }
  expect(f.store.enabled(f.target.sessionId)).toBe(false);
});

test.each([false, true])("own intermediate consumed by external merge=%s keeps audit and exact settlement across reopen", async merge => {
  const f = fixture();
  let own = 0;
  const { result, external } = await f.race({ merge, before: task => {
    const receipt = JSON.parse(tool(task, "memory").execute({ operations: [{ op: "update", id: `K${f.item.knowledgeId}@${f.item.commit}`, text: "own maintained wording", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "legal maintenance" }], skipped: [] }));
    own = receipt.committed[0].commit;
  }, after: task => { tool(task, "trace").execute({ address: `K${externalId()}`, full: true }); } });
  function externalId() { return f.store.commitGraph(f.target).current[0]!.knowledgeId; }
  expect(result.outcome).toBe("success");
  if (!("runId" in result)) throw Error("missing run");
  expect(f.store.listCommitsByRun(result.runId).map(r => r.id)).toEqual([own]);
  expect(f.store.isKnowledgeProcessed(own)).toBe(false);
  expect(f.store.isKnowledgeProcessed(external.commit)).toBe(false);
  expect(f.store.isKnowledgeProcessed(f.item.commit)).toBe(false);
  expect(f.memory.spend(f.target.sessionId).cost).toBe(0.25);
  expect(f.store.getRun(result.runId)!.outcome).toBe("success");
  expect(f.store.getClaim(f.target.sessionId, "dreaming")).toBeNull();
  expect(f.store.retryDreamingRange(f.target)).toBeNull();
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events").all().map(row => Number(row.event_id))).toEqual([f.item.commit]);
  expect(f.store.db.prepare("SELECT name FROM sqlite_master WHERE name = 'pending_deliveries'").get()).toBeUndefined();
  expect(f.memory.status(f.target.sessionId, f.target.branch, f.target.headTurnId)).toContain(`Last dreaming: run ${result.runId} success`);
  expect(f.memory.branchSummary(f.target.sessionId, f.target.branch, f.target.headTurnId)).toContain(merge ? "external merged result" : `external update after ${own}`);
  const execution = String(f.store.db.prepare("SELECT execution_id FROM execution_runs WHERE run_id = ?").get(result.runId)!.execution_id);
  f.memory.close();
  const reopened = TraceMemory(f.db, async raw => {
    const task = raw as DreamingAgentInput;
    expect(task.material.changed).toContain(`K${external.knowledgeId}@${external.commit}`);
    const receipt = tool(task, "check").execute({});
    expect(receipt).toContain("- successor-free results: 1");
    expect(receipt).toContain("Blockers: none");
    expect(receipt).not.toContain(`K${external.knowledgeId}@${external.commit}`);
    return success;
  }, { dreaming: { triggerTokens: 1000000 } }); memories.push(reopened);
  for (const outcome of ["failure", "cancelled", "conflict"] as const) expect(reopened.settleExecution(execution, outcome, result.runId)).toEqual({});
  expect(reopened.store.db.prepare("SELECT outcome FROM task_executions WHERE id = ?").get(execution)?.outcome).toBe("success");
  expect(reopened.store.pendingKnowledgeEvents(f.target).map(event => event.id)).toContain(external.commit);
  expect(reopened.taskEligibility("dreaming", f.target)).toEqual({ due: false });
  expect((await reopened.dream(f.target)).outcome).toBe("dropped");
  expect(reopened.store.isKnowledgeProcessed(external.commit)).toBe(false);
  reopened.close();
  const catchup = TraceMemory(f.db, async raw => {
    const task = raw as DreamingAgentInput;
    expect(task.material.changed).toContain(`K${external.knowledgeId}@${external.commit}`);
    return success;
  }, { dreaming: { triggerTokens: 1 } }); memories.push(catchup);
  expect((await catchup.dream(f.target)).outcome).toBe("success");
  expect(catchup.store.isKnowledgeProcessed(external.commit)).toBe(true);
  expect(catchup.store.isKnowledgeProcessed(own)).toBe(false);
  expect(catchup.store.retryDreamingRange(f.target)).toBeNull();
  expect(catchup.store.pendingKnowledgeEvents(f.target)).toEqual([]);
});

test.each([false, true])("a successor of processed read-only material does not enlarge the retained changed batch (merge=%s)", async merge => {
  const f = fixture("pending ".repeat(6000));
  const created = f.other.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
    operations: [{ op: "create", handle: "$processed", author: "external", ...f.content, text: "processed ".repeat(4500) }] });
  if (!created.ok) throw Error(created.problems.join());
  const processed = created.committed[0]!;
  const certified = f.other.store.recordRun({ kind: "dreaming", sessionId: f.otherPath.sessionId, outcome: "success", createdAt: "now" });
  f.other.store.completeDreaming(certified.id, [processed.commit], [processed.commit]);

  const frozen = new Barrier(), changed = new Barrier();
  const materials: string[] = [];
  let attempt = 0;
  f.setAgent(async task => {
    materials.push(task.material.changed);
    if (attempt++ === 0) { frozen.release(); await changed.wait; }
    expect(task.material.changed).toContain(`K${f.item.knowledgeId}@${f.item.commit}`);
    return success;
  });
  const first = f.memory.dream(f.target);
  await frozen.wait;
  const base = f.other.store.currentCommit(processed.knowledgeId, f.otherPath)[0]!;
  let operations: Parameters<typeof f.other.store.commitConsolidationRun>[0]["operations"];
  if (merge) {
    const survivor = f.other.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
      operations: [{ op: "create", handle: "$survivor", author: "external", ...f.content, text: "survivor" }] });
    if (!survivor.ok) throw Error(survivor.problems.join());
    operations = [{ op: "merge", intoKnowledgeId: survivor.committed[0]!.knowledgeId, intoBaseCommit: survivor.committed[0]!.commit,
      absorb: [{ knowledgeId: processed.knowledgeId, baseCommit: base.id }], ...f.content, text: "successor ".repeat(4500) }];
  } else operations = [{ op: "update", knowledgeId: processed.knowledgeId, baseCommit: base.id, ...f.content, text: "successor ".repeat(4500) }];
  const successor = f.other.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" }, path: f.otherPath, operations });
  if (!successor.ok) throw Error(successor.problems.join());
  changed.release();

  const conflicted = await first;
  expect(conflicted.outcome).toBe("conflict");
  if (!("runId" in conflicted)) throw Error("missing run");
  const firstCheck = JSON.parse(f.store.getRun(conflicted.runId)!.response!).check;
  expect(firstCheck.resultIds).toEqual([f.item.commit]);
  expect(firstCheck.externalSuccessors).toEqual([{ knowledgeId: successor.committed[0]!.knowledgeId, commit: successor.committed[0]!.commit }]);
  expect(f.store.isKnowledgeProcessed(processed.commit)).toBe(true);
  expect(f.count()).toBe(0);
  const retained = f.store.retryDreamingRange(f.target)!;
  expect(retained.anchor).toBe(f.item.commit);
  const resumed = await f.memory.dream(f.target);
  expect(resumed.outcome).toBe("success");
  expect(materials[1]).not.toContain(`K${successor.committed[0]!.knowledgeId}@${successor.committed[0]!.commit}`);
  expect(f.store.isKnowledgeProcessed(f.item.commit)).toBe(true);
  expect(f.store.isKnowledgeProcessed(successor.committed[0]!.commit)).toBe(false);
  expect(f.store.retryDreamingRange(f.target)).toBeNull();

  const independent = await f.memory.dream(f.target);
  expect(independent.outcome).toBe("failure");
  if (!('problems' in independent)) throw Error("missing problems");
  expect(independent.problems.join()).toContain("exceeds 10000");
  expect(f.store.taskFailures(f.target.sessionId).some(row => row.head !== f.item.commit && row.count === 1)).toBe(true);
});

test("consumed original events close exactly and their enlarged outside events are independently rebatched", async () => {
  const f = fixture("first ".repeat(2500));
  const originals = [f.item];
  for (const [handle, word] of [["$second", "second"], ["$third", "third"]] as const) {
    const created = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" },
      operations: [{ op: "create", handle, author: "test", ...f.content, text: `${word} `.repeat(2500) }] });
    if (!created.ok) throw Error(created.problems.join());
    originals.push(created.committed[0]!);
  }
  const originalEventIds = originals.map(item => item.commit);
  const frozen = new Barrier(), changed = new Barrier();
  f.setAgent(async () => { frozen.release(); await changed.wait; return success; });
  const first = f.memory.dream(f.target);
  await frozen.wait;
  const successors = [];
  for (const item of originals) {
    const current = f.other.store.currentCommit(item.knowledgeId, f.otherPath)[0]!;
    const updated = f.other.store.commitConsolidationRun({ path: f.otherPath,
      run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
      operations: [{ op: "update", knowledgeId: item.knowledgeId, baseCommit: current.id, ...f.content, text: "expanded ".repeat(3500) }] });
    if (!updated.ok) throw Error(updated.problems.join());
    successors.push(updated.committed[0]!);
  }
  changed.release();
  expect((await first).outcome).toBe("success");
  expect(f.store.retryDreamingRange(f.target)).toBeNull();
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events ORDER BY event_id").all().map(row => Number(row.event_id))).toEqual(originalEventIds);
  expect(f.store.pendingKnowledgeEvents(f.target).map(event => event.id)).toEqual(successors.map(item => item.commit));
  const completedRange = f.store.dreamingRange(1, true)!;
  expect(completedRange).toMatchObject({ anchor: f.item.commit, eventIds: originalEventIds });

  const changedSizes: number[] = [], maintainedBatchSizes: number[] = [];
  let maintainedRuns = 0;
  f.setAgent(async task => {
    changedSizes.push(tokens(task.material.changed));
    const handles = [...task.material.changed.matchAll(/\[K(\d+)@(\d+)\]/g)]
      .map(match => ({ knowledgeId: Number(match[1]), commit: Number(match[2]) }));
    const current = maintainedRuns++ < 2 ? handles.filter(handle => f.store.knowledgeRevision(handle.commit)?.op !== "archive") : [];
    maintainedBatchSizes.push(current.length);
    if (current.length) {
      const receipt = tool(task, "memory").execute({ operations: current.map(handle => ({ op: "archive", id: `K${handle.knowledgeId}@${handle.commit}`,
        supports: [], reason: "Retire test material after verifying the rebatch" })), skipped: [] });
      expect(receipt).toContain('"committed"');
    }
    return success;
  });
  const outcomes = [];
  for (let guard = 0; guard < 10 && (f.store.retryDreamingRange(f.target) || f.store.pendingKnowledgeEvents(f.target).length); guard++)
    outcomes.push((await f.memory.dream(f.target)).outcome);
  expect(outcomes).toEqual(["success", "success"]);
  expect(changedSizes.every(size => size <= 10000)).toBe(true);
  expect(maintainedBatchSizes).toEqual([2, 1]);
  expect(f.store.retryDreamingRange(f.target)).toBeNull();
  expect(f.store.pendingKnowledgeEvents(f.target)).toEqual([]);
  expect(f.store.dreamingRange(completedRange.id, true)).toEqual(completedRange);
  for (const item of successors) expect(f.store.isKnowledgeProcessed(f.store.currentCommit(item.knowledgeId, f.target)[0]!.id)).toBe(true);
  expect(f.store.taskFailures(f.target.sessionId).every(row => row.count === 0)).toBe(true);
});

test("one consumed input's indivisible oversized successor stays pending without pinning independent inputs", async () => {
  const f = fixture("first ".repeat(2500));
  const originals = [f.item];
  for (const handle of ["$second", "$third"]) {
    const created = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" },
      operations: [{ op: "create", handle, author: "test", ...f.content, text: "later ".repeat(2500) }] });
    if (!created.ok) throw Error(created.problems.join());
    originals.push(created.committed[0]!);
  }
  const frozen = new Barrier(), changed = new Barrier();
  f.setAgent(async () => { frozen.release(); await changed.wait; return success; });
  const first = f.memory.dream(f.target);
  await frozen.wait;
  const base = f.other.store.currentCommit(f.item.knowledgeId, f.otherPath)[0]!;
  const successor = f.other.store.commitConsolidationRun({ path: f.otherPath,
    run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
    operations: [{ op: "update", knowledgeId: f.item.knowledgeId, baseCommit: base.id, ...f.content, text: "oversized ".repeat(11000) }] });
  if (!successor.ok) throw Error(successor.problems.join());
  changed.release();
  expect((await first).outcome).toBe("success");
  expect(f.store.retryDreamingRange(f.target)).toBeNull();
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events ORDER BY event_id").all().map(row => Number(row.event_id)))
    .toEqual(originals.map(item => item.commit));
  expect(originals.slice(1).every(item => f.store.isKnowledgeProcessed(item.commit))).toBe(true);
  expect(f.store.isKnowledgeProcessed(f.item.commit)).toBe(false);
  expect(f.store.pendingKnowledgeEvents(f.target).map(event => event.id)).toEqual([successor.committed[0]!.commit]);
  const runs = f.store.listRuns(f.target.sessionId).length;
  await expect(f.memory.dream(f.target)).rejects.toThrow("oldest change with its current body and framing exceeds 10000");
  expect(f.store.listRuns(f.target.sessionId)).toHaveLength(runs);
  expect(f.store.isKnowledgeProcessed(successor.committed[0]!.commit)).toBe(false);
  expect(f.store.taskFailures(f.target.sessionId).every(row => row.count === 0)).toBe(true);
});

test.each([false, true])("an oversized consumer of a legal own output does not pin independent events and its later leaf remains certifiable (merge=%s)", async merge => {
  const f = fixture("first ".repeat(1800));
  const originals = [f.item];
  for (const [handle, word] of [["$second", "second"], ["$third", "third"]] as const) {
    const created = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" },
      operations: [{ op: "create", handle, author: "test", ...f.content, text: `${word} `.repeat(1800) }] });
    if (!created.ok) throw Error(created.problems.join());
    originals.push(created.committed[0]!);
  }
  let own = 0, oversized = 0, outsideEvent = 0;
  f.setAgent(async task => {
    const receipt = JSON.parse(tool(task, "memory").execute({ operations: [{ op: "update", id: `K${f.item.knowledgeId}@${f.item.commit}`,
      text: "own maintained", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "legal maintenance" }], skipped: [] }));
    own = receipt.committed[0].commit;
    let operation: Parameters<typeof f.other.store.commitConsolidationRun>[0]["operations"][number];
    if (merge) {
      const survivor = f.other.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
        operations: [{ op: "create", handle: "$survivor", author: "external", ...f.content, text: "outside survivor" }] });
      if (!survivor.ok) throw Error(survivor.problems.join());
      outsideEvent = survivor.committed[0]!.commit;
      operation = { op: "merge", intoKnowledgeId: survivor.committed[0]!.knowledgeId, intoBaseCommit: survivor.committed[0]!.commit,
        absorb: [{ knowledgeId: f.item.knowledgeId, baseCommit: own }], ...f.content, text: "oversized ".repeat(11000) };
    } else operation = { op: "update", knowledgeId: f.item.knowledgeId, baseCommit: own, ...f.content, text: "oversized ".repeat(11000) };
    const external = f.other.store.commitConsolidationRun({ path: f.otherPath,
      run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" }, operations: [operation] });
    if (!external.ok) throw Error(external.problems.join());
    oversized = external.committed[0]!.commit;
    return success;
  });
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.retryDreamingRange(f.target)).toBeNull();
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events ORDER BY event_id").all().map(row => Number(row.event_id)))
    .toEqual(originals.map(item => item.commit));
  expect(originals.slice(1).every(item => f.store.isKnowledgeProcessed(item.commit))).toBe(true);
  expect(f.store.isKnowledgeProcessed(own)).toBe(false);
  expect(f.store.isKnowledgeProcessed(oversized)).toBe(false);
  const runs = f.store.listRuns(f.target.sessionId).length;
  await expect(f.memory.dream(f.target)).rejects.toThrow("oldest change with its current body and framing exceeds 10000");
  expect(f.store.listRuns(f.target.sessionId)).toHaveLength(runs);
  expect(f.store.taskFailures(f.target.sessionId).every(row => row.count === 0)).toBe(true);

  const current = f.other.store.commitGraph(f.otherPath).current.find(revision => revision.id === oversized)!;
  const recovered = f.other.store.commitConsolidationRun({ path: f.otherPath,
    run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
    operations: [{ op: "update", knowledgeId: current.knowledgeId, baseCommit: current.id, ...f.content, text: "recovered output" }] });
  if (!recovered.ok) throw Error(recovered.problems.join());
  f.setAgent(async task => {
    expect(tokens(task.material.changed)).toBeLessThanOrEqual(10000);
    expect(task.material.changed).toContain(`K${recovered.committed[0]!.knowledgeId}@${recovered.committed[0]!.commit}`);
    return success;
  });
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.isKnowledgeProcessed(recovered.committed[0]!.commit)).toBe(true);
  expect(f.store.isKnowledgeProcessed(own)).toBe(false);
  expect(f.store.isKnowledgeProcessed(oversized)).toBe(false);
  expect(f.store.retryDreamingRange(f.target)).toBeNull();
  const laterEvents = [outsideEvent, oversized, recovered.committed[0]!.commit].filter(Boolean).sort((a, b) => a - b);
  expect(f.store.db.prepare("SELECT event_id, COUNT(*) n FROM settled_knowledge_events GROUP BY event_id ORDER BY event_id").all()
    .map(row => [Number(row.event_id), Number(row.n)])).toEqual([...originals.map(item => [item.commit, 1]), ...laterEvents.map(id => [id, 1])]);
  expect(f.store.db.prepare("SELECT event_ids FROM dreaming_completions ORDER BY run_id").all().map(row => JSON.parse(String(row.event_ids))))
    .toEqual([originals.map(item => item.commit), laterEvents]);
});

test("retained events that share a merge result are supplied and settled as one component", () => {
  const f = fixture("first ".repeat(1000));
  const second = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" },
    operations: [{ op: "create", handle: "$second", author: "test", ...f.content, text: "second ".repeat(1000) }] });
  const third = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" },
    operations: [{ op: "create", handle: "$third", author: "test", ...f.content, text: "third ".repeat(5000) }] });
  if (!second.ok || !third.ok) throw Error("seed failed");
  const ids = [f.item.commit, second.committed[0]!.commit, third.committed[0]!.commit];
  const range = f.store.retainDreamingRange(f.target, ids);
  const merged = f.other.store.commitConsolidationRun({ path: f.otherPath,
    run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" }, operations: [{ op: "merge",
      intoKnowledgeId: f.item.knowledgeId, intoBaseCommit: f.item.commit,
      absorb: [{ knowledgeId: second.committed[0]!.knowledgeId, baseCommit: second.committed[0]!.commit }],
      ...f.content, text: "shared merge result ".repeat(3000) }] });
  if (!merged.ok) throw Error(merged.problems.join());
  const frozen = f.store.transaction(() => freezeDreaming(f.store, f.target, f.memory.config));
  expect(frozen.range).toEqual(range);
  expect(frozen.eventIds).toEqual(ids.slice(0, 2));
  expect(frozen.changed.versions.map(value => value.revision.id)).toEqual([merged.committed[0]!.commit]);
  expect(tokens(frozen.material.changed)).toBeLessThanOrEqual(10000);
  const all = f.store.dreamingInput(f.target, ids, []);
  expect(tokens(`Changed knowledge (unsettled events):\n${all.text}`)).toBeGreaterThan(10000);
});

test("retained admission reuses one graph and keeps SQL preparation linear in candidate count", () => {
  const f = fixture("evidence");
  const operations = Array.from({ length: 199 }, (_, index) => ({ op: "create" as const, handle: `$bulk${index}`, author: "test", ...f.content, text: "rule" }));
  const created = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations });
  if (!created.ok) throw Error(created.problems.join());
  const first = f.store.transaction(() => freezeDreaming(f.store, f.target, f.memory.config));
  expect(first.eventIds).toHaveLength(200);
  const originalPrepare = f.store.db.prepare.bind(f.store.db), originalGraphInput = f.store.commitGraphInput.bind(f.store);
  let prepares = 0, graphs = 0;
  f.store.db.prepare = ((...args: Parameters<typeof f.store.db.prepare>) => { prepares++; return originalPrepare(...args); }) as typeof f.store.db.prepare;
  f.store.commitGraphInput = ((...args: Parameters<typeof f.store.commitGraphInput>) => { graphs++; return originalGraphInput(...args); }) as typeof f.store.commitGraphInput;
  try {
    const retained = f.store.transaction(() => freezeDreaming(f.store, f.target, f.memory.config));
    expect(retained.eventIds).toEqual(first.eventIds);
    expect(retained.material.changed).toBe(first.material.changed);
  } finally {
    f.store.db.prepare = originalPrepare;
    f.store.commitGraphInput = originalGraphInput;
  }
  expect(graphs).toBe(2); // changed admission plus the independently bounded processed window
  expect(prepares).toBeLessThan(1000); // linear metadata/body reads, not candidates × full-store scans
});

test.each(["provider", "request", "invalid", "scope", "stale", "tool", "budget"])("external successor cannot hide unresolved %s failure", async problem => {
  const f = fixture();
  const { result } = await f.race({
    result: problem === "provider" ? { ...success, outcome: "failure", output: "external successor after freeze (provider's own words)" }
      : problem === "request" ? { outcome: "success", output: "missing request" } : success,
    after: task => {
      if (problem === "invalid") expect(tool(task, "memory").execute({ operations: [{ op: "create", supports: [], text: "invented" }], skipped: [] })).toContain("rejected");
      if (problem === "scope") {
        const outside = f.other.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$outside", author: "external", ...f.content }] });
        if (!outside.ok) throw Error(outside.problems.join());
        const item = outside.committed[0]!;
        tool(task, "trace").execute({ address: `K${item.knowledgeId}`, full: true });
        expect(tool(task, "memory").execute({ operations: [{ op: "archive", id: `K${item.knowledgeId}@${item.commit}`, supports: [], reason: "illegal outside family" }], skipped: [] })).toContain("read-only");
      }
      if (problem === "stale") expect(tool(task, "memory").execute({ operations: [{ op: "archive", id: `K${f.item.knowledgeId}@${f.item.commit}`, supports: [], reason: "stale write" }], skipped: [] })).toContain("rejected");
      if (problem === "tool") expect(tool(task, "check").execute({ claim: "conflict" })).toContain("rejected");
      if (problem === "budget") {
        // Synthetic legacy certified pool, deliberately beyond today's hard cap. The external
        // successor must not mask this independent real capacity violation.
        const added = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$large", author: "legacy", ...f.content, text: "large ".repeat(12000) }] });
        if (!added.ok) throw Error(added.problems.join());
        const legacy = f.store.recordRun({ kind: "dreaming", sessionId: f.target.sessionId, createdAt: "now", outcome: "success" });
        f.store.db.prepare("INSERT INTO dreaming_completions VALUES (?, '[]', '[]')").run(legacy.id);
        f.store.db.prepare("INSERT INTO processed_knowledge_versions VALUES (?, ?)").run(added.committed[0]!.commit, legacy.id);
      }
    },
  });
  const skipped = problem === "stale";
  expect(result.outcome).toBe(skipped ? "success" : "failure");
  expect(f.count()).toBe(skipped ? 0 : 1);
  if (!("runId" in result)) throw Error("missing run");
  expect(f.store.getRun(result.runId)?.outcome).toBe(skipped ? "success" : "failure");
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events").all().map(row => Number(row.event_id)))
    .toEqual(skipped ? [f.item.commit] : []);
});

test.each(["cancel", "lost claim"])("external successor does not replace %s settlement", async kind => {
  const f = fixture(), controller = new AbortController();
  const { result } = await f.race({ signal: controller.signal, after: () => {
    if (kind === "cancel") controller.abort();
    else f.other.store.reopenSession(f.target.sessionId, f.other.executorId);
  } });
  expect(result.outcome).not.toBe("conflict");
  expect(f.count()).toBe(0);
  expect(f.store.db.prepare("SELECT outcome FROM task_executions").get()?.outcome).toBe("cancelled");
});

test("untrusted provider result and public settlement cannot manufacture the exception", async () => {
  const f = fixture();
  f.setAgent(async () => ({ ...success, outcome: "failure", output: "external successor after freeze", conflict: true }));
  expect((await f.memory.dream(f.target)).outcome).toBe("failure");
  expect(f.count()).toBe(1);
  for (const phase of ["noting", "consolidation", "dreaming"] as const) {
    const executionId = f.store.beginExecution({ sessionId: f.target.sessionId, phase, head: f.item.commit });
    const run = f.store.recordRun({ kind: phase, sessionId: f.target.sessionId, executionId, outcome: "conflict", response: JSON.stringify({ check: { externalSuccessors: [f.item], failures: [] } }), createdAt: "now" });
    expect(() => f.memory.settleExecution(executionId, "conflict", run.id)).toThrow("core Dreamer termination authority");
    const unrelated = f.store.recordRun({ kind: phase, sessionId: f.target.sessionId, outcome: "conflict", createdAt: "now" });
    expect(() => f.memory.settleExecution(executionId, "conflict", unrelated.id)).toThrow("belong to the execution");
  }
  expect(f.count()).toBe(1);
});

test.each([false, true])("another target's Dreamer may finish shared events (merge=%s) without making the original execution a failure", async merge => {
  const f = fixture(), frozen = new Barrier(), finished = new Barrier();
  f.setAgent(async () => { frozen.release(); await finished.wait; return success; });
  const pending = f.memory.dream(f.target);
  await frozen.wait;
  let survivor = f.item;
  if (merge) {
    const created = f.other.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
      operations: [{ op: "create", handle: "$outside", author: "external", ...f.content }] });
    if (!created.ok) throw Error(created.problems.join());
    survivor = created.committed[0]!;
  }
  const other = TraceMemory(f.db, async raw => {
    const task = raw as DreamingAgentInput;
    expect(tool(task, "memory").execute({ operations: [{ op: merge ? "merge" : "update", id: `K${survivor.knowledgeId}@${survivor.commit}`,
      ...(merge ? { absorb: [`K${f.item.knowledgeId}@${f.item.commit}`] } : {}),
      text: "Maintained by the other Dreamer", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "legal shared maintenance" }], skipped: [] })).toContain('"committed"');
    return success;
  }, { dreaming: { triggerTokens: 1 } }); memories.push(other);
  try { expect((await other.dream(f.otherPath)).outcome).toBe("success"); }
  finally { finished.release(); }
  const result = await pending;
  expect(result.outcome).toBe("success");
  expect(f.count()).toBe(0);
  expect(f.store.db.prepare("SELECT * FROM dreaming_completions").all()).toHaveLength(2);
  expect(f.store.isKnowledgeProcessed(f.item.commit)).toBe(false);
  expect(f.store.retryDreamingRange(f.target)).toBeNull();
});

test("a second connection consuming input before finalization yields successful exact settlement without a certificate", async () => {
  const f = fixture();
  let external = 0;
  f.setAgent(async () => {
    const transaction = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, "transaction").mockImplementationOnce(fn => {
      external = f.write().commit;
      return transaction(fn);
    });
    return success;
  });
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("success");
  expect(f.count()).toBe(0);
  expect(f.store.isKnowledgeProcessed(external)).toBe(false);
  expect(f.store.isKnowledgeProcessed(f.item.commit)).toBe(false);
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events").all().map(row => Number(row.event_id))).toEqual([f.item.commit]);
  if (!("runId" in result)) throw Error("missing run");
  expect(JSON.parse(f.store.getRun(result.runId)!.response!).check.resultIds).toEqual([]);
});

test("narrow reference conflict survives close/reopen and replay; the next real failure disables", async () => {
  const f = fixture();
  const created = f.other.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
    operations: [{ op: "create", handle: "$processed-streak", author: "external", ...f.content, text: "processed reference" }] });
  if (!created.ok) throw Error(created.problems.join());
  const processed = created.committed[0]!;
  const certified = f.other.store.recordRun({ kind: "dreaming", sessionId: f.otherPath.sessionId, outcome: "success", createdAt: "now" });
  f.other.store.completeDreaming(certified.id, [processed.commit], [processed.commit]);

  f.setAgent(async () => ({ ...success, outcome: "failure", output: "real error" }));
  await f.memory.dream(f.target); await f.memory.dream(f.target);
  const before = f.store.taskFailures(f.target.sessionId);
  const frozen = new Barrier(), changed = new Barrier();
  f.setAgent(async () => { frozen.release(); await changed.wait; return success; });
  const pending = f.memory.dream(f.target);
  await frozen.wait;
  const updated = f.other.store.commitConsolidationRun({ path: f.otherPath,
    run: { kind: "manual", sessionId: f.otherPath.sessionId, createdAt: "now" },
    operations: [{ op: "update", knowledgeId: processed.knowledgeId, baseCommit: processed.commit, ...f.content, text: "new reference" }] });
  if (!updated.ok) throw Error(updated.problems.join());
  changed.release();
  const result = await pending;
  expect(result.outcome).toBe("conflict");
  if (!("runId" in result)) throw Error("missing run");
  expect(f.store.taskFailures(f.target.sessionId)).toEqual(before);
  const execution = String(f.store.db.prepare("SELECT execution_id FROM execution_runs WHERE run_id = ?").get(result.runId)!.execution_id);
  f.memory.close();
  const source = new URL("../../../src/core/api/index.ts", import.meta.url).href;
  execFileSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    const { TraceMemory } = await import(${JSON.stringify(source)});
    const m = TraceMemory(${JSON.stringify(f.db)}, async () => { throw Error('No provider during reopen'); });
    try {
      for (const outcome of ['failure', 'cancelled', 'conflict'])
        assert.deepEqual(m.settleExecution(${JSON.stringify(execution)}, outcome, ${result.runId}), {});
      assert.equal(m.store.getRun(${result.runId}).outcome, 'conflict');
      assert.deepEqual(m.store.taskFailures(${f.target.sessionId}), ${JSON.stringify(before)});
      assert.equal(m.store.db.prepare('SELECT outcome FROM task_executions WHERE id = ?').get(${JSON.stringify(execution)}).outcome, 'conflict');
    } finally { m.close(); }
  `], { timeout: 5000, stdio: "pipe" });
  const next = TraceMemory(f.db, async () => ({ ...success, outcome: "failure", output: "third real error" })); memories.push(next);
  expect(next.settleExecution(execution, "failure", result.runId)).toEqual({});
  expect(next.store.taskFailures(f.target.sessionId)).toEqual(before);
  expect((await next.dream(f.target)).automaticOff).toContain("off after three failures");
  expect(next.store.taskFailures(f.target.sessionId).some(row => row.count === 3)).toBe(true);
});

test("external writer after the final check cannot enter its write transaction", async () => {
  const f = fixture();
  f.other.store.db.exec("PRAGMA busy_timeout = 0");
  const original = f.store.completeDreaming.bind(f.store);
  vi.spyOn(f.store, "completeDreaming").mockImplementation((...args) => {
    expect(f.store.db.isTransaction).toBe(true);
    expect(() => f.write()).toThrow(/locked/);
    return original(...args);
  });
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  const next = f.write();
  expect(f.store.isKnowledgeProcessed(next.commit)).toBe(false);
  expect(f.store.pendingKnowledgeEvents(f.target).map(e => e.id)).toEqual([next.commit]);
});
