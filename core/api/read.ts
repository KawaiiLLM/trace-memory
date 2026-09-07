import { randomUUID } from "node:crypto";
import type { TraceMemoryConfig } from "./index.ts";
import type { Store, KnowledgeWithRevision, KnowledgePath } from "../store/index.ts";
import { freezeRecording } from "../recording/index.ts";
import { budgetKnowledge, budgetFacts, finish, listingLine, renderKnowledgeBlock, renderKnowledge, renderFact, renderTurn, xmlBlock } from "../render/index.ts";

export interface ListingOptions { cap?: number; cursor?: string; tool?: number; full?: boolean; sessionId?: number; headTurnId?: number | null }
export type SearchScope = "facts" | "knowledge" | "all" | "raw";

export function readFacade(store: Store, config: TraceMemoryConfig, expand: (address: string, options?: ListingOptions) => string) {
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
  const knowledgeFor = (projectId: number, sessionId = 0, headTurnId?: number | null) => {
    const active = budgetKnowledge(store.listVisibleKnowledge(sessionId, projectId, headTurnId), config.render.knowledgeBlockTokens, knowledgeLine);
    return { content: renderKnowledgeBlock(active.groups), receipts: active.receipts };
  };
  const knowledge = (id: number, headTurnId?: number | null) => knowledgeFor(session(id).projectId, id, headTurnId);
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
  return {
    trace,
    // Knowledge are injected once, at session start (ruling: "约束最前", grilling Q15); deliveries ride every
    // prompt (ruling 08:53: recording results are injected with the next user message). Two reads, one job each.
    inject: (target: number | { projectId: number } | KnowledgePath): string => {
      if (typeof target === "object" && "sessionId" in target) return finish(knowledge(target.sessionId, target.headTurnId));
      if (typeof target === "object") {
        // First prompt: no session id yet (allocated at the first reply), so no session knowledge.
        if (!store.getProject(target.projectId)) throw new Error(`project ${target.projectId} does not exist`);
        return finish(knowledgeFor(target.projectId));
      }
      return finish(knowledge(target));
    },
    deliver: (sessionId: number, branch: string | null = "main"): { text: string; runIds: number[] } => {
      session(sessionId);
      return store.deliver(sessionId, branch, (facts) => facts.length ? xmlBlock("recorded", facts.map((f) => factLine(f.id)).join("\n")) : "");
    },
    // Ruling 2026-09-07: a delivery is confirmed only after the host persisted it (at the turn's stop);
    // an unconfirmed delivery is rendered again next time. Duplicates are allowed, silent loss is not.
    confirmDelivery: (runIds: number[]): void => { store.confirmDeliveries(runIds); },
    compact: (sessionId: number, branch = "main", headTurnId?: number): string => {
      const block = knowledge(sessionId, store.knowledgePath(sessionId, branch, headTurnId).headTurnId);
      const after = store.getWatermark(sessionId, branch)?.lastRecordedTurn ?? 0;
      const turns = headTurnId === undefined ? store.listTurns(sessionId).filter((t) => t.id > after)
        : freezeRecording(store, { sessionId, branch, headTurnId }, config).turns.map((t) => t.turn);
      const raw = turns.map((t) => renderTurn(t, store.listToolCalls(t.id), config.render));
      const rawText = raw.map((r) => r.content).join("\n\n");
      const facts = store.listSessionFacts(sessionId);
      const episodic = budgetFacts(rawText, facts, (f) => factLine(f.id), config.render.episodicBlockTokens);
      return finish({ content: `${block.content}\n\n${xmlBlock("episodic", ["Raw:", rawText, "Recent facts (newest first):", episodic.recent.join("\n")].join("\n\n"))}`,
        receipts: [...block.receipts, ...raw.flatMap((r) => r.receipts), ...episodic.receipts] });
    },
    branchSummary: (sessionId: number, branch: string, headTurnId: number): string => {
      const tail = freezeRecording(store, { sessionId, branch, headTurnId }, config).turns;
      const raw = tail.map(({ turn, calls }) => renderTurn(turn, calls, config.render));
      const path = { sessionId, headTurnId }, turns = store.pathTurns(path);
      const facts = store.listSessionFacts(sessionId).filter(f => store.factOnPath(f, path, turns)).sort((a, b) => a.id - b.id);
      const factIds = new Set(facts.map(f => f.id));
      const commits = store.listKnowledgeRevisions().filter(r => store.commitApplies(r, path) &&
        [...r.supports, ...(r.because ?? [])].some(id => factIds.has(id)))
        .map(revision => ({ knowledge: store.getKnowledge(revision.knowledgeId)!, revision }));
      const content = ["this is knowledge from another branch; it must not be written as facts; the Recorder's facts come only from the current branch's conversation, never from messages this plugin injected.",
        "Facts:", ...facts.map(f => factLine(f.id)), "Commits (by evidence):", ...commits.map(knowledgeLine),
        "Unrecorded raw:", ...raw.map(r => r.content), ...raw.flatMap(r => r.receipts)].join("\n");
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
      const s = session(sessionId), runs = store.listRuns(sessionId), watermarks = store.listWatermarks(sessionId);
      const branches = [...new Set([...watermarks.map((w) => w.branch), ...runs.map((r) => r.branch)])];
      return [`Session: S${sessionId}`, `Project: ${store.getProject(s.projectId)!.name} (${store.projectDeclaration(sessionId)})`,
        `Facts: ${store.listSessionFacts(sessionId).length} session; ${store.listProjectFacts(s.projectId).length} project`,
        `Knowledge: ${store.listVisibleKnowledge(sessionId, s.projectId).length} visible active`,
        ...(watermarks.length ? [] : ["Watermarks: none"]),
        ...watermarks.map((w) => `Watermark ${w.branch}: recorded ${w.lastRecordedTurn ? `T${w.lastRecordedTurn}` : "none"}; integrated ${w.lastIntegratedFact ? `F${w.lastIntegratedFact}` : "none"}`),
        ...(["recording", "integration"] as const).map((kind) => { const r = [...runs].reverse().find((r) => r.kind === kind); return `Last ${kind}: ${r ? `run ${r.id} ${r.outcome} ${r.createdAt} branch=${r.branch}` : "none"}`; }),
        `Pending deliveries: ${branches.reduce((n, b) => n + store.listPendingDeliveries(sessionId, b).length, 0)}`].join("\n");
    },
  };
}
