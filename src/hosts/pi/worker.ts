// One memory task, run as a native Pi child. This is the adapter between core's frozen agent task
// and `hosts/pi/native.ts`: it binds the task to a fork or a fresh child, keeps the run's own
// request/usage/retry accounting, applies the documented fork fallback and returns the run record's
// result. It holds no session state — everything it needs is an argument, so a host state change
// after `runWorker` was called cannot reach a run that is already going (the abort signal is the one
// deliberate exception: cancellation must reach a running child).
import { NotForkable, runNative, type CacheObservation, type NativeForkTask, type ThinkingLevel, type Verification as NativeVerification } from "./native.ts";
import type { Body } from "./fork.ts";
import type { ConsolidationAgentInput, NotingAgentInput, RunAgentResult, ToolDefinition } from "../../core/api/index.ts";

type Task = NotingAgentInput | ConsolidationAgentInput;
/** The model shape Pi's own child session takes, already resolved by the host's registry lookup. */
export type WorkerModel = NativeForkTask["model"];
/** Inherited context: the parent state a fork run is launched from, read by the host at launch. */
export interface ForkLaunch { parentFile: string; parentSessionId: string; checkpoint: string; captured: Body }

/** What the host hands one run. Values, not the host's live state; the callbacks are the only way
 * back into it (retry and cache notices, the footer they refresh, the one-per-session fallback
 * notice). */
export interface WorkerBinding {
  /** Resolved from Pi's registry by the host. Absent when the configured model does not exist, which
   * fails the run before anything is sent — and then `checkCapacity` is absent too, unused. */
  model?: WorkerModel;
  /** The last check before a request leaves: the frozen batch fit the reported capacity, and the
   * real body with the instructions, the tools and the output reserve must still fit the model. */
  checkCapacity?: (payload: unknown) => void;
  /** The memory tools core bound for this run, as the host wrapped them. */
  tools: ToolDefinition[];
  runsDir: string;
  cwd: string;
  agentDir: string;
  /** 0 = unlimited, as `maxToolRounds` has always meant. */
  maxToolRounds: number;
  /** A fork task's frozen launch, or the host's reason for refusing to fork this one. Absent for a
   * task that was never asked to run with inherited context. */
  fork?: ForkLaunch | { refused: string };
  /** 19c: one completed fork response was eligible for the cache-miss policy, hit or miss. */
  onCache(observation: CacheObservation): void;
  onRetry(event: { attempt: number; maxAttempts: number; delayMs: number; error: string }): void;
  onRetryEnd(): void;
  /** A fork task that fell back to a fresh child, with the reason it was refused. */
  onFallback(reason: string): void;
}

export async function runWorker(task: Task, binding: WorkerBinding): Promise<RunAgentResult> {
  const { model } = binding;
  let request: unknown = null;
  // The fork gate's result: the passing verification of a fork run, or — under `native` — the
  // rejected one a fallback still records, with both hashes and the differing path.
  let verification: (Partial<NativeVerification> & { rounds: NativeVerification["rounds"]; native?: NativeVerification }) | undefined;
  let fallbackReason: string | undefined;
  let mode: "fork" | "subagent" = "subagent";
  let usage: unknown;
  const retries: { attempt: number; error: string }[] = [];
  const progress = () => task.reportProgress?.({ usage, retries: [...retries], request, mode, verification, fallbackReason });
  try {
    task.signal?.throwIfAborted();
    if (!model) throw new Error(`Unavailable model: ${task.model}`);
    // 20a: core prepares the domain text of both representations from one frozen task; this adapter
    // only binds it to native messages. A fork has no system slot of its own, so its appended user
    // message carries the instructions and then the increment; a fresh child takes the instructions
    // as its system prompt and the whole material as its first user message.
    // 19a/19b/19c: the only runner. A fork task runs in Pi's own child `AgentSession` branched at
    // the parent's persisted leaf; an unforkable fork task and every subagent task (explicit, a fork
    // fallback, or borrowed closed-session work) run in a fresh private child session. Pi owns the
    // model call, the tool loop, the retry policy and cancellation in both; this adapter keeps only
    // the byte-level gate on a fork's first request.
    const common = {
      runsDir: binding.runsDir, cwd: binding.cwd, agentDir: binding.agentDir, model,
      // 26b: the level the host froze with this task at admission, carried by the frozen task itself
      // (core keeps it opaque), so a foreground switch after admission reaches neither this run's
      // later rounds nor its fallback.
      thinkingLevel: task.thinkingLevel as ThinkingLevel | undefined,
      tools: binding.tools, maxToolRounds: binding.maxToolRounds,
      signal: task.signal, feedback: task.kind === "consolidation" ? task.reviewFeedback : undefined,
      onRequest: (body: unknown) => { binding.checkCapacity!(body); request = body; task.reportRequest(body); },
      onProgress: (state: { usage: unknown; retries: { attempt: number; error: string }[] }) => {
        usage = state.usage; retries.splice(0, retries.length, ...state.retries); progress(); },
      onRetry: binding.onRetry, onRetryEnd: binding.onRetryEnd,
    };
    if (task.mode === "fork" && binding.fork) {
      try {
        // Every host-side precondition — the cache-miss latch, post-compaction evidence, the branch,
        // the captured payload, the parent file and its leaf — was decided before this run started
        // and arrives as one refusal reason.
        if ("refused" in binding.fork) throw new NotForkable(binding.fork.refused);
        if (task.text.inherited === undefined) throw new NotForkable("this phase prepares no inherited-context material");
        const native = await runNative({ ...common, mode: "fork", parentFile: binding.fork.parentFile,
          parentSessionId: binding.fork.parentSessionId, checkpoint: binding.fork.checkpoint, captured: binding.fork.captured,
          task: `${task.prompt}\n\n${task.text.inherited}`, onCache: binding.onCache });
        mode = "fork";
        usage = native.usage; request = native.request ?? request; verification = native.verification;
        retries.splice(0, retries.length, ...native.retries);
        return { outcome: native.outcome, output: native.output, usage, request, mode, verification, thinking: native.thinking,
          ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
      } catch (error) {
        if (!(error instanceof NotForkable)) throw error;
        // Nothing was sent and nothing was committed: this task continues as a native subagent.
        fallbackReason = `native runner: ${error.message}`;
        if (error.verification) verification = { rounds: [], native: error.verification }; // a rejected gate still records both hashes
        binding.onFallback(fallbackReason);
      }
    }
    // Native subagent parity (19b): explicit subagent mode, a fork fallback and borrowed
    // closed-session work all run in the same native runner, on a fresh private SessionManager in
    // the runs directory. A child that cannot be constructed at all is a run failure with a reason
    // (the outer catch below): there is no second runtime to fall back to, and the queue stays
    // pending for the next permitted trigger.
    const native = await runNative({ ...common, mode: "subagent", systemPrompt: task.prompt, task: task.text.fresh });
    mode = "subagent";
    usage = native.usage; request = native.request ?? request;
    retries.splice(0, retries.length, ...native.retries);
    return { outcome: native.outcome, output: native.output, usage, request, mode, verification, fallbackReason, thinking: native.thinking,
      ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
  } catch (error) {
    return { outcome: task.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failure",
      output: String(error), usage, retries, request, mode, verification, fallbackReason };
  }
}
