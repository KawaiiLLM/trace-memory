import type { ConsolidateResult, DreamingResult, NotingResult, TraceMemory, TaskBoundary, TaskTarget } from "../../core/api/index.ts";
import type { CcReconcileResult } from "./importer.ts";
import type { ResolvedCcWorkerConfig } from "./config.ts";
import { CC_MAX_RESULT_CHARS } from "./tools.ts";

export type CcWorkerPhase = "noting" | "consolidation" | "dreaming";
type CcTaskResult = NotingResult | ConsolidateResult | DreamingResult;
export type CcCatchupState = "running" | "waiting" | "completed" | "stopped" | "failed";
export interface CcCatchupStatus {
  state: CcCatchupState;
  phase?: "noting" | "consolidation";
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
  phase?: "noting" | "consolidation";
  diagnostic?: string;
  downstream: Set<"consolidation" | "dreaming">;
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
    if (reconcile.state !== "ready" || reconcile.coreSessionId === null || reconcile.headTurnId === null || !reconcile.selectedEntryIds.length) return;
    if (admitAutomatic && opportunityEpoch === this.cancellationEpoch && (reconcile.bootstrap || reconcile.appendedEntryIds.length)) {
      const selected = new Set(reconcile.selectedEntryIds);
      // Bootstrap publishes history once; only subsequent live increments replay their own
      // selected entries. The final entry is the bootstrap origin, never the first old record.
      const opportunities = reconcile.bootstrap ? [reconcile.selectedEntryIds.at(-1)!] : reconcile.appendedEntryIds;
      for (const entryId of opportunities) {
        if (!selected.has(entryId)) continue;
        const entry = this.memory.store.getSourceEntry(entryId);
        if (!entry) throw new Error(`CC appended entry ${entryId} disappeared before scheduling`);
        const own: TaskTarget = { sessionId: reconcile.coreSessionId, branch: reconcile.branch,
          headTurnId: reconcile.bootstrap ? reconcile.headTurnId : entry.turnId, triggerEntryId: entry.id };
        for (const phase of ["noting", "consolidation", "dreaming"] as const) this.startAutomatic(phase, own);
      }
    }
    this.driveCatchup();
  }

  catchupTicket(): number { return this.cancellationEpoch; }

  startCatchup(reconcile: CcReconcileResult, ticket = this.cancellationEpoch): CcCatchupStatus {
    if (ticket !== this.cancellationEpoch) return this.failedStatus("catchup was cancelled before admission");
    if (this.catchup && (this.catchup.state === "running" || this.catchup.state === "waiting")) return this.catchupStatus();
    if (this.stopped) return this.failedStatus("CC executor is shutting down");
    if (!this.worker)
      return this.failedStatus("CC per-phase worker models, thinking levels, executable version and finite context capacities are not configured");
    if (reconcile.state === "disabled") return this.failedStatus("Trace Memory is disabled for this session");
    if (reconcile.state !== "ready" || reconcile.coreSessionId === null || reconcile.headTurnId === null || !reconcile.selectedEntryIds.length)
      return this.failedStatus(reconcile.problems.join("; ") || "persisted selected source path is not ready");
    if (!this.memory.store.enabled(reconcile.coreSessionId)) return this.failedStatus("Trace Memory is disabled for this session");
    const target: TaskTarget = { sessionId: reconcile.coreSessionId, branch: reconcile.branch,
      headTurnId: reconcile.headTurnId, triggerEntryId: reconcile.selectedEntryIds.at(-1)! };
    const entries = this.memory.pendingEntries(target.sessionId, target.branch, target.headTurnId);
    const facts = this.memory.store.consolidationBatch(target.sessionId, target.branch, target.headTurnId).map(fact => fact.id);
    this.catchup = { target, maxEntryId: entries.length ? Math.max(...entries.map(entry => entry.id)) : undefined,
      entryTotal: entries.length, factIds: new Set(facts), factTotal: facts.length,
      state: entries.length ? "running" : "completed", downstream: new Set() };
    this.driveCatchup();
    return this.catchupStatus();
  }

  catchupStatus(): CcCatchupStatus {
    if (!this.catchup) return this.failedStatus("no catchup has been started");
    const drain = this.catchup;
    const remainingEntries = drain.maxEntryId === undefined ? 0 : this.memory
      .pendingEntries(drain.target.sessionId, drain.target.branch, drain.target.headTurnId)
      .filter(entry => entry.id <= drain.maxEntryId!).length;
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

  private startAutomatic(phase: CcWorkerPhase, own: TaskTarget): void {
    if (this.slots.has(phase) || this.stopped) return;
    let due = false;
    try { due = this.memory.taskEligibility(phase, own).due; }
    catch (error) { this.diagnostic(`${phase} eligibility failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    const candidates = [...(due ? [{ ...own, borrowed: false }] : []),
      ...(phase === "dreaming" ? [] : this.memory.store.closedTasks(phase, own.sessionId, this.memory.config.closedSessionScope)
        .map(target => ({ ...target, borrowed: true })))];
    if (!candidates.length) return;
    if (!this.worker) {
      this.diagnostic(`${phase} admission failed: CC per-phase worker models, thinking levels, executable version and finite context capacities are not configured`);
      return;
    }
    const cancellationEpoch = this.cancellationEpoch;
    this.reserve(phase, () => this.runCandidates(phase, own.sessionId, candidates, cancellationEpoch));
  }

  private reserve(phase: CcWorkerPhase, run: () => Promise<CcTaskResult | undefined>,
    shouldDrive: () => boolean = () => true): void {
    const work = Promise.resolve().then(run);
    this.slots.set(phase, work);
    void work.catch(error => this.diagnostic(`${phase} worker failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { this.slots.delete(phase); if (shouldDrive()) this.driveCatchup(); });
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
      // Slots are reserved synchronously but provider admission starts in a microtask. The same
      // cancellation epoch that fences manual catchup also fences ordinary and borrowed candidates,
      // including continuation after an earlier candidate drops or loses admission.
      if (this.stopped || this.cancellationEpoch !== cancellationEpoch || !this.memory.store.enabled(executorSessionId)) return;
      try {
        const options = { ...this.common(phase, target, borrowed, true), executorSessionId };
        const result = phase === "noting" ? await this.memory.noting(options)
          : phase === "consolidation" ? await this.memory.consolidate(options) : await this.memory.dream(options);
        this.report(phase, target, result);
        if (result.outcome !== "dropped" && result.outcome !== "empty") return result;
      } catch (error) {
        this.diagnostic(`${phase} admission failed for S${target.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        if (!(error instanceof Error && error.cause === "task admission")) return;
      }
    }
  }

  private report(phase: CcWorkerPhase, target: TaskTarget, result: CcTaskResult): void {
    if (result.automaticOff) this.diagnostic(result.automaticOff);
    const problems = "problems" in result ? result.problems ?? [] : [];
    if (result.outcome === "failure" || result.outcome === "bounced" || result.outcome === "cancelled" || problems.length)
      this.diagnostic(`${phase} worker ${result.outcome} for S${target.sessionId}${"runId" in result ? ` R${result.runId}` : ""}: ${problems.join("; ") || result.outcome}`);
  }

  private driveCatchup(): void {
    const drain = this.catchup;
    if (!drain || this.stopped || (drain.state !== "running" && drain.state !== "waiting")) return;
    if (!this.memory.store.enabled(drain.target.sessionId)) { this.stopCatchup("Trace Memory was disabled"); return; }
    const remainingEntries = drain.maxEntryId === undefined ? [] : this.memory
      .pendingEntries(drain.target.sessionId, drain.target.branch, drain.target.headTurnId)
      .filter(entry => entry.id <= drain.maxEntryId!);
    if (!remainingEntries.length) {
      drain.state = drain.downstream.size ? "waiting" : "completed";
      drain.phase = drain.downstream.has("consolidation") ? "consolidation" : undefined;
      return;
    }
    const phase = "noting";
    drain.phase = phase;
    if (this.slots.has(phase)) { drain.state = "waiting"; return; }
    const claim = this.memory.store.getClaim(drain.target.sessionId, phase);
    if (claim && claim.expiresAt > Date.now() && claim.executorId !== this.memory.executorId) { drain.state = "waiting"; return; }
    drain.state = "running";
    const cancellationEpoch = this.cancellationEpoch;
    const boundary: TaskBoundary = { maxEntryId: drain.maxEntryId };
    let chain = true;
    const drainActive = () => drain.state === "running" || drain.state === "waiting";
    this.reserve(phase, async () => {
      // Reservation is synchronous, admission is not. Recheck the exact drain after the microtask
      // boundary so stop/off/path changes cannot launch a task after their cancellation acknowledgement.
      if (this.stopped || this.catchup !== drain || this.cancellationEpoch !== cancellationEpoch ||
          !drainActive()) { chain = false; return; }
      let result: NotingResult;
      try {
        result = await this.memory.noting(this.common(phase, drain.target, false, false, boundary));
      } catch (error) {
        if (this.catchup === drain && drainActive()) {
          drain.state = "failed"; drain.phase = undefined; drain.diagnostic = error instanceof Error ? error.message : String(error);
        }
        return;
      }
      const produced = phase === "noting" && "facts" in result && Array.isArray(result.facts) ? result.facts : [];
      for (const fact of produced) if (!drain.factIds.has(fact.id)) { drain.factIds.add(fact.id); drain.factTotal++; }
      this.report(phase, drain.target, result);
      if (this.catchup !== drain || !drainActive()) return result;
      if (result.outcome === "dropped") { drain.state = "waiting"; chain = false; return result; }
      if (result.outcome !== "success" && result.outcome !== "empty") {
        drain.state = result.outcome === "cancelled" ? "stopped" : "failed"; drain.phase = undefined;
        drain.diagnostic = result.problems?.join("; ") || result.outcome;
      }
      if (result.outcome === "success") this.checkDownstream(drain, "consolidation", cancellationEpoch);
      return result;
    }, () => chain);
  }

  /** Catchup adds completion opportunities, not a second admission policy or a retry queue. */
  private checkDownstream(drain: Catchup, phase: "consolidation" | "dreaming", epoch: number): void {
    const active = () => !this.stopped && this.catchup === drain && this.cancellationEpoch === epoch &&
      (drain.state === "running" || drain.state === "waiting") && this.memory.store.enabled(drain.target.sessionId);
    if (!active() || this.slots.has(phase)) return;
    let due: boolean;
    try { due = this.memory.taskEligibility(phase, drain.target).due; }
    catch (error) { this.diagnostic(`${phase} eligibility failed: ${String(error)}`); return; }
    if (!due) return;
    drain.downstream.add(phase);
    this.reserve(phase, async () => {
      if (!active()) return;
      const result = await this.runCandidates(phase, drain.target.sessionId,
        [{ ...drain.target, borrowed: false }], epoch);
      if (active() && result?.outcome === "success" && phase === "consolidation")
        this.checkDownstream(drain, "dreaming", epoch);
      return result;
    }, () => { drain.downstream.delete(phase); return true; });
  }

  stop(): void { this.stopCatchup("executor shutdown"); this.stopped = true; }

  async settle(): Promise<void> { await Promise.allSettled([...this.slots.values()]); }
}
