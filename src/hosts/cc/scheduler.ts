import type { ConsolidateResult, DreamingResult, NotingResult, TraceMemory, TaskBoundary, TaskTarget } from "../../core/api/index.ts";
import type { CcReconcileResult } from "./importer.ts";
import type { ResolvedCcWorkerConfig } from "./config.ts";
import { CC_MAX_RESULT_CHARS } from "./tools.ts";

export type CcWorkerPhase = "noting" | "consolidation" | "dreaming";
type CcTaskResult = NotingResult | ConsolidateResult | DreamingResult;
export type CcCatchupState = "running" | "waiting" | "completed" | "stopped" | "failed";
export interface CcCatchupStatus {
  state: CcCatchupState;
  phase?: CcWorkerPhase;
  entriesDone: number;
  entriesTotal: number;
  factsDone: number;
  factsTotal: number;
  diagnostic?: string;
}
interface Catchup {
  target: TaskTarget;
  maxEntryId?: number;
  entryTotal: number;
  factIds: Set<number>;
  factTotal: number;
  state: CcCatchupState;
  phase?: CcWorkerPhase;
  diagnostic?: string;
  /** Phases launched by this drain. Ordinary work in the shared slots is never adopted. */
  active: Set<CcWorkerPhase>;
}

/** One CC-local slot per phase. Core remains the authority for eligibility, claims, borrowing and settlement. */
export class CcTaskScheduler {
  private readonly memory: TraceMemory;
  private readonly worker: ResolvedCcWorkerConfig | undefined;
  private readonly diagnostic: (message: string) => void;
  private readonly slots = new Map<CcWorkerPhase, Promise<CcTaskResult | undefined>>();
  private stopped = false;
  private catchup?: Catchup;
  private cancellationEpoch = 0;
  /** Ticket 72: ports 69's per-entry rule to CC. Noting has no entry here — every appended entry
   * evaluates it, own and borrowed, exactly as before. Consolidation and Dreaming are evaluated only
   * while armed; a phase disarms itself the moment its own evaluation comes back not-due, and a due
   * phase that did not launch (busy slot, foreign claim, dropped) stays armed for the next opportunity.
   * `noting: true` is never read; it exists only so `phase: CcWorkerPhase` can index this object
   * without narrowing. Constructing this scheduler (attach) is itself an arming event. */
  private readonly armed: Record<CcWorkerPhase, boolean> = { noting: true, consolidation: true, dreaming: true };
  private armCD(): void { this.armed.consolidation = true; this.armed.dreaming = true; }
  /** The last-seen `Store.progressSignal` for this session: a change re-arms C and D, closing what the
   * flags above miss on their own — a commit made through a different connection to the same database
   * file (another executor, a Pi session, an operator CLI). Compared at every per-entry opportunity. */
  private lastArmSignal?: string;
  /** Was the last reconcile "ready" (a bound, enabled session with a persisted selected path and
   * head), and on which branch. A transition into ready (attach, or memory re-enabled) and a branch
   * switch (a selected-path change or a retarget) both arm C and D, mirroring 69's "restore" event on
   * Pi. A transition OUT of ready, or a branch change, also fences in-flight completions the same way
   * `stopCatchup` already does for stop/off: a task admitted against the old path must not use a late
   * completion to launch C or D there (`checkpointCD` always re-evaluates the current path instead). */
  private lastReady = false;
  private lastBranch?: string;
  /** The freshest known effective path: what the completion checkpoint evaluates, never the settled
   * task's own (possibly stale) target. Set at every ready reconcile, whether or not it appended entries. */
  private currentTarget?: TaskTarget;

  constructor(memory: TraceMemory, worker: ResolvedCcWorkerConfig | undefined,
    diagnostic: (message: string) => void) {
    this.memory = memory; this.worker = worker; this.diagnostic = diagnostic;
  }

  running(): CcWorkerPhase[] { return [...this.slots.keys()]; }

  /** Observe every authoritative projection. Polls can resume a waiting drain after claim expiry. */
  reconcile(reconcile: CcReconcileResult, admitAutomatic = true, opportunityEpoch = this.cancellationEpoch): void {
    const drain = this.catchup;
    if (drain && (drain.state === "running" || drain.state === "waiting")) {
      const pathChanged = reconcile.coreSessionId !== null &&
        (reconcile.coreSessionId !== drain.target.sessionId || reconcile.branch !== drain.target.branch);
      if (pathChanged || reconcile.state === "disabled") {
        this.stopCatchup(pathChanged ? "selected branch changed" : "Trace Memory was disabled");
        this.memory.cancelTasks();
      }
    }
    const ready = reconcile.state === "ready" && reconcile.coreSessionId !== null && reconcile.headTurnId !== null && !!reconcile.selectedEntryIds.length;
    // Ticket 72: a selected-path change or a transition out of ready fences in-flight completions the
    // same way stop/off already do through `stopCatchup` above — bump the epoch even with no catchup
    // drain active, so the ordinary completion checkpoint observes it too.
    if (this.lastReady && (!ready || reconcile.branch !== this.lastBranch)) this.cancellationEpoch++;
    if (ready) {
      if (!this.lastReady || reconcile.branch !== this.lastBranch) this.armCD();
      this.lastBranch = reconcile.branch;
      this.currentTarget = { sessionId: reconcile.coreSessionId!, branch: reconcile.branch,
        headTurnId: reconcile.headTurnId!, triggerEntryId: reconcile.selectedEntryIds.at(-1)! };
    }
    this.lastReady = ready;
    if (!ready) return;
    if (admitAutomatic && opportunityEpoch === this.cancellationEpoch && reconcile.appendedEntryIds.length) {
      const selected = new Set(reconcile.selectedEntryIds);
      // Bootstrap collapses actual new selected history, never an instance-start opportunity.
      // Hook-first/known resumes and newly imported siblings grant no final-path check.
      const appended = reconcile.appendedEntryIds.filter(id => selected.has(id));
      const opportunities = reconcile.bootstrap && appended.length ? [reconcile.selectedEntryIds.at(-1)!] : appended;
      for (const entryId of opportunities) {
        const entry = this.memory.store.getSourceEntry(entryId);
        if (!entry) throw new Error(`CC appended entry ${entryId} disappeared before scheduling`);
        const own: TaskTarget = { sessionId: reconcile.coreSessionId!, branch: reconcile.branch,
          headTurnId: reconcile.bootstrap ? reconcile.headTurnId! : entry.turnId, triggerEntryId: entry.id };
        // Ticket 72: an appended entry alone re-arms nothing; a change of the completed signal since
        // the last opportunity does (a commit through another connection this executor has not seen).
        const signal = this.memory.store.progressSignal(own.sessionId);
        if (signal !== this.lastArmSignal) { this.lastArmSignal = signal; this.armCD(); }
        for (const phase of ["noting", "consolidation", "dreaming"] as const) this.startAutomatic(phase, own);
      }
    }
    this.driveCatchup(false);
  }

  catchupTicket(): number { return this.cancellationEpoch; }

  startCatchup(reconcile: CcReconcileResult, ticket = this.cancellationEpoch): CcCatchupStatus {
    if (ticket !== this.cancellationEpoch) return this.failedStatus("catchup was cancelled before admission");
    if (this.catchup && (this.catchup.state === "running" || this.catchup.state === "waiting")) {
      // A waiting drain with nothing drain-owned active has no in-process completion left to wake it
      // (e.g. a C/D admission dropped by a foreign claim). A repeated command is that recovery. A
      // running drain is only reported, never duplicated.
      if (this.catchup.state === "waiting" && !this.catchup.active.size) this.driveCatchup(true);
      return this.catchupStatus();
    }
    if (this.stopped) return this.failedStatus("CC executor is shutting down");
    if (!this.worker)
      return this.failedStatus("CC per-phase worker models, thinking levels, executable version and finite context capacities are not configured");
    if (reconcile.state === "disabled") return this.failedStatus("Trace Memory is disabled for this session");
    if (reconcile.state !== "ready" || reconcile.coreSessionId === null || reconcile.headTurnId === null || !reconcile.selectedEntryIds.length)
      return this.failedStatus(reconcile.problems.join("; ") || "persisted selected source path is not ready");
    if (!this.memory.store.enabled(reconcile.coreSessionId)) return this.failedStatus("Trace Memory is disabled for this session");
    const target: TaskTarget = { sessionId: reconcile.coreSessionId, branch: reconcile.branch,
      headTurnId: reconcile.headTurnId, triggerEntryId: reconcile.selectedEntryIds.at(-1)! };
    const entries = this.pendingEntryIds(target);
    const facts = this.memory.store.consolidationBatch(target.sessionId, target.branch, target.headTurnId).map(fact => fact.id);
    this.catchup = { target, maxEntryId: entries.length ? Math.max(...entries) : undefined,
      entryTotal: entries.length, factIds: new Set(facts), factTotal: facts.length,
      state: "running", active: new Set() };
    this.driveCatchup();
    return this.catchupStatus();
  }

  catchupStatus(): CcCatchupStatus {
    if (!this.catchup) return this.failedStatus("no catchup has been started");
    const drain = this.catchup;
    const remainingEntries = drain.maxEntryId === undefined ? 0 : this.pendingEntryIds(drain.target)
      .filter(id => id <= drain.maxEntryId!).length;
    const remainingFacts = this.memory.store
      .consolidationBatch(drain.target.sessionId, drain.target.branch, drain.target.headTurnId)
      .filter(fact => drain.factIds.has(fact.id)).length;
    return { state: drain.state, ...(drain.phase ? { phase: drain.phase } : {}),
      entriesDone: drain.entryTotal - remainingEntries, entriesTotal: drain.entryTotal,
      factsDone: drain.factTotal - remainingFacts, factsTotal: drain.factTotal,
      ...(drain.diagnostic ? { diagnostic: drain.diagnostic } : {}) };
  }

  /** Mark first, then the caller fences core tasks. This prevents completion chaining in the race. */
  stopCatchup(diagnostic = "stop requested"): void {
    this.cancellationEpoch++;
    if (!this.catchup || this.catchup.state === "completed" || this.catchup.state === "failed" || this.catchup.state === "stopped") return;
    this.catchup.state = "stopped"; this.catchup.phase = undefined; this.catchup.diagnostic = diagnostic;
  }

  private failedStatus(diagnostic: string): CcCatchupStatus {
    return { state: "failed", entriesDone: 0, entriesTotal: 0, factsDone: 0, factsTotal: 0, diagnostic };
  }

  /** Ticket 72: Noting always evaluates (own and borrowed, exactly as before). Consolidation and
   * Dreaming evaluate their own candidate only while armed — an appended entry alone cannot change
   * either answer (67/69: no fact and no knowledge revision comes from Raw) — but the borrowed
   * closed-session scan keeps its per-opportunity timing unchanged, running regardless of `armed`, so
   * `includeBorrowed=false` is only ever passed by the completion checkpoint below. */
  private startAutomatic(phase: CcWorkerPhase, own: TaskTarget, includeBorrowed = true): void {
    if (this.slots.has(phase) || this.stopped) return;
    const evaluate = phase === "noting" || this.armed[phase];
    let due = false;
    if (evaluate) {
      try { due = this.memory.taskEligibility(phase, own).due; }
      catch (error) { this.diagnostic(`${phase} eligibility failed: ${error instanceof Error ? error.message : String(error)}`); return; }
      if (phase !== "noting") this.armed[phase] = due; // not-due disarms; due leaves it armed until launch settles
    }
    const candidates = [...(due ? [{ ...own, borrowed: false }] : []),
      ...(phase === "dreaming" || !includeBorrowed ? [] : this.memory.store.closedTasks(phase, own.sessionId, this.memory.config.closedSessionScope)
        .map(target => ({ ...target, borrowed: true })))];
    if (!candidates.length) return;
    if (!this.worker) {
      this.diagnostic(`${phase} admission failed: CC per-phase worker models, thinking levels, executable version and finite context capacities are not configured`);
      return;
    }
    const cancellationEpoch = this.cancellationEpoch;
    this.reserve(phase, own.sessionId, () => this.runCandidates(phase, own.sessionId, candidates, cancellationEpoch));
  }

  /**
   * R4: a successful ordinary completion while a drain is active is a full checkpoint (all of N/C/D
   * checked); any other ordinary outcome (failure, cancelled, empty, dropped, bounced) stays N-only,
   * matching the per-poll drive.
   */
  private reserve(phase: CcWorkerPhase, sessionId: number, run: () => Promise<CcTaskResult | undefined>,
    shouldDrive: (result: CcTaskResult | undefined) => boolean = result => {
      const drain = this.catchup;
      const drainActive = !!drain && (drain.state === "running" || drain.state === "waiting");
      this.driveCatchup(drainActive && result?.outcome === "success");
      return false;
    }): void {
    const epoch = this.cancellationEpoch;
    const admissionSignal = this.memory.store.progressSignal(sessionId);
    let settled: CcTaskResult | undefined;
    const work = Promise.resolve().then(run).then(result => { settled = result; return result; });
    this.slots.set(phase, work);
    void work.catch(error => this.diagnostic(`${phase} worker failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        this.slots.delete(phase);
        // Ticket 72's completion checkpoint: any non-empty, non-dropped completion may have moved
        // consolidationBatch/duePools (success or failure — a failed run may still have committed
        // incrementally), so it re-checks own C and D immediately rather than waiting for the next
        // appended entry. Gated on the signal actually having moved since this task's own admission, so
        // a run that settles without committing anything falls back to the ordinary pace, as before.
        if (settled && settled.outcome !== "empty" && settled.outcome !== "dropped" &&
          this.memory.store.progressSignal(sessionId) !== admissionSignal) this.checkpointCD(sessionId, epoch);
        if (shouldDrive(settled)) this.driveCatchup();
      });
  }

  /** Ticket 72 item 3: fenced by the same admission an ordinary opportunity passes — the task's own
   * cancellation epoch (a stop, an off, or a selected-path change/retarget since admission bumps it,
   * per `reconcile` above), the executor not stopped, and memory still enabled — and it evaluates the
   * CURRENT effective path (`currentTarget`), never the finished task's own (possibly stale) target.
   * It checks only own C and D, scanning no borrowed candidates, so it composes with 68's catchup
   * checkpoint through the same slot reservation: whichever `reserve`s a phase first wins that slot;
   * the other's `startAutomatic` call becomes a no-op. */
  private checkpointCD(sessionId: number, epoch: number): void {
    if (this.stopped || this.cancellationEpoch !== epoch) return;
    const target = this.currentTarget;
    if (!target || target.sessionId !== sessionId || !this.memory.store.enabled(sessionId)) return;
    this.armCD();
    this.startAutomatic("consolidation", target, false);
    this.startAutomatic("dreaming", target, false);
  }

  private common(phase: CcWorkerPhase, target: TaskTarget, borrowed: boolean, automatic: boolean, boundary?: TaskBoundary) {
    const execution = this.worker!.phases[phase];
    return { ...target, borrowed, automatic, executorSessionId: target.sessionId, mode: "subagent" as const,
      effectiveMode: "subagent" as const, model: execution.model, capacity: execution.capacity, maxReadChars: CC_MAX_RESULT_CHARS,
      thinkingLevel: execution.thinking, subagentThinkingLevel: execution.thinking, ...(boundary ? { boundary } : {}) };
  }

  private async runCandidates(phase: CcWorkerPhase, executorSessionId: number,
    candidates: (TaskTarget & { borrowed: boolean })[], cancellationEpoch: number): Promise<CcTaskResult | undefined> {
    for (const { borrowed, ...target } of candidates) {
      try {
        const result = await this.runCandidate(phase, executorSessionId, target, borrowed, cancellationEpoch);
        if (!result || result.outcome !== "dropped" && result.outcome !== "empty") return result;
      } catch (error) {
        this.diagnostic(`${phase} admission failed for S${target.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        if (!(error instanceof Error && error.cause === "task admission")) return;
      }
    }
  }

  /** One ordinary admission path; callers own continuation and error handling, not claim policy. */
  private async runCandidate(phase: CcWorkerPhase, executorSessionId: number, target: TaskTarget,
    borrowed: boolean, epoch: number): Promise<CcTaskResult | undefined> {
    if (this.stopped || this.cancellationEpoch !== epoch || !this.memory.store.enabled(executorSessionId)) return;
    const options = { ...this.common(phase, target, borrowed, true), executorSessionId };
    const result = phase === "noting" ? await this.memory.noting(options)
      : phase === "consolidation" ? await this.memory.consolidate(options) : await this.memory.dream(options);
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
   * checkAll and independently check N, C and D. The per-poll/per-entry drive stays N-only (checkAll
   * false). Busy ordinary slots are observed once and never adopted or queued.
   */
  private driveCatchup(checkAll = true): void {
    const drain = this.catchup;
    if (!drain || this.stopped || (drain.state !== "running" && drain.state !== "waiting")) return;
    if (!this.memory.store.enabled(drain.target.sessionId)) { this.stopCatchup("Trace Memory was disabled"); return; }
    const epoch = this.cancellationEpoch;
    const owned = () => !this.stopped && this.catchup === drain && this.cancellationEpoch === epoch &&
      (drain.state === "running" || drain.state === "waiting");
    const remaining = drain.maxEntryId === undefined ? [] : this.pendingEntryIds(drain.target)
      .filter(id => id <= drain.maxEntryId!);
    if (!checkAll && !remaining.length && drain.phase && drain.phase !== "noting") {
      this.finishWithoutCheckpoint(drain); // Ordinary release may have cleared all due work; settle without replaying it.
      return;
    }
    if (checkAll) drain.phase = undefined;
    let blockedNoting = false;
    let launched = false;

    const phases: readonly CcWorkerPhase[] = checkAll ? ["noting", "consolidation", "dreaming"] : ["noting"];
    for (const phase of phases) {
      let due = phase === "noting" ? remaining.length > 0 : false;
      if (phase !== "noting") {
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
      let checkpoint = false;
      this.reserve(phase, drain.target.sessionId, async () => {
        if (!owned()) return;
        try {
          const result = phase === "noting"
            ? await this.memory.noting(this.common(phase, drain.target, false, false,
              { maxEntryId: drain.maxEntryId } as TaskBoundary))
            : await this.runCandidate(phase, drain.target.sessionId, drain.target, false, epoch);
          if (!result) return;
          if (phase === "noting" && "facts" in result && Array.isArray(result.facts))
            for (const fact of result.facts) if (!drain.factIds.has(fact.id)) { drain.factIds.add(fact.id); drain.factTotal++; }
          if (phase === "noting") this.report(phase, drain.target, result);
          if (!owned()) return result;
          checkpoint = result.outcome === "success";
          if (result.outcome === "dropped") {
            if (phase === "noting") { drain.state = "waiting"; drain.phase = "noting"; }
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
        if (!checkpoint) this.finishWithoutCheckpoint(drain, blockedNoting);
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
    for (const phase of ["consolidation", "dreaming"] as const) {
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
