// 19a/19b: the Pi adapter's only execution path. A Noting or Dreaming task runs inside a real
// private child `AgentSession` with no inherited history. Pi owns the model call, the tool loop,
// the retry policy, cancellation and persistence; this module only prepares the child, whitelists
// tool execution and reports the run.
//
// Everything here uses the public SDK entry (`createAgentSession`, `SessionManager`,
// `DefaultResourceLoader`, `SettingsManager`) plus the public `Agent` fields Pi itself sets.
import { mkdirSync } from "node:fs";
import { createAgentSession, createBashTool, DefaultResourceLoader, SessionManager, SettingsManager,
  type ExtensionAPI, type ToolDefinition as PiToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "../../core/api/index.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "../phase-settings.ts";

export { THINKING_LEVELS, type ThinkingLevel } from "../phase-settings.ts";

type Body = Record<string, unknown>;
const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value));

interface NativeCommon {
  kind: "noting" | "dreaming";
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
  /** Same frozen reader as this task's material; only trace:// execution is exposed. */
  read: ReturnType<typeof import("./memory-files.ts").memoryReadTool>;
  /** The Noter's write and edit (ticket 144), already confined by the host to its two workspace files. */
  fileTools?: PiToolDefinition[];
  /** 0 = unlimited, as `maxToolRounds` has always meant. */
  maxToolRounds: number;
  signal?: AbortSignal;
  /** Called for every outgoing body, in order. `contextTokens` is Pi's own measure of the child's context at that moment (27a), which the host's
   * last capacity check decides by, or undefined when Pi reports it unknown; the body is passed for
   * the run record, never for accounting. */
  onRequest(request: unknown, contextTokens: number | undefined): void;
  /** Review 2026-09-10 (P2): `thinking` rides along as soon as the child exists, so a run the host
   * force-cancels at its cleanup deadline still audits the level it was really sent at. */
  onProgress(state: { usage: unknown; retries: { attempt: number; error: string }[]; thinking?: { requested?: ThinkingLevel; effective: ThinkingLevel } }): void;
  /** Dreamer's host check at a completed pass, with one same-child repair. */
  passEnd?(): string | undefined;
  onResponse?(id: string, inputTokens?: number): void;
  /** Pi's own retry policy (settings.json `retry`, read by the child's SettingsManager) scheduled a
   * backoff, and ended one. The host surfaces them; this module neither retries nor sleeps itself. */
  onRetry?(event: { attempt: number; maxAttempts: number; delayMs: number; error: string }): void;
  onRetryEnd?(): void;
}
/** Fresh context: a private child session with no parent file to inherit from. */
export interface NativeTask extends NativeCommon {
  systemPrompt: string;
}

export interface NativeResult {
  outcome: "success" | "failure" | "cancelled";
  output: string;
  /** Only the child's newly generated assistant messages; copied parent usage is never counted. */
  usage?: unknown;
  request?: unknown;
  retries: { attempt: number; error: string }[];
  /** Absolute path of the child's own JSONL under the runs directory. */
  nativeLog?: string;
  /** 26b: the level this child was asked to run at and the level Pi's clamp left it at. */
  thinking: { requested?: ThinkingLevel; effective: ThinkingLevel };
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

export async function runNative(task: NativeTask): Promise<NativeResult> {
  // --- Prepare the child. Failures before the first provider request are run failures with a reason.
  mkdirSync(task.runsDir, { recursive: true });
  // Fresh context (19b): only the bound tools, confined file tools and native Bash are registered.
  const system = task.systemPrompt;
  const bash = createBashTool(task.cwd);
  const tools: { name: string; description: string; parameters: Body;
    constrainedSampling?: PiToolDefinition["constrainedSampling"] }[] = [
    ...task.tools.map(definition => ({ name: definition.name, description: definition.description, parameters: definition.parameters as Body })),
    { name: task.read.name, description: task.read.description, parameters: { ...task.read.parameters },
      constrainedSampling: task.read.constrainedSampling },
    ...(task.fileTools ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters as Body })),
    { name: bash.name, description: bash.description, parameters: { ...bash.parameters }, constrainedSampling: bash.constrainedSampling }];
  const manager = SessionManager.create(task.cwd, task.runsDir);
  const nativeLog: string | undefined = manager.getSessionFile();

  const calls: { name: string; executed: boolean }[] = [];
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  // All tools share the same execution accounting and round limit, including plain (unsandboxed) Bash.
  const definitions = tools.map(tool => ({
    name: tool.name, label: tool.name, description: tool.description, parameters: tool.parameters as never,
    constrainedSampling: tool.constrainedSampling,
    executionMode: "sequential" as const,
    async execute(_id: string, raw: unknown) {
      const bound = task.tools.find(t => t.name === tool.name);
      const reading = tool.name === "read", file = task.fileTools?.find(t => t.name === tool.name), shell = tool.name === bash.name;
      calls.push({ name: tool.name, executed: (reading || !!file || shell || !!bound) && !exceeded });
      if (exceeded) throw new Error(`rejected: tool rounds exceeded (${task.maxToolRounds})`);
      if (shell) return bash.execute(_id, raw as never, task.signal);
      if (reading) return task.read.execute(_id, raw as never, task.signal, undefined, { cwd: task.cwd } as never);
      if (file) return file.execute(_id, raw as never, task.signal, undefined, { cwd: task.cwd } as never);
      if (!bound) throw new Error(`rejected: ${tool.name} is not available to a Trace Memory worker`);
      let content: string;
      try { content = await bound.execute(raw); }
      catch (error) { content = `rejected: ${String(error)}`; }
      return { ...result(content), ...(task.kind === "dreaming" && task.passEnd && task.maxToolRounds > 0 && rounds >= task.maxToolRounds ? { terminate: true } : {}) };
    },
  })) satisfies { name: string }[] as unknown as PiToolDefinition[];

  const settingsManager = SettingsManager.create(task.cwd, task.agentDir);
  // Discovery off: no extensions, skills, prompt templates, themes or project context. The one
  // supplied resource is this adapter's own inline extension, which hands the child its system
  // prompt through Pi's own `before_agent_start` result.
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
  // 26b: the frozen level is Pi's own `thinkingLevel` option, which takes precedence over the
  // per-model preference and the global default, and is clamped by Pi to
  // the levels this model supports. The effective level is read back from the session Pi built.
  const { session } = await createAgentSession({ cwd: task.cwd, agentDir: task.agentDir, model: task.model as never,
    settingsManager, resourceLoader, sessionManager: manager, thinkingLevel: task.thinkingLevel,
    noTools: "all", tools: definitions.map(d => d.name), customTools: definitions });
  const thinking = { ...(task.thinkingLevel ? { requested: task.thinkingLevel } : {}), effective: session.thinkingLevel };

  // --- Run the child.
  const retries: { attempt: number; error: string }[] = [];
  let usage: unknown, request: unknown, rounds = 0, failure: string | undefined, terminal: { stopReason?: string; errorMessage?: string; content?: unknown } | undefined;
  task.onProgress({ usage, retries, thinking }); // known now, not only with the final result (review 2026-09-10 P2)
  const seen = new Set<unknown>();
  // A fresh child's audit assumes nothing about the body's shape, so any API the SDK can call may
  // run it (review 2026-09-08).
  let exceeded = false;
  const inherited = session.agent.onPayload;
  session.agent.toolExecution = "sequential"; // Pi's tested default is parallel
  session.agent.onPayload = async (payload: unknown, model: unknown) => {
    task.signal?.throwIfAborted();
    const body = snapshot(payload) as Body;
    // The run record stores the last request sent, which embeds every earlier round (spec: Run record
    // contract).
    request = snapshot(body);
    // 27a: what the host's last capacity check decides by is Pi's measure of THIS CHILD's context, not
    // this body — `AgentSession.getContextUsage()`, the same number Pi shows for the foreground, which
    // runs pi-ai's `estimateContextTokens` over the child's own messages: the child's latest real
    // assistant usage once it has one, plus an estimate of what follows it. The guard therefore reads
    // no provider shape at all.
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
    const counters = message.usage as { input?: number; cacheRead?: number; cacheWrite?: number } | undefined;
    const input = counters?.input === undefined ? undefined : counters.input + (counters.cacheRead ?? 0) + (counters.cacheWrite ?? 0);
    task.onResponse?.(String(seen.size), input);
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
    task.onProgress({ usage, retries });
  });
  const abort = () => void session.abort();
  task.signal?.addEventListener("abort", abort);
  try {
    task.signal?.throwIfAborted();
    await session.prompt(task.task, { expandPromptTemplates: false });
    await session.waitForIdle();
    // A native prompt includes the whole tool loop and provider retries. Only now is this a pass end. The same child, counters
    // and retry accounting survive the follow-ups core authorizes: as many passes as the stop hook returns a message for
    // (a Noter's repair or next step, a Dreaming task's next batch; core bounds the count).
    for (let pass = 1; task.passEnd && !task.signal?.aborted && !failure && terminal?.stopReason !== "error" && terminal?.stopReason !== "aborted"; pass++) {
      // Only a normally ended pass gets a follow-up, so a truncated one stays the run's failure (125).
      const normal = terminal !== undefined && terminal.stopReason !== "length" && !terminal.errorMessage;
      // A Noter follow-up needs a normally ended pass; a Dreaming task is asked after every pass, truncated or not (125).
      const followup = task.kind === "dreaming" || normal ? task.passEnd() : undefined;
      if (!(followup && normal && (task.kind === "dreaming" ? task.maxToolRounds === 0 || rounds < task.maxToolRounds : true))) break;
      // A new public prompt reapplies before_agent_start. An idle custom-message turn skips it,
      // so Pi's next-turn refresh would replace the worker instructions with its base prompt.
      // The feedback identifies itself as host-generated, not evidence, in this same child log.
      await session.sendUserMessage(followup, { expandPromptTemplates: false });
      await session.waitForIdle();
    }
  } catch (error) {
    failure = String(error);
  } finally {
    task.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose(); // only this child's runtime and subscriptions
  }
  // Nothing left this process: the child could not start. No provider request was made.
  if (request === undefined && !task.signal?.aborted) throw new Error(failure ?? "native child produced no provider request");

  // `prompt()` resolving is not success: the outcome comes from the child's terminal response,
  // and core keeps a committed batch when that response failed.
  const aborted = !exceeded && (task.signal?.aborted || terminal?.stopReason === "aborted"); // a cap or refusal aborts the child itself: a failure, not a cancellation
  const failed = failure !== undefined || terminal === undefined || terminal.stopReason === "error" || terminal.stopReason === "length" || terminal.errorMessage !== undefined;
  const outcome = aborted ? "cancelled" as const : failed ? "failure" as const : "success" as const;
  const output = outcome === "success" ? text(terminal!)
    : failure ?? `${terminal?.stopReason ?? "no terminal assistant response"}${terminal?.errorMessage ? `: ${terminal.errorMessage}` : ""}${terminal && text(terminal) ? ` (partial output: ${text(terminal).slice(0, 200)})` : ""}`;
  return { outcome, output, usage, request, retries, calls, thinking, ...(nativeLog ? { nativeLog } : {}) };
}
