import type { Store, KnowledgeWithRevision, ApplicabilityInput } from "./index.ts";
import { renderKnowledge, renderKnowledgeBlock, wholeKnowledge } from "../render/index.ts";
import type { TriggerOrigin } from "../model/index.ts";

export type KnowledgeBudgetField = "global" | "project" | "session";
export interface KnowledgeBudgetValues { global: number; project: number; session: number }
export interface KnowledgeBudgets extends KnowledgeBudgetValues {
  applicable: number;
  injection: number;
  dreamingProcessedInput: number;
}
export const DEFAULT_KNOWLEDGE_BUDGETS: KnowledgeBudgetValues = { global: 4_000, project: 15_000, session: 1_000 };
export const DEFAULT_DREAMING_TRIGGER_TOKENS = 10_000;
export const DEFAULT_SHARED_ALLOWANCE_TOKENS = 10_000;

/** 104: one Dreamer evaluation per session context, over its applicable pools. Due when their sizes
 * (as `check` measures them) exceed `window`, the injection base plus the shared allowance, or when
 * their nonempty pending weight, summed, reaches the trigger. 126: the answer is only whether a run is
 * due; a run covers all of the session's pools. */
export function dreamingDue(pools: readonly (KnowledgePoolSize & { pending: readonly { tokens: number }[] })[],
  window: number, triggerTokens: number): boolean {
  const overflow = pools.reduce((sum, pool) => sum + pool.tokens, 0) > window;
  return overflow || pools.some(pool => pool.pending.length) &&
    pools.reduce((sum, pool) => sum + pool.pending.reduce((total, value) => total + value.tokens, 0), 0) >= triggerTokens;
}

/** 126: the fixed pool key of a Dreamer range, execution and failure streak that covers all of a
 * session's pools. Rows written before 126 keep the one pool they named. */
export const ALL_POOLS = "all";

/** Database policy owns the base window only. The shared allowance is a fixed configuration value
 * (`compaction.sharedAllowanceTokens`), never derived from the maintenance triggers (73). */
export function deriveKnowledgeBudgets(values: KnowledgeBudgetValues, stored = false): KnowledgeBudgets {
  const label = (field: KnowledgeBudgetField) => `${field[0]!.toUpperCase()}${field.slice(1)} Knowledge budget`;
  for (const field of ["global", "project", "session"] as const) if (!Number.isSafeInteger(values[field]) || values[field] < 0)
    throw new Error(`${stored ? "stored Knowledge budget policy: " : ""}${label(field)} must be an exact nonnegative safe integer`);
  const applicable = values.global + values.project + values.session;
  if (!Number.isSafeInteger(applicable)) throw new Error(`${stored ? "stored Knowledge budget policy: " : ""}derived applicable Knowledge capacity must be a safe integer`);
  return { ...values, applicable, injection: applicable, dreamingProcessedInput: applicable };
}

/** Only the current per-pool processing state remains after 64d. */
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

export interface PendingKnowledgeVersion {
  revisionId: number;
  knowledgeId: number;
  pool: string;
  tokens: number;
  /** What every size, weight and cap measures. */
  material: string;
  /** `material` plus the supporting facts' dates, as the Dreamer is shown it (139). */
  shown: string;
}
export interface KnowledgePoolSize { pool: string; tokens: number; budget: number }
export interface DreamingRange {
  id: number;
  sessionId: number;
  branch: string;
  headTurnId: number;
  /** The oldest frozen revision; null for a range with none (a run due by overflow alone). */
  anchor: number | null;
  eventIds: number[];
  origin: TriggerOrigin | null;
  /** `ALL_POOLS` since 126; one pool on older rows; null on legacy ranges. */
  pool: string | null;
  claimToken: string | null;
  closedAt: string | null;
  /** Every pending revision visible when this range froze, including the unselected remainder. */
  pendingRevisionIds: number[];
}

/** Full block, never a truncated budget selection. Shared by budget reporting and Dreamer input. */
export function processedBlock(values: KnowledgeWithRevision[], render: (value: KnowledgeWithRevision) => string = value => renderKnowledge(value)): string {
  return renderKnowledgeBlock(wholeKnowledge(values, render).groups);
}

export function placementOwner(store: Store, value: Pick<KnowledgeWithRevision, "revision">, input?: ApplicabilityInput): string {
  const r = value.revision;
  if (r.scope === "global") return "global";
  const sessionId = r.runId === null ? null : input ? input.runs.get(r.runId) : store.runSessionId(r.runId);
  const projectId = sessionId == null ? undefined : input ? input.projects.get(sessionId) : store.getSession(sessionId)?.projectId;
  if (sessionId == null || projectId === undefined) throw new Error(`K${r.knowledgeId}@${r.id}: missing run-session scope attribution`);
  return r.scope === "session" ? `session:${sessionId}` : `project:${projectId}`;
}
