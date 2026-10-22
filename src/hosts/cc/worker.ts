import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createSdkMcpServer, query, type SDKAssistantMessage, type SDKMessage, type SDKResultMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { DreamingAgentInput, NotingAgentInput, RunAgent, RunAgentResult, ToolDefinition } from "../../core/api/index.ts";
import { memoryPath, resolvedMemoryPath, toolRejected } from "../../core/api/index.ts";
import { sweepStaleWorkspaces } from "../../core/noting/workspace.ts";
import { confineSearch, resolveRepositoryPath } from "../../core/dreaming/roots.ts";
import { CC_AGENT_SDK_VERSION, ccWorkspaceRoot, type ResolvedCcHostConfig, type ResolvedCcPhaseConfig, type ResolvedCcWorkerConfig } from "./config.ts";
import { runWithCcNativeAbortOwner } from "./native-rejection.ts";
import { CC_MAX_RESULT_CHARS } from "./tools.ts";
import { materializeCcWorkerRead, saveCcWorkerOutput } from "./files.ts";
import { CC_WORKER_SERVER_NAME, ccWorkerToolNames } from "./tool-names.ts";

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

/** The SDK's query source is on Claude Code's 1h prompt-cache allowlist, so a worker wrote at the 1h
 * rate (2x input, against 1.25x for 5m). No later run reads it: each run's material changes, and a
 * run's own requests are seconds apart. FORCE_PROMPT_CACHING_5M wins over every other TTL source. */
function productionEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (value !== undefined && (OPERATIONAL_ENV_KEYS.has(key) || SESSION_ENV_KEYS.has(key) || key.startsWith("LC_"))) result[key] = value;
  return { ...result, DISABLE_AUTOUPDATER: "1", DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", FORCE_PROMPT_CACHING_5M: "1" };
}

const RESULT_SIZE_META = { "anthropic/maxResultSizeChars": CC_MAX_RESULT_CHARS } as const;

/** SDK tool helpers convert through Zod and parse arguments. Core owns the schemas and validation,
 * so the public low-level MCP handlers advertise the originals and pass arguments through unchanged. */
function workerServer(task: CcAgentTask, origins: CcResponseOrigins, toolsAllowed: () => boolean) {
  const config = createSdkMcpServer({ name: CC_WORKER_SERVER_NAME, version: "0.1.0-beta.7" });
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
    const text = await definition.execute(input);
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
  if (message.mcp_servers.length !== 1 || message.mcp_servers[0]?.name !== CC_WORKER_SERVER_NAME || message.mcp_servers[0].status !== "connected")
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
    // Stage 4 §1.2: the classify task runs on its own triple; every other task on its phase's.
    const settings = this.worker.phases[task.kind === "dreaming" && task.task === "classify" ? "classify" : task.kind];
    if (task.model !== undefined && task.model !== settings.model)
      throw new Error(`CC ${task.kind} task model ${task.model} does not match configured model ${settings.model}`);
    if (task.subagentThinkingLevel !== undefined && task.subagentThinkingLevel !== settings.thinking)
      throw new Error(`CC ${task.kind} task thinking ${task.subagentThinkingLevel} does not match configured thinking ${settings.thinking}`);
    if (!task.reader?.sessionId || !task.reader.branch || !task.reader.headTurnId || !task.reader.projectId)
      throw new Error("CC worker needs a frozen Core reader target");
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
    const frozenReader = { ...task.reader };
    // Native --restricted confines Read to the prepared private worker cwd, even after a Hook rewrite.
    const renderedRoot = join(this.worker.cwd, "rendered");
    mkdirSync(renderedRoot, { recursive: true, mode: 0o700 });
    const readDirectory = mkdtempSync(join(renderedRoot, "worker-"));
    const rendered = new Map<string, string>();
    // Ticket 136: an over-long search output lands in this directory and is registered as a rendering, so the
    // worker's restricted Read may open it.
    task.setSpill?.(text => { const path = saveCcWorkerOutput(readDirectory, text); rendered.set(path, "search output"); return path; });
    const deny = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const,
      permissionDecision: "deny" as const, permissionDecisionReason: reason } });
    const allow = (reason: string) => ({ hookSpecificOutput: { hookEventName: "PreToolUse" as const,
      permissionDecision: "allow" as const, permissionDecisionReason: reason } });
    // Ticket 144: the Noter's two workspace files, and nothing else, may be read, written and edited. A path is one only when it is
    // absolute and already normal, is exactly one of the two, is not a symbolic link, and sits directly in the run's directory.
    // Stage 4: a Dreaming task has the same shape, with its own lists of readable and writable files.
    // A task with no workspace (a fixture of the older shapes) reads trace:// only.
    const workspace = task.workspace as typeof task.workspace | undefined;
    const files = !workspace ? { read: [] as string[], write: [] as string[] }
      : task.kind === "noting" ? { read: [task.workspace.facts, task.workspace.knowledge], write: [task.workspace.facts, task.workspace.knowledge] }
      : { read: task.workspace.read, write: task.workspace.write };
    const workspaceFile = (file: unknown, allowed: readonly string[]): { path: string } | { reason: string } => {
      if (typeof file !== "string" || !isAbsolute(file) || file !== resolve(file) || !allowed.includes(file))
        return { reason: `Trace Memory: this task may use only its ${task.kind === "noting" ? "two " : ""}workspace files` };
      try {
        if (realpathSync(dirname(file)) !== realpathSync(workspace!.dir)) return { reason: "Trace Memory: a workspace file must sit directly in the run's workspace" };
        if (existsSync(file) && lstatSync(file).isSymbolicLink()) return { reason: "Trace Memory: a workspace file may not be a symbolic link" };
      } catch (error) { return { reason: error instanceof Error ? error.message : String(error) }; }
      return { path: file };
    };
    // Stage 4 §5.4: verify alone may read repositories, through Read, Grep and Glob confined to its roots (one function, one deny list).
    // curate and verify list the same tools so their first requests are alike; curate's roots are empty, so its calls are refused.
    const roots = task.kind === "dreaming" && task.task === "verify" ? task.workspace.roots : [];
    const searches = task.kind === "dreaming" && task.task !== "classify";
    const onSearch = async (raw: unknown) => {
      const event = raw as { tool_name?: unknown; tool_input?: Record<string, unknown> };
      try {
        const confined = confineSearch(event.tool_input ?? {}, roots, event.tool_name === "Glob" ? "glob" : "grep");
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "allow" as const, permissionDecisionReason: "repository search",
          updatedInput: { ...event.tool_input, path: confined.path, ...(confined.glob ? { glob: confined.glob } : {}) } } };
      } catch (error) { return deny(error instanceof Error ? error.message : String(error)); }
    };
    const onWrite = async (raw: unknown) => {
      const event = raw as { tool_input?: Record<string, unknown> };
      const checked = workspaceFile(event?.tool_input?.file_path, files.write);
      return workspace && "path" in checked ? allow("workspace file") : deny(workspace ? (checked as { reason: string }).reason : "CC worker has no Write or Edit");
    };
    const onRead = async (raw: unknown) => {
      const event = raw as { tool_name?: unknown; tool_input?: Record<string, unknown>; cwd?: unknown };
      const file = event?.tool_input?.file_path;
      try {
        if (event.tool_name !== "Read" || typeof file !== "string") return deny(workspace ? "CC worker accepts only Read of trace:// and its workspace files" : "CC worker accepts only Read of trace://");
        // An absolute path that names a workspace file is read as it is; the rendering rules below do not apply to it.
        if (files.read.includes(file)) {
          const checked = workspaceFile(file, files.read);
          return "path" in checked ? allow("workspace file") : deny(checked.reason);
        }
        const virtual = memoryPath(file) ?? resolvedMemoryPath(file, event.cwd);
        if (virtual !== null) {
          const path = materializeCcWorkerRead(this.config, frozenReader, virtual, readDirectory);
          rendered.set(path, virtual);
          return { hookSpecificOutput: { hookEventName: "PreToolUse" as const,
            permissionDecision: "allow" as const, permissionDecisionReason: "read trace:// rendering",
            updatedInput: { ...event.tool_input, file_path: path } } };
        }
        // verify: a file under its roots, past the deny list (a rendering of this run is checked below).
        if (roots.length && isAbsolute(file) && !rendered.has(file)) {
          const resolved = resolveRepositoryPath(file, roots);
          return "path" in resolved ? allow("repository file") : deny(resolved.reason);
        }
        // A continuation may name only a file rendered by this very run; never a sibling worker's
        // rendering or a path reached through a symlink or lexical traversal.
        if (!isAbsolute(file) || file !== resolve(file) || !rendered.has(file)) return deny("CC worker Read is restricted to its own trace:// renderings");
        const actual = realpathSync(file);
        if (!actual.startsWith(realpathSync(readDirectory) + sep) || !lstatSync(file).isFile() || lstatSync(file).isSymbolicLink())
          return deny("CC worker Read rendering is outside its own session");
        return { hookSpecificOutput: { hookEventName: "PreToolUse" as const,
          permissionDecision: "allow" as const, permissionDecisionReason: "continue trace:// read" } };
      } catch (error) {
        const virtual = typeof file === "string" ? memoryPath(file) ?? resolvedMemoryPath(file, event.cwd) ?? rendered.get(file) : null;
        if (virtual && error instanceof Error && "code" in error && typeof error.code === "string") {
          const operation = "syscall" in error && typeof error.syscall === "string" ? error.syscall : "read";
          return deny(`${error.code}: ${operation} '${virtual}'`);
        }
        return deny(error instanceof Error ? error.message : String(error));
      }
    };
    // These hooks are the only guard on a child's file access: whatever they throw, the call is denied.
    const failClosed = <R,>(hook: (raw: unknown) => Promise<R>) => async (raw: unknown): Promise<R | ReturnType<typeof deny>> => {
      try { return await hook(raw); } catch (error) { return deny(`CC worker file hook failed: ${error instanceof Error ? error.message : String(error)}`); }
    };
    let assistantMessagesAfterResult: SDKAssistantMessage[] = [];
    const input = new CcUserInput();
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
    // Passes core has authorized so far: the first, then one more for each follow-up string its stop hook returned. The hook is
    // asked after every pass, for the Noter (a repair or the next step, stage 5 §1.4) as for a Dreaming task, and core bounds the count.
    let authorized = 1;
    let passState: "open" | "awaiting" | "complete" = "open";
    const toolsAllowed = () => passState !== "complete";
    return runWithCcNativeAbortOwner(controller.signal, error =>
      this.journal("contained-sdk-control-abort", { taskKind: task.kind, nativeSessionId, error: error.message }),
      async () => { try {
      task.signal?.throwIfAborted();
      // The Noter alone has native Write and Edit, confined by the hook above to its two files; `--restricted` keeps them inside the cwd.
      const native = workspace ? ["Read", "Write", "Edit", ...(searches ? ["Grep", "Glob"] : [])] : ["Read"];
      const allowedTools = [...native, ...task.tools.map(definition => ccWorkerToolNames[definition.name])];
      const execution = this.query({ prompt: input ?? task.text, options: {
        model: settings.model,
        cwd: this.worker.cwd,
        pathToClaudeCodeExecutable: this.worker.claudeExecutable,
        env: this.environment,
        tools: native,
        allowedTools,
        hooks: { PreToolUse: [{ matcher: "Read", hooks: [failClosed(onRead)] }, ...(workspace ? [{ matcher: "Write|Edit", hooks: [failClosed(onWrite)] }] : []),
          ...(searches ? [{ matcher: "Grep|Glob", hooks: [failClosed(onSearch)] }] : [])] },
        mcpServers: { [CC_WORKER_SERVER_NAME]: workerServer(task, origins, toolsAllowed) },
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
        // plugin-free, as assertInit requires. 129: 2.1.293 adds `cc-plugin-plugin-authoring@builtin` the same way.
        extraArgs: { "disable-slash-commands": null, "no-chrome": null, restricted: null, effort: settings.thinking,
          settings: JSON.stringify({ enabledPlugins: { "agents-md@builtin": false, "cc-plugin-plugin-authoring@builtin": false },
            // verify: `--restricted` confines the file tools to the working directories, `additionalDirectories` included.
            ...(roots.length ? { permissions: { additionalDirectories: roots } } : {}) }) },
      } });
      for await (const message of execution) {
        if (passState === "complete")
          throw new Error("CC worker emitted protocol activity after its authorized final pass");
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
          task.signal?.throwIfAborted();
          const pass = results.length;
          if (pass > authorized) throw new Error("CC worker emitted a completed pass without core authorization");
          passState = "open";
          const succeeded = message.subtype === "success" && !message.is_error;
          output = !succeeded && nativeFailureOutput !== null ? nativeFailureOutput
            : message.subtype === "success" ? message.result : message.errors.join("; ");
          outcome = succeeded ? "success" : "failure";
          if (!succeeded) { passState = "complete"; input.close(); }
          else {
            const repair = task.passEnd();
            if (typeof repair === "string" && repair.length > 0) {
              authorized++;
              passState = "awaiting";
              input.push(userMessage(repair, message.session_id, true));
            } else {
              passState = "complete";
              input.close();
            }
          }
        }
      }
      if (passState === "awaiting")
        throw new Error("CC worker ended before completing the core-requested pass");
      if (initIdentity === null) throw new Error("CC worker ended without native init metadata");
      if (protocolError) throw protocolError;
      if (!results.length) throw new Error("CC worker ended without an SDK result message");
      const usage = observedUsage();
      return { outcome, output, ...(usage ? { usage } : {}), ...(retries.length ? { retries } : {}),
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
        ...(usage ? { usage } : {}), ...(retries.length ? { retries } : {}),
        ...verifiedNativeLog(nativeLog, nativeSessionId, origins.rounds()),
        audit: { available: false, reason: AUDIT_UNAVAILABLE },
        thinking: { requested: settings.thinking, effective: settings.thinking } };
    } finally {
      input?.close(); origins.close(); task.signal?.removeEventListener("abort", cancel);
      rmSync(readDirectory, { recursive: true, force: true });
    } });
  }
}

export function createCcRunAgent(config: ResolvedCcHostConfig, dependencies: CcWorkerDependencies = {},
  maxToolRounds: (kind: CcAgentTask["kind"]) => number = () => 0): RunAgent {
  const worker = new CcAgentWorker(config, dependencies);
  // A crashed executor leaves its Noter workspaces behind; this executor's start removes the ones far older than any live run.
  if (config.worker) sweepStaleWorkspaces(ccWorkspaceRoot(config.worker.cwd));
  return (input: unknown) => {
    const task = input as CcAgentTask;
    if (task.kind !== "noting" && task.kind !== "dreaming")
      return Promise.resolve({ outcome: "failure", output: `CC worker does not support ${String((input as { kind?: unknown })?.kind)}`,
        audit: { available: false, reason: AUDIT_UNAVAILABLE } });
    return worker.run(task, maxToolRounds(task.kind));
  };
}
