import { expect, test } from "vitest";
import { Store } from "../../../src/core/store/index.ts";
import { makeDormant } from "../../support/seed.ts";

for (const state of ["active", "reserved", "replaced", "expired", "none"] as const)
  test(`92: a third Noter failure makes the session dormant and expires every Dreamer claim of it (${state})`, () => {
    const store = new Store(":memory:");
    try {
      const project = store.createProject({ name: "claims", declaredBy: "mark" });
      const session = store.createSession({ host: "pi:test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
      const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "evidence", startedAt: "now" });
      const entry = store.appendSourceEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: "one", role: "user", text: "evidence", raw: "evidence", calls: [] });
      store.selectSourcePath(session.id, "main", [entry.id]);
      const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
      const fact = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
        { turnId: turn.id, text: "evidence", source: [`T${turn.id}#E1`], entryIds: [entry.id], createdAt: "now" },
      ] });
      if (!fact.ok) throw Error(fact.problems.join("; "));
      const written = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [
        { files: null, op: "create", title: "Fixture title", handle: "$1", author: "test", text: "rule", category: "constraint", scope: "session", supports: [fact.facts[0]!.id], topics: [], reason: "evidence", createdAt: "now" },
      ] });
      if (!written.ok) throw Error(written.problems.join("; "));
      // The claim of an admitted run; admission itself needs a due Dreamer, which this fixture does not depend on.
      store.db.prepare("INSERT INTO task_claims (session_id, phase, executor_id, token, expires_at, borrowed, reserved) VALUES (?, 'dreaming', 'executor', 'live', ?, 0, 0)")
        .run(session.id, Date.now() + 60_000);
      if (state === "reserved") store.db.prepare("UPDATE task_claims SET reserved=1 WHERE phase='dreaming'").run();
      if (state === "replaced") store.db.prepare("UPDATE task_claims SET token='replacement' WHERE phase='dreaming'").run();
      if (state === "expired") store.db.prepare("UPDATE task_claims SET expires_at=? WHERE phase='dreaming'").run(Date.now() - 1);
      if (state === "none") store.db.prepare("DELETE FROM task_claims WHERE phase='dreaming'").run();
      for (let n = 0; n < 3; n++) {
        const executionId = store.beginExecution({ sessionId: session.id, phase: "noting", head: entry.id });
        const failed = store.recordRun({ kind: "noting", sessionId: session.id, executionId, outcome: "failure", createdAt: "now" });
        expect(!!store.settleExecution(executionId, "failure", failed.id).dormant).toBe(n === 2);
      }
      expect(store.dormant(session.id)).toBe(true);
      expect(store.enabled(session.id)).toBe(true); // 183: dormant, not off
      // Stage 4 §1.5: nothing keeps an admitted Dreamer's token alive past dormancy, whatever its state; it writes no coverage.
      if (state === "none") expect(store.getClaim(session.id, "dreaming")).toBeNull();
      else expect(store.getClaim(session.id, "dreaming")!.expiresAt).toBe(0);
      expect(store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
    } finally { store.close(); }
  });

test("183: reopening a dormant session renews no claim: its expired Dreamer claim neither holds the database-wide seat nor changes hands, and `/trace on` still clears dormancy", () => {
  const store = new Store(":memory:");
  try {
    const project = store.createProject({ name: "reopen", declaredBy: "mark" });
    const open = () => store.createSession({ host: "pi:test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const dormant = open(), healthy = open();
    store.db.prepare("INSERT INTO task_claims (session_id, phase, executor_id, token, expires_at, borrowed, reserved) VALUES (?, 'dreaming', 'old', 'live', ?, 0, 0)")
      .run(dormant.id, Date.now() + 60_000);
    makeDormant(store, dormant.id); // the third failure expires the in-flight claim
    store.closeSession(dormant.id);
    store.reopenSession(dormant.id, "new");
    expect(store.getSession(dormant.id)!.closedAt).toBeNull();
    expect(store.getClaim(dormant.id, "dreaming")).toMatchObject({ executorId: "old", token: "live", expiresAt: 0 });
    expect(store.dreamerSeatHolder(healthy.id)).toBeNull();
    store.setEnrollment(dormant.id, true);
    expect(store.dormant(dormant.id)).toBe(false);
  } finally { store.close(); }
});
