import { expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generate } from "./perf/fixture.ts";
import { Store } from "../src/core/store/index.ts";

test("92: performance seed retains C processing and performs its merge through admitted D", () => {
  const directory = mkdtempSync(join(tmpdir(), "tm92-perf-"));
  try {
    const fixture = generate(join(directory, "trace.db"), { entries: 150, facts: 30, resultChars: 100 });
    const store = new Store(fixture.dbPath);
    try {
      const revisions = store.listKnowledgeRevisions();
      expect(revisions).toHaveLength(fixture.knowledgeCount);
      const merged = revisions.filter(revision => revision.op === "merge");
      expect(merged).toHaveLength(1);
      expect(revisions.filter(revision => revision.op === "create").every(revision => revision.actorRole === "consolidation")).toBe(true);
      const consolidationRuns = store.listRuns(fixture.sessionId).filter(run => run.kind === "consolidation");
      expect(consolidationRuns.flatMap(run => store.listConsolidatedFacts(run.id)).length).toBeGreaterThan(0);
      expect(store.getRun(merged[0]!.runId!)?.kind).toBe("dreaming");
      expect(store.db.prepare("SELECT outcome FROM task_executions WHERE phase='dreaming'").all()).toEqual([{ outcome: "success" }]);
      expect(store.db.prepare("SELECT * FROM task_claims").all()).toEqual([]);
      expect(store.currentKnowledge({ sessionId: fixture.sessionId, branch: fixture.branch, headTurnId: fixture.headTurnId }))
        .toHaveLength(revisions.filter(revision => revision.op === "create").length - 1);
    } finally { store.close(); }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
