import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../../../src/core/store/index.ts";

let dir: string;
let dbPath: string;
let store: Store;

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
      "knowledge_marks",
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
    const r1 = store.commitNotingRun({
      run: { kind: "noting", sessionId: s1.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t1.id, category: "observation", actor: "user", text: "fact one", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(r1.ok).toBe(true);
    const s2 = makeSession(p2.id);
    const t2 = store.appendTurn({ sessionId: s2.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const r2 = store.commitNotingRun({
      run: { kind: "noting", sessionId: s2.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t2.id, category: "observation", actor: "user", text: "fact two", source: ["T2#user"], createdAt: "2026-01-01T00:00:01Z" }],
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
    const result = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [
        { turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" },
        {
          turnId: t.id,
          category: "event",
          actor: "agent",
          status: "completed",
          text: "switched the lockfile to pnpm",
          source: ["T1#t1"],
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
    const first = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
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
          source: ["T2#user"],
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
    const notingResult = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(notingResult.ok).toBe(true);
    if (!notingResult.ok) return;
    const factId = notingResult.facts[0]!.id;

    const created = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      operations: [
        {
          op: "create", topics: [], reason: "Initial admission of this conclusion.",
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

    // a first edit against revision 1 succeeds and moves the knowledge to revision 2...
    const round2 = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, createdAt: "2026-01-01T00:02:00Z" },
      operations: [
        {
          op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
          knowledgeId,
          baseCommit: 1,
          text: "The project uses pnpm exclusively.",
          category: "constraint",
          scope: "project",
          supports: [factId],
          createdAt: "2026-01-01T00:02:00Z",
        },
      ],
    });
    expect(round2.ok).toBe(true);
    if (!round2.ok) return;
    expect(round2.committed).toHaveLength(1);

    // A stale update rejects the whole batch, including earlier writes.
    const round3 = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, createdAt: "2026-01-01T00:03:00Z" },
      operations: [
        {
          op: "create", topics: [], reason: "Initial admission of this conclusion.",
          handle: "$e2",
          author: "consolidation",
          text: "A second, unrelated knowledge.",
          category: "reference",
          scope: "project",
          supports: [factId],
          createdAt: "2026-01-01T00:03:00Z",
        },
        {
          op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.",
          knowledgeId,
          baseCommit: 1, // stale: the knowledge is now at revision 2
          text: "A conflicting edit.",
          category: "constraint",
          scope: "project",
          supports: [factId],
          createdAt: "2026-01-01T00:03:00Z",
        },
      ],
    });
    expect(round3.ok).toBe(false);
    if (round3.ok) return;
    expect(round3.problems.join(" ")).toMatch(/moved/);
    expect(store.getKnowledge(knowledgeId + 1)).toBeNull();
    expect(store.getRun(round3.runId)?.outcome).toBe("failure");

    // the knowledge itself still holds the round-2 text, untouched by the rejected round-3 edit
    const finalKnowledge = { knowledge: store.getKnowledge(knowledgeId)!, revision: store.currentCommit(knowledgeId)[0]! };
    expect(finalKnowledge.revision.id).toBe(2);
    expect(finalKnowledge.revision.text).toBe("The project uses pnpm exclusively.");
  });
});

describe("project merge", () => {
  test("relabels sessions and project-scoped knowledge onto the survivor", () => {
    const from = store.createProject({ name: "undeclared-session-project", declaredBy: "marker" });
    const into = store.createProject({ name: "the-real-project", declaredBy: "mark" });
    const s = makeSession(from.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const recorded = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const consolidated = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      operations: [
        {
          op: "create", topics: [], reason: "Initial admission of this conclusion.",
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

    const recorded = store.commitNotingRun({
      run: { kind: "noting", sessionId: s1.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t1.id, category: "observation", actor: "user", text: "context fact", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    const factId = recorded.facts[0]!.id;

    // A knowledge item's project is the project of the session that consolidated it; only global knowledge have none.
    function newKnowledge(scope: "session" | "project" | "global", sessionId: number, text: string) {
      const turn = store.appendTurn({ sessionId, kind: "turn", startedAt: "2026-01-01T00:01:00Z" });
      const evidence = store.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: "2026-01-01T00:01:00Z" }, facts: [
        { turnId: turn.id, category: "observation", actor: "user", text: "context fact", source: [`T${turn.id}#user`], createdAt: "2026-01-01T00:01:00Z" } ] });
      if (!evidence.ok) throw new Error("fixture evidence failed");
      const r = store.commitConsolidationRun({
        run: { kind: "consolidation", sessionId, createdAt: "2026-01-01T00:01:00Z" },
        operations: [
          { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text, category: "term", scope, supports: [evidence.facts[0]!.id], createdAt: "2026-01-01T00:01:00Z" },
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

describe("marks", () => {
  test("records a mark on a knowledge item revision", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const recorded = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    if (!recorded.ok) throw new Error("setup failed");
    const consolidated = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      operations: [
        { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text: "Use pnpm.", category: "constraint", scope: "project", supports: [recorded.facts[0]!.id], createdAt: "2026-01-01T00:01:00Z" },
      ],
    });
    if (!consolidated.ok) throw new Error("setup failed");
    const knowledgeId = consolidated.committed[0]!.knowledgeId;
    store.addKnowledgeMark(knowledgeId, 1, "verified", "2026-01-01T00:02:00Z");
    expect(store.listKnowledgeMarks(knowledgeId)).toHaveLength(1);
    expect(store.listKnowledgeMarks(knowledgeId)[0]!.kind).toBe("verified");
  });

  // 29d supersedes "queues and clears a pending delivery bound to a branch": the queue and both of its
  // operations are retired. The table itself is still created for published Beta databases, which the
  // schema test above pins by name, and 29d's own test opens such a database read-only.
});

describe("commit boundaries (ticket 01 review repairs)", () => {
  function seed() {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const recorded = store.commitNotingRun({
      run: { kind: "noting", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    if (!recorded.ok) throw new Error("seed failed");
    return { p, s, t, factId: recorded.facts[0]!.id };
  }
  const consolidationAt = "2026-01-01T00:01:00Z";

  test.each([
    ["revision", "knowledge_revisions", "id, knowledge_id, parent_id, text, category, scope, supports, op, reason, created_at"],
    ["tool ordinal", "tool_calls", "turn_id, ordinal, name, status"],
    ["turn ordinal", "turns", "session_id, ordinal, kind, started_at"],
    ["revision mark", "knowledge_marks", "knowledge_id, commit_id, kind, created_at"],
  ])("database rejects a duplicate %s", (_name, table, columns) => {
    const { s, t, factId } = seed();
    const made = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "term", category: "term", scope: "session", supports: [factId], createdAt: consolidationAt }] });
    if (!made.ok) throw new Error("setup failed");
    store.appendToolCall({ turnId: t.id, name: "bash", status: "success" });
    store.addKnowledgeMark(made.committed[0]!.knowledgeId, 1, "verified", consolidationAt);
    expect(() => store.db.exec(`INSERT INTO ${table} (${columns}) SELECT ${columns} FROM ${table} LIMIT 1`)).toThrow(/UNIQUE constraint failed/);
  });

  test.each([["event", null], ["decision", "completed"]])("database rejects category %s with status %s", (category, status) => {
    const { factId } = seed();
    expect(() => store.db.prepare("UPDATE facts SET category = ?, status = ? WHERE id = ?").run(category, status, factId)).toThrow(/CHECK constraint failed/);
  });

  test("database enforces fact ownership, knowledge origin, link revisions and watermark references", () => {
    const { s, factId } = seed();
    const made = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "term", category: "term", scope: "session", supports: [factId], createdAt: consolidationAt }] });
    if (!made.ok) throw new Error("setup failed");
    const id = made.committed[0]!.knowledgeId;
    expect(() => store.db.exec("UPDATE facts SET run_id = NULL")).toThrow(/NOT NULL constraint failed/);
    for (const sql of [
      "UPDATE facts SET run_id = 999999",
      "UPDATE knowledge SET origin_session_id = 999999",
      `INSERT INTO knowledge_links VALUES (${id}, 999, 'merged_into', ${id}, 1)`,
      `INSERT INTO knowledge_links VALUES (${id}, 1, 'merged_into', ${id}, 999)`,
      "INSERT INTO source_paths VALUES (999999, 'main', '[]')",
      `INSERT INTO noted_entries VALUES (999999, 999999)`,
      "INSERT INTO consolidated_facts VALUES (999999, 1)",
      "INSERT INTO consolidated_facts VALUES (1, 999999)",
    ]) expect(() => store.db.exec(sql)).toThrow(/FOREIGN KEY constraint failed/);
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  test("knowledge origin survives another session's edit and project moves without revision-one ownership", () => {
    const { p, s, factId } = seed(), peer = makeSession(p.id);
    const turn = store.appendTurn({ sessionId: peer.id, kind: "turn", startedAt: consolidationAt });
    const recorded = store.commitNotingRun({ run: { kind: "noting", sessionId: peer.id, createdAt: consolidationAt },
      facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "private term", source: [`T${turn.id}#user`], createdAt: consolidationAt }] });
    if (!recorded.ok) throw new Error("setup failed");
    const peerFact = recorded.facts[0]!.id;
    const made = store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "test", text: "term", category: "term", scope: "project", supports: [factId], createdAt: consolidationAt }] });
    if (!made.ok) throw new Error("setup failed");
    const id = made.committed[0]!.knowledgeId;
    expect(store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: peer.id, createdAt: consolidationAt },
      operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: id, baseCommit: 1, text: "private term", category: "term", scope: "session", supports: [peerFact], createdAt: consolidationAt }] }).ok).toBe(true);
    const target = store.declareProject(peer.id, "destination", "mark");
    const survivor = store.createProject({ name: "survivor", declaredBy: "mark" });
    store.mergeProject(target.id, survivor.id);
    store.close(); store = new Store(dbPath);
    expect(store.getKnowledge(id)?.originSessionId).toBe(s.id);
    expect(store.currentCommit(id, store.knowledgePath(peer.id)).map(r => r.id)).toEqual([2]);
    expect(store.currentCommit(id, store.knowledgePath(s.id)).map(r => r.id)).toEqual([1]);
  });

  test("a scope change moves the knowledge's ownership, so it stays visible after reopening", () => {
    const { p, s, factId } = seed();
    const made = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text: "Use pnpm.", category: "constraint", scope: "global", supports: [factId], createdAt: consolidationAt }],
    });
    if (!made.ok) throw new Error("setup failed");
    const id = made.committed[0]!.knowledgeId;
    expect(store.getKnowledge(id)!.projectId).toBe(p.id);
    const edited = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: id, baseCommit: 1, text: "Use pnpm here.", category: "constraint", scope: "project", supports: [factId], createdAt: consolidationAt }],
    });
    expect(edited.ok).toBe(true);
    store.close();
    store = new Store(dbPath);
    expect(store.getKnowledge(id)!.projectId).toBe(p.id);
    expect(store.listVisibleKnowledge(s.id, p.id).map((e) => e.knowledge.id)).toContain(id);
  });

  test("a knowledge item cannot absorb itself; duplicate absorb targets collapse to one", () => {
    const { s, factId } = seed();
    const mk = (text: string) =>
      store.commitConsolidationRun({
        run: { kind: "consolidation", sessionId: s.id, createdAt: consolidationAt },
        operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text, category: "term", scope: "project", supports: [factId], createdAt: consolidationAt }],
      });
    const a = mk("A");
    const b = mk("B");
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const aId = a.committed[0]!.knowledgeId;
    const bId = b.committed[0]!.knowledgeId;
    const run = { kind: "consolidation" as const, sessionId: s.id, createdAt: consolidationAt };
    const rejected = store.commitConsolidationRun({ run, operations: [
      { op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", intoKnowledgeId: aId, intoBaseCommit: 1, absorb: [{ knowledgeId: aId, baseCommit: 1 }], text: "A", category: "term", scope: "project", supports: [factId], createdAt: consolidationAt },
    ] });
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.problems.join(" ")).toContain("cannot absorb itself");
    const merged = store.commitConsolidationRun({ run, operations: [
      { op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", intoKnowledgeId: aId, intoBaseCommit: 1, absorb: [{ knowledgeId: bId, baseCommit: 2 }, { knowledgeId: bId, baseCommit: 2 }], text: "A and B", category: "term", scope: "project", supports: [factId], createdAt: consolidationAt },
    ] });
    expect(merged.ok).toBe(true);
    expect(store.currentCommit(aId)[0]?.op).toBe("merge");
    expect(store.currentCommit(bId)[0]?.op).toBeUndefined();
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_links WHERE from_knowledge = ?").get(bId)).toEqual({ n: 1 });
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
    const run = { kind: "consolidation" as const, sessionId: s.id, createdAt: consolidationAt };
    for (const [supports, problem] of [[ [999999], "F999999 does not exist" ], [ [], "must not be empty" ]] as const) {
      const r = store.commitConsolidationRun({ run, operations: [
        { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text: "invalid", category: "term", scope: "project", supports: [...supports], createdAt: consolidationAt },
      ] });
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.problems.join(" ")).toContain(problem);
    }
    const r = store.commitConsolidationRun({ run, operations: [
      { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e3", author: "consolidation", text: "fine", category: "term", scope: "project", supports: [factId], createdAt: consolidationAt },
    ] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const id = r.committed[0]!.knowledgeId;
    const archive = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, createdAt: consolidationAt },
      operations: [{ op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", knowledgeId: id, baseCommit: 1, supports: [999998], createdAt: consolidationAt }],
    });
    expect(archive.ok).toBe(false);
    expect(store.currentCommit(id)[0]?.op).toBe("create");
    expect(() => store.addKnowledgeMark(id, 999, "verified", consolidationAt)).toThrow("no commit 999");
    expect(store.addKnowledgeMark(id, 1, "verified", consolidationAt).commitId).toBe(1);
  });

  test("an consolidation rejection rolls back knowledge and progress marks; a fact outside the project cannot be marked", () => {
    const { s, factId } = seed();
    const r = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: consolidationAt },
      operations: [
        { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text: "ok", category: "term", scope: "project", supports: [factId], createdAt: consolidationAt },
        { op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: 424242, baseCommit: 1, text: "gone", category: "term", scope: "project", supports: [factId], createdAt: consolidationAt },
      ],
      consolidated: [factId],
    });
    expect(r.ok).toBe(false);
    expect(store.listVisibleKnowledge(s.id, store.getSession(s.id)!.projectId)).toEqual([]);
    expect(store.listConsolidatedProjectFacts(store.getSession(s.id)!.projectId)).toEqual([]);
    const foreign = store.commitConsolidationRun({
      run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: consolidationAt },
      operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "consolidation", text: "ok", category: "term", scope: "project", supports: [factId], createdAt: consolidationAt }],
      consolidated: [424242],
    });
    expect(foreign.ok).toBe(false);
    expect(store.listVisibleKnowledge(s.id, store.getSession(s.id)!.projectId)).toEqual([]);
  });

  test("a short write lock held by another process delays the commit instead of losing it", async () => {
    const { s, t } = seed();
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
      facts: [{ turnId: t.id, category: "observation", actor: "user", text: "written under contention", source: ["T1#user"], createdAt: consolidationAt }],
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect((await exited)[0]).toBe(0);
    expect(r.ok).toBe(true);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 2 });

    // 17c 2026-09-08 extends this real-process write-lock seam with task admission and fencing.
    const entry = store.appendSourceEntry({ sessionId: s.id, turnId: t.id, nativeId: "pending", nativeLineage: "process-test",
      role: "user", text: "pending evidence", raw: "pending evidence", calls: [] });
    store.selectSourcePath(s.id, "main", [entry.id]);
    store.closeSession(s.id);
    const target = { sessionId: s.id, branch: "main", headTurnId: t.id };
    const clock = Date.now();
    const workers = ["process-a", "process-b"].map(executor => spawn(process.execPath, ["--input-type=module", "-e", `
      import { Store } from ${JSON.stringify(new URL("../../../src/core/store/index.ts", import.meta.url).href)};
      const store = new Store(${JSON.stringify(dbPath)});
      Date.now = () => ${clock};
      process.on("message", () => process.send(["noting", "consolidation"].map(phase =>
        store.acquireClaim(${JSON.stringify(target)}, phase, ${JSON.stringify(executor)}, true))));
      process.send("ready");
    `], { stdio: ["ignore", "pipe", "inherit", "ipc"] }));
    const exits = workers.map(worker => once(worker, "exit"));
    try {
      await Promise.all(workers.map(worker => once(worker, "message")));
      const results = workers.map(worker => once(worker, "message"));
      workers.forEach(worker => worker.send("race"));
      const claims = (await Promise.all(results)).flatMap(([value]) => value as (import("../../../src/core/store/index.ts").TaskClaim | null)[]).filter(c => c !== null);
      expect(claims.map(c => c.phase).sort()).toEqual(["consolidation", "noting"]);
      expect(claims.every(c => c.expiresAt === clock + 30 * 60_000)).toBe(true);
      workers.forEach(worker => worker.kill("SIGKILL"));
      await Promise.all(exits);
      expect(store.getSession(s.id)!.closedAt).not.toBeNull();
      const time = vi.spyOn(Date, "now").mockReturnValue(clock + 30 * 60_000);
      try {
        for (const stale of claims) {
          const replacement = store.acquireClaim(target, stale.phase, "replacement-process", true)!;
          expect(replacement).not.toBeNull(); expect(replacement.token).not.toBe(stale.token);
          const run = { kind: stale.phase, sessionId: s.id, branch: "main", claim: stale, createdAt: consolidationAt };
          const rejected = stale.phase === "noting" ? store.commitNotingRun({ run, facts: [], entryIds: [entry.id] })
            : store.commitConsolidationRun({ run, operations: [], consolidated: store.consolidationBatch(s.id, "main", t.id).map(f => f.id) });
          expect(rejected.ok).toBe(false);
          expect(store.releaseClaim(stale)).toBe(false);
          expect(store.getClaim(s.id, stale.phase)!.token).toBe(replacement.token);
          expect(store.releaseClaim(replacement)).toBe(true);
        }
        expect(store.pendingEntries(s.id, "main", t.id)).toHaveLength(1);
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
