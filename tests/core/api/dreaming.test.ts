import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tokens } from "../../../src/core/render/index.ts";
import { freezeDreaming } from "../../../src/core/dreaming/index.ts";
import { processedBlock } from "../../../src/core/store/processing.ts";
import { TraceMemory, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";

const memories: ReturnType<typeof TraceMemory>[] = [], directories: string[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(agent: (task: DreamingAgentInput) => Promise<RunAgentResult>, body = "durable rule", db = ":memory:", scope: "global" | "project" = "project") {
  const memory = TraceMemory(db, task => {
    const guidance = (task as DreamingAgentInput).tools.find(t => t.name === "trace")!.description;
    expect(guidance).toContain("trace({address:'K12@57',itemBudget:null})");
    expect(guidance).toContain("pageBudget still applies");
    expect(guidance).toContain("Follow every cursor");
    expect(guidance).toContain("already supplied internally need no reread");
    return agent(task as DreamingAgentInput);
  }, { dreaming: { triggerTokens: 1 } }); memories.push(memory);
  const store = memory.store;
  const p = store.createProject({ name: "P", declaredBy: "mark" });
  const s = store.createSession({ host: "test", enrollmentChoice: true, projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const f = store.commitNotingRun({ run: { kind: "manual", sessionId: s.id, createdAt: "now" }, facts: [{ turnId: t.id, category: "decision", actor: "user", text: body, source: [`T${t.id}#user`], createdAt: "now" }] });
  if (!f.ok) throw Error(f.problems.join());
  const content = { text: body, category: "constraint" as const, scope, supports: [f.facts[0]!.id], topics: [], reason: "fact", createdAt: "now" };
  const c = store.commitConsolidationRun({ run: { kind: "manual", sessionId: s.id, createdAt: "now" }, operations: [{ op: "create", handle: "$1", author: "test", ...content }] });
  if (!c.ok) throw Error(c.problems.join());
  const item = c.committed[0]!;
  return { memory, store, content, item, target: { sessionId: s.id, branch: "main", headTurnId: t.id } };
}
const success = { outcome: "success", output: "done", request: { exact: "request" } } as const;

test("32d: no-change completion runs the host check without a check tool call", async () => {
  const f = fixture(async task => { expect(task.tools.map(t => t.name)).toEqual(["trace", "search", "check", "memory"]); return success; });
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.pendingKnowledgeEvents(f.target)).toEqual([]);
  expect(f.store.isKnowledgeProcessed(f.item.commit)).toBe(true);
  const run = f.store.listRuns(f.target.sessionId).find(r => r.kind === "dreaming")!;
  const checked = JSON.parse(run.response!).check;
  const before = f.store.taskFailures(f.target.sessionId);
  f.store.completeDreaming(run.id, checked.eventIds, checked.resultIds, () => { throw Error("replay must not revalidate or resettle"); });
  expect(f.store.taskFailures(f.target.sessionId)).toEqual(before);
});

test.each(["success", "failure"] as const)("32d: immediate archive plus an unresolved bad batch stays unprocessed after provider %s", async outcome => {
  const f = fixture(async task => {
    const memory = task.tools.find(t => t.name === "memory")!;
    expect(memory.execute({ operations: [{ op: "archive", id: `K${f.item.knowledgeId}@${f.item.commit}`, supports: [], reason: "Retire for active budget, keep history" }], skipped: [] })).toContain('"committed"');
    expect(f.store.listCurrentKnowledge(f.target)).toEqual([]);
    expect(memory.execute({ operations: [{ op: "create", text: "invented", category: "constraint", scope: "project", topics: [], supports: [], reason: "fake" }], skipped: [] })).toContain("rejected:");
    return { ...success, outcome, output: outcome === "failure" ? "provider failed" : "done despite rejected batch" };
  });
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("failure");
  expect(f.store.listCurrentKnowledge(f.target)).toEqual([]);
  expect(f.store.dreamingInput(f.target).oldestId).toBe(f.item.commit);
  expect(f.store.isKnowledgeProcessed(f.store.listKnowledgeRevisions().at(-1)!.id)).toBe(false);
});

test("32d: scope overflow permits one concrete repair but an unreduced remainder still fails", async () => {
  const f = fixture(async task => {
    expect(task.passEnd(2)).toMatch(/One repair.*48 tool rounds/);
    expect(task.passEnd(2)).toBeUndefined();
    task.tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "archive", id: `K${f.item.knowledgeId}@${f.item.commit}`, supports: [], reason: "Budget tradeoff: retire lower priority rule" }], skipped: [] });
    return success;
  }, "large ".repeat(12000));
  // The changed input window is hard too; use a legacy processed oversized pool outside this task.
  const created = f.store.knowledgeRevision(f.item.commit)!;
  f.store.db.prepare("UPDATE knowledge_revisions SET text = ? WHERE id = ?").run("small rule", created.id);
  const other = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", ...f.content, text: "large ".repeat(8000) }] });
  if (!other.ok) throw Error(other.problems.join());
  // Legacy pool setup bypasses certification only in this test; no production code may do so.
  const runId = f.store.recordRun({ kind: "dreaming", sessionId: f.target.sessionId, createdAt: "now", outcome: "success" }).id;
  f.store.db.prepare("INSERT INTO dreaming_completions VALUES (?, '[]', '[]')").run(runId);
  f.store.db.prepare("INSERT INTO processed_knowledge_versions VALUES (?, ?)").run(other.committed[0]!.commit, runId);
  expect((await f.memory.dream(f.target)).outcome).toBe("failure"); // excluded remainder cannot be silently trimmed
});

test("34b: successive consumed inputs settle independently; a later unchanged leaf is certified", async () => {
  let reread = false;
  const f = fixture(async task => {
    if (reread && f.store.listKnowledgeRevisions().length === 3) return success;
    const current = f.store.currentCommit(f.item.knowledgeId, f.target)[0]!;
    const updated = f.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "update", knowledgeId: f.item.knowledgeId, baseCommit: current.id, ...f.content, text: "external successor" }] });
    expect(updated.ok).toBe(true);
    if (reread) task.tools.find(t => t.name === "trace")!.execute({ address: `K${f.item.knowledgeId}` });
    return success;
  });
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  reread = true;
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.listKnowledgeRevisions().every(revision => !f.store.isKnowledgeProcessed(revision.id))).toBe(true);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.isKnowledgeProcessed(3)).toBe(true);
  expect(f.store.isKnowledgeProcessed(f.item.commit)).toBe(false);
  expect(f.store.pendingKnowledgeEvents(f.target)).toEqual([])
});

test("32d: cancellation fences late calls, preserves prior batches and retains the anchor", async () => {
  const cancelled = new AbortController();
  const f = fixture(async task => {
    const memory = task.tools.find(t => t.name === "memory")!;
    const output = memory.execute({ operations: [{ op: "update", id: `K${f.item.knowledgeId}@${f.item.commit}`, ...f.content, supports: f.content.supports.map(id => `F${id}`), createdAt: undefined }], skipped: [] });
    expect(output).toContain("rejected:"); // model fields are strict, including undefined extra fields
    cancelled.abort();
    expect(memory.execute({ operations: [], skipped: [] })).toContain("finished");
    return { ...success, outcome: "cancelled" };
  });
  expect((await f.memory.dream({ ...f.target, signal: cancelled.signal })).outcome).toBe("cancelled");
  expect(f.store.retryDreamingRange(f.target)?.anchor).toBe(f.item.commit);
});

test("32: completion is transactional and hard-capped; edits committed by a failed pass stay unprocessed", async () => {
  let first = true;
  const f = fixture(async task => {
    const memory = task.tools.find(t => t.name === "memory")!;
    const current = f.store.currentCommit(f.item.knowledgeId, f.target)[0]!;
    const operations = first ? [{ op: "update", id: `K${f.item.knowledgeId}@${current.id}`, text: "budget ".repeat(11000), category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "retained long body" }]
      : [{ op: "archive", id: `K${f.item.knowledgeId}@${current.id}`, supports: [], reason: "Deliberately retire lower-priority active content for the hard cap" }];
    expect(memory.execute({ operations, skipped: [] })).toContain('"committed"');
    first = false;
    return success;
  });
  expect((await f.memory.dream(f.target)).outcome).toBe("failure");
  const changed = f.store.currentCommit(f.item.knowledgeId, f.target)[0]!;
  expect(f.store.isKnowledgeProcessed(changed.id)).toBe(false);
  expect(f.store.retryDreamingRange(f.target)?.anchor).toBe(f.item.commit);
  // One indivisible oversized own result is never clipped or certified without being supplied.
  await expect(f.memory.dream(f.target)).rejects.toThrow(/retained task output .* exceeds 10000/);
});

test("32d: full reads outside the family cannot expand writes; split and merge stay atomic", async () => {
  const f = fixture(async task => {
    const outside = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$outside", author: "manual", ...f.content, text: "outside" }] });
    if (!outside.ok) throw Error(outside.problems.join());
    const external = outside.committed[0]!;
    const trace = task.tools.find(t => t.name === "trace")!, memory = task.tools.find(t => t.name === "memory")!;
    trace.execute({ address: `K${external.knowledgeId}` });
    expect(memory.execute({ operations: [{ op: "archive", id: `K${external.knowledgeId}@${external.commit}`, supports: [], reason: "outside" }], skipped: [] })).toContain("read-only");
    const content = { text: "split claim", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Separate claims without adding facts" };
    const split = JSON.parse(memory.execute({ operations: [{ op: "split", id: `K${f.item.knowledgeId}@${f.item.commit}`, supports: content.supports, reason: content.reason,
      children: [{ text: "first split claim", category: "constraint", topics: [] }, { text: "second split claim", category: "constraint", topics: [] }] }], skipped: [] })).committed;
    expect(split).toHaveLength(2);
    for (const item of split) trace.execute({ address: `K${item.knowledgeId}` });
    const merged = JSON.parse(memory.execute({ operations: [{ op: "merge", id: `K${split[1].knowledgeId}@${split[1].commit}`, absorb: [`K${split[0].knowledgeId}@${split[0].commit}`], ...content }], skipped: [] })).committed;
    expect(merged).toHaveLength(1);
    expect(f.store.listKnowledgeLinks(split[0].knowledgeId)[0]).toMatchObject({ kind: "merged_into", toCommit: merged[0].commit });
    expect(f.store.listKnowledgeRevisions(split[0].knowledgeId)).toHaveLength(1);
    expect(f.store.currentCommit(external.knowledgeId, f.target)[0]!.id).toBe(external.commit);
    return success;
  });
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.listFactsByRun(f.store.listRuns(f.target.sessionId).at(-1)!.id)).toEqual([]);
});

test("32d: shared scope completion through two connections cannot certify a combined 6k global pool", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-scope-race-")); directories.push(dir);
  const db = join(dir, "memory.sqlite");
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondHeld = new Promise<void>(resolve => { releaseSecond = resolve; });
  const first = fixture(async () => { await firstHeld; return success; }, "global ".repeat(3000), db, "global");
  const firstTask = first.memory.dream(first.target);
  const other = TraceMemory(db, async () => { await secondHeld; return success; }, { dreaming: { triggerTokens: 1 } }); memories.push(other);
  const session = other.store.createSession({ host: "test", enrollmentChoice: true, projectId: first.store.getSession(first.target.sessionId)!.projectId, startedAt: "now", firstReplyAt: "now" });
  const turn = other.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "other", startedAt: "now" });
  const added = other.store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", ...first.content }] });
  if (!added.ok) throw Error(added.problems.join());
  const secondTask = other.dream({ sessionId: session.id, branch: "main", headTurnId: turn.id });
  expect(await other.dream(first.target)).toMatchObject({ outcome: "dropped" });
  releaseFirst(); expect((await firstTask).outcome).toBe("success");
  releaseSecond(); expect((await secondTask).outcome).toBe("failure");
  expect(first.store.isKnowledgeProcessed(first.item.commit)).toBe(true);
  expect(first.store.isKnowledgeProcessed(added.committed[0]!.commit)).toBe(false);
  expect(first.store.checkProcessedScopes().problems).toEqual([]);
});

test("32d: changing the selected source path cannot make missing results a successful empty completion", async () => {
  const f = fixture(async () => {
    f.store.selectSourcePath(f.target.sessionId, f.target.branch, []);
    return success;
  });
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("failure");
  expect("problems" in result && result.problems.join()).toContain("frozen path");
  expect(f.store.isKnowledgeProcessed(f.item.commit)).toBe(false);
  expect(f.store.db.prepare("SELECT * FROM settled_knowledge_events").all()).toEqual([]);
});

test("34b: a successor arriving before the final transaction consumes the input without being certified", async () => {
  const f = fixture(async () => {
    const transaction = f.store.transaction.bind(f.store);
    vi.spyOn(f.store, "transaction").mockImplementationOnce(fn => {
      const moved = f.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "update", knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit, ...f.content, text: "external after check" }] });
      expect(moved.ok).toBe(true);
      return transaction(fn);
    });
    return success;
  });
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe("success");
  expect(f.store.listKnowledgeRevisions().every(r => !f.store.isKnowledgeProcessed(r.id))).toBe(true);
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events").all().map(row => Number(row.event_id))).toEqual([f.item.commit]);
  expect(f.store.pendingKnowledgeEvents(f.target).map(e => e.id)).toEqual([2]);
});

test("32d: direct facts are deduplicated whole bodies within 10k, with honest omitted-fact receipts", async () => {
  const f = fixture(async task => {
    expect(tokens(task.material.processed)).toBeLessThanOrEqual(20000);
    expect(tokens(task.material.changed)).toBeLessThanOrEqual(10000);
    expect(tokens(task.material.facts)).toBeLessThanOrEqual(10000);
    expect(task.material.facts).toContain("first-direct-fact");
    expect(task.material.facts).toContain("source:");
    expect(task.material.facts).toContain("Omitted whole direct facts beyond 10000: F3");
    expect(task.material.facts).not.toContain("second-direct-fact");
    expect(task.material.changed.match(/\[K1@2\]/g)).toHaveLength(1);
    return success;
  });
  const facts = f.store.commitNotingRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, facts: ["first-direct-fact", "second-direct-fact"].map(label => ({ turnId: f.target.headTurnId, category: "decision" as const, actor: "user" as const, text: `${label} ${"evidence ".repeat(8000)}`, source: [`T${f.target.headTurnId}#user`], createdAt: "now" })) });
  if (!facts.ok) throw Error(facts.problems.join());
  expect(f.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "update", knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit, ...f.content, supports: facts.facts.map(f => f.id) }] }).ok).toBe(true);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
});

test("32d: a legacy over-10k processed project passes only after valid maintenance retirement reduces it", async () => {
  let retire = 0;
  const f = fixture(async task => {
    expect(task.passEnd(0)).toContain("exceeds 10000");
    const item = f.store.currentCommit(retire, f.target)[0]!;
    const result = task.tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "archive", id: `K${retire}@${item.id}`, supports: [], reason: "Hard-budget tradeoff: retire a lower-priority active rule while retaining history" }], skipped: [] });
    expect(result).toContain('"committed"');
    expect(task.passEnd(1)).toBeUndefined();
    return success;
  }, "legacy ".repeat(6000));
  const other = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$2", author: "test", ...f.content }] });
  if (!other.ok) throw Error(other.problems.join());
  retire = other.committed[0]!.knowledgeId;
  // Only the synthetic legacy fixture bypasses today's certification caps.
  const legacyRun = f.store.recordRun({ kind: "dreaming", sessionId: f.target.sessionId, createdAt: "now", outcome: "success" }).id;
  f.store.db.prepare("INSERT INTO dreaming_completions VALUES (?, '[]', '[]')").run(legacyRun);
  for (const id of [f.item.commit, other.committed[0]!.commit]) {
    f.store.db.prepare("INSERT INTO processed_knowledge_versions VALUES (?, ?)").run(id, legacyRun);
    f.store.db.prepare("INSERT INTO settled_knowledge_events VALUES (?, ?)").run(id, legacyRun);
  }
  expect(f.store.checkProcessedScopes().problems.join()).toContain("exceeds 10000");
  const pending = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$3", author: "test", ...f.content, text: "New durable constraint" }] });
  expect(pending.ok).toBe(true);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.checkProcessedScopes().problems).toEqual([]);
});


test.each([false, true])("32d: processed input uses relevance only when oversized (%s), stable ties and whole-item framing", oversized => {
  const f = fixture(async () => success, "transaction exact authorization");
  const legacyRun = f.store.recordRun({ kind: "dreaming", sessionId: f.target.sessionId, createdAt: "now", outcome: "success" }).id;
  f.store.db.prepare("INSERT INTO dreaming_completions VALUES (?, '[]', '[]')").run(legacyRun);
  const items: { knowledgeId: number; commit: number }[] = [];
  for (const [text, createdAt] of [["unrelated gardening flowers", "1900"], ["transaction exact authorization", "2000"], ["transaction exact authorization", "2000"], ["unrelated gardening flowers", "2030"]]) {
    const added = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$legacy", author: "test", ...f.content, text: (text! + " ").repeat(oversized ? 1500 : 1), category: text!.startsWith("transaction") ? "reference" : "constraint", createdAt: createdAt! }] });
    if (!added.ok) throw Error(added.problems.join());
    const item = added.committed[0]!; items.push(item);
    f.store.db.prepare("INSERT INTO processed_knowledge_versions VALUES (?, ?)").run(item.commit, legacyRun);
    f.store.db.prepare("INSERT INTO settled_knowledge_events VALUES (?, ?)").run(item.commit, legacyRun);
  }
  const all = f.store.listCurrentKnowledge(f.target).filter(v => f.store.isKnowledgeProcessed(v.revision.id));
  const full = `Processed knowledge:\n${processedBlock(all)}`;
  const frozen = freezeDreaming(f.store, f.target, f.memory.config);
  expect(tokens(frozen.material.processed)).toBeLessThanOrEqual(20000);
  expect(tokens(frozen.material.changed)).toBeLessThanOrEqual(10000);
  expect(tokens(frozen.material.facts)).toBeLessThanOrEqual(10000);
  if (!oversized) expect(frozen.material.processed).toBe(full);
  else {
    expect(tokens(full)).toBeGreaterThan(20000);
    expect(frozen.material.processed).toContain(`[K${items[1]!.knowledgeId}@${items[1]!.commit}]`);
    expect(frozen.material.processed).not.toContain(`[K${items[0]!.knowledgeId}@${items[0]!.commit}]`);
    const second = frozen.material.processed.indexOf(`[K${items[2]!.knowledgeId}@${items[2]!.commit}]`);
    expect(second).toBeGreaterThan(frozen.material.processed.indexOf(`[K${items[1]!.knowledgeId}@${items[1]!.commit}]`));
    expect(frozen.material.processed).not.toContain(`[K${items[3]!.knowledgeId}@${items[3]!.commit}]`);
    expect(frozen.material.processed).toContain("omitted");
    expect(frozen.range.knowledgeIds).not.toContain(items[0]!.knowledgeId);
  }
});


test("32d: own split/update/merge/archive outputs survive failure and reopen under the original range", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dreamer-own-results-")); directories.push(dir);
  const db = join(dir, "memory.sqlite");
  let own: { knowledgeId: number; commit: number }[] = [];
  const f = fixture(async task => {
    const memory = task.tools.find(t => t.name === "memory")!, trace = task.tools.find(t => t.name === "trace")!;
    const content = { text: "separate exact claim", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Retain conditions" };
    const split = JSON.parse(memory.execute({ operations: [{ op: "split", id: `K${f.item.knowledgeId}@${f.item.commit}`, supports: content.supports, reason: content.reason,
      children: [{ text: "first exact claim", category: "constraint", topics: [] }, { text: "second exact claim", category: "constraint", topics: [] }] }], skipped: [] })).committed;
    expect(split).toHaveLength(2); own.push(...split);
    for (const item of split) trace.execute({ address: `K${item.knowledgeId}` });
    const updated = JSON.parse(memory.execute({ operations: [{ op: "update", id: `K${split[0].knowledgeId}@${split[0].commit}`, ...content, text: "refined exact claim" }], skipped: [] })).committed;
    expect(updated).toHaveLength(1); own.push(...updated);
    expect(f.store.dreamingOwnCommits(f.store.retryDreamingRange(f.target)!.id)).toEqual(own.map(v => v.commit));
    return { ...success, outcome: "failure", output: "provider fails after retained writes" };
  }, "durable rule", db);
  expect((await f.memory.dream(f.target)).outcome).toBe("failure");
  const retained = f.store.retryDreamingRange(f.target)!;
  expect(retained).toMatchObject({ anchor: f.item.commit, eventIds: [f.item.commit], headTurnId: f.target.headTurnId });
  expect(own.every(v => !f.store.isKnowledgeProcessed(v.commit))).toBe(true);
  f.memory.close();
  const next = TraceMemory(db, async raw => {
    const task = raw as DreamingAgentInput;
    expect(next.store.retryDreamingRange(f.target)).toEqual(retained);
    const current = next.store.commitGraph(f.target).current;
    const survivor = current[0]!, child = current[1]!;
    const memory = task.tools.find(t => t.name === "memory")!;
    const merged = JSON.parse(memory.execute({ operations: [{ op: "merge", id: `K${survivor.knowledgeId}@${survivor.id}`, absorb: [`K${child.knowledgeId}@${child.id}`], text: "combined exact claims", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Preserve both claims" }], skipped: [] })).committed;
    expect(merged).toHaveLength(1); own.push(...merged);
    task.tools.find(t => t.name === "trace")!.execute({ address: `K${survivor.knowledgeId}` });
    const archived = JSON.parse(memory.execute({ operations: [{ op: "archive", id: `K${survivor.knowledgeId}@${merged[0].commit}`, supports: [], reason: "Deliberate retirement with retained history" }], skipped: [] })).committed;
    expect(archived).toHaveLength(1); own.push(...archived);
    const checked = JSON.parse(task.tools.find(t => t.name === "check")!.execute({}));
    expect(checked.problems).toEqual([]);
    expect(checked.resultIds).toEqual([archived[0].commit]);
    return success;
  }, { dreaming: { triggerTokens: 1 } }); memories.push(next);
  expect((await next.dream(f.target)).outcome).toBe("success");
  expect(next.store.isKnowledgeProcessed(own.at(-1)!.commit)).toBe(true);
  expect(own.slice(0, -1).every(v => !next.store.isKnowledgeProcessed(v.commit))).toBe(true);
  expect(next.store.pendingKnowledgeEvents(f.target)).toEqual([]);
  expect(next.store.retryDreamingRange(f.target)).toBeNull();
});

test("32d: a fully read external merge outside family cannot hide the selected result into empty success", async () => {
  const f = fixture(async task => {
    const external = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "create", handle: "$outside", author: "manual", ...f.content }] });
    if (!external.ok) throw Error(external.problems.join());
    const item = external.committed[0]!;
    const merged = f.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "merge", intoKnowledgeId: item.knowledgeId, intoBaseCommit: item.commit, absorb: [{ knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit }], ...f.content }] });
    expect(merged.ok).toBe(true);
    task.tools.find(t => t.name === "trace")!.execute({ address: `K${item.knowledgeId}` });
    const checked = JSON.parse(task.tools.find(t => t.name === "check")!.execute({}));
    expect(checked.resultIds).toEqual([]);
    expect(checked.problems).toEqual([]);
    expect(checked.family).not.toContain(item.knowledgeId);
    return success;
  });
  const completed = await f.memory.dream(f.target);
  expect(completed.outcome).toBe("success");
  expect(f.store.listKnowledgeRevisions().every(r => !f.store.isKnowledgeProcessed(r.id))).toBe(true);
  expect(f.store.db.prepare("SELECT event_id FROM settled_knowledge_events").all().map(row => Number(row.event_id))).toEqual([f.item.commit]);
  expect(f.store.pendingKnowledgeEvents(f.target)).toHaveLength(2);
});

test("32d: rereading a later external version permits a deliberate own update, not certifying the external base", async () => {
  let external = 0, own = 0;
  const f = fixture(async task => {
    const moved = f.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: [{ op: "update", knowledgeId: f.item.knowledgeId, baseCommit: f.item.commit, ...f.content, text: "external wording" }] });
    if (!moved.ok) throw Error(moved.problems.join());
    external = moved.committed[0]!.commit;
    task.tools.find(t => t.name === "trace")!.execute({ address: `K${f.item.knowledgeId}` });
    const result = JSON.parse(task.tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "update", id: `K${f.item.knowledgeId}@${external}`, text: "deliberately maintained rule", category: "constraint", scope: "project", supports: ["F1"], topics: [], reason: "Reconcile read external content against evidence" }], skipped: [] }));
    expect(result.committed).toHaveLength(1); own = result.committed[0].commit;
    return success;
  });
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(f.store.isKnowledgeProcessed(own)).toBe(true);
  expect(f.store.isKnowledgeProcessed(external)).toBe(false);
  expect(f.store.pendingKnowledgeEvents(f.target).map(e => e.id)).toEqual([external]);
});


test("32d: retained split outputs can finish unchanged on retry without losing either identity", async () => {
  let first = true;
  const f = fixture(async task => {
    if (!first) return success;
    first = false;
    const content = { supports: ["F1"], reason: "Separate claims" };
    expect(JSON.parse(task.tools.find(t => t.name === "memory")!.execute({ operations: [{ op: "split", id: `K${f.item.knowledgeId}@${f.item.commit}`, ...content,
      children: [{ text: "first separate claim", category: "constraint", topics: [] }, { text: "second separate claim", category: "constraint", topics: [] }] }], skipped: [] })).committed).toHaveLength(2);
    return { ...success, outcome: "failure" };
  });
  expect((await f.memory.dream(f.target)).outcome).toBe("failure");
  const retained = f.store.retryDreamingRange(f.target)!, current = f.store.commitGraph(f.target).current.map(r => r.id);
  expect(current).toHaveLength(2);
  expect((await f.memory.dream(f.target)).outcome).toBe("success");
  expect(current.every(id => f.store.isKnowledgeProcessed(id))).toBe(true);
  const completion = f.store.db.prepare("SELECT event_ids, result_ids FROM dreaming_completions").get()!;
  expect(JSON.parse(String(completion.event_ids))).toEqual(retained.eventIds);
  expect(JSON.parse(String(completion.result_ids))).toEqual(current);
});

test.each([10, 100])("32d: supplied family validation resolves one graph for %s identities", size => {
  const f = fixture(async () => success);
  const added = f.store.commitConsolidationRun({ run: { kind: "manual", sessionId: f.target.sessionId, createdAt: "now" }, operations: Array.from({ length: size - 1 }, (_, i) => ({ op: "create" as const, handle: `$${i}`, author: "test", ...f.content })) });
  if (!added.ok) throw Error(added.problems.join());
  const ids = [f.item.knowledgeId, ...added.committed.map(v => v.knowledgeId)];
  const graph = vi.spyOn(f.store, "commitGraph"), started = performance.now();
  const range = f.store.retainDreamingRange(f.target, [f.item.commit], ids);
  const ms = performance.now() - started;
  expect(range.knowledgeIds).toEqual(ids);
  expect(graph).toHaveBeenCalledTimes(1);
  console.log(`bounded family admission: identities=${size}, graphs=${graph.mock.calls.length}, ms=${ms.toFixed(2)}`);
});
