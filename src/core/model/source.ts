import type { SourceEntry } from "../store/index.ts";
import { callSelector, parseTurnAddress } from "./address.ts";

export type SourceBlock = { kind: "text" | "thinking" | "marker"; text: string }
  | { kind: "call" | "result"; call: SourceEntry["calls"][number] };
export const entryAddress = (entry: Pick<SourceEntry, "turnId" | "entryOrdinal">): string => `T${entry.turnId}#E${entry.entryOrdinal}`;

/** Recover only the recorded role/content shape, never signatures or opaque thinking. Older
 * host-neutral records without blocks retain their text/call projection and original order. */
export function sourceBlocks(entry: SourceEntry): SourceBlock[] {
  if (entry.role === "toolResult") return entry.calls.map(call => ({ kind: "result", call }));
  let raw: unknown;
  try { raw = JSON.parse(entry.raw); } catch { /* Non-JSON hosts use their text/call projection. */ }
  const message = raw && typeof raw === "object" ? raw as Record<string, unknown> : undefined;
  if (message?.role === entry.role && Array.isArray(message.content)) {
    const blocks: SourceBlock[] = [];
    const calls = new Map(entry.calls.map(call => [call.callId, call]));
    for (const value of message.content) {
      if (!value || typeof value !== "object") continue;
      const block = value as Record<string, unknown>;
      if (block.type === "text" && typeof block.text === "string") blocks.push({ kind: "text", text: block.text });
      else if (block.type === "thinking") {
        if (typeof block.thinking === "string" && block.thinking.length) blocks.push({ kind: "thinking", text: block.thinking });
      } else if (block.type === "toolCall") {
        const call = typeof block.id === "string" ? calls.get(block.id) : undefined;
        if (call) { blocks.push({ kind: "call", call }); calls.delete(call.callId); }
      } else blocks.push({ kind: "marker", text: `[${typeof block.type === "string" && /^[\w-]+$/.test(block.type) ? block.type : "non-text content"} omitted]` });
    }
    // Missing calls in a purported native block sequence must not disappear from evidence.
    if (calls.size) return [...(entry.text ? [{ kind: "text" as const, text: entry.text }] : []), ...entry.calls.map(call => ({ kind: "call" as const, call }))];
    return blocks;
  }
  return [...(entry.text ? [{ kind: "text" as const, text: entry.text }] : entry.role === "user"
    ? [{ kind: "marker" as const, text: "[non-text content omitted]" }] : []), ...entry.calls.map(call => ({ kind: "call" as const, call }))];
}
export const fragmentAddress = (entry: SourceEntry, block: SourceBlock): string => `${entryAddress(entry)}@${block.kind === "call" || block.kind === "result" ? callSelector(block.call.callId) : block.kind === "thinking" ? "thinking" : "text"}`;

/** Precise addresses establish actual block existence. Non-text placeholders are not evidence. */
export function preciseSources(entry: SourceEntry): string[] {
  const blocks = sourceBlocks(entry).filter(block => block.kind !== "marker");
  return blocks.length ? [entryAddress(entry), ...new Set(blocks.map(block => fragmentAddress(entry, block))),
    ...(entry.role === "toolResult" && entry.calls.some(call => resultHasText(call.result)) ? [`${entryAddress(entry)}@text`] : [])] : [];
}
export function resultHasText(result?: string): boolean {
  if (!result) return false;
  try {
    const value = JSON.parse(result);
    if (value && Array.isArray(value.content)) return value.content.some((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.length);
  } catch { /* Plain result text is text. */ }
  return true;
}
export function exactSource(entry: SourceEntry, address: string): boolean {
  let parsed;
  try { parsed = parseTurnAddress(address); } catch { return false; }
  if (!parsed || parsed.turn !== entry.turnId || parsed.legacy || parsed.entries?.length !== 1
    || parsed.entries[0]!.to !== undefined || parsed.entries[0]!.from !== entry.entryOrdinal) return false;
  const selection = parsed.selector;
  if (!selection) return preciseSources(entry).includes(entryAddress(entry));
  if (selection.kind === "role" || selection.kind === "facts") return false;
  if (selection.kind === "call") return entry.calls.some(c => c.callId === selection.id);
  return preciseSources(entry).includes(`${entryAddress(entry)}@${selection.kind}`);
}
