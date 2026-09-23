import { mkdirSync, rmSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { TraceMemory } from "../../core/api/index.ts";
import type { CcCatchupStatus } from "./scheduler.ts";
import { Store } from "../../core/store/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { assertOperatorBinding, readBinding, updateBinding, updateBindingInStoreTransaction, type CcExecutorBinding, type CcSessionBinding } from "./binding.ts";

export type ControlVerb = "stop" | "off" | "catchup";
export interface CancellationControlReply {
  ok: true;
  verb: "stop" | "off";
  abortRequested: { sessionId: number; phase: string; executionId: string }[];
  /** Abort/fencing is acknowledged; worker termination is observed separately by its owner. */
  termination: "pending-observation";
}
export interface CatchupControlReply {
  ok: true;
  verb: "catchup";
  catchup: CcCatchupStatus;
  /** Catchup starts no cancellation; retained so existing reply consumers can inspect one stable field. */
  abortRequested: [];
}
export type ControlReply = CancellationControlReply | CatchupControlReply;
export interface CcControlHandlers {
  catchup(): Promise<CcCatchupStatus>;
  /** Must mark the finite drain stopped before core cancellation can settle a worker. */
  beforeCancel(): void;
  /** 70: abort a scan currently running under the binding lock, before `off` waits for that same
   * lock through `disableEnrollment` below. Never called for `stop`. */
  abortImport(): void;
}

export interface CcControlServer {
  executor: CcExecutorBinding;
  close(preserveExecutor?: boolean): Promise<void>;
  /** 63: serve another native session of the same core session — the executor record moves from the
   * current binding to `next`, and control requests are checked against `next` from then on. */
  retarget(next: CcSessionBinding): Promise<void>;
}

const socketPath = (config: ResolvedCcHostConfig, token: string): string => {
  // Each contender owns a distinct socket. A losing attach can therefore clean up only
  // its own unpublished endpoint and can never unlink the durable winner's endpoint.
  const value = join(config.stateDir, "control", `${token.replaceAll("-", "").slice(0, 12)}.sock`);
  if (Buffer.byteLength(value) > 100) throw new Error("CC control socket path exceeds the supported Unix-domain path length; configure a shorter stateDir");
  return value;
};
const executorLiveness = (executor: CcExecutorBinding): "alive" | "dead" | "unknown" => {
  try { process.kill(executor.pid, 0); return "alive"; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    return "unknown";
  }
};

type DisableResult = { state: "disabled"; changed: boolean } | { state: "live-executor"; executor: CcExecutorBinding } |
  { state: "unknown-executor"; executor: CcExecutorBinding };

async function disableEnrollment(config: ResolvedCcHostConfig, nativeSessionId: string, store: Store,
  expectedToken: string | null): Promise<DisableResult> {
  let result: DisableResult = { state: "disabled", changed: false };
  await updateBindingInStoreTransaction(config, nativeSessionId, store, current => {
    if (!current) throw new Error("CC binding disappeared during off");
    assertOperatorBinding(config, current, store);
    if (expectedToken === null && current.executor) {
      const liveness = executorLiveness(current.executor);
      if (liveness !== "dead") {
        result = { state: liveness === "alive" ? "live-executor" : "unknown-executor", executor: current.executor };
        return current;
      }
    } else if (expectedToken !== null && current.executor?.token !== expectedToken) {
      throw new Error("CC executor binding changed during off");
    }
    if (current.coreSessionId !== null) {
      store.setEnrollment(current.coreSessionId, false);
      result = { state: "disabled", changed: current.enrollment.choice !== false };
      return { ...current, enrollment: store.enrollment(current.coreSessionId) };
    }
    result = { state: "disabled", changed: current.enrollment.choice !== false };
    return current.enrollment.choice === false ? current
      : { ...current, enrollment: { ...current.enrollment, choice: false } };
  });
  return result;
}

const closeServer = (server: ReturnType<typeof createServer>): Promise<void> => new Promise(resolve => {
  if (!server.listening) { resolve(); return; }
  server.close(() => resolve());
});

export async function startControlServer(config: ResolvedCcHostConfig, initial: CcSessionBinding, memory: TraceMemory,
  bindingTimeoutMs?: number, signal?: AbortSignal, handlers?: CcControlHandlers): Promise<CcControlServer> {
  let binding = initial; // 63: re-pointed by `retarget`
  const token = randomUUID(), path = socketPath(config, token);
  const executor: CcExecutorBinding = { executorId: memory.executorId, pid: process.pid, token, socketPath: path, startedAt: new Date().toISOString() };
  mkdirSync(dirname(path), { recursive: true });
  const server = createServer(connection => {
    let input = "", handled = false;
    connection.setEncoding("utf8");
    connection.on("error", error => console.error(`Trace Memory CC: control connection failed: ${String(error)}`));
    connection.on("data", chunk => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > 16_384) { handled = true; connection.destroy(new Error("CC control request is too large")); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      void (async () => {
        try {
          const request = JSON.parse(input.slice(0, newline)) as { verb?: unknown; token?: unknown };
          if (request.token !== token || typeof request.verb !== "string" ||
              (request.verb !== "stop" && request.verb !== "off" && request.verb !== "catchup"))
            throw new Error("invalid CC control request");
          const current = readBinding(config, binding.nativeSessionId);
          if (!current) throw new Error("CC binding disappeared before control");
          assertOperatorBinding(config, current, memory.store);
          // The control server is attached before the first reconciliation, so its starting
          // binding may legitimately be provisional. Once allocated, the authoritative host,
          // project and database checks above plus the executor token fence the same target.
          if ((binding.coreSessionId !== null && current.coreSessionId !== binding.coreSessionId) ||
              current.executor?.token !== token)
            throw new Error("CC core or executor identity changed before control");
          const verb = request.verb as ControlVerb;
          if (verb === "catchup") {
            if (!handlers) throw new Error("catchup is unavailable on this executor");
            const reply: CatchupControlReply = { ok: true, verb, catchup: await handlers.catchup(), abortRequested: [] };
            connection.end(`${JSON.stringify(reply)}\n`); return;
          }
          handlers?.beforeCancel();
          const aborted = memory.cancelTasks(false);
          if (verb === "off") {
            // Intent reaches the scan before the lock does: abort a running import now, so it
            // releases the binding lock at its next cooperative resume instead of making this
            // request wait behind the whole (possibly multi-second) scan.
            handlers?.abortImport();
            await disableEnrollment(config, binding.nativeSessionId, memory.store, token);
            // Binding-lock contention can leave a window between the first fence and durable disable.
            // Fence once more before acknowledgement so work admitted in that window cannot survive off.
            handlers?.beforeCancel();
            for (const task of memory.cancelTasks(false))
              if (!aborted.some(previous => previous.executionId === task.executionId)) aborted.push(task);
          }
          const reply: CancellationControlReply = { ok: true, verb, abortRequested: aborted, termination: "pending-observation" };
          connection.end(`${JSON.stringify(reply)}\n`);
        } catch (error) { connection.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); }
      })();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(path, resolve); });
    await updateBinding(config, binding.nativeSessionId, current => {
      if (!current) throw new Error("CC binding disappeared before executor attach");
      if (current.transcriptPath !== binding.transcriptPath) throw new Error("CC binding changed before executor attach");
      if (current.executor) {
        const liveness = executorLiveness(current.executor);
        if (liveness === "alive") throw new Error(`CC session already has a live executor process ${current.executor.pid}`);
        if (liveness === "unknown") throw new Error(`cannot establish liveness of CC executor process ${current.executor.pid}`);
      }
      return { ...current, executor };
    }, bindingTimeoutMs, signal);
  } catch (error) {
    try { await closeServer(server); }
    catch (cleanup) { console.error(`Trace Memory CC: failed attach socket close: ${String(cleanup)}`); }
    try { rmSync(path, { force: true }); }
    catch (cleanup) { console.error(`Trace Memory CC: failed attach socket removal: ${String(cleanup)}`); }
    throw error;
  }
  const attachTo = (target: CcSessionBinding) => updateBinding(config, target.nativeSessionId, current => {
    if (!current) throw new Error("CC binding disappeared before executor attach");
    if (current.transcriptPath !== target.transcriptPath) throw new Error("CC binding changed before executor attach");
    if (current.executor && current.executor.token !== token) {
      const liveness = executorLiveness(current.executor);
      if (liveness === "alive") throw new Error(`CC session already has a live executor process ${current.executor.pid}`);
      if (liveness === "unknown") throw new Error(`cannot establish liveness of CC executor process ${current.executor.pid}`);
    }
    return { ...current, executor };
  }, bindingTimeoutMs);
  const release = (target: CcSessionBinding) => updateBinding(config, target.nativeSessionId,
    current => !current || current.executor?.token !== token ? current! : { ...current, executor: null });
  return { executor, close: async (preserveExecutor = false) => {
    try { await closeServer(server); }
    finally {
      try { rmSync(path, { force: true }); }
      finally { if (!preserveExecutor) await release(binding); }
    }
  }, retarget: async next => {
    // The binding captured at attach may predate enrollment (a provisional parent turned on later);
    // compare against what the Hook persisted since, not the stale in-memory copy.
    const current = readBinding(config, binding.nativeSessionId) ?? binding;
    if (next.coreSessionId === null || next.coreSessionId !== current.coreSessionId) throw new Error("CC control retarget must stay on the same core session");
    await attachTo(next);
    const previous = binding; binding = next;
    await release(previous);
  } };
}

function request(executor: CcExecutorBinding, verb: ControlVerb, timeoutMs: number): Promise<ControlReply> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(executor.socketPath); let output = "", settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(timer); connection.destroy(); error ? reject(error) : undefined; };
    const timer = setTimeout(() => finish(new Error(`CC executor did not acknowledge ${verb} within ${timeoutMs} ms`)), timeoutMs);
    connection.setEncoding("utf8");
    connection.on("connect", () => connection.write(`${JSON.stringify({ verb, token: executor.token })}\n`));
    connection.on("data", chunk => output += chunk);
    connection.on("end", () => {
      try {
        const reply = JSON.parse(output);
        if (!reply.ok) throw new Error(reply.error ?? "CC executor rejected control request");
        settled = true; clearTimeout(timer); resolve(reply);
      } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
    });
    connection.on("error", error => finish(error));
  });
}

export type OperatorControlResult =
  | { state: "acknowledged"; reply: ControlReply }
  | { state: "not-running"; enrollmentChanged: boolean }
  | { state: "unavailable"; diagnostic: string }
  | { state: "unknown"; diagnostic: string };

async function validatedOperatorBinding(config: ResolvedCcHostConfig, nativeSessionId: string): Promise<CcSessionBinding> {
  const store = new Store(config.dbPath);
  try {
    return await updateBinding(config, nativeSessionId, current => {
      if (!current) throw new Error(`Claude Code session ${nativeSessionId} is not bound`);
      assertOperatorBinding(config, current, store);
      return current;
    });
  } finally { store.close(); }
}

/** Trusted operator boundary used by 43e's future CLI; it never accepts identity from an MCP tool. */
export async function controlSession(config: ResolvedCcHostConfig, nativeSessionId: string, verb: ControlVerb,
  timeoutMs = 2_000): Promise<OperatorControlResult> {
  const binding = await validatedOperatorBinding(config, nativeSessionId);
  let executor = binding.executor;
  if (!executor || executorLiveness(executor) === "dead") {
    if (verb === "stop") return { state: "not-running", enrollmentChanged: false };
    if (verb === "catchup") return { state: "unavailable", diagnostic: "CC catchup requires the session's live executor" };
    const store = new Store(config.dbPath);
    try {
      const disabled = await disableEnrollment(config, nativeSessionId, store, null);
      if (disabled.state === "disabled") return { state: "not-running", enrollmentChanged: disabled.changed };
      if (disabled.state === "unknown-executor")
        return { state: "unknown", diagnostic: `cannot establish executor liveness for process ${disabled.executor.pid}` };
      executor = disabled.executor;
    } finally { store.close(); }
  }
  const liveness = executorLiveness(executor);
  if (liveness === "unknown") return { state: "unknown", diagnostic: `cannot establish executor liveness for process ${executor.pid}` };
  if (liveness === "dead") {
    if (verb === "stop") return { state: "not-running", enrollmentChanged: false };
    if (verb === "catchup") return { state: "unavailable", diagnostic: "CC catchup requires the session's live executor" };
    const store = new Store(config.dbPath);
    try {
      const disabled = await disableEnrollment(config, nativeSessionId, store, null);
      return disabled.state === "disabled" ? { state: "not-running", enrollmentChanged: disabled.changed }
        : { state: "unknown", diagnostic: "CC executor ownership changed repeatedly during off" };
    } finally { store.close(); }
  }
  const finalBinding = await validatedOperatorBinding(config, nativeSessionId);
  if (finalBinding.executor?.token !== executor.token)
    throw new Error(`CC executor binding changed before ${verb}`);
  try { return { state: "acknowledged", reply: await request(executor, verb, timeoutMs) }; }
  catch (error) { return { state: "unknown", diagnostic: `executor is live but ${verb} communication failed: ${String(error)}` }; }
}
