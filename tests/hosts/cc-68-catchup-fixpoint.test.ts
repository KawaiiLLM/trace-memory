import { expect, test, vi } from "vitest";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-68.db", stateDir: "/tmp/unused-68",
  notingModel: "synthetic", notingThinking: "medium", consolidationModel: "synthetic", consolidationThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", claudeVersion: "2.1.280",
    contextWindows: { synthetic: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1], selectedCount: 1, selectedTailId: 1,
  selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [], snapshot: {} as any };

function fixture() {
  let entries: number[] = [];
  let cDue = 0, dDue = 0;
  const starts: string[] = [];
  const memory = { executorId: "ours", config: { closedSessionScope: "project" }, cancelTasks: vi.fn(),
    pendingEntries: vi.fn(() => { throw new Error("catchup progress hydrated Raw"); }),
    store: { enabled: () => true, pendingEntryIds: () => [...entries], consolidationBatch: () => [],
      getClaim: () => null, closedTasks: () => [], getSourceEntry: (id: number) => ({ id, turnId: 1 }), progressSignal: () => "sig" },
    taskEligibility: vi.fn((phase: string) => ({ due: phase === "consolidation" ? cDue > 0 : phase === "dreaming" ? dDue > 0 : entries.length > 0 })),
    noting: vi.fn(async () => { starts.push("N"); entries.shift(); return { outcome: "success", facts: [] }; }),
    consolidate: vi.fn(async () => { starts.push("C"); cDue--; return { outcome: "success" }; }),
    dream: vi.fn(async () => { starts.push("D"); dDue--; return { outcome: "success" }; }) };
  const scheduler = new CcTaskScheduler(memory as any, worker, () => {});
  return { scheduler, memory, starts, entries, c: (count: number) => { cDue = count; }, d: (count: number) => { dDue = count; } };
}

async function settle(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 30 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick();
}

test("R4 checkpoint reaches C and D fixpoints without requiring N", async () => {
  const f = fixture(); f.c(3); f.d(2);
  f.scheduler.startCatchup(projection); await settle(f);
  expect(f.starts.filter(x => x === "C")).toHaveLength(3);
  expect(f.starts.filter(x => x === "D")).toHaveLength(2);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
  expect(f.memory.pendingEntries).not.toHaveBeenCalled();
});

test("R4 reaches D when C is never due and a D completion exposes another pool", async () => {
  const f = fixture(); f.d(2);
  f.scheduler.startCatchup(projection); await settle(f);
  expect(f.starts).toEqual(["D", "D"]);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test.each(["empty", "dropped"] as const)("R4 %s does not spin, complete while due, or resume on ordinary release", async outcome => {
  const f = fixture(); f.c(1);
  f.memory.consolidate.mockImplementation(async () => { f.starts.push("C"); return { outcome } as any; });
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 5; i++) await tick();
  expect(f.starts).toEqual(["C"]);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "waiting", phase: "consolidation" });
  f.scheduler.reconcile(projection, false); await tick();
  expect(f.starts).toEqual(["C"]);
  expect(f.scheduler.catchupStatus().state).toBe("waiting");
});

test.each(["consolidation", "dreaming"] as const)("R4 a successful ordinary %s completion launches the still-due drain phase and converges", async phase => {
  const f = fixture();
  let due = true;
  const releases: Array<() => void> = [];
  const execute = vi.fn(async () => { await new Promise<void>(resolve => { releases.push(resolve); }); return { outcome: "success" }; });
  if (phase === "consolidation") f.memory.consolidate = execute as any;
  else f.memory.dream = execute as any;
  f.memory.taskEligibility.mockImplementation(candidate => ({ due: candidate === phase && due }));
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1], selectedAppendedEntryIds: [1] });
  await tick();
  expect(execute).toHaveBeenCalledTimes(1); // ordinary slot busy
  expect(f.scheduler.startCatchup(projection)).toMatchObject({ state: "waiting", phase });
  // The ordinary run succeeds while the phase is still due: R4 makes this a full checkpoint.
  releases[0]!(); await tick(); await tick();
  expect(execute).toHaveBeenCalledTimes(2); // drain launched its own due phase, not adopting the ordinary one
  expect(f.scheduler.catchupStatus().state).toBe("running");
  due = false;
  releases[1]!(); await settle(f);
  expect(execute).toHaveBeenCalledTimes(2); // no longer due: converges without a third launch
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test.each(["consolidation", "dreaming"] as const)("R4 a non-success ordinary %s completion does not launch the drain", async phase => {
  const f = fixture();
  let release!: () => void;
  const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "failure", problems: ["boom"] }; });
  if (phase === "consolidation") f.memory.consolidate = execute as any;
  else f.memory.dream = execute as any;
  f.memory.taskEligibility.mockImplementation(candidate => ({ due: candidate === phase }));
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1], selectedAppendedEntryIds: [1] });
  await tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.scheduler.startCatchup(projection)).toMatchObject({ state: "waiting", phase });
  release(); await tick(); await tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "waiting", phase });
});

test("86: catchup D failure preserves partial writes and admits a fresh range without checking C/D", async () => {
  const f = fixture();
  const writes: string[] = [];
  let attempt = 0;
  const checks: string[] = [];
  f.memory.taskEligibility.mockImplementation(phase => { checks.push(phase); return { due: phase === "dreaming" && attempt < 2 }; });
  f.memory.dream.mockImplementation(async () => {
    attempt++;
    if (attempt === 1) { writes.push("committed revision 1"); return { outcome: "failure", problems: ["time bound after write"] } as any; }
    expect(writes).toEqual(["committed revision 1"]);
    writes.push("committed revision 2");
    return { outcome: "success" } as any;
  });
  f.scheduler.startCatchup(projection); await settle(f);
  expect(attempt).toBe(2);
  expect(writes).toEqual(["committed revision 1", "committed revision 2"]);
  expect(checks.slice(0, 2)).toEqual(["consolidation", "dreaming"]);
  expect(checks.slice(2)).toEqual(["consolidation", "dreaming", "consolidation", "dreaming"]); // success checkpoint and completion only
});

test("86: a failed ordinary D with partial writes does not checkpoint C or D", async () => {
  const f = fixture();
  let signal = "before";
  f.memory.store.progressSignal = vi.fn(() => signal);
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" }));
  f.memory.dream.mockImplementation(async () => {
    signal = "partial-write";
    return { outcome: "failure", problems: ["time bound after write"] } as any;
  });
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1], selectedAppendedEntryIds: [1] });
  for (let i = 0; i < 5; i++) await tick();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.memory.taskEligibility.mock.calls.map(([phase]) => phase)).toEqual(["noting", "consolidation", "dreaming"]);
  expect(signal).toBe("partial-write");
});

test("86: a Dreamer wall-clock failure retries its frozen phase; stop at completion fences retry", async () => {
  const f = fixture();
  let release!: () => void;
  const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; });
    return { outcome: "failure", problems: ["Dreamer exceeded wall-clock limit"] } as any; });
  f.memory.dream = execute as any;
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "dreaming" }));
  f.scheduler.startCatchup(projection);
  await tick(); expect(execute).toHaveBeenCalledTimes(1);
  f.scheduler.stopCatchup(); release(); await tick(); await tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus().state).toBe("stopped");
});

test.each(["consolidation", "dreaming"] as const)("R4 a repeated catchup command re-checks a waiting idle drain and launches a due %s", async phase => {
  const f = fixture();
  let calls = 0;
  const execute = vi.fn(async () => (++calls === 1 ? { outcome: "dropped" } : { outcome: "success" }));
  if (phase === "consolidation") f.memory.consolidate = execute as any;
  else f.memory.dream = execute as any;
  f.memory.taskEligibility.mockImplementation(candidate => ({ due: candidate === phase && calls < 2 }));
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 5; i++) await tick();
  // The dropped admission (a foreign claim) leaves the drain waiting with nothing drain-owned active:
  // no in-process completion will ever re-check it.
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "waiting", phase });
  f.scheduler.startCatchup(projection);
  await settle(f);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test("R4 a repeated catchup command on a running drain does not start a second run", async () => {
  const f = fixture();
  let due = true, release!: () => void;
  const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "success" }; });
  f.memory.consolidate = execute as any;
  f.memory.taskEligibility.mockImplementation(candidate => ({ due: candidate === "consolidation" && due }));
  f.scheduler.startCatchup(projection);
  await tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus().state).toBe("running");
  f.scheduler.startCatchup(projection);
  await tick();
  expect(execute).toHaveBeenCalledTimes(1); // still running: the repeated command only reports, never drives
  due = false; release(); await settle(f);
  expect(execute).toHaveBeenCalledTimes(1);
});

test("R4 ordinary completion may settle a zero-Raw wait when it clears all due work, without replay", async () => {
  const f = fixture();
  let due = true, release!: () => void;
  const execute = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "success" }; });
  f.memory.consolidate = execute as any;
  f.memory.taskEligibility.mockImplementation(phase => ({ due: phase === "consolidation" && due }));
  f.scheduler.reconcile({ ...projection, appendedEntryIds: [1], selectedAppendedEntryIds: [1] });
  await tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.scheduler.startCatchup(projection)).toMatchObject({ state: "waiting", phase: "consolidation" });
  due = false; release(); await tick(); await tick();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});

test("86: 'catchup 同样遵守三次失败转为off' retries one logical C task without failure checkpoints", async () => {
  const f = fixture(); f.c(1);
  const checks: string[] = [];
  f.memory.taskEligibility.mockImplementation(phase => { checks.push(phase); return { due: phase === "consolidation" }; });
  f.memory.consolidate.mockImplementation(async () => {
    f.starts.push("C");
    const attempts = f.starts.filter(phase => phase === "C").length;
    return { outcome: "failure", problems: ["terminal"], ...(attempts === 3 ? { automaticOff: "off after three failures" } : {}) } as any;
  });
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 15 && f.scheduler.catchupStatus().state !== "stopped"; i++) await tick();
  expect(f.starts).toEqual(["C", "C", "C"]);
  expect(checks).toEqual(["consolidation", "dreaming"]); // first checkpoint only; failures check neither.
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "stopped", diagnostic: "terminal" });
});

test.each(["consolidation", "dreaming"] as const)("86: '任务失败后不检查' — %s retries before another eligibility check, then succeeds", async phase => {
  const f = fixture();
  const trace: string[] = [];
  let attempt = 0;
  f.memory.taskEligibility.mockImplementation(candidate => { trace.push(`check:${candidate}`); return { due: candidate === phase && attempt < 2 }; });
  const execute = vi.fn(async () => { trace.push(`run:${phase}`); return { outcome: ++attempt === 1 ? "failure" : "success" }; });
  if (phase === "consolidation") f.memory.consolidate = execute as any;
  else f.memory.dream = execute as any;
  f.scheduler.startCatchup(projection);
  await settle(f);
  expect(trace.slice(0, 4)).toEqual(["check:consolidation", "check:dreaming", `run:${phase}`, `run:${phase}`]);
  expect(f.scheduler.catchupStatus().state).toBe("completed");
});
