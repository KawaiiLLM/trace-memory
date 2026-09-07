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
import { capturedSystemPrompt, capturedTools, hash, messageKey, snapshot, verifyNativeRequest, type Body } from "./branch.ts";
import type { ToolDefinition } from "../../core/api/index.ts";

export type Verification = ReturnType<typeof verifyNativeRequest> & { key: string; cache_read?: number; rounds: ReturnType<typeof verifyNativeRequest>[] };

/** A child cannot be prepared from this parent state; the caller falls back and records the reason. */
export class NotForkable extends Error {
  /** Present when the gate rejected the child's first body: both hashes and the differing path. */
  verification?: Verification;
  constructor(message: string, verification?: Verification) { super(message); this.verification = verification; }
}

export interface NativeTask {
  /** The parent's own JSONL. Opened read-only through a second manager; never mutated. */
  parentFile: string;
  /** The parent's Pi session id, supplied to the provider as the request/transport identity. */
  parentSessionId: string;
  /** Frozen entry the child forks at: the last persisted entry of the selected path. */
  checkpoint: string;
  runsDir: string;
  cwd: string;
  agentDir: string;
  /** Already resolved by the host (notingModel/consolidationModel or the session model). */
  model: { provider: string; id: string; api: string; [key: string]: unknown };
  /** The parent provider request this child's first body is checked against. */
  captured: Body;
  /** The task material core supplies for this run, delivered as the child's user prompt. */
  task: string;
  tools: ToolDefinition[];
  /** 0 = unlimited, matching the request-copy runner's `maxToolRounds`. */
  maxToolRounds: number;
  signal?: AbortSignal;
  /** Called for every outgoing body, in order; the first one is the verified one. */
  onRequest(request: unknown): void;
  onProgress(state: { usage: unknown; retries: { attempt: number; error: string }[] }): void;
  /** Consolidation's review feedback, delivered to the child as a native user message. */
  feedback?(result: string): string | undefined;
}

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

export async function runNative(task: NativeTask): Promise<NativeResult> {
  const api = task.model.api;
  // --- Prepare the child. Failures before the first provider request are fallbacks, not run failures.
  mkdirSync(task.runsDir, { recursive: true });
  let system: string, tools: { name: string; description: string; parameters: Body }[];
  try {
    system = capturedSystemPrompt(api, task.captured);
    tools = capturedTools(api, task.captured);
  } catch (error) { throw new NotForkable(String(error)); }
  if (!tools.length) throw new NotForkable("captured payload carries no tool definitions");
  for (const definition of task.tools) if (!tools.some(t => t.name === definition.name)) throw new NotForkable(`captured payload omits the ${definition.name} tool`);

  // An independent manager on the parent's file, writing into the runs directory. The foreground
  // manager is never touched, and `createBranchedSession` copies only the selected ancestry.
  const manager = SessionManager.open(task.parentFile, task.runsDir);
  if (!manager.getEntry(task.checkpoint)) throw new NotForkable(`checkpoint ${task.checkpoint} is not persisted`);
  forkable(manager.getBranch(task.checkpoint));
  const parentId = manager.getSessionId();
  const nativeLog = manager.createBranchedSession(task.checkpoint);
  if (manager.getSessionId() === parentId) throw new NotForkable("child session kept the parent id");

  const calls: { name: string; executed: boolean }[] = [];
  let committed = false;
  const pending: Promise<unknown>[] = [];
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  // Tool DEFINITIONS are the parent's, byte for byte, because the gate compares them. Tool
  // EXECUTION is whitelisted to the memory tools core bound for this run; anything else the copied
  // history invites the model to call returns an error result and never runs.
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
  const verification: Verification = { passed: false, capturedHash: hash(task.captured), requestHash: "", appendedMessages: [],
    differingPath: `$.${messageKey(api)}`, key: JSON.stringify([task.model.id, task.model.provider, hash(task.captured.tools ?? null)]), rounds: [] };
  const retries: { attempt: number; error: string }[] = [];
  let usage: unknown, request: unknown, rounds = 0, failure: string | undefined, terminal: { stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
  const seen = new Set<unknown>();
  const key = messageKey(api);
  let previous: Body | undefined;
  const inherited = session.agent.onPayload;
  session.agent.sessionId = task.parentSessionId; // adapter decision: the parent's cache/affinity identity
  session.agent.toolExecution = "sequential"; // Pi's tested default is parallel
  session.agent.onPayload = async (payload: unknown, model: unknown) => {
    task.signal?.throwIfAborted();
    const body = snapshot(payload) as Body;
    const messages = body[key];
    if (!Array.isArray(messages)) throw new Error(`Native child body has no ${key} array`);
    if (!previous) {
      // The gate: the whole captured parent body against this body with the child's own appended
      // messages removed. Nothing is excluded from the comparison.
      const appended = messages.slice((task.captured[key] as unknown[] | undefined)?.length ?? -1);
      Object.assign(verification, verifyNativeRequest(task.captured, body, api, appended));
      if (!verification.passed) throw new NotForkable(`native prefix mismatch at ${verification.differingPath}`, { ...verification });
    } else {
      const appended = messages.slice((previous[key] as unknown[]).length);
      const checked = verifyNativeRequest(previous, body, api, appended);
      verification.rounds.push(checked);
      if (!checked.passed) { verification.passed = false; throw new Error(`Prefix mismatch at ${checked.differingPath}`); }
    }
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
    throw new NotForkable(verification.passed ? failure ?? "native child produced no provider request" : `native prefix mismatch at ${verification.differingPath}`,
      verification.passed ? undefined : { ...verification });
  if (verification.passed && typeof (usage as { cacheRead?: unknown } | undefined)?.cacheRead === "number")
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
