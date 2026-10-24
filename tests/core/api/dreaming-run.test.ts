import { afterEach, expect, test } from "vitest";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture, scriptedDreamer } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import type { DreamingAgentInput } from "../../../src/core/dreaming/index.ts";
import { incrementalCandidates } from "../../../src/core/dreaming/candidates.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("a due incremental run covers processed project items and ends the handoff", async () => {
  const f = dreamerFixture(memories), a = f.item("Use pnpm"), b = f.item("Commit lockfiles", { category: "reference" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.noterOperations(f.path)).toBe(0);
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  for (const item of [a,b]) expect(f.store.currentCommit(item.knowledgeId, f.path)[0]).toMatchObject({ text: item === a ? "Use pnpm" : "Commit lockfiles", files: null });
  expect(await f.dream()).toMatchObject({ outcome: "empty" });
});

test("one pass can update archive merge and split but never create", async () => {
  const f = dreamerFixture(memories);
  const [a,b,c,d,e] = Array.from({ length: 5 }, (_, i) => f.item(`Supported rule ${i}`));
  f.dreamer.script.curate!.group1 = [block(`update ${a!.ref}`, { reason: "clarify" }, "Updated supported rule"),
    block(`archive ${b!.ref}`, { kind: "invalid", reason: "expired" }, "This time-limited rule expired according to the recorded facts."),
    block(`merge ${c!.ref}`, { absorb: d!.ref, reason: "duplicates" }, "The common supported rule"),
    block(`split ${e!.ref}`, { supports: `F${e!.supports[0]}`, reason: "independent facets" }, "The primary facet") + `\n### child\ntitle: Other facet\ncategory: reference\nscope: project\ntopics:\nsupports: F${e!.supports[0]}\nfiles: None\nreason: Independent facet\n\nThe other facet\n`].join("\n");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.currentCommit(a!.knowledgeId, f.path)[0]!.text).toBe("Updated supported rule");
  expect(f.store.currentCommit(b!.knowledgeId, f.path)[0]!.op).toBe("archive");
  expect(f.store.liveKnowledge(f.path).some(r => r.knowledgeId === d!.knowledgeId)).toBe(false);
  expect(f.store.liveKnowledge(f.path).some(r => r.text === "The other facet")).toBe(true);
  expect(incrementalCandidates(f.store, f.path, 10)).toMatchObject({ seeds: [], candidates: [] });
});

test("a failure is counted once per execution and the persisted groups retry without reaching the trigger again", async () => {
  const f = dreamerFixture(memories); f.item("Original rule");
  f.dreamer.script.curate!.group1 = "## bogus\n";
  expect(await f.dream()).toMatchObject({ outcome: "failure" });
  expect(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")?.count).toBe(1);
  f.dreamer.script.curate!.group1 = "## none\n";
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")?.count).toBe(0);
});

test("a late Noter version stays pending when its frozen predecessor is processed", async () => {
  const f = dreamerFixture(memories), original = f.item("Original rule"), scripted = scriptedDreamer();
  f.dreamer.script.instead = { curate: async input => {
    f.item("New rule after group admission");
    return scripted.agent(input);
  } };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.noterOperations(f.path)).toBe(1);
  expect(f.store.getKnowledge(original.knowledgeId)?.score).toBe(50);
});

test("a runner ignoring its own deadline fails without publishing the group", async () => {
  const f = dreamerFixture(memories), original = f.item("Original rule");
  f.memory.config.dreaming.timeoutMs = 20;
  f.dreamer.script.instead = { curate: async (_input: DreamingAgentInput) => new Promise(() => {}) };
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { class: "timeout" } });
  expect(f.store.currentCommit(original.knowledgeId, f.path)[0]!.id).toBe(original.commit);
});
