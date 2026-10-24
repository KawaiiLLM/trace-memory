import { afterEach, expect, test } from "vitest";
import { TraceMemory as openMemory, type TraceMemory } from "../../../src/core/api/index.ts";
import { dreamerFixture, scriptedDreamer } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { updateKnowledge } from "../../support/seed.ts";
import { checkScores } from "../../../src/core/dreaming/classify.ts";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

const memories: TraceMemory[] = [], directories: string[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// Ticket 167 supersedes anchor calibration, curate-time scoring and score self-check tests.
test("all curate groups commit before one isolated scoring conversation publishes ratings", async () => {
  const f = dreamerFixture(memories); f.memory.config.dreaming.groupItems = 1;
  const a = f.item("Original first rule"), b = f.item("Second rule");
  f.dreamer.script.curate!.group1 = block(`update ${a.ref}`, { reason: "clarify" }, "Updated first rule");
  f.dreamer.script.scoring = (_batch, labels) => {
    expect(f.store.currentCommit(a.knowledgeId, f.path)[0]!.text).toBe("Updated first rule");
    expect(f.store.handoff(f.session.id, "dreaming")!.detail!.groups!.every(group => group.run)).toBe(true);
    expect(f.store.getKnowledge(a.knowledgeId)!.score).toBeNull();
    const input = f.dreamer.inputs.at(-1)!;
    expect(input.workspace.roots).toEqual([]);
    expect(input.workspace.write.map(file => file.split("/").at(-1))).toEqual(["scores.md"]);
    expect(input.tools.map(tool => tool.name)).toEqual(["check"]);
    expect(input.text).toContain('Curate verdict: {"decision":"update","accuracy":"ok","reason":"Preserve the supported understanding"}');
    expect(new Set(labels)).toEqual(new Set([`K${a.knowledgeId}`, `K${b.knowledgeId}`]));
    return `K${a.knowledgeId} 5 1 1\nK${b.knowledgeId} 4 4 4\n`;
  };
  const result = await f.dream();
  expect(result, JSON.stringify(result)).toMatchObject({ outcome: "success" });
  expect(f.store.getKnowledge(a.knowledgeId)).toMatchObject({ score: 81, ratings: { consequence: 5, frequency: 1, current: 1 } });
  expect(f.store.getKnowledge(b.knowledgeId)).toMatchObject({ score: 51, ratings: { consequence: 4, frequency: 4, current: 4 } });
  expect(f.dreamer.inputs.filter(input => input.task === "scoring")).toHaveLength(1);
});

test("failed scoring keeps committed changes and a reopened executor retries scoring alone", async () => {
  const directory = mkdtempSync("/private/tmp/scoring-resume-"); directories.push(directory);
  const file = join(directory, "memory.sqlite");
  const f = dreamerFixture(memories, {}, file), item = f.item("Original rule");
  f.dreamer.script.curate!.group1 = block(`update ${item.ref}`, { reason: "clarify" }, "Updated rule");
  f.dreamer.script.scoring = () => "K9999 3 3 3\n";
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "scoring" } });
  const current = f.store.currentCommit(item.knowledgeId, f.path)[0]!;
  expect(current.text).toBe("Updated rule");
  expect(f.store.getKnowledge(item.knowledgeId)).toMatchObject({ score: null, ratings: null });
  expect(f.store.handoff(f.session.id, "dreaming")!.nextTask).toBe("scoring");
  f.memory.close();
  const replacement = scriptedDreamer(), next = openMemory(file, replacement.agent, { dreaming: { triggerOperations: 1 } }); memories.push(next);
  expect(await next.dream(f.target)).toMatchObject({ outcome: "success" });
  expect(replacement.inputs.map(input => input.task)).toEqual(["scoring"]);
  expect(next.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(current.id);
  expect(next.store.getKnowledge(item.knowledgeId)).toMatchObject({ score: 51, ratings: { consequence: 4, frequency: 4, current: 4 } });
  expect(next.store.db.prepare("SELECT scored_commit FROM knowledge WHERE id=?").get(item.knowledgeId)!.scored_commit).toBe(current.id);
});

test("a version changed during scoring cannot receive the old version's ratings", async () => {
  const f = dreamerFixture(memories), a = f.item("First rule"), b = f.item("Second rule");
  let concurrent = 0;
  f.dreamer.script.scoring = (_batch, labels) => {
    concurrent = updateKnowledge(f.store, f.path, a.knowledgeId, a.commit, "User changed rule", a.supports).commit;
    return labels.map(label => `${label} 4 4 4`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.currentCommit(a.knowledgeId, f.path)[0]!.id).toBe(concurrent);
  expect(f.store.getKnowledge(a.knowledgeId)).toMatchObject({ score: null, ratings: null });
  expect(f.store.getKnowledge(b.knowledgeId)!.score).toBe(51);
  expect(f.store.db.prepare("SELECT 1 FROM knowledge_processed WHERE revision_id=?").get(concurrent)).toBeUndefined();
});

test("sequential scoring batches retain passed ratings on failure and publish all ratings atomically", async () => {
  const f = dreamerFixture(memories);
  const items = Array.from({ length: 101 }, (_, i) => f.item(`Rule ${i + 1}`));
  let batches = 0;
  f.dreamer.script.scoring = (_batch, labels) => {
    batches++;
    expect(items.every(item => f.store.getKnowledge(item.knowledgeId)!.score === null)).toBe(true);
    return labels.length === 1 ? "invalid" : labels.map(label => `${label} 3 3 3`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "scoring" } });
  expect(batches).toBe(3); // First batch passes; second batch fails and repairs once.
  expect(f.store.handoff(f.session.id, "dreaming")!.detail!.scoringResults).toHaveLength(100);
  const before = f.dreamer.inputs.length;
  f.dreamer.script.scoring = (_batch, labels) => labels.map(label => `${label} 1 1 1`).join("\n");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.slice(before).map(input => input.task)).toEqual(["scoring"]);
  expect(items.map(item => f.store.getKnowledge(item.knowledgeId)!.score)).toEqual([...Array(100).fill(22), 1]);
});

test("rating files reject duplicate, foreign, missing, fractional and out-of-range ratings", () => {
  const target = { label: "K1", title: "Rule", text: "Rule", category: "constraint" as const, scope: "project" as const, knowledgeId: 1, commit: 1 };
  for (const text of ["K1 0 3 3", "K1 3 6 3", "K1 3 3 1.5", "K2 3 3 3", "", "K1 3 3 3\nK1 4 4 4", "K1 81"])
    expect(checkScores(text, [target]).problems.length).toBeGreaterThan(0);
  expect(checkScores("K1 2 4 5", [target])).toEqual({ scores: new Map([["K1", { consequence: 2, frequency: 4, current: 5 }]]), problems: [] });
});
