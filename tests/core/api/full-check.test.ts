import { afterEach, expect, test } from "vitest";
import { readFileSync } from "node:fs";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture, scriptedDreamer } from "../../support/dreamer.ts";
import { checkGroups, fullCheckDryRun } from "../../../src/core/dreaming/clustering.ts";
import { projectItems } from "../../../src/core/dreaming/candidates.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("clustering rejects missing, duplicate, foreign and oversized membership before curate", async () => {
  const f = dreamerFixture(memories);
  f.item("One supported rule"); f.item("Another supported rule");
  const items = projectItems(f.store, f.path), [a, b] = items.map(item => `K${item.value.knowledge.id}`);
  const file = (members: string) => `# Group 1\n## Cluster Rules\n${members.split(", ").map(id => `- ${id}`).join("\n")}\n`;
  expect(checkGroups(file(`${a}, ${b}`), items).problems).toEqual([]);
  expect(checkGroups(file(`${a}, ${a}, K999`), items).problems.join("\n")).toMatch(/duplicate[\s\S]*unknown[\s\S]*missing/);
  expect(checkGroups(file(`${a}, ${b}`), items, 1).problems.join("\n")).toContain("1–1");
  f.dreamer.script.clustering = file(`${a}, ${a}`);
  expect(await f.memory.dream({ ...f.target, manual: true, fullCheck: true })).toMatchObject({ outcome: "failure", failure: { task: "clustering" } });
  expect(f.dreamer.inputs.some(input => input.task === "curate")).toBe(false);
  expect(f.store.currentKnowledge(f.path).every(item => item.knowledge.score === null)).toBe(true);
});

test("full check persists clusters, resumes only uncommitted groups and rescores already scored keeps without anchors", async () => {
  const f = dreamerFixture(memories); f.memory.config.dreaming.groupItems = 1;
  const a = f.item("First supported rule"), b = f.item("Second supported rule");
  f.store.db.prepare("UPDATE knowledge SET score=90,scored_commit=? WHERE id=?").run(a.commit, a.knowledgeId);
  f.dreamer.script.curate!.group2 = "## bogus\n";
  const scoring: string[] = [];
  f.dreamer.script.instead = { curate: async input => {
    expect(readFileSync(`${input.workspace.dir}/group.md`, "utf8")).toContain("## Cluster Topic");
    return scriptedDreamer({ curate: f.dreamer.script.curate, scoring: (_group, labels, message) => {
      const text = readFileSync(`${input.workspace.dir}/scoring.md`, "utf8");
      if (message.startsWith("Curate passes.")) expect(message.split("<scoring_input>\n")[1]?.split("</scoring_input>")[0]).toBe(text);
      scoring.push(text);
      return labels.map(label => `${label} 61`).join("\n");
    } }).agent(input);
  } };
  expect(fullCheckDryRun(f.store, f.path)).toMatchObject({ count: 2, groups: null, decisions: [], modelCalls: 0 });
  expect(await f.memory.dream({ ...f.target, manual: true, fullCheck: true })).toMatchObject({ outcome: "failure" });
  const saved = f.store.handoff(f.session.id, "dreaming")!.detail!;
  expect(saved.groups!.map(group => !!group.run)).toEqual([true, false]);
  expect(saved.groups![0]!.clusters).toEqual([{ label: "Topic 1.1", items: [a.knowledgeId] }]);
  expect(f.store.getKnowledge(a.knowledgeId)!.score).toBe(61);
  expect(f.store.currentCommit(a.knowledgeId, f.path)[0]!.id).toBe(a.commit);
  expect(f.store.getKnowledge(b.knowledgeId)!.score).toBeNull();
  expect(fullCheckDryRun(f.store, f.path)).toMatchObject({ count: 2, groups: saved.groups, decisions: [{ runId: saved.groups![0]!.run }] });
  f.dreamer.script.curate!.group2 = "## none\n";
  const before = f.dreamer.inputs.length;
  expect(await f.memory.dream({ ...f.target, manual: true, fullCheck: true })).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.slice(before).map(input => input.task)).toEqual(["curate"]);
  expect(f.store.getKnowledge(b.knowledgeId)!.score).toBe(61);
  expect(scoring.every(text => text.includes("None available") && !text.includes(" 90\n"))).toBe(true);
  expect(f.store.currentKnowledge(f.path).map(item => item.revision.files)).toEqual([null, null]);
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
});

test.each([{ mode: "full check", fullCheck: true }, { mode: "incremental Dreamer", fullCheck: false }])("a running $mode excludes the other Dreamer mode through the same claim", async ({ fullCheck }) => {
  const f = dreamerFixture(memories), scripted = scriptedDreamer();
  f.item("Supported rule");
  const held = Promise.withResolvers<void>();
  f.dreamer.script.instead = { notes: async input => { await held.promise; return scripted.agent(input); } };
  const running = f.memory.dream({ ...f.target, manual: true, fullCheck });
  try {
    expect(f.store.getClaim(f.session.id, "dreaming")).not.toBeNull();
    const refused = await f.memory.dream({ ...f.target, manual: true, fullCheck: !fullCheck });
    expect(refused).toMatchObject({ outcome: "dropped", reason: expect.stringMatching(/already running/) });
  } finally { held.resolve(); expect(await running).toMatchObject({ outcome: "success" }); }
});

test("a manual full check replaces paused incremental membership and includes newly visible items", async () => {
  const f = dreamerFixture(memories); f.memory.config.dreaming.groupItems = 1;
  const a = f.item("First rule"), b = f.item("Second rule");
  f.dreamer.script.curate!.group2 = "## bogus\n";
  expect(await f.dream()).toMatchObject({ outcome: "failure" });
  const committed = f.store.handoff(f.session.id, "dreaming")!.detail!.groups![0]!.run!;
  const c = f.item("Rule arriving after the paused incremental run");
  f.dreamer.script.curate!.group2 = "## none\n";
  expect(await f.memory.dream({ ...f.target, manual: true, fullCheck: true })).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.filter(input => input.task === "clustering")).toHaveLength(2);
  expect([a, b, c].map(item => f.store.getKnowledge(item.knowledgeId)!.score)).toEqual([50, 50, 50]);
  expect(f.store.getRun(committed)!.outcome).toBe("success");
  expect(fullCheckDryRun(f.store, f.path).groups!.map(group => group.items)).toEqual([[a.knowledgeId], [b.knowledgeId], [c.knowledgeId]]);
});
