import type { KnowledgeWithRevision } from "../store/index.ts";
import { similarity } from "../consolidation/similarity.ts";
import { budgetKnowledge, renderKnowledge } from "./index.ts";

/**
 * The relevance-bounded worker knowledge seam shared by Consolidation and Dreaming.
 * Callers own candidate eligibility and the query that describes their frozen work; this function
 * owns only lexical scoring and whole-item selection. Presentation remains category-grouped by
 * `budgetKnowledge`, whose stable category/time/id ordering resolves equal scores.
 */
export function budgetRelevantKnowledge(
  candidates: KnowledgeWithRevision[],
  cap: number,
  query: string,
  line: (knowledge: KnowledgeWithRevision) => string = renderKnowledge,
  budget = "Knowledge capacity",
) {
  const scores = new Map(candidates.map(value => [value.revision.id, similarity(query, value.revision.text)]));
  return budgetKnowledge(candidates, cap, line, budget, undefined,
    (left, right) => scores.get(right.revision.id)! - scores.get(left.revision.id)!);
}
