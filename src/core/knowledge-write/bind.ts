import { prepareMemory } from "./prepare.ts";
import { canonicalToolNames, type ToolNames } from "../prompts/tool-names.ts";
import type { MemoryBatch } from "../model/index.ts";
import type { Store, RunInput, KnowledgePath } from "../store/index.ts";

export function bindMemory(store: Store, sessionId: number, run: RunInput,
  path: KnowledgePath = store.knowledgePath(sessionId),
  eligibleSupport?: (factId: number) => boolean,
  skippable?: (commit: number) => string | undefined, names: ToolNames = canonicalToolNames) {
  const allCommitted: import("../store/index.ts").CommittedKnowledgeOp[] = [];
  // Accepted Dreamer skips become exact processing records when the frozen range settles.
  const skipped: { knowledge: string; because: string }[] = [];
  // Parallel to `skipped`: each entry's already-resolved numeric revision (68 fix 4 — no re-parsing).
  const skippedCommits: number[] = [];
  let committed: { runId: number; committed: import("../store/index.ts").CommittedKnowledgeOp[];
    diagnostics: import("./prepare.ts").ConsolidationDiagnostic[]; output: MemoryBatch } | undefined;
  let failure: { runId: number; problems: string[] } | undefined;
  const sequence: { name: string; input: unknown; result: string; problems?: string[] }[] = [];
  /** One immediate submission; its receipt object is the model-facing result before serialization. */
  const execute = (input: unknown, request: unknown = input) => {
    const prepared = prepareMemory(store, sessionId, input, run, path, eligibleSupport, skippable, undefined, names);
    if (prepared.results.some(r => r.startsWith("rejected:"))) { failure = undefined; return { results: prepared.results }; }
    const diagnostics = prepared.diagnostics;
    const result = store.commitConsolidationRun({ path, run: { ...run, response: JSON.stringify({ problems: [] }),
      request: JSON.stringify(request) }, operations: prepared.operations,
      finalizeResponse: ({ committed }) => JSON.stringify({ results: prepared.results, committed, diagnostics }) });
    if (!result.ok) { failure = result; const problems = result.readerProblems ?? result.problems;
      return { results: prepared.results.map(() => `rejected: ${problems.join("; ")}`) }; }
    committed = { ...result, diagnostics, output: structuredClone(prepared.batch) };
    allCommitted.push(...result.committed);
    if (skippable) for (const skip of prepared.batch.skipped) if ("knowledge" in skip) {
      skipped.push(skip); skippedCommits.push(prepared.declinedCommits.get(skip)!);
    }
    failure = undefined;
    return { results: prepared.results, committed: result.committed.map(({ commit, ...item }) =>
      ({ ...item, version: `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, commit)}` })), diagnostics };
  };
  return { execute, sequence, allCommitted, skipped, skippedCommits,
    get committed() { return committed; }, get failure() { return failure; } };
}
