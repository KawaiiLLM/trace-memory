// Ticket 72 "CC executor checks Consolidation and Dreaming only when armed": ports 69's per-entry rule
// to the CC scheduler. Mirrors 69's own Pi coverage (armed/disarmed per-entry counts, not-delayed
// completion checkpoints, cross-connection re-arming, cancellation fencing) against `CcTaskScheduler`.
import { afterEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { TraceMemory } from "../../src/core/api/index.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-72.db", stateDir: "/tmp/unused-72",
  notingModel: "synthetic", notingThinking: "medium", consolidationModel: "synthetic", consolidationThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", claudeVersion: "2.1.280",
    contextWindows: { synthetic: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1, 2, 3], selectedCount: 3, selectedTailId: 3,
  selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [], snapshot: {} as any };

/** A mock memory whose Consolidation/Dreaming due-ness and progress signal are test-controlled, so
 * arming, disarming and the completion checkpoint can be driven deterministically without a real DB. */
function fixture() {
  let sig = "s0", cDue = false, dDue = false, enabled = true;
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
      return { due: phase === "noting" ? true : phase === "consolidation" ? cDue : dDue };
    }),
    noting: vi.fn(async () => new Promise(resolve => releases.set("noting", (outcome = "success") => { starts.push("noting"); resolve({ outcome, facts: [] }); }))),
    consolidate: vi.fn(async () => new Promise(resolve => releases.set("consolidation", (outcome = "success") => { starts.push("consolidation"); resolve({ outcome }); }))),
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
    setSignal: (value: string) => { sig = value; }, setCDue: (value: boolean) => { cDue = value; },
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
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] }); // attach starts armed; not due disarms C/D
  await settleAll(f, "noting");
  expect(f.checks).toEqual(["noting", "consolidation", "dreaming"]);
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] }); // signal unchanged: nothing re-arms
  expect(f.checks).toEqual(["noting"]);
});

test("72: a Noting completion that crosses Consolidation's trigger admits C at that completion, before any further entry", async () => {
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] }); // disarms C and D (not due)
  await settleAll(f, "noting");
  expect(f.starts).toEqual(["noting"]);
  f.checks.length = 0;
  // The committed run moves the signal and makes Consolidation due, simulating a fact commit — no new
  // appended entry follows.
  f.setSignal("s1"); f.setCDue(true);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  await settleAll(f, "noting", "consolidation"); // entry 2's Noting and its own checkpoint's Consolidation both settle
  expect(f.starts).toEqual(["noting", "noting", "consolidation"]);
});

test("72: a Consolidation completion that makes a pool due admits D likewise", async () => {
  const f = fixture();
  f.setCDue(true);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] }); // admits Noting and Consolidation together
  await settleAll(f, "noting"); // free Noting; keep Consolidation in flight so its own completion sees the signal move below
  f.setSignal("s1"); f.setDDue(true); // the signal moves before Consolidation's own completion is observed
  await settleAll(f, "consolidation"); // Consolidation's completion checkpoint sees the moved signal and admits Dreaming
  await settleAll(f, "dreaming");
  expect(f.starts).toEqual(["noting", "consolidation", "dreaming"]);
});

test("80: failed C does not relay another connection's empty-Noting signal into a retry", async () => {
  const f = fixture();
  f.setCDue(true);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await settleAll(f, "noting");
  expect(f.memory.consolidate).toHaveBeenCalledTimes(1);
  // An external empty note changes processing membership but creates no new C/D work.
  f.setSignal("empty-noting-committed");
  f.releases.get("consolidation")!("failure");
  await tick(); await tick();
  expect(f.memory.consolidate).toHaveBeenCalledTimes(1);
  expect(f.memory.dream).not.toHaveBeenCalled();
});

test("86: failed D keeps partial work but checks C/D only at the next ordinary opportunity", async () => {
  const f = fixture();
  f.setDDue(true);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await settleAll(f, "noting");
  f.setSignal("dreaming-partial-commit");
  f.setCDue(true); f.setDDue(false);
  f.releases.get("dreaming")!("failure");
  await tick(); await tick();
  expect(f.memory.consolidate).not.toHaveBeenCalled();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  await tick();
  expect(f.memory.consolidate).toHaveBeenCalledTimes(1);
});

test("72: attach, retarget and enabling memory re-check C and D at the next opportunity", async () => {
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] }); // attach: armed; not due disarms
  await settleAll(f, "noting");
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  expect(f.checks).toEqual(["noting"]); // still disarmed
  await settleAll(f, "noting");
  f.checks.length = 0;
  // A selected-path change (retarget) fences the epoch, so this same call's own admission is deferred;
  // the next opportunity (a following call) is where it actually re-checks C and D — matching how the
  // pre-existing catchup path-change fencing already behaves, and how Pi's own "restore" arming event
  // is proven at the next ingested entry rather than inside the restore call itself.
  f.scheduler.reconcile({ ...projection, branch: "other" });
  expect(f.checks).toEqual([]);
  f.scheduler.reconcile({ ...projection, branch: "other", appendedEntryIds: [3] });
  expect(f.checks).toEqual(["noting", "consolidation", "dreaming"]);
  await settleAll(f, "noting");
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, branch: "other", appendedEntryIds: [1] });
  expect(f.checks).toEqual(["noting"]); // disarmed again after not-due
  await settleAll(f, "noting");
  f.checks.length = 0;
  // Disable, then re-enable: re-checks C and D at the next opportunity.
  f.scheduler.reconcile({ ...projection, branch: "other", state: "disabled" as const });
  f.scheduler.reconcile({ ...projection, branch: "other", appendedEntryIds: [2] });
  expect(f.checks).toEqual(["noting", "consolidation", "dreaming"]);
});

test("72: a due-but-busy Consolidation is retried at the next entry", async () => {
  const f = fixture();
  f.setCDue(true);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] }); // starts noting and consolidation; C stays busy
  await tick();
  expect(f.starts).toEqual([]);
  await settleAll(f, "noting"); // free Noting's slot only; Consolidation stays in flight (busy)
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] }); // C's slot is busy: no eligibility call, still armed
  expect(f.checks).toEqual(["noting"]);
  await settleAll(f, "noting", "consolidation");
  expect(f.starts).toEqual(expect.arrayContaining(["noting", "consolidation"]));
  f.checks.length = 0;
  f.setCDue(false);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [3] }); // retried: due is re-evaluated (now false)
  expect(f.checks).toContain("consolidation");
});

test("72: late completions respect cancellation — stop, off, a retarget and a cancelled outcome each suppress the checkpoint", async () => {
  // Review 2026-09-23: the Consolidation stays in flight across the cancellation and completes only
  // after it, having committed partially (the signal moved). Control's stop and off both fence through
  // `stopCatchup` (its `beforeCancel`); off also leaves memory disabled.
  for (const [cancel, outcome] of [
    [(f: ReturnType<typeof fixture>) => f.scheduler.stopCatchup(), "success"],
    [(f: ReturnType<typeof fixture>) => { f.scheduler.stopCatchup(); f.setEnabled(false); }, "success"],
    [(f: ReturnType<typeof fixture>) => f.scheduler.reconcile({ ...projection, branch: "elsewhere" }), "success"],
    [() => {}, "cancelled"],
  ] as const) {
    const f = fixture();
    f.setCDue(true);
    f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
    await settleAll(f, "noting");
    expect(f.memory.consolidate).toHaveBeenCalledTimes(1);
    expect(f.starts).not.toContain("consolidation"); // still in flight
    cancel(f);
    f.setSignal("s1"); f.setDDue(true); // it committed partially before finishing
    f.releases.get("consolidation")!(outcome); await tick(); await tick();
    expect(f.starts).toContain("consolidation");
    expect(f.memory.dream).not.toHaveBeenCalled(); // the late completion must not launch D
    expect(f.memory.consolidate).toHaveBeenCalledTimes(1); // nor C again
  }
});

test("72: a branch switch that arrives with new entries keeps their ordinary opportunity", async () => {
  // Review 2026-09-23: the switch fences the old path's in-flight work, but its own newly ingested
  // entries on the new path still evaluate N, and C and D because the switch arms them.
  const f = fixture();
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await settleAll(f, "noting");
  f.checks.length = 0;
  f.scheduler.reconcile({ ...projection, branch: "side", selectedEntryIds: [1, 2, 3, 4], appendedEntryIds: [4] });
  expect(f.checks).toEqual(["noting", "consolidation", "dreaming"]);
  await tick(); // `reserve` calls the phase function a microtask later
  expect(f.memory.noting).toHaveBeenCalledTimes(2);
});

test("72: after a retarget, a later legitimate checkpoint evaluates the new path, and the checkpoint scans no borrowed candidates", async () => {
  const f = fixture();
  f.setCDue(true);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1] });
  await settleAll(f, "noting", "consolidation"); // settles before any signal change: no checkpoint fires yet
  f.scheduler.reconcile({ ...projection, branch: "new-branch" }); // retarget: fences the (already-settled) prior admission
  f.setCDue(true);
  f.closedQueried.length = 0;
  // A fresh, legitimate opportunity on the new path — entry 4 must also be a selected entry.
  f.scheduler.reconcile({ ...projection, branch: "new-branch", selectedEntryIds: [1, 2, 3, 4], appendedEntryIds: [4] });
  await settleAll(f, "noting"); // free Noting; keep this new Consolidation in flight
  f.setSignal("s1"); f.setDDue(true); // the signal moves before this Consolidation's own completion is observed
  await settleAll(f, "consolidation");
  await settleAll(f, "dreaming");
  expect(f.starts).toContain("dreaming"); // the new path's own checkpoint fires normally
  // The completion checkpoint's own admission (dreaming, here) never scans borrowed candidates —
  // Noting's and Consolidation's own ordinary per-entry admission above is the only source of
  // `closedTasks` queries.
  expect(f.closedQueried).not.toContain("dreaming");
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
    const executionId = store.beginExecution({ sessionId: session.id, phase: "dreaming", head: range.anchor, origin: range.origin });
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

test("72: a commit through a second Store connection re-arms C and D at the next appended entry", async () => {
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
    expect(checks).toContain("consolidation"); // the second connection's commit re-armed it
    scheduler.stop(); await scheduler.settle();
    memory.close(); observer.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
