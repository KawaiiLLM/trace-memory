import { expect, test, vi } from "vitest";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-67.db", stateDir: "/tmp/unused-67",
  notingModel: "synthetic", notingThinking: "medium", consolidationModel: "synthetic", consolidationThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", claudeVersion: "2.1.257", contextWindows: { synthetic: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1, 2], appendedEntryIds: [], problems: [], snapshot: {} as any };
function fixture() {
  let pending = [1, 2], enabled = true;
  const checks: string[] = [], starts: string[] = [];
  const memory = { executorId: "ours", config: { closedSessionScope: "project" },
    pendingEntries: () => pending.map(id => ({ id })), cancelTasks: vi.fn(),
    store: { enabled: () => enabled, consolidationBatch: () => [], getClaim: () => null, closedTasks: () => [],
      getSourceEntry: (id: number) => ({ id, turnId: 1 }) },
    taskEligibility: vi.fn((phase: string) => { checks.push(phase); return { due: true }; }),
    noting: vi.fn(async () => { starts.push("noting"); pending.shift(); return { outcome: "success", facts: [] }; }),
    consolidate: vi.fn(async () => { starts.push("consolidation"); return { outcome: "success" }; }),
    dream: vi.fn(async () => { starts.push("dreaming"); return { outcome: "success" }; }) };
  const scheduler = new CcTaskScheduler(memory as any, worker, () => {});
  return { scheduler, memory, checks, starts, disable: () => { enabled = false; },
    consume: (count: number) => { pending.splice(0, count); }, append: () => pending.push(3) };
}

test("bootstrap collapses new selected history only; known resumes and Hook-first do not trigger", async () => {
  const f = fixture();
  f.memory.taskEligibility.mockImplementation(() => ({ due: false }));
  f.scheduler.reconcile({ ...projection, bootstrap: true, appendedEntryIds: [] });
  f.scheduler.reconcile({ ...projection, bootstrap: true, appendedEntryIds: [99] });
  expect(f.memory.taskEligibility).not.toHaveBeenCalled();
  f.scheduler.reconcile({ ...projection, bootstrap: true, appendedEntryIds: [1] });
  expect(f.memory.taskEligibility).toHaveBeenCalledTimes(3);
  for (const [, target] of f.memory.taskEligibility.mock.calls as any)
    expect(target).toMatchObject({ triggerEntryId: 2, headTurnId: 1 });
  f.memory.taskEligibility.mockClear();
  f.scheduler.reconcile({ ...projection, bootstrap: false });
  expect(f.memory.taskEligibility).not.toHaveBeenCalled();
  f.scheduler.reconcile({ ...projection, bootstrap: false, appendedEntryIds: [1, 2] });
  expect(f.memory.taskEligibility).toHaveBeenCalledTimes(6);
  expect((f.memory.taskEligibility.mock.calls as any).map((call: any) => call[1].triggerEntryId)).toEqual([1, 1, 1, 2, 2, 2]);
});

test("known restart grants no automatic opportunity but explicit catchup still drains frozen Raw", async () => {
  const f = fixture();
  f.memory.taskEligibility.mockImplementation(() => ({ due: false }));
  f.scheduler.reconcile({ ...projection, bootstrap: true });
  await tick();
  expect(f.memory.taskEligibility).not.toHaveBeenCalled();
  expect(f.memory.noting).not.toHaveBeenCalled();
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 10 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(2);
  expect(f.memory.consolidate).not.toHaveBeenCalled();
});

test("last N retains its launched C completion check for D, without a D chain", async () => {
  const f = fixture();
  let release!: () => void;
  f.memory.taskEligibility.mockImplementation(phase => {
    f.checks.push(phase);
    return { due: phase === "dreaming" || f.memory.noting.mock.calls.length === 2 };
  });
  f.memory.consolidate.mockImplementation(async () => {
    f.starts.push("consolidation");
    await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "success" };
  });
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 10 && !release; i++) await tick();
  expect(f.starts).toEqual(["noting", "noting", "consolidation"]);
  expect(f.scheduler.catchupStatus().state).toBe("waiting");
  release();
  for (let i = 0; i < 10 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick();
  expect(f.checks).toEqual(["consolidation", "consolidation", "dreaming"]);
  expect(f.starts).toEqual(["noting", "noting", "consolidation", "dreaming"]);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
  await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
});

test("busy C discards an N completion opportunity and slot release does not replay it", async () => {
  const f = fixture();
  let release!: () => void;
  f.memory.consolidate.mockImplementation(async () => {
    f.starts.push("consolidation");
    await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "success" };
  });
  f.memory.taskEligibility.mockImplementation(phase => { f.checks.push(phase); return { due: phase !== "dreaming" }; });
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 10 && f.memory.noting.mock.calls.length < 2; i++) await tick();
  expect(f.starts).toEqual(["noting", "consolidation", "noting"]);
  expect(f.memory.consolidate).toHaveBeenCalledTimes(1);
  release(); await tick(); await tick();
  expect(f.memory.consolidate).toHaveBeenCalledTimes(1);
  expect(f.checks).toEqual(["consolidation", "dreaming"]);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
  // A later real entry is a new opportunity, not a replay of the busy one.
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  await tick();
  expect(f.memory.consolidate).toHaveBeenCalledTimes(2);
  release(); await tick();
});

// Retained ordinary-task ownership: catchup does not adopt a worker that predates it.
test.each([1, 2])("preexisting ordinary N consuming %s entries is not adopted by catchup", async consumed => {
  const f = fixture();
  let release!: () => void, finishedOrdinary = false;
  const normalNoting = f.memory.noting.getMockImplementation()!;
  f.memory.noting.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    f.consume(consumed); finishedOrdinary = true;
    return { outcome: "success", facts: [] };
  }).mockImplementation(normalNoting);
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "noting" || phase === "consolidation" && finishedOrdinary }));
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(1);
  expect(f.scheduler.startCatchup(projection).state).toBe("waiting");
  release();
  for (let i = 0; i < 10 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(consumed === 2 ? 1 : 2);
  expect(f.memory.consolidate).toHaveBeenCalledTimes(consumed === 2 ? 0 : 1);
  expect(f.memory.dream).not.toHaveBeenCalled();
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test("preexisting ordinary C is not adopted for catchup's D callback", async () => {
  const f = fixture();
  let release!: () => void, catchup = false;
  f.memory.consolidate.mockImplementation(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "success" };
  });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "consolidation" || phase === "dreaming" && catchup }));
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [2] });
  await tick(); catchup = true;
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 10 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(2);
  expect(f.memory.consolidate).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
  release(); await tick(); await tick();
  expect(f.memory.dream).not.toHaveBeenCalled();
});

test.each(["consolidation", "dreaming"] as const)("catchup-owned %s terminal failures fence future continuation", async phase => {
  for (const outcome of ["failure", "cancelled", "throw"] as const) {
    const f = fixture(); f.append();
    let releaseN!: () => void, failDownstream!: () => void;
    const originalN = f.memory.noting.getMockImplementation()!;
    f.memory.noting.mockImplementationOnce(originalN).mockImplementation(async () => {
      await new Promise<void>(resolve => { releaseN = resolve; });
      return originalN();
    });
    const execute = vi.fn(async () => {
      await new Promise<void>(resolve => { failDownstream = resolve; });
      if (outcome === "throw") throw new Error("downstream transport failed");
      return { outcome, problems: ["downstream terminated"] };
    });
    if (phase === "consolidation") f.memory.consolidate = execute as any;
    else f.memory.dream = execute as any;
    f.scheduler.startCatchup({ ...projection, selectedEntryIds: [1, 2, 3] });
    for (let i = 0; i < 10 && (!releaseN || !failDownstream); i++) await tick();
    expect(releaseN).toBeTypeOf("function"); expect(failDownstream).toBeTypeOf("function");
    failDownstream(); await tick();
    expect(f.scheduler.catchupStatus()).toMatchObject({ state: outcome === "cancelled" ? "stopped" : "failed",
      diagnostic: outcome === "throw" ? "downstream transport failed" : "downstream terminated" });
    const before = { n: f.memory.noting.mock.calls.length, c: f.memory.consolidate.mock.calls.length, d: f.memory.dream.mock.calls.length };
    // The in-flight N retains ownership, but its completion must not launch another N/C/D.
    releaseN(); await tick(); await tick();
    f.scheduler.reconcile(projection, false); await tick();
    expect({ n: f.memory.noting.mock.calls.length, c: f.memory.consolidate.mock.calls.length, d: f.memory.dream.mock.calls.length }).toEqual(before);
    expect(f.memory.pendingEntries()).toEqual([{ id: 3 }]);
    expect(f.memory.cancelTasks).not.toHaveBeenCalled();
  }
});

test.each(["empty", "dropped"] as const)("downstream %s is not a catchup failure or retry", async outcome => {
  const f = fixture();
  f.memory.consolidate.mockImplementation(async () => ({ outcome }) as any);
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 10 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick();
  expect(f.scheduler.catchupStatus().state).toBe("completed");
  expect(f.memory.dream).not.toHaveBeenCalled();
  const calls = f.memory.consolidate.mock.calls.length;
  await tick(); f.scheduler.reconcile(projection, false); await tick();
  expect(f.memory.consolidate).toHaveBeenCalledTimes(calls);
});

test.each(["stop", "off", "path"])("%s fences C completion's D check after N has drained", async action => {
  const f = fixture();
  let release!: () => void;
  f.memory.consolidate.mockImplementation(async () => {
    await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "success" };
  });
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 10 && f.memory.noting.mock.calls.length < 2; i++) await tick();
  if (action === "stop") f.scheduler.stopCatchup();
  else if (action === "off") f.disable();
  else f.scheduler.reconcile({ ...projection, branch: "other" }, false);
  release(); await tick(); await tick();
  expect(f.memory.dream).not.toHaveBeenCalled();
  expect(f.scheduler.catchupStatus().state).toBe("stopped");
});
