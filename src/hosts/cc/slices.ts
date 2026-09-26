import { ccInjectionLength, encodeCcInjection, type CcHookOutput, type CcVisibleBinding } from "./injection.ts";
import { expandList, knowledgeBlockParts } from "../../core/render/index.ts";
import { transportItemText, type TransportItem } from "../../core/render/material.ts";
import { tokens } from "../../core/render/tokens.ts";

export const CC_SLICE_COUNT = 24;
export const CC_SLICE_LIMIT = 10_000;
export const CC_KNOWLEDGE_RECENCY_NOTICE = "Within one rendered set of 24 segments, order knowledge by the header's p[0] segment number, then by position within that segment: higher segments and later items are newer. Arrival order is not recency. For claims about the same object, the newer item takes precedence until maintenance merges them.";

const address = (item: TransportItem): string => item.kind === "knowledge" ? item.address
  : item.kind === "fact" ? `F${item.factId}` : item.kind === "raw" ? item.address
  : item.kind === "state" ? item.address : "";

/** Transport selection only: core has already selected and rendered whole items. Pack their
 * unchanged texts under the native per-hook limit; never identify members from arbitrary prose.
 * Capacity drops the lowest-priority whole item and names it in a receipt. */
export function sliceCcInjection(binding: CcVisibleBinding, items: readonly TransportItem[],
  warning?: string): (CcHookOutput | null)[] {
  const slots: { items: TransportItem[] }[] = Array.from({ length: CC_SLICE_COUNT }, () => ({ items: [] }));
  const omitted: string[] = [];
  let pendingRaw = 0, pendingFacts = 0, pendingFactTokens = 0;
  const omit = (item: TransportItem): void => {
    omitted.push(address(item));
    if (item.kind === "raw" && item.pending) pendingRaw++;
    if (item.kind === "fact" && item.pending) { pendingFacts++; pendingFactTokens += tokens(item.text); }
  };
  const rank = (item: TransportItem): number => item.kind === "state" ? 0 : item.kind === "knowledge" ? 1
    : item.kind === "raw" ? 2 : item.kind === "fact" ? 3 : 4;
  const ordered = [...items].sort((a, b) => rank(a) - rank(b) ||
    (a.kind === "knowledge" && b.kind === "knowledge" ? b.commitId - a.commitId : 0));
  const membership = (members: TransportItem[], index: number) => ({
    knowledgeCommitIds: members.flatMap(item => item.kind === "knowledge" ? [item.commitId] : []),
    knowledgeStates: members.flatMap(item => item.kind === "state" ? [item.receipt] : []),
    factIds: members.flatMap(item => item.kind === "fact" ? [item.factId] : []),
    entryIds: members.flatMap(item => item.kind === "raw" ? [item.entryId] : []),
    slice: [index, CC_SLICE_COUNT] as [number, number],
  });
  const itemText = (item: TransportItem) => transportItemText(item, CC_KNOWLEDGE_RECENCY_NOTICE);
  // One exact assembly for both trial size and emitted bytes. Parts reference immutable item
  // text; trials neither join full bodies nor compute digests. Each carrier has one knowledge list.
  const assemble = (items: TransportItem[], index: number) => {
    const members = [...items].sort((a, b) => rank(a) - rank(b) ||
      (a.kind === "knowledge" && b.kind === "knowledge" ? a.commitId - b.commitId : 0));
    const knowledge = knowledgeBlockParts(members.filter(item => item.kind === "knowledge")
      .map(item => ({ category: "items", text: item.text })), CC_KNOWLEDGE_RECENCY_NOTICE);
    const sections = [
      ...members.filter(item => item.kind === "state").map(item => [itemText(item)]),
      ...(knowledge.length ? [knowledge] : []),
      ...members.filter(item => item.kind !== "state" && item.kind !== "knowledge").map(item => [itemText(item)]),
    ];
    return { membership: membership(members, index), parts: sections.flatMap((section, at) => at ? ["\n\n", ...section] : section) };
  };
  const encode = (members: TransportItem[], index: number) => {
    const assembled = assemble(members, index);
    return encodeCcInjection(binding, { ...assembled.membership, text: assembled.parts.join("") });
  };
  const size = (members: TransportItem[], index: number) => {
    const assembled = assemble(members, index);
    return ccInjectionLength(binding, assembled.membership, assembled.parts.reduce((sum, part) => sum + part.length, 0));
  };
  const tryPlace = (item: TransportItem): boolean => {
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      const members = [...slot.items, item];
      if (size(members, index) <= CC_SLICE_LIMIT) {
        slot.items = members; return true;
      }
    }
    return false;
  };
  // Core's receipts are mandatory material. A legacy unbounded receipt must still name the
  // actual omission rather than displace it with an unrelated transport-capacity failure.
  for (const item of ordered.filter(item => item.kind === "receipt")) {
    if (tryPlace(item)) continue;
    const count = item.text.match(/omitted (\d+)/)?.[1];
    const expansion = item.text.split("expand: ")[1];
    const addresses = expansion?.match(/(?:K\d+(?:@v\d+)?|F\d+|T\d+#E\d+)/g) ?? [];
    const compact: TransportItem = { kind: "receipt", text: `omitted ${count ?? "1"} ${count ? "items" : "receipt"}; expand: ${expandList(addresses)}` };
    if (!addresses.length || !tryPlace(compact)) throw new Error("CC core omission receipt has no usable expansion address");
  }
  for (const item of ordered.filter(item => item.kind === "state")) if (!tryPlace(item)) omit(item);
  const base = slots.map(slot => ({ items: [...slot.items] }));
  const selected: Extract<TransportItem, { kind: "knowledge" }>[] = [];
  const packKnowledge = (knowledge: typeof selected) => {
    const packed = base.map(slot => ({ items: [...slot.items] }));
    let index = 0;
    for (const item of [...knowledge].sort((a, b) => a.commitId - b.commitId)) {
      // Knowledge never backfills a previous segment. Facts and Raw retain first-fit below.
      while (index < packed.length) {
        const slot = packed[index]!;
        if (size([...slot.items, item], index) <= CC_SLICE_LIMIT) {
          slot.items.push(item); break;
        }
        index++;
      }
      if (index === packed.length) return undefined;
    }
    return packed;
  };
  // Preserve newest-priority admission even though the admitted bodies must be placed oldest-first.
  // A rejected older/oversized item cannot evict a newer admitted version.
  for (const item of ordered) if (item.kind === "knowledge") {
    const packed = packKnowledge([...selected, item]);
    if (!packed) { omit(item); continue; }
    selected.push(item);
    packed.forEach((slot, index) => { slots[index] = slot; });
  }
  for (const item of ordered.filter(item => item.kind === "raw" || item.kind === "fact")) if (!tryPlace(item)) omit(item);
  if (omitted.length) {
    const receipt: TransportItem = { kind: "receipt", text: "" };
    // Last in selection priority, not last in physical slot: first-fit may leave holes.
    while (true) {
      receipt.text = `omitted ${omitted.length} whole items at CC inline capacity; expand: ${expandList(omitted)}`;
      if (tryPlace(receipt)) break;
      const retained = [...ordered].reverse().find(item => item.kind !== "receipt" &&
        slots.some(slot => slot.items.includes(item)));
      if (!retained) throw new Error("CC inline envelope cannot carry its omission receipt");
      const slot = slots.find(slot => slot.items.includes(retained))!;
      const position = slot.items.indexOf(retained);
      slot.items.splice(position, 1);
      omit(retained);
    }
  }
  const transportWarning = pendingRaw || pendingFacts ? `Trace Memory: inline transport omitted ${[
    ...(pendingRaw ? [`${pendingRaw} pending Raw ${pendingRaw === 1 ? "entry" : "entries"}`] : []),
    ...(pendingFacts ? [`${pendingFacts} unconsolidated ${pendingFacts === 1 ? "fact" : "facts"} (${pendingFactTokens} tokens)`] : []),
  ].join(" and ")}; they remain pending for Noting and Consolidation.` : "";
  const notice = [warning, transportWarning].filter(Boolean).join(" ");
  return slots.map((slot, index) => {
    // The existing segment number plus local position establishes one logical chronology,
    // independent of native completion order. No later knowledge fills an earlier hole.
    return slot.items.length || index === 0 && notice
      ? { hookSpecificOutput: { hookEventName: "SessionStart" as const,
          additionalContext: slot.items.length ? encode(slot.items, index) : "" },
          ...(index === 0 && notice ? { systemMessage: notice } : {}) }
      : null;
  });
}
