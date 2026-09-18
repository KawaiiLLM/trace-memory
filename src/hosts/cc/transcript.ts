import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { SourceNormalizationError, type SourceBlock, type SourceNormalizer } from "../../core/model/source.ts";
import type { SourceInput } from "../../core/store/index.ts";

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
}

interface FileStamp { size: number; modifiedMs: number; changedMs: number; device: number; inode: number }
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

export class CcNativeLineageError extends Error {}

/** Decode native lineage exactly once. A malformed present value is not an absent parent. */
export function nativeParentId(record: CcNativeRecord): string | null {
  const value = record.logicalParentUuid ?? record.parentUuid;
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value) throw new CcNativeLineageError(
    `native lineage parent of ${nativeId(record) ?? "record without UUID"} is invalid`);
  return value;
}

const snapshot = (path: string, stamp: FileStamp | null, values: Partial<CcTranscriptSnapshot> = {}): CcTranscriptSnapshot => ({
  path, exists: stamp !== null, size: stamp?.size ?? null, modifiedMs: stamp?.modifiedMs ?? null,
  changedMs: stamp?.changedMs ?? null, device: stamp?.device ?? null, inode: stamp?.inode ?? null,
  completeBytes: 0, recordCount: 0, records: [], incompleteBytes: 0, changed: false, reset: false, ...values,
});

export function classifySourceRecord(record: CcNativeRecord): CcSourceRecord | null {
  const id = nativeId(record);
  if (!id || record.isSidechain === true || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true) return null;
  if (record.type === "system" && record.subtype === "compact_boundary" && record.isMeta !== true)
    return { kind: "compaction", record, nativeId: id, timestamp: timestamp(record) };
  if (record.type !== "user" && record.type !== "assistant") return null;
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
  const nativePrompt = ["typed", "queued", "sdk", "system"].includes(String(record.promptSource));
  const humanPrompt = record.isMeta !== true && record.origin?.kind === "human";
  if (!nativePrompt && !humanPrompt) return null;
  const text = !nativePrompt && typeof content === "string" ? humanCommandPrompt(content) ?? content : textBlocks(content).join("\n");
  return { kind: "user", record, nativeId: id, timestamp: timestamp(record), text, calls: [] };
}

const nodeOf = (record: CcNativeRecord): CcNativeNode | null => {
  const uuid = nativeId(record);
  if (!uuid) return null;
  const source = classifySourceRecord(record);
  try {
    return { uuid, parentUuid: nativeParentId(record), sourceKind: source?.kind ?? null,
      calls: source?.kind === "assistant" ? source.calls.map(call => ({ id: call.callId, name: call.name })) : [], timestamp: source?.timestamp ?? timestamp(record) };
  } catch (error) {
    if (!(error instanceof CcNativeLineageError)) throw error;
    return { uuid, parentUuid: null, sourceKind: source?.kind ?? null,
      calls: source?.kind === "assistant" ? source.calls.map(call => ({ id: call.callId, name: call.name })) : [], timestamp: source?.timestamp ?? timestamp(record), lineageProblem: error.message };
  }
};

export class CcTranscriptScan {
  readonly nodes: Map<string, CcNativeNode>;
  readonly snapshot: CcTranscriptSnapshot;
  readonly callCarriers: Map<string, Set<string>>;
  readonly stamp: FileStamp;
  readonly reset: boolean;
  readonly completeOffset: number;
  readonly lineCount: number;
  readonly selectedLeafUuid: string | null;
  readonly problems: string[];
  readonly newProblems: Set<string>;

  constructor(input: { nodes: Map<string, CcNativeNode>; callCarriers: Map<string, Set<string>>; snapshot: CcTranscriptSnapshot;
    stamp: FileStamp; reset: boolean; completeOffset: number; lineCount: number; selectedLeafUuid: string | null;
    problems?: string[]; newProblems?: Set<string> }) {
    this.nodes = input.nodes; this.callCarriers = input.callCarriers;
    this.snapshot = input.snapshot; this.stamp = input.stamp; this.reset = input.reset;
    this.completeOffset = input.completeOffset; this.lineCount = input.lineCount; this.selectedLeafUuid = input.selectedLeafUuid;
    this.problems = input.problems ?? [];
    this.newProblems = input.newProblems ?? new Set();
  }

  node(uuid: string): CcNativeNode | undefined { return this.nodes.get(uuid); }

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

  selectedPath(): { leafUuid: string | null; nodes: CcNativeNode[]; problem?: string } {
    if (!this.selectedLeafUuid) return { leafUuid: null, nodes: [] };
    const reverse: CcNativeNode[] = [], seen = new Set<string>();
    let current = this.node(this.selectedLeafUuid);
    while (current) {
      if (seen.has(current.uuid)) return { leafUuid: this.selectedLeafUuid, nodes: [], problem: `native lineage cycle at ${current.uuid}` };
      if (current.lineageProblem) return { leafUuid: this.selectedLeafUuid, nodes: [], problem: current.lineageProblem };
      if (current.importProblem) return { leafUuid: this.selectedLeafUuid, nodes: [], problem: current.importProblem };
      seen.add(current.uuid); reverse.push(current);
      if (current.parentUuid === null) break;
      current = this.node(current.parentUuid);
      if (!current) return { leafUuid: this.selectedLeafUuid, nodes: [], problem: `native lineage parent ${reverse.at(-1)!.parentUuid} is missing` };
    }
    return { leafUuid: this.selectedLeafUuid, nodes: reverse.reverse() };
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
  private nodes = new Map<string, CcNativeNode>();
  private callCarriers = new Map<string, Set<string>>();
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

  scan(path: string, visit: (record: CcNativeRecord, source: CcSourceRecord | null, raw: string,
    scan: CcTranscriptScan, acceptedIdentity: boolean) => void, collect = false): CcTranscriptScan | CcTranscriptSnapshot {
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "r");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return snapshot(path, null);
      throw error;
    }
    try {
      const before = fstatSync(descriptor);
      const stamp: FileStamp = { size: before.size, modifiedMs: before.mtimeMs, changedMs: before.ctimeMs, device: before.dev, inode: before.ino };
      if (this.rejected && sameStamp(this.rejected.stamp, stamp)) return this.rejected.snapshot;
      if (sameStamp(this.stamp, stamp)) return { ...this.lastSnapshot!, records: [], changed: false, reset: false };
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
      const records: CcNativeRecord[] = [], collectedById = new Map<string, { record: CcNativeRecord; identity: string }>();
      const parsedRecords: { record: CcNativeRecord; source: CcSourceRecord | null; raw: string; node: CcNativeNode | null }[] = [];
      // Appends extend the committed structural index in place. Its cursor offset is not advanced
      // until projection and binding succeed, so a fatal retry rereads the suffix and fills only
      // committed source associations. A reset builds a replacement index off to the side.
      const scanNodes = reset ? new Map<string, CcNativeNode>() : this.nodes;
      const scanCalls = reset ? new Map<string, Set<string>>() : this.callCarriers;
      const problems = reset ? [] : [...this.unresolvedProblems], newProblems = new Set<string>();
      let selectedLeafUuid = reset ? null : this.selectedLeafUuid;
      let physicalRecords = reset ? 0 : this.recordCount;
      let lines = reset ? 0 : this.lineCount;
      const preliminary = snapshot(path, stamp, { completeBytes: completeOffset, recordCount: physicalRecords,
        incompleteBytes: stamp.size - completeOffset, changed: true, reset });
      const scan = new CcTranscriptScan({ nodes: scanNodes, callCarriers: scanCalls, snapshot: preliminary, stamp, reset,
        completeOffset, lineCount: lines, selectedLeafUuid, problems, newProblems });
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
        let source = classifySourceRecord(record), node = nodeOf(record);
        if (node) {
          const prior = scanNodes.get(node.uuid), collected = collectedById.get(node.uuid), identity = nativeIdentity(record);
          if (prior && (prior.parentUuid !== node.parentUuid || prior.sourceKind !== node.sourceKind || prior.lineageProblem !== node.lineageProblem) ||
              collected && collected.identity !== identity) {
            const problem = `native transcript UUID ${node.uuid} changed within the completed file`;
            scan.markProblem(node.uuid, problem);
            source = null; node = null;
          } else {
            if (!prior) {
              scanNodes.set(node.uuid, node);
              for (const call of node.calls) {
                const carriers = scanCalls.get(call.id) ?? new Set<string>();
                carriers.add(node.uuid); scanCalls.set(call.id, carriers);
              }
            }
            if (!collected) collectedById.set(node.uuid, { record, identity });
            if (source) selectedLeafUuid = node.uuid;
          }
        }
        if (collect) records.push(record);
        parsedRecords.push({ record, source, raw, node });
      }
      // Visit each native identity after all suffix nodes are known, in ancestry order. This resolves
      // a result/call pair that is physically reversed without replaying historical records.
      const unique = new Map(parsedRecords.filter(value => value.node).map(value => [value.node!.uuid, value] as const));
      const visiting = new Set<string>(), visited = new Set<string>();
      const ordered: typeof parsedRecords = [];
      const add = (value: (typeof parsedRecords)[number]): void => {
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
      for (const value of ordered) {
        const acceptedIdentity = nativeId(value.record) === null || !!value.node &&
          !value.node.lineageProblem && !value.node.importProblem;
        try { visit(value.record, value.source, value.raw, scan, acceptedIdentity); }
        catch (error) { throw new CcTranscriptScanFailure(scan, error); }
      }
      const resultSnapshot = snapshot(path, stamp, { completeBytes: completeOffset, recordCount: physicalRecords, records,
        incompleteBytes: stamp.size - completeOffset, changed: true, reset });
      return new CcTranscriptScan({ nodes: scanNodes, callCarriers: scanCalls, snapshot: resultSnapshot, stamp, reset,
        completeOffset, lineCount: lines, selectedLeafUuid, problems, newProblems });
    } finally { closeSync(descriptor); }
  }

  commit(scan: CcTranscriptScan, problem?: string): void {
    if (scan.reset) this.unresolvedProblems.clear();
    for (const value of scan.newProblems) this.unresolvedProblems.add(value);
    if (scan.reset) { this.nodes = scan.nodes; this.callCarriers = scan.callCarriers; }
    this.stamp = scan.stamp; this.completeOffset = scan.completeOffset;
    this.lineCount = scan.lineCount; this.recordCount = scan.snapshot.recordCount; this.selectedLeafUuid = scan.selectedLeafUuid;
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
    try { rawParent = nativeParentId(current); }
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
