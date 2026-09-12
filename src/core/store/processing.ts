import type { Store, KnowledgePath, KnowledgeWithRevision, ApplicabilityInput, CommitGraph } from "./index.ts";
import { renderKnowledge, renderKnowledgeBlock, tokens } from "../render/index.ts";
import { KNOWLEDGE_CATEGORIES, type KnowledgeRevision, type TriggerOrigin } from "../model/index.ts";

/** Change this whenever the immutable knowledge material rendering changes. Marks are not events. */
export const KNOWLEDGE_VIEW_VERSION = "34a-v1";
export const PROCESSING_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_weights (
  commit_id INTEGER NOT NULL REFERENCES knowledge_revisions(id),
  view_version TEXT NOT NULL, tokens INTEGER NOT NULL CHECK(tokens >= 0),
  PRIMARY KEY(commit_id, view_version)
);
CREATE TABLE IF NOT EXISTS dreaming_completions (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id),
  event_ids TEXT NOT NULL, result_ids TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settled_knowledge_events (
  event_id INTEGER PRIMARY KEY REFERENCES knowledge_revisions(id),
  run_id INTEGER NOT NULL REFERENCES dreaming_completions(run_id)
);
CREATE TABLE IF NOT EXISTS processed_knowledge_versions (
  commit_id INTEGER PRIMARY KEY REFERENCES knowledge_revisions(id),
  run_id INTEGER NOT NULL REFERENCES dreaming_completions(run_id)
);
CREATE TABLE IF NOT EXISTS dreaming_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL,
  head_turn_id INTEGER NOT NULL REFERENCES turns(id),
  anchor INTEGER NOT NULL REFERENCES knowledge_revisions(id),
  completed_run INTEGER REFERENCES dreaming_completions(run_id),
  origin_session_id INTEGER REFERENCES sessions(id), origin_entry_ids TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dreaming_open_range ON dreaming_ranges(session_id, branch) WHERE completed_run IS NULL;
CREATE TABLE IF NOT EXISTS dreaming_range_events (
  range_id INTEGER NOT NULL REFERENCES dreaming_ranges(id),
  event_id INTEGER NOT NULL REFERENCES knowledge_revisions(id), PRIMARY KEY(range_id,event_id)
);
CREATE TABLE IF NOT EXISTS dreaming_range_versions (
  range_id INTEGER NOT NULL REFERENCES dreaming_ranges(id),
  commit_id INTEGER NOT NULL REFERENCES knowledge_revisions(id), PRIMARY KEY(range_id,commit_id)
);
CREATE TABLE IF NOT EXISTS dreaming_family (
  range_id INTEGER NOT NULL REFERENCES dreaming_ranges(id),
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id), PRIMARY KEY(range_id,knowledge_id)
);
CREATE TABLE IF NOT EXISTS dreaming_run_ranges (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id), range_id INTEGER NOT NULL REFERENCES dreaming_ranges(id)
);
CREATE TABLE IF NOT EXISTS knowledge_placement_validations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  commit_id INTEGER NOT NULL REFERENCES processed_knowledge_versions(commit_id),
  old_owner TEXT NOT NULL, new_owner TEXT NOT NULL,
  view_version TEXT NOT NULL, created_at TEXT NOT NULL
);
`;

export interface KnowledgeEvent { id: number; knowledgeId: number; tokens: number; kind: "event" | "version" }
export interface DreamingRange { id: number; sessionId: number; branch: string; headTurnId: number; anchor: number; eventIds: number[]; versionIds: number[]; knowledgeIds: number[]; origin: TriggerOrigin | null }

/** Project selected current results back to caller-chosen exact roots over the prepared parent DAG. */
export function currentResultsByRoot(current: readonly KnowledgeRevision[], parents: ReadonlyMap<number, readonly number[]>,
  roots: ReadonlySet<number>): Map<number, Set<number>> {
  const result = new Map([...roots].map(id => [id, new Set<number>()]));
  if (!roots.size) return result;
  for (const revision of current) {
    const pending = [revision.id], visited = new Set<number>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      result.get(id)?.add(revision.id);
      pending.push(...(parents.get(id) ?? []));
    }
  }
  return result;
}

export function changeWeight(store: Store, commitId: number, version = KNOWLEDGE_VIEW_VERSION, cache = true): number {
  const cached = store.db.prepare("SELECT tokens FROM knowledge_weights WHERE commit_id = ? AND view_version = ?").get(commitId, version);
  if (cached) return Number(cached.tokens);
  const row = store.db.prepare("SELECT knowledge_id FROM knowledge_revisions WHERE id = ?").get(commitId);
  if (!row) throw new Error(`Unknown knowledge event ${commitId}`);
  const event = store.getKnowledgeRevision(Number(row.knowledge_id), commitId)!;
  const revision = event.op === "archive" ? store.getKnowledgeRevision(event.knowledgeId, event.parentId!) : event;
  if (!revision) throw new Error(`K${event.knowledgeId}@${commitId}: archive predecessor is unavailable; repair attribution before maintenance`);
  const weight = tokens(renderKnowledge({ knowledge: store.getKnowledge(event.knowledgeId)!, revision }));
  if (cache) store.db.prepare("INSERT OR IGNORE INTO knowledge_weights VALUES (?, ?, ?)").run(commitId, version, weight);
  return weight;
}

export function pendingEvents(store: Store, path: KnowledgePath, cache = true,
  snapshot = store.pathSnapshot(path), prepared?: ReturnType<Store["commitGraphInput"]>, preparedGraph?: CommitGraph): KnowledgeEvent[] {
  const candidates = store.pendingKnowledgeRevisions(path);
  const retained = new Set(store.db.prepare(`SELECT e.event_id FROM dreaming_range_events e JOIN dreaming_ranges r ON r.id = e.range_id
    WHERE r.session_id = ? AND r.branch = ? AND r.completed_run IS NULL`).all(path.sessionId, path.branch ?? "").map(r => Number(r.event_id)));
  const needsVersionProjection = !!prepared || !!store.db.prepare(`SELECT 1 WHERE
    EXISTS (SELECT 1 FROM settled_knowledge_events) OR EXISTS (
      SELECT 1 FROM knowledge_revisions k JOIN dreaming_run_ranges d ON d.run_id = k.run_id
      JOIN dreaming_ranges r ON r.id = d.range_id LEFT JOIN processed_knowledge_versions p ON p.commit_id = k.id
      WHERE r.completed_run IS NULL AND p.commit_id IS NULL)`).get();
  const facts = new Map<number, boolean>(), commits = new Map<number, boolean>();
  const applies = (revision: Parameters<Store["commitApplies"]>[0]) => retained.has(revision.id) ||
    store.commitApplies(revision, path, snapshot, prepared?.metadata, facts, commits);
  if (!needsVersionProjection) return candidates.filter(applies)
    .map(revision => ({ id: revision.id, knowledgeId: revision.knowledgeId,
      tokens: changeWeight(store, revision.id, KNOWLEDGE_VIEW_VERSION, cache), kind: "event" as const }));
  const input = prepared ?? store.commitGraphInput();
  const events = candidates.filter(applies);
  const graph = preparedGraph ?? store.commitGraph(path, undefined, snapshot, input);
  const eventIds = new Set(events.map(event => event.id));
  const represented = new Set([...currentResultsByRoot(graph.current, input.parents, eventIds).values()].flatMap(ids => [...ids]));
  const processed = store.processedKnowledgeVersions(graph.current.map(revision => revision.id));
  const restored = graph.current.filter(revision => !processed.has(revision.id) && !represented.has(revision.id));
  return [...events.map(revision => ({ id: revision.id, knowledgeId: revision.knowledgeId,
      tokens: changeWeight(store, revision.id, KNOWLEDGE_VIEW_VERSION, cache), kind: "event" as const })),
    ...restored.map(revision => ({ id: revision.id, knowledgeId: revision.knowledgeId,
      tokens: changeWeight(store, revision.id, KNOWLEDGE_VIEW_VERSION, cache), kind: "version" as const }))]
    .sort((left, right) => left.id - right.id || left.kind.localeCompare(right.kind));
}

/** Full block, never a truncated budget selection. Shared by placement and final certification. */
export function processedBlock(values: KnowledgeWithRevision[], render = renderKnowledge): string {
  return renderKnowledgeBlock(KNOWLEDGE_CATEGORIES.flatMap(category => {
    const members = values.filter(v => v.revision.category === category);
    return members.length ? [{ category, text: members.map(v => render(v)).join("\n") }] : [];
  }));
}

/** Include every stored branch and every terminal Turn, not an arbitrary executor subset. */
function projectionPaths(store: Store): KnowledgePath[] {
  const paths: KnowledgePath[] = [];
  for (const row of store.db.prepare("SELECT id FROM sessions").all()) {
    const sessionId = Number(row.id);
    paths.push(store.knowledgePath(sessionId));
    for (const branch of store.db.prepare("SELECT branch FROM source_paths WHERE session_id = ?").all(sessionId))
      paths.push(store.knowledgePath(sessionId, String(branch.branch)));
    for (const turn of store.db.prepare(`SELECT t.id FROM turns t WHERE t.session_id = ?
      AND NOT EXISTS (SELECT 1 FROM turns c WHERE c.parent_turn_id = t.id)`).all(sessionId))
      paths.push({ sessionId, headTurnId: Number(turn.id) });
  }
  return [...new Map(paths.map(path => [JSON.stringify([path.sessionId, path.branch ?? null, path.headTurnId ?? null]), path])).values()];
}

export function placementOwner(store: Store, value: Pick<KnowledgeWithRevision, "revision">, input?: ApplicabilityInput): string {
  const r = value.revision;
  if (r.scope === "global") return "global";
  const sessionId = r.runId === null ? null : input ? input.runs.get(r.runId) : store.runSessionId(r.runId);
  const projectId = sessionId == null ? undefined : input ? input.projects.get(sessionId) : store.getSession(sessionId)?.projectId;
  if (sessionId == null || projectId === undefined) throw new Error(`K${r.knowledgeId}@${r.id}: missing run-session scope attribution`);
  return r.scope === "session" ? `session:${sessionId}` : `project:${projectId}`;
}

export function processedProjection(store: Store, accepted: number[] = [], affected?: Set<string>) {
  const processed = new Set([...store.db.prepare("SELECT commit_id FROM processed_knowledge_versions").all().map(r => Number(r.commit_id)), ...accepted]);
  const pools = new Map<string, Map<number, KnowledgeWithRevision>>();
  const owners = new Map<number, string>();
  if (!processed.size || affected?.size === 0) return { pools, owners, paths: [] as { path: KnowledgePath; values: KnowledgeWithRevision[] }[] };
  const input = store.commitGraphInput();
  // Historical certificates retain their owner even when an unprocessed successor hides them.
  for (const revision of input.revisions) if (processed.has(revision.id))
    owners.set(revision.id, placementOwner(store, { revision }, input.metadata));
  const knowledge = new Map<number, KnowledgeWithRevision["knowledge"]>();
  const paths = projectionPaths(store).filter(path => !affected || affected.has("global") ||
    affected.has(`session:${path.sessionId}`) || affected.has(`project:${input.metadata.projects.get(path.sessionId)}`)).map(path => {
    const values = store.commitGraph(path, undefined, undefined, input).current
      .filter(r => r.op !== "archive" && processed.has(r.id)).map(revision => {
        if (!knowledge.has(revision.knowledgeId)) knowledge.set(revision.knowledgeId, store.getKnowledge(revision.knowledgeId)!);
        return { knowledge: knowledge.get(revision.knowledgeId)!, revision };
      });
    for (const value of values) {
      const owner = owners.get(value.revision.id)!;
      if (!pools.has(owner)) pools.set(owner, new Map());
      pools.get(owner)!.set(value.revision.id, value);
    }
    return { path, values };
  });
  return { pools, paths, owners };
}

export function checkProcessedScopes(store: Store, accepted: number[] = [], affected?: Set<string>) {
  return checkProcessedProjection(processedProjection(store, accepted, affected), affected);
}

/** Reuse the tentative placement's exact after projection; no reads or new applicability decisions. */
export function checkProcessedProjection({ pools, paths, owners }: ReturnType<typeof processedProjection>, affected?: Set<string>) {
  const rendered = new Map<number, string>();
  const render = (value: KnowledgeWithRevision) => {
    if (!rendered.has(value.revision.id)) rendered.set(value.revision.id, renderKnowledge(value));
    return rendered.get(value.revision.id)!;
  };
  const totals: { scope: string; tokens: number; cap: number }[] = [];
  for (const [scope, values] of pools) {
    if (affected && !affected.has(scope)) continue;
    totals.push({ scope, tokens: tokens(processedBlock([...values.values()], render)), cap: scope === "global" ? 4000 : scope.startsWith("project:") ? 10000 : 1000 });
  }
  for (const { path, values } of paths) {
    if (affected && !values.some(v => affected.has(owners.get(v.revision.id)!))) continue;
    totals.push({ scope: `applicable:S${path.sessionId}/${path.branch ?? ""}/T${path.headTurnId ?? ""}`, tokens: tokens(processedBlock(values, render)), cap: 15000 });
  }
  return { totals, problems: totals.filter(t => t.tokens > t.cap).map(t => `${t.scope}: processed knowledge ${t.tokens} exceeds ${t.cap}; reduce the affected processed pool before retrying this operation`) };
}
