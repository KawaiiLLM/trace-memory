import type { ConsolidateResult, NotingResult, TraceMemory, TaskTarget } from "../../core/api/index.ts";
import type { CcReconcileResult } from "./importer.ts";
import type { ResolvedCcWorkerConfig } from "./config.ts";
import { CC_MAX_RESULT_CHARS } from "./tools.ts";

export type CcWorkerPhase = "noting" | "consolidation";
type CcTaskResult = NotingResult | ConsolidateResult;

/** CC-local N/C slots. Core remains the authority for eligibility, claims, borrowing and settlement. */
export class CcTaskScheduler {
  private readonly memory: TraceMemory;
  private readonly worker: ResolvedCcWorkerConfig | undefined;
  private readonly capacity: { inputTokens: number; prefixTokens: 0 } | undefined;
  private readonly diagnostic: (message: string) => void;
  private readonly slots = new Map<CcWorkerPhase, Promise<CcTaskResult | undefined>>();
  private stopped = false;

  constructor(memory: TraceMemory, worker: ResolvedCcWorkerConfig | undefined,
    capacity: { inputTokens: number; prefixTokens: 0 } | undefined,
    diagnostic: (message: string) => void) {
    this.memory = memory; this.worker = worker; this.capacity = capacity; this.diagnostic = diagnostic;
  }

  running(): CcWorkerPhase[] { return [...this.slots.keys()]; }

  /** One completed-entry opportunity. Repeated stat/watch reconciliations with no new source do nothing. */
  trigger(reconcile: CcReconcileResult): void {
    if (this.stopped || reconcile.state !== "ready" || !reconcile.appendedEntryIds.length ||
        reconcile.coreSessionId === null || reconcile.headTurnId === null || !reconcile.selectedEntryIds.length) return;
    const own: TaskTarget = { sessionId: reconcile.coreSessionId, branch: reconcile.branch,
      headTurnId: reconcile.headTurnId, triggerEntryId: reconcile.selectedEntryIds.at(-1)! };
    for (const phase of ["noting", "consolidation"] as const) this.start(phase, own);
  }

  private start(phase: CcWorkerPhase, own: TaskTarget): void {
    if (this.slots.has(phase) || this.stopped) return;
    let due = false;
    try { due = this.memory.taskEligibility(phase, own).due; }
    catch (error) { this.diagnostic(`${phase} eligibility failed: ${error instanceof Error ? error.message : String(error)}`); return; }
    const candidates = [...(due ? [{ ...own, borrowed: false }] : []),
      ...this.memory.store.closedTasks(phase, own.sessionId, this.memory.config.closedSessionScope)
        .map(target => ({ ...target, borrowed: true }))];
    if (!candidates.length) return;
    if (!this.worker || !this.capacity) {
      this.diagnostic(`${phase} admission failed: CC worker model, effort, executable version and finite context capacity are not configured`);
      return;
    }
    // Reserve synchronously before the async function can reach core admission or the native SDK.
    const work = Promise.resolve().then(() => this.runCandidates(phase, own.sessionId, candidates));
    this.slots.set(phase, work);
    void work.catch(error => this.diagnostic(`${phase} worker failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => this.slots.delete(phase));
  }

  private async runCandidates(phase: CcWorkerPhase, executorSessionId: number,
    candidates: (TaskTarget & { borrowed: boolean })[]): Promise<CcTaskResult | undefined> {
    for (const { borrowed, ...target } of candidates) {
      if (this.stopped || !this.memory.store.enabled(executorSessionId)) return;
      try {
        const common = { ...target, borrowed, automatic: true, executorSessionId, mode: "subagent" as const,
          effectiveMode: "subagent" as const, model: this.worker!.model, capacity: this.capacity!, maxReadChars: CC_MAX_RESULT_CHARS,
          thinkingLevel: this.worker!.effort, subagentThinkingLevel: this.worker!.effort };
        const result = phase === "noting" ? await this.memory.noting(common) : await this.memory.consolidate(common);
        if (result.automaticOff) this.diagnostic(result.automaticOff);
        const problems = "problems" in result ? result.problems ?? [] : [];
        if (result.outcome === "failure" || result.outcome === "bounced" || result.outcome === "cancelled" || problems.length)
          this.diagnostic(`${phase} worker ${result.outcome} for S${target.sessionId}${"runId" in result ? ` R${result.runId}` : ""}: ${problems.join("; ") || result.outcome}`);
        if (result.outcome !== "dropped" && result.outcome !== "empty") return result;
      } catch (error) {
        this.diagnostic(`${phase} admission failed for S${target.sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        if (!(error instanceof Error && error.cause === "task admission")) return;
      }
    }
  }

  stop(): void { this.stopped = true; }

  async settle(): Promise<void> {
    await Promise.allSettled([...this.slots.values()]);
  }
}
