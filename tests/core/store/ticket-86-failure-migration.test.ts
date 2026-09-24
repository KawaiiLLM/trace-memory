import { afterEach, expect, test, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, type TaskTarget } from "../../../src/core/store/index.ts";
import { tokens } from "../../../src/core/render/index.ts";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
const audit = (db: DatabaseSync) => Object.fromEntries([
  "runs", "task_executions", "execution_runs", "dreaming_ranges", "dreaming_run_ranges",
].map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
const streaks = (db: DatabaseSync) => db.prepare("SELECT * FROM task_failures ORDER BY session_id,phase,head").all();

function reserve(store: Store, path: TaskTarget, pool: string, executor: string) {
  const claim = store.acquireClaim(path, "dreaming", executor);
  if (!claim) throw new Error("fixture Dreamer claim is unavailable");
  return { claim, range: store.retainKnowledgePoolRange(path, pool, claim) };
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
      operations: [1, 2].map(index => ({ op: "create" as const, handle: `$${index}`, author: "fixture", text: `rule ${index} ` + "word ".repeat(40),
        category: "constraint" as const, scope: "project" as const, supports: [fact.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now" })) });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const [first, second] = created.committed, pool = `project:${project.id}`;
    const oldest = store.pendingVersions(pool, path)[0]!;
    const budget = tokens(`Pending current knowledge:\n${oldest.material}`);
    store.setKnowledgeBudget("project", budget); // One complete item fits even under the old hard cap.
    const abandoned = reserve(store, path, pool, "abandoned");
    store.releaseClaim(abandoned.claim);
    const failed = reserve(store, path, pool, "legacy-failure");
    expect(failed.range.id).toBe(second!.commit);
    expect(failed.range.anchor).toBe(first!.commit);
    expect(failed.range.eventIds).toEqual([first!.commit]);
    const oldExecution = store.beginExecution({ sessionId: session.id, phase: "dreaming", head: failed.range.id });
    const oldRun = store.bindDreamingRun({ kind: "dreaming", sessionId: session.id, branch: "main", createdAt: "now",
      executionId: oldExecution, dreamingRangeId: failed.range.id, claim: failed.claim });
    store.completeKnowledgePoolRange(oldRun, "failure");
    store.settleExecution(oldExecution, "failure", store.dreamingRunId(oldRun)!, "legacy failure of first revision");
    store.releaseClaim(failed.claim);
    const processed = reserve(store, path, pool, "legacy-success");
    const successExecution = store.beginExecution({ sessionId: session.id, phase: "dreaming", head: processed.range.id });
    const successRun = store.bindDreamingRun({ kind: "dreaming", sessionId: session.id, branch: "main", createdAt: "now",
      executionId: successExecution, dreamingRangeId: processed.range.id, claim: processed.claim });
    store.completeKnowledgePoolRange(successRun, "success", processed.range.eventIds);
    store.settleExecution(successExecution, "success", store.dreamingRunId(successRun)!);
    store.releaseClaim(processed.claim);
    for (const phase of ["noting", "consolidation"] as const) {
      const executionId = store.beginExecution({ sessionId: session.id, phase, head: phase === "noting" ? entry.id : fact.facts[0]!.id });
      const run = store.recordRun({ kind: phase, sessionId: session.id, executionId, outcome: "failure", createdAt: "now" });
      store.settleExecution(executionId, "failure", run.id, `preserved ${phase} failure`);
    }
    // The pre-86 database had identical execution tables but no application-version marker.
    store.db.exec("PRAGMA user_version = 0");
    return { file, path, pool, budget, disabledId: disabled.id, nextRevision: second!.commit,
      beforeAudit: audit(store.db), beforeStreaks: streaks(store.db) };
  } finally { store.close(); }
}

function failNextRevision(store: Store, path: TaskTarget, pool: string) {
  const { claim, range } = reserve(store, path, pool, "new-failure");
  const executionId = store.beginExecution({ sessionId: path.sessionId, phase: "dreaming", head: range.anchor });
  const run = store.bindDreamingRun({ kind: "dreaming", sessionId: path.sessionId, branch: path.branch, createdAt: "now",
    executionId, dreamingRangeId: range.id, claim });
  store.completeKnowledgePoolRange(run, "failure");
  const result = store.settleExecution(executionId, "failure", store.dreamingRunId(run)!, "new revision failed");
  store.releaseClaim(claim);
  return result;
}

test("86 option A: clear only old D streaks once; a formerly colliding revision starts at one and reopen preserves its count", () => {
  const fixture = legacyDatabase();
  let store = new Store(fixture.file);
  try {
    expect(store.db.prepare("PRAGMA user_version").get()!.user_version).toBe(1);
    expect(streaks(store.db)).toEqual(fixture.beforeStreaks.filter(row => row.phase !== "dreaming"));
    expect(audit(store.db)).toEqual(fixture.beforeAudit);
    expect(store.enabled(fixture.path.sessionId)).toBe(true);
    expect(store.enabled(fixture.disabledId)).toBe(false);
    expect(failNextRevision(store, fixture.path, fixture.pool)).toEqual({});
    expect(store.taskFailures(fixture.path.sessionId).filter(row => row.phase === "dreaming"))
      .toMatchObject([{ head: fixture.nextRevision, count: 1 }]);
    store.close(); store = new Store(fixture.file);
    expect(store.taskFailures(fixture.path.sessionId).filter(row => row.phase === "dreaming"))
      .toMatchObject([{ head: fixture.nextRevision, count: 1 }]);
    expect(failNextRevision(store, fixture.path, fixture.pool)).toEqual({});
    store.close(); store = new Store(fixture.file);
    expect(store.taskFailures(fixture.path.sessionId).filter(row => row.phase === "dreaming"))
      .toMatchObject([{ head: fixture.nextRevision, count: 2 }]);
    expect(failNextRevision(store, fixture.path, fixture.pool).automaticOff).toBeTruthy();
    expect(store.enabled(fixture.path.sessionId)).toBe(false);
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
