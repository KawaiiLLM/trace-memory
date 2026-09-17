import { appendFileSync, chmodSync, mkdirSync, openSync, closeSync } from "node:fs";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";
import { createSdkMcpServer, query, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { ConsolidationAgentInput, NotingAgentInput, RunAgent, RunAgentResult, ToolDefinition } from "../../core/api/index.ts";
import { toolRejected } from "../../core/api/index.ts";
import { CC_AGENT_SDK_VERSION, CC_CONTEXT_HEADROOM, type ResolvedCcHostConfig, type ResolvedCcWorkerConfig } from "./config.ts";
import { CC_MAX_RESULT_CHARS } from "./tools.ts";

export type CcAgentTask = NotingAgentInput | ConsolidationAgentInput;
const execFileAsync = promisify(execFile);
const AUDIT_UNAVAILABLE = `Claude Agent SDK ${CC_AGENT_SDK_VERSION} does not expose the exact provider request body`;

export interface CcWorkerDependencies {
  /** Native probes supply an isolated loopback environment. Production uses the filtered host environment below. */
  environment?: NodeJS.ProcessEnv;
  /** Production-interface tests replace only transport execution; tool serving stays production code. */
  query?: typeof query;
}

interface WaitingOrigin { resolve(value: string): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

/** Correlates native MCP handlers to underlying assistant responses, not SDK envelope UUIDs. */
export class CcResponseOrigins {
  private readonly task: CcAgentTask;
  private readonly timeoutMs: number;
  private readonly maxToolRounds: number;
  private readonly responseIds = new Set<string>();
  private readonly toolRoundIds = new Set<string>();
  private readonly origins = new Map<string, string>();
  private readonly claimed = new Set<string>();
  private readonly waiters = new Map<string, WaitingOrigin[]>();
  private failure: Error | null = null;
  private readonly onFailure: (error: Error) => void;

  constructor(task: CcAgentTask, timeoutMs: number, maxToolRounds: number, onFailure: (error: Error) => void) {
    this.task = task; this.timeoutMs = timeoutMs; this.maxToolRounds = maxToolRounds; this.onFailure = onFailure;
    task.signal?.addEventListener("abort", () => this.close(new Error("CC worker cancelled while awaiting assistant response origin")), { once: true });
  }

  observe(message: SDKAssistantMessage): void {
    if (this.failure) throw this.failure;
    const responseId = message.message.id;
    if (typeof responseId !== "string" || !responseId) throw this.fail(new Error("CC assistant response has no valid message.id"));
    const blocks = message.message.content.filter((block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use");
    if (!this.responseIds.has(responseId)) {
      this.responseIds.add(responseId);
      // The response proves the preceding native request boundary. Acknowledge before any handler
      // from this response is released; another block from this same response gains no new generation.
      this.task.acknowledgeRequest();
    }
    if (blocks.length && !this.toolRoundIds.has(responseId)) {
      this.toolRoundIds.add(responseId);
      if (this.maxToolRounds > 0 && this.toolRoundIds.size > this.maxToolRounds)
        throw this.fail(new Error(`CC worker exceeded ${this.maxToolRounds} tool rounds`));
    }
    for (const block of blocks) {
      const prior = this.origins.get(block.id);
      if (prior && prior !== responseId)
        throw this.fail(new Error(`CC tool use ${block.id} is ambiguous across assistant responses`));
      this.origins.set(block.id, responseId);
      for (const waiter of this.waiters.get(block.id) ?? []) {
        clearTimeout(waiter.timer); waiter.resolve(responseId);
      }
      this.waiters.delete(block.id);
    }
  }

  async origin(extra: unknown): Promise<string> {
    if (this.failure) throw this.failure;
    const id = (extra as { _meta?: Record<string, unknown> } | undefined)?._meta?.["claudecode/toolUseId"];
    if (typeof id !== "string" || !id) throw this.fail(new Error("CC tool handler is missing claudecode/toolUseId metadata"));
    if (this.claimed.has(id)) throw this.fail(new Error(`CC tool use ${id} was handled more than once`));
    this.claimed.add(id);
    const known = this.origins.get(id);
    if (known) return known;
    return new Promise<string>((resolve, reject) => {
      const waiter: WaitingOrigin = { resolve, reject, timer: setTimeout(() => {
        const rows = this.waiters.get(id) ?? [];
        this.waiters.set(id, rows.filter(row => row !== waiter));
        reject(this.fail(new Error(`CC assistant response origin timed out for tool use ${id}`)));
      }, this.timeoutMs) };
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), waiter]);
    });
  }

  rounds(): number { return this.toolRoundIds.size; }
  error(): Error | null { return this.failure; }

  close(error = new Error("CC response-origin coordinator closed")): void {
    if (!this.failure) this.failure = error;
    for (const rows of this.waiters.values()) for (const waiter of rows) {
      clearTimeout(waiter.timer); waiter.reject(this.failure);
    }
    this.waiters.clear();
  }

  private fail(error: Error): Error {
    this.close(error); this.onFailure(error); return error;
  }
}

const OPERATIONAL_ENV_KEYS = new Set([
  "HOME", "PATH", "TMPDIR", "TMP", "TEMP", "LANG", "TZ", "SHELL", "USER", "LOGNAME",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
]);
const SESSION_ENV_KEYS = new Set([
  "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_CUSTOM_HEADERS",
  "NODE_EXTRA_CA_CERTS", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "all_proxy", "ALL_PROXY", "no_proxy", "NO_PROXY",
  "NODE_USE_ENV_PROXY", "CLAUDE_CODE_PROXY_RESOLVES_HOSTS", "CLAUDE_CONFIG_DIR",
]);

function productionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && (OPERATIONAL_ENV_KEYS.has(key) || SESSION_ENV_KEYS.has(key) || key.startsWith("LC_"))) result[key] = value;
  return { ...result, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" };
}

const RESULT_SIZE_META = { "anthropic/maxResultSizeChars": CC_MAX_RESULT_CHARS } as const;

/** SDK tool helpers convert through Zod and parse arguments. Core owns the schemas and validation,
 * so the public low-level MCP handlers advertise the originals and pass arguments through unchanged. */
function workerServer(task: CcAgentTask, origins: CcResponseOrigins, record: (value: unknown) => void) {
  const config = createSdkMcpServer({ name: "trace_memory", version: "0.1.0-beta.7" });
  const definitions = new Map<string, ToolDefinition>(task.tools.map(definition => [definition.name, definition]));
  config.instance.server.registerCapabilities({ tools: {} });
  config.instance.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: task.tools.map(definition => ({
    name: definition.name, description: definition.description, inputSchema: structuredClone(definition.parameters),
    _meta: RESULT_SIZE_META,
  })) }));
  config.instance.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const definition = definitions.get(request.params.name);
    if (!definition) throw new Error(`unknown CC worker tool ${request.params.name}`);
    await origins.origin(extra);
    task.signal?.throwIfAborted();
    const input = request.params.arguments ?? {};
    const text = definition.execute(input);
    record({ type: "tool", name: definition.name, input, result: text });
    return { content: [{ type: "text" as const, text }], ...(toolRejected(definition.name as ToolDefinition["name"], text) ? { isError: true } : {}) };
  });
  return config;
}

function coreUsage(result: SDKResultMessage) {
  const usage = result.usage as unknown;
  if (!usage || typeof usage !== "object") return;
  const counters = usage as Record<string, unknown>;
  const names = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
  if (names.some(name => typeof counters[name] !== "number")) return;
  return { input: counters.input_tokens as number, output: counters.output_tokens as number,
    cacheRead: counters.cache_read_input_tokens as number, cacheWrite: counters.cache_creation_input_tokens as number,
    cost: { total: result.total_cost_usd } };
}

function nativeVersion(stdout: string): string | null {
  return stdout.match(/\b(\d+\.\d+\.\d+)\b/)?.[1] ?? null;
}

function assertInit(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>, worker: ResolvedCcWorkerConfig,
  allowedTools: readonly string[]): void {
  if (message.claude_code_version !== worker.claudeVersion)
    throw new Error(`CC worker expected Claude Code ${worker.claudeVersion}, got ${message.claude_code_version}`);
  if (message.cwd !== worker.cwd) throw new Error(`CC worker started in unexpected cwd ${message.cwd}`);
  const actual = [...message.tools].sort(), expected = [...allowedTools].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`CC worker tool isolation failed: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  if (message.plugins.length || message.skills.length || message.slash_commands.length)
    throw new Error("CC worker isolation failed: plugins, skills or slash commands were loaded");
  if (message.mcp_servers.length !== 1 || message.mcp_servers[0]?.name !== "trace_memory" || message.mcp_servers[0].status !== "connected")
    throw new Error("CC worker isolation failed: the private trace_memory MCP server is not the sole connected server");
}

function assertModelMetadata(models: unknown, worker: ResolvedCcWorkerConfig): void {
  if (!Array.isArray(models)) throw new Error("CC worker could not read supported model metadata");
  const selected = models.find(value => value && typeof value === "object" &&
    ((value as { value?: unknown }).value === worker.model || (value as { model?: unknown }).model === worker.model));
  if (!selected) throw new Error(`CC worker model ${worker.model} is not supported by the installed executable`);
  const levels = (selected as { supportedEffortLevels?: unknown }).supportedEffortLevels;
  if (!Array.isArray(levels) || !levels.includes(worker.effort))
    throw new Error(`CC worker effort ${worker.effort} is not supported by model ${worker.model}`);
}

/** One fresh-context official-SDK execution implementation for frozen Noting and Consolidation tasks. */
export class CcAgentWorker {
  private readonly config: ResolvedCcHostConfig;
  private readonly worker: ResolvedCcWorkerConfig;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly query: typeof query;
  private versionCheck: Promise<void> | null = null;

  constructor(config: ResolvedCcHostConfig, dependencies: CcWorkerDependencies = {}) {
    if (!config.worker) throw new Error("CC worker configuration is required for Noting and Consolidation admission");
    this.config = config; this.worker = config.worker;
    this.environment = productionEnvironment(dependencies.environment ?? process.env);
    this.query = dependencies.query ?? query;
  }

  capacity(): { inputTokens: number; prefixTokens: 0 } {
    return { inputTokens: this.worker.contextWindow - CC_CONTEXT_HEADROOM, prefixTokens: 0 };
  }

  private verifyExecutable(): Promise<void> {
    return this.versionCheck ??= execFileAsync(this.worker.claudeExecutable, ["--version"], { timeout: 10_000, env: this.environment })
      .then(({ stdout }) => {
        const version = nativeVersion(stdout);
        if (version !== this.worker.claudeVersion)
          throw new Error(`CC worker expected Claude Code ${this.worker.claudeVersion}, got ${version ?? JSON.stringify(stdout.trim())}`);
      });
  }

  async run(task: CcAgentTask, maxToolRounds: number): Promise<RunAgentResult> {
    const logs = join(this.config.stateDir, "workers"); mkdirSync(logs, { recursive: true });
    const nativeLog = join(logs, `${Date.now()}-${task.kind}-${randomUUID()}.jsonl`);
    closeSync(openSync(nativeLog, "wx", 0o600)); chmodSync(nativeLog, 0o600);
    const record = (value: unknown) => appendFileSync(nativeLog, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    const controller = new AbortController();
    const cancel = () => controller.abort(task.signal?.reason ?? new DOMException("CC worker cancelled", "AbortError"));
    task.signal?.addEventListener("abort", cancel, { once: true });
    let protocolError: Error | null = null;
    const origins = new CcResponseOrigins(task, this.worker.responseOriginTimeoutMs, maxToolRounds, error => {
      protocolError ??= error; controller.abort(error);
    });
    let result: SDKResultMessage | null = null;
    let initialized = false;
    try {
      task.signal?.throwIfAborted();
      await this.verifyExecutable();
      const allowedTools = task.tools.map(definition => `mcp__trace_memory__${definition.name}`);
      const execution = this.query({ prompt: task.text, options: {
        model: this.worker.model,
        cwd: this.worker.cwd,
        pathToClaudeCodeExecutable: this.worker.claudeExecutable,
        env: this.environment,
        tools: [],
        allowedTools,
        mcpServers: { trace_memory: workerServer(task, origins, record) },
        abortController: controller,
        systemPrompt: task.prompt,
        settingSources: [],
        plugins: [],
        persistSession: false,
        permissionMode: "dontAsk",
        strictMcpConfig: true,
        extraArgs: { "disable-slash-commands": null, "no-chrome": null, restricted: null, effort: this.worker.effort },
      } });
      for await (const message of execution) {
        record(message);
        if (message.type === "system" && message.subtype === "init") {
          if (initialized) throw new Error("CC worker emitted more than one init message");
          initialized = true; assertInit(message, this.worker, allowedTools);
          assertModelMetadata(await execution.supportedModels(), this.worker);
        } else if (message.type === "assistant") origins.observe(message);
        else if (message.type === "result") result = message;
      }
      if (!initialized) throw new Error("CC worker ended without native init metadata");
      if (protocolError) throw protocolError;
      if (!result) throw new Error("CC worker ended without an SDK result message");
      const usage = coreUsage(result);
      const success = result.subtype === "success" && !result.is_error;
      const output = result.subtype === "success" ? result.result : result.errors.join("; ");
      return { outcome: success ? "success" : "failure", output, ...(usage ? { usage } : {}), mode: "subagent", nativeLog,
        audit: { available: false, reason: AUDIT_UNAVAILABLE }, verification: { rounds: origins.rounds() },
        thinking: { requested: this.worker.effort, effective: this.worker.effort } };
    } catch (error) {
      controller.abort(error);
      const cancelled = task.signal?.aborted === true;
      const cause = protocolError && !cancelled ? protocolError : error;
      return { outcome: cancelled ? "cancelled" : "failure", output: cause instanceof Error ? cause.message : String(cause),
        mode: "subagent", nativeLog, audit: { available: false, reason: AUDIT_UNAVAILABLE },
        verification: { rounds: origins.rounds() }, thinking: { requested: this.worker.effort, effective: this.worker.effort } };
    } finally {
      origins.close(); task.signal?.removeEventListener("abort", cancel);
    }
  }
}

export function createCcRunAgent(config: ResolvedCcHostConfig, dependencies: CcWorkerDependencies = {},
  maxToolRounds: (kind: CcAgentTask["kind"]) => number = () => 0): {
  runAgent: RunAgent; capacity: { inputTokens: number; prefixTokens: 0 }
} {
  const worker = new CcAgentWorker(config, dependencies);
  return { runAgent: (input: unknown) => {
    const task = input as CcAgentTask;
    if (task.kind !== "noting" && task.kind !== "consolidation")
      return Promise.resolve({ outcome: "failure", output: `CC worker does not support ${String((input as { kind?: unknown })?.kind)}`,
        audit: { available: false, reason: AUDIT_UNAVAILABLE } });
    return worker.run(task, maxToolRounds(task.kind));
  }, capacity: worker.capacity() };
}
