import { randomUUID } from "node:crypto";
import type { TraceMemoryConfig } from "./index.ts";
import type { Store, KnowledgeWithRevision, KnowledgePath, SourceEntry } from "../store/index.ts";
import type { Fact, FactRelation, KnowledgeMark, KnowledgeRevision } from "../model/index.ts";
import { budgetKnowledge, charge, expandList, tokens, finish, listingLine, renderKnowledge, renderFact, renderFactGroups, renderEntry, rawResultText, xmlBlock, type EntryView, type ResultExtractor, type EntryProfile } from "../render/index.ts";
import { budgetMaterial, injectionText, compactText, FACTS_TITLE, RAW_TITLE } from "../render/material.ts";
import { noVisibility, type SuppliedMaterial, type VisibleView } from "./visible.ts";

/** `sessionId`, `headTurnId` and `branch` are the reader's own path, supplied by the host or by a
 * run's tool binding, never by the model: they decide which knowledge a label is judged against and,
 * since 23b, which of a Turn's native occurrences an assembled `trace` shows. An unbound read is
 * unrestricted, as it always was. A Turn's occurrences are selected by `branch`, or — when a paged
 * read froze them at query time (22c) — by the `entryIds` that query kept; like the path, neither is
 * reachable from a model's tool arguments. */
export interface ListingOptions { maxTokens?: number; cap?: number; cursor?: string; tool?: number; full?: boolean; sessionId?: number; headTurnId?: number | null; branch?: string; entryIds?: readonly number[]; profile?: EntryProfile }
export const DEFAULT_SEARCH_TOKENS = 2000;
/** Exact versions resolved by a named K read; bare reads replace that identity's prior bases. */
export interface KnowledgeRead { knowledgeId: number; commits: number[]; replace: boolean }
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
 * compaction run, with the reason it could not be avoided: which required window overflowed after
 * lending, and by how much. There is no third outcome: compact never trims a pending window to make
 * the block fit, and core never summarizes with a model.
 *
 * 29a "Renderers return what they kept": beside the replacement text, the identities it actually
 * carries — every supplied entry, pending and refilled alike, plus the facts and knowledge commits
 * that survived budgeting. What a budget dropped is absent here. A native delegation supplies
 * nothing, so it has no `supplied` at all. */
export type CompactResult = { text: string; supplied: SuppliedMaterial; charged?: ChargedWindows }
  /** 28b: `over` says which required window overflowed, so the host's bounded recovery can decide
   * which phase to run without reading the prose of `reason`. It is present exactly when a required
   * window is over after lending — the one condition recovery can act on. A delegation for any other
   * reason (an entry whose minima exceed the view profile, a store error the host caught) carries
   * none, and recovery starts nothing for it. */
  | { native: true; reason: string; over?: { facts: boolean; raw: boolean } };

/** 28a item 6: what one custom replacement charged, window by window, beside the text it produced.
 * Diagnostics — the outcome is still the custom replacement or the native delegation, and nothing
 * reads this to decide between them. `envelope` is the sum of the three baselines, the ceiling the
 * three charges together may never exceed. */
export interface ChargedWindows { knowledge: number; facts: number; raw: number; envelope: number;
  /** What the required material alone charges — the pending facts and the pending Raw with their
   * framing, before either refill. `facts`/`raw` above minus these is what the refills took. */
  required: { facts: number; raw: number } }
/** 29a: the initial knowledge block and the exact commits it carries. */
export interface Injection { text: string; knowledgeCommitIds: number[] }

/** 22c "complete snapshot": one search hit whose formatting the query deferred to a later page, with
 * the mutable state its line would otherwise read from the database then. Everything else a hit
 * prints — the fact and commit records, the path, the labels the commit graph decided — is immutable
 * or already frozen by the query, so these three annotations are the whole remainder. */
interface FrozenHit { address: string; relations?: FactRelation[]; marks?: KnowledgeMark[]; entryIds?: number[]; profile?: EntryProfile }

/** One component of a `trace` comma list, in request order: either a fact an interval selected —
 * rendered when a page asks for it, from the relations the query froze — or text a named component
 * already resolved at query time. */
type TraceUnit = { fact: number; relations?: FactRelation[] } | { text: string };

/** Parent 29 "Version-aware knowledge" (29b): one line per commit the reader's context already holds
 * that is not among the current applicable commits here — superseded, archived or merged away. The
 * block beside these lines carries only what is current, so without them stale visible text would
 * read as current knowledge. Ticket 31 made this shared: the Consolidator's material and the main
 * agent's knowledge block are one selection, and neither may explain a stale commit differently.
 * The full revision read happens only when there is a stale commit to explain. */
export function knowledgeStatusNotes(store: Store, current: readonly KnowledgeWithRevision[], visible: Iterable<number>,
  path: KnowledgePath | null, projectId?: number): string[] {
  const currentCommits = new Set(current.map(k => k.revision.id));
  const stale = [...visible].filter(id => !currentCommits.has(id));
  if (!stale.length) return [];
  const graph = store.commitGraph(path, projectId);
  const byCommit = new Map(graph.revisions.map(r => [r.id, r]));
  return stale.flatMap(id => {
    const revision = byCommit.get(id);
    if (!revision) return []; // another database's id cannot reach here (the carrier binding), and an unknown one explains nothing
    const descendants = graph.descendants(id);
    const successors = graph.current.filter(r => r.id !== id && descendants.has(r.id));
    const label = `K${revision.knowledgeId}@${id} is `;
    if (!successors.length) return [label + "no longer current on this path"];
    return successors.map(successor => label + (successor.op === "archive" ? "archived"
      : successor.op === "merge" || successor.knowledgeId !== revision.knowledgeId ? `merged into K${successor.knowledgeId}@${successor.id}`
      : `superseded by K${successor.knowledgeId}@${successor.id} above`));
  });
}

export function readFacade(store: Store, config: TraceMemoryConfig, expand: (address: string, options?: ListingOptions, reads?: KnowledgeRead[]) => string,
  resultText: ResultExtractor = rawResultText) {
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
   * crossed the page edge — `cap` counts output lines. Search also freezes `maxTokens`; an
   * oversized line leaves its unsent suffix in the same queue, without a second fragment cache.
   * `reads` carries only named trace-origin K versions; search leaves it empty. Completion belongs
   * to the whole requested expression, not a rendered child or an unconsumed/evicted remainder. */
  type Remainder = Continuation & { offset: number; pending: readonly string[]; footer: string; cap: number; owner: string; maxTokens?: number; reads: KnowledgeRead[] };
  // A model asks for page one and usually never asks for page two, so a continuation is a cache
  // entry, not an obligation: the least recently used one is dropped once this many are outstanding,
  // and the reader meets the "unknown or expired cursor" error that an unknown cursor always met.
  // A count bound needs no clock and no timer; add an age bound only if a single query's remainder
  // ever becomes large enough that sixteen of them matter.
  const CURSORS = 16;
  const cursors = new Map<string, Remainder>();
  const page = (source: string[] | Continuation, options: ListingOptions = {}, footer = "", reads: KnowledgeRead[] = []): TraceRead => {
    const owner = options.sessionId === undefined ? "unbound" : `${options.sessionId}:${store.getSession(options.sessionId)?.projectId}`;
    const saved = options.cursor ? cursors.get(options.cursor) : undefined;
    if (options.cursor && (!saved || saved.owner !== owner)) throw new Error("unknown or expired cursor");
    const cap = options.cap ?? saved?.cap ?? 100;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("listing cap must be a positive integer");
    const { items, format, capture } = saved ?? (Array.isArray(source)
      ? { items: source, format: (lines: readonly unknown[]) => lines as string[], capture: undefined } : source);
    if (saved) { footer = saved.footer; reads = saved.reads; }
    if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1))
      throw new Error("search maxTokens must be a positive safe integer");
    if (saved && options.maxTokens !== undefined && options.maxTokens !== saved.maxTokens)
      throw new Error("cursor maxTokens is frozen; omit it or use the original budget");
    const maxTokens = saved?.maxTokens ?? options.maxTokens;
    const cursor = randomUUID();
    const fragmentNote = "Hit continues on next page; concatenate without a newline.";
    const output = (lines: string[], more: boolean, fragment = false) => finish({ content: lines.join("\n"),
      receipts: [...(footer ? [footer] : []), ...(fragment ? [fragmentNote] : []), ...(more ? [`cursor=${cursor}`] : [])] });
    const fits = (lines: string[], more: boolean, fragment = false) => maxTokens === undefined || tokens(output(lines, more, fragment)) <= maxTokens;
    // Alternating letters/digits bound the UUID's estimate, so an admitted tiny budget still
    // permits progress when the next page generates a more expensive cursor spelling.
    const minimum = output(["😀"], true, true).replace(cursor, "a1a1a1a1-a1a1-4a1a-a1a1-a1a1a1a1a1a1");
    if (maxTokens !== undefined && tokens(minimum) > maxTokens) throw new Error("search maxTokens is too small for pagination hints and content");
    const lines: string[] = [], pending = [...(saved?.pending ?? [])];
    let at = saved?.offset ?? 0, fragment = false;
    while (lines.length < cap && (pending.length || at < items.length)) {
      // One-hit lookahead only. Unrendered hits retain the existing frozen identity snapshot.
      if (!pending.length) pending.push(...format([items[at++]]));
      if (!pending.length) continue;
      const line = pending[0]!;
      const more = pending.length > 1 || at < items.length;
      if (maxTokens === undefined || fits([...lines, line], more)) { lines.push(pending.shift()!); continue; }
      // Prefer a whole hit on the next page to splitting it into the current page's spare space.
      if (lines.length) break;
      // Search lines can contain a whole Raw Turn. Keep the suffix in the SAME pending queue,
      // splitting only at code-point boundaries (never inside a UTF-16 surrogate pair).
      let low = 0, high = line.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (fits([line.slice(0, mid)], true, true)) low = mid; else high = mid - 1;
      }
      if (low > 0 && /[\uD800-\uDBFF]/.test(line[low - 1]!) && /[\uDC00-\uDFFF]/.test(line[low] ?? "")) low--;
      if (!low || !fits([line.slice(0, low)], true, true)) throw new Error("search maxTokens is too small for this hit and pagination hints");
      lines.push(line.slice(0, low)); pending[0] = line.slice(low); fragment = true;
      break;
    }
    const more = pending.length > 0 || at < items.length;
    const result = output(lines, more, fragment);
    if (maxTokens !== undefined && tokens(result) > maxTokens) throw new Error("search maxTokens is too small for pagination hints");
    // Snapshot and validate first: a rejected request must leave the input cursor usable.
    const remainder = more ? saved ? { ...saved, offset: at, pending }
      : capture ? { items: capture(items.slice(at)), offset: 0, pending, format, footer, cap, owner, maxTokens, reads }
      : { items, offset: at, pending, format, footer, cap, owner, maxTokens, reads } : undefined;
    if (options.cursor) cursors.delete(options.cursor);
    if (remainder) {
      cursors.set(cursor, remainder);
      for (const oldest of cursors.keys()) { if (cursors.size <= CURSORS) break; cursors.delete(oldest); }
    }
    return { text: result, completed: more ? [] : reads };
  };
  const session = (id: number) => {
    const value = store.getSession(id);
    if (!value) throw new Error(`session S${id} does not exist`);
    return value;
  };
  // Both read one mutable annotation of an otherwise immutable record. A caller that froze it at
  // query time (22c) supplies it; everyone else reads it now, exactly as before.
  const factLine = (id: number, relations: readonly FactRelation[] = store.listFactRelations(id)) => renderFact(store.getFact(id)!, [...relations]);
  const factGroups = (facts: Fact[]) => renderFactGroups(facts, f => factLine(f.id), store.factTurnTimes(facts));
  const knowledgeLine = (value: KnowledgeWithRevision, marks: readonly KnowledgeMark[] = store.listKnowledgeMarks(value.knowledge.id)) =>
    renderKnowledge(value, marks.filter((m) => m.commitId === value.revision.id));
  // The knowledge part of the shared material contract (20a): the applicable commits at one node,
  // under the existing scope and commit-graph rules. Its block layout lives in core/render/material.ts.
  const applicable = (projectId: number, sessionId = 0, headTurnId?: number | null, branch?: string) =>
    store.listVisibleKnowledge(sessionId, projectId, headTurnId, branch);
  /** Ticket 31 "One selection, two triggers": the ONE knowledge selection of the main agent — the
   * applicable commits at this node minus the ones the reader's context already holds, plus 29b's
   * status lines for the visible commits that are no longer current, budgeted and rendered as the
   * knowledge block has always been. 29d's initial injection and 31's supplement are this same call:
   * the initial trigger only ever fires on a context with no knowledge commits at all, so `visible`
   * is empty there, nothing is subtracted, no status line exists and the bytes are unchanged.
   *
   * 29a "Renderers return what they kept": the exact commit ids the block carries come back beside it,
   * so the host persists those identities on the message it injects instead of parsing them back out
   * of the rendered prose. `inject` is this same call read for its text alone. */
  const injection = (target: number | { projectId: number } | KnowledgePath, visible: VisibleView = noVisibility()): Injection => {
    const id = typeof target === "number" ? target : "sessionId" in target ? target.sessionId : undefined;
    if (id !== undefined && !store.enabled(id)) return { text: "", knowledgeCommitIds: [] };
    let current: KnowledgeWithRevision[];
    if (typeof target === "object" && "sessionId" in target) current = applicable(session(target.sessionId).projectId, target.sessionId, target.headTurnId, target.branch);
    else if (typeof target === "object") {
      // First prompt: no session id yet (allocated at the first reply), so no session knowledge.
      if (!store.getProject(target.projectId)) throw new Error(`project ${target.projectId} does not exist`);
      current = applicable(target.projectId);
    } else current = applicable(session(target).projectId, target);
    // 31 "What repeats and what does not": a commit visible at this exact version is never repeated
    // (a visible predecessor covers nothing), so the delta is empty exactly when every candidate is
    // visible; a commit a budget omitted, a newer revision and a commit a compaction did not keep are
    // all candidates again. The status lines are reserved out of the same allowance by `budgetMaterial`.
    const delta = current.filter(({ revision }) => !visible.knowledgeCommitIds.has(revision.id));
    // An empty delta is no block at all, exactly as an empty applicable set always was. The status
    // lines annotate a block; they never become one on their own, or a re-enable with nothing new
    // would keep restating what a superseded commit became (31 "What repeats and what does not").
    if (!delta.length) return { text: "", knowledgeCommitIds: [] };
    const path = id === undefined ? null : typeof target === "object" && "sessionId" in target
      ? target : store.knowledgePath(id);
    const notes = knowledgeStatusNotes(store, current, visible.knowledgeCommitIds, path,
      id === undefined && typeof target === "object" && "projectId" in target ? target.projectId : undefined);
    // This consumer emits no current material and no episodic block at all (20a: knowledge, then
    // receipts), so its only ceiling is the knowledge cap and the episodic envelope is unbounded.
    const budgeted = budgetMaterial({ knowledge: delta, knowledgeLine, knowledgeNotes: notes,
      current: "", framing: [], caps: { knowledge: config.render.knowledgeBlockTokens, episodic: Infinity } });
    return { text: injectionText({ knowledge: budgeted.knowledge, receipts: budgeted.receipts }, budgeted.knowledgeNotes),
      knowledgeCommitIds: budgeted.knowledgeCommitIds };
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
    const cursor = /^cursor=(\S+)$/.exec(address.trim());
    if (options.cursor || cursor) return page([], { ...options, cursor: options.cursor ?? cursor![1] });
    const targets = address.split(",").map((a) => a.trim());
    // A continuation is already one bounded response, not a component to unwrap into a new
    // unbudgeted comma listing. Refuse before any child can consume its cursor.
    if (targets.length > 1 && targets.some(target => target.startsWith("cursor="))) throw new Error("continue a cursor alone, not in a comma list");
    const intervals = targets.map(factInterval);
    const reads: KnowledgeRead[] = [];
    // A comma list and an interval are the same read: every component contributes its lines in request
    // order, repeats included. An interval contributes its facts as identities — one range query, no
    // record read — so the first page costs the page, not the interval; only the components the reader
    // named individually are resolved at query time, as they always were. What a deferred fact's line
    // still reads from the database is its relations, and those are frozen for the whole remainder in
    // one batched read the moment the query defers (22c's snapshot rule, the same one search meets).
    if (targets.length > 1 || intervals.some(Boolean)) {
      const items = targets.flatMap((target, index): TraceUnit[] => {
        const range = intervals[index];
        if (!range) {
          const child = traceRead(target, { ...options, cap: Number.MAX_SAFE_INTEGER });
          reads.push(...child.completed);
          return [{ text: child.text }];
        }
        const ids = store.listFactIdsInRange(range.from, range.to);
        return ids.length ? ids.map((fact) => ({ fact })) : [{ text: `${target}: no facts exist in this range` }];
      });
      const format = (units: readonly unknown[]) => (units as TraceUnit[])
        .flatMap((unit) => ("fact" in unit ? factLine(unit.fact, unit.relations) : unit.text).split("\n"));
      const capture = (deferred: readonly unknown[]): TraceUnit[] => {
        const units = deferred as TraceUnit[];
        const relations = store.listFactRelationsOf(units.flatMap((unit) => "fact" in unit ? [unit.fact] : []));
        return units.map((unit) => "fact" in unit ? { fact: unit.fact, relations: relations.get(unit.fact)! } : unit);
      };
      return page({ items, format, capture }, options, "", reads);
    }
    const s = /^S([1-9]\d*)$/.exec(address);
    if (s) { session(Number(s[1])); return page(store.listTurns(Number(s[1])).map((t) => listingLine(expand(`T${t.id}`))), options); }
    let project = store.findProjectByName(address);
    while (project?.mergedInto != null) project = store.getProject(project.mergedInto);
    if (project) return page([...store.listVisibleKnowledge(0, project.id).map((k) => knowledgeLine(k)),
      ...store.listProjectFacts(project.id).map((f) => factLine(f.id))].map(listingLine), options);
    const result = expand(address, options, reads);
    return /^(K|F\d+\.\.)/.test(address) || options.cap !== undefined
      ? page(result.split("\n"), options, "", reads) : { text: result, completed: reads };
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
  /** 24a "Footer counts": the four progress/applicability numbers of one session's selected branch
   * and head, answered from one path snapshot (22a) and the pending-entry identities (22b).
   *
   * - `entries`: imported source entries of this path that no Noting run has committed yet. The
   *   `noted_entries` rows a run writes inside its business transaction are what removes an entry
   *   here, so an admitted, running, failed or cancelled batch is still pending, and a provider
   *   failure after the commit restores nothing.
   * - `facts`: every committed fact applicable on this path, the ones already consolidated included.
   * - `unconsolidated`: those of them Consolidation still owes work for — the same exact membership
   *   `consolidationBatch` selects, never `facts` minus the cited ones.
   * - `knowledge`: the applicable current knowledge, in `listCurrentKnowledge`'s own counting unit,
   *   so two divergent tips of one identity count as the two items they are.
   *
   * Nothing here loads a Raw payload, tokenizes, freezes a task or reads a run's audit body; the
   * snapshot is built for this one read and dropped with it, so another connection's commits are
   * seen by the next call. The branch defaults to `main`, so a caller without a host path still asks
   * about a named branch rather than about Turn-only membership. */
  const progress = (sessionId: number, branch = "main", headTurnId?: number | null) => {
    session(sessionId);
    const path = store.knowledgePath(sessionId, branch, headTurnId);
    const snapshot = store.pathSnapshot(path);
    const facts = store.listBranchFacts(sessionId, branch, path.headTurnId, snapshot);
    return {
      // No head means no Turn on this path, so nothing of it has been imported: the enumeration's
      // own answer, not a placeholder for one it could not compute.
      entries: path.headTurnId == null ? 0 : store.pendingEntryIds(sessionId, branch, path.headTurnId, snapshot).length,
      facts: facts.length,
      unconsolidated: store.unconsolidated(facts, path, snapshot).length,
      knowledge: store.listCurrentKnowledge(path, {}, snapshot).length,
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
    // Knowledge is injected once per visible baseline (ruling: "constraints first", grilling Q15);
    // 29d retired the per-prompt delivery that used to ride beside it, so this is the only automatic
    // material the foreground receives — later background results reach it through a compaction or an
    // explicit read, never because a worker finished.
    injection,
    inject: (target: number | { projectId: number } | KnowledgePath): string => injection(target).text,
    // Ticket 28a "Compaction allocator": one allocator over three material windows and one envelope,
    // filled in the ruled priority (28 amendment 7, 30 "Compaction and historical refill"):
    //
    //   1. current knowledge, by the existing priority selection;
    //   2. the pending facts and the pending Raw of the path, which are required;
    //   3. refill (a): the most recent already-consolidated facts of the path;
    //   4. refill (b): the most recent already-extracted source entries of the path.
    //
    // Baselines are `render.knowledgeBlockTokens`, `compaction.factsTokens` and `compaction.rawTokens`;
    // the envelope is their sum and there is no fourth key. Compaction no longer reads
    // `render.episodicBlockTokens`, which stayed the Noter's history envelope. Lending is what the two
    // comparisons below express: a window needing less than its baseline leaves the difference in the
    // envelope, a window needing more may spend it, and no borrower pushes the charged total past the
    // envelope. Knowledge is the only window another's demand can reduce, and only above its own
    // baseline — the fit test measures it at that baseline (`atBaseline.cost`), so optional knowledge
    // yields before a required window is declared over, and nothing knowledge held at its baseline is
    // lost. A required window is never trimmed: pending facts and pending Raw are represented whole,
    // or the operation delegates to native compaction with the window and the numbers (28b interposes
    // the bounded recovery there; this slice launches no worker). Refills are optional in the strict
    // sense — an omitted refill item starts nothing, delegates nothing and enters no carrier, and
    // spare space left over simply stays empty.
    //
    // Nothing here waits for, cancels or starts a memory worker, touches a claim or advances any
    // progress: a Noter finishing concurrently may make this snapshot redundant, never incomplete.
    compact: (sessionId: number, branch = "main", headTurnId?: number, retainedNativeIds: readonly string[] = []): CompactResult => {
      if (!store.enabled(sessionId)) return { text: "", supplied: { entries: [], factIds: [], knowledgeCommitIds: [] } };
      const path = store.knowledgePath(sessionId, branch, headTurnId);
      const snapshot = store.pathSnapshot(path); // one membership for this operation, knowledge and facts alike
      const head = headTurnId ?? store.listTurns(sessionId).at(-1)?.id;
      // Freeze a read snapshot: the path's source entries and its facts, split into what must be
      // represented and what may refill the spare. The rendering below reads these same sets.
      const sourced = head === undefined ? [] : store.sourcePath(sessionId, branch, head);
      const pending = head === undefined ? [] : store.pendingEntries(sessionId, branch, head);
      const knowledge = store.listCurrentKnowledge(path, {}, snapshot);
      // 26 amendment 2: the facts are the ones applicable on the selected path, never the whole
      // session's — a sibling branch's fact is not history here. `listSessionFacts`'s freshness order
      // is what the refill selects by, so it is filtered, not replaced by `listBranchFacts`.
      const applicable = store.listSessionFacts(sessionId).filter(f => store.factOnPath(f, path, snapshot));
      const pendingFacts = store.unconsolidated(applicable, path, snapshot);
      const pendingFactIds = new Set(pendingFacts.map(f => f.id));
      // Refill (a)'s candidates: the already-consolidated facts of the path, deduplicated against the
      // pending ones by construction, still in the freshness order the selection wants.
      const consolidated = applicable.filter(f => !pendingFactIds.has(f.id));
      const factTurns = store.factTurnTimes(applicable);
      // Refill (b)'s candidates: the already-extracted entries of the path — the path minus what is
      // still pending — minus what the post-compaction context retains, so nothing is supplied twice.
      // An entry whose only earlier visibility was the summary this compaction discards is NOT
      // excluded on that account (30 case 10): the exclusions are these two and no other.
      const pendingIds = new Set(pending.map(e => e.id)), retained = new Set(retainedNativeIds);
      const extracted = sourced.filter(e => !pendingIds.has(e.id) && !retained.has(e.nativeId));
      const caps = { knowledge: config.render.knowledgeBlockTokens, facts: config.compaction.factsTokens, raw: config.compaction.rawTokens };
      const envelope = caps.knowledge + caps.facts + caps.raw;
      // Every emitted component is charged inside the window that owns it: the `<episodic>` tag and
      // the facts title with the facts, the Raw title with the Raw, each block's omission receipts
      // with their own block. The `Receipts:` heading `finish` emits is charged to each window that
      // has a receipt, which over-counts safely (the same rule `budgetMaterial` applies).
      const lines = (facts: Fact[]) => renderFactGroups(facts, f => factLine(f.id), factTurns);
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
      // Required first. Knowledge is measured at its baseline here, so a knowledge corpus larger than
      // its own window can never make a required window overflow, and a knowledge block within it is
      // never dropped to make room (28 "Material and allocation").
      const atBaseline = budgetKnowledge(knowledge, caps.knowledge, knowledgeLine);
      if (atBaseline.cost + requiredFacts + requiredRaw > envelope) {
        const over = [requiredFacts > caps.facts ? `the facts window (${pendingFacts.length} pending facts need ${requiredFacts} tokens, compaction.factsTokens ${caps.facts})` : "",
          requiredRaw > caps.raw ? `the Raw window (bounded views of ${pending.length} pending entries need ${requiredRaw} tokens, compaction.rawTokens ${caps.raw})` : ""].filter(Boolean);
        return { native: true, over: { facts: requiredFacts > caps.facts, raw: requiredRaw > caps.raw },
          reason: `required material does not fit after lending: ${over.join(" and ") || "the required windows"} exceed the `
          + `${envelope}-token envelope beside ${atBaseline.cost} tokens of knowledge, by ${atBaseline.cost + requiredFacts + requiredRaw - envelope} tokens` };
      }
      // It fits, so the rest of the envelope is knowledge's to grow into before the refills see it
      // (28 amendment 7's priority 1). `budgetKnowledge` keeps more as the cap rises and this cap is
      // at least the baseline's cost, so the block can only gain items here, never lose one.
      const active = budgetKnowledge(knowledge, envelope - requiredFacts - requiredRaw, knowledgeLine);
      let spare = envelope - active.cost - requiredFacts - requiredRaw;
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
      spare -= factsCharge(facts, factReceipts) - requiredFacts;
      // Refill (b): whole already-extracted entries, most recent first, through the same profile,
      // charged to the Raw window and the envelope; selection stops at the remaining budget and there
      // is no smaller profile to fall back to (30). One that cannot hold its own labels is left out.
      const refilledRaw: { entry: SourceEntry; content: string }[] = [];
      for (const entry of [...extracted].reverse()) {
        let content: string;
        try { content = view(entry).content; } catch (error) { if (/capacity/.test(String(error))) continue; throw error; }
        if (tokens(content) + 1 > spare) break;
        refilledRaw.push({ entry, content }); spare -= tokens(content) + 1;
      }
      // Displayed in source order, pending and refilled alike (30: "display the selected Raw entries
      // in source order"; no new relevance ranking).
      const order = new Map(sourced.map((entry, index) => [entry.id, index]));
      const supplied = [...pending.map((entry, index) => ({ entry, content: views![index]!.content })), ...refilledRaw]
        .sort((a, b) => order.get(a.entry.id)! - order.get(b.entry.id)!);
      return { text: compactText({ knowledge: active.groups, facts: lines(facts),
          entries: supplied.map(s => ({ id: s.entry.id, view: s.content })),
          receipts: [...views.flatMap(v => v.receipts), ...factReceipts, ...active.receipts] }),
        // 29a "Renderers return what they kept": exactly the identities this replacement carries,
        // pending and refilled alike. What a budget left out is absent here (28a item 7).
        supplied: { entries: supplied.map(s => ({ id: s.entry.id, nativeId: s.entry.nativeId, view: "bounded" as const })),
          factIds: facts.map(f => f.id), knowledgeCommitIds: active.commits },
        // 28a item 6: the per-window accounting beside the text, for the acceptance probe and for
        // 28b's recovery decision. It is diagnostics, not a second outcome.
        charged: { knowledge: active.cost, facts: factsCharge(facts, factReceipts), raw: rawCharge(supplied.map(s => s.content)),
          envelope, required: { facts: requiredFacts, raw: requiredRaw } } };
    },
    branchSummary: (sessionId: number, branch: string, headTurnId: number): string => {
      if (!store.enabled(sessionId)) return "";
      // Every pending entry, not Noting's next batch (review 2026-09-08: the batch cap silently cut the tail).
      // Newest kept whole within the episodic budget; older ones are named in a receipt, never dropped silently.
      const pending = store.pendingEntries(sessionId, branch, headTurnId).map(e => renderEntry(e, config.render, resultText));
      let kept = pending.length, used = 0;
      for (let i = pending.length - 1; i >= 0; i--) {
        used += tokens(pending[i]!.content);
        if (used > config.render.episodicBlockTokens && i < pending.length - 1) { kept = pending.length - 1 - i; break; }
      }
      const raw = pending.slice(pending.length - kept);
      const omitted = pending.length - kept;
      if (omitted) raw.push({ content: "", receipts: [`[... ${omitted} earlier pending entries beyond the carry budget truncated; read them with trace]`], omitted: [] });
      const path = { sessionId, headTurnId, branch }, snapshot = store.pathSnapshot(path); // one membership for facts and commits alike
      const facts = store.listSessionFacts(sessionId).filter(f => store.factOnPath(f, path, snapshot)).sort((a, b) => a.id - b.id);
      const factIds = new Set(facts.map(f => f.id));
      const commits = store.listKnowledgeRevisions().filter(r => store.commitApplies(r, path, snapshot) &&
        r.supports.some(id => factIds.has(id)))
        .map(revision => ({ knowledge: store.getKnowledge(revision.knowledgeId)!, revision }));
      const content = ["this is knowledge from another branch; it must not be written as facts; the Noter's facts come only from the current branch's conversation, never from messages this plugin injected.",
        "Facts:", ...factGroups(facts), "Commits (by evidence):", ...commits.map((c) => knowledgeLine(c)),
        "Pending raw:", ...raw.map(r => r.content), ...raw.flatMap(r => r.receipts)].join("\n");
      // Escape payload markup so injected content cannot close or nest the carry boundary.
      return xmlBlock("branch_carry", content); // like every block: tags delimit, lines are byte-for-byte trace lines (ruling 15:14)
    },
    search: (query: string, scope: SearchScope = "all", options: ListingOptions & { sessionId?: number } = {}): string => {
      if (!["facts", "knowledge", "all", "raw"].includes(scope)) throw new Error("invalid search scope");
      if (options.cursor) {
        // Shared trace cursors cannot turn a search continuation into an unbudgeted read.
        return page([], { ...options, maxTokens: options.maxTokens === undefined ? cursors.get(options.cursor)?.maxTokens ?? DEFAULT_SEARCH_TOKENS : options.maxTokens }).text;
      }
      const addresses = store.searchAddresses(query, scope);
      // 22c: the path, the applicable set, the current tips and the commit ancestry are resolved once,
      // before the first page, and every page this query ever formats is labelled from them: a commit
      // that arrives between two pages neither joins the hits nor moves a label already established.
      const path = options.sessionId === undefined ? null : store.knowledgePath(options.sessionId, undefined, options.headTurnId);
      const graph = addresses.some(a => a.startsWith("K")) ? store.commitGraph(path) : null;
      const tips = new Map<number, KnowledgeRevision[]>();
      for (const r of graph?.current ?? []) tips.set(r.knowledgeId, [...(tips.get(r.knowledgeId) ?? []), r]);
      // The graph freezes what a hit *is*; this freezes the mutable state its line *reads*: a fact's
      // relations, a commit's marks, a Turn's occurrence membership. Each is read for the deferred
      // hits in one query — identities for the Turns, never their Raw — so a fact negated, a commit
      // marked or a message completed after this query changes no page it already established.
      const capture = (deferred: readonly unknown[]): FrozenHit[] => {
        const rest = deferred as string[];
        const record = (address: string) => Number(address.slice(1)), commitOf = (address: string) => Number(address.split("@")[1]);
        const ids = (prefix: string, of: (address: string) => number) => rest.filter(a => a.startsWith(prefix)).map(of);
        const relations = store.listFactRelationsOf(ids("F", record));
        const marks = store.listKnowledgeMarksOf(ids("K", commitOf));
        const entries = store.listSourceEntryIdsOf(ids("T", record));
        return rest.map(address => address.startsWith("F") ? { address, relations: relations.get(record(address))! }
          // The entry-view profile is frozen with the identities (review 2026-09-09): a configuration
          // refresh between two pages changes no excerpt a query already established.
          : address.startsWith("T") ? { address, entryIds: entries.get(record(address))!, profile: { entryTokens: config.render.entryTokens, toolInputTokens: config.render.toolInputTokens, toolResultTokens: config.render.toolResultTokens } }
          : { address, marks: marks.get(commitOf(address))! });
      };
      const format = (hits: readonly unknown[]) => (hits as (string | FrozenHit)[]).map((item) => {
        const frozen: FrozenHit | undefined = typeof item === "string" ? undefined : item;
        const address = frozen?.address ?? item as string;
        if (address.startsWith("F")) return factLine(Number(address.slice(1)), frozen?.relations);
        if (address.startsWith("T")) return expand(address, frozen && { entryIds: frozen.entryIds, profile: frozen.profile });
        const [id, commit] = address.slice(1).split("@").map(Number);
        const knowledge = store.getKnowledge(id!)!;
        const hit = graph!.revisions.find(r => r.id === commit)!;
        const current = tips.get(id!) ?? [];
        const applicable = !path || graph!.applicable.has(hit.id);
        const descendants = graph!.descendants(hit.id);
        const successors = [...new Set(graph!.revisions.filter(r => descendants.has(r.id)).map(r => r.knowledgeId))]
          .flatMap(id => tips.get(id) ?? []).filter(r => r.id !== hit.id && descendants.has(r.id));
        const status = !applicable ? "another branch"
          : current.some(r => r.id === commit) ? (hit.op === "archive" ? (path ? "archived on this path" : "archived") : path ? "current on this path" : "tip (newest-created alternatives)")
          : successors.length && successors.every(r => r.op === "archive") ? (path ? "archived on this path" : "archived")
          : `superseded${path ? " on this path" : ""} by ${successors.map(r => `K${r.knowledgeId}@${r.id}`).join(", ") || "none"}`;
        return knowledgeLine({ knowledge, revision: hit }, frozen?.marks) + `\n  note: ${status}`;
      }).map(listingLine);
      return page({ items: addresses, format, capture }, { ...options, maxTokens: options.maxTokens === undefined ? DEFAULT_SEARCH_TOKENS : options.maxTokens }, "Search uses literal substring search. No hit does not mean absent.").text;
    },
    declareProject: (sessionId: number, name: string, source: "marker" | "mark" = "mark"): string => {
      const project = store.declareProject(sessionId, name, source);
      return `S${sessionId} project: ${project.name} (${store.projectDeclaration(sessionId)})`;
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
        `Spend: ${totals.runs.noting} noting, ${totals.runs.consolidation} consolidation, ${totals.runs.dreaming} dreaming, ${totals.runs.manual} manual runs; ${totals.input + totals.output + totals.cacheRead + totals.cacheWrite} tokens; $${totals.cost.toFixed(4)}`,
        // 24a: the footer's own counts, spelled out. They describe imported evidence only: native
        // history of a disabled interval is imported when the session is enabled again, so a zero
        // here is not proof that every available native message has been processed.
        `Pending: ${counts.entries} imported ${counts.entries === 1 ? "entry" : "entries"} to note, ${counts.unconsolidated} of ${counts.facts} applicable ${counts.facts === 1 ? "fact" : "facts"} to consolidate; ${counts.knowledge} current knowledge (imported evidence on this branch)`,
        `Facts: ${store.listSessionFacts(sessionId).length} session; ${store.listProjectFacts(s.projectId).length} project`,
        `Knowledge: ${store.listVisibleKnowledge(sessionId, s.projectId).length} visible active`,
        ...(["noting", "consolidation", "dreaming"] as const).map((kind) => { const r = [...runs].reverse().find((r) => r.kind === kind); return `Last ${kind}: ${r ? `run ${r.id} ${r.outcome} ${r.createdAt} branch=${r.branch}` : "none"}`; })].join("\n");
    },
  };
}
