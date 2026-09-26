import { prepareMemory } from "./commit.ts";
import type { MemoryBatch } from "../model/index.ts";
import type { Store, RunInput, KnowledgePath } from "../store/index.ts";
import type { freezeConsolidation } from "./index.ts";

export function bindMemory(store: Store, sessionId: number, run: RunInput,
  consolidation?: ReturnType<typeof freezeConsolidation>, path: KnowledgePath = store.knowledgePath(sessionId),
  eligibleSupport?: (factId: number) => boolean,
  skippable?: (commit: number) => string | undefined) {
  const allCommitted: import("../store/index.ts").CommittedKnowledgeOp[] = [];
  // Accepted Dreamer skips become exact processing records when the frozen range settles.
  const skipped: { knowledge: string; because: string }[] = [];
  // Parallel to `skipped`: each entry's already-resolved numeric revision (68 fix 4 — no re-parsing).
  const skippedCommits: number[] = [];
  let problems: string[] = [];
  let committed: { runId: number; committed: import("../store/index.ts").CommittedKnowledgeOp[];
    diagnostics: import("./commit.ts").ConsolidationDiagnostic[]; output: MemoryBatch } | undefined;
  let failure: { runId: number; problems: string[] } | undefined;
  const sequence: { name: string; input: unknown; result: string; problems?: string[] }[] = [];
  const execute = (input: unknown) => {
    if (committed && run.kind === "consolidation") return "rejected: already committed";
    const prepared = prepareMemory(store, sessionId, input, run, consolidation, path, eligibleSupport, skippable);
    problems = prepared.results.filter(r => r.startsWith("rejected:"));
    if (problems.length) { failure = undefined; return JSON.stringify({ results: prepared.results }); }
    const diagnostics = prepared.diagnostics;
    const receipt = (items: import("../store/index.ts").CommittedKnowledgeOp[]) => JSON.stringify({ results: prepared.results,
      committed: items.map(({ commit, ...item }) => ({ ...item, version: `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, commit)}` })), diagnostics });
    const result = store.commitConsolidationRun({ path, run: { ...run, response: JSON.stringify({ problems: [] }),
      ...(run.kind === "consolidation" ? {} : { request: JSON.stringify(input) }) }, operations: prepared.operations,
      ...(consolidation ? { consolidated: consolidation.rangeFacts.map(f => f.id) } : {}),
      finalizeResponse: ({ committed }) => run.kind === "consolidation"
        ? JSON.stringify({ toolCalls: [...sequence, { name: "memory", input, result: receipt(committed) }], committed,
          diagnostics, problems: [] })
        : JSON.stringify({ results: prepared.results, committed, diagnostics }) });
    if (!result.ok) { failure = result; problems = result.readerProblems ?? result.problems;
      return JSON.stringify({ results: prepared.results.map(() => `rejected: ${problems.join("; ")}`) }); }
    committed = { ...result, diagnostics, output: structuredClone(prepared.batch) };
    allCommitted.push(...result.committed);
    if (skippable) for (const skip of prepared.batch.skipped) if ("knowledge" in skip) {
      skipped.push(skip); skippedCommits.push(prepared.declinedCommits.get(skip)!);
    }
    problems = []; failure = undefined;
    return receipt(result.committed);
  };
  return { execute, sequence, allCommitted, skipped, skippedCommits,
    get committed() { return committed; }, get problems() { return problems; }, get failure() { return failure; } };
}
