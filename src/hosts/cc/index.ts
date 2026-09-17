import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveCcHostConfig, type CcHostConfig, type ResolvedCcHostConfig } from "./config.ts";
import { recordSessionStart, validateNativeSessionId, type CcHookInput } from "./binding.ts";
import { nativeCreatedAt, readCompleteTranscript } from "./transcript.ts";
import { CcCoordinator, recordCcSessionEnd } from "./lifecycle.ts";
import { CcForegroundTools } from "./tools.ts";
import { ccSessionStartInjection, type CcHookOutput } from "./injection.ts";

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

export async function handleCcHook(configInput: CcHostConfig | ResolvedCcHostConfig, input: CcHookInput): Promise<CcHookOutput | null> {
  const config = resolveCcHostConfig(configInput);
  validateNativeSessionId(input.session_id);
  if (input.hook_event_name === "SessionStart") {
    const snapshot = readCompleteTranscript(input.transcript_path);
    await recordSessionStart(config, input, snapshot.exists && !snapshot.problem ? nativeCreatedAt(snapshot.records) : null);
    return ccSessionStartInjection(config, input);
  }
  if (input.hook_event_name !== "SessionEnd") throw new Error(`unsupported Claude Code Hook ${String(input.hook_event_name)}`);
  const result = await recordCcSessionEnd(config, input);
  if (!result.confirmed) console.error(`Trace Memory CC: SessionEnd close not confirmed: ${result.diagnostic ?? result.reason}`);
  return null;
}

export async function runCcStdioMcp(configInput: CcHostConfig | ResolvedCcHostConfig,
  nativeSessionId = process.env.CLAUDE_CODE_SESSION_ID): Promise<void> {
  const config = resolveCcHostConfig(configInput), sessionId = validateNativeSessionId(nativeSessionId);
  const runtimeDirectory = join(config.stateDir, "runtime"), runtimePath = join(runtimeDirectory, `${sessionId}.jsonl`);
  mkdirSync(runtimeDirectory, { recursive: true });
  const runtimeEvent = (event: string, details: Record<string, unknown> = {}) => {
    const value = { event, at: Date.now(), pid: process.pid, ...details };
    console.error(`Trace Memory CC: lifecycle ${JSON.stringify(value)}`);
    try { appendFileSync(runtimePath, `${JSON.stringify(value)}\n`, { mode: 0o600 }); }
    catch (error) { console.error(`Trace Memory CC: lifecycle journal failed: ${String(error)}`); }
  };
  const coordinator = new CcCoordinator(config, sessionId, message => {
    console.error(`Trace Memory CC: ${message}`);
    try { appendFileSync(runtimePath, `${JSON.stringify({ event: "coordinator", at: Date.now(), pid: process.pid, message })}\n`, { mode: 0o600 }); }
    catch (error) { console.error(`Trace Memory CC: lifecycle journal failed: ${String(error)}`); }
  });
  const foreground = new CcForegroundTools(coordinator);
  const pendingCalls = new Map<string, AbortController>();
  let buffer = "", ending: Promise<void> | null = null, notifyEnding!: () => void;
  const endingStarted = new Promise<void>(resolveEnding => { notifyEnding = resolveEnding; });
  const finish = (reason: string) => {
    if (ending) return ending;
    runtimeEvent("shutdown-request", { reason });
    ending = (async () => {
      for (const controller of pendingCalls.values()) controller.abort(new DOMException("MCP shutdown", "AbortError"));
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
  await endingStarted;
  await ending;
  await startup;
}

function readConfig(path: string): ResolvedCcHostConfig {
  return resolveCcHostConfig(JSON.parse(readFileSync(resolve(path), "utf8")));
}

async function readStdin(): Promise<string> {
  let input = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

const direct = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (direct) void (async () => {
  const [command, configFlag, configPath] = process.argv.slice(2);
  if ((command !== "mcp" && command !== "hook") || configFlag !== "--config" || !configPath)
    throw new Error("usage: node src/hosts/cc/index.ts mcp|hook --config /absolute/path/to/cc.config.json");
  const config = readConfig(configPath);
  if (command === "mcp") { await runCcStdioMcp(config); process.exit(process.exitCode ?? 0); }
  else {
    const output = await handleCcHook(config, JSON.parse(await readStdin()));
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  }
})().catch(error => { console.error(`Trace Memory CC: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; });
