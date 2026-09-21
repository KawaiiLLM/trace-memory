import { TraceMemory, directoryAllocation, type TraceMemory as TraceMemoryFacade } from "../../core/api/index.ts";
import type { SourceEntry } from "../../core/store/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { createCcRunAgent, type CcWorkerDependencies } from "./worker.ts";
import { coreHostOf, implicitCcProject, readBinding, withCcBindingLock, type CcBindingLock, type CcSessionBinding } from "./binding.ts";
import { CcTranscriptCursor, CcTranscriptScan, CcTranscriptScanFailure, ccSourceBlocks, classifySourceRecord,
  nativeParentId, readTranscriptBootstrap, readTranscriptMetadata, type CcNativeRecord, type CcSourceRecord,
  type CcTranscriptSnapshot } from "./transcript.ts";

export interface CcReconcileResult {
  state: "ready" | "provisional" | "disabled" | "not-ready" | "unavailable";
  snapshot: CcTranscriptSnapshot;
  coreSessionId: number | null;
  branch: string;
  headTurnId: number | null;
  selectedEntryIds: number[];
  appendedEntryIds: number[];
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
  output: "CC worker configuration is required for Noting and Consolidation admission",
  audit: { available: false as const, reason: "Claude Agent SDK worker was not configured" } });
const provisionalEnabled = (binding: CcSessionBinding) => binding.enrollment.choice ?? binding.enrollment.defaultEnabled;

class CcIntegrityError extends Error {}
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
    for (const node of ancestry) if (node.sourceKind && node.sourceKind !== "compaction") {
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
    values: Partial<CcReconcileResult> = {}): CcReconcileResult {
    return { state, snapshot, coreSessionId: this.binding.coreSessionId, branch: this.binding.branch,
      headTurnId: this.lastResult?.headTurnId ?? null, selectedEntryIds: this.lastResult?.selectedEntryIds ?? [],
      appendedEntryIds: [], problems, ...values };
  }

  async synchronize(): Promise<CcReconcileResult> {
    const observedBinding = readBinding(this.config, this.binding.nativeSessionId);
    if (this.lastResult && observedBinding && JSON.stringify(observedBinding) === JSON.stringify(this.binding) &&
        (observedBinding.coreSessionId === null || this.memory.store.enabled(observedBinding.coreSessionId))) {
      const unchanged = this.transcript.unchangedSnapshot(observedBinding.transcriptPath);
      if (unchanged) {
        const problems = this.transcript.currentProblems();
        return { ...this.lastResult, state: problems.length ? "not-ready" : this.lastResult.state,
          snapshot: problems.length ? { ...unchanged, problem: problems[0] } : unchanged,
          appendedEntryIds: [], problems };
      }
    }
    return withCcBindingLock(this.config, this.binding.nativeSessionId, async locked => {
      this.lockedBinding = locked;
      try { return await this.reconcileLocked(); }
      finally { this.lockedBinding = null; }
    });
  }

  private async reconcileLocked(): Promise<CcReconcileResult> {
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
    const nearestTurn = (record: CcNativeRecord, scan: CcTranscriptScan): number | null => {
      const seen = new Set<string>();
      let parent: string | null;
      try { parent = nativeParentId(record); }
      catch (error) { throw new CcIntegrityError(error instanceof Error ? error.message : String(error)); }
      while (parent) {
        if (seen.has(parent)) throw new CcIntegrityError(`native lineage cycle at ${parent}`);
        seen.add(parent);
        const ancestor = scan.node(parent);
        if (!ancestor) throw new CcIntegrityError(`native lineage parent ${parent} is missing`);
        if (ancestor.lineageProblem) throw new CcIntegrityError(ancestor.lineageProblem);
        if (ancestor.importProblem) throw new CcIntegrityError(ancestor.importProblem);
        if (ancestor.turnId !== undefined) return ancestor.turnId;
        if (ancestor.sourceKind !== null) throw new CcIntegrityError(`native source ${ancestor.uuid} is not persisted`);
        parent = ancestor.parentUuid;
      }
      // 63: a native session cleared into from another continues that core session; its root
      // records descend from the compaction Turn the clear appended under the parent's head.
      return this.binding.clearedFrom?.compactionTurnId ?? null;
    };
    const knownCalls = (turnId: number): Map<string, CallIdentity> => {
      const loaded = this.callsByTurn.get(turnId);
      if (this.loadedCallTurns.has(turnId)) return loaded ?? new Map();
      const values = new Map<string, CallIdentity>();
      for (const entry of this.memory.store.listSourceEntries(sessionId, turnId)) for (const value of entry.calls) {
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
      if (source.kind === "compaction") {
        const known = this.memory.store.findNativeTurn(sessionId, lineage, source.nativeId);
        const parentTurnId = nearestTurn(record, scan);
        if (known) {
          const turn = this.memory.store.getTurn(known.turnId);
          if (!turn || turn.kind !== "compaction" || turn.parentTurnId !== parentTurnId || turn.startedAt !== source.timestamp)
            throw new CcIntegrityError(`native compaction ${source.nativeId} changed after persistence`);
          return { association: { turnId: known.turnId } };
        }
        const turn = this.memory.store.appendTurn({ sessionId, parentTurnId, kind: "compaction", startedAt: source.timestamp, endedAt: source.timestamp });
        this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, turn.id, "compaction");
        return { association: { turnId: turn.id } };
      }
      const known = this.memory.store.findSourceEntry(sessionId, lineage, source.nativeId);
      if (known) {
        if (known.raw !== raw) throw new CcIntegrityError(`native source ${source.nativeId} changed after persistence`);
        if (source.kind === "user" && !this.memory.store.findNativeTurn(sessionId, lineage, source.nativeId))
          this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, known.turnId, "turn");
        const calls = new Map(knownCalls(known.turnId));
        if (source.kind === "assistant") for (const value of known.calls) {
          const prior = calls.get(value.callId);
          if (prior && (prior.ordinal !== value.ordinal || prior.name !== value.name))
            throw new CcIntegrityError(`native tool call ${value.callId} changed within one Turn`);
          calls.set(value.callId, { ordinal: value.ordinal, name: value.name });
        }
        return { association: { turnId: known.turnId, entryId: known.id }, calls };
      }
      let turnId: number;
      if (source.kind === "user") {
        const parentTurnId = nearestTurn(record, scan);
        turnId = this.memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: source.text, startedAt: source.timestamp }).id;
        this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, turnId, "turn");
      } else {
        const owner = nearestTurn(record, scan);
        if (owner === null || this.memory.store.getTurn(owner)?.kind !== "turn")
          throw new CcIntegrityError(`owning user Turn for native source ${source.nativeId} is unavailable`);
        turnId = owner;
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
        role: source.kind, text: source.text, raw, calls: fragments });
      if (source.kind === "assistant") {
        const turn = this.memory.store.getTurn(turnId)!;
        this.memory.store.updateTurn(turnId, { assistantText: [turn.assistantText, source.text].filter(Boolean).join("\n"), endedAt: source.timestamp });
      }
      return { association: { turnId, entryId: stored.id }, calls, appendedEntryId: stored.id };
    };

    const visit = (record: CcNativeRecord, source: CcSourceRecord | null, raw: string, currentScan: CcTranscriptScan): void => {
      if (!source) return;
      try {
        const committed = this.memory.store.transaction(() => ingest(record, source, raw, currentScan));
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
    let branch = this.binding.branch, selectedEntryIds: number[] = [], headTurnId: number | null = null, projectionReady = true;
    try {
      scan = this.transcript.scan(this.binding.transcriptPath, visit);
      if (scan instanceof CcTranscriptScan) {
        for (const problem of scan.problems) addProblem(problem);
        if (!scan.reset && scan.selectedLeafUuid === this.binding.selectedLeafUuid && this.lastResult) {
          selectedEntryIds = this.lastResult.selectedEntryIds;
          headTurnId = this.lastResult.headTurnId;
        } else {
          const priorLeaf = this.binding.selectedLeafUuid, extension = [] as NonNullable<ReturnType<CcTranscriptScan["node"]>>[];
          let continuous = false;
          if (!scan.reset && priorLeaf && scan.selectedLeafUuid && this.lastResult) {
            let cursor = scan.node(scan.selectedLeafUuid); const seen = new Set<string>();
            while (cursor && !seen.has(cursor.uuid)) {
              if (cursor.uuid === priorLeaf) { continuous = true; break; }
              seen.add(cursor.uuid); extension.push(cursor);
              cursor = cursor.parentUuid ? scan.node(cursor.parentUuid) : undefined;
            }
          }
          let selectedNodes: typeof extension;
          if (continuous) {
            selectedNodes = extension.reverse();
            selectedEntryIds = [...this.lastResult!.selectedEntryIds];
            for (const node of selectedNodes) if (node.sourceKind && node.sourceKind !== "compaction") {
              if (node.entryId === undefined) {
                if (!failedNativeIds.has(node.uuid)) addProblem(`native source ${node.uuid} is not persisted`);
                projectionReady = false; break;
              }
              selectedEntryIds.push(node.entryId);
            }
          } else {
            const selected = scan.selectedPath();
            if (selected.problem) {
              addProblem(selected.problem); projectionReady = false; selectedNodes = [];
            } else {
              selectedNodes = selected.nodes;
              for (const node of selectedNodes) if (node.sourceKind && node.sourceKind !== "compaction") {
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
            // 63: the child's path continues the parent's persisted path; before the first child entry the head is the compaction Turn.
            const inherited = this.binding.clearedFrom?.inheritedEntryIds ?? [];
            if (inherited.length && !inherited.every((id, index) => selectedEntryIds[index] === id)) selectedEntryIds = [...inherited, ...selectedEntryIds];
            this.memory.selectEntries(sessionId, branch, selectedEntryIds);
            headTurnId = [...selectedNodes].reverse().find(node => node.turnId !== undefined)?.turnId ?? this.lastResult?.headTurnId
              ?? this.binding.clearedFrom?.compactionTurnId ?? null;
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
    if (projectionReady) await this.persist(binding => binding.branch === branch && binding.selectedLeafUuid === completed.selectedLeafUuid
      ? binding : { ...binding, branch, selectedLeafUuid: completed.selectedLeafUuid });
    this.transcript.commit(completed, problems[0]);
    const state = problems.length ? "not-ready" : "ready";
    const ready = this.result(state, problems.length ? { ...completed.snapshot, problem: problems[0] } : completed.snapshot, problems,
      { coreSessionId: sessionId, branch: projectionReady ? branch : this.binding.branch,
        headTurnId: projectionReady ? headTurnId : this.lastResult?.headTurnId ?? null,
        selectedEntryIds: projectionReady ? selectedEntryIds : this.lastResult?.selectedEntryIds ?? [], appendedEntryIds });
    if (projectionReady) this.lastResult = ready;
    return ready;
  }

}

export class CcImporter {
  readonly memory: TraceMemoryFacade;
  private projection: CcProjection;
  private readonly config: ResolvedCcHostConfig;
  /** 63: every native lineage this facade has served; the source normalizer renders them all. */
  private readonly lineages = new Set<string>();
  private reopened = false;

  constructor(config: ResolvedCcHostConfig, binding: CcSessionBinding, workerDependencies: CcWorkerDependencies = {}) {
    let memory!: TraceMemoryFacade;
    const runAgent = config.worker ? createCcRunAgent(config, workerDependencies,
      kind => memory.config[kind].maxToolRounds) : undefined;
    this.lineages.add(binding.nativeSessionId);
    memory = TraceMemory(config.dbPath, runAgent ?? unavailableRunner,
      { closedSessionScope: config.closedSessionScope }, undefined,
      entry => this.lineages.has(entry.nativeLineage) ? ccSourceBlocks(entry) : undefined);
    this.memory = memory;
    this.config = config;
    this.projection = new CcProjection(config, binding, memory);
  }

  currentBinding(): CcSessionBinding { return this.projection.currentBinding(); }
  /** 63: project another native lineage of the same core session on the same facade. */
  retarget(binding: CcSessionBinding): void {
    const current = this.projection.currentBinding();
    if (binding.coreSessionId !== current.coreSessionId) throw new Error("CC importer retarget must stay on the same core session");
    this.lineages.add(binding.nativeSessionId);
    this.projection = new CcProjection(this.config, binding, this.memory);
  }
  persistedCall(toolUseId: string, toolName: "note" | "memory"): CcPersistedCall | null {
    return this.projection.persistedCall(toolUseId, toolName);
  }
  async reconcile(): Promise<CcReconcileResult> {
    const result = await this.projection.synchronize();
    if (!this.reopened && result.coreSessionId !== null && result.state !== "disabled") {
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
