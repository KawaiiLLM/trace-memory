// One memory task, run as a native Pi child. This is the adapter between core's frozen agent task
// and `hosts/pi/native.ts`: it binds the task to a fork or a fresh child, keeps the run's own
// request/usage/retry accounting and returns the run record's result. 27c: it runs the task in the
// mode it was admitted for and nothing else — a fork it cannot run comes back as a `ForkRefusal`,
// and the host admits the task once more on the configured subagent model.
// It holds no session state — everything it needs is an argument, so a host state change
// after `runWorker` was called cannot reach a run that is already going (the abort signal is the one
// deliberate exception: cancellation must reach a running child).
// 27b (parent 27 amendment 4): Pi's own overflow classifier, imported from the package's main
// entry — a subpath import of `@earendil-works/pi-ai` does not resolve inside an installed
// extension (tests/package-smoke.mjs catches it). No pattern list of ours, and no error string
// rebuilt from the terminal message.
import { isContextOverflow } from "@earendil-works/pi-ai";
import { addUsage, NotForkable, runNative, type CacheObservation, type NativeForkTask, type NativeResult, type ThinkingLevel, type Verification as NativeVerification } from "./native.ts";
import type { Body } from "./fork.ts";
import type { ConsolidationAgentInput, NotingAgentInput, RunAgentResult, ToolDefinition } from "../../core/api/index.ts";

type Task = NotingAgentInput | ConsolidationAgentInput;
/** The model shape Pi's own child session takes, already resolved by the host's registry lookup. */
export type WorkerModel = NativeForkTask["model"];
/** Inherited context: the parent state a fork run is launched from, read by the host at launch. */
export interface ForkLaunch { parentFile: string; parentSessionId: string; checkpoint: string; captured: Body }
/** The fork gate's result on a run record: the passing verification of a fork run, or — under
 * `native` — the rejected one a fallback still records, with both hashes and the differing path. */
type RunVerification = Partial<NativeVerification> & { rounds: NativeVerification["rounds"]; native?: NativeVerification };

/** 27c (parent 27 "Per-task fork fallback"): why this task did not run with inherited context, and
 * what the refused attempt already produced. `runWorker` returns it instead of rerunning the frozen
 * task itself: the host admits the task once more — the configured subagent model, that model's
 * capacity, fresh material — and hands this back with the re-admission, so the one run that happens
 * keeps the attempt's usage, its retries and its gate result. */
export interface ForkRefusal {
  /** The run's recorded `fallbackReason` and the text of the one warning. */
  reason: string;
  /** Noting's frozen batch, so the re-admission selects the same entries: 18b's task boundary, the
   * mechanism a manual catchup already freezes its target with. */
  boundary?: { maxEntryId?: number };
  usage?: unknown;
  retries?: { attempt: number; error: string }[];
  verification?: RunVerification;
}

/** What the host hands one run. Values, not the host's live state; the callbacks are the only way
 * back into it (retry and cache notices, and the footer they refresh). */
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
}

/** 27b (parent 27 amendment 6, "After a fork attempt"): is this finished fork attempt one the host
 * may admit once more as a fresh child? Only when the provider rejected the request for context
 * capacity — Pi's own `isContextOverflow`, called with the child's terminal message and this window,
 * so authentication, network and rate-limit failures are none of it — and the run committed no
 * business submission and was not cancelled. `committed` is core's commit state as the native runner
 * reports it (a non-rejection receipt from `note`/`memory`), never a tool name or a display string.
 * Stop, shutdown, a lost claim and a disabled enrollment all cancel the task, which this refuses. */
function overflowFallback(native: NativeResult, model: WorkerModel, signal?: AbortSignal): boolean {
  if (native.outcome !== "failure" || native.committed || signal?.aborted || native.terminal === undefined) return false;
  const window = typeof model.contextWindow === "number" ? model.contextWindow : undefined;
  return isContextOverflow(native.terminal as never, window);
}

export async function runWorker(task: Task, binding: WorkerBinding): Promise<RunAgentResult> {
  const { model } = binding;
  let request: unknown = null;
  // 27b/27c: what the fork attempt this task was already refused for had produced — its usage, its
  // retries and its gate result — handed back by the host with the re-admission, so both attempts
  // stay in the one run record this task produces. A rejected request reports the SDK's placeholder
  // zeros, which `runNative` never counts, so unknown stays unknown rather than becoming a free
  // request.
  const carried = task.forkAttempt as ForkRefusal | undefined;
  let verification = carried?.verification;
  // 27c: the reason frozen with this task at the admission that decided it runs fresh; the run this
  // adapter is running now is the one that records it.
  let fallbackReason: string | undefined = task.fallbackReason;
  let mode: "fork" | "subagent" = "subagent";
  let usage: unknown = carried?.usage;
  let thinking: RunAgentResult["thinking"]; // reported by the runner as soon as the child exists (review 2026-09-10 P2)
  const retries: { attempt: number; error: string }[] = [...(carried?.retries ?? [])];
  const progress = () => task.reportProgress?.({ usage, retries: [...retries], request, mode, verification, fallbackReason, thinking });
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
      // later rounds nor its fallback. This is the *inherited* one, which the fork run below keeps
      // (26d): a fork's request prefix has to stay the captured parent's.
      thinkingLevel: task.thinkingLevel as ThinkingLevel | undefined,
      tools: binding.tools, maxToolRounds: binding.maxToolRounds,
      signal: task.signal, feedback: task.kind === "consolidation" ? task.reviewFeedback : undefined,
      onRequest: (body: unknown, contextTokens: number | undefined) => { binding.checkCapacity!(contextTokens); request = body; task.reportRequest(body); },
      onProgress: (state: { usage: unknown; retries: { attempt: number; error: string }[]; thinking?: RunAgentResult["thinking"] }) => {
        if (state.thinking) thinking = state.thinking;
        usage = carried ? addUsage(carried.usage, state.usage) : state.usage;
        retries.splice(0, retries.length, ...(carried?.retries ?? []), ...state.retries); progress(); },
      onRetry: binding.onRetry, onRetryEnd: binding.onRetryEnd,
    };
    if (task.mode === "fork" && binding.fork) {
      // 27c: whatever refuses this fork, the answer is the same one — the task comes back to the host,
      // which admits it once more on the configured subagent model and its capacity. Nothing is rerun
      // here on the model this task was frozen with, and no run is recorded for the refused attempt:
      // what it produced travels in the refusal and is charged to the run the re-admission makes.
      // The outcome beside it is what a caller that ignored `refused` would have to record, and it is
      // the honest one: nothing was committed and the evidence stays pending.
      const refused = (reason: string, attempt: Partial<ForkRefusal> = {}): RunAgentResult =>
        ({ outcome: "failure", output: reason, request,
          refused: { reason, ...(task.kind === "noting" ? { boundary: { maxEntryId: task.entryIds.at(-1) } } : {}), ...attempt } satisfies ForkRefusal });
      try {
        // Every host-side precondition — the cache-miss latch, post-compaction evidence, the branch,
        // the captured payload, the parent file and its leaf — was decided before this run started
        // and arrives as one refusal reason.
        if ("refused" in binding.fork) throw new NotForkable(binding.fork.refused);
        if (task.text.inherited === undefined) throw new NotForkable("this phase prepares no inherited-context material");
        const native = await runNative({ ...common, mode: "fork", parentFile: binding.fork.parentFile,
          parentSessionId: binding.fork.parentSessionId, checkpoint: binding.fork.checkpoint, captured: binding.fork.captured,
          task: `${task.prompt}\n\n${task.text.inherited}`, onCache: binding.onCache });
        request = native.request ?? request; verification = native.verification;
        // 27b: the one post-attempt refusal. A request the provider rejected for context capacity, in
        // a run that submitted nothing, is re-admitted on the same frozen evidence; the attempt's own
        // usage, retries and log go with it. Every other ending — success, an authentication or
        // rate-limit failure, a cancellation, a failure after a commit — is this run's outcome.
        if (overflowFallback(native, model, task.signal))
          return refused(`context overflow: ${native.output}${native.nativeLog ? ` (fork attempt log: ${native.nativeLog})` : ""}`,
            { usage: native.usage, retries: native.retries, verification });
        mode = "fork";
        usage = native.usage;
        retries.splice(0, retries.length, ...native.retries);
        return { outcome: native.outcome, output: native.output, usage, request, mode, verification, thinking: native.thinking,
          ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
      } catch (error) {
        if (!(error instanceof NotForkable)) throw error;
        // Nothing was sent and nothing was committed. A rejected gate travels with the refusal, so
        // the run the re-admission makes still records both hashes and the differing path.
        return refused(`native runner: ${error.message}`, error.verification ? { verification: { rounds: [], native: error.verification } } : {});
      }
    }
    // Native subagent parity (19b): explicit subagent mode, a task re-admitted after a fork refusal
    // and borrowed closed-session work all run in the same native runner, on a fresh private
    // SessionManager in the runs directory. A child that cannot be constructed at all is a run
    // failure with a reason (the outer catch below): there is no second runtime to fall back to, and
    // the queue stays pending for the next permitted trigger.
    // 26d: a fresh child thinks at the phase's own frozen subagent level — the configured preference
    // when it is not `inherit`, the inherited foreground level otherwise (the host resolves that at
    // admission; a host that froze only one level keeps 26b's single-level behaviour here).
    const native = await runNative({ ...common, thinkingLevel: (task.subagentThinkingLevel ?? task.thinkingLevel) as ThinkingLevel | undefined,
      mode: "subagent", systemPrompt: task.prompt, task: task.text.fresh });
    mode = "subagent";
    usage = carried ? addUsage(carried.usage, native.usage) : native.usage;
    request = native.request ?? request;
    retries.splice(0, retries.length, ...(carried?.retries ?? []), ...native.retries);
    return { outcome: native.outcome, output: native.output, usage, request, mode, verification, fallbackReason, thinking: native.thinking,
      ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
  } catch (error) {
    return { outcome: task.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failure",
      output: String(error), usage, retries, request, mode, verification, fallbackReason };
  }
}
