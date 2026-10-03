// /tm is a read-only, host-neutral namespace. Hosts own pagination and output limits.
import type { TraceMemory } from "./index.ts";
import type { KnowledgeRevision } from "../model/index.ts";
import type { SourceEntry } from "../store/index.ts";
import { MEMORY_ROOT, memoryPath, parseMemoryViewPath } from "../model/address.ts";
import { renderEntryWhole } from "../render/index.ts";
import { canonicalToolNames, type ToolNames } from "../prompts/tool-names.ts";
import { readingGuide } from "../render/reading-guide.ts";

export { MEMORY_ROOT, MEMORY_READ_ONLY, memoryPath, memoryGlob } from "../model/address.ts";

/** Whose view a `/tm` file shows: the reader's own path, as a host binds `trace`. */
export interface MemoryReader { sessionId?: number; branch?: string; headTurnId?: number | null; projectId?: number; toolNames?: ToolNames }
export interface MemoryFile { content: string; unbounded: boolean }
export type MemoryGrepMode = "files_with_matches" | "content" | "count";
export interface MemoryGrepOptions {
  ignoreCase?: boolean; literal?: boolean;
  /** Filters searched files: matched against the base name, or the path under the searched directory when it holds a `/`. */
  glob?: string;
}
/** Unformatted matches: each host owns output modes, context, pagination and truncation. */
export interface MemoryGrepFile { path: string; lines: string[]; hits: number[]; mark?: string }
export interface MemoryListing { lines: string[]; total: number }

const VISIBLE = `${MEMORY_ROOT}/knowledge`, ALL = `${MEMORY_ROOT}/knowledge-all`;
const SESSION = /^\/tm\/S([1-9]\d*)$/;
const LAYER = /^\/tm\/(facts|raw)$/;
const LAYER_SESSION = /^\/tm\/(facts|raw)\/S([1-9]\d*)$/;
const LAYER_TURN = /^\/tm\/(facts|raw)\/S([1-9]\d*)\/T([1-9]\d*)$/;
const KNOWLEDGE = /^\/tm\/K[1-9]\d*(?:#[a-z]{4,}|@v[1-9]\d*)?$/;
const FACT = /^\/tm\/F[1-9]\d*$/;
const HISTORY = /^\/tm\/(K[1-9]\d*)\.history$/;
const PREVIEW = 160;
const preview = (text: string) => { const line = text.split("\n")[0]!; return line.length > PREVIEW ? `${line.slice(0, PREVIEW)}…` : line; };

/** One glob segment (`*`, `?`, `{a,b}`) or, with `/`, a whole relative path (`**` spans segments). */
function globRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") { if (glob[i + 1] === "*") { source += ".*"; i++; } else source += "[^/]*"; }
    else if (c === "?") source += "[^/]";
    else if (c === "{") source += "(?:";
    else if (c === "}") source += ")";
    else if (c === ",") source += /\{[^}]*$/.test(glob.slice(0, i)) ? "|" : ",";
    else source += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/** A revision's body for listing and search alike (101 ruled): its own text, or — for a legacy
 * archive written before 99 (empty body, no kind) — its parent's, found in the same identity's
 * version list. */
const revisionBody = (revision: KnowledgeRevision, list: readonly KnowledgeRevision[]): string =>
  revision.op === "archive" && !revision.text ? list.find(r => r.id === revision.parentId)?.text ?? "" : revision.text;

export function memoryFiles(memory: TraceMemory, reader: MemoryReader) {
  const store = memory.store;
  const toolNames = reader.toolNames ?? canonicalToolNames;
  const bound = reader.sessionId === undefined ? {} : { sessionId: reader.sessionId, headTurnId: reader.headTurnId,
    ...(reader.branch === undefined ? {} : { branch: reader.branch }) };
  const full = (address: string, extra: { versions?: "history"; sessionId?: number; branch?: string; headTurnId?: number | null;
    rawTurn?: boolean; fileFacts?: boolean; full?: boolean } = {}) =>
    memory.trace(address, { modelFacing: true, pageBudget: null,
      itemBudget: null, toolCallBudget: null, toolResultBudget: null, ...bound, ...extra, toolNames });
  const resolve = (raw: string) => {
    const path = memoryPath(raw);
    if (!path) throw new Error(`not a Trace Memory path: ${raw}`);
    return path;
  };
  const session = (id: number) => {
    const value = store.getSession(id);
    if (!value) throw new Error(`no such path: session S${id} does not exist`);
    return value;
  };
  const projectName = (id: number | null) => id === null ? "no project" : store.getProject(id)?.name ?? `project ${id}`;
  const selectedPath = (sessionId: number, turnId?: number) => {
    const current = sessionId === reader.sessionId
      ? store.knowledgePath(sessionId, reader.branch, reader.headTurnId) : store.currentPath(sessionId);
    const headTurnId = turnId ?? current.headTurnId;
    if (headTurnId == null) throw new Error(`no such path: session S${sessionId} has no current Turn`);
    if (store.getTurn(headTurnId)?.sessionId !== sessionId)
      throw new Error(`no such path: T${headTurnId} is not in S${sessionId}`);
    if (turnId === undefined || current.headTurnId != null && store.pathTurns(current).has(turnId))
      return { sessionId, branch: current.branch, headTurnId };
    // A stored Turn need not belong to any selected source path. Read its entries unbound, as main did.
    return { sessionId, branch: store.sourceBranchContainingTurn(sessionId, turnId) ?? undefined, headTurnId };
  };
  const entriesOf = (sessionId: number, turnId: number) =>
    store.listSourceEntries(sessionId, turnId, selectedPath(sessionId, turnId).branch);
  const visible = () => {
    const projectId = reader.projectId ?? (reader.sessionId === undefined ? undefined : session(reader.sessionId).projectId);
    return projectId === undefined ? [] : store.listVisibleKnowledge(reader.sessionId ?? 0, projectId, reader.headTurnId, reader.branch);
  };
  /** Every identity's versions in order, for the all-scope listing and its search. */
  const versions = () => {
    const revisions = store.listKnowledgeRevisions();
    const ordinals = store.versionOrdinals(revisions.map(revision => revision.id));
    const records = store.knowledgeRecords([...new Set(revisions.map(revision => revision.knowledgeId))]);
    const byIdentity = new Map<number, KnowledgeRevision[]>();
    for (const revision of [...revisions].sort((a, b) => ordinals.get(a.id)! - ordinals.get(b.id)!)) {
      const list = byIdentity.get(revision.knowledgeId);
      if (list) list.push(revision); else byIdentity.set(revision.knowledgeId, [revision]);
    }
    return { identities: [...byIdentity].sort(([a], [b]) => a - b), records, ordinal: (revision: KnowledgeRevision) => ordinals.get(revision.id)! };
  };

  /** A directory's children as [path, label], or null when the path is not a directory. */
  const children = (path: string): [string, string][] | null => {
    if (path === MEMORY_ROOT) return [
      [VISIBLE, "directory: knowledge visible to you, current versions"],
      [ALL, "directory: every knowledge identity in every scope and project, archived included"],
      [`${MEMORY_ROOT}/facts`, "directory: Turn facts"],
      [`${MEMORY_ROOT}/raw`, "directory: full Raw entries"],
      ...store.listSessions().map(s => [`${MEMORY_ROOT}/S${s.id}`, `session · project ${projectName(s.projectId)} · ${s.host} · ${s.startedAt}`] as [string, string]),
      ...store.factHeadings().map(f => [`${MEMORY_ROOT}/F${f.id}`, preview(f.heading)] as [string, string]),
    ];
    if (path === VISIBLE) return visible().map(({ knowledge, revision }) =>
      [`${MEMORY_ROOT}/K${knowledge.id}`, `[${revision.category}/${revision.scope}] ${preview(revision.text)}`]);
    if (path === ALL) {
      const { identities, records, ordinal } = versions();
      return identities.map(([id, list]) => {
        const latest = list.at(-1)!, record = records.get(id)!;
        const body = revisionBody(latest, list);
        const owner = latest.scope === "global" ? "" : latest.scope === "session" ? ` S${record.originSessionId}` : ` ${projectName(record.projectId)}`;
        const status = latest.op === "archive" ? ` (archived at v${ordinal(latest)}${latest.archiveKind ? `, ${latest.archiveKind}` : ""})` : "";
        return [`${MEMORY_ROOT}/K${id}@v${ordinal(latest)}`, `[${latest.category}/${latest.scope}${owner}]${status} ${preview(body)}`];
      });
    }
    let m: RegExpExecArray | null;
    if ((m = SESSION.exec(path))) {
      session(Number(m[1]));
      return store.listTurns(Number(m[1])).flatMap(turn => [
        [`${MEMORY_ROOT}/facts/S${m![1]}/T${turn.id}`, `${turn.kind} ${turn.startedAt}`],
        [`${MEMORY_ROOT}/raw/S${m![1]}/T${turn.id}`, `${turn.kind} ${turn.startedAt}`],
      ] as [string, string][]);
    }
    if (LAYER.test(path)) return store.listSessions().map(s => [`${path}/S${s.id}`, ""]);
    if ((m = LAYER_SESSION.exec(path))) {
      session(Number(m[2]));
      return store.listTurns(Number(m[2])).map(turn => [`${path}/T${turn.id}`, ""]);
    }
    if ((m = LAYER_TURN.exec(path)) && m[1] === "raw") return entriesOf(Number(m[2]), Number(m[3]))
      .map(entry => [`${path}#E${entry.entryOrdinal}`, ""]);
    return null;
  };

  const fileText = (path: string): MemoryFile => {
    let m: RegExpExecArray | null;
    const view = parseMemoryViewPath(path);
    if (view) {
      const { sessionId: id, turnId, entryOrdinal, role, layer } = view;
      if (entryOrdinal !== undefined) {
        // E is Turn-local and immutable; a sibling-selected branch cannot hide it.
        if (!store.listSourceEntries(id, turnId!).some(entry => entry.entryOrdinal === entryOrdinal)) throw new Error(`no such path: ${path}`);
        return { content: full(`S${id}/T${turnId}#E${entryOrdinal}${role ? `@${role}` : ""}`,
          { sessionId: id, branch: undefined, headTurnId: turnId, full: true }), unbounded: true };
      }
      const node = selectedPath(id, turnId);
      if (layer === "knowledge") return { content: memory.injection(node, undefined, false, toolNames).text ||
        `(a fresh context at S${id}'s current head would receive no knowledge)`, unbounded: true };
      if (layer === "compact") {
        const compact = memory.compact(id, node.branch, node.headTurnId, undefined, false, { toolNames });
        if ("native" in compact) throw new Error(compact.reason);
        return { content: compact.text, unbounded: true };
      }
      const { sessionId, branch, headTurnId } = node;
      const target = `S${id}/T${headTurnId}`;
      if (layer === "facts") return { content: full(target, { sessionId, branch, headTurnId, fileFacts: true }), unbounded: false };
      return { content: memory.trace(target + (role ? `@${role}` : ""), { modelFacing: true, pageBudget: null,
        sessionId, branch, headTurnId, rawTurn: true, toolNames }), unbounded: false };
    }
    if ((m = HISTORY.exec(path))) return { content: full(`${m[1]}.history`), unbounded: false };
    if (KNOWLEDGE.test(path)) return { content: full(path.slice(MEMORY_ROOT.length + 1)), unbounded: false };
    if (FACT.test(path)) {
      const id = Number(path.slice(MEMORY_ROOT.length + 2));
      const fact = store.getFact(id);
      if (!fact) throw new Error(`fact F${id} does not exist`);
      const owner = store.getTurn(fact.turnId);
      if (!owner) throw new Error(`fact F${id} has no owning Turn`);
      return { content: `Source session: S${owner.sessionId}\n${full(`F${id}`)}`, unbounded: false };
    }
    throw new Error(`no such path: ${path}; /tm`);
  };
  const read = (raw: string): MemoryFile => {
    const path = resolve(raw), listing = children(path);
    if (listing && (path === MEMORY_ROOT || path === VISIBLE || path === ALL || SESSION.test(path) || LAYER.test(path))) return { content: [
      ...(path === MEMORY_ROOT ? [readingGuide(reader.sessionId, toolNames)] : []),
      ...(listing.length ? SESSION.test(path)
        ? store.listTurns(Number(SESSION.exec(path)![1])).map(turn =>
          `${MEMORY_ROOT}/facts${path.slice(MEMORY_ROOT.length)}/T${turn.id}  ${MEMORY_ROOT}/raw${path.slice(MEMORY_ROOT.length)}/T${turn.id}  ${turn.kind} ${turn.startedAt}`)
        : listing.map(([child, label]) => LAYER.test(path) ? child : label ? `${child}  ${label}` : child) : ["(empty)"]),
    ].join("\n"), unbounded: false };
    return fileText(path);
  };

  /** Search enumerable leaves only; full entry bodies and full fact/knowledge text. */
  type Searched = { path: string; text: () => string; mark?: string };
  const whole = (entry: SourceEntry) => renderEntryWhole(entry, memory.resultText, undefined, undefined, true).content;
  function* turnFiles(sessionId: number, turnId: number, layer?: "facts" | "raw", role?: "user" | "assistant" | "observation"): Generator<Searched> {
    const factPath = `${MEMORY_ROOT}/facts/S${sessionId}/T${turnId}`;
    if (layer !== "raw") yield { path: factPath, text: () => fileText(factPath).content };
    if (layer === "facts") return;
    const meta = entriesOf(sessionId, turnId);
    for (const entry of store.hydrateSourceEntries(meta.map(e => e.id))) {
      if (role && (entry.role === "toolResult" ? "observation" : entry.role) !== role) continue;
      yield { path: `${MEMORY_ROOT}/raw/S${sessionId}/T${turnId}#E${entry.entryOrdinal}`, text: () => whole(entry) };
    }
  }
  function* searched(path: string): Generator<Searched> {
    if (path === MEMORY_ROOT) {
      yield* searched(VISIBLE); yield* searched(ALL);
      for (const s of store.listSessions()) yield* searched(`${MEMORY_ROOT}/S${s.id}`);
      for (const f of store.factHeadings()) yield { path: `${MEMORY_ROOT}/F${f.id}`, text: () => full(`F${f.id}`) };
      return;
    }
    if (path === VISIBLE) {
      for (const { knowledge } of visible()) yield { path: `${MEMORY_ROOT}/K${knowledge.id}`, text: () => full(`K${knowledge.id}`) };
      return;
    }
    if (path === ALL) {
      // Every version, archives included (99), each marked when it is not its identity's latest.
      const { identities, ordinal } = versions();
      for (const [id, list] of identities) {
        const latest = list.at(-1)!, latestStatus = `latest v${ordinal(latest)}${latest.op === "archive" ? ", archived" : ""}`;
        for (const revision of list) {
          const address = `K${id}@v${ordinal(revision)}`;
          // 101 (ruled): a legacy empty archive is searched by its parent's body, same as its listing.
          const legacyEmpty = revision.op === "archive" && !revision.text;
          yield { path: `${MEMORY_ROOT}/${address}`, text: () => legacyEmpty ? revisionBody(revision, list) : full(address),
            mark: revision !== latest ? ` (historical; ${latestStatus})` : latest.op === "archive" ? " (archived)" : undefined };
        }
      }
      return;
    }
    let m: RegExpExecArray | null;
    if ((m = SESSION.exec(path))) {
      session(Number(m[1]));
      for (const turn of store.listTurns(Number(m[1]))) yield* turnFiles(Number(m[1]), turn.id);
      return;
    }
    if ((m = LAYER.exec(path))) {
      for (const s of store.listSessions()) yield* searched(`${path}/S${s.id}`);
      return;
    }
    if ((m = LAYER_SESSION.exec(path))) {
      session(Number(m[2]));
      for (const turn of store.listTurns(Number(m[2]))) yield* turnFiles(Number(m[2]), turn.id, m[1] as "facts" | "raw");
      return;
    }
    if ((m = LAYER_TURN.exec(path))) {
      yield* turnFiles(Number(m[2]), Number(m[3]), m[1] as "facts" | "raw"); return;
    }
    const view = parseMemoryViewPath(path);
    if (view?.entryOrdinal !== undefined) {
      const meta = store.listSourceEntries(view.sessionId, view.turnId!).find(e => e.entryOrdinal === view.entryOrdinal);
      if (!meta) throw new Error(`no such path: ${path}`);
      const entry = store.hydrateSourceEntries([meta.id])[0]!;
      if (view.role && (entry.role === "toolResult" ? "observation" : entry.role) !== view.role)
        throw new Error(`entry role does not match: ${path}`);
      yield { path, text: () => whole(entry) };
      return;
    }
    if (view?.layer === "raw") {
      const node = selectedPath(view.sessionId, view.turnId);
      yield* turnFiles(node.sessionId, node.headTurnId, "raw", view.role); return;
    }
    if (view || FACT.test(path) || KNOWLEDGE.test(path) || HISTORY.test(path)) {
      yield { path, text: () => fileText(path).content }; return;
    }
    throw new Error(`no such path: ${path}`);
  }


  function* grep(pattern: string, raw: string, options: MemoryGrepOptions = {}): Generator<MemoryGrepFile> {
    const root = resolve(raw);
    let regex: RegExp;
    try { regex = new RegExp(options.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, options.ignoreCase ? "i" : ""); }
    catch (error) { throw new Error(`invalid pattern: ${(error as Error).message}`); }
    const filter = options.glob ? globRegex(options.glob) : undefined;
    for (const file of searched(root)) {
      if (filter && !filter.test(options.glob!.includes("/") ? file.path.slice(root.length + 1) : basename(file.path))) continue;
      const lines = file.text().split("\n");
      const hits = lines.flatMap((line, index) => regex.test(line) ? [index] : []);
      if (hits.length) yield { path: file.path, lines, hits, ...(file.mark ? { mark: file.mark } : {}) };
    }
  }

  const glob = (pattern: string): MemoryListing => {
    const segments = resolve(pattern).split("/").slice(2);
    const found = new Set<string>();
    const walk = (path: string, rest: string[]) => {
      if (!rest.length) { found.add(path); return; }
      const [head, ...tail] = rest;
      if (head === "**") { walk(path, tail); for (const [child] of children(path) ?? []) walk(child, rest); return; }
      const matcher = globRegex(head!);
      for (const [child] of children(path) ?? []) if (matcher.test(basename(child))) walk(child, tail);
      // An E suffix is part of the T segment, not a further slash component.
      if (LAYER_SESSION.test(path) && path.startsWith(`${MEMORY_ROOT}/raw/`) && head!.includes("#"))
        for (const [turn] of children(path) ?? []) for (const [entry] of children(turn) ?? [])
          if (matcher.test(basename(entry))) walk(entry, tail);
    };
    walk(MEMORY_ROOT, segments);
    return { lines: [...found], total: found.size };
  };

  return { read, grep, glob };
}
