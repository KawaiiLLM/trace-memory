import { prepareMemory, accounting } from "./commit.ts";
import type { MemoryBatch } from "../model/index.ts";
import type { Store, RunInput, KnowledgePath } from "../store/index.ts";
import type { freezeIntegration, NearPair } from "./index.ts";
export interface MemoryReview {
  frozen: ReturnType<typeof freezeIntegration>;
  feedback(batch: MemoryBatch): { text: string; near: NearPair[] };
}
export function bindMemory(store: Store, sessionId: number, run: RunInput, review?: MemoryReview, path: KnowledgePath = store.knowledgePath(sessionId)) {
  const reads = new Map((review?.frozen.knowledge ?? store.listCurrentKnowledge(path)).map(k => [k.revision.id, k]));
  const reread = (addresses: string) => {
    for (const address of addresses.split(",").map(a => a.trim())) {
      const match = /^K([1-9]\d*)(?:@([1-9]\d*))?$/.exec(address);
      if (!match) continue;
      const id = Number(match[1]);
      if (!match[2]) for (const [commit, item] of reads) if (item.knowledge.id === id) reads.delete(commit);
      if (match[2]) {
        const revision = store.getKnowledgeRevision(id, Number(match[2]));
        if (revision) reads.set(revision.id, { knowledge: store.getKnowledge(id)!, revision });
      } else for (const item of store.listCurrentKnowledge(path).filter(k => k.knowledge.id === id)) reads.set(item.revision.id, item);
    }
  };
  let candidate: MemoryBatch | undefined, near: NearPair[] = [], problems: string[] = [];
  // Ruling 18:39: the second submission answers the checklist. A request counter, advanced by the
  // host on every provider request, tells whether the model has seen the feedback since the candidate.
  let requests = 0, candidateRequest = -1;
  let committed: { runId: number; committed: import("../store/index.ts").CommittedKnowledgeOp[]; diagnostics: import("./commit.ts").IntegrationDiagnostic[]; output: MemoryBatch; unansweredNear: NearPair[] } | undefined;
  let failure: { runId: number; problems: string[] } | undefined;
  const sequence: { name: string; input: unknown; result: string }[] = [];
  const execute = (input: unknown) => {
    if (committed && review) return "rejected: already committed";
    if (review && candidate && requests === candidateRequest) return "rejected: the review feedback has not been read yet; resubmit after the feedback message";
    const prepared = prepareMemory(store, sessionId, input, run, review?.frozen, path, [...reads.values()]);
    problems = prepared.results.filter(r => r.startsWith("rejected:"));
    if (problems.length) return JSON.stringify({ results: prepared.results });
    if (review && !candidate) {
      candidate = structuredClone(prepared.batch); candidateRequest = requests;
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
    const result = store.commitIntegrationRun({ path, run: { ...run, response: JSON.stringify({ problems: [] }), ...(review ? {} : { request: JSON.stringify(input) }) }, operations: prepared.operations,
      ...(review ? { watermark: { sessionId, branch: run.branch!, lastIntegratedFact: review.frozen.rangeFacts.at(-1)!.id } } : {}),
      finalizeResponse: ({ committed }) => {
        if (review) diagnostics.push(...accounting(store, sessionId, prepared.batch, review.frozen.rangeFacts, path));
        return review ? JSON.stringify({ toolCalls: [...sequence, { name: "memory", input, result: receipt(committed) }], candidate, committed, diagnostics, problems: [], readKnowledgeCommits: review.frozen.knowledge.map(k => ({ knowledgeId: k.knowledge.id, commit: k.revision.id })) }) : receipt(committed); } });
    if (!result.ok) { failure = result; problems = result.problems; return JSON.stringify({ results: prepared.results.map(() => `rejected: ${problems.join("; ")}`) }); }
    committed = { ...result, diagnostics, output: structuredClone(prepared.batch), unansweredNear };
    for (const item of result.committed) reread(`K${item.knowledgeId}`);
    problems = []; failure = undefined;
    return receipt(result.committed);
  };
  return { execute, reread, sequence, requestSeen: () => { requests++; }, get candidate() { return candidate; }, get committed() { return committed; }, get problems() { return problems; }, get failure() { return failure; } };
}
