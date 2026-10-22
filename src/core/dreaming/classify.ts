// Dreaming's classify task (ticket 144 stage 4 §6): which items a run scores, the anchors that show the scale, and the message
// of one pass. Scores live in columns outside the version chain; a changed item keeps its score until it is scored again (§6.7).

import { renderToolNames } from "../prompts/tool-names.ts";
import type { ToolNames } from "../prompts/tool-names.ts";
import { knowledgeTitle } from "../render/index.ts";
import type { WritingLimits } from "../model/index.ts";
import type { CurateItem } from "./curate.ts";

/** One conversation scores at most this many items (Magic Context's classify batch). */
export const CLASSIFY_PASS_ITEMS = 100;
/** Already-scored items shown beside a pass of a large pool, to carry the scale (Magic Context's stratified anchors). */
export const CLASSIFY_ANCHORS = 30;

/** §6.2: the set frozen when classify starts. Up to 100 current items are all scored in one pass; above that only the items that
 * are unscored or changed since they were scored, oldest change first, in passes of 100. Items come oldest change first. */
export function classifySet(items: readonly CurateItem[]): CurateItem[][] {
  const set = items.length <= CLASSIFY_PASS_ITEMS ? [...items]
    : items.filter(item => item.score === null || item.scoredCommit !== item.value.revision.id);
  const passes: CurateItem[][] = [];
  for (let at = 0; at < set.length; at += CLASSIFY_PASS_ITEMS) passes.push(set.slice(at, at + CLASSIFY_PASS_ITEMS));
  return passes;
}

/** §6.3: above 100 items, the scored items outside the set stand as anchors: all of them when there are 30 or fewer, otherwise 30
 * spread evenly over the scores from lowest to highest. */
export function classifyAnchors(items: readonly CurateItem[]): CurateItem[] {
  if (items.length <= CLASSIFY_PASS_ITEMS) return [];
  const scored = items.filter(item => item.score !== null && item.scoredCommit === item.value.revision.id)
    .sort((a, b) => a.score! - b.score! || a.value.revision.id - b.value.revision.id);
  const n = scored.length;
  return n <= CLASSIFY_ANCHORS ? scored : Array.from({ length: CLASSIFY_ANCHORS }, (_, i) => scored[Math.min(n - 1, Math.floor(i * n / CLASSIFY_ANCHORS))]!);
}

/** The first message of one pass: the anchors, then the items to score, whole, then the line that sends the model to `check`. */
export function classifyMessage(anchors: readonly CurateItem[], pass: readonly CurateItem[], limits: Pick<WritingLimits, "titleWords">, names: ToolNames, checkFirst: string): string {
  const show = (item: CurateItem, mark = "") => {
    const r = item.value.revision;
    return `K${r.knowledgeId} [${r.category}/${r.scope}]${mark} ${knowledgeTitle(r, limits.titleWords)}\n${r.text}`;
  };
  return [anchors.length ? `Already scored; shown for scale, do not score:\n\n${anchors.map(item => show(item, ` (score ${item.score})`)).join("\n\n")}` : "",
    `Items to score:\n\n${pass.map(item => show(item)).join("\n\n")}`, renderToolNames(checkFirst, names)].filter(Boolean).join("\n\n");
}
