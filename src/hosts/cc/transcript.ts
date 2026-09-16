import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
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
  records: CcNativeRecord[];
  incompleteBytes: number;
  problem?: string;
}

export type CcSourceRecord =
  | { kind: "user" | "assistant" | "toolResult"; record: CcNativeRecord; nativeId: string; timestamp: string | null; text: string;
      calls: SourceInput["calls"] }
  | { kind: "compaction"; record: CcNativeRecord; nativeId: string; timestamp: string | null };

const byteLength = (value: string) => Buffer.byteLength(value, "utf8");
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

export function readCompleteTranscript(path: string): CcTranscriptSnapshot {
  let raw: string, stats, descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    raw = readFileSync(descriptor, "utf8"); stats = fstatSync(descriptor);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, exists: false, size: null, modifiedMs: null, records: [], incompleteBytes: 0 };
    throw error;
  } finally { if (descriptor !== undefined) closeSync(descriptor); }
  const newline = raw.lastIndexOf("\n"), complete = newline < 0 ? "" : raw.slice(0, newline);
  const incompleteBytes = newline < 0 ? byteLength(raw) : byteLength(raw.slice(newline + 1));
  const records: CcNativeRecord[] = [], identities = new Map<string, string>();
  for (const [index, line] of complete.split("\n").entries()) {
    if (!line) continue;
    let record: unknown;
    try { record = JSON.parse(line); }
    catch (error) { return { path, exists: true, size: stats.size, modifiedMs: stats.mtimeMs, records, incompleteBytes,
      problem: `invalid completed transcript record at line ${index + 1}: ${String(error)}` }; }
    const value = object(record);
    if (!value) return { path, exists: true, size: stats.size, modifiedMs: stats.mtimeMs, records, incompleteBytes,
      problem: `invalid completed transcript record at line ${index + 1}: expected an object` };
    const id = nativeId(value);
    if (id) {
      const serialized = JSON.stringify(value), prior = identities.get(id);
      if (prior !== undefined && prior !== serialized) return { path, exists: true, size: stats.size, modifiedMs: stats.mtimeMs, records, incompleteBytes,
        problem: `native transcript UUID ${id} changed within the completed file` };
      if (prior !== undefined) continue;
      identities.set(id, serialized);
    }
    records.push(value);
  }
  return { path, exists: true, size: stats.size, modifiedMs: stats.mtimeMs, records, incompleteBytes };
}

export function nativeCreatedAt(records: readonly CcNativeRecord[]): string | null {
  for (const record of records) if (!record.isSidechain && typeof record.timestamp === "string" && Number.isFinite(Date.parse(record.timestamp))) return record.timestamp;
  return null;
}

export function classifySourceRecord(record: CcNativeRecord): CcSourceRecord | null {
  const id = nativeId(record);
  if (!id || record.isSidechain === true || record.isCompactSummary === true || record.isVisibleInTranscriptOnly === true || record.isMeta === true) return null;
  if (record.type === "system" && record.subtype === "compact_boundary") return { kind: "compaction", record, nativeId: id, timestamp: timestamp(record) };
  if (record.type !== "user" && record.type !== "assistant") return null;
  const message = object(record.message);
  if (!message || record.message?.isCompactSummary === true || message.role !== record.type) return null;
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
    const calls: SourceInput["calls"] = [];
    for (const block of toolResults) if (typeof block.tool_use_id === "string" && block.tool_use_id) {
      calls.push({ ordinal: 0, name: "unknown", callId: block.tool_use_id,
        result: JSON.stringify({ content: block.content, toolUseResult: record.toolUseResult }), status: block.is_error === true ? "failure" : "success" });
    }
    if (calls.length !== toolResults.length) return null;
    return { kind: "toolResult", record, nativeId: id, timestamp: timestamp(record), text: "", calls };
  }
  if (!(typeof content === "string" || Array.isArray(content))) return null;
  // Pinned CC 2.1.257 records both typed TUI prompts and SDK/print prompts with
  // explicit source provenance. Local-command envelopes omit promptSource (their
  // caveat is additionally isMeta), so classification never depends on payload text.
  const origin = object(record.origin);
  const typedHuman = record.promptSource === "typed" && origin?.kind === "human";
  const sdkExternal = record.promptSource === "sdk";
  if (record.userType !== "external" || typeof record.promptId !== "string" || !record.promptId || !(typedHuman || sdkExternal)) return null;
  return { kind: "user", record, nativeId: id, timestamp: timestamp(record), text: textBlocks(content).join("\n"), calls: [] };
}

export function selectedNativePath(records: readonly CcNativeRecord[]): { leafUuid: string | null; records: CcNativeRecord[]; problem?: string } {
  const byId = new Map(records.flatMap(record => nativeId(record) ? [[record.uuid as string, record] as const] : []));
  // Physical transcript order is the persistence order. A last-prompt record is only a native
  // checkpoint: it can remain on an abandoned sibling after a newer eligible source is complete.
  // Excluded records may connect ancestry, but cannot become the selection authority themselves.
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
    const rawParent = current.logicalParentUuid ?? current.parentUuid;
    if (rawParent === null || rawParent === undefined) break;
    if (typeof rawParent !== "string" || !rawParent)
      return { leafUuid, records: [], problem: `native lineage parent of ${id} is invalid` };
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
  if (typeof record.message?.content === "string") return [{ kind: "text", text: record.message.content }];
  for (const block of blocks(record.message?.content)) result.push(block.type === "text" && typeof block.text === "string"
    ? { kind: "text", text: block.text } : { kind: "marker", text: `[${typeof block.type === "string" ? block.type : "non-text content"} omitted]` });
  return result;
};
