import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";
import { writeHandoff } from "../../../src/core/store/executions.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { declarationContext } from "../project-declaration-context.ts";
import { TraceMemory, memoryFiles } from "../../../src/core/api/index.ts";
import { entry as seedEntry, legacyKnowledge, receiptCommit } from "../../support/seed.ts";
import { commitDreamerOps } from "../../support/dreamer.ts";

let dir: string;
let dbPath: string;
let store: Store;
const tag = (knowledgeId: number, commit: number) => `K${knowledgeId}#${store.versionTag(knowledgeId, commit)}`;
const history = (knowledgeId: number, commit: number) => `K${knowledgeId}@v${store.versionOrdinal(knowledgeId, commit)}`;
const publishedCommit = (item: { knowledgeId: number; version: string }) =>
  receiptCommit(store, item);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-store-"));
  dbPath = join(dir, "test.sqlite");
  store = new Store(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeSession(projectId: number, host = "test-host") {
  return store.createSession({ enrollmentChoice: true, host, startedAt: "2026-01-01T00:00:00Z", firstReplyAt: "2026-01-01T00:00:05Z", projectId });
}

describe("schema", () => {
  test("creates all tables without error and is reopenable", () => {
    // Store already ran the schema in beforeEach; reopening the same file must not fail
    // (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE VIRTUAL TABLE IF NOT EXISTS).
    const again = new Store(dbPath);
    const tables = again.db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    for (const expected of [
      "sessions",
      "projects",
      "turns",
      "tool_calls",
      "facts",
      "fact_relations",
      "knowledge",
      "knowledge_revisions",
      "knowledge_links",
      "runs",
      "source_entries", "source_paths", "noted_entries",
      "idx_knowledge_project",
      "idx_runs_session",
    ]) {
      expect(names).toContain(expected);
    }
    expect(names).not.toContain("pending_deliveries");
    again.close();
  });
});

describe("global ids", () => {
  test("turn ids increase across sessions, not reset per session", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s1 = makeSession(p.id);
    const s2 = makeSession(p.id);
    const t1 = store.appendTurn({ sessionId: s1.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const t2 = store.appendTurn({ sessionId: s2.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    expect(t2.id).toBeGreaterThan(t1.id);
    // each session's own ordinal still starts at 1
    expect(t1.ordinal).toBe(1);
    expect(t2.ordinal).toBe(1);
  });

  test("fact and knowledge ids increase across projects", () => {
    const p1 = store.createProject({ name: "p1", declaredBy: "mark" });
    const p2 = store.createProject({ name: "p2", declaredBy: "mark" });
    expect(p2.id).toBeGreaterThan(p1.id);
    const s1 = makeSession(p1.id);
    const t1 = store.appendTurn({ sessionId: s1.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const e1 = seedEntry(store, s1.id, t1.id, "first", "user", "fact one");
    const r1 = store.commitNotingRun({
      run: { kind: "noting", sessionId: s1.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t1.id, category: "observation", actor: "user", text: "fact one", source: [`T${t1.id}#user`], entryIds: [e1.id], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(r1.ok).toBe(true);
    const s2 = makeSession(p2.id);
    const t2 = store.appendTurn({ sessionId: s2.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const e2 = seedEntry(store, s2.id, t2.id, "second", "user", "fact two");
    const r2 = store.commitNotingRun({
      run: { kind: "noting", sessionId: s2.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t2.id, category: "observation", actor: "user", text: "fact two", source: [`T${t2.id}#user`], entryIds: [e2.id], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r2.facts[0]!.id).toBeGreaterThan(r1.facts[0]!.id);
    }
  });
});

describe("session id allocation", () => {
  test("requires a first assistant reply timestamp", () => {
    const p = store.createProject({ name: "proj", declaredBy: "marker" });
    expect(() =>
      store.createSession({ enrollmentChoice: true, host: "test", startedAt: "2026-01-01T00:00:00Z", firstReplyAt: "", projectId: p.id }),
    ).toThrow();
  });

  test("allocates an id once the first reply exists", () => {
    const p = store.createProject({ name: "proj", declaredBy: "marker" });
    const s = makeSession(p.id);
    expect(s.id).toBeGreaterThan(0);
    expect(store.getSession(s.id)?.firstReplyAt).toBe("2026-01-01T00:00:05Z");
  });
});

describe("commitNotingRun: local handle resolution", () => {
  test("resolves $n to the batch's own freshly assigned fact ids", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const user = seedEntry(store, s.id, t.id, "initial", "user", "use pnpm");
    const assistant = seedEntry(store, s.id, t.id, "reply", "assistant", "switched the lockfile to pnpm");
    const result = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [
        { turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: [`T${t.id}#user`], entryIds: [user.id], createdAt: "2026-01-01T00:00:01Z" },
        {
          turnId: t.id,
          category: "event",
          actor: "agent",
          status: "completed",
          text: "switched the lockfile to pnpm",
          source: [`T${t.id}#assistant`], entryIds: [assistant.id],
          createdAt: "2026-01-01T00:00:02Z",
          support: [{ target: "$1", strength: "weak" }],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.facts).toHaveLength(2);
    const rel = store.db.prepare("SELECT * FROM fact_relations WHERE from_fact = ?").get(result.facts[1]!.id) as any;
    expect(rel.to_fact).toBe(result.facts[0]!.id);
    expect(rel.kind).toBe("support");
  });

  test("resolves F<id> targets against facts committed in an earlier run", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const user = seedEntry(store, s.id, t.id, "prior", "user", "use pnpm");
    const first = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: [`T${t.id}#user`], entryIds: [user.id], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      facts: [
        {
          turnId: t.id,
          category: "decision",
          actor: "user",
          text: "confirmed pnpm again",
          source: [`T${t.id}#user`], entryIds: [user.id],
          createdAt: "2026-01-01T00:01:00Z",
          support: [{ target: `F${first.facts[0]!.id}`, strength: "strong" }],
        },
      ],
    });
    expect(second.ok).toBe(true);
  });

  test("rejects an out-of-range local handle and writes only the run record", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const result = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [
        {
          turnId: t.id,
          category: "observation",
          actor: "user",
          text: "an orphaned relation",
          source: ["T1#user"],
          createdAt: "2026-01-01T00:00:01Z",
          support: [{ target: "$99", strength: "weak" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems[0]).toMatch(/invalid local handle/);

    // no fact was committed...
    const facts = store.db.prepare("SELECT * FROM facts").all();
    expect(facts).toHaveLength(0);

    // ...but the run record was, with outcome "failure" (run record written on failure)
    const run = store.getRun(result.runId);
    expect(run).not.toBeNull();
    expect(run!.outcome).toBe("failure");
  });
});

describe("commitConsolidationRun: revision conflicts", () => {
  test("a stale expected revision rolls back the whole batch and records failure", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const entry = store.appendSourceEntry({ sessionId: s.id, turnId: t.id, nativeLineage: "fixture", nativeId: "stale-base-root",
      role: "user", text: "use pnpm", raw: "{}", calls: [] });
    store.selectSourcePath(s.id, "main", [entry.id]);
    const path = { sessionId: s.id, branch: "main", headTurnId: t.id };
    const origin = store.triggerOrigin(path, entry.id);
    const run = (createdAt: string) => store.bindRunOrigin({ kind: "noting" as const, sessionId: s.id, branch: "main", createdAt }, origin);
    const notingResult = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: [`T${t.id}#user`], entryIds: [entry.id], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(notingResult.ok).toBe(true);
    if (!notingResult.ok) return;
    const factId = notingResult.facts[0]!.id;

    const created = commitNoterKnowledge(store, {
      path, run: run("2026-01-01T00:01:00Z"),
      operations: [
        {
          op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.",
          handle: "$e1",
          author: "consolidation",
          text: "The project uses pnpm.",
          category: "constraint",
          scope: "project",
          supports: [factId],
          createdAt: "2026-01-01T00:01:00Z",
        },
      ],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const knowledgeId = created.committed[0]!.knowledgeId;
    const second = commitNoterKnowledge(store, { path, run: run("2026-01-01T00:01:30Z"), operations: [{
      op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e2", author: "consolidation",
      text: "A second, unrelated knowledge.", category: "reference", scope: "project", supports: [factId],
      createdAt: "2026-01-01T00:01:30Z",
    }] });
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Another writer's update lands first; the batch below is built on the old base.
    const updatedCommit = commitDreamerOps({ store }, path, [{ op: "update", knowledgeId, baseCommit: created.committed[0]!.commit,
      topics: [], reason: "Substantive correction of the recorded conclusion.", text: "The project uses pnpm exclusively.",
      category: "constraint", scope: "project", supports: [factId], createdAt: "2026-01-01T00:01:45Z" }])[0]!.commit;
    const revisionsBefore = store.listKnowledgeRevisions();
    const linksBefore = store.listKnowledgeLinks(second.committed[0]!.knowledgeId);
    const rejected = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: s.id, branch: path.branch, createdAt: "2026-01-01T00:02:00Z" }, operations: [
      { op: "archive", kind: "invalid", knowledgeId: second.committed[0]!.knowledgeId, baseCommit: second.committed[0]!.commit,
        text: "The independent fixture item no longer holds; the user withdrew it and nothing replaces it.",
        supports: [factId], reason: "Retire the independent fixture item.", createdAt: "2026-01-01T00:02:00Z" },
      { op: "update", knowledgeId, baseCommit: created.committed[0]!.commit, topics: [],
        reason: "Substantive correction of the recorded conclusion.", text: "A conflicting edit.", category: "constraint",
        scope: "project", supports: [factId], createdAt: "2026-01-01T00:02:00Z" },
    ] });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) throw new Error("stale Store batch unexpectedly committed");
    expect(rejected.problems).toEqual([`K${knowledgeId}@${created.committed[0]!.commit}: base is not the latest effective applicable revision; current: K${knowledgeId}@${updatedCommit}`]);
    expect(store.getRun(rejected.runId)).toMatchObject({ kind: "manual", outcome: "failure" });
    expect(store.listKnowledgeRevisions()).toEqual(revisionsBefore);
    expect(store.listKnowledgeLinks(second.committed[0]!.knowledgeId)).toEqual(linksBefore);
    expect(store.currentCommit(second.committed[0]!.knowledgeId).map(revision => revision.id)).toEqual([second.committed[0]!.commit]);
    expect(store.currentCommit(knowledgeId).map(revision => revision.id)).toEqual([updatedCommit]);
    expect(store.currentCommit(second.committed[0]!.knowledgeId)[0]?.op).toBe("create");
    const finalKnowledge = { knowledge: store.getKnowledge(knowledgeId)!, revision: store.currentCommit(knowledgeId)[0]! };
    expect(finalKnowledge.revision.id).toBe(updatedCommit);
    expect(finalKnowledge.revision.text).toBe("The project uses pnpm exclusively.");
  });
});

describe("project merge", () => {
  test("relabels sessions and project-scoped knowledge onto the survivor", () => {
    const from = store.createProject({ name: "undeclared-session-project", declaredBy: "marker" });
    const into = store.createProject({ name: "the-real-project", declaredBy: "mark" });
    const s = makeSession(from.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const user = seedEntry(store, s.id, t.id, "merger", "user", "use pnpm");
    const recorded = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: [`T${t.id}#user`], entryIds: [user.id], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const consolidated = commitNoterKnowledge(store, {
      run: { sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      operations: [
        {
          op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.",
          handle: "$e1",
          author: "consolidation",
          text: "The project uses pnpm.",
          category: "constraint",
          scope: "project",
          supports: [recorded.facts[0]!.id],
          createdAt: "2026-01-01T00:01:00Z",
        },
      ],
    });
    expect(consolidated.ok).toBe(true);
    if (!consolidated.ok) return;
    const knowledgeId = consolidated.committed[0]!.knowledgeId;

    store.mergeProject(from.id, into.id);

    expect(store.getProject(from.id)?.mergedInto).toBe(into.id);
    expect(store.getSession(s.id)?.projectId).toBe(into.id);
    expect(store.getKnowledge(knowledgeId)?.projectId).toBe(into.id);
  });
});

describe("visibility rule", () => {
  test("shows global and this project's knowledge, and only this session's session-scope knowledge", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const otherProject = store.createProject({ name: "other-proj", declaredBy: "mark" });
    const s1 = makeSession(p.id);
    const s2 = makeSession(p.id);
    const t1 = store.appendTurn({ sessionId: s1.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const initial = seedEntry(store, s1.id, t1.id, "scope-initial", "user", "context fact");

    const recorded = store.commitNotingRun({
      run: { kind: "noting", sessionId: s1.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t1.id, category: "observation", actor: "user", text: "context fact", source: [`T${t1.id}#user`], entryIds: [initial.id], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const factId = recorded.facts[0]!.id;

    // A knowledge item's project is the project of the session that consolidated it; only global knowledge have none.
    function newKnowledge(scope: "session" | "project" | "global", sessionId: number, text: string) {
      const turn = store.appendTurn({ sessionId, kind: "turn", startedAt: "2026-01-01T00:01:00Z" });
      const source = seedEntry(store, sessionId, turn.id, `scope-${turn.id}`, "user", "context fact");
      const evidence = store.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: "2026-01-01T00:01:00Z" }, facts: [
        { turnId: turn.id, category: "observation", actor: "user", text: "context fact", source: [`T${turn.id}#user`], entryIds: [source.id], createdAt: "2026-01-01T00:01:00Z" } ] });
      if (!evidence.ok) throw new Error("fixture evidence failed");
      const r = commitNoterKnowledge(store, {
        run: { sessionId, createdAt: "2026-01-01T00:01:00Z" },
        operations: [
          { op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text, category: "understanding", scope, supports: [evidence.facts[0]!.id], createdAt: "2026-01-01T00:01:00Z" },
        ],
      });
      if (!r.ok) throw new Error("setup failed");
      return r.committed[0]!.knowledgeId;
    }

    const s3 = makeSession(otherProject.id);
    const globalKnowledge = newKnowledge("global", s1.id, "A global working-method noting.");
    const projectKnowledge = newKnowledge("project", s1.id, "A project-wide term.");
    const session1Knowledge = newKnowledge("session", s1.id, "A session-only detail for s1.");
    const otherProjectKnowledge = newKnowledge("project", s3.id, "Belongs to a different project.");

    const visibleToS2 = store.listVisibleKnowledge(s2.id, p.id).map((e) => e.knowledge.id);
    expect(visibleToS2).toContain(globalKnowledge);
    expect(visibleToS2).toContain(projectKnowledge);
    expect(visibleToS2).not.toContain(session1Knowledge);
    expect(visibleToS2).not.toContain(otherProjectKnowledge);

    const visibleToS1 = store.listVisibleKnowledge(s1.id, p.id).map((e) => e.knowledge.id);
    expect(visibleToS1).toContain(session1Knowledge);
  });
});

describe("commit boundaries (ticket 01 review repairs)", () => {
  function seed() {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const entry = store.appendSourceEntry({ sessionId: s.id, turnId: t.id, nativeLineage: "fixture", nativeId: `seed-${s.id}`,
      role: "user", text: "use pnpm", raw: "{}", calls: [] });
    store.selectSourcePath(s.id, "main", [entry.id]);
    const recorded = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: [`T${t.id}#user`],
        entryIds: [entry.id], createdAt: "2026-01-01T00:00:01Z" }],
    });
    if (!recorded.ok) throw new Error(recorded.problems.join("; "));
    return { p, s, t, entry, factId: recorded.facts[0]!.id, path: { sessionId: s.id, branch: "main", headTurnId: t.id } };
  }
  const consolidationAt = "2026-01-01T00:01:00Z";

  test.each([
    ["revision", "knowledge_revisions", "id, knowledge_id, parent_id, text, category, scope, supports, op, reason, created_at"],
    ["tool ordinal", "tool_calls", "turn_id, ordinal, name, status"],
    ["turn ordinal", "turns", "session_id, ordinal, kind, started_at"],
  ])("database rejects a duplicate %s", (_name, table, columns) => {
    const { s, t, factId } = seed();
    const made = commitNoterKnowledge(store, { run: { sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "term", category: "understanding", scope: "session", supports: [factId], createdAt: consolidationAt }] });
    if (!made.ok) throw new Error(made.problems.join("; "));
    store.appendToolCall({ turnId: t.id, name: "bash", status: "success" });
    expect(() => store.db.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table} LIMIT 1`)).toThrow(/UNIQUE constraint failed/);
  });

  test.each([["event", null], ["decision", "completed"]])("database rejects category %s with status %s", (category, status) => {
    const { factId } = seed();
    expect(() => store.db.prepare("UPDATE facts SET category = ?, status = ? WHERE id = ?").run(category, status, factId)).toThrow(/CHECK constraint failed/);
  });

  test("database enforces fact ownership, knowledge origin, link revisions and watermark references", () => {
    const { s, factId } = seed();
    const made = commitNoterKnowledge(store, { run: { sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "term", category: "understanding", scope: "session", supports: [factId], createdAt: consolidationAt }] });
    if (!made.ok) throw new Error(made.problems.join("; "));
    const id = made.committed[0]!.knowledgeId;
    expect(() => store.db.exec("UPDATE facts SET run_id = NULL")).toThrow(/NOT NULL constraint failed/);
    for (const sql of [
      "UPDATE facts SET run_id = 999999",
      "UPDATE knowledge SET origin_session_id = 999999",
      `INSERT INTO knowledge_links VALUES (${id}, 999, 'merged_into', ${id}, 1)`,
      `INSERT INTO knowledge_links VALUES (${id}, 1, 'merged_into', ${id}, 999)`,
      "INSERT INTO source_paths(session_id, branch) VALUES (999999, 'main')",
      `INSERT INTO noted_entries VALUES (999999, 999999)`,
      "INSERT INTO consolidated_facts VALUES (999999, 1)",
      "INSERT INTO consolidated_facts VALUES (1, 999999)",
    ]) expect(() => store.db.exec(sql)).toThrow(/FOREIGN KEY constraint failed/);
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("64b: knowledge identity origin survives while global current scope hides the identity from other readers", () => {
    const { p, s, factId } = seed(), peer = makeSession(p.id);
    const turn = store.appendTurn({ sessionId: peer.id, kind: "turn", userPrompt: "private term", startedAt: consolidationAt });
    const entry = store.appendSourceEntry({ sessionId: peer.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "peer-private",
      role: "user", text: "private term", raw: "private term", calls: [] });
    store.selectSourcePath(peer.id, "main", [entry.id]);
    store.setCurrentPath(peer.id, "main", turn.id, "test-lineage");
    const recorded = store.commitNotingRun({ run: { kind: "noting", sessionId: peer.id, branch: "main", createdAt: consolidationAt }, entryIds: [entry.id],
      facts: [{ turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "private term",
        source: [`T${turn.id}#E${entry.entryOrdinal}`], createdAt: consolidationAt }] });
    if (!recorded.ok) throw new Error("setup failed");
    const peerFact = recorded.facts[0]!.id;
    const made = commitNoterKnowledge(store, { run: { sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "term", category: "understanding", scope: "project", supports: [factId], createdAt: consolidationAt }] });
    if (!made.ok) throw new Error("setup failed");
    const id = made.committed[0]!.knowledgeId;
    commitDreamerOps({ store }, { sessionId: peer.id, branch: "main", headTurnId: turn.id }, [{ op: "update", knowledgeId: id, baseCommit: made.committed[0]!.commit, topics: [],
      reason: "Substantive correction of the recorded conclusion.", text: "private term", category: "understanding", scope: "session", supports: [peerFact], createdAt: consolidationAt }]);
    const privateCommit = store.currentCommit(id, store.knowledgePath(peer.id))[0]!.id;
    const target = store.declareProject(peer.id, "destination", "mark", declarationContext(store, { sessionId: peer.id, branch: "main", headTurnId: turn.id }));
    const survivor = store.createProject({ name: "survivor", declaredBy: "mark" });
    store.mergeProject(target.id, survivor.id);
    store.close(); store = new Store(dbPath);
    expect(store.getKnowledge(id)?.originSessionId).toBe(s.id);
    expect(store.currentCommit(id, store.knowledgePath(peer.id)).map(r => r.id)).toEqual([privateCommit]);
    expect(store.currentCommit(id, store.knowledgePath(s.id)).map(r => r.id)).toEqual([]);
  });

  test("64b: a scope change moves the knowledge's ownership, so it stays visible after reopening", () => {
    const { p, s, t, factId } = seed();
    const made = commitNoterKnowledge(store, {
      run: { sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text: "Use pnpm.", category: "constraint", scope: "global", supports: [factId], createdAt: consolidationAt }],
    });
    if (!made.ok) throw new Error("setup failed");
    const id = made.committed[0]!.knowledgeId;
    expect(store.getKnowledge(id)!.projectId).toBe(p.id);
    commitDreamerOps({ store }, { sessionId: s.id, branch: "main", headTurnId: t.id }, [{ op: "update", knowledgeId: id, baseCommit: made.committed[0]!.commit, topics: [],
      reason: "Substantive correction of the recorded conclusion.", text: "Use pnpm here.", category: "constraint", scope: "project", supports: [factId], createdAt: consolidationAt }]);
    store.close();
    store = new Store(dbPath);
    expect(store.getKnowledge(id)!.projectId).toBe(p.id);
    expect(store.listVisibleKnowledge(s.id, p.id).map((e) => e.knowledge.id)).toContain(id);
  });

  test("34a merge rejects self and duplicate parents instead of normalizing them away", () => {
    const { s, factId, path } = seed();
    const mk = (text: string) =>
      commitNoterKnowledge(store, {
        run: { sessionId: s.id, createdAt: consolidationAt },
        operations: [{ op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text, category: "understanding", scope: "project", supports: [factId], createdAt: consolidationAt }],
      });
    const a = mk("A");
    const b = mk("B");
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const aId = a.committed[0]!.knowledgeId;
    const bId = b.committed[0]!.knowledgeId;
    const common = { topics: [], reason: "Merged duplicate knowledge into the survivor.", text: "A", category: "understanding" as const,
      scope: "project" as const, supports: [factId], createdAt: consolidationAt };
    const run = { kind: "dreaming" as const, sessionId: s.id, branch: path.branch, createdAt: consolidationAt };
    const [self, duplicate] = store.commitWorkspaceRun({ path, run, operations: [{ op: "merge", intoKnowledgeId: aId,
      intoBaseCommit: a.committed[0]!.commit, absorb: [{ knowledgeId: aId, baseCommit: a.committed[0]!.commit }], ...common },
    { op: "merge", intoKnowledgeId: aId, intoBaseCommit: a.committed[0]!.commit, absorb: [{ knowledgeId: bId, baseCommit: b.committed[0]!.commit },
      { knowledgeId: bId, baseCommit: b.committed[0]!.commit }], ...common, text: "A and B" }] }).results;
    expect(self).toMatchObject({ ok: false });
    if (!self!.ok) expect(self!.reason).toContain("duplicate merge parent");
    expect(duplicate).toMatchObject({ ok: false });
    if (!duplicate!.ok) expect(duplicate!.reason).toContain("duplicate merge parent");
    expect(store.currentCommit(aId)[0]?.op).toBe("create");
    expect(store.currentCommit(bId)[0]?.op).toBe("create");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_links WHERE from_knowledge = ?").get(bId)).toEqual({ n: 0 });
  });

  test("a merge keeps the named primary's identity, even when the primary is the newer item, beside another valid operation", () => {
    const { s, factId, path } = seed();
    const run = { kind: "manual" as const, sessionId: s.id, createdAt: consolidationAt };
    const create = (text: string) => {
      const result = store.commitConsolidationRun({ run, operations: [{ op: "create", title: "Fixture title", handle: "$e1", author: "test",
        text, category: "understanding", scope: "project", supports: [factId], reason: "admit identity", topics: [], createdAt: consolidationAt }] });
      if (!result.ok) throw new Error(result.problems.join("; "));
      return result.committed[0]!;
    };
    const older = create("older"), newer = create("newer"), independent = create("independent");
    const merged = store.commitWorkspaceRun({ path, run: { kind: "dreaming", sessionId: s.id, branch: path.branch, createdAt: consolidationAt }, operations: [
      { op: "archive", kind: "invalid", knowledgeId: independent.knowledgeId, baseCommit: independent.commit, supports: [factId],
        text: "The independent item no longer holds; the user withdrew it and nothing replaces it.", reason: "Independent legal batch item", createdAt: consolidationAt },
      { op: "merge", intoKnowledgeId: newer.knowledgeId, intoBaseCommit: newer.commit,
        absorb: [{ knowledgeId: older.knowledgeId, baseCommit: older.commit }], text: "combined", category: "understanding",
        scope: "project", supports: [factId], reason: "Merge into the newer item", topics: ["identity"], createdAt: consolidationAt },
    ] });
    const [archived, mergeResult] = merged.results;
    if (!archived!.ok || !mergeResult!.ok) throw new Error(JSON.stringify(merged.results));
    const primary = mergeResult!.committed[0]!;
    expect(primary).toMatchObject({ op: "merge", knowledgeId: newer.knowledgeId });
    expect(store.knowledgeRevision(primary.commit)).toMatchObject({ knowledgeId: newer.knowledgeId, parentId: newer.commit,
      text: "combined", supports: [factId], reason: "Merge into the newer item", topics: ["identity"] });
    expect(store.listKnowledgeLinks(older.knowledgeId)).toContainEqual({ fromKnowledge: older.knowledgeId,
      fromCommit: older.commit, kind: "merged_into", toKnowledge: newer.knowledgeId, toCommit: primary.commit });
    expect(store.revisionGrounds(store.knowledgeRevision(primary.commit)!)).toEqual(new Set([factId]));
    expect(store.currentCommit(older.knowledgeId)).toEqual([]);
    expect(store.currentCommit(independent.knowledgeId)[0]?.op).toBe("archive");
    expect(store.currentCommit(newer.knowledgeId)[0]?.op).toBe("merge");
    expect(store.currentCommit(independent.knowledgeId)[0]?.op).toBe("archive");
  });

  test("135: a Noter create may carry a legacy category only as the audited conversion of its own update to that base", () => {
    const { s, factId, path } = seed();
    const legacy = legacyKnowledge(store, path, { text: "legacy rule", category: "mechanism", scope: "project", supports: [factId], topics: ["packages"] });
    const noter = { sessionId: s.id, createdAt: consolidationAt };
    const content = { title: "Legacy rule", scope: "project" as const, supports: [factId], reason: "Clarify the legacy rule", topics: ["packages"], createdAt: consolidationAt };
    const create = (category: string) => commitNoterKnowledge(store, { path, run: noter, operations: [{ op: "create", handle: "$e1", author: "test",
      text: "new rule", ...content, category: category as never }] });
    const update = (category: string) => commitNoterKnowledge(store, { path, run: noter, operations: [{ op: "update", knowledgeId: legacy.knowledgeId,
      baseCommit: legacy.commit, text: "edited legacy rule", ...content, category: category as never }] });
    const before = store.listKnowledgeRevisions();
    // A plain create has no base to inherit from, so a legacy category is refused.
    expect(create("mechanism").ok).toBe(false);
    expect(store.listKnowledgeRevisions()).toEqual(before);
    // A current base is updated in place, keeping its own legacy category and no other.
    expect(update("term").ok).toBe(false);
    expect(store.listKnowledgeRevisions()).toEqual(before);
    // Once a descendant advances the base, the same update converts to a create that keeps the base's category.
    const advanced = store.commitConsolidationRun({ path, run: { kind: "manual", ...noter }, operations: [{ op: "update", knowledgeId: legacy.knowledgeId,
      baseCommit: legacy.commit, text: "advanced rule", ...content, category: "understanding" }] });
    if (!advanced.ok) throw new Error(advanced.problems.join("; "));
    expect(update("term").ok).toBe(false);
    expect(create("mechanism").ok).toBe(false);
    const converted = update("mechanism");
    if (!converted.ok) throw new Error(converted.problems.join("; "));
    expect(store.knowledgeRevision(converted.committed[0]!.commit)).toMatchObject({ op: "create", category: "mechanism", topics: ["packages"] });
    expect(store.knowledgeRevision(converted.committed[0]!.commit)!.text).toContain("edited legacy rule");
    expect(store.currentCommit(legacy.knowledgeId)[0]!.text).toBe("advanced rule");
  });

  test("92: an N batch commits create and archive together; a forbidden op still rolls back the whole batch atomically", () => {
    const { s, factId } = seed();
    const manual = { kind: "manual" as const, sessionId: s.id, createdAt: consolidationAt };
    const created = store.commitConsolidationRun({ run: manual, operations: [{ op: "create", title: "Fixture title", handle: "$base", author: "test",
      text: "continuing rule", category: "constraint", scope: "project", supports: [factId], reason: "admit rule",
      topics: [], createdAt: consolidationAt }] });
    if (!created.ok) throw new Error(created.problems.join("; "));
    const item = created.committed[0]!;
    const archive = { op: "archive" as const, kind: "invalid" as const, text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", knowledgeId: item.knowledgeId, baseCommit: item.commit,
      supports: [factId], reason: "retire rule", createdAt: consolidationAt };
    // N owns create and archive; terminal publication commits both atomically.
    const accepted = commitNoterKnowledge(store, { run: { sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", title: "Fixture title", handle: "$partial", author: "test", text: "commits alongside the archive", category: "understanding",
        scope: "project", supports: [factId], reason: "mixed item", topics: [], createdAt: consolidationAt }, archive] });
    expect(accepted.ok).toBe(true);
    if (!accepted.ok) return;
    expect(accepted.committed.map(op => op.op)).toEqual(["create", "archive"]);
    expect(store.currentCommit(item.knowledgeId)[0]).toMatchObject({ op: "archive", archiveKind: "invalid", actorRole: "noting" });

    // A batch mixing a legal op with one forbidden to N (merge) rolls back whole.
    const before = store.listKnowledgeRevisions();
    const currentBase = store.currentCommit(item.knowledgeId)[0]!.id;
    const rejected = commitNoterKnowledge(store, { run: { sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", title: "Fixture title", handle: "$partial2", author: "test", text: "must roll back", category: "understanding",
        scope: "project", supports: [factId], reason: "mixed item", topics: [], createdAt: consolidationAt },
        { op: "merge", intoKnowledgeId: item.knowledgeId, intoBaseCommit: currentBase,
          absorb: [{ knowledgeId: item.knowledgeId, baseCommit: currentBase }],
          category: "reference", scope: "project", supports: [factId], reason: "forbidden", topics: [], createdAt: consolidationAt }] });
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.problems.join(" ")).toContain("Noter permits create, update and archive only");
    expect(store.listKnowledgeRevisions()).toEqual(before);
  });

  test("a noting commit rejects turns and watermarks outside its own session and branch", () => {
    const { s, t } = seed();
    const p2 = store.createProject({ name: "other", declaredBy: "mark" });
    const s2 = makeSession(p2.id);
    const t2 = store.appendTurn({ sessionId: s2.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const fact = { category: "observation" as const, actor: "user" as const, text: "x", source: ["T1#user"], createdAt: consolidationAt };
    const foreignTurn = store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: consolidationAt }, facts: [{ ...fact, turnId: t2.id }] });
    expect(foreignTurn.ok).toBe(false);
    // 17a supersedes Turn watermark writes with exact entry membership.
    const foreignEntry = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: consolidationAt },
      facts: [{ ...fact, turnId: t.id }],
      entryIds: [999999],
    });
    expect(foreignEntry.ok).toBe(false);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM facts").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE outcome = 'failure'").get()).toEqual({ n: 2 });
  });

  test("a local handle may only point at an earlier fact of the batch", () => {
    const { s, t } = seed();
    const fact = { turnId: t.id, category: "observation" as const, actor: "agent" as const, source: ["T1#assistant"], createdAt: consolidationAt };
    const forward = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: consolidationAt },
      facts: [
        { ...fact, text: "first" },
        { ...fact, text: "second", support: [{ target: "$3", strength: "weak" }] },
        { ...fact, text: "third" },
      ],
    });
    expect(forward.ok).toBe(false);
    const self = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: consolidationAt },
      facts: [{ ...fact, text: "loop", support: [{ target: "$1", strength: "weak" }] }],
    });
    expect(self.ok).toBe(false);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM fact_relations").get()).toEqual({ n: 0 });
  });

  test("cited facts must exist and supports must not be empty; marks bind to an existing revision", () => {
    const { s, factId } = seed();
    const run = { kind: "manual" as const, sessionId: s.id, createdAt: consolidationAt };
    for (const [supports, problem] of [[ [999999], "F999999 does not exist" ], [ [], "must not be empty" ]] as const) {
      const r = store.commitConsolidationRun({ run, operations: [
        { op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text: "invalid", category: "understanding", scope: "project", supports: [...supports], createdAt: consolidationAt },
      ] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.problems.join(" ")).toContain(problem);
    }
    const r = store.commitConsolidationRun({ run, operations: [
      { op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", handle: "$e3", author: "consolidation", text: "fine", category: "understanding", scope: "project", supports: [factId], createdAt: consolidationAt },
    ] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = r.committed[0]!.knowledgeId;
    const archive = store.commitConsolidationRun({
      run: { kind: "manual", sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "archive", kind: "invalid", text: "Withdrawn: the user retired this and nothing replaces it, per the cited fact.", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: id, baseCommit: 1, supports: [999998], createdAt: consolidationAt }],
    });
    expect(archive.ok).toBe(false);
    expect(store.currentCommit(id)[0]?.op).toBe("create");

  });

  test("an N terminal rejection rolls back facts, knowledge and Raw progress; foreign entries cannot be marked", () => {
    const { s, t, factId, path } = seed();
    const entryIds = store.pendingEntryIds(s.id, "main", t.id);
    expect(entryIds).toHaveLength(1);
    const before = store.listSessionFacts(s.id);
    const r = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: consolidationAt },
      facts: [{ turnId: t.id, text: "new fact must roll back", source: [`T${t.id}#E1`], entryIds, createdAt: consolidationAt }],
      entryIds,
      held: { path, slots: [1], validate() {}, knowledge: ids => [
        { op: "create", title: "Fixture title", topics: [], reason: "new evidence", handle: "$e1", author: "noting", text: "ok", category: "understanding", scope: "project", supports: [ids.get(1)!], createdAt: consolidationAt },
        { op: "update", topics: [], reason: "invalid target", knowledgeId: 424242, baseCommit: 1, text: "gone", category: "understanding", scope: "project", supports: [factId], createdAt: consolidationAt },
      ] },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toContain("K424242");
    expect(store.listSessionFacts(s.id)).toEqual(before);
    expect(store.listVisibleKnowledge(s.id, store.getSession(s.id)!.projectId)).toEqual([]);
    expect(store.pendingEntryIds(s.id, "main", t.id)).toEqual(entryIds);
    expect(store.listConsolidatedProjectFacts(store.getSession(s.id)!.projectId)).toEqual([]);
    const other = makeSession(store.createProject({ name: "foreign-progress", declaredBy: "mark" }).id);
    const turn = store.appendTurn({ sessionId: other.id, kind: "turn", startedAt: consolidationAt });
    const foreignEntry = store.appendSourceEntry({ sessionId: other.id, turnId: turn.id, nativeLineage: "foreign", nativeId: "u",
      role: "user", text: "foreign", raw: "foreign", calls: [] });
    const foreign = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: consolidationAt }, facts: [], entryIds: [foreignEntry.id],
      held: { path, slots: [], validate() {}, knowledge: () => [{ op: "create", title: "Fixture title", topics: [], reason: "must roll back", handle: "$e1", author: "noting", text: "ok", category: "understanding", scope: "project", supports: [factId], createdAt: consolidationAt }] },
    });
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.problems.join(" ")).toMatch(/entry|session/i);
    expect(store.pendingEntryIds(s.id, "main", t.id)).toEqual(entryIds);
    expect(store.listVisibleKnowledge(s.id, store.getSession(s.id)!.projectId)).toEqual([]);
  });

  test("a short write lock held by another process delays the commit instead of losing it", async () => {
    const { s, t, entry: boundEntry, factId } = seed();
    const holder = spawn(process.execPath, ["--input-type=module", "-e", `
      import { DatabaseSync } from "node:sqlite";
      import { setTimeout } from "node:timers/promises";
      const d = new DatabaseSync(${JSON.stringify(dbPath)});
      d.exec("BEGIN IMMEDIATE");
      process.stdout.write("locked\\n");
      await setTimeout(180);
      d.exec("COMMIT");
      d.close();
    `], { stdio: ["ignore", "pipe", "inherit"] });
    const exited = once(holder, "exit");
    await once(holder.stdout, "data"); // the other process now holds the lock
    const started = performance.now();
    const r = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: consolidationAt },
      facts: [{ turnId: t.id, category: "observation", actor: "user", text: "written under contention", source: [`T${t.id}#user`], entryIds: [boundEntry.id], createdAt: consolidationAt }],
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect((await exited)[0]).toBe(0);
    expect(r.ok).toBe(true);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 2 });

    // 17c 2026-09-08 extends this real-process write-lock seam with task admission and fencing.
    const entry = store.appendSourceEntry({ sessionId: s.id, turnId: t.id, nativeId: "pending", nativeLineage: "process-test",
      role: "user", text: "pending evidence", raw: "pending evidence", calls: [] });
    store.selectSourcePath(s.id, "main", [boundEntry.id, entry.id]);
    const pendingBefore = store.pendingEntries(s.id, "main", t.id).map(item => item.id);
    expect(pendingBefore).toContain(entry.id);
    const knowledge = store.commitConsolidationRun({ run: { kind: "manual", sessionId: s.id, createdAt: consolidationAt }, operations: [{
      op: "create", title: "Fixture title", handle: "$pending", author: "test", text: "pending maintenance", category: "constraint", scope: "session",
      supports: [factId], reason: "evidence", topics: [], createdAt: consolidationAt,
    }] });
    if (!knowledge.ok) throw Error(knowledge.problems.join("; "));
    store.closeSession(s.id);
    // A Dreamer is due on a hand-off row (stage 4 §2.4); the manual item above is not a Noter change.
    writeHandoff(store, { sessionId: s.id, phase: "dreaming", nextTask: "curate", branch: null, entryIds: [], detail: { operation: "update" },
      runId: store.recordRun({ kind: "dreaming", sessionId: s.id, branch: "main", createdAt: consolidationAt, outcome: "success" }).id });
    const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
    const clock = Date.now();
    const workers = ["process-a", "process-b"].map(executor => spawn(process.execPath, ["--input-type=module", "-e", `
      import { Store } from ${JSON.stringify(new URL("../../../src/core/store/index.ts", import.meta.url).href)};
      const store = new Store(${JSON.stringify(dbPath)});
      Date.now = () => ${clock};
      process.on("message", () => process.send(["noting", "dreaming"].map(phase =>
        store.acquireClaim(${JSON.stringify(target)}, phase, ${JSON.stringify(executor)}, phase === "noting"))));
      process.send("ready");
    `], { stdio: ["ignore", "pipe", "inherit", "ipc"] }));
    const exits = workers.map(worker => once(worker, "exit"));
    try {
      await Promise.all(workers.map(worker => once(worker, "message")));
      const results = workers.map(worker => once(worker, "message"));
      workers.forEach(worker => worker.send("race"));
      const claims = (await Promise.all(results)).flatMap(([value]) => value as (import("../../../src/core/store/index.ts").TaskClaim | null)[]).filter(c => c !== null);
      expect(claims.map(c => c.phase).sort()).toEqual(["dreaming", "noting"]);
      expect(claims.every(c => c.expiresAt === clock + 30 * 60_000)).toBe(true);
      workers.forEach(worker => worker.kill("SIGKILL"));
      await Promise.all(exits);
      expect(store.getSession(s.id)!.closedAt).not.toBeNull();
      const dreamClaim = claims.find(claim => claim.phase === "dreaming")!;
      expect(dreamClaim).toBeDefined();
      const time = vi.spyOn(Date, "now").mockReturnValue(clock + 30 * 60_000);
      try {
        for (const stale of claims) {
          const replacement = store.acquireClaim(target, stale.phase, "replacement-process", stale.phase === "noting")!;
          expect(replacement).not.toBeNull(); expect(replacement.token).not.toBe(stale.token);
          const run = { kind: stale.phase, sessionId: s.id, branch: "main", claim: stale, createdAt: consolidationAt };
          if (stale.phase === "noting") {
            const rejected = store.commitNotingRun({ run, facts: [], entryIds: [entry.id] });
            expect(rejected.ok).toBe(false);
            if (!rejected.ok) expect(rejected.problems.join(" ")).toMatch(/claim|range/i);
          } else expect(() => store.commitTaskPass({ run, path: target, handoff: () => null })).toThrow(/claim/i);
          expect(store.releaseClaim(stale)).toBe(false);
          expect(store.getClaim(s.id, stale.phase)!.token).toBe(replacement.token);
          expect(store.releaseClaim(replacement)).toBe(true);
        }
        expect(store.pendingEntries(s.id, "main", t.id).map(item => item.id)).toEqual(pendingBefore);
        expect(store.consolidationBatch(s.id, "main", t.id).length).toBeGreaterThan(0);
        const live = makeSession(store.getSession(s.id)!.projectId);
        const liveTurn = store.appendTurn({ sessionId: live.id, kind: "turn", startedAt: consolidationAt });
        store.appendSourceEntry({ sessionId: live.id, turnId: liveTurn.id, nativeId: "live", nativeLineage: "process-test", role: "user", text: "live", raw: "live", calls: [] });
        const livePath = { sessionId: live.id, branch: "main", headTurnId: liveTurn.id };
        expect(store.acquireClaim(livePath, "noting", "crashed", false)).not.toBeNull();
        time.mockReturnValue(clock + 60 * 60_000);
        expect(store.getSession(live.id)!.closedAt).toBeNull();
        expect(store.acquireClaim(livePath, "noting", "borrower", true)).toBeNull();
        expect(store.acquireClaim(livePath, "noting", "resumed", false)).not.toBeNull();
      } finally { time.mockRestore(); }
    } finally {
      workers.forEach(worker => { if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL"); });
      await Promise.allSettled(exits);
    }
  });
});

describe("incremental raw noting", () => {
  test("a turn is appended at the prompt and completed later with its assistant text and end time", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "hi", startedAt: "2026-01-01T00:00:00Z" });
    expect(t.assistantText).toBeNull();
    const done = store.updateTurn(t.id, { assistantText: "hello", endedAt: "2026-01-01T00:00:09Z" });
    expect(done.assistantText).toBe("hello");
    expect(done.endedAt).toBe("2026-01-01T00:00:09Z");
    expect(store.updateTurn(t.id, { endedAt: null }).assistantText).toBe("hello");
    expect(() => store.updateTurn(424242, { assistantText: "x" })).toThrow("does not exist");
  });
});
