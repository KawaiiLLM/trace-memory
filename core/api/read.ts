import { randomUUID } from "node:crypto";
import type { TraceMemoryConfig } from "./index.ts";
import type { Store, EntryWithRevision } from "../store/index.ts";
import { freezeNote } from "../note/index.ts";
import { budgetEntries, budgetFacts, finish, listingLine, renderEntriesBlock, renderEntry, renderFact, renderTurn, xmlBlock } from "../render/index.ts";

export interface ListingOptions { cap?: number; cursor?: string }
export type SearchScope = "facts" | "entries" | "all" | "raw";
export type MarkInput = { sessionId: number; project: string; source?: "marker" | "mark" }
  | { entryId: number; kind: "verified" | "flagged" | "clear" };

export function readFacade(store: Store, config: TraceMemoryConfig, expand: (address: string) => string) {
  const cursors = new Map<string, { lines: string[]; footer: string; cap: number }>();
  const page = (lines: string[], options: ListingOptions = {}, footer = ""): string => {
    const saved = options.cursor ? cursors.get(options.cursor) : undefined;
    if (options.cursor && !saved) throw new Error("unknown or expired cursor");
    const cap = options.cap ?? saved?.cap ?? 100;
    if (!Number.isSafeInteger(cap) || cap < 1) throw new Error("listing cap must be a positive integer");
    if (saved) { lines = saved.lines; footer = saved.footer; }
    const receipts = footer ? [footer] : [];
    if (lines.length > cap) {
      const cursor = randomUUID();
      cursors.set(cursor, { lines: lines.slice(cap), footer, cap });
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
  const entryLine = (value: EntryWithRevision) => renderEntry(value, store.listMarks(value.entry.id).filter((m) => m.rev === value.revision.rev));
  const entriesFor = (projectId: number, sessionId = 0) => {
    const active = budgetEntries(store.listVisibleEntries(sessionId, projectId), config.render.entriesBlockTokens, entryLine);
    return { content: renderEntriesBlock(active.groups), receipts: active.receipts };
  };
  const entries = (id: number) => entriesFor(session(id).projectId, id);
  const trace = (address: string, options: ListingOptions = {}): string => {
    const cursor = /^cursor=(\S+)$/.exec(address.trim());
    if (options.cursor || cursor) return page([], { ...options, cursor: options.cursor ?? cursor![1] });
    const listing = /^(.*) cap=(\d+)$/.exec(address);
    if (listing && !/^(?:S\d+\/)?T\d+(?:\s|$)/.test(address)) {
      address = listing[1]!; options = { ...options, cap: Number(listing[2]) };
    }
    const targets = address.split(",").map((a) => a.trim());
    if (targets.length > 1) return page(targets.flatMap((a) => trace(a, { cap: Number.MAX_SAFE_INTEGER }).split("\n")), options);
    const s = /^S([1-9]\d*)$/.exec(address);
    if (s) { session(Number(s[1])); return page(store.listTurns(Number(s[1])).map((t) => listingLine(expand(`T${t.id}`))), options); }
    let project = store.findProjectByName(address);
    while (project?.mergedInto != null) project = store.getProject(project.mergedInto);
    if (project) return page([...store.listVisibleEntries(0, project.id).map(entryLine),
      ...store.listProjectFacts(project.id).map((f) => factLine(f.id))].map(listingLine), options);
    const result = expand(address);
    return /^(E|F\d+\.\.)/.test(address) || options.cap !== undefined ? page(result.split("\n"), options) : result;
  };
  return {
    trace,
    // Entries are injected once, at session start (ruling: "约束最前", grilling Q15); deliveries ride every
    // prompt (ruling 08:53: note results are injected with the next user message). Two reads, one job each.
    inject: (target: number | { projectId: number }): string => {
      if (typeof target === "object") {
        // First prompt: no session id yet (allocated at the first reply), so no session entries.
        if (!store.getProject(target.projectId)) throw new Error(`project ${target.projectId} does not exist`);
        return finish(entriesFor(target.projectId));
      }
      return finish(entries(target));
    },
    deliver: (sessionId: number, branch: string | null = "main"): string => {
      session(sessionId);
      return store.deliver(sessionId, branch, (facts) => facts.length ? xmlBlock("pending_notes", facts.map((f) => factLine(f.id)).join("\n")) : "");
    },
    compact: (sessionId: number, branch = "main", headTurnId?: number): string => {
      const block = entries(sessionId);
      const after = store.getWatermark(sessionId, branch)?.lastNotedTurn ?? 0;
      const turns = headTurnId === undefined ? store.listTurns(sessionId).filter((t) => t.id > after)
        : freezeNote(store, { sessionId, branch, headTurnId }, config).turns.map((t) => t.turn);
      const raw = turns.map((t) => renderTurn(t, store.listToolCalls(t.id), config.render));
      const rawText = raw.map((r) => r.content).join("\n\n");
      const facts = store.listSessionFacts(sessionId);
      const episodic = budgetFacts(rawText, facts, (f) => factLine(f.id), config.render.episodicBlockTokens);
      return finish({ content: `${block.content}\n\n${xmlBlock("episodic", ["Raw:", rawText, "Recent facts (newest first):", episodic.recent.join("\n")].join("\n\n"))}`,
        receipts: [...block.receipts, ...raw.flatMap((r) => r.receipts), ...episodic.receipts] });
    },
    branchSummary: (sessionId: number, branch: string, headTurnId: number): string => {
      const tail = freezeNote(store, { sessionId, branch, headTurnId }, config).turns;
      const raw = tail.map(({ turn, calls }) => renderTurn(turn, calls, config.render));
      const facts = store.listBranchFacts(sessionId, branch).map((f) => factLine(f.id));
      return finish({ content: [...facts, ...raw.map((r) => r.content)].join("\n\n"),
        receipts: raw.flatMap((r) => r.receipts) });
    },
    search: (query: string, scope: SearchScope = "all", options: ListingOptions & { sessionId?: number } = {}): string => {
      if (options.cursor) return page([], options);
      if (!["facts", "entries", "all", "raw"].includes(scope)) throw new Error("invalid search scope");
      const lines = store.searchAddresses(query, scope, options.sessionId).map((address) => {
        if (address.startsWith("F")) return factLine(Number(address.slice(1)));
        if (address.startsWith("T")) return expand(address);
        const [id, rev] = address.slice(1).split("@").map(Number);
        return entryLine({ entry: store.getEntry(id!)!, revision: store.getEntryRevision(id!, rev!)! });
      }).map(listingLine);
      return page(lines, options, `${scope === "raw" ? "Raw search uses literal LIKE over turns and tool calls. " : "Search uses FTS5 over stored fact text and entry revisions. "}No hit does not mean absent.`);
    },
    mark: (input: MarkInput): string => {
      if ("project" in input) {
        const project = store.declareProject(input.sessionId, input.project, input.source ?? "mark");
        return `S${input.sessionId} project: ${project.name} (${store.projectDeclaration(input.sessionId)})`;
      }
      if (!["verified", "flagged", "clear"].includes(input.kind)) throw new Error("invalid mark kind");
      const rev = store.setMark(input.entryId, input.kind, new Date().toISOString());
      return `E${input.entryId}@${rev}: ${input.kind}`;
    },
    status: (sessionId: number): string => {
      const s = session(sessionId), runs = store.listRuns(sessionId), watermarks = store.listWatermarks(sessionId);
      const branches = [...new Set([...watermarks.map((w) => w.branch), ...runs.map((r) => r.branch)])];
      return [`Session: S${sessionId}`, `Project: ${store.getProject(s.projectId)!.name} (${store.projectDeclaration(sessionId)})`,
        `Facts: ${store.listSessionFacts(sessionId).length} session; ${store.listProjectFacts(s.projectId).length} project`,
        `Entries: ${store.listVisibleEntries(sessionId, s.projectId).length} visible active`,
        ...(watermarks.length ? [] : ["Watermarks: none"]),
        ...watermarks.map((w) => `Watermark ${w.branch}: noted ${w.lastNotedTurn ? `T${w.lastNotedTurn}` : "none"}; settled ${w.lastSettledFact ? `F${w.lastSettledFact}` : "none"}`),
        ...(["note", "settle"] as const).map((kind) => { const r = [...runs].reverse().find((r) => r.kind === kind); return `Last ${kind}: ${r ? `run ${r.id} ${r.outcome} ${r.createdAt} branch=${r.branch}` : "none"}`; }),
        `Pending deliveries: ${branches.reduce((n, b) => n + store.listPendingDeliveries(sessionId, b).length, 0)}`].join("\n");
    },
  };
}
