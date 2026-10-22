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
// 92: fresh Noter material names its target/range, then reuses the batch-end compact layout:
// Knowledge -> facts -> exact pending Raw -> receipts, with processed-Raw refill disabled.
// Foreground injection is Knowledge -> receipts.
//
// Stable Knowledge bytes contain no task range, entry id, timestamp, run id or omission count. This
// is a layout guarantee, not a shared provider cache: current versions and budget selection can
// change, and foreground and worker instructions differ. Actual retained carriers, not receipts or
// offered material, establish delivery; the frozen selection remains the processing target.
import { createHash } from "node:crypto";
import type { Fact } from "../model/index.ts";
import type { KnowledgeWithRevision } from "../store/index.ts";
import { budgetFacts, budgetKnowledge, charge, finish, knowledgeGroups, renderKnowledgeBlock, KNOWLEDGE_RECENCY_NOTICE, tokens, wholeKnowledge, xmlBlock,
  type BudgetedKnowledge, type FactTurns } from "./index.ts";

/** One knowledge category group as `budgetKnowledge` returns it: the category and its rendered lines. */
export interface KnowledgeGroup { category: string; text: string }
/** A frozen task range as a label. It is a label, never an id watermark (ticket 20). */
export interface TaskRange { from: string; to: string }
export interface RunningTask { id: string; kind: string; description: string; status: string }

/** Display-only estimates captured while assembling a carrier. Framing stays unclassified. */
export interface MemoryComposition { bodyHash: string; knowledge: number; facts: number; raw: number }
export const memoryBodyHash = (text: string): string => createHash("sha256").update(text).digest("hex");
export function measuredMemory(text: string, material: SharedMaterial): { text: string; composition: MemoryComposition } {
  return { text, composition: { bodyHash: memoryBodyHash(text),
    knowledge: tokens((material.knowledge ?? []).map(group => group.text).join("\n")),
    facts: tokens([...(material.factTitles ?? []), ...(material.facts ?? [])].join("\n")),
    raw: tokens([...(material.earlierUsers ?? []).map(entry => entry.view),
      ...(material.entries ?? []).map(entry => entry.view)].join("\n\n")) } };
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
  const sections = [
    { title: FACT_TITLES_TITLE, key: "facts" as const },
    { title: FACTS_TITLE, key: "facts" as const },
    { title: EARLIER_USERS_TITLE, key: "raw" as const },
    { title: RAW_TITLE, key: "raw" as const },
    { title: "Running tasks:", key: null },
  ].map(section => ({ ...section, start: episodic >= 0 ? original.indexOf(`\n${section.title}\n`, episodic) : -1 }))
    .filter(section => section.start >= 0 && section.start < episodicEnd);
  if (episodicEnd >= 0 && original.indexOf("\n<episodic>\n", episodic + 1) < 0 &&
      (closingEpisodic < 0 || original.indexOf("\n</episodic>", closingEpisodic + 1) < 0) &&
      sections.every((section, index) => original.indexOf(`\n${section.title}\n`, section.start + 1) < 0 &&
        (index === 0 || section.start > sections[index - 1]!.start))) {
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i]!;
      if (section.key) regions.push({ start: section.start + 1, end: sections[i + 1]?.start ?? episodicEnd, key: section.key });
    }
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
 * sharing this type never adds a block to a consumer's order. Ordinary injection stays Knowledge-only;
 * Noter material includes Knowledge (92). */
export interface SharedMaterial {
  /** Ticket 118: one reading guide for the complete material, never one per knowledge block. */
  readingGuide?: string;
  /** Active Knowledge within its budget, in category order. */
  knowledge?: KnowledgeGroup[];
  /** Historical facts selected by freshness, displayed in chronological Turn groups, within budget. */
  facts?: string[];
  /** Older fact titles are an index, not visible full fact bodies. */
  factTitles?: string[];
  /** Compressed Raw entries, oldest first, each with the source identity of its own view. */
  entries?: { id: number; view: string }[];
  /** Human input preceding Raw; display only, never source-span coverage. */
  earlierUsers?: { id: number; view: string }[];
  /** Live host state, compaction only; measured in the final text, outside every allowance. */
  runningTasks?: readonly RunningTask[];
  /** Budget receipts for everything the views and the budgets left out. */
  receipts: string[];
  /** 101 (ruled): the knowledge block's header when it is not the plain recency notice — a session's
   * own material also names the session and the path a subagent inherits its knowledge from. */
  knowledgeNotice?: string;
}

/** The frozen task material of one Noting run. No field is a composed message. */
export interface NotingMaterial extends SharedMaterial {
  /** Originating target session, never the worker's host. */
  harness?: string;
  /** The material entries this run must supply: thinking-only processing members are absent. */
  entries: { id: number; view: string }[];
  facts: string[];
}

export type TransportItem =
  /** `form`: a title-only item's text is its header line (144 §7.4). `allowance` and `rank` are core's selection:
   * the Knowledge base's items come first, then the temporary allowance's, each in delivery order (§7.5). */
  | { kind: "knowledge"; text: string; category: string; commitId: number; address: string; form?: "body" | "title"; allowance?: "base" | "temporary"; rank?: number }
  | { kind: "state"; text: string; address: string; receipt: { fromCommit: number; toCommits: number[] } }
  | { kind: "fact"; text: string; factId: number; pending: boolean; allowance?: "temporary"; charge?: number }
  | { kind: "raw"; text: string; entryId: number; address: string; pending: boolean; allowance?: "temporary"; charge?: number }
  /** `allowance`: which cap pays for a Knowledge receipt (the base when it has room, 144 §7.2). */
  | { kind: "receipt"; text: string; knowledge?: boolean; allowance?: "base" | "temporary" };

/** A whole selected domain item can be independently framed when its transport has several
 * unordered carriers. The host only decides which complete framed items fit each carrier. */
export function transportItemText(item: TransportItem, recencyNotice = KNOWLEDGE_RECENCY_NOTICE): string {
  switch (item.kind) {
    case "knowledge": return renderKnowledgeBlock(knowledgeGroups([item]), recencyNotice);
    case "state": return `${KNOWLEDGE_STATUS_TITLE}\n${item.text}`;
    case "fact": return `<episodic>\n${FACTS_TITLE}\n\n${item.text}\n</episodic>`;
    case "raw": return `<episodic>\n${RAW_TITLE}\n\n${item.text}\n</episodic>`;
    case "receipt": return `Receipts:\n${item.text}`;
  }
}

export const FACTS_TITLE = "Recent facts (by Turn):";
export const FACT_TITLES_TITLE = "Earlier facts (titles only; read trace://F<id> for the body):";
export const RAW_TITLE = "Raw:";
export const EARLIER_USERS_TITLE = "Earlier user messages:";
/** Title for retained versions that are no longer current authority. */
export const KNOWLEDGE_STATUS_TITLE = "Inherited knowledge status (these commits are not current authority):";
/** Between blocks, and between a block's title and its body. Entry views use the same separator. */
export const BLOCK = "\n\n";

/** Complete Raw-window charge shared by oldest-batch admission and compact assembly. */
export const rawWindowTokens = (views: string[], receipts: string[]): number =>
  (views.length ? charge([xmlBlock("episodic", ""), RAW_TITLE]) + charge(views) : 0)
  + (receipts.length ? charge(receipts) + charge(["Receipts:"]) : 0);

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
  // The historical-fact receipt is itself charged, and only a fill knows whether there is one. Filling
  // under its charge can omit more facts and lengthen it (eight addresses become "… and 1 more up to"),
  // so refill until the charged receipt covers the produced one. Room only shrinks and a receipt is
  // bounded (ticket 20 "Budgeted receipts"), so this ends.
  // `history` caps the optional historical facts below what the episodic budget would allow: a phase
  // negotiating a smaller model window trims this optional material before it drops selected evidence.
  const room = () => Math.min(input.history ?? Infinity, input.caps.episodic - reserved());
  const fill = (cap: number) => input.facts?.length
    ? budgetFacts(input.facts, input.factLine!, cap, input.factTurns!) : { recent: [] as string[], receipts: [] as string[], factIds: [] as number[] };
  let filled = fill(room());
  for (let charged = 0; charge(filled.receipts) > charged;) {
    charged = charge(filled.receipts);
    filled = fill(room() - charged - (receipts.length ? 0 : charge(["Receipts:"])));
  }
  receipts.push(...filled.receipts);
  const over = reserved() - input.caps.episodic;
  if (over > 0) receipts.unshift(`${label} overage: ${over} tokens; all ${kept} kept`);
  return { knowledge: active.groups, facts: filled.recent, receipts: [...receipts, ...active.receipts, ...noteReceipts],
    knowledgeNotes: notes, factIds: filled.factIds, knowledgeCommitIds: active.commits,
    over: { current: ceiling === undefined ? 0 : Math.max(0, current - ceiling), episodic: Math.max(0, over) } };
}

const block = (parts: string[]): string => parts.join(BLOCK);

/** The leading knowledge block of all four consumers, and the only knowledge layout in this
 * repository. Nothing task-specific may enter it (see "Stable prefix" above); empty knowledge
 * renders no block at all rather than a bare title. */
export const knowledgeBlock = (material: SharedMaterial): string => renderKnowledgeBlock(material.knowledge ?? [], material.knowledgeNotice);
const leading = (material: SharedMaterial): string[] => {
  const knowledge = knowledgeBlock(material);
  return [...(material.readingGuide ? [material.readingGuide] : []), ...(knowledge ? [knowledge] : [])];
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

/** Main-agent compact, also reused by Noter with its exact selected batch. */
export const compactText = (material: SharedMaterial, rawTitle: string = RAW_TITLE, knowledgeNotes: readonly string[] = []): string => {
  // 73: a window that kept nothing emits nothing — no title, and no `<episodic>` tag when both are empty.
  const facts = material.facts ?? [], raw = (material.entries ?? []).map(entry => entry.view);
  const episodic = [...(material.factTitles?.length ? [FACT_TITLES_TITLE, material.factTitles.join("\n")] : []),
    ...(facts.length ? [FACTS_TITLE, facts.join("\n")] : []),
    ...(material.earlierUsers?.length ? [EARLIER_USERS_TITLE, material.earlierUsers.map(entry => entry.view).join(BLOCK)] : []),
    ...(raw.length ? [rawTitle, raw.join(BLOCK)] : []),
    ...(material.runningTasks?.length ? ["Running tasks:", material.runningTasks.map(task =>
      `- ${task.id} ${task.kind}: ${task.description.replace(/[\r\n]/gu, " ")} (${task.status})`).join("\n")] : [])];
  return finish({ content: block([...leading(material), ...statusBlock(knowledgeNotes),
    ...(episodic.length ? [xmlBlock("episodic", block(episodic))] : [])]), receipts: material.receipts });
};

/** Noting uses shared compact rendering plus its task identity. */
export const notingText = (material: NotingMaterial, range: TaskRange): string =>
  block([...(material.harness ? [`Target session agent: ${material.harness}`] : []), rangeLine(range),
    compactText(material)].filter(Boolean));
