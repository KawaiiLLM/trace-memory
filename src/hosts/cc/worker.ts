import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createSdkMcpServer, query, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DreamingAgentInput, NotingAgentInput, RunAgent, RunAgentResult, ToolDefinition } from "../../core/api/index.ts";
import { toolRejected } from "../../core/api/index.ts";
import { CC_AGENT_SDK_VERSION, type ResolvedCcHostConfig, type ResolvedCcPhaseConfig, type ResolvedCcWorkerConfig } from "./config.ts";
import { runWithCcNativeAbortOwner } from "./native-rejection.ts";
import { CC_MAX_RESULT_CHARS } from "./tools.ts";

export type CcAgentTask = NotingAgentInput | DreamingAgentInput;
/** Called for every runtime-journal-worthy event this worker produces, before or after it returns
 * (78: the contained SDK control abort can arrive on either side of settlement). Matches the shape
 * of the executor's own runtime journal writer (`runtimeEvent` in hosts/cc/index.ts). */
export type CcWorkerJournal = (event: string, details?: Record<string, unknown>) => void;
const AUDIT_UNAVAILABLE = `Claude Agent SDK ${CC_AGENT_SDK_VERSION} does not expose the exact provider request body`;

/** Claude Code's own project-directory encoding: every character outside [A-Za-z0-9] becomes one
 * `-`, byte for byte, with no collapsing of runs (verified against the pinned executable, 78). */
function ccProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** Where Claude Code itself writes this worker's native session transcript: `CLAUDE_CONFIG_DIR`
 * when the worker environment sets it (it always passes it through when configured), else `~/.claude`
 * — resolved against the spawned process's own HOME, not this process's. */
export function ccNativeTranscriptPath(environment: NodeJS.ProcessEnv, cwd: string, nativeSessionId: string): string {
  const configDir = environment.CLAUDE_CONFIG_DIR || join(environment.HOME || homedir(), ".claude");
  return join(configDir, "projects", ccProjectDirName(cwd), `${nativeSessionId}.jsonl`);
}

/** Log verification is an audit diagnostic, never an outcome (78): it never throws, and a problem it
 * finds never changes the run's outcome, reason, usage or commits — only whether `nativeLog` is
 * reported and what `verification` notes. */
function verifyNativeLog(path: string, nativeSessionId: string): string | undefined {
  let content: string;
  try { content = readFileSync(path, "utf8"); }
  catch { return `native session file is missing at ${path}`; }
  const firstLine = content.split("\n").find(line => line.trim().length > 0);
  if (firstLine === undefined) return `native session file at ${path} is empty`;
  let parsed: unknown;
  try { parsed = JSON.parse(firstLine); } catch { return `native session file at ${path} has unparsable content`; }
  const found = (parsed as { sessionId?: unknown } | null)?.sessionId;
  return found === nativeSessionId ? undefined
    : `native session file at ${path} holds session ${JSON.stringify(found)}, expected ${nativeSessionId}`;
}

/** The one place both return paths report `nativeLog`/`verification` (78). No init received: neither
 * field says anything about a native log. Init received: verify, and report `nativeLog` only when it
 * checks out — a path that does not exist, or holds another session, is never reported, and the
 * problem is noted instead. Either way this never throws and never touches outcome, usage or output. */
function verifiedNativeLog(nativeLog: string | undefined, nativeSessionId: string | null, rounds: number):
  { nativeLog?: string; verification: { rounds: number; nativeLogProblem?: string } } {
  if (nativeLog === undefined || nativeSessionId === null) return { verification: { rounds } };
  const problem = verifyNativeLog(nativeLog, nativeSessionId);
  return problem ? { verification: { rounds, nativeLogProblem: problem } } : { nativeLog, verification: { rounds } };
}

export interface CcWorkerDependencies {
  /** Native probes supply an isolated loopback environment. Production uses the filtered host environment below. */
  environment?: NodeJS.ProcessEnv;
  /** Production-interface tests replace only transport execution; tool serving stays production code. */
  query?: typeof query;
  /** 78: the executor's runtime journal, for the one worker event with no home in the run record
   * (a contained SDK control abort). Absent (tests that do not care) is a no-op. */
  journal?: CcWorkerJournal;
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
  private readonly pendingWrites = new Map<string, { name: "note" | "memory"; input: unknown }>();
  private readonly rejectedWrites = new Set<string>();
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
      const name = block.name.replace(/^mcp__trace_memory__/, "");
      if (this.task.kind === "noting" && (name === "note" || name === "memory") && !this.pendingWrites.has(block.id))
        this.pendingWrites.set(block.id, { name, input: structuredClone(block.input) });
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

  /** Native argument/permission refusal can precede the MCP handler. Route it by tool-use ID,
   * never by parsing the error prose. A missing result/dispatch cannot establish correction. */
  rejected(id: string, reason: string): void {
    const attempt = this.pendingWrites.get(id);
    if (!attempt || this.claimed.has(id) || this.rejectedWrites.has(id)) return;
    if (this.task.kind !== "noting" || !this.task.reportToolRejection) throw this.fail(new Error("CC Noter cannot report native tool rejection"));
    this.task.reportToolRejection(id, attempt.name, attempt.input, reason);
    this.rejectedWrites.add(id);
  }

  requireDispatchedWrites(): void {
    for (const id of this.pendingWrites.keys()) if (!this.claimed.has(id) && !this.rejectedWrites.has(id))
      throw this.fail(new Error(`CC Noter tool call ${id} has neither a handler dispatch nor a correlated refusal`));
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
function workerServer(task: CcAgentTask, origins: CcResponseOrigins, toolsAllowed: () => boolean) {
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
    if (!toolsAllowed()) throw new Error("CC worker received a tool call outside an authorized pass");
    await origins.origin(extra);
    task.signal?.throwIfAborted();
    if (!toolsAllowed()) throw new Error("CC worker pass authorization ended before its tool call completed");
    const input = request.params.arguments ?? {};
    const text = definition.execute(input);
    return { content: [{ type: "text" as const, text }], ...(toolRejected(definition.name as ToolDefinition["name"], text) ? { isError: true } : {}) };
  });
  return config;
}

const USAGE_COUNTERS = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;

function assistantApiError(message: SDKAssistantMessage): string | undefined {
  const value = message as unknown as { is_api_error_message?: unknown; isApiError?: unknown };
  if (value.is_api_error_message !== true && value.isApiError !== true) return;
  const text = message.message.content.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map(part => part.text).join("\n").trim();
  return text || "CC native API error";
}

type UsageTotals = { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: { total: number } };

function assistantUsage(messages: readonly SDKAssistantMessage[]) {
  // Partial/replayed assistant envelopes can share an API response id. Keep the latest complete
  // counters for that response, just as origins count that id as one native round.
  const latest = new Map<string, Omit<UsageTotals, "cost">>();
  for (const message of messages) {
    const id = message.message.id;
    if (typeof id !== "string") continue;
    const usage = message.message.usage as unknown;
    if (!usage || typeof usage !== "object") continue;
    const counters = usage as Record<string, unknown>;
    if (USAGE_COUNTERS.some(name => typeof counters[name] !== "number")) continue;
    latest.set(id, { input: counters.input_tokens as number, output: counters.output_tokens as number,
      cacheRead: counters.cache_read_input_tokens as number, cacheWrite: counters.cache_creation_input_tokens as number });
  }
  if (!latest.size) return;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const usage of latest.values()) for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) totals[key] += usage[key];
  return totals;
}

function coreUsage(results: readonly SDKResultMessage[]) {
  if (!results.length) return;
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const result of results) {
    const usage = result.usage as unknown;
    if (!usage || typeof usage !== "object") return;
    const counters = usage as Record<string, unknown>;
    if (USAGE_COUNTERS.some(name => typeof counters[name] !== "number")) return;
    totals.input += counters.input_tokens as number;
    totals.output += counters.output_tokens as number;
    totals.cacheRead += counters.cache_read_input_tokens as number;
    totals.cacheWrite += counters.cache_creation_input_tokens as number;
  }
  const cost = results.at(-1)!.total_cost_usd;
  if (typeof cost !== "number") return;
  return { ...totals, cost: { total: cost } };
}

class CcUserInput implements AsyncIterable<SDKUserMessage> {
  private values: SDKUserMessage[] = [];
  private waiters: ((value: IteratorResult<SDKUserMessage>) => void)[] = [];
  private ended = false;

  push(value: SDKUserMessage): void {
    if (this.ended) throw new Error("CC worker input is already closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false }); else this.values.push(value);
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return { next: () => {
      const value = this.values.shift();
      if (value) return Promise.resolve({ value, done: false });
      if (this.ended) return Promise.resolve({ value: undefined, done: true });
      return new Promise(resolve => this.waiters.push(resolve));
    } };
  }
}

function userMessage(text: string, sessionId = "", synthetic = false): SDKUserMessage {
  return { type: "user", session_id: sessionId, message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null, ...(synthetic ? { isSynthetic: true } : {}) } as SDKUserMessage;
}

function assertInit(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>, worker: ResolvedCcWorkerConfig,
  allowedTools: readonly string[]): void {
  if (message.cwd !== worker.cwd) throw new Error(`CC worker started in unexpected cwd ${message.cwd}`);
  const actual = [...message.tools].sort(), expected = [...allowedTools].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`CC worker tool isolation failed: expected ${expected.join(", ")}, got ${actual.join(", ")}`);
  if (message.plugins.length || message.skills.length || message.slash_commands.length)
    throw new Error("CC worker isolation failed: plugins, skills or slash commands were loaded");
  if (message.mcp_servers.length !== 1 || message.mcp_servers[0]?.name !== "trace_memory" || message.mcp_servers[0].status !== "connected")
    throw new Error("CC worker isolation failed: the private trace_memory MCP server is not the sole connected server");
}

function assertModelMetadata(models: unknown, execution: ResolvedCcPhaseConfig): void {
  if (!Array.isArray(models)) throw new Error("CC worker could not read supported model metadata");
  const selected = models.find(value => value && typeof value === "object" &&
    ((value as { value?: unknown }).value === execution.model || (value as { model?: unknown }).model === execution.model));
  if (!selected) throw new Error(`CC worker model ${execution.model} is not supported by the installed executable`);
  const levels = (selected as { supportedEffortLevels?: unknown }).supportedEffortLevels;
  if (!Array.isArray(levels) || !levels.includes(execution.thinking))
    throw new Error(`CC worker effort ${execution.thinking} is not supported by model ${execution.model}`);
}

/** One fresh-context official-SDK execution implementation for all three frozen memory phases. */
export class CcAgentWorker {
  private readonly config: ResolvedCcHostConfig;
  private readonly worker: ResolvedCcWorkerConfig;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly query: typeof query;
  private readonly journal: CcWorkerJournal;

  constructor(config: ResolvedCcHostConfig, dependencies: CcWorkerDependencies = {}) {
    if (!config.worker) throw new Error("CC worker configuration is required for memory-task admission");
    this.config = config; this.worker = config.worker;
    const environment = productionEnvironment(dependencies.environment ?? process.env);
    this.environment = config.retry === undefined ? environment
      : { ...environment, CLAUDE_CODE_MAX_RETRIES: String(config.retry.maxRetries) };
    this.query = dependencies.query ?? query;
    this.journal = dependencies.journal ?? (() => {});
  }

  async run(task: CcAgentTask, maxToolRounds: number): Promise<RunAgentResult> {
    const settings = this.worker.phases[task.kind];
    if (task.model !== undefined && task.model !== settings.model)
      throw new Error(`CC ${task.kind} task model ${task.model} does not match configured model ${settings.model}`);
    if (task.subagentThinkingLevel !== undefined && task.subagentThinkingLevel !== settings.thinking)
      throw new Error(`CC ${task.kind} task thinking ${task.subagentThinkingLevel} does not match configured thinking ${settings.thinking}`);
    // 78: the path Claude Code itself will persist this run's native session under, known only once
    // init reports the native session id. Verified, never created, by this adapter.
    let nativeLog: string | undefined;
    const controller = new AbortController();
    const cancel = () => controller.abort(task.signal?.reason ?? new DOMException("CC worker cancelled", "AbortError"));
    task.signal?.addEventListener("abort", cancel, { once: true });
    let protocolError: Error | null = null;
    const origins = new CcResponseOrigins(task, this.worker.responseOriginTimeoutMs, maxToolRounds, error => {
      protocolError ??= error; controller.abort(error);
    });
    const results: SDKResultMessage[] = [], assistantMessages: SDKAssistantMessage[] = [];
    let assistantMessagesAfterResult: SDKAssistantMessage[] = [];
    const input = task.kind === "dreaming" ? new CcUserInput() : null;
    input?.push(userMessage(task.text));
    let initIdentity: string | null = null, nativeSessionId: string | null = null;
    let output = "CC worker ended without an SDK result message";
    let nativeFailureOutput: string | null = null;
    let outcome: "success" | "failure" = "failure";
    const retries: { attempt: number; error: string }[] = [];
    const observedUsage = () => {
      const settled = coreUsage(results);
      if (!settled) return assistantUsage(assistantMessages);
      const tail = assistantUsage(assistantMessagesAfterResult);
      return tail ? { ...settled, input: settled.input + tail.input, output: settled.output + tail.output,
        cacheRead: settled.cacheRead + tail.cacheRead, cacheWrite: settled.cacheWrite + tail.cacheWrite } : settled;
    };
    const progress = () => { const usage = observedUsage(); task.reportProgress?.({ retries: [...retries], ...(usage ? { usage } : {}) }); };
    let dreamState: "first" | "repair-authorized" | "complete" = "first";
    const toolsAllowed = () => task.kind !== "dreaming" || dreamState !== "complete";
    return runWithCcNativeAbortOwner(controller.signal, error =>
      this.journal("contained-sdk-control-abort", { taskKind: task.kind, nativeSessionId, error: error.message }),
      async () => { try {
      task.signal?.throwIfAborted();
      const allowedTools = task.tools.map(definition => `mcp__trace_memory__${definition.name}`);
      const execution = this.query({ prompt: input ?? task.text, options: {
        model: settings.model,
        cwd: this.worker.cwd,
        pathToClaudeCodeExecutable: this.worker.claudeExecutable,
        env: this.environment,
        tools: [],
        allowedTools,
        mcpServers: { trace_memory: workerServer(task, origins, toolsAllowed) },
        abortController: controller,
        systemPrompt: task.prompt,
        settingSources: [],
        plugins: [],
        // 78: the worker's session is now the native transcript (nativeLog). Every other isolation
        // option is unchanged — settingSources/plugins empty, strictMcpConfig — so no hook, plugin or
        // skill ever loads for it, and it is never bound, imported or enrolled as a foreground session.
        permissionMode: "dontAsk",
        strictMcpConfig: true,
        // 106: Claude Code 2.1.284 loads its builtin `agents-md@builtin` plugin even so. The `--settings`
        // layer is read whatever the setting sources, and turning the plugin off there keeps the worker
        // plugin-free, as assertInit requires.
        extraArgs: { "disable-slash-commands": null, "no-chrome": null, restricted: null, effort: settings.thinking,
          settings: JSON.stringify({ enabledPlugins: { "agents-md@builtin": false } }) },
      } });
      for await (const message of execution) {
        if (task.kind === "dreaming" && dreamState === "complete")
          throw new Error("CC Dreamer emitted protocol activity after its authorized final pass");
        if (message.type === "system" && message.subtype === "init") {
          assertInit(message, this.worker, allowedTools);
          const identity = JSON.stringify({ sessionId: message.session_id,
            messagingSocketPath: (message as unknown as { messaging_socket_path?: unknown }).messaging_socket_path });
          if (initIdentity === null) {
            initIdentity = identity;
            nativeSessionId = message.session_id;
            // 106: the Claude Code version is recorded per run, never required.
            this.journal("worker-run-started", { taskKind: task.kind, nativeSessionId, claudeVersion: message.claude_code_version });
            nativeLog = ccNativeTranscriptPath(this.environment, this.worker.cwd, nativeSessionId);
            assertModelMetadata(await execution.supportedModels(), settings);
          } else if (identity !== initIdentity) throw new Error("CC worker repeated init with a different native session or messaging socket");
        } else if (message.type === "assistant") {
          assistantMessages.push(message); assistantMessagesAfterResult.push(message);
          nativeFailureOutput = assistantApiError(message) ?? nativeFailureOutput;
          origins.observe(message);
          progress();
          if (task.kind === "dreaming") task.reportRounds(origins.rounds());
        } else if (message.type === "user" && Array.isArray(message.message.content)) {
          for (const block of message.message.content) if (block.type === "tool_result" && block.is_error)
            origins.rejected(block.tool_use_id, JSON.stringify(block.content));
        } else if (message.type === "system" && (message as unknown as { subtype?: unknown }).subtype === "api_retry") {
          const retry = message as unknown as { attempt?: unknown; max_retries?: unknown; retry_delay_ms?: unknown; error?: unknown };
          if (!Number.isSafeInteger(retry.attempt) || typeof retry.error !== "string")
            throw new Error("CC worker received malformed native api_retry metadata");
          retries.push({ attempt: retry.attempt as number, error: retry.error });
          progress();
        } else if (message.type === "result") {
          if (nativeSessionId !== null && message.session_id !== nativeSessionId)
            throw new Error("CC worker result came from a different native session");
          results.push(message);
          // A result accounts for all assistant responses in that completed native pass. Only
          // assistant usage received after it is unaccounted tail usage if continuation later fails.
          assistantMessagesAfterResult = [];
          progress();
          if (message.is_error || message.subtype !== "success")
            nativeFailureOutput ??= message.subtype === "success" ? message.result : message.errors.join("; ");
          if (task.kind !== "dreaming") {
            outcome = message.subtype === "success" && !message.is_error ? "success" : "failure";
            output = outcome === "failure" && nativeFailureOutput !== null ? nativeFailureOutput
              : message.subtype === "success" ? message.result : message.errors.join("; ");
          } else {
            const pass = results.length;
            if ((pass === 1 && dreamState !== "first") || (pass === 2 && dreamState !== "repair-authorized") || pass > 2)
              throw new Error("CC Dreamer emitted a completed pass without core repair authorization");
            const succeeded = message.subtype === "success" && !message.is_error;
            output = !succeeded && nativeFailureOutput !== null ? nativeFailureOutput
              : message.subtype === "success" ? message.result : message.errors.join("; ");
            outcome = succeeded ? "success" : "failure";
            if (!succeeded) { dreamState = "complete"; input!.close(); }
            else {
              const repair = task.passEnd(origins.rounds());
              if (pass === 1 && typeof repair === "string" && repair.length > 0) {
                dreamState = "repair-authorized";
                input!.push(userMessage(repair, message.session_id, true));
              } else {
                dreamState = "complete";
                input!.close();
              }
            }
          }
        }
      }
      if (task.kind === "dreaming" && dreamState === "repair-authorized")
        throw new Error("CC Dreamer ended before completing the core-requested repair pass");
      if (initIdentity === null) throw new Error("CC worker ended without native init metadata");
      if (protocolError) throw protocolError;
      if (!results.length) throw new Error("CC worker ended without an SDK result message");
      origins.requireDispatchedWrites();
      const usage = observedUsage();
      return { outcome, output, ...(usage ? { usage } : {}), ...(retries.length ? { retries } : {}), mode: "subagent",
        ...verifiedNativeLog(nativeLog, nativeSessionId, origins.rounds()),
        audit: { available: false, reason: AUDIT_UNAVAILABLE },
        thinking: { requested: settings.thinking, effective: settings.thinking } };
    } catch (error) {
      controller.abort(error);
      const cancelled = task.signal?.aborted === true;
      const cause = protocolError && !cancelled ? protocolError : error;
      const usage = observedUsage();
      const specific = nativeFailureOutput ?? (cause instanceof Error ? cause.message : String(cause));
      return { outcome: cancelled ? "cancelled" : "failure", output: specific,
        ...(usage ? { usage } : {}), ...(retries.length ? { retries } : {}), mode: "subagent",
        ...verifiedNativeLog(nativeLog, nativeSessionId, origins.rounds()),
        audit: { available: false, reason: AUDIT_UNAVAILABLE },
        thinking: { requested: settings.thinking, effective: settings.thinking } };
    } finally {
      input?.close(); origins.close(); task.signal?.removeEventListener("abort", cancel);
    } });
  }
}

export function createCcRunAgent(config: ResolvedCcHostConfig, dependencies: CcWorkerDependencies = {},
  maxToolRounds: (kind: CcAgentTask["kind"]) => number = () => 0): RunAgent {
  const worker = new CcAgentWorker(config, dependencies);
  return (input: unknown) => {
    const task = input as CcAgentTask;
    if (task.kind !== "noting" && task.kind !== "dreaming")
      return Promise.resolve({ outcome: "failure", output: `CC worker does not support ${String((input as { kind?: unknown })?.kind)}`,
        audit: { available: false, reason: AUDIT_UNAVAILABLE } });
    return worker.run(task, maxToolRounds(task.kind));
  };
}
