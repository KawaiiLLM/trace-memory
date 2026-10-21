// Dreaming's curate task (ticket 144 stage 4 §4): the pool view and the prefix every task of a run shares, the batches
// (one per category), the check of a batch file and what is applied from it.

import { KNOWLEDGE_CATEGORIES, knowledgeCategoryGroup, type KnowledgeCategory } from "../model/index.ts";
import { describeBlock, problem, plan, type CheckResult, type WorkspaceFile } from "../workspace/index.ts";
import { knowledgeTitle, renderKnowledge, tokens, withFactDates, withKnowledgeCost } from "../render/index.ts";
import type { KnowledgeOperationInput, KnowledgePath, Store, WorkspaceOperationResult } from "../store/index.ts";
import type { PlannedBlock } from "../workspace/plan.ts";

/** The knowledge block every task of a run opens with (§4.1): named constant, not a setting. */
export const CURATE_PREFIX_TOKENS = 50_000;

export type CurateItem = ReturnType<Store["curateItems"]>[number];
export type Category = (typeof KNOWLEDGE_CATEGORIES)[number];
const groupOf = (item: CurateItem): Category => knowledgeCategoryGroup(item.value.revision.category);

/** The prefix text and the items it shows, by category. Unscored items are shown whole, even past the cap; scored items follow
 * in score order while the block stays within it; the rest show their header line only (title included). */
export function curatePrefix(store: Store, path: KnowledgePath, items: readonly CurateItem[] = store.curateItems(path), cap = CURATE_PREFIX_TOKENS) {
  const writing = store.writing;
  const whole = new Map(items.map(item => {
    const body = renderKnowledge(item.value, item.address, false, writing);
    return [item.value.revision.id, withFactDates(withKnowledgeCost(body, tokens(body)), item.dates)] as const;
  }));
  const shown = new Set<number>();
  let used = 0;
  for (const item of items.filter(item => item.score === null)) { shown.add(item.value.revision.id); used += tokens(whole.get(item.value.revision.id)!) + 1; }
  const scored = items.filter(item => item.score !== null).sort((a, b) => b.score! - a.score! || b.value.revision.id - a.value.revision.id);
  for (const item of scored) {
    const cost = tokens(whole.get(item.value.revision.id)!) + 1;
    if (used + cost > cap) break;
    shown.add(item.value.revision.id); used += cost;
  }
  const render = (item: CurateItem) => shown.has(item.value.revision.id) ? whole.get(item.value.revision.id)!
    : whole.get(item.value.revision.id)!.split("\n")[0]!;
  const byCategory = new Map<Category, CurateItem[]>();
  for (const category of KNOWLEDGE_CATEGORIES) byCategory.set(category, items.filter(item => groupOf(item) === category));
  const text = KNOWLEDGE_CATEGORIES.filter(category => byCategory.get(category)!.length)
    .map(category => `## ${category} (${byCategory.get(category)!.length})\n\n${byCategory.get(category)!.map(render).join("\n\n")}`).join("\n\n");
  return { text: `Current knowledge of this session's pools, by category:\n\n${text || "none"}`, byCategory };
}

export const batchFileName = (index: number, category: string) => `curate-${index + 1}-${category}.md`;

/** The check of a curate batch file: the Stage 2 plan, then the rule that a batch touches only its own category (§4.3). Merge
 * parents and every base must sit in the batch's category group; `create`, split children and a category change by `update`
 * may name any category. */
export function checkBatch(store: Store, path: KnowledgePath, category: Category, file: WorkspaceFile): CheckResult & { planned: PlannedBlock[] } {
  const planned = plan(store, { kind: "curate", sessionId: path.sessionId, path, file });
  const problems = [...planned.problems];
  const groupAt = (knowledgeId: number, baseCommit: number) => {
    const revision = store.getKnowledgeRevision(knowledgeId, baseCommit);
    return revision ? knowledgeCategoryGroup(revision.category) : undefined;
  };
  if (!planned.problems.length) for (const entry of planned.knowledge) {
    const operation = entry.make().operation as KnowledgeOperationInput | undefined;
    if (!operation || operation.op === "create") continue;
    const bases = operation.op === "merge" ? [{ knowledgeId: operation.intoKnowledgeId, baseCommit: operation.intoBaseCommit }, ...operation.absorb]
      : [{ knowledgeId: operation.knowledgeId, baseCommit: operation.baseCommit }];
    for (const base of bases) {
      const group = groupAt(base.knowledgeId, base.baseCommit);
      if (group !== undefined && group !== category)
        problems.push(problem(file, entry.block.line, describeBlock(entry.block),
          `K${base.knowledgeId} is in category ${group}; this batch covers ${category}. Change a category with an update in the batch of the item's own category`));
    }
  }
  return { ok: !problems.length, problems, lengths: planned.lengths, planned: planned.knowledge };
}
export type { WorkspaceOperationResult };
