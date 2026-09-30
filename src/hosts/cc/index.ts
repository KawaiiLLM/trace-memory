import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCcHostConfig, type CcHostConfig, type ResolvedCcHostConfig } from "./config.ts";
import { upgradeSettingsFile } from "../retired-settings.ts";
import { assertOperatorBinding, markCcFunctionHook, readBinding, recordSessionStart, updateBinding, validateNativeSessionId, type CcHookInput } from "./binding.ts";
import { readTranscriptCreatedAt } from "./transcript.ts";
import { CcCoordinator, recordCcSessionEnd } from "./lifecycle.ts";
import { CcForegroundTools } from "./tools.ts";
import { ccCompaction, ccDeltaInjection, ccPrepareSessionStartInjection, ccPreparedSessionStartInjection, ccSessionStartInjection, type CcHookOutput } from "./injection.ts";
import { sliceCcInjection } from "./slices.ts";
import { declareCcProject, operateCcSession } from "./operator.ts";
import { followNativeSession, processAncestors, publishNativeSession, type CcNativeSessionFollower } from "./native-session.ts";
import { installCcNativeRejectionGuard } from "./native-rejection.ts";
import { readCcMenu, readCcRuns } from "./menu.ts";
import type { CcContextSnapshot } from "./menu-context.ts";
import { editedCcConfig, saveCcConfig, type CcSettingId } from "./menu-config.ts";
import { executorSettings, executorSnapshot, requestCcForkSources, requestCcForkWarnings, signalCcForkEvent, signalCcTurnEnd, waitCcForkCommand } from "./control.ts";
import { runCcFiles } from "./files.ts";
import { Store } from "../../core/store/index.ts";
import { parseRunsCount } from "../trace-menu.ts";

export * from "./config.ts";
export * from "./binding.ts";
export * from "./transcript.ts";
export * from "./importer.ts";
export * from "./control.ts";
export * from "./lifecycle.ts";
export * from "./tools.ts";
export * from "./worker.ts";
export * from "./scheduler.ts";
export * from "./injection.ts";
export * from "./operator.ts";
export * from "./native-session.ts";

export async function handleCcHook(configInput: CcHostConfig | ResolvedCcHostConfig, input: CcHookInput,
  prepareOnly = false): Promise<CcHookOutput | null> {
  const config = "coreConfig" in configInput ? configInput : resolveCcHostConfig(configInput);
  validateNativeSessionId(input.session_id);
  if (input.hook_event_name === "SessionStart") {
    // 102: `/clear` starts an ordinary new session, like startup. Creation time matters only to a new
    // binding; a bound session's transcript is not read.
    await recordSessionStart(config, input, readBinding(config, input.session_id) ? null : readTranscriptCreatedAt(input.transcript_path));
    // 65: tell this Claude Code process's executor which session it serves; never fails the Hook.
    try { if (!publishNativeSession(config, input)) console.error("Trace Memory CC: CLAUDE_PID is not set; the executor keeps its own session id"); }
    catch (error) { console.error(`Trace Memory CC: native session publish failed: ${error instanceof Error ? error.message : String(error)}`); }
    if (prepareOnly) { await ccPrepareSessionStartInjection(config, input); return null; }
    return ccSessionStartInjection(config, input);
  }
  if (input.hook_event_name !== "SessionEnd") throw new Error(`unsupported Claude Code Hook ${String(input.hook_event_name)}`);
  const result = await recordCcSessionEnd(config, input);
  if (!result.confirmed) console.error(`Trace Memory CC: SessionEnd close not confirmed: ${result.diagnostic ?? result.reason}`);
  return null;
}

export async function runCcStdioMcp(configInput: CcHostConfig | ResolvedCcHostConfig,
  nativeSessionId = process.env.CLAUDE_CODE_SESSION_ID, configPath?: string): Promise<void> {
  const config = "coreConfig" in configInput ? configInput : resolveCcHostConfig(configInput);
  const sessionId = validateNativeSessionId(nativeSessionId);
  const runtimeDirectory = join(config.stateDir, "runtime"), runtimePath = join(runtimeDirectory, `${sessionId}.jsonl`);
  mkdirSync(runtimeDirectory, { recursive: true });
  const runtimeEvent = (event: string, details: Record<string, unknown> = {}) => {
    const value = { event, at: Date.now(), pid: process.pid, ...details };
    console.error(`Trace Memory CC: lifecycle ${JSON.stringify(value)}`);
    try { appendFileSync(runtimePath, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
    catch (error) { console.error(`Trace Memory CC: lifecycle journal failed: ${String(error)}`); }
  };
  const disposeNativeRejectionGuard = installCcNativeRejectionGuard();
  const coordinator = new CcCoordinator(config, sessionId, message => {
    console.error(`Trace Memory CC: ${message}`);
    try { appendFileSync(runtimePath, `${JSON.stringify({ event: "coordinator", at: Date.now(), pid: process.pid, message })}\n`, { mode: 0o600 }); }
    catch (error) { console.error(`Trace Memory CC: lifecycle journal failed: ${String(error)}`); }
  }, undefined, runtimeEvent, configPath);
  const foreground = new CcForegroundTools(coordinator);
  // 65: the Hook's id is authoritative. Until the coordinator attaches, an assignment for this
  // process's ancestors re-targets it; afterwards (102) the executor leaves the attached session as an
  // exit does and attaches to the assigned one as at startup.
  let follower: CcNativeSessionFollower | null = null;
  try {
    const ancestors = processAncestors();
    runtimeEvent("native-ancestors", { ancestors });
    follower = followNativeSession(config, ancestors, record => {
      if (coordinator.adoptNativeSessionId(record.nativeSessionId)) return;
      void coordinator.retargetTo(record.nativeSessionId).then(retargeted =>
        runtimeEvent(retargeted ? "session-id-retargeted" : "session-id-retarget-failed", { to: record.nativeSessionId, source: record.source }));
    }, message => runtimeEvent("native-session-follow", { message }));
  } catch (error) { runtimeEvent("native-session-follow-unavailable", { error: error instanceof Error ? error.message : String(error) }); }
  const pendingCalls = new Map<string, AbortController>();
  let buffer = "", ending: Promise<void> | null = null, notifyEnding!: () => void;
  const endingStarted = new Promise<void>(resolveEnding => { notifyEnding = resolveEnding; });
  const finish = (reason: string) => {
    if (ending) return ending;
    runtimeEvent("shutdown-request", { reason });
    ending = (async () => {
      for (const controller of pendingCalls.values()) controller.abort(new DOMException("MCP shutdown", "AbortError"));
      follower?.stop();
      process.stdin.destroy();
      const result = await coordinator.shutdown(reason);
      if (!result.confirmed) process.exitCode = 1;
    })();
    notifyEnding();
    return ending;
  };
  const reply = (id: unknown, result?: unknown, error?: { code: number; message: string }) =>
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let request: { id?: unknown; method?: unknown; params?: unknown };
      try { request = JSON.parse(line); }
      catch { console.error("Trace Memory CC: invalid MCP JSON-RPC input"); continue; }
      if (request.method === "notifications/cancelled") {
        const cancelled = (request.params as { requestId?: unknown } | undefined)?.requestId;
        pendingCalls.get(JSON.stringify(cancelled))?.abort(new DOMException("MCP call cancelled", "AbortError"));
        continue;
      }
      if (request.id === undefined) continue;
      if (request.method === "initialize") reply(request.id, {
        protocolVersion: (request.params as { protocolVersion?: string } | undefined)?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} }, serverInfo: { name: "trace-memory", version: "0.1.0-beta.7" },
      });
      else if (request.method === "tools/list") reply(request.id, { tools: foreground.list() });
      else if (request.method === "tools/call") {
        const key = JSON.stringify(request.id), controller = new AbortController();
        if (pendingCalls.has(key)) { reply(request.id, undefined, { code: -32600, message: "duplicate in-flight request id" }); continue; }
        pendingCalls.set(key, controller);
        const params = request.params as { name?: unknown; arguments?: unknown; _meta?: unknown } | undefined;
        void foreground.call(params?.name, params?.arguments, params?._meta, controller.signal)
          .then(result => reply(request.id, result), error => reply(request.id, undefined,
            { code: -32603, message: error instanceof Error ? error.message : String(error) }))
          .finally(() => pendingCalls.delete(key));
      } else reply(request.id, undefined, { code: -32601, message: "method not found" });
    }
  });
  process.stdin.on("end", () => { void finish("stdio EOF"); });
  process.once("SIGINT", () => { void finish("SIGINT"); });
  process.once("SIGTERM", () => { void finish("SIGTERM"); });
  process.once("SIGHUP", () => { void finish("SIGHUP"); });
  runtimeEvent("handlers-registered");
  process.once("exit", code => runtimeEvent("process-exit", { code }));
  const startup = coordinator.start().catch(async error => {
    runtimeEvent("startup-failed", { error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
    await finish("startup failure");
  });
  try {
    await endingStarted;
    await ending;
    await startup;
  } finally { disposeNativeRejectionGuard(); }
}

function readConfig(path: string): ResolvedCcHostConfig {
  if (!path.startsWith("/")) throw new Error("CC configuration path must be absolute");
  upgradeSettingsFile(path, undefined, values => resolveCcHostConfig(values as unknown as CcHostConfig), message => console.warn(message));
  return resolveCcHostConfig(JSON.parse(readFileSync(path, "utf8")));
}

async function readStdin(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

export async function runCcCommand(argv = process.argv.slice(2)): Promise<void> {
  const [command, configFlag, configPath, sessionFlag, nativeSessionId, verb, ...rest] = argv;
  if ((command !== "mcp" && command !== "hook" && command !== "hook-prepare" && command !== "hook-slices" && command !== "hook-delta" &&
      command !== "hook-compact" && command !== "hook-capable" && command !== "hook-turn" && command !== "hook-sources" && command !== "hook-fork" && command !== "hook-fork-watch" && command !== "cli" && command !== "fs") || configFlag !== "--config" || !configPath)
    throw new Error("usage: cc.cjs mcp|hook --config /absolute/path/to/cc.config.json | cc.cjs cli --config /absolute/path/to/cc.config.json --session <native-id> on|off|stop|catchup|project [name] | cc.cjs fs --config /absolute/path/to/cc.config.json --session <native-id> read|grep|glob ...");
  const config = readConfig(configPath);
  if (command === "mcp") { await runCcStdioMcp(config, undefined, configPath); return; }
  if (command === "hook-capable" || command === "hook-turn" || command === "hook-sources") {
    const input = JSON.parse(await readStdin()) as { session_id?: unknown; turnId?: unknown; reason?: unknown;
      observation?: import("./control.ts").CcForkObservation };
    const session = validateNativeSessionId(input.session_id);
    if (command === "hook-capable") await markCcFunctionHook(config, session);
    else if (command === "hook-sources") {
      if (typeof input.turnId !== "string" || !input.turnId) throw new Error("CC fork source read requires native turnId");
      process.stdout.write(`${JSON.stringify(await requestCcForkSources(config, session, input.turnId))}\n`);
    } else {
      if (typeof input.turnId !== "string" || !input.turnId || typeof input.reason !== "string")
        throw new Error("CC turn-end hook requires native turnId and reason");
      process.stdout.write(`${JSON.stringify(await signalCcTurnEnd(config, session, input.turnId, input.reason, input.observation))}\n`);
    }
    return;
  }
  if (command === "hook-fork-watch") {
    if (sessionFlag !== "--session" || typeof nativeSessionId !== "string" || !nativeSessionId || typeof verb !== "string" || !verb)
      throw new Error("CC fork stop listener requires native session and agent ID");
    validateNativeSessionId(nativeSessionId);
    process.stdout.write(`${JSON.stringify(await waitCcForkCommand(config, nativeSessionId, verb))}\n`);
    return;
  }
  if (command === "hook-fork") {
    const input = JSON.parse(await readStdin()) as { session_id: string; verb: "fork-register" | "fork-call" | "fork-check" | "fork-terminal" | "fork-account" | "fork-no-start" | "fork-disconnect";
      turnId?: string; agentId?: string; callId?: string; name?: string; reason?: string; answer?: string; confirmed?: boolean; usage?: unknown };
    validateNativeSessionId(input.session_id);
    if (!["fork-register", "fork-call", "fork-check", "fork-terminal", "fork-account", "fork-no-start", "fork-disconnect"].includes(input.verb))
      throw new Error("invalid CC native fork event");
    if (input.verb === "fork-account") {
      if (typeof input.agentId !== "string" || !input.agentId) throw new Error("CC fork accounting requires the native agent ID");
      process.stdout.write(`${JSON.stringify({ allowed: true, warnings: await requestCcForkWarnings(config, input.session_id, input.agentId) })}\n`);
      return;
    }
    const { session_id: _session, verb: _verb, ...detail } = input;
    process.stdout.write(`${JSON.stringify({ allowed: await signalCcForkEvent(config, input.session_id, input.verb, detail) })}\n`);
    return;
  }
  if (command === "hook-compact") {
    // 102: the `session.compact` function hook's compaction; `passThrough` keeps native compaction.
    // `auto` (requirement 14) is the caller's own event trigger, manual or auto, not the handle below.
    const input = JSON.parse(await readStdin()) as { session_id: string; trigger: unknown; auto?: unknown };
    validateNativeSessionId(input.session_id);
    if (typeof input.trigger !== "string" || !input.trigger) throw new Error("CC compaction requires the handle of its newest message");
    const built = await ccCompaction(config, { session_id: input.session_id, trigger: input.trigger, auto: input.auto === true });
    process.stdout.write(`${JSON.stringify(built ?? { passThrough: true })}\n`);
    return;
  }
  if (command === "hook-delta") {
    const input = JSON.parse(await readStdin()) as { session_id: string; transcript_path?: string; prompt_id?: unknown;
      messages?: unknown; hook_event_name?: string };
    validateNativeSessionId(input.session_id);
    const binding = readBinding(config, input.session_id);
    if (!binding || input.transcript_path !== undefined && input.transcript_path !== binding.transcriptPath)
      throw new Error("CC delta native session or transcript binding is unavailable");
    if (input.messages !== undefined && (!Array.isArray(input.messages) || input.hook_event_name !== "session.compact"))
      throw new Error("CC compact delta requires returned messages");
    if (input.messages === undefined && input.hook_event_name !== "UserPromptSubmit")
      throw new Error("CC prompt delta requires UserPromptSubmit");
    // 97: the prompt's own node is its native prompt id; the compacted messages are not read.
    if (input.messages === undefined && (typeof input.prompt_id !== "string" || !input.prompt_id))
      throw new Error("CC prompt delta requires the native prompt_id");
    const slices = await ccDeltaInjection(config, { session_id: input.session_id, transcript_path: binding.transcriptPath },
      input.messages ? { kind: "compact" } : { kind: "prompt", promptId: input.prompt_id as string },
      (output, visible) => sliceCcInjection(visible, output?.transportItems ?? [], undefined, output?.transportKnowledgeAllowance));
    process.stdout.write(`${JSON.stringify({ slices })}\n`);
    return;
  }
  if (command === "hook" || command === "hook-prepare" || command === "hook-slices") {
    const input = JSON.parse(await readStdin()) as CcHookInput;
    if (command !== "hook-slices") {
      const output = await handleCcHook(config, input, command === "hook-prepare");
      if (command === "hook" && output) { const { transportItems: _, transportKnowledgeAllowance: _allowance, ...native } = output; process.stdout.write(`${JSON.stringify(native)}\n`); }
      return;
    }
    if (input.hook_event_name !== "SessionStart") throw new Error("hook-slices requires SessionStart");
    const sliced = (output: CcHookOutput | null, visible: { db: string; nativeSession: string; coreSession: number | null }) => {
      if (output?.hookSpecificOutput.additionalContext && !output.transportItems)
        throw new Error("CC SessionStart has no structured transport material");
      return sliceCcInjection(visible, output?.transportItems ?? [], output?.systemMessage, output?.transportKnowledgeAllowance);
    };
    const { output, slices, snapshot } = await ccPreparedSessionStartInjection(config, input, sliced);
    const bound = readBinding(config, input.session_id);
    if (!bound) throw new Error("CC SessionStart has no binding after preparation");
    // A clean SessionStart clears the last compaction warning a binding may still carry.
    if (bound.lastCompactionNotice) {
      await updateBinding(config, input.session_id, current => {
        if (!current || current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path)
          throw new Error("CC binding changed before transport warning was recorded");
        return { ...current, lastCompactionNotice: null };
      });
    }
    const selection = createHash("sha256").update(JSON.stringify({ material: output?.transportItems ?? [],
      warning: output?.systemMessage ?? null, knowledgeAllowance: output?.transportKnowledgeAllowance ?? null })).digest("hex");
    process.stdout.write(`${JSON.stringify({ selection, snapshot, slices })}\n`);
    return;
  }
  if (sessionFlag !== "--session" || !nativeSessionId || !verb)
    throw new Error("CLI requires --session <native-id> and a command");
  // 101: the `/tm` read-only files the function hook answers Read, Grep and Glob from.
  if (command === "fs") { process.stdout.write(`${JSON.stringify(runCcFiles(config, nativeSessionId, [verb, ...rest]))}\n`); return; }
  if (verb === "menu" || verb === "runs") {
    if (rest[0] !== "--json" || verb === "menu" && !(rest.length === 1 || rest.length === 2 && rest[1] === "--snapshot") || verb === "runs" && rest.length !== 2)
      throw new Error(verb === "runs" ? "runs requires --json <count>" : "menu requires --json [--snapshot]");
    const runLimit = verb === "runs" ? parseRunsCount(rest[1]!) : 10;
    if (verb === "runs") { process.stdout.write(`${JSON.stringify({ runs: readCcRuns(config, nativeSessionId, runLimit) })}\n`); return; }
    let effective: Awaited<ReturnType<typeof executorSnapshot>> | undefined;
    try { effective = await executorSnapshot(config, nativeSessionId); }
    catch { /* The menu remains navigable; its worker values are explicitly unavailable. */ }
    const current = rest[1] === "--snapshot" ? JSON.parse(await readStdin()) as CcContextSnapshot : undefined;
    const data = readCcMenu(config, nativeSessionId, effective?.config, 10, effective?.catchup, current);
    process.stdout.write(`${JSON.stringify(data)}\n`);
    return;
  }
  if (verb === "setting") {
    const [id, value, capacity] = rest;
    if (!id || value === undefined || rest.length > 3) throw new Error("setting requires <row-id> <value> [capacity]");
    if (id.startsWith("budget.")) {
      if (!["budget.global", "budget.project", "budget.session"].includes(id) || capacity !== undefined)
        throw new Error(`unsupported CC setting ${id}`);
      const amount = Number(value);
      if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Knowledge budget must be a non-negative safe integer");
      const store = new Store(config.dbPath);
      try {
        const binding = readBinding(config, validateNativeSessionId(nativeSessionId));
        if (!binding) throw new Error(`Claude Code session ${nativeSessionId} is not bound`);
        assertOperatorBinding(config, binding, store);
        store.setKnowledgeBudget(id.slice(7) as "global" | "project" | "session", amount);
      }
      finally { store.close(); }
      process.stdout.write(`${JSON.stringify({ saved: true, applied: true })}\n`); return;
    }
    const store = new Store(config.dbPath);
    try {
      const binding = readBinding(config, validateNativeSessionId(nativeSessionId));
      if (!binding) throw new Error(`Claude Code session ${nativeSessionId} is not bound`);
      assertOperatorBinding(config, binding, store);
    } finally { store.close(); }
    const original = readFileSync(configPath, "utf8");
    const updated = editedCcConfig(original, id as CcSettingId, value, capacity);
    const prepared = resolveCcHostConfig(JSON.parse(updated));
    if (prepared.dbPath !== config.dbPath || prepared.stateDir !== config.stateDir) throw new Error("setting cannot change database or state directory");
    const next = saveCcConfig(configPath, original, updated);
    try { await executorSettings(next, nativeSessionId, { path: configPath, expected: updated });
      process.stdout.write(`${JSON.stringify({ saved: true, applied: true })}\n`);
    } catch (error) { process.stdout.write(`${JSON.stringify({ saved: true, applied: false,
      diagnostic: error instanceof Error ? error.message : String(error) })}\n`); }
    return;
  }
  if (verb !== "project" && rest.length) throw new Error(`CC operator command ${verb} accepts no arguments`);
  const result = verb === "project" ? await declareCcProject(config, nativeSessionId, rest.join(" "))
    : verb === "on" || verb === "off" || verb === "stop" || verb === "catchup" ? await operateCcSession(config, nativeSessionId, verb)
    : (() => { throw new Error(`unknown CC operator command ${verb}`); })();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const direct = process.argv[1]?.endsWith("/index.ts") && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) void runCcCommand().catch(error => {
  console.error(`Trace Memory CC: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1;
});
