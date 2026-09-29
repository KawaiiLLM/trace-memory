import { expect, test, vi } from "vitest";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-68.db", stateDir: "/tmp/unused-68",
  notingModel: "synthetic", notingThinking: "medium", "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", claudeVersion: "2.1.280",
    contextWindows: { synthetic: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1], selectedCount: 1, selectedTailId: 1,
  selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [], snapshot: {} as any };
type Result = { outcome: string; problems?: string[]; automaticOff?: string };

// This suite isolates scheduling; Pi catchup-pipeline and CC worker tests cover real writes/claims.
function fixture() {
  const entries: number[] = [], starts: string[] = [];
  let dDue = 0;
  const memory = { executorId: "ours", config: { closedSessionScope: "project" }, cancelTasks: vi.fn(),
    pendingEntries: vi.fn(() => { throw new Error("catchup progress hydrated Raw"); }),
    store: { enabled: () => true, pendingEntryIds: () => [...entries], getClaim: () => null, closedTasks: () => [],
      getSourceEntry: (id: number) => ({ id, turnId: 1 }), progressSignal: () => "sig" },
    taskEligibility: vi.fn((phase: string) => ({ due: phase === "dreaming" ? dDue > 0 : entries.length > 0 })),
    noting: vi.fn(async (): Promise<Result> => { starts.push("N"); entries.shift(); return { outcome: "success" }; }),
    dream: vi.fn(async (): Promise<Result> => { starts.push("D"); dDue--; return { outcome: "success" }; }) };
  const scheduler = new CcTaskScheduler(memory as any, worker, () => {});
  return { scheduler, memory, starts, entries, d: (count: number) => { dDue = count; } };
}
async function settle(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 30 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick();
}

test("92: checkpoint reaches every due D pool without requiring N or a retired C step", async () => {
  const f = fixture(); f.d(3); f.scheduler.startCatchup(projection); await settle(f);
  expect(f.starts).toEqual(["D", "D", "D"]);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
  expect(f.memory.pendingEntries).not.toHaveBeenCalled();
  expect(f.memory.taskEligibility.mock.calls.every(([phase]) => phase === "dreaming")).toBe(true);
});

test.each(["empty", "dropped"] as const)("R4 %s does not spin, complete while due, or resume on ordinary release", async outcome => {
  const f = fixture(); f.d(1);
  f.memory.dream.mockImplementation(async () => { f.starts.push("D"); return { outcome }; });
  f.scheduler.startCatchup(projection); for (let i = 0; i < 5; i++) await tick();
  expect(f.starts).toEqual(["D"]);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "waiting", phase: "dreaming" });
  f.scheduler.reconcile(projection, false); await tick();
  expect(f.starts).toEqual(["D"]); expect(f.scheduler.catchupStatus().state).toBe("waiting");
});

test("R4 successful ordinary D completion launches the still-due drain phase and converges", async () => {
  const f = fixture(); let due = true; const releases: Array<() => void> = [];
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { releases.push(resolve); }); return { outcome: "success" }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && due }));
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.startCatchup(projection)).toMatchObject({ state: "waiting", phase: "dreaming" });
  releases[0]!(); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(2); expect(f.scheduler.catchupStatus().state).toBe("running");
  due = false; releases[1]!(); await settle(f);
  expect(f.memory.dream).toHaveBeenCalledTimes(2); expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test("R4 non-success ordinary D completion does not launch the drain", async () => {
  const f = fixture(); let release = () => {};
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "failure", problems: ["boom"] }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" }));
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.startCatchup(projection)).toMatchObject({ state: "waiting", phase: "dreaming" });
  release(); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "waiting", phase: "dreaming" });
});

test("86: D retries after reported partial writes without another eligibility check", async () => {
  const f = fixture(), writes: string[] = [], checks: string[] = []; let attempt = 0;
  f.memory.taskEligibility.mockImplementation(phase => { checks.push(phase); return { due: phase === "dreaming" && attempt < 2 }; });
  f.memory.dream.mockImplementation(async () => {
    attempt++;
    if (attempt === 1) { writes.push("committed revision 1"); return { outcome: "failure", problems: ["time bound after write"] }; }
    expect(writes).toEqual(["committed revision 1"]); expect(checks).toEqual(["dreaming"]);
    writes.push("committed revision 2"); return { outcome: "success" };
  });
  f.scheduler.startCatchup(projection); await settle(f);
  expect(attempt).toBe(2); expect(writes).toEqual(["committed revision 1", "committed revision 2"]);
  expect(checks).toEqual(["dreaming", "dreaming", "dreaming"]); // admission, success checkpoint, completion
});

test("86: failed ordinary D with partial writes does not checkpoint D", async () => {
  const f = fixture(); let signal = "before";
  f.memory.store.progressSignal = () => signal;
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" }));
  f.memory.dream.mockImplementation(async () => { signal = "partial-write"; return { outcome: "failure", problems: ["time bound after write"] }; });
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket());
  for (let i = 0; i < 5; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.memory.taskEligibility.mock.calls.map(([phase]) => phase)).toEqual(["noting", "dreaming"]);
  expect(signal).toBe("partial-write");
});

test("86: stop before Dreamer deadline failure settles fences its retry", async () => {
  const f = fixture(); let release = () => {};
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "failure", problems: ["Dreamer exceeded wall-clock limit"] }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" }));
  f.scheduler.startCatchup(projection); await tick(); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  f.scheduler.stopCatchup(); release(); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1); expect(f.scheduler.catchupStatus().state).toBe("stopped");
});

test("R4 repeated catchup rechecks a waiting idle drain after a dropped foreign-claim admission", async () => {
  const f = fixture(); let calls = 0;
  f.memory.dream.mockImplementation(async () => ({ outcome: ++calls === 1 ? "dropped" : "success" }));
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && calls < 2 }));
  f.scheduler.startCatchup(projection); for (let i = 0; i < 5; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "waiting", phase: "dreaming" });
  f.scheduler.startCatchup(projection); await settle(f);
  expect(f.memory.dream).toHaveBeenCalledTimes(2); expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test("R4 repeated catchup while running does not duplicate work", async () => {
  const f = fixture(); let due = true, release = () => {};
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "success" }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && due }));
  f.scheduler.startCatchup(projection); await tick(); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus().state).toBe("running");
  f.scheduler.startCatchup(projection); await tick(); expect(f.memory.dream).toHaveBeenCalledTimes(1);
  due = false; release(); await settle(f); expect(f.memory.dream).toHaveBeenCalledTimes(1);
});

test("R4 ordinary completion settles zero-Raw wait when it clears all due work without replay", async () => {
  const f = fixture(); let due = true, release = () => {};
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "success" }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" && due }));
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.scheduler.startCatchup(projection)).toMatchObject({ state: "waiting", phase: "dreaming" });
  due = false; release(); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1); expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test("86: three failures of one logical D task turn memory off without failure checkpoints", async () => {
  const f = fixture(); f.d(1); const checks: string[] = [];
  f.memory.taskEligibility.mockImplementation(phase => { checks.push(phase); return { due: phase === "dreaming" }; });
  f.memory.dream.mockImplementation(async () => { f.starts.push("D"); return { outcome: "failure", problems: ["terminal"],
    ...(f.starts.length === 3 ? { automaticOff: "off after three failures" } : {}) }; });
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 15 && f.scheduler.catchupStatus().state !== "stopped"; i++) await tick();
  expect(f.starts).toEqual(["D", "D", "D"]); expect(checks).toEqual(["dreaming"]);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "stopped", diagnostic: "terminal" });
});

test.each(["noting", "dreaming"] as const)("86: %s retries before another eligibility check, then succeeds", async phase => {
  const f = fixture(), trace: string[] = []; let attempt = 0;
  if (phase === "noting") f.entries.push(1);
  f.memory.taskEligibility.mockImplementation(candidate => { trace.push(`check:${candidate}`); return { due: candidate === phase && attempt < 2 }; });
  const execute = async () => { trace.push(`run:${phase}`); const outcome = ++attempt === 1 ? "failure" : "success";
    if (outcome === "success" && phase === "noting") f.entries.shift(); return { outcome }; };
  if (phase === "noting") f.memory.noting.mockImplementation(execute); else f.memory.dream.mockImplementation(execute);
  f.scheduler.startCatchup(projection); await settle(f);
  const first = trace.indexOf(`run:${phase}`);
  expect(trace.slice(first, first + 2)).toEqual([`run:${phase}`, `run:${phase}`]);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});
