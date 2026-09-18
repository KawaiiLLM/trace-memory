import { prepareMemory, accounting } from "./commit.ts";
import type { MemoryBatch } from "../model/index.ts";
import type { Store, RunInput, KnowledgePath, KnowledgeWithRevision } from "../store/index.ts";
import type { freezeConsolidation, NearPair } from "./index.ts";
import type { KnowledgeRead } from "../api/read.ts";
export interface MemoryReview {
  frozen: ReturnType<typeof freezeConsolidation>;
  feedback(batch: MemoryBatch): { text: string; near: NearPair[]; completed: KnowledgeRead[] };
}
export function bindMemory(store: Store, sessionId: number, run: RunInput, review?: MemoryReview, path: KnowledgePath = store.knowledgePath(sessionId),
  reads = new Map<number, KnowledgeWithRevision>(), eligibleSupport?: (factId: number) => boolean, skippable?: (commit: number) => string | undefined) {
  for (const handle of review?.frozen.prepared?.readKnowledgeCommits ?? []) {
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
  // 59: the Dreamer's accepted skips (handle, because), recorded with the run; a skip accounts, never certifies.
  const skipped: { knowledge: string; because: string }[] = [];
  let candidate: MemoryBatch | undefined, near: NearPair[] = [], problems: string[] = [];
  // Ruling 18:39: the second submission answers the checklist. A request counter, advanced by the
  // host on every provider request, tells whether the model has seen the feedback since the candidate.
  let requests = 0, candidateRequest = -1, pendingFeedback: KnowledgeRead[] | undefined;
  let committed: { runId: number; committed: import("../store/index.ts").CommittedKnowledgeOp[]; diagnostics: import("./commit.ts").ConsolidationDiagnostic[]; output: MemoryBatch; unansweredNear: NearPair[] } | undefined;
  let failure: { runId: number; problems: string[]; conflicts?: import("../store/index.ts").ConsumedBaseConflict[] } | undefined;
  const sequence: { name: string; input: unknown; result: string }[] = [];
  const execute = (input: unknown) => {
    if (committed && review) return "rejected: already committed";
    if (review && candidate && requests === candidateRequest) return "rejected: the review feedback has not been read yet; resubmit after the feedback message";
    const prepared = prepareMemory(store, sessionId, input, run, review?.frozen, path, [...reads.values()], eligibleSupport, skippable);
    problems = prepared.results.filter(r => r.startsWith("rejected:"));
    if (problems.length) { failure = undefined; return JSON.stringify({ results: prepared.results }); }
    if (review && !candidate) {
      candidate = structuredClone(prepared.batch); candidateRequest = requests;
      const feedback = review.feedback(candidate); near = feedback.near;
      pendingFeedback = structuredClone(feedback.completed); // Grant only when the next provider request confirms delivery.
      problems = ["first batch requires a second submission"];
      return JSON.stringify({ results: prepared.results, feedback: { role: "user", content: feedback.text } });
    }
    const labels = new Set(prepared.batch.operations.map((op, i) => op.op === "create" ? `$e${i + 1}` : op.op === "archive" ? "" : op.id));
    const unansweredNear = near.filter(pair => (labels.has(pair.candidate) || (pair.candidate.startsWith("$e") && prepared.batch.operations.some(op => op.op === "create"))) && !prepared.batch.operations.some(op =>
      (op.op === "update" || op.op === "merge") && (op.id === pair.knowledge || op.absorb?.includes(pair.knowledge))));
    const diagnostics = prepared.diagnostics;
    if (unansweredNear.length) diagnostics.push({ kind: "unanswered_near", pairs: unansweredNear });
    const receipt = (items: import("../store/index.ts").CommittedKnowledgeOp[]) => JSON.stringify({ results: prepared.results, committed: items, diagnostics });
    const result = store.commitConsolidationRun({ path, run: { ...run, response: JSON.stringify({ problems: [] }), ...(review ? {} : { request: JSON.stringify(input) }) }, operations: prepared.operations,
      ...(review ? { consolidated: review.frozen.rangeFacts.map(f => f.id) } : {}),
      finalizeResponse: ({ committed }) => {
        if (review) diagnostics.push(...accounting(store, prepared.batch, review.frozen.rangeFacts, path));
        return review ? JSON.stringify({ toolCalls: [...sequence, { name: "memory", input, result: receipt(committed) }], candidate, committed, diagnostics, problems: [], readKnowledgeCommits: review.frozen.prepared?.readKnowledgeCommits ?? [] }) : receipt(committed); } });
    if (!result.ok) { failure = result; problems = result.problems; return JSON.stringify({ results: prepared.results.map(() => `rejected: ${problems.join("; ")}`) }); }
    committed = { ...result, diagnostics, output: structuredClone(prepared.batch), unansweredNear };
    allCommitted.push(...result.committed);
    if (skippable) skipped.push(...prepared.batch.skipped.flatMap(skip => "knowledge" in skip ? [skip] : []));
    // A receipt names the new version but does not supply its complete rendered body.
    problems = []; failure = undefined;
    return receipt(result.committed);
  };
  return { execute, reread, sequence, allCommitted, skipped, get readCommits() { return [...reads.keys()]; }, requestSeen: () => { requests++; if (pendingFeedback !== undefined) { reread(pendingFeedback); pendingFeedback = undefined; } }, get candidate() { return candidate; }, get committed() { return committed; }, get problems() { return problems; }, get failure() { return failure; }, get competitiveConflicts() { return failure?.conflicts ?? []; } };
}
