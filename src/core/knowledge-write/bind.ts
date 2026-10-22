import { prepareMemory, type ConsolidationDiagnostic } from "./prepare.ts";
import { canonicalToolNames, type ToolNames } from "../prompts/tool-names.ts";
import type { MemoryBatch } from "../model/index.ts";
import type { Store, RunInput, KnowledgePath, CommittedKnowledgeOp } from "../store/index.ts";
import { renderKnowledge, tokens } from "../render/index.ts";

export interface MemoryReceipt {
  results: string[];
  committed: (Omit<CommittedKnowledgeOp, "commit"> & { version: string })[];
  diagnostics: ConsolidationDiagnostic[];
  tokens?: { before: number[]; after: number[] };
}

export function bindMemory(store: Store, sessionId: number, run: RunInput,
  path: KnowledgePath = store.knowledgePath(sessionId),
  eligibleSupport?: (factId: number) => boolean,
  names: ToolNames = canonicalToolNames) {
  const allCommitted: CommittedKnowledgeOp[] = [];
  let committed: { runId: number; committed: CommittedKnowledgeOp[];
    diagnostics: ConsolidationDiagnostic[]; output: MemoryBatch } | undefined;
  let failure: { runId: number; problems: string[] } | undefined;
  const sequence: { name: string; input: unknown; result: string; problems?: string[] }[] = [];
  /** One immediate submission; its receipt object is the model-facing result before serialization. */
  const execute = (input: unknown, request: unknown = input) => {
    const prepared = prepareMemory(store, sessionId, input, run, path, eligibleSupport, undefined, names);
    if (prepared.results.some(r => r.startsWith("rejected:"))) { failure = undefined; return { results: prepared.results }; }
    const diagnostics = prepared.diagnostics;
    let receipt: MemoryReceipt | undefined;
    const result = store.commitConsolidationRun({ path, run: { ...run, response: JSON.stringify({ problems: [] }),
      request: JSON.stringify(request) }, operations: prepared.operations,
      finalizeResponse: ({ committed }) => {
        const versions = new Map<number, { count: number; tagged?: string }>();
        const view = (knowledgeId: number, commit: number) => {
          let value = versions.get(commit);
          if (value) return value;
          const revision = store.getKnowledgeRevision(knowledgeId, commit)!;
          if (revision.op === "archive") value = { count: 0 };
          else {
            const tagged = `K${knowledgeId}#${store.versionTag(knowledgeId, commit)}`;
            value = { tagged, count: tokens(renderKnowledge({ knowledge: store.getKnowledge(knowledgeId)!, revision }, tagged, false, store.writing)) };
          }
          versions.set(commit, value);
          return value;
        };
        const before: number[] = [];
        for (const operation of prepared.operations) {
          if (operation.op === "create") continue;
          if (operation.op === "merge") {
            before.push(view(operation.intoKnowledgeId, operation.intoBaseCommit).count);
            for (const parent of operation.absorb) before.push(view(parent.knowledgeId, parent.baseCommit).count);
          } else before.push(view(operation.knowledgeId, operation.baseCommit).count);
        }
        const after = committed.map(item => view(item.knowledgeId, item.commit).count);
        const published = committed.map(item => ({ ...item,
          version: item.op === "update" || item.op === "merge" || item.op === "split"
            ? view(item.knowledgeId, item.commit).tagged!
            : `K${item.knowledgeId}@v${store.versionOrdinal(item.knowledgeId, item.commit)}` }));
        receipt = { results: prepared.results, committed: published.map(({ commit, ...item }) => item), diagnostics,
          ...(committed.length ? { tokens: { before, after } } : {}) };
        // Human audit retains numeric commits; the model receives the same counts and version labels.
        return JSON.stringify({ ...receipt, committed: published });
      } });
    if (!result.ok) { failure = result; const problems = result.readerProblems ?? result.problems;
      return { results: prepared.results.map(() => `rejected: ${problems.join("; ")}`) }; }
    committed = { ...result, diagnostics, output: structuredClone(prepared.batch) };
    allCommitted.push(...result.committed);
    failure = undefined;
    return receipt!;
  };
  return { execute, sequence, allCommitted,
    get committed() { return committed; }, get failure() { return failure; } };
}
