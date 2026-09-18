import { afterEach, expect, test, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
import { TraceMemory } from "../../src/core/api/index.ts";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { bindingMutexPath, bindingPath, readBinding, recordSessionStart, updateBinding, type CcExecutorBinding } from "../../src/hosts/cc/binding.ts";
import { controlSession, startControlServer } from "../../src/hosts/cc/control.ts";
import { CcCoordinator, recordCcSessionEnd } from "../../src/hosts/cc/lifecycle.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import type { CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = "2026-01-01T00:00:00.000Z";
const sdkPrompt = (promptId: string) => ({ promptId, promptSource: "sdk", userType: "external" });
function fixture(label = "lifecycle") {
  const dir = mkdtempSync(join(tmpdir(), `tm-cc-${label}-`)); dirs.push(dir);
  const transcriptPath = join(dir, "native.jsonl"), nativeSessionId = `native-${label}`;
  const config = resolveCcHostConfig({ dbPath: join(dir, "memory.sqlite"), stateDir: join(dir, "s"), baseline: "2025-01-01T00:00:00.000Z",
    pollIntervalMs: 10, finalSyncTimeoutMs: 300, finalSyncStablePolls: 2 });
  const records: CcNativeRecord[] = [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: now, ...sdkPrompt("p1"), message: { role: "user", content: "question" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
    { type: "last-prompt", leafUuid: "a1" },
  ];
  return { dir, transcriptPath, nativeSessionId, config, records, write: () => writeFileSync(transcriptPath, records.map(record => `${JSON.stringify(record)}\n`).join("")) };
}
const sleep = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));
const directControl = (executor: CcExecutorBinding, verb: unknown) =>
  new Promise<any>((resolveReply, reject) => {
    const socket = createConnection(executor.socketPath); let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb, token: executor.token })}\n`));
    socket.on("data", chunk => output += chunk);
    socket.on("end", () => { try { resolveReply(JSON.parse(output)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
const childScript = resolve("tests/hosts/cc-binding-child.ts");
const spawnBindingChild = (mode: "update" | "control", input: Record<string, unknown>): ChildProcess => spawn(process.execPath,
  [childScript, mode], { cwd: resolve("."), env: { ...process.env, CC_BINDING_CHILD_INPUT: JSON.stringify(input) },
    stdio: ["ignore", "ignore", "inherit", "ipc"] });
const childMessage = (child: ChildProcess, type: string, timeoutMs = 3_000): Promise<Record<string, unknown>> => new Promise((resolveMessage, reject) => {
  const timer = setTimeout(() => { cleanup(); reject(new Error(`child ${child.pid} did not report ${type}`)); }, timeoutMs);
  const message = (value: unknown) => {
    const record = value as Record<string, unknown>;
    if (record.type !== type) return;
    cleanup(); resolveMessage(record);
  };
  const exit = (code: number | null, signal: NodeJS.Signals | null) => {
    cleanup(); reject(new Error(`child ${child.pid} exited before ${type}: code=${code} signal=${signal}`));
  };
  const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); };
  child.on("message", message); child.on("exit", exit);
});
const childExit = (child: ChildProcess, timeoutMs = 3_000): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`child ${child.pid} did not exit`)); }, timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolveExit(); });
  });
};

test("owner-token stop uses the facade's owned task path and leaves another executor running", async () => {
  const f = fixture("control"); f.write();
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  let ownerAborted = false, otherAborted = false, releaseOther!: () => void;
  const blocked = (owner: boolean) => async (input: unknown) => {
    const signal = (input as { signal: AbortSignal }).signal;
    await new Promise<void>(resolve => {
      if (owner) signal.addEventListener("abort", () => { ownerAborted = true; resolve(); }, { once: true });
      else { releaseOther = resolve; signal.addEventListener("abort", () => { otherAborted = true; resolve(); }, { once: true }); }
    });
    return { outcome: "cancelled" as const, output: null };
  };
  const owner = TraceMemory(f.config.dbPath, blocked(true)), other = TraceMemory(f.config.dbPath, blocked(false));
  const project = owner.store.createProject({ name: "control", declaredBy: "mark" });
  const seed = (memory: typeof owner, host: string) => {
    const session = memory.store.createSession({ projectId: project.id, host, startedAt: now, firstReplyAt: now, enrollmentChoice: true });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", startedAt: now });
    const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: host, nativeId: `${host}-entry`, role: "user", text: "pending", raw: "{}", calls: [] });
    memory.selectEntries(session.id, "main", [entry.id]); return { session, turn };
  };
  const a = seed(owner, `cc:${f.nativeSessionId}`), b = seed(other, "other");
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, coreSessionId: a.session.id, projectId: project.id }));
  const server = await startControlServer(f.config, readBinding(f.config, f.nativeSessionId)!, owner);
  try {
    const ownerRun = owner.noting({ sessionId: a.session.id, branch: "main", headTurnId: a.turn.id, mode: "subagent" });
    const otherRun = other.noting({ sessionId: b.session.id, branch: "main", headTurnId: b.turn.id, mode: "subagent" });
    for (let i = 0; i < 100 && owner.store.getClaim(a.session.id, "noting")?.executorId !== owner.executorId; i++) await sleep(2);
    const controlled = await controlSession(f.config, f.nativeSessionId, "stop", 2_000);
    expect(controlled.state).toBe("acknowledged");
    if (controlled.state !== "acknowledged") throw new Error("stop was not acknowledged");
    expect(controlled.reply.abortRequested).toEqual([expect.objectContaining({ sessionId: a.session.id, phase: "noting", executionId: expect.any(String) })]);
    await ownerRun; expect(ownerAborted).toBe(true); expect(owner.store.getClaim(a.session.id, "noting")).toBeNull();
    ownerAborted = false;
    const ownerRetry = owner.noting({ sessionId: a.session.id, branch: "main", headTurnId: a.turn.id, mode: "subagent" });
    for (let i = 0; i < 100 && owner.store.getClaim(a.session.id, "noting")?.executorId !== owner.executorId; i++) await sleep(2);
    const off = await controlSession(f.config, f.nativeSessionId, "off", 2_000);
    expect(off.state).toBe("acknowledged"); await ownerRetry;
    expect(ownerAborted).toBe(true); expect(owner.store.enrollment(a.session.id).choice).toBe(false);
    expect(otherAborted).toBe(false); expect(other.store.getClaim(b.session.id, "noting")?.executorId).toBe(other.executorId);
    releaseOther(); await otherRun;
  } finally { await server.close(); owner.close(); other.close(); }
});

test("control socket routes catchup to the live executor and never creates an operator worker", async () => {
  const f = fixture("control-catchup"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-catchup-"); dirs.push(f.config.stateDir);
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const memory = TraceMemory(f.config.dbPath, async () => ({ outcome: "failure" as const, output: "must not run" }));
  let calls = 0;
  const server = await startControlServer(f.config, binding, memory, undefined, undefined, {
    catchup: async () => { calls++; return { state: "waiting", phase: "noting", entriesDone: 0, entriesTotal: 2, factsDone: 0, factsTotal: 0 }; },
    beforeCancel: () => {},
  });
  try {
    const result = await controlSession(f.config, f.nativeSessionId, "catchup");
    expect(result).toMatchObject({ state: "acknowledged", reply: { verb: "catchup", abortRequested: [],
      catchup: { state: "waiting", phase: "noting", entriesTotal: 2 } } });
    expect(calls).toBe(1);
    await expect(directControl(server.executor, ["off"])).resolves.toMatchObject({ ok: false, error: "invalid CC control request" });
  } finally { await server.close(); memory.close(); }
});

test("off fences again after a contended disable before acknowledging", async () => {
  const f = fixture("off-disable-window"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-off-window-"); dirs.push(f.config.stateDir);
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const memory = TraceMemory(f.config.dbPath, async () => ({ outcome: "failure" as const, output: "must not run" }));
  let cancellations = 0;
  const before = { sessionId: 1, phase: "noting" as const, executionId: "before-disable" };
  const during = { sessionId: 1, phase: "consolidation" as const, executionId: "during-disable" };
  const cancel = vi.spyOn(memory, "cancelTasks").mockReturnValueOnce([before]).mockReturnValueOnce([before, during]);
  const server = await startControlServer(f.config, binding, memory, undefined, undefined, {
    catchup: async () => ({ state: "completed", entriesDone: 0, entriesTotal: 0, factsDone: 0, factsTotal: 0 }),
    beforeCancel: () => { cancellations++; },
  });
  const mutex = new DatabaseSync(bindingMutexPath(f.config, f.nativeSessionId), { timeout: 0 }); mutex.exec("BEGIN IMMEDIATE");
  try {
    const disabling = directControl(server.executor, "off");
    for (let i = 0; i < 100 && cancellations < 1; i++) await sleep(2);
    expect(cancellations).toBe(1);
    mutex.exec("ROLLBACK"); mutex.close();
    await expect(disabling).resolves.toMatchObject({ ok: true, verb: "off", abortRequested: [before, during] });
    expect(cancellations).toBe(2);
    expect(cancel).toHaveBeenCalledTimes(2);
  } finally {
    try { mutex.exec("ROLLBACK"); } catch {}
    try { mutex.close(); } catch {}
    cancel.mockRestore(); await server.close(); memory.close();
  }
});

test("control stop fences catchup while coordinator reconciliation is blocked", async () => {
  const f = fixture("catchup-stop-race"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-race-"); dirs.push(f.config.stateDir);
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  await coordinator.start();
  const executor = readBinding(f.config, f.nativeSessionId)!.executor!;
  f.records.splice(-1, 1,
    { uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", ...sdkPrompt("p2"), message: { role: "user", content: "later" } },
    { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "later answer" }] } },
    { type: "last-prompt", leafUuid: "a2" });
  f.write();
  const mutex = new DatabaseSync(bindingMutexPath(f.config, f.nativeSessionId), { timeout: 0 }); mutex.exec("BEGIN IMMEDIATE");
  try {
    const catching = directControl(executor, "catchup");
    await sleep(20);
    const stopped = await directControl(executor, "stop");
    expect(stopped).toMatchObject({ ok: true, verb: "stop" });
    mutex.exec("ROLLBACK"); mutex.close();
    await expect(catching).resolves.toMatchObject({ ok: true, verb: "catchup",
      catchup: { state: "failed", diagnostic: "catchup was cancelled before admission" } });
  } finally {
    try { mutex.exec("ROLLBACK"); } catch {}
    try { mutex.close(); } catch {}
    await coordinator.shutdown("test");
  }
});

test("stop also fences the first attach opportunity while initial import is in flight", async () => {
  const f = fixture("initial-reconcile-stop");
  f.config.stateDir = mkdtempSync("/tmp/tmcc-initial-"); dirs.push(f.config.stateDir);
  f.config.pollIntervalMs = 100_000;
  f.config.worker = { claudeExecutable: "/missing/claude", claudeVersion: "2.1.257", model: "synthetic",
    effort: "medium", contextWindow: 200_000, cwd: f.dir, responseOriginTimeoutMs: 20 };
  f.records[0]!.message = { role: "user", content: "pending ".repeat(12_000) }; f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const imported = new Promise<void>(resolve => { reached = resolve; });
  const original = CcImporter.prototype.reconcile;
  const spy = vi.spyOn(CcImporter.prototype, "reconcile").mockImplementation(async function (this: CcImporter) {
    const result = await original.call(this); reached(); await held; return result;
  });
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  try {
    const starting = coordinator.start(); await imported;
    const noting = vi.fn(async () => ({ outcome: "success", facts: [] }));
    ((coordinator as any).importer.memory as any).noting = noting;
    ((coordinator as any).importer.memory as any).taskEligibility = (phase: string) => ({ due: phase === "noting" });
    expect(await directControl(readBinding(f.config, f.nativeSessionId)!.executor!, "stop")).toMatchObject({ ok: true, verb: "stop" });
    release(); await starting; await sleep(0);
    expect(noting).not.toHaveBeenCalled();
  } finally { release(); spy.mockRestore(); await coordinator.shutdown("test"); }
});

test("stop invalidates an entry opportunity frozen before an in-flight reconcile result", async () => {
  const f = fixture("reconcile-stop-epoch"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-epoch-"); dirs.push(f.config.stateDir);
  f.config.pollIntervalMs = 100_000;
  f.config.worker = { claudeExecutable: "/missing/claude", claudeVersion: "2.1.257", model: "synthetic",
    effort: "medium", contextWindow: 200_000, cwd: f.dir, responseOriginTimeoutMs: 20 };
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  await coordinator.start();
  const internal = coordinator as any, importer = internal.importer as CcImporter;
  const noting = vi.fn(async () => ({ outcome: "success", facts: [] }));
  (importer.memory as any).noting = noting;
  (importer.memory as any).taskEligibility = (phase: string) => ({ due: phase === "noting" });
  const original = importer.reconcile.bind(importer);
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const imported = new Promise<void>(resolve => { reached = resolve; });
  let gate = true;
  (importer as any).reconcile = async () => {
    const result = await original();
    if (gate) { reached(); await held; }
    return result;
  };
  const long = "pending ".repeat(12_000);
  f.records.splice(-1, 1,
    { uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", ...sdkPrompt("p2"), message: { role: "user", content: long } },
    { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "later answer" }] } },
    { type: "last-prompt", leafUuid: "a2" });
  f.write();
  const opportunity = coordinator.requestReconcile("held entry opportunity");
  await imported;
  expect(await directControl(readBinding(f.config, f.nativeSessionId)!.executor!, "stop")).toMatchObject({ ok: true, verb: "stop" });
  gate = false; release(); await opportunity; await sleep(0);
  expect(noting).not.toHaveBeenCalled();

  f.records.splice(-1, 1,
    { uuid: "u3", parentUuid: "a2", type: "user", timestamp: "2026-01-01T00:00:04.000Z", ...sdkPrompt("p3"), message: { role: "user", content: long } },
    { uuid: "a3", parentUuid: "u3", type: "assistant", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "new answer" }] } },
    { type: "last-prompt", leafUuid: "a3" });
  try {
    f.write(); await coordinator.requestReconcile("new entry opportunity");
    // Watch events can coalesce with this request; admission is asynchronous, not a one-tick contract.
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(1));
  } finally { await coordinator.shutdown("test"); }
});

test("separate-process same-session contenders publish one live executor and losing cleanup preserves its socket", async () => {
  const f = fixture("control-race"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-owner-"); dirs.push(f.config.stateDir);
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const children: ChildProcess[] = [];
  let winner: ChildProcess | null = null;
  try {
    for (let index = 0; index < 4; index++) {
      const child = spawnBindingChild("control", { config: f.config, nativeSessionId: f.nativeSessionId, worker: `control-${index}` });
      children.push(child); await childMessage(child, "ready");
    }
    const outcomes = children.map(child => new Promise<Record<string, unknown>>((resolveOutcome, reject) => {
      const timer = setTimeout(() => reject(new Error(`control contender ${child.pid} did not settle`)), 3_000);
      const message = (value: unknown) => {
        const record = value as Record<string, unknown>;
        if (record.type !== "fulfilled" && record.type !== "rejected" && record.type !== "failed") return;
        clearTimeout(timer); child.off("message", message); resolveOutcome(record);
      };
      child.on("message", message);
    }));
    children.forEach(child => child.send({ type: "go" }));
    const settled = await Promise.all(outcomes);
    expect(settled.filter(result => result.type === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.type === "rejected")).toHaveLength(3);
    expect(settled.filter(result => result.type === "rejected").every(result =>
      String(result.error).includes("already has a live executor"))).toBe(true);
    const winnerIndex = settled.findIndex(result => result.type === "fulfilled"); winner = children[winnerIndex]!;
    await Promise.all(children.filter(child => child !== winner).map(child => childExit(child)));
    const durable = readBinding(f.config, f.nativeSessionId)!.executor!;
    expect(durable.token).toBe((settled[winnerIndex]!.executor as { token: string }).token);
    expect(durable.pid).toBe(winner.pid); expect(existsSync(durable.socketPath)).toBe(true);
    expect((await controlSession(f.config, f.nativeSessionId, "stop")).state).toBe("acknowledged");
  } finally {
    if (winner?.connected) winner.send({ type: "close" });
    for (const child of children) if (child.exitCode === null && child.signalCode === null && child !== winner) child.kill("SIGKILL");
    if (winner) await childExit(winner);
    await Promise.all(children.filter(child => child !== winner).map(child => childExit(child).catch(() => {})));
  }
});

test("live provisional off survives the allocation transition and cannot be revived by reconciliation", async () => {
  const f = fixture("provisional-off"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-off-"); dirs.push(f.config.stateDir);
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const memory = TraceMemory(f.config.dbPath, async () => ({ outcome: "cancelled" as const, output: null }));
  const server = await startControlServer(f.config, binding, memory);
  try {
    expect(await controlSession(f.config, f.nativeSessionId, "off")).toMatchObject({ state: "acknowledged" });
    expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ coreSessionId: null, enrollment: { choice: false } });
    const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    try {
      expect((await importer.reconcile()).state).toBe("disabled");
      expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ coreSessionId: null, enrollment: { choice: false } });
    } finally { importer.close(); }
  } finally { await server.close(); memory.close(); }
});

test("off and executor startup serialize through the binding lock without reviving provisional enrollment", async () => {
  const f = fixture("off-start-race"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-off-race-"); dirs.push(f.config.stateDir);
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const mutex = new DatabaseSync(bindingMutexPath(f.config, f.nativeSessionId), { timeout: 0 }); mutex.exec("BEGIN IMMEDIATE");
  const memory = TraceMemory(f.config.dbPath, async () => ({ outcome: "cancelled" as const, output: null }));
  const starting = startControlServer(f.config, binding, memory);
  const controlDirectory = join(f.config.stateDir, "control");
  for (let i = 0; i < 100 && !(existsSync(controlDirectory) && readdirSync(controlDirectory).some(name => name.endsWith(".sock"))); i++) await sleep(2);
  const disabling = controlSession(f.config, f.nativeSessionId, "off");
  mutex.exec("ROLLBACK"); mutex.close();
  const server = await starting;
  try {
    expect(["acknowledged", "not-running"]).toContain((await disabling).state);
    expect(readBinding(f.config, f.nativeSessionId)!.enrollment.choice).toBe(false);
    const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    try { expect((await importer.reconcile()).state).toBe("disabled"); }
    finally { importer.close(); }
  } finally { await server.close(); memory.close(); }
});

test("operator validation keeps its Store open through a contended binding lock for an allocated session", async () => {
  const f = fixture("operator-store-lock"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
  try { expect((await importer.reconcile()).coreSessionId).not.toBeNull(); } finally { importer.close(); }
  const mutex = new DatabaseSync(bindingMutexPath(f.config, f.nativeSessionId), { timeout: 0 }); mutex.exec("BEGIN IMMEDIATE");
  const disabling = controlSession(f.config, f.nativeSessionId, "off");
  await sleep(20); mutex.exec("ROLLBACK"); mutex.close();
  await expect(disabling).resolves.toMatchObject({ state: "not-running", enrollmentChanged: true });
  const store = new Store(f.config.dbPath);
  try { expect(store.enabled(readBinding(f.config, f.nativeSessionId)!.coreSessionId!)).toBe(false); }
  finally { store.close(); }
});

test("off persists without a live executor and live communication failure is not called not-running", async () => {
  const f = fixture("off"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  expect(await controlSession(f.config, f.nativeSessionId, "catchup")).toEqual({ state: "unavailable",
    diagnostic: "CC catchup requires the session's live executor" });
  expect(await controlSession(f.config, f.nativeSessionId, "off")).toEqual({ state: "not-running", enrollmentChanged: true });
  expect(readBinding(f.config, f.nativeSessionId)!.enrollment.choice).toBe(false);
  await updateBinding(f.config, f.nativeSessionId, binding => ({ ...binding!, executor: { executorId: "missing", pid: process.pid,
    token: "token", socketPath: join(f.dir, "absent.sock"), startedAt: now } }));
  const result = await controlSession(f.config, f.nativeSessionId, "stop", 50);
  expect(result.state).toBe("unknown");
  if (result.state === "unknown") expect(result.diagnostic).toContain("executor is live but stop communication failed");
});

test("SQLite binding mutex releases a killed owner and keeps separate-process critical sections exclusive", async () => {
  const f = fixture("dead-mutex"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const eventsPath = join(f.dir, "mutex-events.jsonl");
  const holder = spawnBindingChild("update", { config: f.config, nativeSessionId: f.nativeSessionId, worker: "holder" });
  const competitors = Array.from({ length: 6 }, (_, index) => spawnBindingChild("update",
    { config: f.config, nativeSessionId: f.nativeSessionId, worker: `competitor-${index}`, eventsPath, holdMs: 15 }));
  const children = [holder, ...competitors];
  try {
    await Promise.all(children.map(child => childMessage(child, "ready")));
    const entered = childMessage(holder, "entered"); holder.send({ type: "go" }); await entered;
    const probe = new DatabaseSync(bindingMutexPath(f.config, f.nativeSessionId), { timeout: 0 });
    expect(() => probe.exec("BEGIN IMMEDIATE")).toThrow(/locked/); probe.close();
    const attempting = competitors.map(child => childMessage(child, "attempting"));
    competitors.forEach(child => child.send({ type: "go" })); await Promise.all(attempting);
    const fulfilled = competitors.map(child => childMessage(child, "fulfilled"));
    holder.kill("SIGKILL"); await childExit(holder); await Promise.all(fulfilled); await Promise.all(competitors.map(child => childExit(child)));
    const events = readFileSync(eventsPath, "utf8").trim().split("\n").map(line => JSON.parse(line) as { event: string; worker: string });
    expect(events).toHaveLength(competitors.length * 2);
    let active: string | null = null;
    for (const event of events) {
      if (event.event === "start") { expect(active).toBeNull(); active = event.worker; }
      else { expect(active).toBe(event.worker); active = null; }
    }
    expect(active).toBeNull();
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(children.map(child => childExit(child).catch(() => {})));
  }
});

test("binding timeout and abort cover the full wait and never run a deferred callback", async () => {
  const f = fixture("mutex-deadline"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const holder = spawnBindingChild("update", { config: f.config, nativeSessionId: f.nativeSessionId, worker: "holder" });
  try {
    await childMessage(holder, "ready"); const entered = childMessage(holder, "entered"); holder.send({ type: "go" }); await entered;
    let timedCallback = false; const started = performance.now();
    await expect(updateBinding(f.config, f.nativeSessionId, current => { timedCallback = true; return current!; }, 50))
      .rejects.toThrow(`timed out waiting for CC binding lock for ${f.nativeSessionId}`);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(40); expect(elapsed).toBeLessThan(200); expect(timedCallback).toBe(false);
    const stillHeld = new DatabaseSync(bindingMutexPath(f.config, f.nativeSessionId), { timeout: 0 });
    expect(() => stillHeld.exec("BEGIN IMMEDIATE")).toThrow(/locked/); stillHeld.close();

    const abort = new AbortController(); let abortedCallback = false;
    const waiting = updateBinding(f.config, f.nativeSessionId, current => { abortedCallback = true; return current!; }, 1_000, abort.signal);
    abort.abort(new DOMException("test cancellation", "AbortError"));
    await expect(waiting).rejects.toMatchObject({ name: "AbortError" }); expect(abortedCallback).toBe(false);
    holder.kill("SIGKILL"); await childExit(holder);
    await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, lastClose: { at: now, reason: "after wait", confirmed: false } }));
    expect(timedCallback).toBe(false); expect(abortedCallback).toBe(false);
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    await childExit(holder).catch(() => {});
  }
});

test("an invalid binding mutex database fails explicitly without replacement", async () => {
  const f = fixture("invalid-mutex"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const mutex = bindingMutexPath(f.config, f.nativeSessionId); writeFileSync(mutex, "not a SQLite database");
  await expect(updateBinding(f.config, f.nativeSessionId, current => current!)).rejects.toThrow(/not a database/);
  expect(readFileSync(mutex, "utf8")).toBe("not a SQLite database");
});

test("binding mutexes isolate sessions and release after an update exception", async () => {
  const f = fixture("mutex-isolation"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const otherSessionId = `${f.nativeSessionId}-other`;
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: otherSessionId,
    transcript_path: f.transcriptPath }, now);
  const holder = spawnBindingChild("update", { config: f.config, nativeSessionId: f.nativeSessionId, worker: "holder" });
  try {
    await childMessage(holder, "ready"); const entered = childMessage(holder, "entered"); holder.send({ type: "go" }); await entered;
    const started = performance.now();
    await updateBinding(f.config, otherSessionId, current => ({ ...current!, lastClose: { at: now, reason: "other", confirmed: false } }), 500);
    expect(performance.now() - started).toBeLessThan(200);
    await expect(updateBinding(f.config, otherSessionId, () => { throw new Error("update failed"); })).rejects.toThrow("update failed");
    await updateBinding(f.config, otherSessionId, current => ({ ...current!, enrollment: { ...current!.enrollment, choice: false } }));
    expect(readBinding(f.config, otherSessionId)).toMatchObject({ enrollment: { choice: false }, lastClose: { reason: "other" } });
  } finally {
    if (holder.exitCode === null && holder.signalCode === null) holder.kill("SIGKILL");
    await childExit(holder).catch(() => {});
  }
});

test("stdio MCP stays protocol-clean and only prompt_input_exit confirms close after SIGINT", async () => {
  const f = fixture("stdio"); f.write();
  const configPath = join(f.dir, "cc.json"); writeFileSync(configPath, JSON.stringify(f.config));
  const child = spawn(process.execPath, [resolve("src/hosts/cc/index.ts"), "mcp", "--config", configPath], {
    cwd: resolve("."), env: { ...process.env, CLAUDE_CODE_SESSION_ID: f.nativeSessionId }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "", stderr = ""; child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })}\n`);
  for (let i = 0; i < 100 && !stdout.includes('"id":1'); i++) await sleep(5);
  expect(stdout).toContain('"name":"trace-memory"');
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  for (let i = 0; i < 100 && !readBinding(f.config, f.nativeSessionId)?.selectedLeafUuid; i++) await sleep(5);
  expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ executor: { pid: child.pid }, selectedLeafUuid: "a1" });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" })}\n`);
  for (let i = 0; i < 100 && !stdout.includes('"id":2'); i++) await sleep(5);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "trace", arguments: { address: "T1" } } })}\n`);
  for (let i = 0; i < 100 && !stdout.includes('"id":3'); i++) await sleep(5);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "note", arguments: { facts: [] } } })}\n`);
  for (let i = 0; i < 100 && !stdout.includes('"id":4'); i++) await sleep(5);
  child.kill("SIGINT");
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`stdio MCP did not exit; stderr=${stderr}; binding=${JSON.stringify(readBinding(f.config, f.nativeSessionId))}`)); }, 2_000);
    child.on("exit", (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }); });
  });
  expect(exit).toEqual({ code: 1, signal: null });
  expect(stdout.trim().split("\n").map(value => JSON.parse(value))).toEqual([
    expect.objectContaining({ jsonrpc: "2.0", id: 1, result: expect.objectContaining({ capabilities: { tools: {} } }) }),
    expect.objectContaining({ jsonrpc: "2.0", id: 2, result: { tools: expect.arrayContaining([
      expect.objectContaining({ name: "trace" }), expect.objectContaining({ name: "search" }),
      expect.objectContaining({ name: "note" }), expect.objectContaining({ name: "memory" }),
    ]) } }),
    expect.objectContaining({ jsonrpc: "2.0", id: 3, result: expect.objectContaining({ content: [expect.objectContaining({ type: "text", text: expect.stringContaining("question") })] }) }),
    expect.objectContaining({ jsonrpc: "2.0", id: 4, result: expect.objectContaining({ isError: true,
      content: [expect.objectContaining({ text: expect.stringContaining("source-not-ready") })] }) }),
  ]);
  expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ executor: { pid: child.pid }, lastClose: { confirmed: false, reason: "SIGINT" } });
  expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath, reason: "prompt_input_exit" })).toMatchObject({ confirmed: true });
  const closed = readBinding(f.config, f.nativeSessionId)!; expect(closed.executor).toBeNull();
  const store = new Store(f.config.dbPath);
  try { expect(store.getSession(closed.coreSessionId!)!.closedAt).not.toBeNull(); } finally { store.close(); }
});

test("SIGINT registered before startup cancels an attach held by the SQLite mutex and finalizes after release", async () => {
  const f = fixture("startup-race"); f.write();
  const shortState = mkdtempSync("/tmp/tmcc-race-"); dirs.push(shortState); f.config.stateDir = shortState;
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const mutex = new DatabaseSync(bindingMutexPath(f.config, f.nativeSessionId), { timeout: 0 }); mutex.exec("BEGIN IMMEDIATE");
  const configPath = join(f.dir, "cc.json"); writeFileSync(configPath, JSON.stringify(f.config));
  const child = spawn(process.execPath, [resolve("src/hosts/cc/index.ts"), "mcp", "--config", configPath], {
    cwd: resolve("."), env: { ...process.env, CLAUDE_CODE_SESSION_ID: f.nativeSessionId }, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = ""; child.stderr.setEncoding("utf8"); child.stderr.on("data", chunk => stderr += chunk);
  const controlDirectory = join(shortState, "control"), runtime = join(shortState, "runtime", `${f.nativeSessionId}.jsonl`);
  const hasSocket = () => existsSync(controlDirectory) && readdirSync(controlDirectory).some(name => name.endsWith(".sock"));
  for (let i = 0; i < 400 && !(hasSocket() && existsSync(runtime) && readFileSync(runtime, "utf8").includes('"event":"handlers-registered"')); i++) await sleep(5);
  expect(hasSocket(), stderr).toBe(true); expect(readFileSync(runtime, "utf8")).toContain('"event":"handlers-registered"');
  child.kill("SIGINT"); await sleep(30);
  expect(child.exitCode).toBeNull(); expect(child.signalCode).toBeNull();
  mutex.exec("ROLLBACK"); mutex.close();
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`held-startup MCP did not exit; stderr=${stderr}`)); }, 2_000);
    child.on("exit", (code, signal) => { clearTimeout(timeout); resolveExit({ code, signal }); });
  });
  expect(exit).toEqual({ code: 1, signal: null });
  expect(readFileSync(runtime, "utf8")).toContain("startup-cancelled");
  expect(readBinding(f.config, f.nativeSessionId)!.lastClose).toMatchObject({ reason: "SIGINT", confirmed: false });
});

test("unrelated files in the transcript directory do not request transcript reconciliation", async () => {
  const f = fixture("unrelated-watch"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const diagnostics: string[] = [], coordinator = new CcCoordinator(f.config, f.nativeSessionId, value => diagnostics.push(value));
  await coordinator.start(); diagnostics.length = 0;
  writeFileSync(join(f.dir, "unrelated.tmp"), "unrelated");
  await sleep(50);
  expect(diagnostics.some(value => value.includes('"reason":"transcript watch"'))).toBe(false);
  await coordinator.shutdown("test shutdown");
});

test("live control follows a provisional binding through ordinary core allocation", async () => {
  const f = fixture("control-allocation");
  f.config.stateDir = mkdtempSync("/tmp/tmcc-allocation-"); dirs.push(f.config.stateDir);
  writeFileSync(f.transcriptPath, [
    { uuid: "u1", parentUuid: null, type: "user", timestamp: now, promptId: "p1", promptSource: "typed", userType: "external", message: { role: "user", content: "question" } },
    { uuid: "a1", parentUuid: "u1", type: "assistant", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }] } },
  ].map(record => `${JSON.stringify(record)}\n`).join(""));
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  expect(readBinding(f.config, f.nativeSessionId)?.coreSessionId).toBeNull();
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostics.push(message));
  await coordinator.start();
  try {
    const result = await coordinator.requestReconcile("test allocation");
    expect(result, diagnostics.join("\n")).toMatchObject({ state: "ready", coreSessionId: expect.any(Number) });
    expect(readBinding(f.config, f.nativeSessionId)?.coreSessionId).toEqual(expect.any(Number));
    await expect(controlSession(f.config, f.nativeSessionId, "stop")).resolves.toMatchObject({
      state: "acknowledged", reply: { verb: "stop" },
    });
    await expect(controlSession(f.config, f.nativeSessionId, "off")).resolves.toMatchObject({
      state: "acknowledged", reply: { verb: "off" },
    });
  } finally { await coordinator.shutdown("test cleanup"); }
});

test("ordinary wake bursts coalesce to one pending reconciliation", async () => {
  const f = fixture("wake-coalesce");
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  const requests = Array.from({ length: 100 }, () => coordinator.requestReconcile("synthetic burst"));
  expect(new Set(requests).size).toBe(1);
  await requests[0];
  await coordinator.shutdown("test shutdown");
});

test("a stable projection after plain transport EOF is reconciled but not declared a normal close", async () => {
  const f = fixture("eof"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  await coordinator.start(); expect((await coordinator.requestReconcile("test"))?.state).toBe("ready");
  const result = await coordinator.shutdown("stdio EOF");
  expect(result).toMatchObject({ confirmed: false, reason: "source reconciliation completed without normal producer termination" });
  const binding = readBinding(f.config, f.nativeSessionId)!, store = new Store(f.config.dbPath);
  try { expect(store.getSession(binding.coreSessionId!)!.closedAt).toBeNull(); }
  finally { store.close(); }
});

test("kill-like shutdown with an unavailable replacement remains pending and is diagnosed", async () => {
  const f = fixture("crash"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const diagnostics: string[] = [], coordinator = new CcCoordinator(f.config, f.nativeSessionId, value => diagnostics.push(value));
  await coordinator.start(); await coordinator.requestReconcile("test");
  rmSync(f.transcriptPath);
  const result = await coordinator.shutdown("SIGTERM");
  expect(result).toMatchObject({ confirmed: false, reason: "final reconciliation unconfirmed" });
  expect(result.diagnostic).toContain("unavailable"); expect(diagnostics.some(value => value.includes("close not confirmed"))).toBe(true);
  const binding = readBinding(f.config, f.nativeSessionId)!, store = new Store(f.config.dbPath);
  try { expect(store.getSession(binding.coreSessionId!)!.closedAt).toBeNull(); }
  finally { store.close(); }
});

test("unchanged projection is watch-quiescent while transcript and concurrent binding changes persist across resume", async () => {
  const f = fixture("quiescent"); f.write();
  const initial = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  let importer = new CcImporter(f.config, initial);
  const target = bindingPath(f.config, f.nativeSessionId), events: string[] = [];
  const watcher = watch(join(f.config.stateDir, "bindings"), (_event, filename) => {
    if (String(filename) === `${f.nativeSessionId}.json`) events.push(String(filename));
  });
  try {
    expect((await importer.reconcile()).state).toBe("ready"); await sleep(150); events.length = 0;
    const settledInode = statSync(target).ino;
    for (let index = 0; index < 5; index++) expect((await importer.reconcile()).appendedEntryIds).toEqual([]);
    await sleep(50);
    expect(events).toEqual([]); expect(statSync(target).ino).toBe(settledInode);

    importer.memory.store.setEnrollment(importer.currentBinding().coreSessionId!, false);
    await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, enrollment: { ...current!.enrollment, choice: false } }));
    for (let index = 0; index < 100 && !events.length; index++) await sleep(2);
    expect(events.length).toBeGreaterThan(0);
    expect((await importer.reconcile()).state).toBe("disabled");
    expect(readBinding(f.config, f.nativeSessionId)!.enrollment.choice).toBe(false);

    importer.memory.store.setEnrollment(importer.currentBinding().coreSessionId!, true);
    await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, enrollment: { ...current!.enrollment, choice: true } }));
    f.records.splice(-1, 0,
      { uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", ...sdkPrompt("p2"), message: { role: "user", content: "next" } },
      { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", content: [{ type: "text", text: "next answer" }] } });
    f.records[f.records.length - 1] = { type: "last-prompt", leafUuid: "a2" };
    writeFileSync(f.transcriptPath, f.records.map(record => `${JSON.stringify(record)}\n`).join(""));
    const changed = await importer.reconcile(); expect(changed.state).toBe("ready"); expect(changed.appendedEntryIds).toHaveLength(2);
    expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ selectedLeafUuid: "a2", enrollment: { choice: true } });

    importer.close(); importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    await sleep(100); events.length = 0; const resumeInode = statSync(target).ino;
    expect((await importer.reconcile()).appendedEntryIds).toEqual([]); await sleep(50);
    expect(events).toEqual([]); expect(statSync(target).ino).toBe(resumeInode);
  } finally { watcher.close(); importer.close(); }
});

test("prompt_input_exit closes from the imported eligible projection with stale or absent last-prompt", async () => {
  const f = fixture("session-end-close");
  f.records.splice(-1, 0, { uuid: "duration", parentUuid: "a1", type: "system", subtype: "turn_duration", timestamp: "2026-01-01T00:00:02.000Z" });
  f.records[f.records.length - 1] = { type: "last-prompt", leafUuid: "duration" }; f.write();
  const started = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, started); const imported = await importer.reconcile(); importer.close();
  expect(imported.state).toBe("ready"); expect(readBinding(f.config, f.nativeSessionId)!.selectedLeafUuid).toBe("a1");
  const child = spawn(process.execPath, ["-e", ""]); const deadPid = child.pid!;
  await new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  const executor = { executorId: "dead-session-end-owner", pid: deadPid, token: "dead-token", socketPath: join(f.dir, "dead.sock"), startedAt: now };
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor }));
  const store = new Store(f.config.dbPath);
  try {
    expect(store.acquireClaim({ sessionId: imported.coreSessionId!, branch: imported.branch, headTurnId: imported.headTurnId! },
      "noting", executor.executorId)).not.toBeNull();
  } finally { store.close(); }
  const input = { hook_event_name: "SessionEnd" as const, session_id: f.nativeSessionId, transcript_path: f.transcriptPath,
    reason: "prompt_input_exit" };
  expect(await recordCcSessionEnd(f.config, input)).toMatchObject({ confirmed: true, reason: "SessionEnd prompt_input_exit" });
  const closed = readBinding(f.config, f.nativeSessionId)!; expect(closed.executor).toBeNull();
  expect(closed.lastClose).toMatchObject({ confirmed: true, reason: "SessionEnd prompt_input_exit" });
  const verified = new Store(f.config.dbPath); let closedAt: string | null = null;
  try {
    closedAt = verified.getSession(imported.coreSessionId!)!.closedAt; expect(closedAt).not.toBeNull();
    expect(verified.getClaim(imported.coreSessionId!, "noting")).toBeNull();
  } finally { verified.close(); }
  // Retry the only cross-file crash window: the database close committed but the binding receipt did not.
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor,
    lastClose: { at: now, reason: "SessionEnd prompt_input_exit", confirmed: false, diagnostic: "simulated binding-write crash" } }));
  writeFileSync(f.transcriptPath, f.records.filter(record => record.type !== "last-prompt")
    .map(record => `${JSON.stringify(record)}\n`).join(""));
  expect((await recordCcSessionEnd(f.config, input)).confirmed).toBe(true);
  expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ executor: null, lastClose: { confirmed: true } });
  const retried = new Store(f.config.dbPath);
  try { expect(retried.getSession(imported.coreSessionId!)!.closedAt).toBe(closedAt); } finally { retried.close(); }
});

test("prompt_input_exit refuses an executor identity change while waiting for owner death", async () => {
  const f = fixture("session-end-owner-change"); f.write();
  const started = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, started); const imported = await importer.reconcile(); importer.close();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 1000)"]);
  const expected = { executorId: "ending-owner", pid: child.pid!, token: "ending-token", socketPath: join(f.dir, "ending.sock"), startedAt: now };
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: expected }));
  const input = { hook_event_name: "SessionEnd" as const, session_id: f.nativeSessionId, transcript_path: f.transcriptPath,
    reason: "prompt_input_exit" };
  const closing = recordCcSessionEnd(f.config, input);
  await sleep(20);
  const replacement = { executorId: "replacement-owner", pid: process.pid, token: "replacement-token",
    socketPath: join(f.dir, "replacement.sock"), startedAt: now };
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: replacement }));
  child.kill("SIGTERM"); await new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  expect(await closing).toMatchObject({ confirmed: false, diagnostic: "CC executor identity changed during SessionEnd close" });
  expect(readBinding(f.config, f.nativeSessionId)!.executor).toEqual(replacement);
  const store = new Store(f.config.dbPath);
  try { expect(store.getSession(imported.coreSessionId!)!.closedAt).toBeNull(); } finally { store.close(); }
});

test("SessionEnd leaves unsupported, live-executor, and unimported-tail sessions explicitly unconfirmed", async () => {
  const f = fixture("session-end-pending"); f.config.finalSyncTimeoutMs = 20; f.write();
  const started = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, started); const imported = await importer.reconcile(); importer.close();
  const alive = { executorId: "live-owner", pid: process.pid, token: "live-token", socketPath: join(f.dir, "live.sock"), startedAt: now };
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: alive }));
  const normalInput = { hook_event_name: "SessionEnd" as const, session_id: f.nativeSessionId, transcript_path: f.transcriptPath,
    reason: "prompt_input_exit" };
  expect(await recordCcSessionEnd(f.config, normalInput)).toMatchObject({ confirmed: false,
    diagnostic: expect.stringContaining("named executor remained alive through the SessionEnd close bound") });
  let store = new Store(f.config.dbPath); try { expect(store.getSession(imported.coreSessionId!)!.closedAt).toBeNull(); } finally { store.close(); }
  expect((await recordCcSessionEnd(f.config, { ...normalInput, reason: "other" })).confirmed).toBe(false);
  expect(readBinding(f.config, f.nativeSessionId)!.lastClose).toMatchObject({ confirmed: false, reason: "SessionEnd other" });

  const child = spawn(process.execPath, ["-e", ""]); const deadPid = child.pid!;
  await new Promise<void>(resolveExit => child.once("exit", () => resolveExit()));
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: { ...alive, pid: deadPid, token: "dead" } }));
  writeFileSync(f.transcriptPath, [...f.records,
    { uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", ...sdkPrompt("p2"), message: { role: "user", content: "not imported" } },
    { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "not imported" }] } }]
    .map(record => `${JSON.stringify(record)}\n`).join(""));
  expect(await recordCcSessionEnd(f.config, normalInput)).toMatchObject({ confirmed: false,
    diagnostic: "latest complete eligible native source has not already been imported as the selected projection" });
  writeFileSync(f.transcriptPath, f.records.map(record => `${JSON.stringify(record)}\n`).join("") + '{"uuid":');
  expect(await recordCcSessionEnd(f.config, normalInput)).toMatchObject({ confirmed: false,
    diagnostic: expect.stringContaining("incomplete trailing bytes") });
  store = new Store(f.config.dbPath); try { expect(store.getSession(imported.coreSessionId!)!.closedAt).toBeNull(); } finally { store.close(); }
});
