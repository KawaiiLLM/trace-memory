import { expect, test, vi } from "vitest";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-68.db", stateDir: "/tmp/unused-68",
  notingModel: "synthetic", notingThinking: "medium", consolidationModel: "synthetic", consolidationThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", claudeVersion: "2.1.257",
    contextWindows: { synthetic: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1], appendedEntryIds: [], problems: [], snapshot: {} as any };

function fixture() {
  let entries: number[] = [];
  let cDue = 0, dDue = 0;
  const starts: string[] = [];
  const memory = { executorId: "ours", config: { closedSessionScope: "project" }, cancelTasks: vi.fn(),
    pendingEntries: vi.fn(() => { throw new Error("catchup progress hydrated Raw"); }),
    store: { enabled: () => true, pendingEntryIds: () => [...entries], consolidationBatch: () => [],
      getClaim: () => null, closedTasks: () => [], getSourceEntry: (id: number) => ({ id, turnId: 1 }) },
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

test("R4 terminal failure fences every later phase", async () => {
  const f = fixture(); f.c(2); f.d(1); f.entries.push(1);
  f.memory.consolidate.mockImplementation(async () => ({ outcome: "failure", problems: ["terminal"] }) as any);
  f.scheduler.startCatchup(projection);
  for (let i = 0; i < 10 && f.scheduler.catchupStatus().state !== "failed"; i++) await tick();
  expect(f.scheduler.catchupStatus()).toMatchObject({ state: "failed", diagnostic: "terminal" });
  const before = [...f.starts]; await tick(); f.scheduler.reconcile(projection, false); await tick();
  expect(f.starts).toEqual(before);
});
