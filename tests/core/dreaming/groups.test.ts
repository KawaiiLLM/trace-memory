import { expect, test } from "vitest";
import { candidateGroups, checkGroups, type ClusteredGroup } from "../../../src/core/dreaming/clustering.ts";
import type { CurateItem } from "../../../src/core/store/index.ts";

const range = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);
function group(start: number, count: number, marks: number[] = []): ClusteredGroup {
  const items = range(start, count);
  return { items, clusters: Array.from({ length: Math.ceil(count / 10) }, (_, i) => ({ label: `Topic ${start + i}`, items: items.slice(i * 10, i * 10 + 10),
    ...(marks.some(id => items.slice(i * 10, i * 10 + 10).includes(id)) ? { marks: Object.fromEntries(marks.filter(id => items.slice(i * 10, i * 10 + 10).includes(id)).map(id => [id, { kind: "duplicate" as const, reason: "Same claim" }])) } : {}) })) };
}

test("one candidate group tops up, one marked item at a time, touched clustering groups first, and drops what does not fit", () => {
  const clustering = [group(1, 50, [1, 2]), group(51, 50, [51, 52]), group(101, 3, [101, 102, 103])];
  const groups = candidateGroups(clustering, new Set(range(3, 45)));
  expect(groups.map(value => value.items)).toEqual([[1, 2, ...range(3, 45), 51, 52, 101]]); // 102 and 103 do not fit
  expect(groups[0]!.clusters.flatMap(cluster => cluster.items).includes(50)).toBe(true); // title-only reference
  // No candidates: the marked items alone fill one group (158 review); no marks and no candidates give no group.
  expect(candidateGroups(clustering, new Set()).map(value => value.items)).toEqual([[1, 2, 51, 52, 101, 102, 103]]);
  expect(candidateGroups([group(1, 5)], new Set())).toEqual([]);
});

test("more than fifty candidates form clustering parts, merge in order, then fill orphan marks without opening a group", () => {
  const clustering = [group(1, 50, [41, 42]), group(51, 50, [71]), group(101, 50, [111, 112]), group(151, 50, range(151, 50))];
  const candidates = new Set([...range(1, 40), ...range(51, 20), ...range(101, 10)]);
  const groups = candidateGroups(clustering, candidates);
  expect(groups.map(value => value.items)).toEqual([[...range(1, 40), 41, 42, ...range(151, 8)], [...range(51, 20), 71, ...range(101, 10), 111, 112, ...range(159, 17)]]);
  expect(groups.every(value => value.items.length <= 50)).toBe(true);
  expect(new Set(groups.flatMap(value => value.items)).size).toBe(100); // orphan marks fill every space left
});

test("clustering refuses oversized clusters, malformed marks, pairs and unnecessary groups", () => {
  const items = range(1, 11).map(id => ({ value: { knowledge: { id } } }) as CurateItem);
  const lines = items.map((_, i) => `- K${i + 1}`).join("\n");
  expect(checkGroups(`# Group 1\n## Cluster Rules\n${lines}`, items).problems).toContain("groups.md: group 1 clusters must contain at most 10 items");
  for (const mark of [" ! duplicate:", " ! conflict: why", " ! duplicate K2: same", ", K2 ! duplicate: same"]) {
    expect(checkGroups(`# Group 1\n## Cluster Rules\n- K1${mark}`, items).problems.join("\n")).toContain("optional ! duplicate|contradiction");
  }
  const valid = `# Group 1\n## Cluster Rules\n- K1 ! duplicate: Same claim\n${range(2, 9).map(id => `- K${id}`).join("\n")}\n## Cluster Other\n- K11 ! contradiction: Opposing claim\n`;
  const checked = checkGroups(valid, items);
  expect(checked.problems).toEqual([]);
  expect(checked.groups[0]!.clusters.map(cluster => cluster.marks)).toEqual([{ 1: { kind: "duplicate", reason: "Same claim" } }, { 11: { kind: "contradiction", reason: "Opposing claim" } }]);
  expect(checkGroups(valid.replace("## Cluster Other", "# Group 2\n## Cluster Other"), items).problems).toContain("groups.md: use 1 groups, as few as possible");
});
