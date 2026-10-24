import type { CurateItem, KnowledgeOperationInput, KnowledgeWithRevision } from "../store/index.ts";
import type { KnowledgeCategory, KnowledgeScope } from "../model/index.ts";
import { knowledgeStaleLabel } from "../render/index.ts";

export const CLASSIFY_ANCHORS = 30;
/** Stratified old scored versions, including small pools; changed candidates do not anchor themselves. */
export function classifyAnchors(items: readonly CurateItem[], excluded: ReadonlySet<number> = new Set()): CurateItem[] {
  const scored = items.filter(item => !excluded.has(item.value.knowledge.id) && item.score !== null && item.scoredCommit === item.value.revision.id)
    .sort((a, b) => a.score! - b.score! || a.value.revision.id - b.value.revision.id);
  return scored.length <= CLASSIFY_ANCHORS ? scored : Array.from({ length: CLASSIFY_ANCHORS }, (_, i) => scored[Math.floor(i * (scored.length - 1) / (CLASSIFY_ANCHORS - 1))]!);
}
export interface ScoreTarget extends Pick<KnowledgeWithRevision, "staleReasons"> { label: string; title: string; text: string; category: KnowledgeCategory; scope: KnowledgeScope; operation?: number; part?: number; knowledgeId?: number; commit?: number }
export interface CheckedScores { scores: Map<string, number>; problems: string[] }
/** Split labels are workspace-local until the atomic group commit allocates their identities. */
export function scoreTargets(items: readonly CurateItem[], operations: readonly KnowledgeOperationInput[]): ScoreTarget[] {
  const targets: ScoreTarget[] = [];
  const current = new Map(items.map(item => [item.value.knowledge.id, item.value]));
  operations.forEach((op, index) => {
    if (op.op === "archive" || op.op === "create") return;
    const id = op.op === "merge" ? op.intoKnowledgeId : op.knowledgeId;
    const base = current.get(id)!;
    targets.push({ label: `K${id}`, title: op.title ?? base.revision.title ?? "(no title)", text: op.text ?? base.revision.text, category: op.category, scope: op.scope, staleReasons: base.staleReasons, operation: index, part: 0 });
    if (op.op === "split") op.children.forEach((child, part) => targets.push({ label: `K${id}.child${part + 1}`, title: child.title ?? "(no title)", text: child.text, category: child.category, scope: child.scope ?? op.scope, staleReasons: base.staleReasons, operation: index, part: part + 1 }));
  });
  const consumed = new Set(operations.flatMap(op => op.op === "create" ? [] : op.op === "merge" ? [op.intoKnowledgeId, ...op.absorb.map(item => item.knowledgeId)] : [op.knowledgeId]));
  for (const item of items) if ((item.score === null || item.scoredCommit !== item.value.revision.id) && !consumed.has(item.value.knowledge.id)) targets.push({ label: `K${item.value.knowledge.id}`, title: item.value.revision.title ?? "(no title)", text: item.value.revision.text, category: item.value.revision.category, scope: item.value.revision.scope, staleReasons: item.value.staleReasons, knowledgeId: item.value.knowledge.id, commit: item.value.revision.id });
  return targets;
}
export function scoringText(anchors: readonly CurateItem[], targets: readonly ScoreTarget[]): string {
  return `# Old scored anchors (scale only)\n\n${anchors.map(item => `K${item.value.knowledge.id} ${item.score}\n${item.value.revision.title ?? "(no title)"}${knowledgeStaleLabel(item.value)}\n${item.value.revision.category}; ${item.value.revision.scope}\n${item.value.revision.text}`).join("\n\n") || "None available"}\n\n# Items to score\n\n${targets.map(target => `${target.label}\n${target.title}${knowledgeStaleLabel(target)}\n${target.category}; ${target.scope}\n${target.text}`).join("\n\n") || "None"}\n`;
}
export function checkScores(text: string, targets: readonly ScoreTarget[]): CheckedScores {
  const scores = new Map<string, number>(), problems: string[] = [], wanted = new Set(targets.map(target => target.label));
  for (const line of text.split(/\r?\n/).filter(line => line.trim())) {
    const match = /^(K[1-9]\d*(?:\.child[1-9]\d*)?)\s+(\d+)$/.exec(line.trim());
    if (!match || !wanted.has(match[1]!) || Number(match[2]) < 1 || Number(match[2]) > 100) { problems.push(`scores.md: expected one target label and an integer score 1–100: ${line}`); continue; }
    if (scores.has(match[1]!)) problems.push(`scores.md: duplicate ${match[1]}`);
    scores.set(match[1]!, Number(match[2]));
  }
  for (const target of targets) if (!scores.has(target.label)) problems.push(`scores.md: missing ${target.label}`);
  return { scores, problems };
}
