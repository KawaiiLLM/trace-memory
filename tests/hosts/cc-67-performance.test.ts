import { expect, test, vi } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../../src/core/store/index.ts";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";
import { TraceMemory, type NotingAgentInput } from "../../src/core/api/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart } from "../../src/hosts/cc/binding.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { CcImporter, CcProjection } from "../../src/hosts/cc/importer.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { CcAgentWorker } from "../../src/hosts/cc/worker.ts";

const at = "2026-01-01T00:00:00.000Z";
const line = (value: unknown) => JSON.stringify(value) + "\n";
function records(pairs: number) {
  return Array.from({ length: pairs }, (_, i) => [
    { uuid: `u${i}`, parentUuid: i ? `a${i - 1}` : null, type: "user", timestamp: at,
      promptId: `p${i}`, promptSource: "sdk", message: { role: "user", content: `question ${i}` } },
    { uuid: `a${i}`, parentUuid: `u${i}`, type: "assistant", timestamp: at,
      message: { role: "assistant", content: [{ type: "text", text: `answer ${i}` }] } },
  ]).flat();
}
function seedKnowledge(db: string, due: boolean) {
  const memory = TraceMemory(db, async () => { throw new Error("no provider in fixture"); });
  const store = memory.store;
  try {
    store.transaction(() => {
      for (let owner = 0; owner < 8; owner++) {
        const project = store.createProject({ name: `owner-${owner}`, declaredBy: "mark" });
        const session = store.createSession({ host: `fixture:${owner}`, projectId: project.id, startedAt: at,
          firstReplyAt: at, enrollmentChoice: true });
        const turn = store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: at });
        const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: `owner-${owner}`,
          nativeId: "e", role: "user", text: "synthetic support", raw: "{}", calls: [] });
        store.publishSourcePath(session.id, "main", [entry.id], turn.id, `owner-${owner}`);
        const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: at },
          entryIds: [entry.id], facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "Synthetic rule",
            source: [`T${turn.id}#E${entry.entryOrdinal}`], entryIds: [entry.id], createdAt: at }] });
        if (!noted.ok) throw new Error(noted.problems.join("; "));
        const created = store.commitConsolidationRun({ path: { sessionId: session.id, branch: "main", headTurnId: turn.id },
          run: { kind: "manual", sessionId: session.id, branch: "main", createdAt: at },
          operations: Array.from({ length: 10 }, (_, i) => ({ op: "create" as const, handle: `$k${i}`, author: "fixture",
            category: "reference" as const, scope: owner === 0 && due ? "global" as const : "session" as const,
            // 104: the due owner's pending weight, summed, reaches the 5k Dreamer trigger.
            text: `Rule ${owner}-${i}: ${"synthetic body ".repeat(owner === 0 && due ? 250 : 40)}`, supports: [noted.facts[0]!.id], topics: [],
            reason: "synthetic fixture", createdAt: at })) });
        if (!created.ok) throw new Error(created.problems.join("; "));
      }
    });
    if (due) store.setKnowledgeBudget("global", 1000);
  } finally { memory.close(); }
}

// Work bounds are independent of machine speed. Timings are diagnostics, not production claims.
async function fullChain(entries: number, due: boolean) {
  const dir = mkdtempSync("/tmp/tm67-perf-");
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = "performance";
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "s"),
    baseline: "2025-01-01T00:00:00Z", pollIntervalMs: 60_000, finalSyncTimeoutMs: 100, finalSyncStablePolls: 2,
    notingModel: "synthetic", notingThinking: "medium",
    "dreaming.model": "synthetic", "dreaming.thinking": "medium", worker: { cwd: dir, claudeExecutable: "/missing/claude",
      claudeVersion: "2.1.280", contextWindows: { synthetic: 200_000 } } });
  seedKnowledge(config.dbPath, due);
  // New installations must receive WAL from Store, without an operator step in the fixture.
  const inspection = new DatabaseSync(config.dbPath);
  try { expect(inspection.prepare("PRAGMA journal_mode").get()!.journal_mode).toBe("wal"); }
  finally { inspection.close(); }
  writeFileSync(transcriptPath, records(entries / 2).map(line).join(""));
  await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, at);
  const diagnostics: string[] = [], coordinator = new CcCoordinator(config, nativeSessionId, message => diagnostics.push(message));
  let importer!: CcImporter, scheduler!: CcTaskScheduler, eligibility = 0, prepares = 0, inputs = 0, admissionAt = 0;
  let schedulerMs = 0, scheduledAt = 0, scheduleFinishedAt = 0;
  const phases: string[] = [], origins: number[] = [], checks: Array<[string, number | undefined]> = [];
  const phaseWork: Record<string, { calls: number; prepares: number }> = {};
  let maxWriteHoldMs = 0, maxBeginWaitMs = 0;
  const transaction = Store.prototype.transaction;
  const transactionSpy = vi.spyOn(Store.prototype, "transaction").mockImplementation(function <T>(this: Store, fn: () => T): T {
    if (this.db.isTransaction) return transaction.call(this, fn) as T;
    const db = this.db, exec = db.exec;
    let acquired: number | undefined;
    db.exec = function (sql: string) {
      const before = performance.now();
      try { return exec.call(this, sql); }
      finally {
        if (sql === "BEGIN IMMEDIATE") { acquired = performance.now(); maxBeginWaitMs = Math.max(maxBeginWaitMs, acquired - before); }
        else if ((sql === "COMMIT" || sql === "ROLLBACK") && acquired !== undefined) {
          maxWriteHoldMs = Math.max(maxWriteHoldMs, performance.now() - acquired); acquired = undefined;
        }
      }
    };
    try { return transaction.call(this, fn) as T; }
    finally { db.exec = exec; }
  });
  const writer = spawn(process.execPath, [resolve("tests/hosts/cc-67-writer.mjs"), config.dbPath, "8"],
    { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  const finished = new Promise<any>((resolveDone, reject) => {
    writer.on("message", (message: any) => { if (message.type === "done") resolveDone(message); });
    writer.on("error", reject);
  });
  await new Promise<void>((resolveReady, reject) => {
    writer.on("message", (message: any) => { if (message.type === "ready") resolveReady(); });
    writer.once("error", reject);
  });
  const originalImport = CcImporter.prototype.reconcile;
  const importSpy = vi.spyOn(CcImporter.prototype, "reconcile").mockImplementation(function (this: CcImporter) {
    importer = this; return originalImport.call(this);
  });
  const originalSchedule = CcTaskScheduler.prototype.reconcile;
  const scheduleSpy = vi.spyOn(CcTaskScheduler.prototype, "reconcile").mockImplementation(function (this: CcTaskScheduler, ...args) {
    scheduler = this;
    originalSchedule.apply(this, args);
  });
  const workerSpy = vi.spyOn(CcAgentWorker.prototype, "run").mockImplementation(async task => {
    phases.push(task.kind); admissionAt ||= performance.now();
    expect(importer.memory.store.db.prepare("SELECT count(*) AS n FROM task_claims").get()!.n).toBeGreaterThan(0);
    if (task.kind === "noting") {
      const input = task as NotingAgentInput, note = input.tools.find(tool => tool.name === "note")!;
      const batch = { facts: [] };
      note.execute(batch);
      input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    }
    return { outcome: "success", output: "synthetic worker", audit: { available: false, reason: "deterministic fixture" } };
  });
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    const start = performance.now(), startedAt = Date.now();
    let lastHeartbeat = start, maxHeartbeatGapMs = 0, heartbeatSamples = 0;
    // Arm before bootstrap, including its asynchronous attach and synchronous import/scheduling.
    // This reports actual stalls; it does not pretend synchronous 30k ingestion is responsive.
    heartbeat = setInterval(() => {
      const now = performance.now();
      maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - lastHeartbeat);
      lastHeartbeat = now; heartbeatSamples++;
    }, 10);
    const result = await coordinator.requestReconcile("startup");
    const bootstrapMs = performance.now() - start, completedAt = Date.now();
    expect(result?.state).toBe("ready");
    expect(result?.selectedEntryIds).toHaveLength(entries);
    expect(result?.appendedEntryIds).toHaveLength(entries);
    expect(result?.bootstrap).toBe(true);
    // Bootstrap/import alone is not an automatic opportunity; the persisted final reply is.
    const memory = importer.memory, store = memory.store, real = memory.taskEligibility;
    const countEligibility = vi.spyOn(memory, "taskEligibility").mockImplementation((...params) => {
      eligibility++; origins.push(params[1].triggerEntryId!);
      checks.push([params[0], params[1].triggerEntryId]);
      const before = prepares, counted = phaseWork[params[0]] ??= { calls: 0, prepares: 0 }; counted.calls++;
      try { return real(...params); } finally { counted.prepares += prepares - before; }
    });
    const prepare = store.db.prepare.bind(store.db);
    const sql = vi.spyOn(store.db, "prepare").mockImplementation((query: string) => { prepares++; return prepare(query); });
    const originalInput = (store as any).commitGraphInput.bind(store);
    const graph = vi.spyOn(store as any, "commitGraphInput").mockImplementation((...params) => { inputs++; return originalInput(...params); });
    try {
      scheduledAt = performance.now();
      scheduler.turnEnd(result!, scheduler.catchupTicket());
      scheduleFinishedAt = performance.now();
      schedulerMs = scheduleFinishedAt - scheduledAt;
    } finally { countEligibility.mockRestore(); sql.mockRestore(); graph.mockRestore(); }
    // The original graph-read bound covers synchronous scheduling, not deferred task execution.
    expect(inputs).toBe(1);
    await scheduler.settle();
    await new Promise<void>(resolve => setTimeout(resolve, 10));
    clearInterval(heartbeat); heartbeat = undefined;
    expect(heartbeatSamples).toBeGreaterThan(0);
    const workerAdmissionFromBootstrapMs = admissionAt - start;
    const workerAdmissionAfterSchedulingMs = admissionAt - scheduleFinishedAt;
    expect(eligibility).toBe(2);
    expect(origins).toEqual(Array(2).fill(result!.selectedEntryIds.at(-1)));
    expect(checks).toEqual([["noting", result!.selectedEntryIds.at(-1)], ["dreaming", result!.selectedEntryIds.at(-1)]]);
    expect(inputs).toBe(1);
    expect(Object.entries(phaseWork).map(([phase, value]) => [phase, value.calls])).toEqual([["noting", 1], ["dreaming", 1]]);
    // N's oldest bounded Raw batch does hundreds of entry reads; a 200-prepare total cap
    // would reject necessary batch selection. A 10x history increase must not multiply it.
    expect(phases).toContain("noting");
    expect(phases.includes("dreaming")).toBe(due);
    expect(admissionAt).toBeGreaterThanOrEqual(scheduledAt);
    expect(workerAdmissionAfterSchedulingMs).toBeGreaterThanOrEqual(0);
    const idle = await coordinator.requestReconcile("stat wake-up");
    expect(idle?.appendedEntryIds).toEqual([]);
    expect(idle?.bootstrap).toBe(false);
    expect(eligibility).toBe(2);
    expect(checks).toEqual([["noting", result!.selectedEntryIds.at(-1)], ["dreaming", result!.selectedEntryIds.at(-1)]]);
    if (writer.connected) writer.send("stop", () => {}); // A child failure already reports its original error through `done`.
    const writerResult = await finished;
    expect(writerResult.error).toBeUndefined();
    expect(writerResult.writes).toBeGreaterThan(2);
    expect(writerResult.firstAt).toBeLessThan(completedAt);
    expect(writerResult.lastAt).toBeGreaterThan(startedAt);
    expect(writerResult.maxMs).toBeLessThan(5000);
    expect(maxWriteHoldMs).toBeLessThan(5000);
    console.log(JSON.stringify({ fixture: "CC full chain", entries, due, journalMode: "wal", bootstrapMs, schedulerMs,
      maxHeartbeatGapMs, heartbeatSamples, workerAdmissionFromBootstrapMs, workerAdmissionAfterSchedulingMs,
      eligibility, graphInputs: inputs, sqlPrepares: prepares, phaseWork, phases, maxWriteHoldMs, maxBeginWaitMs, writer: writerResult }));
    return phaseWork;
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await coordinator.shutdown("test");
    importSpy.mockRestore(); scheduleSpy.mockRestore(); workerSpy.mockRestore(); transactionSpy.mockRestore();
    if (writer.connected) writer.send("stop", () => {});
    await finished;
    rmSync(dir, { recursive: true, force: true });
  }
}

test("3k/30k full CC chain preserves fixed eligibility work and WAL writer progress, with due and non-due shared pools", async () => {
  const small = await fullChain(3000, false);
  const large = await fullChain(30_000, false);
  expect(large).toEqual(small);
  await fullChain(30_000, true);
}, 120_000);

test("Hook-first bootstrap and fresh resume validate known records without per-record write transactions", async () => {
  const dir = mkdtempSync("/tmp/tm67-resume-");
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = "resume";
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "s"),
    baseline: "2025-01-01T00:00:00Z", finalSyncTimeoutMs: 100, finalSyncStablePolls: 2 });
  writeFileSync(transcriptPath, records(1000).map(line).join(""));
  const binding = await recordSessionStart(config, { hook_event_name: "SessionStart", session_id: nativeSessionId, transcript_path: transcriptPath }, at);
  const hook = TraceMemory(config.dbPath, async () => { throw new Error("provider forbidden"); });
  try { expect((await new CcProjection(config, binding, hook).synchronize()).selectedEntryIds).toHaveLength(2000); }
  finally { hook.close(); }
  const importer = new CcImporter(config, readBinding(config, nativeSessionId)!);
  const transaction = vi.spyOn(importer.memory.store, "transaction");
  const eligibility = vi.spyOn(importer.memory, "taskEligibility");
  const scheduler = new CcTaskScheduler(importer.memory, undefined, () => {});
  try {
    const resumed = await importer.reconcile();
    expect(resumed.bootstrap).toBe(true);
    expect(resumed.appendedEntryIds).toEqual([]);
    expect(resumed.selectedEntryIds).toHaveLength(2000);
    expect(transaction.mock.calls.length).toBeLessThan(10);
    scheduler.reconcile(resumed);
    expect(eligibility).not.toHaveBeenCalled();
    expect((await importer.reconcile()).bootstrap).toBe(false);
    const next = records(1001).slice(-2);
    appendFileSync(transcriptPath, next.map(line).join(""));
    const live = await importer.reconcile();
    expect(live.bootstrap).toBe(false);
    expect(live.appendedEntryIds).toHaveLength(2);
    scheduler.reconcile(live);
    expect(eligibility).not.toHaveBeenCalled(); // Entry ingestion is not a checkpoint.
    scheduler.turnEnd(live, scheduler.catchupTicket());
    expect(eligibility.mock.calls.map(([phase, target]) => [phase, target.triggerEntryId])).toEqual([
      ["noting", live.appendedEntryIds[1]], ["dreaming", live.appendedEntryIds[1]],
    ]);
  } finally { scheduler.stop(); eligibility.mockRestore(); transaction.mockRestore(); importer.close(); rmSync(dir, { recursive: true, force: true }); }
});
