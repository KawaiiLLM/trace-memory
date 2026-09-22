import type { Store } from "../store/index.ts";
import type { KnowledgeRevision } from "../model/index.ts";
import { similarity } from "../consolidation/similarity.ts";
import type { ListingOptions } from "./read.ts";

/** One read's ownership, DAG and representative policy. Selection never grants read authority.
 * A named project supplies its own context and cannot borrow the caller's session. */
export function knowledgeReadSelection(store: Store, options: ListingOptions, namedProject?: number) {
  const sessionId = namedProject === undefined ? options.sessionId : undefined;
  const reader = sessionId === undefined ? undefined : store.getSession(sessionId);
  if (sessionId !== undefined && !reader) throw new Error(`session S${sessionId} does not exist`);
  const projectId = namedProject ?? reader?.projectId;
  if (options.scope === "session" && sessionId === undefined) throw new Error("scope:session requires a session context");
  if (options.scope === "project" && projectId === undefined) throw new Error("scope:project requires a project context");
  const path = sessionId === undefined ? null : store.knowledgePath(sessionId, options.branch, options.headTurnId);
  const input = store.commitGraphInput();
  const graph = store.commitGraph(path, namedProject, undefined, input);
  const current = new Set(graph.current.map(r => r.id));
  const byCommit = input.metadata.revisions!;
  const matches = (r: KnowledgeRevision) => {
    if (options.category && r.category !== options.category || options.scope && r.scope !== options.scope) return false;
    const owner = r.runId === null ? undefined : input.metadata.runs.get(r.runId);
    if (r.scope === "global") return true;
    if (r.scope === "session") return sessionId === undefined ? projectId === undefined : owner === sessionId;
    return projectId === undefined || owner !== undefined && input.metadata.projects.get(owner) === projectId;
  };
  const eligible = (r: KnowledgeRevision) => matches(r) && ((options.versions ?? "current") === "all"
    || options.versions === "history" && graph.applicable.has(r.id)
    || (options.versions ?? "current") === "current" && current.has(r.id) && r.op !== "archive");
  // 59b: the batched search orders each query's hits by that similarity (rarest match first), so
  // `cap` keeps the most relevant K rather than the lowest id; the single form keeps K-id order.
  const representatives = (candidates: readonly KnowledgeRevision[], query = "", order: "id" | "score" = "id") => {
    const chosen = new Map<number, { revision: KnowledgeRevision; score: number }>();
    for (const revision of candidates) {
      if (!eligible(revision)) continue;
      const score = query ? Math.max(similarity(query, revision.text), ...revision.topics.map(topic => similarity(query, topic))) : 0;
      const previous = chosen.get(revision.knowledgeId);
      if (!previous || score > previous.score || score === previous.score &&
        (Number(current.has(revision.id)) > Number(current.has(previous.revision.id))
          || current.has(revision.id) === current.has(previous.revision.id) && revision.id > previous.revision.id))
        chosen.set(revision.knowledgeId, { revision, score });
    }
    const ranked = [...chosen.values()];
    if (order === "score") ranked.sort((a, b) => b.score - a.score || Number(current.has(b.revision.id)) - Number(current.has(a.revision.id)) || b.revision.id - a.revision.id);
    else ranked.sort((a, b) => a.revision.knowledgeId - b.revision.knowledgeId);
    return ranked.map(value => value.revision);
  };
  const status = (hit: KnowledgeRevision) => {
    if (!graph.applicable.has(hit.id)) return "another branch";
    if (current.has(hit.id)) return hit.op === "archive" ? (path ? "archived on this path" : "archived")
      : path ? "current on this path" : "tip (newest-created alternatives)";
    const descendants = graph.descendants(hit.id);
    // State is global even when the selected revision's body is outside this reader's scope.
    // A competing sibling is not a descendant, so fall back to this identity's resolved
    // alternative rather than emitting the false `superseded by none`.
    const successors = graph.resolved.filter(r => r.id !== hit.id && descendants.has(r.id));
    const selected = successors.length ? successors
      : graph.resolved.filter(r => r.id !== hit.id && r.knowledgeId === hit.knowledgeId);
    return selected.length && selected.every(r => r.op === "archive") ? (path ? "archived on this path" : "archived")
      : selected.length ? `superseded${path ? " on this path" : ""} by ${selected.map(r => `K${r.knowledgeId}@${r.id}`).join(", ")}`
      : path ? "not current on this path" : "not globally current";
  };
  return { input, graph, path, byCommit, matches, representatives, status };
}

export const KNOWLEDGE_REPRESENTATIVE_RECEIPT = "One representative per K; inspect a K with trace(Kn, versions:history/all) or trace(Kn..).";
