import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { TraceMemory, knowledgeStateKey, noVisibility, type Injection, type KnowledgeStateReceipt, type VisibleView } from "../../core/api/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { coreHostOf, implicitCcProject, readBinding, sessionEnabled, updateBinding, type CcHookInput, type CcSessionBinding } from "./binding.ts";
import { CcProjection } from "./importer.ts";
import { ccSourceBlocks, classifySourceRecord, nativeParentId, readCompleteTranscript, selectedNativePath, type CcNativeRecord } from "./transcript.ts";

const BEGIN = "TRACE MEMORY KNOWLEDGE: If this is a file reference, read the file before proceeding.";
const HEADER = "TRACE-MEMORY-CC/1 ";
const END = "TRACE MEMORY KNOWLEDGE END";
const digest = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
// Unlike Pi's path identity, dev:inode invalidates old envelopes after any file replacement,
// including backup restore, and conservatively causes the next occurrence to reinject.
export const databaseIdentity = (path: string): string => { const stat = statSync(path); return `${stat.dev}:${stat.ino}`; };
const positiveId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export interface CcVisibleBinding { db: string; nativeSession: string; coreSession: number | null }
interface EnvelopeHeader {
  db: string;
  native: string;
  core: number | null;
  commits: number[];
  states: KnowledgeStateReceipt[];
  sha256: string;
}
interface WireHeader { d: string; n: string; s: number | null; k: number[]; r: string[]; h: string }
export interface CcHookOutput { hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
  /** 73 "Truncation is announced in the foreground": Claude Code 2.1.280's hook runner turns this
   * top-level field into a user-visible `hook_system_message`, capped at 4,000 characters. Present
   * only when `/clear`'s compaction omitted unprocessed material. */
  systemMessage?: string }

const identityCount = (injection: Injection): number => injection.knowledgeCommitIds.length +
  (injection.knowledgeStates ?? []).reduce((count, state) => count + 1 + state.toCommits.length, 0);

/** Encode exactly one core block. The host envelope is outside core's allowance but has its own bound. */
export function encodeCcInjection(binding: CcVisibleBinding, injection: Injection): string {
  const header: WireHeader = { d: binding.db, n: binding.nativeSession, s: binding.coreSession,
    k: injection.knowledgeCommitIds, r: (injection.knowledgeStates ?? []).map(knowledgeStateKey), h: digest(injection.text) };
  const framing = `${BEGIN}\n${HEADER}${JSON.stringify(header)}\n\n${END}`;
  const bound = 300 + 12 * identityCount(injection);
  if (framing.length > bound) throw new Error(`CC injection envelope exceeds its ${bound}-character host framing bound`);
  return `${BEGIN}\n${HEADER}${JSON.stringify(header)}\n${injection.text}\n${END}`;
}

function decodeCcInjection(content: unknown, binding: CcVisibleBinding): EnvelopeHeader | null {
  if (typeof content !== "string") return null;
  const prefix = `${BEGIN}\n${HEADER}`, suffix = `\n${END}`;
  if (!content.startsWith(prefix) || !content.endsWith(suffix)) return null;
  const headerEnd = content.indexOf("\n", prefix.length);
  if (headerEnd < 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(content.slice(prefix.length, headerEnd)); } catch { return null; }
  if (!object(parsed) || Object.keys(parsed).sort().join(",") !== "d,h,k,n,r,s" ||
      typeof parsed.d !== "string" || typeof parsed.n !== "string" ||
      !(parsed.s === null || positiveId(parsed.s)) || typeof parsed.h !== "string" || !/^[0-9a-f]{64}$/.test(parsed.h) ||
      !Array.isArray(parsed.k) || !parsed.k.every(positiveId) || new Set(parsed.k).size !== parsed.k.length ||
      !Array.isArray(parsed.r) || !parsed.r.every(value => typeof value === "string" && /^[1-9]\d*>[1-9]\d*(?:,[1-9]\d*)*$/.test(value))) return null;
  const states = (parsed.r as string[]).map(value => { const [from, to] = value.split(">");
    return { fromCommit: Number(from), toCommits: to!.split(",").map(Number) }; });
  if (!states.every(state => positiveId(state.fromCommit) && state.toCommits.every(positiveId))) return null;
  if (parsed.d !== binding.db || parsed.n !== binding.nativeSession) return null;
  if (!(parsed.s === binding.coreSession || parsed.s === null && binding.coreSession !== null)) return null;
  const body = content.slice(headerEnd + 1, -suffix.length);
  if (digest(body) !== parsed.h) return null;
  return { db: parsed.d, native: parsed.n, core: parsed.s, commits: parsed.k as number[], states, sha256: parsed.h };
}

const attachmentContents = (record: CcNativeRecord): unknown[] => {
  if (record.type !== "attachment" || record.isSidechain === true || !object(record.attachment) ||
      record.attachment.type !== "hook_additional_context" || record.attachment.hookEvent !== "SessionStart" ||
      !Array.isArray(record.attachment.content)) return [];
  return record.attachment.content;
};

function compactPreserved(record: CcNativeRecord): string[] | null {
  if (record.type !== "system" || record.subtype !== "compact_boundary") return null;
  const metadata = object(record.compactMetadata) ? record.compactMetadata : null;
  const messages = metadata && object(metadata.preservedMessages) ? metadata.preservedMessages : null;
  if (!messages || !Array.isArray(messages.uuids) || !messages.uuids.every((id: unknown) => typeof id === "string" && id))
    throw new Error(`native compact boundary ${String(record.uuid)} has invalid preservedMessages`);
  return messages.uuids;
}

interface NativeSelection { leafUuid: string | null; records: CcNativeRecord[]; problem?: string }
interface NativePreservation { boundary: CcNativeRecord; anchor: CcNativeRecord; preserved: string[]; head: string; tail: string }

/** Validate the native preservation description without deciding whether this boundary owns the
 * selected context. Abandoned siblings are allowed to remain in the physical file. */
function nativePreservation(record: CcNativeRecord, byId: ReadonlyMap<string, CcNativeRecord>): NativePreservation | null {
  if (record.type !== "system" || record.subtype !== "compact_boundary" || typeof record.uuid !== "string") return null;
  const metadata = object(record.compactMetadata) ? record.compactMetadata : null;
  const segment = metadata && object(metadata.preservedSegment) ? metadata.preservedSegment : null;
  const messages = metadata && object(metadata.preservedMessages) ? metadata.preservedMessages : null;
  const preserved = messages?.uuids, anchorId = messages?.anchorUuid, head = segment?.headUuid, tail = segment?.tailUuid;
  if (!Array.isArray(preserved) || !preserved.length || !preserved.every(id => typeof id === "string" && id) ||
      typeof anchorId !== "string" || !anchorId || typeof head !== "string" || typeof tail !== "string" ||
      preserved[0] !== head || preserved.at(-1) !== tail || record.logicalParentUuid !== tail || record.parentUuid !== null)
    return null;
  const anchor = byId.get(anchorId);
  if (!anchor || nativeParentId(anchor) !== record.uuid) return null;
  for (let index = 0; index < preserved.length; index++) {
    const retained = byId.get(preserved[index]!);
    if (!retained || index > 0 && nativeParentId(retained) !== preserved[index - 1]) return null;
  }
  return { boundary: record, anchor, preserved: preserved as string[], head, tail };
}

/** CC may copy a compacted context by putting the preserved head after a summary anchor while the
 * boundary still names the preserved tail as its logical parent. Break only that fully validated
 * host retention cycle; source/evidence ancestry keeps its original strict resolver. */
function selectedRetentionPath(records: readonly CcNativeRecord[]): NativeSelection {
  const ordinary = selectedNativePath(records);
  if (!ordinary.problem?.startsWith("native lineage cycle at ")) return ordinary;
  const byId = new Map(records.flatMap(record => typeof record.uuid === "string" && record.uuid
    ? [[record.uuid, record] as const] : []));
  const projectedBoundaries = new Set<string>();
  const projected = records.map(record => {
    const shape = nativePreservation(record, byId);
    if (!shape || nativeParentId(byId.get(shape.head)!) !== shape.anchor.uuid) return record;
    projectedBoundaries.add(record.uuid as string);
    return { ...record, logicalParentUuid: undefined, parentUuid: null };
  });
  const selected = selectedNativePath(projected);
  if (selected.problem || !selected.records.some(record => typeof record.uuid === "string" && projectedBoundaries.has(record.uuid))) return ordinary;
  return { leafUuid: selected.leafUuid, records: selected.records.map(record => byId.get(record.uuid as string)!) };
}

const hasKnowledgeAttachment = (record: CcNativeRecord): boolean => attachmentContents(record).length > 0;

/** Extend an authoritative source path only through the one retained Hook-carrier tail. A physical
 * suffix or a shared ancestor is not branch authority. */
function retainedTail(records: readonly CcNativeRecord[], roots: Set<string>, after: number): Set<string> {
  const positions = new Map<string, number>();
  records.forEach((record, index) => { if (typeof record.uuid === "string" && record.uuid) positions.set(record.uuid, index); });
  const eligible = new Map<string, CcNativeRecord>();
  for (let index = after + 1; index < records.length; index++) {
    const record = records[index]!;
    if (typeof record.uuid === "string" && record.uuid && record.isSidechain !== true) eligible.set(record.uuid, record);
  }
  const carrierPaths: string[][] = [];
  for (const record of eligible.values()) {
    if (!hasKnowledgeAttachment(record)) continue;
    const path: string[] = [], seen = new Set<string>();
    let current: CcNativeRecord | undefined = record;
    while (current && typeof current.uuid === "string" && !roots.has(current.uuid)) {
      if (seen.has(current.uuid)) throw new Error(`native retained tail cycle at ${current.uuid}`);
      seen.add(current.uuid); path.push(current.uuid);
      const parent = nativeParentId(current);
      if (parent === null) break;
      current = eligible.get(parent);
      if (!current && roots.has(parent)) break;
    }
    const parent = path.length ? nativeParentId(eligible.get(path.at(-1)!)!) : null;
    if (path.length && parent !== null && roots.has(parent)) carrierPaths.push(path.reverse());
  }
  if (!carrierPaths.length) return new Set();
  carrierPaths.sort((left, right) => left.length - right.length || (positions.get(left.at(-1)!)! - positions.get(right.at(-1)!)!));
  const chosen = carrierPaths.at(-1)!;
  for (const path of carrierPaths) if (!path.every((id, index) => chosen[index] === id))
    throw new Error("native retained context has ambiguous Hook-carrier tails");
  return new Set(chosen);
}

function selectedPreservation(records: readonly CcNativeRecord[], selected: NativeSelection,
  byId: ReadonlyMap<string, CcNativeRecord>): { shape: NativePreservation; index: number; retainedStart: number } | null {
  const selectedIndex = new Map(selected.records.map((record, index) => [record.uuid as string, index]));
  const candidates: { shape: NativePreservation; index: number; retainedStart: number }[] = [];
  for (const record of records) {
    if (record.type !== "system" || record.subtype !== "compact_boundary" || typeof record.uuid !== "string") continue;
    const onPath = selectedIndex.get(record.uuid);
    const shape = nativePreservation(record, byId);
    if (onPath !== undefined) {
      if (!shape) {
        const preserved = compactPreserved(record);
        for (const id of preserved!) if (!byId.has(id))
          throw new Error(`native compact boundary ${record.uuid} preserves missing record ${id}`);
        throw new Error(`native compact boundary ${record.uuid} has inconsistent preservation metadata`);
      }
      candidates.push({ shape, index: onPath, retainedStart: onPath + 1 });
      continue;
    }
    if (!shape || typeof shape.anchor.promptId !== "string" || !shape.anchor.promptId) continue;
    // Manual /compact continues from the preserved tail rather than the boundary. The summary anchor
    // and the non-source continuation share the native prompt identity, while ancestry proves the
    // continuation belongs to the selected path. Prompt identity alone is never occurrence authority.
    const continuation = selected.records.find(candidate => candidate.uuid !== record.uuid &&
      !shape.preserved.includes(candidate.uuid as string) && candidate.promptId === shape.anchor.promptId &&
      classifySourceRecord(candidate) === null && nativeParentId(candidate) === shape.tail);
    if (continuation) {
      const index = selectedIndex.get(continuation.uuid as string)!;
      candidates.push({ shape, index, retainedStart: index });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((left, right) => left.index - right.index);
  const chosen = candidates.at(-1)!;
  if (candidates.some(candidate => candidate !== chosen && candidate.index === chosen.index &&
      candidate.shape.boundary.uuid !== chosen.shape.boundary.uuid))
    throw new Error("native retained context has ambiguous compact boundaries");
  return chosen;
}

/** Select what native CC actually retains. Evidence chooses the live branch; validated preservation
 * metadata replaces the pre-boundary portion of that ancestry. Neither a shared UUID nor physical
 * recency can grant an abandoned boundary authority. */
export function selectedCcVisibleRecords(records: readonly CcNativeRecord[]): CcNativeRecord[] {
  const selected = selectedRetentionPath(records);
  if (selected.problem) throw new Error(selected.problem);
  if (!selected.leafUuid) return [];
  const positions = new Map<string, number>();
  const byId = new Map<string, CcNativeRecord>();
  records.forEach((record, index) => {
    if (typeof record.uuid === "string" && record.uuid) { positions.set(record.uuid, index); byId.set(record.uuid, record); }
  });
  const selectedIds = new Set(selected.records.map(record => record.uuid as string));
  const preservation = selectedPreservation(records, selected, byId);
  const retained = new Set<string>();
  if (preservation) {
    for (const id of preservation.shape.preserved) retained.add(id);
    retained.add(preservation.shape.boundary.uuid as string);
    for (const record of selected.records.slice(preservation.retainedStart)) retained.add(record.uuid as string);
  } else for (const id of selectedIds) retained.add(id);
  const tail = retainedTail(records, retained, positions.get(selected.leafUuid)!);
  for (const id of tail) retained.add(id);
  return records.filter(record => typeof record.uuid === "string" && retained.has(record.uuid));
}

export function ccVisibleView(records: readonly CcNativeRecord[], binding: CcVisibleBinding): VisibleView {
  const view = noVisibility();
  for (const record of selectedCcVisibleRecords(records)) {
    const source = classifySourceRecord(record);
    if (source && source.kind !== "compaction") view.raw.set(source.nativeId, "source");
    for (const content of attachmentContents(record)) {
      const envelope = decodeCcInjection(content, binding);
      if (!envelope) continue;
      for (const commit of envelope.commits) view.knowledgeCommitIds.add(commit);
      for (const state of envelope.states) (view.knowledgeStates ??= new Set()).add(knowledgeStateKey(state));
    }
  }
  return view;
}

const enabled = (binding: CcSessionBinding, memory: ReturnType<typeof TraceMemory>): boolean => sessionEnabled(binding, memory.store);

async function lockedInjectionBinding(config: ResolvedCcHostConfig, nativeSessionId: string,
  transcriptPath: string, memory: ReturnType<typeof TraceMemory>): Promise<CcSessionBinding> {
  return updateBinding(config, nativeSessionId, current => {
    if (!current || current.dbPath !== config.dbPath || current.transcriptPath !== transcriptPath)
      throw new Error("CC binding changed while preparing injection");
    if (!enabled(current, memory)) return current;
    if (current.coreSessionId !== null) {
      const session = memory.store.getSession(current.coreSessionId);
      if (!session || session.host !== coreHostOf(current) || session.projectId !== current.projectId)
        throw new Error("bound Claude Code core session or project disagrees with the database");
      return current;
    }
    if (current.projectId !== null) {
      if (!memory.store.getProject(current.projectId)) throw new Error("bound Claude Code project is unavailable");
      return current;
    }
    const project = implicitCcProject(memory.store, current.nativeSessionId);
    return { ...current, projectId: project.id };
  });
}

/** Read-only Knowledge selection for one SessionStart occurrence. Binding/project enrollment are the
 * only durable writes; this facade starts no importer, scheduler, worker, or executor loop. */
export async function ccSessionStartInjection(config: ResolvedCcHostConfig, input: CcHookInput): Promise<CcHookOutput | null> {
  if (!input.source || !(["startup", "resume", "clear", "compact"] as const).includes(input.source))
    throw new Error("SessionStart source must be startup, resume, clear or compact");
  const initial = readBinding(config, input.session_id);
  if (!initial) throw new Error("CC SessionStart binding is unavailable after enrollment");
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC injection Hook cannot run model work"); },
    config.coreConfig, undefined, entry => entry.nativeLineage === initial.nativeSessionId ? ccSourceBlocks(entry) : undefined);
  try {
    let binding = await lockedInjectionBinding(config, initial.nativeSessionId, initial.transcriptPath, memory);
    if (!enabled(binding, memory)) return null;
    const projection = new CcProjection(config, binding, memory);
    const projected = await projection.synchronize();
    binding = projection.currentBinding();
    if (projected.state === "disabled") return null;
    if (projected.state === "not-ready")
      throw new Error(projected.problems.join("; ") || "native source projection is not ready");
    const snapshot = readCompleteTranscript(binding.transcriptPath);
    if (snapshot.problem || snapshot.incompleteBytes)
      throw new Error(snapshot.problem ?? `native transcript has ${snapshot.incompleteBytes} incomplete trailing bytes`);
    const core = binding.coreSessionId;
    let target: { projectId: number } | { sessionId: number; branch: string; headTurnId: number };
    if (core === null) {
      if (binding.projectId === null) throw new Error("provisional Claude Code project is unavailable");
      target = { projectId: binding.projectId };
    } else {
      const session = memory.store.getSession(core);
      if (!session || session.host !== coreHostOf(binding) || session.projectId !== binding.projectId)
        throw new Error("bound Claude Code core session or project disagrees with the database");
      if (!snapshot.exists) throw new Error("native transcript is unavailable for an allocated Claude Code session");
      const selected = selectedNativePath(snapshot.records);
      if (selected.problem) throw new Error(selected.problem);
      if (!selected.leafUuid || selected.leafUuid !== binding.selectedLeafUuid)
        throw new Error("native selected source disagrees with the persisted Claude Code binding");
      const entry = memory.store.findSourceEntry(core, binding.nativeSessionId, selected.leafUuid);
      const turn = memory.store.findNativeTurn(core, binding.nativeSessionId, selected.leafUuid);
      const headTurnId = entry?.turnId ?? turn?.turnId;
      if (!headTurnId) throw new Error("native selected source has no persisted core Turn");
      target = { sessionId: core, branch: binding.branch, headTurnId };
    }
    const visibleBinding = { db: databaseIdentity(config.dbPath), nativeSession: binding.nativeSessionId, coreSession: core };
    const visible = input.source === "compact" ? noVisibility() : ccVisibleView(snapshot.records, visibleBinding);
    const injection = memory.injection(target, visible);
    if (!injection.text) return null;
    const additionalContext = encodeCcInjection(visibleBinding, injection);
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } };
  } finally {
    // SessionStart owns no executor or claim. Closing its Store directly avoids invalidating work
    // owned by the concurrently running MCP process after projection-only synchronization.
    memory.store.close();
  }
}
