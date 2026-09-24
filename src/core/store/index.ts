// core/store — node:sqlite behind one plain interface. No abstraction over SQLite;
// this is the only place that knows a database exists. Schema: .scratch/v1/spec.md (Schema).
// Global ids: turns, facts, and knowledge use SQLite's per-table AUTOINCREMENT, which never
// reuses an id and is not reset per session or project — that is the "global id" the spec asks for.

import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrateDreaming, migrateDreamingRanges64d, migrateKnowledgeLineage, migrateKnowledgeSubtraction, type Migration64dReport } from "./migration.ts";
import { SourceNormalizationError, sourceAddresses, sourceKey, type SourceBlock, type SourceNormalizer } from "../model/source.ts";
export { sourceAddresses } from "../model/source.ts";
import { EXECUTIONS_SQL, beginExecution, linkExecutionRun, settleExecution, type LogicalTask, type ExecutionOutcome } from "./executions.ts";
import { PROCESSING_SQL, DEFAULT_KNOWLEDGE_BUDGETS, DEFAULT_DREAMING_TRIGGER_TOKENS, deriveKnowledgeBudgets, processedBlock, placementOwner, type DreamingRange, type KnowledgeBudgetField, type KnowledgeBudgets, type PendingKnowledgeVersion, type KnowledgePoolSize, type DueKnowledgePool } from "./processing.ts";
import { factAddresses, renderKnowledge, renderKnowledgeChange, tokens } from "../render/index.ts";
import { KNOWLEDGE_CATEGORIES } from "../model/index.ts";
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
  fork_suppressed_run INTEGER,
  -- 62: the real repository root (or cwd) the session started in; the key later sessions join by.
  -- NULL for sessions allocated before the column existed or in an excluded directory (home, temp).
  directory TEXT
);

CREATE TABLE IF NOT EXISTS session_lineage_cursors (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  lineage TEXT NOT NULL,
  branch TEXT NOT NULL,
  head_turn_id INTEGER NOT NULL REFERENCES turns(id),
  -- Ticket 72: bumped only when this cursor's write is NOT a plain forward walk (a branch switch, or a
  -- head at or below hwm_head_turn_id) — never on an ordinary forward head move, so ingesting Raw
  -- never touches it. progressSignal reads MAX(version) through the index below.
  version INTEGER NOT NULL DEFAULT 0,
  -- Ticket 72: the largest head_turn_id this cursor has ever held, updated to MAX(itself, new head) on
  -- every write regardless of branch. Turn ids are AUTOINCREMENT and assigned in creation order, so a
  -- genuinely new Turn -- on any branch this lineage later switches to -- always exceeds it; only a
  -- revisit of an already-superseded Turn (a move back, or a branch switch landing on one) can be <=
  -- it. Exact where a "once rewritten, bump forever" flag would only approximate: a branch switch and
  -- later return, or repeated back-and-forth, never falsely keeps bumping on later genuine progress.
  hwm_head_turn_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, lineage)
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

-- Ticket 81: Raw search's candidate index. Contentless (content='') so the trigram index is the
-- only copy of the indexed text -- turns.user_prompt/assistant_text and tool_calls.name/input/result
-- (up to ~200 MB) are never duplicated into an FTS5 content shadow table the way a plain (non-
-- contentless) FTS5 table would. contentless_delete=1 is required: a plain contentless table refuses
-- DELETE and UPDATE outright (verified on this SQLite), and the index must track a Turn's growing
-- reply and a tool call's later result. Rows carry no metadata of their own (contentless columns other
-- than rowid cannot be read back, verified on this SQLite) -- raw_search_entries below is the sole
-- record of which session/turn/tool-call/field a given rowid belongs to.
CREATE VIRTUAL TABLE IF NOT EXISTS raw_fts USING fts5(
  text,
  content = '',
  contentless_delete = 1,
  tokenize = 'trigram'
);
-- One row per indexed field, one field per (Turn prompt, Turn reply, tool-call name, input, result) --
-- never combined, so reindexing a growing reply or a completed result touches only its own row, and a
-- query that only matches across two fields (e.g. the end of a prompt and the start of a reply) is
-- never even a candidate. id is shared 1:1 with raw_fts's rowid, assigned by inserting the metadata
-- row first and using its id as raw_fts's explicit rowid. tool_call_id is NULL for the two Turn-level
-- fields and set for the three tool-call-level fields.
CREATE TABLE IF NOT EXISTS raw_search_entries (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  tool_call_id INTEGER REFERENCES tool_calls(id),
  field TEXT NOT NULL CHECK (field IN ('user_prompt','assistant_text','tool_name','tool_input','tool_result'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_search_turn_field ON raw_search_entries(turn_id, field) WHERE tool_call_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_search_tool_call_field ON raw_search_entries(tool_call_id, field) WHERE tool_call_id IS NOT NULL;

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
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  branch TEXT NOT NULL,
  length INTEGER NOT NULL DEFAULT 0 CHECK (length >= 0),
  tail_entry_id INTEGER REFERENCES source_entries(id),
  -- Ticket 72: bumped only when a write replaces membership with something other than an extension of
  -- the prior list, or appends an id at or below hwm_entry_id (the writer alone knows this; see
  -- publishSourcePath/selectSourcePath) — an already-stored entry leaving or rejoining the selected
  -- path under an unchanged cursor. A pure append of genuinely new entries leaves it untouched, so
  -- ingesting Raw never bumps it.
  version INTEGER NOT NULL DEFAULT 0,
  -- Ticket 72: the largest source_entries.id this row has ever held, updated to MAX(itself, new max)
  -- on every write. Entry ids are AUTOINCREMENT and assigned in creation order, so a genuinely new
  -- entry always exceeds it; only a restored, previously-removed entry can be <= it. Exact where a
  -- "once rewritten, bump forever" flag would only approximate: pure appends after a removal-and-
  -- restore never falsely keep bumping.
  hwm_entry_id INTEGER NOT NULL DEFAULT 0,
  CHECK ((length = 0) = (tail_entry_id IS NULL)),
  UNIQUE (session_id, branch)
);
CREATE TABLE IF NOT EXISTS source_path_entries (
  path_id INTEGER NOT NULL REFERENCES source_paths(id) ON DELETE CASCADE,
  position INTEGER NOT NULL CHECK (position >= 0),
  entry_id INTEGER NOT NULL REFERENCES source_entries(id),
  PRIMARY KEY (path_id, position),
  UNIQUE (path_id, entry_id)
) WITHOUT ROWID;
-- 74: a compact mirror of each source entry's calls (native call id, ordinal, name only -- never
-- input/result, which stay in content/tool_calls and would move the wide data here). Lets a
-- rebuild answer call identity, per entry or per Turn, without loading Raw.
CREATE TABLE IF NOT EXISTS source_entry_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES source_entries(id),
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  call_id TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_entry_calls_entry ON source_entry_calls(entry_id);
CREATE INDEX IF NOT EXISTS idx_source_entry_calls_turn ON source_entry_calls(turn_id, id);
-- Native checkpoints that own a Turn but are not Raw source entries (notably compaction boundaries),
-- plus the user source that created each ordinary Turn. Host-native identity keeps import idempotent;
-- no host envelope or selected-path policy enters this table.
CREATE TABLE IF NOT EXISTS native_turns (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  native_lineage TEXT NOT NULL,
  native_id TEXT NOT NULL,
  turn_id INTEGER NOT NULL UNIQUE REFERENCES turns(id),
  kind TEXT NOT NULL CHECK (kind IN ('turn','compaction')),
  PRIMARY KEY (session_id, native_lineage, native_id)
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

// Ticket 81: the five raw_search_entries.field values, one per indexed Turn/tool-call column.
type RawFtsField = "user_prompt" | "assistant_text" | "tool_name" | "tool_input" | "tool_result";

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
  directory?: string | null; // 62: the resolved repository root or cwd; absent or null when excluded
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
/** 79 "Metadata lists": every hot column of a source entry, never `content`/`blocks` (the payload
 * table, item 0). What `sourcePath`, `pendingEntries` and `listSourceEntries` return — id, session,
 * Turn, native lineage, native id, entry ordinal, addresses and digest. A consumer that needs a body
 * hydrates the exact ids it chose through `Store.hydrateSourceEntries`, never a loop of single reads
 * over the whole list. */
export interface SourceEntryMeta {
  id: number; sessionId: number; nativeLineage: string; nativeId: string;
  turnId: number; entryOrdinal: number; addresses: string[]; digest: string;
}
/** 74: the one digest algorithm, used by the write path, the backfill and every host's rebuild
 * comparison, so digest equality means exactly what `raw === raw` string equality meant, up to
 * collision. Covers exactly `SourceInput.raw` — the same string each host already compares today
 * (Pi: `JSON.stringify(message)`; CC: the transcript's original line) — never a re-serialization. */
export const sourceDigest = (raw: string): string => createHash("sha256").update(raw).digest("hex");

/** Ticket 81: length in Unicode characters (code points), as FTS5's trigram tokenizer counts them --
 * never UTF-16 units (`.length`) or bytes. `Array.from` splits on code points, so an astral character
 * (outside the BMP, encoded as a UTF-16 surrogate pair) counts once, not twice. Below three, no
 * trigram exists to index or query, so `searchAddresses` keeps today's LIKE scan for these. */
export const unicodeLength = (value: string): number => Array.from(value).length;

/** Ticket 81: the query as one quoted FTS5 phrase, so `MATCH` requires its trigrams contiguously
 * (substring semantics) rather than interpreting `"`, `*`, `:`, `(`, `NEAR`, `AND`, etc. as FTS5
 * query syntax. The only character that needs escaping inside a quoted phrase is `"` itself,
 * doubled per FTS5's own quoting rule. */
const ftsPhraseQuery = (query: string): string => `"${query.replaceAll('"', '""')}"`;

/** 77: 71's one-parse extraction, unchanged — a single multi-path `json_extract` reads the four usage
 * counters, the cost total and `$.usage` itself (to tell "recorded" from "missing or explicit null")
 * in one pass over the response text. `expr` is bound at write time (the exact string about to be
 * stored) and is the `response` column itself at backfill time (once per existing row). */
const usageFieldsSql = (expr: string) => `CASE WHEN json_valid(${expr}) THEN json_extract(${expr},
      '$.usage.input', '$.usage.output', '$.usage.cacheRead', '$.usage.cacheWrite', '$.usage.cost.total', '$.usage') END`;

type UsageColumns = [input: number | null, output: number | null, cacheRead: number | null, cacheWrite: number | null, cost: number | null];

/** 77: turns 71's six-value extraction into the five stored columns, matching `listRunUsage`'s old
 * derivation exactly. `null` in every field is "no observation" — an unparsable response (`fields`
 * itself null) or a missing/explicit-null `usage` — kept apart from an observed zero, which every
 * other case (including a non-object `usage`) returns as a real 0. */
function usageFromFields(fields: string | null): UsageColumns {
  if (fields === null) return [null, null, null, null, null];
  const [input, output, cacheRead, cacheWrite, costTotal, usage] = JSON.parse(fields) as unknown[];
  if (usage === null) return [null, null, null, null, null];
  // A per-field SQL extraction returns JSON true/false as the integers 1/0; keep them boolean-derived
  // here too, so historical totals do not drift.
  const count = (value: unknown) => (typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : 0);
  return [count(input), count(output), count(cacheRead), count(cacheWrite), count(costTotal)];
}

export type Phase = "noting" | "consolidation" | "dreaming";
/** Host-selected path plus the facade's exact trigger computations. Store invokes the callback
 * under the declaration transaction; it is deliberately not taskEligibility, enrollment or stop state. */
export interface ProjectDeclarationContext {
  path: KnowledgePath;
  atTrigger: (phase: Phase) => boolean;
}
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
      text?: string;
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
 * read that built it: every revision in id order, global direct-fact applicability and selection,
 * the current revisions visible to this reader, and historical ancestry. */
export interface CommitGraph {
  revisions: KnowledgeRevision[];
  /** Revisions admitted by the shared no-fork validity projection before reader visibility. */
  effective: Set<number>;
  /** Reader-independent direct-fact applicability. */
  applicable: Set<number>;
  /** One reader-independent current revision per surviving identity, archives included. */
  resolved: KnowledgeRevision[];
  /** The subset of `resolved` whose selected revision is visible to this reader. */
  current: KnowledgeRevision[];
  ancestors: (commitId: number) => Set<number>;
  descendants: (commitId: number) => Set<number>;
}

/** Metadata for one synchronous projection. Rebuild after assignment changes; never cache across reads. */
type PersistedKnowledgePath = KnowledgePath & { lineage: string };
type PersistedKnowledgePaths = PersistedKnowledgePath[] | null | "invalid";

export interface ApplicabilityInput {
  revisions?: Map<number, KnowledgeRevision>;
  parents?: Map<number, number[]>;
  runs: Map<number, number>;
  projects: Map<number, number>;
  currentPaths?: Map<number, PersistedKnowledgePaths>;
  currentSnapshots?: Map<string, PathSnapshot>;
  validatedCurrentPaths?: Set<string>;
  facts: Map<number, { fact: Fact; sessionId: number; runId: number; entries: number[] }>;
}

/** The exact shape `commitGraphInput` returns, named so the ticket 80 graph memo (`Store.graphInputCache`)
 * does not force a self-referential `ReturnType<typeof commitGraphInput>` while that method is defined. */
export interface GraphInput {
  revisions: KnowledgeRevision[];
  parents: Map<number, number[]>;
  metadata: ApplicabilityInput;
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

export type CommitConsolidationResult =
  | { ok: true; runId: number; committed: CommittedKnowledgeOp[] }
  | { ok: false; runId: number; problems: string[] };


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
    directory: row.directory ?? null,
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

// 83: `entry_ordinal` is `NOT NULL` from the upgrade transaction's backfill onward (a pre-83
// database's stray NULLs — a stale writer's omission, never a migration gap — are numbered then),
// so a plain `Number()` is correct here and no longer needs a null passthrough for output identity.
/** 79: the hot columns alone, shared by every metadata list read. */
function toSourceEntryMeta(row: any): SourceEntryMeta {
  return { id: Number(row.id), sessionId: Number(row.session_id), nativeLineage: row.native_lineage, nativeId: row.native_id,
    turnId: Number(row.turn_id), entryOrdinal: Number(row.entry_ordinal), addresses: JSON.parse(row.addresses), digest: row.digest };
}
/** 79: the hot row joined to its Raw payload row, the one shape every full-entry reader builds. */
function toSourceEntry(row: any): SourceEntry {
  const blocks = row.blocks === null ? undefined : JSON.parse(row.blocks) ?? undefined;
  return { ...JSON.parse(row.content), id: Number(row.id), entryOrdinal: Number(row.entry_ordinal), ...(blocks ? { blocks } : {}) };
}
const SOURCE_ENTRY_META_COLUMNS = "id, session_id, native_lineage, native_id, turn_id, entry_ordinal, addresses, digest";

// ---- Store ----

export class StaleSourcePathError extends Error {
  constructor() { super("source path changed since the expected prefix"); this.name = "StaleSourcePathError"; }
}

export interface SourcePathState { count: number; tailId: number | null; version: number }

/** A pending queue with stable identity across appends and local prefix consumption. Positions are
 * monotonic, so removing a batch neither shifts nor copies the retained backlog. Store owns writes. */
export class PendingEntries implements Iterable<number> {
  private readonly entries = new Map<number, number>();
  private first = 0;
  private end = 0;
  constructor(ids: Iterable<number>) { for (const id of ids) this.append(id); }
  get offset(): number { return this.first; }
  get length(): number { return this.end - this.first; }
  at(index: number): number | undefined { return this.entries.get(this.first + index); }
  append(id: number): void { this.entries.set(this.end++, id); }
  removePrefix(count: number): void {
    for (let i = 0; i < count; i++) this.entries.delete(this.first++);
  }
  [Symbol.iterator](): IterableIterator<number> { return this.entries.values(); }
}

export class Store {
  readonly db: DatabaseSync;
  readonly migration64d: Migration64dReport;
  closed = false;
  private readonly dreamingAuthorities = new WeakMap<object, { rangeId: number; sessionId: number; token: string; executionId: string; runId: number }>();
  private readonly originAuthorities = new WeakMap<object, TriggerOrigin | null>();
  /** 70: memoizes `enabled()` for the lifetime of the current top-level transaction only. Every write
   * inside one transaction sees the same snapshot regardless of how many times it re-checks
   * enrollment (43a's per-record transactions each call it several times, once per write method);
   * `setEnrollment` invalidates its own session id so a write that flips enrollment mid-transaction
   * is still observed by a later check in the same transaction. Unset outside any transaction. */
  private enrolledCache: Map<number, boolean> | null = null;

  /** Capture once at admission. The ordered ids end at the exact native entry represented by this target. */
  triggerOrigin(path: KnowledgePath, triggerEntryId?: number): TriggerOrigin | null {
    if (!path.branch || path.headTurnId == null) return null;
    const ids = this.selectedSourceEntryIds(path.sessionId, path.branch);
    if (ids === null) return null;
    const explicit = triggerEntryId === undefined ? undefined : ids.indexOf(triggerEntryId);
    if (explicit !== undefined && explicit < 0) throw new Error("trigger origin does not contain the exact triggering entry");
    const captured = explicit === undefined ? ids : ids.slice(0, explicit + 1);
    if (captured.some(id => !Number.isInteger(id) || Number(id) <= 0) || new Set(captured).size !== captured.length)
      throw new Error("trigger origin path is malformed");
    if (!captured.length) return null;
    // Whole-path metadata from the covering index (71): a foreign or missing id is simply absent.
    const rows = this.db.prepare(`SELECT id, session_id, turn_id FROM source_entries
      WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .all(path.sessionId, JSON.stringify(captured)) as { id: number; session_id: number; turn_id: number }[];
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

  /** Called only by admitted host execution, not by a model-facing tool. One authority family
   * covers both the current pool range and the legacy range while callers are migrated. */
  bindDreamingRun(run: RunInput): RunInput {
    this.requireClaim(run);
    const range = run.dreamingRangeId === undefined ? null : this.dreamingRange(run.dreamingRangeId);
    if (run.kind !== "dreaming" || !run.claim || !run.executionId || !range || range.sessionId !== run.sessionId ||
        range.branch !== run.branch || (range.pool !== null && range.claimToken !== run.claim.token))
      throw new Error("Dreamer binding requires its admitted claim, execution and frozen range");
    const authority = {};
    const runId = this.transaction(() => this.insertRun({ ...run, outcome: "failure",
      response: JSON.stringify({ status: "admitted; maintenance not yet completed" }) }));
    this.dreamingAuthorities.set(authority, { rangeId: range.id, sessionId: range.sessionId, token: run.claim.token,
      executionId: run.executionId, runId });
    return { ...run, dreamingAuthority: authority };
  }

  private dreamingAuthority(run: RunInput) {
    return run.dreamingAuthority && this.dreamingAuthorities.get(run.dreamingAuthority);
  }

  isDreamingRun(run: RunInput): boolean {
    const authority = this.dreamingAuthority(run);
    return !!authority && run.kind === "dreaming" && authority.rangeId === run.dreamingRangeId && authority.sessionId === run.sessionId
      && authority.token === run.claim?.token && authority.executionId === run.executionId;
  }

  dreamingRunId(run: RunInput): number | undefined {
    return this.isDreamingRun(run) ? this.dreamingAuthority(run)?.runId : undefined;
  }

  validateDreamingRun(run: RunInput, path: KnowledgePath): DreamingRange {
    if (!this.isDreamingRun(run)) throw new Error("trusted Dreamer run binding required");
    this.requireEnabled(run.sessionId!);
    this.requireClaim(run);
    const range = this.dreamingRange(run.dreamingRangeId!);
    if (!range || path.sessionId !== range.sessionId || path.branch !== range.branch || path.headTurnId !== range.headTurnId)
      throw new Error("Dreamer target differs from its retained path");
    return range;
  }

  private readonly normalizeSource: SourceNormalizer | undefined;
  constructor(path: string, normalizeSource?: SourceNormalizer) {
    this.normalizeSource = normalizeSource;
    this.db = new DatabaseSync(path);
    let began = false;
    let priorBudgetPolicy: { global: number; project: number; session: number } | null = null;
    try {
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.db.exec("PRAGMA busy_timeout = 5000;");
      // Configure file databases before any transaction; SQLite memory databases cannot use WAL.
      // The live shared file is converted during the stopped-executor deployment, before workers
      // load this code. That cutover procedure does not disable WAL initialization for new files.
      if (path !== ":memory:") {
        let mode: unknown;
        try { mode = this.db.prepare("PRAGMA journal_mode = WAL").get()!.journal_mode; }
        catch (error) {
          throw new Error(`Store WAL initialization failed before the schema transaction: ${error instanceof Error ? error.message : String(error)}. ` +
            "For a shared-database upgrade, verify that all executors were stopped and the backup/manual WAL conversion completed before restart.", { cause: error });
        }
        if (mode !== "wal") throw new Error(`Store requires WAL journal mode; SQLite returned ${String(mode)}`);
      }
      // One immediate transaction owns schema probes, upgrades and policy publication. Legacy
      // CHECK rebuilds require foreign keys off before BEGIN. A changed schema is checked once
      // before commit; an unchanged open must not scan the entire database under its write lock.
      this.db.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE");
      began = true;
      const schemaBefore = Number(this.db.prepare("PRAGMA schema_version").get()!.schema_version);
      const policyTable = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='knowledge_budget_policy'").get();
      // 74: captured before SCHEMA_SQL creates the table below, so its absence here means a fresh
      // deploy of this table that still needs every pre-existing entry's calls mirrored into it.
      const hadSourceEntryCalls = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_entry_calls'").get();
      // Ticket 81: captured before SCHEMA_SQL creates raw_fts below, so its absence here means a fresh
      // deploy of the index that still needs every pre-existing Turn and tool call's text indexed.
      const hadRawFts = !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='raw_fts'").get();
      const oldPathShape = this.db.prepare("PRAGMA table_info(source_paths)").all().some(row => row.name === "entry_ids");
      if (policyTable) {
        const row = this.db.prepare("SELECT global_tokens,project_tokens,session_tokens FROM knowledge_budget_policy WHERE id=1").get();
        if (row) priorBudgetPolicy = { global: Number(row.global_tokens), project: Number(row.project_tokens), session: Number(row.session_tokens) };
      }
      this.db.exec(SCHEMA_SQL);
      migrateDreaming(this.db, true);
      this.transaction(() => {
        // 62: existing sessions keep NULL; they are never re-attributed to a directory.
        const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all();
        if (!sessionColumns.some(r => r.name === "directory")) this.db.exec("ALTER TABLE sessions ADD COLUMN directory TEXT");
        // 64b: lineage cursors replace the never-deployed session-wide foreground columns.
        if (sessionColumns.some(r => r.name === "current_branch")) this.db.exec("ALTER TABLE sessions DROP COLUMN current_branch");
        if (sessionColumns.some(r => r.name === "current_head")) this.db.exec("ALTER TABLE sessions DROP COLUMN current_head");
        // Allocate once in original insertion order, across every branch of each Turn. Raw and
        // historic citation strings remain untouched. Recheck under the immediate write lock.
        if (!this.db.prepare("PRAGMA table_info(source_entries)").all().some(r => r.name === "entry_ordinal")) {
          this.db.exec(`ALTER TABLE source_entries ADD COLUMN entry_ordinal INTEGER CHECK(entry_ordinal > 0);
            WITH numbered AS (SELECT id, row_number() OVER (PARTITION BY turn_id ORDER BY id) AS ordinal FROM source_entries)
            UPDATE source_entries SET entry_ordinal = (SELECT ordinal FROM numbered WHERE numbered.id = source_entries.id);`);
        }
        this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_source_turn_ordinal ON source_entries(turn_id, entry_ordinal)");
        // Ticket 72: an existing database predates the change-detection version/high-water-mark columns.
        if (!this.db.prepare("PRAGMA table_info(session_lineage_cursors)").all().some(r => r.name === "version"))
          this.db.exec("ALTER TABLE session_lineage_cursors ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_session_lineage_cursors_version ON session_lineage_cursors(version)");
        if (!this.db.prepare("PRAGMA table_info(session_lineage_cursors)").all().some(r => r.name === "hwm_head_turn_id")) {
          this.db.exec("ALTER TABLE session_lineage_cursors ADD COLUMN hwm_head_turn_id INTEGER NOT NULL DEFAULT 0");
          // Backfill from the only known value at migration time: the row's own current head. Earlier
          // history is not recoverable, but this is a safe floor — the row cannot have held anything
          // higher without that write having already set its own head_turn_id at least that high.
          this.db.exec("UPDATE session_lineage_cursors SET hwm_head_turn_id = head_turn_id");
        }
        if (!this.db.prepare("PRAGMA table_info(source_paths)").all().some(r => r.name === "version"))
          this.db.exec("ALTER TABLE source_paths ADD COLUMN version INTEGER NOT NULL DEFAULT 0");
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_source_paths_version ON source_paths(version)");
        if (!this.db.prepare("PRAGMA table_info(source_paths)").all().some(r => r.name === "hwm_entry_id")) {
          this.db.exec("ALTER TABLE source_paths ADD COLUMN hwm_entry_id INTEGER NOT NULL DEFAULT 0");
          // Backfill from the row's own current contents: the largest entry id it holds right now.
          this.db.exec(oldPathShape
            ? "UPDATE source_paths SET hwm_entry_id = (SELECT IFNULL(MAX(value), 0) FROM json_each(entry_ids))"
            : "UPDATE source_paths SET hwm_entry_id = (SELECT IFNULL(MAX(entry_id), 0) FROM source_path_entries e WHERE e.path_id = source_paths.id)");
        }
        if (oldPathShape) this.migrateSourcePaths();
        // Derived membership metadata keeps path/coverage queries off large immutable Raw bodies.
        // Both migration and new ingestion use the same block interpreter as write validation.
        const columns = this.db.prepare("PRAGMA table_info(source_entries)").all();
        // 79: once the hot/cold split has run (this open or an earlier one), `source_entries` never
        // regains `content`; that absence is this whole block's "already split" signal, since it runs
        // on every open, not only the first. Before the split, `blocks` lives here too and the two
        // now-redundant covering indexes below (item 0) are still built as before, immediately
        // superseded by the split rebuild later in this same transaction; after the split, neither is
        // rebuilt (item 0: dropped), and the decode backfill reads/writes the split shape instead.
        const alreadySplit = !columns.some(r => r.name === "content");
        // 79: 71's idx_source_membership and 74's idx_source_identity existed only to dodge the wide
        // content/blocks columns with INDEXED BY; nothing in this codebase names either index anymore
        // (item 0: dropped), so neither is created here, before or after the split. `blocks` itself is
        // re-added to whichever table currently owns it if a database is (genuinely or, in a test,
        // synthetically) missing it there.
        if (!alreadySplit) {
          if (!columns.some(r => r.name === "blocks")) this.db.exec("ALTER TABLE source_entries ADD COLUMN blocks TEXT");
        } else if (!this.db.prepare("PRAGMA table_info(source_entry_raw)").all().some(r => r.name === "blocks")) {
          this.db.exec("ALTER TABLE source_entry_raw ADD COLUMN blocks TEXT");
        }
        // Reopens inspect only undecoded legacy entries, not every immutable Raw body. This index is
        // maintained by SQLite when the owning host fills blocks; it stores no progress. Rebuilt on
        // every open, like idx_source_turn_ordinal below, on whichever table currently holds `blocks`
        // -- `source_entry_raw` exists by the time this runs on any already-split database (created
        // during that database's own first-ever split).
        this.db.exec(alreadySplit ? "CREATE INDEX IF NOT EXISTS idx_source_unnormalized ON source_entry_raw(entry_id) WHERE blocks IS NULL"
          : "CREATE INDEX IF NOT EXISTS idx_source_unnormalized ON source_entries(id) WHERE blocks IS NULL");
        const newAddresses = !columns.some(r => r.name === "addresses");
        if (newAddresses) this.db.exec("ALTER TABLE source_entries ADD COLUMN addresses TEXT NOT NULL DEFAULT '[]'");
        // 74: a digest of exactly the `raw` string a rebuild compares today (`sourceDigest`, one fixed
        // algorithm for every host and this backfill), so a known entry's identity is answered from
        // metadata alone, never by loading `content`/`blocks`. `json_extract` reads the one field the
        // backfill needs straight out of SQLite, without a JS-side JSON.parse per row. Almost always
        // pre-split (any ordinarily-migrated database already has `digest` by the time it could ever
        // split), but not gated on that: an exotic database missing only `digest` after already
        // splitting still needs `content` from `source_entry_raw` to compute it.
        const newDigest = !columns.some(r => r.name === "digest");
        if (newDigest) {
          this.db.exec("ALTER TABLE source_entries ADD COLUMN digest TEXT");
          const updateDigest = this.db.prepare("UPDATE source_entries SET digest = ? WHERE id = ?");
          const digestSelect = alreadySplit
            ? "SELECT e.id, json_extract(r.content, '$.raw') AS raw FROM source_entries e JOIN source_entry_raw r ON r.entry_id = e.id ORDER BY e.id"
            : "SELECT id, json_extract(content, '$.raw') AS raw FROM source_entries ORDER BY id";
          for (const row of this.db.prepare(digestSelect).iterate())
            updateDigest.run(sourceDigest(String(row.raw)), Number(row.id));
        }
        // 74: `source_entry_calls` is brand new (SCHEMA_SQL above); a database that already had
        // entries needs every one of their `calls` mirrored in, once, from the same field a fresh
        // write derives it from. A pure-SQL INSERT...SELECT never round-trips content through JS.
        // Ordinarily pre-split (an already-split database was never missing this table), but not
        // gated on that, matching the digest backfill above: `content` is joined from
        // `source_entry_raw` when the split has already moved it there.
        if (!hadSourceEntryCalls) this.db.exec(alreadySplit
          ? `INSERT INTO source_entry_calls (entry_id, turn_id, call_id, ordinal, name)
             SELECT e.id, e.turn_id, json_extract(value, '$.callId'), json_extract(value, '$.ordinal'), json_extract(value, '$.name')
             FROM source_entries e JOIN source_entry_raw r ON r.entry_id = e.id, json_each(r.content, '$.calls')`
          : `INSERT INTO source_entry_calls (entry_id, turn_id, call_id, ordinal, name)
             SELECT source_entries.id, turn_id, json_extract(value, '$.callId'), json_extract(value, '$.ordinal'), json_extract(value, '$.name')
             FROM source_entries, json_each(source_entries.content, '$.calls')`);
        // 79: an ongoing mechanism, not a one-time migration step — a host's own source normalizer may
        // still owe `blocks` to an entry another host or an older version wrote (`blocks IS NULL`), on
        // every open, split or not. Pre-split, `content`/`blocks` are read and written on
        // `source_entries` itself; post-split, `content`/`blocks` are read from and `blocks` is
        // written back to `source_entry_raw`, while `addresses` stays on `source_entries`.
        if (newAddresses || normalizeSource) {
          const updateAddresses = this.db.prepare("UPDATE source_entries SET addresses = ? WHERE id = ?");
          const updateBlocks = alreadySplit ? this.db.prepare("UPDATE source_entry_raw SET blocks = ? WHERE entry_id = ?")
            : this.db.prepare("UPDATE source_entries SET blocks = ? WHERE id = ?");
          // Driven from `source_entry_raw` when filtering by `blocks IS NULL`, so the planner uses
          // idx_source_unnormalized (a partial index keyed on that table) instead of scanning the
          // (possibly much larger) `source_entries` and probing `source_entry_raw` by rowid per row.
          const selectSql = !alreadySplit
            ? `SELECT id, content, entry_ordinal, blocks FROM source_entries ${newAddresses ? "" : "WHERE blocks IS NULL"} ORDER BY id`
            : newAddresses
            ? `SELECT e.id, r.content, e.entry_ordinal, r.blocks FROM source_entries e JOIN source_entry_raw r ON r.entry_id = e.id ORDER BY e.id`
            : `SELECT r.entry_id AS id, r.content, e.entry_ordinal, r.blocks FROM source_entry_raw r JOIN source_entries e ON e.id = r.entry_id
               WHERE r.blocks IS NULL ORDER BY r.entry_id`;
          for (const row of this.db.prepare(selectSql).iterate()) {
            const input = JSON.parse(String(row.content));
            let blocks: SourceBlock[] | undefined, sealMismatch = false;
            if (row.blocks == null) {
              try { blocks = normalizeSource?.(input); }
              catch (error) {
                if (!(error instanceof SourceNormalizationError)) throw error;
                sealMismatch = true;
                // Persist JSON null below: retain legacy proof without retrying this row on reopen.
                // Numeric storage identities locate the row without exposing Raw or native IDs.
                console.warn(`Trace Memory: legacy source normalization skipped; entry=${Number(row.id)} turn=${Number(input.turnId)}; call mapping mismatch`);
              }
            } else blocks = JSON.parse(String(row.blocks));
            const entry = { ...input, id: Number(row.id), entryOrdinal: Number(row.entry_ordinal), ...(blocks ? { blocks } : {}) };
            // An absent host decode is not a permanent negative result: another host owns that Raw.
            // Only a recognized mismatch is sealed as JSON null.
            const blocksValue = blocks ? JSON.stringify(blocks) : sealMismatch || row.blocks === "null" ? "null" : null;
            updateAddresses.run(JSON.stringify(sourceAddresses(entry)), entry.id);
            updateBlocks.run(blocksValue, entry.id);
          }
        }
      });
      // 77: usage columns land after `request` and `response` (ALTER TABLE always appends), so an
      // ordinary row read of them would still walk both columns' overflow chains -- the exact cost
      // this ticket removes. Every read of them goes through a covering index instead (below); the
      // index is created only once the columns it references exist (as idx_source_membership and
      // idx_source_identity above).
      this.transaction(() => {
        const runColumns = this.db.prepare("PRAGMA table_info(runs)").all();
        if (!runColumns.some(r => r.name === "usage_cost")) {
          this.db.exec(`ALTER TABLE runs ADD COLUMN usage_input INTEGER;
            ALTER TABLE runs ADD COLUMN usage_output INTEGER;
            ALTER TABLE runs ADD COLUMN usage_cache_read INTEGER;
            ALTER TABLE runs ADD COLUMN usage_cache_write INTEGER;
            ALTER TABLE runs ADD COLUMN usage_cost REAL;`);
          // 71's one-parse query, reused as the backfill: one SELECT walks each row's `response` once
          // and hands back the six extracted values as a small array, never the row's full response text.
          const setUsage = this.db.prepare(`UPDATE runs SET usage_input = ?, usage_output = ?,
            usage_cache_read = ?, usage_cache_write = ?, usage_cost = ? WHERE id = ?`);
          for (const row of this.db.prepare(`SELECT id, ${usageFieldsSql("response")} fields FROM runs ORDER BY id`).iterate() as
            IterableIterator<{ id: number; fields: string | null }>)
            setUsage.run(...usageFromFields(row.fields), Number(row.id));
        }
        // Covering indexes: the daily spend's direct `created_at >= ?` range (Store.spendSince) and the
        // per-session read's direct `session_id = ?` lookup (listRunUsage) were each answered from the
        // index alone (Pi review of 05c390b), so neither statement walked a row to reach usage_* past
        // request/response. 79: once the split (below, later in this same open) removes request/response
        // from `runs`, both covering indexes are redundant (item 0: dropped) and never rebuilt; this
        // runs on every open, so it is gated the same way the source_entries block above is, on whether
        // `runs` still has the wide columns these indexes existed to dodge.
        if (runColumns.some(r => r.name === "request")) {
          this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_daily_usage ON runs(created_at, id, usage_cost)");
          this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_session_usage ON runs(session_id, id, kind, usage_input, usage_output, usage_cache_read, usage_cache_write, usage_cost)");
        }
      });
      // Ticket 81: `raw_fts`/`raw_search_entries` are brand new (SCHEMA_SQL above); a database that
      // already had Turns and tool calls needs every one of their non-null indexed fields written in,
      // once. Hoisted prepared statements (as the digest and usage backfills above), one INSERT pair
      // per field, in id order for both tables so a very large database streams rather than buffers.
      if (!hadRawFts) this.transaction(() => {
        const insertEntry = this.db.prepare("INSERT INTO raw_search_entries (session_id, turn_id, tool_call_id, field) VALUES (?, ?, ?, ?)");
        const insertFts = this.db.prepare("INSERT INTO raw_fts (rowid, text) VALUES (?, ?)");
        const addField = (sessionId: number, turnId: number, toolCallId: number | null, field: RawFtsField, text: string | null) => {
          if (text === null) return;
          const info = insertEntry.run(sessionId, turnId, toolCallId, field);
          insertFts.run(Number(info.lastInsertRowid), text);
        };
        for (const row of this.db.prepare("SELECT id, session_id, user_prompt, assistant_text FROM turns ORDER BY id").iterate() as
          IterableIterator<{ id: number; session_id: number; user_prompt: string | null; assistant_text: string | null }>) {
          addField(row.session_id, row.id, null, "user_prompt", row.user_prompt);
          addField(row.session_id, row.id, null, "assistant_text", row.assistant_text);
        }
        for (const row of this.db.prepare(`SELECT tc.id AS id, tc.turn_id AS turn_id, t.session_id AS session_id, tc.name AS name, tc.input AS input, tc.result AS result
            FROM tool_calls tc JOIN turns t ON t.id = tc.turn_id ORDER BY tc.id`).iterate() as
          IterableIterator<{ id: number; turn_id: number; session_id: number; name: string; input: string | null; result: string | null }>) {
          addField(row.session_id, row.turn_id, row.id, "tool_name", row.name);
          addField(row.session_id, row.turn_id, row.id, "tool_input", row.input);
          addField(row.session_id, row.turn_id, row.id, "tool_result", row.result);
        }
      });
      migrateDreamingRanges64d(this.db);
      this.db.exec(PROCESSING_SQL);
      this.db.exec(EXECUTIONS_SQL);
      migrateKnowledgeLineage(this.db, true);
      // The policy is part of the same schema transaction. Concurrent openers serialize at BEGIN;
      // INSERT OR IGNORE preserves an edited existing row and initializes an absent row once.
      this.transaction(() => {
        this.db.exec(`CREATE TABLE IF NOT EXISTS knowledge_budget_policy (
          id INTEGER PRIMARY KEY CHECK(id = 1),
          global_tokens INTEGER NOT NULL CHECK(global_tokens BETWEEN 0 AND 9007199254740991),
          project_tokens INTEGER NOT NULL CHECK(project_tokens BETWEEN 0 AND 9007199254740991),
          session_tokens INTEGER NOT NULL CHECK(session_tokens BETWEEN 0 AND 9007199254740991)
        )`);
        this.db.prepare("INSERT OR IGNORE INTO knowledge_budget_policy VALUES (1, ?, ?, ?)")
          .run(DEFAULT_KNOWLEDGE_BUDGETS.global, DEFAULT_KNOWLEDGE_BUDGETS.project, DEFAULT_KNOWLEDGE_BUDGETS.session);
        this.knowledgeBudgets(); // Invalid stored arithmetic is a hard open failure, never a fallback.
      });
      this.migration64d = migrateKnowledgeSubtraction(this.db, () => {
        const input = this.commitGraphInput(), visible = new Map<number, KnowledgeRevision>();
        const sessions = (this.db.prepare("SELECT id, project_id FROM sessions ORDER BY id").all() as
          { id: number; project_id: number }[]);
        const cursors = this.db.prepare(`SELECT session_id, branch, head_turn_id FROM session_lineage_cursors
          ORDER BY session_id, lineage`).all() as { session_id: number; branch: string; head_turn_id: number }[];
        const addPath = (path: KnowledgePath) => {
          for (const revision of this.commitGraph(path, undefined, undefined, input).current)
            if (revision.op !== "archive") visible.set(revision.id, revision);
        };
        for (const cursor of cursors) addPath({ sessionId: cursor.session_id, branch: cursor.branch, headTurnId: cursor.head_turn_id });
        const cursorSessions = new Set(cursors.map(cursor => cursor.session_id));
        for (const session of sessions.filter(value => !cursorSessions.has(value.id))) {
          const branches = (this.db.prepare("SELECT branch FROM source_paths WHERE session_id = ? ORDER BY branch").all(session.id) as { branch: string }[]);
          if (branches.length) for (const { branch } of branches) addPath(this.knowledgePath(session.id, branch));
          else for (const revision of this.commitGraph(null, undefined, undefined, input).current) {
            const writer = revision.runId === null ? undefined : input.metadata.runs.get(revision.runId);
            if (revision.op !== "archive" && (revision.scope === "global" ||
              revision.scope === "session" && writer === session.id ||
              revision.scope === "project" && writer !== undefined && input.metadata.projects.get(writer) === session.project_id))
              visible.set(revision.id, revision);
          }
        }
        return [...visible.values()].map(revision => ({ revisionId: revision.id,
          pool: placementOwner(this, { revision }, input.metadata) }));
      }, priorBudgetPolicy);
      // 79 "Hot/cold split": one-time, idempotent rebuild that moves Raw payloads and run bodies into
      // tables of their own, run once at the explicit upgrade, last: `migrateKnowledgeLineage` above
      // still expects `origin_session_id`/`origin_entry_ids` on the pre-split `runs` shape and would
      // re-add a dropped `origin_entry_ids` column if this ran earlier. `content`/`request` column
      // presence is the idempotency signal (both absent from a fresh database's SCHEMA_SQL-created
      // table only after this same rebuild ran once), so a second open does no work at all.
      // 83: the ordinal backfill runs first, in the same transaction, strictly before 79's rebuild of
      // `source_entries` -- a pre-split database gets its `NOT NULL` constraint from that same
      // rebuild (its `createSql` already declares it); an already-split database gets it from the
      // backfill's own rebuild instead, since 79's rebuild has nothing left to do there.
      this.transaction(() => { this.migrateEntryOrdinalBackfill(); this.migrateHotColdSplit(); });
      const schemaChanged = Number(this.db.prepare("PRAGMA schema_version").get()!.schema_version) !== schemaBefore;
      if (schemaChanged && this.db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Store migration: foreign key violations");
      this.db.exec("COMMIT");
      began = false;
      this.db.exec("PRAGMA foreign_keys = ON");
    } catch (error) {
      if (began && this.db.isTransaction) { try { this.db.exec("ROLLBACK"); } catch { /* Preserve the initialization error. */ } }
      try { this.db.exec("PRAGMA foreign_keys = ON"); } catch { /* Preserve the initialization error. */ }
      try { this.db.close(); } catch { /* Preserve the initialization error. */ }
      throw error;
    }
  }

  /** Shared table-rebuild procedure (SQLite's documented ALTER-TABLE-by-rebuild recipe): preserve
   * ids and the AUTOINCREMENT sequence, drop and recreate indexes/triggers not explicitly dropped.
   * Foreign keys are verified once, by the caller's caller, at the end of the whole schema
   * transaction. Used by 79's hot/cold split and 83's `NOT NULL` rebuild alike -- the same recipe,
   * two different column-shape changes. */
  private rebuildTable(table: string, drop: readonly string[], dropIndexes: readonly string[], createSql: string): void {
    const keep = (this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
      .map(row => row.name).filter(name => !drop.includes(name));
    const objects = this.db.prepare(`SELECT name, sql FROM sqlite_master WHERE tbl_name = ? AND type IN ('index','trigger')
      AND sql IS NOT NULL AND name NOT IN (${dropIndexes.map(() => "?").join(",") || "''"}) ORDER BY name`).all(table, ...dropIndexes) as { name: string; sql: string }[];
    const sequence = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = ?").get(table) as { seq: number } | undefined;
    this.db.exec(createSql.replace(/CREATE TABLE (?:IF NOT EXISTS )?\S+/, `CREATE TABLE ${table}_migrate`));
    this.db.exec(`INSERT INTO ${table}_migrate (${keep.join(",")}) SELECT ${keep.join(",")} FROM ${table};
      DROP TABLE ${table}; ALTER TABLE ${table}_migrate RENAME TO ${table}`);
    if (sequence) this.db.prepare("UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?").run(sequence.seq, table);
    for (const object of objects) this.db.exec(String(object.sql));
  }

  /** Convert legacy JSON membership under the same schema transaction as the rest of Store open. */
  private migrateSourcePaths(): void {
    if (!this.db.isTransaction) throw new Error("Source path migration requires a transaction");
    const rows = this.db.prepare("SELECT rowid, session_id, branch, entry_ids FROM source_paths ORDER BY rowid").all() as
      { rowid: number; session_id: number; branch: string; entry_ids: string }[];
    // Keep the old table intact until the new header is populated; failures roll back both tables.
    this.db.exec(`CREATE TABLE source_paths_migrate (
      id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id), branch TEXT NOT NULL,
      length INTEGER NOT NULL DEFAULT 0 CHECK(length >= 0), tail_entry_id INTEGER REFERENCES source_entries(id),
      version INTEGER NOT NULL DEFAULT 0, hwm_entry_id INTEGER NOT NULL DEFAULT 0,
      CHECK ((length = 0) = (tail_entry_id IS NULL)), UNIQUE(session_id,branch))`);
    const insertHeader = this.db.prepare(`INSERT INTO source_paths_migrate
      (id,session_id,branch,length,tail_entry_id,version,hwm_entry_id) VALUES (?,?,?,?,?,?,?)`);
    const insertMember = this.db.prepare("INSERT INTO source_path_entries(path_id,position,entry_id) VALUES (?,?,?)");
    for (const row of rows) {
      const ids = this.parsePathEntryIds(row.entry_ids);
      if (!ids || new Set(ids).size !== ids.length) throw new Error("stored source path is malformed");
      const old = this.db.prepare("SELECT version,hwm_entry_id FROM source_paths WHERE rowid = ?")
        .get(row.rowid) as { version: number; hwm_entry_id: number };
      insertHeader.run(row.rowid, row.session_id, row.branch, ids.length, ids.at(-1) ?? null, old.version, old.hwm_entry_id);
      ids.forEach((id, position) => insertMember.run(row.rowid, position, id));
    }
    this.db.exec(`DROP TABLE source_paths; ALTER TABLE source_paths_migrate RENAME TO source_paths;
      CREATE INDEX idx_source_paths_version ON source_paths(version)`);
  }

  /** 83: give every source entry whose `entry_ordinal` is NULL the ordinal it should have had, then
   * make the column `NOT NULL`. This codebase's write path (`appendSourceEntry`) always assigns an
   * ordinal, and the ALTER two blocks above numbers every row that existed the first time
   * `entry_ordinal` was added -- a NULL only enters through a stale writer's raw INSERT that omitted
   * the column, never through this migration itself. Backfilled per Turn, in id order, continuing
   * after the Turn's highest existing ordinal (a Turn with no numbered entry starts at E1); each
   * backfilled row's `addresses` is then recomputed with the same function a writer uses
   * (`sourceAddresses`), and its `#tN` legacy tool-call addresses -- which never depended on
   * `entry_ordinal` -- are asserted unchanged before the row commits. Idempotent: decided by the
   * column's declared `notnull` flag (Pi review of 2964522), never by "no NULL rows right now", so a
   * database with 0 NULLs but a still-nullable column still gets the constraint, and a database
   * already `NOT NULL` does nothing. A pre-split database gets its constraint from 79's own rebuild
   * of `source_entries`, called right after this method returns (its `createSql` already declares
   * it, since backfilling here guarantees no NULL survives into it); an already-split database, with
   * no such rebuild left to piggyback on, gets a dedicated one here. */
  private migrateEntryOrdinalBackfill(): void {
    if (!this.db.isTransaction) throw new Error("Ordinal backfill requires an active transaction");
    const ordinalColumn = (this.db.prepare("PRAGMA table_info(source_entries)").all() as { name: string; notnull: number }[])
      .find(column => column.name === "entry_ordinal");
    if (!ordinalColumn || ordinalColumn.notnull) return; // already NOT NULL: idempotent no-op
    const alreadySplit = !(this.db.prepare("PRAGMA table_info(source_entries)").all() as { name: string }[]).some(c => c.name === "content");
    const missing = this.db.prepare("SELECT id, turn_id FROM source_entries WHERE entry_ordinal IS NULL ORDER BY turn_id, id").all() as { id: number; turn_id: number }[];
    if (missing.length) {
      const maxOrdinal = new Map((this.db.prepare("SELECT turn_id, MAX(entry_ordinal) AS max FROM source_entries WHERE entry_ordinal IS NOT NULL GROUP BY turn_id").all() as
        { turn_id: number; max: number }[]).map(row => [row.turn_id, Number(row.max)]));
      const setOrdinal = this.db.prepare("UPDATE source_entries SET entry_ordinal = ? WHERE id = ?");
      const getBody = this.db.prepare(alreadySplit
        ? "SELECT r.content, r.blocks FROM source_entry_raw r WHERE r.entry_id = ?"
        : "SELECT content, blocks FROM source_entries WHERE id = ?");
      const getAddresses = this.db.prepare("SELECT addresses FROM source_entries WHERE id = ?");
      const setAddresses = this.db.prepare("UPDATE source_entries SET addresses = ? WHERE id = ?");
      const legacyToolCalls = (addresses: string[]) => addresses.filter(address => /#t\d+$/.test(address)).sort();
      const next = new Map<number, number>();
      for (const row of missing) {
        const ordinal = (next.get(row.turn_id) ?? maxOrdinal.get(row.turn_id) ?? 0) + 1;
        next.set(row.turn_id, ordinal);
        setOrdinal.run(ordinal, row.id);
        const body = getBody.get(row.id) as { content: string; blocks: string | null };
        const blocks = body.blocks == null ? undefined : JSON.parse(body.blocks) ?? undefined;
        const entry = { ...JSON.parse(body.content), id: row.id, entryOrdinal: ordinal, ...(blocks ? { blocks } : {}) };
        const before = legacyToolCalls(JSON.parse((getAddresses.get(row.id) as { addresses: string }).addresses));
        const after = sourceAddresses(entry);
        const afterToolCalls = legacyToolCalls(after);
        if (before.length !== afterToolCalls.length || before.some((address, index) => address !== afterToolCalls[index]))
          throw new Error(`ordinal backfill: entry ${row.id}'s #tN addresses changed (${JSON.stringify(before)} -> ${JSON.stringify(afterToolCalls)})`);
        setAddresses.run(JSON.stringify(after), row.id);
      }
    }
    if (alreadySplit) this.rebuildTable("source_entries", [], [], `CREATE TABLE source_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id INTEGER NOT NULL REFERENCES sessions(id),
      native_lineage TEXT NOT NULL,
      native_id TEXT NOT NULL,
      turn_id INTEGER NOT NULL REFERENCES turns(id),
      entry_ordinal INTEGER NOT NULL CHECK(entry_ordinal > 0),
      addresses TEXT NOT NULL DEFAULT '[]',
      digest TEXT,
      UNIQUE (session_id, native_lineage, native_id)
    )`);
  }

  /** 79 item 0: split `content`/`blocks` out of `source_entries` into `source_entry_raw`, and
   * `request`/`response`/`origin_entry_ids` out of `runs` into `run_bodies`, each keyed by the owning
   * row's id. Runs inside Store's one all-schema upgrade transaction. Rebuilds follow the codebase's
   * established table-rebuild procedure (as `migrateDreaming`/`migrateKnowledgeLineage` above):
   * preserve ids and the AUTOINCREMENT sequence, drop and recreate indexes/triggers, foreign keys
   * verified once at the end of the whole schema transaction. `content`/`request` column presence is
   * the one idempotency signal: absent (already split, or a fresh database that never had them here)
   * means nothing to do. */
  private migrateHotColdSplit(): void {
    if (!this.db.isTransaction) throw new Error("Hot/cold split requires an active transaction");
    this.db.exec(`CREATE TABLE IF NOT EXISTS source_entry_raw (
      entry_id INTEGER PRIMARY KEY REFERENCES source_entries(id), content TEXT NOT NULL, blocks TEXT)`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS run_bodies (
      run_id INTEGER PRIMARY KEY REFERENCES runs(id), request TEXT, response TEXT, origin_entry_ids TEXT)`);
    const columns = (table: string) => this.db.prepare(`PRAGMA table_info(${table})`).all().map(row => String(row.name));
    if (columns("source_entries").includes("content")) {
      this.db.exec("INSERT INTO source_entry_raw (entry_id, content, blocks) SELECT id, content, blocks FROM source_entries");
      // 71's idx_source_membership and 74's idx_source_identity existed only to dodge the wide
      // content/blocks columns; the split makes both redundant (measured, reported per the ticket).
      // idx_source_unnormalized is a partial index on `blocks IS NULL`, recreated below on the table
      // that now actually holds `blocks`.
      // 83: `entry_ordinal` is declared `NOT NULL` here -- safe unconditionally, since
      // `migrateEntryOrdinalBackfill` (called just before this method, same transaction) already
      // guarantees no NULL survives to this rebuild, on every database this branch runs for.
      this.rebuildTable("source_entries", ["content", "blocks"], ["idx_source_membership", "idx_source_identity", "idx_source_unnormalized"], `CREATE TABLE source_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL REFERENCES sessions(id),
        native_lineage TEXT NOT NULL,
        native_id TEXT NOT NULL,
        turn_id INTEGER NOT NULL REFERENCES turns(id),
        entry_ordinal INTEGER NOT NULL CHECK(entry_ordinal > 0),
        addresses TEXT NOT NULL DEFAULT '[]',
        digest TEXT,
        UNIQUE (session_id, native_lineage, native_id)
      )`);
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_source_unnormalized ON source_entry_raw(entry_id) WHERE blocks IS NULL");
    }
    if (columns("runs").includes("request")) {
      // A `runs` that reaches this split without ever having gone through 34a's origin migration
      // (an exotic cold path: a database untouched since before 34a, opened for the first time on
      // code that already carries both) has no `origin_entry_ids` column to copy from; migrated as
      // NULL, same as an ordinary run with no trigger origin.
      const originExpr = columns("runs").includes("origin_entry_ids") ? "origin_entry_ids" : "NULL";
      this.db.exec(`INSERT INTO run_bodies (run_id, request, response, origin_entry_ids) SELECT id, request, response, ${originExpr} FROM runs`);
      // 77's idx_runs_daily_usage/idx_runs_session_usage existed only to dodge request/response; the
      // split makes their covering trailing columns redundant. The filter columns themselves
      // (created_at, session_id) still need a lookup index -- idx_runs_created_at below, and
      // idx_runs_session from SCHEMA_SQL, which the split leaves untouched.
      this.rebuildTable("runs", ["request", "response", "origin_entry_ids"], ["idx_runs_daily_usage", "idx_runs_session_usage"], `CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL CHECK (kind IN ('noting','consolidation','dreaming','manual')),
        session_id INTEGER REFERENCES sessions(id),
        branch TEXT,
        range_from TEXT,
        range_to TEXT,
        prompt_hash TEXT,
        model TEXT,
        mode TEXT,
        origin_session_id INTEGER REFERENCES sessions(id),
        outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','cancelled','bounced','conflict')),
        created_at TEXT NOT NULL,
        usage_input INTEGER, usage_output INTEGER, usage_cache_read INTEGER, usage_cache_write INTEGER, usage_cost REAL
      )`);
      // `id` as a trailing column, not just `created_at`: spendSince orders by id (so its summation
      // never depends on row-storage order), and a single-column index would need a temp b-tree to
      // supply that order for a range condition; the composite key answers both without one.
      this.db.exec("CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at, id)");
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
    // Snapshot what a rolled-back savepoint must restore. Taken (and BEGIN/SAVEPOINT attempted)
    // before the memo is touched: a failed BEGIN never installs or mutates it.
    const priorCache = nested ? (this.enrolledCache ? new Map(this.enrolledCache) : null) : null;
    this.db.exec(nested ? "SAVEPOINT trace_memory_transaction" : "BEGIN IMMEDIATE");
    if (!nested) this.enrolledCache = new Map();
    try {
      const result = fn();
      this.db.exec(nested ? "RELEASE trace_memory_transaction" : "COMMIT");
      if (!nested) this.enrolledCache = null;
      return result;
    } catch (error) {
      try {
        this.db.exec(nested
          ? "ROLLBACK TO trace_memory_transaction; RELEASE trace_memory_transaction"
          : "ROLLBACK");
      } catch { /* Preserve the original error if rollback fails. */ }
      // A rolled-back savepoint discards whatever it memoized, in step with the database; a
      // rolled-back top-level transaction clears the memo entirely, as before.
      this.enrolledCache = nested ? priorCache : null;
      throw error;
    }
  }

  /** Read the sole database-owned policy. Consumers call this in their own transaction when they
   * need a coherent cap; no process-local copy can override it. */
  knowledgeBudgets(): KnowledgeBudgets {
    const row = this.db.prepare("SELECT global_tokens, project_tokens, session_tokens FROM knowledge_budget_policy WHERE id = 1").get() as
      { global_tokens: number; project_tokens: number; session_tokens: number } | undefined;
    if (!row) throw new Error("stored Knowledge budget policy: exactly one row with id 1 is required");
    return deriveKnowledgeBudgets({ global: Number(row.global_tokens), project: Number(row.project_tokens), session: Number(row.session_tokens) }, true);
  }

  /** Apply one edited row against the latest other two values under the same write lock. Budgets
   * trigger maintenance; existing content above the new value is reported by duePools, not rejected. */
  setKnowledgeBudget(field: KnowledgeBudgetField, value: number): { changed: boolean; policy: KnowledgeBudgets } {
    if (!["global", "project", "session"].includes(field)) throw new Error(`Unknown Knowledge budget field ${field}`);
    return this.transaction(() => {
      const current = this.knowledgeBudgets();
      const policy = deriveKnowledgeBudgets({ global: current.global, project: current.project, session: current.session, [field]: value });
      if (policy[field] === current[field]) return { changed: false, policy: current };
      const column = `${field}_tokens`;
      const result = this.db.prepare(`UPDATE knowledge_budget_policy SET ${column} = ? WHERE id = 1`).run(policy[field]);
      if (result.changes !== 1) throw new Error("Knowledge budget policy update did not affect its authoritative row");
      return { changed: true, policy };
    });
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

  private relabelProject(fromProjectId: number, intoProjectId: number): void {
    if (fromProjectId === intoProjectId) return;
    this.requireProjectRelabelFence(fromProjectId, intoProjectId);
    this.db.prepare("UPDATE projects SET merged_into = ? WHERE id = ?").run(intoProjectId, fromProjectId);
    this.db.prepare("UPDATE sessions SET project_id = ? WHERE project_id = ?").run(intoProjectId, fromProjectId);
    this.db.prepare("UPDATE knowledge SET project_id = ? WHERE project_id = ?").run(intoProjectId, fromProjectId);
  }

  private requireProjectRelabelFence(fromProjectId: number, intoProjectId: number): void {
    const now = Date.now();
    const live = this.db.prepare(`SELECT c.session_id FROM task_claims c JOIN sessions s ON s.id = c.session_id
      WHERE c.phase = 'dreaming' AND c.expires_at > ? AND s.project_id IN (?,?) LIMIT 1`)
      .get(now, fromProjectId, intoProjectId);
    if (live) throw new Error("Project relabel waits for the active Dreamer in an affected project");
    const ranged = this.db.prepare(`SELECT 1 FROM dreaming_ranges r JOIN task_claims c
      ON c.session_id = r.session_id AND c.phase = 'dreaming' AND c.token = r.claim_token
      WHERE r.completed_run IS NULL AND r.closed_at IS NULL AND c.expires_at > ? AND r.pool IN (?,?) LIMIT 1`)
      .get(now, `project:${fromProjectId}`, `project:${intoProjectId}`);
    if (ranged) throw new Error("Project relabel waits for the active Dreamer range of an affected pool");
  }

  /** Relabel a merged project's sessions and project-scoped knowledge onto the survivor. */
  mergeProject(fromProjectId: number, intoProjectId: number): void {
    this.transaction(() => this.relabelProject(fromProjectId, intoProjectId));
  }

  // -- sessions --

  /** A session row — and its id — exists only once the first assistant reply exists. */
  createSession(input: CreateSessionInput): Session {
    if (input.enrollmentChoice != null && typeof input.enrollmentChoice !== "boolean") throw new Error("Enrollment choice must be boolean");
    if (!input.firstReplyAt) {
      throw new Error("a session is allocated an id only once an assistant reply exists (firstReplyAt is required)");
    }
    const info = this.db.prepare("INSERT INTO sessions (host, started_at, first_reply_at, project_id, parent_session_id, project_declaration, enrollment_default, enrollment_choice, directory) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.host, input.startedAt, input.firstReplyAt, input.projectId, input.parentSessionId ?? null, input.projectDeclaration ?? "marker", Number(enrollmentDefault(input.nativeCreatedAt, input.baseline)), input.enrollmentChoice == null ? null : Number(input.enrollmentChoice), input.directory ?? null);
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  /** 62: the distinct effective projects (merges followed) of the sessions that recorded a directory. */
  directoryProjects(directory: string): number[] {
    const effective = new Set<number>();
    for (const row of this.db.prepare("SELECT DISTINCT project_id FROM sessions WHERE directory = ?").all(directory)) {
      let project = this.getProject(Number(row.project_id))!;
      while (project.mergedInto !== null) project = this.getProject(project.mergedInto)!;
      effective.add(project.id);
    }
    return [...effective];
  }

  getSession(id: number): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : null;
  }

  findSessionByHost(host: string): Session | null {
    const rows = this.db.prepare("SELECT * FROM sessions WHERE host = ? ORDER BY id").all(host);
    if (rows.length > 1) throw new Error(`multiple memory sessions are bound to host ${host}`);
    return rows.length ? toSession(rows[0]) : null;
  }

  private parsePathEntryIds(raw: unknown): number[] | null {
    let parsed: unknown;
    try { parsed = JSON.parse(String(raw)); } catch { return null; }
    return Array.isArray(parsed) && parsed.every(id => Number.isSafeInteger(id) && id > 0) ? parsed as number[] : null;
  }

  /** Shared foreground invariant for publication and batched Knowledge applicability. A native branch
   * may end before a headless/compaction Turn, or extend beyond an ancestor-prefix rewind. */
  private pathCoherenceProblem(sessionId: number, branch: string, headTurnId: number, ids: readonly number[],
    entries: ReadonlyMap<number, { turnId: number; sessionId: number }>, headAncestry: ReadonlySet<number>,
    tailAncestry?: ReadonlySet<number>): string | null {
    if (!branch) return "current path requires a non-empty branch";
    if (!headAncestry.has(headTurnId)) return `current path head T${headTurnId} is not a Turn of session S${sessionId}`;
    if (ids.some(id => entries.get(id)?.sessionId !== sessionId)) return `current path branch ${branch} has malformed source ancestry`;
    if (!ids.length) return null;
    const tail = entries.get(ids.at(-1)!)!.turnId;
    return headAncestry.has(tail) || tailAncestry?.has(headTurnId) ? null
      : `current path head T${headTurnId} is not coherent with branch ${branch}`;
  }

  private ancestryFromParents(parents: ReadonlyMap<number, number | null>, root: number): Set<number> {
    const ids = new Set<number>();
    let id: number | null = root;
    while (id !== null) {
      if (!parents.has(id) || ids.has(id)) throw new Error("invalid path ancestry");
      ids.add(id); id = parents.get(id)!;
    }
    return ids;
  }

  private currentPathProblem(sessionId: number, branch: string, headTurnId: number, snapshot?: PathSnapshot): string | null {
    if (!branch) return "current path requires a non-empty branch";
    const turn = this.db.prepare("SELECT session_id FROM turns WHERE id = ?").get(headTurnId) as { session_id: number } | undefined;
    if (!turn || Number(turn.session_id) !== sessionId) return `current path head T${headTurnId} is not a Turn of session S${sessionId}`;
    const ids = this.selectedSourceEntryIds(sessionId, branch);
    if (ids === null) return `current path branch ${branch} is not a persisted source path of session S${sessionId}`;
    const entryRows = ids.length ? this.db.prepare(`SELECT id, turn_id, session_id FROM source_entries
      WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) : [];
    const entries = new Map(entryRows.map(value => [Number(value.id), { turnId: Number(value.turn_id), sessionId: Number(value.session_id) }]));
    const headAncestry = snapshot?.turns ?? this.pathTurns({ sessionId, headTurnId });
    const tail = ids.length && entries.get(ids.at(-1)!);
    const tailAncestry = tail && !headAncestry.has(tail.turnId) ? this.pathTurns({ sessionId, headTurnId: tail.turnId }) : undefined;
    return this.pathCoherenceProblem(sessionId, branch, headTurnId, ids, entries, headAncestry, tailAncestry);
  }

  /** Publish the host's authoritative foreground. Knowledge resolution is stateless and observes
   * this path on its next read; path publication never mutates revision validity. */
  setCurrentPath(sessionId: number, branch: string, headTurnId: number, lineage: string): void {
    if (typeof lineage !== "string" || !lineage) throw new Error("current path requires a non-empty lineage");
    const problem = this.currentPathProblem(sessionId, branch, headTurnId);
    if (problem) throw new Error(problem);
    if (!this.getSession(sessionId)) throw new Error(`session S${sessionId} does not exist`);
    this.writeCurrentPath(sessionId, branch, headTurnId, lineage);
  }

  private writeCurrentPath(sessionId: number, branch: string, headTurnId: number, lineage: string): void {
    // Ticket 72: turn ids are assigned by AUTOINCREMENT in creation order, so a genuinely new Turn —
    // on any branch this lineage later switches to — always exceeds `hwm_head_turn_id`, the largest
    // head this cursor has ever held; only a revisit of an already-superseded Turn (a move back, or a
    // branch switch landing on one) can be <= it. Compared against the stored `head_turn_id` too, not
    // only `hwm_head_turn_id`: an idempotent republish of the SAME head (routine — a host publishes on
    // every poll, often before its own next Turn exists) must not bump merely because that head is, by
    // definition, never above its own high-water mark. A branch switch always bumps `version`, since
    // even a forward-looking head on a different line can remove items that were already visible on
    // the old one. The high-water mark itself only ever grows (MAX(itself, new head)), so 57 branches
    // and routine tree switches never turn into a "bump every later write forever" cursor: only a
    // write that is genuinely a move back (by id) or a branch change bumps.
    this.db.prepare(`INSERT INTO session_lineage_cursors (session_id, lineage, branch, head_turn_id, version, hwm_head_turn_id)
        VALUES (?, ?, ?, ?, (SELECT IFNULL(MAX(version), 0) + 1 FROM session_lineage_cursors), ?)
      ON CONFLICT (session_id, lineage) DO UPDATE SET
        version = CASE WHEN branch != excluded.branch OR
          (excluded.head_turn_id != head_turn_id AND excluded.head_turn_id <= hwm_head_turn_id)
          THEN (SELECT MAX(version) + 1 FROM session_lineage_cursors) ELSE version END,
        branch = excluded.branch, head_turn_id = excluded.head_turn_id,
        hwm_head_turn_id = MAX(hwm_head_turn_id, excluded.head_turn_id)`)
      .run(sessionId, lineage, branch, headTurnId, headTurnId);
  }

  enrollment(sessionId: number): Enrollment {
    const row = this.db.prepare("SELECT enrollment_default, enrollment_choice FROM sessions WHERE id = ?").get(sessionId);
    if (!row) throw new Error(`session S${sessionId} does not exist`);
    return { defaultEnabled: !!row.enrollment_default, choice: row.enrollment_choice === null ? null : !!row.enrollment_choice };
  }
  enabled(sessionId: number): boolean {
    const cached = this.enrolledCache?.get(sessionId);
    if (cached !== undefined) return cached;
    const value = this.enrollment(sessionId);
    const result = value.choice ?? value.defaultEnabled;
    this.enrolledCache?.set(sessionId, result);
    return result;
  }
  setEnrollment(sessionId: number, enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("Enrollment choice must be boolean");
    this.transaction(() => {
      this.enrollment(sessionId);
      this.db.prepare("UPDATE sessions SET enrollment_choice = ? WHERE id = ?").run(Number(enabled), sessionId);
      if (enabled) this.db.prepare("DELETE FROM task_failures WHERE session_id = ?").run(sessionId);
      this.enrolledCache?.delete(sessionId);
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

  private otherSessionOwnsDreamerSeat(sessionId: number, now: number): boolean {
    return !!this.db.prepare(`SELECT 1 FROM task_claims
      WHERE phase = 'dreaming' AND session_id != ? AND expires_at > ? LIMIT 1`).get(sessionId, now);
  }

  private dreamerSeatHeld(now: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM task_claims WHERE phase = 'dreaming' AND expires_at > ? LIMIT 1").get(now);
  }

  reopenSession(sessionId: number, executorId: string): void {
    this.transaction(() => {
      this.db.prepare("UPDATE sessions SET closed_at = NULL WHERE id = ?").run(sessionId);
      // Reserve the new tokens for this executor without launching either phase.
      for (const phase of ["noting", "consolidation", "dreaming"] as const) {
        const previous = this.getClaim(sessionId, phase);
        if (!previous || previous.executorId === executorId) continue;
        const now = Date.now(), seatUnavailable = phase === "dreaming" && this.otherSessionOwnsDreamerSeat(sessionId, now);
        this.db.prepare("UPDATE task_claims SET executor_id = ?, token = ?, expires_at = ?, borrowed = 0, reserved = 1 WHERE session_id = ? AND phase = ?")
          .run(executorId, randomUUID(), seatUnavailable ? Math.min(previous.expiresAt, now) : now + 30 * 60_000, sessionId, phase);
      }
    });
  }

  getClaim(sessionId: number, phase: Phase): TaskClaim | null {
    const row = this.db.prepare("SELECT * FROM task_claims WHERE session_id = ? AND phase = ?").get(sessionId, phase);
    return row ? { sessionId, phase, executorId: String(row.executor_id), token: String(row.token),
      expiresAt: Number(row.expires_at), borrowed: !!row.borrowed, reserved: !!row.reserved } : null;
  }

  acquireClaim(target: TaskTarget, phase: Phase, executorId: string, borrowed = false, eligible: () => boolean = () => true): TaskClaim | null {
    return this.transaction(() => this.acquireAvailableClaim(target, phase, executorId, borrowed, () => {
      const pending = phase === "noting" ? this.pendingEntries(target.sessionId, target.branch, target.headTurnId)
        : phase === "dreaming" ? this.knowledgePools(target).filter(pool => pool.reason !== null || pool.pending.length > 0)
        : this.consolidationBatch(target.sessionId, target.branch, target.headTurnId);
      return pending.length > 0;
    }, eligible));
  }

  /** Called only by atomic Store operations. Pending discovery is private and synchronous, so
   * admission can reuse its own projection without accepting prepared authority from a caller. */
  private acquireAvailableClaim(target: TaskTarget, phase: Phase, executorId: string, borrowed: boolean,
    hasPending: () => boolean, eligible: () => boolean): TaskClaim | null {
    if (!executorId || !this.enabled(target.sessionId)) return null;
    if (borrowed && this.getSession(target.sessionId)?.closedAt == null) return null;
    const pending = hasPending();
    const now = Date.now();
    if (phase === "dreaming") this.db.prepare(`UPDATE dreaming_ranges AS r SET closed_at = ? WHERE r.pool IS NOT NULL
      AND r.completed_run IS NULL AND r.closed_at IS NULL AND NOT EXISTS (
        SELECT 1 FROM task_claims c WHERE c.session_id = r.session_id AND c.phase = 'dreaming'
          AND c.token = r.claim_token AND c.expires_at > ?)`)
      .run(new Date().toISOString(), now);
    const openRange = phase === "dreaming" ? this.openDreamingRange(target.sessionId, target.branch) : null;
    if ((openRange && openRange.pool !== null) || !pending || !eligible()) return null;
    const current = this.getClaim(target.sessionId, phase);
    const takeover = current?.reserved && current.expiresAt > now && current.executorId === executorId && !borrowed;
    if (current && current.expiresAt > now && !takeover) return null;
    if (phase === "dreaming" && this.otherSessionOwnsDreamerSeat(target.sessionId, now)) return null;
    const claim: TaskClaim = { sessionId: target.sessionId, phase, executorId,
      token: takeover ? current.token : randomUUID(), expiresAt: now + 30 * 60_000, borrowed, reserved: false };
    this.db.prepare(`INSERT INTO task_claims (session_id, phase, executor_id, token, expires_at, borrowed, reserved) VALUES (?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT (session_id, phase) DO UPDATE SET executor_id = excluded.executor_id, token = excluded.token,
      expires_at = excluded.expires_at, borrowed = excluded.borrowed, reserved = 0`)
      .run(claim.sessionId, phase, executorId, claim.token, claim.expiresAt, Number(borrowed));
    return claim;
  }

  releaseClaim(claim: TaskClaim): boolean {
    return !!this.db.prepare("DELETE FROM task_claims WHERE session_id = ? AND phase = ? AND token = ? AND executor_id = ?")
      .run(claim.sessionId, claim.phase, claim.token, claim.executorId).changes;
  }

  invalidateExecutor(executorId: string, completingDreamerToken?: string): void {
    // Cancellation closes tool bindings separately. Only the exact in-flight Dreamer token stays
    // live for its processing transaction; this neither renews expiry nor preserves a replacement.
    this.db.prepare(`UPDATE task_claims SET expires_at = 0 WHERE executor_id = ?
      AND (? IS NULL OR phase != 'dreaming' OR token != ?)`)
      .run(executorId, completingDreamerToken ?? null, completingDreamerToken ?? null);
  }

  releaseExecutor(executorId: string): void {
    const rows = this.db.prepare("SELECT session_id, phase FROM task_claims WHERE executor_id = ?").all(executorId);
    for (const row of rows) {
      const claim = this.getClaim(Number(row.session_id), row.phase as Phase);
      if (claim?.executorId === executorId) this.releaseClaim(claim);
    }
  }

  private requireClaim(run: RunInput, terminalProcessing = false): void {
    if (!run.claim) return; // Manual writes and explicit low-level store commits have no worker.
    // Off fences new model work and knowledge writes, not completion of an already admitted run.
    // Terminal processing still requires the exact live token and all ownership/range fences.
    if (!terminalProcessing && run.executorSessionId !== undefined) this.requireEnabled(run.executorSessionId);
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
        if (phase === "dreaming") {
          const path = { sessionId, branch: String(branch), headTurnId };
          const due = this.duePools(path);
          if (!this.openDreamingRange(sessionId, String(branch)) && due.length) targets.push({ ...path,
            oldest: due.flatMap(pool => pool.pending.map(value => value.revisionId))[0] ?? Number.MAX_SAFE_INTEGER });
          continue;
        }
        const pending = phase === "noting" ? this.pendingEntries(sessionId, String(branch), headTurnId)
          : this.consolidationBatch(sessionId, String(branch), headTurnId);
        if (pending.length) targets.push({ sessionId, branch: String(branch), headTurnId,
          oldest: Math.min(...pending.map(value => value.id)) });
      }
    }
    // Global source/fact allocation order is durable pending arrival order; branches never coalesce.
    return targets.sort((a, b) => a.oldest - b.oldest || a.sessionId - b.sessionId || (a.branch < b.branch ? -1 : a.branch > b.branch ? 1 : 0))
      .map(({ oldest: _, ...target }) => target);
  }

  // -- turns & tool calls --

  /** Ticket 81: write a raw_fts/raw_search_entries pair for a field that is known not to be indexed
   * yet (a freshly appended Turn or tool call). A null value is simply not indexed -- there is nothing
   * for a later search to find, exactly as a NULL column never satisfies today's LIKE. */
  private indexRawField(field: RawFtsField, sessionId: number, turnId: number, toolCallId: number | null, text: string | null): void {
    if (text === null) return;
    const info = this.db.prepare("INSERT INTO raw_search_entries (session_id, turn_id, tool_call_id, field) VALUES (?, ?, ?, ?)")
      .run(sessionId, turnId, toolCallId, field);
    this.db.prepare("INSERT INTO raw_fts (rowid, text) VALUES (?, ?)").run(Number(info.lastInsertRowid), text);
  }

  /** Ticket 81: bring one field's row up to date after its source column changed (a growing reply, a
   * completed tool result). An in-place `UPDATE raw_fts` (contentless_delete=1 permits it) is cheaper
   * than delete+insert and leaves raw_search_entries, and the rowid pairing, untouched. A transition to
   * NULL removes the row instead -- a NULL column matches nothing under LIKE either. */
  private reindexRawField(field: RawFtsField, sessionId: number, turnId: number, toolCallId: number | null, text: string | null): void {
    // Two statements, one per partial unique index: `tool_call_id IS ?` matches neither index's
    // WHERE clause, so the planner scanned the whole table on every reply or result update.
    const existing = (toolCallId === null
      ? this.db.prepare("SELECT id FROM raw_search_entries WHERE turn_id = ? AND field = ? AND tool_call_id IS NULL").get(turnId, field)
      : this.db.prepare("SELECT id FROM raw_search_entries WHERE tool_call_id = ? AND field = ?").get(toolCallId, field)) as { id: number } | undefined;
    if (!existing) { this.indexRawField(field, sessionId, turnId, toolCallId, text); return; }
    if (text === null) {
      this.db.prepare("DELETE FROM raw_fts WHERE rowid = ?").run(existing.id);
      this.db.prepare("DELETE FROM raw_search_entries WHERE id = ?").run(existing.id);
    } else {
      this.db.prepare("UPDATE raw_fts SET text = ? WHERE rowid = ?").run(text, existing.id);
    }
  }

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
      const turnId = Number(info.lastInsertRowid);
      this.indexRawField("user_prompt", input.sessionId, turnId, null, input.userPrompt ?? null);
      this.indexRawField("assistant_text", input.sessionId, turnId, null, input.assistantText ?? null);
      return this.getTurn(turnId)!;
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
      if (patch.assistantText !== undefined) this.reindexRawField("assistant_text", turn.sessionId, id, null, patch.assistantText);
      return this.getTurn(id)!;
    });
  }

  getTurn(id: number): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? toTurn(row) : null;
  }

  appendToolCall(input: AppendToolCallInput): ToolCall {
    return this.transaction(() => {
      const turn = this.getTurn(input.turnId)!;
      this.requireEnabled(turn.sessionId);
      const ordinalRow = this.db
        .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM tool_calls WHERE turn_id = ?")
        .get(input.turnId) as { next: number };
      const info = this.db.prepare("INSERT INTO tool_calls (turn_id, ordinal, name, input, result, status) VALUES (?, ?, ?, ?, ?, ?)").run(input.turnId, ordinalRow.next, input.name, input.input ?? null, input.result ?? null, input.status);
      const toolCallId = Number(info.lastInsertRowid);
      this.indexRawField("tool_name", turn.sessionId, input.turnId, toolCallId, input.name);
      this.indexRawField("tool_input", turn.sessionId, input.turnId, toolCallId, input.input ?? null);
      this.indexRawField("tool_result", turn.sessionId, input.turnId, toolCallId, input.result ?? null);
      const row = this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(toolCallId);
      return toToolCall(row);
    });
  }

  completeToolCall(turnId: number, ordinal: number, result: string, status: string): void {
    return this.transaction(() => {
      const turn = this.getTurn(turnId)!;
      this.requireEnabled(turn.sessionId);
      const toolCall = this.db.prepare("SELECT id FROM tool_calls WHERE turn_id = ? AND ordinal = ?").get(turnId, ordinal) as { id: number } | undefined;
      this.db.prepare("UPDATE tool_calls SET result = ?, status = ? WHERE turn_id = ? AND ordinal = ?").run(result, status, turnId, ordinal);
      if (toolCall) this.reindexRawField("tool_result", turn.sessionId, turnId, toolCall.id, result);
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

  /** One immutable Noting NEAR pool read. Facts, source bindings and rendered relations use three
   * batched queries in one database snapshot regardless of pool size; applicability reuses
   * factOnPath and the binding's path snapshot rather than consulting the mutable branch tip. */
  notingNearPool(sessionId: number, path: KnowledgePath, snapshot: PathSnapshot): { facts: Fact[]; relations: Map<number, FactRelation[]> } {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT f.*, t.session_id FROM facts f JOIN turns t ON t.id = f.turn_id
        WHERE t.session_id = ? ORDER BY f.id`).all(sessionId);
      const projected: ApplicabilityInput = { runs: new Map(), projects: new Map(), facts: new Map() };
      for (const row of rows) {
        const fact = toFact(row);
        projected.facts.set(fact.id, { fact, sessionId: Number(row.session_id), runId: Number(row.run_id), entries: [] });
      }
      const ids = JSON.stringify([...projected.facts.keys()]);
      for (const row of this.db.prepare("SELECT fact_id, entry_id FROM fact_sources WHERE fact_id IN (SELECT value FROM json_each(?)) ORDER BY entry_id").all(ids))
        projected.facts.get(Number(row.fact_id))!.entries.push(Number(row.entry_id));
      const facts = [...projected.facts.values()].map(value => value.fact).filter(fact => this.factOnPath(fact, path, snapshot, projected));
      return { facts, relations: this.listFactRelationsOnPathOf(facts.map(fact => fact.id), path, snapshot) };
    });
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

  /** Judge immutable Fact membership in one frozen path snapshot with batched endpoint/source reads. */
  factApplicabilityOnPath(factIds: readonly number[], path: KnowledgePath,
    snapshot = this.pathSnapshot(path)): Map<number, boolean> {
    const endpointIds = [...new Set(factIds)];
    const input: ApplicabilityInput = { runs: new Map(), projects: new Map(), facts: new Map() };
    if (!endpointIds.length) return new Map();
    const ids = JSON.stringify(endpointIds);
    for (const row of this.db.prepare(`SELECT f.*, t.session_id FROM facts f JOIN turns t ON t.id = f.turn_id
      WHERE f.id IN (SELECT value FROM json_each(?))`).all(ids)) {
      const fact = toFact(row);
      input.facts.set(fact.id, { fact, sessionId: Number(row.session_id), runId: Number(row.run_id), entries: [] });
    }
    for (const row of this.db.prepare(`SELECT fact_id, entry_id FROM fact_sources
      WHERE fact_id IN (SELECT value FROM json_each(?)) ORDER BY entry_id`).all(ids))
      input.facts.get(Number(row.fact_id))?.entries.push(Number(row.entry_id));
    return new Map(endpointIds.map(id => {
      const fact = input.facts.get(id)?.fact;
      return [id, !!fact && this.factOnPath(fact, path, snapshot, input)] as const;
    }));
  }

  /** Automatic material keeps a relation only when both immutable Fact endpoints belong to the
   * selected path. Explicit Fact-address reads continue to use the unrestricted relation methods. */
  listFactRelationsOnPathOf(factIds: number[], path: KnowledgePath,
    snapshot = this.pathSnapshot(path)): Map<number, FactRelation[]> {
    const all = this.listFactRelationsOf(factIds);
    const endpointIds = [...new Set([...all.values()].flatMap(relations => relations.flatMap(r => [r.fromFact, r.toFact])))];
    if (!endpointIds.length) return all;
    const applies = this.factApplicabilityOnPath(endpointIds, path, snapshot);
    return new Map([...all].map(([id, relations]) => [id,
      relations.filter(relation => applies.get(relation.fromFact) && applies.get(relation.toFact))]));
  }

  listFactRelationsOnPath(factId: number, path: KnowledgePath, snapshot = this.pathSnapshot(path)): FactRelation[] {
    return this.listFactRelationsOnPathOf([factId], path, snapshot).get(factId) ?? [];
  }

  // -- runs (standalone: failure / cancelled, or a run with nothing else to commit) --

  /** 77: the one helper every writer of `response` routes through. Runs 71's one-parse extraction
   * against the exact string about to be stored (never the table), so the caller can bind the result
   * into the same INSERT/UPDATE statement that writes `response` -- the columns are derived from, and
   * written alongside, the same value, and can never fall out of step with it. */
  private usageColumns(response: string | null): UsageColumns {
    const row = this.db.prepare(`SELECT ${usageFieldsSql("?")} fields`).get(response, response) as { fields: string | null };
    return usageFromFields(row.fields);
  }

  recordRun(input: RunInput & { outcome: RunOutcome }): Run {
    return this.transaction(() => this.getRun(this.insertRun(input))!);
  }

  updateRun(id: number, input: RunInput & { outcome: RunOutcome }): void {
    this.transaction(() => {
      const previous = this.getRun(id);
      if (!previous) throw new Error(`run ${id} does not exist`);
      const factIds = (this.db.prepare("SELECT id FROM facts WHERE run_id = ? ORDER BY id").all(id) as { id: number }[]).map((f) => f.id);
      const response = JSON.parse(input.response ?? "{}");
      const nextResponse = JSON.stringify({ ...response, ...(input.entryAudit ? { entryAudit: input.entryAudit } : {}), ...(previous.kind === "noting" || factIds.length ? { factIds } : {}) });
      // 79 item 0: the body (request/response) and the hot columns (outcome, mode, usage_*) are
      // written together, in this same transaction, through this one updater.
      this.db.prepare("UPDATE run_bodies SET request = ?, response = ? WHERE run_id = ?").run(input.request ?? null, nextResponse, id);
      this.db.prepare(`UPDATE runs SET outcome = ?, mode = ?,
          usage_input = ?, usage_output = ?, usage_cache_read = ?, usage_cache_write = ?, usage_cost = ? WHERE id = ?`)
        .run(input.outcome, input.mode ?? null, ...this.usageColumns(nextResponse), id);
    });
  }

  /** The session a run was run for, as metadata: one column, never the request and response bodies.
   * Scope checks need only this (review 2026-09-09: a footer refresh with
   * scoped knowledge was loading whole audit bodies through `getRun` to read one id). */
  runSessionId(runId: number): number | null {
    return (this.db.prepare("SELECT session_id FROM runs WHERE id = ?").get(runId) as { session_id: number } | undefined)?.session_id ?? null;
  }
  /** 79 item 0: a legitimate full-row reader (the ticket's own list: "run audits, `listRuns`
   * consumers that show responses, and the trace readers") — joins the body in, unlike every
   * metadata-only run reader above. */
  getRun(id: number): Run | null {
    const row = this.db.prepare("SELECT r.*, b.request, b.response, b.origin_entry_ids FROM runs r JOIN run_bodies b ON b.run_id = r.id WHERE r.id = ?").get(id);
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
    const ownsCommit = !this.db.isTransaction;
    let publishPending: (() => void) | undefined;
    try {
      const result = this.transaction(() => {
        const sessionId = this.requireRunSession(input.run);
        this.requireEnabled(sessionId);
        this.requireClaim(input.run);
        const pending = this.pendingPath, consumed = input.entryIds ?? [];
        // Validate reuse under the write lock. A second writer's commit, unpublished append, or
        // non-prefix batch must rebuild. Nested callers cannot publish before their outer COMMIT.
        const header = ownsCommit && pending?.path && pending.sessionId === sessionId
          ? this.sourcePathState(sessionId, pending.branch) : null;
        const retainPending = !!(header && pending?.path && pending.signal === this.progressSignal(sessionId) &&
          header.version === pending.path.version && header.count === pending.path.count &&
          header.tailId === pending.path.tailId && consumed.length <= pending.ids.length &&
          consumed.every((id, index) => pending.ids.at(index) === id));
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
        const finalResponse = JSON.stringify({ ...response, ...(input.run.entryAudit ? { entryAudit: input.run.entryAudit } : {}), factIds: batchIds });
        this.db.prepare("UPDATE run_bodies SET response = ? WHERE run_id = ?").run(finalResponse, runId);
        this.db.prepare(`UPDATE runs SET usage_input = ?, usage_output = ?, usage_cache_read = ?, usage_cache_write = ?, usage_cost = ? WHERE id = ?`)
          .run(...this.usageColumns(finalResponse), runId);
        for (const id of input.entryIds ?? []) {
          if (this.getSourceEntry(id)?.sessionId !== sessionId) throw new Error("entry does not belong to the run session");
          this.db.prepare("INSERT INTO noted_entries (entry_id, run_id) VALUES (?, ?)").run(id, runId);
        }
        this.completeExecution(runId);
        if (retainPending) {
          const signal = this.progressSignal(sessionId);
          publishPending = () => {
            if (this.pendingPath !== pending) return;
            pending!.ids.removePrefix(consumed.length);
            pending!.signal = signal;
          };
        }
        return { runId, facts: batchIds.map((id) => this.getFact(id)!) };
      });
      // Queue mutation follows the actual COMMIT, never the writes or a released SAVEPOINT.
      publishPending?.();
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

  /** 79 item 0: writes the hot row and the body row (`request`/`response`/`origin_entry_ids`)
   * together, in the caller's transaction — the one helper every run writer routes through, so a
   * failure between the two inserts leaves neither. `origin_session_id` (hot) and `origin_entry_ids`
   * (body) are both derived from the same `origin` value here and never written elsewhere, so their
   * old same-table CHECK's invariant ("both null or both set") still holds by construction even
   * though it can no longer be a single-table CHECK once they live in different tables. */
  private insertRun(input: RunInput & { outcome: RunOutcome }): number {
    const origin = this.runOrigin(input);
    const response = input.entryAudit ? JSON.stringify({ ...JSON.parse(input.response ?? "{}"), entryAudit: input.entryAudit }) : input.response ?? null;
    // `this.transaction` nests as a SAVEPOINT under an already-open transaction and opens its own
    // otherwise (a caller may reach this from outside one, e.g. `recordFailure` after a rolled-back
    // attempt) -- either way the two inserts commit or roll back together.
    const id = this.transaction(() => {
      const info = this.db.prepare(`INSERT INTO runs (kind, session_id, branch, range_from, range_to, prompt_hash, model, mode, origin_session_id, outcome, created_at,
          usage_input, usage_output, usage_cache_read, usage_cache_write, usage_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          input.kind,
          input.sessionId ?? null,
          input.branch ?? null,
          input.rangeFrom ?? null,
          input.rangeTo ?? null,
          input.promptHash ?? null,
          input.model ?? null,
          input.mode ?? null,
          origin?.sessionId ?? null,
          input.outcome,
          input.createdAt,
          ...this.usageColumns(response),
        );
      const runId = Number(info.lastInsertRowid);
      this.db.prepare("INSERT INTO run_bodies (run_id, request, response, origin_entry_ids) VALUES (?, ?, ?, ?)")
        .run(runId, input.request ?? null, response, origin ? JSON.stringify(origin.entryIds) : null);
      return runId;
    });
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

  /** Batch immutable identity lookup for one projection; callers never scan knowledge per revision. */
  knowledgeRecords(ids: readonly number[]): Map<number, Knowledge> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    return new Map(this.db.prepare("SELECT * FROM knowledge WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id")
      .all(JSON.stringify(unique)).map(row => { const value = toKnowledge(row); return [value.id, value]; }));
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
    return this.ancestryFromParents(parents, path.headTurnId!);
  }

  /** Compare against a previously validated head, visiting only newer Turns. Turn ids increase at
   * insertion, so reaching an older id proves divergence without walking the retained ancestry. */
  pathExtendsHead(path: KnowledgePath, previous: number): boolean {
    const head = path.headTurnId;
    if (head == null || head < previous) return false;
    if (head === previous) return true;
    const row = this.db.prepare("SELECT parent_turn_id FROM turns WHERE id = ? AND session_id = ?")
      .get(head, path.sessionId) as { parent_turn_id: number | null } | undefined;
    if (row?.parent_turn_id === previous) return true;
    if (row?.parent_turn_id == null || row.parent_turn_id < previous) return false;
    return !!this.db.prepare(`WITH RECURSIVE suffix(id, parent_turn_id) AS (
      SELECT id, parent_turn_id FROM turns WHERE id = ? AND session_id = ?
      UNION SELECT t.id, t.parent_turn_id FROM turns t JOIN suffix s ON t.id = s.parent_turn_id
        WHERE s.id > ? AND t.session_id = ?)
      SELECT 1 FROM suffix WHERE id = ? LIMIT 1`)
      .get(row.parent_turn_id, path.sessionId, previous, path.sessionId, previous);
  }

  /** Compatibility for callers without a host head: use the branch's latest recorded or manual turn. */
  knowledgePath(sessionId: number, branch?: string, headTurnId?: number | null): KnowledgePath {
    if (headTurnId !== undefined) return branch === undefined ? { sessionId, headTurnId } : { sessionId, headTurnId, branch };
    if (branch === undefined) {
      const row = this.db.prepare("SELECT id FROM turns WHERE session_id = ? ORDER BY id DESC LIMIT 1").get(sessionId);
      return { sessionId, headTurnId: row ? Number(row.id) : null };
    }
    const native = this.sourcePathState(sessionId, branch);
    if (native) {
      const row = this.db.prepare("SELECT turn_id FROM source_entries WHERE id = ?").get(native.tailId ?? 0);
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

  /** Visibility is evaluated only after global current selection. Session scope additionally requires
   * every direct fact to belong to this reader branch; failure hides the identity without fallback. */
  private visibleOnPath(revision: KnowledgeRevision, path: KnowledgePath, input: ApplicabilityInput,
    snapshot?: PathSnapshot): boolean {
    if (!this.admits(revision, path.sessionId, input)) return false;
    if (revision.scope !== "session") return true;
    const selected = snapshot ?? this.pathSnapshot(path);
    return revision.supports.every(id => {
      const projected = input.facts.get(id);
      const fact = projected?.fact ?? this.getFact(id);
      if (!fact) throw new Error(`knowledge commit ${revision.id} cites missing fact ${id}`);
      return this.factOnPath(fact, path, selected, input);
    });
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
    const { revisions, parents } = input;
    // A caller's prepared snapshot belongs to this read, never to the memoized graph.
    const metadata = prepared ? { ...input.metadata, currentSnapshots: new Map(input.metadata.currentSnapshots) } : input.metadata;
    const foreground = path && metadata.currentPaths?.get(path.sessionId);
    if (prepared && path && Array.isArray(foreground)) {
      const match = foreground.find(value => value.branch === path.branch && value.headTurnId === path.headTurnId);
      if (match) metadata.currentSnapshots?.set(`${path.sessionId}:${match.lineage}`, prepared);
    }
    const facts = new Map<number, boolean>(), commits = new Map<number, boolean>();
    const grounded = revisions.filter(revision => this.revisionApplies(revision, metadata, facts, commits));
    const effective = this.effectiveRevisions(revisions, parents, grounded);
    const cursor = path && Array.isArray(foreground)
      ? foreground.find(value => value.branch === path.branch && value.headTurnId === path.headTurnId) : undefined;
    let readerSnapshot = prepared ?? (cursor ? metadata.currentSnapshots?.get(`${path!.sessionId}:${cursor.lineage}`) : undefined);
    const visible = path ? (revision: KnowledgeRevision) => {
      if (revision.scope === "session") readerSnapshot ??= this.pathSnapshot(path);
      return this.visibleOnPath(revision, path, metadata, readerSnapshot);
    } : (revision: KnowledgeRevision) => this.collectionAdmits(revision, projectId, metadata);
    return this.projectCommitGraph(revisions, parents, grounded, effective, visible);
  }

  /** One global graph input per Store, not a duplicate for each reader session. The graph's
   * dependencies are global; reader-specific pool-state fields in progressSignal can cause extra
   * misses but cannot change its contents. A named session opts into this read memo; seeded reads,
   * unnamed reads and every read inside a transaction rebuild from their own snapshot. */
  private graphInputCache: { signal: string; input: GraphInput } | undefined;
  commitGraphInput(seed?: readonly KnowledgeRevision[], cacheSessionId?: number): GraphInput {
    if (seed || cacheSessionId === undefined) return this.buildGraphInput(seed);
    // A writer must see its own transaction, not a process memo. Never publish a graph that
    // could have been built from work later rolled back, including nested savepoints.
    if (this.db.isTransaction) return this.buildGraphInput();
    // One read snapshot binds the signal and its graph: another connection cannot commit
    // between the two reads and leave an old graph installed under a newer signal.
    this.db.exec("BEGIN");
    try {
      const signal = this.progressSignal(cacheSessionId);
      const cached = this.graphInputCache;
      if (cached && cached.signal === signal) {
        this.db.exec("COMMIT");
        return cached.input;
      }
      const input = this.buildGraphInput();
      this.db.exec("COMMIT");
      this.graphInputCache = { signal, input };
      return input;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private buildGraphInput(seed?: readonly KnowledgeRevision[]): GraphInput {
    const revisions = seed ? [...seed] : this.db.prepare("SELECT * FROM knowledge_revisions ORDER BY id").all().map(toKnowledgeRevision);
    const byId = new Map(revisions.map(revision => [revision.id, revision]));
    if (seed) {
      let frontier = revisions.map(revision => revision.id);
      while (frontier.length) {
        const linked = this.db.prepare(`SELECT from_commit FROM knowledge_links
          WHERE kind IN ('merged_into','split_from') AND to_commit IN (SELECT value FROM json_each(?))`)
          .all(JSON.stringify(frontier)).map(row => Number(row.from_commit));
        const parentIds = [...new Set(frontier.flatMap(id => {
          const parent = byId.get(id)?.parentId;
          return parent === null || parent === undefined ? [] : [parent];
        }).concat(linked))].filter(id => !byId.has(id));
        if (!parentIds.length) break;
        const ancestors = this.db.prepare(`SELECT * FROM knowledge_revisions
          WHERE id IN (SELECT value FROM json_each(?)) ORDER BY id`).all(JSON.stringify(parentIds)).map(toKnowledgeRevision);
        for (const revision of ancestors) byId.set(revision.id, revision);
        frontier = ancestors.map(revision => revision.id);
      }
      revisions.splice(0, revisions.length, ...[...byId.values()].sort((a, b) => a.id - b.id));
    }
    const parents = new Map(revisions.map(r => [r.id, r.parentId === null ? [] : [r.parentId]]));
    const revisionIds = JSON.stringify(revisions.map(revision => revision.id));
    for (const link of this.db.prepare(`SELECT from_commit, to_commit FROM knowledge_links
      WHERE kind IN ('merged_into','split_from') AND to_commit IN (SELECT value FROM json_each(?))`).all(revisionIds) as { from_commit: number; to_commit: number }[]) {
      const direct = parents.get(link.to_commit)!;
      if (!direct.includes(link.from_commit)) direct.push(link.from_commit);
    }
    const runIds = JSON.stringify([...new Set(revisions.flatMap(r => r.runId === null ? [] : [r.runId]))]);
    const factIds = JSON.stringify([...new Set(revisions.flatMap(r => r.supports))]);
    const facts = new Map(this.db.prepare(`SELECT f.*, t.session_id FROM facts f JOIN turns t ON t.id = f.turn_id WHERE f.id IN (SELECT value FROM json_each(?))`).all(factIds)
      .map(r => [Number(r.id), { fact: toFact(r), sessionId: Number(r.session_id), runId: Number(r.run_id), entries: [] as number[] }]));
    const sessions = [...new Set([...facts.values()].map(value => value.sessionId))];
    const cursorRows = this.db.prepare(`SELECT c.session_id, c.lineage, c.branch, c.head_turn_id,
      p.session_id IS NOT NULL AS branch_exists,
      EXISTS(SELECT 1 FROM turns t WHERE t.id = c.head_turn_id AND t.session_id = c.session_id) AS head_exists
      FROM session_lineage_cursors c LEFT JOIN source_paths p ON p.session_id = c.session_id AND p.branch = c.branch
      WHERE c.session_id IN (SELECT value FROM json_each(?))
      ORDER BY c.session_id, c.lineage`).all(JSON.stringify(sessions));
    const grouped = new Map<number, typeof cursorRows>();
    for (const row of cursorRows) { const id = Number(row.session_id); let values = grouped.get(id); if (!values) { values = []; grouped.set(id, values); } values.push(row); }
    const metadata: ApplicabilityInput = {
      revisions: new Map(revisions.map(r => [r.id, r])), parents,
      runs: new Map(this.db.prepare("SELECT id, session_id FROM runs WHERE id IN (SELECT value FROM json_each(?))").all(runIds).map(r => [Number(r.id), Number(r.session_id)])),
      projects: new Map(this.db.prepare("SELECT id, project_id FROM sessions").all().map(r => [Number(r.id), Number(r.project_id)])),
      currentPaths: new Map(sessions.map(sessionId => {
        const rows = grouped.get(sessionId) ?? [];
        if (!rows.length) return [sessionId, null];
        const paths = rows.map(r => typeof r.branch !== "string" || !r.branch || !Number.isSafeInteger(Number(r.head_turn_id)) || !r.branch_exists || !r.head_exists
          ? "invalid" as const : { sessionId, branch: String(r.branch), headTurnId: Number(r.head_turn_id), lineage: String(r.lineage) });
        return [sessionId, paths.some(path => path === "invalid") ? "invalid" as const : paths as PersistedKnowledgePath[]];
      })),
      currentSnapshots: new Map(), validatedCurrentPaths: new Set(),
      facts,
    };
    for (const row of this.db.prepare("SELECT fact_id, entry_id FROM fact_sources WHERE fact_id IN (SELECT value FROM json_each(?)) ORDER BY entry_id").all(factIds))
      metadata.facts.get(Number(row.fact_id))!.entries.push(Number(row.entry_id));
    this.prepareCurrentMembership(metadata, new Map(cursorRows.map(row => {
      let ids: number[] | null = null;
      try { if (row.branch_exists) ids = this.selectedSourceEntryIds(Number(row.session_id), String(row.branch)); }
      catch (error) {
        if (error instanceof Error && error.message === "stored source path is malformed")
          throw new Error(`session S${Number(row.session_id)} has a corrupted recorded foreground`, { cause: error });
        throw error;
      }
      return [`${Number(row.session_id)}:${String(row.lineage)}`, ids] as const;
    })));
    return { revisions, parents, metadata };
  }

  /** Build direct-fact owner membership in batched reads local to this graph projection. Bound facts
   * need only entry identities; legacy unbound facts load addresses for their cited Turns alone. */
  private prepareCurrentMembership(input: ApplicabilityInput, rawPaths: Map<string, unknown>): void {
    const owners = new Set([...input.facts.values()].map(value => value.sessionId));
    const paths = new Map<string, { owner: number; path: PersistedKnowledgePath; ids: number[] }>();
    const malformed = (owner: number): never => { throw new Error(`session S${owner} has a corrupted recorded foreground`); };
    for (const owner of owners) {
      const current = input.currentPaths?.get(owner);
      if (current === undefined) throw new Error(`knowledge applicability is missing foreground metadata for session S${owner}`);
      if (current === null) continue;
      if (current === "invalid") return malformed(owner);
      for (const path of current) {
        const key = `${owner}:${path.lineage}`, ids = rawPaths.get(key);
        if (!Array.isArray(ids) || ids.some(id => !Number.isSafeInteger(id) || id < 1)) malformed(owner);
        paths.set(key, { owner, path, ids: ids as number[] });
      }
    }
    if (!paths.size) return;
    const selectedIds = [...new Set([...paths.values()].flatMap(value => value.ids))];
    // 71: INDEXED BY forces the covering-index plan outright, rather than trusting the planner's
    // stat-driven cost estimate — without a fresh ANALYZE the default rowid-lookup plan wins even
    // though it touches every row's overflow pages (verified with EXPLAIN QUERY PLAN both ways).
    const entryRows = selectedIds.length ? this.db.prepare(`SELECT id, turn_id, session_id FROM source_entries
      WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(selectedIds)) : [];
    const entries = new Map(entryRows.map(row => [Number(row.id), { turnId: Number(row.turn_id), sessionId: Number(row.session_id) }]));
    const seeds: { key: string; owner: number; root: number }[] = [];
    for (const [key, value] of paths) {
      if (value.ids.some(id => entries.get(id)?.sessionId !== value.owner)) malformed(value.owner);
      seeds.push({ key: `${key}:head`, owner: value.owner, root: value.path.headTurnId! });
      const tail = value.ids.length ? entries.get(value.ids.at(-1)!)!.turnId : null;
      if (tail !== null) seeds.push({ key: `${key}:tail`, owner: value.owner, root: tail });
    }
    const lineageRows = this.db.prepare(`WITH RECURSIVE
      seeds(key, owner, root) AS (
        SELECT json_extract(value, '$.key'), json_extract(value, '$.owner'), json_extract(value, '$.root') FROM json_each(?)
      ), lineage(key, owner, id, parent_turn_id, session_id) AS (
        SELECT s.key, s.owner, t.id, t.parent_turn_id, t.session_id FROM seeds s JOIN turns t ON t.id = s.root
        UNION
        SELECT l.key, l.owner, t.id, t.parent_turn_id, t.session_id FROM lineage l JOIN turns t ON t.id = l.parent_turn_id
      ) SELECT key, owner, id, parent_turn_id, session_id FROM lineage`).all(JSON.stringify(seeds));
    const bySeed = new Map<string, Map<number, number | null>>();
    for (const row of lineageRows) {
      const key = String(row.key), owner = Number(row.owner);
      if (Number(row.session_id) !== owner) malformed(owner);
      let lineage = bySeed.get(key); if (!lineage) { lineage = new Map(); bySeed.set(key, lineage); }
      lineage.set(Number(row.id), row.parent_turn_id === null ? null : Number(row.parent_turn_id));
    }
    const ancestry = (key: string, label: "head" | "tail", owner: number, root: number) => {
      try { return this.ancestryFromParents(bySeed.get(`${key}:${label}`) ?? malformed(owner), root); }
      catch { return malformed(owner); }
    };
    const citedTurns = new Map<number, Set<number>>();
    for (const value of input.facts.values()) if (!value.entries.length) {
      let turns = citedTurns.get(value.sessionId); if (!turns) { turns = new Set(); citedTurns.set(value.sessionId, turns); }
      for (const source of value.fact.source) { const match = /^T([1-9]\d*)#/.exec(source); if (match) turns.add(Number(match[1])); }
    }
    const snapshots = new Map<string, { owner: number; turns: Set<number>; selected: Set<number>; addresses: Map<number, Set<string>> }>();
    const addressCandidates = new Set<number>();
    for (const [key, value] of paths) {
      const turns = ancestry(key, "head", value.owner, value.path.headTurnId!);
      const tail = value.ids.length ? entries.get(value.ids.at(-1)!)!.turnId : null;
      const tailTurns = tail !== null && !turns.has(tail) ? ancestry(key, "tail", value.owner, tail) : undefined;
      if (this.pathCoherenceProblem(value.owner, value.path.branch!, value.path.headTurnId!, value.ids, entries, turns, tailTurns)) malformed(value.owner);
      const selected = new Set(value.ids.filter(id => turns.has(entries.get(id)!.turnId)));
      const wanted = citedTurns.get(value.owner); if (wanted) for (const id of selected) if (wanted.has(entries.get(id)!.turnId)) addressCandidates.add(id);
      snapshots.set(key, { owner: value.owner, turns, selected, addresses: new Map() });
    }
    if (addressCandidates.size) for (const row of this.db.prepare(`SELECT id, session_id, turn_id, addresses FROM source_entries
      WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify([...addressCandidates]))) {
      let parsed: unknown; try { parsed = JSON.parse(String(row.addresses)); } catch { malformed(Number(row.session_id)); }
      if (!Array.isArray(parsed) || parsed.some(address => typeof address !== "string")) malformed(Number(row.session_id));
      for (const snapshot of snapshots.values()) if (snapshot.owner === Number(row.session_id) && snapshot.selected.has(Number(row.id))) {
        const turnId = Number(row.turn_id); let values = snapshot.addresses.get(turnId); if (!values) { values = new Set(); snapshot.addresses.set(turnId, values); }
        for (const address of parsed as string[]) values.add(address);
      }
    }
    for (const [key, value] of snapshots) {
      input.currentSnapshots?.set(key, { turns: value.turns, entries: { ids: value.selected, addresses: turnId => value.addresses.get(turnId) ?? new Set() }, consolidatedRuns: new Map() });
      input.validatedCurrentPaths?.add(key);
    }
  }

  /** Resolve effective lineages from immutable commit order and current direct-fact applicability.
   * A lineage lane is stable across ordinary writes, records both the split operation and its output,
   * and is combined by merge parents. Resolve grounded tips latest-first: equal/prefix lanes and
   * different split operations on one base conflict, while outputs of the same split coexist. Skipped
   * earlier operations have no side effects, so an ineffective merge cannot keep consuming another identity. */
  private effectiveRevisions(revisions: KnowledgeRevision[], parents: Map<number, number[]>, grounded: KnowledgeRevision[]): Set<number> {
    const groundedIds = new Set(grounded.map(revision => revision.id));
    const byId = new Map(revisions.map(revision => [revision.id, revision]));
    const lanes = new Map<number, string[][]>(), visiting = new Set<number>();
    const lanesOf = (id: number): string[][] => {
      const cached = lanes.get(id); if (cached) return cached;
      if (visiting.has(id)) throw new Error(`knowledge lineage cycle at commit ${id}`);
      const revision = byId.get(id);
      if (!revision) throw new Error(`knowledge lineage references missing commit ${id}`);
      visiting.add(id);
      const direct = parents.get(id) ?? [];
      const inherited = direct.length ? direct.flatMap(parent => lanesOf(parent)) : [[`K${revision.knowledgeId}`]];
      const result = revision.op === "split" && revision.runId !== null
        ? inherited.map(lane => [...lane, `S${revision.runId}:${direct.join(",")}`, `O${revision.id}`]) : inherited;
      const unique = [...new Map(result.map(lane => [lane.join("/"), lane])).values()];
      visiting.delete(id); lanes.set(id, unique);
      return unique;
    };
    const conflicts = (left: readonly string[], right: readonly string[]) => {
      if (left[0] !== right[0]) return false;
      let index = 1;
      while (index < left.length && index < right.length) {
        if (left[index] !== right[index]) return true; // alternative split operations on one lane
        if (left[index + 1] !== right[index + 1]) return false; // outputs of the same split coexist
        index += 2;
      }
      return true; // the same lane, or its unsplit prefix
    };
    const active = new Set<number>(), activeByRoot = new Map<string, Set<number>>();
    for (const revision of [...grounded].sort((left, right) => right.id - left.id)) {
      const revisionLanes = lanesOf(revision.id), candidates = new Set<number>();
      for (const lane of revisionLanes) for (const tip of activeByRoot.get(lane[0]!) ?? []) candidates.add(tip);
      if ([...candidates].some(tip => revisionLanes.some(left => lanesOf(tip).some(right => conflicts(left, right))))) continue;
      active.add(revision.id);
      for (const root of new Set(revisionLanes.map(lane => lane[0]!))) {
        let tips = activeByRoot.get(root); if (!tips) { tips = new Set(); activeByRoot.set(root, tips); }
        tips.add(revision.id);
      }
    }
    const effective = new Set<number>(), seen = new Set<number>();
    const pending = [...active];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id); if (groundedIds.has(id)) effective.add(id);
      pending.push(...(parents.get(id) ?? []));
    }
    return effective;
  }

  /** Write-base integrity consumes the same resolved graph as every reader. The surrounding
   * BEGIN IMMEDIATE transaction keeps this check and the revision insert atomic. */
  private resolvedBaseProblem(graph: CommitGraph,
    target: { knowledgeId: number; baseCommit: number }): string | null {
    const current = graph.resolved.filter(revision => revision.knowledgeId === target.knowledgeId);
    if (graph.effective.has(target.baseCommit) && current.some(revision => revision.id === target.baseCommit)) return null;
    const related = new Set<number>();
    for (const ancestor of graph.ancestors(target.baseCommit))
      for (const descendant of graph.descendants(ancestor)) related.add(descendant);
    // 76 review: name only a version this writer can see. `graph.resolved`/`graph.revisions` are
    // reader-independent and can hold another project's or session's winning revision; `graph.current`
    // is the same reader-visible resolution `baseProblem`'s hint below already uses via `currentCommit`
    // (this is the identical writer-path graph, so reusing it is the same rule, not a second one) —
    // still following merge/split links across identities, but only into what this writer can read.
    const consumingCurrent = graph.current.filter(revision => related.has(revision.id));
    const sameIdentity = graph.current.filter(revision => revision.knowledgeId === target.knowledgeId);
    const actual = consumingCurrent.length ? consumingCurrent.map(revision => `K${revision.knowledgeId}@${revision.id}`).join(", ")
      : sameIdentity.length ? sameIdentity.map(revision => `K${revision.knowledgeId}@${revision.id}`).join(", ") : undefined;
    return `K${target.knowledgeId}@${target.baseCommit}: base is not the latest effective applicable revision; `
      + (actual ? `current: ${actual}` : "no current version is visible on this branch");
  }

  private collectionAdmits(revision: KnowledgeRevision, projectId: number | undefined, input: ApplicabilityInput): boolean {
    const writer = revision.runId === null ? undefined : input.runs.get(revision.runId);
    return projectId === undefined || revision.scope === "global" ||
      (revision.scope === "project" && writer !== undefined && input.projects.get(writer) === projectId);
  }

  private projectCommitGraph(revisions: KnowledgeRevision[], parents: Map<number, number[]>, applicable: KnowledgeRevision[], effective: Set<number>,
    visible: (revision: KnowledgeRevision) => boolean): CommitGraph {
    const selected = applicable.filter(revision => effective.has(revision.id));
    const superseded = new Set<number>();
    // ponytail: scan the commit DAG per read; index/cache only if measured history size requires it.
    for (const r of selected) {
      const pending = [...parents.get(r.id)!];
      while (pending.length) {
        const id = pending.pop()!;
        if (superseded.has(id)) continue;
        superseded.add(id); pending.push(...parents.get(id)!);
      }
    }
    let children: Map<number, number[]> | undefined; // the same edges, downwards; built only if asked for
    const resolved = selected.filter(r => !superseded.has(r.id));
    return { revisions, effective, applicable: new Set(applicable.map(r => r.id)), resolved, current: resolved.filter(visible),
      ancestors: (commitId: number) => {
        const ids = new Set([commitId]), pending = [commitId];
        while (pending.length) for (const parent of parents.get(pending.pop()!) ?? []) if (!ids.has(parent)) { ids.add(parent); pending.push(parent); }
        return ids;
      },
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
    const header = this.sourcePathState(path.sessionId, path.branch);
    if (!header) return null;
    const rows = this.db.prepare(`SELECT j.position, j.entry_id, e.id AS owned_id, e.id, e.turn_id, e.addresses
      FROM source_paths p JOIN source_path_entries j ON j.path_id = p.id
      LEFT JOIN source_entries e ON e.id = j.entry_id AND e.session_id = p.session_id
      WHERE p.session_id = ? AND p.branch = ? ORDER BY j.position`).all(path.sessionId, path.branch) as
      { position: number; entry_id: number; owned_id: number | null; id: number; turn_id: number; addresses: string }[];
    this.validatePathMembers(header, rows);
    const ids = new Set<number>(), addresses = new Map<number, Set<string>>();
    for (const { id, turn_id, addresses: raw } of rows) {
      if (!turns.has(turn_id)) continue;
      ids.add(id);
      if (!addresses.has(turn_id)) addresses.set(turn_id, new Set());
      for (const address of JSON.parse(raw) as string[]) addresses.get(turn_id)!.add(address);
    }
    return { ids, addresses: (turnId: number) => addresses.get(turnId) ?? new Set() };
  }

  factEntries(factId: number): number[] {
    return (this.db.prepare("SELECT entry_id FROM fact_sources WHERE fact_id = ? ORDER BY entry_id").all(factId) as { entry_id: number }[]).map(r => r.entry_id);
  }

  factCoveredByRaw(fact: Fact, covered: ReadonlySet<number>): boolean {
    return this.factsCoveredByRaw([fact], covered).has(fact.id);
  }

  /** Resolve visible original native entries against the selected path and validate every bounded
   * carrier's database/native pair in one metadata lookup. A carrier can identify a representation,
   * not move an arbitrary source onto this path. Raw bodies are never loaded. */
  visibleSourceEntryIds(path: KnowledgePath | null, snapshot: PathSnapshot | null,
    raw: ReadonlyMap<string, "source" | "view">, carried: ReadonlyMap<number, string>): Set<number> {
    const selected = snapshot?.entries?.ids ?? new Set<number>();
    const candidates = new Set([...carried.keys(), ...selected]);
    if (!path || !candidates.size || (!carried.size && ![...raw.values()].includes("source"))) return new Set();
    const result = new Set<number>();
    // Covering index (74's identity index holds native_id): rows of other sessions were skipped anyway.
    for (const row of this.db.prepare(`SELECT id, session_id, native_id FROM source_entries
      WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .all(path.sessionId, JSON.stringify([...candidates])) as { id: number; session_id: number; native_id: string }[]) {
      if (row.session_id !== path.sessionId || !selected.has(row.id)) continue;
      if (carried.get(row.id) === row.native_id || raw.get(row.native_id) === "source") result.add(row.id);
    }
    return result;
  }

  /** Re-resolve citations in the original Noting run's frozen entry set, never today's path.
   * Manual/legacy writes without that set cannot prove completeness and stay eligible. The optional
   * applicability projection reuses the graph's fact/source snapshot, leaving one proof lookup. */
  factsCoveredByRaw(facts: readonly Fact[], covered: ReadonlySet<number>,
    projected?: ReadonlyMap<number, { fact: Fact; sessionId: number; runId: number; entries: number[] }>): Set<number> {
    const result = new Set<number>();
    if (!facts.length || !covered.size) return result;
    const bindings = new Map<number, Set<number>>(), runs = new Map<number, number>();
    if (projected) {
      for (const fact of facts) {
        const value = projected.get(fact.id);
        if (!value) continue;
        runs.set(fact.id, value.runId);
        if (value.entries.length) bindings.set(fact.id, new Set(value.entries));
      }
    } else for (const row of this.db.prepare("SELECT f.run_id, b.fact_id, b.entry_id FROM fact_sources b JOIN facts f ON f.id = b.fact_id WHERE f.id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(facts.map(f => f.id)))) {
      const id = Number(row.fact_id);
      runs.set(id, Number(row.run_id));
      if (!bindings.has(id)) bindings.set(id, new Set());
      bindings.get(id)!.add(Number(row.entry_id));
    }
    // A fact is covered only when every entry it is bound to lies in `covered` (the final check below
    // demands exactly that), so a fact bound outside the Raw window can never qualify. Filter on it
    // first: the proof lookup then reads only the Noting runs of window-bound facts, bounded by the
    // window, instead of every noted entry of every run behind every candidate fact on the path.
    for (const [id, bound] of bindings) if (![...bound].every(entry => covered.has(entry))) bindings.delete(id);
    if (!bindings.size) return result;
    const sources = new Map<number, Map<string, Set<number>>>();
    for (const row of this.db.prepare(`SELECT n.run_id, e.id, e.addresses
      FROM noted_entries n JOIN runs r ON r.id = n.run_id
      JOIN source_entries e ON e.id = n.entry_id AND e.session_id = r.session_id
      WHERE r.kind = 'noting' AND r.outcome = 'success' AND r.id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify([...new Set([...bindings.keys()].map(id => runs.get(id)!))]))) {
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

  /** Ticket 80 item 3: every fact's `fact_sources` binding, one batched query regardless of how many
   * ids are asked for — the replacement for a `factEntries` call per fact inside a loop. A fact with
   * no bound entries still gets an (empty) entry, so a lookup miss is never confused with "unbound". */
  factSourceEntries(factIds: readonly number[]): Map<number, number[]> {
    const ids = [...new Set(factIds)];
    const bound = new Map<number, number[]>(ids.map(id => [id, []]));
    if (ids.length) for (const row of this.db.prepare(`SELECT fact_id, entry_id FROM fact_sources
      WHERE fact_id IN (SELECT value FROM json_each(?)) ORDER BY entry_id`).all(JSON.stringify(ids)) as { fact_id: number; entry_id: number }[])
      bound.get(Number(row.fact_id))!.push(Number(row.entry_id));
    return bound;
  }

  /** Fact and Raw readers keep their supplied frozen path. Foreign facts remain available for their
   * existing scope-specific selection; only Knowledge support membership consults mutable foregrounds.
   * `owners` (71): a batched turn-id -> session-id map a caller already holds, tried before a
   * per-fact `SELECT * FROM turns WHERE id = ?` — the check itself is unchanged, only where its
   * answer comes from. `bound` (80): a batched `factSourceEntries` result a caller already holds,
   * tried before a per-fact `fact_sources` query — same order of preference as `owners`. */
  factOnPath(fact: Fact, path: KnowledgePath, snapshot = this.pathSnapshot(path), input?: ApplicabilityInput,
    owners?: ReadonlyMap<number, number>, bound?: ReadonlyMap<number, number[]>): boolean {
    const projected = input?.facts.get(fact.id);
    const owner = projected?.sessionId ?? owners?.get(fact.turnId) ?? this.getTurn(fact.turnId)!.sessionId;
    if (owner !== path.sessionId) return true;
    return this.factInSnapshot(fact, snapshot, projected?.entries ?? bound?.get(fact.id));
  }

  private factInSnapshot(fact: Fact, snapshot: PathSnapshot, projectedEntries?: number[]): boolean {
    const { turns, entries } = snapshot;
    if (!turns.has(fact.turnId) || !fact.source.every(source => turns.has(Number(/^T([1-9]\d*)#/.exec(source)?.[1])))) return false;
    if (entries === null) return true;
    const bound = projectedEntries ?? this.factEntries(fact.id);
    return bound.length ? bound.every(id => entries.ids.has(id))
      : fact.source.every(source => entries.addresses(Number(/^T([1-9]\d*)#/.exec(source)![1])).has(sourceKey(source)));
  }

  /** Knowledge support always follows the fact owner's foreground, including for an unbound project
   * or global collection read. The cache belongs to one commitGraph input and is never shared by Store instances. */
  private factOnCurrentPath(fact: Fact, owner: number, input: ApplicabilityInput): boolean {
    if (!input.currentPaths?.has(owner)) throw new Error(`knowledge applicability is missing foreground metadata for session S${owner}`);
    const paths = input.currentPaths.get(owner)!;
    if (paths === null) return true;
    if (paths === "invalid") throw new Error(`session S${owner} has a corrupted recorded foreground`);
    const projected = input.facts.get(fact.id)?.entries;
    // One whole fact must pass one cursor. Never union Turn/source/entry membership across siblings.
    return paths.some(path => {
      const key = `${owner}:${path.lineage}`;
      const snapshot = input.currentSnapshots?.get(key);
      if (!snapshot) throw new Error(`knowledge applicability is missing cursor snapshot for session S${owner}`);
      return this.factInSnapshot(fact, snapshot, projected);
    });
  }

  /** Applicability is local to one immutable revision and reader-independent: every direct support
   * follows its owner's current foreground. Citation scope is validated only at the write seam. */
  private revisionApplies(commit: KnowledgeRevision, input: ApplicabilityInput,
    facts: Map<number, boolean>, commits: Map<number, boolean>): boolean {
    if (commits.has(commit.id)) return commits.get(commit.id)!;
    const applies = commit.supports.every(id => {
      const projected = input.facts.get(id);
      const stored = projected?.fact ?? this.getFact(id);
      if (!stored) throw new Error(`knowledge commit ${commit.id} cites missing fact ${id}`);
      const owner = projected?.sessionId ?? this.getTurn(stored.turnId)!.sessionId;
      if (!facts.has(id)) facts.set(id, this.factOnCurrentPath(stored, owner, input));
      return facts.get(id)!;
    });
    commits.set(commit.id, applies);
    return applies;
  }

  commitApplies(commit: KnowledgeRevision, path: KnowledgePath, snapshot?: PathSnapshot,
    input: ApplicabilityInput = this.commitGraphInput([commit]).metadata, facts = new Map<number, boolean>(),
    commits = new Map<number, boolean>()): boolean {
    const foreground = input.currentPaths?.get(path.sessionId);
    const selected = snapshot ? { ...input, currentSnapshots: new Map(input.currentSnapshots) } : input;
    if (snapshot && Array.isArray(foreground)) {
      const match = foreground.find(value => value.branch === path.branch && value.headTurnId === path.headTurnId);
      if (match) selected.currentSnapshots?.set(`${path.sessionId}:${match.lineage}`, snapshot);
    }
    return this.revisionApplies(commit, selected, facts, commits);
  }

  /** Grounds are exactly this revision's direct supports; lineage is immutable provenance only. */
  revisionGrounds(commit: KnowledgeRevision): Set<number> {
    return new Set(commit.supports);
  }

  commitParents(commit: KnowledgeRevision): KnowledgeRevision[] {
    return this.db.prepare(`SELECT * FROM knowledge_revisions WHERE id = ? OR id IN
      (SELECT from_commit FROM knowledge_links WHERE to_commit = ? AND kind IN ('merged_into','split_from')) ORDER BY id`)
      .all(commit.parentId, commit.id).map(toKnowledgeRevision);
  }

  commitChildren(commit: KnowledgeRevision): KnowledgeRevision[] {
    return this.db.prepare(`SELECT * FROM knowledge_revisions WHERE parent_id = ? OR id IN
      (SELECT to_commit FROM knowledge_links WHERE from_commit = ? AND kind IN ('merged_into','split_from')) ORDER BY id`)
      .all(commit.id, commit.id).map(toKnowledgeRevision);
  }

  currentCommit(knowledgeId: number, path: KnowledgePath | null = null): KnowledgeRevision[] {
    return this.commitGraph(path).current.filter(revision => revision.knowledgeId === knowledgeId);
  }

  /** Resolve the global current version before filtering visibility and active bodies. A
   * session-scoped read shares the graph memo with injection and pool reads; write transactions
   * always build their own graph. */
  currentKnowledge(path: KnowledgePath | null = null, filter: KnowledgeFilter = {}, snapshot?: PathSnapshot): KnowledgeWithRevision[] {
    return this.commitGraph(path, filter.projectId, snapshot,
      path ? this.commitGraphInput(undefined, path.sessionId) : this.commitGraphInput()).current
      .filter(revision => revision.op !== "archive" && (!filter.scope || revision.scope === filter.scope))
      .map(revision => ({ knowledge: this.getKnowledge(revision.knowledgeId)!, revision }))
      .sort((a, b) => a.knowledge.id - b.knowledge.id);
  }

  listVisibleKnowledge(sessionId: number, projectId: number, headTurnId?: number | null, branch?: string): KnowledgeWithRevision[] {
    return sessionId ? this.currentKnowledge(this.knowledgePath(sessionId, branch, headTurnId))
      : this.currentKnowledge(null, { projectId });
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
        UNION SELECT from_commit, to_commit FROM knowledge_links WHERE kind IN ('merged_into','split_from')
      ), descendants(id) AS (
        SELECT ? UNION SELECT e.child FROM edges e JOIN descendants d ON e.parent = d.id
      ) SELECT id FROM descendants`).all(commitId) as { id: number }[]).map(r => r.id));
  }

  baseProblem(knowledgeId: number, base: number, path: KnowledgePath | null, allowArchived = false,
    prepared?: ApplicabilityInput): string | null {
    const revision = this.getKnowledgeRevision(knowledgeId, base);
    let visible = !path, applicable = !path;
    if (path && revision) {
      const input = prepared ?? this.commitGraphInput([revision]).metadata;
      const foreground = input.currentPaths?.get(path.sessionId);
      const cursor = Array.isArray(foreground)
        ? foreground.find(value => value.branch === path.branch && value.headTurnId === path.headTurnId) : undefined;
      const snapshot = revision.scope === "session"
        ? (cursor ? input.currentSnapshots?.get(`${path.sessionId}:${cursor.lineage}`) : undefined) ?? this.pathSnapshot(path) : undefined;
      applicable = this.commitApplies(revision, path, snapshot, input);
      visible = applicable && this.visibleOnPath(revision, path, input, snapshot);
    }
    if (revision && (revision.op !== "archive" || allowArchived) && visible) return null;
    const generic = `K${knowledgeId}@${base}: base is missing, archived, inapplicable or outside the writer's scope`;
    // 76: name the writer's current version instead of the generic refusal, so a rejected C or D
    // operation can resubmit against the right address without a blind read. `currentCommit` reuses
    // the same reader-visible resolution every other consumer of this path sees; it is only ever
    // called on the (rare) refusal path, never for a commit that already validated.
    if (!revision || !path) return generic;
    const current = this.currentCommit(knowledgeId, path)[0];
    if (current) return current.id === base
      ? `K${knowledgeId}@${base}: current version is archived`
      : `K${knowledgeId}@${base} is not current on this branch; current is K${knowledgeId}@${current.id}`;
    return `K${knowledgeId}@${base}: ${revision.op === "archive" ? "archived" : !applicable ? "inapplicable" : "outside the writer's scope"} on this branch`;
  }

  /** Direct consuming edges across update, merge, split and archive identities. */
  consumingSuccessors(commitIds: readonly number[]): Map<number, number[]> {
    const ids = [...new Set(commitIds)];
    const result = new Map(ids.map(id => [id, [] as number[]]));
    if (!ids.length) return result;
    for (const row of this.db.prepare(`WITH edges(parent, child) AS (
      SELECT parent_id, id FROM knowledge_revisions WHERE parent_id IS NOT NULL
      UNION SELECT from_commit, to_commit FROM knowledge_links WHERE kind IN ('merged_into','split_from')
    ) SELECT parent, child FROM edges WHERE parent IN (SELECT value FROM json_each(?)) ORDER BY parent, child`).all(JSON.stringify(ids)))
      result.get(Number(row.parent))!.push(Number(row.child));
    return result;
  }

  /** Completion/accounting follows the same owner-foreground applicability used by every reader.
   * Trigger origins never turn an inapplicable successor into a consumer. */
  applicableConsumingSuccessors(commitIds: readonly number[], path: KnowledgePath,
    snapshot?: PathSnapshot, prepared?: ReturnType<Store["commitGraphInput"]>): Map<number, number[]> {
    const successors = this.consumingSuccessors(commitIds);
    if (!commitIds.length) return successors;
    snapshot ??= this.pathSnapshot(path);
    const input = prepared ?? this.commitGraphInput();
    const facts = new Map<number, boolean>(), commits = new Map<number, boolean>();
    for (const [baseCommit, ids] of successors) successors.set(baseCommit, ids.filter(successorId => {
      const successor = input.metadata.revisions!.get(successorId);
      return !!successor && this.commitApplies(successor, path, snapshot, input.metadata, facts, commits);
    }));
    return successors;
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
          this.validateDreamingRun(input.run, path);
          if (input.operations.some(op => op.op === "create"))
            throw new Error("Dreamer cannot create knowledge without an explicit split parent");
        } else {
          if (input.run.kind !== "consolidation" && input.run.kind !== "manual")
            throw new Error(`${input.run.kind} has no knowledge commit authority`);
          // 76: C creates, updates and archives; merge/split stay the Dreamer's.
          const allowed = input.run.kind === "consolidation" ? new Set(["create", "update", "archive"]) : new Set(["create", "archive"]);
          const forbidden = input.operations.find(op => !allowed.has(op.op));
          if (forbidden) throw new Error(`${forbidden.op} belongs to the Dreamer and is not available to ${input.run.kind === "consolidation" ? "the Consolidator" : "manual memory"}`);
          if (input.run.kind === "manual" && input.operations.some(op => op.op === "archive") && this.dreamerSeatHeld(Date.now()))
            throw new Error("manual archive is unavailable while the Dreamer seat is held");
        }
        for (const op of input.operations) {
          const trustedDreaming = this.isDreamingRun(input.run);
          const authority = trustedDreaming ? this.dreamingAuthority(input.run) : undefined;
          const dreamingPool = authority ? this.dreamingRange(authority.rangeId)?.pool ?? null : null;
          const role: "consolidation" | "dreaming" | "manual" = trustedDreaming ? "dreaming" : input.run.kind === "consolidation" ? "consolidation" : "manual";
          const outcome = this.applyKnowledgeOperation(op, runId, projectId, sessionId, path, trustedDreaming, role, dreamingPool);
          if (outcome.ok) committed.push(...outcome.value);
          else throw new Error(outcome.reason);
        }
        for (const factId of input.consolidated ?? []) this.markConsolidated(factId, runId, projectId);
        if (input.finalizeResponse) {
          const finalResponse = input.finalizeResponse({ committed });
          this.db.prepare("UPDATE run_bodies SET response = ? WHERE run_id = ?").run(finalResponse, runId);
          this.db.prepare(`UPDATE runs SET usage_input = ?, usage_output = ?, usage_cache_read = ?, usage_cache_write = ?, usage_cost = ? WHERE id = ?`)
            .run(...this.usageColumns(finalResponse), runId);
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
      return { ok: false, ...failed };
    }
  }

  private applyKnowledgeOperation(op: KnowledgeOperationInput, runId: number, projectId: number,
    sessionId: number, path: KnowledgePath | null, dreaming = false, role: "consolidation" | "dreaming" | "manual" = "manual",
    dreamingPool: string | null = null): { ok: true; value: CommittedKnowledgeOp[] } | { ok: false; reason: string } {
    if (path && path.sessionId !== sessionId) return { ok: false, reason: "writer path must belong to the run session" };
    if (op.op === "merge" && (op.absorb.length !== 1 || op.absorb[0]!.baseCommit === op.intoBaseCommit))
      return { ok: false, reason: "merge requires id as the survivor and absorb as exactly one distinct other parent" };
    if (op.op === "merge" && op.intoKnowledgeId > op.absorb[0]!.knowledgeId)
      return { ok: false, reason: `merge survivor K${op.intoKnowledgeId} is newer than absorbed K${op.absorb[0]!.knowledgeId}; swap them: use K${op.absorb[0]!.knowledgeId}@${op.absorb[0]!.baseCommit} as the survivor and absorb K${op.intoKnowledgeId}@${op.intoBaseCommit}` };
    const targets = op.op === "create" ? [] : op.op === "merge"
      ? [{ knowledgeId: op.intoKnowledgeId, baseCommit: op.intoBaseCommit }, ...op.absorb]
      : [{ knowledgeId: op.knowledgeId, baseCommit: op.baseCommit }];
    // 76: baseProblem accepts an archived base for a Dreamer revival, both for a merge survivor and
    // for a plain update of the archived version (the "D reviews an archive" revoke/adjust path).
    const revivalTarget = op.op === "merge" ? { knowledgeId: op.intoKnowledgeId, baseCommit: op.intoBaseCommit }
      : op.op === "update" ? { knowledgeId: op.knowledgeId, baseCommit: op.baseCommit } : undefined;
    const revivalSurvivor = dreaming && revivalTarget !== undefined
      && this.getKnowledgeRevision(revivalTarget.knowledgeId, revivalTarget.baseCommit)?.op === "archive";
    const writerInput = targets.length ? this.commitGraphInput() : undefined;
    const writerGraph = writerInput ? this.commitGraph(path, undefined, undefined, writerInput) : undefined;
    const seen = new Set<number>();
    for (const target of targets) {
      const base = this.getKnowledgeRevision(target.knowledgeId, target.baseCommit);
      if (dreamingPool !== null && base) {
        const owner = placementOwner(this, { revision: base }, writerInput!.metadata);
        if (owner !== dreamingPool)
          return { ok: false, reason: `K${target.knowledgeId}@${target.baseCommit}: base belongs to ${owner}, outside Dreamer pool ${dreamingPool}` };
      }
      const bad = this.baseProblem(target.knowledgeId, target.baseCommit, path,
        revivalSurvivor && target.knowledgeId === revivalTarget!.knowledgeId && target.baseCommit === revivalTarget!.baseCommit, writerInput!.metadata);
      if (bad) return { ok: false, reason: bad };
      const validityProblem = this.resolvedBaseProblem(writerGraph!, target);
      if (validityProblem) return { ok: false, reason: validityProblem };
      if (seen.has(target.baseCommit)) return { ok: false, reason: "duplicate merge parent; a commit cannot absorb itself" };
      seen.add(target.baseCommit);
    }
    const prior = targets.length ? this.getKnowledgeRevision(targets[0]!.knowledgeId, targets[0]!.baseCommit)! : null;
    if (op.op === "merge") {
      const parentScopes = new Set(targets.map(target => this.getKnowledgeRevision(target.knowledgeId, target.baseCommit)!.scope));
      if (parentScopes.size !== 1 || !parentScopes.has(op.scope))
        return { ok: false, reason: "merge parents and result must share one scope" };
    }
    const scope = op.op === "archive" || op.op === "split" ? prior!.scope : op.scope;
    const supports = op.supports.length ? op.supports : dreaming
      ? [...new Set(targets.flatMap(target => this.getKnowledgeRevision(target.knowledgeId, target.baseCommit)!.supports))]
      : [];
    if ((!supports.length && (!dreaming || op.op === "create")) || supports.some(id => !Number.isSafeInteger(id) || id <= 0))
      return { ok: false, reason: "supports must not be empty" };
    if (typeof op.reason !== "string" || !op.reason.trim()) return { ok: false, reason: "reason must be a non-empty commit message" };
    const bad = this.citationProblem(supports, scope, path ?? this.knowledgePath(sessionId));
    if (bad) return { ok: false, reason: bad };
    const insertRevision = (knowledgeId: number, parentId: number | null, text: string, category: KnowledgeCategory, topics: string[], revisionOp: KnowledgeOp) => {
      const info = this.db.prepare(`INSERT INTO knowledge_revisions
        (knowledge_id, parent_id, text, category, scope, supports, support_semantics, op, reason, topics, run_id, created_at, actor_role)
        VALUES (?, ?, ?, ?, ?, ?, 'change', ?, ?, ?, ?, ?, ?)`).run(knowledgeId, parentId, text, category, scope,
          JSON.stringify(supports), revisionOp, op.reason, JSON.stringify(topics), runId, op.createdAt, role);
      return Number(info.lastInsertRowid);
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
    const text = op.op === "archive" ? "" : op.op === "merge" && op.text === undefined
      ? this.knowledgeRevision(Math.max(op.intoBaseCommit, op.absorb[0]!.baseCommit))!.text
      : op.text!;
    const commitId = insertRevision(knowledgeId, prior?.id ?? null, text,
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

  /** Current visible, non-archived revisions not yet processed by this owner pool. The shared
   * graph projection chooses one current revision before reader visibility; processing affects only
   * scheduling and never participates in that projection. */
  poolVersions(pool: string, path: KnowledgePath): KnowledgeWithRevision[] {
    return this.knowledgePools(path).find(value => value.pool === pool)?.versions ?? [];
  }

  pendingVersions(pool: string, path: KnowledgePath): PendingKnowledgeVersion[] {
    return this.knowledgePools(path).find(value => value.pool === pool)?.pending ?? [];
  }

  /** 76: the nearest ancestor of `revisionId`, walking the commit DAG's parent edges (ordinary
   * `parent_id` plus merge/split links, exactly the edges `commitGraphInput` already collected into
   * `parents`), that this pool has a processing record for — the version D last confirmed here.
   * Undefined when no ancestor has one (shown whole as `New`, as today). BFS gives the nearest one
   * on ties; only called for pending versions, and it walks no further than the first hit. */
  private nearestProcessedAncestor(revisionId: number, pool: string, parents: Map<number, number[]>,
    processed: ReadonlySet<string>): number | undefined {
    const seen = new Set<number>([revisionId]);
    let frontier = parents.get(revisionId) ?? [];
    while (frontier.length) {
      const next: number[] = [];
      for (const id of frontier) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (processed.has(`${pool}:${id}`)) return id;
        next.push(...(parents.get(id) ?? []));
      }
      frontier = next;
    }
    return undefined;
  }

  /** One operation-local value: resolve globally before scope filtering, render each current body
   * once, and batch processing history. Never retain this value across a mutation or transaction.
   * Read-only — Dreaming eligibility (`duePools`) and the facade's `knowledgePools`/`dreamingPending`
   * all read through here, never a writer's own validation — so ticket 80 opts this into the
   * per-session graph memo. */
  knowledgePools(path: KnowledgePath, dreamingTriggerTokens = DEFAULT_DREAMING_TRIGGER_TOKENS) {
    const projectId = this.getSession(path.sessionId)?.projectId;
    if (projectId === undefined) throw new Error(`Unknown session ${path.sessionId}`);
    const budgets = this.knowledgeBudgets(), input = this.commitGraphInput(undefined, path.sessionId);
    const pools = [["global", budgets.global], [`project:${projectId}`, budgets.project], [`session:${path.sessionId}`, budgets.session]] as const;
    const versions = new Map<string, KnowledgeWithRevision[]>(pools.map(([pool]) => [pool, []]));
    // 76: archives are pending too, but never count toward pool size or the injected block — they
    // keep their own list, and D's own archives are excluded up front (own output, never pending).
    const archivedVersions = new Map<string, KnowledgeWithRevision[]>(pools.map(([pool]) => [pool, []]));
    const allCurrent = this.commitGraph(path, undefined, undefined, input).current;
    const current = allCurrent.filter(revision => revision.op !== "archive");
    const archives = allCurrent.filter(revision => revision.op === "archive" && revision.actorRole !== "dreaming");
    const knowledge = new Map(this.db.prepare("SELECT * FROM knowledge WHERE id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify([...new Set([...current, ...archives].map(revision => revision.knowledgeId))]))
      .map(row => [Number(row.id), toKnowledge(row)]));
    for (const revision of current) versions.get(placementOwner(this, { revision }, input.metadata))?.push({ knowledge: knowledge.get(revision.knowledgeId)!, revision });
    for (const revision of archives) archivedVersions.get(placementOwner(this, { revision }, input.metadata))?.push({ knowledge: knowledge.get(revision.knowledgeId)!, revision });
    const history = this.db.prepare(`SELECT p.pool, p.revision_id FROM knowledge_processed p
      WHERE p.pool IN (SELECT value FROM json_each(?))`).all(JSON.stringify(pools.map(([pool]) => pool)));
    const processed = new Set(history.map(row => `${row.pool}:${row.revision_id}`));
    const states = new Map(this.db.prepare("SELECT * FROM knowledge_pool_state WHERE pool IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(pools.map(([pool]) => pool))).map(row => [String(row.pool), row]));
    return pools.map(([pool, budget]) => {
      const values = versions.get(pool)!;
      const rendered = new Map(values.map(value => [value.revision.id, renderKnowledge(value)]));
      const size = tokens(processedBlock(values, value => rendered.get(value.revision.id)!));
      // 76: baseline lookup, segmentation and diff run only for a pending version that has a
      // processed ancestor in this pool; a version with none is shown and weighed whole ("New").
      const pendingUpdates = values.filter(value => !processed.has(`${pool}:${value.revision.id}`)).map(value => {
        const baselineId = this.nearestProcessedAncestor(value.revision.id, pool, input.parents, processed);
        const baseline = baselineId === undefined ? undefined : input.metadata.revisions!.get(baselineId);
        if (!baseline) {
          const material = `New K${value.revision.knowledgeId}@${value.revision.id}:\n${rendered.get(value.revision.id)!}`;
          return { revisionId: value.revision.id, knowledgeId: value.revision.knowledgeId, pool, tokens: tokens(material), material };
        }
        const change = renderKnowledgeChange(value.revision.knowledgeId, baseline, value.revision);
        const material = `Changed K${value.revision.knowledgeId}@${value.revision.id} (from @${baseline.id}):\n${change.text}`;
        return { revisionId: value.revision.id, knowledgeId: value.revision.knowledgeId, pool, tokens: change.addedTokens + change.removedTokens, material };
      });
      // 76: an archive shows the body it removed (its parent, since the archive itself stores empty
      // text) whole, plus the diff from the baseline to that body when a baseline exists and differs
      // from it (case B: D confirmed A, C changed A to B, then archived B). Weight is always the
      // whole archived body, in case A and case B alike — never the diff.
      const pendingArchives = (archivedVersions.get(pool) ?? []).filter(value => !processed.has(`${pool}:${value.revision.id}`)).map(value => {
        const parent = value.revision.parentId === null ? undefined : input.metadata.revisions!.get(value.revision.parentId);
        if (!parent) throw new Error(`K${value.revision.knowledgeId}@${value.revision.id}: archive has no archived body`);
        const archivedBody = renderKnowledge({ knowledge: value.knowledge, revision: parent });
        const baselineId = this.nearestProcessedAncestor(value.revision.id, pool, input.parents, processed);
        const baseline = baselineId === undefined ? undefined : input.metadata.revisions!.get(baselineId);
        const diffLine = baseline && baseline.id !== parent.id ? `\n${renderKnowledgeChange(value.revision.knowledgeId, baseline, parent).text}` : "";
        // 76 review: the archive revision's own supports are the evidence that caused the archive
        // (e.g. F3), distinct from the archived body's own supports already inside `archivedBody`.
        // Show them explicitly, labelled as the archive's evidence, beside the body they retire.
        const evidenceLine = `\n  archive evidence: ${factAddresses(value.revision.supports)}`;
        const material = `Archived K${value.revision.knowledgeId}@${value.revision.id} (reason: ${value.revision.reason}):\n${archivedBody}${evidenceLine}${diffLine}`;
        return { revisionId: value.revision.id, knowledgeId: value.revision.knowledgeId, pool, tokens: tokens(archivedBody), material };
      });
      const pending = [...pendingUpdates, ...pendingArchives].sort((left, right) => left.revisionId - right.revisionId);
      let reason: DueKnowledgePool["reason"] | null = null;
      const pendingTokens = pending.reduce((sum, value) => sum + value.tokens, 0);
      const effectiveTrigger = Math.min(dreamingTriggerTokens, budget);
      if (pending.length && pendingTokens >= effectiveTrigger) reason = "pending";
      else if (size > budget) {
        const state = states.get(pool);
        // Pending always wins on the over-budget path. Only a fully deliberated residual may be
        // suppressed while its measured size and budget remain unchanged.
        if (pending.length || !state || Number(state.last_over_size) !== size || Number(state.last_over_budget) !== budget)
          reason = "over-budget";
      }
      return { pool, budget, tokens: size, versions: values, rendered, archived: archivedVersions.get(pool) ?? [], pending, reason };
    });
  }

  pendingPoolWeight(pool: string, path: KnowledgePath): number {
    return this.pendingVersions(pool, path).reduce((total, revision) => total + revision.tokens, 0);
  }

  processedCurrentVersions(values: readonly KnowledgeWithRevision[]): Set<number> {
    if (!values.length) return new Set();
    const rows = this.db.prepare(`SELECT p.pool, p.revision_id, r.scope, u.session_id, s.project_id
      FROM knowledge_processed p JOIN knowledge_revisions r ON r.id = p.revision_id
      LEFT JOIN runs u ON u.id = r.run_id LEFT JOIN sessions s ON s.id = u.session_id
      WHERE p.revision_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(values.map(value => value.revision.id)));
    return new Set(rows.filter(row => {
      const owner = row.scope === "global" ? "global" : row.scope === "session"
        ? `session:${row.session_id}` : `project:${row.project_id}`;
      return owner === String(row.pool);
    }).map(row => Number(row.revision_id)));
  }

  poolSizes(path: KnowledgePath): KnowledgePoolSize[] {
    return this.knowledgePools(path).map(({ pool, budget, tokens }) => ({ pool, budget, tokens }));
  }

  duePools(path: KnowledgePath, dreamingTriggerTokens = DEFAULT_DREAMING_TRIGGER_TOKENS): DueKnowledgePool[] {
    return this.knowledgePools(path, dreamingTriggerTokens).flatMap(({ pool, budget, tokens, pending, reason }) => reason ? [{ pool, budget, tokens, pending, reason }] : []);
  }

  private poolBudget(pool: string): number {
    const budgets = this.knowledgeBudgets();
    return pool === "global" ? budgets.global : pool.startsWith("project:") ? budgets.project : budgets.session;
  }

  /** One atomic admission snapshot covers discovery, claim availability and the frozen range.
   * Claim/range bookkeeping does not mutate knowledge, processing records or source cursors. */
  admitKnowledgePool(target: TaskTarget, executorId: string, borrowed = false, executorSessionId?: number,
    dreamingTriggerTokens = DEFAULT_DREAMING_TRIGGER_TOKENS) {
    return this.transaction(() => {
      if (!this.enabled(target.sessionId) || (executorSessionId !== undefined && !this.enabled(executorSessionId)))
        return { outcome: "dropped" as const };
      const pool = this.knowledgePools(target, dreamingTriggerTokens).find(value => value.reason !== null);
      if (!pool) return { outcome: "empty" as const };
      const claim = this.acquireAvailableClaim(target, "dreaming", executorId, borrowed, () => true, () => true);
      if (!claim) return { outcome: "dropped" as const };
      const range = this.retainProjectedPoolRange(target, pool, claim);
      return { outcome: "admitted" as const, claim, pool, range };
    });
  }

  /** Select and reserve from the same atomic projection. Only range/claim bookkeeping mutates
   * inside this operation; no caller can submit a stale prepared projection as write authority. */
  freezeKnowledgePool(target: TaskTarget, claim: TaskClaim, dreamingTriggerTokens = DEFAULT_DREAMING_TRIGGER_TOKENS) {
    return this.transaction(() => {
      const pool = this.knowledgePools(target, dreamingTriggerTokens).find(value => value.reason !== null);
      if (!pool) throw new Error("No Knowledge pool is due");
      return { pool, range: this.retainProjectedPoolRange(target, pool, claim) };
    });
  }

  /** Direct callers may reserve a below-trigger pending prefix with the same live-claim fence. */
  retainKnowledgePoolRange(target: TaskTarget, pool: string, claim: TaskClaim): DreamingRange {
    return this.transaction(() => {
      const projected = this.knowledgePools(target).find(value => value.pool === pool);
      if (!projected) throw new Error(`Pool ${pool} is not applicable to S${target.sessionId}`);
      return this.retainProjectedPoolRange(target, projected, claim);
    });
  }

  private retainProjectedPoolRange(target: TaskTarget, due: ReturnType<Store["knowledgePools"]>[number], claim: TaskClaim): DreamingRange {
    const pool = due.pool;
    return this.transaction(() => {
      this.requireClaim({ kind: "dreaming", sessionId: target.sessionId, branch: target.branch, createdAt: new Date().toISOString(), claim });
      const session = this.getSession(target.sessionId)!;
      if (!new Set(["global", `project:${session.projectId}`, `session:${session.id}`]).has(pool))
        throw new Error(`Pool ${pool} is not applicable to S${target.sessionId}`);
      const now = Date.now(), createdAt = new Date().toISOString();
      // An expired or replaced claim leaves audit history, not a reservation or retry queue.
      this.db.prepare(`UPDATE dreaming_ranges AS r SET closed_at = ? WHERE r.pool IS NOT NULL
        AND r.completed_run IS NULL AND r.closed_at IS NULL AND NOT EXISTS (
          SELECT 1 FROM task_claims c WHERE c.session_id = r.session_id AND c.phase = 'dreaming'
            AND c.token = r.claim_token AND c.expires_at > ?)`)
        .run(createdAt, now);
      const reserved = new Set((this.db.prepare(`SELECT e.event_id FROM dreaming_range_events e
        JOIN dreaming_ranges r ON r.id = e.range_id JOIN task_claims c
          ON c.session_id = r.session_id AND c.phase = 'dreaming' AND c.token = r.claim_token
        WHERE r.pool IS NOT NULL AND r.completed_run IS NULL AND r.closed_at IS NULL AND c.expires_at > ?`)
        .all(now) as { event_id: number }[]).map(row => row.event_id));
      if (!due.reason && !due.pending.length) throw new Error(`Pool ${pool} is not due`);
      const selected: PendingKnowledgeVersion[] = [];
      for (const revision of due.pending) {
        if (reserved.has(revision.revisionId)) continue;
        const candidate = ["Pending current knowledge:", ...selected.map(value => value.material), revision.material].join("\n");
        if (tokens(candidate) > this.poolBudget(pool)) break;
        selected.push(revision);
      }
      if (due.pending.length && !selected.length)
        throw new Error(`Pool ${pool}: oldest pending version with its complete framing exceeds ${this.poolBudget(pool)}`);
      const ids = selected.map(revision => revision.revisionId);
      const origin = this.triggerOrigin(target, target.triggerEntryId);
      const id = Number(this.db.prepare(`INSERT INTO dreaming_ranges
        (session_id,branch,head_turn_id,anchor,origin_session_id,origin_entry_ids,pool,claim_token,pending_revisions)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(target.sessionId, target.branch, target.headTurnId, ids[0] ?? null,
          origin?.sessionId ?? null, origin ? JSON.stringify(origin.entryIds) : null, pool, claim.token,
          JSON.stringify(due.pending.map(value => value.revisionId))).lastInsertRowid);
      for (const revisionId of ids) this.db.prepare("INSERT INTO dreaming_range_events VALUES (?,?)").run(id, revisionId);
      return this.dreamingRange(id)!;
    });
  }

  /** Record the exact frozen revisions and this run's own commits at terminal outcome. */
  completeKnowledgePoolRange(boundRun: RunInput, outcome: "success" | "failure" | "cancelled",
    skippedRevisionIds: readonly number[] = []): void {
    this.transaction(() => {
      const authority = this.dreamingAuthority(boundRun);
      if (!authority || !this.isDreamingRun(boundRun)) throw new Error("Trusted pool Dreamer run binding required");
      this.requireClaim(boundRun, true);
      const runId = authority.runId, range = this.dreamingRange(authority.rangeId);
      if (!range?.pool || range.closedAt !== null || range.sessionId !== boundRun.sessionId || range.claimToken !== boundRun.claim?.token)
        throw new Error("Knowledge pool completion requires its exact open range and claim");
      const own = this.db.prepare("SELECT * FROM knowledge_revisions WHERE run_id = ? ORDER BY id").all(runId).map(toKnowledgeRevision);
      const priorRun = this.getRun(runId);
      if (!priorRun) throw new Error(`run ${runId} does not exist`);
      this.updateRun(runId, { ...boundRun, request: boundRun.request ?? priorRun.request,
        response: boundRun.response ?? priorRun.response, mode: boundRun.mode ?? priorRun.mode, outcome });
      const frozen = new Set(range.eventIds);
      if (skippedRevisionIds.some(id => !Number.isSafeInteger(id) || !frozen.has(id)))
        throw new Error("Knowledge pool completion skips must be exact frozen revisions");
      const pairs = new Map<string, { pool: string; revisionId: number }>();
      for (const revisionId of skippedRevisionIds)
        pairs.set(`${range.pool}:${revisionId}`, { pool: range.pool, revisionId });
      for (const revision of own) {
        const owner = placementOwner(this, { revision });
        pairs.set(`${owner}:${revision.id}`, { pool: owner, revisionId: revision.id });
      }
      for (const pair of pairs.values()) this.db.prepare("INSERT OR IGNORE INTO knowledge_processed(pool,revision_id,run_id) VALUES (?,?,?)")
        .run(pair.pool, pair.revisionId, runId);
      const closed = this.db.prepare(`UPDATE dreaming_ranges SET completed_run = ?, closed_at = ?
        WHERE id = ? AND completed_run IS NULL AND closed_at IS NULL`).run(runId, new Date().toISOString(), range.id);
      if (closed.changes !== 1) throw new Error("Knowledge pool range was not closed atomically");
      // A pre-commit cancellation closes its reservation but does not service or suppress the pool:
      // a run that neither committed a revision nor skipped a version leaves no trace in pool state.
      const consumes = outcome !== "cancelled" || own.length > 0 || skippedRevisionIds.length > 0;
      if (consumes) {
        const path = { sessionId: range.sessionId, branch: range.branch, headTurnId: range.headTurnId };
        const size = this.knowledgePools(path).find(value => value.pool === range.pool)!;
        // A run with pending untouched material must not establish an excess-suppression baseline.
        // residual_revisions remains schema history only; admission no longer reads it.
        if (size.tokens > size.budget && !size.pending.length) {
          this.db.prepare(`INSERT INTO knowledge_pool_state(pool,last_over_size,last_over_budget,residual_revisions) VALUES (?,?,?,?)
            ON CONFLICT(pool) DO UPDATE SET last_over_size=excluded.last_over_size,last_over_budget=excluded.last_over_budget,
              residual_revisions=excluded.residual_revisions`).run(size.pool, size.tokens, size.budget, "[]");
        } else if (size.tokens <= size.budget) this.db.prepare("DELETE FROM knowledge_pool_state WHERE pool = ?").run(size.pool);
      }
    });
  }

  dreamingRange(id: number): DreamingRange | null {
    const row = this.db.prepare("SELECT * FROM dreaming_ranges WHERE id = ? AND completed_run IS NULL AND closed_at IS NULL").get(id);
    return row ? { id, sessionId: Number(row.session_id), branch: String(row.branch), headTurnId: Number(row.head_turn_id), anchor: Number(row.anchor),
      eventIds: this.db.prepare("SELECT event_id FROM dreaming_range_events WHERE range_id = ? ORDER BY event_id").all(id).map(r => Number(r.event_id)),
      origin: triggerOriginFromRow(row), pool: row.pool === null ? null : String(row.pool),
      claimToken: row.claim_token === null ? null : String(row.claim_token), closedAt: row.closed_at === null ? null : String(row.closed_at),
      pendingRevisionIds: JSON.parse(String(row.pending_revisions ?? "[]")) } : null;
  }

  openDreamingRange(sessionId: number, branch: string): DreamingRange | null {
    const row = this.db.prepare("SELECT id FROM dreaming_ranges WHERE session_id = ? AND branch = ? AND completed_run IS NULL AND closed_at IS NULL").get(sessionId, branch);
    return row ? this.dreamingRange(Number(row.id)) : null;
  }

  listTurns(sessionId: number): Turn[] {
    return this.db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY id").all(sessionId).map(toTurn);
  }

  findNativeTurn(sessionId: number, nativeLineage: string, nativeId: string): { turnId: number; kind: "turn" | "compaction" } | null {
    const row = this.db.prepare("SELECT turn_id, kind FROM native_turns WHERE session_id = ? AND native_lineage = ? AND native_id = ?")
      .get(sessionId, nativeLineage, nativeId) as { turn_id: number; kind: "turn" | "compaction" } | undefined;
    return row ? { turnId: row.turn_id, kind: row.kind } : null;
  }

  bindNativeTurn(sessionId: number, nativeLineage: string, nativeId: string, turnId: number, kind: "turn" | "compaction"): void {
    const turn = this.getTurn(turnId);
    if (!nativeLineage || !nativeId || turn?.sessionId !== sessionId || turn?.kind !== kind)
      throw new Error("invalid native Turn binding");
    const known = this.findNativeTurn(sessionId, nativeLineage, nativeId);
    if (known) {
      if (known.turnId !== turnId || known.kind !== kind) throw new Error("native Turn identity changed after persistence");
      return;
    }
    this.db.prepare("INSERT INTO native_turns (session_id, native_lineage, native_id, turn_id, kind) VALUES (?, ?, ?, ?, ?)")
      .run(sessionId, nativeLineage, nativeId, turnId, kind);
  }

  projectSessionIds(projectId: number): number[] {
    return (this.db.prepare("SELECT id FROM sessions WHERE project_id = ? ORDER BY id").all(projectId) as { id: number }[]).map(row => row.id);
  }

  /** 79 item 0: a legitimate full-row reader (`listRuns` consumers that show responses); joins the body. */
  listRuns(sessionId: number): Run[] {
    return this.db.prepare("SELECT r.*, b.request, b.response, b.origin_entry_ids FROM runs r JOIN run_bodies b ON b.run_id = r.id WHERE r.session_id = ? ORDER BY r.id").all(sessionId).map(toRun);
  }
  /** 22d: one row per run of a session, carrying its kind and the usage it recorded. `usage` is null
   * exactly when the run recorded no usage observation — a response without one, a cancelled run
   * whose usage is unknown, or a response that was not JSON at all. A run whose usage object exists
   * but is empty is an observation of zeros, and is reported as one; nothing here manufactures a zero
   * for a missing one (parent 22, "Capacity and accounting").
   *
   * 77: reads the five columns every writer of `response` now keeps in step with it (`usageColumns`),
   * never `response` itself. 79: `request`/`response` are no longer even on this table, so the split
   * makes the old covering `idx_runs_session_usage` redundant (dropped, item 0) — SCHEMA_SQL's plain
   * `idx_runs_session` answers `session_id = ?` and the now tiny row (no body columns) is cheap to
   * read directly for `kind`/`usage_*`, measured on the split tables. A direct `session_id = ?`
   * condition, not the optional-parameter form: that form lets the planner scan the whole table or
   * index as history grows. */
  listRunUsage(sessionId: number): { kind: RunKind; usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } | null }[] {
    const rows = this.db.prepare(`SELECT kind, usage_input, usage_output, usage_cache_read, usage_cache_write, usage_cost
      FROM runs INDEXED BY idx_runs_session WHERE session_id = ? ORDER BY id`).all(sessionId) as
      { kind: RunKind; usage_input: number | null; usage_output: number | null; usage_cache_read: number | null; usage_cache_write: number | null; usage_cost: number | null }[];
    return rows.map(row => ({ kind: row.kind, usage: row.usage_cost === null ? null :
      { input: row.usage_input!, output: row.usage_output!, cacheRead: row.usage_cache_read!, cacheWrite: row.usage_cache_write!, cost: row.usage_cost } }));
  }

  /** 51/77: the footer's daily figure — every run's cost, created at or after `since` (77 replaces a
   * per-refresh reparse of every run's `response`, 71's ruling, with the same figure read from the
   * persisted usage columns). 79: the split still needs a `created_at` lookup index (the ticket's own
   * "lookup indexes a query still needs stay"), but its old covering trailing columns (`id`,
   * `usage_cost`) are redundant now that the row has no body to dodge — `idx_runs_created_at`
   * replaces `idx_runs_daily_usage` (item 0). Rows read still grow with the day's runs, not history. */
  spendSince(since: string): number {
    const rows = this.db.prepare(`SELECT id, usage_cost FROM runs INDEXED BY idx_runs_created_at
      WHERE created_at >= ? ORDER BY id`).all(since) as { id: number; usage_cost: number | null }[];
    let cost = 0;
    for (const row of rows) if (row.usage_cost !== null) cost += row.usage_cost;
    return cost;
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

  declareProject(sessionId: number, name: string, source: "marker" | "mark", context?: ProjectDeclarationContext): Project {
    return this.transaction(() => {
      const session = this.getSession(sessionId);
      if (!session) throw new Error(`session S${sessionId} does not exist`);
      if (!["marker", "mark"].includes(source)) throw new Error("invalid project declaration source");
      if (!name.trim()) throw new Error("project name must not be empty");
      const prior = this.projectDeclaration(sessionId);
      if (source === "marker" && prior === "mark") return this.getProject(session.projectId)!;
      if (prior === "undeclared") {
        if (!context || context.path.sessionId !== sessionId || context.path.branch === undefined || context.path.headTurnId === null ||
            this.getTurn(context.path.headTurnId)?.sessionId !== sessionId)
          throw new Error("Project declaration requires the host's selected session path");
        for (const phase of ["noting", "consolidation"] as const) if (context.atTrigger(phase))
          throw new Error(`Project declaration rejected: ${phase} is due; run /trace catchup, then retry`);
        const live = this.db.prepare("SELECT phase FROM task_claims WHERE session_id = ? AND phase IN ('noting','consolidation') AND expires_at > ? ORDER BY phase LIMIT 1")
          .get(sessionId, Date.now()) as { phase: Phase } | undefined;
        if (live) throw new Error(`Project declaration rejected: ${live.phase} has a live claim; wait for it to finish, then retry`);
      }
      let target = this.findProjectByName(name) ?? this.createProject({ name, declaredBy: source });
      while (target.mergedInto !== null) target = this.getProject(target.mergedInto)!;
      if (session.projectId !== target.id) {
        if (prior === "undeclared") this.relabelProject(session.projectId, target.id);
        else this.requireProjectRelabelFence(session.projectId, target.id);
      }
      this.db.prepare("UPDATE sessions SET project_id = ?, project_declaration = ? WHERE id = ?").run(target.id, source, sessionId);
      return target;
    });
  }

  /** Ticket 81: today's full scan of every Turn and tool call, kept verbatim for queries too short for
   * a trigram (below three Unicode characters, where two-character CJK words are common). */
  private rawLikeScan(pattern: string, restricted: boolean, owners: string): string[] {
    return (this.db.prepare(`SELECT t.id FROM turns t WHERE
        (? = 0 OR t.session_id IN (SELECT value FROM json_each(?))) AND
        (t.user_prompt LIKE ? ESCAPE '\\' OR t.assistant_text LIKE ? ESCAPE '\\' OR EXISTS
        (SELECT 1 FROM tool_calls c WHERE c.turn_id = t.id AND
        (c.name LIKE ? ESCAPE '\\' OR c.input LIKE ? ESCAPE '\\' OR c.result LIKE ? ESCAPE '\\'))) ORDER BY t.id`)
        .all(Number(restricted), owners, pattern, pattern, pattern, pattern, pattern) as { id: number }[]).map((r) => `T${r.id}`);
  }

  /** Ticket 81: the index finds candidates, today's rule decides the hits (review of d9d8d84).
   * Step 1 -- `raw_fts MATCH` with the query as one quoted phrase against the default (case-folding)
   * trigram index: a superset of today's LIKE hits (Unicode case-folding is broader than LIKE's
   * ASCII-only fold), restricted to this scope's sessions and split into Turn-level candidate turn
   * ids and tool-call-level candidate (turn id, tool_call id) pairs by field.
   * Step 2 -- each candidate is re-checked against the real column value with today's exact
   * `LIKE … ESCAPE '\'` clause (never against raw_fts itself: FTS5 does not use the trigram index for
   * a LIKE with ESCAPE, confirmed by EXPLAIN QUERY PLAN on this SQLite -- a full scan). This is the
   * same WHERE clause `rawLikeScan` runs, merely restricted to `id IN (candidates)`, so a field that
   * only looked like a match under Unicode case-folding (`éco` candidate, `École`) is excluded exactly
   * as today, and a query spanning two fields (the end of a prompt, the start of a reply) never
   * candidates in the first place because each field is its own indexed row.
   * Step 3 -- candidates reduce to Turns (several matching tool calls of one Turn collapse to it once)
   * and are ordered by id, as today. */
  private rawTrigram(query: string, restricted: boolean, owners: string): string[] {
    const phrase = ftsPhraseQuery(query);
    const candidates = this.db.prepare(`SELECT e.turn_id AS turnId, e.tool_call_id AS toolCallId
        FROM raw_search_entries e JOIN raw_fts ON raw_fts.rowid = e.id
        WHERE raw_fts MATCH ? AND (? = 0 OR e.session_id IN (SELECT value FROM json_each(?)))`)
      .all(phrase, Number(restricted), owners) as { turnId: number; toolCallId: number | null }[];
    const turnIds = JSON.stringify([...new Set(candidates.filter(c => c.toolCallId === null).map(c => c.turnId))]);
    const toolCallIds = JSON.stringify([...new Set(candidates.filter(c => c.toolCallId !== null).map(c => c.toolCallId))]);
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const hits = new Set<number>();
    for (const row of this.db.prepare(`SELECT id FROM turns WHERE id IN (SELECT value FROM json_each(?))
        AND (user_prompt LIKE ? ESCAPE '\\' OR assistant_text LIKE ? ESCAPE '\\')`)
      .all(turnIds, pattern, pattern) as { id: number }[]) hits.add(row.id);
    for (const row of this.db.prepare(`SELECT DISTINCT turn_id AS id FROM tool_calls WHERE id IN (SELECT value FROM json_each(?))
        AND (name LIKE ? ESCAPE '\\' OR input LIKE ? ESCAPE '\\' OR result LIKE ? ESCAPE '\\')`)
      .all(toolCallIds, pattern, pattern, pattern) as { id: number }[]) hits.add(row.id);
    return [...hits].sort((a, b) => a - b).map(id => `T${id}`);
  }

  searchAddresses(query: string, scope: "facts" | "knowledge" | "all" | "raw", sessionIds?: readonly number[]): string[] {
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const owners = JSON.stringify(sessionIds ?? []), restricted = sessionIds !== undefined;
    // A NUL cannot appear in an FTS5 query string (it ends the phrase: "unterminated string"), so a
    // query holding one keeps the LIKE scan too, unchanged rather than stripped.
    const raw = () => unicodeLength(query) < 3 || query.includes("\u0000")
      ? this.rawLikeScan(pattern, restricted, owners) : this.rawTrigram(query, restricted, owners);
    if (scope === "raw") return raw();
    const facts = scope === "knowledge" ? [] : (this.db.prepare(`SELECT f.id FROM facts f JOIN turns t ON t.id = f.turn_id
      WHERE (? = 0 OR t.session_id IN (SELECT value FROM json_each(?))) AND f.text LIKE ? ESCAPE '\\' ORDER BY f.id`)
      .all(Number(restricted), owners, pattern) as { id: number }[]).map((r) => `F${r.id}`);
    // 21b: a label matches under the same literal semantics and escaping as the text. EXISTS over
    // json_each reads label values, never the JSON punctuation around them, and returns one row per
    // revision however many labels (or text and labels together) match. Knowledge membership is
    // resolved by the caller's path and version filter rather than by its author's session here.
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
    // 71: the recursive lineage above already restricts every candidate's turn to this session (its
    // own WHERE clauses), so the owner is known without a further lookup — one map instead of a
    // `SELECT * FROM turns WHERE id = ?` per fact (this call issued one per candidate, thousands on
    // a long branch). `factOnPath` still runs the same ownership check, just answered from this map.
    const owners = new Map(candidates.map(fact => [fact.turnId, sessionId]));
    // 80 item 3: one batched `fact_sources` read for the whole candidate list, not one per fact.
    const bound = this.factSourceEntries(candidates.map(fact => fact.id));
    return candidates.filter(fact => this.factOnPath(fact, path, view, undefined, owners, bound)); // every source on the path, not only the first
  }

  /** Ticket 69/72: a cheap composite that changes exactly when a commit could change
   * `consolidationBatch`, `duePools` or the footer's four cached counts — for ANY connection to this
   * database file, not only this process. Every database input those read is covered:
   *  - facts, knowledge revisions/links (a merge/split's `knowledge_links` row is written in the same
   *    commit as its `knowledge_revisions` row) and processed records are insert-only, so `MAX(id)`/
   *    `MAX(rowid)` is monotonic and exact for `facts`, `consolidated_facts`, `knowledge_revisions` and
   *    `knowledge_processed`;
   *  - project assignment and merges: every session's `project_id`, ordered by id and concatenated in one
   *    scan of `sessions` (145 rows on production, no schema change), so *any* session's declaration or
   *    reassignment — not only this reader's own — changes the signal; a merge additionally reassigns
   *    every session and knowledge row that shared the merged-away project in the same transaction as
   *    marking it merged, covered the same way, plus the count of merged projects as a second check.
   *    (Ticket 80, ruled "B": completes the signal — until this, only this reader's own `project_id` was
   *    read, so another session's declaration left a shared project's knowledge stale in this session's
   *    memoized graph, footer count and C/D arming alike, reproduced across two connections: A and B
   *    share a project and A sees B's project knowledge; B is moved to another project; A's signal was
   *    unchanged, so a reused graph kept showing knowledge that no longer applies.)
   *  - the knowledge budget policy (`knowledge_budget_policy`, a single point-lookup row) and the
   *    over-budget suppression state (`knowledge_pool_state`) of exactly the three pools this session's
   *    Dreaming can be due for (global, its project, itself) — bounded point lookups by primary key;
   *  - other sessions' current-path cursors (`session_lineage_cursors.version`, ticket 72: bumped only
   *    by a branch switch or a head moving back to an ancestor, never an ordinary forward move) and
   *    non-append rewrites of `source_paths` membership under an unchanged cursor
   *    (`source_paths.version`, ticket 72: bumped only where the path is written, by the writer's own
   *    prefix check) — both read as one indexed `MAX(version)` each. A bump takes its table's next
   *    version rather than adding one to its own row, so every bump in any row moves the maximum; a
   *    per-row counter would hide behind another row's higher one. Global rather than scoped to this
   *    session's own dependency set, so a change elsewhere may over-arm this session but Raw ingestion,
   *    which moves neither, never does.
   * Ingesting Raw touches none of these: `source_entries`/`turns` are deliberately absent, and an
   * ordinary forward head move or a pure append leaves every included column exactly as it was. */
  progressSignal(sessionId: number): string {
    const row = this.db.prepare(`SELECT
        (SELECT IFNULL(MAX(id), 0) FROM facts) AS f,
        (SELECT IFNULL(MAX(rowid), 0) FROM consolidated_facts) AS cf,
        (SELECT IFNULL(MAX(rowid), 0) FROM noted_entries) AS ne,
        (SELECT IFNULL(MAX(id), 0) FROM knowledge_revisions) AS kr,
        (SELECT IFNULL(MAX(rowid), 0) FROM knowledge_processed) AS kp,
        (SELECT group_concat(project_id, ',') FROM (SELECT project_id FROM sessions ORDER BY id)) AS pa,
        (SELECT COUNT(*) FROM projects WHERE merged_into IS NOT NULL) AS pm,
        (SELECT global_tokens || ':' || project_tokens || ':' || session_tokens FROM knowledge_budget_policy WHERE id = 1) AS bp,
        IFNULL((SELECT last_over_size || ':' || last_over_budget FROM knowledge_pool_state WHERE pool = 'global'), '') AS psg,
        IFNULL((SELECT last_over_size || ':' || last_over_budget FROM knowledge_pool_state
          WHERE pool = 'project:' || (SELECT project_id FROM sessions WHERE id = ?)), '') AS psp,
        IFNULL((SELECT last_over_size || ':' || last_over_budget FROM knowledge_pool_state WHERE pool = 'session:' || ?), '') AS pss,
        (SELECT IFNULL(MAX(version), 0) FROM session_lineage_cursors) AS cv,
        (SELECT IFNULL(MAX(version), 0) FROM source_paths) AS sv`)
      .get(sessionId, sessionId) as { f: number; cf: number; ne: number; kr: number; kp: number; pa: string | null; pm: number;
        bp: string; psg: string; psp: string; pss: string; cv: number; sv: number };
    return `${row.f}:${row.cf}:${row.ne}:${row.kr}:${row.kp}:${row.pa}:${row.pm}:${row.bp}:${row.psg}:${row.psp}:${row.pss}:${row.cv}:${row.sv}`;
  }
  /** Which of these branch facts Consolidation still owes work for: exact path-aware membership, one
   * fact at a time, never "every fact minus the cited ones" (22b, restated by 24a for the footer).
   * The one definition both the batch and the footer's second count are built from. */
  unconsolidated(facts: Fact[], path: KnowledgePath, snapshot = this.pathSnapshot(path)): Fact[] {
    if (!facts.length) return [];
    const rows = this.db.prepare(`SELECT fact_id, run_id FROM consolidated_facts
      WHERE fact_id IN (SELECT value FROM json_each(?))`)
      .all(JSON.stringify(facts.map(f => f.id))) as { fact_id: number; run_id: number }[];
    const missing = [...new Set(rows.map(row => row.run_id))].filter(id => !snapshot.consolidatedRuns.has(id));
    if (missing.length) {
      // A run's complete fact set, including facts from other sessions, must be on the path.
      // Batch across runs too: hundreds of one-fact runs must not mean hundreds of reads.
      const runFacts = this.db.prepare(`SELECT i.run_id AS consolidation_run_id, f.* FROM consolidated_facts i JOIN facts f ON f.id = i.fact_id
        WHERE i.run_id IN (SELECT value FROM json_each(?)) ORDER BY i.run_id, f.id`)
        .all(JSON.stringify(missing)) as (Record<string, unknown> & { consolidation_run_id: number })[];
      const all = runFacts.map(toFact);
      const owners = new Map(this.db.prepare(`SELECT id, session_id FROM turns
        WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify([...new Set(all.map(f => f.turnId))])).map(row => [Number(row.id), Number(row.session_id)]));
      const bound = this.factSourceEntries(all.map(f => f.id));
      const grouped = new Map<number, Fact[]>();
      for (let i = 0; i < runFacts.length; i++) {
        const runId = runFacts[i]!.consolidation_run_id;
        if (!grouped.has(runId)) grouped.set(runId, []);
        grouped.get(runId)!.push(all[i]!);
      }
      for (const id of missing) snapshot.consolidatedRuns.set(id,
        (grouped.get(id) ?? []).every(f => this.factOnPath(f, path, snapshot, undefined, owners, bound)));
    }
    const runs = new Map<number, number[]>();
    for (const row of rows) {
      if (!runs.has(row.fact_id)) runs.set(row.fact_id, []);
      runs.get(row.fact_id)!.push(row.run_id);
    }
    return facts.filter(f => !(runs.get(f.id) ?? []).some(id => snapshot.consolidatedRuns.get(id)));
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
      if (!runs.has(run_id)) {
        const facts = this.listConsolidatedFacts(run_id);
        // 71: one run's consolidated facts may span sessions, so ownership is genuinely queried
        // (never assumed) — just batched once per run instead of once per fact of that run.
        const owners = new Map(this.db.prepare("SELECT id, session_id FROM turns WHERE id IN (SELECT value FROM json_each(?))")
          .all(JSON.stringify([...new Set(facts.map(f => f.turnId))])).map(r => [Number(r.id), Number(r.session_id)]));
        // 80 item 3: one batched `fact_sources` read for this run's facts, not one per fact.
        const bound = this.factSourceEntries(facts.map(f => f.id));
        runs.set(run_id, facts.every((f) => this.factOnPath(f, path, snapshot, undefined, owners, bound)));
      }
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

  /** `known`, when passed (even `null`), replaces the internal duplicate-check query: a caller that
   * already resolved `findSourceEntry(input.sessionId, input.nativeLineage, input.nativeId)` for this
   * exact identity in the same synchronous flow (nothing else can write between the two calls) skips
   * repeating it. Omitted (the default), this queries exactly as before. */
  appendSourceEntry(input: SourceInput, known: SourceEntry | null | undefined = undefined): SourceEntry {
    return this.transaction(() => {
      this.requireEnabled(input.sessionId);
      if (typeof input.nativeLineage !== "string" || typeof input.nativeId !== "string" || typeof input.text !== "string" || typeof input.raw !== "string" ||
          !Array.isArray(input.calls) || input.calls.some(c => !Number.isSafeInteger(c.ordinal) || c.ordinal < 1 || typeof c.name !== "string" || !c.name || typeof c.callId !== "string" || !c.callId || /[\uD800-\uDFFF]/u.test(c.callId) || typeof c.status !== "string" || !c.status ||
            (c.input !== undefined && typeof c.input !== "string") || (c.result !== undefined && typeof c.result !== "string")) ||
          new Set(input.calls.map(c => c.callId)).size !== input.calls.length || new Set(input.calls.map(c => c.ordinal)).size !== input.calls.length || (input.role === "user" && input.calls.length) || (input.role === "toolResult" && input.text)) throw new Error("invalid source entry content");
      const turn = this.getTurn(input.turnId);
      if (!input.nativeLineage || !input.nativeId || !["user", "assistant", "toolResult"].includes(input.role) ||
          turn?.sessionId !== input.sessionId || turn?.kind !== "turn") throw new Error("invalid source entry identity or owning turn");
      if (known === undefined) known = this.findSourceEntry(input.sessionId, input.nativeLineage, input.nativeId);
      if (known) {
        const { id: _, entryOrdinal: _ordinal, blocks: _blocks, ...original } = known;
        if (JSON.stringify(original) !== JSON.stringify(input)) throw new Error("native source entry changed after persistence");
        return known;
      }
      const blocks = this.normalizeSource?.(input);
      if (!input.text && !input.calls.length && input.role !== "user" && !blocks?.length) throw new Error("empty source entry"); // an image-only user message still bounds a Turn
      const ordinal = Number(this.db.prepare("SELECT COALESCE(MAX(entry_ordinal), 0) + 1 AS n FROM source_entries WHERE turn_id = ?").get(input.turnId)!.n);
      if (!Number.isSafeInteger(ordinal)) throw new Error("Turn entry ordinal exhausted");
      const result = this.db.prepare("INSERT INTO source_entries (session_id, native_lineage, native_id, turn_id, entry_ordinal, addresses, digest) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(input.sessionId, input.nativeLineage, input.nativeId, input.turnId, ordinal,
          JSON.stringify(sourceAddresses({ ...input, id: 0, entryOrdinal: ordinal, blocks })), sourceDigest(input.raw));
      // 79: the Raw payload row, written in the same transaction as the hot row above (item 0's
      // "every writer writes both rows in one transaction" — a failure between them leaves neither,
      // since both inserts share this method's enclosing `this.transaction`).
      this.db.prepare("INSERT INTO source_entry_raw (entry_id, content, blocks) VALUES (?, ?, ?)")
        .run(result.lastInsertRowid, JSON.stringify(input), blocks ? JSON.stringify(blocks) : this.normalizeSource ? "null" : null);
      // 74: mirror call identities into the compact side table in the same write, so a later known-
      // entry rebuild never needs this row's `content` to answer them.
      if (input.calls.length) {
        const insertCall = this.db.prepare("INSERT INTO source_entry_calls (entry_id, turn_id, call_id, ordinal, name) VALUES (?, ?, ?, ?, ?)");
        for (const call of input.calls) insertCall.run(result.lastInsertRowid, input.turnId, call.callId, call.ordinal, call.name);
      }
      return this.getSourceEntry(Number(result.lastInsertRowid))!;
    });
  }
  /** 79 item 0: the one full-row reader every hydrator (bounded or one-shot) goes through. Joins the
   * hot row to its Raw payload row — the only place `source_entry_raw` is read. */
  getSourceEntry(id: number): SourceEntry | null {
    const row = this.db.prepare(`SELECT e.id, e.entry_ordinal, r.content, r.blocks FROM source_entries e
      JOIN source_entry_raw r ON r.entry_id = e.id WHERE e.id = ?`).get(id);
    return row ? toSourceEntry(row) : null;
  }
  /** 79: hydrate exactly the ids a consumer already chose, in one statement, in the requested order.
   * Never a loop of single `getSourceEntry` calls over a whole list (item 1). A consumer that decides
   * membership incrementally against a budget (compact's Raw span, the Noting batch, the branch-carry
   * suffix) instead hydrates one candidate at a time through `getSourceEntry`, because its final id
   * set is not known until each candidate is priced — the acceptance criteria's explicit allowance. */
  hydrateSourceEntries(ids: readonly number[]): SourceEntry[] {
    const unique = [...new Set(ids)];
    if (!unique.length) return [];
    const rows = this.db.prepare(`SELECT e.id, e.entry_ordinal, r.content, r.blocks FROM source_entries e
      JOIN source_entry_raw r ON r.entry_id = e.id WHERE e.id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(unique));
    const byId = new Map(rows.map(row => [Number((row as { id: number }).id), toSourceEntry(row)]));
    return ids.map(id => byId.get(id)).filter((entry): entry is SourceEntry => entry !== undefined);
  }
  findSourceEntry(sessionId: number, nativeLineage: string, nativeId: string): SourceEntry | null {
    const row = this.db.prepare("SELECT id FROM source_entries WHERE session_id = ? AND native_lineage = ? AND native_id = ?").get(sessionId, nativeLineage, nativeId) as { id: number } | undefined;
    return row ? this.getSourceEntry(row.id) : null;
  }
  /** 74: what a rebuild's known-entry check needs — never `content`/`blocks` (8.1 KB/4.2 KB on
   * average). 79: `content`/`blocks` are no longer even on this table, so the plain unique index the
   * table's own `UNIQUE (session_id, native_lineage, native_id)` constraint already creates answers
   * this lookup and the small row it returns needs no covering index of its own (74's idx_source_identity
   * dropped, item 0). This entry's own call identities (never its `input`/`result`) come from
   * `source_entry_calls`. The caller compares `digest` against `sourceDigest` of the same string it
   * compares today — a mismatch is reported exactly as a content mismatch was before this existed. */
  findKnownSourceEntry(sessionId: number, nativeLineage: string, nativeId: string):
    { id: number; turnId: number; digest: string; calls: { ordinal: number; name: string; callId: string }[] } | null {
    const row = this.db.prepare(`SELECT id, turn_id, digest FROM source_entries
      WHERE session_id = ? AND native_lineage = ? AND native_id = ?`).get(sessionId, nativeLineage, nativeId) as
      { id: number; turn_id: number; digest: string } | undefined;
    if (!row) return null;
    return { id: Number(row.id), turnId: Number(row.turn_id), digest: row.digest, calls: this.entryCallIdentities(row.id) };
  }
  private entryCallIdentities(entryId: number): { ordinal: number; name: string; callId: string }[] {
    return (this.db.prepare("SELECT call_id, ordinal, name FROM source_entry_calls WHERE entry_id = ? ORDER BY id").all(entryId) as
      { call_id: string; ordinal: number; name: string }[]).map(c => ({ ordinal: Number(c.ordinal), name: c.name, callId: c.call_id }));
  }
  /** 74: a Turn's call identities alone — call id, ordinal, name — for CC's `knownCalls()`, which used
   * to load every source entry of the Turn (`listSourceEntries`) only to read this. */
  turnCallIdentities(turnId: number): { ordinal: number; name: string; callId: string }[] {
    return (this.db.prepare("SELECT call_id, ordinal, name FROM source_entry_calls WHERE turn_id = ? ORDER BY id").all(turnId) as
      { call_id: string; ordinal: number; name: string }[]).map(c => ({ ordinal: Number(c.ordinal), name: c.name, callId: c.call_id }));
  }
  /** 22c: `turnId` narrows the read to one Turn's native occurrences, so a full trace of one tool
   * call loads that Turn instead of the whole session. The order — by entry id — is the same.
   * 23b: `branch` answers from that branch's selected native ancestry instead, in the branch's own
   * order, so an occurrence only a sibling branch selected is not part of this branch's trace. A
   * stored path restricts membership even when its selection is empty. Only an unbound read or
   * legacy data without a stored path falls back to session occurrences. Neither form loads Raw
   * payloads to decide membership. 79: returns metadata alone (item 1); a caller that renders any of
   * these occurrences hydrates the exact ids it kept through `hydrateSourceEntries`, once. */
  listSourceEntries(sessionId: number, turnId?: number, branch?: string): SourceEntryMeta[] {
    const selected = branch === undefined ? [] : this.db.prepare(
      `SELECT e.${SOURCE_ENTRY_META_COLUMNS.split(", ").join(", e.")} FROM source_paths p
       JOIN source_path_entries j ON j.path_id = p.id JOIN source_entries e ON e.id = j.entry_id
       WHERE p.session_id = ? AND p.branch = ? AND e.session_id = ? AND (? IS NULL OR e.turn_id = ?) ORDER BY j.position`)
      .all(sessionId, branch, sessionId, turnId ?? null, turnId ?? null);
    const hasPath = branch !== undefined && this.sourcePathState(sessionId, branch) !== null;
    // 74/79: INDEXED BY pins the turn-ordinal index (67) outright — without it, the planner's stat-free
    // cost estimate can prefer a session_id-prefixed plan instead, adding an unwanted sort.
    const rows = hasPath ? selected
      : (turnId === undefined
        ? this.db.prepare(`SELECT ${SOURCE_ENTRY_META_COLUMNS} FROM source_entries WHERE session_id = ? ORDER BY id`).all(sessionId)
        : this.db.prepare(`SELECT ${SOURCE_ENTRY_META_COLUMNS} FROM source_entries INDEXED BY idx_source_turn_ordinal WHERE turn_id = ? AND session_id = ? ORDER BY id`).all(turnId, sessionId));
    return rows.map(toSourceEntryMeta);
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
  sourcePathState(sessionId: number, branch: string): SourcePathState | null {
    const row = this.db.prepare("SELECT length, tail_entry_id, version FROM source_paths WHERE session_id = ? AND branch = ?")
      .get(sessionId, branch) as { length: number; tail_entry_id: number | null; version: number } | undefined;
    return row ? { count: row.length, tailId: row.tail_entry_id, version: row.version } : null;
  }
  selectedSourceEntryIds(sessionId: number, branch: string): number[] | null {
    const state = this.sourcePathState(sessionId, branch);
    if (!state) return null;
    // Return one ordered value rather than a JS row per member. Graph preparation batches the
    // ownership check; trigger admission and path writers validate their own selected entries.
    const row = this.db.prepare(`SELECT json_group_array(entry_id ORDER BY position) AS ids,
      MAX(position) AS last_position FROM source_path_entries
      WHERE path_id = (SELECT id FROM source_paths WHERE session_id = ? AND branch = ?)`)
      .get(sessionId, branch) as { ids: string; last_position: number | null };
    const ids = JSON.parse(row.ids) as number[];
    // Nonnegative, unique integer positions and this maximum also exclude a gap in the sequence.
    if (ids.length !== state.count || (ids.at(-1) ?? null) !== state.tailId ||
        row.last_position !== (ids.length ? ids.length - 1 : null))
      throw new Error("stored source path is malformed");
    return ids;
  }
  /** Full readers validate the rows they already need, not a second membership enumeration. */
  private validatePathMembers(state: SourcePathState,
    rows: { position: number; entry_id: number; owned_id: number | null }[]): void {
    if (rows.length !== state.count || (rows.at(-1)?.entry_id ?? null) !== state.tailId ||
        rows.some((row, index) => row.position !== index || row.owned_id !== row.entry_id))
      throw new Error("stored source path is malformed");
  }
  /** Resolve a persisted native ancestry without exposing source_paths storage to a host adapter.
   * A later extension of the same branch is eligible; a sibling that diverged before the prefix is not. */
  sourceBranchForPrefix(sessionId: number, entryIds: readonly number[], preferred?: string): string | null {
    if (!entryIds.length || entryIds.some(id => !Number.isSafeInteger(id) || id < 1)) return null;
    const matches = (this.db.prepare(`SELECT p.branch FROM source_paths p WHERE p.session_id = ? AND p.length >= ?
      AND NOT EXISTS (SELECT 1 FROM json_each(?) wanted WHERE NOT EXISTS
        (SELECT 1 FROM source_path_entries e WHERE e.path_id = p.id
         AND e.position = CAST(wanted.key AS INTEGER) AND e.entry_id = wanted.value)) ORDER BY p.branch`)
      .all(sessionId, entryIds.length, JSON.stringify(entryIds)) as { branch: string }[]).map(row => row.branch);
    return preferred && matches.includes(preferred) ? preferred : matches[0] ?? null;
  }
  /** Publish source selection and its lineage cursor atomically, validating the supplied identities
   * once without writing and then reparsing the full path. Other lineage cursors remain untouched. */
  publishSourcePath(sessionId: number, branch: string, entryIds: number[], headTurnId: number, lineage: string): void {
    this.transaction(() => {
      this.requireEnabled(sessionId);
      if (typeof lineage !== "string" || !lineage) throw new Error("current path requires a non-empty lineage");
      if (!branch || new Set(entryIds).size !== entryIds.length || entryIds.some(id => !Number.isSafeInteger(id) || id < 1))
        throw new Error("invalid source path");
      // Ownership from the covering index (71), not one Raw row per path entry: a foreign id is absent
      // and fails the check below exactly as a foreign session_id did.
      const rows = this.db.prepare(`SELECT id, turn_id, session_id FROM source_entries
        WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))`).all(sessionId, JSON.stringify(entryIds));
      const entries = new Map(rows.map(row => [Number(row.id), { turnId: Number(row.turn_id), sessionId: Number(row.session_id) }]));
      if (entryIds.some(id => entries.get(id)?.sessionId !== sessionId)) throw new Error("invalid source path");
      const headAncestry = this.pathTurns({ sessionId, headTurnId });
      const tail = entryIds.length ? entries.get(entryIds.at(-1)!)!.turnId : null;
      const tailAncestry = tail !== null && !headAncestry.has(tail) ? this.pathTurns({ sessionId, headTurnId: tail }) : undefined;
      const problem = this.pathCoherenceProblem(sessionId, branch, headTurnId, entryIds, entries, headAncestry, tailAncestry);
      if (problem) throw new Error(problem);
      this.writeSourcePath(sessionId, branch, entryIds);
      this.writeCurrentPath(sessionId, branch, headTurnId, lineage);
    });
  }

  /** Append a proven suffix against the exact persisted prefix. Unlike a full publication this
   * never reads old membership or walks the old head's ancestry. Navigations use publishSourcePath. */
  appendSourcePath(sessionId: number, branch: string, expected: SourcePathState, newEntryIds: number[],
    headTurnId: number, lineage: string): SourcePathState {
    return this.transaction(() => {
      this.requireEnabled(sessionId);
      const state = this.sourcePathState(sessionId, branch);
      if (!state || state.count !== expected.count || state.tailId !== expected.tailId || state.version !== expected.version)
        throw new StaleSourcePathError();
      // An empty path has no owned tail to anchor the head check. Validate the head itself for
      // every append, including head-only publications, before writing its lineage cursor.
      if (!this.db.prepare("SELECT 1 FROM turns WHERE id = ? AND session_id = ?").get(headTurnId, sessionId))
        throw new Error(`current path head T${headTurnId} is not a Turn of session S${sessionId}`);
      if (!branch || !lineage || new Set(newEntryIds).size !== newEntryIds.length ||
          newEntryIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw new Error("invalid source path tail");
      const rows = this.db.prepare(`SELECT id, turn_id FROM source_entries NOT INDEXED WHERE id IN
        (SELECT value FROM json_each(?)) AND session_id = ?`).all(JSON.stringify(newEntryIds), sessionId) as
        { id: number; turn_id: number }[];
      if (rows.length !== newEntryIds.length) throw new Error("invalid source path tail");
      const overlap = this.db.prepare(`SELECT 1 FROM source_path_entries WHERE path_id =
        (SELECT id FROM source_paths WHERE session_id = ? AND branch = ?)
        AND entry_id IN (SELECT value FROM json_each(?)) LIMIT 1`).get(sessionId, branch, JSON.stringify(newEntryIds));
      if (overlap) throw new Error("invalid source path tail: duplicate entry");
      const turns = new Map(rows.map(row => [row.id, row.turn_id]));
      const tailTurn = newEntryIds.length ? turns.get(newEntryIds.at(-1)!)! : null;
      const oldTail = state.tailId === null ? null : this.db.prepare("SELECT turn_id FROM source_entries WHERE id = ?")
        .get(state.tailId) as { turn_id: number } | undefined;
      if (state.tailId !== null && !oldTail) throw new Error("stored source path is malformed");
      // On an ordinary append the new tail and head must extend the old tail's Turn. A
      // headless/navigated or sibling path is intentionally delegated to full publication.
      const extendsTurn = (root: number, ancestor: number): boolean => {
        if (root === ancestor) return true;
        const direct = this.db.prepare("SELECT parent_turn_id FROM turns WHERE id = ? AND session_id = ?")
          .get(root, sessionId) as { parent_turn_id: number | null } | undefined;
        if (direct?.parent_turn_id === ancestor) return true;
        const row = this.db.prepare(`WITH RECURSIVE lineage(id,parent_turn_id) AS (
          SELECT id,parent_turn_id FROM turns WHERE id = ? AND session_id = ?
          UNION SELECT t.id,t.parent_turn_id FROM turns t JOIN lineage l
            ON t.id = l.parent_turn_id WHERE l.id != ? AND t.session_id = ?)
          SELECT 1 FROM lineage WHERE id = ? LIMIT 1`)
          .get(root, sessionId, ancestor, sessionId, ancestor);
        return !!row;
      };
      // Validate every transition in the new suffix, not just its final Turn. A middle sibling
      // followed by a valid final descendant would otherwise silently enter the selected path.
      let previousTurn = oldTail?.turn_id ?? null;
      for (const id of newEntryIds) {
        const turn = turns.get(id)!;
        if (previousTurn !== null && turn !== previousTurn && !extendsTurn(turn, previousTurn))
          throw new Error("source path tail is not an extension");
        previousTurn = turn;
      }
      if (!extendsTurn(headTurnId, tailTurn ?? oldTail?.turn_id ?? headTurnId))
        throw new Error("source path head is not an extension");
      if (!newEntryIds.length) {
        this.writeCurrentPath(sessionId, branch, headTurnId, lineage);
        return state;
      }
      const hwm = (this.db.prepare("SELECT hwm_entry_id FROM source_paths WHERE session_id = ? AND branch = ?")
        .get(sessionId, branch) as { hwm_entry_id: number }).hwm_entry_id;
      const restored = newEntryIds.some(id => id <= hwm);
      const nextVersion = restored ? Number(this.db.prepare("SELECT IFNULL(MAX(version), 0) + 1 AS next FROM source_paths").get()!.next) : state.version;
      const pathId = Number(this.db.prepare("SELECT id FROM source_paths WHERE session_id = ? AND branch = ?").get(sessionId, branch)!.id);
      const insert = this.db.prepare("INSERT INTO source_path_entries(path_id,position,entry_id) VALUES (?,?,?)");
      newEntryIds.forEach((id, position) => insert.run(pathId, state.count + position, id));
      const count = state.count + newEntryIds.length, tailId = newEntryIds.at(-1)!;
      this.db.prepare(`UPDATE source_paths SET length = ?, tail_entry_id = ?, version = ?, hwm_entry_id = ?
        WHERE session_id = ? AND branch = ?`).run(count, tailId, nextVersion, Math.max(hwm, ...newEntryIds), sessionId, branch);
      this.writeCurrentPath(sessionId, branch, headTurnId, lineage);
      return { count, tailId, version: nextVersion };
    });
  }

  /** Ticket 72: only the writer knows whether the new list extends the stored one — an unbroken
   * prefix relationship, the only shape an ordinary ingested-entry append ever produces. Any other
   * replacement (an entry removed, reordered, or a shorter list) is a membership rewrite the change
   * signal must observe, so it bumps `source_paths.version` — and so does an "extension" whose
   * appended id is at or below `hwm_entry_id`, the largest source_entries.id this row has ever held:
   * entry ids are AUTOINCREMENT in creation order, so a genuinely new entry always exceeds it, and only
   * a restored, previously-removed entry ([e1] -> [e1,e2] again after [e1,e2] -> [e1]) can be <= it.
   * The high-water mark only ever grows, so a path that was rewritten once and later only receives
   * genuinely new entries never keeps bumping — exact where a "once rewritten, bump forever" flag
   * would only approximate. A pure append of new entries leaves an unrewritten path's signal untouched. */
  private writeSourcePath(sessionId: number, branch: string, entryIds: number[]): void {
    const prior = this.selectedSourceEntryIds(sessionId, branch) ?? [];
    const row = this.db.prepare("SELECT hwm_entry_id FROM source_paths WHERE session_id = ? AND branch = ?")
      .get(sessionId, branch) as { hwm_entry_id: number } | undefined;
    const hwm = row?.hwm_entry_id ?? 0;
    const append = prior.length <= entryIds.length && prior.every((id, index) => entryIds[index] === id);
    const restored = append && entryIds.slice(prior.length).some(id => id <= hwm);
    const bump = !append || restored;
    const newHwm = entryIds.length ? Math.max(hwm, ...entryIds) : hwm;
    this.db.prepare(`INSERT INTO source_paths (session_id, branch, length, tail_entry_id, version, hwm_entry_id)
      VALUES (?, ?, ?, ?, 0, ?) ON CONFLICT (session_id, branch) DO UPDATE SET
      length = excluded.length, tail_entry_id = excluded.tail_entry_id,
      version = CASE WHEN ? THEN (SELECT MAX(version) + 1 FROM source_paths) ELSE version END, hwm_entry_id = ?`)
      .run(sessionId, branch, entryIds.length, entryIds.at(-1) ?? null, newHwm, bump ? 1 : 0, newHwm);
    const pathId = Number(this.db.prepare("SELECT id FROM source_paths WHERE session_id = ? AND branch = ?").get(sessionId, branch)!.id);
    this.db.prepare("DELETE FROM source_path_entries WHERE path_id = ?").run(pathId);
    const insert = this.db.prepare("INSERT INTO source_path_entries(path_id,position,entry_id) VALUES (?,?,?)");
    entryIds.forEach((id, position) => insert.run(pathId, position, id));
  }

  selectSourcePath(sessionId: number, branch: string, entryIds: number[]): void {
    return this.transaction(() => {
      this.requireEnabled(sessionId);
      // 22b: ownership is an identity question, so it is counted in one query instead of loading every
      // selected entry's Raw payload; duplicates are already rejected, so equal counts mean all owned.
      const owned = (this.db.prepare("SELECT COUNT(*) n FROM source_entries WHERE session_id = ? AND id IN (SELECT value FROM json_each(?))")
        .get(sessionId, JSON.stringify(entryIds)) as { n: number }).n;
      if (!branch || new Set(entryIds).size !== entryIds.length || owned !== entryIds.length) throw new Error("invalid source path");
      this.writeSourcePath(sessionId, branch, entryIds);
    });
  }
  /** The selected path's metadata in persisted branch order; no Raw payload is loaded. */
  private pathSourceMeta(sessionId: number, branch: string, headTurnId: number, prepared?: PathSnapshot): SourceEntryMeta[] {
    const turns = prepared?.turns ?? this.pathTurns({ sessionId, headTurnId });
    const header = this.sourcePathState(sessionId, branch);
    const rows = header ? this.db.prepare(`SELECT j.position, j.entry_id, e.id AS owned_id,
        e.${SOURCE_ENTRY_META_COLUMNS.split(", ").join(", e.")}
        FROM source_paths p JOIN source_path_entries j ON j.path_id = p.id
        LEFT JOIN source_entries e ON e.id = j.entry_id AND e.session_id = p.session_id
        WHERE p.session_id = ? AND p.branch = ? ORDER BY j.position`).all(sessionId, branch)
      : this.db.prepare(`SELECT ${SOURCE_ENTRY_META_COLUMNS} FROM source_entries WHERE session_id = ? ORDER BY id`).all(sessionId);
    if (header) this.validatePathMembers(header, rows as { position: number; entry_id: number; owned_id: number | null }[]);
    return rows.filter((r: any) => turns.has(Number(r.turn_id))).map(toSourceEntryMeta);
  }
  private pathEntryIds(sessionId: number, branch: string, headTurnId: number, prepared?: PathSnapshot): number[] {
    return this.pathSourceMeta(sessionId, branch, headTurnId, prepared).map(e => e.id);
  }
  sourceHeadEntryId(sessionId: number, branch: string, headTurnId: number, prepared?: PathSnapshot): number | undefined {
    return this.pathEntryIds(sessionId, branch, headTurnId, prepared).at(-1);
  }
  /** 79 item 1: metadata only, read from the hot table; no list read touches the payload table. A
   * consumer that renders any of these entries hydrates the exact ids it chose, through
   * `hydrateSourceEntries` (already decided) or one `getSourceEntry` per candidate while it is still
   * deciding membership against a budget (compact, the Noting batch, the branch-carry suffix). */
  sourcePath(sessionId: number, branch: string, headTurnId: number): SourceEntryMeta[] {
    return this.pathSourceMeta(sessionId, branch, headTurnId);
  }
  entryNoted(id: number): boolean {
    return !!this.db.prepare("SELECT 1 FROM noted_entries WHERE entry_id = ? LIMIT 1").get(id);
  }
  private pendingPath: { sessionId: number; branch: string; headTurnId: number;
    signal: string; path: SourcePathState | null; ids: PendingEntries; coversTail: boolean } | undefined;

  /** The queue is owned by Store and must not be mutated by callers. Its identity changes on a
   * rebuild; an append or local Noting prefix consumption retains it and the API's counted prefix. */
  pendingEntryState(sessionId: number, branch: string, headTurnId: number,
    prepare?: () => PathSnapshot): PendingEntries {
    const ownSnapshot = !this.db.isTransaction;
    const cached = ownSnapshot ? this.pendingPath : undefined;
    if (ownSnapshot) this.db.exec("BEGIN");
    try {
      // Read the signal, header, suffix and processing marks from one SQLite snapshot. Otherwise
      // an external note followed by an append can produce a pending set that never existed.
      const read = (): (() => PendingEntries) => {
        const signal = this.progressSignal(sessionId);
        const path = this.sourcePathState(sessionId, branch);
        // No header means session-occurrence fallback. Raw appends do not change the signal, so
        // that fallback is always fresh rather than pretending an absent path is a stable prefix.
        if (path && cached?.path && cached.sessionId === sessionId && cached.branch === branch && cached.signal === signal &&
            cached.path.version === path.version) {
          if (cached.path.count === path.count && cached.path.tailId === path.tailId &&
              (cached.headTurnId === headTurnId || (cached.coversTail &&
                this.pathExtendsHead({ sessionId, headTurnId }, cached.headTurnId)))) return () => {
            cached.headTurnId = headTurnId;
            return cached.ids;
          };
          // Every rewrite/restored entry bumps the version. The same version and a larger count
          // allow an indexed suffix read; historical-head answers must first cover the old tail.
          if (cached.coversTail && cached.path && path && path.count > cached.path.count) {
            const rows = this.db.prepare(`SELECT j.position, j.entry_id, e.turn_id FROM source_paths p
              JOIN source_path_entries j ON j.path_id = p.id
              JOIN source_entries e ON e.id = j.entry_id AND e.session_id = p.session_id
              WHERE p.session_id = ? AND p.branch = ? AND j.position >= ? ORDER BY j.position`)
              .all(sessionId, branch, cached.path.count) as { position: number; entry_id: number; turn_id: number }[];
            if (rows.length === path.count - cached.path.count && rows.at(-1)?.entry_id === path.tailId &&
                rows.every((row, i) => row.position === cached.path!.count + i)) {
              const direct = this.db.prepare("SELECT parent_turn_id, session_id FROM turns WHERE id = ?")
                .get(headTurnId) as { parent_turn_id: number | null; session_id: number } | undefined;
              const turns = direct?.session_id !== sessionId ? new Set<number>()
                : cached.headTurnId === headTurnId ? new Set([headTurnId])
                : direct.parent_turn_id === cached.headTurnId ? new Set([headTurnId, cached.headTurnId])
                : new Set(this.db.prepare(`WITH RECURSIVE lineage(id,parent_turn_id) AS (
                    SELECT id,parent_turn_id FROM turns WHERE id = ? AND session_id = ? UNION
                    SELECT t.id,t.parent_turn_id FROM turns t JOIN lineage l ON t.id = l.parent_turn_id
                    WHERE l.id != ? AND t.session_id = ?)
                    SELECT id FROM lineage`).all(headTurnId, sessionId, cached.headTurnId, sessionId).map(row => Number(row.id)));
              // Full publication also permits general selections that filter out sibling Turns.
              // Only extend this answer when every new entry actually belongs to the reader head.
              if (turns.has(cached.headTurnId) && rows.every(row => turns.has(row.turn_id))) {
                const newIds = rows.map(row => row.entry_id);
                const noted = new Set((this.db.prepare("SELECT entry_id FROM noted_entries WHERE entry_id IN (SELECT value FROM json_each(?))")
                  .all(JSON.stringify(newIds)) as { entry_id: number }[]).map(row => row.entry_id));
                const added = newIds.filter(id => !noted.has(id));
                return () => {
                  for (const id of added) cached.ids.append(id);
                  cached.path = path;
                  cached.headTurnId = headTurnId;
                  return cached.ids;
                };
              }
            }
          }
        }
        // The factory runs only on a miss, inside this read snapshot. A footer can reuse these
        // same validated members/ancestors for its other counts without passing a stale snapshot.
        const prepared = prepare?.();
        const ids = prepared?.entries ? [...prepared.entries.ids]
          : this.pathEntryIds(sessionId, branch, headTurnId, prepared);
        const noted = new Set((this.db.prepare("SELECT entry_id FROM noted_entries WHERE entry_id IN (SELECT value FROM json_each(?))")
          .all(JSON.stringify(ids)) as { entry_id: number }[]).map(row => row.entry_id));
        const pending = new PendingEntries(ids.filter(id => !noted.has(id)));
        return () => {
          if (ownSnapshot) this.pendingPath = { sessionId, branch, headTurnId, signal, path,
            ids: pending, coversTail: !path || (ids.at(-1) ?? null) === path.tailId };
          return pending;
        };
      };
      const publish = read();
      if (ownSnapshot) this.db.exec("COMMIT");
      // Nothing derived from a failed transaction, including an extended array, escapes rollback.
      return publish();
    } catch (error) {
      if (ownSnapshot && this.db.isTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Return a defensive copy; consumers of the hot due path use pendingEntryState directly. */
  pendingEntryIds(sessionId: number, branch: string, headTurnId: number, prepared?: PathSnapshot): number[] {
    if (prepared) {
      const ids = this.pathEntryIds(sessionId, branch, headTurnId, prepared);
      const noted = new Set((this.db.prepare("SELECT entry_id FROM noted_entries WHERE entry_id IN (SELECT value FROM json_each(?))")
        .all(JSON.stringify(ids)) as { entry_id: number }[]).map(r => r.entry_id));
      return ids.filter(id => !noted.has(id));
    }
    return [...this.pendingEntryState(sessionId, branch, headTurnId)];
  }
  /** 79 item 1: metadata only, same contract as `sourcePath` above. */
  pendingEntries(sessionId: number, branch: string, headTurnId: number): SourceEntryMeta[] {
    const all = this.pathSourceMeta(sessionId, branch, headTurnId);
    const noted = new Set((this.db.prepare("SELECT entry_id FROM noted_entries WHERE entry_id IN (SELECT value FROM json_each(?))")
      .all(JSON.stringify(all.map(e => e.id))) as { entry_id: number }[]).map(r => r.entry_id));
    return all.filter(e => !noted.has(e.id));
  }
}
