import { ccInjectionLength, encodeCcInjection, type CcHookOutput, type CcVisibleBinding } from "./injection.ts";
import { expandList, knowledgeBlockParts, knowledgeGroups, sessionKnowledgeNotice } from "../../core/render/index.ts";
import { transportItemText, type TransportItem } from "../../core/render/material.ts";
import { tokens } from "../../core/render/tokens.ts";
import { ccPluginToolNames } from "./tool-names.ts";
import { KNOWLEDGE_CATEGORIES } from "../../core/model/index.ts";
import { readingGuide } from "../../core/render/reading-guide.ts";

export const CC_SLICE_COUNT = 24;
export const CC_SLICE_LIMIT = 10_000;
export const CC_KNOWLEDGE_RECENCY_NOTICE = "Within one rendered set of 24 segments, read knowledge by the header's p[0] segment number, then by position within that segment. Items are grouped by category and a category may continue into the next segment; within a category they are ordered by last change, so higher segments and later items are newer. Position does not compare items across categories. Arrival order is not recency. For claims about the same object within a category, the newer item takes precedence until maintenance merges them.";

/** 101 (ruled): a bound session's knowledge header also names it and the path a subagent inherits
 * its knowledge from. */
export const ccKnowledgeHeader = (binding: CcVisibleBinding): string => binding.coreSession === null
  ? CC_KNOWLEDGE_RECENCY_NOTICE : sessionKnowledgeNotice(binding.coreSession, CC_KNOWLEDGE_RECENCY_NOTICE);

/** Ticket 132: knowledge is presented by category (glossary order), then oldest commit first. */
const knowledgeOrder = (a: Extract<TransportItem, { kind: "knowledge" }>, b: Extract<TransportItem, { kind: "knowledge" }>): number =>
  KNOWLEDGE_CATEGORIES.indexOf(a.category as never) - KNOWLEDGE_CATEGORIES.indexOf(b.category as never) || a.commitId - b.commitId;

const address = (item: TransportItem, sessionId: number | null): string => item.kind === "knowledge" || item.kind === "state" ? `trace://${item.address}`
  : item.kind === "fact" ? `trace://F${item.factId}` : item.kind === "raw" ? `trace://raw/S${sessionId}/${item.address}` : "";

/** Core's selection order for knowledge (144 §7.5): its rank when it ranked the item, otherwise newest commit first. */
const knowledgeRank = (item: Extract<TransportItem, { kind: "knowledge" }>): number => item.rank ?? -item.commitId;
/** Whether a knowledge item is charged to the temporary allowance rather than the Knowledge base. */
const temporaryKnowledge = (item: TransportItem): boolean => item.kind === "knowledge" && item.allowance === "temporary";

/** Transport selection only: core has already selected and rendered whole items. Pack their
 * unchanged texts under the native per-hook limit; never identify members from arbitrary prose.
 * Capacity drops the lowest-priority whole item and names it in a receipt. */
export function sliceCcInjection(binding: CcVisibleBinding, items: readonly TransportItem[],
  warning?: string, knowledgeAllowance = Infinity, temporaryAllowance = Infinity): (CcHookOutput | null)[] {
  if (binding.coreSession === null && items.some(item => item.kind === "raw"))
    throw new Error("CC Raw transport needs a bound core session");
  const slots: { items: TransportItem[] }[] = Array.from({ length: CC_SLICE_COUNT }, () => ({ items: [] }));
  const omitted: string[] = [];
  let pendingRaw = 0, pendingFacts = 0, pendingFactTokens = 0, omittedKnowledge = false;
  const omit = (item: TransportItem): void => {
    omitted.push(address(item, binding.coreSession));
    if (item.kind === "knowledge" || item.kind === "state") omittedKnowledge = true;
    if (item.kind === "raw" && item.pending) pendingRaw++;
    if (item.kind === "fact" && item.pending) { pendingFacts++; pendingFactTokens += tokens(item.text); }
  };
  const rank = (item: TransportItem): number => item.kind === "state" ? 0 : item.kind === "knowledge" ? 1
    : item.kind === "raw" ? 2 : item.kind === "fact" ? 3 : 4;
  const ordered = [...items].sort((a, b) => rank(a) - rank(b) ||
    (a.kind === "knowledge" && b.kind === "knowledge" ? knowledgeRank(a) - knowledgeRank(b) : 0));
  const membership = (members: TransportItem[], index: number) => ({
    knowledgeCommitIds: members.flatMap(item => item.kind === "knowledge" && item.form !== "title" ? [item.commitId] : []),
    knowledgeTitleCommitIds: members.flatMap(item => item.kind === "knowledge" && item.form === "title" ? [item.commitId] : []),
    knowledgeStates: members.flatMap(item => item.kind === "state" ? [item.receipt] : []),
    factIds: members.flatMap(item => item.kind === "fact" ? [item.factId] : []),
    entryIds: members.flatMap(item => item.kind === "raw" ? [item.entryId] : []),
    slice: [index, CC_SLICE_COUNT] as [number, number],
  });
  const header = ccKnowledgeHeader(binding);
  const guide = readingGuide(binding.coreSession ?? undefined, ccPluginToolNames);
  const itemText = (item: TransportItem) => transportItemText(item, header);
  // One exact assembly for trial character size, Knowledge cost and emitted bytes. Trials do not
  // compute digests; each final carrier has one knowledge list with its own domain framing.
  const assemble = (items: TransportItem[], index: number) => {
    const members = [...items].sort((a, b) => rank(a) - rank(b) ||
      (a.kind === "knowledge" && b.kind === "knowledge" ? knowledgeOrder(a, b) : 0));
    const knowledge = knowledgeBlockParts(knowledgeGroups(members.filter(item => item.kind === "knowledge")), header);
    const sections = [
      ...(index === 0 ? [[guide]] : []),
      ...members.filter(item => item.kind === "state").map(item => [itemText(item)]),
      ...(knowledge.length ? [knowledge] : []),
      ...members.filter(item => item.kind !== "state" && item.kind !== "knowledge").map(item => [itemText(item)]),
    ];
    // 144 §7.5: framing is charged by who needs it. The base pays for the window its own items and state notices
    // make; the temporary allowance pays for everything else the slice's Knowledge adds (its items, the framing only
    // they bring, and receipts core charged to it) and for the temporary Raw it carries.
    const knowledgeTokens = (members: TransportItem[]) => {
      const block = knowledgeBlockParts(knowledgeGroups(members.filter(item => item.kind === "knowledge")), header);
      const sections = [
        ...members.filter(item => item.kind === "state").map(itemText),
        ...(block.length ? [block.join("")] : []),
        ...members.filter(item => item.kind === "receipt" && item.knowledge !== false).map(itemText),
      ];
      return sections.length ? tokens(sections.join("\n\n")) : 0;
    };
    const whole = knowledgeTokens(members);
    const baseCost = knowledgeTokens(members.filter(item => !temporaryKnowledge(item) && !(item.kind === "receipt" && item.allowance === "temporary")));
    const temporaryCost = whole - baseCost + members.reduce((sum, item) => sum + ((item.kind === "raw" || item.kind === "fact") ? item.charge ?? 0 : 0), 0);
    return { membership: { ...membership(members, index), knowledgeTokens: baseCost, temporaryTokens: temporaryCost },
      parts: sections.flatMap((section, at) => at ? ["\n\n", ...section] : section) };
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
    const addresses = expansion?.match(/trace:\/\/[^\s,]+/g) ?? [];
    const compact: TransportItem = { kind: "receipt", knowledge: item.knowledge,
      text: `omitted ${count ?? "1"} ${count ? "items" : "receipt"}; expand: ${expandList(addresses)}` };
    if (!addresses.length || !tryPlace(compact)) throw new Error("CC core omission receipt has no usable expansion address");
  }
  for (const item of ordered.filter(item => item.kind === "state")) if (!tryPlace(item)) omit(item);
  const base = slots.map(slot => ({ items: [...slot.items] }));
  const selected: Extract<TransportItem, { kind: "knowledge" }>[] = [];
  const packKnowledge = (knowledge: typeof selected) => {
    const packed = base.map(slot => ({ items: [...slot.items] }));
    let index = 0;
    for (const item of [...knowledge].sort(knowledgeOrder)) {
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
  // Preserve rank-order admission even though the admitted bodies are placed by category, oldest first.
  // A rejected lower-ranked/oversized item cannot evict a higher-ranked admitted version.
  for (const item of ordered) if (item.kind === "knowledge") {
    const packed = packKnowledge([...selected, item]);
    if (!packed) { omit(item); continue; }
    selected.push(item);
    packed.forEach((slot, index) => { slots[index] = slot; });
  }
  for (const item of ordered.filter(item => item.kind === "raw" || item.kind === "fact")) if (!tryPlace(item)) omit(item);
  const costs = () => slots.reduce((sum, slot, index) => {
    const { knowledgeTokens, temporaryTokens } = assemble(slot.items, index).membership;
    return { base: sum.base + knowledgeTokens, temporary: sum.temporary + temporaryTokens };
  }, { base: 0, temporary: 0 });
  const fits = () => { const cost = costs(); return cost.base <= knowledgeAllowance && cost.temporary <= temporaryAllowance; };
  const remove = (item: TransportItem) => {
    const slot = slots.find(slot => slot.items.includes(item))!;
    slot.items.splice(slot.items.indexOf(item), 1);
    omit(item);
  };
  const placed = (item: TransportItem) => slots.some(slot => slot.items.includes(item));
  const lowestBase = () => [...ordered].reverse().find(item => (item.kind === "state" || item.kind === "knowledge" && !temporaryKnowledge(item)) && placed(item));
  const lowestTemporary = () => [...ordered].reverse().find(item => temporaryKnowledge(item) && placed(item));
  const lowestKnowledge = () => (costs().base > knowledgeAllowance ? lowestBase() : lowestTemporary()) ?? lowestTemporary() ?? lowestBase();
  // Same admission priorities as character packing: lowest-ranked first, state notices last. Final segment
  // framing belongs to K; host JSON framing and Fact/Raw do not. Two loops, base first: removing a slice's last
  // base item moves its framing to the temporary cost, and removing a temporary item never changes the base cost,
  // so a temporary item is never evicted for the base cap.
  while (costs().base > knowledgeAllowance) {
    const item = lowestBase();
    if (!item) break;
    remove(item);
  }
  while (costs().temporary > temporaryAllowance) {
    const item = lowestTemporary();
    if (!item) break;
    remove(item);
  }
  if (omitted.length) {
    const receipt: TransportItem = { kind: "receipt", text: "" };
    // Last in selection priority, not last in physical slot: first-fit may leave holes.
    while (true) {
      receipt.text = `omitted ${omitted.length} whole items at CC inline capacity; expand: ${expandList(omitted)}`;
      receipt.knowledge = omittedKnowledge;
      const isPlaced = tryPlace(receipt);
      if (isPlaced && fits()) break;
      if (isPlaced) {
        const slot = slots.find(slot => slot.items.includes(receipt))!;
        slot.items.splice(slot.items.indexOf(receipt), 1);
      }
      const retained = isPlaced ? lowestKnowledge() : [...ordered].reverse().find(item => item.kind !== "receipt" &&
        slots.some(slot => slot.items.includes(item)));
      if (!retained) {
        if (!isPlaced) throw new Error("CC inline envelope cannot carry its omission receipt");
        break; // No K item remains, and even its omission receipt does not fit this window.
      }
      remove(retained);
    }
  }
  // A window too small even for its pre-existing K receipts emits no K material (73).
  if (!fits())
    for (const slot of slots) slot.items = slot.items.filter(item => item.kind !== "receipt" || item.knowledge === false);
  const transportWarning = pendingRaw || pendingFacts ? `Trace Memory: inline transport omitted ${[
    ...(pendingRaw ? [`${pendingRaw} pending Raw ${pendingRaw === 1 ? "entry" : "entries"}`] : []),
    ...(pendingFacts ? [`${pendingFacts} ${pendingFacts === 1 ? "fact" : "facts"} (${pendingFactTokens} tokens)`] : []),
  ].join(" and ")}${pendingRaw ? "; omitted Raw remains pending for Noting." : "."}` : "";
  const notice = [warning, transportWarning].filter(Boolean).join(" ");
  return slots.map((slot, index) => {
    // The existing segment number plus local position establishes one logical chronology,
    // independent of native completion order. No later knowledge fills an earlier hole.
    return slot.items.length || index === 0 && (notice || slots.some(slot => slot.items.length))
      ? { hookSpecificOutput: { hookEventName: "SessionStart" as const,
          additionalContext: slot.items.length || index === 0 && slots.some(slot => slot.items.length) ? encode(slot.items, index) : "" },
          ...(index === 0 && notice ? { systemMessage: notice } : {}) }
      : null;
  });
}
