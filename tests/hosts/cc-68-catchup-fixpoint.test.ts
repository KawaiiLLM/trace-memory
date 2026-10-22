import { expect, test, vi } from "vitest";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-68.db", stateDir: "/tmp/unused-68",
  notingModel: "synthetic", notingThinking: "medium", "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude",
    contextWindows: { synthetic: 200_000, sonnet: 200_000 } } }).worker;
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
  f.scheduler.reconcile(projection); await tick();
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

test("R4 non-success ordinary D completion does not launch the drain; since 146 it ends the drain", async () => {
  const f = fixture(); let release = () => {};
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "failure", problems: ["boom"] }; });
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" }));
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.startCatchup(projection)).toMatchObject({ state: "waiting", phase: "dreaming" });
  release(); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "failed", diagnostic: "boom" }); // 146 Q18: Dreaming retries at the next check, not in a drain
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

test("86: stop before Dreamer deadline failure settles leaves the drain stopped with one D call", async () => {
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

test("146 Q18: a D failure that carries automaticOff stops the drain with the diagnostic", async () => {
  const f = fixture(); f.d(1);
  f.memory.dream.mockImplementation(async () => ({ outcome: "failure", problems: ["terminal"], automaticOff: "off after three failures" }));
  f.scheduler.startCatchup(projection); for (let i = 0; i < 10; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "stopped", diagnostic: "terminal" });
});

test("86: noting retries before another eligibility check, then succeeds", async () => {
  const f = fixture(), trace: string[] = []; let attempt = 0;
  f.entries.push(1);
  f.memory.taskEligibility.mockImplementation(candidate => { trace.push(`check:${candidate}`); return { due: candidate === "noting" && attempt < 2 }; });
  f.memory.noting.mockImplementation(async () => { trace.push("run:noting"); const outcome = ++attempt === 1 ? "failure" : "success";
    if (outcome === "success") f.entries.shift(); return { outcome }; });
  f.scheduler.startCatchup(projection); await settle(f);
  const first = trace.indexOf("run:noting");
  expect(trace.slice(first, first + 2)).toEqual(["run:noting", "run:noting"]);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});

// ---- 146 Q18: a Dreaming failure while a drain is active ends the drain, whoever started the run; the retry is the next entry-end check ----

const hold = () => { let release = () => {}; const gate = new Promise<void>(resolve => { release = resolve; }); return { gate, release: () => release() }; };

test("146 Q18 (a): an ordinary D fails, then a late N succeeds: D was called once, the drain failed, and the next entry-end check starts D once", async () => {
  const f = fixture(), d = hold(), n = hold(); let dFails = true;
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" || f.entries.length > 0 }));
  f.memory.dream.mockImplementation(async () => { if (!dFails) return { outcome: "success" }; await d.gate; return { outcome: "failure", problems: ["boom"] }; });
  f.memory.noting.mockImplementation(async () => { await n.gate; f.entries.shift(); return { outcome: "success" }; });
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick(); // ordinary D, held
  f.entries.push(1);
  f.scheduler.startCatchup(projection); await tick(); // the drain starts N and skips the busy D
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  d.release(); await tick(); await tick();
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "failed", diagnostic: "boom" });
  n.release(); for (let i = 0; i < 5; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1); // the late N success drove nothing
  dFails = false;
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(2);
});

test("146 Q18 (b): the drain's own D fails: one call, the drain ends, and the next entry-end check starts the retry once", async () => {
  const f = fixture(); let fail = true;
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" }));
  f.memory.dream.mockImplementation(async () => fail ? { outcome: "failure", problems: ["boom"] } : { outcome: "success" });
  f.scheduler.startCatchup(projection); for (let i = 0; i < 10; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "failed", diagnostic: "boom" });
  fail = false;
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick(); await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(2);
});

test("146 Q18 (c): a manual dream that fails during a drain ends the drain; a late N success drives nothing", async () => {
  const f = fixture(), n = hold();
  f.entries.push(1);
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "noting" && f.entries.length > 0 }));
  f.memory.noting.mockImplementation(async () => { await n.gate; f.entries.shift(); return { outcome: "success" }; });
  f.memory.dream.mockImplementation(async () => ({ outcome: "failure", problems: ["boom"] }));
  f.scheduler.startCatchup(projection); await tick();
  expect(f.scheduler.catchupStatus().state).toBe("running");
  f.scheduler.beginDream(); f.scheduler.startDream(projection, f.scheduler.catchupTicket()); for (let i = 0; i < 5; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "failed", diagnostic: "boom" });
  n.release(); for (let i = 0; i < 5; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
});

test("146 Q18 (d): a D failure for another session does not end the drain", async () => {
  const f = fixture(), n = hold(); let dDue = false;
  f.entries.push(1);
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" ? dDue : f.entries.length > 0 }));
  f.memory.noting.mockImplementation(async () => { await n.gate; f.entries.shift(); return { outcome: "success" }; });
  f.memory.dream.mockImplementation(async () => ({ outcome: "failure", problems: ["other session"] }));
  f.scheduler.startCatchup(projection); await tick();
  dDue = true;
  f.scheduler.turnEnd({ ...projection, coreSessionId: 2 }, f.scheduler.catchupTicket()); for (let i = 0; i < 5; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "running", phase: "noting" });
  n.release();
});
