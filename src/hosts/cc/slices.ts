import { encodeCcInjection, type CcHookOutput, type CcVisibleBinding } from "./injection.ts";
import { expandList } from "../../core/render/index.ts";
import { transportItemText, type TransportItem } from "../../core/render/material.ts";
import { tokens } from "../../core/render/tokens.ts";

export const CC_SLICE_COUNT = 24;
export const CC_SLICE_LIMIT = 10_000;

const address = (item: TransportItem): string => item.kind === "knowledge" ? item.address
  : item.kind === "fact" ? `F${item.factId}` : item.kind === "raw" ? item.address
  : item.kind === "state" ? `K@${item.receipt.fromCommit}` : "";

/** Transport selection only: core has already selected and rendered whole items. Pack their
 * unchanged texts under the native per-hook limit; never identify members from arbitrary prose.
 * Capacity drops the lowest-priority whole item and names it in a receipt. */
export function sliceCcInjection(binding: CcVisibleBinding, items: readonly TransportItem[],
  warning?: string): (CcHookOutput | null)[] {
  const slots: { body: string[]; items: TransportItem[] }[] = Array.from({ length: CC_SLICE_COUNT }, () => ({ body: [], items: [] }));
  const omitted: string[] = [];
  let pendingRaw = 0, pendingFacts = 0, pendingFactTokens = 0;
  const omit = (item: TransportItem): void => {
    omitted.push(address(item));
    if (item.kind === "raw" && item.pending) pendingRaw++;
    if (item.kind === "fact" && item.pending) { pendingFacts++; pendingFactTokens += tokens(item.text); }
  };
  const ordered = [...items].sort((a, b) => {
    const rank = (item: TransportItem): number => item.kind === "state" ? 0 : item.kind === "knowledge" ? 1
      : item.kind === "raw" ? 2 : item.kind === "fact" ? 3 : 4;
    return rank(a) - rank(b) || (a.kind === "knowledge" && b.kind === "knowledge" ? b.commitId - a.commitId : 0);
  });
  const encode = (texts: string[], members: TransportItem[], index: number): string => encodeCcInjection(binding, {
    text: texts.join("\n\n"), knowledgeCommitIds: members.flatMap(item => item.kind === "knowledge" ? [item.commitId] : []),
    knowledgeStates: members.flatMap(item => item.kind === "state" ? [item.receipt] : []),
    factIds: members.flatMap(item => item.kind === "fact" ? [item.factId] : []),
    entryIds: members.flatMap(item => item.kind === "raw" ? [item.entryId] : []),
    slice: [index, CC_SLICE_COUNT],
  });
  const tryPlace = (item: TransportItem): boolean => {
    const text = transportItemText(item);
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      const next = [...slot.body, text], members = [...slot.items, item];
      if (encode(next, members, index).length <= CC_SLICE_LIMIT) {
        slot.body = next; slot.items = members; return true;
      }
    }
    return false;
  };
  for (const item of ordered) if (!tryPlace(item)) {
    const id = address(item);
    if (id) omit(item);
    else if (item.kind === "receipt") throw new Error("CC transport cannot carry an existing omission receipt");
  }
  if (omitted.length) {
    const receipt: TransportItem = { kind: "receipt", text: `omitted ${omitted.length} whole items at CC inline capacity; expand: ${expandList(omitted)}` };
    // The receipt also pays for its envelope. Evict the least valuable retained whole item if needed.
    while (!tryPlace(receipt)) {
      const slot = [...slots].reverse().find(entry => entry.items.some(item => item.kind !== "receipt"));
      if (!slot) throw new Error("CC inline capacity cannot fit its omission receipt");
      let position = slot.items.length - 1;
      while (slot.items[position]?.kind === "receipt") position--;
      const [item] = slot.items.splice(position, 1); slot.body.splice(position, 1);
      omit(item!);
      receipt.text = `omitted ${omitted.length} whole items at CC inline capacity; expand: ${expandList(omitted)}`;
    }
  }
  const transportWarning = pendingRaw || pendingFacts ? `Trace Memory: inline transport omitted ${[
    ...(pendingRaw ? [`${pendingRaw} pending Raw ${pendingRaw === 1 ? "entry" : "entries"}`] : []),
    ...(pendingFacts ? [`${pendingFacts} unconsolidated ${pendingFacts === 1 ? "fact" : "facts"} (${pendingFactTokens} tokens)`] : []),
  ].join(" and ")}; they remain pending for Noting and Consolidation.` : "";
  const notice = [warning, transportWarning].filter(Boolean).join(" ");
  return slots.map((slot, index) => slot.body.length || index === 0 && notice
    ? { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: slot.body.length ? encode(slot.body, slot.items, index) : "" },
        ...(index === 0 && notice ? { systemMessage: notice } : {}) }
    : null);
}
