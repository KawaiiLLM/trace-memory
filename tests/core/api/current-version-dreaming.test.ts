// What a Dreamer run does to the current versions of knowledge (ticket 144, stage 4): what a passing curate covers, how a stop,
// a memory-off or an executor exit fences a model that keeps working, and a merge that names its primary.
import { afterEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import type { DreamingAgentInput } from "../../../src/core/dreaming/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture, writeCurateFiles } from "../../support/dreamer.ts";
import { REQUEST } from "../../support/noter.ts";
import { block } from "../../support/workspace.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
type Fixture = ReturnType<typeof makeDreamerFixture>;
const covered = (f: Fixture) => f.store.db.prepare("SELECT pool, revision_id FROM knowledge_processed ORDER BY revision_id").all();
const revisions = (f: Fixture) => Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions").get()!.n);

test("64c a due run covers the exact current versions it showed; afterwards nothing is due", async () => {
  const f = makeDreamerFixture(memories);
  const item = f.item("project rule", { category: "constraint" });
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: true });
  expect((await f.dream()).outcome).toBe("success");
  expect(covered(f)).toEqual([{ pool: `project:${f.project.id}`, revision_id: item.commit }]);
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: false });
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).toMatchObject({ knowledge: 1, changedKnowledge: 0 });
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).not.toHaveProperty("processedKnowledge");
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).not.toHaveProperty("unprocessedKnowledge");
});


test("64c a merge names its primary: the older identity continues, both parents are the merge's parents, the absorbed item is no longer current", async () => {
  const f = makeDreamerFixture(memories);
  const older = f.item("original earlier conclusion", { category: "constraint" }), newer = f.item("最新主张：条件与例外原样保留。", { category: "constraint", title: "最新主张" });
  const explicit = "Deliberately rewritten merge";
  f.dreamer.script.curate!.constraint = block(`merge ${older.ref}`, { absorb: newer.ref, topics: "merged", reason: "same conclusion" }, explicit);
  expect((await f.dream()).outcome).toBe("success");
  const merged = f.store.currentCommit(older.knowledgeId, f.path)[0]!;
  expect(merged).toMatchObject({ files: null, knowledgeId: older.knowledgeId, op: "merge", text: explicit, topics: ["merged"] });
  expect(f.store.commitParents(merged).map(parent => parent.id).sort((a, b) => a - b)).toEqual([older.commit, newer.commit].sort((a, b) => a - b));
  expect(f.store.currentCommit(newer.knowledgeId, f.path)).toEqual([]);
});
