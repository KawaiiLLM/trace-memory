// Ticket 72 / 92: CC checks Dreaming only when armed; ports 69's per-entry rule
// to the CC scheduler. Mirrors 69's own Pi coverage (armed/disarmed per-entry counts, not-delayed
// completion checkpoints, cross-connection re-arming, cancellation fencing) against `CcTaskScheduler`.
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { TraceMemory, type DreamingAgentInput } from "../../src/core/api/index.ts";
import { skipRest, suppliedHandles } from "../dreaming-skips.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-72.db", stateDir: "/tmp/unused-72",
  notingModel: "synthetic", notingThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", claudeVersion: "2.1.280",
    contextWindows: { synthetic: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1, 2, 3], selectedCount: 3, selectedTailId: 3,
  selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [], snapshot: {} as any };

/** A mock memory whose Dreaming due-ness and progress signal are test-controlled, so
 * arming, disarming and the completion checkpoint can be driven deterministically without a real DB. */
function fixture() {
  let sig = "s0", dDue = false, enabled = true;
  const checks: string[] = [], starts: string[] = [], closedQueried: string[] = [];
  const releases = new Map<string, (outcome?: string) => void>();
  const memory = {
    executorId: "ours", config: { closedSessionScope: "project" }, cancelTasks: vi.fn(),
    store: {
      enabled: () => enabled,
      progressSignal: () => sig,
      closedTasks: (phase: string) => { closedQueried.push(phase); return []; },
      getClaim: () => null,
      getSourceEntry: (id: number) => ({ id, turnId: 1 }),
    },
    taskEligibility: vi.fn((phase: string) => {
      checks.push(phase);
      return { due: phase === "noting" ? true : dDue };
    }),
    noting: vi.fn(async () => new Promise(resolve => releases.set("noting", (outcome = "success") => { starts.push("noting"); resolve({ outcome, facts: [] }); }))),
    dream: vi.fn(async () => new Promise(resolve => releases.set("dreaming", (outcome = "success") => { starts.push("dreaming"); resolve({ outcome }); }))),
  };
  const scheduler = new CcTaskScheduler(memory as any, worker, () => {});
  // These scheduler fixtures vary the selected IDs and appended IDs independently. Recompute
  // their projection header exactly as the importer would, rather than carry a stale base header.
  const reconcile = scheduler.reconcile.bind(scheduler);
  scheduler.reconcile = (value, admit, epoch) => {
    const selected = new Set(value.selectedEntryIds);
    reconcile({ ...value, selectedCount: value.selectedEntryIds.length, selectedTailId: value.selectedEntryIds.at(-1) ?? null,
      selectedAppendedEntryIds: value.appendedEntryIds.filter(id => selected.has(id)) }, admit, epoch);
  };
  return { scheduler, memory, checks, starts, closedQueried, releases,
    setSignal: (value: string) => { sig = value; },
    setDDue: (value: boolean) => { dDue = value; }, setEnabled: (value: boolean) => { enabled = value; } };
}

afterEach(() => vi.restoreAllMocks());

/** `reserve()` invokes the phase function inside a `Promise.resolve().then(...)`, so the mock's
 * `releases` entry is not populated until a microtask has run. Waits for it, releases every named
 * phase together (so concurrently-admitted phases settle as one wave, matching how a real worker
 * would complete independently rather than serialize), then waits again for any completion checkpoint
 * `.finally()` triggers to run. */
async function settleAll(f: ReturnType<typeof fixture>, ...phases: string[]): Promise<void> {
  await tick();
  for (const phase of phases) f.releases.get(phase)!();
  await tick();
}

test("72: per appended entry with nothing armed evaluates Noting only", async () => {
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] }); // attach starts armed; not due disarms D
  await settleAll(f, "noting");
  expect(f.checks).toEqual(["noting", "dreaming"]);
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] }); // signal unchanged: nothing re-arms
  expect(f.checks).toEqual(["noting"]);
});

// N now publishes knowledge itself; the former N→C and C→D checkpoints are one N→D boundary.
test("72/92: successful N publication admits due D before any further entry", async () => {
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(1);
  expect(f.memory.dream).not.toHaveBeenCalled();
  f.checks.length = 0;
  f.setSignal("joint-n-commit"); f.setDDue(true);
  await settleAll(f, "noting");
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.checks).toEqual(["dreaming"]);
  await settleAll(f, "dreaming");
  expect(f.starts).toEqual(["noting", "dreaming"]);
});

test("80: failed N does not relay another connection's progress signal into a D checkpoint", async () => {
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(1);
  f.setSignal("external-commit"); f.setDDue(true);
  const before = [...f.checks];
  f.releases.get("noting")!("failure");
  await tick(); await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(1);
  expect(f.memory.dream).not.toHaveBeenCalled();
  expect(f.checks).toEqual(before);
});

test("86: failed D checks remaining pending work only at the next ordinary opportunity", async () => {
  const f = fixture();
  f.setDDue(true);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await settleAll(f, "noting");
  f.setSignal("dreaming-partial-commit");
  const before = [...f.checks];
  f.releases.get("dreaming")!("failure");
  await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.checks).toEqual(before);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(2);
});

test("72: attach, retarget and enabling memory re-check D at the next opportunity", async () => {
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] }); // attach: armed; not due disarms
  await settleAll(f, "noting");
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  expect(f.checks).toEqual(["noting"]); // still disarmed
  await settleAll(f, "noting");
  f.checks.length = 0;
  // A selected-path change (retarget) fences the epoch, so this same call's own admission is deferred;
  // the next opportunity (a following call) is where it actually re-checks D — matching how the
  // pre-existing catchup path-change fencing already behaves, and how Pi's own "restore" arming event
  // is proven at the next ingested entry rather than inside the restore call itself.
  f.scheduler.reconcile({ ...projection, branch: "other" });
  expect(f.checks).toEqual([]);
  f.scheduler.reconcile({ ...projection, branch: "other", appendedEntryIds: [3] });
  expect(f.checks).toEqual(["noting", "dreaming"]);
  await settleAll(f, "noting");
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, branch: "other", appendedEntryIds: [1] });
  expect(f.checks).toEqual(["noting"]); // disarmed again after not-due
  await settleAll(f, "noting");
  f.checks.length = 0;
  // Disable, then re-enable: re-checks D at the next opportunity.
  f.scheduler.reconcile({ ...projection, branch: "other", state: "disabled" as const });
  f.scheduler.reconcile({ ...projection, branch: "other", appendedEntryIds: [2] });
  expect(f.checks).toEqual(["noting", "dreaming"]);
});

test("72: a due-but-busy Dreamer is rechecked at the next entry after release", async () => {
  const f = fixture(); f.setDDue(true);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await tick(); expect(f.starts).toEqual([]);
  await settleAll(f, "noting");
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  expect(f.checks).toEqual(["noting"]);
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  await settleAll(f, "noting", "dreaming");
  expect(f.starts).toEqual(expect.arrayContaining(["noting", "dreaming"]));
  f.checks.length = 0; f.setDDue(false);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [3] });
  expect(f.checks).toEqual(["noting", "dreaming"]);
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
});

test("72: late completions respect cancellation — stop, off, a retarget and a cancelled outcome each suppress the checkpoint", async () => {
  // An ordinary N stays in flight; a changed signal cannot bypass its cancellation epoch.
  // Control's stop/off fence through stopCatchup; off also leaves memory disabled.
  for (const [cancel, outcome] of [
    [(f: ReturnType<typeof fixture>) => f.scheduler.stopCatchup(), "success"],
    [(f: ReturnType<typeof fixture>) => { f.scheduler.stopCatchup(); f.setEnabled(false); }, "success"],
    [(f: ReturnType<typeof fixture>) => f.scheduler.reconcile({ ...projection, branch: "elsewhere" }), "success"],
    [() => {}, "cancelled"],
  ] as const) {
    const f = fixture();
    f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
    await tick();
    expect(f.memory.noting).toHaveBeenCalledTimes(1);
    expect(f.starts).not.toContain("noting");
    cancel(f);
    f.setSignal("s1"); f.setDDue(true);
    f.releases.get("noting")!(outcome); await tick(); await tick();
    expect(f.starts).toContain("noting");
    expect(f.memory.dream).not.toHaveBeenCalled();
    expect(f.memory.noting).toHaveBeenCalledTimes(1);
  }
});

test("72: a branch switch that arrives with new entries keeps their ordinary opportunity", async () => {
  // Review 2026-09-23: the switch fences the old path's in-flight work, but its own newly ingested
  // entries on the new path still evaluate N, and D because the switch arms it.
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await settleAll(f, "noting");
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, branch: "side", selectedEntryIds: [1, 2, 3, 4], appendedEntryIds: [4] });
  expect(f.checks).toEqual(["noting", "dreaming"]);
  await tick(); // `reserve` calls the phase function a microtask later
  expect(f.memory.noting).toHaveBeenCalledTimes(2);
});

test("72: after retarget, the new path's legitimate N checkpoint admits D without a borrowed scan", async () => {
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await settleAll(f, "noting");
  f.scheduler.reconcile({ ...projection, branch: "new-branch" });
  f.scheduler.reconcile({ ...projection, branch: "new-branch", selectedEntryIds: [1, 2, 3, 4], appendedEntryIds: [4] });
  await tick();
  f.closedQueried.length = 0;
  f.setSignal("new-path-n-commit"); f.setDDue(true);
  await settleAll(f, "noting");
  await settleAll(f, "dreaming");
  expect(f.starts).toContain("dreaming");
  expect(f.closedQueried).toEqual([]);
});

test("85: CC scheduler does not launch Dreamer for an over-budget pool with below-trigger pending", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-85-cc-not-due-"));
  try {
    const memory = TraceMemory(join(dir, "trace.db"), async () => ({ outcome: "failure" as const, output: "unexpected worker" }));
    const store = memory.store;
    const project = store.createProject({ name: "A", declaredBy: "mark" });
    const session = store.createSession({ host: "cc", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
    const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "cc", nativeId: "u", role: "user", text: "rule", raw: "rule", calls: [] });
    memory.selectEntries(session.id, "main", [entry.id]);
    const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
      { turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#E1`], createdAt: "now" }] });
    if (!fact.ok) throw Error(fact.problems.join());
    const create = (text: string) => {
      const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" },
        operations: [{ op: "create", handle: "$rule", author: "test", text, category: "constraint", scope: "project",
          supports: [fact.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now" }] });
      if (!result.ok) throw Error(result.problems.join());
    };
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const pool = `project:${project.id}`;
    create("Long durable constraint ".repeat(120));
    const claim = store.acquireClaim(path, "dreaming", "fixture")!;
    const range = store.retainKnowledgePoolRange(path, pool, claim);
    const executionId = store.beginExecution({ sessionId: session.id, phase: "dreaming", pool: range.pool!, origin: range.origin });
    const run = store.bindDreamingRun({ kind: "dreaming", sessionId: session.id, branch: "main", dreamingRangeId: range.id, executionId, claim, createdAt: "now" });
    store.completeKnowledgePoolRange(run, "success", range.eventIds);
    store.releaseClaim(claim);
    const oldSize = store.poolSizes(path).find(value => value.pool === pool)!.tokens;
    create("Small new rule");
    store.setKnowledgeBudget("project", oldSize - 1);
    expect(store.pendingPoolWeight(pool, path)).toBeLessThan(oldSize - 1);
    expect(store.poolSizes(path).find(value => value.pool === pool)!.tokens).toBeGreaterThan(oldSize - 1);
    expect(memory.taskEligibility("dreaming", path).due).toBe(false);
    const dream = vi.spyOn(memory, "dream");
    const scheduler = new CcTaskScheduler(memory, worker, () => {});
    scheduler.reconcile({ state: "ready", coreSessionId: session.id, branch: "main", headTurnId: turn.id,
      selectedEntryIds: [entry.id], selectedCount: 1, selectedTailId: entry.id,
      selectedAppendedEntryIds: [entry.id], appendedEntryIds: [entry.id], problems: [], snapshot: {} as any });
    await tick();
    expect(dream).not.toHaveBeenCalled();
    scheduler.stop(); await scheduler.settle();
    memory.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("72: inertness — driving entry ingestion through a real Store leaves consolidationBatch and duePools unchanged", async () => {
  const time = "2026-09-23T00:00:00Z";
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-72-cc-inert-"));
  try {
    const memory = TraceMemory(join(dir, "trace.db"), async () => ({ outcome: "failure" as const, output: "unused" }));
    const store = memory.store;
    const project = store.createProject({ name: "A", declaredBy: "mark" });
    const sessionId = store.createSession({ host: "cc", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time }).id;
    const turnId = store.appendTurn({ sessionId, kind: "turn", userPrompt: "first", assistantText: "answer", startedAt: time }).id;
    const before = { consolidation: store.consolidationBatch(sessionId, "main", turnId), dreaming: store.duePools({ sessionId, branch: "main", headTurnId: turnId }) };
    const entries = [1, 2, 3].map(n => store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: `u${n}`,
      role: "toolResult", text: "", raw: `r${n}`, calls: [{ ordinal: 1, name: "tool", callId: `c${n}`, status: "ok" }] }));
    memory.selectEntries(sessionId, "main", entries.map(entry => entry.id));
    const after = { consolidation: store.consolidationBatch(sessionId, "main", turnId), dreaming: store.duePools({ sessionId, branch: "main", headTurnId: turnId }) };
    expect(after).toEqual(before);
    memory.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("72: a commit through a second Store connection re-arms D at the next appended entry", async () => {
  const time = "2026-09-23T00:00:00Z";
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-72-cc-cross-conn-"));
  try {
    const dbPath = join(dir, "trace.db");
    const memory = TraceMemory(dbPath, async () => ({ outcome: "failure" as const, output: "unused" }));
    const observer = TraceMemory(dbPath, async () => ({ outcome: "failure" as const, output: "unused" }));
    const store = memory.store;
    const project = store.createProject({ name: "A", declaredBy: "mark" });
    const sessionId = store.createSession({ host: "cc", enrollmentChoice: true, projectId: project.id, startedAt: time, firstReplyAt: time }).id;
    const turnId = store.appendTurn({ sessionId, kind: "turn", userPrompt: "first", assistantText: "answer", startedAt: time }).id;
    const entry = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u1", role: "user", text: "hi", raw: "hi", calls: [] });
    memory.selectEntries(sessionId, "main", [entry.id]);
    const config = worker;
    const checks: string[] = [];
    const eligibility = vi.spyOn(memory, "taskEligibility");
    const scheduler = new CcTaskScheduler(memory, config, () => {});
    scheduler.reconcile({ state: "ready", coreSessionId: sessionId, branch: "main", headTurnId: turnId,
      selectedEntryIds: [entry.id], selectedCount: 1, selectedTailId: entry.id,
      selectedAppendedEntryIds: [entry.id], appendedEntryIds: [entry.id], problems: [], snapshot: {} as any });
    await tick();
    eligibility.mockClear();
    // A commit through a second connection to the same database file — this session's own next
    // opportunity has not otherwise changed.
    const noted = observer.store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time },
      facts: [{ turnId, entryIds: [entry.id], category: "observation", actor: "user", text: "seen via a second connection", source: [`T${turnId}#E1`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const entry2 = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "n", nativeId: "u2", role: "toolResult", text: "", raw: "r2",
      calls: [{ ordinal: 1, name: "tool", callId: "c1", status: "ok" }] });
    memory.selectEntries(sessionId, "main", [entry.id, entry2.id]);
    scheduler.reconcile({ state: "ready", coreSessionId: sessionId, branch: "main", headTurnId: turnId,
      selectedEntryIds: [entry.id, entry2.id], selectedCount: 2, selectedTailId: entry2.id,
      selectedAppendedEntryIds: [entry2.id], appendedEntryIds: [entry2.id], problems: [], snapshot: {} as any });
    for (const [phase] of eligibility.mock.calls) checks.push(phase as string);
    expect(checks).toContain("dreaming"); // the second connection's commit re-armed it
    expect(checks).not.toContain("consolidation");
    scheduler.stop(); await scheduler.settle();
    memory.close(); observer.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("104: successful Dreamer runs follow back to back while the session overflows, and stop once neither condition holds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "trace-memory-104-cc-continuous-"));
  try {
    const selected: string[] = [];
    let store!: ReturnType<typeof TraceMemory>["store"];
    const large = new Map<string, number>();
    const memory = TraceMemory(join(dir, "trace.db"), async raw => {
      const input = raw as DreamingAgentInput;
      const pool = /frozen pool: (\S+)/.exec(String(input.tools.find(tool => tool.name === "check")!.execute({})))![1]!;
      selected.push(pool);
      // Each run retires its pool's large processed item and deliberates its small pending one.
      const id = large.get(pool)!;
      expect(input.tools.find(tool => tool.name === "memory")!.execute({ operations: [{ op: "archive", kind: "budget",
        id: `K${id}#${store.versionTag(id, store.currentCommit(id)[0]!.id)}`, supports: [], reason: "Retired to fit the pool budget." }],
        skipped: [] })).toContain("committed");
      skipRest(input);
      return { outcome: "success", output: "pool fits", request: { fixture: "continuous" } };
    }, { noting: { triggerTokens: 1e9 }, dreaming: { triggerTokens: 1e9 } });
    store = memory.store;
    const project = store.createProject({ name: "A", declaredBy: "mark" });
    const session = store.createSession({ host: "cc", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
    const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "cc", nativeId: "u", role: "user", text: "rule", raw: "rule", calls: [] });
    memory.selectEntries(session.id, "main", [entry.id]);
    const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
      { turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#E1`], createdAt: "now" }] });
    if (!fact.ok) throw Error(fact.problems.join());
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const create = (scope: "global" | "project", words: number) => {
      const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" },
        operations: [{ op: "create", handle: "$rule", author: "test", text: `${scope} rule ${"word ".repeat(words)}`, category: "constraint",
          scope, supports: [fact.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now" }] });
      if (!result.ok) throw Error(result.problems.join());
      return result.committed[0]!;
    };
    const processed = (pool: string) => {
      const claim = store.acquireClaim(path, "dreaming", "fixture")!;
      const range = store.retainKnowledgePoolRange(path, pool, claim);
      const run = store.bindDreamingRun({ kind: "dreaming", sessionId: session.id, branch: "main", dreamingRangeId: range.id, claim, createdAt: "now",
        executionId: store.beginExecution({ sessionId: session.id, phase: "dreaming", pool, origin: range.origin }) });
      store.completeKnowledgePoolRange(run, "success", range.eventIds);
      store.releaseClaim(claim);
    };
    const projectPool = `project:${project.id}`;
    large.set("global", create("global", 3_000).knowledgeId); processed("global");
    large.set(projectPool, create("project", 4_000).knowledgeId); processed(projectPool);
    create("global", 10); create("project", 10);
    // Each pool fits only without its large item, and the session overflows its window.
    store.setKnowledgeBudget("global", 100);
    store.setKnowledgeBudget("project", 100);
    store.setKnowledgeBudget("session", 0);
    memory.config.compaction.sharedAllowanceTokens = 500;
    expect(memory.taskEligibility("dreaming", path).due).toBe(true);
    const fixtureRuns = store.listRuns(session.id).length;
    const diagnostics: string[] = [];
    const scheduler = new CcTaskScheduler(memory, worker, message => diagnostics.push(message));
    scheduler.reconcile({ state: "ready", coreSessionId: session.id, branch: "main", headTurnId: turn.id,
      selectedEntryIds: [entry.id], selectedCount: 1, selectedTailId: entry.id,
      selectedAppendedEntryIds: [entry.id], appendedEntryIds: [entry.id], problems: [], snapshot: {} as any });
    await vi.waitFor(async () => { await scheduler.settle(); expect(selected, diagnostics.join("\n")).toHaveLength(2); });
    await scheduler.settle();
    // The larger excess first, then the other pool, with no new entry between them; no third run
    // once the session neither overflows nor has pending weight at the trigger.
    expect(selected).toEqual([projectPool, "global"]);
    expect(store.listRuns(session.id).slice(fixtureRuns).map(run => [run.kind, run.outcome])).toEqual([["dreaming", "success"], ["dreaming", "success"]]);
    expect(memory.taskEligibility("dreaming", path).due).toBe(false);
    scheduler.stop(); await scheduler.settle();
    memory.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
