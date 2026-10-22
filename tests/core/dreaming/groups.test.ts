// Ticket 146 §2.2 and §4.1: how a run's items become groups of at most 100 and batches of at most 20. Pure functions over fake items.
import { expect, test } from "vitest";
import { KNOWLEDGE_CATEGORIES } from "../../../src/core/model/index.ts";
import { CURATE_BATCH_ITEMS, CURATE_GROUP_ITEMS, batchesOf, formGroups, headingCost, type CurateItem } from "../../../src/core/dreaming/curate.ts";

let next = 1;
const item = (category: string, id = next++) => ({ value: { revision: { id, knowledgeId: id, category } }, address: `K${id}@v1` }) as unknown as CurateItem;
const pool = (sizes: Record<string, number>) => Object.entries(sizes).flatMap(([category, n]) => Array.from({ length: n }, () => item(category)));
const unit = () => 1;
const shape = (groups: CurateItem[][]) => groups.map(group => {
  const counts = new Map<string, number>();
  for (const i of group) counts.set(i.value.revision.category, (counts.get(i.value.revision.category) ?? 0) + 1);
  return [...counts].map(([category, n]) => `${category}:${n}`).join("+");
});
const formed = (items: CurateItem[], cost: (i: CurateItem) => number = unit, room = Infinity) => {
  const result = formGroups(items, cost, room);
  if ("refusal" in result) throw new Error(result.refusal);
  return result.groups;
};

test("a non-empty pool of at most 100 items is one group, with no allowance and with one just large enough; the empty pool has no group", () => {
  for (const n of [1, 40, 100]) {
    expect(formed(pool({ constraint: n }))).toHaveLength(1);
    expect(formed(pool({ constraint: n }), unit, n + headingCost("constraint"))).toHaveLength(1);
  }
  expect(formed([])).toEqual([]);
});

test("a category that fits an empty group but not the allowance beside the others splits by the allowance; each item fits alone", () => {
  const h = headingCost("constraint");
  const two = pool({ constraint: 2 });
  const cost = () => 6;
  expect(formed(two, cost, 12 + h)).toHaveLength(1);
  expect(shape(formed(two, cost, 11 + h))).toEqual(["constraint:1", "constraint:1"]); // room 10 + heading: one item at a time
  const many = pool({ constraint: 14, reference: 13, open: 13 });
  const groups = formed(many, () => 5, 30 * 5 / 2);
  expect(groups.length).toBeGreaterThan(1);
  for (const group of groups) expect(group.length * 5 + new Set(group.map(i => i.value.revision.category)).size * headingCost("constraint")).toBeLessThanOrEqual(75 + 3 * headingCost("constraint"));
});

test("the five examples of the design (sizes of categories to groups)", () => {
  const o = KNOWLEDGE_CATEGORIES.slice(0, 5) as readonly string[];
  const by = (...sizes: number[]) => Object.fromEntries(sizes.map((n, i) => [o[i]!, n]));
  expect(shape(formed(pool(by(90, 80, 60))))).toEqual([`${o[0]}:90`, `${o[1]}:80`, `${o[2]}:60`]);
  expect(shape(formed(pool(by(60, 50, 40, 30, 20))))).toEqual([`${o[0]}:60+${o[2]}:40`, `${o[1]}:50+${o[3]}:30+${o[4]}:20`]);
  expect(shape(formed(pool(by(79, 39, 1, 54, 10))))).toEqual([`${o[0]}:79+${o[2]}:1+${o[4]}:10`, `${o[1]}:39+${o[3]}:54`]);
  expect(shape(formed(pool(by(150, 50, 30))))).toEqual([`${o[0]}:100`, `${o[0]}:50+${o[1]}:50`, `${o[2]}:30`]);
  expect(shape(formed(pool(by(60, 60, 60, 50))))).toEqual([`${o[0]}:60`, `${o[1]}:60`, `${o[2]}:60`, `${o[3]}:50`]); // ceil(230 / 100) is 3, but no category is split
});

test("a category that fits an empty group is never split, no group passes 100 items, and every group respects the allowance", () => {
  const o = KNOWLEDGE_CATEGORIES.slice(0, 4) as readonly string[];
  const sizes = [0, 7, 30, 55, 100];
  for (const a of sizes) for (const b of sizes) for (const c of sizes) for (const d of [0, 45, 101]) {
    const items = pool({ [o[0]!]: a, [o[1]!]: b, [o[2]!]: c, [o[3]!]: d });
    for (const room of [Infinity, 130]) {
      const groups = formed(items, i => 1 + (i.value.revision.id % 3), room);
      const homes = new Map<string, number>();
      for (const [at, group] of groups.entries()) {
        expect(group.length).toBeLessThanOrEqual(CURATE_GROUP_ITEMS);
        for (const category of new Set(group.map(i => i.value.revision.category))) homes.set(category, (homes.get(category) ?? 0) + 1);
        expect(new Set(group).size).toBe(group.length);
        void at;
      }
      for (const [category, n] of Object.entries({ [o[0]!]: a, [o[1]!]: b, [o[2]!]: c, [o[3]!]: d }))
        if (n && n <= CURATE_GROUP_ITEMS && room === Infinity) expect(homes.get(category)).toBe(1);
      expect(groups.flat()).toHaveLength(items.length);
    }
  }
});

test("the allowance closes a group at k items and one token less closes it at k - 1", () => {
  const h = headingCost("constraint");
  for (const k of [3, 10]) {
    expect(formed(pool({ constraint: k }), unit, k + h)).toHaveLength(1);
    const less = formed(pool({ constraint: k }), unit, k - 1 + h);
    expect(less.map(group => group.length)).toEqual([k - 1, 1]);
  }
});

test("the same pool gives the same groups: repeated calls and a shuffled input", () => {
  const items = pool({ constraint: 150, reference: 50, open: 30 });
  const key = (groups: CurateItem[][]) => groups.map(group => group.map(i => i.value.revision.id).join(",")).join("|");
  const first = key(formed(items));
  expect(key(formed(items))).toBe(first);
  const shuffled = [...items].sort((a, b) => (a.value.revision.id * 7919) % 13 - (b.value.revision.id * 7919) % 13 || a.value.revision.id - b.value.revision.id);
  expect(key(formed(shuffled))).toBe(first);
});

test("a category of 230 is cut into consecutive chunks of 100, 100 and 30, oldest first", () => {
  const items = pool({ constraint: 230 });
  const groups = formed(items);
  expect(groups.map(group => group.length)).toEqual([100, 100, 30]);
  expect(groups.flat().map(i => i.value.revision.id)).toEqual(items.map(i => i.value.revision.id));
});

test("an item that fits no empty group alone refuses the formation and names it", () => {
  const items = pool({ constraint: 3 });
  const result = formGroups(items, i => i === items[1] ? 50 : 1, 10);
  expect(result).toMatchObject({ refusal: expect.stringContaining(items[1]!.address) });
  expect(result).not.toHaveProperty("groups");
});

test("batches are cut per category at 20, in category order: 79 constraint and 10 reference give 20, 20, 20, 19 and 10", () => {
  const sizes = batchesOf(pool({ reference: 10, constraint: 79 })).map(batch => [batch.category, batch.items.length]);
  expect(sizes).toEqual([["constraint", 20], ["constraint", 20], ["constraint", 20], ["constraint", 19], ["reference", 10]]);
  expect(CURATE_BATCH_ITEMS).toBe(20);
});
