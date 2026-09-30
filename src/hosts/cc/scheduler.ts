import { NOTING_CAPACITY, type DreamingResult, type NotingResult, type TraceMemory, type TaskBoundary, type TaskTarget, type VisibleView } from "../../core/api/index.ts";
import type { CcReconcileResult } from "./importer.ts";
import type { ResolvedCcWorkerConfig } from "./config.ts";
import { CC_MAX_RESULT_CHARS } from "./tools.ts";

// CC alone defers MCP tools in a native fork. Core receives and prices this exact text at freeze;
// the host must not append anything to the admitted task at launch.
const CC_NOTER_FORK_GUIDANCE = "In this Claude Code fork, note and memory may be deferred. Use ToolSearch to load both tools before writing.";

export type CcWorkerPhase = "noting" | "dreaming";
export type CcForkChoice = { model: string; capacity: { inputTokens: number; prefixTokens: number }; visible: VisibleView } | { refused: string };
type CcTaskResult = NotingResult | DreamingResult;
export type CcCatchupState = "starting" | "running" | "waiting" | "completed" | "stopped" | "failed";
export interface CcCatchupStatus {
  state: CcCatchupState;
  phase?: CcWorkerPhase;
  entriesDone: number;
  entriesTotal: number;
  diagnostic?: string;
}
interface Catchup {
  target: TaskTarget;
  maxEntryId?: number;
  entryTotal: number;
  state: CcCatchupState;
  phase?: CcWorkerPhase;
  diagnostic?: string;
  /** Phases launched by this drain. Ordinary work in the shared slots is never adopted. */
  active: Set<CcWorkerPhase>;
}

/** One CC-local slot per phase. Core remains the authority for eligibility, claims, borrowing and settlement. */
export class CcTaskScheduler {
  private readonly memory: TraceMemory;
  private worker: ResolvedCcWorkerConfig | undefined;
  private readonly diagnostic: (message: string) => void;
  /** Ticket 75: a status-publish hook, fired when a phase is admitted and when it settles (slot
   * cleared). Best-effort, synchronous and never awaited; wrapped in `safeNotify` below so a fault in
   * the publisher — the wired implementation is already fully self-contained, but this boundary must
   * hold regardless — can never reach admission or settlement. */
  private readonly notify: (reason: string) => void;
  private readonly slots = new Map<CcWorkerPhase, Promise<CcTaskResult | undefined>>();
  private stopped = false;
  private catchup?: Catchup;
  private cancellationEpoch = 0;
  /** A selected-path or enrollment transition fences in-flight admission and the manual drain. */
  private lastReady = false;
  private lastBranch?: string;

  constructor(memory: TraceMemory, worker: ResolvedCcWorkerConfig | undefined,
    diagnostic: (message: string) => void, notify: (reason: string) => void = () => {}) {
    this.memory = memory; this.worker = worker; this.diagnostic = diagnostic; this.notify = notify;
  }

  running(): CcWorkerPhase[] { return [...this.slots.keys()]; }
  /** A future admission reads this snapshot; already reserved slots retain their captured phase config. */
  applyWorker(worker: ResolvedCcWorkerConfig | undefined): void { this.worker = worker; }

  private safeNotify(reason: string): void {
    try { this.notify(reason); } catch (error) { this.diagnostic(`status notify failed (${reason}): ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Observe every authoritative projection. Polls can resume a waiting drain after claim expiry. */
  reconcile(reconcile: CcReconcileResult): void {
    const drain = this.catchup;
    if (drain && (drain.state === "running" || drain.state === "waiting")) {
      const pathChanged = reconcile.coreSessionId !== null &&
        (reconcile.coreSessionId !== drain.target.sessionId || reconcile.branch !== drain.target.branch);
      if (pathChanged || reconcile.state === "disabled") {
        this.stopCatchup(pathChanged ? "selected branch changed" : "Trace Memory was disabled");
        this.memory.cancelTasks();
      }
    }
    const ready = reconcile.state === "ready" && reconcile.coreSessionId !== null && reconcile.headTurnId !== null && reconcile.selectedCount > 0;
    // A selected-path change or transition out of ready invalidates a queued checkpoint.
    if (this.lastReady && (!ready || reconcile.branch !== this.lastBranch)) this.cancellationEpoch++;
    if (ready) this.lastBranch = reconcile.branch;
    this.lastReady = ready;
    if (ready) this.driveCatchup(false);
  }

  catchupTicket(): number { return this.cancellationEpoch; }

  startCatchup(reconcile: CcReconcileResult, ticket = this.cancellationEpoch): CcCatchupStatus {
    if (ticket !== this.cancellationEpoch) return this.failedStatus("catchup was cancelled before admission");
    if (this.catchup && (this.catchup.state === "running" || this.catchup.state === "waiting")) {
      // A waiting drain with nothing drain-owned active has no in-process completion left to wake it
      // (e.g. a D admission dropped by a foreign claim). A repeated command is that recovery. A
      // running drain is only reported, never duplicated.
      if (this.catchup.state === "waiting" && !this.catchup.active.size) this.driveCatchup(true);
      return this.catchupStatus();
    }
    if (this.stopped) return this.failedStatus("CC executor is shutting down");
    if (!this.worker)
      return this.failedStatus("CC per-phase worker models, thinking levels, executable version and finite context capacities are not configured");
    if (reconcile.state === "disabled") return this.failedStatus("Trace Memory is disabled for this session");
    if (reconcile.state !== "ready" || reconcile.coreSessionId === null || reconcile.headTurnId === null || !reconcile.selectedCount)
      return this.failedStatus(reconcile.problems.join("; ") || "persisted selected source path is not ready");
    if (!this.memory.store.enabled(reconcile.coreSessionId)) return this.failedStatus("Trace Memory is disabled for this session");
    const target: TaskTarget = { sessionId: reconcile.coreSessionId, branch: reconcile.branch,
      headTurnId: reconcile.headTurnId, triggerEntryId: reconcile.selectedTailId! };
    const entries = this.pendingEntryIds(target);
    this.catchup = { target, maxEntryId: entries.length ? Math.max(...entries) : undefined,
      entryTotal: entries.length,
      state: "running", active: new Set() };
    this.driveCatchup();
    return this.catchupStatus();
  }

  /** Read the existing drain only. A menu read is not a catchup checkpoint or admission. */
  catchupSnapshot(): CcCatchupStatus | null { return this.startStatus ?? (this.catchup ? this.catchupStatus() : null); }

  /** A manual catchup is acknowledged at once, because its transcript sync can outlast the operator's
   * 2-second wait; the sync and `startCatchup` then follow in the executor. A repeated command while
   * starting or draining is only reported (and a stalled waiting drain re-driven, as `startCatchup`). */
  activeCatchup(): CcCatchupStatus | null {
    if (this.startStatus?.state === "starting") return this.startStatus;
    if (!this.catchup || (this.catchup.state !== "running" && this.catchup.state !== "waiting")) return null;
    if (this.catchup.state === "waiting" && !this.catchup.active.size) this.driveCatchup(true);
    return this.catchupStatus();
  }
  beginCatchup(): CcCatchupStatus {
    return this.startStatus = { state: "starting", entriesDone: 0, entriesTotal: 0,
      diagnostic: "syncing the transcript" };
  }
  /** A failed start stays visible until the next one; a started drain reports itself. */
  endCatchup(result: CcCatchupStatus): void { this.startStatus = result.state === "failed" ? result : null; }

  catchupStatus(): CcCatchupStatus {
    if (!this.catchup) return this.failedStatus("no catchup has been started");
    const drain = this.catchup;
    const remainingEntries = drain.maxEntryId === undefined ? 0 : this.pendingEntryIds(drain.target)
      .filter(id => id <= drain.maxEntryId!).length;
    return { state: drain.state, ...(drain.phase ? { phase: drain.phase } : {}),
      entriesDone: drain.entryTotal - remainingEntries, entriesTotal: drain.entryTotal,
      ...(drain.diagnostic ? { diagnostic: drain.diagnostic } : {}) };
  }

  /** Mark first, then the caller fences core tasks and the explicit manual drain. */
  stopCatchup(diagnostic = "stop requested"): void {
    this.cancellationEpoch++;
    if (!this.catchup || this.catchup.state === "completed" || this.catchup.state === "failed" || this.catchup.state === "stopped") return;
    this.catchup.state = "stopped"; this.catchup.phase = undefined; this.catchup.diagnostic = diagnostic;
  }

  private startStatus: CcCatchupStatus | null = null;

  private failedStatus(diagnostic: string): CcCatchupStatus {
    return { state: "failed", entriesDone: 0, entriesTotal: 0, diagnostic };
  }

  /** One ordinary phase evaluation at the main-turn checkpoint. */
  private startAutomatic(phase: CcWorkerPhase, own: TaskTarget, fork?: CcForkChoice,
    noLaunch?: () => void): void {
    if (this.slots.has(phase) || this.stopped) { noLaunch?.(); return; }
    let due = false;
    try { due = this.memory.taskEligibility(phase, own).due; }
    catch (error) { this.diagnostic(`${phase} eligibility failed: ${error instanceof Error ? error.message : String(error)}`); noLaunch?.(); return; }
    const candidates = due ? [{ ...own, borrowed: false }] : [];
    if (phase !== "dreaming") {
      try { candidates.push(...this.memory.store.closedTasks(phase, own.sessionId, this.memory.config.closedSessionScope)
        .map(target => ({ ...target, borrowed: true }))); }
      catch (error) { this.diagnostic(`${phase} closed-session scan failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!candidates.length) { noLaunch?.(); return; }
    if (!this.worker) {
      this.diagnostic(`${phase} admission failed: CC per-phase worker models, thinking levels, executable version and finite context capacities are not configured`);
      noLaunch?.(); return;
    }
    const cancellationEpoch = this.cancellationEpoch;
    this.reserve(phase, () => this.runCandidates(phase, own.sessionId, candidates, cancellationEpoch, fork, noLaunch));
  }

  turnEnd(reconcile: Pick<CcReconcileResult, "state" | "coreSessionId" | "headTurnId" | "selectedTailId" | "branch">, epoch: number,
    fork?: CcForkChoice, noLaunch?: () => void, notingFailure?: string): void {
    if (epoch !== this.cancellationEpoch || this.stopped || reconcile.state !== "ready" ||
      reconcile.coreSessionId === null || reconcile.headTurnId === null || reconcile.selectedTailId === null) { noLaunch?.(); return; }
    const target: TaskTarget = { sessionId: reconcile.coreSessionId, branch: reconcile.branch,
      headTurnId: reconcile.headTurnId, triggerEntryId: reconcile.selectedTailId };
    for (const phase of ["noting", "dreaming"] as const) {
      if (phase === "noting" && notingFailure) {
        this.diagnostic(`noting source observation failed: ${notingFailure}`);
        noLaunch?.();
        continue;
      }
      this.startAutomatic(phase, target, phase === "noting" ? fork : undefined, phase === "noting" ? noLaunch : undefined);
    }
  }

  /** Ordinary completion never triggers automatic work; a running manual drain still owns its checks. */
  private reserve(phase: CcWorkerPhase, run: () => Promise<CcTaskResult | undefined>,
    shouldDrive: (result: CcTaskResult | undefined) => boolean = result => {
      const drain = this.catchup;
      const drainActive = !!drain && (drain.state === "running" || drain.state === "waiting");
      if (result?.outcome !== "failure" && result?.outcome !== "cancelled")
        this.driveCatchup(drainActive && result?.outcome === "success");
      return false;
    }): void {
    const epoch = this.cancellationEpoch;
    let settled: CcTaskResult | undefined;
    const work = Promise.resolve().then(run).then(result => { settled = result; return result; });
    this.slots.set(phase, work);
    this.safeNotify(`${phase} admitted`);
    void work.catch(error => this.diagnostic(`${phase} worker failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.slots.delete(phase);
        this.safeNotify(`${phase} settled`);
        if (shouldDrive(settled)) this.driveCatchup();
      });
  }

  private common(phase: CcWorkerPhase, target: TaskTarget, borrowed: boolean, automatic: boolean, boundary?: TaskBoundary) {
    const execution = this.worker!.phases[phase];
    return { ...target, borrowed, automatic, executorSessionId: target.sessionId, mode: "subagent" as const,
      effectiveMode: "subagent" as const, model: execution.model, capacity: execution.capacity, maxReadChars: CC_MAX_RESULT_CHARS,
      thinkingLevel: execution.thinking, subagentThinkingLevel: execution.thinking, ...(boundary ? { boundary } : {}) };
  }

  private async runCandidates(phase: CcWorkerPhase, executorSessionId: number,
    candidates: (TaskTarget & { borrowed: boolean })[], cancellationEpoch: number,
    fork?: CcForkChoice, noLaunch?: () => void): Promise<CcTaskResult | undefined> {
    try { for (const { borrowed, ...target } of candidates) {
      try {
        const result = await this.runCandidate(phase, executorSessionId, target, borrowed, cancellationEpoch,
          !borrowed && phase === "noting" ? fork : undefined, noLaunch);
        if (!result || result.outcome !== "dropped" && result.outcome !== "empty") return result;
      } catch (error) {
        this.diagnostic(`${phase} admission failed for S${target.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        if (!(error instanceof Error && error.cause === "task admission")) return;
      }
    }
    } finally { noLaunch?.(); }
  }

  /** One ordinary admission path; callers own continuation and error handling, not claim policy. */
  private async runCandidate(phase: CcWorkerPhase, executorSessionId: number, target: TaskTarget,
    borrowed: boolean, epoch: number, fork?: CcForkChoice, noLaunch?: () => void): Promise<CcTaskResult | undefined> {
    if (this.stopped || this.cancellationEpoch !== epoch || !this.memory.store.enabled(executorSessionId)) { noLaunch?.(); return; }
    const options = { ...this.common(phase, target, borrowed, true), executorSessionId };
    let result: CcTaskResult;
    if (phase === "noting" && fork) {
      const fresh = (reason: string) => this.memory.noting({ ...options, mode: "fork", effectiveMode: "subagent",
        fallbackReason: reason });
      if ("refused" in fork) { noLaunch?.(); result = await fresh(fork.refused); }
      else {
        try {
          const frozenIds = this.memory.notingBatch(target).map(entry => entry.id);
          result = await this.memory.noting({ ...options, mode: "fork", effectiveMode: "fork",
            model: fork.model, capacity: fork.capacity, visible: fork.visible, forkGuidance: CC_NOTER_FORK_GUIDANCE });
          if (result.outcome === "dropped" && "refused" in result && result.refused && !this.stopped && this.cancellationEpoch === epoch) {
            const refusal = result.refused as { reason?: string };
            noLaunch?.();
            result = await this.memory.noting({ ...options, mode: "fork", effectiveMode: "subagent",
              fallbackReason: refusal.reason ?? "CC native fork did not start", executionId: "executionId" in result ? result.executionId : undefined,
              boundary: { exactEntryIds: frozenIds } });
          }
        } catch (error) {
          if (!(error instanceof Error && error.cause === "task admission" && error.message.startsWith(NOTING_CAPACITY))) throw error;
          noLaunch?.(); result = await fresh(error.message);
        }
      }
    } else {
      noLaunch?.();
      result = phase === "noting" ? await this.memory.noting(options) : await this.memory.dream(options);
    }
    this.report(phase, target, result);
    return result;
  }

  private report(phase: CcWorkerPhase, target: TaskTarget, result: CcTaskResult): void {
    if (result.automaticOff) this.diagnostic(result.automaticOff);
    const problems = "problems" in result ? result.problems ?? [] : [];
    if (result.outcome === "failure" || result.outcome === "bounced" || result.outcome === "cancelled" || problems.length)
      this.diagnostic(`${phase} worker ${result.outcome} for S${target.sessionId}${"runId" in result ? ` R${result.runId}` : ""}: ${problems.join("; ") || result.outcome}`);
  }

  /** ID-only progress keeps control acknowledgement independent of Raw payload size. */
  private pendingEntryIds(target: TaskTarget): number[] {
    return this.memory.store.pendingEntryIds(target.sessionId, target.branch, target.headTurnId);
  }

  /**
   * One catchup checkpoint (R4). Start, every successful completion (catchup-owned or ordinary) while
   * a drain is active, and a repeated `catchup` command on an idle waiting drain enter here with
   * checkAll and independently check N and D. The per-poll/per-entry drive stays N-only (checkAll
   * false). Busy ordinary slots are observed once and never adopted or queued.
   */
  private driveCatchup(checkAll = true, retryPhase?: CcWorkerPhase): void {
    const drain = this.catchup;
    if (!drain || this.stopped || (drain.state !== "running" && drain.state !== "waiting")) return;
    if (!this.memory.store.enabled(drain.target.sessionId)) { this.stopCatchup("Trace Memory was disabled"); return; }
    const epoch = this.cancellationEpoch;
    const owned = () => !this.stopped && this.catchup === drain && this.cancellationEpoch === epoch &&
      (drain.state === "running" || drain.state === "waiting");
    const remaining = drain.maxEntryId === undefined ? [] : this.pendingEntryIds(drain.target)
      .filter(id => id <= drain.maxEntryId!);
    if (!checkAll && !retryPhase && !remaining.length && drain.phase && drain.phase !== "noting") {
      this.finishWithoutCheckpoint(drain); // Ordinary release may have cleared all due work; settle without replaying it.
      return;
    }
    if (checkAll) drain.phase = undefined;
    let blockedNoting = false;
    let launched = false;

    const phases: readonly CcWorkerPhase[] = retryPhase ? [retryPhase] : checkAll ? ["noting", "dreaming"] : ["noting"];
    for (const phase of phases) {
      let due = retryPhase === phase || phase === "noting" && remaining.length > 0;
      if (phase !== "noting" && !retryPhase) {
        try { due = this.memory.taskEligibility(phase, drain.target).due; }
        catch (error) {
          drain.state = "failed"; drain.phase = undefined;
          drain.diagnostic = error instanceof Error ? error.message : String(error);
          this.diagnostic(`${phase} catchup failed: ${drain.diagnostic}`);
          return;
        }
      }
      if (!due || this.slots.has(phase)) {
        if (phase === "noting" && due) blockedNoting = true;
        continue;
      }
      if (phase === "noting") {
        const claim = this.memory.store.getClaim(drain.target.sessionId, phase);
        if (claim && claim.expiresAt > Date.now() && claim.executorId !== this.memory.executorId) {
          blockedNoting = true; continue;
        }
      }
      launched = true; drain.active.add(phase); drain.state = "running";
      if (phase !== "dreaming") drain.phase = phase;
      let checkpoint = false, retry = false;
      this.reserve(phase, async () => {
        if (!owned()) return;
        try {
          const result = phase === "noting"
            ? await this.memory.noting(this.common(phase, drain.target, false, false,
              { maxEntryId: drain.maxEntryId } as TaskBoundary))
            : await this.runCandidate(phase, drain.target.sessionId, drain.target, false, epoch);
          if (!result) return;
          if (phase === "noting") this.report(phase, drain.target, result);
          if (!owned()) return result;
          checkpoint = result.outcome === "success";
          if (result.outcome === "dropped") {
            if (phase === "noting") { drain.state = "waiting"; drain.phase = "noting"; }
          } else if (result.outcome === "failure" || result.outcome === "bounced") {
            drain.diagnostic = ("problems" in result ? result.problems?.join("; ") : undefined) || result.outcome;
            if (result.automaticOff) { drain.state = "stopped"; drain.phase = undefined; }
            else retry = true;
          } else if (result.outcome !== "success" && result.outcome !== "empty") {
            drain.state = result.outcome === "cancelled" ? "stopped" : "failed";
            drain.phase = undefined;
            drain.diagnostic = ("problems" in result ? result.problems?.join("; ") : undefined) || result.outcome;
          }
          return result;
        } catch (error) {
          if (owned()) {
            drain.state = "failed"; drain.phase = undefined;
            drain.diagnostic = error instanceof Error ? error.message : String(error);
          }
        }
      }, () => {
        drain.active.delete(phase);
        if (this.catchup !== drain) return false;
        if (retry) this.driveCatchup(false, phase); // Released slot, same phase and frozen boundary; no other eligibility check.
        else if (!checkpoint) this.finishWithoutCheckpoint(drain, blockedNoting);
        return checkpoint;
      });
    }

    if (launched || drain.active.size) return;
    if (remaining.length && blockedNoting) {
      drain.state = "waiting"; drain.phase = "noting"; return;
    }
    this.finishWithoutCheckpoint(drain, blockedNoting);
  }

  /** Empty/dropped are terminal for their opportunity: settle, but do not create another checkpoint. */
  private finishWithoutCheckpoint(drain: Catchup, blockedNoting = false): void {
    if (this.catchup !== drain || drain.active.size || drain.state === "failed" || drain.state === "stopped") return;
    const remaining = drain.maxEntryId === undefined ? 0 : this.pendingEntryIds(drain.target)
      .filter(id => id <= drain.maxEntryId!).length;
    if (remaining || blockedNoting) { drain.state = "waiting"; drain.phase = "noting"; return; }
    for (const phase of ["dreaming"] as const) {
      try {
        if (this.memory.taskEligibility(phase, drain.target).due) {
          drain.state = "waiting"; drain.phase = phase; return;
        }
      } catch (error) {
        drain.state = "failed"; drain.phase = undefined;
        drain.diagnostic = error instanceof Error ? error.message : String(error);
        return;
      }
    }
    drain.state = "completed"; drain.phase = undefined;
  }

  stop(): void { this.stopCatchup("executor shutdown"); this.stopped = true; }

  async settle(): Promise<void> { await Promise.allSettled([...this.slots.values()]); }
}
