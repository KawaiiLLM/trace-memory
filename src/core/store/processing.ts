import type { Store, KnowledgeWithRevision, ApplicabilityInput } from "./index.ts";

export type KnowledgeBudgetField = "global" | "project" | "session";
export interface KnowledgeBudgetValues { global: number; project: number; session: number }
export interface KnowledgeBudgets extends KnowledgeBudgetValues {
  applicable: number;
  injection: number;
}
export const DEFAULT_KNOWLEDGE_BUDGETS: KnowledgeBudgetValues = { global: 4_000, project: 15_000, session: 1_000 };
/** 146: Dreaming is due after this many Noter knowledge operations (creates and updates). */
export const DEFAULT_DREAMING_TRIGGER_OPERATIONS = 30;

/** 126: the fixed pool key of a Dreamer range, execution and failure streak that covers all of a
 * session's pools. Rows written before 126 keep the one pool they named. */
export const ALL_POOLS = "all";

/** Database policy owns only the base. Both temporary pools are fixed configuration values,
 * independent of maintenance triggers (165). */
export function deriveKnowledgeBudgets(values: KnowledgeBudgetValues, stored = false): KnowledgeBudgets {
  const label = (field: KnowledgeBudgetField) => `${field[0]!.toUpperCase()}${field.slice(1)} Knowledge budget`;
  for (const field of ["global", "project", "session"] as const) if (!Number.isSafeInteger(values[field]) || values[field] < 0)
    throw new Error(`${stored ? "stored Knowledge budget policy: " : ""}${label(field)} must be an exact nonnegative safe integer`);
  const applicable = values.global + values.project + values.session;
  if (!Number.isSafeInteger(applicable)) throw new Error(`${stored ? "stored Knowledge budget policy: " : ""}derived applicable Knowledge capacity must be a safe integer`);
  return { ...values, applicable, injection: applicable };
}

/** `knowledge_processed` is Dreamer coverage (144 stage 4 §2.1). The three `dreaming_*` range tables are legacy: kept with their
 * migrations, unread and unwritten. */
export const PROCESSING_SQL = `
CREATE TABLE IF NOT EXISTS knowledge_processed (
  pool TEXT NOT NULL,
  revision_id INTEGER NOT NULL REFERENCES knowledge_revisions(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),
  PRIMARY KEY(pool, revision_id)
);
CREATE TABLE IF NOT EXISTS dreaming_ranges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL,
  head_turn_id INTEGER NOT NULL REFERENCES turns(id),
  anchor INTEGER REFERENCES knowledge_revisions(id),
  completed_run INTEGER REFERENCES runs(id),
  origin_session_id INTEGER REFERENCES sessions(id), origin_entry_ids TEXT,
  pool TEXT,
  claim_token TEXT,
  closed_at TEXT,
  pending_revisions TEXT NOT NULL DEFAULT '[]'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_dreaming_open_range ON dreaming_ranges(session_id, branch) WHERE completed_run IS NULL AND closed_at IS NULL;
CREATE TABLE IF NOT EXISTS dreaming_range_events (
  range_id INTEGER NOT NULL REFERENCES dreaming_ranges(id),
  event_id INTEGER NOT NULL REFERENCES knowledge_revisions(id), PRIMARY KEY(range_id,event_id)
);
CREATE TABLE IF NOT EXISTS dreaming_run_ranges (
  run_id INTEGER PRIMARY KEY REFERENCES runs(id), range_id INTEGER NOT NULL REFERENCES dreaming_ranges(id)
);
`;

export function placementOwner(store: Store, value: Pick<KnowledgeWithRevision, "revision">, input?: ApplicabilityInput): string {
  const r = value.revision;
  if (r.scope === "global") return "global";
  const sessionId = r.runId === null ? null : input ? input.runs.get(r.runId) : store.runSessionId(r.runId);
  const projectId = sessionId == null ? undefined : input ? input.projects.get(sessionId) : store.getSession(sessionId)?.projectId;
  if (sessionId == null || projectId === undefined) throw new Error(`K${r.knowledgeId}@${r.id}: missing run-session scope attribution`);
  return r.scope === "session" ? `session:${sessionId}` : `project:${projectId}`;
}
