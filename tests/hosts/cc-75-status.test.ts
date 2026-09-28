// Ticket 75: the CC status publisher and status command.
import { afterEach, expect, test, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { readBinding, recordSessionStart, updateBinding, type CcExecutorBinding } from "../../src/hosts/cc/binding.ts";
import { controlSession } from "../../src/hosts/cc/control.ts";
import { CcCoordinator } from "../../src/hosts/cc/lifecycle.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { handleCcHook } from "../../src/hosts/cc/index.ts";
import { readCcStatus, removeCcStatus, statusPath, writeCcStatus, type CcStatusFile } from "../../src/hosts/cc/status.ts";
import { runCcStatusCommand } from "../../src/hosts/cc/status-entry.ts";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const until = async (condition: () => boolean, timeoutMs = 3_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) { if (Date.now() > deadline) throw new Error("condition not met in time"); await sleep(10); }
};
const sample: CcStatusFile = { version: 1, nativeSessionId: "s1", executorId: "e1", pid: process.pid, token: "tok",
  updatedAt: "2026-01-01T00:00:00Z", enabled: true, running: { noting: false, dreaming: false },
  counts: { entries: 24, facts: 102, changedKnowledge: 252, knowledge: 306 }, cost: 0.12 };

// --- status.ts: the atomic writer/reader -----------------------------------------------------------

test("writeCcStatus is atomic (write, fsync, rename) and readCcStatus round-trips it", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm75-status-")); dirs.push(dir);
  writeCcStatus(dir, sample);
  expect(readCcStatus(dir, "s1")).toEqual(sample);
  const target = statusPath(dir, "s1");
  expect(readFileSync(target, "utf8").trim()).toBe(JSON.stringify(sample));
  expect(existsSync(join(dir, "status"))).toBe(true);
  // no stray temporary files left behind
  expect(readdirSync(join(dir, "status"))).toEqual(["s1.json"]);
});

test("readCcStatus returns null for a missing file and removeCcStatus is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "tm75-status-")); dirs.push(dir);
  expect(readCcStatus(dir, "missing")).toBeNull();
  removeCcStatus(dir, "missing"); // never throws for an absent file
  writeCcStatus(dir, sample);
  removeCcStatus(dir, "s1");
  expect(readCcStatus(dir, "s1")).toBeNull();
  removeCcStatus(dir, "s1"); // idempotent
});

// --- scheduler.ts: notify at admission and at settlement --------------------------------------------

const worker = resolveCcHostConfig({ dbPath: "/tmp/unused-75.db", stateDir: "/tmp/unused-75",
  notingModel: "synthetic", notingThinking: "medium",
  "dreaming.model": "synthetic", "dreaming.thinking": "medium",
  worker: { cwd: "/tmp", claudeExecutable: "/missing/claude", claudeVersion: "2.1.280", contextWindows: { synthetic: 200_000 } } }).worker;
const projection = { state: "ready" as const, coreSessionId: 1, branch: "main", headTurnId: 1,
  selectedEntryIds: [1, 2], selectedCount: 2, selectedTailId: 2,
  selectedAppendedEntryIds: [1, 2], appendedEntryIds: [1, 2], problems: [], snapshot: {} as any, bootstrap: true };

test("scheduler notifies admission and settlement, and a failing notify never blocks a task", async () => {
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  let release!: (value: unknown) => void;
  const memory = { executorId: "ours", config: { closedSessionScope: "project" },
    store: { enabled: () => true, pendingEntryIds: () => [1, 2], getClaim: () => null, closedTasks: () => [],
      getSourceEntry: (id: number) => ({ id, turnId: 1 }), progressSignal: () => "s0" },
    taskEligibility: vi.fn((phase: string) => ({ due: phase === "noting" })),
    noting: vi.fn(async () => { await new Promise(resolve => { release = resolve; }); return { outcome: "success", facts: [] }; }),
    dream: vi.fn(async () => ({ outcome: "success" })) };
  const calls: string[] = [];
  const scheduler = new CcTaskScheduler(memory as any, worker, () => {}, reason => { calls.push(reason); });
  scheduler.reconcile(projection);
  await tick();
  expect(calls).toEqual(["noting admitted"]); // admission fires synchronously, before the run settles
  release(undefined);
  await until(() => calls.length > 1);
  expect(calls).toEqual(["noting admitted", "noting settled"]);
});

test("a throwing notify never prevents admission or settlement (fault isolation)", async () => {
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const memory = { executorId: "ours", config: { closedSessionScope: "project" },
    store: { enabled: () => true, pendingEntryIds: () => [1, 2], getClaim: () => null, closedTasks: () => [],
      getSourceEntry: (id: number) => ({ id, turnId: 1 }), progressSignal: () => "s0" },
    taskEligibility: vi.fn((phase: string) => ({ due: phase === "noting" })),
    noting: vi.fn(async () => ({ outcome: "success", facts: [] })), dream: vi.fn() };
  const scheduler = new CcTaskScheduler(memory as any, worker, () => {}, () => { throw new Error("publish exploded"); });
  scheduler.reconcile(projection);
  await tick(); await tick();
  expect(memory.noting).toHaveBeenCalledTimes(1); // admission proceeded despite the throwing hook
});

// --- lifecycle.ts: the publisher wired into a real CcCoordinator ------------------------------------

function fixture(label: string, overrides: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `tm75-cc-${label}-`)); dirs.push(dir);
  // Short basename keeps the control socket below 100 bytes with a task-local TMPDIR.
  const stateDir = mkdtempSync(join(tmpdir(), "s")); dirs.push(stateDir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = `native-${label}`;
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir, baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 20, finalSyncTimeoutMs: 300, finalSyncStablePolls: 2,
    notingModel: "synthetic", notingThinking: "medium",
    "dreaming.model": "synthetic", "dreaming.thinking": "medium", "noting.triggerTokens": 1,
    worker: { claudeExecutable: "/missing/claude", claudeVersion: "2.1.280", contextWindows: { synthetic: 200_000 }, cwd: dir,
      responseOriginTimeoutMs: 20 },
    ...overrides });
  const records = [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: "2026-01-01T00:00:00.000Z", promptId: "p1", promptSource: "sdk", userType: "external", message: { role: "user", content: "question" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "last-prompt", leafUuid: "a1" },
  ];
  writeFileSync(transcriptPath, records.map(record => `${JSON.stringify(record)}\n`).join(""));
  return { dir, stateDir, transcriptPath, nativeSessionId, config };
}

/** Wrap the coordinator's private `publish` so tests can observe every call while its real (private)
 * implementation still runs — a spy, not a stub. */
function trackPublish(coordinator: CcCoordinator): string[] {
  const calls: string[] = [];
  const target = coordinator as unknown as { publish: (reason: string) => void };
  const original = target.publish.bind(coordinator);
  target.publish = (reason: string) => { calls.push(reason); original(reason); };
  return calls;
}

test("attach and the first reconcile publish; admission and settlement publish too; an unchanged stat wake-up publishes nothing", async () => {
  const f = fixture("lifecycle");
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  const calls = trackPublish(coordinator);
  try {
    await coordinator.start(); // attach + first reconcile; noting is due (triggerTokens: 1) and gets admitted
    expect(calls).toContain("startup");
    expect(calls).toContain("noting admitted");
    const executor = readBinding(f.config, f.nativeSessionId)!.executor!;
    let status = readCcStatus(f.stateDir, f.nativeSessionId)!;
    expect(status).toMatchObject({ nativeSessionId: f.nativeSessionId, executorId: executor.executorId, pid: executor.pid,
      token: executor.token, enabled: true });
    expect(status.counts).toEqual({ entries: 2, facts: 0, changedKnowledge: 0, knowledge: 0 });
    expect(status.running).toEqual({ noting: true, dreaming: false }); // admitted, not settled yet

    await until(() => calls.includes("noting settled")); // the missing executable fails fast
    status = readCcStatus(f.stateDir, f.nativeSessionId)!;
    expect(status.running).toEqual({ noting: false, dreaming: false });

    // A stat wake-up with nothing appended and the same path/state changes nothing: no new publish.
    calls.length = 0;
    const before = statSync(statusPath(f.stateDir, f.nativeSessionId)).mtimeMs;
    await coordinator.requestReconcile("stat wake-up");
    await sleep(20);
    expect(calls).toEqual([]);
    expect(statSync(statusPath(f.stateDir, f.nativeSessionId)).mtimeMs).toBe(before);
  } finally { await coordinator.shutdown("test"); }
});

test("off/on transitions publish through the reconcile the binding watch already triggers", async () => {
  const f = fixture("onoff", { pollIntervalMs: 60_000, "noting.triggerTokens": 10_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  try {
    await coordinator.start();
    expect(readCcStatus(f.stateDir, f.nativeSessionId)!.enabled).toBe(true);
    const coreSessionId = readBinding(f.config, f.nativeSessionId)!.coreSessionId!;
    // The real off/on path (control.ts's `disableEnrollment`) updates the Store's own enrollment
    // record and mirrors it onto the binding together, under the binding lock; reproduce both here.
    const store = new Store(f.config.dbPath);
    try {
      store.setEnrollment(coreSessionId, false);
      await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, enrollment: store.enrollment(coreSessionId) }));
      await coordinator.requestReconcile("binding watch");
      expect(readCcStatus(f.stateDir, f.nativeSessionId)!.enabled).toBe(false);
      store.setEnrollment(coreSessionId, true);
      await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, enrollment: store.enrollment(coreSessionId) }));
      await coordinator.requestReconcile("binding watch");
      expect(readCcStatus(f.stateDir, f.nativeSessionId)!.enabled).toBe(true);
    } finally { store.close(); }
  } finally { await coordinator.shutdown("test"); }
});

test("an automatic off recorded only in the Store publishes off, never the binding's stale on", async () => {
  // Production S136: three failed Noting runs switched the core session off (executions.ts), which
  // never touches the CC binding. The status file kept publishing the binding's `choice: true` while
  // every reconcile imported nothing because the session was off.
  const f = fixture("autooff", { pollIntervalMs: 60_000, "noting.triggerTokens": 10_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  try {
    await coordinator.start();
    expect(readCcStatus(f.stateDir, f.nativeSessionId)!.enabled).toBe(true);
    const coreSessionId = readBinding(f.config, f.nativeSessionId)!.coreSessionId!;
    const store = new Store(f.config.dbPath);
    try { store.setEnrollment(coreSessionId, false); } finally { store.close(); }
    expect(readBinding(f.config, f.nativeSessionId)!.enrollment.choice).not.toBe(false); // the binding still says on
    await coordinator.requestReconcile("binding watch");
    const status = readCcStatus(f.stateDir, f.nativeSessionId)!;
    expect(status.enabled).toBe(false);
    expect(status.counts).toBeUndefined(); // off counts nothing, as Pi's footer (24a)
    expect(status.cost).toBeUndefined();
  } finally { await coordinator.shutdown("test"); }
});

test("retarget writes under the new native session id and removes the old file", async () => {
  const f = fixture("retarget", { pollIntervalMs: 60_000 });
  const parentId = f.nativeSessionId, childId = "native-retarget-child", childTranscript = join(f.dir, "child.jsonl");
  vi.stubEnv("CLAUDE_PID", "90101");
  await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "startup", session_id: parentId, transcript_path: f.transcriptPath });
  const coordinator = new CcCoordinator(f.config, parentId, () => {});
  try {
    await coordinator.start();
    expect(readCcStatus(f.stateDir, parentId)).not.toBeNull();
    writeFileSync(childTranscript, "");
    await handleCcHook(f.config, { hook_event_name: "SessionStart", source: "clear", session_id: childId, transcript_path: childTranscript });
    expect(await coordinator.retargetTo(childId)).toBe(true);
    expect(readCcStatus(f.stateDir, parentId)).toBeNull(); // the old file is gone
    // 102: the executor attaches to the new session as at startup, and publishes there.
    await vi.waitFor(() => expect(readCcStatus(f.stateDir, childId)).not.toBeNull());
    const moved = readCcStatus(f.stateDir, childId)!;
    expect(moved.nativeSessionId).toBe(childId);
    expect(moved.token).toBe(readBinding(f.config, childId)!.executor!.token);
  } finally { await coordinator.shutdown("test"); }
});

test("shutdown removes the file, but only while the binding still names this executor", async () => {
  const f = fixture("shutdown-owned", { pollIntervalMs: 60_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  await coordinator.start();
  expect(readCcStatus(f.stateDir, f.nativeSessionId)).not.toBeNull();
  await coordinator.shutdown("test");
  expect(readCcStatus(f.stateDir, f.nativeSessionId)).toBeNull();
});

test("a superseded executor's shutdown never deletes a newer executor's file", async () => {
  const f = fixture("shutdown-superseded", { pollIntervalMs: 60_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  await coordinator.start();
  expect(readCcStatus(f.stateDir, f.nativeSessionId)).not.toBeNull();
  // A newer executor claimed the binding (a real race would be a new process attaching); this
  // coordinator's own shutdown must leave that newer executor's file alone.
  const newer: CcExecutorBinding = { executorId: "newer", pid: process.pid, token: "newer-token", socketPath: join(f.dir, "newer.sock"), startedAt: new Date().toISOString() };
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: newer }));
  writeCcStatus(f.stateDir, { ...readCcStatus(f.stateDir, f.nativeSessionId)!, executorId: newer.executorId, pid: newer.pid, token: newer.token });
  await coordinator.shutdown("test");
  const survivor = readCcStatus(f.stateDir, f.nativeSessionId);
  expect(survivor).not.toBeNull();
  expect(survivor!.token).toBe("newer-token");
});

test("a superseded executor's late publish never overwrites a newer executor's file", async () => {
  const f = fixture("publish-superseded", { pollIntervalMs: 60_000, "noting.triggerTokens": 10_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  try {
    await coordinator.start();
    const newer: CcExecutorBinding = { executorId: "newer", pid: process.pid, token: "newer-token", socketPath: join(f.dir, "newer.sock"), startedAt: new Date().toISOString() };
    await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: newer }));
    writeCcStatus(f.stateDir, { ...readCcStatus(f.stateDir, f.nativeSessionId)!, executorId: newer.executorId, pid: newer.pid, token: newer.token });
    // Force a would-be publish from the superseded coordinator: an appended-entries reconcile.
    writeFileSync(f.transcriptPath, readFileSync(f.transcriptPath, "utf8") +
      `${JSON.stringify({ uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", promptId: "p2", promptSource: "sdk", userType: "external", message: { role: "user", content: "more" } })}\n`);
    await coordinator.requestReconcile("transcript watch");
    const status = readCcStatus(f.stateDir, f.nativeSessionId)!;
    expect(status.token).toBe("newer-token"); // untouched by the superseded coordinator
  } finally {
    // Restore ownership before shutdown so cleanup does not itself race the (fake) newer executor.
    await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: (coordinator as any).control?.executor ?? null }));
    await coordinator.shutdown("test");
  }
});

// --- fault injection: progress/cost/write failures never touch task, control or shutdown outcomes --

test("a failing progress or cost read renders ? and logs a diagnostic; the reconcile itself is unaffected", async () => {
  const f = fixture("fault-read", { pollIntervalMs: 60_000, "noting.triggerTokens": 10_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostics.push(message));
  try {
    const first = await coordinator.start();
    expect(readCcStatus(f.stateDir, f.nativeSessionId)!.counts).toBeDefined();
    const importer = (coordinator as any).importer;
    importer.memory.progress = () => { throw new Error("injected progress failure"); };
    importer.memory.spendSince = () => { throw new Error("injected cost failure"); };
    writeFileSync(f.transcriptPath, readFileSync(f.transcriptPath, "utf8") +
      `${JSON.stringify({ uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", promptId: "p2", promptSource: "sdk", userType: "external", message: { role: "user", content: "more" } })}\n`);
    const result = await coordinator.requestReconcile("transcript watch");
    expect(result?.state).toBe("ready"); // the reconcile itself succeeded despite both injected faults
    expect(result?.problems ?? []).toEqual([]);
    const status = readCcStatus(f.stateDir, f.nativeSessionId)!;
    expect(status.counts).toBeUndefined();
    expect(status.cost).toBeUndefined();
    expect(diagnostics.some(m => m.includes("status counts unavailable") && m.includes("injected progress failure"))).toBe(true);
    expect(diagnostics.some(m => m.includes("status cost unavailable") && m.includes("injected cost failure"))).toBe(true);
  } finally { await coordinator.shutdown("test"); }
});

test("a failing status write is a diagnostic, never a fault: task and shutdown outcomes are unaffected", async () => {
  const f = fixture("fault-write", { pollIntervalMs: 60_000, "noting.triggerTokens": 10_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostics.push(message));
  try {
    await coordinator.start();
    const statusDir = join(f.stateDir, "status");
    mkdirSync(statusDir, { recursive: true });
    chmodSync(statusDir, 0o555); // read+execute only: writeCcStatus's openSync must fail
    try {
      writeFileSync(f.transcriptPath, readFileSync(f.transcriptPath, "utf8") +
        `${JSON.stringify({ uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", promptId: "p2", promptSource: "sdk", userType: "external", message: { role: "user", content: "more" } })}\n`);
      const result = await coordinator.requestReconcile("transcript watch");
      expect(result?.state).toBe("ready");
      expect(diagnostics.some(m => m.includes("status publish failed"))).toBe(true);
    } finally { chmodSync(statusDir, 0o755); }
    const closeResult = await coordinator.shutdown("test"); // must complete cleanly despite the earlier write fault
    expect(closeResult.reason).not.toContain("status");
  } finally { if (!(coordinator as any).closed) await coordinator.shutdown("test"); }
});

// --- control-request latency is structurally independent of publishing ------------------------------

test("control off/on acknowledgement latency is unaffected even when publishing is made artificially slow", async () => {
  // control.ts never calls the publisher: `off`/`on` acknowledge over the socket before any reconcile
  // (and therefore any publish) runs. Proven directly, at any scale, by making publish itself slow and
  // showing the control round trip does not inherit that cost.
  const f = fixture("control-latency", { pollIntervalMs: 60_000, "noting.triggerTokens": 10_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  try {
    await coordinator.start();
    const baseline: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      expect((await controlSession(f.config, f.nativeSessionId, "stop")).state).toBe("acknowledged");
      baseline.push(performance.now() - t0);
    }
    const target = coordinator as unknown as { publish: (reason: string) => void };
    const original = target.publish.bind(coordinator);
    target.publish = (reason: string) => { const until = Date.now() + 200; while (Date.now() < until) { /* busy-wait: simulate a slow publish */ } original(reason); };
    const slowed: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      expect((await controlSession(f.config, f.nativeSessionId, "stop")).state).toBe("acknowledged");
      slowed.push(performance.now() - t0);
    }
    const median = (arr: number[]) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length / 2)]!;
    // The control round trip is unaffected by a publish that now costs 200 ms per call: it is on the
    // reconcile path the binding watch triggers asynchronously, never on the control reply path itself.
    expect(median(slowed)).toBeLessThan(median(baseline) + 50);
  } finally { await coordinator.shutdown("test"); }
});

// --- status-entry.ts: the status command ------------------------------------------------------------

function statusFixture(label: string) {
  const stateDir = mkdtempSync(join(tmpdir(), `tm75-cmd-${label}-`)); dirs.push(stateDir);
  const configPath = join(stateDir, "cc.config.json");
  writeFileSync(configPath, JSON.stringify({ stateDir, dbPath: "/nonexistent-dir-xyz/impossible.db" }));
  return { stateDir, configPath };
}
function seedBinding(stateDir: string, sessionId: string, executor: { token: string }) {
  mkdirSync(join(stateDir, "bindings"), { recursive: true });
  writeFileSync(join(stateDir, "bindings", `${sessionId}.json`), JSON.stringify({ executor }));
}
async function runCommand(configPath: string, input: unknown): Promise<string> {
  let out = "";
  await runCcStatusCommand({ argv: ["--config", configPath], readStdin: async () => JSON.stringify(input), write: line => { out += line; } });
  return out;
}

test("unbound session (no status file): prints nothing", async () => {
  const f = statusFixture("unbound");
  expect(await runCommand(f.configPath, { session_id: "s1" })).toBe("");
});

test("bound and alive: the formatted line, painted with the shared formatter's roles", async () => {
  const f = statusFixture("alive");
  seedBinding(f.stateDir, "s1", { token: "tok" });
  writeCcStatus(f.stateDir, { ...sample, nativeSessionId: "s1", token: "tok", pid: process.pid, running: { noting: true, dreaming: false } });
  const out = await runCommand(f.configPath, { session_id: "s1" });
  expect(out).toBe("🧠 \x1b[36m●\x1b[0m \x1b[2mnotes: 24->102 memory: 252/306 cost: $0.12\x1b[0m\n");
});

test("off: the compact line", async () => {
  const f = statusFixture("off");
  seedBinding(f.stateDir, "s1", { token: "tok" });
  writeCcStatus(f.stateDir, { ...sample, nativeSessionId: "s1", token: "tok", pid: process.pid, enabled: false });
  expect(await runCommand(f.configPath, { session_id: "s1" })).toBe("🧠 \x1b[2m○ off\x1b[0m\n");
});

test("dreaming paints customMessageLabel", async () => {
  const f = statusFixture("phases");
  seedBinding(f.stateDir, "s1", { token: "tok" });
  writeCcStatus(f.stateDir, { ...sample, nativeSessionId: "s1", token: "tok", pid: process.pid, running: { noting: false, dreaming: true } });
  expect(await runCommand(f.configPath, { session_id: "s1" })).toContain("\x1b[35m●\x1b[0m");
});

test("dead executor pid: every count and cost render ?, idle ○, never a stale running ●", async () => {
  const f = statusFixture("dead");
  seedBinding(f.stateDir, "s1", { token: "tok" });
  // A pid essentially guaranteed not to exist.
  writeCcStatus(f.stateDir, { ...sample, nativeSessionId: "s1", token: "tok", pid: 2_000_000_000, running: { noting: true, dreaming: false } });
  const out = await runCommand(f.configPath, { session_id: "s1" });
  expect(out).toBe("🧠 \x1b[2m○\x1b[0m \x1b[2mnotes: ?->? memory: ?/? cost: $?\x1b[0m\n");
});

test("binding now names another executor: rendered exactly like a dead one", async () => {
  const f = statusFixture("stale-owner");
  seedBinding(f.stateDir, "s1", { token: "someone-else" });
  writeCcStatus(f.stateDir, { ...sample, nativeSessionId: "s1", token: "tok", pid: process.pid, running: { noting: true, dreaming: false } });
  const out = await runCommand(f.configPath, { session_id: "s1" });
  expect(out).toBe("🧠 \x1b[2m○\x1b[0m \x1b[2mnotes: ?->? memory: ?/? cost: $?\x1b[0m\n");
});

test("malformed stdin, missing session_id, or a malformed status file: prints nothing and never throws", async () => {
  const f = statusFixture("malformed");
  await expect(runCcStatusCommand({ argv: ["--config", f.configPath], readStdin: async () => "not json", write: () => { throw new Error("must not be called"); } })).resolves.toBeUndefined();
  await expect(runCommand(f.configPath, {})).resolves.toBe(""); // no session_id
  seedBinding(f.stateDir, "s1", { token: "tok" });
  mkdirSync(join(f.stateDir, "status"), { recursive: true });
  writeFileSync(join(f.stateDir, "status", "s1.json"), "not json");
  await expect(runCommand(f.configPath, { session_id: "s1" })).resolves.toBe("");
  // Bad argv/config likewise prints nothing rather than throwing.
  await expect(runCcStatusCommand({ argv: [], readStdin: async () => "{}" })).resolves.toBeUndefined();
});

test("92: historical C spend remains in the real coordinator total without a live C row", async () => {
  const f = fixture("historical", { pollIntervalMs: 60_000, "noting.triggerTokens": 10_000 });
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, "2026-01-01T00:00:00.000Z");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  try {
    await coordinator.start();
    const sessionId = readBinding(f.config, f.nativeSessionId)!.coreSessionId!;
    const store = new Store(f.config.dbPath);
    try {
      const run = store.recordRun({ kind: "consolidation", sessionId, branch: "main", createdAt: new Date().toISOString(), outcome: "success",
        response: JSON.stringify({ nativeLog: "/historical/consolidator.jsonl", usage: { input: 100, output: 20, cost: { total: 0.5 } } }) });
      writeFileSync(f.transcriptPath, readFileSync(f.transcriptPath, "utf8") + `${JSON.stringify({ uuid: "u2", parentUuid: "a1", type: "user",
        timestamp: "2026-01-01T00:00:02.000Z", promptId: "p2", promptSource: "sdk", userType: "external", message: { role: "user", content: "more" } })}\n`);
      await coordinator.requestReconcile("new completed entry");
      expect(readCcStatus(f.stateDir, f.nativeSessionId)).toMatchObject({ cost: 0.5, running: { noting: false, dreaming: false } });
      expect(readCcStatus(f.stateDir, f.nativeSessionId)!.running).not.toHaveProperty("consolidation");
      expect(store.getRun(run.id)).toMatchObject({ kind: "consolidation", outcome: "success" });
      expect(JSON.parse(store.getRun(run.id)!.response!).nativeLog).toBe("/historical/consolidator.jsonl");
    } finally { store.close(); }
  } finally { await coordinator.shutdown("test"); }
});

test("the status command opens no database: an impossible dbPath is never touched", async () => {
  const f = statusFixture("no-db");
  seedBinding(f.stateDir, "s1", { token: "tok" });
  writeCcStatus(f.stateDir, { ...sample, nativeSessionId: "s1", token: "tok", pid: process.pid });
  const out = await runCommand(f.configPath, { session_id: "s1" }); // dbPath points at a directory that does not exist
  expect(out).toContain("notes: 24->102");
  expect(existsSync("/nonexistent-dir-xyz")).toBe(false); // nothing created it
});
