import { randomUUID } from "node:crypto";
import type { TraceMemoryConfig } from "./index.ts";
import type { Store, KnowledgeWithRevision, KnowledgePath } from "../store/index.ts";
import type { Fact, FactRelation, KnowledgeMark, KnowledgeRevision } from "../model/index.ts";
import { tokens, budgetKnowledge, finish, listingLine, renderKnowledge, renderFact, renderFactGroups, renderEntry, rawResultText, xmlBlock, type ResultExtractor, type EntryProfile } from "../render/index.ts";
import { budgetMaterial, injectionText, compactText, secondaryRawTitle, BLOCK, FACTS_TITLE, RAW_TITLE, type SharedMaterial } from "../render/material.ts";

/** `sessionId`, `headTurnId` and `branch` are the reader's own path, supplied by the host or by a
 * run's tool binding, never by the model: they decide which knowledge a label is judged against and,
 * since 23b, which of a Turn's native occurrences an assembled `trace` shows. An unbound read is
 * unrestricted, as it always was. A Turn's occurrences are selected by `branch`, or — when a paged
 * read froze them at query time (22c) — by the `entryIds` that query kept; like the path, neither is
 * reachable from a model's tool arguments. */
export interface ListingOptions { cap?: number; cursor?: string; tool?: number; full?: boolean; sessionId?: number; headTurnId?: number | null; branch?: string; entryIds?: readonly number[]; profile?: EntryProfile }
export type SearchScope = "facts" | "knowledge" | "all" | "raw";

/** Ticket 20 "Compaction escalation" (20c): what compact can produce for one frozen read snapshot.
 * `primary` and `secondary` are complete custom replacements the host may hand to Pi — every pending
 * entry is represented in both, and the tier says which view built them. `native` is the explicit
 * ask that the host decline the custom summary and let Pi's own compaction run, with the reason it
 * could not be avoided: which cap the smallest complete representation missed, and by how much.
 * There is no fourth outcome: compact never hides selected entries to make a tier fit, and core
 * never summarizes with a model. */
/** 21b "Group projection": the topics of the path-selected applicable knowledge, as references to the
 * exact commits they were read from. A commit with several labels is referenced by each of its groups,
 * a commit with none stays available under `unclassified`, and divergent tips remain separate entries:
 * nothing here clones a knowledge record, collapses two tips or picks a winner. */
export interface TopicGroups {
  topics: { topic: string; commits: { knowledgeId: number; commit: number }[] }[];
  unclassified: { knowledgeId: number; commit: number }[];
}

export type CompactResult = { tier: "primary" | "secondary"; text: string } | { tier: "native"; reason: string };

/** 22c "complete snapshot": one search hit whose formatting the query deferred to a later page, with
 * the mutable state its line would otherwise read from the database then. Everything else a hit
 * prints — the fact and commit records, the path, the labels the commit graph decided — is immutable
 * or already frozen by the query, so these three annotations are the whole remainder. */
interface FrozenHit { address: string; relations?: FactRelation[]; marks?: KnowledgeMark[]; entryIds?: number[]; profile?: EntryProfile }

/** One component of a `trace` comma list, in request order: either a fact an interval selected —
 * rendered when a page asks for it, from the relations the query froze — or text a named component
 * already resolved at query time. */
type TraceUnit = { fact: number; relations?: FactRelation[] } | { text: string };

export function readFacade(store: Store, config: TraceMemoryConfig, expand: (address: string, options?: ListingOptions) => string,
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
   * crossed the page edge — `cap` counts output lines, so one record may straddle two pages. */
  type Remainder = Continuation & { offset: number; pending: readonly string[]; footer: string; cap: number; owner: string };
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
    const cap = options.cap ?? saved?.cap ?? 100;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("listing cap must be a positive integer");
    const { items, format, capture } = saved ?? (Array.isArray(source)
      ? { items: source, format: (lines: readonly unknown[]) => lines as string[], capture: undefined } : source);
    if (saved) footer = saved.footer;
    const receipts = footer ? [footer] : [];
    // Only the hits this page prints are formatted: the rest are identities until a page asks for
    // them. One record at a time, because a record's line count is not known before it is rendered.
    const lines = [...(saved?.pending ?? [])];
    let at = saved?.offset ?? 0;
    while (lines.length < cap && at < items.length) lines.push(...format([items[at++]]));
    const pending = lines.splice(cap);
    if (options.cursor) cursors.delete(options.cursor);
    if (pending.length || at < items.length) {
      const cursor = randomUUID();
      // The snapshot is taken here, once, at the moment this query first defers hits. Later pages of
      // the same query re-use that one frozen array and move an offset through it; nothing is copied
      // again, and the stored remainder carries no `capture` because its items already hold it.
      cursors.set(cursor, saved ? { ...saved, offset: at, pending }
        : capture ? { items: capture(items.slice(at)), offset: 0, pending, format, footer, cap, owner }
        : { items, offset: at, pending, format, footer, cap, owner });
      for (const oldest of cursors.keys()) { if (cursors.size <= CURSORS) break; cursors.delete(oldest); }
      receipts.push(`cursor=${cursor}`);
    }
    return finish({ content: lines.join("\n"), receipts });
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
  // The knowledge part of the shared material contract (20a): the same parts, budgeted the same way,
  // that a Noting or Consolidation task freezes. Its block layout lives in core/render/material.ts.
  const knowledgeFor = (projectId: number, sessionId = 0, headTurnId?: number | null, branch?: string): SharedMaterial => {
    const active = budgetKnowledge(store.listVisibleKnowledge(sessionId, projectId, headTurnId, branch), config.render.knowledgeBlockTokens, knowledgeLine);
    return { knowledge: active.groups, receipts: active.receipts };
  };
  const knowledge = (id: number, headTurnId?: number | null, branch?: string) => knowledgeFor(session(id).projectId, id, headTurnId, branch);
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
  const trace = (address: string, options: ListingOptions = {}): string => {
    const cursor = /^cursor=(\S+)$/.exec(address.trim());
    if (options.cursor || cursor) return page([], { ...options, cursor: options.cursor ?? cursor![1] });
    const targets = address.split(",").map((a) => a.trim());
    const intervals = targets.map(factInterval);
    // A comma list and an interval are the same read: every component contributes its lines in request
    // order, repeats included. An interval contributes its facts as identities — one range query, no
    // record read — so the first page costs the page, not the interval; only the components the reader
    // named individually are resolved at query time, as they always were. What a deferred fact's line
    // still reads from the database is its relations, and those are frozen for the whole remainder in
    // one batched read the moment the query defers (22c's snapshot rule, the same one search meets).
    if (targets.length > 1 || intervals.some(Boolean)) {
      const items = targets.flatMap((target, index): TraceUnit[] => {
        const range = intervals[index];
        if (!range) return [{ text: trace(target, { ...options, cap: Number.MAX_SAFE_INTEGER }) }];
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
      return page({ items, format, capture }, options);
    }
    const s = /^S([1-9]\d*)$/.exec(address);
    if (s) { session(Number(s[1])); return page(store.listTurns(Number(s[1])).map((t) => listingLine(expand(`T${t.id}`))), options); }
    let project = store.findProjectByName(address);
    while (project?.mergedInto != null) project = store.getProject(project.mergedInto);
    if (project) return page([...store.listVisibleKnowledge(0, project.id).map((k) => knowledgeLine(k)),
      ...store.listProjectFacts(project.id).map((f) => factLine(f.id))].map(listingLine), options);
    const result = expand(address, options);
    return /^(K|F\d+\.\.)/.test(address) || options.cap !== undefined ? page(result.split("\n"), options) : result;
  };
  // Model spend of this session's runs, from the usage each run recorded (summed over its rounds).
  // 22d: the usage is projected out of the stored response by the store; the request and response
  // audit bodies are never loaded to add up counters. A run without a usage observation — a failure,
  // a cancelled run with unknown usage — contributes nothing at all, not a zero.
  const spend = (sessionId: number) => {
    session(sessionId);
    const totals = { runs: { noting: 0, consolidation: 0, manual: 0 }, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
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
   * seen by the next call. The branch defaults like `deliver`'s, so a caller without a host path
   * still asks about a named branch rather than about Turn-only membership. */
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
    // Knowledge are injected once, at session start (ruling: "constraints first", grilling Q15); deliveries ride every
    // prompt (ruling 08:53: noting results are injected with the next user message). Two reads, one job each.
    inject: (target: number | { projectId: number } | KnowledgePath): string => {
      const id = typeof target === "number" ? target : "sessionId" in target ? target.sessionId : undefined;
      if (id !== undefined && !store.enabled(id)) return "";
      if (typeof target === "object" && "sessionId" in target) return injectionText(knowledge(target.sessionId, target.headTurnId, target.branch));
      if (typeof target === "object") {
        // First prompt: no session id yet (allocated at the first reply), so no session knowledge.
        if (!store.getProject(target.projectId)) throw new Error(`project ${target.projectId} does not exist`);
        return injectionText(knowledgeFor(target.projectId));
      }
      return injectionText(knowledge(target));
    },
    deliver: (sessionId: number, branch: string | null = "main"): { text: string; runIds: number[] } => {
      session(sessionId);
      return store.deliver(sessionId, branch, (facts, commits) => [
        facts.length ? xmlBlock("noted", factGroups(facts).join("\n")) : "",
        commits.length ? xmlBlock("consolidated", commits.map((r) => knowledgeLine({ knowledge: store.getKnowledge(r.knowledgeId)!, revision: r })).join("\n")) : "",
      ].filter(Boolean).join("\n\n"));
    },
    // Ruling 2026-09-07: a delivery is confirmed only after the host persisted it (at the turn's stop);
    // an unconfirmed delivery is rendered again next time. Duplicates are allowed, silent loss is not.
    confirmDelivery: (runIds: number[]): void => { store.confirmDeliveries(runIds); },
    // Ticket 20 "Compaction escalation" (20c). Five ruled steps, in order, over one frozen snapshot.
    // Nothing here waits for, cancels or starts a memory worker, touches a claim or advances any
    // progress: a Noter finishing concurrently may make this snapshot redundant, never incomplete.
    compact: (sessionId: number, branch = "main", headTurnId?: number): CompactResult => {
      if (!store.enabled(sessionId)) return { tier: "primary", text: "" };
      const path = store.knowledgePath(sessionId, branch, headTurnId);
      const head = headTurnId ?? store.listTurns(sessionId).at(-1)?.id;
      // 1. Freeze a read snapshot: every pending original entry on this path, selected once. The
      //    tiers below re-render this same set; none of them may change it.
      const pending = head === undefined ? [] : store.pendingEntries(sessionId, branch, head);
      const knowledge = store.listVisibleKnowledge(sessionId, session(sessionId).projectId, path.headTurnId, branch);
      const facts = store.listSessionFacts(sessionId);
      const factTurns = store.factTurnTimes(facts);
      const caps = { knowledge: config.render.knowledgeBlockTokens, episodic: config.render.episodicBlockTokens, current: config.noting.batchTokens };
      // 4. Recheck the whole block: one accounting for both tiers. Identities, labels, retained tool
      //    names, excerpts and omission markers are charged exactly as normal material is — the inner
      //    ceiling for the joined views, the enclosing episodic budget for the framing around them.
      const build = (views: { content: string; receipts: string[] }[], title: string) => {
        const budgeted = budgetMaterial({ knowledge, knowledgeLine, current: views.map((v) => v.content).join(BLOCK),
          framing: [xmlBlock("episodic", ""), FACTS_TITLE, title], facts, factLine: (f) => factLine(f.id), factTurns, caps });
        return { over: budgeted.over, text: compactText({ knowledge: budgeted.knowledge, facts: budgeted.facts,
          entries: pending.map((entry, i) => ({ id: entry.id, view: views[i]!.content })),
          receipts: [...views.flatMap((v) => v.receipts), ...budgeted.receipts] }, title) };
      };
      // 2. Try normal views: the shared primary views, against the shared Raw ceiling
      //    (`noting.batchTokens`, not a second knob) and the episodic budget. No batch selector here —
      //    the whole pending set is represented or this tier does not apply.
      // A primary view that cannot hold its own labels is a capacity failure of tier 1, not of compact:
      // tier 2 is tried next. Any other rendering error is a data error and is reported (review 2026-09-08).
      let primaryViews: { content: string; receipts: string[] }[] | undefined;
      try { primaryViews = pending.map((e) => renderEntry(e, config.render, resultText)); }
      catch (error) { if (!/capacity/.test(String(error))) throw error; }
      const primary = primaryViews && build(primaryViews, RAW_TITLE);
      if (primary && !primary.over.current && !primary.over.episodic) return { tier: "primary", text: primary.text };
      // 3. Try tier 2: the same renderer under the tier-2 profile (ticket 23, superseding 20c's
      //    separate compact-only renderer), still every selected entry, still deterministic and local.
      //    An entry whose minima that tighter `E` cannot hold is a capacity failure of tier 2, and the
      //    delegation below says so rather than hiding the entry.
      const profile = { toolCallTokens: config.render.secondaryToolCallTokens, entryTokens: config.render.secondaryEntryTokens };
      const title = secondaryRawTitle(profile);
      let secondary: ReturnType<typeof build> | undefined;
      try { secondary = build(pending.map((e) => renderEntry(e, profile, resultText)), title); }
      catch (error) { if (!/capacity/.test(String(error))) throw error; }
      if (secondary && !secondary.over.current && !secondary.over.episodic) return { tier: "secondary", text: secondary.text };
      // 5. Delegate if necessary: many tiny entries, or one entry with excessive mandatory metadata,
      //    can miss the cap even here. Ask for native compaction with the reason instead of hiding
      //    entries, falsifying a receipt or relaxing the cap to force a success.
      const missed = !secondary ? `the tier-2 entry budget: their labels and omission markers exceed ${profile.entryTokens} tokens`
        : secondary.over.current ? `the raw ceiling by ${secondary.over.current} tokens (cap ${caps.current})`
        : `the episodic budget by ${secondary.over.episodic} tokens (cap ${caps.episodic})`;
      return { tier: "native", reason: `tier-2 views of ${pending.length} pending entries exceed ${missed}` };
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
      if (options.cursor) return page([], options);
      if (!["facts", "knowledge", "all", "raw"].includes(scope)) throw new Error("invalid search scope");
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
          : address.startsWith("T") ? { address, entryIds: entries.get(record(address))!, profile: { toolCallTokens: config.render.toolCallTokens, entryTokens: config.render.entryTokens } }
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
      return page({ items: addresses, format, capture }, options, "Search uses literal substring search. No hit does not mean absent.");
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
      const branches = [...new Set(runs.map((r) => r.branch))];
      return [`Session: S${sessionId}`, `Enrollment: ${store.enabled(sessionId) ? "Enabled" : "Disabled"} (${store.enrollment(sessionId).choice === null ? "default" : "explicit choice"})`, `Project: ${store.getProject(s.projectId)!.name} (${store.projectDeclaration(sessionId)})`,
        `Spend: ${totals.runs.noting} noting, ${totals.runs.consolidation} consolidation, ${totals.runs.manual} manual runs; ${totals.input + totals.output + totals.cacheRead + totals.cacheWrite} tokens; $${totals.cost.toFixed(4)}`,
        // 24a: the footer's own counts, spelled out. They describe imported evidence only: native
        // history of a disabled interval is imported when the session is enabled again, so a zero
        // here is not proof that every available native message has been processed.
        `Pending: ${counts.entries} imported ${counts.entries === 1 ? "entry" : "entries"} to note, ${counts.unconsolidated} of ${counts.facts} applicable ${counts.facts === 1 ? "fact" : "facts"} to consolidate; ${counts.knowledge} current knowledge (imported evidence on this branch)`,
        `Facts: ${store.listSessionFacts(sessionId).length} session; ${store.listProjectFacts(s.projectId).length} project`,
        `Knowledge: ${store.listVisibleKnowledge(sessionId, s.projectId).length} visible active`,
        ...(["noting", "consolidation"] as const).map((kind) => { const r = [...runs].reverse().find((r) => r.kind === kind); return `Last ${kind}: ${r ? `run ${r.id} ${r.outcome} ${r.createdAt} branch=${r.branch}` : "none"}`; }),
        `Pending deliveries: ${branches.reduce((n, b) => n + store.listPendingDeliveries(sessionId, b).length, 0)}`].join("\n");
    },
  };
}
