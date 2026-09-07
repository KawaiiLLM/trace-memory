// core/store — node:sqlite behind one plain interface. No abstraction over SQLite;
// this is the only place that knows a database exists. Schema: .scratch/v1/spec.md (Schema).
// Global ids: turns, facts, and knowledge use SQLite's per-table AUTOINCREMENT, which never
// reuses an id and is not reset per session or project — that is the "global id" the spec asks for.

import { DatabaseSync } from "node:sqlite";
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
  PendingDelivery,
  Project,
  Run,
  RunKind,
  RunOutcome,
  Session,
  ToolCall,
  Turn,
  Watermark,
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
  started_at TEXT NOT NULL,
  first_reply_at TEXT NOT NULL,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  parent_session_id INTEGER REFERENCES sessions(id),
  project_declaration TEXT NOT NULL DEFAULT 'marker' CHECK (project_declaration IN ('undeclared','marker','mark'))
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
  op TEXT NOT NULL CHECK (op IN ('create','update','merge','archive')),
  because TEXT,
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL,
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
  kind TEXT NOT NULL CHECK (kind IN ('recording','integration','manual')),
  session_id INTEGER REFERENCES sessions(id),
  branch TEXT,
  range_from TEXT,
  range_to TEXT,
  prompt_hash TEXT,
  model TEXT,
  mode TEXT,
  request TEXT,
  response TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','cancelled','bounced')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS knowledge_marks (
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id),
  commit_id INTEGER NOT NULL UNIQUE REFERENCES knowledge_revisions(id),
  kind TEXT NOT NULL CHECK (kind IN ('verified','flagged')),
  created_at TEXT NOT NULL,
  FOREIGN KEY (knowledge_id, commit_id) REFERENCES knowledge_revisions(knowledge_id, id)
);

CREATE TABLE IF NOT EXISTS pending_deliveries (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  branch TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS watermarks (
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  branch TEXT NOT NULL,
  last_recorded_turn INTEGER REFERENCES turns(id),
  last_integrated_fact INTEGER REFERENCES facts(id),
  PRIMARY KEY (session_id, branch)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
`;

// ---- Input shapes ----

export interface CreateProjectInput {
  name: string;
  declaredBy: "marker" | "mark";
}

export interface CreateSessionInput {
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

export interface RunInput {
  kind: RunKind;
  sessionId?: number | null;
  branch?: string | null;
  rangeFrom?: string | null;
  rangeTo?: string | null;
  promptHash?: string | null;
  model?: string | null;
  mode?: string | null;
  request?: string | null;
  response?: string | null;
  createdAt: string;
}

export interface RecordingRelationTarget {
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
  support?: RecordingRelationTarget[];
  negate?: RecordingRelationTarget[];
}

export interface CommitRecordingRunInput {
  run: RunInput; // sessionId required: every turn, watermark, and delivery must belong to it
  facts: FactCommitInput[];
  responseForFacts?: (ids: number[]) => string;
  watermark?: { sessionId: number; branch: string; lastRecordedTurn: number };
  pendingDelivery?: { sessionId: number; branch: string | null };
}

export type CommitRecordingResult =
  | { ok: true; runId: number; facts: Fact[] }
  | { ok: false; runId: number; problems: string[] };

export type KnowledgeOperationInput =
  | {
      op: "create";
      handle: string; // system-generated candidate label
      because?: number[];
      author: string;
      text: string;
      category: KnowledgeCategory;
      scope: KnowledgeScope;
      supports: number[];
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
      because: number[];
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
      because: number[];
      createdAt: string;
    }
  | {
      op: "archive";
      knowledgeId: number;
      baseCommit: number;
      because: number[];
      createdAt: string;
    };

export type KnowledgePath = { sessionId: number; headTurnId: number | null };
export interface KnowledgeFilter { scope?: KnowledgeScope; projectId?: number }

export interface CommitIntegrationRunInput {
  path?: KnowledgePath | null;
  run: RunInput; // sessionId required: knowledge ownership is derived from the run's session
  operations: KnowledgeOperationInput[];
  // Runs inside the transaction after application, so diagnostics observe the committed knowledge set.
  finalizeResponse?: (result: { committed: CommittedKnowledgeOp[] }) => string;
  watermark?: { sessionId: number; branch: string; lastIntegratedFact: number };
}

export interface CommittedKnowledgeOp {
  op: KnowledgeOp;
  handle?: string;
  knowledgeId: number;
  commit: number;
}

export type CommitIntegrationResult =
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
    id: row.id,
    knowledgeId: row.knowledge_id,
    parentId: row.parent_id,
    text: row.text,
    category: row.category,
    scope: row.scope,
    supports: JSON.parse(row.supports),
    op: row.op,
    because: row.because ? JSON.parse(row.because) : null,
    runId: row.run_id,
    createdAt: row.created_at,
  };
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
    outcome: row.outcome,
    createdAt: row.created_at,
  };
}

// ---- Store ----

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA foreign_keys = ON;");
    // Another process may hold a short write lock (its own recording or integration commit); wait instead of failing.
    // Commits run as immediate transactions: a deferred one that reads first and then writes gets
    // SQLITE_BUSY at once, without the busy handler, when a writer is already active.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // Preserve nested transactions with savepoints: project declaration nests a merge.
  private transaction<T>(fn: () => T): T {
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
      this.db.prepare("UPDATE projects SET merged_into = ? WHERE id = ?").run(intoProjectId, fromProjectId);
      this.db.prepare("UPDATE sessions SET project_id = ? WHERE project_id = ?").run(intoProjectId, fromProjectId);
      this.db.prepare("UPDATE knowledge SET project_id = ? WHERE project_id = ?").run(intoProjectId, fromProjectId);
    });
  }

  // -- sessions --

  /** A session row — and its id — exists only once the first assistant reply exists. */
  createSession(input: CreateSessionInput): Session {
    if (!input.firstReplyAt) {
      throw new Error("a session is allocated an id only once an assistant reply exists (firstReplyAt is required)");
    }
    const info = this.db.prepare("INSERT INTO sessions (host, started_at, first_reply_at, project_id, parent_session_id, project_declaration) VALUES (?, ?, ?, ?, ?, ?)").run(input.host, input.startedAt, input.firstReplyAt, input.projectId, input.parentSessionId ?? null, input.projectDeclaration ?? "marker");
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  getSession(id: number): Session | null {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : null;
  }

  // -- turns & tool calls --

  appendTurn(input: AppendTurnInput): Turn {
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
  }

  /** Raw is recorded incrementally: the turn row exists from the prompt; text and end time land when the turn ends. */
  updateTurn(id: number, patch: { assistantText?: string | null; endedAt?: string | null }): Turn {
    const turn = this.getTurn(id);
    if (!turn) throw new Error(`turn T${id} does not exist`);
    this.db.prepare("UPDATE turns SET assistant_text = ?, ended_at = ? WHERE id = ?").run(
      patch.assistantText === undefined ? turn.assistantText : patch.assistantText,
      patch.endedAt === undefined ? turn.endedAt : patch.endedAt,
      id,
    );
    return this.getTurn(id)!;
  }

  getTurn(id: number): Turn | null {
    const row = this.db.prepare("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? toTurn(row) : null;
  }

  appendToolCall(input: AppendToolCallInput): ToolCall {
    const ordinalRow = this.db
      .prepare("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM tool_calls WHERE turn_id = ?")
      .get(input.turnId) as { next: number };
    const info = this.db.prepare("INSERT INTO tool_calls (turn_id, ordinal, name, input, result, status) VALUES (?, ?, ?, ?, ?, ?)").run(input.turnId, ordinalRow.next, input.name, input.input ?? null, input.result ?? null, input.status);
    const row = this.db.prepare("SELECT * FROM tool_calls WHERE id = ?").get(Number(info.lastInsertRowid));
    return toToolCall(row);
  }

  listToolCalls(turnId: number): ToolCall[] {
    return this.db.prepare("SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY ordinal").all(turnId).map(toToolCall);
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

  // -- runs (standalone: failure / cancelled, or a run with nothing else to commit) --

  recordRun(input: RunInput & { outcome: RunOutcome }): Run {
    return this.getRun(this.insertRun(input))!;
  }

  updateRun(id: number, input: RunInput & { outcome: RunOutcome }): void {
    const previous = this.getRun(id);
    if (!previous) throw new Error(`run ${id} does not exist`);
    const factIds = (this.db.prepare("SELECT id FROM facts WHERE run_id = ? ORDER BY id").all(id) as { id: number }[]).map((f) => f.id);
    const response = JSON.parse(input.response ?? "{}");
    this.db.prepare("UPDATE runs SET request = ?, response = ?, outcome = ?, mode = ? WHERE id = ?")
      .run(input.request ?? null, JSON.stringify({ ...response, ...(previous.kind === "recording" || factIds.length ? { factIds } : {}) }), input.outcome, input.mode ?? null, id);
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

  /**
   * Commit one recording run: the run record and its facts (with relations) as one transaction.
   * A relation target is either "F<id>" (an existing fact) or "$n" (the n-th fact of this
   * same batch, 1-based, resolved to its freshly assigned id inside this transaction).
   * On any failure (e.g. an out-of-range local handle) nothing but the run record is written,
   * with outcome "failure" — the run record is always written, business writes are not.
   */
  commitRecordingRun(input: CommitRecordingRunInput): CommitRecordingResult {
    try {
      const result = this.transaction(() => {
        const sessionId = this.requireRunSession(input.run);
        const branch = input.run.branch ?? null;
        if (input.watermark && (input.watermark.sessionId !== sessionId || input.watermark.branch !== branch)) {
          throw new Error(`watermark S${input.watermark.sessionId}/${input.watermark.branch} does not belong to this run (S${sessionId}/${branch})`);
        }
        if (input.pendingDelivery && (input.pendingDelivery.sessionId !== sessionId || (input.pendingDelivery.branch ?? null) !== branch)) {
          throw new Error(`pending delivery S${input.pendingDelivery.sessionId}/${input.pendingDelivery.branch} does not belong to this run (S${sessionId}/${branch})`);
        }
        const runId = this.insertRun({ ...input.run, outcome: "success" });
        const batchIds: number[] = [];
        for (const f of input.facts) {
          const turn = this.getTurn(f.turnId);
          if (!turn || turn.sessionId !== sessionId) {
            throw new Error(`turn T${f.turnId} does not belong to session S${sessionId}`);
          }
          const info = this.db.prepare("INSERT INTO facts (run_id, turn_id, category, actor, text, quote, status, source, source_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(runId, f.turnId, f.category, f.actor, f.text, f.quote ?? null, f.status ?? null, JSON.stringify(f.source), f.createdAt);
          batchIds.push(Number(info.lastInsertRowid));
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
          for (const rel of f.support ?? []) {
            this.db.prepare("INSERT INTO fact_relations (from_fact, to_fact, kind, strength) VALUES (?, ?, 'support', ?)").run(
              fromFact,
              resolve(rel.target, i),
              rel.strength,
            );
          }
          for (const rel of f.negate ?? []) {
            this.db.prepare("INSERT INTO fact_relations (from_fact, to_fact, kind, strength) VALUES (?, ?, 'negate', ?)").run(
              fromFact,
              resolve(rel.target, i),
              rel.strength,
            );
          }
        });
        let response: Record<string, unknown>;
        try { const parsed = JSON.parse(input.responseForFacts?.(batchIds) ?? input.run.response ?? "{}"); response = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { output: parsed }; }
        catch { response = { output: input.run.response }; }
        this.db.prepare("UPDATE runs SET response = ? WHERE id = ?").run(JSON.stringify({ ...response, factIds: batchIds }), runId);
        if (input.watermark) {
          this.setWatermark(input.watermark.sessionId, input.watermark.branch, input.watermark.lastRecordedTurn, undefined);
        }
        if (input.pendingDelivery && batchIds.length) {
          this.addPendingDelivery(runId, input.pendingDelivery.sessionId, input.pendingDelivery.branch);
        }
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
      throw new Error(`store unavailable: ${why} (while recording failure: ${reason})`);
    }
  }

  private requireRunSession(run: RunInput): number {
    if (run.sessionId === undefined || run.sessionId === null) throw new Error("a committed run must name its session");
    if (!this.getSession(run.sessionId)) throw new Error(`session S${run.sessionId} does not exist`);
    return run.sessionId;
  }

  private insertRun(input: RunInput & { outcome: RunOutcome }): number {
    const info = this.db.prepare(`INSERT INTO runs (kind, session_id, branch, range_from, range_to, prompt_hash, model, mode, request, response, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        input.kind,
        input.sessionId ?? null,
        input.branch ?? null,
        input.rangeFrom ?? null,
        input.rangeTo ?? null,
        input.promptHash ?? null,
        input.model ?? null,
        input.mode ?? null,
        input.request ?? null,
        input.response ?? null,
        input.outcome,
        input.createdAt,
      );
    return Number(info.lastInsertRowid);
  }

  // -- knowledge & revisions --

  getKnowledge(id: number): Knowledge | null {
    const row = this.db.prepare("SELECT * FROM knowledge WHERE id = ?").get(id);
    return row ? toKnowledge(row) : null;
  }

  getKnowledgeWithRevision(id: number, path: KnowledgePath | null = null): KnowledgeWithRevision | null {
    const tips = this.currentCommit(id, path);
    if (tips.length > 1) throw new Error(`K${id}: several tips; use ${tips.map(r => `K${id}@${r.id}`).join(", ")}`);
    return tips.length ? { knowledge: this.getKnowledge(id)!, revision: tips[0]! } : null;
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

  pathTurns(path: KnowledgePath): Set<number> {
    if (!this.getSession(path.sessionId)) throw new Error(`session S${path.sessionId} does not exist`);
    const ids = new Set<number>();
    let id = path.headTurnId;
    while (id !== null) {
      const turn = this.getTurn(id);
      if (!turn || turn.sessionId !== path.sessionId || ids.has(id)) throw new Error("invalid path ancestry");
      ids.add(id); id = turn.parentTurnId;
    }
    return ids;
  }

  /** Compatibility for callers without a host head: use the branch's latest recorded or manual turn. */
  knowledgePath(sessionId: number, branch?: string, headTurnId?: number | null): KnowledgePath {
    if (headTurnId !== undefined) return { sessionId, headTurnId };
    if (branch === undefined) return { sessionId, headTurnId: this.listTurns(sessionId).at(-1)?.id ?? null };
    const recorded = this.getWatermark(sessionId, branch)?.lastRecordedTurn ?? 0;
    const manual = this.listRuns(sessionId).filter(r => r.kind === "manual" && r.branch === branch)
      .map(r => Number(/\/T(\d+)$/.exec(r.rangeTo ?? "")?.[1] ?? 0));
    return { sessionId, headTurnId: Math.max(recorded, ...manual) || null };
  }

  private admits(revision: KnowledgeRevision, sessionId: number): boolean {
    if (revision.scope === "global") return true;
    const origin = revision.runId === null ? null : this.getRun(revision.runId)?.sessionId;
    if (revision.scope === "session") return origin === sessionId;
    return origin != null && this.getSession(origin)?.projectId === this.getSession(sessionId)?.projectId;
  }

  /** All citations from the reader's own session constrain applicability, including because. */
  private currentSet(path: KnowledgePath | null, projectId?: number): KnowledgeWithRevision[] {
    const turns = path ? this.pathTurns(path) : undefined;
    const revisions = this.db.prepare("SELECT * FROM knowledge_revisions ORDER BY id").all().map(toKnowledgeRevision);
    const parents = new Map(revisions.map(r => [r.id, r.parentId === null ? [] : [r.parentId]]));
    for (const link of this.db.prepare("SELECT from_commit, to_commit FROM knowledge_links WHERE kind = 'merged_into'").all() as { from_commit: number; to_commit: number }[]) {
      parents.get(link.to_commit)!.push(link.from_commit);
    }
    const applicable = revisions.filter(r => (projectId === undefined || r.scope === "global" ||
      (r.scope === "project" && r.runId !== null && this.getSession(this.getRun(r.runId)!.sessionId!)?.projectId === projectId)) &&
      (!path || this.commitApplies(r, path, turns)));
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
    return applicable.filter(r => !superseded.has(r.id)).map(revision => ({ knowledge: this.getKnowledge(revision.knowledgeId)!, revision }));
  }

  factOnPath(fact: Fact, path: KnowledgePath, turns = this.pathTurns(path)): boolean {
    return this.getTurn(fact.turnId)!.sessionId !== path.sessionId ||
      (turns.has(fact.turnId) && fact.source.every(source => turns.has(Number(/^T([1-9]\d*)#/.exec(source)?.[1]))));
  }

  commitApplies(commit: KnowledgeRevision, path: KnowledgePath, turns = this.pathTurns(path)): boolean {
    return this.admits(commit, path.sessionId) && [...commit.supports, ...(commit.because ?? [])]
      .every(id => this.factOnPath(this.getFact(id)!, path, turns));
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

  listCurrentKnowledge(path: KnowledgePath | null = null, filter: KnowledgeFilter = {}): KnowledgeWithRevision[] {
    return this.currentSet(path, filter.projectId).filter(({ revision: r }) => r.op !== "archive" &&
      (!filter.scope || r.scope === filter.scope));
  }

  isKnowledgeVisible(id: number, sessionId: number, commitId?: number): boolean {
    return commitId === undefined ? this.currentCommit(id, this.knowledgePath(sessionId)).length > 0
      : !!this.getKnowledgeRevision(id, commitId) && this.admits(this.getKnowledgeRevision(id, commitId)!, sessionId);
  }

  listVisibleKnowledge(sessionId: number, projectId: number, headTurnId?: number | null): KnowledgeWithRevision[] {
    return sessionId ? this.listCurrentKnowledge(this.knowledgePath(sessionId, undefined, headTurnId))
      : this.listCurrentKnowledge(null, { projectId });
  }

  citationProblem(ids: number[], scope: KnowledgeScope, path: KnowledgePath): string | null {
    const turns = this.pathTurns(path), projectId = this.getSession(path.sessionId)!.projectId;
    for (const id of ids) {
      const fact = this.getFact(id);
      if (!fact) return `cited fact F${id} does not exist`;
      const sessionId = this.getTurn(fact.turnId)!.sessionId;
      if (sessionId === path.sessionId) {
        if (!this.factOnPath(fact, path, turns)) return `F${id}: record an adoption fact on this path first`;
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
    const current = this.currentCommit(knowledgeId, path);
    if (current.some(r => r.id === base && r.op !== "archive")) return null;
    const descendants = this.commitDescendants(base);
    const tips = this.currentSet(path).filter(k => k.knowledge.id === knowledgeId || descendants.has(k.revision.id));
    return `K${knowledgeId}@${base}: target moved on or is inactive; current: ${tips.map(k => `K${k.knowledge.id}@${k.revision.id}`).join(", ") || "none (inapplicable)"}; re-read and resubmit`;
  }

  /**
   * Commit one integration run: the run record and its knowledge operations as one transaction.
   * An operation whose base commit has an applicable successor on the writer's path
   * (someone else moved it since the Integrator read it) rolls back the batch and records failure.
   */
  commitIntegrationRun(input: CommitIntegrationRunInput): CommitIntegrationResult {
    try {
      const result = this.transaction(() => {
        const sessionId = this.requireRunSession(input.run);
        const projectId = this.getSession(sessionId)!.projectId;
        if (input.watermark && (input.watermark.sessionId !== sessionId || input.watermark.branch !== (input.run.branch ?? null))) {
          throw new Error(`watermark S${input.watermark.sessionId}/${input.watermark.branch} does not belong to this run (S${sessionId}/${input.run.branch ?? null})`);
        }
        const runId = this.insertRun({ ...input.run, outcome: "success" });
        const committed: CommittedKnowledgeOp[] = [];
        for (const op of input.operations) {
          const outcome = this.applyKnowledgeOperation(op, runId, projectId, sessionId, input.path === undefined ? this.knowledgePath(sessionId) : input.path);
          if (outcome.ok) committed.push(outcome.value);
          else throw new Error(outcome.reason);
        }
        if (input.watermark) {
          this.setWatermark(sessionId, input.watermark.branch, undefined, input.watermark.lastIntegratedFact);
        }
        if (input.finalizeResponse) {
          this.db.prepare("UPDATE runs SET response = ? WHERE id = ?").run(input.finalizeResponse({ committed }), runId);
        }
        return { runId, committed };
      });
      return { ok: true, ...result };
    } catch (err) {
      const run = { ...input.run };
      if (input.finalizeResponse && run.response) {
        try { run.response = JSON.stringify({ ...JSON.parse(run.response), problems: [err instanceof Error ? err.message : String(err)] }); }
        catch { /* Preserve non-JSON responses supplied by direct store callers. */ }
      }
      return { ok: false, ...this.recordFailure(run, err) };
    }
  }

  private applyKnowledgeOperation(op: KnowledgeOperationInput, runId: number, projectId: number,
    sessionId: number, path: KnowledgePath | null): { ok: true; value: CommittedKnowledgeOp } | { ok: false; reason: string } {
    if (path && path.sessionId !== sessionId) return { ok: false, reason: "writer path must belong to the run session" };
    if (op.op === "merge") op = { ...op, absorb: op.absorb.filter((a, i, all) => all.findIndex(b => b.knowledgeId === a.knowledgeId && b.baseCommit === a.baseCommit) === i) };
    const targets = op.op === "create" ? [] : op.op === "merge"
      ? [{ knowledgeId: op.intoKnowledgeId, baseCommit: op.intoBaseCommit }, ...op.absorb]
      : [{ knowledgeId: op.knowledgeId, baseCommit: op.baseCommit }];
    const seen = new Set<number>();
    for (const target of targets) {
      const bad = this.baseProblem(target.knowledgeId, target.baseCommit, path);
      if (bad) return { ok: false, reason: bad };
      if (seen.has(target.baseCommit)) return { ok: false, reason: "duplicate merge parent; a commit cannot absorb itself" };
      seen.add(target.baseCommit);
    }
    if (op.op === "merge" && !op.absorb.length) return { ok: false, reason: "merge: nothing to absorb" };
    const prior = targets.length ? this.getKnowledgeRevision(targets[0]!.knowledgeId, targets[0]!.baseCommit)! : null;
    const scope = op.op === "archive" ? prior!.scope : op.scope;
    const supports = op.op === "archive" ? [] : op.supports;
    if (op.op !== "archive" && !supports.length) return { ok: false, reason: "supports must not be empty" };
    const citations = [...supports, ...(op.because ?? [])];
    const bad = this.citationProblem(citations, scope, path ?? this.knowledgePath(sessionId));
    if (bad) return { ok: false, reason: bad };
    const knowledgeId = op.op === "create" ? Number(this.db.prepare(
      "INSERT INTO knowledge (project_id, origin_session_id, author) VALUES (?, ?, ?)",
    ).run(projectId, sessionId, op.author).lastInsertRowid) : targets[0]!.knowledgeId;
    const info = this.db.prepare(`INSERT INTO knowledge_revisions (knowledge_id, parent_id, text, category, scope, supports, op, because, run_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(knowledgeId, prior?.id ?? null, op.op === "archive" ? "" : op.text,
      op.op === "archive" ? prior!.category : op.category, scope, JSON.stringify(supports), op.op,
      JSON.stringify(op.because ?? []), runId, op.createdAt);
    const commitId = Number(info.lastInsertRowid);
    if (op.op === "merge") for (const parent of op.absorb) {
      this.db.prepare("INSERT INTO knowledge_links (from_knowledge, from_commit, kind, to_knowledge, to_commit) VALUES (?, ?, 'merged_into', ?, ?)")
        .run(parent.knowledgeId, parent.baseCommit, knowledgeId, commitId);
    }
    return { ok: true, value: { op: op.op, ...(op.op === "create" ? { handle: op.handle } : {}), knowledgeId, commit: commitId } };
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

  // -- pending deliveries --

  addPendingDelivery(runId: number, sessionId: number, branch: string | null): void {
    this.db.prepare("INSERT INTO pending_deliveries (run_id, session_id, branch, delivered_at) VALUES (?, ?, ?, NULL)").run(
      runId,
      sessionId,
      branch,
    );
  }

  listPendingDeliveries(sessionId: number, branch: string | null): PendingDelivery[] {
    return this.db
      .prepare("SELECT * FROM pending_deliveries WHERE session_id = ? AND branch IS ? AND delivered_at IS NULL")
      .all(sessionId, branch)
      .map((row: any) => ({ runId: row.run_id, sessionId: row.session_id, branch: row.branch, deliveredAt: row.delivered_at }));
  }

  clearPendingDelivery(runId: number, deliveredAt: string): void {
    this.db.prepare("UPDATE pending_deliveries SET delivered_at = ? WHERE run_id = ?").run(deliveredAt, runId);
  }

  listTurns(sessionId: number): Turn[] {
    return this.db.prepare("SELECT * FROM turns WHERE session_id = ? ORDER BY id").all(sessionId).map(toTurn);
  }

  listRuns(sessionId: number): Run[] {
    return this.db.prepare("SELECT * FROM runs WHERE session_id = ? ORDER BY id").all(sessionId).map(toRun);
  }
  listFactsByRun(runId: number): Fact[] {
    return this.db.prepare("SELECT * FROM facts WHERE run_id = ? ORDER BY id").all(runId).map(toFact);
  }
  listCommitsByRun(runId: number): KnowledgeRevision[] {
    return this.db.prepare("SELECT * FROM knowledge_revisions WHERE run_id = ? ORDER BY id").all(runId).map(toKnowledgeRevision);
  }
  listRunsSince(createdAt: string): Run[] {
    return this.db.prepare("SELECT * FROM runs WHERE created_at >= ? ORDER BY id").all(createdAt).map(toRun);
  }

  listWatermarks(sessionId: number): Watermark[] {
    return (this.db.prepare("SELECT branch FROM watermarks WHERE session_id = ? ORDER BY branch").all(sessionId) as { branch: string }[])
      .map((r) => this.getWatermark(sessionId, r.branch)!);
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
      this.db.prepare("UPDATE sessions SET project_id = ?, project_declaration = ? WHERE id = ?").run(target.id, source, sessionId);
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

  /** Renders the pending deliveries without consuming them; the host confirms the run ids it persisted. */
  deliver(sessionId: number, branch: string | null, render: (facts: Fact[]) => string): { text: string; runIds: number[] } {
    return this.transaction(() => {
      const pending = this.listPendingDeliveries(sessionId, branch);
      const facts = pending.flatMap((p) => this.db.prepare("SELECT * FROM facts WHERE run_id = ? ORDER BY id").all(p.runId).map(toFact));
      return { text: render(facts), runIds: pending.map((p) => p.runId) };
    });
  }
  confirmDeliveries(runIds: number[]): void {
    const at = new Date().toISOString();
    this.transaction(() => { for (const runId of runIds) this.clearPendingDelivery(runId, at); });
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
    const knowledge = scope === "facts" ? [] : (this.db.prepare(`SELECT knowledge_id, id FROM knowledge_revisions
      WHERE text LIKE ? ESCAPE '\\' ORDER BY knowledge_id, id`)
      .all(pattern) as { knowledge_id: number; id: number }[]).map((r) => `K${r.knowledge_id}@${r.id}`);
    return scope === "all" ? [...facts, ...knowledge, ...raw()] : [...facts, ...knowledge];
  }

  // -- watermarks --

  /** Branch facts follow the ancestry frozen by the latest successful recording. */
  /** Facts on the branch's path: every fact whose turn lies on the ancestor chain of the head (given, or the branch's latest known turn), manual facts included. */
  listBranchFacts(sessionId: number, branch: string, headTurnId?: number | null): Fact[] {
    const root = headTurnId ?? this.knowledgePath(sessionId, branch).headTurnId;
    if (!root) return [];
    return this.db.prepare(`WITH RECURSIVE lineage(id, parent_turn_id) AS (
      SELECT t.id, t.parent_turn_id FROM turns t WHERE t.id = ? AND t.session_id = ?
      UNION
      SELECT t.id, t.parent_turn_id FROM turns t JOIN lineage l ON t.id = l.parent_turn_id
      WHERE t.session_id = ?
    ) SELECT f.* FROM facts f WHERE f.turn_id IN (SELECT id FROM lineage) ORDER BY f.id`)
      .all(root, sessionId, sessionId).map(toFact)
      .filter(fact => this.factOnPath(fact, { sessionId, headTurnId: root })); // every source on the path, not only the first
  }

  /** The nearest ancestor of the head (or the head itself) covered by a successful recording run's range, for a new branch's watermark. */
  lastRecordedAncestor(sessionId: number, headTurnId: number): number | null {
    const recorded = new Set<number>();
    for (const run of this.listRuns(sessionId)) {
      if (run.kind !== "recording" || run.outcome !== "success" || !run.rangeFrom || !run.rangeTo) continue;
      const from = Number(/\/T(\d+)$/.exec(run.rangeFrom)?.[1]), to = Number(/\/T(\d+)$/.exec(run.rangeTo)?.[1]);
      for (let id: number | null = to; id; id = this.getTurn(id)?.parentTurnId ?? null) { recorded.add(id); if (id === from) break; }
    }
    for (let id: number | null = headTurnId; id; id = this.getTurn(id)?.parentTurnId ?? null) if (recorded.has(id)) return id;
    return null;
  }

  listIntegratedProjectFacts(projectId: number): Fact[] {
    const watermarks = this.db.prepare(`SELECT w.* FROM watermarks w JOIN sessions s ON s.id = w.session_id
      WHERE s.project_id = ? AND w.last_integrated_fact IS NOT NULL`).all(projectId) as any[];
    const ids = new Set(watermarks.flatMap((w) => this.listBranchFacts(w.session_id, w.branch)
      .filter((f) => f.id <= w.last_integrated_fact).map((f) => f.id)));
    return this.listProjectFacts(projectId).filter((f) => ids.has(f.id));
  }

  getWatermark(sessionId: number, branch: string): Watermark | null {
    const row = this.db.prepare("SELECT * FROM watermarks WHERE session_id = ? AND branch = ?").get(sessionId, branch);
    return row ? { sessionId: (row as any).session_id, branch: (row as any).branch, lastRecordedTurn: (row as any).last_recorded_turn, lastIntegratedFact: (row as any).last_integrated_fact } : null;
  }

  setWatermark(sessionId: number, branch: string, lastRecordedTurn: number | undefined, lastIntegratedFact: number | undefined): void {
    const existing = this.getWatermark(sessionId, branch);
    this.db.prepare(`INSERT INTO watermarks (session_id, branch, last_recorded_turn, last_integrated_fact) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, branch) DO UPDATE SET last_recorded_turn = excluded.last_recorded_turn, last_integrated_fact = excluded.last_integrated_fact`).run(sessionId, branch, lastRecordedTurn ?? existing?.lastRecordedTurn ?? null, lastIntegratedFact ?? existing?.lastIntegratedFact ?? null);
  }
}
