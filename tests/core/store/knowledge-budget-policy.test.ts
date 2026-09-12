import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { deriveKnowledgeBudgets } from "../../../src/core/store/processing.ts";
import { tokens, renderKnowledge } from "../../../src/core/render/index.ts";

const stores: Store[] = [], dirs: string[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const open = (path = ":memory:") => { const store = new Store(path); stores.push(store); return store; };
const file = () => { const dir = mkdtempSync(join(tmpdir(), "tm-budget-policy-")); dirs.push(dir); return join(dir, "trace.db"); };

test("35d defaults and derived capacities are one exact safe-integer policy", () => {
  const store = open();
  expect(store.knowledgeBudgets()).toEqual({
    global: 4_000, project: 10_000, session: 1_000,
    applicable: 15_000, injection: 20_000, dreamingProcessedInput: 20_000,
  });
  expect(deriveKnowledgeBudgets({ global: 4_000, project: 15_000, session: 1_000 })).toMatchObject({
    applicable: 20_000, injection: 25_000, dreamingProcessedInput: 25_000,
  });
  expect(deriveKnowledgeBudgets({ global: 0, project: 0, session: 0 })).toMatchObject({
    applicable: 0, injection: 5_000, dreamingProcessedInput: 5_000,
  });
  for (const value of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    expect(() => deriveKnowledgeBudgets({ global: value, project: 0, session: 0 })).toThrow(/Global Knowledge budget.*nonnegative safe integer/);
  expect(() => deriveKnowledgeBudgets({ global: Number.MAX_SAFE_INTEGER, project: 0, session: 0 })).toThrow(/derived injection.*safe integer/);
  expect(() => deriveKnowledgeBudgets({ global: Number.MAX_SAFE_INTEGER - 4_999, project: 5_000, session: 0 })).toThrow(/applicable.*safe integer/);
});

test("35d edits one latest field, survives reopen, and independent databases stay independent", () => {
  const first = file(), second = file();
  const a = open(first), stale = a.knowledgeBudgets();
  const unrelated = a.createProject({ name: "unchanged", declaredBy: "mark" });
  const beforeMemory = a.db.prepare("SELECT * FROM projects WHERE id = ?").get(unrelated.id);
  expect(a.setKnowledgeBudget("project", 15_000)).toMatchObject({ changed: true, policy: { project: 15_000, injection: 25_000 } });
  const changes = (a.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  expect(a.setKnowledgeBudget("project", 15_000)).toMatchObject({ changed: false });
  expect((a.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n).toBe(changes);
  expect(a.db.prepare("SELECT * FROM projects WHERE id = ?").get(unrelated.id)).toEqual(beforeMemory);
  const peer = open(first);
  expect(peer.setKnowledgeBudget("session", 2_000)).toMatchObject({ policy: { global: stale.global, project: 15_000, session: 2_000 } });
  expect(a.knowledgeBudgets()).toMatchObject({ global: 4_000, project: 15_000, session: 2_000, applicable: 21_000, injection: 26_000 });
  expect(open(second).knowledgeBudgets()).toMatchObject({ global: 4_000, project: 10_000, session: 1_000 });
  a.close(); stores.splice(stores.indexOf(a), 1);
  expect(open(first).knowledgeBudgets()).toMatchObject({ global: 4_000, project: 15_000, session: 2_000 });
});

test("35d supported pre-policy data upgrades without changing memory rows", () => {
  const path = file(), legacy = open(path);
  const project = legacy.createProject({ name: "preserved", declaredBy: "mark" });
  const session = legacy.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  legacy.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "preserve me", startedAt: "now" });
  const before = legacy.db.prepare("SELECT * FROM turns").all();
  legacy.db.exec("DROP TABLE knowledge_budget_policy"); // exact supported schema immediately before 35d
  legacy.close(); stores.splice(stores.indexOf(legacy), 1);
  const upgraded = open(path);
  expect(upgraded.knowledgeBudgets()).toMatchObject({ global: 4_000, project: 10_000, session: 1_000 });
  expect(upgraded.db.prepare("SELECT * FROM turns").all()).toEqual(before);
  expect(upgraded.db.prepare("SELECT count(*) AS n FROM knowledge_budget_policy").get()!.n).toBe(1);
});

test("35d initialization is idempotent and invalid stored arithmetic fails instead of falling back", () => {
  const path = file();
  const a = open(path);
  a.setKnowledgeBudget("global", 4_321);
  a.close(); stores.splice(stores.indexOf(a), 1);
  const b = open(path);
  expect(b.knowledgeBudgets().global).toBe(4_321);
  expect(b.db.prepare("SELECT count(*) AS n FROM knowledge_budget_policy").get()!.n).toBe(1);
  b.close(); stores.splice(stores.indexOf(b), 1);
  const unchanged = readFileSync(path);
  const noWrite = open(path);
  noWrite.close(); stores.splice(stores.indexOf(noWrite), 1);
  expect(readFileSync(path)).toEqual(unchanged);
  const raw = new DatabaseSync(path);
  raw.exec("PRAGMA ignore_check_constraints=ON");
  raw.prepare("UPDATE knowledge_budget_policy SET global_tokens = ?, project_tokens = ?, session_tokens = 0 WHERE id = 1")
    .run(Number.MAX_SAFE_INTEGER, 1);
  raw.close();
  const invalid = readFileSync(path);
  expect(() => new Store(path)).toThrow(/stored Knowledge budget policy.*derived applicable.*safe integer/);
  expect(readFileSync(path)).toEqual(invalid); // opening never resets an invalid row
});

function processedProjectKnowledge(store: Store, text: string, name = "race-project", scope: "project" | "session" = "project") {
  const project = store.createProject({ name, declaredBy: "mark" });
  const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const written = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{
    op: "create", handle: "$1", author: "test", text, category: "constraint", scope, supports: [noted.facts[0]!.id], topics: [], reason: "race fixture", createdAt: "now",
  }] });
  if (!written.ok) throw new Error(written.problems.join("; "));
  const commit = written.committed[0]!.commit;
  const revision = store.knowledgeRevision(commit)!;
  const used = tokens(renderKnowledge({ knowledge: store.getKnowledge(revision.knowledgeId)!, revision }));
  return { project, session, turn, commit, used };
}

test("35d Project and Session budgets apply independently to each owner pool", () => {
  const store = open();
  const items = [
    processedProjectKnowledge(store, "x ".repeat(6_000), "owner-project-a"),
    processedProjectKnowledge(store, "y ".repeat(6_000), "owner-project-b"),
    processedProjectKnowledge(store, "m ".repeat(600), "owner-session-a", "session"),
    processedProjectKnowledge(store, "n ".repeat(600), "owner-session-b", "session"),
  ];
  expect(items[0]!.used + items[1]!.used).toBeGreaterThan(store.knowledgeBudgets().project);
  expect(items[2]!.used + items[3]!.used).toBeGreaterThan(store.knowledgeBudgets().session);
  for (const item of items) {
    const run = store.recordRun({ kind: "dreaming", sessionId: item.session.id, outcome: "success", createdAt: "now" });
    store.completeDreaming(run.id, [item.commit], [item.commit]);
    expect(store.isKnowledgeProcessed(item.commit)).toBe(true);
  }
});

test("35d reductions diagnose current processed owners and pending revisions do not count as processed", () => {
  const store = open();
  store.setKnowledgeBudget("project", 20_000);
  const item = processedProjectKnowledge(store, "current ".repeat(3_000));
  expect(item.used).toBeGreaterThan(1_000);
  const run = store.recordRun({ kind: "dreaming", sessionId: item.session.id, outcome: "success", createdAt: "now" });
  store.completeDreaming(run.id, [item.commit], [item.commit]);
  const used = store.checkProcessedScopes().totals.find(total => total.scope === `project:${item.project.id}`)!.tokens;
  expect(() => store.setKnowledgeBudget("project", used - 1)).toThrow(new RegExp(`project:${item.project.id}: used ${used} tokens, proposed cap ${used - 1}, overage 1`));
  expect(store.knowledgeBudgets().project).toBe(20_000);

  const pending = processedProjectKnowledge(store, "pending ".repeat(5_000));
  expect(pending.used).toBeGreaterThan(item.used);
  expect(store.setKnowledgeBudget("project", used).policy.project).toBe(used);
  const pendingRun = store.recordRun({ kind: "dreaming", sessionId: pending.session.id, outcome: "success", createdAt: "now" });
  expect(() => store.completeDreaming(pendingRun.id, [pending.commit], [pending.commit])).toThrow(/project:.*exceeds/);
  expect(store.isKnowledgeProcessed(pending.commit)).toBe(false);
});

test("35d two connections serialize policy reduction against certification", () => {
  const path = file(), writer = open(path), settings = open(path);
  writer.setKnowledgeBudget("project", 20_000);
  const first = processedProjectKnowledge(writer, "growth ".repeat(2_500));
  const firstRun = writer.recordRun({ kind: "dreaming", sessionId: first.session.id, outcome: "success", createdAt: "now" });
  writer.completeDreaming(firstRun.id, [first.commit], [first.commit]); // growth wins
  const used = writer.checkProcessedScopes().totals.find(total => total.scope === `project:${first.project.id}`)!.tokens;
  expect(() => settings.setKnowledgeBudget("project", used - 1)).toThrow(/overage 1/);

  settings.setKnowledgeBudget("project", used);
  const later = processedProjectKnowledge(writer, "later growth ".repeat(3_000));
  const laterRun = writer.recordRun({ kind: "dreaming", sessionId: later.session.id, outcome: "success", createdAt: "now" });
  expect(() => writer.completeDreaming(laterRun.id, [later.commit], [later.commit])).toThrow(/processed knowledge.*exceeds/);
  expect(writer.knowledgeBudgets()).toEqual(settings.knowledgeBudgets());
});

test("35d a reduction that wins is enforced by later project placement", () => {
  const path = file(), writer = open(path), settings = open(path);
  const first = processedProjectKnowledge(writer, "first ".repeat(1_000), "policy-project-a");
  const second = processedProjectKnowledge(writer, "second ".repeat(1_000), "policy-project-b");
  for (const item of [first, second]) {
    const run = writer.recordRun({ kind: "dreaming", sessionId: item.session.id, outcome: "success", createdAt: "now" });
    writer.completeDreaming(run.id, [item.commit], [item.commit]);
  }
  const cap = Math.max(...writer.checkProcessedScopes().totals.filter(total => total.scope.startsWith("project:")).map(total => total.tokens));
  settings.setKnowledgeBudget("project", cap);
  expect(() => writer.declareProject(second.session.id, "policy-project-a", "mark")).toThrow(/Project placement rejected.*project:.*exceeds/);
  expect(writer.getSession(second.session.id)!.projectId).toBe(second.project.id);
  expect(writer.knowledgeBudgets().project).toBe(cap);
});

test("35d concurrent constructors publish exactly one default row", async () => {
  const path = file();
  const [a, b] = await Promise.all([Promise.resolve().then(() => open(path)), Promise.resolve().then(() => open(path))]);
  expect(a.db.prepare("SELECT count(*) AS n FROM knowledge_budget_policy").get()!.n).toBe(1);
  expect(a.knowledgeBudgets()).toEqual(b.knowledgeBudgets());
});
