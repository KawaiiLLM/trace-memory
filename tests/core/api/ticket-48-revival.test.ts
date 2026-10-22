import { afterEach, expect, test } from "vitest";
import type { TraceMemory } from "../../source-fixture.ts";
import { archive } from "../../support/seed.ts";
import { dreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

test("48/92: the trusted facade revives an archived identity from exact version bases", async () => {
  const f = dreamerFixture(memories);
  const old = f.item("Original widget state", { title: "Widget state" });
  const archiveCommit = archive(f.store, f.path, old.knowledgeId, old.commit, old.supports, "invalid", "Widget retired: the user said it was removed and nothing replaces it");
  expect(f.store.versionOrdinal(old.knowledgeId, archiveCommit)).toBe(2);
  const returned = f.item("Returned widget state", { title: "Widget state" });
  f.dreamer.script.curate!.constraint = block(`merge K${old.knowledgeId}@v2`, { absorb: returned.ref, topics: "widget", reason: "Revive the returning widget identity" }, "Returned widget state");

  const result = await f.dream();
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  const current = f.store.currentKnowledge(f.path);
  expect(current).toHaveLength(1);
  expect(current[0]!.knowledge.id).toBe(old.knowledgeId);
  expect(current[0]!.revision.parentId).toBe(archiveCommit);
  expect(f.store.listKnowledgeLinks(returned.knowledgeId)).toContainEqual(expect.objectContaining({ kind: "merged_into", toKnowledge: old.knowledgeId }));
  expect(f.memory.inject(f.path)).toContain("Returned widget state");
});
