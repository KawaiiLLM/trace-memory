import { expect, test } from "vitest";
import { candidateGroups, checkGroups, type ClusteredGroup, type Suspicion } from "../../../src/core/dreaming/clustering.ts";
import type { CurateItem } from "../../../src/core/store/index.ts";

const range = (start: number, count: number) => Array.from({ length: count }, (_, i) => start + i);
/** A clustering group of `count` items from `start`, ten per cluster. */
const group = (start: number, count: number): ClusteredGroup => {
  const items = range(start, count);
  return { items, clusters: Array.from({ length: Math.ceil(count / 10) }, (_, i) => ({ label: `Topic ${start + i}`, items: items.slice(i * 10, i * 10 + 10) })) };
};
/** Mark `id` in whichever cluster holds it; a plain mark has no partners. */
const mark = (clustering: ClusteredGroup[], id: number, level: Suspicion["level"], partners: number[] = []) => {
  const cluster = clustering.flatMap(value => value.clusters).find(value => value.items.includes(id))!;
  (cluster.marks ??= {})[id] = { kind: "duplicate", level, partners, reason: "Same claim" };
};
const marked = (levels: Record<number, Suspicion["level"]>, clustering: ClusteredGroup[]) => {
  for (const [id, level] of Object.entries(levels)) mark(clustering, Number(id), level);
  return clustering;
};

test("181: groups come from the candidates alone; marks never create or split a group, and candidates over fifty split by clustering group", () => {
  const candidates = new Set([...range(1, 40), ...range(51, 20), ...range(101, 10)]);
  const plain = [group(1, 50), group(51, 50), group(101, 50)];
  const expected = [[...range(1, 40)], [...range(51, 20), ...range(101, 10)]]; // 40 | 20 does not fit | 20 + 10 merge
  expect(candidateGroups(plain, candidates).map(value => value.items)).toEqual(expected);
  // Marks that cannot fit change nothing: the groups are full or the marked item is a candidate already.
  const withMarks = marked({ 41: "high", 71: "high", 111: "high", 120: "medium" }, [group(1, 50), group(51, 50), group(101, 50)]);
  const filled = candidateGroups(withMarks, candidates);
  expect(filled.map(value => value.items.filter(id => candidates.has(id)))).toEqual(expected);
  expect(filled.every(value => value.items.length <= 50)).toBe(true);
  // No candidates: no group, whatever is marked.
  expect(candidateGroups(marked({ 1: "high", 51: "high" }, [group(1, 50), group(51, 50)]), new Set())).toEqual([]);
  // With every item a candidate (a full check) marks add nothing.
  expect(candidateGroups(marked({ 1: "high" }, [group(1, 5)]), new Set(range(1, 5))).map(value => value.items)).toEqual([range(1, 5)]);
});

test("181: spare capacity takes marked items by level, then the group's small cluster, then its clustering group, then clustering order", () => {
  const build = (levels: Record<number, Suspicion["level"]>) =>
    candidateGroups(marked(levels, [group(1, 30), group(31, 20)]), new Set([1, 2, 3, 4]), 6).map(value => value.items);
  // Level beats locality: a high mark elsewhere (35) outranks medium marks in the candidates' own cluster (5).
  expect(build({ 35: "high", 5: "medium", 15: "medium", 6: "low" })).toEqual([[1, 2, 3, 4, 5, 35]]);
  // Within a level: same small cluster (5), same clustering group (15 before 25 in clustering order), elsewhere (36).
  expect(build({ 36: "medium", 25: "medium", 15: "medium", 5: "medium" })).toEqual([[1, 2, 3, 4, 5, 15]]);
  expect(build({ 36: "low", 25: "low", 35: "low" })).toEqual([[1, 2, 3, 4, 25, 35]]);
});

test("181: a marked item joins with its partners that are in no group, or not at all; a later smaller unit still fills", () => {
  const candidates = new Set([1, 2, 3]);
  const clustering = [group(1, 50)];
  mark(clustering, 20, "high", [21, 22, 23, 24]); // a unit of five does not fit three spare places
  mark(clustering, 30, "medium", [31, 32]); // a unit of three fits
  mark(clustering, 40, "low", [1]); // its partner is a candidate in a group already: it joins alone, but no place is left
  expect(candidateGroups(clustering, candidates, 6).map(value => value.items)).toEqual([[1, 2, 3, 30, 31, 32]]);
  const roomy = [group(1, 50)];
  mark(roomy, 30, "medium", [31]);
  mark(roomy, 40, "low", [1]);
  expect(candidateGroups(roomy, candidates, 6).map(value => value.items)).toEqual([[1, 2, 3, 30, 31, 40]]);
  // A partner that is itself marked brings its own partners: the unit is the closure, and it fits whole or not at all (K2 -> K3 -> K4).
  const chained = () => { const value = [group(1, 50)]; mark(value, 2, "high", [3]); mark(value, 3, "low", [4]); return value; };
  expect(candidateGroups(chained(), new Set([1]), 4).map(value => value.items)).toEqual([[1, 2, 3, 4]]);
  // Two spare places do not take the closure {2,3,4}, so K2 does not join half-complete; K3 and its own partner K4 still fit as a unit of their own.
  expect(candidateGroups(chained(), new Set([1]), 3).map(value => value.items)).toEqual([[1, 3, 4]]);
  // Partners that point at each other join once.
  const mutual = [group(1, 50)];
  mark(mutual, 2, "high", [3]);
  mark(mutual, 3, "high", [2]);
  expect(candidateGroups(mutual, new Set([1]), 3).map(value => value.items)).toEqual([[1, 2, 3]]);
  expect(candidateGroups(mutual, new Set([1]), 2).map(value => value.items)).toEqual([[1]]); // the pair does not fit one place: neither joins
});

test("181: an item joins at most one group, and groups fill in group order", () => {
  const clustering = [group(1, 50), group(51, 50)];
  marked({ 3: "high", 10: "medium", 60: "medium", 90: "low" }, clustering);
  // Size 3: the candidates {1,2} and {51,52} do not share a group, each leaves one place.
  const groups = candidateGroups(clustering, new Set([1, 2, 51, 52]), 3).map(value => value.items);
  expect(groups).toEqual([[1, 2, 3], [51, 52, 60]]); // 3 (high, group 1's own cluster) takes group 1's place; 60 is nearest to group 2
  expect(new Set(groups.flat()).size).toBe(6);
});

test("clustering refuses oversized clusters, malformed marks, pairs and unnecessary groups", () => {
  const items = range(1, 11).map(id => ({ value: { knowledge: { id } } }) as CurateItem);
  const lines = items.map((_, i) => `- K${i + 1}`).join("\n");
  expect(checkGroups(`# Group 1\n## Cluster Rules\n${lines}`, items).problems).toContain("groups.md: group 1 clusters must contain at most 10 items");
  // 181: a mark names its level and partners; the old `! duplicate: reason`, a missing or unknown level or kind, and no partner are refused.
  for (const mark of [" ! duplicate:", " ! duplicate: same", " ! duplicate K2: same", " ! duplicate urgent K2: same", " ! duplicate high: same", " ! conflict high K2: why",
    " ! duplicate high K2, K3: same", " ! duplicate high K2 K3: same", ", K2 ! duplicate high K2: same", " ! duplicate high K2:"]) {
    expect(checkGroups(`# Group 1\n## Cluster Rules\n- K1${mark}`, items).problems.join("\n"), mark).toContain("optional ! duplicate|contradiction high|medium|low");
  }
  expect(checkGroups("# Group 1\n## Cluster Rules\n- K1 ! duplicate high K2,K99: same", items).problems.join("\n")).toContain("groups.md:3: unknown partner K99");
  // A partner may come later in the file.
  const valid = `# Group 1\n## Cluster Rules\n- K1 ! duplicate high K11,K2: Same claim\n${range(2, 9).map(id => `- K${id}`).join("\n")}\n## Cluster Other\n- K11 ! contradiction low K1: Opposing claim\n`;
  const checked = checkGroups(valid, items);
  expect(checked.problems).toEqual([]);
  expect(checked.groups[0]!.clusters.map(cluster => cluster.marks)).toEqual([
    { 1: { kind: "duplicate", level: "high", partners: [11, 2], reason: "Same claim" } },
    { 11: { kind: "contradiction", level: "low", partners: [1], reason: "Opposing claim" } }]);
  expect(checkGroups(valid.replace("## Cluster Other", "# Group 2\n## Cluster Other"), items).problems).toContain("groups.md: use 1 groups, as few as possible");
});
