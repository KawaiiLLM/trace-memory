import { expect, test, vi } from "vitest";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-67.db", stateDir: "/tmp/unused-67",
  notingModel: "synthetic", notingThinking: "medium", "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", contextWindows: { synthetic: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1, 2], selectedCount: 2, selectedTailId: 2,
  selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [], snapshot: {} as never };
type Result = { outcome: string; problems?: string[]; automaticOff?: string };
function fixture() {
  const pending = [1, 2], starts: string[] = []; let enabled = true;
  const memory = { executorId: "ours", config: { closedSessionScope: "project" }, cancelTasks: vi.fn(),
    store: { enabled: () => enabled, pendingEntryIds: () => [...pending], getClaim: () => null, closedTasks: () => [],
      getSourceEntry: (id: number) => ({ id, turnId: 1 }), progressSignal: () => "sig" },
    taskEligibility: vi.fn((phase: string, target: { triggerEntryId?: number; headTurnId?: number }) => ({ due: !!phase && !!target })),
    notingBatch: vi.fn(() => [{ id: 1 }, { id: 2 }]),
    noting: vi.fn(async (_input?: unknown): Promise<Result> => { starts.push("N"); pending.shift(); return { outcome: "success" }; }),
    dream: vi.fn(async (): Promise<Result> => { starts.push("D"); return { outcome: "success" }; }) };
  const scheduler = new CcTaskScheduler(memory as unknown as ConstructorParameters<typeof CcTaskScheduler>[0], worker, () => {});
  return { scheduler, memory, starts, pending, disable: () => { enabled = false; } };
}
const settle = async (f: ReturnType<typeof fixture>) => { for (let i = 0; i < 10 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick(); };

test("112: only an admitted CC fork passes its ToolSearch guidance to Core before freezing", async () => {
  const f = fixture();
  const fork = { model: "synthetic", capacity: { inputTokens: 150_000, prefixTokens: 1_000 },
    visible: { raw: new Map(), facts: new Set(), knowledge: new Set() } } as never;
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket(), fork); await tick();
  expect(f.memory.noting).toHaveBeenCalledWith(expect.objectContaining({ effectiveMode: "fork",
    forkGuidance: expect.stringContaining("ToolSearch") }));
  const input = f.memory.noting.mock.calls[0]![0] as { forkGuidance: string };
  expect(input.forkGuidance).toContain("note and memory");
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.noting.mock.calls[1]![0]).not.toHaveProperty("forkGuidance");
});

test("entry imports and bootstrap do not check automatic work; one turn end checks both phases", () => {
  const f = fixture(); f.memory.taskEligibility.mockImplementation(() => ({ due: false }));
  f.scheduler.reconcile({ ...projection, bootstrap: true, appendedEntryIds: [1, 2], selectedAppendedEntryIds: [1, 2] });
  f.scheduler.reconcile({ ...projection, bootstrap: false, appendedEntryIds: [1, 2], selectedAppendedEntryIds: [1, 2] });
  expect(f.memory.taskEligibility).not.toHaveBeenCalled();
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket());
  expect(f.memory.taskEligibility.mock.calls.map(([phase]) => phase)).toEqual(["noting", "dreaming"]);
  for (const [, target] of f.memory.taskEligibility.mock.calls) expect(target).toMatchObject({ triggerEntryId: 2, headTurnId: 1 });
});

test("one turn checks both phases; settlement and new entries do not queue another run", async () => {
  const f = fixture(); let releaseN!: () => void, releaseD!: () => void;
  f.memory.noting.mockImplementation(async () => { await new Promise<void>(resolve => { releaseN = resolve; }); return { outcome: "success" }; });
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { releaseD = resolve; }); return { outcome: "failure" }; });
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(1); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1, 2], selectedAppendedEntryIds: [1, 2] });
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(1); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  releaseN(); releaseD(); await tick(); await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(1); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(2); expect(f.memory.dream).toHaveBeenCalledTimes(2);
  f.scheduler.stop(); releaseN(); releaseD(); await f.scheduler.settle();
});

test("known restart grants no automatic opportunity but explicit catchup drains frozen Raw", async () => {
  const f = fixture(); f.memory.taskEligibility.mockImplementation(() => ({ due: false }));
  f.scheduler.reconcile({ ...projection, bootstrap: true }); await tick();
  expect(f.memory.taskEligibility).not.toHaveBeenCalled(); expect(f.memory.noting).not.toHaveBeenCalled();
  f.scheduler.startCatchup(projection); await settle(f);
  expect(f.memory.noting).toHaveBeenCalledTimes(2); expect(f.memory.dream).not.toHaveBeenCalled();
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test("successful N checkpoints recheck D when its publication first makes knowledge due", async () => {
  const f = fixture(); let release!: () => void;
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && f.memory.noting.mock.calls.length === 2 && f.memory.dream.mock.calls.length === 0 }));
  f.memory.dream.mockImplementation(async () => { f.starts.push("D"); await new Promise<void>(resolve => { release = resolve; }); return { outcome: "success" }; });
  f.scheduler.startCatchup(projection); await settle(f);
  expect(f.starts).toEqual(["N", "N", "D"]); expect(f.scheduler.catchupStatus().state).toBe("running");
  release(); await settle(f); expect(f.scheduler.catchupStatus().state).toBe("completed");
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
});

test("busy D discards N completion opportunities without duplicating the running slot", async () => {
  const f = fixture(); let release!: () => void;
  f.memory.dream.mockImplementation(async () => { f.starts.push("D"); await new Promise<void>(resolve => { release = resolve; }); return { outcome: "success" }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && f.memory.dream.mock.calls.length === 0 }));
  f.scheduler.startCatchup(projection); await settle(f);
  expect(f.starts).toEqual(["N", "D", "N"]); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  release(); await settle(f); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
  await tick(); expect(f.memory.dream).toHaveBeenCalledTimes(1);
});

test.each([1, 2])("ordinary N consuming %s entries retains ownership while catchup waits", async consumed => {
  const f = fixture(); let release!: () => void, ordinaryFinished = false;
  f.memory.noting.mockImplementationOnce(async () => { await new Promise<void>(resolve => { release = resolve; });
    f.pending.splice(0, consumed); ordinaryFinished = true; return { outcome: "success" }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "noting" || phase === "dreaming" && ordinaryFinished && f.memory.dream.mock.calls.length === 0 }));
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(1); expect(f.scheduler.startCatchup(projection).state).toBe("waiting");
  release(); await settle(f);
  expect(f.memory.noting).toHaveBeenCalledTimes(consumed === 2 ? 1 : 2);
  expect(f.memory.dream).toHaveBeenCalledTimes(1); expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test("ordinary D is not adopted; its successful checkpoint admits a separate catchup D", async () => {
  const f = fixture(), releases: Array<() => void> = [];
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { releases.push(resolve); }); return { outcome: "success" }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && f.memory.dream.mock.calls.length < 2 }));
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  f.scheduler.startCatchup(projection); await settle(f);
  expect(f.memory.noting).toHaveBeenCalledTimes(2); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "waiting", phase: "dreaming" });
  releases[0]!(); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(2); expect(f.scheduler.catchupStatus().state).toBe("running");
  releases[1]!(); await settle(f);
  expect(f.memory.dream).toHaveBeenCalledTimes(2); expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test.each(["failure", "cancelled", "throw"] as const)("catchup-owned D %s fences later N continuation", async outcome => {
  const f = fixture(); f.pending.push(3); let releaseN!: () => void, releaseD!: () => void;
  const original = f.memory.noting.getMockImplementation()!;
  f.memory.noting.mockImplementationOnce(original).mockImplementation(async () => { await new Promise<void>(resolve => { releaseN = resolve; }); return original(); });
  f.memory.dream.mockImplementation(async () => {
    await new Promise<void>(resolve => { releaseD = resolve; });
    if (outcome === "throw") throw new Error("downstream transport failed");
    return { outcome, problems: ["downstream terminated"], ...(outcome === "failure" ? { automaticOff: "off after three failures" } : {}) };
  });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && f.memory.dream.mock.calls.length === 0 }));
  f.scheduler.startCatchup({ ...projection, selectedEntryIds: [1, 2, 3], selectedCount: 3, selectedTailId: 3 });
  for (let i = 0; i < 10 && f.memory.noting.mock.calls.length < 2; i++) await tick();
  expect(releaseN).toBeTypeOf("function"); expect(releaseD).toBeTypeOf("function");
  expect(f.memory.noting).toHaveBeenCalledTimes(2); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  releaseD(); await tick(); await tick();
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: outcome === "throw" ? "failed" : "stopped",
    diagnostic: outcome === "throw" ? "downstream transport failed" : "downstream terminated" });
  releaseN(); await tick(); await tick(); f.scheduler.reconcile(projection); await tick();
  expect(f.memory.noting).toHaveBeenCalledTimes(2); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.pending).toEqual([3]); expect(f.memory.cancelTasks).not.toHaveBeenCalled();
});

test.each(["empty", "dropped"] as const)("downstream %s is not a catchup failure or retry", async outcome => {
  const f = fixture();
  f.memory.dream.mockImplementation(async () => ({ outcome }));
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && f.memory.dream.mock.calls.length === 0 }));
  f.scheduler.startCatchup(projection); await settle(f);
  expect(f.scheduler.catchupStatus().state).toBe("completed"); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  await tick(); f.scheduler.reconcile(projection); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
});

test.each(["stop", "off", "path"] as const)("%s fences held D completion after N drains", async action => {
  const f = fixture(); let release!: () => void;
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "success" }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" }));
  f.scheduler.startCatchup(projection); for (let i = 0; i < 10 && f.memory.noting.mock.calls.length < 2; i++) await tick();
  if (action === "stop") f.scheduler.stopCatchup(); else if (action === "off") f.disable();
  else f.scheduler.reconcile({ ...projection, branch: "other" });
  release(); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1); expect(f.scheduler.catchupStatus().state).toBe("stopped");
});
