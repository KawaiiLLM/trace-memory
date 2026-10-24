import { afterEach, expect, test } from "vitest";
import { classifyAnchors } from "../../../src/core/dreaming/classify.ts";
import type { CurateItem } from "../../../src/core/store/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { updateKnowledge } from "../../support/seed.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("scoring continues curate and publishes the changed version only after scores pass", async () => {
  const f = dreamerFixture(memories), item = f.item("Keep the supported rule");
  f.dreamer.script.curate!.group1 = block(`update ${item.ref}`, { reason: "clarify" }, "Keep the supported rule with its condition");
  let beforeScore: number | undefined;
  f.dreamer.script.scoring = (_group, labels) => {
    beforeScore = f.store.currentCommit(item.knowledgeId, f.path)[0]!.id;
    return labels.map(label => `${label} 81`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(beforeScore).toBe(item.commit);
  expect(f.dreamer.inputs.map(input => input.task)).toEqual(["notes", "curate"]);
  const current = f.store.currentCommit(item.knowledgeId, f.path)[0]!;
  expect(current.text).toBe("Keep the supported rule with its condition");
  expect(f.store.getKnowledge(item.knowledgeId)).toMatchObject({ score: 81 });
  expect(f.store.db.prepare("SELECT scored_commit FROM knowledge WHERE id=?").get(item.knowledgeId)?.scored_commit).toBe(current.id);
});

test("a scoring failure publishes no group changes and resumes the whole uncommitted group", async () => {
  const f = dreamerFixture(memories), item = f.item("Original rule");
  f.dreamer.script.curate!.group1 = block(`update ${item.ref}`, { reason: "clarify" }, "Updated rule");
  f.dreamer.script.scoring = () => "K9999 50\n";
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "scoring" } });
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
  expect(f.store.knowledgeStaleReasons(item.commit)).toEqual([]);
  f.dreamer.script.scoring = undefined;
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.map(input => input.task)).toEqual(["notes", "curate", "curate"]);
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.text).toBe("Updated rule");
});

test("incremental scoring uses 30 stratified old anchors even when the target pool is small", () => {
  const items = Array.from({ length: 60 }, (_, at) => ({ score: at + 1, scoredCommit: at + 1,
    value: { knowledge: { id: at + 1 }, revision: { id: at + 1, knowledgeId: at + 1 } } }) as CurateItem);
  const anchors = classifyAnchors(items, new Set([1]));
  expect(anchors).toHaveLength(30);
  expect(anchors[0]!.score).toBe(2);
  expect(anchors.at(-1)!.score).toBe(60);
  expect(classifyAnchors(items.slice(0, 4))).toEqual(items.slice(0, 4));
});

test("stale operations remain pending while independent group operations publish atomically with their scores", async () => {
  const f = dreamerFixture(memories), a = f.item("Old first rule"), b = f.item("Old second rule");
  f.dreamer.script.curate!.group1 = block(`update ${a.ref}`, { reason: "clarify" }, "Dreamer first rule") + block(`update ${b.ref}`, { reason: "clarify" }, "Dreamer second rule");
  let concurrent = 0;
  f.dreamer.script.scoring = (_group, labels) => {
    if (!concurrent) concurrent = updateKnowledge(f.store, f.path, a.knowledgeId, a.commit, "User first rule", a.supports).commit;
    return labels.map(label => `${label} 74`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.currentCommit(a.knowledgeId, f.path)[0]).toMatchObject({ id: concurrent, text: "User first rule" });
  expect(f.store.currentCommit(b.knowledgeId, f.path)[0]!.text).toBe("Dreamer second rule");
  const covered = f.store.db.prepare("SELECT revision_id FROM knowledge_processed").all().map(row => Number(row.revision_id));
  expect(covered).not.toContain(a.commit); expect(covered).not.toContain(concurrent);
  expect(f.store.noterOperations(f.path)).toBe(1);
  expect(f.store.getKnowledge(b.knowledgeId)!.score).toBe(74);
});

test("a stale flag arriving during scoring is not cleared as if curate had reviewed it", async () => {
  const f = dreamerFixture(memories), item = f.item("Supported ruling");
  const reviewed = { reason: "unresolved_check" as const, detail: "Original concern" };
  const late = { reason: "negated_fact" as const, detail: "A newer fact arrived during scoring" };
  f.store.setKnowledgeStale(item.commit, reviewed);
  f.dreamer.script.scoring = (_group, labels) => {
    f.store.setKnowledgeStale(item.commit, late);
    return labels.map(label => `${label} 74`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.knowledgeStaleReasons(item.commit)).toEqual([late]);
});

test("unchanged scored candidates remain usable old anchors in a small incremental pool", async () => {
  const f = dreamerFixture(memories), a = f.item("First supported rule"), b = f.item("Second supported rule");
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  for (const item of [a, b]) f.store.setKnowledgeStale(item.commit, { reason: "unresolved_check", detail: "Review without changing the supported body" });
  const changed = f.item("New supported rule");
  let anchors: number[] = [], targets: string[] = [];
  f.dreamer.script.scoring = (_group, labels) => {
    const text = readFileSync(join(f.dreamer.inputs.at(-1)!.workspace.dir, "scoring.md"), "utf8");
    anchors = [...text.matchAll(/^K(\d+) \d+$/gm)].map(match => Number(match[1]));
    targets = labels;
    return labels.map(label => `${label} 75`).join("\n");
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(anchors).toEqual([a.knowledgeId, b.knowledgeId]);
  expect(targets).toEqual([`K${changed.knowledgeId}`]);
  expect(f.store.getKnowledge(changed.knowledgeId)!.score).toBe(75);
});

test("the scoring stop requests self-check before publication and commits the reviewed scores", async () => {
  const f = dreamerFixture(memories), item = f.item("Original supported rule");
  f.dreamer.script.curate!.group1 = block(`update ${item.ref}`, { reason: "clarify" }, "Reviewed supported rule");
  f.dreamer.script.scoring = (_group, labels) => {
    expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
    return [labels.map(label => `${label} 65`).join("\n"), labels.map(label => `${label} 82`).join("\n")];
  };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.text).toBe("Reviewed supported rule");
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBe(82);
});
