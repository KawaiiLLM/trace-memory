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
import { NotForkable, runNative, type NativeForkTask, type NativeResult, type ThinkingLevel, type Verification as NativeVerification } from "./native.ts";
import type { Body } from "./fork.ts";
import type { NotingAgentInput, DreamingAgentInput, RunAgentResult, ToolDefinition, CacheObservation } from "../../core/api/index.ts";

type Task = NotingAgentInput | DreamingAgentInput;
/** The model shape Pi's own child session takes, already resolved by the host's registry lookup. */
export type WorkerModel = NativeForkTask["model"];
/** Inherited context: the parent state a fork run is launched from, read by the host at launch. */
export interface ForkLaunch { parentFile: string; parentSessionId: string; checkpoint: string; captured: Body;
  /** Recheck the exact parent after asynchronous native preparation, before its first request. */
  recheck?: () => string | undefined;
}
/** The fork gate's result on a run record: the passing verification of a fork run, or — under
 * `native` — the rejected one a fallback still records, with both hashes and the differing path. */
type RunVerification = Partial<NativeVerification> & { rounds: NativeVerification["rounds"]; native?: NativeVerification };

/** 27c (parent 27 "Per-task fork fallback"): why this task did not run with inherited context.
 * `runWorker` returns it instead of rerunning the frozen task itself: the host admits the task once
 * more — the configured subagent model, that model's capacity, fresh material — and hands this back
 * with the re-admission.
 *
 * 27d (user ruling 2026-09-10, "each attempt is its own run record"): it carries no usage and no
 * retries any more. An attempt that really sent a request is recorded by core as its own `fork`
 * run before this value goes back to the host, and the re-admitted run records only its own spend.
 * What stays here is what the NEXT admission needs and could not derive: why, on which entries, at
 * which frozen levels, under which cancellation generation, and — for a refusal that sent nothing —
 * the rejected gate result, which has no run record of its own to live on. */
export interface ForkRefusal {
  /** The run's recorded `fallbackReason` and the text of the one warning. */
  reason: string;
  /** The frozen batch, so the re-admission selects the same evidence: 18b's task boundary, the
   * mechanism a manual catchup already freezes its target with. 27d (parent 27 amendment 6) and 29e:
   * the exact ids of Noting's entries — never an
   * upper bound and never a manual catchup's larger allowable set, both of which prevent additions
   * but permit a smaller batch. */
  boundary?: { exactEntryIds?: number[] };
  /** The rejected gate result of a refusal that sent nothing, which the re-admitted run records
   * (a refused attempt that did send one records its own gate result on its own run). */
  verification?: RunVerification;
  /** 27d repair 3 (parent 27 line 96; 26d's freeze rule): the two levels this task was admitted at.
   * The re-admission reuses them and reads neither the foreground level nor the phase's preference
   * again — repricing fresh material is not permission to reread a frozen policy choice. */
  thinkingLevel?: string;
  subagentThinkingLevel?: string;
  /** Configured fresh model selected at the first host admission, not after an async refusal. */
  subagentModel?: string;
  /** 27d repair 4 (parent 27 line 83): core's cancellation generation, frozen at this task's
   * admission. A re-admission whose carried generation is older than core's current one is dropped. */
  cancellation?: number;
  /** The run core recorded for the refused attempt, when that attempt sent a request. The
   * re-admitted run names it in its own `fallbackReason`, so the two records read as one task. */
  runId?: number;
  executionId?: string;
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
  // 27c/27d: the gate result of a refusal that sent nothing — the only evidence of the previous
  // attempt this run still records, because a refusal that sent nothing has no run record of its
  // own. Usage and retries are not carried any more: each attempt is its own run record (27d), so
  // this run reports only what it spends itself.
  let verification = (task.forkAttempt as ForkRefusal | undefined)?.verification;
  // 27c: the reason frozen with this task at the admission that decided it runs fresh; the run this
  // adapter is running now is the one that records it.
  let fallbackReason: string | undefined = task.fallbackReason;
  let mode: "fork" | "subagent" = "subagent";
  let usage: unknown;
  let thinking: RunAgentResult["thinking"]; // reported by the runner as soon as the child exists (review 2026-09-10 P2)
  const retries: { attempt: number; error: string }[] = [];
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
      signal: task.signal,
      ...(task.kind === "noting" ? { reportToolRejection: task.reportToolRejection } : {}),
      ...(task.kind === "dreaming" ? { passEnd: task.passEnd, reportRounds: task.reportRounds } : {}),
      onRequest: (body: unknown, contextTokens: number | undefined) => { binding.checkCapacity!(contextTokens); request = body; task.reportRequest(body); },
      onProgress: (state: { usage: unknown; retries: { attempt: number; error: string }[]; thinking?: RunAgentResult["thinking"] }) => {
        if (state.thinking) thinking = state.thinking;
        usage = state.usage;
        retries.splice(0, retries.length, ...state.retries); progress(); },
      onRetry: binding.onRetry, onRetryEnd: binding.onRetryEnd,
    };
    if (task.mode === "fork" && binding.fork) {
      // 27c: whatever refuses this fork, the answer is the same one — the task comes back to the host,
      // which admits it once more on the configured subagent model and its capacity. Nothing is rerun
      // here on the model this task was frozen with.
      // 27d: the result beside the refusal is this attempt's own run record, as core writes it when
      // the attempt sent a request (`request != null`; the gate rejects inside `onPayload`, before a
      // body leaves, so a refusal that sent nothing reports none). It is the honest outcome either
      // way: nothing was committed and the evidence stays pending.
      const refused = (reason: string, attempt: Partial<RunAgentResult> = {}, gate?: RunVerification): RunAgentResult =>
        ({ outcome: "failure", output: reason, request, ...attempt,
          refused: { reason, boundary: { exactEntryIds: [...task.entryIds] },
            ...(task.thinkingLevel !== undefined ? { thinkingLevel: task.thinkingLevel } : {}),
            ...(task.subagentThinkingLevel !== undefined ? { subagentThinkingLevel: task.subagentThinkingLevel } : {}),
            ...(task.cancellation !== undefined ? { cancellation: task.cancellation } : {}),
            ...(gate ? { verification: gate } : {}) } satisfies ForkRefusal });
      try {
        // Every host-side precondition — the cache-miss latch, post-compaction evidence, the branch,
        // the captured payload, the parent file and its leaf — was decided before this run started
        // and arrives as one refusal reason.
        if ("refused" in binding.fork) throw new NotForkable(binding.fork.refused);
        const native = await runNative({ ...common, mode: "fork", parentFile: binding.fork.parentFile,
          parentSessionId: binding.fork.parentSessionId, checkpoint: binding.fork.checkpoint, captured: binding.fork.captured,
          recheck: binding.fork.recheck,
          task: `${task.prompt}\n\n${task.text}`, onCache: binding.onCache });
        request = native.request ?? request; verification = native.verification;
        // 27b: the one post-attempt refusal. A request the provider rejected for context capacity, in
        // a run that submitted nothing, is re-admitted on the same frozen evidence; the attempt's own
        // usage, retries and log go with it. Every other ending — success, an authentication or
        // rate-limit failure, a cancellation, a failure after a commit — is this run's outcome.
        if (overflowFallback(native, model, task.signal))
          // 27d: this attempt sent a request, so it is its own `fork`/`failure` run — its usage, its
          // retries, its gate result, its log and the level it really ran at go on THAT record, and
          // none of them is carried into the re-admitted run.
          return refused(`context overflow: ${native.output}${native.nativeLog ? ` (fork attempt log: ${native.nativeLog})` : ""}`,
            { mode: "fork", usage: native.usage, retries: native.retries, verification, thinking: native.thinking,
              ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}) });
        mode = "fork";
        usage = native.usage;
        retries.splice(0, retries.length, ...native.retries);
        return { outcome: native.outcome, output: native.output, usage, request, mode, verification, thinking: native.thinking,
          ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
      } catch (error) {
        if (!(error instanceof NotForkable)) throw error;
        // Nothing was sent and nothing was committed. A rejected gate travels with the refusal, so
        // the run the re-admission makes still records both hashes and the differing path.
        return refused(`native runner: ${error.message}`, {}, error.verification ? { rounds: [], native: error.verification } : undefined);
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
      mode: "subagent", systemPrompt: task.prompt, task: task.text });
    mode = "subagent";
    usage = native.usage;
    request = native.request ?? request;
    retries.splice(0, retries.length, ...native.retries);
    return { outcome: native.outcome, output: native.output, usage, request, mode, verification, fallbackReason, thinking: native.thinking,
      ...(native.nativeLog ? { nativeLog: native.nativeLog } : {}), ...(retries.length ? { retries } : {}) };
  } catch (error) {
    return { outcome: task.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? "cancelled" : "failure",
      output: String(error), usage, retries, request, mode, verification, fallbackReason };
  }
}
