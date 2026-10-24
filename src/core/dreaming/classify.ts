import type { CurateItem } from "../store/index.ts";
import type { KnowledgeCategory, KnowledgeScope, ScoreRatings } from "../model/index.ts";

export interface ScoreVerdict { decision: string; accuracy: string; reason: string }
export interface ScoreTarget { label: string; title: string; text: string; category: KnowledgeCategory; scope: KnowledgeScope; knowledgeId: number; commit: number; verdict?: ScoreVerdict }
export interface RatedTarget extends ScoreRatings { knowledgeId: number; commit: number }
export const SCORING_BATCH_ITEMS = 100;
// Geometric mean of the three ratings, mapped 1–5 → 1–100 (2026-10-25 ruling: 「可以用几何平均折算」).
export const ratingScore = ({ consequence, frequency, current }: ScoreRatings): number =>
  Math.max(consequence === 5 ? 81 : 1, Math.round(1 + (Math.cbrt(consequence * frequency * current) - 1) / 4 * 99));

export function scoreTargets(items: readonly CurateItem[], verdicts: Readonly<Record<string, ScoreVerdict>>, all = false): ScoreTarget[] {
  return items.filter(item => all || item.score === null || item.scoredCommit !== item.value.revision.id).map(item => {
    const { knowledge, revision } = item.value;
    return { label: `K${knowledge.id}`, knowledgeId: knowledge.id, commit: revision.id, title: revision.title ?? "(no title)",
      text: revision.text, category: revision.category, scope: revision.scope, verdict: verdicts[revision.id] };
  });
}
export function scoringText(targets: readonly ScoreTarget[]): string {
  return targets.map(target => `${target.label}\n${target.title}\n${target.category}; ${target.scope}\n${target.text}\nCurate verdict: ${target.verdict ? JSON.stringify({ decision: target.verdict.decision, reason: target.verdict.reason }) : "not provided"}`).join("\n\n") + "\n";
}
export function checkScores(text: string, targets: readonly ScoreTarget[]): { scores: Map<string, ScoreRatings>; problems: string[] } {
  const scores = new Map<string, ScoreRatings>(), problems: string[] = [], wanted = new Set(targets.map(target => target.label));
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    const match = /^(K[1-9]\d*)\s+([1-5])\s+([1-5])\s+([1-5])$/.exec(line.trim());
    if (!match || !wanted.has(match[1]!)) { problems.push(`scores.md: expected a target label and three integer ratings 1–5 (consequence frequency current): ${line}`); continue; }
    if (scores.has(match[1]!)) problems.push(`scores.md: duplicate ${match[1]}`);
    scores.set(match[1]!, { consequence: Number(match[2]), frequency: Number(match[3]), current: Number(match[4]) });
  }
  for (const target of targets) if (!scores.has(target.label)) problems.push(`scores.md: missing ${target.label}`);
  return { scores, problems };
}
