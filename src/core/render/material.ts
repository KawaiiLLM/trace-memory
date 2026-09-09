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
import type { Fact } from "../model/index.ts";
import type { KnowledgeWithRevision } from "../store/index.ts";
import { budgetFacts, budgetKnowledge, charge, finish, renderKnowledgeBlock, tokens, xmlBlock, ENTRY_VIEW_VERSION, type EntryProfile, type FactTurns } from "./index.ts";

/** One knowledge category group as `budgetKnowledge` returns it: the category and its rendered lines. */
export interface KnowledgeGroup { category: string; text: string }
/** A frozen task range as a label. It is a label, never an id watermark (ticket 20). */
export interface TaskRange { from: string; to: string }

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
  entries: { id: number; view: string }[];
  facts: string[];
  /** The head turn's final assistant reply, rendered; null when the head turn has none. */
  head: string | null;
  /** One source-index line per turn of the frozen range, in range order. */
  sources: string[];
}

/** The frozen task material of one Consolidation run. Task-specific parts: the pending facts (as
 * addresses and as lines) and the negated-evidence review cues. No field is a composed message.
 * 25a: there is no already-consolidated history part — that block is removed, and those facts stay
 * reachable through explicit reads. */
export interface ConsolidationMaterial extends SharedMaterial {
  knowledge: KnowledgeGroup[];
  /** The facts to integrate, as addresses: an inherited context already carries their lines. */
  factAddresses: string[];
  /** The same selected facts, rendered with relations in chronological Turn groups. */
  rangeFacts: string[];
  /** Visible knowledge whose supports a range fact negates, with both facts: review cues only. */
  reminders: string[];
}

/** The prepared domain text of one run, both representations from the same frozen task. The host
 * picks one by the native context capability it actually has. */
export interface MaterialText {
  /** Fresh context: the whole ruled order, receipts last. */
  fresh: string;
  /** Inherited context: only what that conversation does not already carry (ruling 08:53). Noting
   * only — Consolidation runs as a subagent alone (25b) and prepares no increment. */
  inherited?: string;
}

export const FACTS_TITLE = "Recent facts (by Turn):";
export const RAW_TITLE = "Raw:";
/** Compaction tier 2 (20c) under ticket 23's one renderer: the block title replaces `RAW_TITLE` —
 * never joins it — and names the view version and the profile that produced these views, because a
 * reader must be able to tell which rule truncated the text in front of it. One title is charged to
 * the episodic budget either way. */
export const secondaryRawTitle = (profile: EntryProfile): string =>
  `Raw (tier-2 entry views, ${ENTRY_VIEW_VERSION}, tool call budget ${profile.toolCallTokens} tokens, entry budget ${profile.entryTokens} tokens):`;
export const RANGE_FACTS_TITLE = "Range facts:";
export const SOURCES_TITLE = "Sources:";
export const REMINDER_TITLE = "Negated-evidence reminder (review cues only; no status derived):";
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
  /** How one knowledge item renders; the read facade adds its marks. */
  knowledgeLine?: (value: KnowledgeWithRevision) => string;
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
  /** How far past each cap this material is, in tokens; zero when it fits. Every consumer receipts an
   * overage; only compact escalates on it (ticket 20 "Compaction escalation", steps 2 and 4). */
  over: { current: number; episodic: number } } {
  const active = input.knowledge ? budgetKnowledge(input.knowledge, input.caps.knowledge!, input.knowledgeLine)
    : { groups: [] as KnowledgeGroup[], receipts: [] as string[] };
  const label = input.label ?? "raw", kept = label === "raw" ? "unrecorded raw" : "range facts";
  const current = tokens(input.current);
  const ceiling = input.caps.current; // absent: this consumer's current material has no inner cap (25c)
  const receipts: string[] = [];
  if (ceiling !== undefined && current > ceiling) receipts.push(`${label} ceiling: ${current - ceiling} tokens over ${ceiling}; all ${kept} kept`);
  // The `Receipts:` heading `finish` emits is charged with the receipts (review 2026-09-08: every emitted
  // component counts, the heading included; it may be charged to both budgets, which over-counts safely).
  const receiptCost = (list: string[]) => list.length ? charge(list) + charge(["Receipts:"]) : 0;
  const reserved = () => current + charge([...input.framing, ...(input.range ? [rangeLine(input.range)] : [])]) + receiptCost(receipts);
  // Two passes: the historical-fact receipt is itself charged, and only a first pass knows whether
  // there is one. A receipt is bounded, so the second pass is the last (ticket 20 "Budgeted receipts").
  // `history` caps the optional historical facts below what the episodic budget would allow: a phase
  // negotiating a smaller model window trims this optional material before it drops selected evidence.
  const room = () => Math.min(input.history ?? Infinity, input.caps.episodic - reserved());
  const fill = (cap: number) => input.facts?.length
    ? budgetFacts(input.facts, input.factLine!, cap, input.factTurns!) : { recent: [] as string[], receipts: [] as string[] };
  let filled = fill(room());
  if (filled.receipts.length) filled = fill(room() - charge(filled.receipts) - (receipts.length ? 0 : charge(["Receipts:"])));
  receipts.push(...filled.receipts);
  const over = reserved() - input.caps.episodic;
  if (over > 0) receipts.unshift(`${label} overage: ${over} tokens; all ${kept} kept`);
  return { knowledge: active.groups, facts: filled.recent, receipts: [...receipts, ...active.receipts],
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

/** Main-agent initial injection: knowledge, then receipts. Knowledge-only by construction — the
 * shared type carries facts and Raw for other consumers, and injection renders neither. */
export const injectionText = (material: SharedMaterial): string =>
  finish({ content: knowledgeBlock(material), receipts: material.receipts });

/** Main-agent compact: knowledge, then historical facts, then the pending Raw, then receipts. The
 * Raw title is `secondaryRawTitle(profile)` when the views inside it were rendered under the tier-2
 * profile (ticket 20 tier 2); the order, the separators and the receipts are the same either way. */
export const compactText = (material: SharedMaterial, rawTitle: string = RAW_TITLE): string =>
  finish({ content: block([...leading(material), xmlBlock("episodic",
    block([FACTS_TITLE, (material.facts ?? []).join("\n"), rawTitle, rawText(material)]))]), receipts: material.receipts });

/** Noter, fresh context: historical facts, range, the selected Raw, then receipts. 25a: no knowledge
 * block in either Noter mode — a Noter that needs knowledge reads it by address. */
export const notingText = (material: NotingMaterial, range: TaskRange): string =>
  finish({ content: block([FACTS_TITLE, material.facts.join("\n"),
    rangeLine(range), RAW_TITLE, rawText(material)]), receipts: material.receipts });

/** Noter, inherited context: the range, the head reply and the frozen source index (ruling 08:53).
 * The captured request precedes the head's final reply, so that reply is appended; the index
 * supplies addresses and previews, never a second copy of the raw. */
export const notingIncrement = (material: NotingMaterial, range: TaskRange): string =>
  block([rangeLine(range), ...(material.head ? [material.head] : []),
    `${SOURCES_TITLE}\n${material.sources.join("\n")}`]);

/** Consolidator, fresh context: knowledge, range, the selected pending facts, the negation reminders,
 * then receipts. 25a: no already-consolidated history block — those facts are read by address. */
export const consolidationText = (material: ConsolidationMaterial, range: TaskRange): string =>
  finish({ content: block([...leading(material),
    rangeLine(range), RANGE_FACTS_TITLE, material.rangeFacts.join("\n"),
    REMINDER_TITLE, material.reminders.join(BLOCK) || "none"]), receipts: material.receipts });
