import type { CcNativeRecord } from "./transcript.ts";

function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => sameJson(value, b[index]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) || Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
}

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const blocks = (value: unknown): Record<string, unknown>[] => Array.isArray(value) ? value.map(object).filter(v => v !== null) : [];
export interface CcOriginalCandidate {
  nativeId: string;
  record: CcNativeRecord;
  kind: "user" | "assistant" | "toolResult" | "compaction";
  afterBoundary: boolean;
}
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
    part.name === row.block.name && sameJson(part.input, row.block.input);
  if (part.type === "tool_result") return typeof part.tool_use_id === "string" && part.tool_use_id === row.block.tool_use_id &&
    (part.is_error === true) === (row.block.is_error === true) && completeResult(part.content, row.block.content);
  return false;
}

/** Compare independently indexed originals to the Hook VM's actual API blocks. No native
 * filesystem, database, carrier decoder or model-supplied text participates in this check. */
export function ccOriginalRaw(selected: readonly CcOriginalCandidate[], api: unknown): Map<string, "source"> {
  const inherited = new Map<string, "source">();
  if (!Array.isArray(api)) return inherited;
  const messages = api.map(object);
  if (messages.some(message => !message || !Array.isArray(message.content))) return inherited;
  const content: Located[] = messages.flatMap(message => blocks(message!.content).map(block => ({ block, role: message!.role, at: 0 })));
  content.forEach((row, at) => { row.at = at; });
  // An identical block repeated by two native entries but present once in the API cannot establish
  // which entry survived. Refuse both rather than assigning the only visible copy to the old one.
  const eligible = selected.filter(entry => entry.afterBoundary);
  const parts = eligible.map(entry => {
    const original = entry.record.message?.content;
    if (entry.kind === "compaction") return null;
    if (entry.kind === "user" && typeof original === "string") return [{ type: "text", text: original }];
    const values = blocks(original);
    if (!Array.isArray(original) || values.length !== original.length || !values.length || values.some(part => entry.kind === "assistant"
      ? part.type !== "text" && part.type !== "tool_use"
      : entry.kind === "user" ? part.type !== "text" : part.type !== "tool_result")) return null;
    return values;
  });
  const used = new Set<number>();
  let last = -1;
  eligible.forEach((entry, index) => {
    const values = parts[index];
    if (!values) return;
    const role = entry.kind === "assistant" ? "assistant" : "user";
    const rows = values.map(part => content.filter(row => matches(part, row, role)));
    if (rows.some((group, partIndex) => group.length !== 1 || parts.some((other, otherIndex) => otherIndex !== index &&
      other?.some(candidate => matches(candidate, group[0]!, role) && sameJson(candidate, values[partIndex]))))) return;
    const positions = rows.map(group => group[0]!.at);
    // Native parallel tool results can be persisted in another order. Their call IDs, not their
    // relative result order, identify them; other entry types retain strict source order.
    const ordered = entry.kind === "toolResult" || positions.every((at, i) => at > (i ? positions[i - 1]! : last));
    if (!ordered || positions.some(at => used.has(at))) return;
    for (const at of positions) used.add(at);
    if (entry.kind !== "toolResult") last = positions.at(-1)!;
    inherited.set(entry.nativeId, "source");
  });
  return inherited;
}
