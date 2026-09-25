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
  const rank = (item: TransportItem): number => item.kind === "state" ? 0 : item.kind === "knowledge" ? 1
    : item.kind === "raw" ? 2 : item.kind === "fact" ? 3 : 4;
  const ordered = [...items].sort((a, b) => rank(a) - rank(b) ||
    (a.kind === "knowledge" && b.kind === "knowledge" ? b.commitId - a.commitId : 0));
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
  // Core's receipts are mandatory material. A legacy unbounded receipt must still name the
  // actual omission rather than displace it with an unrelated transport-capacity failure.
  for (const item of ordered.filter(item => item.kind === "receipt")) {
    if (tryPlace(item)) continue;
    const count = item.text.match(/omitted (\d+)/)?.[1];
    const expansion = item.text.split("expand: ")[1];
    const addresses = expansion?.match(/(?:K\d+(?:@\d+)?|F\d+|T\d+#E\d+)/g) ?? [];
    const compact: TransportItem = { kind: "receipt", text: `omitted ${count ?? "1"} ${count ? "items" : "receipt"}; expand: ${expandList(addresses)}` };
    if (!addresses.length || !tryPlace(compact)) throw new Error("CC core omission receipt has no usable expansion address");
  }
  for (const item of ordered.filter(item => item.kind !== "receipt")) if (!tryPlace(item)) omit(item);
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
      slot.items.splice(position, 1); slot.body.splice(position, 1);
      omit(retained);
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
