import type { Fact, FactRelation } from "../model/index.ts";
import type { FactCommitInput, KnowledgePath, PathSnapshot, Store } from "../store/index.ts";
import { renderFact } from "../render/index.ts";
import { characterBigrams, jaccardBigrams } from "../consolidation/similarity.ts";

export const NOTING_NEAR_LIMIT = 3;

export interface NotingNearNeighbour { factId: number; score: number }
export interface NotingNearShown {
  handle: string;
  text: string;
  neighbours: NotingNearNeighbour[];
}
export interface NotingNearAudit {
  threshold: number;
  firstSubmission: { facts: unknown[] };
  shown: NotingNearShown[];
}
export interface NotingUnansweredNearPair {
  fact: string;
  neighbour: string;
  score: number;
}
export type NotingDiagnostic = { kind: "unanswered_near"; pairs: NotingUnansweredNearPair[] };
export interface NotingNearCandidate {
  fact: Fact;
  relations: FactRelation[];
  grams: ReadonlySet<string>;
}
/** In-memory handoff for 38b. The whole applicable pool is held only for this binding and is never
 * serialized into the run audit; the audit stores only the facts actually shown. */
export interface NotingNearSnapshot {
  threshold: number;
  candidates: readonly NotingNearCandidate[];
  firstSubmission: { facts: unknown[] };
  shown: readonly NotingNearShown[];
}

export function captureNotingNear(store: Store, sessionId: number, path: KnowledgePath, pathSnapshot: PathSnapshot,
  facts: readonly FactCommitInput[], firstSubmission: { facts: unknown[] }, threshold: number): NotingNearSnapshot {
  const pool = store.notingNearPool(sessionId, path, pathSnapshot);
  const candidates = pool.facts.map(fact => ({ fact, relations: pool.relations.get(fact.id) ?? [], grams: characterBigrams(fact.text) }));
  const shown = facts.flatMap((fact, index) => {
    const grams = characterBigrams(fact.text);
    const neighbours = candidates.map(candidate => ({ factId: candidate.fact.id, score: jaccardBigrams(grams, candidate.grams) }))
      .filter(candidate => candidate.score >= threshold)
      .sort((a, b) => b.score - a.score || a.factId - b.factId)
      .slice(0, NOTING_NEAR_LIMIT);
    return neighbours.length ? [{ handle: `$${index + 1}`, text: fact.text, neighbours }] : [];
  });
  return { threshold, candidates, firstSubmission: structuredClone(firstSubmission), shown };
}

export function notingNearFeedback(snapshot: NotingNearSnapshot): string {
  const byId = new Map(snapshot.candidates.map(candidate => [candidate.fact.id, candidate]));
  const near = snapshot.shown.map(item => [
    `${item.handle} ${item.text}`,
    ...item.neighbours.map(neighbour => {
      const candidate = byId.get(neighbour.factId)!;
      return `F${neighbour.factId} (Jaccard ${neighbour.score})\n${renderFact(candidate.fact, candidate.relations)}`;
    }),
  ].join("\n")).join("\n\n");
  return [
    "System-generated review guidance; not a human ruling or adoption evidence.",
    "NEAR:",
    near,
    "Resubmit the complete facts batch. Add support or negate only when the claims affirm or overturn one another; lexical nearness alone is not evidence, and an unrelated neighbour needs no answer.",
  ].join("\n\n");
}

export function notingNearAudit(snapshot: NotingNearSnapshot | undefined): NotingNearAudit | undefined {
  if (!snapshot?.shown.length) return undefined;
  return { threshold: snapshot.threshold, firstSubmission: structuredClone(snapshot.firstSubmission), shown: structuredClone([...snapshot.shown]) };
}

/** Compare committed identities with every unique held fact that appeared anywhere in the review.
 * This deliberately does not reuse first-submission positions or select another top three. */
export function unansweredNotingNear(snapshot: NotingNearSnapshot | undefined, facts: readonly FactCommitInput[], ids: readonly number[]): NotingDiagnostic[] {
  if (!snapshot?.shown.length) return [];
  const shownIds = [...new Set(snapshot.shown.flatMap(item => item.neighbours.map(neighbour => neighbour.factId)))];
  const candidates = new Map(snapshot.candidates.map(candidate => [candidate.fact.id, candidate]));
  const pairs: NotingUnansweredNearPair[] = [];
  facts.forEach((fact, index) => {
    const answered = new Set([...fact.support ?? [], ...fact.negate ?? []].map(relation => relation.target));
    const grams = characterBigrams(fact.text);
    for (const neighbourId of shownIds) {
      const candidate = candidates.get(neighbourId)!;
      const score = jaccardBigrams(grams, candidate.grams);
      if (score >= snapshot.threshold && !answered.has(`F${neighbourId}`))
        pairs.push({ fact: `F${ids[index]}`, neighbour: `F${neighbourId}`, score });
    }
  });
  return pairs.length ? [{ kind: "unanswered_near", pairs }] : [];
}
