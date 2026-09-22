import { prepareMemory } from "./commit.ts";
import type { MemoryBatch } from "../model/index.ts";
import type { Store, RunInput, KnowledgePath, KnowledgeWithRevision } from "../store/index.ts";
import type { freezeConsolidation } from "./index.ts";
import type { KnowledgeRead } from "../api/read.ts";

export function bindMemory(store: Store, sessionId: number, run: RunInput,
  consolidation?: ReturnType<typeof freezeConsolidation>, path: KnowledgePath = store.knowledgePath(sessionId),
  reads = new Map<number, KnowledgeWithRevision>(), eligibleSupport?: (factId: number) => boolean,
  skippable?: (commit: number) => string | undefined) {
  for (const handle of consolidation?.prepared?.readKnowledgeCommits ?? []) {
    const revision = store.getKnowledgeRevision(handle.knowledgeId, handle.commit)!;
    reads.set(handle.commit, { knowledge: store.getKnowledge(handle.knowledgeId)!, revision });
  }
  const reread = (completed: KnowledgeRead[]) => {
    for (const { knowledgeId, commits, replace } of completed) {
      if (replace) for (const [commit, item] of reads) if (item.knowledge.id === knowledgeId) reads.delete(commit);
      for (const commit of commits) {
        const revision = store.getKnowledgeRevision(knowledgeId, commit);
        if (revision) reads.set(commit, { knowledge: store.getKnowledge(knowledgeId)!, revision });
      }
    }
  };
  const allCommitted: import("../store/index.ts").CommittedKnowledgeOp[] = [];
  // Accepted Dreamer skips become exact processing records when the frozen range settles.
  const skipped: { knowledge: string; because: string }[] = [];
  let problems: string[] = [];
  let committed: { runId: number; committed: import("../store/index.ts").CommittedKnowledgeOp[];
    diagnostics: import("./commit.ts").ConsolidationDiagnostic[]; output: MemoryBatch } | undefined;
  let failure: { runId: number; problems: string[] } | undefined;
  const sequence: { name: string; input: unknown; result: string }[] = [];
  const execute = (input: unknown) => {
    if (committed && run.kind === "consolidation") return "rejected: already committed";
    const prepared = prepareMemory(store, sessionId, input, run, consolidation, path, [...reads.values()], eligibleSupport, skippable);
    problems = prepared.results.filter(r => r.startsWith("rejected:"));
    if (problems.length) { failure = undefined; return JSON.stringify({ results: prepared.results }); }
    const diagnostics = prepared.diagnostics;
    const receipt = (items: import("../store/index.ts").CommittedKnowledgeOp[]) => JSON.stringify({ results: prepared.results, committed: items, diagnostics });
    const result = store.commitConsolidationRun({ path, run: { ...run, response: JSON.stringify({ problems: [] }),
      ...(run.kind === "consolidation" ? {} : { request: JSON.stringify(input) }) }, operations: prepared.operations,
      ...(consolidation ? { consolidated: consolidation.rangeFacts.map(f => f.id) } : {}),
      finalizeResponse: ({ committed }) => run.kind === "consolidation"
        ? JSON.stringify({ toolCalls: [...sequence, { name: "memory", input, result: receipt(committed) }], committed,
          diagnostics, problems: [], readKnowledgeCommits: consolidation?.prepared?.readKnowledgeCommits ?? [] })
        : receipt(committed) });
    if (!result.ok) { failure = result; problems = result.problems;
      return JSON.stringify({ results: prepared.results.map(() => `rejected: ${problems.join("; ")}`) }); }
    committed = { ...result, diagnostics, output: structuredClone(prepared.batch) };
    allCommitted.push(...result.committed);
    if (skippable) skipped.push(...prepared.batch.skipped.flatMap(skip => "knowledge" in skip ? [skip] : []));
    problems = []; failure = undefined;
    return receipt(result.committed);
  };
  return { execute, reread, sequence, allCommitted, skipped, get readCommits() { return [...reads.keys()]; },
    get committed() { return committed; }, get problems() { return problems; }, get failure() { return failure; } };
}
