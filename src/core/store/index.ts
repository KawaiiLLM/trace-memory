// core/store — node:sqlite behind one plain interface. No abstraction over SQLite;
// this is the only place that knows a database exists. Schema: .scratch/v1/spec.md (Schema).
// Global ids: turns, facts, and knowledge use SQLite's per-table AUTOINCREMENT, which never
// reuses an id and is not reset per session or project — that is the "global id" the spec asks for.

import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrateDreaming, migrateKnowledgeLineage } from "./migration.ts";
import { SourceNormalizationError, sourceAddresses, sourceKey, type SourceBlock, type SourceNormalizer } from "../model/source.ts";
export { sourceAddresses } from "../model/source.ts";
import { EXECUTIONS_SQL, beginExecution, linkExecutionRun, settleExecution, type LogicalTask, type ExecutionOutcome } from "./executions.ts";
import { PROCESSING_SQL, KNOWLEDGE_VIEW_VERSION, changeWeight, pendingEvents, processedProjection, placementOwner, checkProcessedScopes, checkProcessedProjection, type DreamingRange } from "./processing.ts";
import { renderKnowledge, tokens } from "../render/index.ts";
import { KNOWLEDGE_CATEGORIES, compareTriggerOrigins } from "../model/index.ts";
import type {
  Actor,
  Knowledge,
  KnowledgeCategory,
  KnowledgeOp,
  KnowledgeLink,
  KnowledgeRevision,
  KnowledgeScope,
  Fact,
  FactCategory,
  EventStatus,
  FactRelation,
  KnowledgeMark,
  KnowledgeMarkKind,
  Project,
  Run,
  RunKind,
  RunOutcome,
  TriggerOrigin,
  Session,
  ToolCall,
  Turn,
} from "../model/index.ts";

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  declared_by TEXT NOT NULL CHECK (declared_by IN ('marker','mark')),
  merged_into INTEGER REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  host TEXT NOT NULL,
  enrollment_default INTEGER NOT NULL CHECK (enrollment_default IN (0,1)),
  enrollment_choice INTEGER CHECK (enrollment_choice IN (0,1)),
  started_at TEXT NOT NULL,
  first_reply_at TEXT NOT NULL,
  closed_at TEXT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  parent_session_id INTEGER REFERENCES sessions(id),
  project_declaration TEXT NOT NULL DEFAULT 'marker' CHECK (project_declaration IN ('undeclared','marker','mark')),
  -- 19c cache-miss latch: set once when a host observes an eligible fork cache miss for this memory
  -- session, so later inherited-context work resolves to fresh context until the user retries. It is
  -- session-scoped state, not configuration: a reopen, a fork or a copied host sharing this session
  -- shares it. fork_suppressed_run is the run that detected the miss, linked once it has an id.
  fork_suppressed_at TEXT,
  fork_suppressed_run INTEGER
);

CREATE TABLE IF NOT EXISTS task_claims (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  phase TEXT NOT NULL CHECK (phase IN ('noting','consolidation','dreaming')),
  executor_id TEXT NOT NULL,
  token TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  borrowed INTEGER NOT NULL CHECK (borrowed IN (0,1)),
  reserved INTEGER NOT NULL CHECK (reserved IN (0,1)),
  PRIMARY KEY (session_id, phase)
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  ordinal INTEGER NOT NULL,
  parent_turn_id INTEGER REFERENCES turns(id),
  kind TEXT NOT NULL CHECK (kind IN ('turn','compaction')),
  user_prompt TEXT,
  assistant_text TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  UNIQUE (session_id, ordinal)
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  input TEXT,
  result TEXT,
  status TEXT NOT NULL,
  UNIQUE (turn_id, ordinal)
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  category TEXT NOT NULL CHECK (category IN ('question','proposal','decision','observation','interpretation','event')),
  actor TEXT NOT NULL CHECK (actor IN ('user','agent')),
  text TEXT NOT NULL,
  quote TEXT,
  status TEXT CHECK (status IN ('completed','reported','dispatched','attempted')),
  source TEXT NOT NULL,
  source_time TEXT NOT NULL,
  CHECK ((status IS NOT NULL) = (category = 'event'))
);

-- Which source entries a fact's citations resolved to when it was written. Addresses like T1#assistant
-- are shared by every assistant entry of the Turn, so applicability needs the identities (review 2026-09-08).
CREATE TABLE IF NOT EXISTS fact_sources (
  fact_id INTEGER NOT NULL REFERENCES facts(id),
  entry_id INTEGER NOT NULL REFERENCES source_entries(id),
  PRIMARY KEY (fact_id, entry_id)
);

CREATE TABLE IF NOT EXISTS fact_relations (
  from_fact INTEGER NOT NULL REFERENCES facts(id),
  to_fact INTEGER NOT NULL REFERENCES facts(id),
  kind TEXT NOT NULL CHECK (kind IN ('support','negate')),
  strength TEXT NOT NULL CHECK (strength IN ('strong','weak')),
  PRIMARY KEY (from_fact, to_fact, kind)
);

CREATE TABLE IF NOT EXISTS knowledge (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  origin_session_id INTEGER REFERENCES sessions(id),
  project_id INTEGER REFERENCES projects(id),
  author TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id),
  parent_id INTEGER REFERENCES knowledge_revisions(id),
  text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('constraint','open','dispute','goal','mechanism','term','reference')),
  scope TEXT NOT NULL CHECK (scope IN ('session','project','global')),
  supports TEXT NOT NULL,
  support_semantics TEXT NOT NULL DEFAULT 'complete_result' CHECK (support_semantics IN ('complete_result','change')),
  op TEXT NOT NULL CHECK (op IN ('create','update','merge','split','archive')),
  reason TEXT NOT NULL,
  topics TEXT NOT NULL DEFAULT '[]',
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL,
  actor_role TEXT CHECK(actor_role IS NULL OR actor_role IN ('consolidation','dreaming','manual')),
  UNIQUE (knowledge_id, id)
);

CREATE TABLE IF NOT EXISTS knowledge_links (
  from_knowledge INTEGER NOT NULL,
  from_commit INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('merged_into','split_from')),
  to_knowledge INTEGER NOT NULL,
  to_commit INTEGER NOT NULL,
  PRIMARY KEY (from_knowledge, from_commit, kind, to_knowledge, to_commit),
  FOREIGN KEY (from_knowledge, from_commit) REFERENCES knowledge_revisions(knowledge_id, id),
  FOREIGN KEY (to_knowledge, to_commit) REFERENCES knowledge_revisions(knowledge_id, id)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('noting','consolidation','dreaming','manual')),
  session_id INTEGER REFERENCES sessions(id),
  branch TEXT,
  range_from TEXT,
  range_to TEXT,
  prompt_hash TEXT,
  model TEXT,
  mode TEXT,
  request TEXT,
  response TEXT,
  origin_session_id INTEGER REFERENCES sessions(id),
  origin_entry_ids TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','cancelled','bounced','conflict')),
  created_at TEXT NOT NULL,
  CHECK ((origin_session_id IS NULL) = (origin_entry_ids IS NULL))
);

CREATE TABLE IF NOT EXISTS knowledge_marks (
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id),
  commit_id INTEGER NOT NULL UNIQUE REFERENCES knowledge_revisions(id),
  kind TEXT NOT NULL CHECK (kind IN ('verified','flagged')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (knowledge_id, commit_id) REFERENCES knowledge_revisions(knowledge_id, id)
);

-- Legacy pending_deliveries tables are left untouched, not created or used as visibility evidence.

CREATE TABLE IF NOT EXISTS source_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  native_lineage TEXT NOT NULL,
  native_id TEXT NOT NULL,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  content TEXT NOT NULL,
  UNIQUE (session_id, native_lineage, native_id)
);
CREATE TABLE IF NOT EXISTS source_paths (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  branch TEXT NOT NULL,
  entry_ids TEXT NOT NULL,
  PRIMARY KEY (session_id, branch)
);
CREATE TABLE IF NOT EXISTS noted_entries (
  entry_id INTEGER NOT NULL REFERENCES source_entries(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),
  PRIMARY KEY (entry_id, run_id)
);

-- Consolidation progress is a set, not a scalar: which facts which Consolidation run took (facts arrive out of
-- id order on a path, so no watermark can stand for the set). A fact counts as consolidated on a path when
-- one of its runs took only facts on that path.
CREATE TABLE IF NOT EXISTS consolidated_facts (
  fact_id INTEGER NOT NULL REFERENCES facts(id),
  run_id INTEGER NOT NULL REFERENCES runs(id),
  PRIMARY KEY (fact_id, run_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
`;

// ---- Input shapes ----

export interface CreateProjectInput {
  name: string;
  declaredBy: "marker" | "mark";
}

export interface Enrollment { defaultEnabled: boolean; choice: boolean | null }
export const enrollmentDefault = (created: unknown, baseline: unknown): boolean =>
  typeof created === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(created) &&
  Number.isFinite(Date.parse(created)) && new Date(created).toISOString() === created.replace(/(?<=:\d{2})Z$/, ".000Z") && typeof baseline === "string" &&
  Number.isFinite(Date.parse(baseline)) && Date.parse(created) > Date.parse(baseline);

export interface CreateSessionInput {
  nativeCreatedAt?: unknown;
  baseline?: string;
  enrollmentChoice?: boolean | null;
  host: string;
  startedAt: string;
  firstReplyAt: string; // required: a session row only exists once the first reply exists
  projectId: number;
  parentSessionId?: number | null;
  projectDeclaration?: "undeclared" | "marker" | "mark";
}

export interface AppendTurnInput {
  sessionId: number;
  parentTurnId?: number | null;
  kind: "turn" | "compaction";
  userPrompt?: string | null;
  assistantText?: string | null;
  startedAt: string;
  endedAt?: string | null;
}

export interface AppendToolCallInput {
  turnId: number;
  name: string;
  input?: string | null;
  result?: string | null;
  status: string;
}

/** Host-neutral completed source occurrence. Raw is the exact serialized host message. */
export interface SourceInput {
  sessionId: number;
  nativeLineage: string;
  nativeId: string;
  turnId: number;
  role: "user" | "assistant" | "toolResult";
  text: string;
  raw: string;
  calls: { ordinal: number; name: string; callId: string; input?: string; result?: string; status: string }[];
}
export interface SourceEntry extends SourceInput { id: number; entryOrdinal: number; blocks?: SourceBlock[] }

export type Phase = "noting" | "consolidation" | "dreaming";
export interface TaskTarget { sessionId: number; branch: string; headTurnId: number; triggerEntryId?: number }
export interface TaskClaim {
  sessionId: number; phase: Phase; executorId: string; token: string; expiresAt: number;
  borrowed: boolean; reserved: boolean;
}

export type ClosedSessionScope = "off" | "project" | "global";

export interface RunInput {
  /** Host-only capability, never accepted from tool arguments or serialized as evidence. */
  dreamingAuthority?: object;
  /** Core-only capability binding a frozen trigger origin. */
  originAuthority?: object;
  executionId?: string;
  /** Retained source range for Dreamer's immediate writes; not a new trigger source. */
  dreamingRangeId?: number;
  claim?: TaskClaim;
  /** Borrowing policy frozen at admission; not a new persisted queue or claim field. */
  closedSessionScope?: ClosedSessionScope;
  projectId?: number;
  executorSessionId?: number;
  kind: RunKind;
  entryAudit?: unknown;
  sessionId?: number | null;
  branch?: string | null;
  rangeFrom?: string | null;
  rangeTo?: string | null;
  promptHash?: string | null;
  model?: string | null;
  /** New work writes the execution mode of ticket 19: `fork` (inherited native context) or
   * `subagent` (fresh context). The column stays a free string because rows written before the
   * rename carry `branch`, and reading one back — `updateRun(id, run)` — must preserve it. */
  mode?: string | null;
  request?: string | null;
  response?: string | null;
  createdAt: string;
}

export interface NotingRelationTarget {
  target: string; // "F<id>" or "$n" (1-based index within this commit's facts array)
  strength: "strong" | "weak";
}

export interface FactCommitInput {
  turnId: number;
  category: FactCategory;
  actor: Actor;
  text: string;
  quote?: string | null;
  status?: EventStatus | null;
  source: string[];
  createdAt: string;
  support?: NotingRelationTarget[];
  negate?: NotingRelationTarget[];
  /** The source entries the cited addresses resolved to in the writer's frozen set; empty when the path has no native ancestry. */
  entryIds?: number[];
}

export interface CommitNotingRunInput {
  run: RunInput; // sessionId required: every turn and watermark must belong to it
  facts: FactCommitInput[];
  responseForFacts?: (ids: number[]) => string;
  entryIds?: number[];
}

export type CommitNotingResult =
  | { ok: true; runId: number; facts: Fact[] }
  | { ok: false; runId: number; problems: string[] };

export type KnowledgeOperationInput =
  | {
      op: "create";
      handle: string; // system-generated candidate label
      author: string;
      text: string;
      category: KnowledgeCategory;
      scope: KnowledgeScope;
      supports: number[];
      reason: string;
      /** 21b: the complete replacement label set of this revision; empty means unclassified. */
      topics: string[];
      createdAt: string;
    }
  | {
      op: "update";
      knowledgeId: number;
      baseCommit: number;
      text: string;
      category: KnowledgeCategory;
      scope: KnowledgeScope;
      supports: number[];
      reason: string;
      topics: string[];
      createdAt: string;
    }
  | {
      op: "merge";
      intoKnowledgeId: number;
      intoBaseCommit: number;
      absorb: { knowledgeId: number; baseCommit: number }[];
      text: string;
      category: KnowledgeCategory;
      scope: KnowledgeScope;
      supports: number[];
      reason: string;
      topics: string[];
      createdAt: string;
    }
  | {
      op: "split";
      knowledgeId: number;
      baseCommit: number;
      children: { text: string; category: KnowledgeCategory; topics: string[] }[];
      supports: number[];
      reason: string;
      createdAt: string;
    }
  | {
      op: "archive";
      knowledgeId: number;
      baseCommit: number;
      /** 21a/21b: an archive carries its own evidence; text, category, scope and topics come from the parent. */
      supports: number[];
      reason: string;
      createdAt: string;
    };

/** A path is a session's Turn ancestry; with a branch, also that branch's selected native ancestry (17a), so
 * applicability is decided per source entry, not per Turn: a sibling entry inside the same Turn is off-path. */
export type KnowledgePath = { sessionId: number; headTurnId: number | null; branch?: string };

/** One read's view of the commit DAG (22c), built by `commitGraph` and passed no further than the
 * read that built it: every revision in id order, the ids that apply to the read's path, the current
 * tips among them, and the descendants of a commit — the ancestry a hit's historical label needs. */
export interface CommitGraph {
  revisions: KnowledgeRevision[];
  applicable: Set<number>;
  current: KnowledgeRevision[];
  descendants: (commitId: number) => Set<number>;
}

/** Metadata for one synchronous projection. Rebuild after assignment changes; never cache across reads. */
export interface ApplicabilityInput {
  revisions?: Map<number, KnowledgeRevision>;
  parents?: Map<number, number[]>;
  runs: Map<number, number>;
  projects: Map<number, number>;
  facts: Map<number, { fact: Fact; sessionId: number; entries: number[] }>;
}

/** One path's membership, built once per operation (22a) and passed through every applicability check.
 * `entries` is null when the path has no selected native ancestry; `addresses` answers the address
 * fallback for facts written without entry bindings, one Turn at a time. */
export interface PathSnapshot {
  turns: Set<number>;
  entries: { ids: Set<number>; addresses: (turnId: number) => Set<string> } | null;
  consolidatedRuns: Map<number, boolean>;
}

export interface KnowledgeFilter { scope?: KnowledgeScope; projectId?: number }

export interface CommitConsolidationRunInput {
  path?: KnowledgePath | null;
  run: RunInput; // sessionId required: knowledge ownership is derived from the run's session
  operations: KnowledgeOperationInput[];
  // Runs inside the transaction after application, so diagnostics observe the committed knowledge set.
  finalizeResponse?: (result: { committed: CommittedKnowledgeOp[] }) => string;
  consolidated?: number[]; // the batch's fact ids, marked as taken by this run
}

export interface CommittedKnowledgeOp {
  op: KnowledgeOp;
  handle?: string;
  knowledgeId: number;
  commit: number;
}

export interface ConsumedBaseConflict {
  knowledgeId: number;
  baseCommit: number;
  successorCommits: number[];
}

export type CommitConsolidationResult =
  | { ok: true; runId: number; committed: CommittedKnowledgeOp[] }
  | { ok: false; runId: number; problems: string[]; conflicts?: ConsumedBaseConflict[] };

class ConsumedBaseConflictError extends Error {
  readonly conflict: ConsumedBaseConflict;
  constructor(conflict: ConsumedBaseConflict, message: string) { super(message); this.conflict = conflict; }
}

export interface KnowledgeWithRevision {
  knowledge: Knowledge;
  revision: KnowledgeRevision;
}

// ---- Row mapping helpers ----

function toProject(row: any): Project {
  return { id: row.id, name: row.name, declaredBy: row.declared_by, mergedInto: row.merged_into };
}

function toSession(row: any): Session {
  return {
    id: row.id,
    host: row.host,
    startedAt: row.started_at,
    firstReplyAt: row.first_reply_at,
    closedAt: row.closed_at,
    projectId: row.project_id,
    parentSessionId: row.parent_session_id,
  };
}

function toTurn(row: any): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    ordinal: row.ordinal,
    parentTurnId: row.parent_turn_id,
    kind: row.kind,
    userPrompt: row.user_prompt,
    assistantText: row.assistant_text,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

function toToolCall(row: any): ToolCall {
  return { id: row.id, turnId: row.turn_id, ordinal: row.ordinal, name: row.name, input: row.input, result: row.result, status: row.status };
}

function toFact(row: any): Fact {
  return {
    id: row.id,
    turnId: row.turn_id,
    category: row.category,
    actor: row.actor,
    text: row.text,
    quote: row.quote,
    status: row.status ?? null,
    source: JSON.parse(row.source),
    createdAt: row.source_time,
  };
}

function toKnowledge(row: any): Knowledge {
  return { id: row.id, projectId: row.project_id, originSessionId: row.origin_session_id, author: row.author };
}

function toKnowledgeRevision(row: any): KnowledgeRevision {
  return {
    ...(row.actor_role ? { actorRole: row.actor_role } : {}),
    id: row.id,
    knowledgeId: row.knowledge_id,
    parentId: row.parent_id,
    text: row.text,
    category: row.category,
    scope: row.scope,
    supports: JSON.parse(row.supports),
    supportSemantics: row.support_semantics ?? "complete_result",
    op: row.op,
    reason: row.reason,
    topics: JSON.parse(row.topics),
    runId: row.run_id,
    createdAt: row.created_at,
  };
}

function triggerOriginFromRow(row: any): TriggerOrigin | null {
  if (row.origin_session_id == null && row.origin_entry_ids == null) return null;
  const ids = JSON.parse(String(row.origin_entry_ids));
  if (!Number.isInteger(row.origin_session_id) || row.origin_session_id <= 0 || !Array.isArray(ids) || !ids.length ||
    ids.some((id: unknown) => !Number.isInteger(id) || Number(id) <= 0) || new Set(ids).size !== ids.length)
    throw new Error("stored trigger origin is malformed");
  return { sessionId: Number(row.origin_session_id), entryIds: ids.map(Number) };
}

function toRun(row: any): Run {
  return {
    id: row.id,
    kind: row.kind,
    sessionId: row.session_id,
    branch: row.branch,
    rangeFrom: row.range_from,
    rangeTo: row.range_to,
    promptHash: row.prompt_hash,
    model: row.model,
    mode: row.mode,
    request: row.request,
    response: row.response,
    origin: triggerOriginFromRow(row),
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

// ---- Store ----

export class Store {
  readonly db: DatabaseSync;
  closed = false;
  private readonly dreamingAuthorities = new WeakMap<object, { rangeId: number; sessionId: number; token: string; executionId: string; runId: number }>();
  private readonly originAuthorities = new WeakMap<object, TriggerOrigin | null>();

  /** Capture once at admission. The ordered ids end at the exact native entry represented by this target. */
  triggerOrigin(path: KnowledgePath, triggerEntryId?: number): TriggerOrigin | null {
    if (!path.branch || path.headTurnId == null) return null;
    const row = this.db.prepare("SELECT entry_ids FROM source_paths WHERE session_id = ? AND branch = ?").get(path.sessionId, path.branch) as { entry_ids: string } | undefined;
    if (!row) return null;
    let ids: unknown;
    try { ids = JSON.parse(row.entry_ids); } catch { throw new Error("trigger origin path is malformed"); }
    if (!Array.isArray(ids)) throw new Error("trigger origin path is malformed");
    const explicit = triggerEntryId === undefined ? undefined : ids.indexOf(triggerEntryId);
    if (explicit !== undefined && explicit < 0) throw new Error("trigger origin does not contain the exact triggering entry");
    const captured = explicit === undefined ? ids : ids.slice(0, explicit + 1);
    if (captured.some(id => !Number.isInteger(id) || Number(id) <= 0) || new Set(captured).size !== captured.length)
      throw new Error("trigger origin path is malformed");
    if (!captured.length) return null;
    const rows = this.db.prepare("SELECT id, session_id, turn_id FROM source_entries WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(captured)) as { id: number; session_id: number; turn_id: number }[];
    if (rows.length !== captured.length || rows.some(entry => entry.session_id !== path.sessionId)) throw new Error("trigger origin path contains a missing or foreign entry");
    const byId = new Map(rows.map(entry => [entry.id, entry]));
    const turns = this.pathTurns(path);
    let trigger = explicit === undefined ? -1 : explicit;
    if (triggerEntryId !== undefined && !turns.has(byId.get(triggerEntryId)!.turn_id))
      throw new Error("trigger origin does not contain the exact triggering entry");
    if (explicit === undefined) for (let i = 0; i < captured.length; i++) if (turns.has(byId.get(Number(captured[i]))!.turn_id)) trigger = i;
    if (trigger < 0) throw new Error("trigger origin has no entry on the target ancestry");
    const prefix = captured.slice(0, trigger + 1).map(Number);
    if (prefix.some(id => !turns.has(byId.get(id)!.turn_id))) throw new Error("trigger origin is not an ordered native ancestry");
    return { sessionId: path.sessionId, entryIds: prefix };
  }

  /** Bind a captured value to a run object without exposing serialized authority. */
  bindRunOrigin(run: RunInput, origin: TriggerOrigin | null): RunInput {
    const authority = {};
    this.originAuthorities.set(authority, origin ? { sessionId: origin.sessionId, entryIds: [...origin.entryIds] } : null);
    return { ...run, originAuthority: authority };
  }

  private runOrigin(run: RunInput): TriggerOrigin | null {
    if (!run.originAuthority || !this.originAuthorities.has(run.originAuthority)) return null;
    const origin = this.originAuthorities.get(run.originAuthority)!;
    return origin ? { sessionId: origin.sessionId, entryIds: [...origin.entryIds] } : null;
  }

  /** Called only by admitted host execution, not by a model-facing tool. */
  bindDreamingRun(run: RunInput): RunInput {
    this.requireClaim(run);
    const range = run.dreamingRangeId === undefined ? null : this.dreamingRange(run.dreamingRangeId);
    if (run.kind !== "dreaming" || !run.claim || !run.executionId || !range || range.sessionId !== run.sessionId || range.branch !== run.branch)
      throw new Error("Dreamer binding requires its admitted claim, execution and frozen range");
    const authority = {};
    const runId = this.recordRun({ ...run, outcome: "failure", response: JSON.stringify({ status: "admitted; maintenance not yet completed" }) }).id;
    this.dreamingAuthorities.set(authority, { rangeId: range.id, sessionId: range.sessionId, token: run.claim.token, executionId: run.executionId, runId });
    return { ...run, dreamingAuthority: authority };
  }

  isDreamingRun(run: RunInput): boolean {
    const authority = run.dreamingAuthority && this.dreamingAuthorities.get(run.dreamingAuthority);
    return !!authority && run.kind === "dreaming" && authority.rangeId === run.dreamingRangeId && authority.sessionId === run.sessionId
      && authority.token === run.claim?.token && authority.executionId === run.executionId;
  }

  dreamingRunId(run: RunInput): number | undefined {
    return this.isDreamingRun(run) ? this.dreamingAuthorities.get(run.dreamingAuthority!)!.runId : undefined;
  }

  validateDreamingRun(run: RunInput, path: KnowledgePath, forCompletion = false): DreamingRange {
    if (!this.isDreamingRun(run)) throw new Error("trusted Dreamer run binding required");
    this.requireEnabled(run.sessionId!);
    this.requireClaim(run);
    // Another target may legitimately finish shared events while this execution is running.
    // Its final check still needs the original identity; writes continue to require an open range.
    const range = this.dreamingRange(run.dreamingRangeId!, forCompletion);
    if (!range || path.sessionId !== range.sessionId || path.branch !== range.branch || path.headTurnId !== range.headTurnId)
      throw new Error("Dreamer target differs from its retained path");
    const snapshot = this.pathSnapshot(path);
    if ([...range.eventIds, ...range.versionIds].some(id => { const revision = this.knowledgeRevision(id); return !revision || !this.commitApplies(revision, path, snapshot); }))
      throw new Error("Dreamer obligation no longer applies to its frozen path; do not settle the range");
    return range;
  }

  private readonly normalizeSource: SourceNormalizer | undefined;
  constructor(path: string, normalizeSource?: SourceNormalizer) {
    this.normalizeSource = normalizeSource;
    this.db = new DatabaseSync(path);
    try {
      this.db.exec("PRAGMA foreign_keys = ON;");
      // Another process may hold a short write lock; wait instead of failing. Immediate
      // transactions avoid a deferred read-to-write upgrade bypassing the busy handler.
      this.db.exec("PRAGMA busy_timeout = 5000;");
      this.db.exec(SCHEMA_SQL);
      migrateDreaming(this.db);
      this.transaction(() => {
        // Allocate once in original insertion order, across every branch of each Turn. Raw and
        // historic citation strings remain untouched. Recheck under the immediate write lock.
        if (!this.db.prepare("PRAGMA table_info(source_entries)").all().some(r => r.name === "entry_ordinal")) {
          this.db.exec(`ALTER TABLE source_entries ADD COLUMN entry_ordinal INTEGER CHECK(entry_ordinal > 0);
            WITH numbered AS (SELECT id, row_number() OVER (PARTITION BY turn_id ORDER BY id) AS ordinal FROM source_entries)
            UPDATE source_entries SET entry_ordinal = (SELECT ordinal FROM numbered WHERE numbered.id = source_entries.id);`);
        }
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_source_turn_ordinal ON source_entries(turn_id, entry_ordinal)");
        // Derived membership metadata keeps path/coverage queries off large immutable Raw bodies.
        // Both migration and new ingestion use the same block interpreter as write validation.
        const columns = this.db.prepare("PRAGMA table_info(source_entries)").all();
        if (!columns.some(r => r.name === "blocks")) this.db.exec("ALTER TABLE source_entries ADD COLUMN blocks TEXT");
        const newAddresses = !columns.some(r => r.name === "addresses");
        if (newAddresses) this.db.exec("ALTER TABLE source_entries ADD COLUMN addresses TEXT NOT NULL DEFAULT '[]'");
        if (newAddresses || normalizeSource) {
          const update = this.db.prepare("UPDATE source_entries SET addresses = ?, blocks = ? WHERE id = ?");
          for (const row of this.db.prepare(`SELECT id, content, entry_ordinal, blocks FROM source_entries ${newAddresses ? "" : "WHERE blocks IS NULL"} ORDER BY id`).iterate()) {
            const input = JSON.parse(String(row.content));
            let blocks: SourceBlock[] | undefined;
            if (row.blocks == null) {
              try { blocks = normalizeSource?.(input); }
              catch (error) {
                if (!(error instanceof SourceNormalizationError)) throw error;
                // Persist JSON null below: retain legacy proof without retrying this row on reopen.
                // Numeric storage identities locate the row without exposing Raw or native IDs.
                console.warn(`Trace Memory: legacy source normalization skipped; entry=${Number(row.id)} turn=${Number(input.turnId)}; call mapping mismatch`);
              }
            } else blocks = JSON.parse(String(row.blocks));
            const entry = { ...input, id: Number(row.id), entryOrdinal: Number(row.entry_ordinal), ...(blocks ? { blocks } : {}) };
            update.run(JSON.stringify(sourceAddresses(entry)), blocks ? JSON.stringify(blocks) : normalizeSource ? "null" : null, entry.id);
          }
        }
      });
      this.db.exec(PROCESSING_SQL);
      this.db.exec(EXECUTIONS_SQL);
      migrateKnowledgeLineage(this.db);
    } catch (error) {
      try { this.db.close(); } catch { /* Preserve the initialization error. */ }
      throw error;
    }
  }

  beginShutdown(): void {
    // Cleanup shares the host deadline; synchronous SQLite busy waits cannot consume it per write.
    this.db.exec("PRAGMA busy_timeout = 0;");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  // Preserve nested transactions with savepoints: project declaration nests a merge.
  transaction<T>(fn: () => T): T {
    const nested = this.db.isTransaction;
    this.db.exec(nested ? "SAVEPOINT trace_memory_transaction" : "BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec(nested ? "RELEASE trace_memory_transaction" : "COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec(nested
          ? "ROLLBACK TO trace_memory_transaction; RELEASE trace_memory_transaction"
          : "ROLLBACK");
      } catch { /* Preserve the original error if rollback fails. */ }
      throw error;
    }
  }

  // -- projects --

  createProject(input: CreateProjectInput): Project {
    const info = this.db.prepare("INSERT INTO projects (name, declared_by) VALUES (?, ?)").run(input.name, input.declaredBy);
    return this.getProject(Number(info.lastInsertRowid))!;
  }

  getProject(id: number): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? toProject(row) : null;
  }

  findProjectByName(name: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE name = ?").get(name);
    return row ? toProject(row) : null;
  }

  /** Relabel a merged project's sessions and project-scoped knowledge onto the survivor. */
  mergeProject(fromProjectId: number, intoProjectId: number): void {
    this.transaction(() => {
      const before = this.processedPlacements();
      this.db.prepare("UPDATE projects SET merged_into = ? WHERE id = ?").run(intoProjectId, fromProjectId);
      this.db.prepare("UPDATE sessions SET project_id = ? WHERE project_id = ?").run(intoProjectId, fromProjectId);
      this.db.prepare("UPDATE knowledge SET project_id = ? WHERE project_id = ?").run(intoProjectId, fromProjectId);
      this.revalidatePlacement(before);
    });
  }

  // -- sessions --

  /** A session row — and its id — exists only once the first assistant reply exists. */
  createSession(input: CreateSessionInput): Session {
    if (input.enrollmentChoice != null && typeof input.enrollmentChoice !== "boolean") throw new Error("Enrollment choice must be boolean");
    if (!input.firstReplyAt) {
      throw new Error("a session is allocated an id only once an assistant reply exists (firstReplyAt is required)");
    }
    const info = this.db.prepare("INSERT INTO sessions (host, started_at, first_reply_at, project_id, parent_session_id, project_declaration, enrollment_default, enrollment_choice) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(input.host, input.startedAt, input.firstReplyAt, input.projectId, input.parentSessionId ?? null, input.projectDeclaration ?? "marker", Number(enrollmentDefault(input.nativeCreatedAt, input.baseline)), input.enrollmentChoice == null ? null : Number(input.enrollmentChoice));
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  getSession(id: number): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : null;
  }

  enrollment(sessionId: number): Enrollment {
    const row = this.db.prepare("SELECT enrollment_default, enrollment_choice FROM sessions WHERE id = ?").get(sessionId);
    if (!row) throw new Error(`session S${sessionId} does not exist`);
    return { defaultEnabled: !!row.enrollment_default, choice: row.enrollment_choice === null ? null : !!row.enrollment_choice };
  }
  enabled(sessionId: number): boolean {
    const value = this.enrollment(sessionId);
    return value.choice ?? value.defaultEnabled;
  }
  setEnrollment(sessionId: number, enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("Enrollment choice must be boolean");
    this.transaction(() => {
      this.enrollment(sessionId);
      this.db.prepare("UPDATE sessions SET enrollment_choice = ? WHERE id = ?").run(Number(enabled), sessionId);
      if (enabled) this.db.prepare("DELETE FROM task_failures WHERE session_id = ?").run(sessionId);
    });
  }
  beginExecution(task: LogicalTask, previous?: string): string { return this.transaction(() => beginExecution(this, task, previous)); }
  executionOrigin(id: string): TriggerOrigin | null {
    const row = this.db.prepare("SELECT origin_session_id, origin_entry_ids FROM task_executions WHERE id = ?").get(id);
    if (!row) throw new Error("Unknown execution");
    return triggerOriginFromRow(row);
  }
  taskFailures(sessionId: number) {
    return this.db.prepare("SELECT * FROM task_failures WHERE session_id = ? ORDER BY phase, head").all(sessionId).map(row => ({
      phase: row.phase as Phase, head: Number(row.head), count: Number(row.count), lastReason: String(row.last_reason ?? ""),
      lastRunId: row.last_run_id === null ? null : Number(row.last_run_id), updatedAt: String(row.updated_at),
    }));
  }
  settleExecution(id: string, outcome: ExecutionOutcome, runId: number, reason?: string) {
    return settleExecution(this, id, outcome, runId, reason);
  }
  /** Core-only terminal path; the capability never crosses the model/public settlement boundary. */
  settleDreamingConflict(run: RunInput, reason: string): void {
    const runId = this.dreamingRunId(run);
    if (runId === undefined || !this.db.isTransaction) throw new Error("Trusted Dreamer termination transaction required");
    // Core checked the graph/path in this transaction; do not validate every event again.
    this.requireEnabled(run.sessionId!);
    this.requireClaim(run);
    settleExecution(this, run.executionId!, "conflict", runId, reason, run);
  }
  private completeExecution(runId: number): void {
    const row = this.db.prepare("SELECT execution_id FROM execution_runs WHERE run_id = ?").get(runId);
    if (row) this.settleExecution(String(row.execution_id), "success", runId);
  }
  requireEnabled(sessionId: number): void {
    if (!this.enabled(sessionId)) throw new Error("Trace Memory is Disabled; use /trace on to enable memory.");
  }

  /** 19c: record one eligible fork cache miss for this session. The UPDATE is guarded by IS NULL, so
   * two phases reporting a miss together produce one transition (and one warning): only the call
   * that changed the row returns true. */
  suppressFork(sessionId: number, at = new Date().toISOString()): boolean {
    this.enrollment(sessionId); // a missing session is an error, not a silent no-op
    return !!this.db.prepare("UPDATE sessions SET fork_suppressed_at = ? WHERE id = ? AND fork_suppressed_at IS NULL").run(at, sessionId).changes;
  }
  /** The session's automatic fork suppression, or null while it is not suppressed. */
  forkSuppression(sessionId: number): { at: string; runId: number | null } | null {
    const row = this.db.prepare("SELECT fork_suppressed_at, fork_suppressed_run FROM sessions WHERE id = ?").get(sessionId);
    if (!row) throw new Error(`session S${sessionId} does not exist`);
    return row.fork_suppressed_at === null ? null
      : { at: String(row.fork_suppressed_at), runId: row.fork_suppressed_run === null ? null : Number(row.fork_suppressed_run) };
  }
  /** Link the detecting run once core has given it an id; never overwrites an earlier episode's run. */
  linkForkSuppression(sessionId: number, runId: number): void {
    this.db.prepare("UPDATE sessions SET fork_suppressed_run = ? WHERE id = ? AND fork_suppressed_at IS NOT NULL AND fork_suppressed_run IS NULL").run(runId, sessionId);
  }
  /** The explicit retry (menu only). A later eligible miss starts a new downgrade episode. */
  clearForkSuppression(sessionId: number): void {
    this.db.prepare("UPDATE sessions SET fork_suppressed_at = NULL, fork_suppressed_run = NULL WHERE id = ?").run(sessionId);
  }

  closeSession(sessionId: number, at = new Date().toISOString()): void {
    this.db.prepare("UPDATE sessions SET closed_at = ? WHERE id = ?").run(at, sessionId);
  }

  reopenSession(sessionId: number, executorId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE sessions SET closed_at = NULL WHERE id = ?").run(sessionId);
      // Reserve the new tokens for this executor without launching either phase.
      for (const phase of ["noting", "consolidation", "dreaming"] as const) {
        const previous = this.getClaim(sessionId, phase);
        if (!previous || previous.executorId === executorId) continue;
        this.db.prepare("UPDATE task_claims SET executor_id = ?, token = ?, expires_at = ?, borrowed = 0, reserved = 1 WHERE session_id = ? AND phase = ?")
          .run(executorId, randomUUID(), Date.now() + 30 * 60_000, sessionId, phase);
      }
    });
  }

  getClaim(sessionId: number, phase: Phase): TaskClaim | null {
    const row = this.db.prepare("SELECT * FROM task_claims WHERE session_id = ? AND phase = ?").get(sessionId, phase);
    return row ? { sessionId, phase, executorId: String(row.executor_id), token: String(row.token),
      expiresAt: Number(row.expires_at), borrowed: !!row.borrowed, reserved: !!row.reserved } : null;
  }

  acquireClaim(target: TaskTarget, phase: Phase, executorId: string, borrowed = false, eligible: () => boolean = () => true): TaskClaim | null {
    return this.transaction(() => {
      if (!executorId || !this.enabled(target.sessionId)) return null;
      if (borrowed && this.getSession(target.sessionId)?.closedAt == null) return null;
      const pending = phase === "noting" ? this.pendingEntries(target.sessionId, target.branch, target.headTurnId)
        : phase === "dreaming" ? this.pendingKnowledgeEvents(target)
        : this.consolidationBatch(target.sessionId, target.branch, target.headTurnId);
      if ((!pending.length && !(phase === "dreaming" && this.retryDreamingRange(target))) || !eligible()) return null;
      const current = this.getClaim(target.sessionId, phase), now = Date.now();
      const takeover = current?.reserved && current.expiresAt > now && current.executorId === executorId && !borrowed;
      if (current && current.expiresAt > now && !takeover) return null;
      const claim: TaskClaim = { sessionId: target.sessionId, phase, executorId,
        token: takeover ? current.token : randomUUID(), expiresAt: now + 30 * 60_000, borrowed, reserved: false };
      this.db.prepare(`INSERT INTO task_claims (session_id, phase, executor_id, token, expires_at, borrowed, reserved) VALUES (?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT (session_id, phase) DO UPDATE SET executor_id = excluded.executor_id, token = excluded.token,
        expires_at = excluded.expires_at, borrowed = excluded.borrowed, reserved = 0`)
        .run(claim.sessionId, phase, executorId, claim.token, claim.expiresAt, Number(borrowed));
      return claim;
    });
  }

  releaseClaim(claim: TaskClaim): boolean {
    return !!this.db.prepare("DELETE FROM task_claims WHERE session_id = ? AND phase = ? AND token = ? AND executor_id = ?")
      .run(claim.sessionId, claim.phase, claim.token, claim.executorId).changes;
  }

  invalidateExecutor(executorId: string): void {
    this.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE executor_id = ?").run(executorId);
  }

  releaseExecutor(executorId: string): void {
    const rows = this.db.prepare("SELECT session_id, phase FROM task_claims WHERE executor_id = ?").all(executorId);
    for (const row of rows) {
      const claim = this.getClaim(Number(row.session_id), row.phase as Phase);
      if (claim?.executorId === executorId) this.releaseClaim(claim);
    }
  }

  private requireClaim(run: RunInput): void {
    if (!run.claim) return; // Manual writes and explicit low-level store commits have no worker.
    if (run.executorSessionId !== undefined) this.requireEnabled(run.executorSessionId);
    const claim = run.claim, current = this.getClaim(claim.sessionId, claim.phase);
    if (claim.sessionId !== run.sessionId || claim.phase !== run.kind || !current || current.reserved ||
        current.token !== claim.token || current.executorId !== claim.executorId || current.expiresAt <= Date.now())
      throw new Error("task claim is no longer current and unexpired");
    if (current.borrowed && this.getSession(claim.sessionId)?.closedAt == null) throw new Error("borrowed target is no longer closed");
    if (current.borrowed && !this.canBorrow(claim.sessionId, run.executorSessionId, run.closedSessionScope))
      throw new Error("borrowed work no longer satisfies its scope and active-executor requirements");
    if (run.projectId !== undefined && this.getSession(claim.sessionId)?.projectId !== run.projectId)
      throw new Error("target project changed after admission");
  }

  /** Closed tails require an enabled, open executor. Project scope additionally requires the same
   * project id. Rechecked at admission and commit; project names/cwd are never inferred. */
  canBorrow(targetSessionId: number, executorSessionId?: number, scope: ClosedSessionScope = "project"): boolean {
    if (scope === "off" || executorSessionId === undefined || executorSessionId === targetSessionId) return false;
    const executor = this.getSession(executorSessionId), target = this.getSession(targetSessionId);
    return !!executor && !!target && executor.closedAt === null && target.closedAt !== null &&
      (scope === "global" || executor.projectId === target.projectId) && this.enabled(executorSessionId) && this.enabled(targetSessionId);
  }

  closedTasks(phase: Phase, executorSessionId: number, scope: ClosedSessionScope = "project"): TaskTarget[] {
    const executor = this.getSession(executorSessionId);
    if (scope === "off" || !executor || executor.closedAt !== null || !this.enabled(executorSessionId)) return [];
    const targets: (TaskTarget & { oldest: number })[] = [];
    const sessions = this.db.prepare("SELECT id FROM sessions WHERE (? = 'global' OR project_id = ?) AND closed_at IS NOT NULL AND id != ? AND COALESCE(enrollment_choice, enrollment_default) = 1 ORDER BY id")
      .all(scope, executor.projectId, executorSessionId);
    for (const row of sessions) {
      const sessionId = Number(row.id);
      if ((this.getClaim(sessionId, phase)?.expiresAt ?? 0) > Date.now()) continue;
      const branches = this.db.prepare("SELECT branch FROM source_paths WHERE session_id = ? UNION SELECT branch FROM runs WHERE session_id = ? AND branch IS NOT NULL ORDER BY branch").all(sessionId, sessionId);
      for (const { branch } of branches) {
        const headTurnId = this.knowledgePath(sessionId, String(branch)).headTurnId;
        if (!headTurnId) continue;
        const pending = phase === "noting" ? this.pendingEntries(sessionId, String(branch), headTurnId)
          : phase === "dreaming" ? this.pendingKnowledgeEvents({ sessionId, branch: String(branch), headTurnId })
          : this.consolidationBatch(sessionId, String(branch), headTurnId);
        const retry = phase === "dreaming" ? this.retryDreamingRange({ sessionId, branch: String(branch), headTurnId }) : null;
        if (pending.length || retry) targets.push({ sessionId, branch: String(branch), headTurnId, oldest: retry?.anchor ?? Math.min(...pending.map(e => e.id)) });
      }
    }
    // Global source/fact allocation order is durable pending arrival order; branches never coalesce.
    return targets.sort((a, b) => a.oldest - b.oldest || a.sessionId - b.sessionId || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
      .map(({ oldest: _, ...target }) => target);
  }

  // -- turns & tool calls --

  appendTurn(input: AppendTurnInput): Turn {
    return this.transaction(() => {
      this.requireEnabled(input.sessionId);
      const ordinalRow = this.db
        .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM turns WHERE session_id = ?")
        .get(input.sessionId) as { next: number };
      const info = this.db.prepare(`INSERT INTO turns (session_id, ordinal, parent_turn_id, kind, user_prompt, assistant_text, started_at, ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.sessionId,
          ordinalRow.next,
          input.parentTurnId ?? null,
          input.kind,
          input.userPrompt ?? null,
          input.assistantText ?? null,
          input.startedAt,
          input.endedAt ?? null,
        );
      return this.getTurn(Number(info.lastInsertRowid))!;
    });
  }

  /** Raw is recorded incrementally: the turn row exists from the prompt; text and end time land when the turn ends. */
  updateTurn(id: number, patch: { assistantText?: string | null; endedAt?: string | null }): Turn {
    return this.transaction(() => {
      const turn = this.getTurn(id);
      if (!turn) throw new Error(`turn T${id} does not exist`);
      this.requireEnabled(turn.sessionId);
      this.db.prepare("UPDATE turns SET assistant_text = ?, ended_at = ? WHERE id = ?").run(
        patch.assistantText === undefined ? turn.assistantText : patch.assistantText,
        patch.endedAt === undefined ? turn.endedAt : patch.endedAt,
        id,
      );
      return this.getTurn(id)!;
    });
  }

  getTurn(id: number): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? toTurn(row) : null;
  }

  appendToolCall(input: AppendToolCallInput): ToolCall {
    return this.transaction(() => {
      this.requireEnabled(this.getTurn(input.turnId)!.sessionId);
      const ordinalRow = this.db
        .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM tool_calls WHERE turn_id = ?")
        .get(input.turnId) as { next: number };
      const info = this.db.prepare("INSERT INTO tool_calls (turn_id, ordinal, name, input, result, status) VALUES (?, ?, ?, ?, ?, ?)").run(input.turnId, ordinalRow.next, input.name, input.input ?? null, input.result ?? null, input.status);
      const row = this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(Number(info.lastInsertRowid));
      return toToolCall(row);
    });
  }

  completeToolCall(turnId: number, ordinal: number, result: string, status: string): void {
    return this.transaction(() => {
      this.requireEnabled(this.getTurn(turnId)!.sessionId);
      this.db.prepare("UPDATE tool_calls SET result = ?, status = ? WHERE turn_id = ? AND ordinal = ?").run(result, status, turnId, ordinal);
    });
  }

  listToolCalls(turnId: number): ToolCall[] {
    return this.db.prepare("SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY ordinal").all(turnId).map(toToolCall);
  }

  /** Display metadata only: grouping facts must not reread their Turns' Raw bodies per fact. */
  factTurnTimes(facts: readonly Pick<Fact, "turnId">[]): Map<number, string> {
    const ids = [...new Set(facts.map(f => f.turnId))];
    if (!ids.length) return new Map();
    return new Map((this.db.prepare("SELECT id, started_at FROM turns WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids)) as { id: number; started_at: string }[]).map(row => [row.id, row.started_at]));
  }

  listSessionFacts(sessionId: number): Fact[] {
    return this.db.prepare(
      "SELECT f.* FROM facts f JOIN turns t ON t.id = f.turn_id WHERE t.session_id = ? ORDER BY f.source_time DESC, f.id DESC",
    ).all(sessionId).map(toFact);
  }

  listProjectFacts(projectId: number): Fact[] {
    return this.db.prepare(
      `SELECT f.* FROM facts f JOIN turns t ON t.id = f.turn_id
       JOIN sessions s ON s.id = t.session_id WHERE s.project_id = ? ORDER BY f.source_time DESC, f.id DESC`,
    ).all(projectId).map(toFact);
  }

  listFactRelations(factId: number): FactRelation[] {
    return (this.db.prepare(
      "SELECT * FROM fact_relations WHERE from_fact = ? OR to_fact = ? ORDER BY from_fact, to_fact, kind, strength",
    ).all(factId, factId) as any[]).map((r) => ({
      fromFact: r.from_fact, toFact: r.to_fact, kind: r.kind, strength: r.strength,
    }));
  }

  /** 22c "complete snapshot": the same answer as `listFactRelations` for many facts in one read, so a
   * paged search can freeze what its deferred hits print without formatting or re-reading them. */
  listFactRelationsOf(factIds: number[]): Map<number, FactRelation[]> {
    const wanted = new Set(factIds), relations = new Map<number, FactRelation[]>([...wanted].map(id => [id, []]));
    if (!wanted.size) return relations;
    const ids = JSON.stringify([...wanted]);
    for (const r of this.db.prepare(`SELECT * FROM fact_relations
      WHERE from_fact IN (SELECT value FROM json_each(?)) OR to_fact IN (SELECT value FROM json_each(?))
      ORDER BY from_fact, to_fact, kind, strength`).all(ids, ids) as any[]) {
      const relation = { fromFact: r.from_fact, toFact: r.to_fact, kind: r.kind, strength: r.strength };
      for (const id of new Set([relation.fromFact, relation.toFact])) relations.get(id)?.push(relation);
    }
    return relations;
  }

  // -- runs (standalone: failure / cancelled, or a run with nothing else to commit) --

  recordRun(input: RunInput & { outcome: RunOutcome }): Run {
    return this.transaction(() => this.getRun(this.insertRun(input))!);
  }

  updateRun(id: number, input: RunInput & { outcome: RunOutcome }): void {
    this.transaction(() => {
      const previous = this.getRun(id);
      if (!previous) throw new Error(`run ${id} does not exist`);
      if (input.outcome !== "success" && this.db.prepare("SELECT 1 FROM dreaming_completions WHERE run_id = ?").get(id))
        throw new Error("A completed Dreaming run cannot be changed to an unsuccessful outcome");
      const factIds = (this.db.prepare("SELECT id FROM facts WHERE run_id = ? ORDER BY id").all(id) as { id: number }[]).map((f) => f.id);
      const response = JSON.parse(input.response ?? "{}");
      this.db.prepare("UPDATE runs SET request = ?, response = ?, outcome = ?, mode = ? WHERE id = ?")
        .run(input.request ?? null, JSON.stringify({ ...response, ...(input.entryAudit ? { entryAudit: input.entryAudit } : {}), ...(previous.kind === "noting" || factIds.length ? { factIds } : {}) }), input.outcome, input.mode ?? null, id);
    });
  }

  /** The session a run was run for, as metadata: one column, never the request and response bodies.
   * Scope checks need only this (review 2026-09-09: a footer refresh with
   * scoped knowledge was loading whole audit bodies through `getRun` to read one id). */
  runSessionId(runId: number): number | null {
    return (this.db.prepare("SELECT session_id FROM runs WHERE id = ?").get(runId) as { session_id: number } | undefined)?.session_id ?? null;
  }
  getRun(id: number): Run | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  }

  // -- facts --

  getFact(id: number): Fact | null {
    const row = this.db.prepare("SELECT * FROM facts WHERE id = ?").get(id);
    return row ? toFact(row) : null;
  }

  /** 25d "Range semantics": the facts that exist in an inclusive id interval, ascending. One indexed
   * query over the rows that are there, never a walk of the numeric span: `F1-F1000000000` costs what
   * its existing facts cost, and an interval over a gap answers with an empty list rather than with a
   * missing-record diagnostic per integer. */
  factMetadataInRange(from: number, to: number): { id: number; turnId: number; time: string }[] {
    return this.db.prepare("SELECT f.id, f.turn_id AS turnId, t.started_at AS time FROM facts f JOIN turns t ON t.id = f.turn_id WHERE f.id BETWEEN ? AND ? ORDER BY f.id").all(from, to) as { id: number; turnId: number; time: string }[];
  }

  listTurnFacts(turnId: number): Fact[] {
    return this.db.prepare("SELECT * FROM facts WHERE turn_id = ? ORDER BY id").all(turnId).map(toFact);
  }

  /**
   * Commit one noting run: the run record and its facts (with relations) as one transaction.
   * A relation target is either "F<id>" (an existing fact) or "$n" (the n-th fact of this
   * same batch, 1-based, resolved to its freshly assigned id inside this transaction).
   * On any failure (e.g. an out-of-range local handle) nothing but the run record is written,
   * with outcome "failure" — the run record is always written, business writes are not.
   */
  commitNotingRun(input: CommitNotingRunInput): CommitNotingResult {
    try {
      const result = this.transaction(() => {
        const sessionId = this.requireRunSession(input.run);
        this.requireEnabled(sessionId);
        this.requireClaim(input.run);
        const runId = this.insertRun({ ...input.run, outcome: "success" });
        const batchIds: number[] = [];
        for (const f of input.facts) {
          const turn = this.getTurn(f.turnId);
          if (!turn || turn.sessionId !== sessionId) {
            throw new Error(`turn T${f.turnId} does not belong to session S${sessionId}`);
          }
          const info = this.db.prepare("INSERT INTO facts (run_id, turn_id, category, actor, text, quote, status, source, source_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(runId, f.turnId, f.category, f.actor, f.text, f.quote ?? null, f.status ?? null, JSON.stringify(f.source), f.createdAt);
          const factId = Number(info.lastInsertRowid);
          batchIds.push(factId);
          for (const entryId of new Set(f.entryIds ?? [])) {
            if (this.getSourceEntry(entryId)?.sessionId !== sessionId) throw new Error("fact source entry does not belong to the run session");
            this.db.prepare("INSERT INTO fact_sources (fact_id, entry_id) VALUES (?, ?)").run(factId, entryId);
          }
        }
        const resolve = (target: string, batchIndex: number): number => {
          const fIdMatch = /^F(\d+)$/.exec(target);
          if (fIdMatch) return Number(fIdMatch[1]);
          const handleMatch = /^\$(\d+)$/.exec(target);
          if (handleMatch) {
            const n = Number(handleMatch[1]);
            // A handle may only point at an earlier fact of this batch: the extractor sees the past, never the future.
            if (n < 1 || n > batchIndex) {
              throw new Error(`invalid local handle "${target}" in fact #${batchIndex + 1}: a handle must name an earlier fact of this batch`);
            }
            return batchIds[n - 1]!;
          }
          throw new Error(`invalid relation target "${target}" in fact #${batchIndex + 1}`);
        };
        input.facts.forEach((f, i) => {
          const fromFact = batchIds[i]!;
          for (const kind of ["support", "negate"] as const) for (const rel of f[kind] ?? []) {
            this.db.prepare("INSERT INTO fact_relations (from_fact, to_fact, kind, strength) VALUES (?, ?, ?, ?)")
              .run(fromFact, resolve(rel.target, i), kind, rel.strength);
          }
        });
        let response: Record<string, unknown>;
        try { const parsed = JSON.parse(input.responseForFacts?.(batchIds) ?? input.run.response ?? "{}"); response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output: parsed }; }
        catch { response = { output: input.run.response }; }
        this.db.prepare("UPDATE runs SET response = ? WHERE id = ?").run(JSON.stringify({ ...response, ...(input.run.entryAudit ? { entryAudit: input.run.entryAudit } : {}), factIds: batchIds }), runId);
        for (const id of input.entryIds ?? []) {
          if (this.getSourceEntry(id)?.sessionId !== sessionId) throw new Error("entry does not belong to the run session");
          this.db.prepare("INSERT INTO noted_entries (entry_id, run_id) VALUES (?, ?)").run(id, runId);
        }
        this.completeExecution(runId);
        return { runId, facts: batchIds.map((id) => this.getFact(id)!) };
      });
      return { ok: true, runId: result.runId, facts: result.facts };
    } catch (err) {
      return { ok: false, ...this.recordFailure(input.run, err) };
    }
  }

  /** Write the failure run record; if even that cannot be written, say so instead of pretending it was. */
  private recordFailure(run: RunInput, err: unknown): { runId: number; problems: string[] } {
    const reason = err instanceof Error ? err.message : String(err);
    try {
      const runId = this.insertRun({ ...run, outcome: "failure", response: run.response ?? reason });
      return { runId, problems: [reason] };
    } catch (second) {
      const why = second instanceof Error ? second.message : String(second);
      throw new Error(`store unavailable: ${why} (while noting failure: ${reason})`);
    }
  }

  private requireRunSession(run: RunInput): number {
    if (run.sessionId === undefined || run.sessionId === null) throw new Error("a committed run must name its session");
    if (!this.getSession(run.sessionId)) throw new Error(`session S${run.sessionId} does not exist`);
    return run.sessionId;
  }

  private insertRun(input: RunInput & { outcome: RunOutcome }): number {
    const origin = this.runOrigin(input);
    const info = this.db.prepare(`INSERT INTO runs (kind, session_id, branch, range_from, range_to, prompt_hash, model, mode, request, response, origin_session_id, origin_entry_ids, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.kind,
        input.sessionId ?? null,
        input.branch ?? null,
        input.rangeFrom ?? null,
        input.rangeTo ?? null,
        input.promptHash ?? null,
        input.model ?? null,
        input.mode ?? null,
        input.request ?? null,
        input.entryAudit ? JSON.stringify({ ...JSON.parse(input.response ?? "{}"), entryAudit: input.entryAudit }) : input.response ?? null,
        origin?.sessionId ?? null,
        origin ? JSON.stringify(origin.entryIds) : null,
        input.outcome,
        input.createdAt,
      );
    const id = Number(info.lastInsertRowid);
    linkExecutionRun(this, id, input);
    if (input.dreamingRangeId !== undefined) {
      const range = this.dreamingRange(input.dreamingRangeId);
      if (input.kind !== "dreaming" || !range || range.sessionId !== input.sessionId)
        throw new Error("Dreaming run must belong to its retained range session");
      this.db.prepare("INSERT INTO dreaming_run_ranges VALUES (?, ?)").run(id, range.id);
    }
    return id;
  }

  // -- knowledge & revisions --

  getKnowledge(id: number): Knowledge | null {
    const row = this.db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id);
    return row ? toKnowledge(row) : null;
  }

  getKnowledgeRevision(knowledgeId: number, commitId: number): KnowledgeRevision | null {
    const row = this.db.prepare("SELECT * FROM knowledge_revisions WHERE knowledge_id = ? AND id = ?").get(knowledgeId, commitId);
    return row ? toKnowledgeRevision(row) : null;
  }

  listKnowledgeLinks(knowledgeId: number): KnowledgeLink[] {
    return (this.db.prepare(
      "SELECT * FROM knowledge_links WHERE from_knowledge = ? ORDER BY from_commit, kind, to_knowledge, to_commit",
    ).all(knowledgeId) as any[]).map((r) => ({
      fromKnowledge: r.from_knowledge, fromCommit: r.from_commit, kind: r.kind, toKnowledge: r.to_knowledge, toCommit: r.to_commit,
    }));
  }

  listKnowledgeRevisions(knowledgeId?: number): KnowledgeRevision[] {
    return this.db.prepare("SELECT * FROM knowledge_revisions WHERE ? IS NULL OR knowledge_id = ? ORDER BY id").all(knowledgeId ?? null, knowledgeId ?? null).map(toKnowledgeRevision);
  }

  /** The head's Turn ancestry, read in one query instead of one per Turn. The walk below still
   * decides: a missing Turn, a Turn of another session and a cycle remain an error, never a silently
   * shorter path. */
  pathTurns(path: KnowledgePath): Set<number> {
    if (!this.getSession(path.sessionId)) throw new Error(`session S${path.sessionId} does not exist`);
    const parents = new Map((this.db.prepare(`WITH RECURSIVE lineage(id, parent_turn_id) AS (
      SELECT t.id, t.parent_turn_id FROM turns t WHERE t.id = ? AND t.session_id = ?
      UNION SELECT t.id, t.parent_turn_id FROM turns t JOIN lineage l ON t.id = l.parent_turn_id WHERE t.session_id = ?
    ) SELECT id, parent_turn_id FROM lineage`).all(path.headTurnId, path.sessionId, path.sessionId) as { id: number; parent_turn_id: number | null }[])
      .map(r => [r.id, r.parent_turn_id]));
    const ids = new Set<number>();
    let id = path.headTurnId;
    while (id !== null) {
      if (!parents.has(id) || ids.has(id)) throw new Error("invalid path ancestry");
      ids.add(id); id = parents.get(id)!;
    }
    return ids;
  }

  /** Compatibility for callers without a host head: use the branch's latest recorded or manual turn. */
  knowledgePath(sessionId: number, branch?: string, headTurnId?: number | null): KnowledgePath {
    if (headTurnId !== undefined) return branch === undefined ? { sessionId, headTurnId } : { sessionId, headTurnId, branch };
    if (branch === undefined) {
      const row = this.db.prepare("SELECT id FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId);
      return { sessionId, headTurnId: row ? Number(row.id) : null };
    }
    const native = this.db.prepare("SELECT entry_ids FROM source_paths WHERE session_id = ? AND branch = ?").get(sessionId, branch) as { entry_ids: string } | undefined;
    if (native) {
      const row = this.db.prepare("SELECT turn_id FROM source_entries WHERE id = ?").get((JSON.parse(native.entry_ids) as number[]).at(-1) ?? 0);
      return { sessionId, headTurnId: row ? Number(row.turn_id) : null, branch };
    }
    const member = this.db.prepare("SELECT s.turn_id FROM noted_entries e JOIN source_entries s ON s.id = e.entry_id JOIN runs r ON r.id = e.run_id WHERE r.session_id = ? AND r.branch = ? ORDER BY s.id DESC LIMIT 1").get(sessionId, branch) as { turn_id: number } | undefined;
    let recorded = member?.turn_id ?? 0;
    for (const row of this.db.prepare(`SELECT range_to FROM runs WHERE session_id = ? AND branch = ?
      AND (kind = 'manual' OR (kind = 'noting' AND outcome = 'success'))`).all(sessionId, branch))
      recorded = Math.max(recorded, Number(/\/T(\d+)$/.exec(String(row.range_to ?? ""))?.[1] ?? 0));
    return { sessionId, headTurnId: recorded || null, branch };
  }

  private admits(revision: KnowledgeRevision, sessionId: number, input?: ApplicabilityInput): boolean {
    if (revision.scope === "global") return true;
    const origin = revision.runId === null ? null : input ? input.runs.get(revision.runId) : this.runSessionId(revision.runId);
    if (revision.scope === "session") return origin === sessionId;
    return origin != null && (input ? input.projects.get(origin) === input.projects.get(sessionId)
      : this.getSession(origin)?.projectId === this.getSession(sessionId)?.projectId);
  }

  /** All citations from the reader's own session constrain applicability; since 21a that is one
   * `supports` list per commit, archives included. */
  private currentSet(path: KnowledgePath | null, projectId?: number, snapshot?: PathSnapshot): KnowledgeWithRevision[] {
    return this.commitGraph(path, projectId, snapshot).current.map(revision => ({ knowledge: this.getKnowledge(revision.knowledgeId)!, revision }));
  }

  /** One resolution of the commit DAG (22c): every revision, which of them apply to `path` (and to
   * `projectId`, where a scope filter is asked for), which of those are current, and the descendants
   * of any commit. A read resolves this once and answers every hit from it instead of rebuilding the
   * graph per hit. Like the path snapshot it is a value that never outlives its read, so the next
   * read sees another executor's commits; a page asked for later still reports its own query's.
   *
   * An operation that has already built the path snapshot (22a) passes it: the footer's progress
   * values are one operation and share one membership, exactly as `consolidationBatch` does. */
  commitGraph(path: KnowledgePath | null, projectId?: number, prepared?: PathSnapshot, input = this.commitGraphInput()): CommitGraph {
    const snapshot = path ? prepared ?? this.pathSnapshot(path) : null;
    const { revisions, parents, metadata } = input;
    const facts = new Map<number, boolean>(), commits = new Map<number, boolean>(), projectCommits = new Map<number, boolean>();
    const applicable = revisions.filter(r => (projectId === undefined || this.commitAppliesToProject(r, projectId, metadata, projectCommits)) &&
      (!path || this.commitApplies(r, path, snapshot!, metadata, facts, commits)));
    return this.projectCommitGraph(revisions, parents, applicable);
  }

  /** DAG and applicability inputs for one synchronous projection, before any placement mutation. */
  commitGraphInput() {
    const revisions = this.db.prepare("SELECT * FROM knowledge_revisions ORDER BY id").all().map(toKnowledgeRevision);
    const parents = new Map(revisions.map(r => [r.id, r.parentId === null ? [] : [r.parentId]]));
    for (const link of this.db.prepare("SELECT from_commit, to_commit FROM knowledge_links WHERE kind = 'merged_into'").all() as { from_commit: number; to_commit: number }[]) {
      parents.get(link.to_commit)!.push(link.from_commit);
    }
    const runIds = JSON.stringify([...new Set(revisions.flatMap(r => r.runId === null ? [] : [r.runId]))]);
    const factIds = JSON.stringify([...new Set(revisions.flatMap(r => r.supports))]);
    const metadata: ApplicabilityInput = {
      revisions: new Map(revisions.map(r => [r.id, r])),
      parents,
      runs: new Map(this.db.prepare("SELECT id, session_id FROM runs WHERE id IN (SELECT value FROM json_each(?))")
        .all(runIds).map(r => [Number(r.id), Number(r.session_id)])),
      projects: new Map(this.db.prepare("SELECT id, project_id FROM sessions").all().map(r => [Number(r.id), Number(r.project_id)])),
      facts: new Map(this.db.prepare(`SELECT f.*, t.session_id FROM facts f JOIN turns t ON t.id = f.turn_id
        WHERE f.id IN (SELECT value FROM json_each(?))`).all(factIds)
        .map(r => [Number(r.id), { fact: toFact(r), sessionId: Number(r.session_id), entries: [] }])),
    };
    for (const row of this.db.prepare("SELECT fact_id, entry_id FROM fact_sources WHERE fact_id IN (SELECT value FROM json_each(?)) ORDER BY entry_id").all(factIds))
      metadata.facts.get(Number(row.fact_id))!.entries.push(Number(row.entry_id));
    return { revisions, parents, metadata };
  }

  private projectCommitGraph(revisions: KnowledgeRevision[], parents: Map<number, number[]>, applicable: KnowledgeRevision[]): CommitGraph {
    const superseded = new Set<number>();
    // ponytail: scan the commit DAG per read; index/cache only if measured history size requires it.
    for (const r of applicable) {
      const pending = [...parents.get(r.id)!];
      while (pending.length) {
        const id = pending.pop()!;
        if (superseded.has(id)) continue;
        superseded.add(id); pending.push(...parents.get(id)!);
      }
    }
    let children: Map<number, number[]> | undefined; // the same edges, downwards; built only if asked for
    return { revisions, applicable: new Set(applicable.map(r => r.id)), current: applicable.filter(r => !superseded.has(r.id)),
      descendants: (commitId: number) => {
        if (!children) { children = new Map(); for (const [id, up] of parents) for (const parent of up) children.set(parent, [...(children.get(parent) ?? []), id]); }
        const ids = new Set([commitId]), pending = [commitId];
        while (pending.length) for (const child of children.get(pending.pop()!) ?? []) if (!ids.has(child)) { ids.add(child); pending.push(child); }
        return ids;
      } };
  }

  /** One operation's answer to "is this on the selected path" (22a): the path's Turn set, the branch's
   * selected source-entry identities, and the run memo Consolidation progress needs. Built once at the
   * start of an operation and passed down; it never outlives it, so a commit, an enrollment change or a
   * branch move by another executor between two operations is seen. Nothing here parses a Raw payload:
   * identity comes from `turn_id` and, only where a fact was written without entry bindings, from
   * `json_extract` over that one Turn's entries. */
  pathSnapshot(path: KnowledgePath): PathSnapshot {
    const turns = this.pathTurns(path);
    return { turns, entries: this.pathEntries(path, turns), consolidatedRuns: new Map() };
  }

  /** The branch's selected native ancestry up to the head, as entry ids per Turn; null when the path
   * names no branch or the branch has no selected ancestry (headless seams keep Turn semantics).
   * `addresses` answers one Turn at a time and keeps the answer for the rest of the operation; only a
   * fact written without entry bindings asks. */
  private pathEntries(path: KnowledgePath, turns: Set<number>): PathSnapshot["entries"] {
    if (!path.branch || !path.headTurnId) return null;
    const row = this.db.prepare("SELECT entry_ids FROM source_paths WHERE session_id = ? AND branch = ?").get(path.sessionId, path.branch) as { entry_ids: string } | undefined;
    if (!row) return null;
    const ids = new Set<number>(), byTurn = new Map<number, number[]>();
    for (const { id, turn_id } of this.db.prepare("SELECT e.id, e.turn_id FROM json_each(?) j JOIN source_entries e ON e.id = j.value")
      .all(row.entry_ids) as { id: number; turn_id: number }[]) {
      if (!turns.has(turn_id)) continue;
      ids.add(id); byTurn.set(turn_id, [...(byTurn.get(turn_id) ?? []), id]);
    }
    const cache = new Map<number, Set<string>>();
    return { ids, addresses: (turnId: number) => {
      if (!cache.has(turnId)) cache.set(turnId, this.addressesOf(turnId, byTurn.get(turnId) ?? []));
      return cache.get(turnId)!;
    } };
  }

  /** Historical source membership for one Turn's selected entries, including persisted precise
   * fragments and legacy role/tool aliases. New-note permission is checked separately. */
  private addressesOf(turnId: number, ids: number[]): Set<string> {
    const addresses = new Set<string>();
    for (const row of ids.length ? this.db.prepare("SELECT addresses FROM source_entries WHERE turn_id = ? AND id IN (SELECT value FROM json_each(?))").all(turnId, JSON.stringify(ids)) : [])
      for (const address of JSON.parse(String(row.addresses)) as string[]) addresses.add(address);
    return addresses;
  }

  factEntries(factId: number): number[] {
    return (this.db.prepare("SELECT entry_id FROM fact_sources WHERE fact_id = ? ORDER BY entry_id").all(factId) as { entry_id: number }[]).map(r => r.entry_id);
  }

  factCoveredByRaw(fact: Fact, covered: ReadonlySet<number>): boolean {
    return this.factsCoveredByRaw([fact], covered).has(fact.id);
  }

  /** Re-resolve citations in the original Noting run's frozen entry set, never today's path.
   * Manual/legacy writes without that set cannot prove completeness and stay eligible.
   * Two metadata-only queries per allocation; no Raw bodies or persistent cache. */
  factsCoveredByRaw(facts: readonly Fact[], covered: ReadonlySet<number>): Set<number> {
    const result = new Set<number>();
    if (!facts.length || !covered.size) return result;
    const bindings = new Map<number, Set<number>>(), runs = new Map<number, number>();
    for (const row of this.db.prepare("SELECT f.run_id, b.fact_id, b.entry_id FROM fact_sources b JOIN facts f ON f.id = b.fact_id WHERE f.id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(facts.map(f => f.id)))) {
      const id = Number(row.fact_id);
      runs.set(id, Number(row.run_id));
      if (!bindings.has(id)) bindings.set(id, new Set());
      bindings.get(id)!.add(Number(row.entry_id));
    }
    const sources = new Map<number, Map<string, Set<number>>>();
    for (const row of this.db.prepare(`SELECT n.run_id, e.id, e.addresses
      FROM noted_entries n JOIN runs r ON r.id = n.run_id
      JOIN source_entries e ON e.id = n.entry_id AND e.session_id = r.session_id
      WHERE r.kind = 'noting' AND r.outcome = 'success' AND r.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...new Set(runs.values())]))) {
      const run = Number(row.run_id);
      if (!sources.has(run)) sources.set(run, new Map());
      const addresses = sources.get(run)!;
      for (const address of JSON.parse(String(row.addresses)) as string[]) {
        if (!addresses.has(address)) addresses.set(address, new Set());
        addresses.get(address)!.add(Number(row.id));
      }
    }
    for (const fact of facts) {
      const bound = bindings.get(fact.id), addresses = sources.get(runs.get(fact.id)!);
      const keys = fact.source.map(sourceKey);
      if (!bound?.size || !keys.length || !addresses || !keys.every(key => addresses.has(key))) continue;
      const expected = new Set(keys.flatMap(key => [...addresses.get(key)!]));
      if (expected.size === bound.size && [...expected].every(id => bound.has(id) && covered.has(id))) result.add(fact.id);
    }
    return result;
  }

  /** A fact is on a path when its Turn and every cited Turn are on the ancestry and, when the branch has a
   * selected native ancestry, the source entries it was bound to when written are all in it (review
   * 2026-09-08: T1#assistant is shared by every assistant entry of T1, so identity decides, not the address).
   * A fact written without bindings falls back to the address check. Foreign-session facts are judged by scope. */
  factOnPath(fact: Fact, path: KnowledgePath, snapshot = this.pathSnapshot(path), input?: ApplicabilityInput): boolean {
    if ((input ? input.facts.get(fact.id)!.sessionId : this.getTurn(fact.turnId)!.sessionId) !== path.sessionId) return true;
    const { turns, entries } = snapshot;
    if (!turns.has(fact.turnId) || !fact.source.every(source => turns.has(Number(/^T([1-9]\d*)#/.exec(source)?.[1])))) return false;
    if (entries === null) return true;
    const bound = input ? input.facts.get(fact.id)!.entries : this.factEntries(fact.id);
    return bound.length ? bound.every(id => entries.ids.has(id))
      : fact.source.every(source => entries.addresses(Number(/^T([1-9]\d*)#/.exec(source)![1])).has(sourceKey(source)));
  }

  private commitAppliesToProject(commit: KnowledgeRevision, projectId: number, input: ApplicabilityInput,
    commits: Map<number, boolean>, visiting = new Set<number>()): boolean {
    if (commits.has(commit.id)) return commits.get(commit.id)!;
    if (visiting.has(commit.id)) throw new Error(`knowledge lineage cycle at commit ${commit.id}`);
    visiting.add(commit.id);
    const runSession = commit.runId === null ? undefined : input.runs.get(commit.runId);
    let applies = commit.scope === "global" || (commit.scope === "project" && runSession !== undefined && input.projects.get(runSession) === projectId);
    if (applies && commit.supportSemantics === "change") applies = (input.parents?.get(commit.id) ?? []).every(id => {
      const parent = input.revisions?.get(id);
      if (!parent) throw new Error(`knowledge commit ${commit.id} has missing parent ${id}`);
      return this.commitAppliesToProject(parent, projectId, input, commits, visiting);
    });
    visiting.delete(commit.id); commits.set(commit.id, applies);
    return applies;
  }

  commitApplies(commit: KnowledgeRevision, path: KnowledgePath, snapshot = this.pathSnapshot(path), input?: ApplicabilityInput,
    facts = new Map<number, boolean>(), commits = new Map<number, boolean>(), visiting = new Set<number>()): boolean {
    if (commits.has(commit.id)) return commits.get(commit.id)!;
    if (visiting.has(commit.id)) throw new Error(`knowledge lineage cycle at commit ${commit.id}`);
    visiting.add(commit.id);
    const own = this.admits(commit, path.sessionId, input) && commit.supports.every(id => {
      if (!facts.has(id)) {
        const stored = input?.facts.get(id)?.fact ?? this.getFact(id);
        if (!stored) throw new Error(`knowledge commit ${commit.id} cites missing fact ${id}`);
        facts.set(id, this.factOnPath(stored, path, snapshot, input));
      }
      return facts.get(id)!;
    });
    let applies = own;
    if (applies && commit.supportSemantics === "change") {
      const ids = input?.parents?.get(commit.id) ?? this.commitParents(commit).map(parent => parent.id);
      applies = ids.every(id => {
        const parent = input?.revisions?.get(id) ?? this.knowledgeRevision(id);
        if (!parent) throw new Error(`knowledge commit ${commit.id} has missing parent ${id}`);
        return this.commitApplies(parent, path, snapshot, input, facts, commits, visiting);
      });
    }
    visiting.delete(commit.id); commits.set(commit.id, applies);
    return applies;
  }

  /** Effective grounding is used for explanations/accounting; direct supports remain the immutable change evidence. */
  revisionGrounds(commit: KnowledgeRevision, memo = new Map<number, Set<number>>(), visiting = new Set<number>()): Set<number> {
    const cached = memo.get(commit.id); if (cached) return new Set(cached);
    if (visiting.has(commit.id)) throw new Error(`knowledge lineage cycle at commit ${commit.id}`);
    visiting.add(commit.id);
    const grounds = new Set(commit.supports);
    if (commit.supportSemantics === "change") for (const parent of this.commitParents(commit))
      for (const id of this.revisionGrounds(parent, memo, visiting)) grounds.add(id);
    visiting.delete(commit.id); memo.set(commit.id, grounds);
    return new Set(grounds);
  }

  commitParents(commit: KnowledgeRevision): KnowledgeRevision[] {
    return this.db.prepare(`SELECT * FROM knowledge_revisions WHERE id = ? OR id IN
      (SELECT from_commit FROM knowledge_links WHERE to_commit = ? AND kind = 'merged_into') ORDER BY id`)
      .all(commit.parentId, commit.id).map(toKnowledgeRevision);
  }

  commitChildren(commit: KnowledgeRevision): KnowledgeRevision[] {
    return this.db.prepare(`SELECT * FROM knowledge_revisions WHERE parent_id = ? OR id IN
      (SELECT to_commit FROM knowledge_links WHERE from_commit = ? AND kind = 'merged_into') ORDER BY id`)
      .all(commit.id, commit.id).map(toKnowledgeRevision);
  }

  currentCommit(knowledgeId: number, path: KnowledgePath | null = null): KnowledgeRevision[] {
    return this.currentSet(path).filter(k => k.knowledge.id === knowledgeId).map(k => k.revision);
  }

  listCurrentKnowledge(path: KnowledgePath | null = null, filter: KnowledgeFilter = {}, snapshot?: PathSnapshot): KnowledgeWithRevision[] {
    return this.currentSet(path, filter.projectId, snapshot).filter(({ revision: r }) => r.op !== "archive" &&
      (!filter.scope || r.scope === filter.scope));
  }

  listVisibleKnowledge(sessionId: number, projectId: number, headTurnId?: number | null, branch?: string): KnowledgeWithRevision[] {
    return sessionId ? this.listCurrentKnowledge(this.knowledgePath(sessionId, branch, headTurnId))
      : this.listCurrentKnowledge(null, { projectId });
  }

  citationProblem(ids: number[], scope: KnowledgeScope, path: KnowledgePath, snapshot = this.pathSnapshot(path)): string | null {
    const projectId = this.getSession(path.sessionId)!.projectId;
    for (const id of ids) {
      const fact = this.getFact(id);
      if (!fact) return `cited fact F${id} does not exist`;
      const sessionId = this.getTurn(fact.turnId)!.sessionId;
      if (sessionId === path.sessionId) {
        if (!this.factOnPath(fact, path, snapshot)) return `F${id}: record an adoption fact on this path first`;
      } else if (scope === "session" || (scope === "project" && this.getSession(sessionId)!.projectId !== projectId)) {
        return `F${id}: not an available fact for ${scope} scope`;
      }
    }
    return null;
  }

  commitDescendants(commitId: number): Set<number> {
    return new Set((this.db.prepare(`WITH RECURSIVE
      edges(parent, child) AS (
        SELECT parent_id, id FROM knowledge_revisions WHERE parent_id IS NOT NULL
        UNION SELECT from_commit, to_commit FROM knowledge_links WHERE kind = 'merged_into'
      ), descendants(id) AS (
        SELECT ? UNION SELECT e.child FROM edges e JOIN descendants d ON e.parent = d.id
      ) SELECT id FROM descendants`).all(commitId) as { id: number }[]).map(r => r.id));
  }

  baseProblem(knowledgeId: number, base: number, path: KnowledgePath | null): string | null {
    const revision = this.getKnowledgeRevision(knowledgeId, base);
    if (revision && revision.op !== "archive" && (!path || this.commitApplies(revision, path))) return null;
    return `K${knowledgeId}@${base}: base is missing, archived or inapplicable at the frozen writer path`;
  }

  /** Direct consuming edges across update, merge, split and archive identities. */
  consumingSuccessors(commitIds: readonly number[]): Map<number, number[]> {
    const ids = [...new Set(commitIds)];
    const result = new Map(ids.map(id => [id, [] as number[]]));
    if (!ids.length) return result;
    for (const row of this.db.prepare(`WITH edges(parent, child) AS (
      SELECT parent_id, id FROM knowledge_revisions WHERE parent_id IS NOT NULL
      UNION SELECT from_commit, to_commit FROM knowledge_links WHERE kind = 'merged_into'
    ) SELECT parent, child FROM edges WHERE parent IN (SELECT value FROM json_each(?)) ORDER BY parent, child`).all(JSON.stringify(ids)))
      result.get(Number(row.parent))!.push(Number(row.child));
    return result;
  }

  /** The immutable-origin guard is separate from evidence applicability and complete-read authority. */
  private competingSuccessors(knowledgeId: number, baseCommit: number, path: KnowledgePath | null, runId: number): ConsumedBaseConflict | null {
    const successors = this.consumingSuccessors([baseCommit]).get(baseCommit)!;
    if (!successors.length) return null;
    const incoming = this.getRun(runId)!;
    const conflicts: number[] = [];
    for (const successorId of successors) {
      const successor = this.knowledgeRevision(successorId)!;
      const prior = successor.runId === null ? null : this.getRun(successor.runId);
      const priorSession = prior?.sessionId ?? null;
      if (priorSession === incoming.sessionId) {
        const relation = compareTriggerOrigins(incoming.origin, prior!.origin);
        if (relation === "unknown") throw new Error(`K${knowledgeId}@${baseCommit}: trigger ancestry is unknown for an existing same-session successor; re-admit from authoritative native ancestry`);
        if (relation === "independent") throw new Error(`K${knowledgeId}@${baseCommit}: stored trigger origin does not match its target session`);
        if (relation !== "divergent") conflicts.push(successorId);
      } else if (!path || this.commitApplies(successor, path)) conflicts.push(successorId);
    }
    return conflicts.length ? { knowledgeId, baseCommit, successorCommits: conflicts } : null;
  }

  /** Commit one atomic knowledge batch. Every exact base and consuming edge is rechecked here. */
  commitConsolidationRun(input: CommitConsolidationRunInput): CommitConsolidationResult {
    try {
      const result = this.transaction(() => {
        const sessionId = this.requireRunSession(input.run);
        this.requireEnabled(sessionId);
        this.requireClaim(input.run);
        const projectId = this.getSession(sessionId)!.projectId;
        const runId = this.dreamingRunId(input.run) ?? this.insertRun({ ...input.run, outcome: "success" });
        const committed: CommittedKnowledgeOp[] = [];
        const path = input.path === undefined ? this.knowledgePath(sessionId) : input.path;
        if (this.isDreamingRun(input.run)) {
          if (!path) throw new Error("Dreamer requires its frozen path");
          const range = this.validateDreamingRun(input.run, path);
          const parents = input.operations.flatMap(op => op.op === "create" ? [] : op.op === "merge" ? [op.intoKnowledgeId, ...op.absorb.map(a => a.knowledgeId)] : [op.knowledgeId]);
          if (parents.some(id => !range.knowledgeIds.includes(id))) throw new Error("knowledge outside the frozen Dreamer family is read-only");
          if (input.operations.some(op => op.op === "create")) throw new Error("Dreamer cannot create knowledge without an explicit split parent");
        } else if (input.operations.some(op => op.op === "split" || (op.op === "merge" && input.run.kind === "consolidation"))) {
          throw new Error("structural operation requires trusted Dreamer authority");
        }
        for (const op of input.operations) {
          const trustedDreaming = this.isDreamingRun(input.run);
          const role: "consolidation" | "dreaming" | "manual" = trustedDreaming ? "dreaming" : input.run.kind === "consolidation" ? "consolidation" : "manual";
          const outcome = this.applyKnowledgeOperation(op, runId, projectId, sessionId, path, trustedDreaming, role);
          if (outcome.ok) committed.push(...outcome.value);
          else throw new Error(outcome.reason);
        }
        for (const factId of input.consolidated ?? []) this.markConsolidated(factId, runId, projectId);
        if (input.finalizeResponse) {
          this.db.prepare("UPDATE runs SET response = ? WHERE id = ?").run(input.finalizeResponse({ committed }), runId);
        }
        if (input.run.kind === "consolidation") this.completeExecution(runId);
        return { runId, committed };
      });
      return { ok: true, ...result };
    } catch (err) {
      const run = { ...input.run };
      if (input.finalizeResponse && run.response) {
        try { run.response = JSON.stringify({ ...JSON.parse(run.response), problems: [err instanceof Error ? err.message : String(err)] }); }
        catch { /* Preserve non-JSON responses supplied by direct store callers. */ }
      }
      const runId = this.dreamingRunId(run);
      const failed = runId === undefined ? this.recordFailure(run, err) : { runId, problems: [err instanceof Error ? err.message : String(err)] };
      return { ok: false, ...failed, ...(err instanceof ConsumedBaseConflictError ? { conflicts: [err.conflict] } : {}) };
    }
  }

  private applyKnowledgeOperation(op: KnowledgeOperationInput, runId: number, projectId: number,
    sessionId: number, path: KnowledgePath | null, dreaming = false, role: "consolidation" | "dreaming" | "manual" = "manual"): { ok: true; value: CommittedKnowledgeOp[] } | { ok: false; reason: string } {
    if (path && path.sessionId !== sessionId) return { ok: false, reason: "writer path must belong to the run session" };
    if (op.op === "merge" && (op.absorb.length !== 1 || op.absorb[0]!.baseCommit === op.intoBaseCommit))
      return { ok: false, reason: "merge requires exactly two distinct parents" };
    const targets = op.op === "create" ? [] : op.op === "merge"
      ? [{ knowledgeId: op.intoKnowledgeId, baseCommit: op.intoBaseCommit }, ...op.absorb]
      : [{ knowledgeId: op.knowledgeId, baseCommit: op.baseCommit }];
    const seen = new Set<number>();
    for (const target of targets) {
      const bad = this.baseProblem(target.knowledgeId, target.baseCommit, path);
      if (bad) return { ok: false, reason: bad };
      const conflict = this.competingSuccessors(target.knowledgeId, target.baseCommit, path, runId);
      if (conflict) {
        const incoming = this.getRun(runId)!;
        const independent = conflict.successorCommits.some(id => this.getRun(this.knowledgeRevision(id)!.runId!)!.sessionId !== incoming.sessionId);
        throw new ConsumedBaseConflictError(conflict, `K${target.knowledgeId}@${target.baseCommit}: ${independent ? "applicable consuming successor from independent target session" : "competing consuming successor from comparable trigger origin"}: ${conflict.successorCommits.map(id => `@${id}`).join(", ")}`);
      }
      if (seen.has(target.baseCommit)) return { ok: false, reason: "duplicate merge parent; a commit cannot absorb itself" };
      seen.add(target.baseCommit);
    }
    const prior = targets.length ? this.getKnowledgeRevision(targets[0]!.knowledgeId, targets[0]!.baseCommit)! : null;
    const scope = op.op === "archive" || op.op === "split" ? prior!.scope : op.scope;
    const supports = op.supports;
    if (!supports.length && !dreaming) return { ok: false, reason: "supports must not be empty; only a trusted Dreamer maintenance operation has an exception" };
    if (typeof op.reason !== "string" || !op.reason.trim()) return { ok: false, reason: "reason must be a non-empty commit message" };
    const bad = this.citationProblem(supports, scope, path ?? this.knowledgePath(sessionId));
    if (bad) return { ok: false, reason: bad };
    const range = this.db.prepare("SELECT range_id FROM dreaming_run_ranges WHERE run_id = ?").get(runId);
    const insertRevision = (knowledgeId: number, parentId: number | null, text: string, category: KnowledgeCategory, topics: string[], revisionOp: KnowledgeOp) => {
      const info = this.db.prepare(`INSERT INTO knowledge_revisions
        (knowledge_id, parent_id, text, category, scope, supports, support_semantics, op, reason, topics, run_id, created_at, actor_role)
        VALUES (?, ?, ?, ?, ?, ?, 'change', ?, ?, ?, ?, ?, ?)`).run(knowledgeId, parentId, text, category, scope,
          JSON.stringify(supports), revisionOp, op.reason, JSON.stringify(topics), runId, op.createdAt, role);
      const commit = Number(info.lastInsertRowid);
      if (range) this.db.prepare("INSERT OR IGNORE INTO dreaming_family VALUES (?, ?)").run(range.range_id!, knowledgeId);
      changeWeight(this, commit);
      return commit;
    };
    if (op.op === "split") {
      if (op.children.length !== 2) return { ok: false, reason: "split requires exactly two complete children" };
      if (op.children.some(child => !child.text.trim() || !KNOWLEDGE_CATEGORIES.includes(child.category) ||
          !Array.isArray(child.topics) || child.topics.some(topic => typeof topic !== "string" || !topic.trim())))
        return { ok: false, reason: "split requires exactly two complete children with text, category and topics" };
      const author = this.getKnowledge(op.knowledgeId)!.author;
      const values = op.children.map(child => {
        const knowledgeId = Number(this.db.prepare("INSERT INTO knowledge (project_id, origin_session_id, author) VALUES (?, ?, ?)")
          .run(projectId, sessionId, author).lastInsertRowid);
        const commit = insertRevision(knowledgeId, prior!.id, child.text, child.category, child.topics, "split");
        this.db.prepare("INSERT INTO knowledge_links (from_knowledge, from_commit, kind, to_knowledge, to_commit) VALUES (?, ?, 'split_from', ?, ?)")
          .run(op.knowledgeId, op.baseCommit, knowledgeId, commit);
        return { op: "split" as const, knowledgeId, commit };
      });
      return { ok: true, value: values };
    }
    const knowledgeId = op.op === "create" ? Number(this.db.prepare(
      "INSERT INTO knowledge (project_id, origin_session_id, author) VALUES (?, ?, ?)",
    ).run(projectId, sessionId, op.author).lastInsertRowid) : targets[0]!.knowledgeId;
    const commitId = insertRevision(knowledgeId, prior?.id ?? null, op.op === "archive" ? "" : op.text,
      op.op === "archive" ? prior!.category : op.category, op.op === "archive" ? prior!.topics : op.topics, op.op);
    if (op.op === "merge") for (const parent of op.absorb) {
      this.db.prepare("INSERT INTO knowledge_links (from_knowledge, from_commit, kind, to_knowledge, to_commit) VALUES (?, ?, 'merged_into', ?, ?)")
        .run(parent.knowledgeId, parent.baseCommit, knowledgeId, commitId);
    }
    return { ok: true, value: [{ op: op.op, ...(op.op === "create" ? { handle: op.handle } : {}), knowledgeId, commit: commitId }] };
  }

  // -- shared exact Dreamer processing; no automatic worker is launched by these primitives --

  knowledgeRevision(commitId: number): KnowledgeRevision | null {
    const row = this.db.prepare("SELECT * FROM knowledge_revisions WHERE id = ?").get(commitId);
    return row ? toKnowledgeRevision(row) : null;
  }

  knowledgeEventWeight(commitId: number, version = KNOWLEDGE_VIEW_VERSION): number {
    return changeWeight(this, commitId, version);
  }

  pendingKnowledgeEvents(path: KnowledgePath) { return pendingEvents(this, path); }

  pendingKnowledgeRevisions(path: KnowledgePath) {
    // Compare immutable integer identities first; deserialize only pending candidates, not the
    // settled history. All exclusions use existing primary keys, with no second event ledger.
    return this.db.prepare(`SELECT r.* FROM knowledge_revisions r WHERE r.id IN (
      SELECT id FROM knowledge_revisions EXCEPT SELECT event_id FROM settled_knowledge_events)
      AND NOT EXISTS (SELECT 1 FROM dreaming_run_ranges d WHERE d.run_id = r.run_id)
      AND (r.scope = 'global' OR EXISTS (SELECT 1 FROM runs u JOIN sessions s ON s.id = u.session_id
        WHERE u.id = r.run_id AND ((r.scope = 'session' AND s.id = ?) OR
          (r.scope = 'project' AND s.project_id = (SELECT project_id FROM sessions WHERE id = ?))))
        OR EXISTS (SELECT 1 FROM dreaming_range_events e JOIN dreaming_ranges d ON d.id = e.range_id
          WHERE e.event_id = r.id AND d.session_id = ? AND d.branch = ? AND d.completed_run IS NULL)) ORDER BY r.id`)
      .all(path.sessionId, path.sessionId, path.sessionId, path.branch ?? "").map(toKnowledgeRevision);
  }

  isKnowledgeProcessed(commitId: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM processed_knowledge_versions WHERE commit_id = ?").get(commitId);
  }

  /** Exact processed versions among one caller-selected commit set, in one bounded lookup. */
  processedKnowledgeVersions(commitIds: readonly number[]): Set<number> {
    if (!commitIds.length) return new Set();
    return new Set((this.db.prepare("SELECT commit_id FROM processed_knowledge_versions WHERE commit_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify([...new Set(commitIds)])) as { commit_id: number }[]).map(row => row.commit_id));
  }

  /** Build one admission-local graph, applicability snapshot and rendered-result cache. Selection
   * may price many candidate batches, but it must not turn each candidate into another database or
   * graph scan. The snapshot is deliberately returned as a value and is never retained by Store. */
  dreamingInputSnapshot(path: KnowledgePath, ownCommits?: number[]) {
    const range = this.openDreamingRange(path.sessionId, path.branch ?? "");
    // Retry reads live revisions on the retained path, not the caller's advancing head. An exact
    // event selection may name a range event another target just settled: it remains a graph root
    // for this frozen read even though it no longer appears in the unsettled-event heading.
    const inputPath = range ? { sessionId: range.sessionId, branch: range.branch, headTurnId: range.headTurnId } : path;
    const graphInput = this.commitGraphInput();
    const pathSnapshot = this.pathSnapshot(inputPath);
    const graph = this.commitGraph(inputPath, undefined, pathSnapshot, graphInput);
    const events = pendingEvents(this, inputPath, true, pathSnapshot, graphInput, graph);
    const outputRoots = range ? ownCommits ?? this.dreamingOwnCommits(range.id) : [];
    const processed = this.processedKnowledgeVersions(graph.current.map(revision => revision.id));
    const revisions = new Map(graph.revisions.map(revision => [revision.id, revision]));
    const knowledgeIds = [...new Set(graph.current.flatMap(revision => [revision.knowledgeId,
      ...(revision.op === "archive" && revision.parentId !== null ? [revisions.get(revision.parentId)?.knowledgeId] : [])]).filter((id): id is number => id !== undefined))];
    const knowledge = new Map((knowledgeIds.length ? this.db.prepare("SELECT * FROM knowledge WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(knowledgeIds)) : [])
      .map(row => { const value = toKnowledge(row); return [value.id, value] as const; }));
    const value = (revision: KnowledgeRevision) => {
      const item = knowledge.get(revision.knowledgeId);
      if (!item) throw new Error(`Knowledge K${revision.knowledgeId} is unavailable`);
      return { knowledge: item, revision };
    };
    const current = new Set(graph.current.map(revision => revision.id));
    const eventResults = new Map(events.map(event => [event.id, new Set<number>()]));
    for (const result of graph.current) {
      const pending = [result.id], visited = new Set<number>();
      while (pending.length) {
        const id = pending.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        eventResults.get(id)?.add(result.id);
        pending.push(...(graphInput.parents.get(id) ?? []));
      }
    }
    const resultsOfRoots = (roots: readonly number[]) => {
      const descendants = new Set<number>();
      for (const id of roots) for (const child of graph.descendants(id)) descendants.add(child);
      return new Set(graph.current.filter(revision => descendants.has(revision.id) && !processed.has(revision.id)).map(revision => revision.id));
    };
    const ownResults = resultsOfRoots(outputRoots);
    const rendered = new Map<number, string>();
    const render = (revision: KnowledgeRevision) => {
      if (!rendered.has(revision.id)) rendered.set(revision.id, renderKnowledge(value(revision)));
      return rendered.get(revision.id)!;
    };
    const selectResults = (obligationIds: readonly number[], resultIds: ReadonlySet<number>) => {
      const selected = new Set(obligationIds), selectedObligations = events.filter(event => selected.has(event.id));
      const selectedEvents = selectedObligations.filter(event => event.kind === "event");
      const selectedVersions = selectedObligations.filter(event => event.kind === "version");
      const versions = graph.current.filter(revision => resultIds.has(revision.id)).map(revision => ({
        ...value(revision), processed: processed.has(revision.id),
      }));
      const predecessors = [...new Set(versions.filter(v => v.revision.op === "archive").map(v => v.revision.parentId!))].map(id => {
        const revision = revisions.get(id);
        if (!revision) throw new Error(`Archive predecessor ${id} is unavailable`);
        return value(revision);
      });
      const supplied = new Set(versions.filter(v => v.revision.op !== "archive").map(v => v.revision.id));
      const text = [`Change events: ${selectedEvents.map(e => `K${e.knowledgeId}@${e.id} (${e.tokens})`).join(", ") || "none"}`,
        `Exact version obligations: ${selectedVersions.map(value => `K${value.knowledgeId}@${value.id} (${value.tokens})`).join(", ") || "none"}`,
        ...predecessors.filter(v => !supplied.has(v.revision.id)).map(v => `Archive predecessor (historical, not a new fact):\n${render(v.revision)}`),
        ...versions.map(v => v.revision.op === "archive"
          ? `K${v.knowledge.id}@${v.revision.id} archived${v.revision.actorRole === "dreaming" && !v.revision.supports.length ? " (maintenance judgment)" : " (fact-backed)"}; actor: ${v.revision.actorRole ?? "fact-backed writer"}; parent K${v.knowledge.id}@${v.revision.parentId}; supports: ${v.revision.supports.map(id => `F${id}`).join(", ")}; reason: ${v.revision.reason}`
          : `${render(v.revision)}\n  processed: ${v.processed}`)].join("\n");
      return { events: selectedEvents, obligations: selectedObligations, versionObligations: selectedVersions,
        eventResults: selectedEvents.map(event => ({ eventId: event.id, commits: [...(eventResults.get(event.id) ?? [])].filter(id => resultIds.has(id)).sort((a, b) => a - b) })),
        oldestId: range?.anchor ?? selectedObligations[0]?.id ?? null, versions, predecessors, text,
        tokens: tokens(text), pendingTokens: selectedObligations.reduce((n, event) => n + event.tokens, 0) };
    };
    const resultsFor = (eventIds: readonly number[], roots: readonly number[] = outputRoots) => {
      const resultIds = roots === outputRoots ? new Set(ownResults) : resultsOfRoots(roots);
      for (const id of eventIds) {
        let results = eventResults.get(id);
        // An exact caller may name a range event another target just settled. It is absent from the
        // pending heading but remains a graph root for this frozen read.
        if (!results) {
          results = new Set([...graph.descendants(id)].filter(commit => current.has(commit)));
        }
        for (const result of results) resultIds.add(result);
      }
      return resultIds;
    };
    const input = (eventIds: readonly number[], roots: readonly number[] = outputRoots) =>
      selectResults(eventIds, resultsFor(eventIds, roots));
    // Events sharing one current merge result are one selectable unit: supplying only one side
    // would pretend the merged result were independent. Standalone legal outputs remain individual
    // obligations, so an oversized one cannot pin unrelated retained events.
    const components = (candidateIds: readonly number[]) => {
      const byId = new Map(events.map(obligation => [obligation.id, obligation]));
      const allowedEvents = new Set(candidateIds.filter(id => byId.get(id)?.kind === "event"));
      const resultEvents = new Map<number, number[]>();
      for (const id of allowedEvents) for (const result of eventResults.get(id) ?? [])
        resultEvents.set(result, [...(resultEvents.get(result) ?? []), id]);
      const visited = new Set<number>(), groups: { obligationIds: number[]; resultIds: number[]; ownOutput: boolean }[] = [];
      for (const first of candidateIds) {
        if (visited.has(first)) continue;
        if (byId.get(first)?.kind === "version") {
          visited.add(first); groups.push({ obligationIds: [first], resultIds: [...(eventResults.get(first) ?? [])], ownOutput: false }); continue;
        }
        const pending = [first], members: number[] = [], results = new Set<number>();
        while (pending.length) {
          const id = pending.pop()!;
          if (visited.has(id) || !allowedEvents.has(id)) continue;
          visited.add(id); members.push(id);
          for (const result of eventResults.get(id) ?? []) {
            results.add(result);
            for (const peer of resultEvents.get(result) ?? []) if (!visited.has(peer)) pending.push(peer);
          }
        }
        groups.push({ obligationIds: members.sort((a, b) => a - b), resultIds: [...results], ownOutput: [...results].some(id => ownResults.has(id)) });
      }
      const associated = new Set(groups.flatMap(group => group.resultIds));
      return [...[...ownResults].filter(id => !associated.has(id)).map(id => ({ obligationIds: [] as number[], resultIds: [id], ownOutput: true })), ...groups];
    };
    const select = (retainedIds: readonly number[] | undefined, fits: (candidate: ReturnType<typeof selectResults>) => boolean) => {
      if (retainedIds === undefined) {
        let low = 0, high = events.length;
        while (low < high) {
          const middle = Math.ceil((low + high) / 2), ids = events.slice(0, middle).map(event => event.id);
          if (fits(selectResults(ids, resultsFor(ids, [])))) low = middle;
          else high = middle - 1;
        }
        const ids = events.slice(0, low).map(event => event.id), selected = selectResults(ids, resultsFor(ids, []));
        return { eventIds: selected.events.map(event => event.id), versionIds: selected.versionObligations.map(value => value.id), input: selected, blocked: [] as string[], ownBlocked: false };
      }
      const pending = new Set(events.map(event => event.id));
      const candidates = retainedIds.filter(id => pending.has(id));
      const blocked: string[] = [], fitting: ReturnType<typeof components> = [];
      for (const component of components(candidates)) {
        if (fits(selectResults(component.obligationIds, new Set(component.resultIds)))) fitting.push(component);
        else blocked.push(`${component.ownOutput ? "retained task output " : ""}${component.obligationIds.length
          ? component.obligationIds.map(id => `K@${id}`).join("+") : component.resultIds.map(id => `output K@${id}`).join("+")}`);
      }
      let low = 0, high = fitting.length;
      const selection = (count: number) => ({ obligationIds: fitting.slice(0, count).flatMap(component => component.obligationIds),
        resultIds: new Set(fitting.slice(0, count).flatMap(component => component.resultIds)) });
      while (low < high) {
        const middle = Math.ceil((low + high) / 2), candidate = selection(middle);
        if (fits(selectResults(candidate.obligationIds, candidate.resultIds))) low = middle;
        else high = middle - 1;
      }
      const picked = selection(low), selected = selectResults(picked.obligationIds, picked.resultIds);
      return { eventIds: selected.events.map(event => event.id), versionIds: selected.versionObligations.map(value => value.id), input: selected, blocked,
        ownBlocked: blocked.some(label => label.startsWith("retained task output ")) };
    };
    return { events, input, select };
  }

  /** Event weight is cumulative; changed input supplies each current exact body only once.
   * A bounded caller selects eventIds first and settles only those actually supplied. */
  dreamingInput(path: KnowledgePath, eventIds?: number[], ownCommits?: number[]) {
    const snapshot = this.dreamingInputSnapshot(path, ownCommits);
    const ids = eventIds ?? snapshot.events.map(event => event.id);
    return snapshot.input(ids);
  }

  /** Exact outputs of this retained task, across batches and failed executions. Neither family
   * membership nor an external writer's actor label proves that a revision belongs to this task. */
  dreamingOwnCommits(rangeId: number): number[] {
    return this.db.prepare(`SELECT r.id FROM knowledge_revisions r JOIN dreaming_run_ranges d ON d.run_id = r.run_id
      WHERE d.range_id = ? ORDER BY r.id`).all(rangeId).map(r => Number(r.id));
  }

  /** A frozen unfinished range retries independently of new-event weight and shared settlement. */
  retryDreamingRange(path: KnowledgePath, input?: ReturnType<Store["commitGraphInput"]>): DreamingRange | null {
    const range = this.openDreamingRange(path.sessionId, path.branch ?? "");
    if (!range) return null;
    if (this.db.prepare(`SELECT 1 FROM dreaming_range_events e WHERE range_id = ?
      AND NOT EXISTS (SELECT 1 FROM settled_knowledge_events s WHERE s.event_id = e.event_id) LIMIT 1`).get(range.id)) return range;
    const obligations = new Set([...range.versionIds, ...this.dreamingOwnCommits(range.id)]);
    const graph = this.commitGraph({ sessionId: range.sessionId, branch: range.branch, headTurnId: range.headTurnId }, undefined, undefined, input);
    return graph.current.some(revision => obligations.has(revision.id) && !this.isKnowledgeProcessed(revision.id)) ? range : null;
  }

  dreamingRange(id: number, includeCompleted = false): DreamingRange | null {
    const row = this.db.prepare(`SELECT * FROM dreaming_ranges WHERE id = ?${includeCompleted ? "" : " AND completed_run IS NULL"}`).get(id);
    return row ? { id, sessionId: Number(row.session_id), branch: String(row.branch), headTurnId: Number(row.head_turn_id), anchor: Number(row.anchor),
      eventIds: this.db.prepare("SELECT event_id FROM dreaming_range_events WHERE range_id = ? ORDER BY event_id").all(id).map(r => Number(r.event_id)),
      versionIds: this.db.prepare("SELECT commit_id FROM dreaming_range_versions WHERE range_id = ? ORDER BY commit_id").all(id).map(r => Number(r.commit_id)),
      knowledgeIds: this.db.prepare("SELECT knowledge_id FROM dreaming_family WHERE range_id = ? ORDER BY knowledge_id").all(id).map(r => Number(r.knowledge_id)),
      origin: triggerOriginFromRow(row) } : null;
  }

  openDreamingRange(sessionId: number, branch: string): DreamingRange | null {
    const row = this.db.prepare("SELECT id FROM dreaming_ranges WHERE session_id = ? AND branch = ? AND completed_run IS NULL").get(sessionId, branch);
    return row ? this.dreamingRange(Number(row.id)) : null;
  }

  retainDreamingRange(target: TaskTarget, eventIds: number[], suppliedKnowledgeIds: number[] = [], origin: TriggerOrigin | null = this.triggerOrigin(target, target.triggerEntryId), versionIds: number[] = []): DreamingRange {
    return this.transaction(() => {
      const retained = this.openDreamingRange(target.sessionId, target.branch);
      if (retained) return retained;
      const pending = this.pendingKnowledgeEvents(target);
      const events = [...new Set(eventIds)].sort((a, b) => a - b), versions = [...new Set(versionIds)].sort((a, b) => a - b);
      const obligations = [...events, ...versions];
      if (!obligations.length || events.some(id => !pending.some(value => value.id === id && value.kind === "event")) ||
          versions.some(id => !pending.some(value => value.id === id && value.kind === "version")))
        throw new Error("Dreaming range requires exact applicable pending events or versions");
      const id = Number(this.db.prepare("INSERT INTO dreaming_ranges(session_id,branch,head_turn_id,anchor,origin_session_id,origin_entry_ids) VALUES (?,?,?,?,?,?)")
        .run(target.sessionId, target.branch, target.headTurnId, Math.min(...obligations), origin?.sessionId ?? null, origin ? JSON.stringify(origin.entryIds) : null).lastInsertRowid);
      for (const event of pending.filter(value => obligations.includes(value.id))) {
        if (event.kind === "event") this.db.prepare("INSERT INTO dreaming_range_events VALUES (?,?)").run(id, event.id);
        else this.db.prepare("INSERT INTO dreaming_range_versions VALUES (?,?)").run(id, event.id);
        this.db.prepare("INSERT OR IGNORE INTO dreaming_family VALUES (?,?)").run(id, event.knowledgeId);
      }
      const current = new Set(suppliedKnowledgeIds.length ? this.commitGraph(target).current.map(r => r.knowledgeId) : []);
      for (const knowledgeId of suppliedKnowledgeIds) {
        if (!current.has(knowledgeId)) throw new Error("Dreamer family must be applicable at admission");
        this.db.prepare("INSERT OR IGNORE INTO dreaming_family VALUES (?,?)").run(id, knowledgeId);
      }
      return this.dreamingRange(id)!;
    });
  }

  checkProcessedScopes(acceptedResultIds: number[] = []) { return checkProcessedScopes(this, acceptedResultIds); }

  /** 32d passes its target/claim/frozen-family recheck here, inside the same short transaction.
   * The successful run and two exact sets are authoritative; no watermark or tip substitution. */
  completeDreaming(runId: number, eventIds: number[], resultIds: number[], validate: () => void = () => {}): void {
    this.transaction(() => {
      const events = [...new Set(eventIds)].sort((a, b) => a - b), results = [...new Set(resultIds)].sort((a, b) => a - b);
      const previous = this.db.prepare("SELECT * FROM dreaming_completions WHERE run_id = ?").get(runId);
      if (previous) {
        if (previous.event_ids !== JSON.stringify(events) || previous.result_ids !== JSON.stringify(results)) throw new Error("Dreaming completion already recorded with different exact sets");
        return;
      }
      const run = this.getRun(runId);
      if (!run || run.kind !== "dreaming" || run.outcome !== "success") throw new Error("Dreaming completion requires a successful dreaming run");
      validate();
      for (const id of [...events, ...results]) if (!Number.isSafeInteger(id) || !this.db.prepare("SELECT 1 FROM knowledge_revisions WHERE id = ?").get(id))
        throw new Error(`Unknown knowledge commit ${id}`);
      const affected = new Set(results.map(id => {
        const revision = this.knowledgeRevision(id)!;
        return placementOwner(this, { revision });
      }));
      const check = checkProcessedScopes(this, results, affected);
      if (check.problems.length) throw new Error(check.problems.join("; "));
      this.db.prepare("INSERT INTO dreaming_completions VALUES (?,?,?)").run(runId, JSON.stringify(events), JSON.stringify(results));
      for (const id of events) this.db.prepare("INSERT OR IGNORE INTO settled_knowledge_events VALUES (?,?)").run(id, runId);
      for (const id of results) this.db.prepare("INSERT OR IGNORE INTO processed_knowledge_versions VALUES (?,?)").run(id, runId);
      this.completeExecution(runId);
      // Shared certification may finish another session's retained work too. Settlement alone
      // cannot close it: every applicable current result, including derived K, must be processed.
      const ranges = this.db.prepare(`SELECT session_id, branch FROM dreaming_ranges WHERE completed_run IS NULL
        AND NOT EXISTS (SELECT 1 FROM dreaming_range_events e WHERE e.range_id = dreaming_ranges.id
          AND NOT EXISTS (SELECT 1 FROM settled_knowledge_events s WHERE s.event_id = e.event_id))`).all();
      const input = ranges.length ? this.commitGraphInput() : undefined;
      for (const row of ranges) {
        const path = { sessionId: Number(row.session_id), branch: String(row.branch), headTurnId: null };
        if (!this.retryDreamingRange(path, input)) this.db.prepare(`UPDATE dreaming_ranges SET completed_run = ?
          WHERE session_id = ? AND branch = ? AND completed_run IS NULL`).run(runId, path.sessionId, path.branch);
      }
    });
  }

  private processedPlacements() {
    const projection = processedProjection(this);
    const active = new Set<number>();
    for (const pool of projection.pools.values()) for (const id of pool.keys()) active.add(id);
    return { owners: projection.owners, active, projection };
  }

  private revalidatePlacement(before: ReturnType<Store["processedPlacements"]>): void {
    const after = this.processedPlacements();
    // Admission can expose a certified global predecessor even when no certificate's owner moves.
    // Compare the actual projected pool, not just the relabelled sessions or knowledge rows.
    const moved = [...new Set([...before.active, ...after.active])].filter(id =>
      before.owners.get(id) !== after.owners.get(id) || before.active.has(id) !== after.active.has(id));
    if (!moved.length) return;
    const affected = new Set(moved.flatMap(id => [before.owners.get(id)!, after.owners.get(id)!]));
    const check = checkProcessedProjection(after.projection, affected);
    if (check.problems.length) throw new Error(`Project placement rejected: ${check.problems.join("; ")}`);
    for (const id of moved) this.db.prepare(`INSERT INTO knowledge_placement_validations
      (commit_id,old_owner,new_owner,view_version,created_at) VALUES (?,?,?,?,?)`).run(id, before.owners.get(id)!, after.owners.get(id)!, KNOWLEDGE_VIEW_VERSION, new Date().toISOString());
  }

  // -- marks: each row belongs to one immutable commit --
  addKnowledgeMark(knowledgeId: number, commitId: number, kind: KnowledgeMarkKind, createdAt: string): KnowledgeMark {
    if (!this.getKnowledgeRevision(knowledgeId, commitId)) throw new Error(`knowledge K${knowledgeId} has no commit ${commitId}`);
    this.db.prepare("INSERT INTO knowledge_marks (knowledge_id, commit_id, kind, created_at) VALUES (?, ?, ?, ?)").run(knowledgeId, commitId, kind, createdAt);
    return { knowledgeId, commitId, kind, createdAt };
  }

  listKnowledgeMarks(knowledgeId: number): KnowledgeMark[] {
    return this.db.prepare("SELECT * FROM knowledge_marks WHERE knowledge_id = ? ORDER BY created_at ASC").all(knowledgeId)
      .map((row: any) => ({ knowledgeId: row.knowledge_id, commitId: row.commit_id, kind: row.kind, createdAt: row.created_at }));
  }

  /** 22c "complete snapshot": the marks of many commits in one read, keyed by the commit asked for
   * (`commit_id` is unique, so each key holds at most one mark). A mark written later is not in it. */
  listKnowledgeMarksOf(commitIds: number[]): Map<number, KnowledgeMark[]> {
    const marks = new Map<number, KnowledgeMark[]>([...new Set(commitIds)].map(id => [id, []]));
    if (!marks.size) return marks;
    for (const row of this.db.prepare("SELECT * FROM knowledge_marks WHERE commit_id IN (SELECT value FROM json_each(?)) ORDER BY created_at ASC")
      .all(JSON.stringify([...marks.keys()])) as any[]) {
      marks.get(row.commit_id)!.push({ knowledgeId: row.knowledge_id, commitId: row.commit_id, kind: row.kind, createdAt: row.created_at });
    }
    return marks;
  }

  listTurns(sessionId: number): Turn[] {
    return this.db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY id").all(sessionId).map(toTurn);
  }

  listRuns(sessionId: number): Run[] {
    return this.db.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY id").all(sessionId).map(toRun);
  }
  /** 22d: one row per run of a session, carrying its kind and the usage it recorded — projected out
   * of `runs.response` in SQL, so the request and response audit bodies stay in the database. No
   * schema change: `json_extract` over the existing column, the shape 22a's amendment allows.
   * `usage` is null exactly when the run recorded no usage observation — a response without one, a
   * cancelled run whose usage is unknown, or a response that is not JSON at all. A run whose usage
   * object exists but is empty is an observation of zeros, and is reported as one; nothing here
   * manufactures a zero for a missing one (parent 22, "Capacity and accounting"). */
  listRunUsage(sessionId: number): { kind: RunKind; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | null }[] {
    const rows = this.db.prepare(`SELECT kind,
        CASE WHEN json_valid(response) THEN json_type(response, '$.usage') END recorded,
        CASE WHEN json_valid(response) THEN json_extract(response, '$.usage.input') END input,
        CASE WHEN json_valid(response) THEN json_extract(response, '$.usage.output') END output,
        CASE WHEN json_valid(response) THEN json_extract(response, '$.usage.cacheRead') END cacheRead,
        CASE WHEN json_valid(response) THEN json_extract(response, '$.usage.cacheWrite') END cacheWrite,
        CASE WHEN json_valid(response) THEN json_extract(response, '$.usage.cost.total') END cost
      FROM runs WHERE session_id = ? ORDER BY id`).all(sessionId) as Record<string, unknown>[];
    const count = (value: unknown) => (typeof value === "number" ? value : 0);
    return rows.map(row => ({ kind: row.kind as RunKind,
      // `json_type` is null for a missing key and 'null' for a recorded null: both are "no observation".
      usage: !row.recorded || row.recorded === "null" ? null
        : { input: count(row.input), output: count(row.output), cacheRead: count(row.cacheRead), cacheWrite: count(row.cacheWrite), cost: count(row.cost) } }));
  }
  listFactsByRun(runId: number): Fact[] {
    return this.db.prepare("SELECT * FROM facts WHERE run_id = ? ORDER BY id").all(runId).map(toFact);
  }
  listCommitsByRun(runId: number): KnowledgeRevision[] {
    return this.db.prepare("SELECT * FROM knowledge_revisions WHERE run_id = ? ORDER BY id").all(runId).map(toKnowledgeRevision);
  }

  projectDeclaration(sessionId: number): string {
    return (this.db.prepare("SELECT project_declaration FROM sessions WHERE id = ?").get(sessionId) as { project_declaration: string }).project_declaration;
  }

  declareProject(sessionId: number, name: string, source: "marker" | "mark"): Project {
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      if (!session) throw new Error(`session S${sessionId} does not exist`);
      if (!["marker", "mark"].includes(source)) throw new Error("invalid project declaration source");
      if (!name.trim()) throw new Error("project name must not be empty");
      const prior = this.projectDeclaration(sessionId);
      if (source === "marker" && prior === "mark") return this.getProject(session.projectId)!;
      let target = this.findProjectByName(name) ?? this.createProject({ name, declaredBy: source });
      while (target.mergedInto !== null) target = this.getProject(target.mergedInto)!;
      if (prior === "undeclared" && session.projectId !== target.id) this.mergeProject(session.projectId, target.id);
      const before = this.processedPlacements();
      this.db.prepare("UPDATE sessions SET project_id = ?, project_declaration = ? WHERE id = ?").run(target.id, source, sessionId);
      this.revalidatePlacement(before);
      return target;
    });
  }

  mark(commitId: number, kind: KnowledgeMarkKind | "clear", time = new Date().toISOString()): number {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT * FROM knowledge_revisions WHERE id = ?").get(commitId);
      if (!row) throw new Error(`knowledge commit ${commitId} does not exist`);
      const revision = toKnowledgeRevision(row);
      this.db.prepare("DELETE FROM knowledge_marks WHERE commit_id = ?").run(commitId);
      if (kind !== "clear") this.addKnowledgeMark(revision.knowledgeId, commitId, kind, time);
      return commitId;
    });
  }

  searchAddresses(query: string, scope: "facts" | "knowledge" | "all" | "raw"): string[] {
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const raw = () => (this.db.prepare(`SELECT t.id FROM turns t WHERE
        (t.user_prompt LIKE ? ESCAPE '\\' OR t.assistant_text LIKE ? ESCAPE '\\' OR EXISTS
        (SELECT 1 FROM tool_calls c WHERE c.turn_id = t.id AND
        (c.name LIKE ? ESCAPE '\\' OR c.input LIKE ? ESCAPE '\\' OR c.result LIKE ? ESCAPE '\\'))) ORDER BY t.id`)
        .all(pattern, pattern, pattern, pattern, pattern) as { id: number }[]).map((r) => `T${r.id}`);
    if (scope === "raw") return raw();
    const facts = scope === "knowledge" ? [] : (this.db.prepare("SELECT id FROM facts WHERE text LIKE ? ESCAPE '\\' ORDER BY id").all(pattern) as { id: number }[]).map((r) => `F${r.id}`);
    // 21b: a label matches under the same literal semantics and escaping as the text. EXISTS over
    // json_each reads label values, never the JSON punctuation around them, and returns one row per
    // revision however many labels (or text and labels together) match.
    const knowledge = scope === "facts" ? [] : (this.db.prepare(`SELECT knowledge_id, id FROM knowledge_revisions
      WHERE text LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_each(topics) WHERE value LIKE ? ESCAPE '\\')
      ORDER BY knowledge_id, id`)
      .all(pattern, pattern) as { knowledge_id: number; id: number }[]).map((r) => `K${r.knowledge_id}@${r.id}`);
    return scope === "all" ? [...facts, ...knowledge, ...raw()] : [...facts, ...knowledge];
  }

  // -- path-aware fact progress --
  /** Facts on the branch's path: every fact whose turn lies on the ancestor chain of the head (given, or the branch's latest known turn), manual facts included. */
  listBranchFacts(sessionId: number, branch: string, headTurnId?: number | null, snapshot?: PathSnapshot): Fact[] {
    const root = headTurnId ?? this.knowledgePath(sessionId, branch).headTurnId;
    if (!root) return [];
    const candidates = this.db.prepare(`WITH RECURSIVE lineage(id, parent_turn_id) AS (
      SELECT t.id, t.parent_turn_id FROM turns t WHERE t.id = ? AND t.session_id = ?
      UNION
      SELECT t.id, t.parent_turn_id FROM turns t JOIN lineage l ON t.id = l.parent_turn_id
      WHERE t.session_id = ?
    ) SELECT f.* FROM facts f WHERE f.turn_id IN (SELECT id FROM lineage) ORDER BY f.id`)
      .all(root, sessionId, sessionId).map(toFact);
    if (!candidates.length) return [];
    const path = { sessionId, headTurnId: root, branch };
    const view = snapshot ?? this.pathSnapshot(path); // one path membership for the whole list, not one per fact
    return candidates.filter(fact => this.factOnPath(fact, path, view)); // every source on the path, not only the first
  }

  /** Which of these branch facts Consolidation still owes work for: exact path-aware membership, one
   * fact at a time, never "every fact minus the cited ones" (22b, restated by 24a for the footer).
   * The one definition both the batch and the footer's second count are built from. */
  unconsolidated(facts: Fact[], path: KnowledgePath, snapshot = this.pathSnapshot(path)): Fact[] {
    return facts.filter(f => !this.consolidatedOnPath(f.id, path, snapshot));
  }

  /** Committed facts are immediately eligible; progress is path-aware exact membership. */
  consolidationBatch(sessionId: number, branch: string, headTurnId?: number): Fact[] {
    const path = this.knowledgePath(sessionId, branch, headTurnId);
    // A head that names no Turn of this session has no facts, the answer the lineage query below gives.
    if (this.getTurn(path.headTurnId ?? 0)?.sessionId !== sessionId) return [];
    const snapshot = this.pathSnapshot(path);
    return this.unconsolidated(this.listBranchFacts(sessionId, branch, path.headTurnId, snapshot), path, snapshot);
  }

  markConsolidated(factId: number, runId: number, projectId: number): void {
    const fact = this.getFact(factId);
    if (!fact || this.getSession(this.getTurn(fact.turnId)!.sessionId)!.projectId !== projectId) throw new Error(`F${factId} is not a fact of this run's project`);
    this.db.prepare("INSERT INTO consolidated_facts (fact_id, run_id) VALUES (?, ?)").run(factId, runId);
  }
  /** A fact is consolidated on a path when one of the runs that took it took only facts on that path (the same rule a fork applies when it inherits progress). */
  consolidatedOnPath(factId: number, path: KnowledgePath, snapshot = this.pathSnapshot(path)): boolean {
    const runs = snapshot.consolidatedRuns;
    return (this.db.prepare("SELECT run_id FROM consolidated_facts WHERE fact_id = ?").all(factId) as { run_id: number }[]).some(({ run_id }) => {
      if (!runs.has(run_id)) runs.set(run_id, this.listConsolidatedFacts(run_id).every((f) => this.factOnPath(f, path, snapshot)));
      return runs.get(run_id)!;
    });
  }
  listConsolidatedFacts(runId: number): Fact[] {
    return this.db.prepare("SELECT f.* FROM facts f JOIN consolidated_facts i ON i.fact_id = f.id WHERE i.run_id = ? ORDER BY f.id").all(runId).map(toFact);
  }
  listConsolidatedProjectFacts(projectId: number): Fact[] {
    return this.db.prepare(`SELECT DISTINCT f.* FROM facts f JOIN consolidated_facts i ON i.fact_id = f.id
      JOIN turns t ON t.id = f.turn_id JOIN sessions s ON s.id = t.session_id WHERE s.project_id = ? ORDER BY f.source_time DESC, f.id DESC`).all(projectId).map(toFact);
  }

  appendSourceEntry(input: SourceInput): SourceEntry {
    return this.transaction(() => {
      this.requireEnabled(input.sessionId);
      if (typeof input.nativeLineage !== "string" || typeof input.nativeId !== "string" || typeof input.text !== "string" || typeof input.raw !== "string" ||
          !Array.isArray(input.calls) || input.calls.some(c => !Number.isSafeInteger(c.ordinal) || c.ordinal < 1 || typeof c.name !== "string" || !c.name || typeof c.callId !== "string" || !c.callId || /[\uD800-\uDFFF]/u.test(c.callId) || typeof c.status !== "string" || !c.status ||
            (c.input !== undefined && typeof c.input !== "string") || (c.result !== undefined && typeof c.result !== "string")) ||
          new Set(input.calls.map(c => c.callId)).size !== input.calls.length || new Set(input.calls.map(c => c.ordinal)).size !== input.calls.length || (input.role === "user" && input.calls.length) || (input.role === "toolResult" && input.text)) throw new Error("invalid source entry content");
      if (!input.nativeLineage || !input.nativeId || !["user", "assistant", "toolResult"].includes(input.role) ||
          this.getTurn(input.turnId)?.sessionId !== input.sessionId || this.getTurn(input.turnId)?.kind !== "turn") throw new Error("invalid source entry identity or owning turn");
      const known = this.findSourceEntry(input.sessionId, input.nativeLineage, input.nativeId);
      if (known) {
        const { id: _, entryOrdinal: _ordinal, blocks: _blocks, ...original } = known;
        if (JSON.stringify(original) !== JSON.stringify(input)) throw new Error("native source entry changed after persistence");
        return known;
      }
      const blocks = this.normalizeSource?.(input);
      if (!input.text && !input.calls.length && input.role !== "user" && !blocks?.length) throw new Error("empty source entry"); // an image-only user message still bounds a Turn
      const ordinal = Number(this.db.prepare("SELECT COALESCE(MAX(entry_ordinal), 0) + 1 AS n FROM source_entries WHERE turn_id = ?").get(input.turnId)!.n);
      if (!Number.isSafeInteger(ordinal)) throw new Error("Turn entry ordinal exhausted");
      const result = this.db.prepare("INSERT INTO source_entries (session_id, native_lineage, native_id, turn_id, content, entry_ordinal, addresses, blocks) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(input.sessionId, input.nativeLineage, input.nativeId, input.turnId, JSON.stringify(input), ordinal,
          JSON.stringify(sourceAddresses({ ...input, id: 0, entryOrdinal: ordinal, blocks })), blocks ? JSON.stringify(blocks) : this.normalizeSource ? "null" : null);
      return this.getSourceEntry(Number(result.lastInsertRowid))!;
    });
  }
  getSourceEntry(id: number): SourceEntry | null {
    const row = this.db.prepare("SELECT id, content, entry_ordinal, blocks FROM source_entries WHERE id = ?").get(id) as { id: number; content: string; entry_ordinal: number; blocks: string | null } | undefined;
    if (!row) return null;
    const blocks = row.blocks === null ? undefined : JSON.parse(row.blocks) ?? undefined;
    return { ...JSON.parse(row.content), id: row.id, entryOrdinal: row.entry_ordinal, ...(blocks ? { blocks } : {}) };
  }
  findSourceEntry(sessionId: number, nativeLineage: string, nativeId: string): SourceEntry | null {
    const row = this.db.prepare("SELECT id FROM source_entries WHERE session_id = ? AND native_lineage = ? AND native_id = ?").get(sessionId, nativeLineage, nativeId) as { id: number } | undefined;
    return row ? this.getSourceEntry(row.id) : null;
  }
  /** 22c: `turnId` narrows the read to one Turn's native occurrences, so a full trace of one tool
   * call loads that Turn instead of the whole session. The order — by entry id — is the same.
   * 23b: `branch` answers from that branch's selected native ancestry instead, in the branch's own
   * order, so an occurrence only a sibling branch selected is not part of this branch's trace. A
   * stored path restricts membership even when its selection is empty. Only an unbound read or
   * legacy data without a stored path falls back to session occurrences. Neither form loads Raw
   * payloads to decide membership. */
  listSourceEntries(sessionId: number, turnId?: number, branch?: string): SourceEntry[] {
    const selected = branch === undefined ? [] : this.db.prepare(
      `SELECT e.id FROM source_paths p JOIN json_each(p.entry_ids) j JOIN source_entries e ON e.id = j.value
       WHERE p.session_id = ? AND p.branch = ? AND e.session_id = ? AND (? IS NULL OR e.turn_id = ?) ORDER BY j.key`)
      .all(sessionId, branch, sessionId, turnId ?? null, turnId ?? null) as { id: number }[];
    const hasPath = branch !== undefined && !!this.db.prepare("SELECT 1 FROM source_paths WHERE session_id = ? AND branch = ?").get(sessionId, branch);
    const rows = hasPath ? selected
      : this.db.prepare("SELECT id FROM source_entries WHERE session_id = ? AND (? IS NULL OR turn_id = ?) ORDER BY id")
        .all(sessionId, turnId ?? null, turnId ?? null) as { id: number }[];
    return rows.map(r => this.getSourceEntry(r.id)!);
  }
  /** 22c "complete snapshot": the source-entry identities of many Turns in one read, in the order an
   * unbound `listSourceEntries` returns them. Identities only — no Raw is loaded to freeze which
   * occurrences a read saw, so the cost follows the hit count, not the conversation's volume. */
  listSourceEntryIdsOf(turnIds: number[]): Map<number, number[]> {
    const entries = new Map<number, number[]>([...new Set(turnIds)].map(id => [id, []]));
    if (!entries.size) return entries;
    for (const row of this.db.prepare("SELECT id, turn_id FROM source_entries WHERE turn_id IN (SELECT value FROM json_each(?)) ORDER BY id")
      .all(JSON.stringify([...entries.keys()])) as { id: number; turn_id: number }[]) entries.get(row.turn_id)!.push(row.id);
    return entries;
  }
  selectSourcePath(sessionId: number, branch: string, entryIds: number[]): void {
    return this.transaction(() => {
      this.requireEnabled(sessionId);
      // 22b: ownership is an identity question, so it is counted in one query instead of loading every
      // selected entry's Raw payload; duplicates are already rejected, so equal counts mean all owned.
      const owned = (this.db.prepare("SELECT COUNT(*) n FROM source_entries WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))")
        .get(sessionId, JSON.stringify(entryIds)) as { n: number }).n;
      if (!branch || new Set(entryIds).size !== entryIds.length || owned !== entryIds.length) throw new Error("invalid source path");
      this.db.prepare("INSERT INTO source_paths (session_id, branch, entry_ids) VALUES (?, ?, ?) ON CONFLICT (session_id, branch) DO UPDATE SET entry_ids = excluded.entry_ids")
        .run(sessionId, branch, JSON.stringify(entryIds));
    });
  }
  /** The selected path's entry ids, in the branch's own order, decided by `turn_id` alone: no Raw
   * payload is loaded to answer membership (22b). `json_each`'s key is the position in the stored
   * array, so the branch order survives the join. */
  private pathEntryIds(sessionId: number, branch: string, headTurnId: number, prepared?: PathSnapshot): number[] {
    const turns = prepared?.turns ?? this.pathTurns({ sessionId, headTurnId });
    const row = this.db.prepare("SELECT entry_ids FROM source_paths WHERE session_id = ? AND branch = ?").get(sessionId, branch) as { entry_ids: string } | undefined;
    const rows = (row ? this.db.prepare("SELECT e.id, e.turn_id FROM json_each(?) j JOIN source_entries e ON e.id = j.value ORDER BY j.key").all(row.entry_ids)
      : this.db.prepare("SELECT id, turn_id FROM source_entries WHERE session_id = ? ORDER BY id").all(sessionId)) as { id: number; turn_id: number }[];
    return rows.filter(r => turns.has(r.turn_id)).map(r => r.id);
  }
  sourceHeadEntryId(sessionId: number, branch: string, headTurnId: number, prepared?: PathSnapshot): number | undefined {
    return this.pathEntryIds(sessionId, branch, headTurnId, prepared).at(-1);
  }
  sourcePath(sessionId: number, branch: string, headTurnId: number): SourceEntry[] {
    return this.pathEntryIds(sessionId, branch, headTurnId).map(id => this.getSourceEntry(id)!);
  }
  entryNoted(id: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM noted_entries WHERE entry_id = ? LIMIT 1").get(id);
  }
  /** 22b: `noted_entries` decides which of the path's ids are still pending before any content is
   * loaded, so a caller that needs only the first views does not pay for the whole path. */
  pendingEntryIds(sessionId: number, branch: string, headTurnId: number, prepared?: PathSnapshot): number[] {
    const ids = this.pathEntryIds(sessionId, branch, headTurnId, prepared);
    const noted = new Set((this.db.prepare("SELECT entry_id FROM noted_entries WHERE entry_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(ids)) as { entry_id: number }[]).map(r => r.entry_id));
    return ids.filter(id => !noted.has(id));
  }
  pendingEntries(sessionId: number, branch: string, headTurnId: number): SourceEntry[] {
    return this.pendingEntryIds(sessionId, branch, headTurnId).map(id => this.getSourceEntry(id)!);
  }
}
