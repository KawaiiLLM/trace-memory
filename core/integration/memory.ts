import { prepareMemory, accounting } from "./commit.ts";
import type { MemoryBatch } from "../model/index.ts";
import type { Store, RunInput } from "../store/index.ts";
import type { freezeIntegration, NearPair } from "./index.ts";
export interface MemoryReview {
  frozen: ReturnType<typeof freezeIntegration>;
  feedback(batch: MemoryBatch): { text: string; near: NearPair[] };
}
export function bindMemory(store: Store, sessionId: number, run: RunInput, review?: MemoryReview) {
  let candidate: MemoryBatch | undefined, near: NearPair[] = [], problems: string[] = [];
  let committed: { runId: number; committed: import("../store/index.ts").CommittedKnowledgeOp[]; rejected: import("../store/index.ts").RejectedKnowledgeOp[]; diagnostics: import("./commit.ts").IntegrationDiagnostic[]; output: MemoryBatch; unansweredNear: NearPair[] } | undefined;
  let failure: { runId: number; problems: string[] } | undefined;
  const sequence: { name: string; input: unknown; result: string }[] = [];
  const execute = (input: unknown) => {
    if (committed && review) return "rejected: already committed";
    const prepared = prepareMemory(store, sessionId, input, run, review?.frozen);
    problems = prepared.results.filter(r => r.startsWith("rejected:"));
    if (problems.length) return JSON.stringify({ results: prepared.results });
    if (review && !candidate) {
      candidate = structuredClone(prepared.batch);
      const feedback = review.feedback(candidate); near = feedback.near;
      problems = ["first batch requires a second submission"];
      return JSON.stringify({ results: prepared.results, feedback: { role: "user", content: feedback.text } });
    }
    const labels = new Set(prepared.batch.operations.map((op, i) => op.op === "create" ? `$e${i + 1}` : op.op === "archive" ? "" : op.id));
    const unansweredNear = near.filter(pair => (labels.has(pair.candidate) || (pair.candidate.startsWith("$e") && prepared.batch.operations.some(op => op.op === "create"))) && !prepared.batch.operations.some(op =>
      (op.op === "update" || op.op === "merge") && (op.id === pair.knowledge || op.absorb?.includes(pair.knowledge))));
    const diagnostics = prepared.diagnostics;
    if (unansweredNear.length) diagnostics.push({ kind: "unanswered_near", pairs: unansweredNear });
    const receipt = (items: import("../store/index.ts").CommittedKnowledgeOp[]) => JSON.stringify({ results: prepared.results, committed: items, diagnostics });
    const result = store.commitIntegrationRun({ run: { ...run, response: JSON.stringify({ problems: [] }), ...(review ? {} : { request: JSON.stringify(input) }) }, operations: prepared.operations, atomic: true,
      ...(review ? { watermark: { sessionId, branch: run.branch!, lastIntegratedFact: review.frozen.rangeFacts.at(-1)!.id } } : {}),
      finalizeResponse: ({ committed }) => {
        if (review) diagnostics.push(...accounting(store, sessionId, prepared.batch, review.frozen.rangeFacts));
        return review ? JSON.stringify({ toolCalls: [...sequence, { name: "memory", input, result: receipt(committed) }], candidate, committed, diagnostics, problems: [], readKnowledgeRevisions: review.frozen.knowledge.map(k => ({ knowledgeId: k.knowledge.id, rev: k.revision.rev })) }) : receipt(committed); } });
    if (!result.ok) { failure = result; problems = result.problems; return JSON.stringify({ results: prepared.results.map(() => `rejected: ${problems.join("; ")}`) }); }
    committed = { ...result, diagnostics, output: structuredClone(prepared.batch), unansweredNear };
    problems = []; failure = undefined;
    return receipt(result.committed);
  };
  return { execute, sequence, get candidate() { return candidate; }, get committed() { return committed; }, get problems() { return problems; }, get failure() { return failure; } };
}
