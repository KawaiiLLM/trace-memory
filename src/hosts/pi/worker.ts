// One memory task, run as a native Pi child. This is the adapter between core's frozen agent task
// and `hosts/pi/native.ts`: it binds the task to a fresh private child, keeps the run's own
// request/usage/retry accounting and returns the run record's result.
// It holds no session state — everything it needs is an argument, so a host state change
// after `runWorker` was called cannot reach a run that is already going (the abort signal is the one
// deliberate exception: cancellation must reach a running child).
import { runNative, type NativeTask, type ThinkingLevel } from "./native.ts";
import type { NotingAgentInput, DreamingAgentInput, RunAgentResult, ToolDefinition } from "../../core/api/index.ts";
import type { memoryReadTool } from "./memory-files.ts";

type Task = NotingAgentInput | DreamingAgentInput;
/** The model shape Pi's own child session takes, already resolved by the host's registry lookup. */
export type WorkerModel = NativeTask["model"];

/** What the host hands one run. Values, not the host's live state; the callbacks are the only way
 * back into it (retry notices, and the footer they refresh). */
export interface WorkerBinding {
  /** Resolved from Pi's registry by the host. Absent when the configured model does not exist, which
   * fails the run before anything is sent — and then `checkCapacity` is absent too, unused. */
  model?: WorkerModel;
  /** The last check before a request leaves (27a): the frozen batch fit the reported capacity, and
   * Pi's own measure of the child's context — supplied by the runner, never read off the body — must
   * still fit the one capacity rule. An unknown measure refuses nothing. */
  checkCapacity?: (contextTokens: number | undefined) => void;
  /** The memory tools core bound for this run, as the host wrapped them. */
  tools: ToolDefinition[];
  read: ReturnType<typeof memoryReadTool>;
  /** The Noter's write and edit, confined to its two workspace files (ticket 144). */
  fileTools?: NativeTask["fileTools"];
  runsDir: string;
  cwd: string;
  agentDir: string;
  /** 0 = unlimited, as `maxToolRounds` has always meant. */
  maxToolRounds: number;
  onRetry(event: { attempt: number; maxAttempts: number; delayMs: number; error: string }): void;
  onRetryEnd(): void;
}

export async function runWorker(task: Task, binding: WorkerBinding): Promise<RunAgentResult> {
  const { model } = binding;
  let request: unknown = null;
  let usage: unknown;
  let thinking: RunAgentResult["thinking"]; // reported by the runner as soon as the child exists (review 2026-09-10 P2)
  const retries: { attempt: number; error: string }[] = [];
  const progress = () => task.reportProgress?.({ usage, retries: [...retries], request, thinking });
  try {
    task.signal?.throwIfAborted();
    if (!model) throw new Error(`Unavailable model: ${task.model}`);
    // 20a: core prepares the domain text from one frozen task; this adapter only binds it to native
    // messages: a fresh child takes the instructions as its system prompt and the whole material as
    // its first user message. 19a/19b: the only runner — every task runs in a fresh private child
    // session. Pi owns the model call, the tool loop, the retry policy and cancellation.
    // 26d: a fresh child thinks at the phase's own frozen subagent level — the configured preference
    // when it is not `inherit`, the inherited foreground level otherwise (the host resolves that at
    // admission; a host that froze only one level keeps 26b's single-level behaviour here).
    // A child that cannot be constructed at all is a run failure with a reason (the catch below):
    // there is no second runtime to fall back to, and the queue stays pending for the next
    // permitted trigger.
    const native = await runNative({
      kind: task.kind, runsDir: binding.runsDir, cwd: task.workspace?.dir ?? binding.cwd, agentDir: binding.agentDir, model,
      thinkingLevel: (task.subagentThinkingLevel ?? task.thinkingLevel) as ThinkingLevel | undefined,
      tools: binding.tools, read: binding.read, fileTools: binding.fileTools, maxToolRounds: binding.maxToolRounds,
      signal: task.signal,
      passEnd: task.passEnd,
      onResponse: task.kind === "noting" ? task.reportResponse : undefined,
      onRequest: (body: unknown, contextTokens: number | undefined) => { binding.checkCapacity!(contextTokens); request = body; task.reportRequest(body); },
      onProgress: (state: { usage: unknown; retries: { attempt: number; error: string }[]; thinking?: RunAgentResult["thinking"] }) => {
        if (state.thinking) thinking = state.thinking;
        usage = state.usage;
        retries.splice(0, retries.length, ...state.retries); progress(); },
      onRetry: binding.onRetry, onRetryEnd: binding.onRetryEnd,
      systemPrompt: task.prompt, task: task.text });
    usage = native.usage;
    request = native.request ?? request;
    retries.splice(0, retries.length, ...native.retries);
    return { outcome: native.outcome, output: native.output, usage, request, thinking: native.thinking,
      ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
  } catch (error) {
    return { outcome: task.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failure",
      output: String(error), usage, retries, request };
  }
}
