// 146 §18: `/trace dream` on Claude Code. The scheduler runs one Dreaming run now through the `dreaming` slot with `manual: true`
// and reports through a status of its own, a sibling of the catchup status. Core's refusals are in tests/core/api/dreaming-run.test.ts.
import { expect, test, vi } from "vitest";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { ccDreamNotice } from "../../src/hosts/cc/menu.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-146.db", stateDir: "/tmp/unused-146",
  notingModel: "synthetic", notingThinking: "medium", "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude",
    contextWindows: { synthetic: 200_000, sonnet: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1], selectedCount: 1, selectedTailId: 1,
  selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [], snapshot: {} as any };
type Result = { outcome: string; problems?: string[]; reason?: string; automaticOff?: string };

function fixture() {
  const memory = { executorId: "ours", config: { closedSessionScope: "project" }, cancelTasks: vi.fn(),
    store: { enabled: () => true, pendingEntryIds: () => [], getClaim: () => null, closedTasks: () => [], progressSignal: () => "sig" },
    taskEligibility: vi.fn(() => ({ due: false })),
    noting: vi.fn(async (): Promise<Result> => ({ outcome: "success" })),
    dream: vi.fn(async (_input: unknown): Promise<Result> => ({ outcome: "success" })) };
  const scheduler = new CcTaskScheduler(memory as any, worker, () => {});
  const dream = (reconcile: typeof projection | any = projection) => {
    const starting = scheduler.beginDream();
    scheduler.startDream(reconcile, scheduler.catchupTicket());
    return starting;
  };
  return { scheduler, memory, dream };
}
const settle = async () => { for (let i = 0; i < 5; i++) await tick(); };

test("a manual dream is acknowledged as starting, runs the core with manual: true below the trigger and reports completed", async () => {
  const f = fixture();
  expect(f.dream()).toEqual({ state: "starting", diagnostic: "syncing the transcript" });
  expect(f.scheduler.dreamSnapshot()).toMatchObject({ state: "running" }); // the slot is reserved as soon as the sync ends
  await settle();
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  expect(f.memory.dream.mock.calls[0]![0]).toMatchObject({ manual: true, sessionId: 1, automatic: false });
  expect(f.memory.taskEligibility).not.toHaveBeenCalled(); // the trigger count is not consulted
  expect(f.scheduler.dreamSnapshot()).toEqual({ state: "completed" });
});

test.each([
  ["a foreign claim", { outcome: "dropped", reason: "session S7 holds the Dreamer seat" }, "session S7 holds the Dreamer seat"],
  ["memory off in the core", { outcome: "dropped", reason: "Trace Memory is off for this session" }, "Trace Memory is off for this session"],
  ["nothing to curate", { outcome: "empty" }, "nothing to curate"],
] as const)("a refusal (%s) turns the status to failed with the reason", async (_name, result, diagnostic) => {
  const f = fixture(); f.memory.dream.mockResolvedValue(result);
  f.dream(); await settle();
  expect(f.scheduler.dreamSnapshot()).toEqual({ state: "failed", diagnostic });
});

test("a refusal before the core: memory off in the projection, a not-ready path, a busy Dreamer slot; none calls the core", async () => {
  const f = fixture();
  f.dream({ ...projection, state: "disabled" }); expect(f.scheduler.dreamSnapshot()).toEqual({ state: "failed", diagnostic: "Trace Memory is disabled for this session" });
  f.dream({ ...projection, state: "unavailable", problems: ["no path"] }); expect(f.scheduler.dreamSnapshot()).toEqual({ state: "failed", diagnostic: "no path" });
  let release = () => {};
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "success" }; });
  f.dream(); await tick();
  expect(f.scheduler.activeDream()).toMatchObject({ state: "running" });
  f.dream(); // the slot is taken
  expect(f.scheduler.dreamSnapshot()).toEqual({ state: "failed", diagnostic: "a Dreamer is already running in this session" });
  expect(f.memory.dream).toHaveBeenCalledTimes(1);
  release(); await settle();
});

test("a model that never returns leaves the command answered; the status stays running until the stop ends it as stopped", async () => {
  const f = fixture(); let release = () => {};
  f.memory.dream.mockImplementation(async () => { await new Promise<void>(resolve => { release = resolve; }); return { outcome: "cancelled", problems: ["cancelled"] }; });
  expect(f.dream().state).toBe("starting");
  await settle();
  expect(f.scheduler.dreamSnapshot()).toEqual({ state: "running" });
  f.scheduler.stopCatchup(); release(); await settle();
  expect(f.scheduler.dreamSnapshot()).toMatchObject({ state: "stopped" });
});

test("a failure shows the diagnostic; one that carries automaticOff reads as stopped; a stop during the sync is not admitted", async () => {
  const f = fixture();
  f.memory.dream.mockResolvedValueOnce({ outcome: "failure", problems: ["curate g1: timeout"] });
  f.dream(); await settle();
  expect(f.scheduler.dreamSnapshot()).toEqual({ state: "failed", diagnostic: "curate g1: timeout" });
  f.memory.dream.mockResolvedValueOnce({ outcome: "failure", problems: ["terminal"], automaticOff: "off after three failures" });
  f.dream(); await settle();
  expect(f.scheduler.dreamSnapshot()).toEqual({ state: "stopped", diagnostic: "terminal" });
  const starting = f.scheduler.beginDream(), ticket = f.scheduler.catchupTicket();
  f.scheduler.stopCatchup();
  f.scheduler.startDream(projection, ticket);
  expect(starting.state).toBe("starting");
  expect(f.scheduler.dreamSnapshot()).toMatchObject({ state: "stopped" });
  expect(f.memory.dream).toHaveBeenCalledTimes(2);
});

test("the /trace notice reads each state", () => {
  expect(ccDreamNotice(null)).toBeNull();
  expect(ccDreamNotice({ state: "starting", diagnostic: "syncing the transcript" })).toContain("Dream: starting");
  expect(ccDreamNotice({ state: "running" })).toBe("Dream: running");
  expect(ccDreamNotice({ state: "completed" })).toBe("Dream: completed");
  expect(ccDreamNotice({ state: "failed", diagnostic: "boom" })).toBe("Dream: failed — boom");
  expect(ccDreamNotice({ state: "stopped", diagnostic: "terminal" })).toContain("Dream: stopped (terminal)");
});
