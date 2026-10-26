import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture, scriptedDreamer } from "../../support/dreamer.ts";
import type { DreamingAgentInput } from "../../../src/core/dreaming/index.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("groups commit independently and a retry runs only the uncommitted group with the same prefix", async () => {
  const f = dreamerFixture(memories); f.memory.config.dreaming.groupItems = 1;
  const a = f.item("First supported rule"), b = f.item("Second supported rule");
  f.dreamer.script.curate!.group2 = "## bogus\n";
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { groups: [{ group: 2 }] } });
  const kept = f.store.handoff(f.session.id, "dreaming")!.detail!;
  expect(kept.groups!.map(group => !!group.run)).toEqual([true, false]);
  expect(f.store.noterChangedItems(f.path)).toBe(1);
  const firstInputs = f.dreamer.inputs.filter(input => input.task === "curate");
  expect(firstInputs.map(input => input.text.split("\n\nGroup ")[0])).toEqual([firstInputs[0]!.text.split("\n\nGroup ")[0], firstInputs[0]!.text.split("\n\nGroup ")[0]]);
  f.item("A change arriving after admission");
  f.dreamer.script.curate!.group2 = "## none\n";
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.filter(input => input.task === "notes")).toHaveLength(1);
  const resumed = f.dreamer.inputs.findLast(input => input.task === "curate")!;
  expect(resumed.text).toContain("Group 2.");
  expect(resumed.text.split("\n\nGroup ")[0]).toBe(firstInputs[1]!.text.split("\n\nGroup ")[0]);
  expect(f.store.getKnowledge(a.knowledgeId)?.score).toBe(75);
  expect(f.store.getKnowledge(b.knowledgeId)?.score).toBe(75);
  expect(f.store.noterChangedItems(f.path)).toBe(1);
});

test("at most five groups run at once and every group has its complete item input", async () => {
  const f = dreamerFixture(memories); f.memory.config.dreaming.groupItems = 1;
  const items = Array.from({ length: 7 }, (_, i) => f.item(`Supported rule ${i}`));
  const scripted = scriptedDreamer();
  let active = 0, peak = 0;
  const release = Promise.withResolvers<void>();
  const seen: string[] = [];
  f.dreamer.script.instead = { curate: async (input: DreamingAgentInput) => {
    active++; peak = Math.max(peak, active);
    seen.push(readFileSync(`${input.workspace.dir}/group.md`, "utf8"));
    if (active === 5) release.resolve();
    await release.promise;
    const result = await scripted.agent(input); active--; return result;
  } };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(peak).toBe(5);
  expect(seen).toHaveLength(7);
  for (const item of items) expect(seen.filter(text => text.includes(`# ${item.ref}\n`))).toHaveLength(1);
  expect(f.store.noterChangedItems(f.path)).toBe(0);
});

test("multiple failed groups count once per execution, and a committed sibling cannot reset the failure streak", async () => {
  const f = dreamerFixture(memories); f.memory.config.dreaming.groupItems = 1;
  const a = f.item("First supported rule"), b = f.item("Second supported rule");
  Object.assign(f.dreamer.script.curate!, { group1: "## bogus\n", group2: "## bogus\n" });
  const first = await f.dream();
  expect(first).toMatchObject({ outcome: "failure", failure: { groups: [{ group: 1 }, { group: 2 }] } });
  expect(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")!.count).toBe(1);
  f.dreamer.script.curate!.group1 = "## none\n";
  expect(await f.dream()).toMatchObject({ outcome: "failure" });
  expect(f.store.getKnowledge(a.knowledgeId)!.score).toBe(75); // 169: the successful sibling publishes its own ratings.
  expect(f.store.getKnowledge(b.knowledgeId)!.score).toBeNull();
  expect(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")!.count).toBe(2);
  expect(await f.dream()).toMatchObject({ outcome: "failure", automaticOff: expect.any(String) });
  expect(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")!.count).toBe(3);
  expect(f.store.enabled(f.session.id)).toBe(false);
  expect(f.store.noterChangedItems(f.path)).toBe(1);
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
});
