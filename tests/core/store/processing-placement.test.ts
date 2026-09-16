import { expect, test } from "vitest";
import { Store } from "../../../src/core/store/index.ts";

// This transfer moves no certified version's owner. It changes admission and reveals an old
// global certificate, so a check limited to the moved author's revisions would miss the overflow.
test("32: declaration rechecks a newly applicable certified global predecessor outside the moved session", () => {
  const store = new Store(":memory:");
  try {
    const p = store.createProject({ name: "A", declaredBy: "mark" });
    const author = store.createSession({ host: "test", enrollmentChoice: true, projectDeclaration: "mark", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
    const reader = store.createSession({ host: "test", enrollmentChoice: true, projectDeclaration: "mark", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: author.id, kind: "turn", userPrompt: "facts", startedAt: "now" });
    store.commitNotingRun({ run: { kind: "manual", sessionId: author.id, createdAt: "now" }, facts: [{ turnId: turn.id, text: "fact", category: "decision", actor: "user", source: [`T${turn.id}#user`], createdAt: "now" }] });
    const content = { text: "一".repeat(3400), category: "constraint" as const, scope: "global" as const, supports: [1], topics: [], reason: "test", createdAt: "now" };
    const write = (operations: Parameters<Store["commitConsolidationRun"]>[0]["operations"]) => {
      const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: author.id, createdAt: "now" }, operations });
      expect(result.ok).toBe(true);
    };
    const complete = (id: number) => {
      const path = { sessionId: author.id, branch: "main", headTurnId: turn.id };
      const range = store.retainDreamingRange(path, [id]);
      const run = store.recordRun({ kind: "dreaming", sessionId: author.id, branch: path.branch,
        dreamingRangeId: range.id, outcome: "success", createdAt: "now" });
      store.completeDreaming(run.id, [id], [id]);
    };
    write([{ op: "create", handle: "$1", author: "test", ...content }]); complete(1);
    write([{ op: "update", knowledgeId: 1, baseCommit: 1, ...content, scope: "project", text: "project-only successor" }]);
    write([{ op: "create", handle: "$2", author: "test", ...content }]); complete(3);
    expect(store.checkProcessedScopes().problems).toEqual([]);
    expect(() => store.declareProject(reader.id, "B", "mark")).toThrow(/global.*exceeds 4000/);
    expect(store.getSession(reader.id)!.projectId).toBe(p.id);
    expect(store.findProjectByName("B")).toBeNull();
    expect(store.db.prepare("SELECT * FROM knowledge_placement_validations").all()).toEqual([]);
  } finally { store.close(); }
});
