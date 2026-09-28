import { expect, test } from "vitest";
import { Store } from "../../../src/core/store/index.ts";

for (const state of ["active", "reserved", "replaced", "expired", "closed", "unbound"] as const)
  test(`92: auto-off retains only exact active Dreamer completion authority (${state})`, () => {
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
        { op: "create", handle: "$1", author: "test", text: "rule", category: "constraint", scope: "session", supports: [fact.facts[0]!.id], topics: [], reason: "evidence", createdAt: "now" },
      ] });
      if (!written.ok) throw Error(written.problems.join("; "));
      const claim = store.acquireClaim(path, "dreaming", "executor")!;
      const range = state === "unbound" ? undefined : store.retainKnowledgePoolRange(path, `session:${session.id}`, claim);
      const run = range && store.bindDreamingRun({ kind: "dreaming", sessionId: session.id, branch: "main", claim, dreamingRangeId: range.id,
        executionId: store.beginExecution({ sessionId: session.id, phase: "dreaming", head: range.anchor, origin: range.origin }), createdAt: "now" });
      if (state === "reserved") store.db.prepare("UPDATE task_claims SET reserved=1 WHERE phase='dreaming'").run();
      if (state === "replaced") store.db.prepare("UPDATE task_claims SET token='replacement' WHERE phase='dreaming'").run();
      if (state === "expired") store.db.prepare("UPDATE task_claims SET expires_at=? WHERE phase='dreaming'").run(Date.now() - 1);
      if (state === "closed") store.db.prepare("UPDATE dreaming_ranges SET closed_at='now' WHERE id=?").run(range!.id);
      for (let n = 0; n < 3; n++) {
        const executionId = store.beginExecution({ sessionId: session.id, phase: "noting", head: entry.id });
        const failed = store.recordRun({ kind: "noting", sessionId: session.id, executionId, outcome: "failure", createdAt: "now" });
        expect(!!store.settleExecution(executionId, "failure", failed.id).automaticOff).toBe(n === 2);
      }
      expect(store.enabled(session.id)).toBe(false);
      if (state === "active") {
        expect(store.getClaim(session.id, "dreaming")).toEqual(claim);
        const revision = written.committed[0]!;
        const late = store.commitConsolidationRun({ path, run: run!, operations: [{ op: "archive", kind: "budget", knowledgeId: revision.knowledgeId,
          baseCommit: revision.commit, supports: [], reason: "late write", createdAt: "now" }] });
        expect(late.ok).toBe(false);
        store.completeKnowledgePoolRange(run!, "cancelled", [revision.commit]);
        expect(store.openDreamingRange(session.id, "main")).toBeNull();
        expect(store.releaseClaim(claim)).toBe(true);
      } else {
        expect(store.getClaim(session.id, "dreaming")!.expiresAt).toBe(0);
        if (run) expect(() => store.completeKnowledgePoolRange(run, "cancelled", [])).toThrow();
        expect(store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
      }
    } finally { store.close(); }
  });
