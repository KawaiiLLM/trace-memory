import { randomUUID } from "node:crypto";
import type { TraceMemoryConfig } from "./index.ts";
import type { Store, KnowledgeWithRevision, KnowledgePath } from "../store/index.ts";
import { tokens, budgetKnowledge, finish, listingLine, renderKnowledge, renderFact, renderTurn, renderEntry, rawResultText, xmlBlock, type ResultExtractor } from "../render/index.ts";
import { budgetMaterial, injectionText, compactText, secondaryRawTitle, BLOCK, FACTS_TITLE, RAW_TITLE, type SharedMaterial } from "../render/material.ts";

export interface ListingOptions { cap?: number; cursor?: string; tool?: number; full?: boolean; sessionId?: number; headTurnId?: number | null }
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

export function readFacade(store: Store, config: TraceMemoryConfig, expand: (address: string, options?: ListingOptions) => string,
  resultText: ResultExtractor = rawResultText) {
  const cursors = new Map<string, { lines: string[]; footer: string; cap: number; owner: string }>();
  const page = (lines: string[], options: ListingOptions = {}, footer = ""): string => {
    const owner = options.sessionId === undefined ? "unbound" : `${options.sessionId}:${store.getSession(options.sessionId)?.projectId}`;
    const saved = options.cursor ? cursors.get(options.cursor) : undefined;
    if (options.cursor && (!saved || saved.owner !== owner)) throw new Error("unknown or expired cursor");
    const cap = options.cap ?? saved?.cap ?? 100;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("listing cap must be a positive integer");
    if (saved) { lines = saved.lines; footer = saved.footer; }
    const receipts = footer ? [footer] : [];
    if (lines.length > cap) {
      const cursor = randomUUID();
      cursors.set(cursor, { lines: lines.slice(cap), footer, cap, owner });
      receipts.push(`cursor=${cursor}`);
    }
    if (options.cursor) cursors.delete(options.cursor);
    return finish({ content: lines.slice(0, cap).join("\n"), receipts });
  };
  const session = (id: number) => {
    const value = store.getSession(id);
    if (!value) throw new Error(`session S${id} does not exist`);
    return value;
  };
  const factLine = (id: number) => renderFact(store.getFact(id)!, store.listFactRelations(id));
  const knowledgeLine = (value: KnowledgeWithRevision) => renderKnowledge(value, store.listKnowledgeMarks(value.knowledge.id).filter((m) => m.commitId === value.revision.id));
  // The knowledge part of the shared material contract (20a): the same parts, budgeted the same way,
  // that a Noting or Consolidation task freezes. Its block layout lives in core/render/material.ts.
  const knowledgeFor = (projectId: number, sessionId = 0, headTurnId?: number | null, branch?: string): SharedMaterial => {
    const active = budgetKnowledge(store.listVisibleKnowledge(sessionId, projectId, headTurnId, branch), config.render.knowledgeBlockTokens, knowledgeLine);
    return { knowledge: active.groups, receipts: active.receipts };
  };
  const knowledge = (id: number, headTurnId?: number | null, branch?: string) => knowledgeFor(session(id).projectId, id, headTurnId, branch);
  const trace = (address: string, options: ListingOptions = {}): string => {
    const cursor = /^cursor=(\S+)$/.exec(address.trim());
    if (options.cursor || cursor) return page([], { ...options, cursor: options.cursor ?? cursor![1] });
    const targets = address.split(",").map((a) => a.trim());
    if (targets.length > 1) return page(targets.flatMap((a) => trace(a, { ...options, cap: Number.MAX_SAFE_INTEGER }).split("\n")), options);
    const s = /^S([1-9]\d*)$/.exec(address);
    if (s) { session(Number(s[1])); return page(store.listTurns(Number(s[1])).map((t) => listingLine(expand(`T${t.id}`))), options); }
    let project = store.findProjectByName(address);
    while (project?.mergedInto != null) project = store.getProject(project.mergedInto);
    if (project) return page([...store.listVisibleKnowledge(0, project.id).map(knowledgeLine),
      ...store.listProjectFacts(project.id).map((f) => factLine(f.id))].map(listingLine), options);
    const result = expand(address, options);
    return /^(K|F\d+\.\.)/.test(address) || options.cap !== undefined ? page(result.split("\n"), options) : result;
  };
  // Model spend of this session's runs, from the usage each run recorded (summed over its rounds).
  const spend = (sessionId: number) => {
    session(sessionId);
    const totals = { runs: { noting: 0, consolidation: 0, manual: 0 }, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const run of store.listRuns(sessionId)) {
      totals.runs[run.kind]++;
      let usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | null = null;
      try { usage = JSON.parse(run.response ?? "{}").usage ?? null; } catch { usage = null; }
      if (!usage) continue;
      totals.input += usage.input ?? 0; totals.output += usage.output ?? 0;
      totals.cacheRead += usage.cacheRead ?? 0; totals.cacheWrite += usage.cacheWrite ?? 0; totals.cost += usage.cost?.total ?? 0;
    }
    return totals;
  };
  return {
    spend,
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
        facts.length ? xmlBlock("noted", facts.map((f) => factLine(f.id)).join("\n")) : "",
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
      const caps = { knowledge: config.render.knowledgeBlockTokens, episodic: config.render.episodicBlockTokens, current: config.noting.batchTokens };
      // 4. Recheck the whole block: one accounting for both tiers. Identities, labels, retained tool
      //    names, excerpts and omission markers are charged exactly as normal material is — the inner
      //    ceiling for the joined views, the enclosing episodic budget for the framing around them.
      const build = (views: { content: string; receipts: string[] }[], title: string) => {
        const budgeted = budgetMaterial({ knowledge, knowledgeLine, current: views.map((v) => v.content).join(BLOCK),
          framing: [xmlBlock("episodic", ""), FACTS_TITLE, title], facts, factLine: (f) => factLine(f.id), caps });
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
      if (omitted) raw.push({ content: "", receipts: [`[omitted ${omitted} earlier pending entries beyond the carry budget; read them with trace]`] });
      const path = { sessionId, headTurnId, branch }, snapshot = store.pathSnapshot(path); // one membership for facts and commits alike
      const facts = store.listSessionFacts(sessionId).filter(f => store.factOnPath(f, path, snapshot)).sort((a, b) => a.id - b.id);
      const factIds = new Set(facts.map(f => f.id));
      const commits = store.listKnowledgeRevisions().filter(r => store.commitApplies(r, path, snapshot) &&
        r.supports.some(id => factIds.has(id)))
        .map(revision => ({ knowledge: store.getKnowledge(revision.knowledgeId)!, revision }));
      const content = ["this is knowledge from another branch; it must not be written as facts; the Noter's facts come only from the current branch's conversation, never from messages this plugin injected.",
        "Facts:", ...facts.map(f => factLine(f.id)), "Commits (by evidence):", ...commits.map(knowledgeLine),
        "Pending raw:", ...raw.map(r => r.content), ...raw.flatMap(r => r.receipts)].join("\n");
      // Escape payload markup so injected content cannot close or nest the carry boundary.
      return xmlBlock("branch_carry", content); // like every block: tags delimit, lines are byte-for-byte trace lines (ruling 15:14)
    },
    search: (query: string, scope: SearchScope = "all", options: ListingOptions & { sessionId?: number } = {}): string => {
      if (options.cursor) return page([], options);
      if (!["facts", "knowledge", "all", "raw"].includes(scope)) throw new Error("invalid search scope");
      const lines = store.searchAddresses(query, scope).map((address) => {
        if (address.startsWith("F")) return factLine(Number(address.slice(1)));
        if (address.startsWith("T")) return expand(address);
        const [id, commit] = address.slice(1).split("@").map(Number);
        const knowledge = store.getKnowledge(id!)!;
        const path = options.sessionId === undefined ? null : store.knowledgePath(options.sessionId, undefined, options.headTurnId);
        const hit = store.getKnowledgeRevision(id!, commit!)!;
        const current = store.currentCommit(id!, path);
        const applicable = !path || store.commitApplies(hit, path);
        const descendants = store.commitDescendants(hit.id);
        const successors = [...new Set(store.listKnowledgeRevisions().filter(r => descendants.has(r.id)).map(r => r.knowledgeId))]
          .flatMap(id => store.currentCommit(id, path)).filter(r => r.id !== hit.id && descendants.has(r.id));
        const status = !applicable ? "another branch"
          : current.some(r => r.id === commit) ? (hit.op === "archive" ? (path ? "archived on this path" : "archived") : path ? "current on this path" : "tip (newest-created alternatives)")
          : successors.length && successors.every(r => r.op === "archive") ? (path ? "archived on this path" : "archived")
          : `superseded${path ? " on this path" : ""} by ${successors.map(r => `K${r.knowledgeId}@${r.id}`).join(", ") || "none"}`;
        return knowledgeLine({ knowledge, revision: hit }) + `\n  note: ${status}`;
      }).map(listingLine);
      return page(lines, options, "Search uses literal substring search. No hit does not mean absent.");
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
    status: (sessionId: number): string => {
      const s = session(sessionId), runs = store.listRuns(sessionId);
      const totals = spend(sessionId);
      const branches = [...new Set(runs.map((r) => r.branch))];
      return [`Session: S${sessionId}`, `Enrollment: ${store.enabled(sessionId) ? "Enabled" : "Disabled"} (${store.enrollment(sessionId).choice === null ? "default" : "explicit choice"})`, `Project: ${store.getProject(s.projectId)!.name} (${store.projectDeclaration(sessionId)})`,
        `Spend: ${totals.runs.noting} noting, ${totals.runs.consolidation} consolidation, ${totals.runs.manual} manual runs; ${totals.input + totals.output + totals.cacheRead + totals.cacheWrite} tokens; $${totals.cost.toFixed(4)}`,
        `Facts: ${store.listSessionFacts(sessionId).length} session; ${store.listProjectFacts(s.projectId).length} project`,
        `Knowledge: ${store.listVisibleKnowledge(sessionId, s.projectId).length} visible active`,
        ...(["noting", "consolidation"] as const).map((kind) => { const r = [...runs].reverse().find((r) => r.kind === kind); return `Last ${kind}: ${r ? `run ${r.id} ${r.outcome} ${r.createdAt} branch=${r.branch}` : "none"}`; }),
        `Pending deliveries: ${branches.reduce((n, b) => n + store.listPendingDeliveries(sessionId, b).length, 0)}`].join("\n");
    },
  };
}
