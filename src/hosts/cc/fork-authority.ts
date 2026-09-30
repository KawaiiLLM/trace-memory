import type { NotingAgentInput, RunAgentResult } from "../../core/api/index.ts";

/** Executor-local authority for exactly one native Noter fork. The Hook reports native identities;
 * model arguments and MCP metadata alone never establish a grant. */
export class CcForkAuthority {
  private readonly onCancel?: (agentId: string) => void;
  /** 108: where the native fork's own transcript lives, recorded on every settlement that knows the agent. */
  private readonly transcriptOf?: (agentId: string) => string | undefined;
  constructor(onCancel?: (agentId: string) => void, transcriptOf?: (agentId: string) => string | undefined) {
    this.onCancel = onCancel; this.transcriptOf = transcriptOf;
  }
  private attempt?: {
    task: NotingAgentInput;
    agentId: string | null;
    calls: Map<string, "note" | "memory">;
    result: Promise<RunAgentResult>;
    finish: (result: RunAgentResult) => void;
    ready: Promise<void>;
    release: () => void;
    onAbort: () => void;
  };
  private readonly retired = new Set<string>();

  begin(task: NotingAgentInput): Promise<RunAgentResult> {
    if (this.attempt) throw new Error("a CC Noter fork is already active");
    let finish!: (result: RunAgentResult) => void, release!: () => void;
    const result = new Promise<RunAgentResult>(resolve => { finish = resolve; });
    const ready = new Promise<void>(resolve => { release = resolve; });
    const attempt = { task, agentId: null, calls: new Map<string, "note" | "memory">(), result, finish, ready, release,
      onAbort: () => this.retire(attempt, "cancelled") };
    this.attempt = attempt;
    task.signal?.addEventListener("abort", attempt.onAbort, { once: true });
    if (task.signal?.aborted) this.retire(attempt, "cancelled");
    return result;
  }

  /** A spawn response is ambiguous until it contains the actual native agentId. A missing response
   * cannot be classified as pre-start refusal by this module. */
  register(agentId: string): void {
    const attempt = this.attempt;
    if (!attempt || !agentId || attempt.agentId !== null) throw new Error("CC fork registration has no unique live launch");
    attempt.agentId = agentId;
    attempt.release();
  }

  /** First tool.call waits for the already initiated launch's registration, not a future hook.
   * A different agent or a repeated native call identity never gains N authority. */
  async call(agentId: string, callId: string, name: "note" | "memory"): Promise<boolean> {
    const attempt = this.attempt;
    if (!attempt || !agentId || !callId || this.retired.has(callId)) return false;
    await attempt.ready;
    if (this.attempt !== attempt || attempt.agentId !== agentId || attempt.calls.has(callId)) return false;
    attempt.calls.set(callId, name);
    return true;
  }

  /** Permission checks cannot create authority: only tool.call from the registered agent can. */
  allows(callId: string, name: "note" | "memory"): boolean {
    return !this.retired.has(callId) && this.attempt?.task.signal?.aborted !== true && this.attempt?.calls.get(callId) === name;
  }

  /** MCP dispatch consumes the native call grant exactly once; a retired call must never
   * fall through to immediate manual writes if its ID reappears. */
  take(callId: string, name: "note" | "memory"): NotingAgentInput | "retired" | null {
    if (this.retired.has(callId)) return "retired";
    const attempt = this.attempt;
    if (!attempt || attempt.task.signal?.aborted) return null;
    if (attempt.calls.has(callId) && attempt.calls.get(callId) !== name) return "retired";
    if (attempt.calls.get(callId) !== name) return null;
    attempt.calls.delete(callId);
    this.retired.add(callId);
    return attempt.task;
  }

  /** Only the actual agent's terminal settles this task. The caller validates the native event kind. */
  async complete(agentId: string, result: RunAgentResult): Promise<boolean> {
    const attempt = this.attempt;
    if (!attempt || !agentId) return false;
    await attempt.ready;
    if (this.attempt !== attempt || attempt.agentId !== agentId) return false;
    this.retire(attempt, result.outcome, result);
    return true;
  }

  /** Only an explicit native no-start result is a Core refusal; an ambiguous launch error fails
   * this attempt rather than silently retrying fresh after a possibly started fork. */
  noStart(refused: string, confirmed: boolean): void {
    const attempt = this.attempt;
    if (!attempt || attempt.agentId !== null) throw new Error("CC fork no-start result is not before registration");
    this.retire(attempt, "failure", { outcome: "failure", output: refused,
      ...(confirmed ? { refused: { reason: refused } } : {}) });
  }

  cancelAgent(agentId: string): boolean {
    if (this.attempt?.agentId !== agentId) return false;
    this.retire(this.attempt, "cancelled");
    return true;
  }

  cancel(): void { if (this.attempt) this.retire(this.attempt, "cancelled"); }

  private retire(attempt: NonNullable<CcForkAuthority["attempt"]>, outcome: "success" | "failure" | "cancelled",
    result?: RunAgentResult): void {
    if (this.attempt !== attempt) return;
    this.attempt = undefined;
    attempt.task.signal?.removeEventListener("abort", attempt.onAbort);
    attempt.release();
    for (const id of attempt.calls.keys()) this.retired.add(id);
    attempt.calls.clear();
    if (outcome === "cancelled" && attempt.agentId) this.onCancel?.(attempt.agentId);
    const nativeLog = attempt.agentId ? this.transcriptOf?.(attempt.agentId) : undefined;
    attempt.finish({ ...(result ?? { outcome, output: "CC Noter fork authority retired before native completion" }),
      ...(nativeLog ? { nativeLog } : {}) });
  }
}
