import { expect, test, vi } from "vitest";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { ccWorkerToolNames } from "../../src/hosts/cc/tool-names.ts";
import { sourceSeededMemory, renderEntry, type NotingAgentInput } from "../source-fixture.ts";
import { rawWindowTokens } from "../../src/core/render/material.ts";
import { REQUEST, submit } from "../support/noter.ts";

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-67.db", stateDir: "/tmp/unused-67",
  notingModel: "synthetic", notingThinking: "medium", "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", contextWindows: { synthetic: 200_000, sonnet: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1, 2], selectedCount: 2, selectedTailId: 2,
  selectedAppendedEntryIds: [], appendedEntryIds: [], problems: [], snapshot: {} as never };
type Result = { outcome: string; problems?: string[]; automaticOff?: string };
function fixture() {
  const pending = [1, 2], starts: string[] = []; let enabled = true;
  const knowledgePending: number[][] = [];
  const memory = { executorId: "ours", config: { closedSessionScope: "project", noting: {} }, cancelTasks: vi.fn(),
    store: { enabled: () => enabled, pendingEntryIds: () => [...pending], incompleteEntryIds: () => [...pending, ...knowledgePending.flat()],
      handoff: (_session: number, _phase: string, lane?: string) => lane === "knowledge" && knowledgePending.length ? { entryIds: knowledgePending[0], branch: "main" } : null,
      getClaim: () => null, closedTasks: () => [],
      getSourceEntry: (id: number) => ({ id, turnId: 1 }), progressSignal: () => "sig" },
    taskEligibility: vi.fn((phase: string, target: { triggerEntryId?: number; headTurnId?: number }) => ({ due: phase === "noting" ? pending.length > 0 : !!target })),
    notingBatch: vi.fn(() => [{ id: 1 }, { id: 2 }]),
    noting: vi.fn(async (_input?: unknown): Promise<Result> => { starts.push("N"); pending.shift(); return { outcome: "success" }; }),
    dream: vi.fn(async (): Promise<Result> => { starts.push("D"); return { outcome: "success" }; }) };
  const facade = { ...memory, noting: async (input: { lane?: string }) => {
    if (input.lane === "knowledge") { knowledgePending.shift(); return { outcome: "success" }; }
    const before = [...pending], result = await memory.noting(input);
    const committed = before.filter(id => !pending.includes(id));
    if (result.outcome === "success" && committed.length) knowledgePending.push(committed);
    return result;
  } };
  const scheduler = new CcTaskScheduler(facade as unknown as ConstructorParameters<typeof CcTaskScheduler>[0], worker, () => {});
  return { scheduler, memory, starts, pending, disable: () => { enabled = false; } };
}
const settle = async (f: ReturnType<typeof fixture>) => { for (let i = 0; i < 10 && f.scheduler.catchupStatus().state !== "completed"; i++) await tick(); };

test("112: a CC turn end admits the Noter with the worker's tool names", async () => {
  const f = fixture();
  f.scheduler.turnEnd(projection, f.scheduler.catchupTicket()); await tick();
  expect(f.memory.noting.mock.calls[0]![0]).toMatchObject({ toolNames: ccWorkerToolNames });
});

test("entry ends reuse a not-due Dreaming result until its progress signal changes", () => {
  const f = fixture(); f.memory.taskEligibility.mockImplementation(() => ({ due: false }));
  f.scheduler.reconcile({ ...projection, bootstrap: true, appendedEntryIds: [1, 2], selectedAppendedEntryIds: [1, 2] });
  f.scheduler.reconcile({ ...projection, selectedAppendedEntryIds: [3, 4] });
  expect(f.memory.taskEligibility.mock.calls.map(([phase]) => phase)).toEqual(["noting", "dreaming", "noting"]);
  f.memory.store.progressSignal = () => "committed";
  f.scheduler.reconcile({ ...projection, selectedAppendedEntryIds: [5] });
  expect(f.memory.taskEligibility.mock.calls.slice(-2).map(([phase]) => phase)).toEqual(["noting", "dreaming"]);
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

test("CC pipelines the next fact batch without a turn end, serializes knowledge, and counts only completed batches", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const knowledgeBatches: number[] = [], dreaming: unknown[] = [];
  const active = { facts: 0, knowledge: 0 }, maximum = { facts: 0, knowledge: 0 };
  const memory = sourceSeededMemory(":memory:", async raw => {
    const input = raw as NotingAgentInput;
    if (input.kind !== "noting") { dreaming.push(raw); throw new Error("ordinary N completion must not launch D"); }
    const lane = input.task.endsWith("facts") ? "facts" : "knowledge";
    maximum[lane] = Math.max(maximum[lane], ++active[lane]);
    try {
      const first = memory.store.getSourceEntry(input.entryIds[0]!)!;
      if (input.task === "write-knowledge") {
        knowledgeBatches.push(first.id);
        if (knowledgeBatches.length === 1) { entered.resolve(); await release.promise; }
      }
      await submit(input, memory, { noteInput: [{ title: `Batch ${first.id}`, sources: `[T${first.turnId}#E${first.entryOrdinal}] ${first.text.split(" filler")[0]}` }],
        memoryInput: { op: "create", files: null, title: `Rule ${first.id}`, text: first.text.split(" filler")[0], category: "constraint", scope: "project",
          supports: ["$1"], topics: [], reason: "User ruling" } });
      return { outcome: "success", output: "Done", request: REQUEST };
    } finally { active[lane]--; }
  }, { noting: { triggerTokens: 1 }, dreaming: { triggerOperations: 1 } });
  const diagnostics: string[] = [];
  const scheduler = new CcTaskScheduler(memory, worker, message => diagnostics.push(message));
  try {
    const project = memory.store.createProject({ name: "pipeline", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "cc:pipeline", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const first = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Use pnpm" + " filler".repeat(100), startedAt: "now" });
    const second = memory.store.appendTurn({ sessionId: session.id, parentTurnId: first.id, kind: "turn", userPrompt: "Commit lockfiles" + " filler".repeat(100), startedAt: "later" });
    const entries = memory.store.sourcePath(session.id, "main", second.id);
    memory.config.noting.batchTokens = Math.max(...entries.map(entry => {
      const view = renderEntry(memory.store.getSourceEntry(entry.id)!, memory.config.render);
      return rawWindowTokens([view.content], view.receipts);
    }));
    scheduler.turnEnd({ state: "ready", coreSessionId: session.id, branch: "main", headTurnId: second.id, selectedTailId: entries.at(-1)!.id }, scheduler.catchupTicket());
    await entered.promise;
    await vi.waitFor(() => expect(memory.store.listSessionFacts(session.id).map(value => value.text)).toEqual(["Use pnpm", "Commit lockfiles"]));
    expect(knowledgeBatches).toEqual([entries[0]!.id]);
    expect(memory.store.currentKnowledge()).toEqual([]);
    expect(memory.progress(session.id, "main", second.id).entries).toBe(2);
    expect(maximum).toEqual({ facts: 1, knowledge: 1 });
    release.resolve();
    await vi.waitFor(() => expect(memory.progress(session.id, "main", second.id).entries).toBe(0));
    expect(knowledgeBatches).toEqual(entries.map(value => value.id));
    expect(memory.store.currentKnowledge().map(value => value.revision.text)).toEqual(["Use pnpm", "Commit lockfiles"]);
    expect(dreaming).toEqual([]);
    expect(memory.taskEligibility("dreaming", { sessionId: session.id, branch: "main", headTurnId: second.id }).due).toBe(true);
    expect(diagnostics).toEqual([]);
  } finally { release.resolve(); scheduler.stop(); await scheduler.settle(); memory.close(); }
});
