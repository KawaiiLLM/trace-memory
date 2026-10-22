import { afterEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../../../src/core/store/index.ts";
import { ALL_POOLS } from "../../../src/core/store/processing.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const audit = (db: DatabaseSync) => Object.fromEntries([
  "runs", "task_executions", "execution_runs", "dreaming_ranges", "dreaming_run_ranges",
].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const streaks = (db: DatabaseSync) => db.prepare("SELECT * FROM task_failures ORDER BY session_id,phase,head").all();

/** A pre-104 Dreamer execution, keyed by a backlog head and no pool: the current API admits no such row. */
function legacyExecution(store: Store, sessionId: number, head: number): string {
  const id = `legacy-d-${head}`;
  store.db.prepare("INSERT INTO task_executions(id,session_id,phase,head,updated_at) VALUES (?,?,'dreaming',?,'legacy')").run(id, sessionId, head);
  return id;
}

/** A pre-Stage-4 Dreamer range with its run and execution, as the retired freeze-and-complete left them (the current API writes none). */
function legacyRange(store: Store, sessionId: number, headTurnId: number, events: number[], outcome: "success" | "failure", claim: string): number {
  const range = Number(store.db.prepare(`INSERT INTO dreaming_ranges (session_id,branch,head_turn_id,anchor,pool,claim_token,pending_revisions)
    VALUES (?,'main',?,?,?,?,?)`).run(sessionId, headTurnId, events[0] ?? null, ALL_POOLS, claim, JSON.stringify(events)).lastInsertRowid);
  for (const event of events) store.db.prepare("INSERT INTO dreaming_range_events VALUES (?,?)").run(range, event);
  const execution = legacyExecution(store, sessionId, range);
  const run = store.recordRun({ kind: "dreaming", sessionId, branch: "main", executionId: execution, outcome, createdAt: "now" });
  store.db.prepare("UPDATE dreaming_ranges SET completed_run = ?, closed_at = 'now' WHERE id = ?").run(run.id, range);
  store.db.prepare("INSERT INTO dreaming_run_ranges VALUES (?,?)").run(run.id, range);
  store.db.prepare("UPDATE task_executions SET outcome = ?, terminal_run = ?, reason = ? WHERE id = ?")
    .run(outcome, run.id, outcome === "failure" ? "legacy failure of first revision" : null, execution);
  store.db.prepare("INSERT INTO task_failures(session_id,phase,head,pool,count,last_reason,last_run_id,updated_at) VALUES (?,'dreaming',?,NULL,?,?,?,'legacy')")
    .run(sessionId, range, outcome === "failure" ? 1 : 0, outcome === "failure" ? "legacy failure of first revision" : null, run.id);
  return range;
}

function legacyDatabase() {
  const directory = mkdtempSync(join(tmpdir(), "tm-86-failure-migration-")); directories.push(directory);
  const file = join(directory, "trace.db"), store = new Store(file);
  try {
    const project = store.createProject({ name: "legacy", declaredBy: "mark" });
    const session = store.createSession({ host: "legacy", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const disabled = store.createSession({ host: "disabled", projectId: project.id, enrollmentChoice: false, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "source", startedAt: "now" });
    const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "legacy", nativeId: "user",
      role: "user", text: "source", raw: "source", calls: [] });
    store.selectSourcePath(session.id, "main", [entry.id]);
    const path = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
    const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
      { turnId: turn.id, entryIds: [entry.id], text: "source", category: "decision", actor: "user", source: [`T${turn.id}#user`], createdAt: "now" },
    ] });
    if (!fact.ok) throw new Error(fact.problems.join("; "));
    const created = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, createdAt: "now" },
      operations: [1, 2].map(index => ({ op: "create" as const, title: "Fixture title", handle: `$${index}`, author: "fixture", text: `rule ${index} ` + "word ".repeat(40),
        category: "constraint" as const, scope: "project" as const, supports: [fact.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now" })) });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const [first, second] = created.committed;
    const budget = 5_000;
    store.setKnowledgeBudget("project", budget);
    // One failed and one successful historical Dreamer range over the two items; the success skipped only the first.
    legacyRange(store, session.id, turn.id, [first!.commit, second!.commit], "failure", "legacy-failure");
    legacyRange(store, session.id, turn.id, [first!.commit, second!.commit], "success", "legacy-success");
    const executionId = store.beginExecution({ sessionId: session.id, phase: "noting", head: entry.id });
    const run = store.recordRun({ kind: "noting", sessionId: session.id, executionId, outcome: "failure", createdAt: "now" });
    store.settleExecution(executionId, "failure", run.id, "preserved noting failure");
    // Pre-retirement C audit is persisted history, not newly admitted live work.
    const historical = store.recordRun({ kind: "consolidation", sessionId: session.id, outcome: "failure", createdAt: "legacy" });
    store.db.prepare(`INSERT INTO task_executions(id,session_id,phase,head,outcome,terminal_run,reason,updated_at)
      VALUES ('legacy-c',?,'consolidation',?,'failure',?,'preserved consolidation failure','legacy')`)
      .run(session.id, fact.facts[0]!.id, historical.id);
    store.db.prepare("INSERT INTO execution_runs VALUES (?, 'legacy-c')").run(historical.id);
    store.db.prepare(`INSERT INTO task_failures(session_id,phase,head,count,last_reason,last_run_id,updated_at)
      VALUES (?,'consolidation',?,1,'preserved consolidation failure',?,'legacy')`)
      .run(session.id, fact.facts[0]!.id, historical.id);
    // The pre-86 database had identical execution tables but no application-version marker.
    store.db.exec("PRAGMA user_version = 0");
    return { file, path, budget, disabledId: disabled.id,
      beforeAudit: audit(store.db), beforeStreaks: streaks(store.db) };
  } finally { store.close(); }
}

test("86 option A: clear only old D streaks once, and a streak row written afterwards survives a reopen", () => {
  const fixture = legacyDatabase();
  let store = new Store(fixture.file);
  try {
    expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
    expect(streaks(store.db)).toEqual(fixture.beforeStreaks.filter(row => row.phase !== "dreaming"));
    expect(audit(store.db)).toEqual(fixture.beforeAudit);
    expect(store.enabled(fixture.path.sessionId)).toBe(true);
    expect(store.enabled(fixture.disabledId)).toBe(false);
    // A Dreamer failure no longer counts (Stage 4 2026-10-22), so a streak row is written directly: the reset runs once, not at every open.
    store.db.prepare("INSERT INTO task_failures(session_id,phase,head,pool,count,last_reason,updated_at) VALUES (?,'dreaming',NULL,?,2,'kept','now')")
      .run(fixture.path.sessionId, ALL_POOLS);
    store.close(); store = new Store(fixture.file);
    expect(store.taskFailures(fixture.path.sessionId).filter(row => row.phase === "dreaming"))
      .toMatchObject([{ head: null, pool: ALL_POOLS, count: 2 }]);
    expect(store.enabled(fixture.path.sessionId)).toBe(true);
    expect(store.enabled(fixture.disabledId)).toBe(false);
  } finally { store.close(); }
});

test("86 option A: a later real upgrade failure rolls back both the D reset and its one-time marker", () => {
  const fixture = legacyDatabase(), before = new DatabaseSync(fixture.file);
  // Each field is legal; their derived total is not. Store detects it after the actual reset.
  before.prepare("UPDATE knowledge_budget_policy SET global_tokens=?,project_tokens=? WHERE id=1")
    .run(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
  before.close();
  const exec = DatabaseSync.prototype.exec;
  let observedReset = false;
  const observer = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql: string) {
    exec.call(this, sql);
    if (sql.includes("DELETE FROM task_failures WHERE phase = 'dreaming'")) {
      observedReset = true;
      expect(this.prepare("SELECT COUNT(*) AS n FROM task_failures WHERE phase='dreaming'").get()!.n).toBe(0);
      expect(this.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
    }
  });
  try { expect(() => new Store(fixture.file)).toThrow("derived applicable Knowledge capacity must be a safe integer"); }
  finally { observer.mockRestore(); }
  expect(observedReset).toBe(true);
  const checked = new DatabaseSync(fixture.file);
  try {
    expect(checked.prepare("PRAGMA user_version").get()!.user_version).toBe(0);
    expect(streaks(checked)).toEqual(fixture.beforeStreaks);
    expect(audit(checked)).toEqual(fixture.beforeAudit);
    checked.prepare("UPDATE knowledge_budget_policy SET global_tokens=4000,project_tokens=? WHERE id=1").run(fixture.budget);
  } finally { checked.close(); }
  const upgraded = new Store(fixture.file);
  try {
    expect(upgraded.db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
    expect(streaks(upgraded.db)).toEqual(fixture.beforeStreaks.filter(row => row.phase !== "dreaming"));
    expect(upgraded.enabled(fixture.disabledId)).toBe(false);
  } finally { upgraded.close(); }
});
