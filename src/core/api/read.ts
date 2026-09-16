import { randomUUID } from "node:crypto";
import { knowledgeReadSelection, KNOWLEDGE_REPRESENTATIVE_RECEIPT } from "./knowledge-read.ts";
import { traceTargets } from "../model/address.ts";
import type { TraceMemoryConfig } from "./index.ts";
import type { Store, KnowledgeWithRevision, KnowledgePath, SourceEntry } from "../store/index.ts";
import { KNOWLEDGE_CATEGORIES, KNOWLEDGE_SCOPES, type Fact, type FactRelation, type KnowledgeCategory, type KnowledgeMark, type KnowledgeRevision, type KnowledgeScope } from "../model/index.ts";
import { budgetKnowledge, charge, expandList, tokens, finish, listingLine, renderKnowledge, renderFact, renderFactPreview, renderKnowledgePreview, renderKnowledgeTrace, renderFactGroups, factGroupLayout, renderEntry, rawResultText, xmlBlock, type EntryView, type ResultExtractor, type EntryProfile } from "../render/index.ts";
import { injectionText, compactText, measuredMemory, type MemoryComposition, FACTS_TITLE, RAW_TITLE, KNOWLEDGE_STATUS_TITLE } from "../render/material.ts";
import { knowledgeStateKey, noVisibility, type KnowledgeStateReceipt, type SuppliedMaterial, type VisibleView } from "./visible.ts";

/** `sessionId`, `headTurnId` and `branch` are the reader's own path, supplied by the host or by a
 * run's tool binding, never by the model: they decide which knowledge a label is judged against and,
 * since 23b, which of a Turn's native occurrences an assembled `trace` shows. An unbound read is
 * unrestricted, as it always was. A Turn's occurrences are selected by `branch`, or — when a paged
 * read froze them at query time (22c) — by the `entryIds` that query kept; like the path, neither is
 * reachable from a model's tool arguments. */
export const READ_VERSIONS = ["current", "history", "all"] as const;
export type ReadVersions = (typeof READ_VERSIONS)[number];
export const READ_FIELDS = ["text", "supports", "topics", "status", "reason", "links", "marks"] as const;
export type ReadField = (typeof READ_FIELDS)[number];
export const TRACE_DEFAULT_FIELDS: readonly ReadField[] = ["text", "supports", "topics", "status", "links", "marks"];
export const TRACE_HISTORY_DEFAULT_FIELDS: readonly ReadField[] = [...TRACE_DEFAULT_FIELDS, "reason"];
export const SEARCH_DEFAULT_FIELDS: readonly ReadField[] = ["text"];
export const SEARCH_HISTORY_DEFAULT_FIELDS: readonly ReadField[] = ["text", "status"];
export const SEARCH_PREVIEW_TOKENS = 80;
export const MAX_PUBLIC_READ_TOKENS = 8000;
export interface ListingOptions { itemBudget?: number | null; toolCallBudget?: number | null; toolResultBudget?: number | null; pageBudget?: number | null; maxTokens?: number; cap?: number; cursor?: string; tool?: number; full?: boolean; versions?: ReadVersions; category?: KnowledgeCategory; scope?: KnowledgeScope; fields?: readonly ReadField[]; sessionId?: number; headTurnId?: number | null; branch?: string; entryIds?: readonly number[]; profile?: EntryProfile }
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
  if (options.category !== undefined && !KNOWLEDGE_CATEGORIES.includes(options.category)) throw new Error("invalid knowledge category filter");
  if (options.scope !== undefined && !KNOWLEDGE_SCOPES.includes(options.scope)) throw new Error("invalid knowledge scope filter");
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1 || options.maxTokens > MAX_PUBLIC_READ_TOKENS))
    throw new Error(`maxTokens must be a positive safe integer at most ${MAX_PUBLIC_READ_TOKENS}`);
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

/** 21b "Group projection": the topics of the path-selected applicable knowledge, as references to the
 * exact commits they were read from. A commit with several labels is referenced by each of its groups,
 * a commit with none stays available under `unclassified`, and divergent tips remain separate entries:
 * nothing here clones a knowledge record, collapses two tips or picks a winner. */
export interface TopicGroups {
  topics: { topic: string; commits: { knowledgeId: number; commit: number }[] }[];
  unclassified: { knowledgeId: number; commit: number }[];
}

/** Ticket 20 "Compaction escalation", as tickets 30 and 28a left it: what compact can produce for one
 * frozen read snapshot. The first form is the complete custom replacement the host may hand to Pi —
 * every pending fact and every pending entry is represented in it, the entries in the one bounded
 * view, with the spare allowance refilled by recent consolidated facts and recent already-extracted
 * Raw. `native` is the explicit ask that the host decline the custom summary and let Pi's own
 * compaction run, with the reason it could not be avoided: each required-window excess and the
 * shared overflow shortfall. There is no third outcome: compact never trims a pending window to make
 * the block fit, and core never summarizes with a model.
 *
 * 29a "Renderers return what they kept": beside the replacement text, the identities it actually
 * carries — every supplied entry, pending and refilled alike, plus the facts and knowledge commits
 * that survived budgeting. What a budget dropped is absent here. A native delegation supplies
 * nothing, so it has no `supplied` at all. */
export type CompactResult = { text: string; supplied: SuppliedMaterial; composition?: MemoryComposition; charged?: ChargedWindows }
  /** 28b: `over` says which required window overflowed, so the host's bounded recovery can decide
   * which phase to run without reading the prose of `reason`. It is present exactly when a required
   * window excess cannot fit the shared allowance — the one condition recovery can act on. A delegation for any other
   * reason (an entry whose minima exceed the view profile, a store error the host caught) carries
   * none, and recovery starts nothing for it. */
  | { native: true; reason: string; over?: { knowledge: boolean; facts: boolean; raw: boolean } };

/** 28a item 6: what one custom replacement charged, window by window, beside the text it produced.
 * Diagnostics — the outcome is still the custom replacement or the native delegation, and nothing
 * reads this to decide between them. `envelope` is the sum of the three bases and shared overflow, the ceiling the
 * three charges together may never exceed. */
export interface ChargedWindows { knowledge: number; facts: number; raw: number; envelope: number;
  /** What the required material alone charges — the unprocessed knowledge, pending facts and pending Raw with their
   * framing, before either refill. `facts`/`raw` above minus these is what the refills took. */
  required: { knowledge: number; facts: number; raw: number } }
/** Foreground Knowledge delivery and the exact body/state identities its carrier may persist. */
export interface Injection { text: string; knowledgeCommitIds: number[]; knowledgeStates?: KnowledgeStateReceipt[]; composition?: MemoryComposition }

/** 22c "complete snapshot": one search hit whose formatting the query deferred to a later page, with
 * the mutable state its line would otherwise read from the database then. Everything else a hit
 * prints — the fact and commit records, the path, the labels the commit graph decided — is immutable
 * or already frozen by the query, so these three annotations are the whole remainder. */
interface FrozenHit { address: string; relations?: FactRelation[]; marks?: KnowledgeMark[]; entryIds?: number[]; profile?: EntryProfile }

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
  const byCommit = new Map(graph.revisions.map(r => [r.id, r]));
  return retained.filter(id => graph.applicable.has(id) && !active.has(id)).flatMap(id => {
    const revision = byCommit.get(id);
    if (!revision) return [];
    const descendants = graph.descendants(id);
    const successors = graph.current.filter(r => r.id !== id && descendants.has(r.id));
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
    capture?: (deferred: readonly unknown[]) => readonly unknown[] }
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
    scope?: KnowledgeScope; fields?: readonly ReadField[];
  };
  type Remainder = Continuation & { offset: number; pending: readonly string[]; footer: string; cap: number; owner: string; maxTokens?: number; reads: KnowledgeRead[]; origin: "trace" | "search"; fragmented: boolean; frozen: FrozenListing };
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
    };
    for (const key of ["itemBudget", "toolCallBudget", "toolResultBudget", "tool", "versions", "category", "scope", "fields"] as const) {
      const same = key === "fields" ? JSON.stringify(frozen.fields) === JSON.stringify(saved?.frozen.fields)
        : frozen[key] === saved?.frozen[key];
      if (saved && !same) throw new Error(`cursor ${key} is frozen; omit it or use the original value`);
    }
    const cap = options.cap ?? saved?.cap ?? 100;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("listing cap must be a positive integer");
    if (saved && cap !== saved.cap) throw new Error("cursor cap is frozen; omit it or use the original value");
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
    const cursor = randomUUID();
    const fragmentNote = "Hit continues on next page; concatenate without a newline.";
    const output = (lines: string[], more: boolean, fragment = false) => finish({ content: lines.join("\n"),
      receipts: [...(footer ? [footer] : []), ...(fragment ? [fragmentNote] : []), ...(more ? [`cursor=${cursor}`] : [])] });
    const fits = (lines: string[], more: boolean, fragment = false) => maxTokens === undefined || tokens(output(lines, more, fragment)) <= maxTokens;
    // Alternating letters/digits bound the UUID's estimate, so an admitted tiny budget still
    // permits progress when the next page generates a more expensive cursor spelling.
    const minimum = output(["😀"], true, true).replace(cursor, "a1a1a1a1-a1a1-4a1a-a1a1-a1a1a1a1a1a1");
    if (maxTokens !== undefined && tokens(minimum) > maxTokens) throw new Error("listing maxTokens is too small for pagination hints and content");
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
      // Probe near the page size, not halfway through a potentially megabyte-long remainder.
      // Measuring the whole suffix on EVERY page makes a large single line quadratic to drain.
      // Price only valid code-point prefixes too: a dangling surrogate can change the estimator's
      // script classification (notably a pure emoji run), making an unsafe cut look much cheaper.
      const prefix = (end: number) => line.slice(0, end > 0 && /[\uD800-\uDBFF]/.test(line[end - 1]!)
        && /[\uDC00-\uDFFF]/.test(line[end] ?? "") ? end - 1 : end);
      let low = 0, high = Math.min(256, line.length);
      while (high < line.length && fits([...lines, prefix(high)], true, true)) {
        low = high; high = Math.min(line.length, high * 2);
      }
      if (high === line.length && fits([...lines, line], more)) { lines.push(pending.shift()!); fragmented = false; continue; }
      // Prefer a whole line on the next page to splitting into this page's spare space.
      if (lines.length) break;
      // Keep the suffix in the SAME pending queue, at code-point boundaries. Escaped text is
      // transported verbatim: fragments must be concatenated before interpreting JSON escapes.
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits([prefix(mid)], true, true)) low = mid; else high = mid - 1;
      }
      const kept = prefix(low);
      if (!kept || !fits([kept], true, true)) throw new Error("listing maxTokens is too small for this hit and pagination hints");
      lines.push(kept); pending[0] = line.slice(kept.length); fragment = true; fragmented = true;
      break;
    }
    const more = pending.length > 0 || at < items.length;
    const result = output(lines, more, fragment);
    if (maxTokens !== undefined && tokens(result) > maxTokens) throw new Error("listing maxTokens is too small for pagination hints");
    // Snapshot and validate first: a rejected request must leave the input cursor usable.
    const remainder = more ? saved ? { ...saved, offset: at, pending, fragmented }
      : capture ? { items: capture(items.slice(at)), offset: 0, pending, format, footer, cap, owner, maxTokens, reads, origin, fragmented, frozen }
      : { items, offset: at, pending, format, footer, cap, owner, maxTokens, reads, origin, fragmented, frozen } : undefined;
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
  // Both read one mutable annotation of an otherwise immutable record. A caller that froze it at
  // query time (22c) supplies it; everyone else reads it now, exactly as before.
  const factLine = (id: number, relations: readonly FactRelation[] = store.listFactRelations(id)) => renderFact(store.getFact(id)!, [...relations]);
  const factGroups = (facts: Fact[], relations = store.listFactRelationsOf(facts.map(fact => fact.id))) =>
    renderFactGroups(facts, f => factLine(f.id, relations.get(f.id) ?? []), store.factTurnTimes(facts));
  const knowledgeLine = (value: KnowledgeWithRevision, marks: readonly KnowledgeMark[] = store.listKnowledgeMarks(value.knowledge.id)) =>
    renderKnowledge(value, [...marks]);
  // The knowledge part of the shared material contract (20a): the applicable commits at one node,
  // under the existing scope and commit-graph rules. Its block layout lives in core/render/material.ts.
  const applicable = (projectId: number, sessionId = 0, headTurnId?: number | null, branch?: string) =>
    store.listVisibleKnowledge(sessionId, projectId, headTurnId, branch);
  /** Ticket 34c: one evidence-aware Knowledge-only predicate at every ordinary foreground prompt.
   * One path snapshot and one graph resolve applicability, visible historical bodies, current exact
   * results and state changes. Exact Fact bodies or proven complete source-entry bindings may suppress
   * a nonempty current support list; empty and partial evidence never do. */
  const injection = (target: number | { projectId: number } | KnowledgePath, visible: VisibleView = noVisibility()): Injection => {
    const empty = (): Injection => ({ text: "", knowledgeCommitIds: [] });
    const knowledgeCap = store.knowledgeBudgets().injection;
    const id = typeof target === "number" ? target : "sessionId" in target ? target.sessionId : undefined;
    if (id !== undefined && !store.enabled(id)) return empty();
    const projectId = id === undefined ? (target as { projectId: number }).projectId : session(id).projectId;
    if (!store.getProject(projectId)) throw new Error(`project ${projectId} does not exist`);
    const path = id === undefined ? null : typeof target === "object" && "sessionId" in target
      ? target : store.knowledgePath(id);
    const snapshot = path ? store.pathSnapshot(path) : null;
    const input = store.commitGraphInput();
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
      && !state.revisions.every(covered));
    if (!delta.length && !states.length) return empty();

    // Historical applicable bodies still retained in context spend the same configured allowance.
    // Re-render one coherent visible view with the same category/status framing; do not sum stored
    // body bytes, averages or candidate counts. Existing acknowledged notices are charged too.
    const marks = store.listKnowledgeMarksOf([...visibleBodies, ...delta].map(item => item.revision.id));
    const line = (value: KnowledgeWithRevision) => renderKnowledge(value, marks.get(value.revision.id) ?? []);
    const visibleKnowledge = budgetKnowledge(visibleBodies, Infinity, line);
    const byRevision = new Map(graph.revisions.map(revision => [revision.id, revision]));
    const acknowledgedStateTexts = [...(visible.knowledgeStates ?? new Set())].flatMap(key => {
      const [fromText, toText = ""] = key.split(">");
      const from = byRevision.get(Number(fromText));
      const successors = toText.split(",").filter(Boolean).map(id => byRevision.get(Number(id))).filter((value): value is KnowledgeRevision => !!value);
      return from && successors.length && graph.applicable.has(from.id) && successors.every(value => graph.applicable.has(value.id))
        ? [knowledgeStateText(from, successors)] : [];
    });
    const visibleText = injectionText({ knowledge: visibleKnowledge.groups, receipts: [] }, acknowledgedStateTexts);
    const remaining = knowledgeCap - tokens(visibleText);
    if (remaining <= 0) return empty();

    // Foreground publication has no omission receipts. State transitions retain their established
    // order ahead of bodies, but each notice is one complete budget item: an unfit later notice does
    // not erase an already fitting prefix or permit lower-priority bodies to skip past it.
    const ordered = budgetKnowledge(delta, Infinity, line).commits;
    const byCommit = new Map(delta.map(value => [value.revision.id, value]));
    const build = (stateCount: number, bodyCount: number) => {
      const knowledge = budgetKnowledge(ordered.slice(0, bodyCount).map(id => byCommit.get(id)!), Infinity, line).groups;
      const material = { knowledge, receipts: [] as string[] };
      return { material, text: injectionText(material, states.slice(0, stateCount).map(state => state.text)) };
    };
    const longest = (high: number, fits: (count: number) => boolean) => {
      let low = 0;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (fits(middle)) low = middle; else high = middle - 1;
      }
      return low;
    };
    const stateCount = longest(states.length, count => tokens(build(count, 0).text) <= remaining);
    if (stateCount < states.length) {
      if (!stateCount) return empty();
      const { material, text } = build(stateCount, 0);
      const rendered = measuredMemory(text, material);
      return { ...rendered, knowledgeCommitIds: [], knowledgeStates: states.slice(0, stateCount).map(state => state.receipt) };
    }
    const bodyCount = longest(ordered.length, count => tokens(build(stateCount, count).text) <= remaining);
    const { material, text } = build(stateCount, bodyCount);
    const commits = ordered.slice(0, bodyCount), selectedStates = states.slice(0, stateCount);
    if (tokens(text) > remaining || (!commits.length && !selectedStates.length)) return empty();
    const rendered = measuredMemory(text, material);
    return { ...rendered, knowledgeCommitIds: commits,
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
          const marks = store.listKnowledgeMarksOf(revisions.map(r => r.id));
          const records = store.knowledgeRecords(revisions.map(r => r.knowledgeId));
          const fields = new Set(options.fields!);
          const knowledge = revisions.map(revision => {
            const parents = (selection.input.parents.get(revision.id) ?? []).map(id => selection.byCommit.get(id)!);
            const children = selection.graph.revisions.filter(r => selection.input.parents.get(r.id)?.includes(revision.id));
            const grounds = [...store.revisionGrounds(revision)].sort((a, b) => a - b);
            const status = selection.status(revision);
            return () => renderKnowledgeTrace({ knowledge: records.get(revision.knowledgeId)!, revision }, marks.get(revision.id) ?? [],
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
    const totals = { runs: { noting: 0, consolidation: 0, dreaming: 0, manual: 0 }, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const { kind, usage } of store.listRunUsage(sessionId)) {
      totals.runs[kind]++;
      if (!usage) continue;
      totals.input += usage.input; totals.output += usage.output;
      totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite; totals.cost += usage.cost;
    }
    return totals;
  };
  /** Footer progress/applicability numbers for one session's selected branch and head, answered from
   * one path snapshot (22a), the pending-entry identities (22b), and one exact-version processed lookup.
   *
   * - `entries`: imported source entries of this path that no Noting run has committed yet. The
   *   `noted_entries` rows a run writes inside its business transaction are what removes an entry
   *   here, so an admitted, running, failed or cancelled batch is still pending, and a provider
   *   failure after the commit restores nothing.
   * - `facts`: every committed fact applicable on this path, the ones already consolidated included.
   * - `unconsolidated`: those of them Consolidation still owes work for — the same exact membership
   *   `consolidationBatch` selects, never `facts` minus the cited ones.
   * - `knowledge`: the applicable current knowledge, in `listCurrentKnowledge`'s own counting unit,
   *   so two divergent tips of one identity count as the two versions they are. `unprocessedKnowledge`
   *   and `processedKnowledge` partition those exact current versions; archives and superseded
   *   versions are absent because `listCurrentKnowledge` already excluded them.
   *
   * Nothing here loads a Raw payload, renders or tokenizes, freezes a task, reads a run's audit body,
   * or scans the processed history. The snapshot is built for this one read and dropped with it, so
   * another connection's commits are seen by the next call. The branch defaults to `main`, so a
   * caller without a host path still asks about a named branch rather than about Turn-only membership. */
  const progress = (sessionId: number, branch = "main", headTurnId?: number | null) => {
    session(sessionId);
    const path = store.knowledgePath(sessionId, branch, headTurnId);
    const snapshot = store.pathSnapshot(path);
    const facts = store.listBranchFacts(sessionId, branch, path.headTurnId, snapshot);
    const knowledge = store.listCurrentKnowledge(path, {}, snapshot);
    const processedKnowledge = store.processedKnowledgeVersions(knowledge.map(value => value.revision.id)).size;
    return {
      // No head means no Turn on this path, so nothing of it has been imported: the enumeration's
      // own answer, not a placeholder for one it could not compute.
      entries: path.headTurnId == null ? 0 : store.pendingEntryIds(sessionId, branch, path.headTurnId, snapshot).length,
      facts: facts.length,
      unconsolidated: store.unconsolidated(facts, path, snapshot).length,
      knowledge: knowledge.length,
      unprocessedKnowledge: knowledge.length - processedKnowledge,
      processedKnowledge,
    };
  };
  return {
    spend,
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
    // One allocator: required exact versions/facts/Raw first, fixed bases plus shared required-only
    // overflow, then processed knowledge and Raw-first historical refill in each own base remainder.
    // No worker, processing mark or coverage persistence is performed by this synchronous render.
    compact: (sessionId: number, branch = "main", headTurnId?: number, retainedView: readonly string[] | VisibleView = []): CompactResult => {
      if (!store.enabled(sessionId)) return { text: "", supplied: { entries: [], factIds: [], knowledgeCommitIds: [] } };
      const path = store.knowledgePath(sessionId, branch, headTurnId);
      const snapshot = store.pathSnapshot(path); // one membership for this operation, knowledge and facts alike
      const head = headTurnId ?? store.listTurns(sessionId).at(-1)?.id;
      // Freeze a read snapshot: the path's source entries and its facts, split into what must be
      // represented and what may refill the spare. The rendering below reads these same sets.
      const sourced = head === undefined ? [] : store.sourcePath(sessionId, branch, head);
      const pending = head === undefined ? [] : store.pendingEntries(sessionId, branch, head);
      const knowledge = store.listCurrentKnowledge(path, {}, snapshot);
      const requiredCommits = new Set(knowledge.filter(k => !store.isKnowledgeProcessed(k.revision.id)).map(k => k.revision.id));
      const visible = Array.isArray(retainedView) ? noVisibility() : retainedView as VisibleView;
      const retained = new Set(Array.isArray(retainedView) ? retainedView : visible.raw.keys());
      // Archives remain real immediately, but unprocessed retirement must retain its accounting.
      // Reuse the applicable graph (including archives), never the active-only knowledge list.
      const archives = store.commitGraph(path, undefined, snapshot).current.filter(r => r.op === "archive" && !store.isKnowledgeProcessed(r.id));
      const notes = [...knowledgeStatusNotes(store, knowledge, visible.knowledgeCommitIds, path),
        ...archives.map(r => `K${r.knowledgeId}@${r.id} archived; maintenance not completed; parent K${r.knowledgeId}@${r.parentId}; supports: ${r.supports.map(id => `F${id}`).join(", ") || "none"}; reason: ${r.reason}`)];
      const noteCost = notes.length ? charge([KNOWLEDGE_STATUS_TITLE, ...notes]) : 0;
      // 26 amendment 2: the facts are the ones applicable on the selected path, never the whole
      // session's — a sibling branch's fact is not history here. `listSessionFacts`'s freshness order
      // is what the refill selects by, so it is filtered, not replaced by `listBranchFacts`.
      const applicable = store.listSessionFacts(sessionId).filter(f => store.factOnPath(f, path, snapshot));
      const pendingFacts = store.unconsolidated(applicable, path, snapshot);
      const pendingFactIds = new Set(pendingFacts.map(f => f.id));
      // Optional facts candidates: the already-consolidated facts of the path, deduplicated against the
      // pending ones by construction, still in the freshness order the selection wants.
      let consolidated = applicable.filter(f => !pendingFactIds.has(f.id) && !visible.factIds.has(f.id));
      const factTurns = store.factTurnTimes(applicable);
      // Optional Raw candidates: the already-extracted entries of the path — the path minus what is
      // still pending — minus what the post-compaction context retains, so nothing is supplied twice.
      // An entry whose only earlier visibility was the summary this compaction discards is NOT
      // excluded on that account (30 case 10): the exclusions are these two and no other.
      const pendingIds = new Set(pending.map(e => e.id));
      const extracted = sourced.filter(e => !pendingIds.has(e.id) && !retained.has(e.nativeId));
      const caps = { knowledge: store.knowledgeBudgets().injection, facts: config.compaction.factsTokens, raw: config.compaction.rawTokens };
      const envelope = caps.knowledge + caps.facts + caps.raw + config.compaction.overflowTokens;
      if (!Number.isSafeInteger(envelope)) throw new Error("derived compact envelope must be a safe integer");
      // Every emitted component is charged inside the window that owns it: the `<episodic>` tag and
      // the facts title with the facts, the Raw title with the Raw, each block's omission receipts
      // with their own block. The `Receipts:` heading `finish` emits is charged to each window that
      // has a receipt, which over-counts safely (the same rule `budgetMaterial` applies).
      const factRelations = store.listFactRelationsOnPathOf(applicable.map(fact => fact.id), path, snapshot);
      const lines = (facts: Fact[]) => renderFactGroups(facts, f => factLine(f.id, factRelations.get(f.id) ?? []), factTurns);
      const factsCharge = (facts: Fact[], receipts: string[]) => charge([xmlBlock("episodic", ""), FACTS_TITLE])
        + charge(lines(facts)) + (receipts.length ? charge(receipts) + charge(["Receipts:"]) : 0);
      const rawCharge = (contents: string[]) => charge([RAW_TITLE]) + charge(contents);
      // The one bounded view of every pending entry (30). A view that cannot hold its own labels is a
      // capacity failure of the profile, and the delegation below says so rather than hiding the
      // entry. Any other rendering error is a data error and is reported (review 2026-09-08).
      const view = (entry: SourceEntry) => renderEntry(entry, config.render, resultText);
      let views: EntryView[] | undefined;
      try { views = pending.map(view); }
      catch (error) { if (!/capacity/.test(String(error))) throw error; }
      if (!views) return { native: true, reason: `bounded views of ${pending.length} pending entries exceed the entry view profile `
        + `(E ${config.render.entryTokens}, C ${config.render.toolInputTokens}, R ${config.render.toolResultTokens} tokens): their labels and omission markers do not fit it` };
      const requiredFacts = factsCharge(pendingFacts, []), requiredRaw = rawCharge(views.map(v => v.content));
      const requiredKnowledge = budgetKnowledge(knowledge.filter(k => requiredCommits.has(k.revision.id)), Infinity, knowledgeLine).cost + noteCost;
      const excess = { knowledge: Math.max(0, requiredKnowledge - caps.knowledge),
        facts: Math.max(0, requiredFacts - caps.facts), raw: Math.max(0, requiredRaw - caps.raw) };
      const totalExcess = excess.knowledge + excess.facts + excess.raw;
      if (totalExcess > config.compaction.overflowTokens) return { native: true,
        over: { knowledge: excess.knowledge > 0, facts: excess.facts > 0, raw: excess.raw > 0 },
        reason: `required material exceeds shared overflow: knowledge ${requiredKnowledge} tokens (excess ${excess.knowledge}, database Knowledge injection capacity ${caps.knowledge}); `
          + `${pendingFacts.length} pending facts need ${requiredFacts} tokens (excess ${excess.facts}, compaction.factsTokens ${caps.facts}); `
          + `bounded views of ${pending.length} pending entries need ${requiredRaw} tokens (excess ${excess.raw}, compaction.rawTokens ${caps.raw}); `
          + `shared allowance ${config.compaction.overflowTokens}, charged excess ${totalExcess}, shortfall ${totalExcess - config.compaction.overflowTokens}` };
      const active = budgetKnowledge(knowledge, Math.max(caps.knowledge, requiredKnowledge) - noteCost,
        knowledgeLine, "database Knowledge injection capacity", requiredCommits);
      // Raw first, independently of facts' spare. The discarded summary is not retained coverage.
      let rawSpare = Math.max(0, caps.raw - requiredRaw);
      const refilledRaw: { entry: SourceEntry; content: string }[] = [];
      for (const entry of [...extracted].reverse()) {
        let content: string;
        try { content = view(entry).content; } catch (error) { if (/capacity/.test(String(error))) continue; throw error; }
        if (tokens(content) + 1 > rawSpare) break;
        refilledRaw.push({ entry, content }); rawSpare -= tokens(content) + 1;
      }
      const coverage = new Set([...sourced.filter(e => retained.has(e.nativeId)).map(e => e.id),
        ...pendingIds, ...refilledRaw.map(s => s.entry.id)]);
      const coveredFacts = store.factsCoveredByRaw(consolidated, coverage);
      consolidated = consolidated.filter(f => !coveredFacts.has(f.id));
      const spare = Math.max(0, caps.facts - requiredFacts);
      // Refill (a): whole facts, freshness order, into the spare, charged to the facts window and the
      // envelope. The receipt for what is left out is charged with them; when even that receipt does
      // not fit, the refill is empty and silent — optional material may be omitted, never overspent.
      const omission = (rest: Fact[]) => rest.length ? [`omitted ${rest.length} older facts; expand: ${expandList(rest.map(f => `F${f.id}`))}`] : [];
      let refilledFacts: Fact[] = [], factReceipts = omission(consolidated);
      if (factsCharge(pendingFacts, factReceipts) - requiredFacts > spare) factReceipts = [];
      else for (const fact of consolidated) {
        const next = [...refilledFacts, fact], receipts = omission(consolidated.slice(next.length));
        if (factsCharge([...pendingFacts, ...next], receipts) - requiredFacts > spare) break;
        refilledFacts = next; factReceipts = receipts;
      }
      const facts = [...pendingFacts, ...refilledFacts];
      // Displayed in source order, pending and refilled alike (30: "display the selected Raw entries
      // in source order"; no new relevance ranking).
      const order = new Map(sourced.map((entry, index) => [entry.id, index]));
      const supplied = [...pending.map((entry, index) => ({ entry, content: views![index]!.content })), ...refilledRaw]
        .sort((a, b) => order.get(a.entry.id)! - order.get(b.entry.id)!);
      const material = { knowledge: active.groups, facts: lines(facts),
        entries: supplied.map(s => ({ id: s.entry.id, view: s.content })),
        receipts: [...views.flatMap(v => v.receipts), ...factReceipts, ...active.receipts] };
      return { ...measuredMemory(compactText(material, RAW_TITLE, notes), material),
        // 29a "Renderers return what they kept": exactly the identities this replacement carries,
        // pending and refilled alike. What a budget left out is absent here (28a item 7).
        supplied: { entries: supplied.map(s => ({ id: s.entry.id, nativeId: s.entry.nativeId, view: "bounded" as const })),
          factIds: facts.map(f => f.id), knowledgeCommitIds: active.commits },
        // 28a item 6: the per-window accounting beside the text, for the acceptance probe and for
        // 28b's recovery decision. It is diagnostics, not a second outcome.
        charged: { knowledge: active.cost + noteCost, facts: factsCharge(facts, factReceipts), raw: rawCharge(supplied.map(s => s.content)),
          envelope, required: { knowledge: requiredKnowledge, facts: requiredFacts, raw: requiredRaw } } };
    },
    branchSummary: (sessionId: number, branch: string, headTurnId: number): string => {
      if (!store.enabled(sessionId)) return "";
      // Carry is optional, unlike compact's required pending Raw. Consider the whole pending set,
      // not Noting's next batch, and keep a newest whole suffix under the shared view profile.
      // Charge the Raw title, separators and omission receipt too; even the newest entry may not fit.
      const title = "Pending raw:";
      const pending = store.pendingEntries(sessionId, branch, headTurnId).map(e => renderEntry(e, config.render, resultText));
      const costs = pending.map(view => charge([view.content, ...view.receipts]));
      let omitted = 0, used = charge([title]) + costs.reduce((sum, cost) => sum + cost, 0);
      const receipt = () => omitted ? [`[... ${omitted} earlier pending entries omitted from the carry budget; read them with trace]`] : [];
      while (used + charge(receipt()) > config.render.episodicBlockTokens && omitted < pending.length)
        used -= costs[omitted++]!;
      if (used + charge(receipt()) > config.render.episodicBlockTokens)
        throw new Error(`Branch carry capacity: Raw framing and omission receipt exceed render.episodicBlockTokens (${config.render.episodicBlockTokens})`);
      const raw = pending.slice(omitted);
      const path = { sessionId, headTurnId, branch }, snapshot = store.pathSnapshot(path); // one membership for facts and commits alike
      const facts = store.listSessionFacts(sessionId).filter(f => store.factOnPath(f, path, snapshot)).sort((a, b) => a.id - b.id);
      const factIds = new Set(facts.map(f => f.id));
      const commits = store.listKnowledgeRevisions().filter(r => store.commitApplies(r, path, snapshot) &&
        r.supports.some(id => factIds.has(id)))
        .map(revision => ({ knowledge: store.getKnowledge(revision.knowledgeId)!, revision }));
      const relations = store.listFactRelationsOnPathOf(facts.map(fact => fact.id), path, snapshot);
      const content = ["this is knowledge from another branch; it must not be written as facts; the Noter's facts come only from the current branch's conversation, never from messages this plugin injected.",
        "Facts:", ...factGroups(facts, relations), "Commits (by evidence):", ...commits.map((c) => knowledgeLine(c)),
        title, ...raw.map(r => r.content), ...raw.flatMap(r => r.receipts), ...receipt()].join("\n");
      return xmlBlock("branch_carry", content); // Tags delimit; content stays byte-identical to shared trace lines.
    },
    search: (query: string, requestedScope?: SearchScope, input: ListingOptions & { sessionId?: number } = {}): string => {
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
      let addresses = store.searchAddresses(query, scope, sessionIds);
      // 22c: the path, applicable set, tips and ancestry are resolved once. Filtering happens over
      // that same graph before paging, so a page spends no budget on a status the query excluded.
      const selection = addresses.some(a => a.startsWith("K")) ? knowledgeReadSelection(store, options) : null;
      const graphInput = selection?.input;
      const graph = selection?.graph;
      const byCommit = selection?.byCommit ?? new Map<number, KnowledgeRevision>();
      const children = new Map<number, KnowledgeRevision[]>();
      for (const revision of graph?.revisions ?? []) for (const parent of graphInput!.parents.get(revision.id) ?? [])
        children.set(parent, [...(children.get(parent) ?? []), revision]);
      const revision = (address: string) => byCommit.get(Number(address.split("@")[1]))!;
      const fields = new Set(options.fields!.filter(field => field !== "reason"
        || ((scope === "knowledge" || scope === "all") && options.versions !== "current")));
      const selected = new Set(selection?.representatives(addresses.filter(a => a.startsWith("K")).map(revision), query).map(r => r.id));
      addresses = addresses.filter(address => !address.startsWith("K") || selected.has(revision(address).id));
      // The graph freezes what a hit is; this freezes mutable annotations and Raw membership for
      // deferred pages. No open transaction survives the first page.
      const capture = (deferred: readonly unknown[]): FrozenHit[] => {
        const rest = deferred as string[];
        const record = (address: string) => Number(address.slice(1)), commitOf = (address: string) => Number(address.split("@")[1]);
        const ids = (prefix: string, of: (address: string) => number) => rest.filter(a => a.startsWith(prefix)).map(of);
        const marks = store.listKnowledgeMarksOf(ids("K", commitOf));
        const entries = store.listSourceEntryIdsOf(ids("T", record));
        return rest.map(address => address.startsWith("F") ? { address }
          : address.startsWith("T") ? { address, entryIds: entries.get(record(address))!, profile: { entryTokens: config.render.entryTokens, toolInputTokens: config.render.toolInputTokens, toolResultTokens: config.render.toolResultTokens } }
          : { address, marks: marks.get(commitOf(address))! });
      };
      const format = (hits: readonly unknown[]) => (hits as (string | FrozenHit)[]).map((item) => {
        const frozen: FrozenHit | undefined = typeof item === "string" ? undefined : item;
        const address = frozen?.address ?? item as string;
        if (address.startsWith("F")) return renderFactPreview(store.getFact(Number(address.slice(1)))!, fields, options.itemBudget === null ? Infinity : options.itemBudget!);
        if (address.startsWith("T")) return expand(address, frozen && { entryIds: frozen.entryIds, profile: frozen.profile });
        const [id, commit] = address.slice(1).split("@").map(Number);
        const knowledge = store.getKnowledge(id!)!;
        const hit = revision(address);
        const status = selection!.status(hit);
        const parents = (graphInput!.parents.get(hit.id) ?? []).map(parent => byCommit.get(parent)!).filter(Boolean);
        return renderKnowledgePreview({ knowledge, revision: hit }, frozen?.marks ?? store.listKnowledgeMarks(id!), status, fields,
          options.itemBudget === null ? Infinity : options.itemBudget!, parents, children.get(hit.id) ?? []);
      }).map(listingLine);
      const material = options.scope === "session" ? "this session; session knowledge" : options.scope === "project"
        ? "project sessions; project knowledge" : options.scope === "global" ? "all sessions; global knowledge"
        : reader ? "project sessions; global/project/session knowledge" : "all sessions; unrestricted knowledge owners";
      const filters = [`searched: ${material}, ${options.versions} versions`, ...(options.category ? [`category=${options.category}`] : []), ...(options.scope ? [`scope=${options.scope}`] : [])].join(", ");
      const omitted = READ_FIELDS.filter(field => !fields.has(field));
      const preview = `preview: ${fields.size === 0 ? "identity only" : fields.size === 1 && fields.has("text") ? "text only" : `fields ${[...fields].join(", ")}`}; omitted fields: ${omitted.join(", ") || "none"}`;
      return page({ items: addresses, format, capture }, { ...options,
        maxTokens: options.pageBudget === null ? undefined : options.pageBudget ?? options.maxTokens ?? DEFAULT_READ_TOKENS },
        `Search uses literal substring search. No hit does not mean absent.\n${filters}\n${KNOWLEDGE_REPRESENTATIVE_RECEIPT}\n${preview}`, [], "search").text;
    },
    mark: (address: number | string, kind: "verified" | "flagged" | "clear", path?: KnowledgePath): string => {
      if (!["verified", "flagged", "clear"].includes(kind)) throw new Error("invalid mark kind");
      const match = /^K([1-9]\d*)(?:@([1-9]\d*))?$/.exec(typeof address === "number" ? `K${address}` : address);
      if (!match) throw new Error("invalid knowledge address");
      const id = Number(match[1]);
      if (!store.getKnowledge(id) || (match[2] && !store.getKnowledgeRevision(id, Number(match[2])))) throw new Error(`address does not exist: ${address}`);
      const tips = match[2] ? [store.getKnowledgeRevision(id, Number(match[2]))].filter(r => r !== null) : store.currentCommit(id, path ?? null);
      if (tips.length !== 1) throw new Error(`K${id}: ${tips.length ? "several tips; specify a commit" : "no current commit"}`);
      const commitId = store.mark(tips[0]!.id, kind, new Date().toISOString());
      return `K${id}@${commitId}: ${kind}`;
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
