import type { SourceEntry, SourceInput } from "../store/index.ts";
import { callSelector, parseTurnAddress, type TurnAddress } from "./address.ts";

export type SourceBlock = { kind: "text" | "thinking" | "marker"; text: string }
  | { kind: "call" | "result"; call: SourceInput["calls"][number]; texts?: string[] };
/** A host decodes its own immutable native envelope once, not in each rendering consumer. */
export type SourceNormalizer = (entry: SourceInput) => SourceBlock[] | undefined;
/** Recognized native/projection mismatch only. Storage and unexpected decoder errors stay fatal. */
export class SourceNormalizationError extends Error {
  constructor() { super("native call identity lacks a unique stored mapping"); this.name = "SourceNormalizationError"; }
}
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

/** Stored source membership, not new-fact permission. Non-text placeholders carry no proof. */
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
/** Preserve historical thinking membership for applicability/coverage, independently of new writes. */
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
/** The guard `resolveSource` applies before any block-level check: an address must name exactly one
 * turn, unqualified by session, and — unless it is a legacy alias — exactly one entry ordinal (no
 * range, no list). Both are metadata fields (`SourceEntryMeta.turnId`/`entryOrdinal`), so 79 item 2
 * reuses this same guard, via `sourceAddressScope` below, to narrow candidates before any body is
 * read; `resolveSource` keeps using it to decide whether to look further into the body at all. One
 * parse, one guard, so the two can never drift apart. */
function parseSourceAddress(address: string): (TurnAddress & { turn: number }) | null {
  let parsed: TurnAddress | null;
  try { parsed = parseTurnAddress(address); } catch { return null; }
  if (!parsed || parsed.session !== undefined) return null;
  const { legacy, entries: selection } = parsed;
  if (!legacy && (selection?.length !== 1 || selection[0]!.to !== undefined)) return null;
  return parsed as TurnAddress & { turn: number };
}
/** 79 item 2: which turn (and, for a precise single-ordinal address, which ordinal) a source address
 * could possibly resolve against — decidable from metadata alone, before any body is read. `null`
 * means the address cannot resolve to anything, matching `resolveSource`'s own early return. */
export function sourceAddressScope(address: string): { turn: number; ordinal?: number } | null {
  const parsed = parseSourceAddress(address);
  return parsed ? { turn: parsed.turn, ordinal: parsed.legacy ? undefined : parsed.entries![0]!.from } : null;
}
/** Resolve once against a writer's path. The returned blocks serve eligibility, immutable binding
 * and completion checks alike. Legacy role aliases select text, not their entry's dispatches. */
export function resolveSource(entries: readonly SourceEntry[], address: string): SourceResolution[] {
  const parsed = parseSourceAddress(address);
  if (!parsed) return [];
  const { turn, legacy, selector, entries: selection } = parsed;
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
/** New facts use only public text/call/result evidence. Whole mixed entries exclude thinking;
 * explicit thinking and thinking-only entries resolve to no factual evidence. Reads are unchanged. */
export function resolveFactSource(entries: readonly SourceEntry[], address: string): SourceResolution[] {
  return resolveSource(entries, address).flatMap(hit => {
    const blocks = hit.blocks.filter(block => block.kind !== "thinking");
    return blocks.length ? [{ entry: hit.entry, blocks }] : [];
  });
}
export function exactSource(entry: SourceEntry, address: string): boolean {
  return !/#(?:user|assistant|t\d+)$/.test(address) && resolveSource([entry], address).length > 0;
}
