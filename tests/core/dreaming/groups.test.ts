import { expect, test } from "vitest";
import { formGroups } from "../../../src/core/dreaming/curate.ts";
import type { CurateItem } from "../../../src/core/store/index.ts";

test("candidate groups preserve seed adjacency and assign each item once across the 50-item boundary", () => {
  const items = Array.from({ length: 121 }, (_, id) => ({ address: `K${id + 1}@v1` }) as CurateItem);
  const groups = formGroups(items);
  expect(groups.map(group => group.length)).toEqual([50, 50, 21]);
  expect(groups.flat()).toEqual(items);
  expect(new Set(groups.flat()).size).toBe(items.length);
  expect(formGroups(items, 30).map(group => group.length)).toEqual([30, 30, 30, 30, 1]);
});
