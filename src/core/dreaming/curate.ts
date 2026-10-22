// Dreaming's curate task (ticket 144 stage 4 §4, ticket 146): the pool view, the groups of at most 100 items, the batches of at most
// 20 inside a group, the prefix a group's tasks share, the check of a batch file and what is applied from it.

import { KNOWLEDGE_CATEGORIES, knowledgeCategoryGroup } from "../model/index.ts";
import { problem, plan, type CheckResult, type WorkspaceFile } from "../workspace/index.ts";
import { renderKnowledge, tokens, withFactDates, withKnowledgeCost } from "../render/index.ts";
import type { KnowledgePath, Store, WorkspaceOperationResult } from "../store/index.ts";
import { CURATE_ROTATION, type CurateOperation } from "../store/executions.ts";
import type { PlannedBlock } from "../workspace/plan.ts";

/** 146 rulings 2 and 3: a curate agent takes at most this many items, all shown whole; it works through them in batches of at most
 * `CURATE_BATCH_ITEMS`, each of one category. Named constants, like `CLASSIFY_PASS_ITEMS`. */
export const CURATE_GROUP_ITEMS = 100;
export const CURATE_BATCH_ITEMS = 20;

export type CurateItem = ReturnType<Store["curateItems"]>[number];
export type Category = (typeof KNOWLEDGE_CATEGORIES)[number];
const groupOf = (item: CurateItem): Category => knowledgeCategoryGroup(item.value.revision.category);

/** One item rendered whole, as the group prefix shows it. */
export function wholeText(store: Store, item: CurateItem): string {
  const body = renderKnowledge(item.value, item.address, false, store.writing);
  return withFactDates(withKnowledgeCost(body, tokens(body)), item.dates);
}
/** What an item costs in a prefix: its whole rendering and the separator after it. */
export const wholeCost = (store: Store, item: CurateItem): number => tokens(wholeText(store, item)) + 1;
const headingOf = (category: Category) => `## ${category} (${CURATE_GROUP_ITEMS})\n\n`;
export const headingCost = (category: Category) => tokens(headingOf(category));

/** The prefix a group's tasks share (§2.4): the group's items whole, by category, oldest change first. `total` is the size of the whole pool. */
export function curatePrefix(store: Store, path: KnowledgePath, items: readonly CurateItem[] = store.curateItems(path), total = store.curateItems(path).length) {
  const text = KNOWLEDGE_CATEGORIES.map(category => ({ category, items: items.filter(item => groupOf(item) === category) })).filter(part => part.items.length)
    .map(part => `## ${part.category} (${part.items.length})\n\n${part.items.map(item => wholeText(store, item)).join("\n\n")}`).join("\n\n");
  return { text: `Knowledge of this group: ${items.length} of the session's ${total} current items, by category:\n\n${text || "none"}` };
}

/** §2.2: the groups of a run. Largest category first, each category whole into the first group that has room for it by item count and by
 * token cost; a category that does not fit an empty group is cut into consecutive chunks. Deterministic, not optimal. `room` is the input
 * allowance left for a group's items (Infinity without one). An item that fits no empty group alone refuses the formation. */
export function formGroups(items: readonly CurateItem[], cost: (item: CurateItem) => number, room = Infinity): { groups: CurateItem[][] } | { refusal: string } {
  const byCategory = new Map<Category, CurateItem[]>();
  for (const item of [...items].sort((a, b) => a.value.revision.id - b.value.revision.id)) { const list = byCategory.get(groupOf(item)); if (list) list.push(item); else byCategory.set(groupOf(item), [item]); }
  const total = (list: readonly CurateItem[]) => list.reduce((sum, item) => sum + cost(item), 0);
  const categories = [...byCategory.keys()].sort((a, b) => byCategory.get(b)!.length - byCategory.get(a)!.length
    || total(byCategory.get(b)!) - total(byCategory.get(a)!) || KNOWLEDGE_CATEGORIES.indexOf(a) - KNOWLEDGE_CATEGORIES.indexOf(b));
  interface Open { parts: Map<Category, CurateItem[]>; count: number; cost: number }
  const fits = (open: Open, category: Category, chunk: readonly CurateItem[]) => open.count + chunk.length <= CURATE_GROUP_ITEMS
    && open.cost + total(chunk) + (open.parts.has(category) ? 0 : headingCost(category)) <= room;
  const empty = (): Open => ({ parts: new Map(), count: 0, cost: 0 });
  const opened: Open[] = [];
  const put = (category: Category, chunk: CurateItem[]) => {
    let at = opened.find(open => fits(open, category, chunk));
    if (!at) opened.push(at = empty());
    if (!at.parts.has(category)) { at.cost += headingCost(category); at.parts.set(category, []); }
    at.parts.get(category)!.push(...chunk); at.count += chunk.length; at.cost += total(chunk);
  };
  for (const category of categories) {
    const list = byCategory.get(category)!;
    if (fits(empty(), category, list)) { put(category, list); continue; }
    for (let at = 0; at < list.length;) {
      const chunk: CurateItem[] = [];
      while (at < list.length && fits(empty(), category, [...chunk, list[at]!])) chunk.push(list[at++]!);
      if (!chunk.length) return { refusal: `${list[at]!.address} costs ${cost(list[at]!)} tokens and fits no group alone (room ${room})` };
      put(category, chunk);
    }
  }
  const order = new Map(KNOWLEDGE_CATEGORIES.flatMap(category => (byCategory.get(category) ?? []).map((item, i) => [item, [KNOWLEDGE_CATEGORIES.indexOf(category), i] as const] as const)));
  const rank = (item: CurateItem) => order.get(item)![0] * 1e6 + order.get(item)![1];
  const groups = opened.map(open => KNOWLEDGE_CATEGORIES.flatMap(category => open.parts.get(category) ?? []).sort((a, b) => rank(a) - rank(b)));
  return { groups: groups.sort((a, b) => rank(a[0]!) - rank(b[0]!)) };
}

/** §4.1: the batches of a group's items, in prefix order: each category's items cut into consecutive batches of at most 20. */
export function batchesOf(items: readonly CurateItem[]): { category: Category; items: CurateItem[] }[] {
  return KNOWLEDGE_CATEGORIES.flatMap(category => {
    const own = items.filter(item => groupOf(item) === category);
    return Array.from({ length: Math.ceil(own.length / CURATE_BATCH_ITEMS) }, (_, i) => ({ category, items: own.slice(i * CURATE_BATCH_ITEMS, (i + 1) * CURATE_BATCH_ITEMS) }));
  });
}

export const batchFileName = (index: number, category: string) => `curate-${index + 1}-${category}.md`;

/** The check of a curate batch file: the Stage 2 plan for the run's one operation (never `create`). A batch may act on any live item of the
 * session's pools, inside or outside it (ruling 3); merged items share one category and scope, which the plan checks. A file the agent
 * never wrote fails (it is not read as `## none`). */
export function checkBatch(store: Store, path: KnowledgePath, file: WorkspaceFile & { written: boolean }, operation: CurateOperation): CheckResult & { planned: PlannedBlock[] } {
  if (!file.written) return { ok: false, problems: [problem(file, 0, file.name, "not written: write this batch's file, with `## none` when nothing in it needs a change")], lengths: [], planned: [] };
  const planned = plan(store, { kind: "curate", operation, sessionId: path.sessionId, path, file });
  return { ok: !planned.problems.length, problems: planned.problems, lengths: planned.lengths, planned: planned.knowledge };
}
export { CURATE_ROTATION, type CurateOperation };
export type { WorkspaceOperationResult };
