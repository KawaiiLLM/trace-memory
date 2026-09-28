import { TraceMemory, directoryAllocation, sourceDigest, type TraceMemory as TraceMemoryFacade } from "../../core/api/index.ts";
import { StaleSourcePathError, type SourceEntry, type SourcePathState, type Store } from "../../core/store/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { createCcRunAgent, type CcWorkerDependencies } from "./worker.ts";
import { coreHostOf, dropLostCoreSession, implicitCcProject, readBinding, withCcBindingLock, type CcBindingLock, type CcSessionBinding } from "./binding.ts";
import { CcTranscriptCursor, CcTranscriptScan, CcTranscriptScanFailure, ccSourceBlocks, classifySourceRecord,
  nativeParentId, readTranscriptBootstrap, readTranscriptMetadata, type CcNativeNode, type CcNativeRecord, type CcSourceRecord,
  type CcTranscriptSnapshot } from "./transcript.ts";

/** Measurement and test-only hooks; every field is optional. `onIngestGap` reports each cooperative
 * pause point of the ingest loop (its length before the pause and once more at the end for the
 * final slice); `onPhase` reports the unsliced read and parse/index/sort phases. `sliceMs`/`pauseMs`
 * override the production cooperative-scan constants — unset in production, used by tests that need
 * several real pauses over a small fixture instead of waiting out a 30k-record scan. */
export interface CcImportInstrumentation {
  onIngestGap?: (ms: number) => void;
  onPhase?: (phase: "read" | "index", ms: number) => void;
  sliceMs?: number;
  pauseMs?: number;
}

export interface CcReconcileResult {
  state: "ready" | "provisional" | "disabled" | "not-ready" | "unavailable";
  snapshot: CcTranscriptSnapshot;
  coreSessionId: number | null;
  branch: string;
  headTurnId: number | null;
  /** Full snapshot, materialized only by callers that explicitly need the entire path. */
  selectedEntryIds: number[];
  selectedCount: number;
  selectedTailId: number | null;
  /** Newly ingested entries that belong to the final selected path. */
  selectedAppendedEntryIds: number[];
  appendedEntryIds: number[];
  /** First successful scan of this native projection, not a replay of live entry events. */
  bootstrap?: boolean;
  problems: string[];
}

export interface CcPersistedCall {
  coreSessionId: number;
  branch: string;
  headTurnId: number;
  triggerEntryId: number;
  entryIds: number[];
}

const unavailableRunner = async () => ({ outcome: "failure" as const,
  output: "CC worker configuration is required for Noting and Dreaming admission",
  audit: { available: false as const, reason: "Claude Agent SDK worker was not configured" } });
const provisionalEnabled = (binding: CcSessionBinding) => binding.enrollment.choice ?? binding.enrollment.defaultEnabled;

class CcIntegrityError extends Error {}
/** A node that holds its own source entry on a path: not a compaction, and not a copy of an earlier row. */
const ownsEntry = (node: CcNativeNode): boolean => !!node.sourceKind && node.sourceKind !== "compaction" && node.copyOf === undefined;
interface CallIdentity { ordinal: number; name: string }
interface BootstrapSummary {
  key: string;
  createdAt: string | null;
  firstAssistantAt: string | null;
  completeBytes: number;
  recordCount: number;
  incompleteBytes: number;
}
const snapshotKey = (value: CcTranscriptSnapshot) => JSON.stringify([value.exists, value.device, value.inode, value.size, value.modifiedMs, value.changedMs]);
export const CC_PLUGIN_NAME = "trace-memory";
export const CC_MCP_SERVER_NAME = "traceMemory";

export class CcProjection {
  readonly memory: TraceMemoryFacade;
  private readonly config: ResolvedCcHostConfig;
  private binding: CcSessionBinding;
  private lockedBinding: CcBindingLock | null = null;
  private transcript = new CcTranscriptCursor();
  private bootstrap: BootstrapSummary | null = null;
  private callsByTurn = new Map<number, Map<string, CallIdentity>>();
  private loadedCallTurns = new Set<number>();
  private lastResult: CcReconcileResult | null = null;
  private expectedPath: SourcePathState | null = null;
  private synchronized = false;
  /** 97: memo of `promptParent` per native node; a rescan replaces the nodes and so the memo. */
  private promptParents = new WeakMap<CcNativeNode, number | null>();

  constructor(config: ResolvedCcHostConfig, binding: CcSessionBinding, memory: TraceMemoryFacade) {
    if (binding.dbPath !== config.dbPath) throw new Error("CC binding uses another database");
    this.config = config;
    this.binding = binding;
    this.memory = memory;
  }

  currentBinding(): CcSessionBinding { return this.binding; }

  /** Resolve one native tool call from the incremental structural index. The transcript supplies
   * identity; source_paths only names the already-published branch that owns that ancestry. */
  persistedCall(toolUseId: string, toolName: "note" | "memory"): CcPersistedCall | null {
    if (!toolUseId || this.binding.coreSessionId === null) return null;
    // Claude Code records direct MCP and installed-plugin calls under distinct, stable identities.
    // Keep both identities exact: accepting a suffix would let another server impersonate this one.
    const nativeToolNames = [
      `mcp__${CC_MCP_SERVER_NAME}__${toolName}`,
      `mcp__plugin_${CC_PLUGIN_NAME}_${CC_MCP_SERVER_NAME}__${toolName}`,
    ];
    const ancestry = this.transcript.callPath(toolUseId, nativeToolNames);
    if (!ancestry) return null;
    const entryIds: number[] = [];
    for (const node of ancestry) if (ownsEntry(node)) {
      if (node.entryId === undefined) return null;
      entryIds.push(node.entryId);
    }
    const carrierNode = ancestry.at(-1)!;
    const invocation = carrierNode.calls.find(call => call.id === toolUseId);
    if (!invocation || !nativeToolNames.includes(invocation.name) || carrierNode.entryId === undefined) return null;
    const carrier = this.memory.store.getSourceEntry(carrierNode.entryId);
    if (!carrier || !carrier.calls.some(call => call.callId === toolUseId && call.name === invocation.name)) return null;
    const branch = this.memory.store.sourceBranchForPrefix(this.binding.coreSessionId, entryIds, this.binding.branch);
    if (!branch) return null;
    return { coreSessionId: this.binding.coreSessionId, branch, headTurnId: carrier.turnId, triggerEntryId: carrier.id, entryIds };
  }

  private persist(update: (binding: CcSessionBinding) => CcSessionBinding): void {
    if (!this.lockedBinding) throw new Error("CC projection binding lock is unavailable");
    this.binding = this.lockedBinding.update(current => {
      if (!current) throw new Error("CC binding disappeared");
      return update(current);
    });
  }

  private bootstrapSummary(): { summary: BootstrapSummary; snapshot: CcTranscriptSnapshot } {
    const observed = readTranscriptMetadata(this.binding.transcriptPath), observedKey = snapshotKey(observed);
    if (this.bootstrap?.key === observedKey) return { summary: this.bootstrap, snapshot: { ...observed,
      completeBytes: this.bootstrap.completeBytes, recordCount: this.bootstrap.recordCount, incompleteBytes: this.bootstrap.incompleteBytes } };
    const bootstrap = readTranscriptBootstrap(this.binding.transcriptPath), current = bootstrap.snapshot, key = snapshotKey(current);
    const summary = { key, createdAt: bootstrap.createdAt, firstAssistantAt: bootstrap.firstAssistantAt,
      completeBytes: current.completeBytes, recordCount: current.recordCount, incompleteBytes: current.incompleteBytes };
    if (!current.problem) this.bootstrap = summary;
    return { summary, snapshot: current };
  }

  private async refreshEnrollment(summary: BootstrapSummary): Promise<void> {
    if (this.binding.nativeCreatedAt !== null || !summary.createdAt) return;
    await this.persist(binding => ({ ...binding, nativeCreatedAt: summary.createdAt,
      enrollment: { ...binding.enrollment, defaultEnabled: typeof this.config.baseline === "string" &&
        Date.parse(summary.createdAt!) > Date.parse(this.config.baseline) } }));
  }

  private async allocate(summary: BootstrapSummary): Promise<void> {
    if (this.binding.coreSessionId !== null || !summary.firstAssistantAt || !summary.createdAt) return;
    await this.persist(binding => {
      if (binding.coreSessionId !== null || !provisionalEnabled(binding)) return binding;
      const host = coreHostOf(binding);
      const existing = this.memory.store.findSessionByHost(host);
      if (existing) return { ...binding, coreSessionId: existing.id, projectId: existing.projectId,
        enrollment: this.memory.store.enrollment(existing.id) };
      // 62: the one place this host resolves cwd; a binding without cwd keeps its own project.
      const allocation = directoryAllocation(this.memory.store, binding.cwd, () => implicitCcProject(this.memory.store, binding.nativeSessionId).id);
      const session = this.memory.store.createSession({ host, startedAt: summary.createdAt!, firstReplyAt: summary.firstAssistantAt!, ...allocation,
        nativeCreatedAt: summary.createdAt!, baseline: this.config.baseline, enrollmentChoice: binding.enrollment.choice });
      return { ...binding, coreSessionId: session.id, projectId: allocation.projectId, enrollment: this.memory.store.enrollment(session.id) };
    });
  }

  private result(state: CcReconcileResult["state"], snapshot: CcTranscriptSnapshot, problems: string[] = [],
    values: Partial<CcReconcileResult> = {}, published = false): CcReconcileResult {
    const { selectedEntryIds, ...rest } = values;
    const sessionId = rest.coreSessionId ?? this.binding.coreSessionId;
    const branch = rest.branch ?? this.binding.branch;
    const selected = sessionId === null || (!published && this.lastResult) ? null
      : this.memory.store.selectedSourceEntrySnapshot(sessionId, branch);
    const previous = selected ? null : this.lastResult;
    const count = selectedEntryIds?.length ?? selected?.count ?? previous?.selectedCount ?? 0;
    const result = { state, snapshot, coreSessionId: this.binding.coreSessionId, branch: this.binding.branch,
      headTurnId: this.lastResult?.headTurnId ?? null, appendedEntryIds: [], selectedAppendedEntryIds: [], problems,
      selectedCount: count, selectedTailId: selectedEntryIds ? selectedEntryIds[count - 1] ?? null : selected?.tailId ?? previous?.selectedTailId ?? null, ...rest } as CcReconcileResult;
    // Captured Store prefix does not change after a later append or navigation.
    Object.defineProperty(result, "selectedEntryIds", { enumerable: true, get: () => selectedEntryIds?.slice() ?? selected?.ids() ?? previous?.selectedEntryIds ?? [] });
    return result;
  }

  async synchronize(signal?: AbortSignal, instrumentation?: CcImportInstrumentation): Promise<CcReconcileResult> {
    const observedBinding = readBinding(this.config, this.binding.nativeSessionId);
    if (this.lastResult && observedBinding && JSON.stringify(observedBinding) === JSON.stringify(this.binding) &&
        (observedBinding.coreSessionId === null || this.memory.store.enabled(observedBinding.coreSessionId))) {
      const unchanged = this.transcript.unchangedSnapshot(observedBinding.transcriptPath);
      if (unchanged) {
        const problems = this.transcript.currentProblems();
        return this.result(problems.length ? "not-ready" : this.lastResult.state,
          problems.length ? { ...unchanged, problem: problems[0] } : unchanged, problems,
          { coreSessionId: this.lastResult.coreSessionId, branch: this.lastResult.branch,
            headTurnId: this.lastResult.headTurnId, appendedEntryIds: [], bootstrap: false });
      }
    }
    return withCcBindingLock(this.config, this.binding.nativeSessionId, async locked => {
      this.lockedBinding = locked;
      try { return await this.reconcileLocked(signal, instrumentation); }
      finally { this.lockedBinding = null; }
    }, undefined, signal);
  }

  private async reconcileLocked(signal?: AbortSignal, instrumentation: CcImportInstrumentation = {}): Promise<CcReconcileResult> {
    if (!this.lockedBinding) throw new Error("CC projection binding lock is unavailable");
    const current = this.lockedBinding.read();
    if (!current || current.dbPath !== this.config.dbPath || current.transcriptPath !== this.binding.transcriptPath)
      throw new Error("CC binding changed or disappeared before reconciliation");
    const staleProjection = current.coreSessionId !== this.binding.coreSessionId || current.branch !== this.binding.branch ||
      current.selectedLeafUuid !== this.binding.selectedLeafUuid;
    this.binding = current;
    if (staleProjection) {
      this.transcript = new CcTranscriptCursor();
      this.bootstrap = null;
      this.callsByTurn.clear();
      this.loadedCallTurns.clear();
      this.lastResult = null;
      this.expectedPath = null;
    }
    // 84 edge case: a rollback that reaches back before this native session's own core session was
    // created still leaves the binding naming it. Drop it and fall through to the ordinary
    // provisional path below exactly as a not-yet-registered binding does — it re-allocates a fresh
    // core session for this native identity and re-imports Raw from the transcript.
    if (this.binding.coreSessionId !== null && !this.memory.store.getSession(this.binding.coreSessionId)) {
      this.persist(binding => dropLostCoreSession(binding, this.memory.store));
      this.transcript = new CcTranscriptCursor();
      this.bootstrap = null;
      this.callsByTurn.clear();
      this.loadedCallTurns.clear();
      this.lastResult = null;
      this.expectedPath = null;
    }

    let summary: BootstrapSummary | null = null, bootstrapSnapshot: CcTranscriptSnapshot | null = null;
    if (this.binding.nativeCreatedAt === null || this.binding.coreSessionId === null) {
      ({ summary, snapshot: bootstrapSnapshot } = this.bootstrapSummary());
      if (!bootstrapSnapshot.exists) return this.result("unavailable", bootstrapSnapshot);
      // A complete-read identity diagnostic must block the Hook, but the importer still owns
      // record-local repair: once creation and the first reply are independently known, allocate and
      // let the incremental scanner persist valid records while reporting the conflicting identity.
      if (bootstrapSnapshot.problem && (!summary.createdAt || !summary.firstAssistantAt))
        return this.result("not-ready", bootstrapSnapshot, [bootstrapSnapshot.problem]);
      await this.refreshEnrollment(summary);
    }
    if (this.binding.coreSessionId === null ? !provisionalEnabled(this.binding) : !this.memory.store.enabled(this.binding.coreSessionId))
      return this.result("disabled", bootstrapSnapshot ?? this.transcript.currentSnapshot(this.binding.transcriptPath));
    if (this.binding.coreSessionId === null) await this.allocate(summary!);
    if (this.binding.coreSessionId === null) return this.result("provisional", bootstrapSnapshot!);
    if (!this.memory.store.enabled(this.binding.coreSessionId)) return this.result("disabled", bootstrapSnapshot ?? this.transcript.currentSnapshot(this.binding.transcriptPath));

    const sessionId = this.binding.coreSessionId, lineage = this.binding.nativeSessionId;
    const appendedEntryIds: number[] = [], problems: string[] = [], failedNativeIds = new Set<string>();
    const addProblem = (problem: string): void => { if (!problems.includes(problem)) problems.push(problem); };
    /** The nearest imported source record above `parent`, or null at the root. */
    const importedAbove = (parent: string | null, scan: CcTranscriptScan, seen = new Set<string>()): CcNativeNode | null => {
      while (parent) {
        if (seen.has(parent)) throw new CcIntegrityError(`native lineage cycle at ${parent}`);
        seen.add(parent);
        const ancestor = scan.node(parent);
        if (!ancestor) throw new CcIntegrityError(`native lineage parent ${parent} is missing`);
        if (ancestor.lineageProblem) throw new CcIntegrityError(ancestor.lineageProblem);
        if (ancestor.importProblem) throw new CcIntegrityError(ancestor.importProblem);
        if (ancestor.turnId !== undefined) return ancestor;
        if (ancestor.sourceKind !== null) throw new CcIntegrityError(`native source ${ancestor.uuid} is not persisted`);
        parent = ancestor.parentUuid;
      }
      return null;
    };
    // 63: a native session linked by a `/clear` before 102 continues that core session; its root
    // records descend from the compaction Turn the clear appended under the parent's head.
    const rootTurn = () => this.binding.clearedFrom?.compactionTurnId ?? null;
    const parentOf = (record: CcNativeRecord, scan: CcTranscriptScan): string | null => {
      // The scan resolved this record's lineage in file order; resolve the same parent here.
      const own = typeof record.uuid === "string" ? scan.node(record.uuid) : undefined;
      if (own?.lineageProblem) throw new CcIntegrityError(own.lineageProblem);
      try { return own ? own.parentUuid : nativeParentId(record); }
      catch (error) { throw new CcIntegrityError(error instanceof Error ? error.message : String(error)); }
    };
    const nearestTurn = (record: CcNativeRecord, scan: CcTranscriptScan): number | null =>
      importedAbove(parentOf(record, scan), scan)?.turnId ?? rootTurn();
    /** 97: the Turn a prompt below `node` descends from: the nearest prompt or compaction at or above
     * it, past the replies of the Turn they answer. After a compaction that interrupted a reply, that
     * is the compaction, so it lies on every later path, as on Pi. */
    const promptParent = (node: CcNativeNode | null, scan: CcTranscriptScan): number | null => {
      const walked: CcNativeNode[] = [], seen = new Set<string>();
      let found: number | null | undefined;
      while (found === undefined) {
        if (!node) found = rootTurn();
        else if (this.promptParents.has(node)) found = this.promptParents.get(node)!;
        else if (node.sourceKind === "user" || node.sourceKind === "compaction") found = node.turnId!;
        else { walked.push(node); node = importedAbove(node.parentUuid, scan, seen); }
      }
      for (const value of walked) this.promptParents.set(value, found);
      return found;
    };
    // 74: call identities alone (`turnCallIdentities`), never every entry of the Turn — the same
    // identities `listSourceEntries` used to expose only by loading each entry's full Raw.
    const knownCalls = (turnId: number): Map<string, CallIdentity> => {
      const loaded = this.callsByTurn.get(turnId);
      if (this.loadedCallTurns.has(turnId)) return loaded ?? new Map();
      const values = new Map<string, CallIdentity>();
      for (const value of this.memory.store.turnCallIdentities(turnId)) {
        const prior = values.get(value.callId);
        if (prior && (prior.ordinal !== value.ordinal || prior.name !== value.name))
          throw new CcIntegrityError(`native tool call ${value.callId} changed within one Turn`);
        values.set(value.callId, { ordinal: value.ordinal, name: value.name });
      }
      return values;
    };
    interface RecordCommit {
      association: { turnId: number; entryId?: number };
      calls?: Map<string, CallIdentity>;
      appendedEntryId?: number;
    }
    const ingest = (record: CcNativeRecord, source: CcSourceRecord, raw: string, scan: CcTranscriptScan): RecordCommit => {
      if (!source.timestamp) throw new CcIntegrityError(`native source ${source.nativeId} has no valid timestamp`);
      const timestamp = source.timestamp;
      if (source.kind === "compaction") {
        const known = this.memory.store.findNativeTurn(sessionId, lineage, source.nativeId);
        const above = importedAbove(parentOf(record, scan), scan), parentTurnId = above?.turnId ?? rootTurn();
        if (known) {
          const turn = this.memory.store.getTurn(known.turnId);
          if (!turn || turn.kind !== "compaction" || turn.parentTurnId !== parentTurnId || turn.startedAt !== source.timestamp)
            throw new CcIntegrityError(`native compaction ${source.nativeId} changed after persistence`);
          return { association: { turnId: known.turnId } };
        }
        return this.memory.store.transaction(() => {
          const turn = this.memory.store.appendTurn({ sessionId, parentTurnId, kind: "compaction", startedAt: timestamp, endedAt: timestamp });
          this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, turn.id, "compaction");
          // 97: the supplement the compact hook recorded for the compaction after this record.
          const key = above && this.memory.store.compactionDeliveryKey(coreHostOf(this.binding), above.uuid);
          if (key) this.memory.store.bindDeliveryNode(key, sessionId, turn.id);
          return { association: { turnId: turn.id } };
        });
      }
      // 74: identity without Raw — `digest` compares against `sourceDigest(raw)` in place of
      // `known.raw !== raw`, and `known.calls` (call id, ordinal, name only) comes from the compact
      // side table instead of this entry's full stored content.
      const known = this.memory.store.findKnownSourceEntry(sessionId, lineage, source.nativeId);
      if (known) {
        if (known.digest !== sourceDigest(raw)) throw new CcIntegrityError(`native source ${source.nativeId} changed after persistence`);
        if (source.kind === "user" && !this.memory.store.findNativeTurn(sessionId, lineage, source.nativeId))
          this.memory.store.transaction(() => this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, known.turnId, "turn"));
        const calls = new Map(knownCalls(known.turnId));
        if (source.kind === "assistant") for (const value of known.calls) {
          const prior = calls.get(value.callId);
          if (prior && (prior.ordinal !== value.ordinal || prior.name !== value.name))
            throw new CcIntegrityError(`native tool call ${value.callId} changed within one Turn`);
          calls.set(value.callId, { ordinal: value.ordinal, name: value.name });
        }
        return { association: { turnId: known.turnId, entryId: known.id }, calls };
      }
      // A row Claude Code wrote again across a compaction is the row it repeats: no entry, no tool call or result.
      const original = scan.node(source.nativeId)?.copyOf;
      if (original !== undefined) {
        const turnId = scan.node(original)?.turnId;
        if (turnId === undefined) throw new CcIntegrityError(`native source ${original} is not persisted`);
        return { association: { turnId } };
      }
      return this.memory.store.transaction(() => {
        let turnId: number;
        // The owning Turn is fetched once here and reused below for the assistant-text append
        // (70: it is read once for the ownership check and once more for the append otherwise).
        let ownerTurn: ReturnType<Store["getTurn"]> = null;
        if (source.kind === "user") {
          const parentTurnId = promptParent(importedAbove(parentOf(record, scan), scan), scan);
          turnId = this.memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: source.text, startedAt: timestamp }).id;
          this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, turnId, "turn");
          // 97: a delivery recorded under this prompt's native id belongs to this Turn.
          if (typeof record.promptId === "string" && record.promptId) this.memory.store.bindDeliveryNode(record.promptId, sessionId, turnId);
        } else {
          const owner = nearestTurn(record, scan);
          ownerTurn = owner === null ? null : this.memory.store.getTurn(owner);
          // Claude Code 2.1.280 can compact automatically in the middle of a reply, which then goes on
          // under the same prompt (CC records the same prompt id). As on Pi, the reply's content belongs
          // to the user Turn the compaction interrupted.
          while (ownerTurn?.kind === "compaction")
            ownerTurn = ownerTurn.parentTurnId === null ? null : this.memory.store.getTurn(ownerTurn.parentTurnId);
          if (!ownerTurn || ownerTurn.kind !== "turn")
            throw new CcIntegrityError(`owning user Turn for native source ${source.nativeId} is unavailable`);
          turnId = ownerTurn.id;
        }
        const calls = source.kind === "user" ? new Map<string, CallIdentity>() : new Map(knownCalls(turnId));
        const fragments: SourceEntry["calls"] = [];
        if (source.kind === "assistant") for (const offered of source.calls) {
          if (calls.has(offered.callId)) throw new CcIntegrityError(`native tool call ${offered.callId} repeats within one Turn`);
          const stored = this.memory.store.appendToolCall({ turnId, name: offered.name, input: offered.input, status: offered.status });
          calls.set(offered.callId, { ordinal: stored.ordinal, name: stored.name });
          fragments.push({ ...offered, ordinal: stored.ordinal });
        }
        if (source.kind === "toolResult") {
          for (const value of source.calls) {
            const offered = calls.get(value.callId);
            if (!offered) throw new CcIntegrityError(`tool result ${value.callId} has no call in its owning Turn`);
            fragments.push({ ...value, ordinal: offered.ordinal, name: offered.name });
          }
          for (const call of fragments) this.memory.store.completeToolCall(turnId, call.ordinal, call.result ?? "", call.status);
        }
        const stored = this.memory.appendEntry({ sessionId, nativeLineage: lineage, nativeId: source.nativeId, turnId,
          role: source.kind, text: source.text, raw, calls: fragments }, null);
        if (source.kind === "assistant") {
          const turn = ownerTurn!;
          this.memory.store.updateTurn(turnId, { assistantText: [turn.assistantText, source.text].filter(Boolean).join("\n"), endedAt: source.timestamp });
        }
        return { association: { turnId, entryId: stored.id }, calls, appendedEntryId: stored.id };
      });
    };

    const visit = (record: CcNativeRecord, source: CcSourceRecord | null, raw: string, currentScan: CcTranscriptScan): void => {
      if (!source) return;
      try {
        const committed = ingest(record, source, raw, currentScan);
        currentScan.associate(source.nativeId, committed.association);
        if (committed.calls) {
          this.callsByTurn.set(committed.association.turnId, committed.calls);
          this.loadedCallTurns.add(committed.association.turnId);
        }
        if (committed.appendedEntryId !== undefined) appendedEntryIds.push(committed.appendedEntryId);
      } catch (error) {
        if (!(error instanceof CcIntegrityError)) throw error;
        currentScan.markProblem(source.nativeId, error.message);
        failedNativeIds.add(source.nativeId); addProblem(error.message);
      }
    };

    let scan: CcTranscriptScan | CcTranscriptSnapshot;
    let branch = this.binding.branch, selectedEntryIds: number[] | null = null, selectedDelta: number[] = [],
      headTurnId: number | null = null, projectionReady = true;
    // The rows this reconcile is about to publish as (part of) the selected path, so a successful
    // commit can mark them (98): never proposed again by a later scan's `pathExtension`, however their
    // UUID resurfaces.
    let confirmedNodes: CcNativeNode[] = [];
    try {
      scan = await this.transcript.scanCooperative(this.binding.transcriptPath, visit,
        { signal, onIngestGap: instrumentation.onIngestGap, onPhase: instrumentation.onPhase,
          sliceMs: instrumentation.sliceMs, pauseMs: instrumentation.pauseMs });
      if (scan instanceof CcTranscriptScan) {
        for (const problem of scan.problems) addProblem(problem);
        if (!scan.reset && scan.selectedLeafUuid === this.binding.selectedLeafUuid && this.lastResult) {
          headTurnId = this.lastResult.headTurnId;
        } else {
          const priorLeaf = this.binding.selectedLeafUuid;
          let extension: NonNullable<ReturnType<CcTranscriptScan["node"]>>[] = [];
          let continuous = false;
          if (!scan.reset && priorLeaf && scan.selectedLeafUuid && this.lastResult) {
            // 108: null when this scan does not simply extend the prior path; the full rebuild below
            // decides (and surfaces any lineage problem).
            const appended = scan.pathExtension(priorLeaf);
            continuous = appended !== null;
            if (appended) extension = appended;
          }
          if (continuous) {
            confirmedNodes = extension;
            for (const node of confirmedNodes) if (ownsEntry(node)) {
              if (node.entryId === undefined) {
                if (!failedNativeIds.has(node.uuid)) addProblem(`native source ${node.uuid} is not persisted`);
                projectionReady = false; break;
              }
              selectedDelta.push(node.entryId);
            }
          } else {
            const selected = scan.selectedPath();
            if (selected.problem) {
              addProblem(selected.problem); projectionReady = false;
            } else {
              confirmedNodes = selected.nodes;
              selectedEntryIds = [];
              for (const node of confirmedNodes) if (ownsEntry(node)) {
                if (node.entryId === undefined) {
                  if (!failedNativeIds.has(node.uuid)) addProblem(`native source ${node.uuid} is not persisted`);
                  projectionReady = false; break;
                }
                selectedEntryIds.push(node.entryId);
              }
              if (projectionReady && priorLeaf && selected.leafUuid && !selected.nodes.some(node => node.uuid === priorLeaf))
                branch = `cc:${selected.leafUuid}`;
            }
          }
          if (projectionReady) {
            headTurnId = [...confirmedNodes].reverse().find(node => node.turnId !== undefined)?.turnId ?? this.lastResult?.headTurnId
              ?? this.binding.clearedFrom?.compactionTurnId ?? null;
            const selectedState = continuous ? this.expectedPath : null;
            if (continuous && headTurnId !== null && selectedState) {
              try {
                this.memory.store.appendSourcePath(sessionId, branch, selectedState,
                  selectedDelta, headTurnId, lineage);
              } catch (error) {
                if (!(error instanceof StaleSourcePathError)) throw error;
                // A concurrent rewrite may preserve count and tail but change the middle. Rebuild
                // from native ancestry and publish authoritatively rather than trusting that prefix.
                const rebuilt = scan.selectedPath();
                if (rebuilt.problem) { addProblem(rebuilt.problem); projectionReady = false; }
                else {
                  confirmedNodes = rebuilt.nodes;
                  selectedEntryIds = [];
                  for (const node of rebuilt.nodes) if (ownsEntry(node)) {
                    if (node.entryId === undefined) { addProblem(`native source ${node.uuid} is not persisted`); projectionReady = false; break; }
                    selectedEntryIds.push(node.entryId);
                  }
                }
              }
            } else if (continuous) selectedEntryIds = [...(this.memory.store.selectedSourceEntryIds(sessionId, branch) ?? []), ...selectedDelta];
            if (projectionReady && selectedEntryIds) {
              // 63: a linked child's path begins with its parent's persisted ancestry (kept by 102).
              const inherited = this.binding.clearedFrom?.inheritedEntryIds ?? [];
              if (inherited.length && !inherited.every((id, index) => selectedEntryIds![index] === id))
                selectedEntryIds = [...inherited, ...selectedEntryIds];
              if (headTurnId !== null)
                this.memory.store.publishSourcePath(sessionId, branch, selectedEntryIds, headTurnId, lineage);
              else this.memory.selectEntries(sessionId, branch, selectedEntryIds);
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof CcTranscriptScanFailure) {
        const problem = error.cause instanceof Error ? error.cause.message : String(error.cause);
        if (problem.startsWith("invalid completed transcript record")) {
          const blocked = this.transcript.reject(error.scan, problem);
          return this.result("not-ready", blocked, this.transcript.currentProblems());
        }
        throw error.cause;
      }
      throw error;
    }
    if (!(scan! instanceof CcTranscriptScan)) {
      const observed = scan!;
      if (!observed.exists) return this.result("unavailable", observed);
      const cachedProblems = this.transcript.currentProblems();
      if (cachedProblems.length) return this.result("not-ready", observed, cachedProblems);
      const ready = this.result("ready", observed, [], { coreSessionId: sessionId, branch: this.binding.branch });
      this.lastResult = ready;
      return ready;
    }
    const completed = scan as CcTranscriptScan;
    if (projectionReady) try {
      const transcriptOffset = completed.selectedLeafOffset ?? undefined;
      const leaf = completed.selectedLeafUuid === null ? undefined : completed.node(completed.selectedLeafUuid);
      const selectedHeadTurnId = leaf?.turnId === undefined ? undefined : promptParent(leaf, completed) ?? undefined;
      await this.persist(binding => binding.branch === branch && binding.selectedLeafUuid === completed.selectedLeafUuid &&
        binding.transcriptOffset === transcriptOffset && binding.selectedHeadTurnId === selectedHeadTurnId ? binding
        : (({ transcriptOffset: _stale, selectedHeadTurnId: _head, ...rest }) => ({ ...rest, branch, selectedLeafUuid: completed.selectedLeafUuid,
          ...(transcriptOffset === undefined ? {} : { transcriptOffset }),
          ...(selectedHeadTurnId === undefined ? {} : { selectedHeadTurnId }) }))(binding));
    } catch (error) {
      // Publication may have committed before the binding receipt failed. Do not append its
      // suffix twice on retry; reconstruct the authoritative selected path instead.
      this.lastResult = null;
      this.expectedPath = null;
      throw error;
    }
    this.transcript.commit(completed, problems[0], projectionReady ? confirmedNodes : []);
    const state = problems.length ? "not-ready" : "ready";
    const selectedMembership = selectedEntryIds === null ? null : new Set(selectedEntryIds);
    const newlyImported = selectedEntryIds === null && appendedEntryIds.length ? new Set(appendedEntryIds) : null;
    const ready = this.result(state, problems.length ? { ...completed.snapshot, problem: problems[0] } : completed.snapshot, problems,
      { coreSessionId: sessionId, branch: projectionReady ? branch : this.binding.branch,
        headTurnId: projectionReady ? headTurnId : this.lastResult?.headTurnId ?? null,
        selectedAppendedEntryIds: projectionReady ? selectedEntryIds === null
          ? selectedDelta.filter(id => newlyImported?.has(id))
          : appendedEntryIds.filter(id => selectedMembership!.has(id)) : [],
        appendedEntryIds, bootstrap: !this.synchronized }, projectionReady && (selectedEntryIds !== null || selectedDelta.length > 0));
    if (projectionReady) {
      this.lastResult = ready;
      this.expectedPath = this.memory.store.selectedSourceEntrySnapshot(sessionId, branch)?.state ?? null;
    }
    if (state === "ready") this.synchronized = true;
    return ready;
  }

}

export class CcImporter {
  readonly memory: TraceMemoryFacade;
  private readonly projection: CcProjection;
  private runAgent: ReturnType<typeof createCcRunAgent> | undefined;
  private readonly workerDependencies: CcWorkerDependencies;
  private reopened = false;

  constructor(config: ResolvedCcHostConfig, binding: CcSessionBinding, workerDependencies: CcWorkerDependencies = {}) {
    let memory!: TraceMemoryFacade;
    this.workerDependencies = workerDependencies;
    this.runAgent = config.worker ? createCcRunAgent(config, workerDependencies,
      kind => memory.config[kind].maxToolRounds) : undefined;
    memory = TraceMemory(config.dbPath, input => this.runAgent ? this.runAgent(input) : unavailableRunner(),
      config.coreConfig, undefined,
      entry => entry.nativeLineage === binding.nativeSessionId ? ccSourceBlocks(entry) : undefined);
    this.memory = memory;
    this.projection = new CcProjection(config, binding, memory);
  }

  currentBinding(): CcSessionBinding { return this.projection.currentBinding(); }
  /** Core invokes the runner synchronously before yielding to the provider. An in-flight task
   * holds its invoked worker Promise; only a later task reads this replacement. */
  applyWorker(config: ResolvedCcHostConfig): void {
    this.runAgent = config.worker ? createCcRunAgent(config, this.workerDependencies,
      kind => this.memory.config[kind].maxToolRounds) : undefined;
  }
  persistedCall(toolUseId: string, toolName: "note" | "memory"): CcPersistedCall | null {
    return this.projection.persistedCall(toolUseId, toolName);
  }
  async reconcile(signal?: AbortSignal, instrumentation?: CcImportInstrumentation): Promise<CcReconcileResult> {
    const result = await this.projection.synchronize(signal, instrumentation);
    if (!this.reopened && result.coreSessionId !== null && result.state !== "disabled" &&
        !this.projection.currentBinding().lastClose?.confirmed) {
      this.memory.store.reopenSession(result.coreSessionId, this.memory.executorId);
      this.reopened = true;
    }
    return result;
  }
  close(): void { this.memory.close(); }
}

export function openBoundImporter(config: ResolvedCcHostConfig, nativeSessionId: string): CcImporter | null {
  const binding = readBinding(config, nativeSessionId);
  return binding ? new CcImporter(config, binding) : null;
}
