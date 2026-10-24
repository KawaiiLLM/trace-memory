// Ticket 136: `search` keeps four parameters (query, scope, layer, topk) and may run a script over its
// hits (`code`). A hit is one structured item; the default print is one line per item, and code decides
// what else to print. Order: knowledge, then facts, then Raw; BM25 within each layer,
// then current non-archived knowledge, then newer.
import { knowledgeCategoryGroup, KNOWLEDGE_SCOPES, type KnowledgeScope } from "../model/index.ts";
import { unicodeLength, type SourceEntry, type Store } from "../store/index.ts";
import { renderEntryWhole, renderFactPreview, snippet, rawResultText, knowledgeTitle, knowledgeStaleLabel } from "../render/index.ts";
import { capOutput, formatCodeResult, runCode } from "./code.ts";
import { knowledgeReadSelection } from "./knowledge-read.ts";

export type SearchLayer = "facts" | "knowledge" | "all" | "raw";
export const SEARCH_LAYERS: readonly SearchLayer[] = ["knowledge", "facts", "raw", "all"];
export interface SearchOptions {
  scope?: KnowledgeScope; topk?: number; code?: string;
  /** The reader's path; absent for an unbound reader, who sees every owner's knowledge. */
  sessionId?: number; branch?: string; headTurnId?: number | null;
  /** Writes an over-long output to a file and returns its path; absent where a host has no render directory. */
  spill?: (text: string) => string;
}
export const SEARCH_DEFAULT_TOPK = 10;
/** Raw bodies are read at most this many candidate Turns at a time. */
export const SEARCH_CHUNK_TURNS = 25;
const CHUNK_TURNS = SEARCH_CHUNK_TURNS;

/** One hit: the fields code receives (`lazy` names those read on first access) and its one-line print. */
interface Hit { item: Record<string, unknown>; line: () => string; load?: Record<"role" | "text" | "matchLines", () => unknown>;
  /** Hits of one chunk share a number; the first read of a lazy field answers it for all of them. */
  chunk?: number }
const raise = (message: string): never => { throw new Error(message); };

function searchTerms(query: string): string[] {
  const terms = [...query.matchAll(/"([^"]*)"?|([^\p{White_Space}"]+)/gu)].map(match => match[1] ?? match[2]!).filter(Boolean);
  if (!terms.length) throw new Error("query has no search terms: whitespace and empty quotes are ignored");
  return terms;
}

export function validateSearchInput(raw: unknown): { query?: string; layer?: SearchLayer; options: Pick<SearchOptions, "scope" | "topk" | "code"> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("expected an object");
  const input = raw as Record<string, unknown>;
  if (Object.keys(input).some(key => !["query", "scope", "layer", "topk", "code"].includes(key))) throw new Error("unexpected parameter");
  const { query, scope, layer, topk, code } = input;
  if (query !== undefined && (typeof query !== "string" || !query)) throw new Error("query must be a non-empty string");
  if (scope !== undefined && !KNOWLEDGE_SCOPES.includes(scope as KnowledgeScope)) throw new Error("scope must be session, project or global");
  if (layer !== undefined && !SEARCH_LAYERS.includes(layer as SearchLayer)) throw new Error("layer must be knowledge, facts, raw or all");
  if (topk !== undefined && (!Number.isSafeInteger(topk) || (topk as number) < 1)) throw new Error("topk must be a positive integer");
  if (code !== undefined && (typeof code !== "string" || !code.trim())) throw new Error("code must be non-empty JavaScript source");
  return { ...(query === undefined ? {} : { query: query as string }), ...(layer === undefined ? {} : { layer: layer as SearchLayer }),
    options: { ...(scope === undefined ? {} : { scope: scope as KnowledgeScope }), ...(topk === undefined ? {} : { topk: topk as number }),
      ...(code === undefined ? {} : { code: code as string }) } };
}

/** k-way merge of streams that are each newest first; an equal time keeps the earlier stream's hit first. */
function* newest(streams: Iterable<Hit>[]): Generator<Hit> {
  const heads = streams.map(stream => { const iterator = stream[Symbol.iterator](); return { iterator, next: iterator.next() }; });
  for (;;) {
    let best: (typeof heads)[number] | undefined;
    for (const head of heads) if (!head.next.done && (!best || String(head.next.value.item.time) > String(best.next.value!.item.time))) best = head;
    if (!best) return;
    yield best.next.value as Hit;
    best.next = best.iterator.next();
  }
}

function* chain(streams: Iterable<Hit>[]): Generator<Hit> { for (const stream of streams) yield* stream; }

export function searchFacade(store: Store) {
  return (query: string | undefined, layer: SearchLayer = "all", options: SearchOptions = {}): string | Promise<string> => {
    if (!SEARCH_LAYERS.includes(layer)) throw new Error("invalid search layer");
    if (options.scope !== undefined && !KNOWLEDGE_SCOPES.includes(options.scope)) throw new Error("invalid knowledge scope filter");
    const terms = query === undefined ? undefined : searchTerms(query);
    const needles = terms?.map(term => term.toLocaleLowerCase());
    const ranked = terms?.some(term => unicodeLength(term) >= 3 && !term.includes("\u0000")) ?? false;
    const reader = options.sessionId === undefined ? undefined : store.getSession(options.sessionId) ?? undefined;
    if (options.sessionId !== undefined && !reader) throw new Error(`session S${options.sessionId} does not exist`);
    if (options.scope === "session" && !reader) throw new Error("scope:session requires a session context");
    // The default scope is `project`, so omitting it and writing it are one thing: everything this project can see,
    // that is its sessions' facts and Raw, and the knowledge of every scope applicable here (global, project, session).
    const scope = options.scope === "project" ? undefined : options.scope;
    const sessionIds = scope === "global" || !reader ? undefined : scope === "session" ? [reader.id]
      : store.projectSessionIds(reader.projectId);
    const limit = options.topk ?? (query === undefined ? Infinity : SEARCH_DEFAULT_TOPK);
    const wants = (name: "knowledge" | "facts" | "raw") => layer === "all" || layer === name;
    const turnSessions = new Map<number, number>();
    const sessionOfTurn = (turnId: number) => {
      let session = turnSessions.get(turnId);
      if (session === undefined) turnSessions.set(turnId, session = store.getTurn(turnId)?.sessionId ?? 0);
      return session;
    };

    function* knowledge(): Generator<Hit> {
      const selection = knowledgeReadSelection(store, { sessionId: options.sessionId, branch: options.branch, headTurnId: options.headTurnId,
        ...(scope ? { scope } : {}), versions: "history" });
      const candidates = query === undefined ? [...selection.byCommit.values()]
        : store.searchAddresses(terms!, "knowledge", sessionIds).map(address => selection.byCommit.get(Number(address.split("@")[1]))!);
      const eligible = candidates.filter(revision => revision && selection.eligible(revision));
      const ranks = terms === undefined ? new Map<number, number>() : store.searchRanks(terms, "knowledge", eligible.map(r => r.id));
      eligible.sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0)
        || (!ranked ? 0 : Number(selection.current.has(b.id) && b.op !== "archive") - Number(selection.current.has(a.id) && a.op !== "archive"))
        || b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
      const ordinals = store.versionOrdinals(eligible.map(revision => revision.id));
      for (const r of eligible) {
        const status = selection.current.has(r.id) ? r.op === "archive" ? "archived" : "current" : "superseded";
        // 101: a legacy archive written before 99 has no body of its own; its parent's stands in.
        const text = r.op === "archive" && !r.text ? selection.byCommit.get(r.parentId ?? -1)?.text ?? "" : r.text;
        const group = knowledgeCategoryGroup(r.category), version = ordinals.get(r.id)!;
        const title = knowledgeTitle({ title: r.title, text }, store.writing.titleWords);
        yield { item: { layer: "knowledge", address: `trace://K${r.knowledgeId}@v${version}`, time: r.createdAt, text, title,
            id: r.knowledgeId, version, status, archiveKind: r.archiveKind ?? null, category: group, scope: r.scope, topics: r.topics,
            supports: r.supports, reason: r.reason },
          line: () => `[K${r.knowledgeId}@v${version}] ${status === "current" ? "" : `(${status}) `}[${group}/${r.scope}] ${title}${knowledgeStaleLabel({ staleReasons: store.knowledgeStaleReasons(r.id) })} — ${snippet(text, terms)}` };
      }
    }

    function* facts(): Generator<Hit> {
      const ids = query === undefined
        ? (sessionIds ?? store.listSessions().map(s => s.id)).flatMap(id => store.listSessionFacts(id).map(fact => fact.id))
        : store.searchAddresses(terms!, "facts", sessionIds).map(address => Number(address.slice(1)));
      const ranks = terms === undefined ? new Map<number, number>() : store.searchRanks(terms, "facts", ids);
      const found = store.factsByIds(ids).sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0)
        || b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
      const citing = store.citingKnowledge(found.map(fact => fact.id));
      for (const fact of found) {
        const session = sessionOfTurn(fact.turnId);
        const sources = (fact.segments ?? []).map((text, i) => ({ address: `trace://raw/S${session}/${fact.source[i]!.replace(/@(user|assistant|observation)$/u, "")}`,
          role: fact.roles?.[i]?.role ?? null, text }));
        yield { item: { layer: "facts", address: `trace://F${fact.id}`, session, turn: fact.turnId, time: fact.createdAt, text: fact.text,
            id: fact.id, title: fact.title ?? null, sources, citedBy: [...(citing.get(fact.id)?.keys() ?? [])] },
          line: () => renderFactPreview(fact, new Set(["text"]), Infinity, terms) };
      }
    }

    function* raw(): Generator<Hit> {
      const turnIds = query === undefined
        ? (sessionIds ?? store.listSessions().map(s => s.id)).flatMap(id => store.listTurns(id).map(turn => turn.id))
        : store.searchAddresses(terms!, "raw", sessionIds).map(address => Number(address.slice(1)));
      const ranks = store.rawSearchRanks(terms ?? [], turnIds);
      const time = (id: number) => ranks.get(id)?.startedAt ?? "";
      if (!ranked) turnIds.sort((a, b) => b - a);
      else turnIds.sort((a, b) => (ranks.get(a)?.score ?? 0) - (ranks.get(b)?.score ?? 0)
        || time(b).localeCompare(time(a)) || b - a);
      const pending: { hit: Hit; score: number; turn: number }[] = [];
      const compare = (a: { score: number; turn: number }, b: { score: number; turn: number }) =>
        a.score - b.score || time(b.turn).localeCompare(time(a.turn)) || b.turn - a.turn;
      // Read the most promising Turns first. Keep entries behind any unread Turn that could outrank them.
      for (let from = 0; from < turnIds.length; from += CHUNK_TURNS) {
        const chunk = turnIds.slice(from, from + CHUNK_TURNS);
        // Candidates come from metadata alone (id and ordinal). A chunk's bodies are read together, once, the
        // first time any of its entries needs its text, role or matching lines: by the query filter below, a
        // default print, or a script. A search that only counts its hits reads none.
        const refs = store.listSourceEntryRefsOf(chunk);
        const ids = [...refs.values()].flatMap(list => list.map(ref => ref.id));
        let bodies: Map<number, SourceEntry> | undefined;
        const body = (id: number) => (bodies ??= new Map(store.hydrateSourceEntries(ids).map(entry => [entry.id, entry]))).get(id);
        const cited = store.factsCitingEntries(ids);
        for (const turnId of chunk) {
          const turn = ranks.get(turnId) ?? store.getTurn(turnId);
          if (!turn) continue;
          for (const { id, entryOrdinal } of refs.get(turnId) ?? []) {
            const entry = () => body(id) ?? raise(`source entry ${id} has no stored body`);
            // The text is the entry's exact Read: the same renderer and result extractor as `trace://raw/...#E<k>`
            // (never the host's), so `matchLines` number that Read's lines.
            let rendered: string | undefined;
            const text = () => rendered ??= renderEntryWhole(entry(), rawResultText, undefined, undefined, true).content;
            if (needles !== undefined) {
              if (!body(id)) continue;
              const lower = text().toLocaleLowerCase();
              if (!needles.every(term => lower.includes(term))) continue;
            }
            const role = () => entry().role === "toolResult" ? "observation" : entry().role;
            const label = `S${turn.sessionId}/T${turnId}#E${entryOrdinal}`;
            const matchLines = () => needles === undefined ? [] : text().split("\n").flatMap((line, index) => {
              const lower = line.toLocaleLowerCase();
              return needles.some(term => lower.includes(term)) ? [index + 1] : [];
            });
            // The line opens with its own label, so the snippet leaves out the label the entry's text opens with.
            const snippetBody = () => text().replace(new RegExp(`^\\[T${turnId}#E${entryOrdinal}@${role()}\\] (?:${role()}: )?`), "");
            const hit: Hit = { item: { layer: "raw", address: `trace://raw/${label}`, session: turn.sessionId, turn: turnId, time: turn.startedAt,
                entry: entryOrdinal, citedBy: cited.get(id) ?? [], lazy: ["role", "text", "matchLines"] },
              line: () => `[${label}@${role()}] ${snippet(snippetBody(), terms)}`, load: { role, text, matchLines }, chunk: from };
            if (!ranked) yield hit;
            else {
              const fields = ranks.get(turnId)?.fields;
              const source = entry();
              let score = fields?.get(`0:${source.role === "user" ? "user_prompt" : source.role === "assistant" ? "assistant_text" : ""}`) ?? 0;
              for (const call of source.calls) {
                score = Math.min(score, fields?.get(`${call.ordinal}:tool_name`) ?? 0,
                  fields?.get(`${call.ordinal}:${source.role === "toolResult" ? "tool_result" : "tool_input"}`) ?? 0);
              }
              pending.push({ hit, score, turn: turnId });
            }
          }
        }
        if (ranked) {
          pending.sort(compare);
          const nextTurn = turnIds[from + CHUNK_TURNS];
          const bound = nextTurn === undefined ? undefined : { score: ranks.get(nextTurn)?.score ?? 0, turn: nextTurn };
          let count = 0;
          while (count < pending.length && (!bound || compare(pending[count]!, bound) <= 0)) yield pending[count++]!.hit;
          pending.splice(0, count);
        }
      }
    }

    // With a query, layers print in a fixed order (knowledge, facts, Raw), each ranked by itself. Without one
    // there is no relevance to rank by, so the layers merge newest first (derived, not ruled: `trace://`
    // listings already put the newest first).
    const layers = (["knowledge", "facts", "raw"] as const).filter(wants).map(name => ({ knowledge, facts, raw })[name]());
    const ordered = query === undefined && layers.length > 1 ? newest(layers) : chain(layers);
    const hits: Hit[] = [];
    for (const hit of ordered) { if (hits.length >= limit) break; hits.push(hit); }

    if (options.code === undefined) {
      const lines = hits.map(hit => hit.line());
      if (!lines.length) return "No hit. Every term must appear in one item; try fewer terms. No hit does not mean absent.";
      if (hits.length >= limit && Number.isFinite(limit)) lines.push(`(topk ${limit} reached; more may match. Raise topk or add code to filter.)`);
      return capOutput(lines.join("\n"), options.spill);
    }
    const chunks = new Map<number, number[]>();
    hits.forEach((hit, index) => { if (hit.chunk !== undefined) chunks.set(hit.chunk, [...chunks.get(hit.chunk) ?? [], index]); });
    return runCode(options.code, {
      items: hits.map(hit => ({ ...hit.item })),
      // 138: one reply carries a small field (role, matchLines) for every hit of the asked hit's chunk, so a script
      // that reads it for each hit crosses the thread once per chunk, not once per hit. A chunk's bodies are already
      // read together. `text` answers for the asked hit alone: the worker keeps every reply, so batching texts would
      // copy bodies the script never reads into its 256 MB (reading the user messages' text of a 43,000-entry
      // session ran out of memory).
      field: (index, name) => {
        const answer: Record<number, unknown> = {};
        const asked = name === "text" ? [index] : chunks.get(hits[index]!.chunk!) ?? [index];
        for (const i of asked) answer[i] = hits[i]!.load?.[name as "role" | "text" | "matchLines"]?.();
        return answer;
      },
      render: index => hits[index]!.line(),
    }).then(output => formatCodeResult(output, options.spill));
  };
}

/** The model-facing definition. The hit types are declared as TypeScript (as Pi's codemode and omp's
 * Code Mode declare theirs); a test holds the declaration to the fields real hits carry. */
export const SEARCH_HIT_TYPES = `type Hit = Knowledge | Fact | Raw;
interface Base { address: string; time: string; text: string }
interface Knowledge extends Base { layer: "knowledge"; title: string; id: number; version: number; status: "current" | "superseded" | "archived"; archiveKind: "budget" | "invalid" | "inadmissible" | null; category: string; scope: "global" | "project" | "session"; topics: string[]; supports: number[]; reason: string }
interface Fact extends Base { layer: "facts"; session: number; turn: number; id: number; title: string | null; sources: { address: string; role: string | null; text: string }[]; citedBy: number[] }
interface Raw extends Base { layer: "raw"; session: number; turn: number; entry: number; role: "user" | "assistant" | "observation"; matchLines: number[]; citedBy: number[] }`;

export const searchToolDefinition = {
  name: "search" as const,
  description: `Search knowledge (every version, marked with its status), facts and raw. Every space-separated term must appear in one item (case-insensitive); double quotes keep a phrase. Without query it lists the newest. topk caps hits across layers (default 10 with a query). A hit prints as one line; pass code to filter and print instead. No hit does not mean absent.
code is an async function body run in a sandbox (no files, network or modules; 10 s, 256 MB; output capped at 10000 tokens). Print with text(), console.log() or return.
declare const hits: Hit[]; // at most topk
declare function render(hit: Hit): string; // its one-line print
declare function text(value: unknown): void; declare function exit(): void;
${SEARCH_HIT_TYPES}
Example: code: "for (const h of hits) if (h.layer === 'knowledge' && h.status === 'archived') text(render(h))"`,
  parameters: { type: "object", additionalProperties: false, required: [], properties: {
    query: { type: "string", minLength: 1 },
    scope: { enum: [...KNOWLEDGE_SCOPES], default: "project", description: "project (default): everything this project can see, that is its facts and Raw and the knowledge of every scope applicable here. session: this session's facts and Raw and session knowledge. global: every session's facts and Raw and global knowledge." },
    layer: { enum: ["knowledge", "facts", "raw", "all"], default: "all" },
    topk: { type: "integer", minimum: 1 },
    code: { type: "string" },
  } },
};
