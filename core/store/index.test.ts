import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, Store } from "./index.ts";

let dir: string;
let dbPath: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "trace-memory-store-"));
  dbPath = join(dir, "test.sqlite");
  store = openStore(dbPath);
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

function makeSession(projectId: number, host = "test-host") {
  return store.createSession({ host, startedAt: "2026-01-01T00:00:00Z", firstReplyAt: "2026-01-01T00:00:05Z", projectId });
}

describe("schema", () => {
  test("creates all tables without error and is reopenable", () => {
    // openStore already ran the schema in beforeEach; reopening the same file must not fail
    // (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE VIRTUAL TABLE IF NOT EXISTS).
    const again = openStore(dbPath);
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
      "entries",
      "entry_revisions",
      "entry_links",
      "runs",
      "marks",
      "pending_deliveries",
      "watermarks",
      "idx_entries_project_status",
      "idx_runs_session",
    ]) {
      expect(names).toContain(expected);
    }
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

  test("fact and entry ids increase across projects", () => {
    const p1 = store.createProject({ name: "p1", declaredBy: "mark" });
    const p2 = store.createProject({ name: "p2", declaredBy: "mark" });
    expect(p2.id).toBeGreaterThan(p1.id);
    const s1 = makeSession(p1.id);
    const t1 = store.appendTurn({ sessionId: s1.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const r1 = store.commitNoteRun({
      run: { kind: "note", sessionId: s1.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t1.id, category: "observation", actor: "user", text: "fact one", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(r1.ok).toBe(true);
    const s2 = makeSession(p2.id);
    const t2 = store.appendTurn({ sessionId: s2.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const r2 = store.commitNoteRun({
      run: { kind: "note", sessionId: s2.id, createdAt: "2026-01-01T00:00:01Z" },
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
      store.createSession({ host: "test", startedAt: "2026-01-01T00:00:00Z", firstReplyAt: "", projectId: p.id }),
    ).toThrow();
  });

  test("allocates an id once the first reply exists", () => {
    const p = store.createProject({ name: "proj", declaredBy: "marker" });
    const s = makeSession(p.id);
    expect(s.id).toBeGreaterThan(0);
    expect(store.getSession(s.id)?.firstReplyAt).toBe("2026-01-01T00:00:05Z");
  });
});

describe("commitNoteRun: local handle resolution", () => {
  test("resolves $n to the batch's own freshly assigned fact ids", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const result = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [
        { turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" },
        {
          turnId: t.id,
          category: "event",
          actor: "agent",
          text: "completed: switched the lockfile to pnpm",
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
    const first = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
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
    const result = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
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

describe("commitSettleRun: revision conflicts", () => {
  test("rejects an edit against a stale expected revision while committing the rest", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const noteResult = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(noteResult.ok).toBe(true);
    if (!noteResult.ok) return;
    const factId = noteResult.facts[0]!.id;

    const created = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      operations: [
        {
          op: "new",
          handle: "$e1",
          author: "settle",
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
    const entryId = created.committed[0]!.entryId;

    // a first edit against revision 1 succeeds and moves the entry to revision 2...
    const round2 = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: "2026-01-01T00:02:00Z" },
      operations: [
        {
          op: "edit",
          entryId,
          expectedRevision: 1,
          text: "The project uses pnpm exclusively.",
          category: "constraint",
          scope: "project",
          supports: [factId],
          because: [factId],
          createdAt: "2026-01-01T00:02:00Z",
        },
      ],
    });
    expect(round2.ok).toBe(true);
    if (!round2.ok) return;
    expect(round2.committed).toHaveLength(1);
    expect(round2.rejected).toHaveLength(0);

    // ...but a second edit that still expects revision 1 (stale) is rejected, alongside one that commits
    const round3 = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: "2026-01-01T00:03:00Z" },
      operations: [
        {
          op: "edit",
          entryId,
          expectedRevision: 1, // stale: the entry is now at revision 2
          text: "A conflicting edit.",
          category: "constraint",
          scope: "project",
          supports: [factId],
          because: [factId],
          createdAt: "2026-01-01T00:03:00Z",
        },
        {
          op: "new",
          handle: "$e2",
          author: "settle",
          text: "A second, unrelated entry.",
          category: "reference",
          scope: "project",
          supports: [factId],
          createdAt: "2026-01-01T00:03:00Z",
        },
      ],
    });
    expect(round3.ok).toBe(true);
    if (!round3.ok) return;
    expect(round3.rejected).toHaveLength(1);
    expect(round3.rejected[0]!.reason).toMatch(/moved/);
    expect(round3.committed).toHaveLength(1);
    expect(round3.committed[0]!.op).toBe("new");

    // the entry itself still holds the round-2 text, untouched by the rejected round-3 edit
    const finalEntry = store.getEntryWithRevision(entryId)!;
    expect(finalEntry.revision.rev).toBe(2);
    expect(finalEntry.revision.text).toBe("The project uses pnpm exclusively.");
  });
});

describe("project merge", () => {
  test("relabels sessions and project-scoped entries onto the survivor", () => {
    const from = store.createProject({ name: "undeclared-session-project", declaredBy: "marker" });
    const into = store.createProject({ name: "the-real-project", declaredBy: "mark" });
    const s = makeSession(from.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const noted = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(noted.ok).toBe(true);
    if (!noted.ok) return;
    const settled = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      operations: [
        {
          op: "new",
          handle: "$e1",
          author: "settle",
          text: "The project uses pnpm.",
          category: "constraint",
          scope: "project",
          supports: [noted.facts[0]!.id],
          createdAt: "2026-01-01T00:01:00Z",
        },
      ],
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;
    const entryId = settled.committed[0]!.entryId;

    store.mergeProject(from.id, into.id);

    expect(store.getProject(from.id)?.mergedInto).toBe(into.id);
    expect(store.getSession(s.id)?.projectId).toBe(into.id);
    expect(store.getEntry(entryId)?.projectId).toBe(into.id);
  });
});

describe("visibility rule", () => {
  test("shows global and this project's entries, and only this session's session-scope entries", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const otherProject = store.createProject({ name: "other-proj", declaredBy: "mark" });
    const s1 = makeSession(p.id);
    const s2 = makeSession(p.id);
    const t1 = store.appendTurn({ sessionId: s1.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });

    const noted = store.commitNoteRun({
      run: { kind: "note", sessionId: s1.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t1.id, category: "observation", actor: "user", text: "context fact", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    expect(noted.ok).toBe(true);
    if (!noted.ok) return;
    const factId = noted.facts[0]!.id;

    // An entry's project is the project of the session that settled it; only global entries have none.
    function newEntry(scope: "session" | "project" | "global", sessionId: number, text: string) {
      const r = store.commitSettleRun({
        run: { kind: "settle", sessionId, createdAt: "2026-01-01T00:01:00Z" },
        operations: [
          { op: "new", handle: "$e1", author: "settle", text, category: "term", scope, supports: [factId], createdAt: "2026-01-01T00:01:00Z" },
        ],
      });
      if (!r.ok) throw new Error("setup failed");
      return r.committed[0]!.entryId;
    }

    const s3 = makeSession(otherProject.id);
    const globalEntry = newEntry("global", s1.id, "A global working-method note.");
    const projectEntry = newEntry("project", s1.id, "A project-wide term.");
    const session1Entry = newEntry("session", s1.id, "A session-only detail for s1.");
    const otherProjectEntry = newEntry("project", s3.id, "Belongs to a different project.");

    const visibleToS2 = store.listVisibleEntries(s2.id, p.id).map((e) => e.entry.id);
    expect(visibleToS2).toContain(globalEntry);
    expect(visibleToS2).toContain(projectEntry);
    expect(visibleToS2).not.toContain(session1Entry);
    expect(visibleToS2).not.toContain(otherProjectEntry);

    const visibleToS1 = store.listVisibleEntries(s1.id, p.id).map((e) => e.entry.id);
    expect(visibleToS1).toContain(session1Entry);
  });
});

describe("marks and pending deliveries", () => {
  test("records a mark on an entry revision", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const noted = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    if (!noted.ok) throw new Error("setup failed");
    const settled = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      operations: [
        { op: "new", handle: "$e1", author: "settle", text: "Use pnpm.", category: "constraint", scope: "project", supports: [noted.facts[0]!.id], createdAt: "2026-01-01T00:01:00Z" },
      ],
    });
    if (!settled.ok) throw new Error("setup failed");
    const entryId = settled.committed[0]!.entryId;
    store.addMark(entryId, 1, "verified", "2026-01-01T00:02:00Z");
    expect(store.listMarks(entryId)).toHaveLength(1);
    expect(store.listMarks(entryId)[0]!.kind).toBe("verified");
  });

  test("queues and clears a pending delivery bound to a branch", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const run = store.recordRun({ kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:02:00Z", outcome: "success" });
    store.addPendingDelivery(run.id, s.id, "main");
    expect(store.listPendingDeliveries(s.id, "main")).toHaveLength(1);
    store.clearPendingDelivery(run.id, "2026-01-01T00:03:00Z");
    expect(store.listPendingDeliveries(s.id, "main")).toHaveLength(0);
  });
});

describe("full-text index", () => {
  test("committed facts and entry revisions are searchable through FTS", () => {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const noteResult = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [
        { turnId: t.id, category: "decision", actor: "user", text: "settlement runs on a watermark", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" },
      ],
    });
    expect(noteResult.ok).toBe(true);
    if (!noteResult.ok) return;
    const factId = noteResult.facts[0]!.id;

    const settled = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: "2026-01-01T00:01:00Z" },
      operations: [
        {
          op: "new",
          handle: "$e1",
          author: "settle",
          text: "Settlement is triggered by an unsettled-fact watermark.",
          category: "mechanism",
          scope: "project",
          supports: [factId],
          createdAt: "2026-01-01T00:01:00Z",
        },
      ],
    });
    expect(settled.ok).toBe(true);
    if (!settled.ok) return;

    const factHits = store.db.prepare("SELECT rowid FROM facts_fts WHERE facts_fts MATCH ?").all("watermark") as { rowid: number }[];
    expect(factHits.map((h) => h.rowid)).toEqual([factId]);

    const entryHits = store.db
      .prepare("SELECT rowid FROM entry_revisions_fts WHERE entry_revisions_fts MATCH ?")
      .all("watermark") as { rowid: number }[];
    expect(entryHits).toHaveLength(1);
  });
});

describe("commit boundaries (ticket 01 review repairs)", () => {
  function seed() {
    const p = store.createProject({ name: "proj", declaredBy: "mark" });
    const s = makeSession(p.id);
    const t = store.appendTurn({ sessionId: s.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const noted = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: "2026-01-01T00:00:01Z" },
      facts: [{ turnId: t.id, category: "decision", actor: "user", text: "use pnpm", source: ["T1#user"], createdAt: "2026-01-01T00:00:01Z" }],
    });
    if (!noted.ok) throw new Error("seed failed");
    return { p, s, t, factId: noted.facts[0]!.id };
  }
  const settleAt = "2026-01-01T00:01:00Z";

  test("a scope change moves the entry's ownership, so it stays visible after reopening", () => {
    const { p, s, factId } = seed();
    const made = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: settleAt },
      operations: [{ op: "new", handle: "$e1", author: "settle", text: "Use pnpm.", category: "constraint", scope: "global", supports: [factId], createdAt: settleAt }],
    });
    if (!made.ok) throw new Error("setup failed");
    const id = made.committed[0]!.entryId;
    expect(store.getEntry(id)!.projectId).toBeNull();
    const edited = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: settleAt },
      operations: [{ op: "edit", entryId: id, expectedRevision: 1, text: "Use pnpm here.", category: "constraint", scope: "project", supports: [factId], because: [factId], createdAt: settleAt }],
    });
    expect(edited.ok).toBe(true);
    store.close();
    store = openStore(dbPath);
    expect(store.getEntry(id)!.projectId).toBe(p.id);
    expect(store.listVisibleEntries(s.id, p.id).map((e) => e.entry.id)).toContain(id);
  });

  test("an entry cannot absorb itself; duplicate absorb targets collapse to one", () => {
    const { s, factId } = seed();
    const mk = (text: string) =>
      store.commitSettleRun({
        run: { kind: "settle", sessionId: s.id, createdAt: settleAt },
        operations: [{ op: "new", handle: "$e1", author: "settle", text, category: "term", scope: "project", supports: [factId], createdAt: settleAt }],
      });
    const a = mk("A");
    const b = mk("B");
    if (!a.ok || !b.ok) throw new Error("setup failed");
    const aId = a.committed[0]!.entryId;
    const bId = b.committed[0]!.entryId;
    const merged = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: settleAt },
      operations: [
        { op: "merge", intoEntryId: aId, intoExpectedRevision: 1, absorb: [{ entryId: aId, expectedRevision: 1 }], text: "A", category: "term", scope: "project", supports: [factId], because: [factId], createdAt: settleAt },
        { op: "merge", intoEntryId: aId, intoExpectedRevision: 1, absorb: [{ entryId: bId, expectedRevision: 1 }, { entryId: bId, expectedRevision: 1 }], text: "A and B", category: "term", scope: "project", supports: [factId], because: [factId], createdAt: settleAt },
      ],
    });
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.rejected).toHaveLength(1);
    expect(merged.rejected[0]!.reason).toContain("cannot absorb itself");
    expect(store.getEntry(aId)!.status).toBe("active");
    expect(store.getEntry(bId)!.status).toBe("merged");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM entry_links WHERE from_entry = ?").get(bId)).toEqual({ n: 1 });
  });

  test("a note commit rejects turns, watermarks, and deliveries outside its own session and branch", () => {
    const { s, t } = seed();
    const p2 = store.createProject({ name: "other", declaredBy: "mark" });
    const s2 = makeSession(p2.id);
    const t2 = store.appendTurn({ sessionId: s2.id, kind: "turn", startedAt: "2026-01-01T00:00:00Z" });
    const fact = { category: "observation" as const, actor: "user" as const, text: "x", source: ["T1#user"], createdAt: settleAt };
    const foreignTurn = store.commitNoteRun({ run: { kind: "note", sessionId: s.id, branch: "main", createdAt: settleAt }, facts: [{ ...fact, turnId: t2.id }] });
    expect(foreignTurn.ok).toBe(false);
    const foreignWatermark = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, branch: "main", createdAt: settleAt },
      facts: [{ ...fact, turnId: t.id }],
      watermark: { sessionId: s2.id, branch: "main", lastNotedTurn: t.id },
    });
    expect(foreignWatermark.ok).toBe(false);
    const foreignDelivery = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, branch: "main", createdAt: settleAt },
      facts: [{ ...fact, turnId: t.id }],
      pendingDelivery: { sessionId: s.id, branch: "other" },
    });
    expect(foreignDelivery.ok).toBe(false);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM facts").get()).toEqual({ n: 1 });
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE outcome = 'failure'").get()).toEqual({ n: 3 });
  });

  test("a local handle may only point at an earlier fact of the batch", () => {
    const { s, t } = seed();
    const fact = { turnId: t.id, category: "observation" as const, actor: "agent" as const, source: ["T1#assistant"], createdAt: settleAt };
    const forward = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: settleAt },
      facts: [
        { ...fact, text: "first" },
        { ...fact, text: "second", support: [{ target: "$3", strength: "weak" }] },
        { ...fact, text: "third" },
      ],
    });
    expect(forward.ok).toBe(false);
    const self = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: settleAt },
      facts: [{ ...fact, text: "loop", support: [{ target: "$1", strength: "weak" }] }],
    });
    expect(self.ok).toBe(false);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM fact_relations").get()).toEqual({ n: 0 });
  });

  test("cited facts must exist and supports must not be empty; marks bind to an existing revision", () => {
    const { s, factId } = seed();
    const r = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: settleAt },
      operations: [
        { op: "new", handle: "$e1", author: "settle", text: "dangling", category: "term", scope: "project", supports: [999999], createdAt: settleAt },
        { op: "new", handle: "$e2", author: "settle", text: "empty", category: "term", scope: "project", supports: [], createdAt: settleAt },
        { op: "new", handle: "$e3", author: "settle", text: "fine", category: "term", scope: "project", supports: [factId], createdAt: settleAt },
      ],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rejected.map((x) => x.reason)).toEqual([expect.stringContaining("F999999 does not exist"), expect.stringContaining("must not be empty")]);
    const id = r.committed[0]!.entryId;
    const archive = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, createdAt: settleAt },
      operations: [{ op: "archive", entryId: id, expectedRevision: 1, because: [999998], createdAt: settleAt }],
    });
    expect(archive.ok && archive.rejected).toHaveLength(1);
    expect(() => store.addMark(id, 999, "verified", settleAt)).toThrow("no revision 999");
    expect(store.addMark(id, 1, "verified", settleAt).rev).toBe(1);
  });

  test("a settle commit advances lastSettledFact in the same transaction, even with a rejected operation", () => {
    const { s, factId } = seed();
    const r = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, branch: "main", createdAt: settleAt },
      operations: [
        { op: "new", handle: "$e1", author: "settle", text: "ok", category: "term", scope: "project", supports: [factId], createdAt: settleAt },
        { op: "edit", entryId: 424242, expectedRevision: 1, text: "gone", category: "term", scope: "project", supports: [factId], because: [factId], createdAt: settleAt },
      ],
      watermark: { sessionId: s.id, branch: "main", lastSettledFact: factId },
    });
    expect(r.ok && r.rejected.length).toBe(1);
    expect(store.getWatermark(s.id, "main")?.lastSettledFact).toBe(factId);
    const foreign = store.commitSettleRun({
      run: { kind: "settle", sessionId: s.id, branch: "main", createdAt: settleAt },
      operations: [],
      watermark: { sessionId: s.id, branch: "other", lastSettledFact: factId },
    });
    expect(foreign.ok).toBe(false);
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
    const r = store.commitNoteRun({
      run: { kind: "note", sessionId: s.id, createdAt: settleAt },
      facts: [{ turnId: t.id, category: "observation", actor: "user", text: "written under contention", source: ["T1#user"], createdAt: settleAt }],
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(100);
    expect((await exited)[0]).toBe(0);
    expect(r.ok).toBe(true);
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 2 });
  });
});

describe("incremental raw recording", () => {
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
