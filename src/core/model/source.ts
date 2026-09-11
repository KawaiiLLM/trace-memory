import type { SourceEntry, SourceInput } from "../store/index.ts";
import { callSelector, parseTurnAddress } from "./address.ts";

export type SourceBlock = { kind: "text" | "thinking" | "marker"; text: string }
  | { kind: "call" | "result"; call: SourceInput["calls"][number]; texts?: string[] };
/** A host decodes its own immutable native envelope once, not in each rendering consumer. */
export type SourceNormalizer = (entry: SourceInput) => SourceBlock[] | undefined;
export const entryAddress = (entry: Pick<SourceEntry, "turnId" | "entryOrdinal">): string => `T${entry.turnId}#E${entry.entryOrdinal}`;

/** Legacy projections cannot prove block interleaving or precise fragment existence. They remain
 * readable/citable at the original legacy addresses and the whole stable entry, not invented parts. */
export function sourceBlocks(entry: SourceEntry): SourceBlock[] {
  return entry.blocks ?? [...(entry.text ? [{ kind: "text" as const, text: entry.text }] : entry.role === "user"
    ? [{ kind: "marker" as const, text: "[non-text content omitted]" }] : []),
    ...entry.calls.map(call => ({ kind: entry.role === "toolResult" ? "result" as const : "call" as const, call }))];
}
export const fragmentAddress = (entry: SourceEntry, block: SourceBlock): string => !entry.blocks || block.kind === "marker" ? entryAddress(entry)
  : `${entryAddress(entry)}@${block.kind === "call" || block.kind === "result" ? callSelector(block.call.callId) : block.kind}`;
export const blockText = (block: Extract<SourceBlock, { call: unknown }>): string => (block.texts ?? [block.call.result ?? ""]).join("\n");
export const resultHasText = (entry: SourceEntry): boolean => sourceBlocks(entry).some(block => block.kind === "result" && blockText(block).length > 0);

/** Non-text placeholders are displayable, but never evidence. */
export function preciseSources(entry: SourceEntry): string[] {
  const blocks = sourceBlocks(entry).filter(block => block.kind !== "marker");
  if (!blocks.length) return [];
  return [entryAddress(entry), ...(entry.blocks ? [...new Set(blocks.map(block => fragmentAddress(entry, block))),
    ...(entry.role === "toolResult" && resultHasText(entry) ? [`${entryAddress(entry)}@text`] : [])] : [])];
}
/** Narrow read adapter: historic role/tool-ordinal citations retain their original meaning. */
export const legacySources = (entry: Pick<SourceEntry, "turnId" | "role" | "text" | "calls">): string[] => [
  ...(entry.text ? [`T${entry.turnId}#${entry.role === "user" ? "user" : "assistant"}`] : []),
  ...entry.calls.map(call => `T${entry.turnId}#t${call.ordinal}`),
];
export const sourceAddresses = (entry: SourceEntry): string[] => [...legacySources(entry), ...preciseSources(entry)];
/** Membership key only: preserve the authored citation string, but compare equivalent JSON
 * spellings of an opaque ID against the same persisted block authority. */
export function sourceKey(address: string): string {
  let parsed;
  try { parsed = parseTurnAddress(address); } catch { return address; }
  if (!parsed || parsed.session !== undefined || parsed.legacy || parsed.entries?.length !== 1 || parsed.entries[0]!.to !== undefined) return address;
  const base = `T${parsed.turn}#E${parsed.entries[0]!.from}`, selector = parsed.selector;
  return selector?.kind === "call" ? `${base}@${callSelector(selector.id)}` : address;
}
export function exactSource(entry: SourceEntry, address: string): boolean {
  let parsed;
  try { parsed = parseTurnAddress(address); } catch { return false; }
  if (!parsed || parsed.session !== undefined || parsed.turn !== entry.turnId || parsed.legacy || parsed.entries?.length !== 1
    || parsed.entries[0]!.to !== undefined || parsed.entries[0]!.from !== entry.entryOrdinal) return false;
  const selection = parsed.selector;
  if (!selection) return preciseSources(entry).includes(entryAddress(entry));
  if (!entry.blocks || selection.kind === "role" || selection.kind === "facts") return false;
  if (selection.kind === "call") return sourceBlocks(entry).some(block => (block.kind === "call" || block.kind === "result") && block.call.callId === selection.id);
  return preciseSources(entry).includes(`${entryAddress(entry)}@${selection.kind}`);
}
