import { randomUUID } from "node:crypto";
import { readingGuide } from "../render/reading-guide.ts";
import { searchFacade } from "./search.ts";
import { knowledgeReadSelection, KNOWLEDGE_REPRESENTATIVE_RECEIPT } from "./knowledge-read.ts";
import { canonicalToolNames, renderToolNames, type ToolNames } from "../prompts/tool-names.ts";
import { parseKnowledgeAddress, publicTraceTargets } from "../model/address.ts";
import type { TraceMemoryConfig } from "./index.ts";
import type { Store, KnowledgeWithRevision, KnowledgePath, SourceEntry, SourceEntryMeta, PathSnapshot } from "../store/index.ts";
import type { HumanUserDetector } from "../model/source.ts";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, knowledgeCategoryGroup, type Fact, type FactRelation, type KnowledgeCategory, type KnowledgeRevision, type KnowledgeScope } from "../model/index.ts";
import { formatCost, budgetKnowledge, selectKnowledge, renderKnowledgeTitle, renderKnowledgeOmissions, charge, expandList, tokens, finish, listingLine, sessionKnowledgeNotice, renderKnowledge, renderFact, renderKnowledgeTrace, renderFactGroups, factGroupLayout, renderEntry, rawResultText, xmlBlock, type EntryView, type ResultExtractor, type EntryProfile } from "../render/index.ts";
import { injectionText, compactText, measuredMemory, type MemoryComposition, type SharedMaterial, type TransportItem, type RunningTask, rawWindowTokens, FACTS_TITLE, FACT_TITLES_TITLE, RAW_TITLE, EARLIER_USERS_TITLE, KNOWLEDGE_STATUS_TITLE } from "../render/material.ts";
import { knowledgeStateKey, noVisibility, type KnowledgeStateReceipt, type SuppliedMaterial, type VisibleView } from "./visible.ts";

/** `sessionId`, `headTurnId` and `branch` are the reader's own path, supplied by the host or by a
 * run's tool binding, never by the model: they decide which knowledge a label is judged against and,
 * since 23b, which of a Turn's native occurrences an assembled `trace` shows. An unbound read is
 * unrestricted, as it always was. A Turn's occurrences are selected by `branch`, or — when a paged
 * read froze them at query time (22c) — by the `entryIds` that query kept; like the path, neither is
 * reachable from a model's tool arguments. */
export const READ_VERSIONS = ["current", "history", "all"] as const;
export type ReadVersions = (typeof READ_VERSIONS)[number];
export const READ_FIELDS = ["text", "supports", "topics", "status", "reason", "links"] as const;
export type ReadField = (typeof READ_FIELDS)[number];
export const TRACE_DEFAULT_FIELDS: readonly ReadField[] = ["text", "supports", "topics", "status", "links"];
export const TRACE_HISTORY_DEFAULT_FIELDS: readonly ReadField[] = [...TRACE_DEFAULT_FIELDS, "reason"];
export const SEARCH_DEFAULT_FIELDS: readonly ReadField[] = ["text"];
export const SEARCH_HISTORY_DEFAULT_FIELDS: readonly ReadField[] = ["text", "status"];
export const SEARCH_PREVIEW_TOKENS = 80;
export const MAX_PUBLIC_READ_TOKENS = 8000;
export interface ListingOptions { /** Internal trace:// projection: contributed segments plus uncovered entry paths, never Raw bodies. */ fileFacts?: boolean; itemBudget?: number | null; toolCallBudget?: number | null; toolResultBudget?: number | null; pageBudget?: number | null; maxTokens?: number; /** Host transport ceiling over the final returned string, in JavaScript UTF-16 code units. Not model-facing. */ maxChars?: number; cap?: number; cursor?: string; full?: boolean; versions?: ReadVersions; category?: KnowledgeCategory; scope?: KnowledgeScope; fields?: readonly ReadField[]; sessionId?: number; headTurnId?: number | null; branch?: string; entryIds?: readonly number[]; rawTurn?: boolean; factBacklinks?: ReadonlyMap<number, readonly string[]>; /** Internal frozen metadata for batched exact F reads. */ factReadSnapshot?: { ids: ReadonlySet<number>; relations: ReadonlyMap<number, FactRelation[]> }; profile?: EntryProfile; /** Internal presentation seam; never accepted from model input. */ modelFacing?: boolean; /** Internal host names for generated call hints, not evidence. */ toolNames?: ToolNames }
/** Validate aliases and filters before rendering or touching cursor state. Null is only a
 * content-ceiling disable; pageBudget=null is reserved for internal assembled material reads. */
export function validateBudgets(options: ListingOptions): void {
  for (const key of ["itemBudget", "toolCallBudget", "toolResultBudget", "pageBudget"] as const) {
    const value = options[key];
    if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 1)) throw new Error(`${key} must be a positive safe integer or null`);
    if (key === "pageBudget" && value !== undefined && value !== null && value > MAX_PUBLIC_READ_TOKENS) throw new Error(`pageBudget must be at most ${MAX_PUBLIC_READ_TOKENS}`);
  }
  if (options.full !== undefined && typeof options.full !== "boolean") throw new Error("full must be boolean");
  if (options.full === true && [options.itemBudget, options.toolCallBudget, options.toolResultBudget].some(v => v !== undefined && v !== null)) throw new Error("full:true conflicts with finite content budgets; use null for all content ceilings");
  if (options.pageBudget !== undefined && options.maxTokens !== undefined && options.pageBudget !== options.maxTokens) throw new Error("pageBudget conflicts with maxTokens");
  if ("tool" in options) throw new Error("tool parameter is removed; read the whole entry by address");
  if ("where" in options) throw new Error("where is removed; use scope");
  if (options.versions !== undefined && !READ_VERSIONS.includes(options.versions)) throw new Error("versions must be current, history or all");
  if (options.category !== undefined && !(KNOWLEDGE_CATEGORIES as readonly string[]).includes(options.category)) throw new Error("invalid knowledge category filter");
  if (options.scope !== undefined && !KNOWLEDGE_SCOPES.includes(options.scope)) throw new Error("invalid knowledge scope filter");
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > MAX_PUBLIC_READ_TOKENS))
    throw new Error(`maxTokens must be a positive safe integer at most ${MAX_PUBLIC_READ_TOKENS}`);
  if (options.maxChars !== undefined && (!Number.isSafeInteger(options.maxChars) || options.maxChars < 1))
    throw new Error("maxChars must be a positive safe integer");
  if (options.fields !== undefined && (!Array.isArray(options.fields) || options.fields.some(field => !READ_FIELDS.includes(field))
    || new Set(options.fields).size !== options.fields.length)) throw new Error("fields must contain unique supported field names");
}
export function readProfile(options: ListingOptions, inherited: EntryProfile): EntryProfile {
  const limit = (value: number | null | undefined, fallback: number) => options.full === true || value === null ? Infinity : value ?? fallback;
  return { entryTokens: limit(options.itemBudget, inherited.entryTokens), toolInputTokens: limit(options.toolCallBudget, inherited.toolInputTokens), toolResultTokens: limit(options.toolResultBudget, inherited.toolResultTokens) };
}
/** Shared default response budget for trace and search, including pagination receipts. */
export const DEFAULT_READ_TOKENS = 2000;

/** 21b "Group projection": the topics of current visible knowledge, as references to the exact
 * commits they were read from. A commit with several labels is referenced by each of its groups,
 * and a commit with none stays available under `unclassified`; grouping never changes selection. */
export interface TopicGroups {
  topics: { topic: string; commits: { knowledgeId: number; commit: number }[] }[];
  unclassified: { knowledgeId: number; commit: number }[];
}

/** One custom replacement from a frozen path. Scored Knowledge, full facts and Raw have their
 * own bases. The body pool holds pending Raw overflow, then unscored Knowledge; the pointer
 * pool holds all remaining knowledge titles, then the balanced user/fact-title fill (165).
 * Compact never falls back:
 * over-budget material is truncated — newest kept, oldest omitted with a receipt — rather than
 * escalated to a native delegation. Omitted pending Raw stays pending for Noting; fact omission
 * creates no extraction work. `native` remains only for a host-caught error unrelated to capacity (a
 * store error, an invalid path); core itself never constructs it.
 *
 * 29a "Renderers return what they kept": beside the replacement text, the identities it actually
 * carries — every supplied entry, pending and refilled alike, plus the facts and knowledge commits
 * that survived budgeting. What a budget dropped is absent here. A native delegation supplies
 * nothing, so it has no `supplied` at all. */
export type CompactResult = { text: string; material?: SharedMaterial; supplied: SuppliedMaterial; knowledgeAllowance?: number; temporaryAllowance?: number; pointerAllowance?: number; transportItems?: TransportItem[]; composition?: MemoryComposition; charged?: ChargedWindows; truncated?: TruncationReceipt;
  /** Material exists before capacity selection, even if no body or omission receipt fits. */
  hasMaterialCandidates?: boolean }
  | { native: true; reason: string };

/** Foreground truncation notice for omitted pending Raw and facts. Facts are context omissions,
 * not work for a retired extraction stage; only pending Raw is still processed by Noting. */
/** 79 item 4 (ruled): Raw carries no token figure -- an exact count only, since rendering every
 * omitted entry to size it reads the whole omitted backlog on every compaction. Fact rows are
 * small, so facts keep both a count and a token figure. */
export interface TruncationReceipt { raw?: { entries: number }; facts?: { count: number; tokens: number } }

/** Per-window accounting. The envelope sums three bases and two independent pools (165).
 * Raw overflow and unscored Knowledge charge `temporary`; titles and earlier users charge `pointer`.
 * The reading guide and live running-task block are outside these windows but inside measured text
 * and model-input capacity. Every window is optional and truncates. */
export interface ChargedWindows { knowledge: number; facts: number; raw: number; temporary: number; pointer: number; envelope: number }
/** Foreground Knowledge delivery and the exact body/state identities its carrier may persist. */
export interface Injection { text: string; knowledgeTokens?: number; knowledgeAllowance?: number; knowledgeCommitIds: number[];
  /** Exact title-only membership, independent pool charges and their remaining capacities. */
  knowledgeTitleCommitIds?: number[]; temporaryTokens?: number; pointerTokens?: number; temporaryAllowance?: number; pointerAllowance?: number; knowledgeStates?: KnowledgeStateReceipt[]; transportItems?: TransportItem[]; composition?: MemoryComposition }

/** One component of a `trace` comma list, in request order, rendered over frozen metadata. */
type TaggedBody = { lines: string[]; taggedHeader: string; plainHeader: string; tag: string };
type TraceUnit = { render: () => string | TaggedBody | (string | TaggedBody)[] };

/** Parent 29 "Version-aware knowledge" (29b): one line per commit the reader's context already holds
 * that is not among the current applicable commits here — superseded, archived or merged away. The
 * block beside these lines carries only what is current, so without them stale visible text would
 * read as current knowledge. Ticket 31 made this shared: the Consolidator's material and the main
 * agent's knowledge block are one selection, and neither may explain a stale commit differently.
 * The full revision read happens only when there is a stale commit to explain. */
export interface KnowledgeStateNote { receipt: KnowledgeStateReceipt; text: string; revisions: KnowledgeRevision[] }

const knowledgeStateText = (from: KnowledgeRevision, successors: readonly KnowledgeRevision[], address: (r: KnowledgeRevision) => string): string => {
  const label = `${address(from)} is `;
  if (successors.length > 1) return label + `split into ${successors.map(address).join(" and ")}`;
  const successor = successors[0]!;
  return label + (successor.op === "archive" ? "archived"
    : successor.op === "merge" || successor.knowledgeId !== from.knowledgeId ? `merged into ${address(successor)}`
    : `superseded by ${address(successor)}`);
};

/** Necessary state changes for exact bodies already visible on this path. The receipt is deliberately
 * separate from body visibility: naming a survivor or split child grants no read handle or body. */
export function knowledgeStateNotes(store: Store, current: readonly KnowledgeWithRevision[], visible: Iterable<number>,
  path: KnowledgePath | null, projectId?: number, prepared?: ReturnType<Store["commitGraph"]>, modelFacing = false): KnowledgeStateNote[] {
  const address = (r: KnowledgeRevision) => modelFacing ? `K${r.knowledgeId}@v${store.versionOrdinal(r.knowledgeId, r.id)}` : `K${r.knowledgeId}@${r.id}`;
  const retained = [...visible];
  if (!retained.length) return [];
  const graph = prepared ?? store.commitGraph(path, projectId);
  const active = new Set(current.map(k => k.revision.id));
  const selected = new Map(current.map(item => [item.revision.knowledgeId, item.revision]));
  const byCommit = new Map(graph.revisions.map(r => [r.id, r]));
  return retained.filter(id => !active.has(id)).flatMap(id => {
    const revision = byCommit.get(id);
    if (!revision) return [];
    const shown = selected.get(revision.knowledgeId);
    const resolvedIdentity = graph.current.filter(candidate => candidate.knowledgeId === revision.knowledgeId);
    const applicableIdentity = graph.revisions.filter(candidate => candidate.knowledgeId === revision.knowledgeId
      && graph.applicable.has(candidate.id));
    if (!graph.applicable.has(id)) {
      const targets = shown ? [shown] : resolvedIdentity;
      return [{ receipt: { fromCommit: id, toCommits: targets.length ? targets.map(target => target.id) : [id] },
        revisions: targets, text: targets.length || applicableIdentity.length
          ? `${address(revision)} no longer applies`
          : `K${revision.knowledgeId} no longer applies` }];
    }
    const descendants = graph.descendants(id);
    // Resolve globally, then name only successors visible to this reader (archives included).
    // An out-of-scope successor invalidates the old body without exposing its identity or version.
    const descendantsSelected = graph.current.filter(candidate => candidate.id !== id && descendants.has(candidate.id));
    const successors = descendantsSelected.length ? descendantsSelected
      : resolvedIdentity.filter(candidate => candidate.id !== id);
    const directBranches = graph.revisions.filter(candidate => candidate.parentId === id);
    if (shown && shown.id !== id && (directBranches.length > 1 || !descendants.has(shown.id)))
      return [{ receipt: { fromCommit: id, toCommits: [shown.id] }, revisions: [shown],
        text: `${address(revision)} is shown as ${address(shown)}` }];
    if (!successors.length) return [{ receipt: { fromCommit: id, toCommits: [id] }, revisions: [],
      text: `K${revision.knowledgeId} no longer applies` }];
    const split = graph.revisions.some(r => r.op === "split" && r.parentId === id && graph.applicable.has(r.id));
    if (split) return [{ receipt: { fromCommit: id, toCommits: successors.map(r => r.id) }, revisions: successors,
      text: successors.length === 1 ? `${address(revision)} is split; visible result: ${address(successors[0]!)}`
        : knowledgeStateText(revision, successors, address) }];
    return successors.map(successor => ({ receipt: { fromCommit: id, toCommits: [successor.id] }, revisions: [successor],
      text: knowledgeStateText(revision, [successor], address) }));
  });
}

/** Compatibility projection used by Consolidation and explicit renderer tests. */
export function knowledgeStatusNotes(store: Store, current: readonly KnowledgeWithRevision[], visible: Iterable<number>,
  path: KnowledgePath | null, projectId?: number, modelFacing = false): string[] {
  return knowledgeStateNotes(store, current, visible, path, projectId, undefined, modelFacing).map(note =>
    note.text.replace(/(superseded by K\d+@(?:v)?\d+)$/, "$1 above"));
}

export function readFacade(store: Store, config: TraceMemoryConfig, prepare: (address: string, options?: ListingOptions) => (() => string) = () => { throw new Error("Trace expansion requires its bound reader"); },
  resultText: ResultExtractor = rawResultText, humanUser?: HumanUserDetector) {
  // 22c: what a listing still owes its caller is kept as hit identities plus the formatter that turns
  // exactly one page of them into lines. The formatter carries its query's own snapshot, so a page
  // asked for later prints the labels that query established, and nothing but values is held between
  // pages — no open transaction, no reserved connection.
  interface Continuation { items: readonly unknown[]; format: (items: readonly unknown[]) => (string | TaggedBody)[] }
  /** A query's remainder: the frozen hit set of that one query, shared by every page it still owes,
   * plus this cursor's own position in it. `pending` holds the lines of a hit whose formatting
   * crossed the page edge — `cap` counts output lines. Every read freezes the effective page aliases,
   * line cap, fields, filters and configured content profile; an oversized line leaves its unsent
   * suffix in the same queue, without a second fragment cache.
   * `fragmented` prevents re-estimating a giant line's whole suffix on each continuation.
   * Cursor state holds only frozen output, never a caller's read or write grants. */
  type FrozenListing = {
    itemBudget: number | null; toolCallBudget: number | null; toolResultBudget: number | null;
    versions?: ReadVersions; category?: KnowledgeCategory;
    scope?: KnowledgeScope; fields?: readonly ReadField[];
  };
  type PendingLine = { text: string; completionTag?: string };
  type Remainder = Continuation & { offset: number; pending: readonly (PendingLine | TaggedBody)[]; footer: string; cap: number; owner: string; maxTokens?: number; maxChars?: number; modelFacing: boolean; fragmented: boolean; frozen: FrozenListing };
  // A model asks for page one and usually never asks for page two, so a continuation is a cache
  // entry, not an obligation: the least recently used one is dropped once this many are outstanding,
  // and the reader meets the "unknown or expired cursor" error that an unknown cursor always met.
  // A count bound needs no clock and no timer; add an age bound only if a single query's remainder
  // ever becomes large enough that sixteen of them matter.
  const CURSORS = 16;
  const cursors = new Map<string, Remainder>();
  const page = (source: string[] | Continuation, options: ListingOptions = {}, footer = ""): string => {
    const owner = options.sessionId === undefined ? "unbound" : `${options.sessionId}:${store.getSession(options.sessionId)?.projectId}`;
    const saved = options.cursor ? cursors.get(options.cursor) : undefined;
    if (options.cursor && (!saved || saved.owner !== owner)) throw new Error("unknown or expired cursor");
    if (saved && saved.modelFacing !== !!options.modelFacing) throw new Error("cursor belongs to another presentation surface");
    const defaults = { itemBudget: config.render.entryTokens, toolCallBudget: config.render.toolInputTokens,
      toolResultBudget: config.render.toolResultTokens };
    const content = (key: keyof typeof defaults): number | null => options[key] !== undefined ? options[key]!
      : options.full === true ? null : saved ? saved.frozen[key] : defaults[key];
    const frozen: FrozenListing = {
      itemBudget: content("itemBudget"), toolCallBudget: content("toolCallBudget"), toolResultBudget: content("toolResultBudget"),
      versions: options.versions ?? saved?.frozen.versions, category: options.category ?? saved?.frozen.category,
      scope: options.scope ?? saved?.frozen.scope, fields: options.fields ?? saved?.frozen.fields,
    };
    for (const key of ["itemBudget", "toolCallBudget", "toolResultBudget", "versions", "category", "scope", "fields"] as const) {
      const same = key === "fields" ? JSON.stringify(frozen.fields) === JSON.stringify(saved?.frozen.fields)
        : frozen[key] === saved?.frozen[key];
      if (saved && !same) throw new Error(`cursor ${key} is frozen; omit it or use the original value`);
    }
    const requested = options.cap ?? saved?.cap ?? 100;
    if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("listing cap must be a positive integer");
    if (saved && requested !== saved.cap) throw new Error("cursor cap is frozen; omit it or use the original value");
    const cap = saved?.cap ?? requested;
    const { items, format } = saved ?? (Array.isArray(source)
      ? { items: source, format: (lines: readonly unknown[]) => lines as string[] } : source);
    if (saved) footer = saved.footer;
    const namesPageBudget = options.pageBudget !== undefined || options.maxTokens !== undefined;
    const requestedMaxTokens = options.pageBudget === null ? undefined : options.pageBudget ?? options.maxTokens;
    const maxTokens = namesPageBudget ? requestedMaxTokens : saved ? saved.maxTokens : DEFAULT_READ_TOKENS;
    if (saved && namesPageBudget && maxTokens !== saved.maxTokens) {
      const key = options.pageBudget !== undefined ? "pageBudget" : "maxTokens";
      throw new Error(`cursor ${key} is frozen; omit it or use the original budget`);
    }
    const namesMaxChars = options.maxChars !== undefined;
    const maxChars = namesMaxChars ? options.maxChars : saved?.maxChars;
    if (saved && namesMaxChars && maxChars !== saved.maxChars)
      throw new Error("cursor maxChars is frozen; omit it or use the original ceiling");
    const cursor = randomUUID();
    const fragmentNote = "Hit continues on next page; concatenate without a newline.";
    const output = (lines: string[], more: boolean, fragment = false) => finish({ content: lines.join("\n"),
      receipts: [...(footer ? [footer] : []), ...(fragment ? [fragmentNote] : []), ...(more ? [`cursor=${cursor}`] : [])] });
    const violations = (text: string) => (maxTokens !== undefined && tokens(text) > maxTokens)
      || (maxChars !== undefined && text.length > maxChars);
    const fits = (lines: string[], more: boolean, fragment = false) => !violations(output(lines, more, fragment));
    // Alternating letters/digits bound the UUID's estimate, so an admitted tiny budget still
    // permits progress when the next page generates a more expensive cursor spelling.
    const minimum = output(["😀"], true, true).replace(cursor, "a1a1a1a1-a1a1-4a1a-a1a1-a1a1a1a1a1a1");
    const tooSmall = maxChars === undefined ? "listing maxTokens is too small for pagination hints and content"
      : "listing limits are too small for pagination hints and content";
    if (violations(minimum)) throw new Error(tooSmall);
    const lines: string[] = [], pending = [...(saved?.pending ?? [])];
    let at = saved?.offset ?? 0, fragment = false, fragmented = saved?.fragmented ?? false;
    while (lines.length < cap && (pending.length || at < items.length)) {
      // One-hit lookahead only. Unrendered hits retain the existing frozen identity snapshot.
      if (!pending.length) pending.push(...format([items[at++]]).map(part => typeof part === "string" ? { text: part } : part));
      if (!pending.length) continue;
      const next = pending[0]!;
      if ("lines" in next) {
        // Body identity and completion stay structured until the page actually emits it.
        // Queueing a later collection member is not the start of that member's body.
        if (lines.length + next.lines.length <= cap && fits([...lines, ...next.lines], pending.length > 1 || at < items.length)) {
          lines.push(...next.lines); pending.shift(); continue;
        }
        if (lines.length) break;
        const body = [...next.lines];
        body[0] = next.plainHeader + body[0]!.slice(next.taggedHeader.length);
        pending.splice(0, 1, ...body.slice(0, -1).map(text => ({ text })), { text: body.at(-1)!, completionTag: next.tag });
      }
      const part = pending[0] as PendingLine;
      const line = part.text;
      const tagged = part.completionTag ? `${line} · version ${part.completionTag}` : line;
      const more = pending.length > 1 || at < items.length;
      // The estimator is not monotone (an ASCII suffix can reclassify an emoji run).
      // Price each intact line once before probing; never repeat this full scan on its fragments.
      if (!fragmented && fits([...lines, tagged], more)) { lines.push(tagged); pending.shift(); continue; }
      // Prefer an intact pending line on the next page instead of splitting it into spare room.
      if (lines.length) break;
      // Probe near the page size, not halfway through a potentially megabyte-long remainder.
      // Measuring the whole suffix on EVERY page makes a large single line quadratic to drain.
      // Price only valid code-point prefixes too: a dangling surrogate can change the estimator's
      // script classification (notably a pure emoji run), making an unsafe cut look much cheaper.
      const prefix = (end: number) => line.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(line[end - 1]!)
        && /[\uDC00-\uDFFF]/.test(line[end] ?? "") ? end - 1 : end);
      let low = 0, high = Math.min(256, line.length);
      while (high < line.length && fits([prefix(high)], true, true)) {
        low = high; high = Math.min(line.length, high * 2);
      }
      if (high === line.length && fits([tagged], more)) { lines.push(tagged); pending.shift(); fragmented = false; continue; }
      // Keep the suffix in the SAME pending queue, at code-point boundaries. Escaped text is
      // transported verbatim: fragments must be concatenated before interpreting JSON escapes.
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        const candidate = prefix(mid);
        if (fits([candidate + (mid === line.length && part.completionTag ? ` · version ${part.completionTag}` : "")],
          mid === line.length ? more : true, mid !== line.length)) low = mid; else high = mid - 1;
      }
      const kept = prefix(low);
      if (!kept || !fits([kept], true, true)) throw new Error(maxChars === undefined
        ? "listing maxTokens is too small for this hit and pagination hints" : "listing limits are too small for this hit and pagination hints");
      lines.push(kept); pending[0] = { ...part, text: line.slice(kept.length) }; fragment = true; fragmented = true;
      break;
    }
    const more = pending.length > 0 || at < items.length;
    const result = output(lines, more, fragment);
    if (violations(result)) throw new Error(maxChars === undefined
      ? "listing maxTokens is too small for pagination hints" : "listing limits are too small for pagination hints");
    // Snapshot and validate first: a rejected request must leave the input cursor usable.
    const remainder = more ? saved ? { ...saved, offset: at, pending, fragmented }
      : { items, offset: at, pending, format, footer, cap, owner, maxTokens, maxChars, modelFacing: !!options.modelFacing, fragmented, frozen } : undefined;
    if (options.cursor) cursors.delete(options.cursor);
    if (remainder) {
      cursors.set(cursor, remainder);
      for (const oldest of cursors.keys()) { if (cursors.size <= CURSORS) break; cursors.delete(oldest); }
    }
    return result;
  };
  const session = (id: number) => {
    const value = store.getSession(id);
    if (!value) throw new Error(`session S${id} does not exist`);
    return value;
  };
  const effectiveOptions = (options: ListingOptions): ListingOptions => ({ ...options, versions: options.versions ?? "current" });
  const factLine = (id: number, relations: readonly FactRelation[] = store.listFactRelations(id)) => renderFact(store.getFact(id)!, [...relations]);
  const factGroups = (facts: Fact[], relations = store.listFactRelationsOf(facts.map(fact => fact.id))) =>
    renderFactGroups(facts, f => factLine(f.id, relations.get(f.id) ?? []), store.factTurnTimes(facts));
  const knowledgeLine = (value: KnowledgeWithRevision) => renderKnowledge({ ...value, staleReasons: store.knowledgeStaleReasons(value.revision.id) },
    `K${value.knowledge.id}#${store.versionTag(value.knowledge.id, value.revision.id)}`, false, store.writing);
  // The knowledge part of the shared material contract (20a): the applicable commits at one node,
  // under the existing scope and commit-graph rules. Its block layout lives in core/render/material.ts.
  const applicable = (projectId: number, sessionId = 0, headTurnId?: number | null, branch?: string) =>
    store.listVisibleKnowledge(sessionId, projectId, headTurnId, branch);
  /** 92/97: current visible exact versions minus the node's delivered state, which hosts read from
   * the per-node delivery records. Facts and Raw are evidence, not substitutes for a publication. */
  const injection = (target: number | { projectId: number } | KnowledgePath, visible: VisibleView = noVisibility(),
    transport = false, toolNames: ToolNames = canonicalToolNames): Injection => {
    const empty = (): Injection => ({ text: "", knowledgeCommitIds: [] });
    const baseCap = store.knowledgeBase(), temporaryCap = config.compaction.temporaryTokens, pointerCap = config.compaction.pointerTokens;
    if (!Number.isSafeInteger(baseCap + temporaryCap + pointerCap)) throw new Error("derived foreground Knowledge capacity must be a safe integer");
    const id = typeof target === "number" ? target : "sessionId" in target ? target.sessionId : undefined;
    if (id !== undefined && !store.enabled(id)) return empty();
    const projectId = id === undefined ? (target as { projectId: number }).projectId : session(id).projectId;
    if (!store.getProject(projectId)) throw new Error(`project ${projectId} does not exist`);
    const path = id === undefined ? null : typeof target === "object" && "sessionId" in target
      ? target : store.knowledgePath(id);
    // Ticket 80 item 2: injection runs on every ordinary prompt, sharing this session's per-process
    // graph memo with the footer, eligibility and dreamingDue reads of the same request.
    const input = store.commitGraphInput(undefined, id);
    const graph = store.commitGraph(path, path ? undefined : projectId, undefined, input);
    const records = store.knowledgeRecords(graph.revisions.map(revision => revision.knowledgeId));
    const values = (revisions: readonly KnowledgeRevision[]): KnowledgeWithRevision[] => revisions.map(revision => ({
      knowledge: records.get(revision.knowledgeId)!, revision,
    }));
    const current = values(graph.current.filter(revision => revision.op !== "archive"));
    const allStates = knowledgeStateNotes(store, current, visible.knowledgeCommitIds, path, path ? undefined : projectId, graph, true);
    const notice = id === undefined ? undefined : sessionKnowledgeNotice(id);

    const delta = current.filter(({ revision }) => !visible.knowledgeCommitIds.has(revision.id));
    const states = allStates.filter(state => !(visible.knowledgeStates ?? new Set()).has(knowledgeStateKey(state.receipt)));
    if (!delta.length && !states.length) return empty();

    const line = knowledgeLine;
    // Hosts pass the recorded cost of every delivery on the path, including inapplicable bodies.
    // Only older direct API callers without that measured view need the compatibility projection;
    // normal publication must not re-render historical bodies just to discard their estimated cost.
    const unaccountedCost = () => {
      const bodies = values(graph.revisions.filter(revision => revision.op !== "archive" && visible.knowledgeCommitIds.has(revision.id)));
      const groups = budgetKnowledge(bodies, Infinity, line).groups;
      const acknowledged = visible.knowledgeStates ?? new Set<string>();
      const sources = [...acknowledged].map(key => Number(key.split(">")[0]));
      const notes = knowledgeStateNotes(store, current, sources, path, path ? undefined : projectId, graph, true)
        .filter(state => acknowledged.has(knowledgeStateKey(state.receipt))).map(state => state.text);
      return tokens(injectionText({ knowledge: groups, receipts: [] }, notes));
    };
    // Each context cap is reduced only by deliveries charged to that cap.
    const baseLeft = Math.max(0, baseCap - (visible.knowledgeTokens ?? unaccountedCost()));
    // User ruling, 2026-10-22: an ordinary prompt may spend what the context's 10k has left since its last compaction, /clear
    // or session start, and that includes knowledge the Noter has just written.
    const temporaryLeft = Math.max(0, temporaryCap - (visible.temporaryTokens ?? 0));
    const pointerLeft = Math.max(0, pointerCap - (visible.pointerTokens ?? 0));
    if (baseLeft <= 0 && temporaryLeft <= 0 && pointerLeft <= 0) return empty();

    // State transitions retain priority over optional bodies. Then the shared selector preserves
    // the newest commits and receipts omitted older items, without publishing a receipt alone.
    const guide = readingGuide(id, toolNames);
    const buildStates = (count: number, includeGuide = true) => injectionText({ knowledge: [], receipts: [], ...(includeGuide ? { readingGuide: guide } : {}) }, states.slice(0, count).map(state => state.text));
    const longest = (high: number, fits: (count: number) => boolean) => {
      let low = 0;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) low = middle; else high = middle - 1;
      }
      return low;
    };
    const transportState = (state: KnowledgeStateNote): TransportItem => {
      const from = store.knowledgeRevision(state.receipt.fromCommit)!;
      return { kind: "state", text: state.text, receipt: state.receipt,
        address: `K${from.knowledgeId}@v${store.versionOrdinal(from.knowledgeId, from.id)}` };
    };
    const stateCount = longest(states.length, count => tokens(buildStates(count, false)) <= baseLeft);
    if (stateCount < states.length) {
      if (!stateCount) return empty();
      const material = { knowledge: [], receipts: [], readingGuide: guide };
      const rendered = measuredMemory(buildStates(stateCount), material);
      return { ...rendered, knowledgeTokens: tokens(buildStates(stateCount, false)), knowledgeAllowance: baseLeft, temporaryAllowance: temporaryLeft, pointerAllowance: pointerLeft, knowledgeCommitIds: [], knowledgeStates: states.slice(0, stateCount).map(state => state.receipt),
        ...(transport ? { transportItems: states.slice(0, stateCount).map(transportState) } : {}) };
    }
    const selectedStates = states.slice(0, stateCount);
    const titleLine = (value: KnowledgeWithRevision) => renderKnowledgeTitle({ ...value, staleReasons: store.knowledgeStaleReasons(value.revision.id) },
      `K${value.knowledge.id}#${store.versionTag(value.knowledge.id, value.revision.id)}`, store.writing);
    const statesText = selectedStates.map(state => state.text);
    const statesCost = tokens(injectionText({ knowledge: [], receipts: [] }, statesText));
    // The selector prices parts conservatively; the exact rendered window is checked afterwards and the caps
    // are tightened by any overshoot, so both allowances hold on the text actually emitted.
    let slackBase = 0, slackTemporary = 0, slackPointer = 0;
    for (;;) {
      const selection = selectKnowledge(delta, { baseCap: Math.max(0, baseLeft - statesCost - slackBase), temporaryCap: Math.max(0, temporaryLeft - slackTemporary),
        pointerCap: Math.max(0, pointerLeft - slackPointer), line, titleLine, recencyNotice: undefined, titled: visible.knowledgeTitleCommitIds });
      const material = { knowledge: selection.groups, receipts: selection.receipts, knowledgeNotice: notice, readingGuide: guide };
      const text = injectionText(material, statesText);
      const windowText = injectionText({ ...material, readingGuide: "" }, statesText);
      // Price successive windows exactly: base, all bodies, then pointers.
      const total = tokens(windowText), baseUsed = selection.baseGroups.length || selectedStates.length || selection.baseReceipts.length
        ? tokens(injectionText({ knowledge: selection.baseGroups, receipts: selection.baseReceipts, knowledgeNotice: notice }, statesText)) : 0;
      const bodyUsed = (selection.bodyGroups.length || selectedStates.length || selection.baseReceipts.length
        ? tokens(injectionText({ knowledge: selection.bodyGroups, receipts: selection.baseReceipts, knowledgeNotice: notice }, statesText)) : 0) - baseUsed;
      const pointerUsed = total - baseUsed - bodyUsed;
      if (baseUsed > baseLeft && selection.ranked.some(item => item.allowance === "base")) { slackBase += baseUsed - baseLeft; continue; }
      if (bodyUsed > temporaryLeft && selection.ranked.some(item => item.allowance === "temporary")) { slackTemporary += bodyUsed - temporaryLeft; continue; }
      if (pointerUsed > pointerLeft && selection.ranked.some(item => item.allowance === "pointer")) { slackPointer += pointerUsed - pointerLeft; continue; }
      if (!selection.ranked.length && !selectedStates.length) return empty();
      const rendered = measuredMemory(text, material);
      return { ...rendered, knowledgeTokens: baseUsed, temporaryTokens: bodyUsed, pointerTokens: pointerUsed, knowledgeAllowance: baseLeft, temporaryAllowance: temporaryLeft, pointerAllowance: pointerLeft,
        knowledgeCommitIds: selection.bodyCommits, ...(selection.titleCommits.length ? { knowledgeTitleCommitIds: selection.titleCommits } : {}),
        ...(transport ? { transportItems: [
          ...selection.ranked.map(({ value, form, allowance, rank }) => ({ kind: "knowledge" as const,
            text: form === "title" ? titleLine(value) : knowledgeLine(value), category: knowledgeCategoryGroup(value.revision.category), commitId: value.revision.id,
            address: `K${value.knowledge.id}@v${store.versionOrdinal(value.knowledge.id, value.revision.id)}`, form, allowance, rank })),
          ...selectedStates.map(transportState),
          ...material.receipts.map(text => ({ kind: "receipt" as const, text, allowance: selection.receiptAllowance })),
        ] } : {}),
        ...(selectedStates.length ? { knowledgeStates: selectedStates.map(state => state.receipt) } : {}) };
    }
  };
  const trace = (address: string, options: ListingOptions = {}): string => {
    validateBudgets(options);
    const cursor = /^cursor=([^,\s]+)$/.exec(address.trim());
    if (options.cursor || cursor) {
      // Preserve the explicit-cursor placeholder convention without allowing malformed entry
      // grammar to consume a read. A placeholder never changes the frozen query membership.
      if (options.cursor && address.trim() && !cursor) {
        const placeholders = publicTraceTargets(address);
        if (placeholders.some(target => target.startsWith("cursor="))) throw new Error("continue a cursor alone, not in a comma list");
      }
      return page([], { ...options, cursor: options.cursor ?? cursor![1] });
    }
    options = effectiveOptions(options);
    const targets = publicTraceTargets(address);
    if (targets.some(target => target.startsWith("cursor="))) throw new Error("continue a cursor alone, not in a comma list");
    const historyFields = targets.some(target => /^K[1-9]\d*\.history$/.test(target)
      || options.versions !== "current" && /^K[1-9]\d*$/.test(target));
    options = { ...options, fields: [...(options.fields ?? (historyFields ? TRACE_HISTORY_DEFAULT_FIELDS : TRACE_DEFAULT_FIELDS))] };
    options = { ...options, maxTokens: options.pageBudget === null ? undefined : options.pageBudget ?? options.maxTokens ?? DEFAULT_READ_TOKENS,
      ...(options.pageBudget === null ? { cap: Number.MAX_SAFE_INTEGER } : {}) };
    const collectionReceipts: string[] = [];
    const profile = readProfile(options, config.render);
    const items = store.readSnapshot(() => {

      // Freeze all values in one read snapshot. Renderers close over these values, not queries.
      const fields = new Set(options.fields!);
      const requestedFacts = targets.filter(target => /^F[1-9]\d*$/.test(target)).map(target => Number(target.slice(1)));
      const factReadSnapshot = { ids: store.existingFactIds(requestedFacts), relations: store.listFactRelationsOf(requestedFacts) };
      const citing = store.citingKnowledge(requestedFacts);
      const backlinkSelection = citing.size ? knowledgeReadSelection(store, { sessionId: options.sessionId,
        branch: options.branch, headTurnId: options.headTurnId }) : null;
      const ordinals = store.versionOrdinals([...new Set([
        ...[...citing.values()].flatMap(identities => [...identities.values()].flat()),
        ...(backlinkSelection?.graph.current.map(revision => revision.id) ?? []),
      ])]);
      const currentByIdentity = new Map(backlinkSelection?.graph.current.map(revision => [revision.knowledgeId, revision]) ?? []);
      const backlinks = new Map([...citing].map(([factId, identities]) => [factId, [...identities].flatMap(([id, revisions]) => {
        const current = currentByIdentity.get(id);
        if (!current || !backlinkSelection!.matches(current)) return [];
        const currentOrdinal = ordinals.get(current.id)!;
        return [`K${id}@v${currentOrdinal} — cited by ${[...new Set(revisions.map(revision => ordinals.get(revision)!))].map(n => `v${n}`).join(", ")}; current v${currentOrdinal}${current.op === "archive" ? " (archived)" : ""}`];
      })]));
      const namedKnowledgeIds = targets.flatMap(target => /^K([1-9]\d*)/.exec(target)?.[1] ? [Number(/^K([1-9]\d*)/.exec(target)![1])] : []);
      const supportTitles = store.factTitles(store.revisionSupportIds(namedKnowledgeIds));
      // Freeze identity, links, status and version metadata in this same snapshot. A cursor
      // formats these values only; it must not consult a later database state.
      const knowledgeBody = (value: KnowledgeWithRevision, parents: KnowledgeRevision[], children: KnowledgeRevision[], status?: string,
        historyLine = false, titles = supportTitles) => {
        value = { ...value, staleReasons: store.knowledgeStaleReasons(value.revision.id) };
        const { knowledge, revision } = value;
        const labels = new Map([revision, ...parents, ...children].map(r => [r.id,
          `K${r.knowledgeId}@v${store.versionOrdinal(r.knowledgeId, r.id)}`]));
        const tag = `K${knowledge.id}#${store.versionTag(knowledge.id, revision.id)}`;
        const plainHeader = `[K${knowledge.id}]`, taggedHeader = `[${tag}]`;
        const shown = (r: KnowledgeRevision) => r.id === revision.id ? tag : labels.get(r.id)!;
        const plain = (r: KnowledgeRevision) => r.id === revision.id ? `K${knowledge.id}` : labels.get(r.id)!;
        return (): string | TaggedBody => {
          const full = renderKnowledgeTrace(value, parents, children, Infinity, fields, historyLine, status, shown, labels.get(revision.id), titles, store.writing);
          if (!fields.has("text") || tokens(full) > profile.entryTokens)
            return renderKnowledgeTrace(value, parents, children, profile.entryTokens, fields, historyLine, status, plain, labels.get(revision.id), titles, store.writing);
          return { lines: full.split("\n"), taggedHeader, plainHeader, tag };
        };
      };
      const named = (target: string, status?: string, historyLine = false): (() => string | TaggedBody | (string | TaggedBody)[]) => {
        const s = /^S([1-9]\d*)$/.exec(target);
        if (s) {
          const id = Number(s[1]);
          session(id);
          collectionReceipts.push(`selected: S${id} Raw only (named collection; scope=${options.scope ?? "omitted"})`);
          const turns = store.listTurns(id).map(t => prepare(`T${t.id}`, { ...options, profile, rawTurn: true,
            ...(options.sessionId === id ? {} : { sessionId: id, branch: undefined, headTurnId: undefined }) }));
          return () => turns.map(render => listingLine(render())).join("\n");
        }
        let project = store.findProjectByName(target);
        while (project?.mergedInto != null) project = store.getProject(project.mergedInto);
        if (project) {
          const selection = knowledgeReadSelection(store, options, project.id);
          const revisions = selection.representatives(selection.graph.revisions).sort((a, b) => a.id - b.id);
          const records = store.knowledgeRecords(revisions.map(r => r.knowledgeId));
          const projectTitles = store.factTitles([...new Set(revisions.flatMap(r => r.supports))]);
          const fields = new Set(options.fields!);
          const knowledge = revisions.map(revision => {
            const parents = (selection.input.parents.get(revision.id) ?? []).map(id => selection.byCommit.get(id)!);
            const children = selection.graph.revisions.filter(r => selection.input.parents.get(r.id)?.includes(revision.id));
            const status = selection.status(revision);
            const value = { knowledge: records.get(revision.knowledgeId)!, revision };
            return options.modelFacing ? knowledgeBody(value, parents, children, status, false, projectTitles)
              : () => renderKnowledgeTrace(value, parents, children, profile.entryTokens, fields, false, status,
                undefined, undefined, projectTitles, store.writing);
          });
          const facts = store.listProjectFacts(project.id);
          const relations = options.sessionId === undefined ? store.listFactRelationsOf(facts.map(fact => fact.id)) : (() => {
            const path = store.knowledgePath(options.sessionId!, options.branch, options.headTurnId);
            return store.listFactRelationsOnPathOf(facts.map(fact => fact.id), path);
          })();
          const times = store.factTurnTimes(facts);
          collectionReceipts.push(`selected: project ${project.name} facts; ${options.scope ?? "global/project"} knowledge; ${options.versions} versions`, renderToolNames(KNOWLEDGE_REPRESENTATIVE_RECEIPT, options.toolNames ?? canonicalToolNames));
          return () => [...knowledge.map(render => render()), ...renderFactGroups(facts,
            (fact, frame) => renderFact(fact, relations.get(fact.id) ?? [], profile.entryTokens, frame), times, true)].filter(Boolean);
        }
        const exact = options.modelFacing ? parseKnowledgeAddress(target) : null;
        if (exact && exact.to === undefined && (exact.tag || exact.ordinal)) {
          const commit = exact.tag ? store.resolveVersionTag(exact.id, exact.tag) : store.resolveVersionOrdinal(exact.id, exact.from!);
          const revision = store.getKnowledgeRevision(exact.id, commit)!;
          return knowledgeBody({ knowledge: store.getKnowledge(exact.id)!, revision }, store.commitParents(revision), store.commitChildren(revision), status, historyLine);
        }
        return prepare(target, { ...options, profile, factBacklinks: backlinks, factReadSnapshot });
      };
      const units = targets.flatMap((target): TraceUnit[] => {
        if (options.modelFacing && /^K[1-9]\d*$/.test(target)) {
          const id = Number(/^K([1-9]\d*)/.exec(target)![1]);
          const history = store.listKnowledgeRevisions(id);
          if (!history.length) return [{ render: named(target) }];
          const selection = knowledgeReadSelection(store, options);
          const revisions = options.versions === "current" ? selection.representatives(history)
            : history.filter(r => selection.matches(r) && (options.versions === "all" || selection.graph.applicable.has(r.id)));
          return revisions.length ? revisions.map(revision => ({ render: named(`K${id}@v${store.versionOrdinal(id, revision.id)}`, selection.status(revision),
            options.versions !== "current") }))
            : [{ render: named(target) }];
        }
        return [{ render: named(target) }];
      });
      return units;
    });
    const format = (units: readonly unknown[]) => (units as TraceUnit[])
      .flatMap<string | TaggedBody>(unit => {
        const rendered = unit.render();
        return (Array.isArray(rendered) ? rendered : [rendered]).flatMap<string | TaggedBody>(part => typeof part === "string" ? part.split("\n") : [part]);
      });
    const footer = [...collectionReceipts, ...(targets.some(target => /^K[1-9]\d*$/.test(target))
      ? [`versions: ${options.versions}${historyFields ? "; explicit K history" : ""}`] : [])].join("\n");
    return page({ items, format }, options, footer);
  };
  // Model spend of this session's runs, from the usage each run recorded (summed over its rounds).
  // 22d: the usage is projected out of the stored response by the store; the request and response
  // audit bodies are never loaded to add up counters. A run without a usage observation — a failure,
  // a cancelled run with unknown usage — contributes nothing at all, not a zero.
  const spend = (sessionId: number) => {
    session(sessionId);
    const totals = { runs: { noting: 0, consolidation: 0, dreaming: 0, manual: 0 }, costs: { noting: 0, consolidation: 0, dreaming: 0, manual: 0 },
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknown: 0 };
    for (const { kind, usage, costUnknown } of store.listRunUsage(sessionId)) {
      totals.runs[kind]++;
      if (costUnknown) totals.unknown++;
      if (!usage) continue;
      totals.input += usage.input; totals.output += usage.output;
      totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite;
      if (usage.cost !== null) { totals.cost += usage.cost; totals.costs[kind] += usage.cost; }
    }
    return totals;
  };
  // 51: the footer's figure — every session's runs created at or after `since` (the host passes local
  // midnight as a UTC instant), so the number resets at the day boundary on its own. 77: the store's
  // own query, answered from a covering index on `created_at`, never `listRunUsage`'s session index.
  const spendSince = (since: string) => store.spendSince(since);
  /** Ticket 69/72: `facts`, `unconsolidated`, `knowledge` and `changedKnowledge` are cached per
   * (sessionId, branch), invalidated by `Store.progressSignal` — a cheap composite that changes
   * exactly when a commit (by this process or another connection to the same file) could change one
   * of them. `entries` comes from the shared incremental pending queue, never from these cached
   * knowledge counts. One entry per distinct (sessionId, branch) this process has
   * read progress for; a branch is a UUID created rarely, so this stays small for the footer's one
   * repeatedly re-read path.
   * ponytail: unbounded map, add an eviction policy if a caller ever reads progress for many distinct
   * paths of one long-lived process.
   *
   * Ticket 72: keyed on the head no longer — every sent message creates a new Turn, so a head-keyed
   * cache missed on every message (measured 430 ms warm, 918 ms cold on an S3-sized path). A forward
   * head move brings Raw only and the path only grows (69's own premise: nothing it selects for
   * facts/knowledge shrinks), so a cached entry is still exact as long as the requested head descends
   * from the last checked head. Check only the new suffix and advance that head on every hit;
   * same-head calls never walk ancestors. A branch switch already keys to a different cache
   * entry; a head moved back or a non-append path rewrite is caught by the signal (`source_paths`'s and
   * `session_lineage_cursors`'s own `version` bumps) or, for a same-head backward-then-same case, by
   * the ancestry check itself, since a newer cached head is never an ancestor of an older requested one. */
  const progressCache = new Map<string, { signal: string; headTurnId: number; facts: number; knowledge: number; changedKnowledge: number }>();
  /** Footer progress for one selected path. `knowledge` is the current visible set;
   * `changedKnowledge` counts the Noter operations since the last Dreamer run (146 §1.4): the footer's "Noter ops since the last D", exact (no trigger beside it to stop at). */
  const progress = (sessionId: number, branch = "main", headTurnId?: number | null) => {
    session(sessionId);
    const path = store.knowledgePath(sessionId, branch, headTurnId);
    const key = `${sessionId}:${branch}`;
    const signal = store.progressSignal(sessionId);
    const cached = progressCache.get(key);
    const reusable = cached && cached.signal === signal && path.headTurnId != null &&
      store.pathSnapshot(path).turns.has(cached.headTurnId);
    // Both hit and miss share Noting's queue. A prepared fact snapshot must not cause a second,
    // independent scan of pending membership after every commit. No head means no imported Turn.
    let snapshot: PathSnapshot | undefined;
    const prepare = () => snapshot ??= store.pathSnapshot(path);
    const entries = path.headTurnId == null ? 0 : store.pendingEntryState(sessionId, branch, path.headTurnId,
      reusable ? undefined : prepare).length + store.knowledgePendingEntryIds(sessionId, branch, path.headTurnId).length;
    if (reusable) {
      cached.headTurnId = path.headTurnId!;
      return { entries, facts: cached.facts,
        knowledge: cached.knowledge, changedKnowledge: cached.changedKnowledge };
    }
    snapshot = prepare();
    const facts = store.listBranchFacts(sessionId, branch, path.headTurnId, snapshot);
    const knowledge = store.currentKnowledge(path, {}, snapshot);
    const changedKnowledge = store.noterOperations(path);
    if (path.headTurnId != null) progressCache.set(key, { signal, headTurnId: path.headTurnId, facts: facts.length, knowledge: knowledge.length, changedKnowledge });
    else progressCache.delete(key);
    return { entries, facts: facts.length, knowledge: knowledge.length, changedKnowledge };
  };
  return {
    spend,
    spendSince,
    progress,
    trace,
    // 21b: a read organization projection over the same selected set the automatic material uses; it
    // changes no injection order, no scope and no applicability.
    topicGroups: (sessionId: number, headTurnId?: number | null, branch?: string): TopicGroups => {
      const groups = new Map<string, { knowledgeId: number; commit: number }[]>();
      const unclassified: { knowledgeId: number; commit: number }[] = [];
      for (const { knowledge, revision } of store.listVisibleKnowledge(sessionId, session(sessionId).projectId, headTurnId, branch)) {
        const reference = { knowledgeId: knowledge.id, commit: revision.id };
        if (!revision.topics.length) unclassified.push(reference);
        for (const topic of revision.topics) groups.set(topic, [...(groups.get(topic) ?? []), reference]);
      }
      return { topics: [...groups.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(topic => ({ topic, commits: groups.get(topic)! })), unclassified };
    },
    // Every enabled ordinary prompt uses this evidence-aware Knowledge-only publication predicate.
    // Worker completion alone never delivers material into the foreground.
    injection,
    inject: (target: number | { projectId: number } | KnowledgePath, toolNames?: ToolNames): string => injection(target, undefined, false, toolNames).text,
    // One allocator: required state notices/facts/Raw first, then optional current knowledge and
    // Raw-first historical refill in each own base remainder. Scheduling pairs never affect it.
    // No worker, processing mark or coverage persistence is performed by this synchronous render.
    // 165: Raw overflow precedes unscored bodies in the body pool. Knowledge titles precede
    // the balanced user/fact-title fill in the pointer pool. Bases remain independent. Nothing
    // is required any more: every window truncates — newest kept, oldest omitted with a receipt —
    // rather than escalating to a native delegation. Omitted material stays pending in the store.
    compact: (sessionId: number, branch = "main", headTurnId?: number, retainedView: readonly string[] | VisibleView = [],
      transport = false, options: { endpointEntryId?: number; processedRawRefill?: boolean; knowledge?: boolean;
        /** Internal: the Noter's fresh material shows each body's token count against the worker cap. */
        showKnowledgeSize?: boolean;
        /** Internal: Noter supplies the same guide as task instructions, outside its material windows. */
        readingGuide?: boolean;
        /** Internal: views from this synchronous freeze under this exact profile/extractor. */
        renderedEntries?: ReadonlyMap<number, EntryView>;
        /** Internal: hydrated user sources and their separate excerpt profile, owned by one Noter freeze. */
        historicalUserEntries?: Map<number, { entry: SourceEntry; view?: EntryView }>;
        /** Internal: authoritative ordered metadata and processing state of this same freeze. */
        preparedSources?: { path: KnowledgePath; entries: readonly SourceEntryMeta[]; pending: readonly SourceEntryMeta[] }; toolNames?: ToolNames; runningTasks?: readonly RunningTask[] } = {}): CompactResult => {
      if (!store.enabled(sessionId)) return { text: "", supplied: { entries: [], factIds: [], knowledgeCommitIds: [] } };
      const path = store.knowledgePath(sessionId, branch, headTurnId);
      const prepared = options.preparedSources;
      if (prepared && (prepared.path.sessionId !== path.sessionId || prepared.path.branch !== path.branch))
        throw new Error("Prepared compact source path does not match its reader");
      const snapshot = store.pathSnapshot(path, options.endpointEntryId, prepared?.entries); // exact membership for this endpoint
      const head = headTurnId ?? store.listTurns(sessionId).at(-1)?.id;
      const sourceSnapshot = head === path.headTurnId ? snapshot : head === undefined ? undefined
        : store.pathSnapshot({ sessionId, branch, headTurnId: head });
      const onEndpoint = (entry: SourceEntryMeta) => snapshot.turns.has(entry.turnId)
        && (!snapshot.entries || snapshot.entries.ids.has(entry.id));
      const sourced = prepared ? prepared.entries.filter(onEndpoint)
        : head === undefined ? [] : store.sourcePath(sessionId, branch, head, sourceSnapshot);
      const pending = prepared ? prepared.pending.filter(onEndpoint)
        : head === undefined ? [] : store.pendingEntries(sessionId, branch, head, sourceSnapshot);
      const pendingIds = new Set(pending.map(e => e.id));
      const knowledge = options.knowledge === false ? [] : store.currentKnowledge(path, {}, snapshot);
      const visible = Array.isArray(retainedView) ? noVisibility() : retainedView as VisibleView;
      const retained = new Set(Array.isArray(retainedView) ? retainedView : visible.raw.keys());
      // Ticket 80 item 3: one batched `fact_sources` read for the whole session's facts, not one per fact.
      const sessionFacts = store.listSessionFacts(sessionId);
      const boundEntries = store.factSourceEntries(sessionFacts.map(f => f.id));
      // listSessionFacts already establishes every candidate's owner, as listBranchFacts does.
      const owners = new Map(sessionFacts.map(fact => [fact.turnId, sessionId]));
      const applicable = sessionFacts.filter(f => store.factOnPath(f, path, snapshot, undefined, owners, boundEntries));
      const factTurns = store.factTurnTimes(applicable);
      const caps = { knowledge: store.knowledgeBase(), facts: config.compaction.factsTokens, raw: config.compaction.rawTokens };
      const temporaryCap = config.compaction.temporaryTokens, pointerCap = config.compaction.pointerTokens;
      const envelope = caps.knowledge + caps.facts + caps.raw + temporaryCap + pointerCap;
      if (!Number.isSafeInteger(envelope)) throw new Error("compact envelope must be a safe integer");
      // Every emitted component is charged inside the window that owns it, and a window that emits
      // nothing is charged nothing: the `<episodic>` tag once, with the first of Raw and facts that
      // has items; a title only with its items; each window's receipts with that window. The
      // `Receipts:` heading `finish` emits is charged to each window that has a receipt, which
      // over-counts safely (the same rule `budgetMaterial` applies).
      const factRelations = store.listFactRelationsOnPathOf(applicable.map(fact => fact.id), path, snapshot);
      const lines = (facts: Fact[]) => renderFactGroups(facts, f => factLine(f.id, factRelations.get(f.id) ?? []), factTurns);
      const opener = (title: string) => charge([xmlBlock("episodic", ""), title]);
      const receiptCharge = (receipts: string[]) => receipts.length ? charge(receipts) + charge(["Receipts:"]) : 0;
      const view = (entry: SourceEntry) => renderEntry(entry, config.render, resultText);

      // ---- 1. Status notices use the Knowledge base; body selection follows Raw's overflow claim. ----
      const guide = options.readingGuide === false ? "" : readingGuide(sessionId, options.toolNames ?? canonicalToolNames);
      const knowledgeEnvelope = caps.knowledge;
      const allNotes = options.knowledge === false ? [] : knowledgeStateNotes(store, knowledge, visible.knowledgeCommitIds, path, undefined, undefined, true)
        .sort((a, b) => b.receipt.fromCommit - a.receipt.fromCommit);
      const noteReceipt = (omitted: number) => omitted
        ? [`omitted ${omitted} older inherited knowledge status lines; knowledge base is full`] : [];
      const noteTextCost = (kept: number) => kept ? charge([KNOWLEDGE_STATUS_TITLE, ...allNotes.slice(0, kept).map(note => note.text)]) : 0;
      const noteCost = (kept: number) => noteTextCost(kept) + receiptCharge(noteReceipt(allNotes.length - kept));
      let noteKept = allNotes.length;
      while (noteKept > 0 && noteCost(noteKept) > knowledgeEnvelope) noteKept--;
      const notes = allNotes.slice(0, noteKept).map(note => note.text);
      // With nothing kept, a receipt that does not fit either leaves the notices window empty.
      const noteOmittedReceipt = noteCost(noteKept) <= knowledgeEnvelope ? noteReceipt(allNotes.length - noteKept) : [];
      const knowledgeNoticeCost = noteTextCost(noteKept) + receiptCharge(noteOmittedReceipt);
      const notice = sessionKnowledgeNotice(sessionId);
      // The count is part of the rendered line, so the budget below charges it like any other text.
      const line = options.showKnowledgeSize ? (value: KnowledgeWithRevision) => renderKnowledge({ ...value, staleReasons: store.knowledgeStaleReasons(value.revision.id) },
        `K${value.knowledge.id}#${store.versionTag(value.knowledge.id, value.revision.id)}`, true, store.writing) : knowledgeLine;
      const titleLine = (value: KnowledgeWithRevision) => renderKnowledgeTitle({ ...value, staleReasons: store.knowledgeStaleReasons(value.revision.id) },
        `K${value.knowledge.id}#${store.versionTag(value.knowledge.id, value.revision.id)}`, store.writing);

      // ---- 2. Raw second: the newest contiguous span. Pending entries borrow from temporary;
      // noted entries only fill the Raw base remainder. The walk never skips to an older entry. ----
      // Retained (visible elsewhere in the post-compaction context) excludes an already-noted entry
      // from optional refill; it never excludes a still-pending one (30 case 10) — pending membership
      // alone decides whether an entry must still be represented here.
      const candidates = sourced.filter(e => pendingIds.has(e.id) || (options.processedRawRefill !== false && !retained.has(e.nativeId)));
      interface RawStep { entry: SourceEntryMeta; content: string; receipts: string[]; fromAllowance: number }
      const rawSteps: RawStep[] = [];
      {
        let rawBaseUsed = charge([RAW_TITLE]), allowanceUsed = 0;
        for (let i = candidates.length - 1; i >= 0; i--) {
          // 79 item 2: hydrate newest-first, one Raw candidate at a time. The first non-fitting
          // entry must be rendered to price it, but this Raw walk hydrates no older candidate.
          const entry = candidates[i]!;
          let rendered: EntryView;
          try { rendered = options.renderedEntries?.get(entry.id) ?? view(store.getSourceEntry(entry.id)!); }
          catch (error) { if (/capacity/.test(String(error))) break; throw error; }
          const cost = tokens(rendered.content) + 1;
          const availableBase = Math.max(0, caps.raw - rawBaseUsed);
          if (pendingIds.has(entry.id)) {
            const availableAllowance = Math.max(0, temporaryCap - allowanceUsed);
            if (cost > availableBase + availableAllowance) break;
            const fromBase = Math.min(cost, availableBase);
            rawBaseUsed += fromBase; allowanceUsed += cost - fromBase;
            rawSteps.push({ entry, content: rendered.content, receipts: rendered.receipts, fromAllowance: cost - fromBase });
          } else {
            if (cost > availableBase) break;
            rawBaseUsed += cost;
            rawSteps.push({ entry, content: rendered.content, receipts: rendered.receipts, fromAllowance: 0 });
          }
        }
      }
      const rawReceipt = (kept: number) => candidates.length - kept
        ? [`[... ${candidates.length - kept} earlier entries omitted from the Raw window] ${expandList([...new Set(candidates.slice(0, candidates.length - kept).map(entry => `trace://raw/S${sessionId}/T${entry.turnId}`))])}`] : [];
      // Exactly what Raw adds: its wrapper/title only with entries, kept entry-view receipts,
      // and the omission receipt. Framing is part of the window, not free overflow.
      const rawWindowCost = (kept: number, receipt: string[]) => {
        const steps = rawSteps.slice(0, kept);
        return rawWindowTokens(steps.map(s => s.content), [...steps.flatMap(s => s.receipts), ...receipt]);
      };
      // Only unprocessed material borrows (73): framing and receipts may exceed the base by at
      // most the kept pending entries' cost, capped by temporary. Noted-only Raw fits its base.
      const rawLimit = (kept: number) => caps.raw + Math.min(temporaryCap,
        rawSteps.slice(0, kept).reduce((sum, s) => sum + (pendingIds.has(s.entry.id) ? tokens(s.content) + 1 : 0), 0));
      let rawKept = rawSteps.length;
      while (rawKept > 0 && rawWindowCost(rawKept, rawReceipt(rawKept)) > rawLimit(rawKept)) rawKept--;
      // With nothing kept, a receipt that cannot fit leaves the Raw window empty.
      const rawFinalReceipt = rawWindowCost(rawKept, rawReceipt(rawKept)) <= rawLimit(rawKept) ? rawReceipt(rawKept) : [];
      const rawCharged = rawWindowCost(rawKept, rawFinalReceipt);
      // Display the selected Raw entries in source order (30).
      const suppliedRaw = rawSteps.slice(0, rawKept).reverse();
      const rawOmitted = candidates.slice(0, candidates.length - suppliedRaw.length);
      // 79 item 4: exact omitted pending count only. Sizing the omitted backlog would hydrate it
      // all on every compaction, undoing the bounded walk above; fact rows need no Raw hydration.
      const rawOmittedPending = rawOmitted.filter(e => pendingIds.has(e.id));
      const rawBorrowed = Math.max(0, rawCharged - caps.raw);

      // Scored base bodies, unscored overflow bodies, then independently budgeted pointers (165).
      const active = selectKnowledge(knowledge, { baseCap: Math.max(0, knowledgeEnvelope - knowledgeNoticeCost),
        temporaryCap: Math.max(0, temporaryCap - rawBorrowed), pointerCap, line, titleLine, recencyNotice: notice });
      const knowledgeUsed = knowledgeNoticeCost + active.baseCharge;

      // Full facts and their source coverage retain ticket 73's selection unchanged.
      const coverage = new Set([...sourced.filter(e => retained.has(e.nativeId)).map(e => e.id), ...suppliedRaw.map(s => s.entry.id)]);
      const factCandidates = applicable.filter(f => !visible.factIds.has(f.id));
      const coveredFactIds = store.factsCoveredByRaw(factCandidates, coverage);
      const eligibleFacts = factCandidates.filter(f => !coveredFactIds.has(f.id));
      const omission = (rest: Fact[]) => rest.length ? [`omitted ${rest.length} older facts; expand: ${expandList(rest.map(f => `trace://F${f.id}`))}`] : [];
      // Exactly what facts add: their title, the wrapper only if Raw has not opened it, and
      // their omission receipt. Full-fact selection stays independent of temporary context.
      const factsWindowCost = (kept: number, receipt: string[]) => (kept
        ? (rawKept ? charge([FACTS_TITLE]) : opener(FACTS_TITLE)) + charge(lines(eligibleFacts.slice(0, kept))) : 0) + receiptCharge(receipt);
      const factsTotalCost = (kept: number) => factsWindowCost(kept, omission(eligibleFacts.slice(kept)));
      let factsKept = 0;
      while (factsKept < eligibleFacts.length && factsWindowCost(factsKept + 1, []) <= caps.facts) factsKept++;
      while (factsKept > 0 && factsTotalCost(factsKept) > caps.facts) factsKept--;
      const finalFacts = eligibleFacts.slice(0, factsKept);
      // With nothing kept, a receipt that cannot fit leaves the full-fact window empty.
      let finalFactReceipts = factsTotalCost(factsKept) <= caps.facts ? omission(eligibleFacts.slice(factsKept)) : [];

      // The anchor's ancestry is newest first, including turns without displayed Raw.
      const ancestry = [...snapshot.turns];
      const userTurns = new Set(ancestry.slice(0, config.compaction.userTurns));
      const titleTurns = new Set(ancestry.slice(0, config.compaction.titleTurns));
      const displayed = new Set(suppliedRaw.map(step => step.entry.id));
      const prefixes = /^(?:<task-notification|<system-reminder|<command-|Caveat|\[Request interrupted|Another Claude session|<local-command)/u;
      const piUserPrefix = store.getSession(sessionId)!.host.startsWith("pi:") ? /^(?:<skill|This session is being continued)/u : undefined;
      const userCandidates = sourced.filter(meta => userTurns.has(meta.turnId) && !displayed.has(meta.id)
        && (!meta.addresses.length || meta.addresses.some(address => /#user$/.test(address))))
        .map(meta => {
          const cached = options.historicalUserEntries?.get(meta.id);
          if (cached) return cached;
          const value: { entry: SourceEntry; view?: EntryView } = { entry: store.getSourceEntry(meta.id)! };
          options.historicalUserEntries?.set(meta.id, value);
          return value;
        })
        .filter(({ entry }) => entry.role === "user" && (humanUser?.(entry) ?? (!prefixes.test(entry.text) && !piUserPrefix?.test(entry.text)))).reverse();
      const earlierUsers: { id: number; view: string }[] = [];
      // The walk selects by turn rank, not as a prefix of userCandidates: omit what was not selected.
      const userReceipts = (): string[] => {
        const shown = new Set(earlierUsers.map(entry => entry.id));
        const rest = userCandidates.filter(({ entry }) => !shown.has(entry.id));
        return rest.length ? [`omitted ${rest.length} earlier user messages; expand: ${expandList(rest.map(({ entry }) => `trace://raw/S${sessionId}/T${entry.turnId}#E${entry.entryOrdinal}`))}`] : [];
      };
      const userCost = (receipts: string[]) => (earlierUsers.length
        ? (rawKept || factsKept ? charge([EARLIER_USERS_TITLE]) : opener(EARLIER_USERS_TITLE)) + charge(earlierUsers.map(entry => entry.view)) : 0) + receiptCharge(receipts);
      const afterRaw = pointerCap - active.pointerCharge;

      const titleCandidates = eligibleFacts.slice(factsKept).filter(fact => titleTurns.has(fact.turnId) && fact.title);
      const selectedTitles: Fact[] = [];
      const titleLines = () => factGroupLayout(selectedTitles, factTurns).map(({ fact, header }) => {
        const value = factTurns.get(fact.turnId)!;
        const time = typeof value === "string" ? value : value.time;
        return `${header ? `[T${fact.turnId}] ${time}\n` : ""}[F${fact.id}] ${fact.title}`;
      });
      const titleCost = () => selectedTitles.length
        ? (rawKept || factsKept || earlierUsers.length ? charge([FACT_TITLES_TITLE]) : opener(FACT_TITLES_TITLE)) + charge(titleLines()) : 0;
      // 140: the user's words and the titles fill together, one turn at a time, newest turn first:
      // that turn's user entries, then its titles. A kind past its own reach drops out of the walk
      // and the other continues. The first item that does not fit stops both kinds.
      const depth = new Map(ancestry.map((turnId, index) => [turnId, index]));
      const walk: ({ user: (typeof userCandidates)[number]; rank: number } | { fact: Fact; rank: number })[] = [
        ...userCandidates.map(user => ({ user, rank: depth.get(user.entry.turnId)! * 2 })),
        ...titleCandidates.map(fact => ({ fact, rank: depth.get(fact.turnId)! * 2 + 1 })),
      ].sort((x, y) => x.rank - y.rank);
      for (const item of walk) {
        if ("user" in item) {
          const rendered = item.user.view ??= renderEntry(item.user.entry, { ...config.render, entryTokens: config.compaction.userEntryTokens }, resultText);
          earlierUsers.push({ id: item.user.entry.id, view: rendered.content });
        } else selectedTitles.push(item.fact);
        const ids = new Set(selectedTitles.map(value => value.id));
        const receipt = omission(eligibleFacts.slice(factsKept).filter(value => !ids.has(value.id)));
        // Title fitting reserves room for the shared fact omission receipt, but facts charge it once.
        if (userCost(userReceipts()) + titleCost() + (selectedTitles.length ? receiptCharge(receipt) : 0) > afterRaw) {
          if ("user" in item) earlierUsers.pop(); else selectedTitles.pop();
          break;
        }
      }
      const finalUserReceipts = userCost(userReceipts()) <= afterRaw ? userReceipts() : [];
      const usersCharged = userCost(finalUserReceipts);
      earlierUsers.reverse();
      const titleIds = new Set(selectedTitles.map(fact => fact.id));
      if (selectedTitles.length) finalFactReceipts = omission(eligibleFacts.slice(factsKept).filter(fact => !titleIds.has(fact.id)));
      // Title fitting reserves room for the shared fact omission receipt, but facts charge it once.
      const titlesCharged = titleCost();
      const temporaryCharged = rawBorrowed + active.temporaryCharge;
      const pointerCharged = active.pointerCharge + usersCharged + titlesCharged;

      const truncated: TruncationReceipt = {};
      if (rawOmittedPending.length) truncated.raw = { entries: rawOmittedPending.length };

      const material = { knowledge: active.groups, facts: lines(finalFacts), factTitles: titleLines(), earlierUsers,
        ...(!prepared && options.runningTasks?.length ? { runningTasks: options.runningTasks } : {}),
        entries: suppliedRaw.map(s => ({ id: s.entry.id, view: s.content })),
        receipts: [...suppliedRaw.flatMap(s => s.receipts), ...rawFinalReceipt, ...finalFactReceipts, ...finalUserReceipts, ...active.receipts, ...noteOmittedReceipt],
        knowledgeNotice: notice, readingGuide: guide };
      return { ...measuredMemory(compactText(material, RAW_TITLE, notes), material), material,
        // Transport may repeat K framing, but cannot borrow bases reserved for facts/Raw.
        knowledgeAllowance: knowledgeEnvelope, temporaryAllowance: temporaryCap, pointerAllowance: pointerCap,
        ...(transport ? { transportItems: [
          ...active.ranked.map(({ value, form, allowance, rank }) => ({ kind: "knowledge" as const,
            text: form === "title" ? titleLine(value) : line(value), category: knowledgeCategoryGroup(value.revision.category), commitId: value.revision.id,
            address: `K${value.knowledge.id}@v${store.versionOrdinal(value.knowledge.id, value.revision.id)}`, form, allowance, rank })),
          ...allNotes.slice(0, noteKept).map(note => ({ kind: "state" as const, text: note.text, receipt: note.receipt,
            address: `K${store.knowledgeRevision(note.receipt.fromCommit)!.knowledgeId}` })),
          ...factGroupLayout(finalFacts, factTurns).map(({ fact, header }) => ({ kind: "fact" as const,
            text: header + factLine(fact.id, factRelations.get(fact.id) ?? []), factId: fact.id,
            pending: false })),
          ...suppliedRaw.map(step => ({ kind: "raw" as const, text: step.content, entryId: step.entry.id,
            address: `T${step.entry.turnId}#E${step.entry.entryOrdinal}`, pending: pendingIds.has(step.entry.id),
            ...(step.fromAllowance ? { allowance: "temporary" as const, charge: step.fromAllowance } : {}) })),
          ...material.receipts.map(text => ({ kind: "receipt" as const, text,
            knowledge: active.receipts.includes(text) || noteOmittedReceipt.includes(text),
            ...(active.receipts.includes(text) ? { allowance: active.receiptAllowance } : {}) })),
        ] } : {}),
        // 29a "Renderers return what they kept": exactly the identities this replacement carries.
        // What a budget left out is absent here (28a item 7) and stays pending in the store.
        // Earlier-user excerpts use a smaller profile and are not Raw coverage.
        supplied: { entries: suppliedRaw.map(s => ({ id: s.entry.id, nativeId: s.entry.nativeId, view: "bounded" as const })),
          factIds: finalFacts.map(f => f.id), knowledgeCommitIds: active.bodyCommits,
          ...(active.titleCommits.length ? { knowledgeTitleCommitIds: active.titleCommits } : {}),
          // Each pool records its own charge for later foreground admissions.
          knowledgeTokens: active.baseGroups.length || notes.length || active.baseReceipts.length || noteOmittedReceipt.length
            ? tokens(injectionText({ knowledge: active.baseGroups, receipts: [...active.baseReceipts, ...noteOmittedReceipt], knowledgeNotice: notice }, notes)) : 0,
          temporaryTokens: temporaryCharged,
          pointerTokens: pointerCharged,
          ...(noteKept ? { knowledgeStates: allNotes.slice(0, noteKept).map(note => note.receipt) } : {}) },
        // The per-window accounting beside the text, for the acceptance probe; diagnostics only.
        charged: { knowledge: knowledgeUsed, facts: factsWindowCost(finalFacts.length, finalFactReceipts),
          raw: Math.min(rawCharged, caps.raw), temporary: temporaryCharged, pointer: pointerCharged, envelope },
        hasMaterialCandidates: Boolean(allNotes.length || knowledge.length || candidates.length || eligibleFacts.length),
        ...(Object.keys(truncated).length ? { truncated } : {}) };
    },
    branchSummary: (sessionId: number, branch: string, headTurnId: number, toolNames: ToolNames = canonicalToolNames): string => {
      if (!store.enabled(sessionId)) return "";
      // Carry is optional, unlike compact's required pending Raw. Consider the whole pending set,
      // not Noting's next batch, and keep a newest whole suffix under the shared view profile.
      // Charge the Raw title, separators and omission receipt too; even the newest entry may not fit.
      const title = "Pending raw:";
      const pending = store.pendingEntries(sessionId, branch, headTurnId);
      const raw: ReturnType<typeof renderEntry>[] = [];
      let omitted = pending.length, used = charge([title]);
      const receipt = () => omitted ? [`[... ${omitted} earlier pending entries omitted from the carry budget] ${expandList([...new Set(pending.slice(0, omitted).map(entry => `trace://raw/S${sessionId}/T${entry.turnId}`))])}`] : [];
      // A whole suffix is monotone: after the first entry that cannot fit, no earlier
      // entry can join it. Do not render the history that will only be receipted.
      for (let i = pending.length - 1; i >= 0; i--) {
        // 79 item 2: newest first, hydrated one candidate at a time, same bound as compact's Raw span.
        const view = renderEntry(store.getSourceEntry(pending[i]!.id)!, config.render, resultText);
        const cost = charge([view.content, ...view.receipts]);
        if (used + cost > config.render.episodicBlockTokens) break;
        omitted--; raw.push(view); used += cost;
      }
      // Defer the receipt until the suffix is known: a complete short history has
      // no receipt, which can itself cost more than its oldest entry.
      while (raw.length && used + charge(receipt()) > config.render.episodicBlockTokens) {
        const removed = raw.pop()!;
        used -= charge([removed.content, ...removed.receipts]); omitted++;
      }
      raw.reverse();
      if (used + charge(receipt()) > config.render.episodicBlockTokens)
        throw new Error(`Branch carry capacity: Raw framing and omission receipt exceed render.episodicBlockTokens (${config.render.episodicBlockTokens})`);
      const path = { sessionId, headTurnId, branch }, snapshot = store.pathSnapshot(path); // one membership for facts and commits alike
      const sessionFacts = store.listSessionFacts(sessionId);
      const boundEntries = store.factSourceEntries(sessionFacts.map(f => f.id));
      const facts = sessionFacts.filter(f => store.factOnPath(f, path, snapshot, undefined, undefined, boundEntries)).sort((a, b) => a.id - b.id);
      const factIds = new Set(facts.map(f => f.id));
      const revisions = store.listKnowledgeRevisions();
      const input = store.commitGraphInput(revisions).metadata;
      const applicableFacts = new Map<number, boolean>(), applicableCommits = new Map<number, boolean>();
      const commits = revisions.filter(r => store.commitApplies(r, path, snapshot, input, applicableFacts, applicableCommits) &&
        r.supports.some(id => factIds.has(id)))
        .map(revision => ({ knowledge: store.getKnowledge(revision.knowledgeId)!, revision }));
      const relations = store.listFactRelationsOnPathOf(facts.map(fact => fact.id), path, snapshot);
      const content = ["this is knowledge from another branch; it must not be written as facts; the Noter's facts come only from the current branch's conversation, never from messages this plugin injected.",
        "Facts:", ...factGroups(facts, relations), "Commits (by evidence):", ...commits.map((c) => knowledgeLine(c)),
        title, ...raw.map(r => r.content), ...raw.flatMap(r => r.receipts), ...receipt()].join("\n");
      return xmlBlock("branch_carry", content); // Tags delimit; content stays byte-identical to shared trace lines.
    },
    search: searchFacade(store),
    status: (sessionId: number, branch?: string, headTurnId?: number | null): string => {
      const s = session(sessionId), runs = store.listRuns(sessionId);
      const totals = spend(sessionId);
      const counts = progress(sessionId, branch, headTurnId);
      return [`Session: S${sessionId}`, `Enrollment: ${store.enabled(sessionId) ? "Enabled" : "Disabled"} (${store.enrollment(sessionId).choice === null ? "default" : "explicit choice"})`, `Project: ${store.getProject(s.projectId)!.name} (${store.projectDeclaration(sessionId)})`,
        ...(!store.enabled(sessionId) ? store.taskFailures(sessionId).filter(task => task.count >= 3).map(task =>
          `Automatic off: ${task.phase}, ${task.pool ? `pool ${task.pool}` : `backlog head ${task.head}`}, ${task.count} failures; last R${task.lastRunId}: ${task.lastReason}. Use /trace on to resume.`) : []),
        `Spend: ${totals.runs.noting} noting, ${totals.runs.consolidation} consolidation, ${totals.runs.dreaming} dreaming, ${totals.runs.manual} manual runs; ${totals.input + totals.output + totals.cacheRead + totals.cacheWrite} tokens; ${formatCost(totals.cost, totals.unknown)}`,
        // 24a: the footer's own counts, spelled out. They describe imported evidence only: native
        // history of a disabled interval is imported when the session is enabled again, so a zero
        // here is not proof that every available native message has been processed.
        `Pending: ${counts.entries} imported ${counts.entries === 1 ? "entry" : "entries"} to note; ${counts.facts} applicable facts; ${counts.knowledge} current knowledge (imported evidence on this branch)`,
        `Facts: ${store.listSessionFacts(sessionId).length} session; ${store.listProjectFacts(s.projectId).length} project`,
        `Knowledge: ${counts.knowledge} visible active`,
        ...(["noting", "consolidation", "dreaming"] as const).flatMap((kind) => {
          const r = [...runs].reverse().find((r) => r.kind === kind);
          return kind === "consolidation" && !r ? [] : [`Last ${kind}: ${r ? `run ${r.id} ${r.outcome} ${r.createdAt} branch=${r.branch}` : "none"}`];
        })].join("\n");
    },
  };
}
