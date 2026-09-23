import { afterEach, expect, test } from "vitest";
import { Store } from "../../../src/core/store/index.ts";

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) if (!store.closed) store.close(); });

function countReads(runCount: number) {
  const store = new Store(":memory:"); stores.push(store);
  const time = "2026-09-24T00:00:00Z";
  const project = store.createProject({ name: "test", declaredBy: "mark" });
  const sessionId = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id,
    startedAt: time, firstReplyAt: time }).id;
  const turnId = store.appendTurn({ sessionId, kind: "turn", userPrompt: "a", startedAt: time }).id;
  const entries: number[] = [];
  for (let i = 0; i < runCount; i++) {
    const entry = store.appendSourceEntry({ sessionId, turnId, nativeLineage: "native", nativeId: `e${i}`,
      role: "user", text: `e${i}`, raw: `e${i}`, calls: [] });
    entries.push(entry.id);
  }
  store.selectSourcePath(sessionId, "main", entries);
  store.setCurrentPath(sessionId, "main", turnId, "native");
  for (const id of entries) {
    const noted = store.commitNotingRun({ run: { kind: "noting", sessionId, createdAt: time }, entryIds: [id],
      facts: [{ turnId, entryIds: [id], category: "observation", actor: "user", text: `fact for ${id}`,
        source: [`T${turnId}#E${id}`], createdAt: time }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    const run = store.recordRun({ kind: "consolidation", sessionId, branch: "main", createdAt: time, outcome: "success" });
    store.markConsolidated(noted.facts[0]!.id, run.id, project.id);
  }
  const path = { sessionId, branch: "main", headTurnId: turnId };
  const facts = store.listBranchFacts(sessionId, "main", turnId);
  const original = store.db.prepare.bind(store.db);
  const reads: string[] = [];
  store.db.prepare = ((sql: string) => {
    if (/FROM fact_sources/.test(sql)) reads.push(sql);
    return original(sql);
  }) as typeof store.db.prepare;
  const remaining = store.unconsolidated(facts, path);
  expect(remaining).toEqual([]);
  return reads.length;
}

test("footer's unconsolidated fact membership batches across one-fact runs, not merely within each run", () => {
  expect(countReads(30)).toBeLessThanOrEqual(countReads(1) + 1);
});
