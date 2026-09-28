import { isDeepStrictEqual } from "node:util";
import { classifySourceRecord, ccCarrierStart, ccStripAutoContinue, COMPACTION_SUMMARY_SUFFIX, type CcNativeRecord } from "./transcript.ts";
import { decodeCcInjection, type CcVisibleBinding } from "./injection.ts";

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const blocks = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object).filter(v => v !== null) : [];
export interface CcRawCandidate { nativeId: string; record: CcNativeRecord; afterBoundary: boolean }
type Located = { block: Record<string, unknown>; role: unknown; at: number };

function completeResult(original: unknown, visible: unknown): boolean {
  const before = typeof original === "string" ? [{ type: "text", text: original }] : blocks(original);
  const after = blocks(visible);
  if (Array.isArray(original) && before.length !== original.length || Array.isArray(visible) && after.length !== visible.length ||
      !before.length || after.length < before.length || before.some(block => block.type !== "text" || typeof block.text !== "string")) return false;
  return before.every((block, index) => {
    const actual = after[index];
    return actual?.type === "text" && typeof actual.text === "string" &&
      (actual.text === block.text || actual.text === `${block.text}\n`);
  });
}

function matches(part: Record<string, unknown>, row: Located, role: "user" | "assistant"): boolean {
  if (row.role !== role || part.type !== row.block.type) return false;
  if (part.type === "text") return part.text === row.block.text && typeof part.text === "string";
  if (part.type === "tool_use") return typeof part.id === "string" && part.id === row.block.id &&
    part.name === row.block.name && isDeepStrictEqual(part.input, row.block.input);
  if (part.type === "tool_result") return typeof part.tool_use_id === "string" && part.tool_use_id === row.block.tool_use_id &&
    (part.is_error === true) === (row.block.is_error === true) && completeResult(part.content, row.block.content);
  return false;
}

/** Host supplies only the already-selected entries and their latest-confirmed-compaction membership;
 * this helper never rebuilds a second native ancestry. Historical default messages are not coverage. */
export function ccInheritedRaw(selected: readonly CcRawCandidate[], api: unknown,
  envelope?: { binding: CcVisibleBinding; nativeIdForEntry: (id: number) => string | undefined;
    recorded: (header: NonNullable<ReturnType<typeof decodeCcInjection>>, kind: "compact" | "session-start") => boolean }): Map<string, "source" | "view"> {
  const inherited = new Map<string, "source" | "view">();
  if (!Array.isArray(api)) return inherited;
  const messages = api.map(object);
  if (messages.some(message => !message || !Array.isArray(message.content))) return inherited;
  const content: Located[] = messages.flatMap(message => blocks(message!.content).map(block => ({ block, role: message!.role, at: 0 })));
  content.forEach((row, at) => { row.at = at; });
  const byNative = new Set(selected.map(entry => entry.nativeId));
  if (envelope) for (const { block, role } of content) {
    if (role !== "user" || block.type !== "text" || typeof block.text !== "string") continue;
    const normalized = ccStripAutoContinue(block.text.endsWith("\n") ? block.text.slice(0, -1) : block.text);
    const start = ccCarrierStart(normalized);
    let kind: "compact" | "session-start", encoded: string;
    if (start >= 0 && (start === 0 || normalized.endsWith(COMPACTION_SUMMARY_SUFFIX))) {
      kind = "compact";
      encoded = start === 0 ? normalized : normalized.slice(start, -COMPACTION_SUMMARY_SUFFIX.length);
    } else {
      const prefix = "<system-reminder>\nSessionStart hook additional context: ", suffix = "\n</system-reminder>";
      if (!normalized.startsWith(prefix) || !normalized.endsWith(suffix)) continue;
      kind = "session-start";
      encoded = normalized.slice(prefix.length, -suffix.length);
    }
    const header = decodeCcInjection(encoded, envelope.binding);
    if (!header || !envelope.recorded(header, kind)) continue;
    for (const entryId of header.entryIds) {
      const nativeId = envelope.nativeIdForEntry(entryId);
      if (nativeId && byNative.has(nativeId)) inherited.set(nativeId, "view");
    }
  }
  // An identical block repeated by two native entries but present once in the API cannot establish
  // which entry survived. Refuse both rather than assigning the only visible copy to the old one.
  const eligible = selected.filter(entry => entry.afterBoundary);
  const parts = eligible.map(entry => {
    const source = classifySourceRecord(entry.record), original = entry.record.message?.content;
    if (!source || source.kind === "compaction") return null;
    if (source.kind === "user" && typeof original === "string") return [{ type: "text", text: source.text }];
    const values = blocks(original);
    if (!Array.isArray(original) || values.length !== original.length || !values.length || values.some(part => source.kind === "assistant"
      ? part.type !== "text" && part.type !== "tool_use"
      : source.kind === "user" ? part.type !== "text" : part.type !== "tool_result")) return null;
    return values;
  });
  const used = new Set<number>();
  let last = -1;
  eligible.forEach((entry, index) => {
    const values = parts[index];
    if (!values) return;
    const source = classifySourceRecord(entry.record)!;
    const role = source.kind === "assistant" ? "assistant" : "user";
    const rows = values.map(part => content.filter(row => matches(part, row, role)));
    if (rows.some((group, partIndex) => group.length !== 1 || parts.some((other, otherIndex) => otherIndex !== index &&
      other?.some(candidate => matches(candidate, group[0]!, role) && isDeepStrictEqual(candidate, values[partIndex]))))) return;
    const positions = rows.map(group => group[0]!.at);
    // Native parallel tool results can be persisted in another order. Their call IDs, not their
    // relative result order, identify them; other entry types retain strict source order.
    const ordered = source.kind === "toolResult" || positions.every((at, i) => at > (i ? positions[i - 1]! : last));
    if (!ordered || positions.some(at => used.has(at))) return;
    for (const at of positions) used.add(at);
    if (source.kind !== "toolResult") last = positions.at(-1)!;
    inherited.set(entry.nativeId, "source");
  });
  return inherited;
}
