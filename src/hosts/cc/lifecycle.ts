import { existsSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Store } from "../../core/store/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { bindingPath, readBinding, updateBinding, validateNativeSessionId, type CcExecutorBinding, type CcHookInput,
  type CcSessionBinding } from "./binding.ts";
import { CcImporter, type CcPersistedCall, type CcReconcileResult } from "./importer.ts";
import { startControlServer, type CcControlServer } from "./control.ts";
import { classifySourceRecord, readCompleteTranscript, selectedNativePath } from "./transcript.ts";

export interface CcCloseResult {
  confirmed: boolean;
  reason: string;
  diagnostic?: string;
  reconcile?: CcReconcileResult;
}

export type CcDiagnostic = (message: string) => void;
export interface CcReadProjection { memory: CcImporter["memory"]; binding?: CcPersistedCall }
export interface CcToolProjection extends CcPersistedCall { memory: CcImporter["memory"] }
const wait = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds));

export interface CcSessionEndResult { confirmed: boolean; reason: string; diagnostic?: string }

const sameExecutor = (left: CcExecutorBinding | null, right: CcExecutorBinding): boolean => !!left &&
  left.executorId === right.executorId && left.pid === right.pid && left.token === right.token && left.socketPath === right.socketPath;
const executorLiveness = (executor: CcExecutorBinding): "alive" | "dead" | "unknown" => {
  try { process.kill(executor.pid, 0); return "alive"; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    return "unknown";
  }
};
const samePath = (left: readonly number[], right: readonly number[]): boolean =>
  left.length === right.length && left.every((id, index) => id === right[index]);

/** SessionEnd records native close metadata only. It validates but never imports the authoritative persisted projection. */
export async function recordCcSessionEnd(config: ResolvedCcHostConfig, input: CcHookInput): Promise<CcSessionEndResult> {
  if (input.hook_event_name !== "SessionEnd") throw new Error("expected a SessionEnd Hook input");
  const nativeSessionId = validateNativeSessionId(input.session_id), binding = readBinding(config, nativeSessionId);
  if (!binding) return { confirmed: false, reason: "native SessionEnd unconfirmed", diagnostic: "trusted binding is missing" };
  if (binding.dbPath !== config.dbPath || binding.transcriptPath !== input.transcript_path)
    throw new Error("SessionEnd disagrees with the trusted binding");
  const at = new Date().toISOString(), reason = `SessionEnd ${input.reason ?? "unknown"}`;
  const deadline = Date.now() + config.finalSyncTimeoutMs;
  const unconfirmed = async (diagnostic: string, expected?: CcExecutorBinding): Promise<CcSessionEndResult> => {
    try {
      await updateBinding(config, nativeSessionId, current => {
        if (!current || current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path)
          throw new Error("CC binding changed during SessionEnd");
        if (expected && !sameExecutor(current.executor, expected)) return current;
        return { ...current, lastClose: { at, reason, confirmed: false, diagnostic } };
      }, Math.max(1, deadline - Date.now()));
      return { confirmed: false, reason, diagnostic };
    } catch (error) {
      return { confirmed: false, reason, diagnostic: `${diagnostic}; close metadata write failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
  if (input.reason !== "prompt_input_exit")
    return unconfirmed(`native SessionEnd reason ${String(input.reason)} is not proven to be a normal close`);
  if (!binding.executor) {
    if (binding.lastClose?.confirmed && binding.coreSessionId !== null) {
      const store = new Store(config.dbPath);
      try {
        if (store.getSession(binding.coreSessionId)?.closedAt) return { confirmed: true, reason: binding.lastClose.reason };
      } finally { store.close(); }
    }
    return unconfirmed("normal SessionEnd has no named executor whose termination can be established");
  }
  const expected = binding.executor;
  let liveness = executorLiveness(expected);
  while (liveness === "alive" && Date.now() < deadline) {
    await wait(Math.min(100, config.pollIntervalMs, Math.max(1, deadline - Date.now())));
    liveness = executorLiveness(expected);
  }
  if (liveness !== "dead") return unconfirmed(liveness === "alive"
    ? "named executor remained alive through the SessionEnd close bound"
    : "named executor liveness could not be established", expected);
  const snapshot = readCompleteTranscript(input.transcript_path);
  if (!snapshot.exists || snapshot.problem || snapshot.incompleteBytes) return unconfirmed(!snapshot.exists
    ? "native transcript is unavailable at SessionEnd"
    : snapshot.problem ?? `native transcript retained ${snapshot.incompleteBytes} incomplete trailing bytes`, expected);
  const imported = readBinding(config, nativeSessionId);
  if (!imported || imported.dbPath !== config.dbPath || imported.transcriptPath !== input.transcript_path)
    return unconfirmed("CC binding changed during SessionEnd", expected);
  if (!sameExecutor(imported.executor, expected)) return unconfirmed("CC executor identity changed during SessionEnd close", expected);
  const selected = selectedNativePath(snapshot.records);
  if (selected.problem) return unconfirmed(`native persisted projection is invalid: ${selected.problem}`, expected);
  if (!selected.leafUuid || imported.selectedLeafUuid !== selected.leafUuid)
    return unconfirmed(!selected.leafUuid ? "native transcript has no complete eligible source"
      : "latest complete eligible native source has not already been imported as the selected projection", expected);
  const store = new Store(config.dbPath);
  try {
    if (imported.coreSessionId === null) return unconfirmed("CC binding has no allocated core session", expected);
    const selectedEntryIds = selected.records.flatMap(record => {
      const source = classifySourceRecord(record);
      if (!source || source.kind === "compaction") return [];
      const entry = store.findSourceEntry(imported.coreSessionId!, nativeSessionId, source.nativeId);
      return entry ? [entry.id] : [];
    });
    const expectedSources = selected.records.filter(record => {
      const source = classifySourceRecord(record); return source !== null && source.kind !== "compaction";
    }).length;
    const storedPath = store.selectedSourceEntryIds(imported.coreSessionId, imported.branch);
    if (selectedEntryIds.length !== expectedSources || storedPath === null || !samePath(storedPath, selectedEntryIds))
      return unconfirmed("latest complete eligible native source has not already been imported as the selected projection", expected);
    await updateBinding(config, nativeSessionId, current => {
      if (!current || current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path)
        throw new Error("CC binding changed during SessionEnd close");
      if (!sameExecutor(current.executor, expected)) throw new Error("CC executor identity changed during SessionEnd close");
      if (executorLiveness(expected) !== "dead") throw new Error("CC executor liveness changed during SessionEnd close");
      if (current.coreSessionId === null || current.selectedLeafUuid !== selected.leafUuid || current.branch !== imported.branch ||
          !samePath(store.selectedSourceEntryIds(current.coreSessionId, current.branch) ?? [], selectedEntryIds))
        throw new Error("CC selected projection changed during SessionEnd close");
      const session = store.getSession(current.coreSessionId);
      if (!session || session.host !== `cc:${nativeSessionId}`) throw new Error("bound core session identity changed during SessionEnd close");
      store.transaction(() => {
        store.releaseExecutor(expected.executorId);
        if (session.closedAt === null) store.closeSession(current.coreSessionId!);
      });
      return { ...current, executor: null, lastClose: { at: new Date().toISOString(), reason, confirmed: true } };
    }, Math.max(1, deadline - Date.now()));
    return { confirmed: true, reason };
  } catch (error) {
    const diagnostic = error instanceof Error ? error.message : String(error);
    return unconfirmed(diagnostic, expected);
  } finally { store.close(); }
}

export class CcCoordinator {
  private importer: CcImporter | null = null;
  private control: CcControlServer | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private transcriptWatcher: FSWatcher | null = null;
  private bindingWatcher: FSWatcher | null = null;
  private queue: Promise<CcReconcileResult | null> = Promise.resolve(null);
  private wakeQueued = false;
  private closing = false;
  private closed = false;
  private readonly startup = new AbortController();
  private readonly config: ResolvedCcHostConfig;
  readonly nativeSessionId: string;
  private readonly diagnostic: CcDiagnostic;

  constructor(config: ResolvedCcHostConfig, nativeSessionId: string,
    diagnostic: CcDiagnostic = message => console.error(`Trace Memory CC: ${message}`)) {
    validateNativeSessionId(nativeSessionId);
    this.config = config; this.nativeSessionId = nativeSessionId; this.diagnostic = diagnostic;
  }

  private observe(event: string, details: Record<string, unknown> = {}): void {
    this.diagnostic(`lifecycle ${JSON.stringify({ event, at: Date.now(), ...details })}`);
  }

  private async attach(final: boolean, deadline?: number): Promise<void> {
    if (this.importer || this.closed || this.closing && !final) return;
    const binding = readBinding(this.config, this.nativeSessionId);
    if (!binding) return;
    this.observe("attach-start", { final });
    this.importer = new CcImporter(this.config, binding);
    try {
      const timeout = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
      await startControlServer(this.config, binding, this.importer.memory, timeout, final ? undefined : this.startup.signal)
        .then(control => { this.control = control; });
    } catch (error) { this.importer.close(); this.importer = null; throw error; }
    this.watchTranscript(binding);
    if (final) this.importer.memory.cancelTasks(true);
    this.observe("attach-complete", { final });
  }

  private watchTranscript(binding: CcSessionBinding): void {
    if (this.transcriptWatcher || !existsSync(dirname(binding.transcriptPath))) return;
    const transcriptName = basename(binding.transcriptPath);
    this.transcriptWatcher = watch(dirname(binding.transcriptPath), (_event, filename) => {
      if (String(filename) === transcriptName) void this.requestReconcile("transcript watch");
    });
    this.transcriptWatcher.on("error", error => {
      this.diagnostic(`transcript watch failed: ${String(error)}; stat wake-up remains active`);
      this.transcriptWatcher?.close(); this.transcriptWatcher = null;
    });
  }

  async start(): Promise<void> {
    if (this.poll || this.closed || this.closing) return;
    this.observe("startup-begin");
    const bindingDirectory = dirname(bindingPath(this.config, this.nativeSessionId));
    if (existsSync(bindingDirectory)) {
      const bindingName = basename(bindingPath(this.config, this.nativeSessionId));
      this.bindingWatcher = watch(bindingDirectory, (_event, filename) => {
        if (String(filename) === bindingName) void this.requestReconcile("binding watch");
      });
      this.bindingWatcher.on("error", error => {
        this.diagnostic(`binding watch failed: ${String(error)}; stat wake-up remains active`);
        this.bindingWatcher?.close(); this.bindingWatcher = null;
      });
    }
    this.poll = setInterval(() => { void this.requestReconcile("stat wake-up"); }, this.config.pollIntervalMs);
    await this.requestReconcile("startup");
    this.observe("startup-complete");
  }

  requestReconcile(reason: string, final = false, deadline?: number): Promise<CcReconcileResult | null> {
    if (!final && this.wakeQueued) return this.queue;
    if (!final) this.wakeQueued = true;
    this.queue = this.queue.then(async () => {
      if (!final) this.wakeQueued = false;
      if (this.closed || this.closing && !final) return null;
      try {
        await this.attach(final, deadline);
        const result = await this.importer?.reconcile() ?? null;
        if (this.importer) this.watchTranscript(this.importer.currentBinding());
        if (reason !== "stat wake-up") this.observe("reconcile", { reason, final, state: result?.state ?? "unbound",
          coreSessionId: result?.coreSessionId ?? null, appended: result?.appendedEntryIds.length ?? 0 });
        if (result?.problems.length && reason !== "stat wake-up") this.diagnostic(`${reason}: ${result.problems.join("; ")}`);
        return result;
      } catch (error) {
        if ((error as { name?: string }).name === "AbortError") this.observe("startup-cancelled", { reason });
        else this.diagnostic(`${reason} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      }
    });
    return this.queue;
  }

  /** One non-waiting persisted projection for read tools. */
  async toolProjection(): Promise<CcReadProjection> {
    const result = await this.requestReconcile("foreground read");
    if (!this.importer) throw new Error("binding-not-ready: Claude Code session binding is unavailable");
    const triggerEntryId = result?.selectedEntryIds.at(-1);
    const binding = result?.coreSessionId && result.headTurnId && triggerEntryId
      ? { coreSessionId: result.coreSessionId, branch: result.branch, headTurnId: result.headTurnId, triggerEntryId, entryIds: result.selectedEntryIds }
      : undefined;
    return { memory: this.importer.memory, ...(binding ? { binding } : {}) };
  }

  /** Write tools alone wait for the exact host-authenticated native call. */
  async waitForToolCall(toolUseId: string, toolName: "note" | "memory", signal?: AbortSignal): Promise<CcToolProjection> {
    const deadline = Date.now() + this.config.writeSourceTimeoutMs;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (this.closing || this.closed) throw new Error("source-not-ready: Claude Code executor is shutting down");
      const result = await this.requestReconcile("foreground write binding");
      if (result?.state === "disabled" && result.coreSessionId !== null)
        throw new Error("Trace Memory is Disabled; use the operator command to enable memory");
      const call = this.importer?.persistedCall(toolUseId, toolName);
      if (call) return { memory: this.importer!.memory, ...call };
      await wait(Math.min(20, this.config.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    signal?.throwIfAborted();
    throw new Error(`source-not-ready: exact current call ${toolUseId} was not persisted within ${this.config.writeSourceTimeoutMs} ms; retry this write`);
  }

  private stopWakeups(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = null;
    this.bindingWatcher?.close(); this.bindingWatcher = null;
    this.transcriptWatcher?.close(); this.transcriptWatcher = null;
  }

  private async finalReconcile(): Promise<CcCloseResult> {
    const deadline = Date.now() + this.config.finalSyncTimeoutMs;
    let stable = 0, signature: string | null = null, latest: CcReconcileResult | null = null;
    while (Date.now() < deadline) {
      latest = await this.requestReconcile("final sync", true, deadline);
      if (latest?.state === "disabled") return { confirmed: false,
        reason: "source reconciliation completed without normal producer termination",
        diagnostic: "transport or process shutdown is not proof of a normal native session close", reconcile: latest };
      let next: string | null = null;
      if (latest?.state === "ready" && latest.snapshot.exists && latest.snapshot.incompleteBytes === 0 && !latest.snapshot.problem)
        next = JSON.stringify([latest.snapshot.device, latest.snapshot.inode, latest.snapshot.size, latest.snapshot.modifiedMs,
          latest.snapshot.completeBytes, latest.snapshot.recordCount,
          latest.selectedEntryIds, latest.branch, latest.headTurnId]);
      stable = next !== null && next === signature ? stable + 1 : next === null ? 0 : 1;
      signature = next;
      if (stable >= this.config.finalSyncStablePolls && latest) return { confirmed: false,
        reason: "source reconciliation completed without normal producer termination",
        diagnostic: "a stable snapshot after transport or process shutdown does not prove a normal native session close", reconcile: latest };
      await wait(Math.min(100, this.config.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
    const diagnostic = !latest || latest.state === "unavailable" ? "binding or transcript remained unavailable"
      : latest.snapshot.incompleteBytes ? `transcript retained ${latest.snapshot.incompleteBytes} incomplete trailing bytes`
      : latest.problems.length ? latest.problems.join("; ") : "completed projection did not remain stable before the configured deadline";
    return { confirmed: false, reason: "final reconciliation unconfirmed", diagnostic, ...(latest ? { reconcile: latest } : {}) };
  }

  async shutdown(reason: string): Promise<CcCloseResult> {
    if (this.closed) return { confirmed: false, reason: "coordinator already closed", diagnostic: "duplicate shutdown" };
    if (this.closing) return { confirmed: false, reason: "coordinator shutdown already in progress" };
    this.closing = true; this.stopWakeups(); this.startup.abort(new DOMException("Lifecycle shutdown", "AbortError"));
    this.observe("shutdown-begin", { reason });
    let result: CcCloseResult = { confirmed: false, reason: "no bound importer", diagnostic: "binding was never established" };
    try {
      await this.queue;
      this.importer?.memory.cancelTasks(true);
      result = await this.finalReconcile();
      if (this.importer) {
        this.importer.memory.forceTasks();
        this.importer.memory.store.releaseExecutor(this.importer.memory.executorId);
      }
      // MCP teardown is never close authority. Preserve the named executor so the
      // trusted SessionEnd Hook can verify that exact owner after process death.
      if (this.control) await this.control.close(true);
      if (readBinding(this.config, this.nativeSessionId)) await updateBinding(this.config, this.nativeSessionId, binding => {
        if (!binding) throw new Error("CC binding disappeared during shutdown");
        return { ...binding, lastClose: { at: new Date().toISOString(), reason, confirmed: result.confirmed,
          ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) } };
      });
      if (!result.confirmed) this.diagnostic(`close not confirmed: ${result.diagnostic ?? result.reason}`);
      this.observe("shutdown-complete", { reason, confirmed: result.confirmed });
      return result;
    } finally {
      this.stopWakeups();
      this.closed = true; this.closing = false;
      this.importer?.close(); this.importer = null; this.control = null;
    }
  }
}
