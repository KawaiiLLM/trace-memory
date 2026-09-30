import { existsSync, readdirSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname } from "node:path";
import { Store } from "../../core/store/index.ts";
import { deliveredView, selectNotingMode, type NotingAgentInput, type RunAgentResult, type TaskTarget, type VisibleView } from "../../core/api/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { activeFunctionHook, bindingPath, coreHostOf, readBinding, sessionEnabled, updateBinding, updateBindingInStoreTransaction, validateNativeSessionId, type CcHookInput,
  type CcSessionBinding } from "./binding.ts";
import { CcImporter, type CcImportInstrumentation, type CcPersistedCall, type CcReconcileResult } from "./importer.ts";
import type { CcOriginalCandidate } from "./coverage-original.ts";
import { classifySourceRecord } from "./transcript.ts";
import type { CcWorkerJournal } from "./worker.ts";
import { startControlServer, type CcControlServer, type CcForkObservation } from "./control.ts";
import { CC_CONTEXT_HEADROOM } from "./config.ts";
import { ccDeliveryHead } from "./injection.ts";
import { assignedNativeSession, currentNativeProcess, nativeSessionRecords, processStartedAt } from "./native-session.ts";
import { CcTaskScheduler, type CcCatchupStatus } from "./scheduler.ts";
import { CcForkAuthority } from "./fork-authority.ts";
import { readCcStatus, removeCcStatus, writeCcStatus, type CcStatusFile } from "./status.ts";

/** Claude Code's `turn.complete` reasons, for the main turn and a fork alike. */
const CC_TURN_END_REASONS: readonly string[] = ["answer", "aborted", "refusal", "error"];

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
/** Ticket 75: local midnight of the host's clock, the same cutoff Pi's footer uses for `spendSince` (51). */
const localMidnight = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

export interface CcSessionEndResult { confirmed: boolean; reason: string; diagnostic?: string }

const processLiveness = (identity: { pid: number }): "alive" | "dead" | "unknown" => {
  try { process.kill(identity.pid, 0); return "alive"; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return "dead";
    return "unknown";
  }
};

/** Every other native lineage of this core session. Unknown identity must not masquerade as an
 * ended sibling: that would make an active session borrowable. */
function hasLiveSibling(config: ResolvedCcHostConfig, coreSessionId: number, excludeNativeSessionId: string): boolean {
  for (const file of readdirSync(dirname(bindingPath(config, excludeNativeSessionId)))) {
    if (!file.endsWith(".json")) continue;
    const nativeSessionId = file.slice(0, -".json".length);
    if (nativeSessionId === excludeNativeSessionId) continue;
    const sibling = readBinding(config, nativeSessionId);
    if (!sibling || sibling.coreSessionId !== coreSessionId || sibling.lastClose?.confirmed) continue;
    const native = sibling.nativeProcess;
    if (!native) {
      // Pre-86 bindings lack nativeProcess. Only a matching live assignment keeps them open.
      for (const record of nativeSessionRecords(config)) {
        if (record.nativeSessionId !== nativeSessionId) continue;
        const liveness = processLiveness(record);
        if (liveness === "dead") continue;
        if (liveness === "unknown") throw new Error(`CC sibling ${nativeSessionId} native process liveness is unknown`);
        const startedAt = processStartedAt(record.pid);
        if (record.startedAt === null || startedAt === null)
          throw new Error(`CC sibling ${nativeSessionId} native process identity is unavailable`);
        if (startedAt === record.startedAt) return true;
      }
      continue;
    }
    const liveness = processLiveness(native);
    if (liveness === "dead") continue;
    if (liveness === "unknown") throw new Error(`CC sibling ${nativeSessionId} native process liveness is unknown`);
    const startedAt = processStartedAt(native.pid);
    if (startedAt === null) throw new Error(`CC sibling ${nativeSessionId} native process identity is unavailable`);
    if (startedAt !== native.startedAt) continue; // PID reused after the bound native process ended.
    const assigned = assignedNativeSession(config, [{ pid: native.pid, startedAt }]);
    if (!assigned) throw new Error(`CC sibling ${nativeSessionId} has no native session assignment`);
    // The process has moved on to another native session (/clear, /resume): this one is not live.
    if (assigned.nativeSessionId !== nativeSessionId) continue;
    if (assigned.transcriptPath !== sibling.transcriptPath)
      throw new Error(`CC sibling ${nativeSessionId} disagrees with its native session assignment`);
    return true;
  }
  return false;
}

/** A native SessionEnd closes its bound lineage, whatever its reason: `/clear` ends the session like
 * an exit (102). It never imports or waits for the executor. */
export async function recordCcSessionEnd(config: ResolvedCcHostConfig, input: CcHookInput): Promise<CcSessionEndResult> {
  if (input.hook_event_name !== "SessionEnd") throw new Error("expected a SessionEnd Hook input");
  const nativeSessionId = validateNativeSessionId(input.session_id), binding = readBinding(config, nativeSessionId);
  const reason = `SessionEnd ${input.reason ?? "unknown"}`;
  if (!binding) return { confirmed: false, reason, diagnostic: "trusted binding is missing" };
  if (binding.dbPath !== config.dbPath || binding.transcriptPath !== input.transcript_path)
    throw new Error("SessionEnd disagrees with the trusted binding");
  const nativeProcess = currentNativeProcess();
  if (!nativeProcess || !binding.nativeProcess)
    return { confirmed: false, reason, diagnostic: "SessionEnd native process identity is unavailable; a matching SessionStart is required" };
  const matchesNative = (current: CcSessionBinding) => current.nativeProcess?.pid === nativeProcess.pid &&
    current.nativeProcess.startedAt === nativeProcess.startedAt;
  if (!matchesNative(binding)) return { confirmed: false, reason, diagnostic: "SessionEnd belongs to an earlier native process" };
  const store = binding.coreSessionId === null ? null : new Store(config.dbPath);
  try {
    const close = (current: CcSessionBinding | null): CcSessionBinding => {
      if (!current || current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path ||
          current.coreSessionId !== binding.coreSessionId || !matchesNative(current))
        throw new Error("CC binding changed during SessionEnd close");
      if (store && current.coreSessionId !== null) {
        const session = store.getSession(current.coreSessionId);
        if (!session || session.host !== coreHostOf(current)) throw new Error("bound core session identity changed during SessionEnd close");
        // A live native sibling keeps the core open even before its MCP executor attaches.
        const liveSibling = hasLiveSibling(config, current.coreSessionId, nativeSessionId);
        if (current.executor) store.releaseExecutor(current.executor.executorId);
        if (session.closedAt === null && !liveSibling) store.closeSession(current.coreSessionId);
      }
      return { ...current, executor: null, lastClose: { at: new Date().toISOString(), reason, confirmed: true } };
    };
    if (store) await updateBindingInStoreTransaction(config, nativeSessionId, store, close, config.finalSyncTimeoutMs);
    else await updateBinding(config, nativeSessionId, close, config.finalSyncTimeoutMs);
    return { confirmed: true, reason };
  } catch (error) {
    return { confirmed: false, reason, diagnostic: error instanceof Error ? error.message : String(error) };
  } finally { store?.close(); }
}

export class CcCoordinator {
  private readonly forkAuthority = new CcForkAuthority(agentId => this.control?.stopFork(agentId));
  private forkLaunch: { turnId: string; resolve: (directive: { prompt: string; turnId: string } | null) => void; signal: AbortSignal } | null = null;
  private activeForkTurnId: string | null = null;
  private importer: CcImporter | null = null;
  private scheduler: CcTaskScheduler | null = null;
  private control: CcControlServer | null = null;
  private poll: ReturnType<typeof setInterval> | null = null;
  private transcriptWatcher: FSWatcher | null = null;
  private bindingWatcher: FSWatcher | null = null;
  private queue: Promise<CcReconcileResult | null> = Promise.resolve(null);
  private wakeQueued = false;
  private closing = false;
  private closed = false;
  private startupComplete = false;
  private readonly startup = new AbortController();
  /** 70: the reconcile currently running under the binding lock, if any. `off`, a selected-path
   * retarget and executor shutdown abort it before they wait for the lock themselves (off through
   * `disableEnrollment`, retarget and shutdown through this queue); `stop` never touches it. */
  private currentImportAbort: AbortController | null = null;
  /** 70: outstanding preemption holds. While positive, a non-final reconcile that starts (including
   * one already queued behind the one `abortCurrentImport` just aborted) returns without scanning,
   * instead of racing the preempting operation for the binding lock. `final` reconciles (shutdown's
   * own `finalReconcile`) are exempt — a hold never blocks the operation that is holding it. */
  private importHolds = 0;
  private readonly config: ResolvedCcHostConfig;
  private appliedConfig: ResolvedCcHostConfig;
  /** 65: the Hook's id once adopted; the env id only until then. Fixed from the first attach on. */
  nativeSessionId: string;
  private readonly diagnostic: CcDiagnostic;
  /** Test-only override of the cooperative-scan slice/pause constants; unset in production. */
  private readonly importTuning?: CcImportInstrumentation;
  /** 78: the executor's runtime journal, handed to every worker this coordinator creates, for the
   * one worker event with no home in the run record (a contained SDK control abort). */
  private readonly journal: CcWorkerJournal;
  /** Ticket 75: the most recent reconciled projection, read by `publish` for the counts' target path.
   * `null` before any successful reconcile — counts render as `?`, never as `0`. */
  private lastReconcile: CcReconcileResult | null = null;
  /** Ticket 75: the last published (path, state) key, so a no-op stat-wake-up reconcile writes
   * nothing — publishing is a lifecycle event, never a timer. */
  private lastStatusKey: string | null = null;
  /** Native live turns only. No historical terminal is replayed on attach or restart. */
  private readonly completedTurns = new Set<string>();
  private readonly completedTerminals = new Set<string>();
  private readonly completedHookAnchors = new Set<number>();
  /** 102: the retargets in order, each after the last; shutdown waits for the one in flight. */
  private following: Promise<boolean> = Promise.resolve(true);

  constructor(config: ResolvedCcHostConfig, nativeSessionId: string,
    diagnostic: CcDiagnostic = message => console.error(`Trace Memory CC: ${message}`), importTuning?: CcImportInstrumentation,
    journal: CcWorkerJournal = () => {}) {
    validateNativeSessionId(nativeSessionId);
    this.config = config; this.appliedConfig = config; this.nativeSessionId = nativeSessionId; this.diagnostic = diagnostic;
    this.importTuning = importTuning; this.journal = journal;
  }

  private observe(event: string, details: Record<string, unknown> = {}): void {
    this.diagnostic(`lifecycle ${JSON.stringify({ event, at: Date.now(), ...details })}`);
  }

  /** The scan observes this at its next cooperative resume: it stops with stamp and offset
   * unadvanced and releases the binding lock; the aborting operation then persists and acknowledges
   * as today. A no-op when no reconcile is currently running. */
  private abortCurrentImport(): void {
    this.currentImportAbort?.abort(new DOMException("CC import aborted for a higher-priority control operation", "AbortError"));
  }

  /** 70: begin a preemption hold and abort whatever is currently running. Until the returned release
   * is called, no non-final reconcile scans — including one already queued behind the aborted run,
   * which would otherwise start the instant it settles and win the lock before this operation does.
   * Safe to call release more than once. */
  private holdImport(): () => void {
    this.importHolds++;
    this.abortCurrentImport();
    let released = false;
    return () => { if (released) return; released = true; this.importHolds = Math.max(0, this.importHolds - 1); };
  }

  /** Ticket 75: publish this executor's status file, or do nothing. Every failure mode — a stale
   * binding, a `progress`/`spendSince` read that throws, a write that throws — is caught here and
   * turned into a diagnostic at worst; publishing never affects memory work, never delays a control
   * acknowledgement and never interrupts shutdown cleanup (Pi review). Ownership is re-checked against
   * the binding on every call, not cached: a late call from a superseded executor sees a binding that
   * no longer names it and writes nothing. */
  private publish(reason: string): void {
    if (this.closed) return;
    try {
      const binding = readBinding(this.config, this.nativeSessionId);
      if (!binding?.executor || !this.control || binding.executor.token !== this.control.executor.token) return;
      // The same rule injection uses: the Store's enrollment once a core session exists, so an
      // automatic off is published as off. Without an open Store there is nothing true to publish.
      if (binding.coreSessionId !== null && !this.importer) return;
      const enabled = sessionEnabled(binding, this.importer?.memory.store ?? { enabled: () => false });
      const running = new Set(this.scheduler?.running() ?? []);
      let counts: CcStatusFile["counts"], cost: number | undefined;
      const reconcile = this.lastReconcile;
      // Off counts nothing (24a, as Pi's footer): no path, Raw or run reads for a line that shows `○ off`.
      if (enabled && this.importer && reconcile && reconcile.coreSessionId !== null) {
        try { counts = this.importer.memory.progress(reconcile.coreSessionId, reconcile.branch, reconcile.headTurnId ?? null); }
        catch (error) { this.diagnostic(`status counts unavailable (${reason}): ${error instanceof Error ? error.message : String(error)}`); }
      }
      if (enabled && this.importer) {
        try { cost = this.importer.memory.spendSince(localMidnight()); }
        catch (error) { this.diagnostic(`status cost unavailable (${reason}): ${error instanceof Error ? error.message : String(error)}`); }
      }
      const status: CcStatusFile = { version: 1, nativeSessionId: this.nativeSessionId, executorId: binding.executor.executorId,
        pid: binding.executor.pid, token: binding.executor.token, updatedAt: new Date().toISOString(), enabled,
        running: { noting: running.has("noting"), dreaming: running.has("dreaming") },
        ...(counts ? { counts } : {}), ...(cost !== undefined ? { cost } : {}) };
      writeCcStatus(this.config.stateDir, status);
    } catch (error) { this.diagnostic(`status publish failed (${reason}): ${error instanceof Error ? error.message : String(error)}`); }
  }

  private async attach(final: boolean, deadline?: number): Promise<void> {
    if (this.importer || this.closed || this.closing && !final) return;
    const binding = readBinding(this.config, this.nativeSessionId);
    if (!binding || binding.lastClose?.confirmed) return;
    this.observe("attach-start", { final });
    try {
      this.importer = new CcImporter(this.appliedConfig, binding, { journal: this.journal });
      // Ticket 75: task admission and settlement are their own publish points, independent of reconcile.
      this.importer.setForkRunner(task => this.runFork(task));
      this.scheduler = new CcTaskScheduler(this.importer.memory, this.appliedConfig.worker, this.diagnostic, reason => this.publish(reason));
      const timeout = deadline === undefined ? undefined : Math.max(1, deadline - Date.now());
      await startControlServer(this.config, binding, this.importer.memory, timeout, final ? undefined : this.startup.signal, {
        catchup: async () => {
          const scheduler = this.scheduler;
          if (!scheduler) return { state: "failed", entriesDone: 0, entriesTotal: 0, factsDone: 0, factsTotal: 0,
            diagnostic: "CC executor scheduler is unavailable" };
          const active = scheduler.activeCatchup();
          if (active) return active;
          const ticket = scheduler.catchupTicket(), starting = scheduler.beginCatchup();
          void (async () => {
            let result: CcCatchupStatus;
            try {
              const projection = await this.requestReconcile("manual catchup");
              result = projection ? scheduler.startCatchup(projection, ticket)
                : { state: "failed", entriesDone: 0, entriesTotal: 0,
                  diagnostic: "authoritative transcript reconciliation is unavailable" };
            } catch (error) {
              result = { state: "failed", entriesDone: 0, entriesTotal: 0,
                diagnostic: error instanceof Error ? error.message : String(error) };
            }
            scheduler.endCatchup(result);
          })();
          return starting;
        },
        turnEnd: (turnId, reason, signal, observation) => this.turnEnd(turnId, reason, signal, observation),
        forkSources: (turnId, signal) => this.forkSources(turnId, signal),
        forkNoStart: (turnId, reason, confirmed) => {
          if (!this.activeForkTurnId || turnId !== this.activeForkTurnId) throw new Error("CC fork no-start belongs to another turn");
          this.forkAuthority.noStart(reason, confirmed); this.activeForkTurnId = null;
        },
        forkRegister: (turnId, agentId) => {
          if (!this.activeForkTurnId || turnId !== this.activeForkTurnId) throw new Error("CC fork registration belongs to another turn");
          this.forkAuthority.register(agentId);
        },
        forkDisconnected: agentId => {
          if (this.forkAuthority.cancelAgent(agentId)) {
            this.activeForkTurnId = null;
            this.diagnostic(`native fork ${agentId} lost its physical-stop listener; writes fenced, physical termination unconfirmed`);
          }
        },
        forkCall: (agentId, callId, name) => this.forkAuthority.call(agentId, callId, name),
        forkCheck: (callId, name) => this.forkAuthority.allows(callId, name),
        forkTerminal: async (agentId, reason, answer) => {
          if (!CC_TURN_END_REASONS.includes(reason)) throw new Error(`unsupported CC fork completion reason ${reason}`);
          const settled = await this.forkAuthority.complete(agentId, { outcome: reason === "answer" ? "success" : reason === "aborted" ? "cancelled" : "failure",
            output: answer, mode: "fork", audit: { available: false, reason: "CC native fork does not expose the exact provider request body" } });
          if (settled) this.activeForkTurnId = null;
          return settled;
        },
        beforeCancel: () => { this.forkAuthority.cancel(); this.activeForkTurnId = null; this.scheduler?.stopCatchup(); },
        holdImport: () => this.holdImport(),
        effectiveConfig: () => this.appliedConfig,
        catchupSnapshot: () => this.scheduler?.catchupSnapshot() ?? null,
        applyConfig: next => {
          if (!this.importer || !this.scheduler) throw new Error("CC executor is not attached for settings apply");
          const prior = this.appliedConfig;
          const nonLive = (value: ResolvedCcHostConfig): Record<string, unknown> => {
            const fields: Record<string, unknown> = {
              dbPath: value.dbPath, stateDir: value.stateDir, baseline: value.baseline, retry: value.retry,
              pollIntervalMs: value.pollIntervalMs, finalSyncTimeoutMs: value.finalSyncTimeoutMs,
              finalSyncStablePolls: value.finalSyncStablePolls, writeSourceTimeoutMs: value.writeSourceTimeoutMs,
              "worker.claudeExecutable": value.worker?.claudeExecutable,
              "worker.cwd": value.worker?.cwd,
              "worker.responseOriginTimeoutMs": value.worker?.responseOriginTimeoutMs,
            };
            for (const [section, settings] of Object.entries(value.coreConfig)) {
              if (section === "closedSessionScope") continue;
              if (settings && typeof settings === "object") for (const [field, current] of Object.entries(settings)) {
                if (section === "noting" && field === "forkModeDefault") continue;
                fields[`${section}.${field}`] = current;
              }
              else fields[section] = settings;
            }
            return fields;
          };
          const existingFields = nonLive(prior), nextFields = nonLive(next);
          for (const key of Object.keys(existingFields))
            if (JSON.stringify(existingFields[key]) !== JSON.stringify(nextFields[key]))
              throw new Error(`CC executor cannot hot-apply ${key}; saved file is not applied`);
          for (const [model, capacity] of Object.entries(prior.worker?.contextWindows ?? {}))
            if (next.worker?.contextWindows[model] !== capacity)
              throw new Error(`CC executor cannot hot-apply a changed capacity for ${model}`);
          // No reconciliation or admission: only subsequent tasks observe these replacements.
          if (next.closedSessionScope !== this.appliedConfig.closedSessionScope ||
              next.coreConfig.noting.forkModeDefault !== this.appliedConfig.coreConfig.noting.forkModeDefault)
            this.importer.memory.configure({ closedSessionScope: next.closedSessionScope,
              noting: { forkModeDefault: next.coreConfig.noting.forkModeDefault } });
          this.importer.applyWorker(next);
          this.scheduler.applyWorker(next.worker);
          this.appliedConfig = next;
        },
      }).then(control => { this.control = control; });
      this.watchTranscript(binding);
      if (final) this.importer.memory.cancelTasks(true);
      this.observe("attach-complete", { final });
    } catch (error) { await this.discardAttachment(); throw error; }
  }

  /** Detach references before disposal: facade close may close its Store and then throw. */
  private async discardAttachment(): Promise<void> {
    this.forkAuthority.cancel(); this.activeForkTurnId = null; this.control?.stopForks();
    const importer = this.importer, scheduler = this.scheduler, control = this.control;
    this.importer = null; this.scheduler = null; this.control = null;
    this.transcriptWatcher?.close(); this.transcriptWatcher = null;
    scheduler?.stop();
    try { if (control) await control.close(); }
    catch (error) { this.diagnostic(`attachment control cleanup failed: ${String(error)}`); }
    try { importer?.close(); }
    catch (error) { this.diagnostic(`attachment facade cleanup failed: ${String(error)}`); }
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
      // The name is read at event time: an adoption (65) re-targets the watch without reopening it.
      this.bindingWatcher = watch(bindingDirectory, (_event, filename) => {
        if (String(filename) === basename(bindingPath(this.config, this.nativeSessionId))) void this.requestReconcile("binding watch");
      });
      this.bindingWatcher.on("error", error => {
        this.diagnostic(`binding watch failed: ${String(error)}; stat wake-up remains active`);
        this.bindingWatcher?.close(); this.bindingWatcher = null;
      });
    }
    this.poll = setInterval(() => { void this.requestReconcile("stat wake-up"); }, this.config.pollIntervalMs);
    await this.requestReconcile("startup");
  }

  /** 65: follow the SessionStart Hook's session id while no binding has been attached. Returns false
   * once attached: `retargetTo` follows it from then on. */
  adoptNativeSessionId(nativeSessionId: string): boolean {
    validateNativeSessionId(nativeSessionId);
    if (nativeSessionId === this.nativeSessionId) return true;
    if (this.importer || this.closing || this.closed) return false;
    const previous = this.nativeSessionId;
    this.nativeSessionId = nativeSessionId;
    this.observe("session-id-adopted", { from: previous, to: nativeSessionId });
    if (this.poll) void this.requestReconcile("session adoption");
    return true;
  }

  /** 102: this Claude Code process now serves another native session (`/clear`, or `/resume` inside
   * the process). Leave the attached one as an exit does, then attach to the new one as at startup:
   * its own binding, core session, project (62) and enrollment. One at a time; false once closing. */
  retargetTo(nativeSessionId: string): Promise<boolean> {
    validateNativeSessionId(nativeSessionId);
    return this.following = this.following.then(() => this.follow(nativeSessionId)).catch(error => {
      this.diagnostic(`retarget to ${nativeSessionId} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
  }

  private async follow(nativeSessionId: string): Promise<boolean> {
    if (this.closing || this.closed) return false;
    if (this.adoptNativeSessionId(nativeSessionId)) return true;
    // 70: hold imports before waiting on the queue behind the running scan, as shutdown does.
    const release = this.holdImport(), previous = this.nativeSessionId, token = this.control?.executor.token;
    try {
      this.observe("retarget-start", { from: previous, to: nativeSessionId });
      await this.leave();
      // Switch before the attachment is dropped: a wake-up in between attaches the new session, never the old.
      this.nativeSessionId = nativeSessionId;
      this.lastReconcile = null; this.lastStatusKey = null;
      this.completedTurns.clear(); this.completedTerminals.clear(); this.completedHookAnchors.clear();
      await this.discardAttachment();
      // Ticket 75: the old session's status file, while it is still this executor's.
      if (token !== undefined && readCcStatus(this.config.stateDir, previous)?.token === token) removeCcStatus(this.config.stateDir, previous);
      this.observe("retarget-complete", { from: previous, to: nativeSessionId });
    } finally { release(); }
    void this.requestReconcile("retarget");
    return true;
  }

  /** Source bodies travel in a control RESPONSE, never the 16,384-byte request. This read neither
   * reserves a task nor establishes coverage: the Hook must check the actual native API view, and
   * the final checkpoint must revalidate the path before admitting a fork. */
  async forkSources(turnId: string, signal: AbortSignal): Promise<{
    turnId: string; sessionId: number; branch: string; headTurnId: number; tailId: number;
    selected: CcOriginalCandidate[];
  } | null> {
    if (signal.aborted || this.closing || this.closed || this.completedTurns.has(turnId)) return null;
    const result = await this.requestReconcile("fork source view");
    if (signal.aborted || result?.state !== "ready" || result.coreSessionId === null ||
        result.headTurnId === null || result.selectedTailId === null || !this.importer) return null;
    const target = { sessionId: result.coreSessionId, branch: result.branch, headTurnId: result.headTurnId };
    if (!this.importer.memory.config.noting.forkModeDefault || !this.importer.memory.taskEligibility("noting", target).due ||
        this.scheduler?.running().includes("noting")) return null;
    const batch = this.importer.memory.notingBatch(target);
    const originals = this.importer.nativeRecords(batch.map(entry => entry.nativeId));
    if (originals === null) return null;
    // The Store's selected Turn ancestry already records the last confirmed native compact.
    // A pre-compact source remains pending, but a summary quoting it is not its original API block.
    const store = this.importer.memory.store;
    const remaining = new Set(batch.map(entry => entry.turnId));
    const ancestry: number[] = [];
    for (const id of store.pathTurns(target)) {
      ancestry.push(id);
      remaining.delete(id);
      if (!remaining.size) break;
    }
    if (remaining.size) throw new Error("CC fork batch has a Turn outside its selected path");
    const compact = new Set((store.db.prepare("SELECT id FROM turns WHERE kind = 'compaction' AND id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ancestry)) as { id: number }[]).map(row => Number(row.id)));
    const afterBoundary = new Set<number>();
    for (const id of ancestry) {
      if (compact.has(id)) break;
      afterBoundary.add(id);
    }
    return { turnId, ...target, tailId: result.selectedTailId,
      selected: batch.map((entry, index) => ({ nativeId: entry.nativeId, record: originals[index]!,
        kind: classifySourceRecord(originals[index]!)?.kind ?? "compaction", afterBoundary: afterBoundary.has(entry.turnId) })) };
  }

  private runFork(task: NotingAgentInput): Promise<RunAgentResult> {
    const launch = this.forkLaunch;
    if (!launch || launch.signal.aborted) return Promise.resolve({ outcome: "cancelled", output: "CC fork checkpoint is no longer live" });
    const suppression = this.importer?.memory.store.forkSuppression(task.sessionId);
    if (suppression) return Promise.resolve({ outcome: "failure", output: "CC fork suppressed before launch",
      refused: { reason: `cache miss latch: fork suppressed for this session since ${suppression.at}` } });
    const result = this.forkAuthority.begin(task);
    this.activeForkTurnId = launch.turnId;
    launch.resolve({ prompt: task.text, turnId: launch.turnId });
    return result;
  }

  private forkOption(target: TaskTarget, result: CcReconcileResult, observation: CcForkObservation | undefined):
    { model: string; capacity: { inputTokens: number; prefixTokens: number }; visible: VisibleView } | { refused: string } {
    const refuse = (reason: string) => ({ refused: reason });
    if (!observation || typeof observation.refused === "string")
      return refuse(observation?.refused ?? "CC native parent observation is unavailable");
    const checkpoint = observation.checkpoint;
    if (!checkpoint || checkpoint.sessionId !== target.sessionId || checkpoint.branch !== target.branch ||
        checkpoint.headTurnId !== target.headTurnId || checkpoint.tailId !== result.selectedTailId)
      return refuse("CC fork source checkpoint moved before admission");
    if (!this.importer || !Array.isArray(observation.batch) || !Array.isArray(observation.raw) ||
        typeof observation.model !== "string" || !observation.model ||
        !Number.isSafeInteger(observation.window) || !Number.isSafeInteger(observation.prefix) ||
        observation.window! <= CC_CONTEXT_HEADROOM || observation.prefix! < 0)
      return refuse("CC fork source coverage or native model capacity is unavailable");
    const batch = this.importer.memory.notingBatch(target);
    if (observation.batch.length !== batch.length || batch.some((entry, i) => observation.batch![i] !== entry.nativeId))
      return refuse("CC fork batch changed since source observation");
    if (this.importer.nativeRecords(batch.map(entry => entry.nativeId)) === null)
      return refuse("CC original source snapshot changed before fork admission");
    const selected = new Set(batch.map(entry => entry.nativeId));
    if (new Set(observation.raw).size !== observation.raw.length ||
        observation.raw.some(id => typeof id !== "string" || !selected.has(id)))
      return refuse("CC fork observation contains an unselected or repeated source identity");
    const memory = this.importer.memory, binding = this.importer.currentBinding();
    const head = ccDeliveryHead(binding, memory);
    const delivered = deliveredView(memory.store.deliveredKnowledge(head.node));
    const delta = memory.injection(target, delivered);
    const visible = { ...delivered, raw: new Map(observation.raw.map(id => [id, "source" as const])) };
    const suppression = memory.store.forkSuppression(target.sessionId);
    const decision = selectNotingMode({ requested: "fork",
      ...(suppression ? { suppression: `cache miss latch: fork suppressed for this session since ${suppression.at}` } : {}),
      publicationPending: !!(delta.knowledgeCommitIds.length || delta.knowledgeStates?.length),
      visible, pending: () => memory.pendingEntries(target.sessionId, target.branch, target.headTurnId),
      batch: () => batch });
    return decision.fallbackReason ? refuse(decision.fallbackReason) : { visible, model: observation.model,
      capacity: { inputTokens: observation.window! - CC_CONTEXT_HEADROOM, prefixTokens: observation.prefix! } };
  }

  /** The function hook proves the main turn ended; reconciliation supplies its selected Raw path
   * and entry anchor. The hook's turnId is an event key, not a source UUID. */
  async turnEnd(turnId: string, reason: string, signal: AbortSignal,
    observation?: CcForkObservation): Promise<{ prompt: string; turnId: string } | null> {
    if (signal.aborted || this.closing || this.closed || this.completedTurns.has(turnId)) return null;
    if (!CC_TURN_END_REASONS.includes(reason))
      throw new Error(`unsupported CC turn completion reason ${reason}`);
    const epoch = this.scheduler?.catchupTicket();
    const result = await this.requestReconcile("function turn end");
    if (signal.aborted || !result || !this.scheduler || epoch !== undefined && epoch !== this.scheduler.catchupTicket()) return null;
    if (result.state !== "ready" || result.selectedTailId === null || result.headTurnId === null || result.coreSessionId === null)
      throw new Error(`CC ${reason} turn ${turnId} has no ready selected native path after reconciliation (state=${result.state}, selectedTail=${result.selectedTailId})`);
    // The real main-session Hook establishes completion. Its selected Raw may end in a tool
    // result or a partial assistant when interrupted, not an API-error assistant row.
    if (this.completedHookAnchors.has(result.selectedTailId) || result.terminal && this.completedTerminals.has(result.terminal.uuid)) return null;
    const target: TaskTarget = { sessionId: result.coreSessionId, branch: result.branch,
      headTurnId: result.headTurnId, triggerEntryId: result.selectedTailId };
    let sourceFailure = this.importer?.memory.config.noting.forkModeDefault ? observation?.failed : undefined;
    let fork: ReturnType<CcCoordinator["forkOption"]> | undefined;
    if (this.importer?.memory.config.noting.forkModeDefault && !sourceFailure) {
      try { fork = this.forkOption(target, result, observation); }
      catch (error) { sourceFailure = error instanceof Error ? error.message : String(error); }
    }
    let resolve!: (directive: { prompt: string; turnId: string } | null) => void;
    const launch = new Promise<{ prompt: string; turnId: string } | null>(done => { resolve = done; });
    if (fork && !("refused" in fork)) {
      if (this.forkLaunch) throw new Error("another CC fork checkpoint has not settled");
      this.forkLaunch = { turnId, resolve, signal };
      signal.addEventListener("abort", () => resolve(null), { once: true });
    } else resolve(null);
    this.completedTurns.add(turnId);
    this.completedHookAnchors.add(result.selectedTailId);
    if (result.terminal) this.completedTerminals.add(result.terminal.uuid);
    this.scheduler.turnEnd(result, this.scheduler.catchupTicket(), fork, () => resolve(null), sourceFailure);
    try { return await launch; }
    finally { if (this.forkLaunch?.resolve === resolve) this.forkLaunch = null; }
  }

  requestReconcile(reason: string, final = false, deadline?: number): Promise<CcReconcileResult | null> {
    if (!final && this.wakeQueued) return this.queue;
    if (!final) this.wakeQueued = true;
    // Freeze the cancellation epoch at the opportunity, before importer reconciliation can wait.
    // A stop/off acknowledged while import is in flight invalidates only this opportunity; a later
    // transcript wake captures the new epoch and remains eligible.
    const opportunityEpoch = this.scheduler?.catchupTicket();
    this.queue = this.queue.then(async () => {
      if (!final) this.wakeQueued = false;
      if (this.closed || this.closing && !final) return null;
      const wasAttached = this.importer !== null;
      const importAbort = new AbortController();
      this.currentImportAbort = importAbort;
      // A deadline-bounded (final) sync keeps its duty but stops importing when its deadline passes:
      // the aborted scan leaves stamp and offset unadvanced, so the next executor imports the rest.
      const expiry = deadline === undefined ? undefined : setTimeout(() =>
        importAbort.abort(new DOMException("CC final sync reached its deadline", "AbortError")), Math.max(0, deadline - Date.now()));
      try {
        const attaching = this.attach(final, deadline);
        // attach() constructs the scheduler synchronously before its first await. Capture that first
        // scheduler's epoch now, not after control can acknowledge a stop while initial import waits.
        const epoch = opportunityEpoch ?? this.scheduler?.catchupTicket();
        await attaching;
        if (!final && readBinding(this.config, this.nativeSessionId)?.lastClose?.confirmed) {
          this.scheduler?.stop();
          this.importer?.memory.cancelTasks(true);
          return null;
        }
        // 70: a hold outstanding means a preempting operation (off, retarget or shutdown) is racing
        // this reconcile for the binding lock. Skip the scan rather than contest it: stamp and offset
        // stay unadvanced, so nothing is lost — the next wake after the hold releases imports
        // normally. `final` reconciles (shutdown's own finalReconcile) are exempt: a hold never
        // blocks the very operation that is holding it.
        const result = !final && this.importHolds > 0 ? null : await this.importer?.reconcile(importAbort.signal, this.importTuning) ?? null;
        if (this.importer) this.watchTranscript(this.importer.currentBinding());
        // The explicit drain still observes path/enrollment changes, but its reconciliation must
        // not first become an ordinary threshold-trigger opportunity before the boundary freezes.
        if (!final && result) {
          this.scheduler?.reconcile(result);
          // Only a process with no confirmed live function module uses transcript termination.
          // Initial/restored history is not an automatic opportunity.
          const binding = readBinding(this.config, this.nativeSessionId);
          if (reason !== "function turn end" && reason !== "manual catchup" && this.startupComplete &&
              !(binding && activeFunctionHook(binding)) && result.terminal && (result.terminal.stopReason === "end_turn" || result.terminal.isApiErrorMessage === true ||
                result.terminal.interruptedMessageId !== undefined) &&
              (result.selectedAppendedEntryIds.includes(result.terminal.entryId) || result.terminal.fresh === true) &&
              !this.completedTerminals.has(result.terminal.uuid) && !this.completedHookAnchors.has(result.terminal.entryId)) {
            this.completedTerminals.add(result.terminal.uuid);
            this.scheduler?.turnEnd(result, epoch ?? this.scheduler.catchupTicket());
          }
        }
        // Ticket 75: publish at a lifecycle event, not on a timer — only when this reconcile appended
        // entries or moved the selected path (coreSessionId/branch/headTurnId), including the
        // enrollment on/off transitions carried in `state`. A no-op "stat wake-up" reconcile writes
        // nothing. `final` reconciles (shutdown's drain) publish nothing; shutdown removes the file.
        if (!final && result) {
          this.lastReconcile = result;
          const pathKey = `${result.coreSessionId}|${result.branch}|${result.headTurnId}|${result.state}`;
          if (result.appendedEntryIds.length > 0 || pathKey !== this.lastStatusKey) {
            this.lastStatusKey = pathKey;
            this.publish(reason);
          }
        }
        if (this.importer && result && !this.startupComplete && !final) {
          this.startupComplete = true;
          this.observe("startup-complete");
        }
        if (reason !== "stat wake-up") this.observe("reconcile", { reason, final, state: result?.state ?? "unbound",
          coreSessionId: result?.coreSessionId ?? null, appended: result?.appendedEntryIds.length ?? 0 });
        if (result?.problems.length && reason !== "stat wake-up") this.diagnostic(`${reason}: ${result.problems.join("; ")}`);
        return result;
      } catch (error) {
        if (!wasAttached) await this.discardAttachment();
        if ((error as { name?: string }).name === "AbortError") this.observe("startup-cancelled", { reason });
        else this.diagnostic(`${reason} reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      } finally {
        if (expiry !== undefined) clearTimeout(expiry);
        if (this.currentImportAbort === importAbort) this.currentImportAbort = null;
      }
    });
    return this.queue;
  }

  /** An executor-local native registration, never inferred from MCP model arguments. A retired
   * call cannot become a manual write after cancellation or a duplicate dispatch. */
  forkToolCall(callId: string, name: "note" | "memory") { return this.forkAuthority.take(callId, name); }

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

  /** What an exit does to the attached session (shutdown and 102's retarget): its work stops, a final
   * sync bounded by its deadline imports the transcript's tail, and its tasks are cancelled and settled
   * and their claims released. The caller holds imports. */
  private async leave(): Promise<CcCloseResult> {
    this.forkAuthority.cancel(); this.control?.stopForks();
    this.scheduler?.stop();
    this.transcriptWatcher?.close(); this.transcriptWatcher = null;
    await this.queue;
    this.importer?.memory.cancelTasks(true);
    const result = await this.finalReconcile();
    if (this.importer) {
      this.importer.memory.forceTasks();
      await this.scheduler?.settle();
      this.importer.memory.store.releaseExecutor(this.importer.memory.executorId);
    }
    return result;
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
    this.closing = true; this.scheduler?.stop(); this.stopWakeups(); this.startup.abort(new DOMException("Lifecycle shutdown", "AbortError"));
    // 70: hold imports before waiting on the queue behind the running scan: otherwise a reconcile
    // already queued there would start the instant it settles and run a full, unaborted import first.
    // Never released: `closing` already blocks every future non-final reconcile.
    this.holdImport();
    this.observe("shutdown-begin", { reason });
    let result: CcCloseResult = { confirmed: false, reason: "no bound importer", diagnostic: "binding was never established" };
    try {
      await this.following; // a retarget in flight finishes its handoff first
      result = await this.leave();
      // MCP teardown is never close authority. Preserve its executor binding unless SessionEnd
      // already cleared it, so another attach cannot mistake an unfinished teardown for no owner.
      const owner = this.control?.executor.token;
      if (this.control) await this.control.close(true);
      // Ticket 75: the file is removed on shutdown, but only while the binding still names this
      // executor — never a newer one that may already have attached in a race after this coordinator
      // gave up its socket but before this line runs. A removal failure is a diagnostic, not a fault:
      // shutdown proceeds unconditionally either way.
      try {
        if (owner !== undefined && readBinding(this.config, this.nativeSessionId)?.executor?.token === owner)
          removeCcStatus(this.config.stateDir, this.nativeSessionId);
      } catch (error) { this.diagnostic(`status removal failed: ${error instanceof Error ? error.message : String(error)}`); }
      if (readBinding(this.config, this.nativeSessionId)) await updateBinding(this.config, this.nativeSessionId, binding => {
        if (!binding) throw new Error("CC binding disappeared during shutdown");
        if (binding.lastClose?.confirmed || (owner !== undefined && binding.executor?.token !== owner)) return binding;
        return { ...binding, lastClose: { at: new Date().toISOString(), reason, confirmed: result.confirmed,
          ...(result.diagnostic ? { diagnostic: result.diagnostic } : {}) } };
      });
      if (!result.confirmed) this.diagnostic(`close not confirmed: ${result.diagnostic ?? result.reason}`);
      this.observe("shutdown-complete", { reason, confirmed: result.confirmed });
      return result;
    } finally {
      this.stopWakeups();
      this.closed = true; this.closing = false;
      this.importer?.close(); this.importer = null; this.scheduler = null; this.control = null;
    }
  }
}
