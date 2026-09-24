// 20a: the host-neutral domain text of every memory consumer. Core owns the material contract, its
// titles, its block order and its separators; a host places the prepared text in native system/user
// messages or steering and runs its own model loop. No provider message, body or SDK type is built
// here, and nothing in this module knows what a Pi or CC message is.
//
// This revises 19b's ban on core-composed domain text (user ruling 2026-09-08): core builds no
// provider message or body, and core owns the domain text. The material types of 19b are evolved
// rather than replaced: there is no generic builder or provider-strategy framework here, only one
// function per consumer over the shared parts.
//
// Block order (ticket 20 "Material order and cache scope", as ticket 25a corrected it):
//   Noter                  historical facts -> range -> selected Raw -> receipts
//   Consolidator           knowledge -> range -> selected pending facts -> negation reminders ->
//                          receipts
//   Main-agent injection   knowledge -> receipts
//   Main-agent compact     knowledge -> historical facts -> pending Raw -> receipts
//
// Ticket 25a supersedes ticket 20's leading knowledge block for the Noter in both modes, and the
// Consolidator's already-consolidated history block: a Noter reads knowledge explicitly when it needs
// it and never receives it automatically, and a Consolidator's automatic material is the active
// knowledge plus the pending facts it must integrate. Nothing here removes knowledge a fork already
// inherited from the foreground; explicit reads are unchanged for both.
//
// Stable prefix: the leading knowledge block carries no task range, no entry id of the new batch, no
// timestamp, no run id and no omission count, so two tasks with the same selected knowledge render
// the same leading bytes. That is a byte-layout rule, not a cache claim: knowledge is revised,
// archived and dropped under budget, and the Consolidator and the main agent have different
// instructions and are not one shared cache chain.
//
// Ruling 2026-09-06 08:53: an inherited-context run carries only its instruction, the range, the
// head reply and the frozen source index, because the raw turns, the facts delivered after earlier
// runs and the injected knowledge are already in that conversation. That is the domain increment,
// and it comes from the same frozen task as the full text.
//
// Ticket 29b ("One material-selection mechanism") replaces that pair of fixed layouts with ONE per
// phase. There is no `fresh`/`inherited` choice any more: a task carries the material its child does
// not already hold, and a fresh child — whose visible view is empty — is the case where that is the
// whole thing. What a fork used to get by layout (no Raw, no history, a source index) it now gets by
// subtraction: every block below renders exactly what the phase's builder kept after removing what
// the child's own context proves visible, and the mandatory framing stays whatever the data delta is.
import { createHash } from "node:crypto";
import type { Fact } from "../model/index.ts";
import type { KnowledgeWithRevision } from "../store/index.ts";
import { budgetFacts, budgetKnowledge, charge, finish, renderKnowledgeBlock, tokens, wholeKnowledge, xmlBlock,
  type BudgetedKnowledge, type FactTurns } from "./index.ts";

/** One knowledge category group as `budgetKnowledge` returns it: the category and its rendered lines. */
export interface KnowledgeGroup { category: string; text: string }
/** A frozen task range as a label. It is a label, never an id watermark (ticket 20). */
export interface TaskRange { from: string; to: string }

/** Display-only estimates captured while assembling a carrier. Framing stays unclassified. */
export interface MemoryComposition { bodyHash: string; knowledge: number; facts: number; raw: number }
export const memoryBodyHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export function measuredMemory(text: string, material: SharedMaterial): { text: string; composition: MemoryComposition } {
  return { text, composition: { bodyHash: memoryBodyHash(text),
    knowledge: tokens((material.knowledge ?? []).map(group => group.text).join("\n")),
    facts: tokens((material.facts ?? []).join("\n")),
    raw: tokens((material.entries ?? []).map(entry => entry.view).join("\n\n")) } };
}

/** Measure only the bytes of a renderer-produced block actually retained by a host. `offset`
 * locates the prefix of the original injection inside the host's exact rendered text; `length`
 * may end mid-block (a native preview). `original` may itself be only that retained prefix:
 * an open section then extends to its end, without consulting omitted bytes. Unknown framing
 * stays unclassified. Pi's metadata/hash composition above is intentionally unchanged. */
export function measureRetainedMemoryText(rendered: string, original: string, offset: number, length: number):
  { knowledge: number; facts: number; raw: number; unclassified: number } {
  const out = { knowledge: 0, facts: 0, raw: 0, unclassified: 0 };
  const end = offset + length;
  const regions: { start: number; end: number; key: "knowledge" | "facts" | "raw" }[] = [];
  const knowledgeStart = original.indexOf("\n<knowledge>\n");
  if (knowledgeStart >= 0 && original.indexOf("\n<knowledge>\n", knowledgeStart + 1) < 0) {
    const closing = original.indexOf("\n</knowledge>", knowledgeStart);
    if (closing < 0 || original.indexOf("\n</knowledge>", closing + 1) < 0)
      regions.push({ start: knowledgeStart + 1, end: closing < 0 ? original.length : closing + "\n</knowledge>".length, key: "knowledge" });
  }
  const episodic = original.indexOf("\n<episodic>\n");
  const closingEpisodic = episodic >= 0 ? original.indexOf("\n</episodic>", episodic) : -1;
  const episodicEnd = episodic < 0 ? -1 : closingEpisodic < 0 ? original.length : closingEpisodic;
  const factsStart = episodic >= 0 ? original.indexOf(`\n${FACTS_TITLE}\n`, episodic) : -1;
  const rawStart = episodic >= 0 ? original.indexOf(`\n${RAW_TITLE}\n`, episodic) : -1;
  if (episodicEnd >= 0 && original.indexOf("\n<episodic>\n", episodic + 1) < 0 &&
      (closingEpisodic < 0 || original.indexOf("\n</episodic>", closingEpisodic + 1) < 0) &&
      (factsStart < 0 || original.indexOf(`\n${FACTS_TITLE}\n`, factsStart + 1) < 0) &&
      (rawStart < 0 || original.indexOf(`\n${RAW_TITLE}\n`, rawStart + 1) < 0)) {
    if (factsStart >= 0 && factsStart < episodicEnd && (rawStart < 0 || factsStart < rawStart))
      regions.push({ start: factsStart + 1, end: rawStart >= 0 ? rawStart : episodicEnd, key: "facts" });
    if (rawStart >= 0 && rawStart < episodicEnd)
      regions.push({ start: rawStart + 1, end: episodicEnd, key: "raw" });
  }
  const intervals = regions.map(region => ({ start: Math.max(offset, offset + region.start), end: Math.min(end, offset + region.end), key: region.key }))
    .filter(region => region.start < region.end).sort((a, b) => a.start - b.start);
  if (intervals.some((span, index) => index > 0 && span.start < intervals[index - 1]!.end))
    return { ...out, unclassified: tokens(rendered) }; // Ambiguous nested section markers.
  let cursor = 0;
  for (const span of intervals) {
    if (span.start > cursor) out.unclassified += tokens(rendered.slice(0, span.start)) - tokens(rendered.slice(0, cursor));
    out[span.key] += tokens(rendered.slice(0, span.end)) - tokens(rendered.slice(0, span.start));
    cursor = span.end;
  }
  out.unclassified += tokens(rendered) - tokens(rendered.slice(0, cursor));
  return out;
}

/** The parts every memory consumer shares (ticket 20, "Shared contract"): rendered knowledge,
 * historical facts, compressed Raw entries with their concrete source identity, and budget receipts.
 * A consumer whose ruled order has no knowledge, no facts or no Raw block simply omits those parts;
 * sharing this type never adds a block to a consumer's order (initial injection stays knowledge-only,
 * and since 25a neither Noter mode carries knowledge at all). */
export interface SharedMaterial {
  /** Active knowledge within the knowledge budget, in category order; absent for the Noter (25a). */
  knowledge?: KnowledgeGroup[];
  /** Historical facts selected by freshness, displayed in chronological Turn groups, within budget. */
  facts?: string[];
  /** Compressed Raw entries, oldest first, each with the source identity of its own view. */
  entries?: { id: number; view: string }[];
  /** Budget receipts for everything the views and the budgets left out. */
  receipts: string[];
}

/** The frozen task material of one Noting run. Task-specific parts: the head reply and the source
 * index an inherited-context run needs. No field is a composed message. */
export interface NotingMaterial extends SharedMaterial {
  /** The target entries this run must newly supply: 29b removed the ones the child can already see,
   * so this is a subset of the frozen target and is empty when the whole target is visible. */
  entries: { id: number; view: string }[];
  facts: string[];
  /** The selected path's last native entry, when it is an assistant reply in this batch; otherwise null. 29b:
   * it is restated only when the head entry's own body was withheld as visible, because the captured
   * request a fork inherits stops before that reply. When the Raw block carries the head entry, the
   * reply is in it already and a second copy is the duplicate parent 29 forbids. */
  head: string | null;
  /** One identity-only source-index line per entry of the frozen range, in source order. 29b: emitted only when some
   * target entry's body was withheld — the mandatory source mapping that identifies a body the child
   * must find in its own context. With the whole target supplied, the Raw block carries those
   * addresses itself and the index would be a second copy of them. */
  sources: string[];
}

/** The frozen task material of one Consolidation run. Task-specific parts are the pending facts,
 * as addresses and rendered lines. No field is a composed message. 25a: there is no
 * already-consolidated history part; those facts stay reachable through explicit reads. */
export interface ConsolidationMaterial extends SharedMaterial {
  knowledge: KnowledgeGroup[];
  /** The facts to integrate, as addresses: an inherited context already carries their lines. */
  factAddresses: string[];
  /** The same selected facts, rendered with relations in chronological Turn groups. */
  rangeFacts: string[];
  /** 29b (parent 29 "Version-aware knowledge"): one line per knowledge commit the child inherited
   * that is no longer this path's current authority — superseded, archived or merged. The block above
   * carries only what is current, so without these lines stale inherited text would read as current
   * knowledge. Charged inside the knowledge allowance like everything else in that block. */
  knowledgeNotes: string[];
}

export const FACTS_TITLE = "Recent facts (by Turn):";
export const RAW_TITLE = "Raw:";
export const RANGE_FACTS_TITLE = "Range facts:";
export const SOURCES_TITLE = "Sources:";
/** 29b: the title of `ConsolidationMaterial.knowledgeNotes`, emitted only when there are notes. */
export const KNOWLEDGE_STATUS_TITLE = "Inherited knowledge status (these commits are not current authority):";
/** Between blocks, and between a block's title and its body. Entry views use the same separator. */
export const BLOCK = "\n\n";

const rangeLine = (range: TaskRange): string => `Range: ${range.from}..${range.to}`;

/** Ticket 20 "Shared material budgets", the one budgeting of the shared material. Every consumer
 * passes what it will emit and gets back what fits, with the receipts for what did not:
 *
 * | Component                                                   | Budget |
 * | ----------------------------------------------------------- | ------ |
 * | knowledge block, its category tags, its omission receipts    | `caps.knowledge` |
 * | selected current material: entry views or pending fact lines, with their own labels, omission markers and joining separators | `caps.current`, when the consumer has one |
 * | block titles, the range line, mandatory cues, block receipts, historical facts | `caps.episodic` |
 *
 * A consumer that emits no knowledge block and no historical facts omits those inputs rather than
 * passing empty ones, and pays for neither; a consumer whose current material has no ceiling of its
 * own beyond the enclosing envelope omits `caps.current` the same way (25c: compaction's pending Raw,
 * which is bounded only by the shared episodic envelope it is reserved out of). The current material
 * and the mandatory cues are reserved first; historical facts fill the rest in the existing freshness
 * order, never past `history`.
 * Selected evidence is never dropped to make room: a current material over its own ceiling, or
 * mandatory material over the episodic budget, is receipted, and reducing the task is the phase's own
 * oldest-first re-freeze (`freezeNoting`, `freezeConsolidation`). */
export interface MaterialBudget {
  /** Knowledge candidates; omitted by a consumer whose order has no knowledge block (25a: the Noter). */
  knowledge?: KnowledgeWithRevision[];
  /** How one knowledge item renders. */
  knowledgeLine?: (value: KnowledgeWithRevision) => string;
  /** Optional pre-render of exactly `knowledge` with `knowledgeLine`. A freeze may reuse this
   * range-independent complete-pool measurement while its evidence batch changes. */
  knowledgeWhole?: BudgetedKnowledge;
  /** The owning capacity, used only in capacity diagnostics and omission receipts. */
  knowledgeBudget?: string;
  /** 29b: the status lines of inherited commits that are no longer current. They are reserved out of
   * `caps.knowledge` before the block fills what is left, because a stale-authority warning is worth
   * more than one more current item; anything past the cap is receipted like any other omission. */
  knowledgeNotes?: string[];
  /** The selected current material, already joined with the separator this consumer emits. */
  current: string;
  /** The block titles and mandatory cues this consumer emits around it. */
  framing: string[];
  /** The frozen range, when this consumer shows one; it is a label, charged like any other line. */
  range?: TaskRange;
  /** Historical facts in the existing freshness order, and how one renders; omitted by a consumer
   * whose order has no history block (25a: the Consolidator). */
  facts?: Fact[];
  factLine?: (fact: Fact) => string;
  factTurns?: FactTurns;
  /** `current` is the inner ceiling of the selected current material. A consumer without one omits it
   * (25c, parent amendment 3: compaction's pending Raw lost `noting.batchTokens` as an inner cap and
   * is bounded by `episodic` alone), and then nothing here receipts or reports a current-material
   * overage — the enclosing envelope is the only thing that can be missed. */
  caps: { knowledge?: number; episodic: number; current?: number };
  /** What the current material is called in a receipt: Raw entries, or a Consolidation's range facts. */
  label?: "raw" | "range";
  /** The hard ceiling of the optional historical facts, independent of what the episodic budget would
   * otherwise allow (25a: the Noter's history and its Raw batch are two independent caps, so unused
   * Raw space never enlarges the history block). Capacity negotiation lowers it further to trim this
   * optional material before it drops selected evidence (review 2026-09-08). */
  history?: number;
}

export function budgetMaterial(input: MaterialBudget): { knowledge: KnowledgeGroup[]; facts: string[]; receipts: string[];
  /** 29b: the status lines that fit `caps.knowledge`, in the order they were given. */
  knowledgeNotes: string[];
  /** 29a "Renderers return what they kept": the identities of the historical facts and the knowledge
   * commits this budgeting actually kept. What a cap dropped is receipted above and absent here, so a
   * consumer that persists these as coverage can only understate it. */
  factIds: number[]; knowledgeCommitIds: number[];
  /** How far past each cap this material is, in tokens; zero when it fits. Every consumer receipts an
   * overage; only compact escalates on it (ticket 20 "Compaction escalation", steps 2 and 4). */
  over: { current: number; episodic: number } } {
  const receiptCost = (list: string[]) => list.length ? charge(list) + charge(["Receipts:"]) : 0;
  // 29b: status is mandatory and comes out of the knowledge allowance first. Select the largest
  // whole-line prefix whose own title and, when needed, bounded omission receipt plus shared heading
  // all fit. The receipt is part of the selection rather than unbudgeted text appended afterwards.
  const allNotes = input.knowledgeNotes ?? [], cap = input.caps.knowledge ?? 0;
  const statusCosts = [0];
  for (const note of allNotes) statusCosts.push(statusCosts.at(-1)! + tokens(note) + 1
    + (statusCosts.length === 1 ? tokens(KNOWLEDGE_STATUS_TITLE) + 1 : 0));
  let keptNotes = -1;
  for (let kept = 0; kept <= allNotes.length; kept++) {
    const omitted = allNotes.length - kept;
    const receipts = omitted ? [`omitted ${omitted} inherited knowledge status lines; ${input.knowledgeBudget ?? "Knowledge capacity"} is full`] : [];
    if (statusCosts[kept]! + receiptCost(receipts) <= cap) keptNotes = kept;
  }
  if (keptNotes < 0) {
    const receipt = `omitted ${allNotes.length} inherited knowledge status lines; ${input.knowledgeBudget ?? "Knowledge capacity"} is full`;
    throw new Error(`Knowledge capacity: the inherited status omission receipt alone (${receiptCost([receipt])} tokens) exceeds ${input.knowledgeBudget ?? "Knowledge capacity"} (${cap})`);
  }
  const notes = allNotes.slice(0, keptNotes), noteCost = statusCosts[keptNotes]!;
  const noteReceipts = keptNotes < allNotes.length
    ? [`omitted ${allNotes.length - keptNotes} inherited knowledge status lines; ${input.knowledgeBudget ?? "Knowledge capacity"} is full`] : [];
  const knowledgeCap = Math.max(0, cap - noteCost - receiptCost(noteReceipts));
  const stable = input.knowledge ? input.knowledgeWhole ?? wholeKnowledge(input.knowledge, input.knowledgeLine) : undefined;
  // A fitting pool needs no trimming. Over capacity, preserve newer commits with the same
  // category/commit presentation and oldest-item omission receipts as every other consumer.
  const active = !stable ? { groups: [] as KnowledgeGroup[], receipts: [] as string[], commits: [] as number[] }
    : stable.cost <= knowledgeCap ? stable
    : budgetKnowledge(input.knowledge!, knowledgeCap, input.knowledgeLine, input.knowledgeBudget);
  const label = input.label ?? "raw", kept = label === "raw" ? "unrecorded raw" : "range facts";
  const current = tokens(input.current);
  const ceiling = input.caps.current; // absent: this consumer's current material has no inner cap (25c)
  const receipts: string[] = [];
  if (ceiling !== undefined && current > ceiling) receipts.push(`${label} ceiling: ${current - ceiling} tokens over ${ceiling}; all ${kept} kept`);
  // The `Receipts:` heading `finish` emits is charged with the receipts (review 2026-09-08: every emitted
  // component counts, the heading included; it may be charged to both budgets, which over-counts safely).
  const reserved = () => current + charge([...input.framing, ...(input.range ? [rangeLine(input.range)] : [])]) + receiptCost(receipts);
  // Two passes: the historical-fact receipt is itself charged, and only a first pass knows whether
  // there is one. A receipt is bounded, so the second pass is the last (ticket 20 "Budgeted receipts").
  // `history` caps the optional historical facts below what the episodic budget would allow: a phase
  // negotiating a smaller model window trims this optional material before it drops selected evidence.
  const room = () => Math.min(input.history ?? Infinity, input.caps.episodic - reserved());
  const fill = (cap: number) => input.facts?.length
    ? budgetFacts(input.facts, input.factLine!, cap, input.factTurns!) : { recent: [] as string[], receipts: [] as string[], factIds: [] as number[] };
  let filled = fill(room());
  if (filled.receipts.length) filled = fill(room() - charge(filled.receipts) - (receipts.length ? 0 : charge(["Receipts:"])));
  receipts.push(...filled.receipts);
  const over = reserved() - input.caps.episodic;
  if (over > 0) receipts.unshift(`${label} overage: ${over} tokens; all ${kept} kept`);
  return { knowledge: active.groups, facts: filled.recent, receipts: [...receipts, ...active.receipts, ...noteReceipts],
    knowledgeNotes: notes, factIds: filled.factIds, knowledgeCommitIds: active.commits,
    over: { current: ceiling === undefined ? 0 : Math.max(0, current - ceiling), episodic: Math.max(0, over) } };
}

const block = (parts: string[]): string => parts.join(BLOCK);
const rawText = (material: SharedMaterial): string => (material.entries ?? []).map((entry) => entry.view).join(BLOCK);

/** The leading knowledge block of all four consumers, and the only knowledge layout in this
 * repository. Nothing task-specific may enter it (see "Stable prefix" above); empty knowledge
 * renders no block at all rather than a bare title. */
export const knowledgeBlock = (material: SharedMaterial): string => renderKnowledgeBlock(material.knowledge ?? []);
const leading = (material: SharedMaterial): string[] => {
  const knowledge = knowledgeBlock(material);
  return knowledge ? [knowledge] : [];
};

/** 29b's status block, emitted only when there is a status line: the commits the reader's context
 * already holds that are no longer this path's current authority. Shared by the Consolidator's
 * layout and, since 31, the main agent's knowledge block, which are now the same selection. */
const statusBlock = (notes: readonly string[]): string[] =>
  notes.length ? [`${KNOWLEDGE_STATUS_TITLE}\n${notes.join("\n")}`] : [];

/** Main-agent foreground publication: exact Knowledge bodies, state notices, then receipts.
 * Knowledge-only by construction — the shared type carries facts and Raw for other consumers, and
 * this renders neither. Ticket 34c uses it for the common ordinary-prompt predicate. */
export const injectionText = (material: SharedMaterial, knowledgeNotes: readonly string[] = []): string =>
  finish({ content: block([...leading(material), ...statusBlock(knowledgeNotes)]), receipts: material.receipts });

/** Main-agent compact: knowledge, then historical facts, then the pending Raw, then receipts. Ticket
 * 30: there is one bounded view and therefore one Raw title — the second tier that renamed this block
 * is gone, and the order, the separators and the receipts are what they always were. */
export const compactText = (material: SharedMaterial, rawTitle: string = RAW_TITLE, knowledgeNotes: readonly string[] = []): string => {
  // 73: a window that kept nothing emits nothing — no title, and no `<episodic>` tag when both are empty.
  const facts = material.facts ?? [], episodic = [...(facts.length ? [FACTS_TITLE, facts.join("\n")] : []),
    ...(material.entries?.length ? [rawTitle, rawText(material)] : [])];
  return finish({ content: block([...leading(material), ...statusBlock(knowledgeNotes),
    ...(episodic.length ? [xmlBlock("episodic", block(episodic))] : [])]), receipts: material.receipts });
};

/** The Noter's one layout (29b): the missing historical facts, the range, the head reply when this
 * run restates it, the Raw of the target entries this run supplies, the source index when some body
 * was withheld, then receipts. 25a: no knowledge block in either Noter mode — a Noter that needs
 * knowledge reads it by address. With an empty visible view every target entry is supplied, `head`
 * is null and `sources` is empty, which is byte for byte the layout a fresh Noter has always had. */
export const notingText = (material: NotingMaterial, range: TaskRange): string =>
  finish({ content: block([FACTS_TITLE, material.facts.join("\n"), rangeLine(range),
    ...(material.head ? [material.head] : []),
    ...(material.entries.length ? [RAW_TITLE, rawText(material)] : []),
    ...(material.sources.length ? [`${SOURCES_TITLE}\n${material.sources.join("\n")}`] : []),
  ]), receipts: material.receipts });

/** The Consolidator's one layout (29b): the current knowledge this run supplies, the status of the
 * inherited commits that are no longer current, the range and the pending fact bodies this run
 * supplies, then receipts. 25a: no already-consolidated history block — those facts are read by
 * address. */
export const consolidationText = (material: ConsolidationMaterial, range: TaskRange): string =>
  finish({ content: block([...leading(material), ...statusBlock(material.knowledgeNotes),
    rangeLine(range), RANGE_FACTS_TITLE, material.rangeFacts.join("\n")]), receipts: material.receipts });
