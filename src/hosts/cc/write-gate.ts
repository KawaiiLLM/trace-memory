// Function hooks have a 10-second own-time budget, including clock waits.
export const DEFAULT_WRITE_RESPONSE_TIMEOUT_MS = 8_000;
export function writeResponseTimeout(value: unknown = DEFAULT_WRITE_RESPONSE_TIMEOUT_MS): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 9_000)
    throw new Error("Invalid CC writeResponseTimeoutMs: expected an integer from 1 to 9000");
  return value;
}

export const isCcForegroundWrite = (tool: string): boolean =>
  /^mcp__(?:traceMemory|plugin_trace-memory_traceMemory)__(note|memory)$/.test(tool);

export class WriteResponseStep {
  readonly calls = new Set<string>();
  private readonly completion = Promise.withResolvers<boolean>();
  readonly ready = this.completion.promise;
  result: boolean | undefined;
  private readonly abort = () => this.finish(false);
  readonly session: string;
  readonly turn: string;
  private readonly signal?: AbortSignal;

  constructor(session: string, turn: string, signal?: AbortSignal) {
    this.session = session;
    this.turn = turn;
    this.signal = signal;
    signal?.addEventListener("abort", this.abort, { once: true });
    if (signal?.aborted) this.finish(false);
  }

  finish(complete: boolean): void {
    if (this.result !== undefined) return;
    this.result = complete;
    this.signal?.removeEventListener("abort", this.abort);
    this.completion.resolve(complete);
  }
}

/** Exact streamed call IDs associate a waiter with its response, never the latest active step. */
export class CcWriteGate {
  private readonly steps = new Set<WriteResponseStep>();

  begin(session: string, turn: string, signal?: AbortSignal): WriteResponseStep {
    const step = new WriteResponseStep(session, turn, signal);
    this.steps.add(step);
    return step;
  }

  find(session: string, call: string): WriteResponseStep | undefined {
    for (const step of this.steps) if (step.session === session && step.calls.has(call)) return step;
    return undefined;
  }

  cancel(session?: string, turn?: string): void {
    for (const step of this.steps) if ((session === undefined || step.session === session) &&
        (turn === undefined || step.turn === turn)) {
      step.finish(false);
      this.steps.delete(step);
    }
  }
}

/** A cancelled call must not cancel other calls sharing the response. */
export async function waitForWriteResponse(step: WriteResponseStep, signal: AbortSignal | undefined,
  sleep: (signal: AbortSignal) => Promise<void>): Promise<boolean> {
  if (signal?.aborted) return false;
  if (step.result !== undefined) return step.result;
  const timer = new AbortController();
  const cancelled = Promise.withResolvers<boolean>();
  const abort = () => cancelled.resolve(false);
  signal?.addEventListener("abort", abort, { once: true });
  try { return await Promise.race([step.ready, cancelled.promise, sleep(timer.signal).then(() => true)]); }
  finally {
    signal?.removeEventListener("abort", abort);
    timer.abort();
  }
}
