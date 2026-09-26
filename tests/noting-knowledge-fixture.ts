import type { Store, RunInput, KnowledgePath, KnowledgeOperationInput, CommitConsolidationResult } from "../src/core/store/index.ts";

/** Store-level N publication for tests that previously used live C just to advance knowledge.
 * No source progress is manufactured; the real held publication still checks graph and evidence.
 */
export function commitNoterKnowledge(store: Store, input: {
  path?: KnowledgePath; run: Omit<RunInput, "kind">; operations: KnowledgeOperationInput[];
}): CommitConsolidationResult {
  const path = input.path ?? store.knowledgePath(input.run.sessionId!);
  const result = store.commitNotingRun({ run: { ...input.run, kind: "noting" }, facts: [],
    held: { path, slots: [], validate() {}, knowledge: () => input.operations } });
  if (!result.ok) return result;
  const revisions = store.listCommitsByRun(result.runId);
  return { ok: true, runId: result.runId, committed: revisions.map(revision => ({
    op: revision.op, knowledgeId: revision.knowledgeId, commit: revision.id,
  })) };
}

/** Existing C processing is historical data, not a retired worker invocation. */
export function historicalConsolidation(store: Store, sessionId: number, factIds: number[], branch = "main"): void {
  store.transaction(() => {
    const run = store.recordRun({ kind: "consolidation", sessionId, branch, createdAt: "fixture", outcome: "success" });
    const projectId = store.getSession(sessionId)!.projectId;
    for (const factId of factIds) store.markConsolidated(factId, run.id, projectId);
  });
}
