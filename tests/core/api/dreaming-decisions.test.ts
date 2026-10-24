import { afterEach, expect, test } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture, writeDecisions } from "../../support/dreamer.ts";
import { REQUEST } from "../../support/noter.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("a keep may publish an immutable metadata version; missing grounds flag it instead of reverting it", async () => {
  const f = dreamerFixture(memories), item = f.item("The supported body remains unchanged", { title: "Old label" });
  f.dreamer.script.instead = { curate: async input => {
    input.reportRequest(REQUEST);
    await input.tools.find(tool => tool.name === "check")!.execute({});
    writeDecisions(input.workspace.dir);
    const decisions = join(input.workspace.dir, "decisions.md");
    writeFileSync(decisions, readFileSync(decisions, "utf8").replace("title: Old label", "title: Precise label").replace("grounds: Recorded facts", "grounds: missing original grounds"));
    writeFileSync(join(input.workspace.dir, "changes.md"), "## none\n");
    const scoring = input.passEnd();
    expect(scoring).toBeDefined();
    writeFileSync(join(input.workspace.dir, "scores.md"), `K${item.knowledgeId} 76\n`);
    expect(input.passEnd()).toBeDefined();
    expect(input.passEnd()).toBeUndefined();
    return { outcome: "success", output: "Done", request: REQUEST };
  } };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const current = f.store.currentCommit(item.knowledgeId, f.path)[0]!;
  expect(current.id).not.toBe(item.commit);
  expect(current).toMatchObject({ title: "Precise label", text: "The supported body remains unchanged", supports: item.supports, files: null });
  expect(f.store.getKnowledgeRevision(item.knowledgeId, item.commit)!.title).toBe("Old label");
  expect(f.store.knowledgeStaleReasons(current.id)).toEqual([{ reason: "missing_grounds", detail: "Preserve the supported understanding" }]);
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBe(76);
});

test("oversized repository notes cannot publish a group; retry can replace the notes and finish the saved group", async () => {
  const f = dreamerFixture(memories), item = f.item("Retain this rule");
  f.memory.config.dreaming.notesTokens = 100;
  f.dreamer.script.notes = "Repository-specific detail. ".repeat(500);
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "notes" } });
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBeNull();
  expect(f.store.db.prepare("SELECT * FROM knowledge_processed").all()).toEqual([]);
  f.dreamer.script.notes = "No additional repository notes.";
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.store.noterOperations(f.path)).toBe(0);
  expect(f.store.getKnowledge(item.knowledgeId)!.score).toBe(50);
});
