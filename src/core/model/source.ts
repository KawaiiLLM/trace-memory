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
export interface SourceResolution { entry: SourceEntry; blocks: SourceBlock[] }
/** Resolve once against a writer's path. The returned blocks serve eligibility, immutable binding
 * and completion checks alike. Legacy role aliases select text, not their entry's dispatches. */
export function resolveSource(entries: readonly SourceEntry[], address: string): SourceResolution[] {
  let parsed;
  try { parsed = parseTurnAddress(address); } catch { return []; }
  if (!parsed || parsed.session !== undefined) return [];
  const { turn, legacy, selector, entries: selection } = parsed;
  if (!legacy && (selection?.length !== 1 || selection[0]!.to !== undefined)) return [];
  return entries.flatMap(entry => {
    if (entry.turnId !== turn) return [];
    let blocks = sourceBlocks(entry).filter(block => block.kind !== "marker");
    if (legacy) {
      if (!legacySources(entry).includes(address)) return [];
      blocks = blocks.filter(block => legacy === "user" || legacy === "assistant" ? block.kind === "text"
        : (block.kind === "call" || block.kind === "result") && legacy === `t${block.call.ordinal}`);
    } else {
      if (entry.entryOrdinal !== selection![0]!.from) return [];
      if (selector) {
        if (!entry.blocks) return [];
        blocks = blocks.filter(block => selector.kind === "call"
          ? (block.kind === "call" || block.kind === "result") && block.call.callId === selector.id
          : selector.kind === "text" ? block.kind === "text" || block.kind === "result" && blockText(block).length > 0
          : selector.kind === "thinking" && block.kind === "thinking");
      }
    }
    return blocks.length ? [{ entry, blocks }] : [];
  });
}
export function exactSource(entry: SourceEntry, address: string): boolean {
  return !/#(?:user|assistant|t\d+)$/.test(address) && resolveSource([entry], address).length > 0;
}
