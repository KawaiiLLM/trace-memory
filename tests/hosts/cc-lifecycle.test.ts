import { afterEach, expect, test, vi } from "vitest";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createConnection } from "node:net";
import { TraceMemory } from "../../src/core/api/index.ts";
import { Store } from "../../src/core/store/index.ts";
import { resolveCcHostConfig } from "../../src/hosts/cc/config.ts";
import { activeFunctionHook, bindingMutexPath, bindingPath, markCcFunctionHook, readBinding, recordSessionStart, updateBinding, withCcBindingLock, type CcExecutorBinding } from "../../src/hosts/cc/binding.ts";
import { controlSession, requestCcForkSources, signalCcTurnEnd, startControlServer } from "../../src/hosts/cc/control.ts";
import { CcCoordinator, recordCcSessionEnd } from "../../src/hosts/cc/lifecycle.ts";
import { CcTaskScheduler } from "../../src/hosts/cc/scheduler.ts";
import { CcForkAuthority } from "../../src/hosts/cc/fork-authority.ts";
import { CcImporter } from "../../src/hosts/cc/importer.ts";
import { processStartedAt, publishNativeSession } from "../../src/hosts/cc/native-session.ts";
import { CcTranscriptCursor, CcTranscriptScan, classifySourceRecord, type CcNativeRecord } from "../../src/hosts/cc/transcript.ts";

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const now = "2026-01-01T00:00:00.000Z";
const sdkPrompt = (promptId: string) => ({ promptId, promptSource: "sdk", userType: "external" });
function fixture(label = "lifecycle") {
  vi.stubEnv("CLAUDE_PID", String(process.pid));
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
function enableSyntheticWorker(f: ReturnType<typeof fixture>): void {
  const configured = resolveCcHostConfig({ ...f.config, notingModel: "synthetic", notingThinking: "medium",
    "dreaming.model": "synthetic", "dreaming.thinking": "medium",
    worker: { claudeExecutable: "/missing/claude", contextWindows: { synthetic: 200_000 }, cwd: f.dir,
      responseOriginTimeoutMs: 20 } });
  Object.assign(f.config, configured);
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
const spawnBindingChild = (mode: "update" | "control" | "hook-identity", input: Record<string, unknown>, explicitPid?: string): ChildProcess => spawn(process.execPath,
  [childScript, mode], { cwd: resolve("."), env: { ...process.env, CLAUDE_PID: explicitPid, CC_BINDING_CHILD_INPUT: JSON.stringify(input) },
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

test("public turn-end admission releases fork checkpoint on N eligibility failure and still checks D", async () => {
  const phases: string[] = [], errors: string[] = [];
  const memory = { taskEligibility: (phase: string) => {
    phases.push(phase);
    if (phase === "noting") throw new Error("source store unavailable");
    return { due: false };
  } } as unknown as TraceMemory;
  const scheduler = new CcTaskScheduler(memory, undefined, error => errors.push(error));
  let released = 0;
  scheduler.turnEnd({ state: "ready", coreSessionId: 1, headTurnId: 1, selectedTailId: 1, branch: "main" },
    scheduler.catchupTicket(), { model: "parent", capacity: { inputTokens: 100, prefixTokens: 0 }, visible: {} as any }, () => released++);
  expect(released).toBe(1);
  expect(phases).toEqual(["noting", "dreaming"]);
  expect(errors).toEqual([expect.stringContaining("source store unavailable")]);
  phases.length = 0; errors.length = 0;
  scheduler.turnEnd({ state: "ready", coreSessionId: 1, headTurnId: 1, selectedTailId: 1, branch: "main" },
    scheduler.catchupTicket(), undefined, () => released++, "indexed JSON is invalid");
  expect(released).toBe(2);
  expect(phases).toEqual(["dreaming"]);
  expect(errors).toEqual([expect.stringContaining("indexed JSON is invalid")]);
});

test("public turn-end admission exception releases a prepared fork checkpoint", async () => {
  const errors: string[] = [];
  const memory = { taskEligibility: (phase: string) => ({ due: phase === "noting" }),
    store: { closedTasks: () => [], enabled: () => true },
    config: { closedSessionScope: "off" },
    notingBatch: () => { throw Object.assign(new Error("admission store failed"), { cause: "task admission" }); },
  } as unknown as TraceMemory;
  const worker = { phases: { noting: { model: "fresh", thinking: "medium", capacity: { inputTokens: 100, prefixTokens: 0 } },
    dreaming: { model: "fresh", thinking: "medium", capacity: { inputTokens: 100, prefixTokens: 0 } } } } as any;
  const scheduler = new CcTaskScheduler(memory, worker, message => errors.push(message));
  let released = 0;
  scheduler.turnEnd({ state: "ready", coreSessionId: 1, headTurnId: 1, selectedTailId: 1, branch: "main" },
    scheduler.catchupTicket(), { model: "parent", capacity: { inputTokens: 100, prefixTokens: 0 }, visible: {} as any }, () => released++);
  await vi.waitFor(() => expect(released).toBeGreaterThan(0));
  expect(errors).toEqual([expect.stringContaining("admission store failed")]);
  await scheduler.settle();
});

test("a prelaunch fork refusal releases the main checkpoint before its fresh replacement finishes", async () => {
  let finish!: (result: any) => void;
  const fresh = new Promise<any>(resolve => { finish = resolve; });
  const noting = vi.fn().mockResolvedValueOnce({ outcome: "dropped", executionId: "refused-launch",
    refused: { reason: "fork suppressed before launch" } }).mockImplementationOnce(() => fresh);
  const memory = { taskEligibility: (phase: string) => ({ due: phase === "noting" }),
    store: { closedTasks: () => [], enabled: () => true }, config: { closedSessionScope: "off" },
    notingBatch: () => [{ id: 1 }], noting,
  } as unknown as TraceMemory;
  const worker = { phases: { noting: { model: "fresh", thinking: "medium", capacity: { inputTokens: 100, prefixTokens: 0 } },
    dreaming: { model: "fresh", thinking: "medium", capacity: { inputTokens: 100, prefixTokens: 0 } } } } as any;
  const scheduler = new CcTaskScheduler(memory, worker, () => {});
  let released = 0;
  try {
    scheduler.turnEnd({ state: "ready", coreSessionId: 1, headTurnId: 1, selectedTailId: 1, branch: "main" },
      scheduler.catchupTicket(), { model: "parent", capacity: { inputTokens: 100, prefixTokens: 0 }, visible: {} as any }, () => released++);
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(2));
    expect(noting.mock.calls[1]![0]).toMatchObject({ effectiveMode: "subagent", executionId: "refused-launch",
      boundary: { exactEntryIds: [1] } });
    expect(released).toBeGreaterThan(0);
  } finally {
    finish({ outcome: "success", facts: [] });
    await scheduler.settle();
  }
});

test("function-hook child requires the exact live SessionStart assignment and owner", async () => {
  const f = fixture("hook-identity"); f.write();
  const input = { hook_event_name: "SessionStart" as const, session_id: f.nativeSessionId, transcript_path: f.transcriptPath };
  await recordSessionStart(f.config, input, now);
  const owner = readBinding(f.config, f.nativeSessionId)!.nativeProcess!;
  expect(publishNativeSession(f.config, input)).toMatchObject({ pid: process.pid, startedAt: owner.startedAt });
  const attempt = async (explicitPid?: string) => {
    const child = spawnBindingChild("hook-identity", { config: f.config, nativeSessionId: f.nativeSessionId, worker: "hook" }, explicitPid);
    const result = await Promise.race([childMessage(child, "fulfilled"), childMessage(child, "rejected")]);
    child.disconnect(); await childExit(child);
    return result;
  };
  expect(await attempt()).toMatchObject({ type: "fulfilled", identity: owner });
  expect((await attempt(String(process.ppid))).type).toBe("rejected"); // Explicit mismatch never falls back.
  expect((await attempt("invalid")).type).toBe("rejected");
  const recordPath = join(f.config.stateDir, "native-sessions", `${process.pid}.json`);
  const original = JSON.parse(readFileSync(recordPath, "utf8"));
  const changed = async (change: Record<string, unknown>) => {
    writeFileSync(recordPath, JSON.stringify({ ...original, ...change }));
    expect((await attempt()).type).toBe("rejected");
  };
  await changed({ startedAt: "stale pid reuse" });
  await changed({ startedAt: null }); // assignedNativeSession's legacy loose match cannot authorize a write.
  await changed({ nativeSessionId: "wrong-session" });
  await changed({ transcriptPath: join(f.dir, "other.jsonl") });
  writeFileSync(recordPath, JSON.stringify(original));
  await updateBinding(f.config, f.nativeSessionId, binding => ({ ...binding!, nativeProcess: { ...owner, startedAt: "old launch" } }));
  expect((await attempt()).type).toBe("rejected");
  await updateBinding(f.config, f.nativeSessionId, binding => ({ ...binding!, nativeProcess: owner }));
  expect(processStartedAt(process.pid)).toBe(owner.startedAt);
});

test("live function-hook turns check once across both import orders and do not replay bootstrap", async () => {
  const f = fixture("turn-hook"); enableSyntheticWorker(f);
  (f.records[1]!.message as Record<string, unknown>).stop_reason = "end_turn"; f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  try {
    await coordinator.start();
    const memory = (coordinator as any).importer.memory;
    const noting = vi.fn(async () => ({ outcome: "success", facts: [] }));
    const dreaming = vi.fn(async () => ({ outcome: "success", revisions: [] }));
    memory.noting = noting; memory.dream = dreaming;
    memory.taskEligibility = (phase: string) => ({ due: phase === "noting" });
    expect(noting).not.toHaveBeenCalled();
    await markCcFunctionHook(f.config, f.nativeSessionId);
    expect(activeFunctionHook(readBinding(f.config, f.nativeSessionId)!)).toBe(true);
    await signalCcTurnEnd(f.config, f.nativeSessionId, "turn-one", "answer");
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(1));
    await signalCcTurnEnd(f.config, f.nativeSessionId, "turn-one", "answer");
    f.records.splice(-1, 1,
      { uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", ...sdkPrompt("p2"), message: { role: "user", content: "second" } },
      { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "second answer" }] } },
      { type: "last-prompt", leafUuid: "a2" });
    f.write(); await coordinator.requestReconcile("pre-hook import");
    expect(noting).toHaveBeenCalledTimes(1);
    await signalCcTurnEnd(f.config, f.nativeSessionId, "turn-two", "answer");
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(2));
    f.records.splice(-1, 1,
      { uuid: "u3", parentUuid: "a2", type: "user", timestamp: "2026-01-01T00:00:04.000Z", ...sdkPrompt("p3"), message: { role: "user", content: "third" } },
      { uuid: "a3", parentUuid: "u3", type: "assistant", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", content: [{ type: "text", text: "partial response before interruption" }] } },
      { type: "last-prompt", leafUuid: "a3" });
    f.write(); await signalCcTurnEnd(f.config, f.nativeSessionId, "turn-three", "aborted");
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(3));
    await signalCcTurnEnd(f.config, f.nativeSessionId, "turn-three", "aborted");
    expect(noting).toHaveBeenCalledTimes(3);
    for (const [id, reason] of [[4, "refusal"], [5, "error"]] as const) {
      f.records.splice(-1, 1,
        { uuid: `u${id}`, parentUuid: `a${id - 1}`, type: "user", timestamp: `2026-01-01T00:00:0${id * 2 - 2}.000Z`,
          ...sdkPrompt(`p${id}`), message: { role: "user", content: `prompt ${id}` } },
        { uuid: `a${id}`, parentUuid: `u${id}`, type: "assistant", timestamp: `2026-01-01T00:00:0${id * 2 - 1}.000Z`,
          message: { role: "assistant", content: [{ type: "text", text: `partial ${id}` }] } },
        { type: "last-prompt", leafUuid: `a${id}` });
      f.write();
      await signalCcTurnEnd(f.config, f.nativeSessionId, `turn-${id}`, reason);
      await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(id));
      await signalCcTurnEnd(f.config, f.nativeSessionId, `turn-${id}`, reason);
      expect(noting).toHaveBeenCalledTimes(id);
    }
    await expect(signalCcTurnEnd(f.config, f.nativeSessionId, "invalid", "interrupted"))
      .rejects.toThrow("unsupported CC turn completion reason interrupted");
    expect(noting).toHaveBeenCalledTimes(5); expect(dreaming).not.toHaveBeenCalled();
  } finally { await coordinator.shutdown("test"); }
});

test("fork source observation returns frozen batch identities without scheduling a turn", async () => {
  const f = fixture("fs"); enableSyntheticWorker(f); f.write();
  f.config.coreConfig.noting.triggerTokens = 1;
  f.config.coreConfig.noting.forkModeDefault = true;
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostics.push(message));
  try {
    await coordinator.start();
    expect((coordinator as any).importer, diagnostics.join("; ")).not.toBeNull();
    await markCcFunctionHook(f.config, f.nativeSessionId);
    const sources = await requestCcForkSources(f.config, f.nativeSessionId, "first-turn");
    expect(sources?.turnId).toBe("first-turn");
    expect(sources?.selected).toContain("u1");
    expect((coordinator as any).scheduler.running()).toEqual([]);
  } finally { await coordinator.shutdown("test"); }
});

test("CC final admission uses the selected compaction boundary, frozen batch and checkpoint (110)", async () => {
  const f = fixture("boundary-admission"); enableSyntheticWorker(f); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-110-"); dirs.push(f.config.stateDir);
  f.records.unshift({ uuid: "initial-boundary", parentUuid: null, type: "system", subtype: "compact_boundary",
    timestamp: "2025-12-31T23:59:59.000Z" });
  f.records[1]!.parentUuid = "initial-boundary"; f.write();
  f.config.coreConfig.noting.triggerTokens = 1;
  f.config.coreConfig.noting.forkModeDefault = true;
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId);
  try {
    await coordinator.start();
    await markCcFunctionHook(f.config, f.nativeSessionId);
    const initial = await requestCcForkSources(f.config, f.nativeSessionId, "before");
    expect(initial?.selected).toEqual(["u1", "a1"]);
    const observed = (source: NonNullable<typeof initial>) => ({ checkpoint: { sessionId: source.sessionId,
      branch: source.branch, headTurnId: source.headTurnId, tailId: source.tailId }, batch: source.selected,
      model: "synthetic", window: 200000, prefix: 100 });
    const admit = (source: NonNullable<typeof initial>, observation = observed(source)) => {
      const result = (coordinator as any).lastReconcile;
      return (coordinator as any).forkOption({ sessionId: source.sessionId, branch: source.branch,
        headTurnId: source.headTurnId }, result, observation);
    };
    expect(admit(initial!).visible.raw.size).toBe(2);
    expect(admit(initial!, { ...observed(initial!), batch: ["a1", "u1"] }).refused).toContain("batch changed");
    expect(admit(initial!, { ...observed(initial!), checkpoint: { ...observed(initial!).checkpoint, tailId: -1 } }).refused)
      .toContain("checkpoint moved");
    f.records.splice(-1, 1,
      { uuid: "boundary", parentUuid: null, logicalParentUuid: "a1", type: "system", subtype: "compact_boundary",
        timestamp: "2026-01-01T00:00:02.000Z" },
      { uuid: "summary", parentUuid: "boundary", type: "user", isCompactSummary: true,
        timestamp: "2026-01-01T00:00:03.000Z", message: { role: "user", content: "summary" } },
      { uuid: "u2", parentUuid: "summary", type: "user", ...sdkPrompt("p2"),
        timestamp: "2026-01-01T00:00:04.000Z", message: { role: "user", content: "next question" } },
      { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:05.000Z",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "answer" }] } },
      { type: "last-prompt", leafUuid: "a2" });
    f.write(); await coordinator.requestReconcile("compact boundary");
    const spanning = await requestCcForkSources(f.config, f.nativeSessionId, "after");
    expect(spanning?.selected).toEqual(["u1", "a1", "u2", "a2"]);
    expect(admit(initial!).refused).toContain("checkpoint moved");
    expect(admit(spanning!).refused).toContain("Raw availability: entry");
    expect(admit(spanning!).refused).toContain("native u1");
    const noting = vi.spyOn((coordinator as any).importer.memory, "noting").mockResolvedValue({ outcome: "success", facts: [] });
    expect(await signalCcTurnEnd(f.config, f.nativeSessionId, "after", "answer", observed(spanning!))).toBeNull();
    await vi.waitFor(() => expect(noting).toHaveBeenCalledOnce());
    expect(noting.mock.calls[0]![0]).toMatchObject({ effectiveMode: "subagent",
      fallbackReason: expect.stringContaining("Raw availability: entry") });
  } finally { await coordinator.shutdown("test"); }
});

test.each(["hook", "transcript"] as const)("accepted CC scan race preserves turn-end dedup and published Raw (%s; imposed order)", async mode => {
  const f = fixture(`queued-user-${mode}`); enableSyntheticWorker(f);
  f.config.stateDir = mkdtempSync("/tmp/tmcc-scan-race-"); dirs.push(f.config.stateDir);
  (f.records[1]!.message as Record<string, unknown>).stop_reason = "tool_use";
  f.config.coreConfig.noting.triggerTokens = 1;
  f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostics.push(message));
  try {
    await coordinator.start();
    const importer = (coordinator as any).importer;
    const memory = importer.memory;
    const sessionId = readBinding(f.config, f.nativeSessionId)!.coreSessionId!;
    // Keep the real Core Noting publication path. Only the model transport is deterministic.
    const batches: number[][] = [];
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    const firstRunning = new Promise<void>(resolve => { firstEntered = resolve; });
    importer.runAgent = async (input: any) => {
      expect(input.kind).toBe("noting");
      batches.push(input.entryIds);
      input.reportRequest({ fixture: "CC scan race" });
      expect(input.tools.find((tool: any) => tool.name === "note").execute({ facts: [] })).toContain("held");
      expect(input.tools.find((tool: any) => tool.name === "memory").execute({ operations: [], skipped: [] })).toContain("held");
      if (mode === "hook" && batches.length === 1) { firstEntered(); await firstHeld; }
      return { outcome: "success", output: "done", request: { fixture: "CC scan race" } };
    };
    const dream = vi.fn(async () => ({ outcome: "success", revisions: [] }));
    memory.dream = dream;
    const eligibility = vi.fn((phase: string) => ({ due: phase === "dreaming" || memory.store.pendingEntryIds(sessionId, "main", memory.store.knowledgePath(sessionId, "main").headTurnId!).length > 0 }));
    memory.taskEligibility = eligibility;
    if (mode === "hook") await markCcFunctionHook(f.config, f.nativeSessionId);
    f.records.splice(-1, 1,
      { uuid: "a1-end", parentUuid: "a1", type: "assistant", timestamp: "2026-01-01T00:00:01.500Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "answer finished" }] } },
      { uuid: "u2", parentUuid: "a1-end", type: "user", timestamp: "2026-01-01T00:00:02.000Z", ...sdkPrompt("p2"), message: { role: "user", content: "second" } },
      { type: "last-prompt", leafUuid: "u2" });
    f.write();
    if (mode === "hook") await signalCcTurnEnd(f.config, f.nativeSessionId, "native-event-A", "answer");
    else await coordinator.requestReconcile("A terminal and B user in one scan");
    if (mode === "hook") await firstRunning;
    const selected = memory.store.selectedSourceEntryIds(sessionId, "main")!;
    const bQuestion = selected.at(-1)!;
    expect(selected).toHaveLength(4);
    const appendBAnswer = () => {
      f.records.splice(-1, 1,
        { uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "second answer" }] } },
        { type: "last-prompt", leafUuid: "a2" });
      f.write();
    };
    let answer: number | undefined;
    if (mode === "hook") {
      appendBAnswer();
      await coordinator.requestReconcile("B answer imported while A Noting is held");
      answer = memory.store.selectedSourceEntryIds(sessionId, "main")!.at(-1)!;
      expect(batches[0]).not.toContain(answer);
      expect(memory.store.entryNoted(answer)).toBe(false);
      releaseFirst();
    }
    await (coordinator as any).scheduler.settle();
    if (mode === "hook") expect(memory.store.entryNoted(answer!)).toBe(false);
    expect(batches, JSON.stringify({ diagnostics, eligibility: eligibility.mock.calls, pending: memory.store.pendingEntryIds(sessionId, "main", memory.store.knowledgePath(sessionId, "main").headTurnId!) })).toHaveLength(mode === "hook" ? 1 : 0);
    expect(dream).toHaveBeenCalledTimes(mode === "hook" ? 1 : 0);
    expect(eligibility).toHaveBeenCalledTimes(mode === "hook" ? 2 : 0);
    expect(memory.store.entryNoted(bQuestion)).toBe(mode === "hook");
    if (mode === "hook") expect(batches[0]).toEqual(selected);
    else expect(selected.every((id: number) => !memory.store.entryNoted(id))).toBe(true);
    if (mode === "hook") await signalCcTurnEnd(f.config, f.nativeSessionId, "native-event-A", "answer");
    await coordinator.requestReconcile("duplicate A observation after settlement");
    await (coordinator as any).scheduler.settle();
    expect(batches).toHaveLength(mode === "hook" ? 1 : 0);
    expect(dream).toHaveBeenCalledTimes(mode === "hook" ? 1 : 0);
    if (mode === "transcript") appendBAnswer();
    if (mode === "hook") await signalCcTurnEnd(f.config, f.nativeSessionId, "native-event-B", "answer");
    else await coordinator.requestReconcile("B ended");
    await (coordinator as any).scheduler.settle();
    answer = memory.store.selectedSourceEntryIds(sessionId, "main")!.at(-1)!;
    expect(batches, JSON.stringify({ diagnostics, eligibility: eligibility.mock.calls })).toHaveLength(mode === "hook" ? 2 : 1);
    expect(dream).toHaveBeenCalledTimes(mode === "hook" ? 2 : 1);
    expect(memory.store.entryNoted(answer!), diagnostics.join("; ")).toBe(true);
    expect(batches.at(-1)).toContain(answer);
    expect(batches.slice(0, -1).every(batch => !batch.includes(answer!))).toBe(true);
    expect(memory.store.entryNoted(bQuestion)).toBe(true);
    if (mode === "hook") await signalCcTurnEnd(f.config, f.nativeSessionId, "native-event-B", "answer");
    await coordinator.requestReconcile("duplicate B observation after settlement");
    await (coordinator as any).scheduler.settle();
    expect(batches).toHaveLength(mode === "hook" ? 2 : 1);
    expect(dream).toHaveBeenCalledTimes(mode === "hook" ? 2 : 1);
    expect(eligibility).toHaveBeenCalledTimes(mode === "hook" ? 4 : 2);
  } finally { await coordinator.shutdown("test"); }
});

test("without function hooks, only proven native ends check once", async () => {
  const f = fixture("turn-raw"); enableSyntheticWorker(f);
  (f.records[1]!.message as Record<string, unknown>).stop_reason = "end_turn"; f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const diagnostic: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostic.push(message));
  try {
    await coordinator.start();
    const memory = (coordinator as any).importer?.memory;
    expect(memory, diagnostic.join("; ")).toBeDefined();
    const noting = vi.fn(async () => ({ outcome: "success", facts: [] }));
    memory.noting = noting;
    memory.taskEligibility = (phase: string) => ({ due: phase === "noting" });
    expect(noting).not.toHaveBeenCalled();
    const append = (id: number, stop: string, error = false) => {
      const parent = id === 2 ? "a1" : `a${id - 1}`;
      f.records.splice(-1, 1,
        { uuid: `u${id}`, parentUuid: parent, type: "user", timestamp: `2026-01-01T00:00:${String(id * 2).padStart(2, "0")}.000Z`, ...sdkPrompt(`p${id}`), message: { role: "user", content: "next" } },
        { uuid: `a${id}`, parentUuid: `u${id}`, type: "assistant", timestamp: `2026-01-01T00:00:${String(id * 2 + 1).padStart(2, "0")}.000Z`,
          ...(error ? { isApiErrorMessage: true, error: "server_error" } : {}),
          message: { role: "assistant", ...(error ? { model: "<synthetic>" } : {}), stop_reason: stop, content: [{ type: "text", text: error ? "API Error: test" : "reply" }] } },
        { type: "last-prompt", leafUuid: `a${id}` });
      f.write();
    };
    append(2, "tool_use"); await coordinator.requestReconcile("tool result pending");
    append(3, "stop_sequence"); await coordinator.requestReconcile("unknown stop");
    expect(noting).not.toHaveBeenCalled();
    append(4, "stop_sequence", true); const errorProjection = await coordinator.requestReconcile("native error");
    expect(errorProjection?.terminal, JSON.stringify({ projection: errorProjection, binding: readBinding(f.config, f.nativeSessionId) })).toMatchObject({ uuid: "a4", isApiErrorMessage: true });
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(1));
    await coordinator.requestReconcile("duplicate poll");
    expect(noting).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => expect((coordinator as any).scheduler.running()).toEqual([]));
    append(5, "end_turn"); const last = await coordinator.requestReconcile("answer end");
    expect(last?.terminal?.uuid, JSON.stringify(last)).toBe("a5");
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(2));
  } finally { await coordinator.shutdown("test"); }
});

test("no-hook native interruption after previously imported tool Raw checks once and stays out of Raw", async () => {
  const f = fixture("cc-cancel"); enableSyntheticWorker(f);
  (f.records[1]!.message as Record<string, unknown>).id = "api-read";
  (f.records[1]!.message as Record<string, unknown>).stop_reason = "tool_use";
  (f.records[1]!.message as Record<string, unknown>).content = [{ type: "tool_use", id: "read-call", name: "Read", input: { file_path: "sample.txt" } }];
  f.records.splice(-1, 1, { uuid: "result", parentUuid: "a1", type: "user", timestamp: now,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-call", content: "sample" }] } });
  f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const diagnostics: string[] = [];
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, message => diagnostics.push(message));
  try {
    await coordinator.start();
    expect((coordinator as any).importer, diagnostics.join("; ")).not.toBeNull();
    const memory = (coordinator as any).importer.memory;
    const noting = vi.fn(async () => ({ outcome: "success", facts: [] }));
    memory.noting = noting;
    memory.taskEligibility = (phase: string) => ({ due: phase === "noting" });
    const raw = memory.store.selectedSourceEntryIds(readBinding(f.config, f.nativeSessionId)!.coreSessionId!, "main") ?? [];
    expect(raw).toHaveLength(3);
    expect(noting).not.toHaveBeenCalled();
    appendFileSync(f.transcriptPath, `${JSON.stringify({ uuid: "attach", parentUuid: "result", type: "attachment", timestamp: now })}\n`);
    const nativeMarker = { uuid: "cancel", parentUuid: "attach", type: "user", timestamp: now,
      interruptedMessageId: "api-read", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } };
    appendFileSync(f.transcriptPath, `${JSON.stringify(nativeMarker)}\n`);
    const terminal = await coordinator.requestReconcile("interruption append");
    expect(terminal?.selectedAppendedEntryIds).toEqual([]);
    expect(terminal?.terminal).toMatchObject({ uuid: "cancel", entryId: raw.at(-1), fresh: true, interruptedMessageId: "api-read" });
    expect(memory.store.selectedSourceEntryIds(terminal!.coreSessionId!, terminal!.branch)).toEqual(raw);
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(1));
    await coordinator.requestReconcile("duplicate interruption poll");
    expect(noting).toHaveBeenCalledTimes(1);
    const restarted = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    try {
      const history = await restarted.reconcile();
      expect(history.terminal).toMatchObject({ uuid: "cancel", fresh: false });
      expect(history.selectedAppendedEntryIds).toEqual([]);
      appendFileSync(f.transcriptPath, `${JSON.stringify(nativeMarker)}\n`);
      const replay = await restarted.reconcile();
      expect(replay.terminal).toMatchObject({ uuid: "cancel", fresh: false });
      expect(replay.selectedAppendedEntryIds).toEqual([]);
    } finally { restarted.close(); }
  } finally { await coordinator.shutdown("test"); }
});

test("interruption marker requires the selected tool lineage and interrupted API message id", () => {
  const f = fixture("cancel-path");
  (f.records[1]!.message as Record<string, unknown>).id = "api-read";
  (f.records[1]!.message as Record<string, unknown>).stop_reason = "tool_use";
  f.records.splice(-1, 1, { uuid: "result", parentUuid: "a1", type: "user", timestamp: now,
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: "read-call", content: "ok" }] } });
  f.write();
  const cursor = new CcTranscriptCursor();
  const scan = () => {
    const value = cursor.scan(f.transcriptPath, () => {});
    if (!(value instanceof CcTranscriptScan)) return null;
    const terminal = value.selectedTerminal()?.uuid ?? null;
    cursor.commit(value);
    return terminal;
  };
  expect(scan()).toBeNull();
  const marker = (uuid: string, parentUuid: string, interruptedMessageId: string) =>
    appendFileSync(f.transcriptPath, `${JSON.stringify({ uuid, parentUuid, type: "user", timestamp: now,
      interruptedMessageId, message: { role: "user", content: [{ type: "text", text: "untrusted display text" }] } })}\n`);
  marker("wrong-api", "result", "result"); expect(scan()).toBeNull(); // UUID is not the API id.
  marker("sibling", "u1", "api-read"); expect(scan()).toBeNull();
  appendFileSync(f.transcriptPath, `${JSON.stringify({ uuid: "sidechain", parentUuid: "result", type: "user",
    isSidechain: true, timestamp: now, interruptedMessageId: "api-read", message: { role: "user", content: "sidechain" } })}\n`);
  expect(scan()).toBeNull();
  appendFileSync(f.transcriptPath, `${JSON.stringify({ uuid: "invisible", parentUuid: "result", type: "user",
    isVisibleInTranscriptOnly: true, timestamp: now, interruptedMessageId: "api-read", message: { role: "user", content: "hidden" } })}\n`);
  expect(scan()).toBeNull();
  appendFileSync(f.transcriptPath, `${JSON.stringify({ uuid: "summary", parentUuid: "result", type: "user",
    isCompactSummary: true, timestamp: now, interruptedMessageId: "api-read", message: { role: "user", content: "summary" } })}\n`);
  expect(scan()).toBeNull();
  marker("broken", "unknown", "api-read"); expect(scan()).toBeNull();
  marker("valid", "result", "api-read");
  expect(() => cursor.scan(f.transcriptPath, record => { if (record.uuid === "valid") throw Error("interrupted import"); })).toThrow("interrupted import");
  const retried = cursor.scan(f.transcriptPath, () => {});
  expect(retried).toBeInstanceOf(CcTranscriptScan);
  if (!(retried instanceof CcTranscriptScan)) throw Error("expected retry scan");
  expect(retried.newIds.has("valid")).toBe(true); // An aborted scan indexed the UUID but never committed it.
  expect(retried.selectedTerminal()?.uuid).toBe("valid");
  cursor.commit(retried);
  expect(scan()).toBeNull();
  const typedMarker = { uuid: "typed-spoof", parentUuid: "result", type: "user",
    promptSource: "typed", timestamp: now, interruptedMessageId: "api-read",
    message: { role: "user", content: "ordinary-looking prompt" } };
  expect(classifySourceRecord(typedMarker)).toBeNull();
  appendFileSync(f.transcriptPath, `${JSON.stringify(typedMarker)}\n`);
  expect(scan()).toBe("typed-spoof"); // Structured marker stays non-Raw even with native promptSource.

  appendFileSync(f.transcriptPath, `${JSON.stringify({ uuid: "u2", parentUuid: "valid", type: "user", timestamp: now,
    ...sdkPrompt("p2"), message: { role: "user", content: "next" } })}\n`);
  expect(scan()).toBeNull();
  writeFileSync(f.transcriptPath, readFileSync(f.transcriptPath, "utf8")); // Full rebuild keeps history, never a fresh marker.
  expect(scan()).toBeNull();
  appendFileSync(f.transcriptPath, `${JSON.stringify({ uuid: "api-failure", parentUuid: "u2", type: "assistant", timestamp: now,
    isApiErrorMessage: true, message: { role: "assistant", model: "sonnet", stop_reason: "stop_sequence",
      content: [{ type: "text", text: "API failed" }] } })}\n`);
  expect(scan()).toBe("api-failure"); // A non-synthetic API-error row can itself be the selected Raw leaf.
});

test("incremental transcript terminal follows the selected source, not a sibling or replayed turn", () => {
  const f = fixture("native-terminal-cursor"); f.write();
  const cursor = new CcTranscriptCursor();
  const check = () => {
    const scan = cursor.scan(f.transcriptPath, () => {});
    if (!(scan instanceof CcTranscriptScan)) return null;
    const current = scan;
    const terminal = current.selectedTerminal()?.uuid ?? null;
    cursor.commit(current);
    return terminal;
  };
  expect(check()).toBeNull();
  const append = (record: CcNativeRecord) => appendFileSync(f.transcriptPath, `${JSON.stringify(record)}\n`);
  append({ uuid: "u2", parentUuid: "a1", type: "user", timestamp: now, ...sdkPrompt("p2"), message: { role: "user", content: "next" } });
  append({ uuid: "err2", parentUuid: "u2", type: "assistant", timestamp: now, isApiErrorMessage: true,
    message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "API Error" }] } });
  expect(check()).toBe("err2");
  expect(check()).toBeNull(); // No new suffix: the cursor never offers historical work again.
  append({ uuid: "u3", parentUuid: "u2", type: "user", timestamp: now, ...sdkPrompt("p3"), message: { role: "user", content: "new branch" } });
  expect(check()).toBeNull(); // Prior terminal is on a sibling, not the new selected path.
  append({ uuid: "errSibling", parentUuid: "u2", type: "assistant", timestamp: now, isApiErrorMessage: true,
    message: { role: "assistant", model: "<synthetic>", content: [] } });
  expect(check()).toBeNull();
  append({ uuid: "u4", parentUuid: "u3", type: "user", timestamp: now, ...sdkPrompt("p4"), message: { role: "user", content: "new turn" } });
  expect(check()).toBeNull();
  // A whole-file rebuild cannot promote an old error across the later user prompt.
  appendFileSync(f.transcriptPath, `${JSON.stringify({ type: "last-prompt", leafUuid: "u4" })}\n`);
  expect(check()).toBeNull();
  const restored = readFileSync(f.transcriptPath, "utf8");
  writeFileSync(f.transcriptPath, restored);
  expect(check()).toBeNull();
  append({ uuid: "errBroken", parentUuid: "missing-parent", type: "assistant", timestamp: now, isApiErrorMessage: true,
    message: { role: "assistant", model: "<synthetic>", content: [] } });
  expect(check()).toBeNull(); // An unknown parent cannot certify selected ancestry.
});

test("excluded assistant suffix preserves only the selected main-turn terminal", async () => {
  const f = fixture("terminal-excluded"); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
  try {
    await importer.reconcile();
    const append = (record: CcNativeRecord) => appendFileSync(f.transcriptPath, `${JSON.stringify(record)}\n`);
    append({ uuid: "u2", parentUuid: "a1", type: "user", timestamp: now, ...sdkPrompt("p2"), message: { role: "user", content: "next" } });
    append({ uuid: "a2", parentUuid: "u2", type: "assistant", timestamp: now,
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "done" }] } });
    for (const [index, flag] of ["isSidechain", "isCompactSummary", "isVisibleInTranscriptOnly"].entries()) {
      append({ uuid: `excluded-${index}`, parentUuid: "a2", type: "assistant", timestamp: now, [flag]: true,
        ...(index === 0 ? { isApiErrorMessage: true } : {}),
        message: { role: "assistant", stop_reason: index === 1 ? "end_turn" : "tool_use", content: [{ type: "text", text: "excluded" }] } });
    }
    const completed = await importer.reconcile();
    expect(completed.terminal).toMatchObject({ uuid: "a2", entryId: completed.selectedTailId, stopReason: "end_turn" });
    expect(completed.selectedAppendedEntryIds).toContain(completed.selectedTailId);
    expect((await importer.reconcile()).terminal).toBeUndefined();
    append({ uuid: "u3", parentUuid: "a2", type: "user", timestamp: now, ...sdkPrompt("p3"), message: { role: "user", content: "third" } });
    expect((await importer.reconcile()).terminal).toBeUndefined();
    append({ uuid: "a3", parentUuid: "u3", type: "assistant", timestamp: now,
      message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "text", text: "working" }] } });
    expect((await importer.reconcile()).terminal).toBeUndefined();
  } finally { importer.close(); }
});

test("cached terminal is bound to its projection; reselect, new user and restart do not replay it", async () => {
  const f = fixture("terminal-cache");
  (f.records[1]!.message as Record<string, unknown>).stop_reason = "end_turn"; f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
  try {
    await importer.reconcile();
    f.records.splice(-1, 1,
      { uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", ...sdkPrompt("p2"), message: { role: "user", content: "again" } },
      { uuid: "err2", parentUuid: "u2", type: "assistant", timestamp: "2026-01-01T00:00:03.000Z", isApiErrorMessage: true,
        message: { role: "assistant", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: "API Error" }] } });
    f.write();
    const terminal = await importer.reconcile();
    expect(terminal.terminal).toMatchObject({ uuid: "err2", entryId: terminal.selectedTailId });
    expect(terminal.selectedAppendedEntryIds).toEqual([terminal.selectedTailId]);
    const cached = await importer.reconcile();
    expect(cached.terminal).toBeUndefined(); // A no-change cache hit never replays terminal evidence.
    expect(cached.selectedAppendedEntryIds).toEqual([]);
    // Same file stamp, different external binding: short circuit must not use lastResult.
    await updateBinding(f.config, f.nativeSessionId, binding => ({ ...binding!, branch: "external-reselect", selectedLeafUuid: "a1" }));
    const reselected = await importer.reconcile();
    expect(reselected.branch).toBe("external-reselect");
    expect(reselected.terminal?.uuid).toBe("err2"); // Re-derived from the real selected ancestry.
    expect(reselected.selectedAppendedEntryIds).toEqual([]);
    const restarted = new CcImporter(f.config, readBinding(f.config, f.nativeSessionId)!);
    try {
      const historical = await restarted.reconcile();
      expect(historical.terminal?.uuid).toBe("err2");
      expect(historical.selectedAppendedEntryIds).toEqual([]); // No historical terminal opportunity.
    } finally { restarted.close(); }
    f.records.push({ uuid: "u3", parentUuid: "u2", type: "user", timestamp: "2026-01-01T00:00:04.000Z",
      ...sdkPrompt("p3"), message: { role: "user", content: "new branch" } });
    f.write();
    const moved = await importer.reconcile();
    expect(moved.terminal).toBeUndefined();
    expect(moved.selectedTailId).not.toBe(terminal.selectedTailId);
  } finally { importer.close(); }
});

test("a disconnected turn-end control cannot admit after a slow import; a connected one can", async () => {
  const f = fixture("turn-rpc"); enableSyntheticWorker(f);
  (f.records[1]!.message as Record<string, unknown>).stop_reason = "end_turn"; f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  try {
    await coordinator.start();
    (coordinator as any).transcriptWatcher?.close();
    const importer = (coordinator as any).importer as CcImporter;
    const noting = vi.fn(async () => ({ outcome: "success", facts: [] }));
    (importer.memory as any).noting = noting;
    (importer.memory as any).taskEligibility = (phase: string) => ({ due: phase === "noting" });
    await markCcFunctionHook(f.config, f.nativeSessionId);
    const original = importer.reconcile.bind(importer);
    let release!: () => void, arrived!: () => void;
    let held = new Promise<void>(resolve => { release = resolve; });
    let entered = new Promise<void>(resolve => { arrived = resolve; });
    (importer as any).reconcile = async () => { arrived(); await held; return original(); };
    const executor = readBinding(f.config, f.nativeSessionId)!.executor!;
    const socket = createConnection(executor.socketPath);
    await new Promise<void>(resolve => socket.once("connect", resolve));
    socket.write(`${JSON.stringify({ verb: "turn-end", token: executor.token, turnId: "aborted", reason: "answer" })}\n`);
    await entered;
    socket.destroy(); await new Promise<void>(resolve => socket.once("close", resolve));
    release(); await coordinator.requestReconcile("drain disconnected checkpoint");
    expect(noting).not.toHaveBeenCalled();

    held = new Promise<void>(resolve => { release = resolve; });
    entered = new Promise<void>(resolve => { arrived = resolve; });
    f.config.finalSyncTimeoutMs = 1; // A live control request must not expire at an unrelated final-sync deadline.
    const connected = signalCcTurnEnd(f.config, f.nativeSessionId, "still-connected", "answer");
    await entered;
    await sleep(20);
    expect(noting).not.toHaveBeenCalled();
    release(); await connected;
    await vi.waitFor(() => expect(noting).toHaveBeenCalledTimes(1));
  } finally { await coordinator.shutdown("test"); }
});

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

test("registered fork watcher receives done on terminal and stop on external stop/off", async () => {
  const f = fixture("fork-stop-channel"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-fork-stop-"); dirs.push(f.config.stateDir);
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const memory = TraceMemory(f.config.dbPath, async () => ({ outcome: "failure" as const, output: "must not run" }));
  const events: string[] = [];
  const server = await startControlServer(f.config, binding, memory, undefined, undefined, {
    catchup: async () => ({ state: "completed", entriesDone: 0, entriesTotal: 0 }),
    beforeCancel: () => events.push("fenced"), holdImport: () => () => {},
    forkRegister: (_turn, id) => events.push(`registered:${id}`),
    forkTerminal: async (id, _reason, _answer, usage) => { events.push(`terminal:${id}`, `usage:${JSON.stringify(usage)}`); return true; },
    forkAccounted: async id => [`warning for ${id}`],
    forkDisconnected: id => events.push(`disconnected:${id}`),
  });
  const call = (verb: string, agentId: string) => new Promise<any>((resolveReply, reject) => {
    const socket = createConnection(server.executor.socketPath); let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ token: server.executor.token, verb, agentId,
      ...(verb === "fork-register" ? { turnId: "turn" } : {}),
      ...(verb === "fork-terminal" ? { reason: "answer", answer: "done", usage: { input_tokens: 1 } } : {}) })}\n`));
    socket.on("data", chunk => output += chunk);
    socket.on("end", () => { try { resolveReply(JSON.parse(output)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
  try {
    await markCcFunctionHook(f.config, f.nativeSessionId);
    expect(await call("fork-register", "agent-done")).toMatchObject({ ok: true, allowed: true });
    const done = call("fork-watch", "agent-done");
    expect(await call("fork-terminal", "agent-done")).toMatchObject({ ok: true, allowed: true });
    expect(await done).toEqual({ kind: "done", session: f.nativeSessionId, agent: "agent-done" });
    expect(events).toContain('usage:{"input_tokens":1}'); // 108: the event's usage reaches the settlement
    expect(await call("fork-account", "agent-done")).toEqual({ ok: true, verb: "fork-account", allowed: true, warnings: ["warning for agent-done"] });
    expect(await call("fork-register", "agent-early")).toMatchObject({ ok: true });
    expect(await call("fork-terminal", "agent-early")).toMatchObject({ ok: true });
    expect(await call("fork-watch", "agent-early")).toEqual({ kind: "done", session: f.nativeSessionId, agent: "agent-early" });
    expect(await call("fork-register", "agent-stop")).toMatchObject({ ok: true, allowed: true });
    const stop = call("fork-watch", "agent-stop");
    expect((await controlSession(f.config, f.nativeSessionId, "stop")).state).toBe("acknowledged");
    expect(await stop).toEqual({ kind: "stop", session: f.nativeSessionId, agent: "agent-stop" });
    expect(events).toContain("fenced");
    expect(events).not.toContain("disconnected:agent-stop");
    expect(await call("fork-register", "agent-late")).toMatchObject({ ok: true });
    expect((await controlSession(f.config, f.nativeSessionId, "stop")).state).toBe("acknowledged");
    expect(await call("fork-watch", "agent-late")).toEqual({ kind: "stop", session: f.nativeSessionId, agent: "agent-late" });
    expect(await call("fork-watch", "unknown")).toMatchObject({ ok: false });
    expect(await call("fork-register", "agent-no-listener")).toMatchObject({ ok: true });
    expect(await call("fork-disconnect", "agent-no-listener")).toMatchObject({ ok: true, allowed: true });
    expect(events).toContain("disconnected:agent-no-listener");
    expect(await call("fork-watch", "agent-no-listener")).toMatchObject({ ok: false });
    expect(await call("fork-register", "agent-disconnect")).toMatchObject({ ok: true });
    const broken = createConnection(server.executor.socketPath);
    await new Promise<void>((resolveReady, reject) => {
      broken.on("error", reject);
      broken.on("connect", () => broken.write(`${JSON.stringify({ token: server.executor.token,
        verb: "fork-watch", agentId: "agent-disconnect" })}\n`, () => resolveReady()));
    });
    broken.destroy();
    await vi.waitFor(() => expect(events).toContain("disconnected:agent-disconnect"));
    expect(await call("fork-register", "agent-off")).toMatchObject({ ok: true, allowed: true });
    const off = call("fork-watch", "agent-off");
    expect((await controlSession(f.config, f.nativeSessionId, "off")).state).toBe("acknowledged");
    expect(await off).toEqual({ kind: "stop", session: f.nativeSessionId, agent: "agent-off" });
  } finally { await server.close(); memory.close(); }
});

test("native terminal arriving through control before spawn registration waits for exact identity", async () => {
  const f = fixture("early"); f.write();
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const memory = TraceMemory(f.config.dbPath, async () => ({ outcome: "failure" as const, output: "unused" }));
  const authority = new CcForkAuthority();
  const terminal = authority.begin({} as any);
  let sawEarly!: () => void;
  const earlyReceived = new Promise<void>(resolve => { sawEarly = resolve; });
  const server = await startControlServer(f.config, binding, memory, undefined, undefined, {
    catchup: async () => ({ state: "completed", entriesDone: 0, entriesTotal: 0 }),
    beforeCancel: () => authority.cancel(), holdImport: () => () => {},
    forkRegister: (_turn, agent) => authority.register(agent),
    forkDisconnected: agent => { authority.cancelAgent(agent); },
    forkCall: (agent, callId, name) => authority.call(agent, callId, name),
    forkTerminal: (agent, reason, answer) => { sawEarly(); return authority.complete(agent,
      { outcome: reason === "answer" ? "success" : "failure", output: answer }); },
  });
  const send = (verb: string, agentId: string) => new Promise<any>((resolveReply, reject) => {
    const socket = createConnection(server.executor.socketPath); let body = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ verb, token: server.executor.token,
      agentId, ...(verb === "fork-register" ? { turnId: "main" } : verb === "fork-call"
        ? { callId: "late-write", name: "note" } : { reason: "answer", answer: "done" }) })}\n`));
    socket.on("data", chunk => body += chunk);
    socket.on("end", () => { try { resolveReply(JSON.parse(body)); } catch (error) { reject(error); } });
    socket.on("error", reject);
  });
  try {
    await markCcFunctionHook(f.config, f.nativeSessionId);
    const early = send("fork-terminal", "real");
    // The terminal has reached the real control handler before registration is sent.
    await earlyReceived;
    const registration = await send("fork-register", "real");
    expect(registration).toMatchObject({ ok: true, allowed: true });
    expect(await early).toMatchObject({ ok: true, allowed: true });
    expect(await terminal).toMatchObject({ outcome: "success", output: "done" });
    expect(await send("fork-terminal", "unknown")).toMatchObject({ ok: true, allowed: false });
    const cancelled = authority.begin({} as any);
    expect(await send("fork-register", "second")).toMatchObject({ ok: true, allowed: true });
    expect(await send("fork-disconnect", "second")).toMatchObject({ ok: true, allowed: true });
    expect((await cancelled).outcome).toBe("cancelled");
    expect(await send("fork-call", "second")).toMatchObject({ ok: true, allowed: false });
  } finally { await server.close(); memory.close(); }
});

test("control socket routes catchup to the live executor and never creates an operator worker", async () => {
  const f = fixture("control-catchup"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-catchup-"); dirs.push(f.config.stateDir);
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const memory = TraceMemory(f.config.dbPath, async () => ({ outcome: "failure" as const, output: "must not run" }));
  let calls = 0;
  const server = await startControlServer(f.config, binding, memory, undefined, undefined, {
    catchup: async () => { calls++; return { state: "waiting", phase: "noting", entriesDone: 0, entriesTotal: 2 }; },
    beforeCancel: () => {},
    holdImport: () => () => {},
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
  const during = { sessionId: 1, phase: "dreaming" as const, executionId: "during-disable" };
  const cancel = vi.spyOn(memory, "cancelTasks").mockReturnValueOnce([before]).mockReturnValueOnce([before, during]);
  const server = await startControlServer(f.config, binding, memory, undefined, undefined, {
    catchup: async () => ({ state: "completed", entriesDone: 0, entriesTotal: 0 }),
    beforeCancel: () => { cancellations++; },
    holdImport: () => () => {},
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
    // The command is acknowledged at once; its sync and admission follow in the executor.
    await expect(directControl(executor, "catchup")).resolves.toMatchObject({ ok: true, verb: "catchup", catchup: { state: "starting" } });
    await expect(directControl(executor, "catchup")).resolves.toMatchObject({ catchup: { state: "starting" } }); // a repeat is only reported
    const stopped = await directControl(executor, "stop");
    expect(stopped).toMatchObject({ ok: true, verb: "stop" });
    mutex.exec("ROLLBACK"); mutex.close();
    await vi.waitFor(async () => expect((await directControl(executor, "settings")).catchup)
      .toMatchObject({ state: "failed", diagnostic: "catchup was cancelled before admission" }), { timeout: 5_000 });
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
  enableSyntheticWorker(f);
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

test("stop during import does not create an automatic checkpoint; a later turn end remains eligible", async () => {
  const f = fixture("reconcile-stop-epoch"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tmcc-epoch-"); dirs.push(f.config.stateDir);
  f.config.pollIntervalMs = 100_000;
  enableSyntheticWorker(f);
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
    { uuid: "a3", parentUuid: "u3", type: "assistant", timestamp: "2026-01-01T00:00:05.000Z", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "new answer" }] } },
    { type: "last-prompt", leafUuid: "a3" });
  try {
    f.write(); await coordinator.requestReconcile("new turn import");
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

test.each([false, true])("86: SessionEnd permits an executor replacement but rejects a native owner change under lock (native changed=%s)", async nativeChanged => {
  const f = fixture("session-end-owner-change"); f.write();
  const started = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, started); const imported = await importer.reconcile(); importer.close();
  const expected = { executorId: "ending-owner", pid: process.pid, token: "ending-token", socketPath: join(f.dir, "ending.sock"), startedAt: now };
  const replacement = { ...expected, executorId: "replacement-owner", token: "replacement-token" };
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: expected }));
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  const changing = withCcBindingLock(f.config, f.nativeSessionId, async lock => {
    entered(); await hold;
    lock.update(current => ({ ...current!, executor: replacement,
      nativeProcess: nativeChanged ? { ...current!.nativeProcess!, startedAt: "replacement-native-start" } : current!.nativeProcess }));
  });
  await ready;
  const closing = recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath, reason: "other" });
  release(); await changing;
  expect(await closing).toMatchObject(nativeChanged
    ? { confirmed: false, diagnostic: "CC binding changed during SessionEnd close" }
    : { confirmed: true });
  expect(readBinding(f.config, f.nativeSessionId)!.executor).toEqual(nativeChanged ? replacement : null);
  const store = new Store(f.config.dbPath);
  try {
    const closedAt = store.getSession(imported.coreSessionId!)!.closedAt;
    if (nativeChanged) expect(closedAt).toBeNull();
    else expect(closedAt).not.toBeNull();
  } finally { store.close(); }
});

test.each(["prompt_input_exit", "other", "logout"])("86: SessionEnd %s closes with a live executor and an unimported tail", async reason => {
  const f = fixture(`session-end-${reason}`); f.write();
  const started = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, started); const imported = await importer.reconcile(); importer.close();
  const alive = { executorId: "live-owner", pid: process.pid, token: "live-token", socketPath: join(f.dir, "live.sock"), startedAt: now };
  await updateBinding(f.config, f.nativeSessionId, current => ({ ...current!, executor: alive }));
  writeFileSync(f.transcriptPath, [...f.records,
    { uuid: "u2", parentUuid: "a1", type: "user", timestamp: "2026-01-01T00:00:02.000Z", ...sdkPrompt("p2"),
      message: { role: "user", content: "not imported" } }].map(record => `${JSON.stringify(record)}\n`).join("") + '{"uuid":');
  expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath, reason })).toMatchObject({ confirmed: true });
  const store = new Store(f.config.dbPath);
  try {
    expect(store.getSession(imported.coreSessionId!)!.closedAt).not.toBeNull();
    expect(store.findSourceEntry(imported.coreSessionId!, f.nativeSessionId, "u2")).toBeNull();
    const peer = store.createSession({ host: "cc:borrower", enrollmentChoice: true, projectId: store.getSession(imported.coreSessionId!)!.projectId,
      startedAt: now, firstReplyAt: now });
    expect(store.closedTasks("noting", peer.id).some(task => task.sessionId === imported.coreSessionId)).toBe(true);
    expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ executor: null, lastClose: { confirmed: true, reason: `SessionEnd ${reason}` } });
  } finally { store.close(); }
});

test("86: SessionEnd needs no executor and never guesses a missing native process identity", async () => {
  const f = fixture("session-end-no-executor"); f.write();
  const binding = await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const importer = new CcImporter(f.config, binding); const imported = await importer.reconcile(); importer.close();
  const input = { hook_event_name: "SessionEnd" as const, session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath, reason: "logout" };
  expect(readBinding(f.config, f.nativeSessionId)!.executor).toBeNull();
  vi.stubEnv("CLAUDE_PID", "");
  expect(await recordCcSessionEnd(f.config, input)).toMatchObject({ confirmed: false,
    diagnostic: expect.stringContaining("native process identity is unavailable") });
  const store = new Store(f.config.dbPath);
  try { expect(store.getSession(imported.coreSessionId!)!.closedAt).toBeNull(); } finally { store.close(); }
  vi.stubEnv("CLAUDE_PID", String(process.pid));
  expect(await recordCcSessionEnd(f.config, input)).toMatchObject({ confirmed: true });
});

test("86: a still-running coordinator cannot undo SessionEnd by polling or final shutdown", async () => {
  const f = fixture("end-live"); f.write();
  f.config.stateDir = mkdtempSync("/tmp/tm86-close-"); dirs.push(f.config.stateDir);
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId,
    transcript_path: f.transcriptPath }, now);
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId);
  try {
    await coordinator.start();
    const before = readBinding(f.config, f.nativeSessionId)!;
    expect(before.executor).not.toBeNull();
    expect(await recordCcSessionEnd(f.config, { hook_event_name: "SessionEnd", session_id: f.nativeSessionId,
      transcript_path: f.transcriptPath, reason: "other" })).toMatchObject({ confirmed: true });
    await coordinator.requestReconcile("after native close");
    await coordinator.shutdown("stdin EOF");
    expect(readBinding(f.config, f.nativeSessionId)).toMatchObject({ executor: null,
      lastClose: { confirmed: true, reason: "SessionEnd other" } });
    const store = new Store(f.config.dbPath);
    try { expect(store.getSession(before.coreSessionId!)!.closedAt).not.toBeNull(); } finally { store.close(); }
  } finally { await coordinator.shutdown("test cleanup"); }
});

test.each([false, true])("86: unknown-identity SessionStart invalidates the old owner (previously closed=%s)", async closed => {
  const f = fixture(`unknown-owner-${closed}`); f.write();
  const start = { hook_event_name: "SessionStart" as const, session_id: f.nativeSessionId, transcript_path: f.transcriptPath };
  const initial = await recordSessionStart(f.config, start, now);
  const importer = new CcImporter(f.config, initial);
  const imported = await importer.reconcile(); importer.close();
  if (closed) expect((await recordCcSessionEnd(f.config, { ...start, hook_event_name: "SessionEnd", reason: "other" })).confirmed).toBe(true);
  vi.stubEnv("CLAUDE_PID", "");
  const unknown = await recordSessionStart(f.config, { ...start, source: "resume" }, now);
  expect(unknown.nativeProcess).toBeUndefined();
  expect(unknown.lastClose).toBeNull();
  const resumed = new CcImporter(f.config, unknown);
  await resumed.reconcile(); resumed.close();
  vi.stubEnv("CLAUDE_PID", String(process.pid));
  expect(await recordCcSessionEnd(f.config, { ...start, hook_event_name: "SessionEnd", reason: "logout" }))
    .toMatchObject({ confirmed: false, diagnostic: expect.stringContaining("native process identity is unavailable") });
  const store = new Store(f.config.dbPath);
  try { expect(store.getSession(imported.coreSessionId!)!.closedAt).toBeNull(); } finally { store.close(); }
});

test("86: a late SessionEnd from an earlier native process cannot close a reopened session", async () => {
  const f = fixture("session-end-native-generation"); f.write();
  const start = { hook_event_name: "SessionStart" as const, session_id: f.nativeSessionId, transcript_path: f.transcriptPath };
  const binding = await recordSessionStart(f.config, start, now);
  const importer = new CcImporter(f.config, binding); const imported = await importer.reconcile(); importer.close();
  const newer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    vi.stubEnv("CLAUDE_PID", String(newer.pid!));
    await recordSessionStart(f.config, { ...start, source: "resume" }, now);
    expect(readBinding(f.config, f.nativeSessionId)!.nativeProcess!.pid).toBe(newer.pid);
    vi.stubEnv("CLAUDE_PID", String(process.pid));
    expect(await recordCcSessionEnd(f.config, { ...start, hook_event_name: "SessionEnd", reason: "logout" }))
      .toMatchObject({ confirmed: false, diagnostic: "SessionEnd belongs to an earlier native process" });
    const store = new Store(f.config.dbPath);
    try { expect(store.getSession(imported.coreSessionId!)!.closedAt).toBeNull(); } finally { store.close(); }
  } finally { newer.kill("SIGTERM"); await childExit(newer); }
});

// Ticket 108: a CC fork's cost is amended into its run after the fork settled. Shutdown waits for that, and the
// run is found by its transcript path however many runs core recorded since.
async function forkAccountingFixture(label: string, laterRuns: number) {
  const f = fixture(label); enableSyntheticWorker(f); f.write();
  await recordSessionStart(f.config, { hook_event_name: "SessionStart", session_id: f.nativeSessionId, transcript_path: f.transcriptPath }, now);
  const coordinator = new CcCoordinator(f.config, f.nativeSessionId, () => {});
  await coordinator.start();
  const memory = (coordinator as any).importer.memory, store: Store = memory.store;
  const sessionId = (store.db.prepare("SELECT id FROM sessions LIMIT 1").get() as { id: number }).id;
  const nativeLog = join(f.dir, "agent-x.jsonl");
  const tokens = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
  (coordinator as any).catalog = () => ({ tiers: { t: { input: 1e6, output: 1e6, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, web_search: 0 } }, models: { m: "t" } });
  let settle!: (result: unknown) => void;
  vi.spyOn((coordinator as any).forkAuthority, "begin").mockReturnValue(new Promise(resolve => { settle = resolve; }));
  (coordinator as any).forkLaunch = { turnId: "t", resolve: () => {}, signal: new AbortController().signal };
 
  const settled = (coordinator as any).runFork({ sessionId, text: "note" });
  const record = (response: object) => store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "success", createdAt: now, response: JSON.stringify(response) }).id;
  const runId = record({ nativeLog, usage: { ...tokens } });
  for (let i = 0; i < laterRuns; i++) record({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } });
  settle({ outcome: "success", nativeLog, usage: tokens });
  await settled;
  const transcript = JSON.stringify({ type: "assistant", message: { id: "a", model: "m", usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
  return { coordinator, store, runId, nativeLog, transcript, cost: () => (store.db.prepare("SELECT usage_cost FROM runs WHERE id = ?").get(runId) as { usage_cost: number | null }).usage_cost };
}

test("shutdown waits for fork accounting: a transcript flushed after shutdown began is still read and priced", async () => {
  const a = await forkAccountingFixture("acct-late", 0);
  setTimeout(() => writeFileSync(a.nativeLog, a.transcript), 400);
  expect(a.cost()).toBeNull();
  await a.coordinator.shutdown("test");
  expect(a.store.closed).toBe(true);
  // Read through a fresh connection: the amendment reached the run before the Store closed.
  const db = new Store((a.coordinator as any).config.dbPath);
  try { expect((db.db.prepare("SELECT usage_cost FROM runs WHERE id = ?").get(a.runId) as { usage_cost: number }).usage_cost).toBeCloseTo(15, 6); } finally { db.close(); }
});

test("the settled fork's run is found by its transcript path after more than five later noting runs", async () => {
  const a = await forkAccountingFixture("acct-later", 7);
  writeFileSync(a.nativeLog, a.transcript);
  await (coordinatorAccounting(a.coordinator));
  expect(a.cost()).not.toBeNull();
  await a.coordinator.shutdown("test");
});
const coordinatorAccounting = (coordinator: any) => Promise.allSettled([...coordinator.forkAccounting]);
