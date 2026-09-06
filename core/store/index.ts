// core/store — bun:sqlite behind one plain interface. No abstraction over SQLite;
// this is the only place that knows a database exists. Schema: .scratch/v1/spec.md (Schema).
// Global ids: turns, facts, and entries use SQLite's per-table AUTOINCREMENT, which never
// reuses an id and is not reset per session or project — that is the "global id" the spec asks for.

import { Database } from "bun:sqlite";
import type {
  Actor,
  Entry,
  EntryCategory,
  EntryOp,
  EntryLink,
  EntryRevision,
  EntryScope,
  Fact,
  FactCategory,
  FactRelation,
  Mark,
  MarkKind,
  PendingDelivery,
  Project,
  Run,
  RunKind,
  RunOutcome,
  Session,
  ToolCall,
  Turn,
  Watermark,
} from "../model/index";

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
  parent_session_id INTEGER REFERENCES sessions(id)
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
  ended_at TEXT
);

CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL,
  input TEXT,
  result TEXT,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  turn_id INTEGER NOT NULL REFERENCES turns(id),
  category TEXT NOT NULL CHECK (category IN ('question','proposal','decision','observation','interpretation','event')),
  actor TEXT NOT NULL CHECK (actor IN ('user','agent')),
  text TEXT NOT NULL,
  quote TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS fact_relations (
  from_fact INTEGER NOT NULL REFERENCES facts(id),
  to_fact INTEGER NOT NULL REFERENCES facts(id),
  kind TEXT NOT NULL CHECK (kind IN ('support','negate')),
  strength TEXT NOT NULL CHECK (strength IN ('strong','weak')),
  PRIMARY KEY (from_fact, to_fact, kind)
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  status TEXT NOT NULL CHECK (status IN ('active','merged','archived')) DEFAULT 'active',
  author TEXT NOT NULL,
  current_revision INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS entry_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER NOT NULL REFERENCES entries(id),
  rev INTEGER NOT NULL,
  text TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('constraint','open','dispute','goal','mechanism','term','reference')),
  scope TEXT NOT NULL CHECK (scope IN ('session','project','global')),
  supports TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('new','edit','merge','archive')),
  because TEXT,
  run_id INTEGER REFERENCES runs(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_links (
  from_entry INTEGER NOT NULL,
  from_rev INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('merged_into','split_from')),
  to_entry INTEGER NOT NULL,
  to_rev INTEGER NOT NULL,
  PRIMARY KEY (from_entry, from_rev, kind, to_entry, to_rev)
);

CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('note','settle')),
  session_id INTEGER REFERENCES sessions(id),
  branch TEXT,
  range_from TEXT,
  range_to TEXT,
  prompt_hash TEXT,
  model TEXT,
  mode TEXT,
  request TEXT,
  response TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','cancelled')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS marks (
  entry_id INTEGER NOT NULL REFERENCES entries(id),
  rev INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('verified','flagged')),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_deliveries (
  run_id INTEGER NOT NULL REFERENCES runs(id),
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  branch TEXT,
  delivered_at TEXT
);

CREATE TABLE IF NOT EXISTS watermarks (
  session_id INTEGER NOT NULL,
  branch TEXT NOT NULL,
  last_noted_turn INTEGER,
  last_settled_fact INTEGER,
  PRIMARY KEY (session_id, branch)
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(text, content='facts', content_rowid='id');
CREATE VIRTUAL TABLE IF NOT EXISTS entry_revisions_fts USING fts5(text, content='entry_revisions', content_rowid='id');

-- facts and entry_revisions are append-only, so an AFTER INSERT trigger is the whole
-- index maintenance: no update or delete path exists that could leave the FTS stale.
CREATE TRIGGER IF NOT EXISTS facts_fts_insert AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS entry_revisions_fts_insert AFTER INSERT ON entry_revisions BEGIN
  INSERT INTO entry_revisions_fts (rowid, text) VALUES (new.id, new.text);
END;

CREATE INDEX IF NOT EXISTS idx_entries_project_status ON entries(project_id, status);
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

export interface NoteRelationTarget {
  target: string; // "F<id>" or "$n" (1-based index within this commit's facts array)
  strength: "strong" | "weak";
}

export interface FactCommitInput {
  turnId: number;
  category: FactCategory;
  actor: Actor;
  text: string;
  quote?: string | null;
  source: string[];
  createdAt: string;
  support?: NoteRelationTarget[];
  negate?: NoteRelationTarget[];
}

export interface CommitNoteRunInput {
  run: RunInput; // sessionId required: every turn, watermark, and delivery must belong to it
  facts: FactCommitInput[];
  watermark?: { sessionId: number; branch: string; lastNotedTurn: number };
  pendingDelivery?: { sessionId: number; branch: string | null };
}

export type CommitNoteResult =
  | { ok: true; runId: number; facts: Fact[] }
  | { ok: false; runId: number; problems: string[] };

export type EntryOperationInput =
  | {
      op: "new";
      handle: string; // "$e<n>", resolvable within `committed` below
      author: string;
      text: string;
      category: EntryCategory;
      scope: EntryScope;
      supports: number[];
      createdAt: string;
    }
  | {
      op: "edit";
      entryId: number;
      expectedRevision: number;
      text: string;
      category: EntryCategory;
      scope: EntryScope;
      supports: number[];
      because: number[];
      createdAt: string;
    }
  | {
      op: "merge";
      intoEntryId: number;
      intoExpectedRevision: number;
      absorb: { entryId: number; expectedRevision: number }[];
      text: string;
      category: EntryCategory;
      scope: EntryScope;
      supports: number[];
      because: number[];
      createdAt: string;
    }
  | {
      op: "archive";
      entryId: number;
      expectedRevision: number;
      because: number[];
      createdAt: string;
    };

export interface CommitSettleRunInput {
  run: RunInput; // sessionId required: entry ownership is derived from the run's session
  operations: EntryOperationInput[];
  // Runs inside the transaction after application, so diagnostics observe the committed entry set.
  finalizeResponse?: (result: { committed: CommittedEntryOp[]; rejected: RejectedEntryOp[] }) => string;
  watermark?: { sessionId: number; branch: string; lastSettledFact: number };
}

export interface CommittedEntryOp {
  op: EntryOp;
  handle?: string;
  entryId: number;
  rev: number;
}

export interface RejectedEntryOp {
  op: EntryOperationInput;
  reason: string;
}

export type CommitSettleResult =
  | { ok: true; runId: number; committed: CommittedEntryOp[]; rejected: RejectedEntryOp[] }
  | { ok: false; runId: number; problems: string[] };

export interface EntryWithRevision {
  entry: Entry;
  revision: EntryRevision;
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
    source: JSON.parse(row.source),
    createdAt: row.created_at,
  };
}

function toEntry(row: any): Entry {
  return { id: row.id, projectId: row.project_id, status: row.status, author: row.author, currentRevision: row.current_revision };
}

function toEntryRevision(row: any): EntryRevision {
  return {
    id: row.id,
    entryId: row.entry_id,
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
  readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA foreign_keys = ON;");
    // Another process may hold a short write lock (its own note or settle commit); wait instead of failing.
    // Commits run as immediate transactions: a deferred one that reads first and then writes gets
    // SQLITE_BUSY at once, without the busy handler, when a writer is already active.
    this.db.exec("PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  // -- projects --

  createProject(input: CreateProjectInput): Project {
    const info = this.db.run("INSERT INTO projects (name, declared_by) VALUES (?, ?)", [input.name, input.declaredBy]);
    return this.getProject(Number(info.lastInsertRowid))!;
  }

  getProject(id: number): Project | null {
    const row = this.db.query("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? toProject(row) : null;
  }

  findProjectByName(name: string): Project | null {
    const row = this.db.query("SELECT * FROM projects WHERE name = ?").get(name);
    return row ? toProject(row) : null;
  }

  /** Relabel a merged project's sessions and project-scoped entries onto the survivor. */
  mergeProject(fromProjectId: number, intoProjectId: number): void {
    this.db
      .transaction(() => {
        this.db.run("UPDATE projects SET merged_into = ? WHERE id = ?", [intoProjectId, fromProjectId]);
        this.db.run("UPDATE sessions SET project_id = ? WHERE project_id = ?", [intoProjectId, fromProjectId]);
        this.db.run("UPDATE entries SET project_id = ? WHERE project_id = ?", [intoProjectId, fromProjectId]);
      })
      .immediate();
  }

  // -- sessions --

  /** A session row — and its id — exists only once the first assistant reply exists. */
  createSession(input: CreateSessionInput): Session {
    if (!input.firstReplyAt) {
      throw new Error("a session is allocated an id only once an assistant reply exists (firstReplyAt is required)");
    }
    const info = this.db.run(
      "INSERT INTO sessions (host, started_at, first_reply_at, project_id, parent_session_id) VALUES (?, ?, ?, ?, ?)",
      [input.host, input.startedAt, input.firstReplyAt, input.projectId, input.parentSessionId ?? null],
    );
    return this.getSession(Number(info.lastInsertRowid))!;
  }

  getSession(id: number): Session | null {
    const row = this.db.query("SELECT * FROM sessions WHERE id = ?").get(id);
    return row ? toSession(row) : null;
  }

  // -- turns & tool calls --

  appendTurn(input: AppendTurnInput): Turn {
    const ordinalRow = this.db
      .query("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM turns WHERE session_id = ?")
      .get(input.sessionId) as { next: number };
    const info = this.db.run(
      `INSERT INTO turns (session_id, ordinal, parent_turn_id, kind, user_prompt, assistant_text, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.sessionId,
        ordinalRow.next,
        input.parentTurnId ?? null,
        input.kind,
        input.userPrompt ?? null,
        input.assistantText ?? null,
        input.startedAt,
        input.endedAt ?? null,
      ],
    );
    return this.getTurn(Number(info.lastInsertRowid))!;
  }

  getTurn(id: number): Turn | null {
    const row = this.db.query("SELECT * FROM turns WHERE id = ?").get(id);
    return row ? toTurn(row) : null;
  }

  appendToolCall(input: AppendToolCallInput): ToolCall {
    const ordinalRow = this.db
      .query("SELECT COALESCE(MAX(ordinal), 0) + 1 AS next FROM tool_calls WHERE turn_id = ?")
      .get(input.turnId) as { next: number };
    const info = this.db.run(
      "INSERT INTO tool_calls (turn_id, ordinal, name, input, result, status) VALUES (?, ?, ?, ?, ?, ?)",
      [input.turnId, ordinalRow.next, input.name, input.input ?? null, input.result ?? null, input.status],
    );
    const row = this.db.query("SELECT * FROM tool_calls WHERE id = ?").get(Number(info.lastInsertRowid));
    return toToolCall(row);
  }

  listToolCalls(turnId: number): ToolCall[] {
    return this.db.query("SELECT * FROM tool_calls WHERE turn_id = ? ORDER BY ordinal").all(turnId).map(toToolCall);
  }

  listSessionFacts(sessionId: number): Fact[] {
    return this.db.query(
      "SELECT f.* FROM facts f JOIN turns t ON t.id = f.turn_id WHERE t.session_id = ? ORDER BY f.created_at DESC, f.id DESC",
    ).all(sessionId).map(toFact);
  }

  listProjectFacts(projectId: number): Fact[] {
    return this.db.query(
      `SELECT f.* FROM facts f JOIN turns t ON t.id = f.turn_id
       JOIN sessions s ON s.id = t.session_id WHERE s.project_id = ? ORDER BY f.created_at DESC, f.id DESC`,
    ).all(projectId).map(toFact);
  }

  listFactRelations(factId: number): FactRelation[] {
    return (this.db.query(
      "SELECT * FROM fact_relations WHERE from_fact = ? OR to_fact = ? ORDER BY from_fact, to_fact, kind, strength",
    ).all(factId, factId) as any[]).map((r) => ({
      fromFact: r.from_fact, toFact: r.to_fact, kind: r.kind, strength: r.strength,
    }));
  }

  // -- runs (standalone: failure / cancelled, or a run with nothing else to commit) --

  recordRun(input: RunInput & { outcome: RunOutcome }): Run {
    return this.getRun(this.insertRun(input))!;
  }

  getRun(id: number): Run | null {
    const row = this.db.query("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  }

  // -- facts --

  getFact(id: number): Fact | null {
    const row = this.db.query("SELECT * FROM facts WHERE id = ?").get(id);
    return row ? toFact(row) : null;
  }

  /**
   * Commit one note run: the run record and its facts (with relations) as one transaction.
   * A relation target is either "F<id>" (an existing fact) or "$n" (the n-th fact of this
   * same batch, 1-based, resolved to its freshly assigned id inside this transaction).
   * On any failure (e.g. an out-of-range local handle) nothing but the run record is written,
   * with outcome "failure" — the run record is always written, business writes are not.
   */
  commitNoteRun(input: CommitNoteRunInput): CommitNoteResult {
    try {
      const result = this.db.transaction(() => {
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
          const info = this.db.run(
            "INSERT INTO facts (turn_id, category, actor, text, quote, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [f.turnId, f.category, f.actor, f.text, f.quote ?? null, JSON.stringify(f.source), f.createdAt],
          );
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
            this.db.run("INSERT INTO fact_relations (from_fact, to_fact, kind, strength) VALUES (?, ?, 'support', ?)", [
              fromFact,
              resolve(rel.target, i),
              rel.strength,
            ]);
          }
          for (const rel of f.negate ?? []) {
            this.db.run("INSERT INTO fact_relations (from_fact, to_fact, kind, strength) VALUES (?, ?, 'negate', ?)", [
              fromFact,
              resolve(rel.target, i),
              rel.strength,
            ]);
          }
        });
        if (input.watermark) {
          this.setWatermark(input.watermark.sessionId, input.watermark.branch, input.watermark.lastNotedTurn, undefined);
        }
        if (input.pendingDelivery) {
          this.addPendingDelivery(runId, input.pendingDelivery.sessionId, input.pendingDelivery.branch);
        }
        return { runId, facts: batchIds.map((id) => this.getFact(id)!) };
      }).immediate();
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
    const info = this.db.run(
      `INSERT INTO runs (kind, session_id, branch, range_from, range_to, prompt_hash, model, mode, request, response, outcome, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
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
      ],
    );
    return Number(info.lastInsertRowid);
  }

  // -- entries & revisions --

  getEntry(id: number): Entry | null {
    const row = this.db.query("SELECT * FROM entries WHERE id = ?").get(id);
    return row ? toEntry(row) : null;
  }

  getEntryWithRevision(id: number): EntryWithRevision | null {
    const entry = this.getEntry(id);
    if (!entry) return null;
    const revision = this.getEntryRevision(id, entry.currentRevision)!;
    return { entry, revision };
  }

  getEntryRevision(entryId: number, rev: number): EntryRevision | null {
    const row = this.db.query("SELECT * FROM entry_revisions WHERE entry_id = ? AND rev = ?").get(entryId, rev);
    return row ? toEntryRevision(row) : null;
  }

  listEntryLinks(entryId: number): EntryLink[] {
    return (this.db.query(
      "SELECT * FROM entry_links WHERE from_entry = ? ORDER BY from_rev, kind, to_entry, to_rev",
    ).all(entryId) as any[]).map((r) => ({
      fromEntry: r.from_entry, fromRev: r.from_rev, kind: r.kind, toEntry: r.to_entry, toRev: r.to_rev,
    }));
  }

  listEntryRevisions(entryId: number): EntryRevision[] {
    return this.db
      .query("SELECT * FROM entry_revisions WHERE entry_id = ? ORDER BY rev ASC")
      .all(entryId)
      .map(toEntryRevision);
  }

  /**
   * Entries visible to a session: global entries, this project's project-scope entries,
   * and this session's own session-scope entries. A session-scope entry's owning session
   * is the session_id of the run that created its first revision (entries carry no session
   * column of their own; the schema in spec.md does not give them one).
   */
  listVisibleEntries(sessionId: number, projectId: number): EntryWithRevision[] {
    const rows = this.db
      .query(
        `SELECT e.*, r.id AS rev_id, r.rev AS rev_rev, r.text AS rev_text, r.category AS rev_category,
                r.scope AS rev_scope, r.supports AS rev_supports, r.op AS rev_op, r.because AS rev_because,
                r.run_id AS rev_run_id, r.created_at AS rev_created_at
         FROM entries e
         JOIN entry_revisions r ON r.entry_id = e.id AND r.rev = e.current_revision
         LEFT JOIN entry_revisions r1 ON r1.entry_id = e.id AND r1.rev = 1
         LEFT JOIN runs run1 ON run1.id = r1.run_id
         WHERE e.status = 'active'
           AND (
             r.scope = 'global'
             OR (r.scope = 'project' AND e.project_id = ?)
             OR (r.scope = 'session' AND e.project_id = ? AND run1.session_id = ?)
           )
         ORDER BY e.id ASC`,
      )
      .all(projectId, projectId, sessionId) as any[];
    return rows.map((row) => ({
      entry: toEntry(row),
      revision: toEntryRevision({
        id: row.rev_id,
        entry_id: row.id,
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
   * Commit one settle run: the run record and its entry operations as one transaction.
   * An operation whose expected revision no longer matches the entry's current revision
   * (someone else moved it since the settler read it) is rejected and recorded; the rest
   * of the batch still commits.
   */
  commitSettleRun(input: CommitSettleRunInput): CommitSettleResult {
    try {
      const result = this.db.transaction(() => {
        const sessionId = this.requireRunSession(input.run);
        const projectId = this.getSession(sessionId)!.projectId;
        if (input.watermark && (input.watermark.sessionId !== sessionId || input.watermark.branch !== (input.run.branch ?? null))) {
          throw new Error(`watermark S${input.watermark.sessionId}/${input.watermark.branch} does not belong to this run (S${sessionId}/${input.run.branch ?? null})`);
        }
        const runId = this.insertRun({ ...input.run, outcome: "success" });
        const committed: CommittedEntryOp[] = [];
        const rejected: RejectedEntryOp[] = [];
        for (const op of input.operations) {
          const outcome = this.applyEntryOperation(op, runId, projectId);
          if (outcome.ok) committed.push(outcome.value);
          else rejected.push({ op, reason: outcome.reason });
        }
        // The frozen range is settled even when some operations were rejected: the run record
        // holds the rejections, and a later settlement re-reads those entries at their new revisions.
        if (input.watermark) {
          this.setWatermark(sessionId, input.watermark.branch, undefined, input.watermark.lastSettledFact);
        }
        if (input.finalizeResponse) {
          this.db.run("UPDATE runs SET response = ? WHERE id = ?", [input.finalizeResponse({ committed, rejected }), runId]);
        }
        return { runId, committed, rejected };
      }).immediate();
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

  private applyEntryOperation(
    op: EntryOperationInput,
    runId: number,
    projectId: number,
  ): { ok: true; value: CommittedEntryOp } | { ok: false; reason: string } {
    // Ownership follows scope: a global entry belongs to no project; anything narrower belongs to the run's project.
    const owner = (scope: EntryScope): number | null => (scope === "global" ? null : projectId);

    if (op.op === "new") {
      const bad = this.checkCitedFacts("new", op.supports, []);
      if (bad) return { ok: false, reason: bad };
      const info = this.db.run("INSERT INTO entries (project_id, status, author, current_revision) VALUES (?, 'active', ?, 1)", [
        owner(op.scope),
        op.author,
      ]);
      const entryId = Number(info.lastInsertRowid);
      this.insertRevision(entryId, 1, op.text, op.category, op.scope, op.supports, "new", null, runId, op.createdAt);
      return { ok: true, value: { op: "new", handle: op.handle, entryId, rev: 1 } };
    }

    if (op.op === "edit") {
      const entry = this.getEntry(op.entryId);
      if (!entry || entry.status !== "active" || entry.currentRevision !== op.expectedRevision) {
        return { ok: false, reason: this.conflictReason(op.entryId, op.expectedRevision, entry) };
      }
      const bad = this.checkCitedFacts(`edit E${op.entryId}`, op.supports, op.because);
      if (bad) return { ok: false, reason: bad };
      const nextRev = entry.currentRevision + 1;
      this.insertRevision(op.entryId, nextRev, op.text, op.category, op.scope, op.supports, "edit", op.because, runId, op.createdAt);
      this.db.run("UPDATE entries SET current_revision = ?, project_id = ? WHERE id = ?", [nextRev, owner(op.scope), op.entryId]);
      return { ok: true, value: { op: "edit", entryId: op.entryId, rev: nextRev } };
    }

    if (op.op === "merge") {
      const into = this.getEntry(op.intoEntryId);
      if (!into || into.status !== "active" || into.currentRevision !== op.intoExpectedRevision) {
        return { ok: false, reason: this.conflictReason(op.intoEntryId, op.intoExpectedRevision, into) };
      }
      const absorb = op.absorb.filter((a, i, all) => all.findIndex((b) => b.entryId === a.entryId) === i);
      if (absorb.length === 0) return { ok: false, reason: `merge into E${op.intoEntryId}: nothing to absorb` };
      if (absorb.some((a) => a.entryId === op.intoEntryId)) {
        return { ok: false, reason: `merge into E${op.intoEntryId}: an entry cannot absorb itself` };
      }
      for (const a of absorb) {
        const absorbed = this.getEntry(a.entryId);
        if (!absorbed || absorbed.status !== "active" || absorbed.currentRevision !== a.expectedRevision) {
          return { ok: false, reason: this.conflictReason(a.entryId, a.expectedRevision, absorbed) };
        }
      }
      const bad = this.checkCitedFacts(`merge into E${op.intoEntryId}`, op.supports, op.because);
      if (bad) return { ok: false, reason: bad };
      const nextRev = into.currentRevision + 1;
      this.insertRevision(op.intoEntryId, nextRev, op.text, op.category, op.scope, op.supports, "merge", op.because, runId, op.createdAt);
      this.db.run("UPDATE entries SET current_revision = ?, project_id = ? WHERE id = ?", [nextRev, owner(op.scope), op.intoEntryId]);
      for (const a of absorb) {
        this.db.run("UPDATE entries SET status = 'merged' WHERE id = ?", [a.entryId]);
        this.db.run("INSERT INTO entry_links (from_entry, from_rev, kind, to_entry, to_rev) VALUES (?, ?, 'merged_into', ?, ?)", [
          a.entryId,
          a.expectedRevision,
          op.intoEntryId,
          nextRev,
        ]);
      }
      return { ok: true, value: { op: "merge", entryId: op.intoEntryId, rev: nextRev } };
    }

    // op.op === "archive"
    const entry = this.getEntry(op.entryId);
    if (!entry || entry.status !== "active" || entry.currentRevision !== op.expectedRevision) {
      return { ok: false, reason: this.conflictReason(op.entryId, op.expectedRevision, entry) };
    }
    const bad = this.checkCitedFacts(`archive E${op.entryId}`, null, op.because);
    if (bad) return { ok: false, reason: bad };
    const prior = this.getEntryRevision(op.entryId, entry.currentRevision)!;
    const nextRev = entry.currentRevision + 1;
    this.insertRevision(op.entryId, nextRev, prior.text, prior.category, prior.scope, prior.supports, "archive", op.because, runId, op.createdAt);
    this.db.run("UPDATE entries SET current_revision = ?, status = 'archived' WHERE id = ?", [nextRev, op.entryId]);
    return { ok: true, value: { op: "archive", entryId: op.entryId, rev: nextRev } };
  }

  private conflictReason(entryId: number, expected: number, actual: Entry | null): string {
    if (!actual) return `entry E${entryId} does not exist`;
    if (actual.status !== "active") return `entry E${entryId} is ${actual.status}, not active`;
    return `entry E${entryId} moved: expected revision ${expected}, current revision is ${actual.currentRevision}`;
  }

  private insertRevision(
    entryId: number,
    rev: number,
    text: string,
    category: EntryCategory,
    scope: EntryScope,
    supports: number[],
    op: EntryOp,
    because: number[] | null,
    runId: number,
    createdAt: string,
  ): void {
    this.db.run(
      `INSERT INTO entry_revisions (entry_id, rev, text, category, scope, supports, op, because, run_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [entryId, rev, text, category, scope, JSON.stringify(supports), op, because ? JSON.stringify(because) : null, runId, createdAt],
    );
  }

  // -- marks --

  addMark(entryId: number, rev: number, kind: MarkKind, createdAt: string): Mark {
    if (!this.getEntryRevision(entryId, rev)) throw new Error(`entry E${entryId} has no revision ${rev}`);
    this.db.run("INSERT INTO marks (entry_id, rev, kind, created_at) VALUES (?, ?, ?, ?)", [entryId, rev, kind, createdAt]);
    return { entryId, rev, kind, createdAt };
  }

  listMarks(entryId: number): Mark[] {
    return this.db
      .query("SELECT * FROM marks WHERE entry_id = ? ORDER BY created_at ASC")
      .all(entryId)
      .map((row: any) => ({ entryId: row.entry_id, rev: row.rev, kind: row.kind, createdAt: row.created_at }));
  }

  // -- pending deliveries --

  addPendingDelivery(runId: number, sessionId: number, branch: string | null): void {
    this.db.run("INSERT INTO pending_deliveries (run_id, session_id, branch, delivered_at) VALUES (?, ?, ?, NULL)", [
      runId,
      sessionId,
      branch,
    ]);
  }

  listPendingDeliveries(sessionId: number, branch: string | null): PendingDelivery[] {
    return this.db
      .query("SELECT * FROM pending_deliveries WHERE session_id = ? AND branch IS ? AND delivered_at IS NULL")
      .all(sessionId, branch)
      .map((row: any) => ({ runId: row.run_id, sessionId: row.session_id, branch: row.branch, deliveredAt: row.delivered_at }));
  }

  clearPendingDelivery(runId: number, deliveredAt: string): void {
    this.db.run("UPDATE pending_deliveries SET delivered_at = ? WHERE run_id = ?", [deliveredAt, runId]);
  }

  // -- watermarks --

  /** Branch facts follow the ancestry frozen by the latest successful note. */
  listBranchFacts(sessionId: number, branch: string): Fact[] {
    return this.db.query(`WITH RECURSIVE lineage(id, parent_turn_id) AS (
      SELECT t.id, t.parent_turn_id FROM turns t JOIN watermarks w ON t.id = w.last_noted_turn
      WHERE w.session_id = ? AND w.branch = ? AND t.session_id = w.session_id
      UNION
      SELECT t.id, t.parent_turn_id FROM turns t JOIN lineage l ON t.id = l.parent_turn_id
      WHERE t.session_id = ?
    ) SELECT f.* FROM facts f JOIN lineage l ON f.turn_id = l.id ORDER BY f.id`)
      .all(sessionId, branch, sessionId).map(toFact);
  }

  listSettledProjectFacts(projectId: number): Fact[] {
    const watermarks = this.db.query(`SELECT w.* FROM watermarks w JOIN sessions s ON s.id = w.session_id
      WHERE s.project_id = ? AND w.last_settled_fact IS NOT NULL`).all(projectId) as any[];
    const ids = new Set(watermarks.flatMap((w) => this.listBranchFacts(w.session_id, w.branch)
      .filter((f) => f.id <= w.last_settled_fact).map((f) => f.id)));
    return this.listProjectFacts(projectId).filter((f) => ids.has(f.id));
  }

  getWatermark(sessionId: number, branch: string): Watermark | null {
    const row = this.db.query("SELECT * FROM watermarks WHERE session_id = ? AND branch = ?").get(sessionId, branch);
    return row ? { sessionId: (row as any).session_id, branch: (row as any).branch, lastNotedTurn: (row as any).last_noted_turn, lastSettledFact: (row as any).last_settled_fact } : null;
  }

  setWatermark(sessionId: number, branch: string, lastNotedTurn: number | undefined, lastSettledFact: number | undefined): void {
    const existing = this.getWatermark(sessionId, branch);
    this.db.run(
      `INSERT INTO watermarks (session_id, branch, last_noted_turn, last_settled_fact) VALUES (?, ?, ?, ?)
       ON CONFLICT (session_id, branch) DO UPDATE SET last_noted_turn = excluded.last_noted_turn, last_settled_fact = excluded.last_settled_fact`,
      [sessionId, branch, lastNotedTurn ?? existing?.lastNotedTurn ?? null, lastSettledFact ?? existing?.lastSettledFact ?? null],
    );
  }
}

export function openStore(path: string): Store {
  return new Store(path);
}
