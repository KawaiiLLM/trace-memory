import { randomUUID } from "node:crypto";
import { TraceMemory, type TraceMemory as TraceMemoryFacade } from "../../core/api/index.ts";
import type { SourceEntry } from "../../core/store/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { readBinding, updateBinding, type CcSessionBinding } from "./binding.ts";
import { ccSourceBlocks, classifySourceRecord, nativeCreatedAt, readCompleteTranscript, selectedNativePath,
  type CcNativeRecord, type CcTranscriptSnapshot } from "./transcript.ts";

export interface CcReconcileResult {
  state: "ready" | "disabled" | "not-ready" | "unavailable";
  snapshot: CcTranscriptSnapshot;
  coreSessionId: number | null;
  branch: string;
  headTurnId: number | null;
  selectedEntryIds: number[];
  appendedEntryIds: number[];
  problems: string[];
}

const unavailableRunner = async () => ({ outcome: "failure" as const, output: null,
  audit: { available: false as const, reason: "Claude Code workers are not part of ticket 43a" } });
const provisionalEnabled = (binding: CcSessionBinding) => binding.enrollment.choice ?? binding.enrollment.defaultEnabled;
const parentId = (record: CcNativeRecord): string | null => typeof record.logicalParentUuid === "string" ? record.logicalParentUuid
  : typeof record.parentUuid === "string" ? record.parentUuid : null;

export class CcImporter {
  readonly memory: TraceMemoryFacade;
  private readonly config: ResolvedCcHostConfig;
  private binding: CcSessionBinding;
  private reopened = false;

  constructor(config: ResolvedCcHostConfig, binding: CcSessionBinding) {
    if (binding.dbPath !== config.dbPath) throw new Error("CC binding uses another database");
    this.config = config;
    this.binding = binding;
    this.memory = TraceMemory(config.dbPath, unavailableRunner, {}, undefined,
      entry => entry.nativeLineage === binding.nativeSessionId ? ccSourceBlocks(entry) : undefined);
  }

  currentBinding(): CcSessionBinding { return this.binding; }

  private async persist(update: (binding: CcSessionBinding) => CcSessionBinding): Promise<void> {
    this.binding = await updateBinding(this.config, this.binding.nativeSessionId, current => {
      if (!current) throw new Error("CC binding disappeared");
      return update(current);
    });
  }

  private async refreshEnrollment(records: readonly CcNativeRecord[]): Promise<void> {
    if (this.binding.nativeCreatedAt !== null) return;
    const created = nativeCreatedAt(records);
    if (!created) return;
    await this.persist(binding => ({ ...binding, nativeCreatedAt: created,
      enrollment: { ...binding.enrollment, defaultEnabled: typeof this.config.baseline === "string" && Date.parse(created) > Date.parse(this.config.baseline) } }));
  }

  private async allocate(records: readonly CcNativeRecord[]): Promise<void> {
    if (this.binding.coreSessionId !== null) return;
    const firstAssistant = records.map(classifySourceRecord).find(source => source?.kind === "assistant");
    if (!firstAssistant || !firstAssistant.timestamp) return;
    const startedAt = nativeCreatedAt(records);
    if (!startedAt) return;
    await this.persist(binding => {
      if (binding.coreSessionId !== null || !provisionalEnabled(binding)) return binding;
      const host = `cc:${binding.nativeSessionId}`;
      const existing = this.memory.store.findSessionByHost(host);
      if (existing) return { ...binding, coreSessionId: existing.id, projectId: existing.projectId,
        enrollment: this.memory.store.enrollment(existing.id) };
      const projectName = `cc:${binding.nativeSessionId}`;
      const project = this.memory.store.findProjectByName(projectName) ?? this.memory.store.createProject({ name: projectName, declaredBy: "marker" });
      const session = this.memory.store.createSession({ host, startedAt, firstReplyAt: firstAssistant.timestamp!, projectId: project.id,
        projectDeclaration: "undeclared", nativeCreatedAt: startedAt, baseline: this.config.baseline, enrollmentChoice: binding.enrollment.choice });
      return { ...binding, coreSessionId: session.id, projectId: project.id, enrollment: this.memory.store.enrollment(session.id) };
    });
  }

  private ensureReopened(): void {
    if (!this.reopened && this.binding.coreSessionId !== null) {
      this.memory.store.reopenSession(this.binding.coreSessionId, this.memory.executorId);
      this.reopened = true;
    }
  }

  async reconcile(): Promise<CcReconcileResult> {
    const current = readBinding(this.config, this.binding.nativeSessionId);
    if (!current || current.dbPath !== this.config.dbPath || current.transcriptPath !== this.binding.transcriptPath)
      throw new Error("CC binding changed or disappeared before reconciliation");
    this.binding = current;
    const snapshot = readCompleteTranscript(this.binding.transcriptPath), problems: string[] = [];
    const base = (state: CcReconcileResult["state"]): CcReconcileResult => ({ state, snapshot,
      coreSessionId: this.binding.coreSessionId, branch: this.binding.branch, headTurnId: null,
      selectedEntryIds: [], appendedEntryIds: [], problems });
    if (!snapshot.exists) return base("unavailable");
    if (snapshot.problem) { problems.push(snapshot.problem); return base("not-ready"); }
    // A non-newline tail is pending native output, not an error in the completed prefix.
    // Shutdown separately requires a complete tail before it can finish reconciliation.
    await this.refreshEnrollment(snapshot.records);
    if (this.binding.coreSessionId === null ? !provisionalEnabled(this.binding) : !this.memory.store.enabled(this.binding.coreSessionId))
      return base("disabled");
    await this.allocate(snapshot.records);
    if (this.binding.coreSessionId === null) {
      if (!provisionalEnabled(this.binding)) return base("disabled");
      problems.push("first completed assistant source is not persisted yet");
      return base("not-ready");
    }
    if (!this.memory.store.enabled(this.binding.coreSessionId)) return base("disabled");
    this.ensureReopened();
    const selected = selectedNativePath(snapshot.records);
    if (selected.problem) { problems.push(selected.problem); return base("not-ready"); }
    const sessionId = this.binding.coreSessionId, lineage = this.binding.nativeSessionId;
    const byId = new Map(snapshot.records.flatMap(record => typeof record.uuid === "string" ? [[record.uuid, record] as const] : []));
    // Native append order owns E ordinals. Incomplete final records wait for a later reconciliation;
    // the importer never topologically reorders completed source evidence.
    const ordered = snapshot.records;
    const turnForNative = new Map<string, number>();
    for (const record of ordered) if (typeof record.uuid === "string") {
      const binding = this.memory.store.findNativeTurn(sessionId, lineage, record.uuid);
      if (binding) turnForNative.set(record.uuid, binding.turnId);
      else {
        const source = this.memory.store.findSourceEntry(sessionId, lineage, record.uuid);
        if (source) turnForNative.set(record.uuid, source.turnId);
      }
    }
    const nearestTurn = (record: CcNativeRecord): { turnId: number | null; resolved: boolean } => {
      const seen = new Set<string>(); let parent = parentId(record);
      while (parent) {
        if (seen.has(parent)) { problems.push(`native lineage cycle at ${parent}`); return { turnId: null, resolved: false }; }
        seen.add(parent);
        const turn = turnForNative.get(parent); if (turn !== undefined) return { turnId: turn, resolved: true };
        const ancestor = byId.get(parent);
        if (!ancestor) { problems.push(`native lineage parent ${parent} is missing`); return { turnId: null, resolved: false }; }
        parent = parentId(ancestor);
      }
      return { turnId: null, resolved: true };
    };
    const callMap = (turnId: number): Map<string, { ordinal: number; name: string }> => {
      const result = new Map<string, { ordinal: number; name: string }>();
      for (const entry of this.memory.store.listSourceEntries(sessionId, turnId))
        for (const call of entry.calls) if (!result.has(call.callId)) result.set(call.callId, { ordinal: call.ordinal, name: call.name });
      return result;
    };
    const appendedEntryIds: number[] = [];
    this.memory.store.transaction(() => {
      for (const record of ordered) {
        const source = classifySourceRecord(record);
        if (!source) continue;
        if (!source.timestamp) throw new Error(`native source ${source.nativeId} has no valid timestamp`);
        const knownEntry = source.kind === "compaction" ? null : this.memory.store.findSourceEntry(sessionId, lineage, source.nativeId);
        if (knownEntry) {
          if (knownEntry.raw !== JSON.stringify(record)) throw new Error(`native source ${source.nativeId} changed after persistence`);
          turnForNative.set(source.nativeId, knownEntry.turnId);
          if (source.kind === "user" && !this.memory.store.findNativeTurn(sessionId, lineage, source.nativeId))
            this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, knownEntry.turnId, "turn");
          continue;
        }
        if (source.kind === "compaction") {
          const known = this.memory.store.findNativeTurn(sessionId, lineage, source.nativeId);
          if (known) {
            const turn = this.memory.store.getTurn(known.turnId), parent = nearestTurn(record);
            if (!parent.resolved) { problems.push(`owning parent Turn for native compaction ${source.nativeId} is unavailable`); continue; }
            if (!turn || turn.kind !== "compaction" || turn.parentTurnId !== parent.turnId || turn.startedAt !== source.timestamp)
              throw new Error(`native compaction ${source.nativeId} changed after persistence`);
            turnForNative.set(source.nativeId, known.turnId); continue;
          }
          const parent = nearestTurn(record);
          if (!parent.resolved) { problems.push(`owning parent Turn for native compaction ${source.nativeId} is unavailable`); continue; }
          const turn = this.memory.store.appendTurn({ sessionId, parentTurnId: parent.turnId, kind: "compaction",
            startedAt: source.timestamp, endedAt: source.timestamp });
          this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, turn.id, "compaction");
          turnForNative.set(source.nativeId, turn.id);
          continue;
        }
        let turnId: number | null;
        if (source.kind === "user") {
          const parent = nearestTurn(record);
          if (!parent.resolved) { problems.push(`owning parent Turn for native user source ${source.nativeId} is unavailable`); continue; }
          turnId = this.memory.store.appendTurn({ sessionId, parentTurnId: parent.turnId, kind: "turn",
            userPrompt: source.text, startedAt: source.timestamp }).id;
          this.memory.store.bindNativeTurn(sessionId, lineage, source.nativeId, turnId, "turn");
          turnForNative.set(source.nativeId, turnId);
        } else {
          const parent = nearestTurn(record); turnId = parent.turnId;
          if (!parent.resolved || turnId === null || this.memory.store.getTurn(turnId)?.kind !== "turn") {
            problems.push(`owning user Turn for native source ${source.nativeId} is unavailable`);
            continue;
          }
        }
        const calls = callMap(turnId);
        const fragments: SourceEntry["calls"] = [];
        if (source.kind === "assistant") for (const call of source.calls) {
          if (calls.has(call.callId)) throw new Error(`native tool call ${call.callId} repeats within one Turn`);
          const stored = this.memory.store.appendToolCall({ turnId, name: call.name, input: call.input, status: call.status });
          calls.set(call.callId, { ordinal: stored.ordinal, name: stored.name });
          fragments.push({ ...call, ordinal: stored.ordinal });
        }
        if (source.kind === "toolResult") {
          for (const call of source.calls) {
            const offered = calls.get(call.callId);
            if (!offered) { problems.push(`tool result ${call.callId} has no call in its owning Turn`); continue; }
            fragments.push({ ...call, ordinal: offered.ordinal, name: offered.name });
          }
          if (fragments.length !== source.calls.length) continue;
          for (const call of fragments) this.memory.store.completeToolCall(turnId, call.ordinal, call.result ?? "", call.status);
        }
        const stored = this.memory.appendEntry({ sessionId, nativeLineage: lineage, nativeId: source.nativeId, turnId,
          role: source.kind, text: source.text, raw: JSON.stringify(record), calls: fragments });
        appendedEntryIds.push(stored.id);
        turnForNative.set(source.nativeId, turnId);
        if (source.kind === "assistant") {
          const turn = this.memory.store.getTurn(turnId)!;
          this.memory.store.updateTurn(turnId, { assistantText: [turn.assistantText, source.text].filter(Boolean).join("\n"), endedAt: source.timestamp });
        }
      }
    });
    if (problems.length) {
      const priorEntries = this.binding.selectedPathUuids.flatMap(id => {
        const entry = this.memory.store.findSourceEntry(sessionId, lineage, id); return entry ? [entry] : [];
      });
      return { state: "not-ready", snapshot, coreSessionId: sessionId, branch: this.binding.branch,
        headTurnId: priorEntries.at(-1)?.turnId ?? null, selectedEntryIds: priorEntries.map(entry => entry.id), appendedEntryIds, problems };
    }
    const selectedEntries = selected.records.flatMap(record => typeof record.uuid === "string"
      ? [this.memory.store.findSourceEntry(sessionId, lineage, record.uuid)].filter((entry): entry is SourceEntry => entry !== null) : []);
    const selectedPathUuids = selected.records.flatMap(record => typeof record.uuid === "string" ? [record.uuid] : []);
    let branch = this.binding.branch;
    const prior = this.binding.selectedPathUuids;
    if (prior.length && !(prior.length <= selectedPathUuids.length && prior.every((id, index) => selectedPathUuids[index] === id))) branch = randomUUID();
    this.memory.selectEntries(sessionId, branch, selectedEntries.map(entry => entry.id));
    const headTurnId = [...selected.records].reverse().map(record => typeof record.uuid === "string" ? turnForNative.get(record.uuid) : undefined)
      .find((value): value is number => value !== undefined) ?? null;
    await this.persist(binding => binding.branch === branch && binding.selectedLeafUuid === selected.leafUuid &&
      binding.selectedPathUuids.length === selectedPathUuids.length && binding.selectedPathUuids.every((id, index) => id === selectedPathUuids[index])
      ? binding : { ...binding, branch, selectedLeafUuid: selected.leafUuid, selectedPathUuids });
    return { state: "ready", snapshot, coreSessionId: sessionId, branch, headTurnId,
      selectedEntryIds: selectedEntries.map(entry => entry.id), appendedEntryIds, problems };
  }

  close(): void { this.memory.close(); }
}

export function openBoundImporter(config: ResolvedCcHostConfig, nativeSessionId: string): CcImporter | null {
  const binding = readBinding(config, nativeSessionId);
  return binding ? new CcImporter(config, binding) : null;
}
