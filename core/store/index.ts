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
  status TEXT NOT NULL CHECK (status IN ('active','merged','archived')) DEFAULT 'active',
  author TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS knowledge_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_id INTEGER NOT NULL REFERENCES knowledge(id),
  rev INTEGER NOT NULL,
  text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('constraint','open','dispute','goal','mechanism','term','reference')),
  scope TEXT NOT NULL CHECK (scope IN ('session','project','global')),
  supports TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('create','update','merge','archive')),
  because TEXT,
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL,
  UNIQUE (knowledge_id, rev)
);

CREATE TABLE IF NOT EXISTS knowledge_links (
  from_knowledge INTEGER NOT NULL,
  from_rev INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('merged_into','split_from')),
  to_knowledge INTEGER NOT NULL,
  to_rev INTEGER NOT NULL,
  PRIMARY KEY (from_knowledge, from_rev, kind, to_knowledge, to_rev),
  FOREIGN KEY (from_knowledge, from_rev) REFERENCES knowledge_revisions(knowledge_id, rev),
  FOREIGN KEY (to_knowledge, to_rev) REFERENCES knowledge_revisions(knowledge_id, rev)
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
  rev INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('verified','flagged')),
  created_at TEXT NOT NULL,
  UNIQUE (knowledge_id, rev)
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

CREATE INDEX IF NOT EXISTS idx_knowledge_project_status ON knowledge(project_id, status);
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
      expectedRevision: number;
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
      intoExpectedRevision: number;
      absorb: { knowledgeId: number; expectedRevision: number }[];
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
      expectedRevision: number;
      because: number[];
      createdAt: string;
    };

export interface CommitIntegrationRunInput {
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
  rev: number;
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
  return { id: row.id, projectId: row.project_id, status: row.status, author: row.author, currentRevision: row.current_revision };
}

function toKnowledgeRevision(row: any): KnowledgeRevision {
  return {
    id: row.id,
    knowledgeId: row.knowledge_id,
    rev: row.rev,
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

  getKnowledgeWithRevision(id: number): KnowledgeWithRevision | null {
    const knowledge = this.getKnowledge(id);
    if (!knowledge) return null;
    const revision = this.getKnowledgeRevision(id, knowledge.currentRevision)!;
    return { knowledge, revision };
  }

  getKnowledgeRevision(knowledgeId: number, rev: number): KnowledgeRevision | null {
    const row = this.db.prepare("SELECT * FROM knowledge_revisions WHERE knowledge_id = ? AND rev = ?").get(knowledgeId, rev);
    return row ? toKnowledgeRevision(row) : null;
  }

  listKnowledgeLinks(knowledgeId: number): KnowledgeLink[] {
    return (this.db.prepare(
      "SELECT * FROM knowledge_links WHERE from_knowledge = ? ORDER BY from_rev, kind, to_knowledge, to_rev",
    ).all(knowledgeId) as any[]).map((r) => ({
      fromKnowledge: r.from_knowledge, fromRev: r.from_rev, kind: r.kind, toKnowledge: r.to_knowledge, toRev: r.to_rev,
    }));
  }

  listKnowledgeRevisions(knowledgeId: number): KnowledgeRevision[] {
    return this.db
      .prepare("SELECT * FROM knowledge_revisions WHERE knowledge_id = ? ORDER BY rev ASC")
      .all(knowledgeId)
      .map(toKnowledgeRevision);
  }

  /**
   * Knowledge visible to a session: global knowledge, this project's project-scope knowledge,
   * and this session's own session-scope knowledge. A session-scope knowledge's owning session
   * is its immutable origin_session_id.
   */
  isKnowledgeVisible(id: number, sessionId: number, rev?: number): boolean {
    const knowledge = this.getKnowledge(id), session = this.getSession(sessionId);
    if (!knowledge || !session) return false;
    const revision = this.getKnowledgeRevision(id, rev ?? knowledge.currentRevision);
    if (!revision) return false;
    if (revision.scope === "global") return true;
    if (knowledge.projectId !== session.projectId) return false;
    if (revision.scope === "project") return true;
    return !!this.db.prepare("SELECT 1 FROM knowledge WHERE id = ? AND origin_session_id = ?").get(id, sessionId);
  }

  listVisibleKnowledge(sessionId: number, projectId: number): KnowledgeWithRevision[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, r.id AS rev_id, r.rev AS rev_rev, r.text AS rev_text, r.category AS rev_category,
                r.scope AS rev_scope, r.supports AS rev_supports, r.op AS rev_op, r.because AS rev_because,
                r.run_id AS rev_run_id, r.created_at AS rev_created_at
         FROM knowledge e
         JOIN knowledge_revisions r ON r.knowledge_id = e.id AND r.rev = e.current_revision
         WHERE e.status = 'active'
           AND (
             r.scope = 'global'
             OR (r.scope = 'project' AND e.project_id = ?)
             OR (r.scope = 'session' AND e.project_id = ? AND e.origin_session_id = ?)
           )
         ORDER BY e.id ASC`,
      )
      .all(projectId, projectId, sessionId) as any[];
    return rows.map((row) => ({
      knowledge: toKnowledge(row),
      revision: toKnowledgeRevision({
        id: row.rev_id,
        knowledge_id: row.id,
        rev: row.rev_rev,
        text: row.rev_text,
        category: row.rev_category,
        scope: row.rev_scope,
        supports: row.rev_supports,
        op: row.rev_op,
        because: row.rev_because,
        run_id: row.rev_run_id,
        created_at: row.rev_created_at,
      }),
    }));
  }

  /**
   * Commit one integration run: the run record and its knowledge operations as one transaction.
   * An operation whose expected revision no longer matches the knowledge's current revision
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
          const outcome = this.applyKnowledgeOperation(op, runId, projectId, sessionId);
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

  /** Every fact an operation cites must exist; the text's evidence (supports) must not be empty. */
  private checkCitedFacts(op: string, supports: number[] | null, because: number[]): string | null {
    if (supports && supports.length === 0) return `${op}: supports must not be empty`;
    for (const id of [...(supports ?? []), ...because]) {
      if (!this.getFact(id)) return `${op}: cited fact F${id} does not exist`;
    }
    return null;
  }

  private applyKnowledgeOperation(
    op: KnowledgeOperationInput,
    runId: number,
    projectId: number,
    sessionId: number,
  ): { ok: true; value: CommittedKnowledgeOp } | { ok: false; reason: string } {
    // Ownership follows scope: a global knowledge belongs to no project; anything narrower belongs to the run's project.
    const owner = (scope: KnowledgeScope): number | null => (scope === "global" ? null : projectId);

    if (op.op === "create") {
      const bad = this.checkCitedFacts("create", op.supports, op.because ?? []);
      if (bad) return { ok: false, reason: bad };
      const info = this.db.prepare("INSERT INTO knowledge (project_id, origin_session_id, status, author, current_revision) VALUES (?, ?, 'active', ?, 1)").run(
        owner(op.scope),
        sessionId,
        op.author,
      );
      const knowledgeId = Number(info.lastInsertRowid);
      this.insertRevision(knowledgeId, 1, op.text, op.category, op.scope, op.supports, "create", op.because ?? null, runId, op.createdAt);
      return { ok: true, value: { op: "create", handle: op.handle, knowledgeId, rev: 1 } };
    }

    if (op.op === "update") {
      const knowledge = this.getKnowledge(op.knowledgeId);
      if (!knowledge || knowledge.status !== "active" || knowledge.currentRevision !== op.expectedRevision) {
        return { ok: false, reason: this.conflictReason(op.knowledgeId, op.expectedRevision, knowledge) };
      }
      const bad = this.checkCitedFacts(`edit K${op.knowledgeId}`, op.supports, op.because);
      if (bad) return { ok: false, reason: bad };
      const nextRev = knowledge.currentRevision + 1;
      this.insertRevision(op.knowledgeId, nextRev, op.text, op.category, op.scope, op.supports, "update", op.because, runId, op.createdAt);
      this.db.prepare("UPDATE knowledge SET current_revision = ?, project_id = ? WHERE id = ?").run(nextRev, owner(op.scope), op.knowledgeId);
      return { ok: true, value: { op: "update", knowledgeId: op.knowledgeId, rev: nextRev } };
    }

    if (op.op === "merge") {
      const into = this.getKnowledge(op.intoKnowledgeId);
      if (!into || into.status !== "active" || into.currentRevision !== op.intoExpectedRevision) {
        return { ok: false, reason: this.conflictReason(op.intoKnowledgeId, op.intoExpectedRevision, into) };
      }
      const absorb = op.absorb.filter((a, i, all) => all.findIndex((b) => b.knowledgeId === a.knowledgeId) === i);
      if (absorb.length === 0) return { ok: false, reason: `merge into K${op.intoKnowledgeId}: nothing to absorb` };
      if (absorb.some((a) => a.knowledgeId === op.intoKnowledgeId)) {
        return { ok: false, reason: `merge into K${op.intoKnowledgeId}: a knowledge item cannot absorb itself` };
      }
      for (const a of absorb) {
        const absorbed = this.getKnowledge(a.knowledgeId);
        if (!absorbed || absorbed.status !== "active" || absorbed.currentRevision !== a.expectedRevision) {
          return { ok: false, reason: this.conflictReason(a.knowledgeId, a.expectedRevision, absorbed) };
        }
      }
      const bad = this.checkCitedFacts(`merge into K${op.intoKnowledgeId}`, op.supports, op.because);
      if (bad) return { ok: false, reason: bad };
      const nextRev = into.currentRevision + 1;
      this.insertRevision(op.intoKnowledgeId, nextRev, op.text, op.category, op.scope, op.supports, "merge", op.because, runId, op.createdAt);
      this.db.prepare("UPDATE knowledge SET current_revision = ?, project_id = ? WHERE id = ?").run(nextRev, owner(op.scope), op.intoKnowledgeId);
      for (const a of absorb) {
        this.db.prepare("UPDATE knowledge SET status = 'merged' WHERE id = ?").run(a.knowledgeId);
        this.db.prepare("INSERT INTO knowledge_links (from_knowledge, from_rev, kind, to_knowledge, to_rev) VALUES (?, ?, 'merged_into', ?, ?)").run(
          a.knowledgeId,
          a.expectedRevision,
          op.intoKnowledgeId,
          nextRev,
        );
      }
      return { ok: true, value: { op: "merge", knowledgeId: op.intoKnowledgeId, rev: nextRev } };
    }

    // op.op === "archive"
    const knowledge = this.getKnowledge(op.knowledgeId);
    if (!knowledge || knowledge.status !== "active" || knowledge.currentRevision !== op.expectedRevision) {
      return { ok: false, reason: this.conflictReason(op.knowledgeId, op.expectedRevision, knowledge) };
    }
    const bad = this.checkCitedFacts(`archive K${op.knowledgeId}`, null, op.because);
    if (bad) return { ok: false, reason: bad };
    const prior = this.getKnowledgeRevision(op.knowledgeId, knowledge.currentRevision)!;
    const nextRev = knowledge.currentRevision + 1;
    this.insertRevision(op.knowledgeId, nextRev, prior.text, prior.category, prior.scope, prior.supports, "archive", op.because, runId, op.createdAt);
    this.db.prepare("UPDATE knowledge SET current_revision = ?, status = 'archived' WHERE id = ?").run(nextRev, op.knowledgeId);
    return { ok: true, value: { op: "archive", knowledgeId: op.knowledgeId, rev: nextRev } };
  }

  private conflictReason(knowledgeId: number, expected: number, actual: Knowledge | null): string {
    if (!actual) return `knowledge K${knowledgeId} does not exist`;
    if (actual.status !== "active") return `knowledge K${knowledgeId} is ${actual.status}, not active`;
    return `knowledge K${knowledgeId} moved: expected revision ${expected}, current revision is ${actual.currentRevision}`;
  }

  private insertRevision(
    knowledgeId: number,
    rev: number,
    text: string,
    category: KnowledgeCategory,
    scope: KnowledgeScope,
    supports: number[],
    op: KnowledgeOp,
    because: number[] | null,
    runId: number,
    createdAt: string,
  ): void {
    this.db.prepare(`INSERT INTO knowledge_revisions (knowledge_id, rev, text, category, scope, supports, op, because, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(knowledgeId, rev, text, category, scope, JSON.stringify(supports), op, because ? JSON.stringify(because) : null, runId, createdAt);
  }

  // -- marks --

  addKnowledgeMark(knowledgeId: number, rev: number, kind: KnowledgeMarkKind, createdAt: string): KnowledgeMark {
    if (!this.getKnowledgeRevision(knowledgeId, rev)) throw new Error(`knowledge K${knowledgeId} has no revision ${rev}`);
    this.db.prepare("INSERT INTO knowledge_marks (knowledge_id, rev, kind, created_at) VALUES (?, ?, ?, ?)").run(knowledgeId, rev, kind, createdAt);
    return { knowledgeId, rev, kind, createdAt };
  }

  listKnowledgeMarks(knowledgeId: number): KnowledgeMark[] {
    return this.db
      .prepare("SELECT * FROM knowledge_marks WHERE knowledge_id = ? ORDER BY created_at ASC")
      .all(knowledgeId)
      .map((row: any) => ({ knowledgeId: row.knowledge_id, rev: row.rev, kind: row.kind, createdAt: row.created_at }));
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
      // Session knowledge travel with their creating session even when leaving a declared project.
      this.db.prepare(`UPDATE knowledge SET project_id = ? WHERE id IN (
        SELECT e.id FROM knowledge e JOIN knowledge_revisions r ON r.knowledge_id = e.id AND r.rev = e.current_revision
        WHERE r.scope = 'session' AND e.origin_session_id = ?)`).run(target.id, sessionId);
      return target;
    });
  }

  setKnowledgeMark(knowledgeId: number, kind: KnowledgeMarkKind | "clear", time: string): number {
    return this.transaction(() => {
      const knowledge = this.getKnowledge(knowledgeId);
      if (!knowledge) throw new Error(`knowledge K${knowledgeId} does not exist`);
      this.db.prepare("DELETE FROM knowledge_marks WHERE knowledge_id = ? AND rev = ?").run(knowledgeId, knowledge.currentRevision);
      if (kind !== "clear") this.addKnowledgeMark(knowledgeId, knowledge.currentRevision, kind, time);
      return knowledge.currentRevision;
    });
  }

  deliver(sessionId: number, branch: string | null, render: (facts: Fact[]) => string): string {
    return this.transaction(() => {
      const pending = this.listPendingDeliveries(sessionId, branch);
      const facts = pending.flatMap((p) => this.db.prepare("SELECT * FROM facts WHERE run_id = ? ORDER BY id").all(p.runId).map(toFact));
      const text = render(facts);
      for (const p of pending) this.clearPendingDelivery(p.runId, new Date().toISOString());
      return text;
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
    const knowledge = scope === "facts" ? [] : (this.db.prepare(`SELECT knowledge_id, rev FROM knowledge_revisions
      WHERE text LIKE ? ESCAPE '\\' ORDER BY knowledge_id, rev`)
      .all(pattern) as { knowledge_id: number; rev: number }[]).map((r) => `K${r.knowledge_id}@${r.rev}`);
    return scope === "all" ? [...facts, ...knowledge, ...raw()] : [...facts, ...knowledge];
  }

  // -- watermarks --

  /** Branch facts follow the ancestry frozen by the latest successful recording. */
  listBranchFacts(sessionId: number, branch: string): Fact[] {
    return this.db.prepare(`WITH RECURSIVE lineage(id, parent_turn_id) AS (
      SELECT t.id, t.parent_turn_id FROM turns t JOIN watermarks w ON t.id = w.last_recorded_turn
      WHERE w.session_id = ? AND w.branch = ? AND t.session_id = w.session_id
      UNION
      SELECT t.id, t.parent_turn_id FROM turns t JOIN lineage l ON t.id = l.parent_turn_id
      WHERE t.session_id = ?
    ) SELECT f.* FROM facts f JOIN runs r ON r.id = f.run_id
      WHERE (r.kind != 'manual' AND f.turn_id IN (SELECT id FROM lineage))
        OR (r.kind = 'manual' AND r.session_id = ? AND r.branch = ?) ORDER BY f.id`)
      .all(sessionId, branch, sessionId, sessionId, branch).map(toFact);
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
