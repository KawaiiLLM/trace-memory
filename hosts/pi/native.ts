// 19a: the Pi adapter's native execution path. A Noting or Consolidation task runs inside a real
// child `AgentSession` forked from the parent session file, instead of the request-copy runner in
// index.ts. Pi owns the model call, the tool loop, cancellation and persistence; this module only
// prepares the child, whitelists tool execution, verifies the outgoing prefix and reports the run.
//
// Everything here uses the public SDK entry (`createAgentSession`, `SessionManager`,
// `DefaultResourceLoader`, `SettingsManager`) plus the public `Agent` fields Pi itself sets.
import { mkdirSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type ExtensionAPI, type SessionEntry, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { capturedSystemPrompt, capturedTools, hash, messageKey, snapshot, verifyForkRequest, verifyNativeRequest, type Body } from "./branch.ts";
import type { ToolDefinition } from "../../core/api/index.ts";

export type Verification = ReturnType<typeof verifyForkRequest> & { key: string; cache_read?: number; cacheMiss?: CacheMissObservation; rounds: ReturnType<typeof verifyNativeRequest>[] };

/** A child cannot be prepared from this parent state; the caller falls back and records the reason. */
export class NotForkable extends Error {
  /** Present when the gate rejected the child's first body: both hashes and the differing path. */
  verification?: Verification;
  constructor(message: string, verification?: Verification) { super(message); this.verification = verification; }
}

interface NativeCommon {
  runsDir: string;
  cwd: string;
  agentDir: string;
  /** Already resolved by the host (notingModel/consolidationModel or the session model). */
  model: { provider: string; id: string; api: string; [key: string]: unknown };
  /** The adapter-composed user prompt for this run (hosts/pi/compose.ts). */
  task: string;
  tools: ToolDefinition[];
  /** 0 = unlimited, matching the request-copy runner's `maxToolRounds`. */
  maxToolRounds: number;
  signal?: AbortSignal;
  /** Called for every outgoing body, in order; in fork mode the first one is the verified one. */
  onRequest(request: unknown): void;
  onProgress(state: { usage: unknown; retries: { attempt: number; error: string }[] }): void;
  /** Consolidation's review feedback, delivered to the child as a native user message. */
  feedback?(result: string): string | undefined;
  /** 19c: one completed fork response reported an eligible server-side cache miss (gate 3). The run
   * itself continues; the host decides what a miss means for later tasks. */
  onCacheMiss?(observation: CacheMissObservation): void;
}
/** Inherited context: a child forked from the parent's persisted checkpoint (19a). */
export interface NativeForkTask extends NativeCommon {
  mode: "branch";
  /** The parent's own JSONL. Opened read-only through a second manager; never mutated. */
  parentFile: string;
  /** The parent's Pi session id, supplied to the provider as the request/transport identity. */
  parentSessionId: string;
  /** Frozen entry the child forks at: the last persisted entry of the selected path. */
  checkpoint: string;
  /** The parent provider request this child's first body is checked against. */
  captured: Body;
}
/** Fresh context: a private child session with no parent file and no inherited history (19b). Its
 * system prompt is core's domain prompt and its tools are only the memory tools core bound. */
export interface NativeSubagentTask extends NativeCommon {
  mode: "subagent";
  systemPrompt: string;
}
export type NativeTask = NativeForkTask | NativeSubagentTask;

export interface NativeResult {
  outcome: "success" | "failure" | "cancelled";
  output: string;
  /** Only the child's newly generated assistant messages; copied parent usage is never counted. */
  usage?: unknown;
  request?: unknown;
  verification?: Verification;
  retries: { attempt: number; error: string }[];
  /** Absolute path of the child's own JSONL under the runs directory. */
  nativeLog?: string;
  /** A whitelisted memory tool returned a non-rejection receipt in this run. */
  committed: boolean;
  /** Observed tool-call order, including rejected non-whitelisted calls. */
  calls: { name: string; executed: boolean }[];
}

const text = (message: { content?: unknown }): string => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter((c: { type?: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("\n") : "";

// Same shape as the request-copy runner: a rejection receipt is not a commit.
const rejected = (name: string, content: string): boolean => {
  if (content.startsWith("rejected:")) return true;
  if (name !== "note" && name !== "memory") return false;
  try {
    const { results } = JSON.parse(content);
    return Array.isArray(results) && results.some((r: unknown) => typeof r === "string" && r.startsWith("rejected:"));
  } catch { return false; }
};

function addUsage(total: unknown, usage: unknown): unknown {
  if (usage === undefined || usage === null) return total;
  if (typeof usage === "number") return (typeof total === "number" ? total : 0) + usage;
  if (typeof usage !== "object") return usage;
  const left = (total && typeof total === "object" ? total : {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(usage as object).map(key => [key, addUsage(left[key], (usage as Record<string, unknown>)[key])]));
}

/** Reject a checkpoint whose ancestry ends in an assistant tool-call group with missing results. */
export function forkable(entries: SessionEntry[]): void {
  const results = new Set<string>();
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role: string; toolCallId?: string };
    if (message.role === "toolResult" && message.toolCallId) results.add(message.toolCallId);
  }
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message as { role: string; content?: unknown };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (const part of message.content as { type?: string; id?: string }[])
      if (part.type === "toolCall" && part.id && !results.has(part.id)) throw new NotForkable(`checkpoint tool call ${part.id} has no result`);
  }
}

/** 19c "Entry readiness and fallback": may a fork launch at this checkpoint now? Returns the reason to
 * wait for the next safe boundary, or undefined when the checkpoint is ready. The probe is read-only:
 * the parent's own file is reopened through an independent `SessionManager` (with its own directory, so
 * nothing is created) exactly as the launch does, the chosen entry must exist in that reopened file —
 * Pi's message-completion callback runs before persistence, so a completed message is not yet one — and
 * its ancestry must contain no assistant tool-call group whose results are still missing. Waiting starts
 * nothing, advances no progress and creates no duplicate task; the next boundary decides again. */
export function checkpointReadiness(parentFile: string, checkpoint: string): string | undefined {
  let entries: SessionEntry[];
  try {
    const manager = SessionManager.open(parentFile);
    if (!manager.getEntry(checkpoint)) return `checkpoint ${checkpoint} is not persisted yet`;
    entries = manager.getBranch(checkpoint);
  } catch (error) { return `the parent session file cannot be reopened: ${String(error)}`; }
  try { forkable(entries); } catch (error) { return String((error as Error).message); }
  return undefined;
}

// ---- Cache-miss eligibility (19c; ticket 19 "Cache-miss fallback" and gate 3) ----------------

/** Minimum cacheable prefix length, by provider family and model, from the providers' own
 * documentation. There is deliberately no universal fallback: an API or model that is not listed has
 * an unknown minimum, and an unknown minimum can never establish an eligible miss.
 * - `anthropic-messages`: 1024 tokens, and 2048 for the Haiku family (Anthropic prompt caching).
 * - OpenAI-family completions/responses: a 1024-token prefix (OpenAI automatic prompt caching). */
const CACHE_MINIMUM: { api: string; model?: RegExp; tokens: number }[] = [
  { api: "anthropic-messages", model: /haiku/i, tokens: 2048 },
  { api: "anthropic-messages", tokens: 1024 },
  { api: "openai-completions", tokens: 1024 },
  { api: "openai-responses", tokens: 1024 },
  { api: "openai-codex-responses", tokens: 1024 },
];
export const cacheMinimum = (api: string, model: string): number | undefined =>
  CACHE_MINIMUM.find(entry => entry.api === api && (!entry.model || entry.model.test(model)))?.tokens;

/** What a recorded eligible miss says: the response's own reported input accounting, the model it was
 * measured on, and the minimum it had to reach. */
export interface CacheMissObservation { model: string; api: string; minimum: number; input: number; cacheRead: number; cacheWrite: number }

/** One completed fork response, judged on its own reported usage (never a run's sum).
 *
 * pi-ai normalizes both families to the same counting convention: `input` excludes both `cacheRead`
 * and `cacheWrite` (`openai-completions` subtracts them from `prompt_tokens`; `anthropic-messages`
 * copies `input_tokens`, which already excludes them), so the request's actual input length is
 * `input + cacheRead + cacheWrite` on either. Compressed Raw size is never used.
 *
 * Everything unknown returns undefined: missing or non-numeric usage, an unsupported/unreported cache
 * count, a provider cache that was not requested at all, an unlisted provider minimum, and an input
 * below that minimum. A nonzero `cacheRead` is a hit — there is no ratio threshold. */
export function eligibleCacheMiss(model: { api: string; id: string; provider: string }, usage: unknown, cacheEnabled: boolean): CacheMissObservation | undefined {
  if (!cacheEnabled) return; // the request asked for no caching: a zero read says nothing
  const minimum = cacheMinimum(model.api, model.id);
  if (minimum === undefined) return;
  if (!usage || typeof usage !== "object") return;
  const reported = usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
  if (typeof reported.input !== "number" || typeof reported.cacheRead !== "number") return;
  if (reported.cacheRead !== 0) return;
  const cacheWrite = typeof reported.cacheWrite === "number" ? reported.cacheWrite : 0;
  const input = reported.input + reported.cacheRead + cacheWrite;
  if (!Number.isFinite(input) || input < minimum) return;
  return { model: `${model.provider}/${model.id}`, api: model.api, minimum, input, cacheRead: 0, cacheWrite };
}

export async function runNative(task: NativeTask): Promise<NativeResult> {
  const api = task.model.api;
  // --- Prepare the child. Failures before the first provider request are fallbacks, not run failures.
  mkdirSync(task.runsDir, { recursive: true });
  let system: string, tools: { name: string; description: string; parameters: Body }[];
  let manager: SessionManager, nativeLog: string | undefined;
  if (task.mode === "branch") {
    try {
      system = capturedSystemPrompt(api, task.captured);
      tools = capturedTools(api, task.captured);
    } catch (error) { throw new NotForkable(String(error)); }
    if (!tools.length) throw new NotForkable("captured payload carries no tool definitions");
    for (const definition of task.tools) if (!tools.some(t => t.name === definition.name)) throw new NotForkable(`captured payload omits the ${definition.name} tool`);

    // An independent manager on the parent's file, writing into the runs directory. The foreground
    // manager is never touched, and `createBranchedSession` copies only the selected ancestry.
    manager = SessionManager.open(task.parentFile, task.runsDir);
    if (!manager.getEntry(task.checkpoint)) throw new NotForkable(`checkpoint ${task.checkpoint} is not persisted`);
    forkable(manager.getBranch(task.checkpoint));
    const parentId = manager.getSessionId();
    nativeLog = manager.createBranchedSession(task.checkpoint);
    if (manager.getSessionId() === parentId) throw new NotForkable("child session kept the parent id");
  } else {
    // Fresh context (19b "Subagent parity"): Pi's own new-session constructor, in the runs directory,
    // with no parent file to inherit from. No gate applies because there is no parent body to match,
    // so only the memory tools core bound for this run are registered at all.
    system = task.systemPrompt;
    tools = task.tools.map(definition => ({ name: definition.name, description: definition.description, parameters: definition.parameters as Body }));
    if (!tools.length) throw new NotForkable("no memory tools were bound for this run");
    manager = SessionManager.create(task.cwd, task.runsDir);
    nativeLog = manager.getSessionFile();
  }

  const calls: { name: string; executed: boolean }[] = [];
  let committed = false;
  const pending: Promise<unknown>[] = [];
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  // In fork mode the tool DEFINITIONS are the parent's, byte for byte, because the gate compares
  // them; a fresh child registers only core's four. Tool EXECUTION is whitelisted to the memory
  // tools core bound for this run either way, so anything else the copied history invites the model
  // to call returns an error result and never runs.
  const definitions = tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters as never,
    executionMode: "sequential" as const,
    async execute(_id: string, raw: unknown) {
      const bound = task.tools.find(t => t.name === tool.name);
      calls.push({ name: tool.name, executed: !!bound });
      if (!bound) throw new Error(`rejected: ${tool.name} is not available to a Trace Memory worker`);
      let content: string;
      try { content = bound.execute(raw); }
      catch (error) { content = `rejected: ${String(error)}`; }
      if (!rejected(tool.name, content)) committed ||= tool.name === "note" || tool.name === "memory";
      const review = task.feedback?.(content);
      // Consolidation's review round: a native user message, queued as steering so the child
      // reads it before its next model call. The two-submission protocol stays in core.
      if (review) pending.push(session.sendUserMessage(review, { deliverAs: "steer" }));
      return result(content);
    },
  })) satisfies { name: string }[] as unknown as PiToolDefinition[];

  const settingsManager = SettingsManager.create(task.cwd, task.agentDir);
  // Discovery off: no extensions, skills, prompt templates, themes or project context. The one
  // supplied resource is this adapter's own inline extension, which hands the child the parent's
  // exact system prompt bytes through Pi's own `before_agent_start` result.
  const resourceLoader = new DefaultResourceLoader({ cwd: task.cwd, agentDir: task.agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [{ name: "trace-memory-worker", hidden: true, factory: (pi: ExtensionAPI) => { pi.on("before_agent_start", () => ({ systemPrompt: system })); } }] });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: task.cwd, agentDir: task.agentDir, model: task.model as never,
    settingsManager, resourceLoader, sessionManager: manager,
    noTools: "all", tools: definitions.map(d => d.name), customTools: definitions });

  // --- Run the child.
  const verification: Verification | undefined = task.mode !== "branch" ? undefined
    : { passed: false, capturedHash: hash(task.captured), requestHash: "", appendedMessages: [], normalized: ["cache_control"],
        differingPath: `$.${messageKey(api)}`, key: JSON.stringify([task.model.id, task.model.provider, hash(task.captured.tools ?? null)]), rounds: [] };
  const retries: { attempt: number; error: string }[] = [];
  let usage: unknown, request: unknown, rounds = 0, failure: string | undefined, terminal: { stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
  const seen = new Set<unknown>();
  const key = messageKey(api);
  let previous: Body | undefined;
  // Whether the body this child actually sent asked the provider to cache. Anthropic caches only the
  // prefix its `cache_control` markers select, so a body without one has a disabled cache and its
  // zero read is not evidence of anything; OpenAI-family caching is automatic and not request-controlled.
  let cacheEnabled = api !== "anthropic-messages";
  let observedMiss = false;
  const inherited = session.agent.onPayload;
  // Adapter decision: a fork shares the parent's cache/affinity identity; a fresh child keeps its own.
  if (task.mode === "branch") session.agent.sessionId = task.parentSessionId;
  session.agent.toolExecution = "sequential"; // Pi's tested default is parallel
  session.agent.onPayload = async (payload: unknown, model: unknown) => {
    task.signal?.throwIfAborted();
    const body = snapshot(payload) as Body;
    const messages = body[key];
    if (!Array.isArray(messages)) throw new Error(`Native child body has no ${key} array`);
    // The gate applies to a fork only: a fresh child has no parent body to reproduce.
    if (verification && task.mode === "branch") {
      if (!previous) {
        // The whole captured parent body against this body with the child's own appended messages
        // removed. Only `cache_control` markers are ignored (verifyForkRequest).
        Object.assign(verification, verifyForkRequest(task.captured, body, api));
        if (!verification.passed) throw new NotForkable(`native prefix mismatch at ${verification.differingPath}`, { ...verification });
      } else {
        const checked = verifyForkRequest(previous, body, api); // later rounds: same gate against the previous round
        verification.rounds.push(checked);
        if (!checked.passed) { verification.passed = false; throw new Error(`Prefix mismatch at ${checked.differingPath}`); }
      }
    }
    if (api === "anthropic-messages") cacheEnabled = JSON.stringify(body).includes('"cache_control"');
    if (task.maxToolRounds && rounds++ > task.maxToolRounds) throw new Error(`tool rounds exceeded (${task.maxToolRounds})`);
    previous = body;
    if (request === undefined) request = snapshot(body); // the verified first body is the audited request
    task.onRequest(snapshot(body));
    task.onProgress({ usage, retries });
    return inherited ? inherited(payload as never, model as never) : payload;
  };
  const unsubscribe = session.subscribe(event => {
    if (event.type === "auto_retry_start") { retries.push({ attempt: event.attempt, error: event.errorMessage }); task.onProgress({ usage, retries }); }
    if (event.type !== "message_end") return;
    const message = event.message as { role: string; usage?: unknown; stopReason?: string; errorMessage?: string; content?: unknown };
    if (message.role !== "assistant" || seen.has(event.message)) return;
    seen.add(event.message);
    // Only responses this run generated. The copied parent messages restored into the child were
    // never re-sent, and native session statistics would count them.
    usage = addUsage(usage, message.usage);
    terminal = message;
    // Gate 3: only a response whose request passed the deterministic prefix check can count, and it is
    // judged on its own usage. A response that failed or was cancelled carries SDK placeholder zeros,
    // which are unknown, not a miss. The run continues either way: never replayed, never cancelled for
    // this, and a committed batch stays committed.
    if (verification?.passed && !observedMiss && message.stopReason !== "error" && message.stopReason !== "aborted" && message.errorMessage === undefined) {
      const miss = eligibleCacheMiss(task.model as { api: string; id: string; provider: string }, message.usage, cacheEnabled);
      if (miss) { observedMiss = true; verification.cacheMiss = miss; task.onCacheMiss?.(miss); }
    }
    task.onProgress({ usage, retries });
  });
  const abort = () => void session.abort();
  task.signal?.addEventListener("abort", abort);
  try {
    task.signal?.throwIfAborted();
    await session.prompt(task.task, { expandPromptTemplates: false });
    await Promise.allSettled(pending);
    await session.waitForIdle();
  } catch (error) {
    failure = String(error);
  } finally {
    task.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose(); // only this child's runtime and subscriptions
  }
  // Nothing left this process: the gate rejected the body inside `onPayload`, or the child could
  // not start. No provider request was made, so the caller may still fall back for this task.
  if (request === undefined && !task.signal?.aborted)
    throw new NotForkable(!verification || verification.passed ? failure ?? "native child produced no provider request" : `native prefix mismatch at ${verification.differingPath}`,
      !verification || verification.passed ? undefined : { ...verification });
  if (verification?.passed && typeof (usage as { cacheRead?: unknown } | undefined)?.cacheRead === "number")
    verification.cache_read = (usage as { cacheRead: number }).cacheRead; // recorded as an observation

  // `prompt()` resolving is not success: the outcome comes from the child's terminal response,
  // and core keeps a committed batch when that response failed.
  const aborted = task.signal?.aborted || terminal?.stopReason === "aborted";
  const failed = failure !== undefined || terminal === undefined || terminal.stopReason === "error" || terminal.stopReason === "length" || terminal.errorMessage !== undefined;
  const outcome = aborted ? "cancelled" as const : failed ? "failure" as const : "success" as const;
  const output = outcome === "success" ? text(terminal!)
    : failure ?? `${terminal?.stopReason ?? "no terminal assistant response"}${terminal?.errorMessage ? `: ${terminal.errorMessage}` : ""}${terminal && text(terminal) ? ` (partial output: ${text(terminal).slice(0, 200)})` : ""}`;
  return { outcome, output, usage, request, verification, retries, committed, calls,
    ...(nativeLog ? { nativeLog } : {}) };
}
