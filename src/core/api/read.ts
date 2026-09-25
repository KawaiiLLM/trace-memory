import { randomUUID } from "node:crypto";
import { knowledgeReadSelection, KNOWLEDGE_REPRESENTATIVE_RECEIPT } from "./knowledge-read.ts";
import { traceTargets } from "../model/address.ts";
import type { TraceMemoryConfig } from "./index.ts";
import type { Store, KnowledgeWithRevision, KnowledgePath, SourceEntry, PathSnapshot } from "../store/index.ts";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, knowledgeCategoryGroup, type Fact, type FactRelation, type KnowledgeCategory, type KnowledgeRevision, type KnowledgeScope } from "../model/index.ts";
import { budgetKnowledge, renderKnowledgeOmissions, charge, expandList, tokens, finish, listingLine, renderKnowledge, renderFact, renderFactPreview, renderKnowledgePreview, renderKnowledgeTrace, renderFactGroups, factGroupLayout, renderEntry, rawResultText, xmlBlock, type EntryView, type ResultExtractor, type EntryProfile } from "../render/index.ts";
import { injectionText, compactText, measuredMemory, type MemoryComposition, type TransportItem, FACTS_TITLE, RAW_TITLE, KNOWLEDGE_STATUS_TITLE } from "../render/material.ts";
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
export interface ListingOptions { itemBudget?: number | null; toolCallBudget?: number | null; toolResultBudget?: number | null; pageBudget?: number | null; maxTokens?: number; /** Host transport ceiling over the final returned string, in JavaScript UTF-16 code units. Not model-facing. */ maxChars?: number; cap?: number; cursor?: string; tool?: number; full?: boolean; versions?: ReadVersions; category?: KnowledgeCategory; scope?: KnowledgeScope; fields?: readonly ReadField[]; sessionId?: number; headTurnId?: number | null; branch?: string; entryIds?: readonly number[]; profile?: EntryProfile }
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
  if (options.tool !== undefined && (!Number.isSafeInteger(options.tool) || options.tool < 1)) throw new Error("tool must be a positive ordinal");
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
/** Exact versions resolved by a named K read; bare reads replace that identity's prior bases. */
export interface KnowledgeRead { knowledgeId: number; commits: number[]; replace: boolean; complete?: boolean }
export interface TraceRead { text: string; completed: KnowledgeRead[] }
export type SearchScope = "facts" | "knowledge" | "all" | "raw";

/** 21b "Group projection": the topics of current visible knowledge, as references to the exact
 * commits they were read from. A commit with several labels is referenced by each of its groups,
 * and a commit with none stays available under `unclassified`; grouping never changes selection. */
export interface TopicGroups {
  topics: { topic: string; commits: { knowledgeId: number; commit: number }[] }[];
  unclassified: { knowledgeId: number; commit: number }[];
}

/** Ticket 73 "Shared allowance": what compact can produce for one frozen read snapshot. The one
 * outcome is the complete custom replacement the host hands to Pi — knowledge fills its base and
 * borrows the shared allowance first, then the newest contiguous Raw span (pending entries borrowing
 * what knowledge left, already-noted entries filling only the Raw base), then the newest facts before
 * that span (unconsolidated facts borrowing, consolidated only within the facts base). Compact never
 * falls back: material Noting or Consolidation has not yet processed is truncated — newest kept,
 * oldest omitted with a receipt — rather than escalated to a native delegation, and it stays pending
 * in the store either way. `native` remains only for a host-caught error unrelated to capacity (a
 * store error, an invalid path); core itself never constructs it.
 *
 * 29a "Renderers return what they kept": beside the replacement text, the identities it actually
 * carries — every supplied entry, pending and refilled alike, plus the facts and knowledge commits
 * that survived budgeting. What a budget dropped is absent here. A native delegation supplies
 * nothing, so it has no `supplied` at all. */
export type CompactResult = { text: string; supplied: SuppliedMaterial; transportItems?: TransportItem[]; composition?: MemoryComposition; charged?: ChargedWindows; truncated?: TruncationReceipt }
  | { native: true; reason: string };

/** 73 "Truncation is announced in the foreground": whenever compact omits unprocessed material —
 * pending Raw entries or unconsolidated facts — the counts and tokens omitted per kind, so a host can
 * warn its user. Absent when nothing unprocessed was omitted. */
/** 79 item 4 (ruled): Raw carries no token figure -- an exact count only, since rendering every
 * omitted entry to size it reads the whole omitted backlog on every compaction. Fact rows are
 * small, so facts keep both a count and a token figure. */
export interface TruncationReceipt { raw?: { entries: number }; facts?: { count: number; tokens: number } }

/** 28a item 6: what one custom replacement charged, window by window, beside the text it produced.
 * Diagnostics — nothing reads this to decide the outcome. `envelope` is the sum of the three bases
 * and the shared allowance (73: a fixed configuration value), the ceiling the three charges together
 * may never exceed. Nothing is required any more (73): every window is optional and truncates. */
export interface ChargedWindows { knowledge: number; facts: number; raw: number; envelope: number }
/** Foreground Knowledge delivery and the exact body/state identities its carrier may persist. */
export interface Injection { text: string; knowledgeCommitIds: number[]; knowledgeStates?: KnowledgeStateReceipt[]; transportItems?: TransportItem[]; composition?: MemoryComposition }

/** 22c "complete snapshot": one search hit whose formatting the query deferred to a later page.
 * Fact relations and Raw entry membership are mutable; the commit records, path and labels selected
 * by a knowledge query are already frozen by that query. */
interface FrozenHit { address: string; relations?: FactRelation[]; entryIds?: number[]; profile?: EntryProfile; /** 59: the batched-search query this hit answers, echoed on its line. */ query?: string }
/** 59c: a batched-search query with no hit; its line trails the hits and is paged like them. */
type Miss = { miss: string };

/** One component of a `trace` comma list, in request order: either an interval's immutable fact
 * identity with frozen relations, or a named component's renderer over frozen database values.
 * Both render only after the snapshot transaction exits. */
type TraceUnit = { fact: number; relations: FactRelation[]; header?: string } | { render: () => string };

/** Parent 29 "Version-aware knowledge" (29b): one line per commit the reader's context already holds
 * that is not among the current applicable commits here — superseded, archived or merged away. The
 * block beside these lines carries only what is current, so without them stale visible text would
 * read as current knowledge. Ticket 31 made this shared: the Consolidator's material and the main
 * agent's knowledge block are one selection, and neither may explain a stale commit differently.
 * The full revision read happens only when there is a stale commit to explain. */
export interface KnowledgeStateNote { receipt: KnowledgeStateReceipt; text: string; revisions: KnowledgeRevision[] }

const knowledgeStateText = (from: KnowledgeRevision, successors: readonly KnowledgeRevision[]): string => {
  const label = `K${from.knowledgeId}@${from.id} is `;
  if (successors.length > 1) return label + `split into ${successors.map(r => `K${r.knowledgeId}@${r.id}`).join(" and ")}`;
  const successor = successors[0]!;
  return label + (successor.op === "archive" ? "archived"
    : successor.op === "merge" || successor.knowledgeId !== from.knowledgeId ? `merged into K${successor.knowledgeId}@${successor.id}`
    : `superseded by K${successor.knowledgeId}@${successor.id}`);
};

/** Necessary state changes for exact bodies already visible on this path. The receipt is deliberately
 * separate from body visibility: naming a survivor or split child grants no read handle or body. */
export function knowledgeStateNotes(store: Store, current: readonly KnowledgeWithRevision[], visible: Iterable<number>,
  path: KnowledgePath | null, projectId?: number, prepared?: ReturnType<Store["commitGraph"]>): KnowledgeStateNote[] {
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
    const resolvedIdentity = graph.resolved.filter(candidate => candidate.knowledgeId === revision.knowledgeId);
    const applicableIdentity = graph.revisions.filter(candidate => candidate.knowledgeId === revision.knowledgeId
      && graph.applicable.has(candidate.id));
    if (!graph.applicable.has(id)) {
      const targets = shown ? [shown] : resolvedIdentity;
      return [{ receipt: { fromCommit: id, toCommits: targets.length ? targets.map(target => target.id) : [id] },
        revisions: targets, text: targets.length || applicableIdentity.length
          ? `K${revision.knowledgeId}@${id} no longer applies`
          : `K${revision.knowledgeId} no longer applies` }];
    }
    const descendants = graph.descendants(id);
    // Resolution precedes visibility. A hidden successor still invalidates a retained older body;
    // the notice names only its immutable address and never renders its body. Competing siblings
    // are not descendants, so the globally selected revision for this identity is the fallback.
    const descendantsSelected = graph.resolved.filter(candidate => candidate.id !== id && descendants.has(candidate.id));
    const successors = descendantsSelected.length ? descendantsSelected
      : resolvedIdentity.filter(candidate => candidate.id !== id);
    const directBranches = graph.revisions.filter(candidate => candidate.parentId === id);
    if (shown && shown.id !== id && (directBranches.length > 1 || !descendants.has(shown.id)))
      return [{ receipt: { fromCommit: id, toCommits: [shown.id] }, revisions: [shown],
        text: `K${revision.knowledgeId}@${id} is shown as K${shown.knowledgeId}@${shown.id}` }];
    if (!successors.length) return [];
    const split = graph.revisions.some(r => r.op === "split" && r.parentId === id && graph.applicable.has(r.id));
    if (split) return [{ receipt: { fromCommit: id, toCommits: successors.map(r => r.id) }, revisions: successors,
      text: knowledgeStateText(revision, successors) }];
    return successors.map(successor => ({ receipt: { fromCommit: id, toCommits: [successor.id] }, revisions: [successor],
      text: knowledgeStateText(revision, [successor]) }));
  });
}

/** Compatibility projection used by Consolidation and explicit renderer tests. */
export function knowledgeStatusNotes(store: Store, current: readonly KnowledgeWithRevision[], visible: Iterable<number>,
  path: KnowledgePath | null, projectId?: number): string[] {
  return knowledgeStateNotes(store, current, visible, path, projectId).map(note =>
    note.text.replace(/(superseded by K\d+@\d+)$/, "$1 above"));
}

export function readFacade(store: Store, config: TraceMemoryConfig, prepare: (address: string, options?: ListingOptions, reads?: KnowledgeRead[]) => (() => string),
  resultText: ResultExtractor = rawResultText) {
  const expand = (address: string, options?: ListingOptions) => prepare(address, options)();
  // 22c: what a listing still owes its caller is kept as hit identities plus the formatter that turns
  // exactly one page of them into lines. The formatter carries its query's own snapshot, so a page
  // asked for later prints the labels that query established, and nothing but values is held between
  // pages — no open transaction, no reserved connection.
  interface Continuation { items: readonly unknown[]; format: (items: readonly unknown[]) => string[];
    /** 22c "complete snapshot": run once, on the hits this query defers, to freeze the mutable state
     * their lines will read. The pages formatted at query time need nothing frozen, so the whole
     * hit set is never formatted and no transaction is held; the deferred hits carry their own. */
    capture?: (deferred: readonly unknown[]) => readonly unknown[];
    /** 59c: a batched search's per-query cap; its cursor may repeat it, while the line cap stays the default. */
    queryCap?: number }
  /** A query's remainder: the frozen hit set of that one query, shared by every page it still owes,
   * plus this cursor's own position in it. `pending` holds the lines of a hit whose formatting
   * crossed the page edge — `cap` counts output lines. Every read freezes the effective page aliases,
   * line cap, fields, filters and configured content profile; an oversized line leaves its unsent
   * suffix in the same queue, without a second fragment cache.
   * `fragmented` prevents re-estimating a giant line's whole suffix on each continuation.
   * `reads` carries only named trace-origin K versions; search leaves it empty. Completion belongs
   * to the whole requested expression, not a rendered child or an unconsumed/evicted remainder. */
  type FrozenListing = {
    itemBudget: number | null; toolCallBudget: number | null; toolResultBudget: number | null;
    tool?: number; versions?: ReadVersions; category?: KnowledgeCategory;
    scope?: KnowledgeScope; fields?: readonly ReadField[]; queryCap?: number;
  };
  type Remainder = Continuation & { offset: number; pending: readonly string[]; footer: string; cap: number; owner: string; maxTokens?: number; maxChars?: number; reads: KnowledgeRead[]; origin: "trace" | "search"; fragmented: boolean; frozen: FrozenListing };
  // A model asks for page one and usually never asks for page two, so a continuation is a cache
  // entry, not an obligation: the least recently used one is dropped once this many are outstanding,
  // and the reader meets the "unknown or expired cursor" error that an unknown cursor always met.
  // A count bound needs no clock and no timer; add an age bound only if a single query's remainder
  // ever becomes large enough that sixteen of them matter.
  const CURSORS = 16;
  const cursors = new Map<string, Remainder>();
  const page = (source: string[] | Continuation, options: ListingOptions = {}, footer = "", reads: KnowledgeRead[] = [], origin: "trace" | "search" = "trace"): TraceRead => {
    const owner = options.sessionId === undefined ? "unbound" : `${options.sessionId}:${store.getSession(options.sessionId)?.projectId}`;
    const saved = options.cursor ? cursors.get(options.cursor) : undefined;
    if (options.cursor && (!saved || saved.owner !== owner)) throw new Error("unknown or expired cursor");
    if (saved?.origin === "trace" && origin === "search") throw new Error("search cannot continue a trace cursor; use trace");
    const defaults = { itemBudget: config.render.entryTokens, toolCallBudget: config.render.toolInputTokens,
      toolResultBudget: config.render.toolResultTokens };
    const content = (key: keyof typeof defaults): number | null => options[key] !== undefined ? options[key]!
      : options.full === true ? null : saved ? saved.frozen[key] : defaults[key];
    const frozen: FrozenListing = {
      itemBudget: content("itemBudget"), toolCallBudget: content("toolCallBudget"), toolResultBudget: content("toolResultBudget"),
      tool: options.tool ?? saved?.frozen.tool,
      versions: options.versions ?? saved?.frozen.versions, category: options.category ?? saved?.frozen.category,
      scope: options.scope ?? saved?.frozen.scope, fields: options.fields ?? saved?.frozen.fields,
      queryCap: saved ? saved.frozen.queryCap : Array.isArray(source) ? undefined : source.queryCap,
    };
    for (const key of ["itemBudget", "toolCallBudget", "toolResultBudget", "tool", "versions", "category", "scope", "fields"] as const) {
      const same = key === "fields" ? JSON.stringify(frozen.fields) === JSON.stringify(saved?.frozen.fields)
        : frozen[key] === saved?.frozen[key];
      if (saved && !same) throw new Error(`cursor ${key} is frozen; omit it or use the original value`);
    }
    const requested = options.cap ?? saved?.frozen.queryCap ?? saved?.cap ?? 100;
    if (!Number.isSafeInteger(requested) || requested < 1) throw new Error("listing cap must be a positive integer");
    if (saved && requested !== (saved.frozen.queryCap ?? saved.cap)) throw new Error("cursor cap is frozen; omit it or use the original value");
    const cap = saved?.cap ?? requested;
    const { items, format, capture } = saved ?? (Array.isArray(source)
      ? { items: source, format: (lines: readonly unknown[]) => lines as string[], capture: undefined } : source);
    if (saved) { footer = saved.footer; reads = saved.reads; }
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
      if (!pending.length) pending.push(...format([items[at++]]));
      if (!pending.length) continue;
      const line = pending[0]!;
      const more = pending.length > 1 || at < items.length;
      // The estimator is not monotone (an ASCII suffix can reclassify an emoji run).
      // Price each intact line once before probing; never repeat this full scan on its fragments.
      if (!fragmented && fits([...lines, line], more)) { lines.push(pending.shift()!); continue; }
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
      if (high === line.length && fits([line], more)) { lines.push(pending.shift()!); fragmented = false; continue; }
      // Keep the suffix in the SAME pending queue, at code-point boundaries. Escaped text is
      // transported verbatim: fragments must be concatenated before interpreting JSON escapes.
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits([prefix(mid)], true, true)) low = mid; else high = mid - 1;
      }
      const kept = prefix(low);
      if (!kept || !fits([kept], true, true)) throw new Error(maxChars === undefined
        ? "listing maxTokens is too small for this hit and pagination hints" : "listing limits are too small for this hit and pagination hints");
      lines.push(kept); pending[0] = line.slice(kept.length); fragment = true; fragmented = true;
      break;
    }
    const more = pending.length > 0 || at < items.length;
    const result = output(lines, more, fragment);
    if (violations(result)) throw new Error(maxChars === undefined
      ? "listing maxTokens is too small for pagination hints" : "listing limits are too small for pagination hints");
    // Snapshot and validate first: a rejected request must leave the input cursor usable.
    const remainder = more ? saved ? { ...saved, offset: at, pending, fragmented }
      : capture ? { items: capture(items.slice(at)), offset: 0, pending, format, footer, cap, owner, maxTokens, maxChars, reads, origin, fragmented, frozen }
      : { items, offset: at, pending, format, footer, cap, owner, maxTokens, maxChars, reads, origin, fragmented, frozen } : undefined;
    if (options.cursor) cursors.delete(options.cursor);
    if (remainder) {
      cursors.set(cursor, remainder);
      for (const oldest of cursors.keys()) { if (cursors.size <= CURSORS) break; cursors.delete(oldest); }
    }
    return { text: result, completed: more ? [] : reads.filter(read => read.complete !== false) };
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
  const knowledgeLine = (value: KnowledgeWithRevision) => renderKnowledge(value);
  // The knowledge part of the shared material contract (20a): the applicable commits at one node,
  // under the existing scope and commit-graph rules. Its block layout lives in core/render/material.ts.
  const applicable = (projectId: number, sessionId = 0, headTurnId?: number | null, branch?: string) =>
    store.listVisibleKnowledge(sessionId, projectId, headTurnId, branch);
  /** Ticket 34c: one evidence-aware Knowledge-only predicate at every ordinary foreground prompt.
   * One path snapshot and one graph resolve applicability, visible historical bodies, current exact
   * results and state changes. Exact Fact bodies or proven complete source-entry bindings may suppress
   * a nonempty current support list; empty and partial evidence never do. */
  const injection = (target: number | { projectId: number } | KnowledgePath, visible: VisibleView = noVisibility(),
    transport = false): Injection => {
    const empty = (): Injection => ({ text: "", knowledgeCommitIds: [] });
    const budgets = store.knowledgeBudgets();
    const knowledgeCap = budgets.injection + config.compaction.sharedAllowanceTokens;
    if (!Number.isSafeInteger(knowledgeCap)) throw new Error("derived foreground Knowledge capacity must be a safe integer");
    const id = typeof target === "number" ? target : "sessionId" in target ? target.sessionId : undefined;
    if (id !== undefined && !store.enabled(id)) return empty();
    const projectId = id === undefined ? (target as { projectId: number }).projectId : session(id).projectId;
    if (!store.getProject(projectId)) throw new Error(`project ${projectId} does not exist`);
    const path = id === undefined ? null : typeof target === "object" && "sessionId" in target
      ? target : store.knowledgePath(id);
    const snapshot = path ? store.pathSnapshot(path) : null;
    // Ticket 80 item 2: injection runs on every ordinary prompt, sharing this session's per-process
    // graph memo with the footer, eligibility and knowledgePools/duePools reads of the same request.
    const input = store.commitGraphInput(undefined, id);
    const graph = store.commitGraph(path, path ? undefined : projectId, snapshot ?? undefined, input);
    const records = store.knowledgeRecords(graph.revisions.map(revision => revision.knowledgeId));
    const values = (revisions: readonly KnowledgeRevision[]): KnowledgeWithRevision[] => revisions.map(revision => ({
      knowledge: records.get(revision.knowledgeId)!, revision,
    }));
    const current = values(graph.current.filter(revision => revision.op !== "archive"));
    const visibleBodies = values(graph.revisions.filter(revision => revision.op !== "archive"
      && graph.applicable.has(revision.id) && visible.knowledgeCommitIds.has(revision.id)));
    const allStates = knowledgeStateNotes(store, current, visible.knowledgeCommitIds, path, path ? undefined : projectId, graph);

    const rawIds = store.visibleSourceEntryIds(path, snapshot, visible.raw, visible.rawEntryIds ?? new Map());
    const supported = new Set([...current.filter(item => !visible.knowledgeCommitIds.has(item.revision.id)).map(item => item.revision),
      ...allStates.flatMap(state => state.revisions)].flatMap(revision => revision.supports));
    const facts = [...supported].flatMap(factId => input.metadata.facts.get(factId)?.fact ?? []);
    const rawCovered = store.factsCoveredByRaw(facts.filter(fact => !visible.factIds.has(fact.id)), rawIds, input.metadata.facts);
    const covered = (revision: KnowledgeRevision) => revision.supports.length > 0
      && revision.supports.every(factId => visible.factIds.has(factId) || rawCovered.has(factId));

    const delta = current.filter(({ revision }) => !visible.knowledgeCommitIds.has(revision.id) && !covered(revision));
    const states = allStates.filter(state => !(visible.knowledgeStates ?? new Set()).has(knowledgeStateKey(state.receipt))
      && !(state.revisions.length > 0 && state.revisions.every(covered)));
    if (!delta.length && !states.length) return empty();

    // Historical applicable bodies still retained in context spend the same configured allowance.
    // Re-render one coherent visible view with the same category/status framing; do not sum stored
    // body bytes, averages or candidate counts. Existing acknowledged notices are charged too.
    const line = (value: KnowledgeWithRevision) => renderKnowledge(value);
    const visibleKnowledge = budgetKnowledge(visibleBodies, Infinity, line);
    const acknowledged = visible.knowledgeStates ?? new Set<string>();
    // A retained status notice is independent of its old body: hosts may keep the notice alone.
    // Reconstruct its current matching transition without granting body coverage or producing a new notice.
    const acknowledgedSources = [...acknowledged].map(key => Number(key.split(">")[0]));
    const acknowledgedStateTexts = knowledgeStateNotes(store, current, acknowledgedSources, path, path ? undefined : projectId, graph)
      .filter(state => acknowledged.has(knowledgeStateKey(state.receipt))).map(state => state.text);
    const visibleText = injectionText({ knowledge: visibleKnowledge.groups, receipts: [] }, acknowledgedStateTexts);
    const remaining = knowledgeCap - tokens(visibleText);
    if (remaining <= 0) return empty();

    // State transitions retain priority over optional bodies. Then the shared selector preserves
    // the newest commits and receipts omitted older items, without publishing a receipt alone.
    const buildStates = (count: number) => injectionText({ knowledge: [], receipts: [] }, states.slice(0, count).map(state => state.text));
    const longest = (high: number, fits: (count: number) => boolean) => {
      let low = 0;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) low = middle; else high = middle - 1;
      }
      return low;
    };
    const stateCount = longest(states.length, count => tokens(buildStates(count)) <= remaining);
    if (stateCount < states.length) {
      if (!stateCount) return empty();
      const material = { knowledge: [], receipts: [] };
      const rendered = measuredMemory(buildStates(stateCount), material);
      return { ...rendered, knowledgeCommitIds: [], knowledgeStates: states.slice(0, stateCount).map(state => state.receipt),
        ...(transport ? { transportItems: states.slice(0, stateCount).map(state => ({ kind: "state" as const,
          text: state.text, receipt: state.receipt })) } : {}) };
    }
    const selectedStates = states.slice(0, stateCount);
    const ordered = [...delta].sort((a, b) => b.revision.id - a.revision.id);
    const build = (count: number) => {
      const selected = budgetKnowledge(ordered.slice(0, count), Infinity, line);
      const material = { knowledge: selected.groups,
        receipts: count ? renderKnowledgeOmissions(ordered.slice(count)) : [] };
      return { selected, material, text: injectionText(material, selectedStates.map(state => state.text)) };
    };
    // Foreground allowance is charged to the exact rendered body, not the selector's conservative
    // cost estimate: retained context and state notices already consume part of the same window.
    const count = longest(ordered.length, count => tokens(build(count).text) <= remaining);
    const { selected, material, text } = build(count);
    if (tokens(text) > remaining || (!selected.commits.length && !selectedStates.length)) return empty();
    const rendered = measuredMemory(text, material);
    return { ...rendered, knowledgeCommitIds: selected.commits,
      ...(transport ? { transportItems: [
        ...delta.filter(item => selected.commits.includes(item.revision.id)).map(item => ({ kind: "knowledge" as const,
          text: renderKnowledge(item), category: knowledgeCategoryGroup(item.revision.category), commitId: item.revision.id,
          address: `K${item.knowledge.id}@${item.revision.id}` })),
        ...selectedStates.map(state => ({ kind: "state" as const, text: state.text, receipt: state.receipt })),
        ...material.receipts.map(text => ({ kind: "receipt" as const, text })),
      ] } : {}),
      ...(selectedStates.length ? { knowledgeStates: selectedStates.map(state => state.receipt) } : {}) };
  };
  /** 25d "Trace address queries": one comma component read as an inclusive fact-id interval, `F81-F90`.
   * The hyphen is the whole interval grammar, so `..` keeps its single meaning (`F81..` walks later
   * strong negations, `K1@57..K1@61` diffs two commits). Endpoints are positive safe integers without
   * leading zeros, in ascending order, a one-element interval included; a reversed, unsafe, zero-padded
   * or non-fact pair of that shape is rejected here by name — every component is parsed before the read
   * begins, so no continuation state exists when an expression is refused. Anything that is not
   * address-shaped (a project name like `trace-memory`) is not an interval and still resolves as before. */
  const factInterval = (target: string): { from: number; to: number } | null => {
    const match = /^([A-Z])(\d+)-([A-Z])(\d+)$/.exec(target);
    if (!match) return null;
    const [left, from, right, to] = match.slice(1) as [string, string, string, string];
    const reject = (reason: string): never => { throw new Error(`invalid trace interval ${target}: ${reason}`); };
    if (left !== "F" || right !== "F") reject("only fact-id intervals exist, as F81-F90");
    if (!/^[1-9]\d*$/.test(from) || !/^[1-9]\d*$/.test(to)) reject("endpoints are positive integers without leading zeros");
    const [first, last] = [Number(from), Number(to)];
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)) reject("endpoints are safe integers");
    if (first > last) reject("endpoints ascend, as F81-F90");
    return { from: first, to: last };
  };
  const traceRead = (address: string, options: ListingOptions = {}): TraceRead => {
    validateBudgets(options);
    const cursor = /^cursor=([^,\s]+)$/.exec(address.trim());
    if (options.cursor || cursor) {
      // Preserve the explicit-cursor placeholder convention without allowing malformed entry
      // grammar to consume a read. A placeholder never changes the frozen query membership.
      if (options.cursor && address.trim() && !cursor) {
        const placeholders = traceTargets(address);
        if (placeholders.some(target => target.startsWith("cursor="))) throw new Error("continue a cursor alone, not in a comma list");
        placeholders.forEach(factInterval);
      }
      return page([], { ...options, cursor: options.cursor ?? cursor![1] });
    }
    options = effectiveOptions(options);
    const targets = traceTargets(address);
    if (targets.some(target => target.startsWith("cursor="))) throw new Error("continue a cursor alone, not in a comma list");
    const historyFields = targets.some(target => /^K[1-9]\d*\.\.$/.test(target)
      || options.versions !== "current" && /^K[1-9]\d*$/.test(target));
    options = { ...options, fields: [...(options.fields ?? (historyFields ? TRACE_HISTORY_DEFAULT_FIELDS : TRACE_DEFAULT_FIELDS))] };
    options = { ...options, maxTokens: options.pageBudget === null ? undefined : options.pageBudget ?? options.maxTokens ?? DEFAULT_READ_TOKENS,
      ...(options.pageBudget === null ? { cap: Number.MAX_SAFE_INTEGER } : {}) };
    const reads: KnowledgeRead[] = [];
    const collectionReceipts: string[] = [];
    const profile = readProfile(options, config.render);
    const items = store.transaction(() => {
      const intervals = targets.map(factInterval);
      // Freeze only values under the write lock. Renderers close over these values, not queries.
      const named = (target: string): (() => string) => {
        const s = /^S([1-9]\d*)$/.exec(target);
        if (s) {
          const id = Number(s[1]);
          session(id);
          collectionReceipts.push(`selected: S${id} Raw only (named collection; scope=${options.scope ?? "omitted"})`);
          const turns = store.listTurns(id).map(t => prepare(`T${t.id}`, { ...options, profile,
            ...(options.sessionId === id ? {} : { sessionId: id, branch: undefined, headTurnId: undefined }) }));
          return () => turns.map(render => listingLine(render())).join("\n");
        }
        let project = store.findProjectByName(target);
        while (project?.mergedInto != null) project = store.getProject(project.mergedInto);
        if (project) {
          const selection = knowledgeReadSelection(store, options, project.id);
          const revisions = selection.representatives(selection.graph.revisions);
          const records = store.knowledgeRecords(revisions.map(r => r.knowledgeId));
          const fields = new Set(options.fields!);
          const knowledge = revisions.map(revision => {
            const parents = (selection.input.parents.get(revision.id) ?? []).map(id => selection.byCommit.get(id)!);
            const children = selection.graph.revisions.filter(r => selection.input.parents.get(r.id)?.includes(revision.id));
            const grounds = [...store.revisionGrounds(revision)].sort((a, b) => a - b);
            const status = selection.status(revision);
            return () => renderKnowledgeTrace({ knowledge: records.get(revision.knowledgeId)!, revision },
              parents, children, profile.entryTokens, grounds, fields, false, status);
          });
          const facts = store.listProjectFacts(project.id);
          const relations = options.sessionId === undefined ? store.listFactRelationsOf(facts.map(fact => fact.id)) : (() => {
            const path = store.knowledgePath(options.sessionId!, options.branch, options.headTurnId);
            return store.listFactRelationsOnPathOf(facts.map(fact => fact.id), path);
          })();
          const times = store.factTurnTimes(facts);
          collectionReceipts.push(`selected: project ${project.name} facts; ${options.scope ?? "global/project"} knowledge; ${options.versions} versions`, KNOWLEDGE_REPRESENTATIVE_RECEIPT);
          return () => [...knowledge.map(render => render()), ...renderFactGroups(facts,
            (fact, frame) => renderFact(fact, relations.get(fact.id) ?? [], profile.entryTokens, frame), times, true)].filter(Boolean).join("\n");
        }
        return prepare(target, { ...options, profile }, reads);
      };
      // Intervals keep immutable fact bodies lazy; membership and mutable relations freeze now.
      const units = targets.flatMap((target, index): TraceUnit[] => {
        const range = intervals[index];
        if (!range) return [{ render: named(target) }];
        const facts = store.factMetadataInRange(range.from, range.to);
        const times = new Map(facts.map(fact => [fact.turnId, fact.time]));
        return facts.length ? factGroupLayout(facts, times).map(({ fact, header }) => ({ fact: fact.id, header, relations: [] }))
          : [{ render: () => `${target}: no facts exist in this range` }];
      });
      const ids = units.flatMap(unit => "fact" in unit ? [unit.fact] : []);
      const relations = !ids.length ? new Map<number, FactRelation[]>() : options.sessionId === undefined
        ? store.listFactRelationsOf(ids)
        : store.listFactRelationsOnPathOf(ids, store.knowledgePath(options.sessionId, options.branch, options.headTurnId));
      return units.map(unit => "fact" in unit ? { ...unit, relations: relations.get(unit.fact)! } : unit);
    });
    const format = (units: readonly unknown[]) => (units as TraceUnit[])
      .flatMap(unit => ("fact" in unit ? renderFact(store.getFact(unit.fact)!, unit.relations, profile.entryTokens, text => "\n" + (unit.header ?? "") + text).slice(1) : unit.render()).split("\n"));
    const footer = [...collectionReceipts, ...(targets.some(target => /^K[1-9]\d*(?:\.\.)?$/.test(target))
      ? [`versions: ${targets.every(target => /^K[1-9]\d*\.\.$/.test(target)) ? "all" : options.versions}${historyFields ? "; explicit K history" : ""}`,
        ...(targets.some(target => /^K[1-9]\d*\.\.$/.test(target)) ? ["selected: explicit K.. histories use all branches"] : [])] : [])].join("\n");
    return page({ items, format }, options, footer, reads);
  };
  // Model spend of this session's runs, from the usage each run recorded (summed over its rounds).
  // 22d: the usage is projected out of the stored response by the store; the request and response
  // audit bodies are never loaded to add up counters. A run without a usage observation — a failure,
  // a cancelled run with unknown usage — contributes nothing at all, not a zero.
  const spend = (sessionId: number) => {
    session(sessionId);
    const totals = { runs: { noting: 0, consolidation: 0, dreaming: 0, manual: 0 }, costs: { noting: 0, consolidation: 0, dreaming: 0, manual: 0 },
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const { kind, usage } of store.listRunUsage(sessionId)) {
      totals.runs[kind]++;
      if (!usage) continue;
      totals.input += usage.input; totals.output += usage.output;
      totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite; totals.cost += usage.cost; totals.costs[kind] += usage.cost;
    }
    return totals;
  };
  // 51: the footer's figure — every session's runs created at or after `since` (the host passes local
  // midnight as a UTC instant), so the number resets at the day boundary on its own. 77: the store's
  // own query, answered from a covering index on `created_at`, never `listRunUsage`'s session index.
  const spendSince = (since: string): number => store.spendSince(since);
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
  const progressCache = new Map<string, { signal: string; headTurnId: number; facts: number; unconsolidated: number; knowledge: number; changedKnowledge: number }>();
  /** Footer progress for one selected path. `knowledge` is the current visible set;
   * `changedKnowledge` is the subset whose current owner pool has not processed that revision.
   * Processing is scheduling state only: it is not exposed as a processed/unprocessed partition. */
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
      reusable ? undefined : prepare).length;
    if (reusable) {
      cached.headTurnId = path.headTurnId!;
      return { entries, facts: cached.facts, unconsolidated: cached.unconsolidated,
        knowledge: cached.knowledge, changedKnowledge: cached.changedKnowledge };
    }
    snapshot = prepare();
    const facts = store.listBranchFacts(sessionId, branch, path.headTurnId, snapshot);
    const knowledge = store.currentKnowledge(path, {}, snapshot);
    const changedKnowledge = knowledge.length - store.processedCurrentVersions(knowledge).size;
    const unconsolidated = store.unconsolidated(facts, path, snapshot).length;
    if (path.headTurnId != null) progressCache.set(key, { signal, headTurnId: path.headTurnId, facts: facts.length, unconsolidated, knowledge: knowledge.length, changedKnowledge });
    else progressCache.delete(key);
    return { entries, facts: facts.length, unconsolidated, knowledge: knowledge.length, changedKnowledge };
  };
  return {
    spend,
    spendSince,
    progress,
    trace: (address: string, options?: ListingOptions) => traceRead(address, options).text,
    traceRead,
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
    inject: (target: number | { projectId: number } | KnowledgePath): string => injection(target).text,
    // One allocator: required state notices/facts/Raw first, then optional current knowledge and
    // Raw-first historical refill in each own base remainder. Scheduling pairs never affect it.
    // No worker, processing mark or coverage persistence is performed by this synchronous render.
    // 73 "Shared allowance": one allocator, three windows, one pass — Knowledge first (borrowing the
    // whole allowance), then the newest contiguous Raw span (pending entries borrowing what Knowledge
    // left, already-noted entries only within the Raw base), then the newest facts before that span
    // (unconsolidated facts borrowing what Raw left, consolidated only within the facts base). Nothing
    // is required any more: every window truncates — newest kept, oldest omitted with a receipt —
    // rather than escalating to a native delegation. Omitted material stays pending in the store.
    compact: (sessionId: number, branch = "main", headTurnId?: number, retainedView: readonly string[] | VisibleView = [],
      transport = false): CompactResult => {
      if (!store.enabled(sessionId)) return { text: "", supplied: { entries: [], factIds: [], knowledgeCommitIds: [] } };
      const path = store.knowledgePath(sessionId, branch, headTurnId);
      const snapshot = store.pathSnapshot(path); // one membership for this operation, knowledge and facts alike
      const head = headTurnId ?? store.listTurns(sessionId).at(-1)?.id;
      const sourceSnapshot = head === path.headTurnId ? snapshot : head === undefined ? undefined
        : store.pathSnapshot({ sessionId, branch, headTurnId: head });
      const sourced = head === undefined ? [] : store.sourcePath(sessionId, branch, head, sourceSnapshot);
      const pending = head === undefined ? [] : store.pendingEntries(sessionId, branch, head, sourceSnapshot);
      const pendingIds = new Set(pending.map(e => e.id));
      const knowledge = store.currentKnowledge(path, {}, snapshot);
      const visible = Array.isArray(retainedView) ? noVisibility() : retainedView as VisibleView;
      const retained = new Set(Array.isArray(retainedView) ? retainedView : visible.raw.keys());
      // Ticket 80 item 3: one batched `fact_sources` read for the whole session's facts, not one per fact.
      const sessionFacts = store.listSessionFacts(sessionId);
      const boundEntries = store.factSourceEntries(sessionFacts.map(f => f.id));
      const applicable = sessionFacts.filter(f => store.factOnPath(f, path, snapshot, undefined, undefined, boundEntries));
      const pendingFacts = store.unconsolidated(applicable, path, snapshot);
      const pendingFactIds = new Set(pendingFacts.map(f => f.id));
      const factTurns = store.factTurnTimes(applicable);
      const budgets = store.knowledgeBudgets();
      const sharedAllowance = config.compaction.sharedAllowanceTokens;
      const caps = { knowledge: budgets.injection, facts: config.compaction.factsTokens, raw: config.compaction.rawTokens };
      const envelope = caps.knowledge + caps.facts + caps.raw + sharedAllowance;
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

      // ---- 1. Knowledge first: required status notices, newest kept, then bodies newest-first. ----
      const knowledgeEnvelope = caps.knowledge + sharedAllowance;
      const allNotes = knowledgeStateNotes(store, knowledge, visible.knowledgeCommitIds, path)
        .sort((a, b) => b.receipt.fromCommit - a.receipt.fromCommit)
        .map(note => note.text.replace(/(superseded by K\d+@\d+)$/, "$1 above"));
      const noteReceipt = (omitted: number) => omitted
        ? [`omitted ${omitted} older inherited knowledge status lines; knowledge base plus shared allowance is full`] : [];
      const noteTextCost = (kept: number) => kept ? charge([KNOWLEDGE_STATUS_TITLE, ...allNotes.slice(0, kept)]) : 0;
      const noteCost = (kept: number) => noteTextCost(kept) + receiptCharge(noteReceipt(allNotes.length - kept));
      let noteKept = allNotes.length;
      while (noteKept > 0 && noteCost(noteKept) > knowledgeEnvelope) noteKept--;
      const notes = allNotes.slice(0, noteKept);
      // With nothing kept, a receipt that does not fit either leaves the notices window empty.
      const noteOmittedReceipt = noteCost(noteKept) <= knowledgeEnvelope ? noteReceipt(allNotes.length - noteKept) : [];
      const knowledgeNoticeCost = noteTextCost(noteKept) + receiptCharge(noteOmittedReceipt);
      const active = budgetKnowledge(knowledge, Math.max(0, knowledgeEnvelope - knowledgeNoticeCost),
        knowledgeLine, "Knowledge base plus shared allowance", new Set());
      const knowledgeUsed = knowledgeNoticeCost + active.cost;
      const sharedAfterKnowledge = sharedAllowance - Math.max(0, knowledgeUsed - caps.knowledge);

      // ---- 2. Raw second: the newest contiguous span. Pending entries borrow; noted entries only
      // fill the Raw base remainder. The walk never skips an entry to reach an older one. ----
      // Retained (visible elsewhere in the post-compaction context) excludes an already-noted entry
      // from optional refill; it never excludes a still-pending one (30 case 10) — pending membership
      // is the only thing that decides whether an entry must still be represented here.
      const candidates = sourced.filter(e => pendingIds.has(e.id) || !retained.has(e.nativeId));
      interface RawStep { entry: SourceEntry; content: string; receipts: string[]; fromAllowance: number }
      const rawSteps: RawStep[] = [];
      {
        let rawBaseUsed = charge([RAW_TITLE]), allowanceUsed = 0;
        for (let i = candidates.length - 1; i >= 0; i--) {
          // 79 item 2: newest first, hydrated one candidate at a time — the first that does not fit
          // must still be rendered to know it does not fit (acceptance criteria), but nothing earlier
          // (older) is ever hydrated once that happens.
          const entry = store.getSourceEntry(candidates[i]!.id)!;
          let rendered: EntryView;
          try { rendered = view(entry); } catch (error) { if (/capacity/.test(String(error))) break; throw error; }
          const cost = tokens(rendered.content) + 1;
          const availableBase = Math.max(0, caps.raw - rawBaseUsed);
          if (pendingIds.has(entry.id)) {
            const availableAllowance = Math.max(0, sharedAfterKnowledge - allowanceUsed);
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
        ? [`[... ${candidates.length - kept} earlier entries omitted from the Raw window; read them with trace]`] : [];
      // Exactly what the Raw window adds to the output: the `<episodic>` tag and title only when it
      // has entries, each kept entry's own view receipts, and its omission receipt.
      const rawWindowCost = (kept: number, receipt: string[]) => {
        const steps = rawSteps.slice(0, kept);
        return (kept ? opener(RAW_TITLE) + charge(steps.map(s => s.content)) : 0) + receiptCharge([...steps.flatMap(s => s.receipts), ...receipt]);
      };
      // Only unprocessed material borrows (73): the whole window — framing and receipts included —
      // may exceed its base by at most what its kept pending entries cost, and never by more than
      // the allowance Knowledge left. Without pending entries it fits its base.
      const rawLimit = (kept: number) => caps.raw + Math.min(sharedAfterKnowledge,
        rawSteps.slice(0, kept).reduce((sum, s) => sum + (pendingIds.has(s.entry.id) ? tokens(s.content) + 1 : 0), 0));
      let rawKept = rawSteps.length;
      while (rawKept > 0 && rawWindowCost(rawKept, rawReceipt(rawKept)) > rawLimit(rawKept)) rawKept--;
      // With nothing kept, a receipt that does not fit either leaves the Raw window empty.
      const rawFinalReceipt = rawWindowCost(rawKept, rawReceipt(rawKept)) <= rawLimit(rawKept) ? rawReceipt(rawKept) : [];
      const rawFinalSteps = rawSteps.slice(0, rawKept);
      const rawCharged = rawWindowCost(rawKept, rawFinalReceipt);
      // What the whole window took beyond its base — receipts and framing included — leaves the allowance.
      const sharedAfterRaw = sharedAfterKnowledge - Math.max(0, rawCharged - caps.raw);
      // Displayed in source order (30: "display the selected Raw entries in source order").
      const suppliedRaw = [...rawFinalSteps].reverse();
      const rawOmitted = candidates.slice(0, candidates.length - suppliedRaw.length);
      // 79 item 4 (ruled): omitted pending Raw is reported as an exact count only. A token figure
      // would render every omitted entry on every compaction (7,374 for S134's measured backlog) —
      // the whole cost this ticket removes. Facts keep their count and tokens: fact rows are small.
      const rawOmittedPending = rawOmitted.filter(e => pendingIds.has(e.id));

      // ---- 3. Facts third: newest facts not wholly covered by the Raw span just chosen. ----
      const coverage = new Set([...sourced.filter(e => retained.has(e.nativeId)).map(e => e.id), ...suppliedRaw.map(s => s.entry.id)]);
      const factCandidates = applicable.filter(f => !visible.factIds.has(f.id));
      const coveredFactIds = store.factsCoveredByRaw(factCandidates, coverage);
      const eligibleFacts = factCandidates.filter(f => !coveredFactIds.has(f.id)); // already newest-first
      const omission = (rest: Fact[]) => rest.length ? [`omitted ${rest.length} older facts; expand: ${expandList(rest.map(f => `F${f.id}`))}`] : [];
      // Exactly what the facts window adds: its title only when it has facts, the `<episodic>` tag
      // only when the Raw window did not already open it, and its omission receipt.
      const factsWindowCost = (kept: number, receipt: string[]) => (kept
        ? (rawKept ? charge([FACTS_TITLE]) : opener(FACTS_TITLE)) + charge(lines(eligibleFacts.slice(0, kept))) : 0) + receiptCharge(receipt);
      const factsTotalCost = (kept: number) => factsWindowCost(kept, omission(eligibleFacts.slice(kept)));
      let factsKept = 0, factsBaseUsed = 0, factsAllowanceUsed = 0, prevFactsCost = 0;
      const pendingFactCost: number[] = []; // per kept fact, its marginal cost when unconsolidated, else 0
      for (const fact of eligibleFacts) {
        const nextCost = factsWindowCost(factsKept + 1, []);
        const marginal = nextCost - prevFactsCost;
        const availableBase = Math.max(0, caps.facts - factsBaseUsed);
        if (pendingFactIds.has(fact.id)) {
          const availableAllowance = Math.max(0, sharedAfterRaw - factsAllowanceUsed);
          if (marginal > availableBase + availableAllowance) break;
          const fromBase = Math.min(marginal, availableBase);
          factsBaseUsed += fromBase; factsAllowanceUsed += marginal - fromBase;
        } else {
          if (marginal > availableBase) break;
          factsBaseUsed += marginal;
        }
        pendingFactCost.push(pendingFactIds.has(fact.id) ? marginal : 0);
        factsKept++; prevFactsCost = nextCost;
      }
      // As for Raw: the window may exceed its base only by what its kept unconsolidated facts cost.
      const factsLimit = (kept: number) => caps.facts + Math.min(sharedAfterRaw,
        pendingFactCost.slice(0, kept).reduce((sum, cost) => sum + cost, 0));
      while (factsKept > 0 && factsTotalCost(factsKept) > factsLimit(factsKept)) factsKept--;
      const finalFacts = eligibleFacts.slice(0, factsKept);
      // With nothing kept, a receipt that does not fit either leaves the facts window empty.
      const finalFactReceipts = factsTotalCost(factsKept) <= factsLimit(factsKept) ? omission(eligibleFacts.slice(factsKept)) : [];
      const factsOmittedPending = eligibleFacts.slice(finalFacts.length).filter(f => pendingFactIds.has(f.id));
      const factsOmittedPendingTokens = factsOmittedPending.length ? charge(lines(factsOmittedPending)) : 0;

      const truncated: TruncationReceipt = {};
      if (rawOmittedPending.length) truncated.raw = { entries: rawOmittedPending.length };
      if (factsOmittedPending.length) truncated.facts = { count: factsOmittedPending.length, tokens: factsOmittedPendingTokens };

      const material = { knowledge: active.groups, facts: lines(finalFacts),
        entries: suppliedRaw.map(s => ({ id: s.entry.id, view: s.content })),
        receipts: [...suppliedRaw.flatMap(s => s.receipts), ...rawFinalReceipt, ...finalFactReceipts, ...active.receipts, ...noteOmittedReceipt] };
      return { ...measuredMemory(compactText(material, RAW_TITLE, notes), material),
        ...(transport ? { transportItems: [
          ...knowledge.filter(item => active.commits.includes(item.revision.id)).map(item => ({ kind: "knowledge" as const,
            text: renderKnowledge(item), category: knowledgeCategoryGroup(item.revision.category), commitId: item.revision.id,
            address: `K${item.knowledge.id}@${item.revision.id}` })),
          ...notes.map(text => ({ kind: "receipt" as const, text })),
          ...factGroupLayout(finalFacts, factTurns).map(({ fact, header }) => ({ kind: "fact" as const,
            text: header + factLine(fact.id, factRelations.get(fact.id) ?? []), factId: fact.id,
            pending: pendingFactIds.has(fact.id) })),
          ...suppliedRaw.map(step => ({ kind: "raw" as const, text: step.content, entryId: step.entry.id,
            address: `T${step.entry.turnId}#E${step.entry.entryOrdinal}`, pending: pendingIds.has(step.entry.id) })),
          ...material.receipts.map(text => ({ kind: "receipt" as const, text })),
        ] } : {}),
        // 29a "Renderers return what they kept": exactly the identities this replacement carries.
        // What a budget left out is absent here (28a item 7) and stays pending in the store.
        supplied: { entries: suppliedRaw.map(s => ({ id: s.entry.id, nativeId: s.entry.nativeId, view: "bounded" as const })),
          factIds: finalFacts.map(f => f.id), knowledgeCommitIds: active.commits },
        // The per-window accounting beside the text, for the acceptance probe; diagnostics only.
        charged: { knowledge: knowledgeUsed, facts: factsWindowCost(finalFacts.length, finalFactReceipts), raw: rawCharged, envelope },
        ...(Object.keys(truncated).length ? { truncated } : {}) };
    },
    branchSummary: (sessionId: number, branch: string, headTurnId: number): string => {
      if (!store.enabled(sessionId)) return "";
      // Carry is optional, unlike compact's required pending Raw. Consider the whole pending set,
      // not Noting's next batch, and keep a newest whole suffix under the shared view profile.
      // Charge the Raw title, separators and omission receipt too; even the newest entry may not fit.
      const title = "Pending raw:";
      const pending = store.pendingEntries(sessionId, branch, headTurnId);
      const raw: ReturnType<typeof renderEntry>[] = [];
      let omitted = pending.length, used = charge([title]);
      const receipt = () => omitted ? [`[... ${omitted} earlier pending entries omitted from the carry budget; read them with trace]`] : [];
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
    search: (query: string | readonly string[], requestedScope?: SearchScope, input: ListingOptions & { sessionId?: number } = {}): string => {
      validateBudgets(input);
      let scope = requestedScope;
      if (input.category !== undefined && scope === undefined) scope = "knowledge";
      if (!scope) scope = "all";
      if (!["facts", "knowledge", "all", "raw"].includes(scope)) throw new Error("invalid search scope");
      if (input.category !== undefined && scope !== "knowledge")
        throw new Error("category filter requires layer knowledge");
      if (input.cursor) return page([], input, "", [], "search").text;
      const effective = effectiveOptions(input);
      const historyFields = (scope === "knowledge" || scope === "all") && effective.versions !== "current";
      const options = { ...effective, fields: [...(input.fields ?? (historyFields ? SEARCH_HISTORY_DEFAULT_FIELDS : SEARCH_DEFAULT_FIELDS))],
        itemBudget: input.itemBudget === undefined ? input.full === true ? null : SEARCH_PREVIEW_TOKENS : input.itemBudget };
      const reader = options.sessionId === undefined ? undefined : session(options.sessionId);
      if (options.scope === "session" && !reader) throw new Error("scope:session requires a session context");
      if (options.scope === "project" && !reader) throw new Error("scope:project requires a project context");
      const sessionIds = options.scope === "global" || !reader ? undefined : options.scope === "session" ? [reader.id]
        : store.projectSessionIds(reader.projectId);
      // 59: the batched form runs each query under the shared options; per query at most `cap` hits
      // (default 1), the line cap of the page left at its default. Everything else is the single form.
      const batched = typeof query === "string" ? undefined : [...query];
      const found = (batched ?? [query as string]).map(q => store.searchAddresses(q, scope, sessionIds));
      // 22c: the path, applicable set, tips and ancestry are resolved once. Filtering happens over
      // that same graph before paging, so a page spends no budget on a status the query excluded.
      const selection = found.some(list => list.some(a => a.startsWith("K"))) ? knowledgeReadSelection(store, options) : null;
      const graphInput = selection?.input;
      const graph = selection?.graph;
      const byCommit = selection?.byCommit ?? new Map<number, KnowledgeRevision>();
      const children = new Map<number, KnowledgeRevision[]>();
      for (const revision of graph?.revisions ?? []) for (const parent of graphInput!.parents.get(revision.id) ?? [])
        children.set(parent, [...(children.get(parent) ?? []), revision]);
      const revision = (address: string) => byCommit.get(Number(address.split("@")[1]))!;
      const fields = new Set(options.fields!.filter(field => field !== "reason"
        || ((scope === "knowledge" || scope === "all") && options.versions !== "current")));
      const represented = found.map((list, index) => {
        const ranked = selection?.representatives(list.filter(a => a.startsWith("K")).map(revision), (batched ?? [query as string])[index], batched ? "score" : "id") ?? [];
        const selected = new Set(ranked.map(r => r.id));
        if (!batched) return list.filter(address => !address.startsWith("K") || selected.has(revision(address).id));
        // 59b: knowledge hits in similarity order, then the query's fact and Raw hits as listed.
        return [...ranked.map(r => `K${r.knowledgeId}@${r.id}`), ...list.filter(address => !address.startsWith("K"))];
      });
      const perQuery = input.cap ?? 1;
      if (batched && (!Number.isSafeInteger(perQuery) || perQuery < 1)) throw new Error("listing cap must be a positive integer");
      const addresses = batched ? represented.flatMap((list, index) => list.slice(0, perQuery).map(address => ({ address, query: batched[index]! }))) : represented[0]!;
      // 59c: a query with no hit is a line after every hit, paged like one, never a footer entry.
      const items: (string | FrozenHit | Miss)[] = [...addresses, ...(batched ? batched.filter((_, index) => !represented[index]!.length).map(miss => ({ miss })) : [])];
      // The graph freezes knowledge hits; this freezes mutable Raw membership for deferred pages.
      // No open transaction survives the first page.
      const capture = (deferred: readonly unknown[]): (FrozenHit | Miss)[] => {
        // The no-hit lines trail every hit and read nothing mutable; only the hits are frozen.
        const hits = deferred.filter((item): item is string | FrozenHit => typeof item === "string" || !("miss" in (item as object)));
        const queries = hits.map(item => typeof item === "string" ? undefined : item.query);
        const rest = hits.map(item => typeof item === "string" ? item : item.address);
        const record = (address: string) => Number(address.slice(1));
        const ids = (prefix: string, of: (address: string) => number) => rest.filter(a => a.startsWith(prefix)).map(of);
        const entries = store.listSourceEntryIdsOf(ids("T", record));
        return [...rest.map((address, index): FrozenHit => ({ ...(address.startsWith("F") ? { address }
          : address.startsWith("T") ? { address, entryIds: entries.get(record(address))!, profile: { entryTokens: config.render.entryTokens, toolInputTokens: config.render.toolInputTokens, toolResultTokens: config.render.toolResultTokens } }
          : { address }), ...(queries[index] === undefined ? {} : { query: queries[index] }) })),
          ...deferred.slice(hits.length) as Miss[]];
      };
      const format = (hits: readonly unknown[]) => (hits as (string | FrozenHit | Miss)[]).map((item) => {
        if (typeof item !== "string" && "miss" in item) return `no hit: ${JSON.stringify(item.miss)}`;
        const frozen: FrozenHit | undefined = typeof item === "string" ? undefined : item;
        const address = frozen?.address ?? item as string;
        const echo = frozen?.query === undefined ? "" : `${JSON.stringify(frozen.query)}: `;
        if (address.startsWith("F")) return echo + renderFactPreview(store.getFact(Number(address.slice(1)))!, fields, options.itemBudget === null ? Infinity : options.itemBudget!);
        if (address.startsWith("T")) return echo + expand(address, frozen?.entryIds && { entryIds: frozen.entryIds, profile: frozen.profile });
        const [id, commit] = address.slice(1).split("@").map(Number);
        const knowledge = store.getKnowledge(id!)!;
        const hit = revision(address);
        const status = selection!.status(hit);
        const parents = (graphInput!.parents.get(hit.id) ?? []).map(parent => byCommit.get(parent)!).filter(Boolean);
        return echo + renderKnowledgePreview({ knowledge, revision: hit }, status, fields,
          options.itemBudget === null ? Infinity : options.itemBudget!, parents, children.get(hit.id) ?? []);
      }).map(listingLine);
      const material = options.scope === "session" ? "this session; session knowledge" : options.scope === "project"
        ? "project sessions; project knowledge" : options.scope === "global" ? "all sessions; global knowledge"
        : reader ? "project sessions; global/project/session knowledge" : "all sessions; unrestricted knowledge owners";
      const filters = [`searched: ${material}, ${options.versions} versions`, ...(options.category ? [`category=${options.category}`] : []), ...(options.scope ? [`scope=${options.scope}`] : [])].join(", ");
      const omitted = READ_FIELDS.filter(field => !fields.has(field));
      const preview = `preview: ${fields.size === 0 ? "identity only" : fields.size === 1 && fields.has("text") ? "text only" : `fields ${[...fields].join(", ")}`}; omitted fields: ${omitted.join(", ") || "none"}`;
      return page({ items, format, capture, ...(batched ? { queryCap: perQuery } : {}) }, { ...options, ...(batched ? { cap: undefined } : {}),
        maxTokens: options.pageBudget === null ? undefined : options.pageBudget ?? options.maxTokens ?? DEFAULT_READ_TOKENS },
        `Search uses literal substring search. No hit does not mean absent.\n${filters}\n${KNOWLEDGE_REPRESENTATIVE_RECEIPT}\n${preview}`, [], "search").text;
    },
    status: (sessionId: number, branch?: string, headTurnId?: number | null): string => {
      const s = session(sessionId), runs = store.listRuns(sessionId);
      const totals = spend(sessionId);
      const counts = progress(sessionId, branch, headTurnId);
      return [`Session: S${sessionId}`, `Enrollment: ${store.enabled(sessionId) ? "Enabled" : "Disabled"} (${store.enrollment(sessionId).choice === null ? "default" : "explicit choice"})`, `Project: ${store.getProject(s.projectId)!.name} (${store.projectDeclaration(sessionId)})`,
        ...(!store.enabled(sessionId) ? store.taskFailures(sessionId).filter(task => task.count >= 3).map(task =>
          `Automatic off: ${task.phase}, backlog head ${task.head}, ${task.count} failures; last R${task.lastRunId}: ${task.lastReason}. Use /trace on to resume.`) : []),
        `Spend: ${totals.runs.noting} noting, ${totals.runs.consolidation} consolidation, ${totals.runs.dreaming} dreaming, ${totals.runs.manual} manual runs; ${totals.input + totals.output + totals.cacheRead + totals.cacheWrite} tokens; $${totals.cost.toFixed(4)}`,
        // 24a: the footer's own counts, spelled out. They describe imported evidence only: native
        // history of a disabled interval is imported when the session is enabled again, so a zero
        // here is not proof that every available native message has been processed.
        `Pending: ${counts.entries} imported ${counts.entries === 1 ? "entry" : "entries"} to note, ${counts.unconsolidated} of ${counts.facts} applicable ${counts.facts === 1 ? "fact" : "facts"} to consolidate; ${counts.knowledge} current knowledge (imported evidence on this branch)`,
        `Facts: ${store.listSessionFacts(sessionId).length} session; ${store.listProjectFacts(s.projectId).length} project`,
        `Knowledge: ${counts.knowledge} visible active`,
        ...(["noting", "consolidation", "dreaming"] as const).map((kind) => { const r = [...runs].reverse().find((r) => r.kind === kind); return `Last ${kind}: ${r ? `run ${r.id} ${r.outcome} ${r.createdAt} branch=${r.branch}` : "none"}`; })].join("\n");
    },
  };
}
