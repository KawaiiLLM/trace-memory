import type { CurateItem, KnowledgeOperationInput } from "../store/index.ts";
import type { KnowledgeCategory, KnowledgeScope, ScoreRatings } from "../model/index.ts";

/** Split labels are workspace-local until the atomic group commit allocates their identities. */
export interface ScoreTarget { label: string; title: string; text: string; category: KnowledgeCategory; scope: KnowledgeScope; operation?: number; part?: number; knowledgeId?: number; commit?: number }
export interface RatedTarget extends ScoreRatings { knowledgeId: number; commit: number }
// Geometric mean of the three ratings, mapped 1–5 → 1–100 (2026-10-25 ruling: 「可以用几何平均折算」).
export const ratingScore = ({ consequence, frequency, current }: ScoreRatings): number =>
  Math.max(consequence === 5 ? 81 : 1, Math.round(1 + (Math.cbrt(consequence * frequency * current) - 1) / 4 * 99));

export function scoreTargets(items: readonly CurateItem[], operations: readonly KnowledgeOperationInput[], all = false): ScoreTarget[] {
  const targets: ScoreTarget[] = [];
  const current = new Map(items.map(item => [item.value.knowledge.id, item.value]));
  operations.forEach((op, index) => {
    if (op.op === "archive" || op.op === "create") return;
    const id = op.op === "merge" ? op.intoKnowledgeId : op.knowledgeId;
    const base = current.get(id)!;
    targets.push({ label: `K${id}`, title: op.title ?? base.revision.title ?? "(no title)", text: op.text ?? base.revision.text,
      category: op.category, scope: op.scope, operation: index, part: 0 });
    if (op.op === "split") op.children.forEach((child, part) => targets.push({ label: `K${id}.child${part + 1}`, title: child.title ?? "(no title)",
      text: child.text, category: child.category, scope: child.scope ?? op.scope, operation: index, part: part + 1 }));
  });
  const consumed = new Set(operations.flatMap(op => op.op === "create" ? [] : op.op === "merge"
    ? [op.intoKnowledgeId, ...op.absorb.map(item => item.knowledgeId)] : [op.knowledgeId]));
  for (const item of items) if ((all || item.score === null || item.scoredCommit !== item.value.revision.id) && !consumed.has(item.value.knowledge.id)) {
    const { knowledge, revision } = item.value;
    targets.push({ label: `K${knowledge.id}`, knowledgeId: knowledge.id, commit: revision.id, title: revision.title ?? "(no title)",
      text: revision.text, category: revision.category, scope: revision.scope });
  }
  return targets;
}
export function scoringText(targets: readonly ScoreTarget[]): string {
  return targets.map(target => `${target.label}\n${target.title}\n${target.category}; ${target.scope}\n${target.text}`).join("\n\n") + "\n";
}
export function checkScores(text: string, targets: readonly ScoreTarget[]): { scores: Map<string, ScoreRatings>; problems: string[] } {
  const scores = new Map<string, ScoreRatings>(), problems: string[] = [], wanted = new Set(targets.map(target => target.label));
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    const match = /^(K[1-9]\d*(?:\.child[1-9]\d*)?)\s+([1-5])\s+([1-5])\s+([1-5])$/.exec(line.trim());
    if (!match || !wanted.has(match[1]!)) { problems.push(`scores.md: expected a target label and three integer ratings 1–5 (consequence frequency current): ${line}`); continue; }
    if (scores.has(match[1]!)) problems.push(`scores.md: duplicate ${match[1]}`);
    scores.set(match[1]!, { consequence: Number(match[2]), frequency: Number(match[3]), current: Number(match[4]) });
  }
  for (const target of targets) if (!scores.has(target.label)) problems.push(`scores.md: missing ${target.label}`);
  return { scores, problems };
}
