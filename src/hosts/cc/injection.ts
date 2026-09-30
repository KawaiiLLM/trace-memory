import { createHash, randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { TraceMemory, deliveredView, knowledgeStateKey, noVisibility, type DeliveryNode, type DeliveryPart, type DeliveryTarget,
  type Injection, type KnowledgeStateReceipt, type PendingNode, type TruncationReceipt, type VisibleView } from "../../core/api/index.ts";
import type { TransportItem } from "../../core/render/material.ts";
import type { KnowledgePath, Store } from "../../core/store/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { coreHostOf, dropLostCoreSession, implicitCcProject, readBinding, sessionEnabled, updateBinding, type CcHookInput, type CcSessionBinding } from "./binding.ts";
import { CC_AUTO_CONTINUE_SUFFIX, CC_INJECTION_BEGIN, CC_INJECTION_HEADER, COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX, ccResultText, ccSourceBlocks, readTranscriptTail, tailNodes } from "./transcript.ts";
import { CcProjection } from "./importer.ts";
import { executorLiveness } from "./control.ts";
import { ccPluginToolNames } from "./tool-names.ts";

export { CC_INJECTION_BEGIN, CC_INJECTION_HEADER };
const BEGIN = CC_INJECTION_BEGIN;
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
  factIds: number[];
  entryIds: number[];
  slice: readonly [number, number] | null;
  sha256: string;
  knowledgeTokens?: number;
}
interface WireHeader { d: string; n: string; s: number | null; k: number[]; r: string[]; h: string; t?: number; f?: number[]; e?: number[]; p?: [number, number] }
export interface CcInjectionPayload extends Injection { factIds?: number[]; entryIds?: number[]; slice?: [number, number] }
export interface CcHookOutput { hookSpecificOutput: { hookEventName: "SessionStart"; additionalContext: string };
  /** Internal structured material for the 66 inline-slice transport; never pass to native Hook JSON. */
  transportItems?: TransportItem[];
  transportKnowledgeAllowance?: number;
  /** 73 "Truncation is announced in the foreground": Claude Code 2.1.280's hook runner turns this
   * top-level field into a user-visible `hook_system_message`, capped at 4,000 characters. Present
   * only when a slice's transport omitted pending material. */
  systemMessage?: string }

type InjectionMembership = Omit<CcInjectionPayload, "text">;
const identityCount = (injection: InjectionMembership): number => injection.knowledgeCommitIds.length +
  (injection.knowledgeStates ?? []).reduce((count, state) => count + 1 + state.toCommits.length, 0) +
  (injection.factIds?.length ?? 0) + (injection.entryIds?.length ?? 0);

/** Shared framing for actual encoding and exact UTF-16 capacity measurement. */
function injectionFrame(binding: CcVisibleBinding, injection: InjectionMembership, hash: string): string {
  if (injection.knowledgeTokens !== undefined && (!Number.isSafeInteger(injection.knowledgeTokens) || injection.knowledgeTokens < 0))
    throw new Error("invalid Knowledge accounting metadata");
  const header: WireHeader = { d: binding.db, n: binding.nativeSession, s: binding.coreSession,
    ...(injection.knowledgeTokens === undefined ? {} : { t: injection.knowledgeTokens }),
    k: injection.knowledgeCommitIds, r: (injection.knowledgeStates ?? []).map(knowledgeStateKey), h: hash,
    ...(injection.factIds === undefined ? {} : { f: injection.factIds }),
    ...(injection.entryIds === undefined ? {} : { e: injection.entryIds }),
    ...(injection.slice === undefined ? {} : { p: injection.slice }) };
  const framing = `${BEGIN}\n${CC_INJECTION_HEADER}${JSON.stringify(header)}\n\n${END}`;
  const bound = 300 + (injection.knowledgeTokens === undefined ? 0 : 22) + (injection.slice ? 16 : 0) + 12 * identityCount(injection);
  if (framing.length > bound) throw new Error(`CC injection envelope exceeds its ${bound}-character host framing bound`);
  return framing;
}

/** Measure only: a digest always occupies 64 ASCII characters; no synthetic hash is emitted. */
export function ccInjectionLength(binding: CcVisibleBinding, injection: InjectionMembership, textLength: number): number {
  return injectionFrame(binding, injection, "0".repeat(64)).length + textLength;
}

/** Encode exactly one core block. The host envelope is outside core's allowance but has its own bound. */
export function encodeCcInjection(binding: CcVisibleBinding, injection: CcInjectionPayload): string {
  const frame = injectionFrame(binding, injection, digest(injection.knowledgeTokens === undefined
    ? injection.text : JSON.stringify([injection.knowledgeTokens, injection.text])));
  const boundary = frame.length - END.length - 1;
  return frame.slice(0, boundary) + injection.text + frame.slice(boundary);
}

/** Identity-only decoding is shared with native previews whose original file no longer exists.
 * It never claims body integrity; complete carriers must use decodeCcInjection below. */
export function decodeCcInjectionHeader(content: unknown, binding: CcVisibleBinding): EnvelopeHeader | null {
  if (typeof content !== "string") return null;
  const prefix = `${BEGIN}\n${CC_INJECTION_HEADER}`;
  if (!content.startsWith(prefix)) return null;
  const headerEnd = content.indexOf("\n", prefix.length);
  if (headerEnd < 0) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(content.slice(prefix.length, headerEnd)); } catch { return null; }
  const keys = object(parsed) ? Object.keys(parsed).filter(key => key !== "t").sort().join(",") : "";
  if (!object(parsed) || (keys !== "d,h,k,n,r,s" && keys !== "d,e,f,h,k,n,r,s" && keys !== "d,e,f,h,k,n,p,r,s") ||
      (Object.hasOwn(parsed, "t") && (!Number.isSafeInteger(parsed.t) || Number(parsed.t) < 0)) ||
      typeof parsed.d !== "string" || typeof parsed.n !== "string" ||
      !(parsed.s === null || positiveId(parsed.s)) || typeof parsed.h !== "string" || !/^[0-9a-f]{64}$/.test(parsed.h) ||
      !Array.isArray(parsed.k) || !parsed.k.every(positiveId) || new Set(parsed.k).size !== parsed.k.length ||
      (keys !== "d,h,k,n,r,s" && (!Array.isArray(parsed.f) || !parsed.f.every(positiveId) || new Set(parsed.f).size !== parsed.f.length ||
        !Array.isArray(parsed.e) || !parsed.e.every(positiveId) || new Set(parsed.e).size !== parsed.e.length)) ||
      (keys === "d,e,f,h,k,n,p,r,s" && (!Array.isArray(parsed.p) || parsed.p.length !== 2 ||
        !Number.isSafeInteger(parsed.p[0]) || parsed.p[0] < 0 || parsed.p[0] >= parsed.p[1] || parsed.p[1] !== 24)) ||
      !Array.isArray(parsed.r) || !parsed.r.every(value => typeof value === "string" && /^[1-9]\d*>[1-9]\d*(?:,[1-9]\d*)*$/.test(value))) return null;
  const states = (parsed.r as string[]).map(value => { const [from, to] = value.split(">");
    return { fromCommit: Number(from), toCommits: to!.split(",").map(Number) }; });
  if (!states.every(state => positiveId(state.fromCommit) && state.toCommits.every(positiveId))) return null;
  if (parsed.d !== binding.db || parsed.n !== binding.nativeSession) return null;
  if (!(parsed.s === binding.coreSession || parsed.s === null && binding.coreSession !== null)) return null;
  return { db: parsed.d, native: parsed.n, core: parsed.s, commits: parsed.k as number[], states,
    ...(Object.hasOwn(parsed, "t") ? { knowledgeTokens: parsed.t as number } : {}),
    factIds: keys !== "d,h,k,n,r,s" ? parsed.f as number[] : [],
    entryIds: keys !== "d,h,k,n,r,s" ? parsed.e as number[] : [],
    slice: keys === "d,e,f,h,k,n,p,r,s" ? parsed.p as [number, number] : null, sha256: parsed.h };
}

export function decodeCcInjection(content: unknown, binding: CcVisibleBinding): EnvelopeHeader | null {
  const header = decodeCcInjectionHeader(content, binding), suffix = `\n${END}`;
  if (!header || typeof content !== "string" || !content.endsWith(suffix)) return null;
  const headerEnd = content.indexOf("\n", `${BEGIN}\n${CC_INJECTION_HEADER}`.length);
  const body = content.slice(headerEnd + 1, -suffix.length);
  return digest(header.knowledgeTokens === undefined ? body : JSON.stringify([header.knowledgeTokens, body])) === header.sha256 ? header : null;
}

type Memory = ReturnType<typeof TraceMemory>;
const enabled = (binding: CcSessionBinding, memory: Memory): boolean => sessionEnabled(binding, memory.store);

async function lockedInjectionBinding(config: ResolvedCcHostConfig, nativeSessionId: string,
  transcriptPath: string, memory: Memory): Promise<CcSessionBinding> {
  return updateBinding(config, nativeSessionId, current => {
    if (!current || current.dbPath !== config.dbPath || current.transcriptPath !== transcriptPath)
      throw new Error("CC binding changed while preparing injection");
    // 84 edge case: a rollback that reaches back before this native session's own core session was
    // created still leaves the binding naming it; drop it and fall through below exactly as a
    // not-yet-registered binding. The executor's import re-allocates a core session for it.
    current = dropLostCoreSession(current, memory.store);
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

/** Enrollment and the provisional project are the only binding writes an injection makes. A
 * binding that needs neither is read without the lock the executor's import holds. */
async function injectionBinding(config: ResolvedCcHostConfig, initial: CcSessionBinding, memory: Memory): Promise<CcSessionBinding> {
  const settled = dropLostCoreSession(initial, memory.store) === initial &&
    (!enabled(initial, memory) || initial.coreSessionId !== null || initial.projectId !== null && !!memory.store.getProject(initial.projectId));
  return settled ? initial : lockedInjectionBinding(config, initial.nativeSessionId, initial.transcriptPath, memory);
}

export type CcDeliveryEvent = { kind: "session-start" } | { kind: "prompt"; promptId: string } | { kind: "compact" };

type DeliveryAt = Pick<DeliveryTarget, "turnId" | "nodeKey" | "follows">;

/** 97: the head node of one native session, from the database and the binding. Only records
 * written after the stored leaf are read: they may hold prompts and compactions the executor has
 * not imported. `at()` is where a publication to the head node is recorded; `following()` is the
 * node of a compaction written now, after the last source record. */
export function ccDeliveryHead(binding: CcSessionBinding, memory: Memory): { owner: string; node: DeliveryNode;
  at: () => DeliveryAt; following: () => DeliveryAt; target: KnowledgePath | { projectId: number } } {
  const owner = coreHostOf(binding), core = binding.coreSessionId, store = memory.store;
  const unanchored = (): never => { throw new Error("a compaction with no source record before it holds no delivery"); };
  const head = (headTurnId: number | null, tail: ReturnType<typeof tailNodes>, leaf: string | null,
    target: KnowledgePath | { projectId: number }) => {
    const pending: PendingNode[] = tail.nodes.map(node => "prompt" in node ? { key: node.prompt }
      : { key: node.follows === null ? null : store.compactionDeliveryKey(owner, node.follows), compaction: true });
    const last = tail.nodes.at(-1);
    return { owner, node: { owner, sessionId: core, ...(core === null ? {} : { branch: binding.branch }), headTurnId, pending },
      at: (): DeliveryAt => !last ? headTurnId === null ? {} : { turnId: headTurnId }
        : "prompt" in last ? { nodeKey: last.prompt }
        : { nodeKey: pending.at(-1)!.key ?? randomUUID(), follows: last.follows ?? unanchored() },
      following: (): DeliveryAt => ({ nodeKey: randomUUID(), follows: leaf ?? unanchored() }), target };
  };
  if (core === null) {
    if (binding.projectId === null) throw new Error("provisional Claude Code project is unavailable");
    // Before allocation nothing is imported: the nodes on the path are those the transcript holds.
    const tail = tailNodes(readTranscriptTail(binding.transcriptPath, 0) ?? []);
    return head(null, tail, tail.leaf, { projectId: binding.projectId });
  }
  const session = store.getSession(core);
  if (!session || session.host !== owner || session.projectId !== binding.projectId)
    throw new Error("bound Claude Code core session or project disagrees with the database");
  const turnOf = (uuid: string) => store.findSourceEntry(core, binding.nativeSessionId, uuid)?.turnId
    ?? store.findNativeTurn(core, binding.nativeSessionId, uuid)?.turnId;
  // 63: a native session linked by a clear before 102 continues from the compaction it appended.
  const root = binding.clearedFrom?.compactionTurnId ?? null;
  let headTurnId: number | null = root;
  if (binding.selectedLeafUuid !== null) {
    headTurnId = binding.selectedHeadTurnId ?? turnOf(binding.selectedLeafUuid) ?? null;
    if (headTurnId === null) throw new Error("native selected source has no persisted core Turn");
  }
  let tail: ReturnType<typeof tailNodes> = { nodes: [], exit: null, leaf: null };
  const offset = binding.selectedLeafUuid === null ? 0 : binding.transcriptOffset;
  if (offset !== undefined) {
    tail = tailNodes(readTranscriptTail(binding.transcriptPath, offset) ?? []);
    if (tail.leaf !== null && tail.exit !== binding.selectedLeafUuid) {
      // The executor has not imported a branch switch yet. A chain that starts in the tail is a new
      // root branch; a branch point the import has reached is its Turn; otherwise the stored head
      // stands until the import catches up.
      const rebased = tail.exit === null ? root : turnOf(tail.exit) ?? null;
      if (tail.exit === null || rebased !== null) headTurnId = rebased;
      else console.error(`Trace Memory: unimported native branch point ${tail.exit}; using the stored head`);
    }
  }
  return head(headTurnId, tail, tail.leaf ?? binding.selectedLeafUuid,
    headTurnId === null ? { projectId: session.projectId } : { sessionId: core, branch: binding.branch, headTurnId });
}

const partOf = (output: CcHookOutput | null, visible: CcVisibleBinding): DeliveryPart[] => {
  const context = output?.hookSpecificOutput.additionalContext;
  if (!context) return [];
  const header = decodeCcInjection(context, visible);
  if (!header) throw new Error("emitted Claude Code carrier failed its own decoding");
  return [{ knowledgeCommitIds: header.commits, knowledgeStates: header.states.map(knowledgeStateKey),
    knowledgeTokens: header.knowledgeTokens ?? 0 }];
};

/** 97 "Record at emission": whatever parts `emit` returns are recorded at their node before the
 * caller prints or stages them. The node's delivered state is read in one database snapshot; the
 * record commits only if no other publication for this context landed in between. */
async function deliver<T>(config: ResolvedCcHostConfig, input: Pick<CcHookInput, "session_id" | "transcript_path">,
  event: CcDeliveryEvent, emit: (output: CcHookOutput | null, visible: CcVisibleBinding) => { outputs: (CcHookOutput | null)[]; result: T },
  options: { prepared?: boolean; onSnapshot?: (db: import("node:sqlite").DatabaseSync, binding: CcSessionBinding) => void } = {}): Promise<T | null> {
  const initial = readBinding(config, input.session_id);
  if (!initial || initial.dbPath !== config.dbPath || input.transcript_path !== undefined && initial.transcriptPath !== input.transcript_path)
    throw new Error("CC native session or transcript binding is unavailable");
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC injection Hook cannot run model work"); },
    config.coreConfig, ccResultText, entry => entry.nativeLineage === initial.nativeSessionId ? ccSourceBlocks(entry) : undefined);
  try {
    const binding = options.prepared ? initial : await injectionBinding(config, initial, memory);
    if (!enabled(binding, memory)) return null;
    const visible = { db: databaseIdentity(config.dbPath), nativeSession: binding.nativeSessionId, coreSession: binding.coreSessionId };
    const selected = memory.store.readSnapshot(() => {
      options.onSnapshot?.(memory.store.db, binding);
      const head = ccDeliveryHead(binding, memory);
      const at = event.kind === "prompt" ? { nodeKey: event.promptId } : event.kind === "compact" ? head.following() : head.at();
      // A compaction's supplement is rendered against nothing delivered: it starts its own node.
      const delivered = event.kind === "compact" ? { ...noVisibility(), knowledgeTokens: 0 }
        : deliveredView(memory.store.deliveredKnowledge(event.kind === "prompt"
          ? { ...head.node, pending: [...head.node.pending ?? [], { key: event.promptId }] } : head.node));
      return { head, at, injection: memory.injection(head.target, delivered, true), watermark: memory.store.deliveryWatermark(head.owner) };
    });
    const { head, at, injection } = selected;
    const output: CcHookOutput | null = injection.text ? { hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: encodeCcInjection(visible, injection) }, transportItems: injection.transportItems,
      transportKnowledgeAllowance: injection.knowledgeAllowance } : null;
    const { outputs, result } = emit(output, visible);
    const parts = outputs.flatMap(value => partOf(value, visible));
    if (parts.length) memory.store.transaction(() => {
      if (memory.store.deliveryWatermark(head.owner) !== selected.watermark)
        throw new Error("another Knowledge publication for this context landed while this one was rendered");
      memory.store.recordKnowledgeDelivery({ owner: head.owner, ...at }, parts);
    });
    return result;
  } finally {
    // An injection owns no executor or claim. Closing its Store directly avoids invalidating work
    // owned by the concurrently running MCP process.
    memory.store.close();
  }
}

/** SessionStart's only preparation: enrollment and the provisional project. */
export async function ccPrepareSessionStartInjection(config: ResolvedCcHostConfig, input: CcHookInput): Promise<void> {
  const initial = readBinding(config, input.session_id);
  if (!initial) throw new Error("CC SessionStart binding is unavailable after enrollment");
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC injection Hook cannot run model work"); }, config.coreConfig, ccResultText);
  try { await injectionBinding(config, initial, memory); } finally { memory.store.close(); }
}

const sessionStartSource = (input: CcHookInput): void => {
  if (!input.source || !(["startup", "resume", "clear", "compact"] as const).includes(input.source))
    throw new Error("SessionStart source must be startup, resume, clear or compact");
};

/** One whole SessionStart publication (the unsliced `hook` command), recorded as one part. */
export async function ccSessionStartInjection(config: ResolvedCcHostConfig, input: CcHookInput): Promise<CcHookOutput | null> {
  sessionStartSource(input);
  const output = input.source === "compact" ? null
    : await deliver(config, input, { kind: "session-start" }, output => ({ outputs: [output], result: output }));
  // Publish a clean occurrence only after selection, recording and Store close all succeed.
  await updateBinding(config, input.session_id, current => {
    if (!current || current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path)
      throw new Error("CC binding changed while completing SessionStart");
    return current.lastCompactionNotice == null ? current : { ...current, lastCompactionNotice: null };
  });
  return output ?? null;
}

/** 66's sliced SessionStart: the parts and the database snapshot they were rendered from. */
export async function ccPreparedSessionStartInjection(config: ResolvedCcHostConfig, input: CcHookInput,
  slice: (output: CcHookOutput | null, visible: CcVisibleBinding) => (CcHookOutput | null)[]):
  Promise<{ output: CcHookOutput | null; slices: (CcHookOutput | null)[]; snapshot: object | null }> {
  sessionStartSource(input);
  if (input.source === "compact") return { output: null, slices: slice(null, { db: "", nativeSession: input.session_id, coreSession: null }), snapshot: null };
  let snapshot: object | undefined;
  const delivered = await deliver(config, input, { kind: "session-start" }, (output, visible) => {
    const slices = slice(output, visible);
    return { outputs: slices, result: { output, slices } };
  }, { prepared: true, onSnapshot: (db, binding) => {
    const watermarks = db.prepare(`SELECT
      (SELECT IFNULL(MAX(id),0) FROM facts) f,
      (SELECT IFNULL(MAX(rowid),0) FROM consolidated_facts) cf,
      (SELECT IFNULL(MAX(rowid),0) FROM noted_entries) ne,
      (SELECT IFNULL(MAX(id),0) FROM knowledge_revisions) kr,
      (SELECT IFNULL(MAX(rowid),0) FROM knowledge_processed) kp,
      (SELECT group_concat(project_id, ',') FROM (SELECT project_id FROM sessions ORDER BY id)) pa,
      (SELECT COUNT(*) FROM projects WHERE merged_into IS NOT NULL) pm,
      (SELECT global_tokens || ':' || project_tokens || ':' || session_tokens FROM knowledge_budget_policy WHERE id=1) bp,
      (SELECT IFNULL(MAX(version),0) FROM session_lineage_cursors) cv,
      (SELECT IFNULL(MAX(version),0) FROM source_paths) sv`).get();
    const owner = binding.coreSessionId ? db.prepare(`SELECT project_id, enrollment_default, enrollment_choice
      FROM sessions WHERE id=?`).get(binding.coreSessionId) : null;
    const header = binding.coreSessionId && binding.branch ? db.prepare(`SELECT length, tail_entry_id, version, hwm_entry_id
      FROM source_paths WHERE session_id=? AND branch=?`).get(binding.coreSessionId, binding.branch) : null;
    const cursor = binding.coreSessionId ? db.prepare(`SELECT branch, head_turn_id, version FROM session_lineage_cursors
      WHERE session_id=? AND lineage=?`).get(binding.coreSessionId, input.session_id) : null;
    const own = { coreSessionId: binding.coreSessionId, projectId: binding.projectId,
      enrollment: binding.enrollment, branch: binding.branch, selectedLeafUuid: binding.selectedLeafUuid,
      nativeProcess: binding.nativeProcess, lastClose: binding.lastClose,
      clearedFrom: binding.clearedFrom && { nativeSessionId: binding.clearedFrom.nativeSessionId,
        compactionTurnId: binding.clearedFrom.compactionTurnId, at: binding.clearedFrom.at,
        inheritedLength: binding.clearedFrom.inheritedEntryIds.length,
        inheritedTail: binding.clearedFrom.inheritedEntryIds.at(-1) ?? null },
      transcriptPath: binding.transcriptPath, dbPath: binding.dbPath, cwd: binding.cwd };
    snapshot = { watermarks, owner, header, cursor, own };
  } });
  if (!delivered) return { output: null, slices: slice(null, { db: "", nativeSession: input.session_id, coreSession: null }), snapshot: null };
  if (!snapshot) throw new Error("prepared SessionStart did not capture its input snapshot");
  return { ...delivered, snapshot };
}

/** 73 "Truncation is announced in the foreground": the warning for a compaction that omitted
 * unprocessed material, Pi's notice in Claude Code. 79 item 4 (ruled): Raw is an exact count only. */
export function ccTruncationWarning(omitted: TruncationReceipt | undefined): string | undefined {
  return omitted ? `Trace Memory: compaction omitted ${[
    ...(omitted.raw ? [`${omitted.raw.entries} pending Raw ${omitted.raw.entries === 1 ? "entry" : "entries"}`] : []),
    ...(omitted.facts ? [`${omitted.facts.count} ${omitted.facts.count === 1 ? "fact" : "facts"} (${omitted.facts.tokens} tokens)`] : []),
  ].join(" and ")}${omitted.raw ? "; omitted Raw remains pending for Noting." : "."}` : undefined;
}

/** 97: the tail after the stored leaf holds no source record: the import has reached the end. */
const importedToEnd = (binding: CcSessionBinding): boolean => {
  if (binding.coreSessionId === null || binding.selectedLeafUuid === null || binding.transcriptOffset === undefined) return false;
  const tail = readTranscriptTail(binding.transcriptPath, binding.transcriptOffset);
  return tail !== null && tailNodes(tail).leaf === null;
};

/** The transcript holds the row `uuid`: imported already (one row of a reply Claude Code split may
 * precede the stored leaf), or after the stored leaf (97's tail read). */
const written = (binding: CcSessionBinding, uuid: string, store: Store): boolean => binding.coreSessionId !== null &&
  !!(store.findKnownSourceEntry(binding.coreSessionId, binding.nativeSessionId, uuid) ?? store.findNativeTurn(binding.coreSessionId, binding.nativeSessionId, uuid)) ||
  !!readTranscriptTail(binding.transcriptPath, binding.selectedLeafUuid === null ? 0 : binding.transcriptOffset ?? 0)?.some(record => record.uuid === uuid);

// ponytail: a fixed bound on Claude Code's transcript flush and the executor's import that follows it,
// not configuration; past it the build imports itself or, with no trigger written, keeps native compaction.
const TRIGGER_WAIT_MS = 10_000;

/** 102: Trace Memory's compaction of the main conversation, returned by the `session.compact` hook in
 * place of Claude Code's summary; as Pi's replacement, it keeps no original message. `trigger` is the
 * newest message the hook was handed (its handle is that row's uuid): the prompt just submitted, a tool
 * call's result, or the last reply before `/compact`. Claude Code holds it in memory but may not have
 * written it yet (natively, an automatic compaction's rows land tens of milliseconds after the hook
 * starts), so the build waits for the row and for the live executor to import it, reading only the
 * tail after the stored leaf (97); without a live executor the importer runs here. The block's
 * Knowledge is recorded as the delivery of the compaction the import will append after that leaf,
 * before the text is returned. Null: an unbound or disabled session, which keeps native compaction.
 * `auto` (requirement 14, ruled): the caller's own `manual`/`auto` event trigger, distinct from the
 * handle above; only `auto` gets the trailing continue sentence. */
export async function ccCompaction(config: ResolvedCcHostConfig,
  input: Pick<CcHookInput, "session_id"> & { trigger: string; auto?: boolean }):
  Promise<{ text: string; warning?: string } | null> {
  const initial = readBinding(config, input.session_id);
  if (!initial) return null;
  if (initial.dbPath !== config.dbPath) throw new Error("CC binding uses another database");
  const lineage = initial.nativeSessionId;
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC compaction cannot run model work"); },
    config.coreConfig, ccResultText, entry => entry.nativeLineage === lineage ? ccSourceBlocks(entry) : undefined);
  try {
    // Enrollment is settled once a core session exists or the import has read the creation time.
    const disabled = (binding: CcSessionBinding) => (binding.coreSessionId !== null || binding.nativeCreatedAt !== null) && !enabled(binding, memory);
    const importing = (binding: CcSessionBinding) => binding.executor !== null && executorLiveness(binding.executor) !== "dead";
    let binding = initial;
    for (const deadline = Date.now() + TRIGGER_WAIT_MS; ;) {
      if (disabled(binding)) return null;
      const present = written(binding, input.trigger, memory.store);
      if (present && (importedToEnd(binding) || !importing(binding))) break;
      if (Date.now() >= deadline) {
        if (!present) throw new Error(`the compaction's trigger ${input.trigger} was not written to the transcript`);
        break;
      }
      await new Promise(wake => setTimeout(wake, 20));
      const current = readBinding(config, input.session_id);
      if (current?.dbPath !== config.dbPath || current.transcriptPath !== initial.transcriptPath) throw new Error("CC binding changed during compaction");
      binding = current;
    }
    if (!importedToEnd(binding)) {
      // The import also settles enrollment, which a provisional binding may not know yet.
      const projection = new CcProjection(config, binding, memory);
      const imported = await projection.synchronize();
      if (imported.state === "disabled") return null;
      if (imported.state !== "ready") throw new Error(imported.problems.join("; ") || `the transcript import is ${imported.state}`);
      binding = projection.currentBinding();
      if (!importedToEnd(binding)) throw new Error("the transcript grew while it was imported");
    }
    const offset = binding.transcriptOffset;
    const core = binding.coreSessionId!, leaf = binding.selectedLeafUuid!, branch = binding.branch, owner = coreHostOf(binding);
    const headTurnId = memory.store.findSourceEntry(core, lineage, leaf)?.turnId ?? memory.store.findNativeTurn(core, lineage, leaf)?.turnId;
    if (headTurnId === undefined) throw new Error("the selected native source has no persisted core Turn");
    const { compacted, watermark } = memory.store.readSnapshot(() => ({
      compacted: memory.compact(core, branch, headTurnId, [], false, { toolNames: ccPluginToolNames }), watermark: memory.store.deliveryWatermark(owner) }));
    if ("native" in compacted) throw new Error(`Trace Memory compact returned a native delegation: ${compacted.reason}`);
    // 102 (ruled): the one place the carrier is framed as Pi frames a compaction summary; the delivery
    // below is recorded from the same supplied material, and the framing is outside its Knowledge cost.
    // Requirement 14 (ruled): an automatic compaction's block also ends with Claude Code's own native
    // continue sentence, after the framing; a manual `/compact` gets none.
    const text = COMPACTION_SUMMARY_PREFIX + encodeCcInjection({ db: databaseIdentity(config.dbPath), nativeSession: lineage, coreSession: core }, {
      text: compacted.text, knowledgeCommitIds: compacted.supplied.knowledgeCommitIds, knowledgeTokens: compacted.supplied.knowledgeTokens ?? 0,
      knowledgeStates: compacted.supplied.knowledgeStates, factIds: compacted.supplied.factIds, entryIds: compacted.supplied.entries.map(entry => entry.id) }) +
      COMPACTION_SUMMARY_SUFFIX + (input.auto ? CC_AUTO_CONTINUE_SUFFIX : "");
    memory.store.transaction(() => {
      const current = readBinding(config, input.session_id);
      if (memory.store.deliveryWatermark(owner) !== watermark || current?.coreSessionId !== core || current.branch !== branch ||
          current.selectedLeafUuid !== leaf || current.transcriptOffset !== offset || !importedToEnd(current))
        throw new Error("the session or its selected path changed while the compaction was built");
      memory.store.recordKnowledgeDelivery({ owner, nodeKey: randomUUID(), follows: leaf }, [{
        knowledgeCommitIds: compacted.supplied.knowledgeCommitIds, knowledgeStates: (compacted.supplied.knowledgeStates ?? []).map(knowledgeStateKey),
        knowledgeTokens: compacted.supplied.knowledgeTokens ?? 0 }]);
    });
    const warning = ccTruncationWarning(compacted.truncated);
    return { text, ...(warning ? { warning } : {}) };
  } finally {
    // As an injection: this process owns no executor or claim, so its Store closes directly.
    memory.store.close();
  }
}

/** 97: the UserPromptSubmit delta and the `session.compact` supplement. A prompt's parts belong
 * to that prompt's node; a compaction's parts to the compaction's own node, which the executor's
 * import binds to its Turn. Until then it is on the path only where the boundary is. */
export async function ccDeltaInjection(config: ResolvedCcHostConfig, input: Pick<CcHookInput, "session_id" | "transcript_path">,
  event: Exclude<CcDeliveryEvent, { kind: "session-start" }>,
  slice: (output: CcHookOutput | null, visible: CcVisibleBinding) => (CcHookOutput | null)[]): Promise<(CcHookOutput | null)[]> {
  const slices = await deliver(config, input, event, (output, visible) => { const slices = slice(output, visible); return { outputs: slices, result: slices }; });
  return slices ?? slice(null, { db: "", nativeSession: input.session_id, coreSession: null });
}
