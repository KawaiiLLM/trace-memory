import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import { TraceMemory, deliveredView, knowledgeStateKey, noVisibility, type DeliveryNode, type DeliveryPart, type DeliveryTarget,
  type Injection, type KnowledgeStateReceipt, type VisibleView } from "../../core/api/index.ts";
import type { TransportItem } from "../../core/render/material.ts";
import type { KnowledgePath } from "../../core/store/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { coreHostOf, dropLostCoreSession, implicitCcProject, readBinding, sessionEnabled, updateBinding, type CcHookInput, type CcSessionBinding } from "./binding.ts";
import { ccSourceBlocks, readTranscriptTail, tailPrompts } from "./transcript.ts";

export const CC_INJECTION_BEGIN = "TRACE MEMORY KNOWLEDGE: If this is a file reference, read the file before proceeding.";
const BEGIN = CC_INJECTION_BEGIN;
export const CC_INJECTION_HEADER = "TRACE-MEMORY-CC/1 ";
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
   * only when `/clear`'s compaction omitted unprocessed material. */
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

/** 97: the head node of one native session, from the database and the binding. Only records
 * written after the stored leaf are read: they may hold prompts the executor has not imported. */
export function ccDeliveryHead(binding: CcSessionBinding, memory: Memory): { owner: string; node: DeliveryNode;
  at: Pick<DeliveryTarget, "turnId" | "prompt">; target: KnowledgePath | { projectId: number } } {
  const owner = coreHostOf(binding), core = binding.coreSessionId, store = memory.store;
  if (core === null) {
    if (binding.projectId === null) throw new Error("provisional Claude Code project is unavailable");
    // Before allocation nothing is imported: the prompts on the path are those the transcript holds.
    const prompts = tailPrompts(readTranscriptTail(binding.transcriptPath, 0) ?? []).prompts;
    return { owner, node: { owner, sessionId: null, headTurnId: null, prompts },
      at: prompts.length ? { prompt: prompts.at(-1)! } : {}, target: { projectId: binding.projectId } };
  }
  const session = store.getSession(core);
  if (!session || session.host !== owner || session.projectId !== binding.projectId)
    throw new Error("bound Claude Code core session or project disagrees with the database");
  const turnOf = (uuid: string) => store.findSourceEntry(core, binding.nativeSessionId, uuid)?.turnId
    ?? store.findNativeTurn(core, binding.nativeSessionId, uuid)?.turnId;
  let headTurnId: number | null = binding.clearedFrom?.compactionTurnId ?? null;
  if (binding.selectedLeafUuid !== null) {
    headTurnId = turnOf(binding.selectedLeafUuid) ?? null;
    if (headTurnId === null) throw new Error("native selected source has no persisted core Turn");
  }
  let prompts: string[] = [];
  const offset = binding.selectedLeafUuid === null ? 0 : binding.transcriptOffset;
  if (offset !== undefined) {
    const tail = tailPrompts(readTranscriptTail(binding.transcriptPath, offset) ?? []);
    prompts = tail.prompts;
    if (tail.leaf !== null && tail.exit !== binding.selectedLeafUuid) {
      // The executor has not imported a branch switch yet. Its branch point is resolved only when
      // it is an imported record; otherwise the stored head stands until the import catches up.
      const rebased = tail.exit === null ? null : turnOf(tail.exit) ?? null;
      if (rebased !== null) headTurnId = rebased;
      else console.error(`Trace Memory: unimported native branch point ${String(tail.exit)}; using the stored head`);
    }
  }
  return { owner, node: { owner, sessionId: core, branch: binding.branch, headTurnId, prompts },
    at: prompts.length ? { prompt: prompts.at(-1)! } : headTurnId === null ? {} : { turnId: headTurnId },
    target: headTurnId === null ? { projectId: session.projectId } : { sessionId: core, branch: binding.branch, headTurnId } };
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
    config.coreConfig, undefined, entry => entry.nativeLineage === initial.nativeSessionId ? ccSourceBlocks(entry) : undefined);
  try {
    const binding = options.prepared ? initial : await injectionBinding(config, initial, memory);
    if (!enabled(binding, memory)) return null;
    const visible = { db: databaseIdentity(config.dbPath), nativeSession: binding.nativeSessionId, coreSession: binding.coreSessionId };
    const selected = memory.store.readSnapshot(() => {
      options.onSnapshot?.(memory.store.db, binding);
      const head = ccDeliveryHead(binding, memory);
      const own = event.kind === "prompt" ? [event.promptId] : [];
      // A compaction's supplement is rendered against nothing delivered: it is the new baseline.
      const delivered = event.kind === "compact" ? { ...noVisibility(), knowledgeTokens: 0 }
        : deliveredView(memory.store.deliveredKnowledge({ ...head.node, prompts: [...head.node.prompts ?? [], ...own] }));
      return { head, injection: memory.injection(head.target, delivered, true), watermark: memory.store.deliveryWatermark(head.owner) };
    });
    const { head, injection } = selected;
    const output: CcHookOutput | null = injection.text ? { hookSpecificOutput: { hookEventName: "SessionStart",
      additionalContext: encodeCcInjection(visible, injection) }, transportItems: injection.transportItems,
      transportKnowledgeAllowance: injection.knowledgeAllowance } : null;
    const { outputs, result } = emit(output, visible);
    const parts = outputs.flatMap(value => partOf(value, visible));
    const at = event.kind === "prompt" ? { prompt: event.promptId } : head.at;
    if (parts.length || event.kind === "compact") memory.store.transaction(() => {
      if (memory.store.deliveryWatermark(head.owner) !== selected.watermark)
        throw new Error("another Knowledge publication for this context landed while this one was rendered");
      memory.store.recordKnowledgeDelivery({ owner: head.owner, ...at, baseline: event.kind === "compact" }, parts);
    });
    return result;
  } finally {
    // An injection owns no executor or claim. Closing its Store directly avoids invalidating work
    // owned by the concurrently running MCP process.
    memory.store.close();
  }
}

/** Record an already-rendered publication (a frozen `/clear` compaction) at its compaction node. */
export function recordCcBaseline(config: ResolvedCcHostConfig, binding: CcSessionBinding, outputs: readonly (CcHookOutput | null)[]): void {
  const turnId = binding.clearedFrom?.compactionTurnId;
  if (turnId == null || binding.coreSessionId === null) return;
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC clear Hook cannot run model work"); }, config.coreConfig);
  try {
    const visible = { db: databaseIdentity(config.dbPath), nativeSession: binding.nativeSessionId, coreSession: binding.coreSessionId };
    memory.store.recordKnowledgeDelivery({ owner: coreHostOf(binding), turnId, baseline: true },
      outputs.flatMap(value => partOf(value, visible)));
  } finally { memory.store.close(); }
}

/** SessionStart's only preparation: enrollment and the provisional project. */
export async function ccPrepareSessionStartInjection(config: ResolvedCcHostConfig, input: CcHookInput): Promise<void> {
  const initial = readBinding(config, input.session_id);
  if (!initial) throw new Error("CC SessionStart binding is unavailable after enrollment");
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC injection Hook cannot run model work"); }, config.coreConfig);
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

/** 97: the UserPromptSubmit delta and the `session.compact` supplement. A prompt's parts belong
 * to that prompt's node; a compaction's parts are its baseline, rendered against nothing delivered. */
export async function ccDeltaInjection(config: ResolvedCcHostConfig, input: Pick<CcHookInput, "session_id" | "transcript_path">,
  event: Exclude<CcDeliveryEvent, { kind: "session-start" }>,
  slice: (output: CcHookOutput | null, visible: CcVisibleBinding) => (CcHookOutput | null)[]): Promise<(CcHookOutput | null)[]> {
  let slices: (CcHookOutput | null)[] | null;
  try { slices = await deliver(config, input, event, (output, visible) => { const slices = slice(output, visible); return { outputs: slices, result: slices }; }); }
  catch (error) {
    // The compaction happened whether or not its supplement could be rendered: it still restarts
    // the delivered set, with nothing delivered.
    if (event.kind === "compact") try { recordEmptyBaseline(config, input); }
    catch (secondary) { console.error(`Trace Memory: compaction baseline was not recorded: ${secondary instanceof Error ? secondary.message : String(secondary)}`); }
    throw error;
  }
  return slices ?? slice(null, { db: "", nativeSession: input.session_id, coreSession: null });
}

function recordEmptyBaseline(config: ResolvedCcHostConfig, input: Pick<CcHookInput, "session_id">): void {
  const binding = readBinding(config, input.session_id);
  if (!binding) return;
  const memory = TraceMemory(config.dbPath, async () => { throw new Error("CC compact Hook cannot run model work"); }, config.coreConfig);
  try {
    if (!enabled(binding, memory)) return;
    const head = ccDeliveryHead(binding, memory);
    memory.store.recordKnowledgeDelivery({ owner: head.owner, ...head.at, baseline: true }, []);
  } finally { memory.store.close(); }
}
