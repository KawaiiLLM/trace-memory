import { hash } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { SourceNormalizationError, type SourceBlock, type SourceNormalizer } from "../../core/model/source.ts";
import type { SourceInput } from "../../core/store/index.ts";

// 70: measured on the 30k-record fixture (tests/hosts/cc-70-performance.test.ts) racing a second
// process that writes every 10 ms with a 5 s busy_timeout. A 40 ms slice keeps the importing
// executor's own event-loop gap near the slice length. 5 ms of pause was enough for the writer's
// retry to land on an idle machine but let its worst wait spike past 1 s under real background load
// (another process's own vitest run on this machine); 15 ms gave the writer's retry a reliable
// window in five consecutive runs under that same load (worst wait 139-467 ms) for about 1.5 s more
// total ingest wall time on 30k records. ponytail: fixed constants, not configuration; revisit by
// measurement if a real workload's record shape changes the ratio.
const INGEST_SLICE_MS = 40;
const INGEST_PAUSE_MS = 15;

const pause = (milliseconds: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
  const abort = () => { clearTimeout(timer); reject(signal!.reason ?? new DOMException("Aborted", "AbortError")); };
  signal?.addEventListener("abort", abort, { once: true });
});

export type CcNativeRecord = Record<string, unknown> & {
  uuid?: string;
  parentUuid?: string | null;
  logicalParentUuid?: string | null;
  timestamp?: string;
  type?: string;
  subtype?: string;
  isSidechain?: boolean;
  isCompactSummary?: boolean;
  isVisibleInTranscriptOnly?: boolean;
  isMeta?: boolean;
  promptId?: string;
  promptSource?: string;
  userType?: string;
  origin?: Record<string, unknown>;
  message?: Record<string, unknown>;
};

export interface CcTranscriptSnapshot {
  path: string;
  exists: boolean;
  size: number | null;
  modifiedMs: number | null;
  changedMs: number | null;
  device: number | null;
  inode: number | null;
  completeBytes: number;
  recordCount: number;
  records: CcNativeRecord[];
  incompleteBytes: number;
  changed: boolean;
  reset: boolean;
  problem?: string;
}

export type CcSourceRecord =
  | { kind: "user" | "assistant" | "toolResult"; record: CcNativeRecord; nativeId: string; timestamp: string | null; text: string;
      calls: SourceInput["calls"] }
  | { kind: "compaction"; record: CcNativeRecord; nativeId: string; timestamp: string | null };

export interface CcNativeNode {
  uuid: string;
  parentUuid: string | null;
  sourceKind: CcSourceRecord["kind"] | null;
  calls: { id: string; name: string }[];
  timestamp: string | null;
  lineageProblem?: string;
  importProblem?: string;
  turnId?: number;
  entryId?: number;
  /** An assistant row's message id and content, or a tool result's content, hashed: what a copy shares
   * with the row it repeats. */
  messageKey?: string;
  /** An earlier row with the same key: Claude Code wrote this one again across a compaction, under a
   * new uuid. It is that row, not new Raw. */
  copyOf?: string;
  /** The parent a tool result names, when the scan continues it from that parent's later copy. */
  namedParent?: string;
  /** 108: an assistant row's native API message id, shared (unlike `messageKey`) by every row Claude
   * Code splits one message into. It groups a parallel batch for path selection, never source identity. */
  apiMessageId?: string;
  /** Native assistant stop, not Core Turn.endedAt; tool_use is not a main-turn end. */
  stopReason?: string;
  /** Native API-error flag, never inferred from the assistant's text. */
  isApiErrorMessage?: boolean;
  /** Native interruption refers to an assistant API message id, not a transcript UUID. */
  interruptedMessageId?: string;
  /** Set once this row is confirmed on the persisted selected path (`CcTranscriptCursor.commit`'s
   * `confirmed` list). A row a later scan rereads verbatim (same UUID) is never proposed again by
   * `pathExtension`: membership is this one flag, not a walk of the path or the history. */
  selected?: true;
  /** The cursor has committed the line containing this identity; an aborted scan may index it earlier. */
  committed?: true;
}

interface FileStamp { size: number; modifiedMs: number; changedMs: number; device: number; inode: number }
type OrderedRecord = { record: CcNativeRecord; source: CcSourceRecord | null; raw: string; node: CcNativeNode | null };
export type CcTranscriptVisitor = (record: CcNativeRecord, source: CcSourceRecord | null, raw: string,
  scan: CcTranscriptScan, acceptedIdentity: boolean) => void;
const sameStamp = (left: FileStamp | null, right: FileStamp): boolean => !!left && left.size === right.size &&
  left.modifiedMs === right.modifiedMs && left.changedMs === right.changedMs && left.device === right.device && left.inode === right.inode;
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : null;
const blocks = (content: unknown): Record<string, unknown>[] => Array.isArray(content) ? content.map(object).filter(value => value !== null) : [];
const textBlocks = (content: unknown): string[] => typeof content === "string" ? [content]
  : blocks(content).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string);
const resultTexts = (content: unknown): string[] => typeof content === "string" ? [content]
  : blocks(content).filter(block => block.type === "text" && typeof block.text === "string").map(block => block.text as string);
const timestamp = (record: CcNativeRecord): string | null => typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))
  ? record.timestamp : null;
const nativeId = (record: CcNativeRecord): string | null => typeof record.uuid === "string" && record.uuid ? record.uuid : null;
const mainRecord = (record: CcNativeRecord): boolean => record.isSidechain !== true &&
  record.isCompactSummary !== true && record.isVisibleInTranscriptOnly !== true;
/** Native compaction may copy an identity while adding its top-level conversation slug. The slug is
 * placement metadata, not source or attachment identity; every other byte remains integrity-bound. */
const nativeIdentity = (record: CcNativeRecord): string => {
  const { slug: _slug, ...identity } = record;
  return JSON.stringify(identity);
};

const humanCommandPrompt = (content: string): string | null => {
  const values = new Map<string, string>();
  const tag = /\s*<(command-name|command-message|command-args)>([\s\S]*?)<\/\1>/gy;
  let offset = 0;
  while (offset < content.length) {
    if (!content.slice(offset).trim()) break;
    tag.lastIndex = offset;
    const match = tag.exec(content);
    if (!match || values.has(match[1]!)) return null;
    values.set(match[1]!, match[2]!);
    offset = tag.lastIndex;
  }
  const name = values.get("command-name")?.trim(), message = values.get("command-message")?.trim();
  if (!name || !message || values.size < 2 || !/^\/[^\s<>]+$/.test(name) || message !== name.slice(1)) return null;
  const args = values.get("command-args")?.trim();
  return args ? `${name} ${args}` : name;
};

/** The first two lines of every Trace Memory carrier (encoded in injection.ts). A user row that
 * begins with them, bare or inside the compaction framing below, is Trace Memory's own material,
 * never Raw: the compaction a `session.compact` hook returns (102) is an ordinary user row after the
 * boundary, with no summary flag. */
export const CC_INJECTION_BEGIN = "TRACE MEMORY KNOWLEDGE: If this is a file reference, read the file before proceeding.";
export const CC_INJECTION_HEADER = "TRACE-MEMORY-CC/1 ";
/** 102 (ruled): the compaction a `session.compact` hook returns is its carrier framed as Pi frames a
 * compaction summary for the model, so both hosts show the model the same thing. Copied verbatim from
 * pi-coding-agent 0.87.1, dist/core/messages.js, COMPACTION_SUMMARY_PREFIX and COMPACTION_SUMMARY_SUFFIX. */
export const COMPACTION_SUMMARY_PREFIX = `The conversation history before this point was compacted into the following summary:

<summary>
`;
export const COMPACTION_SUMMARY_SUFFIX = `
</summary>`;
const CARRIER_START = `${CC_INJECTION_BEGIN}\n${CC_INJECTION_HEADER}`;
/** Where a user text's carrier starts: at once, or after the compaction framing; -1 when it opens with neither. */
export const ccCarrierStart = (text: string): number => text.startsWith(CARRIER_START) ? 0
  : text.startsWith(COMPACTION_SUMMARY_PREFIX + CARRIER_START) ? COMPACTION_SUMMARY_PREFIX.length : -1;
/** 102 (ruled): after an automatic compaction only, the message the `session.compact` hook returns
 * ends, after Pi's framed block, with Claude Code's own native instruction to continue the pending
 * task without asking the user. Copied verbatim from the installed Claude Code 2.1.280
 * (@anthropic-ai/claude-code 2.1.280), bin/claude.exe: the sentence its own reactive (automatic)
 * compaction path appends to its summary message when `suppressFollowUpQuestions` is set, which only
 * that path sets. A manual `/compact` never sets it and gets no such sentence. */
export const CC_AUTO_CONTINUE_SUFFIX = "\nContinue the conversation from where it left off without asking the user any further questions. " +
  "Resume directly — do not acknowledge the summary, do not recap what was happening, do not preface with \"I'll continue\" or similar. " +
  "Pick up the last task as if the break never happened.";
/** The carrier recognition and `/trace` estimate (menu-context.ts) read up to Pi's own suffix; this
 * strips an optional trailing auto-continue sentence first so that check is unchanged either way. */
export const ccStripAutoContinue = (text: string): string =>
  text.endsWith(CC_AUTO_CONTINUE_SUFFIX) ? text.slice(0, -CC_AUTO_CONTINUE_SUFFIX.length) : text;

export class CcNativeLineageError extends Error {}

/** Decode native lineage exactly once. A malformed present value is not an absent parent.
 * `writtenBefore` says whether a UUID was written earlier in the file than `record`. Claude Code
 * 2.1.280's automatic compaction can name, as the boundary's logical parent, a preserved message
 * written after the boundary and descending from it (a production transcript, 2026-09-23). Such a
 * boundary continues from its last preserved message written before it, which is what every other
 * boundary names as its logical parent. */
export function nativeParentId(record: CcNativeRecord, writtenBefore?: (uuid: string) => boolean): string | null {
  const value = record.logicalParentUuid ?? record.parentUuid;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value) throw new CcNativeLineageError(
    `native lineage parent of ${nativeId(record) ?? "record without UUID"} is invalid`);
  if (writtenBefore && value === record.logicalParentUuid && record.type === "system" &&
      record.subtype === "compact_boundary" && !writtenBefore(value)) {
    const preserved = (record.compactMetadata as { preservedMessages?: { uuids?: unknown } } | undefined)?.preservedMessages?.uuids;
    const earlier = Array.isArray(preserved) ? preserved.filter((id): id is string => typeof id === "string" && !!id && writtenBefore(id)) : [];
    if (earlier.length) return earlier.at(-1)!;
  }
  return value;
}

const snapshot = (path: string, stamp: FileStamp | null, values: Partial<CcTranscriptSnapshot> = {}): CcTranscriptSnapshot => ({
  path, exists: stamp !== null, size: stamp?.size ?? null, modifiedMs: stamp?.modifiedMs ?? null,
  changedMs: stamp?.changedMs ?? null, device: stamp?.device ?? null, inode: stamp?.inode ?? null,
  completeBytes: 0, recordCount: 0, records: [], incompleteBytes: 0, changed: false, reset: false, ...values,
});

export function classifySourceRecord(record: CcNativeRecord): CcSourceRecord | null {
  const id = nativeId(record);
  if (!id || !mainRecord(record)) return null;
  if (record.type === "system" && record.subtype === "compact_boundary" && record.isMeta !== true)
    return { kind: "compaction", record, nativeId: id, timestamp: timestamp(record) };
  if (record.type !== "user" && record.type !== "assistant") return null;
  if (record.type === "user" && record.interruptedMessageId !== undefined) return null;
  const message = object(record.message);
  if (!message || record.message?.isCompactSummary === true || message.role !== record.type) return null;
  if (record.type === "assistant" && (record.isMeta === true || message.model === "<synthetic>")) return null;
  const content = message.content;
  if (record.type === "assistant") {
    if (!Array.isArray(content)) return null;
    const calls: SourceInput["calls"] = [];
    for (const block of blocks(content)) if (block.type === "tool_use" && typeof block.id === "string" && block.id && typeof block.name === "string" && block.name) {
      calls.push({ ordinal: 0, name: block.name, callId: block.id,
        ...(block.input === undefined ? {} : { input: JSON.stringify(block.input) }), status: "attempted" });
    }
    const text = textBlocks(content).join("\n");
    const hasThinking = blocks(content).some(block => block.type === "thinking" || block.type === "redacted_thinking");
    if (!text && !calls.length && !hasThinking) return null;
    return { kind: "assistant", record, nativeId: id, timestamp: timestamp(record), text, calls };
  }
  const contentBlocks = blocks(content), toolResults = contentBlocks.filter(block => block.type === "tool_result");
  if (toolResults.length) {
    if (record.isMeta === true) return null;
    const calls: SourceInput["calls"] = [];
    for (const block of toolResults) if (typeof block.tool_use_id === "string" && block.tool_use_id) {
      calls.push({ ordinal: 0, name: "unknown", callId: block.tool_use_id,
        result: JSON.stringify({ content: block.content, toolUseResult: record.toolUseResult }), status: block.is_error === true ? "failure" : "success" });
    }
    if (calls.length !== toolResults.length) return null;
    return { kind: "toolResult", record, nativeId: id, timestamp: timestamp(record), text: "", calls };
  }
  if (!(typeof content === "string" || Array.isArray(content))) return null;
  if (ccCarrierStart(textBlocks(content)[0] ?? "") >= 0) return null;
  const nativePrompt = ["typed", "queued", "sdk", "system"].includes(String(record.promptSource));
  const humanPrompt = record.isMeta !== true && record.origin?.kind === "human";
  if (!nativePrompt && !humanPrompt) return null;
  const text = !nativePrompt && typeof content === "string" ? humanCommandPrompt(content) ?? content : textBlocks(content).join("\n");
  return { kind: "user", record, nativeId: id, timestamp: timestamp(record), text, calls: [] };
}

/** Claude Code 2.1.280 splits one API message into rows sharing its id, one per content block, so
 * the id alone does not identify an assistant row; the id with the row's content does. A tool result's
 * content names the calls it answers; the result it writes again across a compaction differs only in uuid.
 * ponytail: hashes every assistant and tool-result row while indexing (about 1 ms per MB of their
 * content); a cheap block fingerprint with an exact re-read on a match would avoid it if a full scan needs it. */
const messageKey = (source: CcSourceRecord | null): string | undefined => {
  const message = source?.record.message;
  const identity = source?.kind === "toolResult" ? [message!.content]
    : source?.kind === "assistant" && typeof message?.id === "string" ? [message.id, message.content] : undefined;
  return identity && hash("sha256", JSON.stringify(identity), "base64");
};

const apiMessageId = (source: CcSourceRecord | null): string | undefined =>
  source?.kind === "assistant" && typeof source.record.message?.id === "string" ? source.record.message.id : undefined;

const nodeOf = (record: CcNativeRecord, writtenBefore: (uuid: string) => boolean): CcNativeNode | null => {
  const uuid = nativeId(record);
  if (!uuid) return null;
  const source = classifySourceRecord(record);
  const main = mainRecord(record);
  try {
    return { uuid, parentUuid: nativeParentId(record, writtenBefore), sourceKind: source?.kind ?? null,
      calls: source?.kind === "assistant" ? source.calls.map(call => ({ id: call.callId, name: call.name })) : [], timestamp: source?.timestamp ?? timestamp(record),
      messageKey: messageKey(source), apiMessageId: apiMessageId(source),
      ...(record.type === "assistant" && typeof record.message?.stop_reason === "string"
        ? { stopReason: record.message.stop_reason } : {}),
      ...(main && record.type === "assistant" && record.isApiErrorMessage === true ? { isApiErrorMessage: true } : {}),
      ...(main && record.type === "user" && typeof record.interruptedMessageId === "string" && record.interruptedMessageId
        ? { interruptedMessageId: record.interruptedMessageId } : {}) };
  } catch (error) {
    if (!(error instanceof CcNativeLineageError)) throw error;
    return { uuid, parentUuid: null, sourceKind: source?.kind ?? null,
      calls: source?.kind === "assistant" ? source.calls.map(call => ({ id: call.callId, name: call.name })) : [], timestamp: source?.timestamp ?? timestamp(record), lineageProblem: error.message };
  }
};

/** Entry id order is import order; a node without an entry sorts last. */
const byFirstImport = (left: CcNativeNode, right: CcNativeNode): number =>
  (left.entryId ?? Infinity) - (right.entryId ?? Infinity) || 0;
const join = (members: Map<string, CcNativeNode[]>, batch: string, node: CcNativeNode): void => {
  const list = members.get(batch);
  if (list) list.push(node); else members.set(batch, [node]);
};

export class CcTranscriptScan {
  readonly nodes: Map<string, CcNativeNode>;
  readonly snapshot: CcTranscriptSnapshot;
  readonly callCarriers: Map<string, Set<string>>;
  /** Each message key and the latest row written with it. */
  readonly messageKeys: Map<string, string>;
  readonly stamp: FileStamp;
  readonly reset: boolean;
  readonly completeOffset: number;
  readonly lineCount: number;
  readonly selectedLeafUuid: string | null;
  /** Latest native turn terminator, independent of whether that row is a Raw source. */
  readonly terminalUuid: string | null;
  /** 97: the byte offset just after the selected leaf's line; everything later is its tail. */
  readonly selectedLeafOffset: number | null;
  readonly problems: string[];
  readonly newProblems: Set<string>;
  /** 108: the native ids this scan read, in visit order: the appended suffix, or every record after a reset. */
  readonly readIds: readonly string[];
  /** Native UUIDs first indexed by this scan; an appended duplicate UUID is not a new terminal. */
  readonly newIds: ReadonlySet<string>;

  constructor(input: { nodes: Map<string, CcNativeNode>; callCarriers: Map<string, Set<string>>; messageKeys: Map<string, string>;
    snapshot: CcTranscriptSnapshot; stamp: FileStamp; reset: boolean; completeOffset: number; lineCount: number; selectedLeafUuid: string | null;
    terminalUuid: string | null; selectedLeafOffset: number | null; problems?: string[]; newProblems?: Set<string>;
    readIds?: readonly string[]; newIds?: ReadonlySet<string> }) {
    this.nodes = input.nodes; this.callCarriers = input.callCarriers; this.messageKeys = input.messageKeys;
    this.snapshot = input.snapshot; this.stamp = input.stamp; this.reset = input.reset;
    this.completeOffset = input.completeOffset; this.lineCount = input.lineCount; this.selectedLeafUuid = input.selectedLeafUuid;
    this.terminalUuid = input.terminalUuid; this.selectedLeafOffset = input.selectedLeafOffset;
    this.problems = input.problems ?? [];
    this.newProblems = input.newProblems ?? new Set();
    this.readIds = input.readIds ?? []; this.newIds = input.newIds ?? new Set();
  }

  node(uuid: string): CcNativeNode | undefined { return this.nodes.get(uuid); }

  /** A synthetic error may follow the selected Raw leaf without becoming Raw itself. Never
   * accept an error on a sibling branch or across another source message. */
  selectedTerminal(): CcNativeNode | null {
    const leaf = this.selectedLeafUuid, candidate = this.terminalUuid && this.node(this.terminalUuid);
    if (!leaf || !candidate) return null;
    if (candidate.uuid === leaf) return candidate.sourceKind === "assistant" && candidate.stopReason === "end_turn" || candidate.isApiErrorMessage ? candidate : null;
    if (candidate.sourceKind !== null || !candidate.isApiErrorMessage && !candidate.interruptedMessageId) return null;
    const seen = new Set<string>();
    let current: CcNativeNode | undefined = candidate;
    while (current && current.uuid !== leaf) {
      if (seen.has(current.uuid) || current.lineageProblem || current.importProblem || current !== candidate && current.sourceKind !== null) return null;
      seen.add(current.uuid);
      current = current.parentUuid === null ? undefined : this.node(current.parentUuid);
    }
    if (current?.uuid !== leaf || !candidate.interruptedMessageId) return current?.uuid === leaf ? candidate : null;
    // CC names the interrupted API message, which may precede tool results and attachments.
    // It must belong to this selected turn, not an earlier user turn or a sibling branch.
    seen.clear();
    while (current && !seen.has(current.uuid)) {
      if (current.lineageProblem || current.importProblem || current.sourceKind === "compaction" ||
          current.sourceKind === "user") return null;
      if (current.sourceKind === "assistant" && current.apiMessageId === candidate.interruptedMessageId) return candidate;
      seen.add(current.uuid);
      current = current.parentUuid === null ? undefined : this.node(current.parentUuid);
    }
    return null;
  }

  associate(uuid: string, association: { turnId: number; entryId?: number }): void {
    const current = this.node(uuid);
    if (!current) throw new Error(`native record ${uuid} is unavailable for association`);
    current.turnId = association.turnId;
    if (association.entryId !== undefined) current.entryId = association.entryId;
  }

  markProblem(uuid: string, problem: string): void {
    const current = this.node(uuid);
    if (current) current.importProblem = problem;
    this.newProblems.add(problem);
    if (!this.problems.includes(problem)) this.problems.push(problem);
  }

  /** 108: the first row of the native message `node` belongs to (for a tool result, the message of the
   * call it answers), or the node itself. Claude Code 2.1.280 writes one assistant message as one row per
   * content block, each under the previous and sharing the message id, and writes each parallel call's
   * result under that call, never under another result. So a batch's rows all hang off its first row, and
   * a single-parent walk from the leaf passes through only some of them; every one reached the model in
   * the same turn. Walks parent links while the message id holds: one message's rows, never the history. */
  private batchOf(node: CcNativeNode): string {
    let current = node.sourceKind === "toolResult" && node.parentUuid !== null ? this.node(node.parentUuid) ?? node : node;
    if (current.apiMessageId === undefined) return node.uuid;
    for (const seen = new Set([current.uuid]);;) {
      const parent = current.parentUuid === null ? undefined : this.node(current.parentUuid);
      if (!parent || parent.apiMessageId !== current.apiMessageId || seen.has(parent.uuid)) return current.uuid;
      seen.add(parent.uuid); current = parent;
    }
  }

  /** `chain` in order, each batch's rows on it joined by its `members` elsewhere and ordered by first
   * import (entry id): the order an incremental extension appends them in. A node without an entry
   * (a copy) holds no path position; it stays in its batch, last. */
  private layout(chain: CcNativeNode[], members: Map<string, CcNativeNode[]>): CcNativeNode[] {
    const nodes: CcNativeNode[] = [];
    for (let index = 0; index < chain.length;) {
      const first = chain[index]!, joined = members.get(first.uuid);
      if (!joined) { nodes.push(first); index++; continue; }
      const batch = [...joined];
      while (index < chain.length && this.batchOf(chain[index]!) === first.uuid) batch.push(chain[index++]!);
      nodes.push(...batch.sort(byFirstImport));
    }
    return nodes;
  }

  /** The leaf's native ancestry and every other row of each parallel batch on it (108). */
  selectedPath(): { leafUuid: string | null; nodes: CcNativeNode[]; problem?: string } {
    const leafUuid = this.selectedLeafUuid;
    if (!leafUuid) return { leafUuid: null, nodes: [] };
    const reverse: CcNativeNode[] = [], chain = new Set<string>();
    let current = this.node(leafUuid);
    while (current) {
      if (chain.has(current.uuid)) return { leafUuid, nodes: [], problem: `native lineage cycle at ${current.uuid}` };
      if (current.lineageProblem) return { leafUuid, nodes: [], problem: current.lineageProblem };
      if (current.importProblem) return { leafUuid, nodes: [], problem: current.importProblem };
      chain.add(current.uuid); reverse.push(current);
      if (current.parentUuid === null) break;
      current = this.node(current.parentUuid);
      if (!current) return { leafUuid, nodes: [], problem: `native lineage parent ${reverse.at(-1)!.parentUuid} is missing` };
    }
    // A full rebuild already walks the whole chain; one more pass finds the batch rows off it.
    const members = new Map<string, CcNativeNode[]>();
    for (const node of this.nodes.values()) if (!chain.has(node.uuid)) {
      const batch = this.batchOf(node);
      if (batch !== node.uuid && chain.has(batch)) join(members, batch, node);
    }
    return { leafUuid, nodes: this.layout(reverse.reverse(), members) };
  }

  /** 108: what this scan appends to the path that ended at `priorLeafUuid`, in `selectedPath`'s order,
   * or null when the new path is not that path extended (the caller then rebuilds). The new leaf's
   * ancestry is walked back to the prior leaf or any row of its batch. A row this scan read joins the path
   * when it is on that walk or belongs to a batch on it or to the prior leaf's batch. The cost follows
   * this scan's rows, not the history. An older source row on the walk, or a new row of an older batch,
   * is left to the full rebuild. */
  pathExtension(priorLeafUuid: string): CcNativeNode[] | null {
    const prior = this.node(priorLeafUuid), leafUuid = this.selectedLeafUuid;
    if (!prior || !leafUuid) return null;
    const anchor = this.batchOf(prior), read = new Set(this.readIds), walked = new Set<string>(), reverse: CcNativeNode[] = [];
    let current = this.node(leafUuid);
    while (current && current.uuid !== priorLeafUuid && this.batchOf(current) !== anchor) {
      if (walked.has(current.uuid) || current.selected || current.lineageProblem || current.importProblem || current.sourceKind && !read.has(current.uuid)) return null;
      walked.add(current.uuid); reverse.push(current);
      current = current.parentUuid === null ? undefined : this.node(current.parentUuid);
    }
    if (!current) return null;
    const batches = new Set([anchor, ...reverse.map(node => this.batchOf(node))]), members = new Map<string, CcNativeNode[]>();
    for (const uuid of this.readIds) if (!walked.has(uuid)) {
      const node = this.node(uuid)!, batch = this.batchOf(node);
      if (batch === uuid || node.selected) continue;
      if (batches.has(batch)) join(members, batch, node);
      else if (!read.has(batch)) return null;
    }
    const joined = (members.get(anchor) ?? []).sort(byFirstImport);
    return [...joined, ...this.layout(reverse.reverse(), members)];
  }

}

export class CcTranscriptScanFailure extends Error {
  readonly scan: CcTranscriptScan;
  override readonly cause: unknown;
  constructor(scan: CcTranscriptScan, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.scan = scan; this.cause = cause;
  }
}

export class CcTranscriptCursor {
  private stamp: FileStamp | null = null;
  private completeOffset = 0;
  private lineCount = 0;
  private recordCount = 0;
  private selectedLeafUuid: string | null = null;
  private terminalUuid: string | null = null;
  private selectedLeafOffset: number | null = null;
  private nodes = new Map<string, CcNativeNode>();
  private callCarriers = new Map<string, Set<string>>();
  private messageKeys = new Map<string, string>();
  private unresolvedProblems = new Set<string>();
  private rejected: { stamp: FileStamp; snapshot: CcTranscriptSnapshot } | null = null;
  private lastSnapshot: CcTranscriptSnapshot | null = null;

  currentSnapshot(path: string): CcTranscriptSnapshot { return this.lastSnapshot ?? snapshot(path, null); }
  /** A read-only fast path for a publisher that already owns this exact file snapshot. */
  unchangedSnapshot(path: string): CcTranscriptSnapshot | null {
    if (!this.stamp || !this.lastSnapshot) return null;
    const observed = readTranscriptMetadata(path);
    if (!observed.exists) return null;
    const stamp: FileStamp = { size: observed.size!, modifiedMs: observed.modifiedMs!, changedMs: observed.changedMs!,
      device: observed.device!, inode: observed.inode! };
    return sameStamp(this.stamp, stamp) ? { ...this.lastSnapshot, records: [], changed: false, reset: false } : null;
  }
  currentProblems(): string[] {
    const values = [...this.unresolvedProblems];
    const rejected = this.rejected?.snapshot.problem;
    if (rejected && !values.includes(rejected)) values.push(rejected);
    return values;
  }
  node(uuid: string): CcNativeNode | undefined { return this.nodes.get(uuid); }
  callPath(toolUseId: string, expectedNames: readonly string[]): CcNativeNode[] | null {
    const carrierIds = this.callCarriers.get(toolUseId);
    if (!carrierIds?.size) return null;
    if (carrierIds.size !== 1) throw new Error(`native tool call ${toolUseId} is ambiguous in this session`);
    const carrier = this.nodes.get([...carrierIds][0]!)!;
    const invocation = carrier.calls.find(call => call.id === toolUseId)!;
    if (!expectedNames.includes(invocation.name))
      throw new Error(`native tool call ${toolUseId} invoked ${invocation.name}, not ${expectedNames.join(" or ")}`);
    const reverse: CcNativeNode[] = [], seen = new Set<string>();
    let current: CcNativeNode | undefined = carrier;
    while (current) {
      if (seen.has(current.uuid)) throw new Error(`native lineage cycle at ${current.uuid}`);
      if (current.lineageProblem) throw new Error(current.lineageProblem);
      if (current.importProblem) throw new Error(current.importProblem);
      seen.add(current.uuid); reverse.push(current);
      if (current.parentUuid === null) break;
      const parent = current.parentUuid;
      current = this.nodes.get(parent);
      if (!current) throw new Error(`native lineage parent ${parent} is missing`);
    }
    return reverse.reverse();
  }

  /** Open, read and parse the appended (or, on reset, whole) region and order its records by
   * ancestry. Holds no database transaction and touches no store: this is the "read" plus
   * "parse/index/sort" work, unsliced and never paused, shared by the synchronous `scan` (the
   * whole-file bootstrap path, which visits nothing that writes) and the cooperative ingest loop. */
  private prepareOrdered(path: string, collect: boolean, onPhase?: (phase: "read" | "index", ms: number) => void):
    { done: CcTranscriptSnapshot } | { scan: CcTranscriptScan; ordered: OrderedRecord[]; finish: () => CcTranscriptScan } {
    const readStart = performance.now();
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { done: snapshot(path, null) };
      throw error;
    }
    try {
      const before = fstatSync(descriptor);
      const stamp: FileStamp = { size: before.size, modifiedMs: before.mtimeMs, changedMs: before.ctimeMs, device: before.dev, inode: before.ino };
      if (this.rejected && sameStamp(this.rejected.stamp, stamp)) return { done: this.rejected.snapshot };
      if (sameStamp(this.stamp, stamp)) return { done: { ...this.lastSnapshot!, records: [], changed: false, reset: false } };
      const replacement = !!this.stamp && (stamp.device !== this.stamp.device || stamp.inode !== this.stamp.inode);
      // A same-size metadata change, replacement, shrink, or broken committed newline is a rebuild.
      // Growth follows the native append contract; metadata cannot prove an arbitrary same-inode
      // prefix mutation that is combined with an append without rereading that prefix.
      let reset = !this.stamp || replacement || stamp.size < this.completeOffset || stamp.size === this.stamp.size;
      if (!reset && this.completeOffset > 0) {
        const marker = Buffer.allocUnsafe(1);
        if (readSync(descriptor, marker, 0, 1, this.completeOffset - 1) !== 1 || marker[0] !== 0x0a) reset = true;
      }
      const start = reset ? 0 : this.completeOffset;
      const bytes = Buffer.allocUnsafe(stamp.size - start);
      let read = 0;
      while (read < bytes.length) {
        const amount = readSync(descriptor, bytes, read, bytes.length - read, start + read);
        if (!amount) throw new Error("native transcript changed while it was being read");
        read += amount;
      }
      const after = fstatSync(descriptor);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.dev !== before.dev || after.ino !== before.ino)
        throw new Error("native transcript changed while it was being read");
      const finalNewline = bytes.lastIndexOf(0x0a);
      const completeLength = finalNewline < 0 ? 0 : finalNewline + 1;
      const completeOffset = start + completeLength;
      onPhase?.("read", performance.now() - readStart);
      const indexStart = performance.now();
      const records: CcNativeRecord[] = [], collectedById = new Map<string, { record: CcNativeRecord; identity: string }>();
      const parsedRecords: OrderedRecord[] = [];
      // Appends extend the committed structural index in place. Its cursor offset is not advanced
      // until projection and projection publish succeed, so a fatal retry (including an aborted
      // cooperative ingest) rereads the suffix and fills only committed source associations. A reset
      // builds a replacement index off to the side.
      const scanNodes = reset ? new Map<string, CcNativeNode>() : this.nodes;
      const scanCalls = reset ? new Map<string, Set<string>>() : this.callCarriers;
      const scanKeys = reset ? new Map<string, string>() : this.messageKeys;
      const newIds = new Set<string>();
      const problems = reset ? [] : [...this.unresolvedProblems], newProblems = new Set<string>();
      let selectedLeafUuid = reset ? null : this.selectedLeafUuid;
      let terminalUuid = reset ? null : this.terminalUuid;
      let selectedLeafOffset = reset ? null : this.selectedLeafOffset;
      let physicalRecords = reset ? 0 : this.recordCount;
      let lines = reset ? 0 : this.lineCount;
      const preliminary = snapshot(path, stamp, { completeBytes: completeOffset, recordCount: physicalRecords,
        incompleteBytes: stamp.size - completeOffset, changed: true, reset });
      const scan = new CcTranscriptScan({ nodes: scanNodes, callCarriers: scanCalls, messageKeys: scanKeys, snapshot: preliminary, stamp, reset,
        completeOffset, lineCount: lines, selectedLeafUuid, terminalUuid, selectedLeafOffset, problems, newProblems });
      let beginning = 0;
      while (beginning < completeLength) {
        const ending = bytes.indexOf(0x0a, beginning);
        const raw = bytes.subarray(beginning, ending).toString("utf8");
        beginning = ending + 1; lines += 1;
        if (!raw) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); }
        catch (error) { throw new CcTranscriptScanFailure(scan, new Error(`invalid completed transcript record at line ${lines}: ${String(error)}`)); }
        const record = object(parsed);
        if (!record) throw new CcTranscriptScanFailure(scan, new Error(`invalid completed transcript record at line ${lines}: expected an object`));
        physicalRecords += 1;
        let source = classifySourceRecord(record), node = nodeOf(record, id => scanNodes.has(id));
        if (node) {
          const prior = scanNodes.get(node.uuid), collected = collectedById.get(node.uuid), identity = nativeIdentity(record);
          if (prior && ((prior.namedParent ?? prior.parentUuid) !== node.parentUuid || prior.sourceKind !== node.sourceKind || prior.lineageProblem !== node.lineageProblem) ||
              collected && collected.identity !== identity) {
            const problem = `native transcript UUID ${node.uuid} changed within the completed file`;
            scan.markProblem(node.uuid, problem);
            source = null; node = null;
          } else {
            if (!prior?.committed) newIds.add(node.uuid);
            if (!prior) {
              // After a compaction in the middle of a reply, the model's context continues from the copy
              // of the in-flight message, but Claude Code names the call's original row as its result's parent.
              // ponytail: a result truly resumed from the original after its copy (an SDK resume at a
              // pre-compaction uuid) would also continue from the copy; tell them apart if that occurs.
              const named = node.parentUuid, parentKey = named === null ? undefined : scanNodes.get(named)?.messageKey;
              const latest = source?.kind === "toolResult" && parentKey !== undefined ? scanKeys.get(parentKey) : undefined;
              if (latest !== undefined && latest !== named) { node.namedParent = named!; node.parentUuid = latest; }
              if (node.messageKey !== undefined) {
                const earlier = scanKeys.get(node.messageKey);
                if (earlier !== undefined) node.copyOf = earlier;
                scanKeys.set(node.messageKey, node.uuid);
              }
              scanNodes.set(node.uuid, node);
              if (node.copyOf === undefined) for (const call of node.calls) {
                const carriers = scanCalls.get(call.id) ?? new Set<string>();
                carriers.add(node.uuid); scanCalls.set(call.id, carriers);
              }
            }
            if (!collected) collectedById.set(node.uuid, { record, identity });
            if (source) { selectedLeafUuid = node.uuid; selectedLeafOffset = start + beginning; }
            if (source?.kind === "user" || mainRecord(record) && record.type === "assistant" || node.interruptedMessageId)
              terminalUuid = (record.type === "assistant" &&
                (node.sourceKind === "assistant" && node.stopReason === "end_turn" || node.isApiErrorMessage) || !!node.interruptedMessageId)
                ? node.uuid : null;
          }
        }
        if (collect) records.push(record);
        parsedRecords.push({ record, source, raw, node });
      }
      // Visit each native identity after all suffix nodes are known, in ancestry order. This resolves
      // a result/call pair that is physically reversed without replaying historical records.
      const unique = new Map(parsedRecords.filter(value => value.node).map(value => [value.node!.uuid, value] as const));
      const visiting = new Set<string>(), visited = new Set<string>();
      const ordered: OrderedRecord[] = [];
      const add = (value: OrderedRecord): void => {
        const id = value.node?.uuid;
        if (!id || visited.has(id)) return;
        if (visiting.has(id)) { ordered.push(value); visited.add(id); return; }
        visiting.add(id);
        const parent = value.node!.parentUuid;
        if (parent && unique.has(parent)) add(unique.get(parent)!);
        visiting.delete(id);
        if (!visited.has(id)) { visited.add(id); ordered.push(value); }
      };
      for (const value of parsedRecords) if (value.node) add(value);
      for (const value of parsedRecords) if (!value.node) ordered.push(value);
      onPhase?.("index", performance.now() - indexStart);
      const finish = (): CcTranscriptScan => {
        const resultSnapshot = snapshot(path, stamp, { completeBytes: completeOffset, recordCount: physicalRecords, records,
          incompleteBytes: stamp.size - completeOffset, changed: true, reset });
        return new CcTranscriptScan({ nodes: scanNodes, callCarriers: scanCalls, messageKeys: scanKeys, snapshot: resultSnapshot, stamp, reset,
          completeOffset, lineCount: lines, selectedLeafUuid, terminalUuid, selectedLeafOffset, problems, newProblems,
          readIds: ordered.flatMap(value => value.node ? [value.node.uuid] : []), newIds });
      };
      return { scan, ordered, finish };
    } finally { closeSync(descriptor); }
  }

  scan(path: string, visit: CcTranscriptVisitor, collect = false): CcTranscriptScan | CcTranscriptSnapshot {
    const prepared = this.prepareOrdered(path, collect);
    if ("done" in prepared) return prepared.done;
    const { scan, ordered, finish } = prepared;
    for (const value of ordered) {
      const acceptedIdentity = nativeId(value.record) === null || !!value.node &&
        !value.node.lineageProblem && !value.node.importProblem;
      try { visit(value.record, value.source, value.raw, scan, acceptedIdentity); }
      catch (error) { throw new CcTranscriptScanFailure(scan, error); }
    }
    return finish();
  }

  /** The cooperative counterpart of `scan`, used only for the ingest visit loop (never the whole-file
   * bootstrap read, which writes nothing and stays synchronous). Read, parse, index and sort are the
   * same unsliced, unpaused work as `scan`; only the per-record visit loop yields: after a slice of
   * about `sliceMs`, it awaits `pauseMs` with no transaction open before resuming from the next
   * record, so a waiting writer's retry finds a free window and the executor's own event loop is
   * never blocked for the whole scan. `signal` is checked between records, never inside one record's
   * visit: an abort leaves the stamp and offset unadvanced (see `prepareOrdered`), so the next scan
   * re-reads the same suffix and skips already-committed records by native identity. */
  async scanCooperative(path: string, visit: CcTranscriptVisitor, options: { signal?: AbortSignal; sliceMs?: number;
    pauseMs?: number; onIngestGap?: (ms: number) => void; onPhase?: (phase: "read" | "index", ms: number) => void } = {}):
    Promise<CcTranscriptScan | CcTranscriptSnapshot> {
    const { signal, sliceMs = INGEST_SLICE_MS, pauseMs = INGEST_PAUSE_MS, onIngestGap, onPhase } = options;
    const prepared = this.prepareOrdered(path, false, onPhase);
    if ("done" in prepared) return prepared.done;
    const { scan, ordered, finish } = prepared;
    let sliceStart = performance.now();
    for (const value of ordered) {
      if (performance.now() - sliceStart >= sliceMs) {
        onIngestGap?.(performance.now() - sliceStart);
        await pause(pauseMs, signal);
        sliceStart = performance.now();
      }
      signal?.throwIfAborted();
      const acceptedIdentity = nativeId(value.record) === null || !!value.node &&
        !value.node.lineageProblem && !value.node.importProblem;
      try { visit(value.record, value.source, value.raw, scan, acceptedIdentity); }
      catch (error) { throw new CcTranscriptScanFailure(scan, error); }
    }
    onIngestGap?.(performance.now() - sliceStart);
    return finish();
  }

  /** `confirmed`: the rows the caller just published as (part of) the selected path, marked so a later
   * scan's `pathExtension` never proposes them again, however their UUID resurfaces (98). Empty when the
   * caller published nothing (a rejected or not-ready scan). */
  commit(scan: CcTranscriptScan, problem?: string, confirmed: readonly CcNativeNode[] = []): void {
    if (scan.reset) this.unresolvedProblems.clear();
    for (const value of scan.newProblems) this.unresolvedProblems.add(value);
    if (scan.reset) { this.nodes = scan.nodes; this.callCarriers = scan.callCarriers; this.messageKeys = scan.messageKeys; }
    for (const node of confirmed) node.selected = true;
    for (const id of scan.readIds) scan.node(id)!.committed = true;
    this.stamp = scan.stamp; this.completeOffset = scan.completeOffset;
    this.lineCount = scan.lineCount; this.recordCount = scan.snapshot.recordCount; this.selectedLeafUuid = scan.selectedLeafUuid;
    this.terminalUuid = scan.terminalUuid; this.selectedLeafOffset = scan.selectedLeafOffset;
    this.rejected = null; this.lastSnapshot = problem ? { ...scan.snapshot, problem } : scan.snapshot;
  }

  reject(scan: CcTranscriptScan, problem: string): CcTranscriptSnapshot {
    const value = { ...scan.snapshot, records: [], problem };
    this.rejected = { stamp: scan.stamp, snapshot: value }; this.lastSnapshot = value;
    return value;
  }
}

export function readTranscriptMetadata(path: string): CcTranscriptSnapshot {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const stats = fstatSync(descriptor);
    return snapshot(path, { size: stats.size, modifiedMs: stats.mtimeMs, changedMs: stats.ctimeMs, device: stats.dev, inode: stats.ino });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot(path, null);
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
}

function completeTranscript(path: string, accepted?: CcNativeRecord[]): CcTranscriptSnapshot {
  const cursor = new CcTranscriptCursor(), acceptedSet = accepted ? new Set<CcNativeRecord>() : null;
  try {
    const value = cursor.scan(path, (record, _source, _raw, _scan, acceptedIdentity) => {
      if (acceptedIdentity) acceptedSet?.add(record);
    }, true);
    if (value instanceof CcTranscriptScan) {
      if (accepted) accepted.push(...value.snapshot.records.filter(record => acceptedSet!.has(record)));
      const problem = value.problems[0];
      cursor.commit(value, problem);
      return problem ? { ...value.snapshot, problem } : value.snapshot;
    }
    return value;
  } catch (error) {
    let size: number | null = null, modifiedMs: number | null = null;
    try { const descriptor = openSync(path, "r"); try { const stats = fstatSync(descriptor); size = stats.size; modifiedMs = stats.mtimeMs; } finally { closeSync(descriptor); } } catch {}
    return { ...snapshot(path, size === null ? null : { size, modifiedMs: modifiedMs!, changedMs: 0, device: 0, inode: 0 }),
      exists: size !== null, problem: error instanceof Error ? error.message : String(error) };
  }
}

export function readCompleteTranscript(path: string): CcTranscriptSnapshot { return completeTranscript(path); }

export function readTranscriptBootstrap(path: string): { snapshot: CcTranscriptSnapshot; createdAt: string | null; firstAssistantAt: string | null } {
  const accepted: CcNativeRecord[] = [], value = completeTranscript(path, accepted);
  const firstAssistant = accepted.map(classifySourceRecord).find(source => source?.kind === "assistant");
  return { snapshot: value, createdAt: nativeCreatedAt(accepted), firstAssistantAt: firstAssistant?.timestamp ?? null };
}

export function nativeCreatedAt(records: readonly CcNativeRecord[]): string | null {
  for (const record of records) if (!record.isSidechain && typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))) return record.timestamp;
  return null;
}

export function selectedNativePath(records: readonly CcNativeRecord[]): { leafUuid: string | null; records: CcNativeRecord[]; problem?: string } {
  const byId = new Map(records.flatMap(record => nativeId(record) ? [[record.uuid as string, record] as const] : []));
  const position = new Map<string, number>();
  records.forEach((record, index) => { const id = nativeId(record); if (id && !position.has(id)) position.set(id, index); });
  const leaf = [...records].reverse().find(record => classifySourceRecord(record) !== null);
  const leafUuid = leaf ? nativeId(leaf) : null;
  if (!leafUuid) return { leafUuid: null, records: [] };
  const reverse: CcNativeRecord[] = [], seen = new Set<string>();
  let current: CcNativeRecord | undefined = leaf;
  while (current) {
    const id = nativeId(current);
    if (!id) return { leafUuid, records: [], problem: "native lineage contains a record without a UUID" };
    if (seen.has(id)) return { leafUuid, records: [], problem: `native lineage cycle at ${id}` };
    seen.add(id); reverse.push(current);
    let rawParent: string | null;
    const at = position.get(id)!;
    try { rawParent = nativeParentId(current, uuid => (position.get(uuid) ?? Infinity) < at); }
    catch (error) { return { leafUuid, records: [], problem: error instanceof Error ? error.message : String(error) }; }
    if (rawParent === null) break;
    current = byId.get(rawParent);
    if (!current) return { leafUuid, records: [], problem: `native lineage parent ${rawParent} is missing` };
  }
  return { leafUuid, records: reverse.reverse() };
}

export const ccSourceBlocks: SourceNormalizer = entry => {
  let record: CcNativeRecord;
  try { record = JSON.parse(entry.raw); } catch { return undefined; }
  const source = classifySourceRecord(record);
  if (!source || source.kind === "compaction" || source.kind !== entry.role) return undefined;
  const mapped = new Map(entry.calls.map(call => [call.callId, call]));
  const result: SourceBlock[] = [];
  if (source.kind === "assistant") {
    for (const block of blocks(record.message?.content)) {
      if (block.type === "text" && typeof block.text === "string") result.push({ kind: "text", text: block.text });
      else if (block.type === "thinking" && typeof block.thinking === "string") result.push({ kind: "thinking", text: block.thinking });
      else if (block.type === "redacted_thinking") result.push({ kind: "marker", text: "[thinking unavailable]" });
      else if (block.type === "tool_use" && typeof block.id === "string") {
        const call = mapped.get(block.id);
        if (!call) throw new SourceNormalizationError();
        result.push({ kind: "call", call });
      } else result.push({ kind: "marker", text: `[${typeof block.type === "string" ? block.type : "non-text content"} omitted]` });
    }
    return result;
  }
  if (source.kind === "toolResult") {
    for (const block of blocks(record.message?.content)) {
      if (block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
      const call = mapped.get(block.tool_use_id);
      if (!call) throw new SourceNormalizationError();
      result.push({ kind: "result", call, texts: resultTexts(block.content) });
    }
    return result;
  }
  if (typeof record.message?.content === "string") return [{ kind: "text", text: source.text }];
  for (const block of blocks(record.message?.content)) result.push(block.type === "text" && typeof block.text === "string"
    ? { kind: "text", text: block.text } : { kind: "marker", text: `[${typeof block.type === "string" ? block.type : "non-text content"} omitted]` });
  return result;
};

/** 97: the complete records written after `offset`, never anything before it. A file shorter than
 * the offset was replaced or truncated: its tail is unknown. */
export function readTranscriptTail(path: string, offset: number): CcNativeRecord[] | null {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("transcript tail offset must be a nonnegative integer");
  let descriptor: number;
  try { descriptor = openSync(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    const size = fstatSync(descriptor).size;
    if (size < offset) return null;
    const bytes = Buffer.allocUnsafe(size - offset);
    let read = 0;
    while (read < bytes.length) {
      const amount = readSync(descriptor, bytes, read, bytes.length - read, offset + read);
      if (!amount) break;
      read += amount;
    }
    const complete = bytes.subarray(0, bytes.subarray(0, read).lastIndexOf(0x0a) + 1).toString("utf8");
    return complete.split("\n").filter(Boolean).map(line => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); } catch (error) { throw new Error(`invalid completed transcript record in the tail: ${String(error)}`); }
      const record = object(parsed);
      if (!record) throw new Error("invalid completed transcript record in the tail: expected an object");
      return record as CcNativeRecord;
    });
  } finally { closeSync(descriptor); }
}

/** 97: a node of the selected chain inside a tail: a prompt, by its native prompt id, or a
 * compaction boundary, by the source record it follows (null at the root). */
export type TailNode = { prompt: string } | { follows: string | null };

/** 97: the nodes of the selected chain inside a tail, oldest first; where that chain leaves the tail
 * (the uuid of the first record before it, or null when the chain starts in the tail); and the last
 * source record in the tail, which a compaction written now would follow. */
export function tailNodes(records: readonly CcNativeRecord[]): { nodes: TailNode[]; exit: string | null; leaf: string | null } {
  const position = new Map<string, number>();
  records.forEach((record, index) => { const id = nativeId(record); if (id && !position.has(id)) position.set(id, index); });
  const leaf = [...records].reverse().find(record => classifySourceRecord(record) !== null);
  if (!leaf) return { nodes: [], exit: null, leaf: null };
  const nodes: TailNode[] = [], seen = new Set<string>();
  let current: CcNativeRecord | undefined = leaf, awaiting: { follows: string | null } | null = null;
  for (;;) {
    const id = nativeId(current)!;
    if (seen.has(id)) throw new Error(`native lineage cycle at ${id}`);
    seen.add(id);
    const source = classifySourceRecord(current);
    if (source && awaiting) { awaiting.follows = id; awaiting = null; }
    if (source?.kind === "user" && typeof current.promptId === "string" && current.promptId) nodes.unshift({ prompt: current.promptId });
    if (source?.kind === "compaction") nodes.unshift(awaiting = { follows: null });
    const at = position.get(id)!;
    const parent = nativeParentId(current, uuid => (position.get(uuid) ?? -1) < at);
    if (parent === null) return { nodes, exit: null, leaf: nativeId(leaf) };
    current = position.has(parent) ? records[position.get(parent)!] : undefined;
    if (!current) {
      if (awaiting) awaiting.follows = parent;
      return { nodes, exit: parent, leaf: nativeId(leaf) };
    }
  }
}

/** The first timestamp of a transcript, read from its start only as far as that record. */
export function readTranscriptCreatedAt(path: string): string | null {
  let descriptor: number;
  try { descriptor = openSync(path, "r"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  try {
    let pending = "", position = 0;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const amount = readSync(descriptor, chunk, 0, chunk.length, position);
      if (!amount) return null;
      position += amount;
      pending += chunk.subarray(0, amount).toString("utf8");
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
        if (!line) continue;
        let record: unknown;
        try { record = JSON.parse(line); } catch { return null; }
        const created = nativeCreatedAt([record as CcNativeRecord]);
        if (created) return created;
      }
    }
  } finally { closeSync(descriptor); }
}
