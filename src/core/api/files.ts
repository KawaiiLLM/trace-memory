// 101: Trace Memory as read-only files under /tm/, the same on every host. A file is what
// trace(<address>) shows the reader; a directory lists what it holds; Grep searches each file's text,
// and a Raw entry's complete text rather than its compressed view (ruled). Nothing here writes: no
// delivery is recorded and no read is remembered.
import type { TraceMemory } from "./index.ts";
import type { KnowledgeRevision } from "../model/index.ts";
import type { SourceEntry } from "../store/index.ts";
import { MEMORY_ROOT, memoryPath } from "../model/address.ts";
import { renderEntryWhole, tokens } from "../render/index.ts";
import { MAX_PUBLIC_READ_TOKENS } from "./read.ts";
import { canonicalToolNames, renderToolNames, type ToolNames } from "../prompts/tool-names.ts";

export { MEMORY_ROOT, MEMORY_READ_ONLY, memoryPath, memoryGlob } from "../model/address.ts";

/** Whose view a `/tm` file shows: the reader's own path, as a host binds `trace`. */
export interface MemoryReader { sessionId?: number; branch?: string; headTurnId?: number | null; projectId?: number; toolNames?: ToolNames }
export interface MemoryPage { lines: string[]; startLine: number; totalLines: number; cut?: string }
export type MemoryGrepMode = "files_with_matches" | "content" | "count";
export interface MemoryGrepOptions {
  mode?: MemoryGrepMode; ignoreCase?: boolean; literal?: boolean; before?: number; after?: number;
  /** Filters searched files: matched against the base name, or the path under the searched directory when it holds a `/`. */
  glob?: string;
  /** Output lines to skip, and at most how many to show, before the token cap. */
  offset?: number; limit?: number;
}
export interface MemoryListing { lines: string[]; cut?: string }

const VISIBLE = `${MEMORY_ROOT}/knowledge`, ALL = `${MEMORY_ROOT}/knowledge-all`;
const SESSION = /^\/tm\/S([1-9]\d*)$/, TURN = /^\/tm\/S([1-9]\d*)\/T([1-9]\d*)$/, ENTRY = /^\/tm\/S([1-9]\d*)\/T([1-9]\d*)\/E([1-9]\d*)$/;
const INHERITED = /^\/tm\/S([1-9]\d*)\/knowledge$/, HISTORY = /^\/tm\/(K[1-9]\d*)\.history$/;
const LEGEND = [
  "Trace Memory, read-only (write with the {{tool.note}} and {{tool.memory}} tools). A file shows what {{tool.trace}}(<address>) shows you. Grep lists matching files (content mode: path:line:text) and searches Raw entries in full, beyond their compressed view.",
  "/tm/knowledge: your visible knowledge · /tm/knowledge-all: every knowledge identity, other projects and archived ones included, at its latest version (Grep there searches every version)",
  "/tm/K<id>: current on your path · /tm/K<id>@v<n>: one version · /tm/K<id>#<tag>: an exact version · /tm/K<id>.history: its versions on your path",
  "/tm/F<id>: a fact and the knowledge citing it · /tm/S<n>: a session's Turns · /tm/S<n>/T<t>: a Turn (its facts and unprocessed Raw), also the directory of its Raw entries E<k>",
  "/tm/S<n>/knowledge: the knowledge a fresh context of S<n> receives (not listed; point a subagent at it) · /tm/<address>: any other {{tool.trace}} address, e.g. /tm/T12#E1..E5",
  "",
];
const PREVIEW = 160;
const preview = (text: string) => { const line = text.split("\n")[0]!; return line.length > PREVIEW ? `${line.slice(0, PREVIEW)}…` : line; };
const count = (value: number) => value.toLocaleString("en");

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

/** Content-mode line text above this length is windowed around its first match rather than shown
 * whole: otherwise a single oversized line (a long Raw line, or a full-body Grep hit on a manual
 * fact/knowledge that legally exceeds the ordinary per-item cap) could itself exceed the page's token
 * cap, and the generic cap-fit (capLines, below) would crop it from the front — losing a match near
 * the end and leaving the printed continuation offset nothing further to reach. */
const MATCH_WINDOW = 300;
function windowedLine(text: string, regex: RegExp): string {
  if (text.length <= MATCH_WINDOW * 6) return text;
  const match = regex.exec(text);
  if (!match) return text;
  const start = Math.max(0, match.index - MATCH_WINDOW), end = Math.min(text.length, match.index + match[0].length + MATCH_WINDOW);
  const before = start > 0 ? `…(${count(start)} characters omitted)… ` : "";
  const after = end < text.length ? ` …(${count(text.length - end)} characters omitted)…` : "";
  return `${before}${text.slice(start, end)}${after}`;
}

/** The longest prefix of `lines` whose rendering fits the cap, and the price of what it leaves. A
 * first line alone over the cap is cut by characters (ponytail: its rest is unreachable by offset;
 * trace's views keep lines far below the cap). */
function capLines(lines: readonly string[], render: (line: string, i: number) => string, cap = MAX_PUBLIC_READ_TOKENS):
  { kept: string[]; cutTokens?: number; cutChars?: { kept: number; of: number } } {
  let used = 0;
  for (let i = 0; i < lines.length; i++) {
    const cost = tokens(`${render(lines[i]!, i)}\n`);
    if (used + cost <= cap) { used += cost; continue; }
    const cutTokens = tokens(lines.slice(i).map((line, j) => render(line, i + j)).join("\n"));
    if (i > 0) return { kept: lines.slice(0, i), cutTokens };
    const line = lines[0]!;
    let low = 0, high = line.length;
    while (low < high) { const mid = Math.ceil((low + high) / 2); if (tokens(render(line.slice(0, mid), 0)) <= cap) low = mid; else high = mid - 1; }
    return { kept: [line.slice(0, low)], cutTokens: cutTokens - tokens(render(line.slice(0, low), 0)), cutChars: { kept: low, of: line.length } };
  }
  return { kept: [...lines] };
}
const capNotice = (tokensCut: number | undefined) => tokensCut === undefined ? ""
  : `cut at the ${count(MAX_PUBLIC_READ_TOKENS)}-token cap (about ${count(tokensCut)} tokens not shown): `;

export function memoryFiles(memory: TraceMemory, reader: MemoryReader) {
  const store = memory.store;
  const toolNames = reader.toolNames ?? canonicalToolNames;
  const bound = reader.sessionId === undefined ? {} : { sessionId: reader.sessionId, headTurnId: reader.headTurnId,
    ...(reader.branch === undefined ? {} : { branch: reader.branch }) };
  const trace = (address: string, extra: { versions?: "history" } = {}) =>
    memory.trace(address, { modelFacing: true, pageBudget: null, ...bound, ...extra, toolNames });
  /** Grep's search source for a fact or knowledge address: the same rendering `trace` gives a plain
   * read, with its per-item body compression removed. A manual fact or knowledge body may legally
   * exceed that compression's cap, and a needle in its middle must still be found; what Grep displays
   * of a match stays bounded regardless (windowedLine, below). Read keeps its own trace-equivalence
   * (fileText), unchanged. */
  const full = (address: string) => memory.trace(address, { modelFacing: true, pageBudget: null, itemBudget: null, ...bound, toolNames });
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
  /** A Turn's entries as the reader's trace sees them: its own branch in its own session. */
  const entriesOf = (sessionId: number, turnId: number) => {
    if (store.getTurn(turnId)?.sessionId !== sessionId) throw new Error(`no such path: T${turnId} is not in S${sessionId}`);
    return store.listSourceEntries(sessionId, turnId, sessionId === reader.sessionId ? reader.branch : undefined);
  };
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
      // S<n>/knowledge is deliberately not a child: a recursive search would render every session's injection.
      return store.listTurns(Number(m[1])).map(turn => [`${path}/T${turn.id}`, `${turn.kind} ${turn.startedAt}`]);
    }
    if ((m = TURN.exec(path))) return entriesOf(Number(m[1]), Number(m[2])).map(entry => [`${path}/E${entry.entryOrdinal}`, ""]);
    return null;
  };

  /** A file's whole text: the trace view its path names. */
  const fileText = (path: string): string => {
    let m: RegExpExecArray | null;
    if ((m = INHERITED.exec(path))) {
      // The injection selection with an empty delivered set and the normal budget; nothing is recorded.
      const id = Number(m[1]);
      return memory.injection(store.currentPath(id), undefined, false, toolNames).text || `(a fresh context at S${id}'s current head would receive no knowledge)`;
    }
    if ((m = HISTORY.exec(path))) return trace(m[1]!, { versions: "history" });
    if ((m = ENTRY.exec(path))) return trace(`S${m[1]}/T${m[2]}#E${m[3]}`);
    if (path === MEMORY_ROOT || path === VISIBLE || path === ALL || SESSION.test(path)) throw new Error(`${path} is a directory`);
    return trace(path.slice(MEMORY_ROOT.length + 1));
  };
  /** Read's lines of a path: a directory's children (a Turn is read as its file), or a file's text. */
  const lines = (path: string): string[] => {
    const listing = TURN.test(path) ? null : children(path);
    if (!listing) return fileText(path).split("\n");
    return [...(path === MEMORY_ROOT ? LEGEND.map(line => renderToolNames(line, toolNames)) : []), ...(listing.length ? listing.map(([child, label]) => label ? `${child}  ${label}` : child) : ["(empty)"])];
  };

  const read = (raw: string, offset = 1, limit = 2000): MemoryPage => {
    const path = resolve(raw), all = lines(path);
    const start = Math.max(1, Math.floor(offset)), size = Math.max(1, Math.floor(limit));
    if (start > all.length) throw new Error(`offset ${start} is past the end of ${path} (${all.length} lines)`);
    const fit = capLines(all.slice(start - 1, start - 1 + size), (line, i) => `${start + i}\t${line}`);
    const next = start + fit.kept.length;
    if (next > all.length) return { lines: fit.kept, startLine: start, totalLines: all.length };
    const partial = fit.cutChars ? `line ${start} shows ${count(fit.cutChars.kept)} of ${count(fit.cutChars.of)} characters; ` : "";
    return { lines: fit.kept, startLine: start, totalLines: all.length,
      cut: `[${capNotice(fit.cutTokens)}${partial}lines ${next}-${all.length} of ${all.length} not shown; continue with offset=${next}]` };
  };

  /** The files a search of `path` covers, each with its searched text: a Raw entry, a fact and a
   * knowledge body all in full, never their bounded rendering. */
  type Searched = { path: string; text: () => string; mark?: string };
  const whole = (entry: SourceEntry) => renderEntryWhole(entry, memory.resultText, undefined, undefined, true).content;
  function* turnFiles(sessionId: number, turnId: number): Generator<Searched> {
    const turn = `${MEMORY_ROOT}/S${sessionId}/T${turnId}`;
    const meta = entriesOf(sessionId, turnId);
    yield { path: turn, text: () => fileText(turn) };
    for (const entry of store.hydrateSourceEntries(meta.map(e => e.id))) yield { path: `${turn}/E${entry.entryOrdinal}`, text: () => whole(entry) };
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
      for (const turn of store.listTurns(Number(m[1]))) yield* turnFiles(turn.sessionId, turn.id);
      return;
    }
    if ((m = TURN.exec(path))) { yield* turnFiles(Number(m[1]), Number(m[2])); return; }
    if ((m = ENTRY.exec(path))) {
      const entry = entriesOf(Number(m[1]), Number(m[2])).find(e => e.entryOrdinal === Number(m![3]));
      if (!entry) throw new Error(`no such path: ${path}`);
      yield { path, text: () => whole(store.hydrateSourceEntries([entry.id])[0]!) };
      return;
    }
    // A lone address: a fact, a knowledge identity (bare/tagged/ordinal) or a project name search
    // its full body (`full`), same as VISIBLE/ALL above; the inheritance view and a version history
    // walk are not per-item bounded the same way, so they keep Read's own rendering (`fileText`).
    if (INHERITED.test(path) || HISTORY.test(path)) { yield { path, text: () => fileText(path) }; return; }
    yield { path, text: () => full(path.slice(MEMORY_ROOT.length + 1)) };
  }

  // Headroom `page` reserves out of the token cap for its own cut/receipt line below, so the page it
  // returns plus that receipt never together exceed the cap. The receipt's own rendered cost (a
  // handful of short fixed phrases and formatted integers) stays far under this fixed reservation.
  const CUT_RECEIPT_RESERVE = 200;
  /** Output lines after `offset`, at most `limit`, within the token cap, and what follows them. */
  const page = (out: string[], more: boolean, offset: number, limit: number, what: string, continuation?: string): MemoryListing => {
    const shown = out.slice(offset, offset + limit);
    const fit = capLines(shown, line => line, MAX_PUBLIC_READ_TOKENS - CUT_RECEIPT_RESERVE);
    const next = offset + fit.kept.length;
    if (!more && next >= out.length) return { lines: fit.kept };
    const rest = more ? `more ${what} follow` : `${what} ${next + 1}-${out.length} of ${out.length} not shown`;
    return { lines: fit.kept, cut: `[${capNotice(fit.cutTokens)}${rest}; ${continuation ?? `continue with offset=${next}`}]` };
  };

  const grep = (pattern: string, raw: string, options: MemoryGrepOptions = {}): MemoryListing => {
    const root = resolve(raw), mode = options.mode ?? "files_with_matches";
    let regex: RegExp;
    try { regex = new RegExp(options.literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : pattern, options.ignoreCase ? "i" : ""); }
    catch (error) { throw new Error(`invalid pattern: ${(error as Error).message}`); }
    const filter = options.glob ? globRegex(options.glob) : undefined;
    const offset = Math.max(0, Math.floor(options.offset ?? 0)), limit = options.limit && options.limit > 0 ? Math.floor(options.limit) : Infinity;
    const before = Math.max(0, options.before ?? 0), after = Math.max(0, options.after ?? 0);
    const out: string[] = [];
    let used = 0, more = false;
    for (const file of searched(root)) {
      if (filter && !filter.test(options.glob!.includes("/") ? file.path.slice(root.length + 1) : basename(file.path))) continue;
      const text = file.text().split("\n");
      if (mode === "files_with_matches") { if (text.some(line => regex.test(line))) out.push(file.path + (file.mark ?? "")); continue; }
      const hits = text.flatMap((line, i) => regex.test(line) ? [i] : []);
      if (!hits.length) continue;
      if (mode === "count") { out.push(`${file.path}:${hits.length}`); continue; }
      const shown = new Set<number>();
      for (const i of hits) for (let j = Math.max(0, i - before); j <= Math.min(text.length - 1, i + after); j++) shown.add(j);
      const hit = new Set(hits);
      for (const i of [...shown].sort((a, b) => a - b)) {
        const line = `${file.path}${hit.has(i) ? ":" : "-"}${i + 1}${hit.has(i) ? ":" : "-"}${windowedLine(text[i]!, regex)}`;
        out.push(line);
        // Content can be the whole Raw of a session: stop once the page is certainly full.
        if (out.length > offset && (used += tokens(line)) > MAX_PUBLIC_READ_TOKENS || out.length >= offset + limit + 1) { more = true; break; }
      }
      if (more) break;
    }
    if (!out.length) return { lines: [] };
    return page(out, more, offset, limit, mode === "files_with_matches" ? "matching files" : mode === "count" ? "counts" : "matching lines");
  };

  const glob = (pattern: string): MemoryListing => {
    const segments = resolve(pattern).split("/").slice(2);
    const found = new Set<string>();
    const walk = (path: string, rest: string[]) => {
      if (!rest.length) { found.add(path); return; }
      const [head, ...tail] = rest;
      if (head === "**") { walk(path, tail); for (const [child] of children(path) ?? []) walk(child, rest); return; }
      const matcher = globRegex(head!);
      for (const [child] of children(path) ?? []) if (matcher.test(basename(child))) walk(child, tail);
    };
    walk(MEMORY_ROOT, segments);
    return found.size ? page([...found], false, 0, Infinity, "paths", "narrow the pattern") : { lines: [] };
  };

  return { read, grep, glob };
}
