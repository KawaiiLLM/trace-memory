// 19a/19b/19c: the Pi adapter's only execution path. A Noting or Consolidation task runs inside a
// real child `AgentSession` — forked from the parent session file for inherited context, private
// and fresh otherwise. Pi owns the model call, the tool loop, the retry policy, cancellation and
// persistence; this module only prepares the child, whitelists tool execution, verifies the
// outgoing prefix and reports the run.
//
// Everything here uses the public SDK entry (`createAgentSession`, `SessionManager`,
// `DefaultResourceLoader`, `SettingsManager`) plus the public `Agent` fields Pi itself sets.
import { mkdirSync } from "node:fs";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type ExtensionAPI, type SessionEntry, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { capturedSystemPrompt, capturedTools, hash, messageKey, serialize, stripCacheControl, snapshot, verifyForkRequest, verifyNativeRequest, type Body } from "./fork.ts";
import { toolRejected, type ToolDefinition } from "../../core/api/index.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../phase-settings.ts";

export { THINKING_LEVELS, type ThinkingLevel } from "../phase-settings.ts";

export type Verification = ReturnType<typeof verifyForkRequest> & { key: string; cache_read?: number; cacheMiss?: CacheObservation; rounds: ReturnType<typeof verifyNativeRequest>[] };

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
  /** 26b: the foreground level the host froze with this task at admission, passed to Pi's own session
   * constructor so neither a per-model preference nor the global default decides the worker's level.
   * Pi clamps it to what this model supports. Absent leaves Pi's own resolution in charge. */
  thinkingLevel?: ThinkingLevel;
  /** The adapter-composed user prompt for this run (hosts/pi/compose.ts). */
  task: string;
  tools: ToolDefinition[];
  reportToolRejection?(id: string, name: "note" | "memory", input: unknown, reason: string): void;
  /** 0 = unlimited, as `maxToolRounds` has always meant. */
  maxToolRounds: number;
  signal?: AbortSignal;
  /** Called for every outgoing body, in order; in fork mode the first one is the verified one.
   * `contextTokens` is Pi's own measure of the child's context at that moment (27a), which the host's
   * last capacity check decides by, or undefined when Pi reports it unknown; the body is passed for
   * the run record, never for accounting. */
  onRequest(request: unknown, contextTokens: number | undefined): void;
  /** Review 2026-09-10 (P2): `thinking` rides along as soon as the child exists, so a run the host
   * force-cancels at its cleanup deadline still audits the level it was really sent at. */
  onProgress(state: { usage: unknown; retries: { attempt: number; error: string }[]; thinking?: { requested?: ThinkingLevel; effective: ThinkingLevel } }): void;
  /** Dreamer's host check at a completed pass, with one same-child repair. */
  passEnd?(rounds: number): string | undefined;
  reportRounds?(rounds: number): void;
  /** 19c: one completed fork response was eligible for the cache-miss policy (gate 3), hit or miss.
   * The run itself continues; the host counts consecutive misses and decides the downgrade. */
  onCache?(observation: CacheObservation): void;
  /** Pi's own retry policy (settings.json `retry`, read by the child's SettingsManager) scheduled a
   * backoff, and ended one. The host surfaces them; this module neither retries nor sleeps itself. */
  onRetry?(event: { attempt: number; maxAttempts: number; delayMs: number; error: string }): void;
  onRetryEnd?(): void;
}
/** Inherited context: a child forked from the parent's persisted checkpoint (19a). */
export interface NativeForkTask extends NativeCommon {
  mode: "fork";
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
  /** 26b: the level this child was asked to run at and the level Pi's clamp left it at. */
  thinking: { requested?: ThinkingLevel; effective: ThinkingLevel };
  /** A whitelisted memory tool returned a non-rejection receipt in this run. */
  committed: boolean;
  /** 27b (parent 27 amendment 4): the child's terminal assistant message, handed back as Pi built
   * it so the caller can classify a provider rejection with pi-ai's own `isContextOverflow`. Never
   * an error string reconstructed here; absent when the child produced no assistant message. */
  terminal?: unknown;
  /** Observed tool-call order, including rejected non-whitelisted calls. */
  calls: { name: string; executed: boolean }[];
}

const text = (message: { content?: unknown }): string => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter((c: { type?: string }) => c.type === "text").map((c: { text?: string }) => c.text ?? "").join("\n") : "";

/** The SDK's stand-in usage on an errored or cancelled response: every counter zero or absent. */
export function placeholderUsage(usage: unknown): boolean {
  if (usage === undefined || usage === null) return true;
  if (typeof usage !== "object") return !usage;
  return Object.values(usage as Record<string, unknown>).every(value => !value || (typeof value === "object" && placeholderUsage(value)));
}

/** Adds one response's reported usage into a running total, counter by counter, over the UNION of
 * both operands' keys (27d repair 5, review 2026-09-10): a counter only one side reports survives.
 * A response that omits `reasoning` or `cacheWrite1h` reported nothing about it, and an unreported
 * counter is never a reason to drop what the other response really counted. */
export function addUsage(total: unknown, usage: unknown): unknown {
  if (usage === undefined || usage === null) return total;
  if (typeof usage === "number") return (typeof total === "number" ? total : 0) + usage;
  if (typeof usage !== "object") return usage;
  const left = (total && typeof total === "object" ? total : {}) as Record<string, unknown>;
  const right = usage as Record<string, unknown>;
  return Object.fromEntries([...new Set([...Object.keys(left), ...Object.keys(right)])].map(key => [key, addUsage(left[key], right[key])]));
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

/** User rulings 2026-09-09 (after the beta dogfood; supersede the 2026-09-08 30,000-uncached-token
 * rule): a completed fork response is a miss when the tokens the provider served from cache are below
 * half of the request's input — `cacheRead < CACHE_MISS_READ_RATIO × (input + cacheRead + cacheWrite)` —
 * and the session is downgraded only after two consecutive eligible misses (the host counts). A
 * response whose input is below the provider's documented cacheable minimum cannot have hit and says
 * nothing (ticket 19 "Unknown is not zero"). */
export const CACHE_MISS_READ_RATIO = 0.5;

/** What one eligible response says: its own reported accounting, the model it was measured on, the
 * provider's documented minimum cacheable length, the ratio it was judged by, its input length and
 * whether it was a miss. */
export interface CacheObservation { model: string; api: string; minimum: number; ratio: number; input: number; cacheRead: number; cacheWrite: number; total: number; miss: boolean }

/** One completed fork response, judged on its own reported usage (never a run's sum).
 *
 * pi-ai normalizes both families to the same counting convention: `input` excludes both `cacheRead`
 * and `cacheWrite` (`openai-completions` subtracts them from `prompt_tokens`; `anthropic-messages`
 * copies `input_tokens`, which already excludes them), so the request's actual input length is
 * `input + cacheRead + cacheWrite` on either. Compressed Raw size is never used.
 *
 * Everything unknown returns undefined: missing or non-numeric usage, an unreported cache count, a
 * provider cache that was not requested at all, an unlisted provider (whose cache reporting is
 * unknown), and an input below the provider's cacheable minimum. Otherwise the response is observed,
 * hit or miss, and the host keeps the consecutive count. */
export function cacheObservation(model: { api: string; id: string; provider: string }, usage: unknown, cacheEnabled: boolean, ratio = CACHE_MISS_READ_RATIO): CacheObservation | undefined {
  if (!cacheEnabled) return; // the request asked for no caching: its cache count says nothing
  const minimum = cacheMinimum(model.api, model.id);
  if (minimum === undefined) return; // unlisted provider: cache reporting unknown
  if (!usage || typeof usage !== "object") return;
  const reported = usage as { input?: unknown; cacheRead?: unknown; cacheWrite?: unknown };
  if (typeof reported.input !== "number" || typeof reported.cacheRead !== "number") return;
  const cacheWrite = typeof reported.cacheWrite === "number" ? reported.cacheWrite : 0;
  const total = reported.input + reported.cacheRead + cacheWrite;
  if (!Number.isFinite(total) || total < minimum) return; // too small to have been cached at all
  return { model: `${model.provider}/${model.id}`, api: model.api, minimum, ratio, input: reported.input, cacheRead: reported.cacheRead, cacheWrite, total, miss: reported.cacheRead < ratio * total };
}

export async function runNative(task: NativeTask): Promise<NativeResult> {
  const api = task.model.api;
  // --- Prepare the child. Failures before the first provider request are fallbacks, not run failures.
  mkdirSync(task.runsDir, { recursive: true });
  let system: string, tools: { name: string; description: string; parameters: Body }[];
  let manager: SessionManager, nativeLog: string | undefined;
  if (task.mode === "fork") {
    try {
      system = capturedSystemPrompt(api, task.captured);
      tools = capturedTools(api, task.captured);
    } catch (error) { throw new NotForkable(String(error)); }
    if (!tools.length) throw new NotForkable("captured payload carries no tool definitions");
    for (const definition of task.tools) {
      const captured = tools.find(t => t.name === definition.name);
      if (!captured) throw new NotForkable(`captured payload omits the ${definition.name} tool`);
      if (task.reportToolRejection && (definition.name === "note" || definition.name === "memory") &&
          (captured.description !== definition.description || serialize(stripCacheControl(captured.parameters)) !== serialize(definition.parameters)))
        throw new NotForkable(`captured ${definition.name} definition is incompatible with the current Noter protocol; refresh foreground tools or use subagent mode`);
    }

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
  const attempts = new Map<string, { name: "note" | "memory"; input: unknown; executed: boolean }>();
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  // In fork mode the tool DEFINITIONS are the parent's, byte for byte, because the gate compares
  // them; a fresh child registers only core's four. Tool EXECUTION is whitelisted to the memory
  // tools core bound for this run either way, so anything else the copied history invites the model
  // to call returns an error result and never runs.
  const definitions = tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters as never,
    executionMode: "sequential" as const,
    async execute(_id: string, raw: unknown) {
      const attempt = attempts.get(_id);
      if (attempt) attempt.executed = true;
      const bound = task.tools.find(t => t.name === tool.name);
      calls.push({ name: tool.name, executed: !!bound && !exceeded });
      if (exceeded) throw new Error(`rejected: tool rounds exceeded (${task.maxToolRounds})`);
      if (!bound) throw new Error(`rejected: ${tool.name} is not available to a Trace Memory worker`);
      let content: string;
      try { content = bound.execute(raw); }
      catch (error) { content = `rejected: ${String(error)}`; }
      // Held N receipts are not business commits, including the explicit empty calls.
      let held = false;
      try { held = Array.isArray(JSON.parse(content).held); } catch { /* Ordinary text receipt. */ }
      if (!toolRejected(tool.name, content) && !held) committed ||= tool.name === "note" || tool.name === "memory";
      return { ...result(content), ...(task.passEnd && task.maxToolRounds > 0 && rounds >= task.maxToolRounds ? { terminate: true } : {}) };
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
  // 27b (parent 27 amendment 1): the memory child runs with Pi's automatic compaction off. The
  // manager above reads the user's own settings, where compaction is enabled by default, and Pi then
  // answers a provider overflow inside `_checkCompaction` by deleting the failed reply, summarizing
  // the child with a second paid call and retrying — a native compaction of a worker session, and an
  // overflow the fallback in hosts/pi/worker.ts would never see. `applyOverrides` merges into THIS
  // manager's in-memory settings only: it is not a setter, it writes no file, and the foreground
  // agent has its own manager, so neither the user's settings nor foreground compaction moves.
  //
  // It must come after the loader's reload: `DefaultResourceLoader.reload()` calls
  // `settingsManager.reload()`, which rebuilds the merged settings from the files and drops every
  // override applied before it.
  settingsManager.applyOverrides({ compaction: { enabled: false } });
  // 26b: the frozen level is Pi's own `thinkingLevel` option, which takes precedence over the entry a
  // forked ancestry carries, the per-model preference and the global default, and is clamped by Pi to
  // the levels this model supports. The effective level is read back from the session Pi built.
  const { session } = await createAgentSession({ cwd: task.cwd, agentDir: task.agentDir, model: task.model as never,
    settingsManager, resourceLoader, sessionManager: manager, thinkingLevel: task.thinkingLevel,
    noTools: "all", tools: definitions.map(d => d.name), customTools: definitions });
  const thinking = { ...(task.thinkingLevel ? { requested: task.thinkingLevel } : {}), effective: session.thinkingLevel };

  // --- Run the child.
  const verification: Verification | undefined = task.mode !== "fork" ? undefined
    : { passed: false, capturedHash: hash(task.captured), requestHash: "", appendedMessages: [], normalized: ["cache_control"],
        differingPath: `$.${messageKey(api)}`, key: JSON.stringify([task.model.id, task.model.provider, hash(task.captured.tools ?? null)]), rounds: [] };
  const retries: { attempt: number; error: string }[] = [];
  let usage: unknown, request: unknown, rounds = 0, failure: string | undefined, terminal: { stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
  task.onProgress({ usage, retries, thinking }); // known now, not only with the final result (review 2026-09-10 P2)
  const seen = new Set<unknown>();
  // Only the fork gate reads the provider's message array; a fresh child's audit assumes nothing
  // about the body's shape, so any API the SDK can call may run it (review 2026-09-08).
  const key = task.mode === "fork" ? messageKey(api) : undefined;
  let previous: Body | undefined;
  let exceeded = false;
  // Whether the body this child actually sent asked the provider to cache. Anthropic caches only the
  // prefix its `cache_control` markers select, so a body without one has a disabled cache and its
  // zero read is not evidence of anything; OpenAI-family caching is automatic and not request-controlled.
  let cacheEnabled = api !== "anthropic-messages";
  const inherited = session.agent.onPayload;
  // Adapter decision: a fork shares the parent's cache/affinity identity; a fresh child keeps its own.
  if (task.mode === "fork") session.agent.sessionId = task.parentSessionId;
  session.agent.toolExecution = "sequential"; // Pi's tested default is parallel
  session.agent.onPayload = async (payload: unknown, model: unknown) => {
    task.signal?.throwIfAborted();
    const body = snapshot(payload) as Body;
    // The gate applies to a fork only: a fresh child has no parent body to reproduce.
    if (verification && task.mode === "fork" && key) {
      if (!Array.isArray(body[key])) throw new Error(`Native child body has no ${key} array`);
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
    previous = body;
    // The run record stores the last request sent, which embeds every earlier round (spec: Run record
    // contract). The first body's hashes are kept separately by the gate, in `verification`.
    request = snapshot(body);
    // 27a: what the host's last capacity check decides by is Pi's measure of THIS CHILD's context, not
    // this body — `AgentSession.getContextUsage()`, the same number Pi shows for the foreground, which
    // runs pi-ai's `estimateContextTokens` over the child's own messages: the child's latest real
    // assistant usage once it has one, plus an estimate of what follows it. For a fork's first round
    // that is the parent's own reported prompt cost plus the increment. The guard therefore reads no
    // provider shape at all, and a subagent on an API the fork gate does not support keeps running.
    //
    // Pi's getter is used rather than importing `estimateContextTokens` directly because a subpath
    // import of `@earendil-works/pi-ai` does not resolve inside an installed Pi extension (the loader
    // maps the package to its compat entry; tests/package-smoke.mjs catches it). Its one cost is that
    // a child with no assistant usage yet — the first round of a fresh subagent — is measured on its
    // messages alone, without the system prompt and tool definitions that admission already priced
    // against the same allowance. `null` is Pi's unknown (a compaction inside the child with no valid
    // reply after it): unknown is not zero and not an overflow either, so it refuses nothing.
    const measured = session.getContextUsage()?.tokens;
    try { task.onRequest(snapshot(body), measured ?? undefined); } catch (error) {
      // A refusal is this host's verdict, not a provider error, so it ends the child as the tool-round
      // cap does. Thrown alone it reaches Pi's retry classifier, which matches digits such as "500"
      // inside the token counts; Pi 0.87 then omits the refused attempt and re-measures without the
      // usage that refused it, and the retried round goes out.
      exceeded = true; failure = error instanceof Error ? error.message : String(error);
      void session.abort();
      throw error;
    }
    task.onProgress({ usage, retries });
    return inherited ? inherited(payload as never, model as never) : payload;
  };
  const unsubscribe = session.subscribe(event => {
    if (task.reportToolRejection) {
      if (event.type === "tool_execution_start" && (event.toolName === "note" || event.toolName === "memory") && !attempts.has(event.toolCallId))
        attempts.set(event.toolCallId, { name: event.toolName, input: structuredClone(event.args), executed: false });
      if (event.type === "tool_execution_end" && event.isError) {
        const attempt = attempts.get(event.toolCallId);
        if (attempt && !attempt.executed) task.reportToolRejection(event.toolCallId, attempt.name, attempt.input,
          JSON.stringify(event.result));
      }
    }
    if (event.type === "auto_retry_start") {
      retries.push({ attempt: event.attempt, error: event.errorMessage });
      task.onProgress({ usage, retries });
      task.onRetry?.({ attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, error: event.errorMessage });
    }
    if (event.type === "auto_retry_end") task.onRetryEnd?.();
    if (event.type !== "message_end") return;
    const message = event.message as { role: string; usage?: unknown; stopReason?: string; errorMessage?: string; content?: unknown };
    if (message.role !== "assistant" || seen.has(event.message)) return;
    seen.add(event.message);
    const failedOrCancelled = message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage !== undefined;
    // Only responses this run generated. The copied parent messages restored into the child were
    // never re-sent, and native session statistics would count them. An errored or cancelled response
    // that reports only the SDK's placeholder zeros reported nothing: that is unknown usage, not a
    // free request (ticket 19 "Usage"; review 2026-09-08). Usage it really received still counts.
    if (!(failedOrCancelled && placeholderUsage(message.usage))) usage = addUsage(usage, message.usage);
    terminal = message;
    // Tool rounds are model turns that call tools, never provider attempts: Pi's own retry policy may
    // re-send a request as often as it likes without spending the cap (review 2026-09-08). The round
    // over the cap fails the run before its tools execute; a committed batch stays committed.
    // A failed or cancelled response may carry a partial tool call that never executes; only a completed
    // response's tool round spends the cap (review 2026-09-08).
    if (!failedOrCancelled && Array.isArray(message.content) && message.content.some((part: { type?: string }) => part.type === "toolCall")) {
      rounds++;
      if (task.maxToolRounds > 0 && rounds > task.maxToolRounds) {
        exceeded = true; failure = `tool rounds exceeded (${task.maxToolRounds})`;
        void session.abort();
      }
    }
    task.reportRounds?.(rounds);
    // Gate 3: only a response whose request passed the deterministic prefix check can count, and it is
    // judged on its own usage. A response that failed or was cancelled carries SDK placeholder zeros,
    // which are unknown, not a miss. The run continues either way: never replayed, never cancelled for
    // this, and a committed batch stays committed.
    if (verification?.passed && message.stopReason !== "error" && message.stopReason !== "aborted" && message.errorMessage === undefined) {
      const observed = cacheObservation(task.model as { api: string; id: string; provider: string }, message.usage, cacheEnabled);
      if (observed) { if (observed.miss && !verification.cacheMiss) verification.cacheMiss = observed; task.onCache?.(observed); }
    }
    task.onProgress({ usage, retries });
  });
  const abort = () => void session.abort();
  task.signal?.addEventListener("abort", abort);
  try {
    task.signal?.throwIfAborted();
    await session.prompt(task.task, { expandPromptTemplates: false });
    await session.waitForIdle();
    // A native prompt includes the whole tool loop and provider retries. Only now is this a pass
    // end. The same child, counters and retry accounting survive the one system-generated repair.
    if (task.passEnd && !task.signal?.aborted && !failure && terminal?.stopReason !== "error" && terminal?.stopReason !== "aborted") {
      const followup = task.passEnd(rounds);
      if (followup && (task.maxToolRounds === 0 || rounds < task.maxToolRounds)) {
        // A new public prompt reapplies before_agent_start. An idle custom-message turn skips it,
        // so Pi's next-turn refresh would replace the worker instructions with its base prompt.
        // The feedback identifies itself as host-generated, not evidence, in this same child log.
        await session.sendUserMessage(followup, { expandPromptTemplates: false });
        await session.waitForIdle();
        task.passEnd(rounds);
      }
    }
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
  const aborted = !exceeded && (task.signal?.aborted || terminal?.stopReason === "aborted"); // a cap or refusal aborts the child itself: a failure, not a cancellation
  const failed = failure !== undefined || terminal === undefined || terminal.stopReason === "error" || terminal.stopReason === "length" || terminal.errorMessage !== undefined;
  const outcome = aborted ? "cancelled" as const : failed ? "failure" as const : "success" as const;
  const output = outcome === "success" ? text(terminal!)
    : failure ?? `${terminal?.stopReason ?? "no terminal assistant response"}${terminal?.errorMessage ? `: ${terminal.errorMessage}` : ""}${terminal && text(terminal) ? ` (partial output: ${text(terminal).slice(0, 200)})` : ""}`;
  return { outcome, output, usage, request, verification, retries, committed, calls, thinking,
    ...(terminal ? { terminal } : {}), ...(nativeLog ? { nativeLog } : {}) };
}
