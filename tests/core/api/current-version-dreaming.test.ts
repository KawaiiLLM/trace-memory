// What a Dreamer run does to the current versions of knowledge (ticket 144, stage 4): what a passing curate covers, how a stop,
// a memory-off or an executor exit fences a model that keeps working, and a merge that names its primary.
import { afterEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import type { DreamingTaskInput } from "../../../src/core/api/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture, writeCurateBatch } from "../../support/dreamer.ts";
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
  expect(f.dreamer.inputs[0]!.text).toContain(`[${item.ref}]`);
  expect(covered(f)).toEqual([{ pool: `project:${f.project.id}`, revision_id: item.commit }]);
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: false });
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).toMatchObject({ knowledge: 1, changedKnowledge: 0 });
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).not.toHaveProperty("processedKnowledge");
  expect(f.memory.progress(f.session.id, "main", f.target.headTurnId)).not.toHaveProperty("unprocessedKnowledge");
});

test.each([
  { committed: false, stopping: false, disabled: false }, { committed: true, stopping: false, disabled: false },
  { committed: false, stopping: true, disabled: false }, { committed: true, stopping: true, disabled: false },
  { committed: false, stopping: false, disabled: true }, { committed: true, stopping: false, disabled: true },
])("64c executor cancellation fences the model's files and keeps the claim until the task ends ($committed/$stopping/$disabled)", async ({ committed, stopping, disabled }) => {
  let task!: DreamingTaskInput, release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const f = makeDreamerFixture(memories);
  const item = f.item("project rule", { category: "constraint" }), original = f.store.getKnowledgeRevision(item.knowledgeId, item.commit)!.text;
  f.item("reference", { category: "reference" }); // a second batch, so that the committed case is still inside curate when it is cancelled
  f.next(async raw => {
    task = raw as DreamingTaskInput; task.acknowledgeRequest();
    if (committed) await writeCurateBatch(task, block(`update ${item.ref}`, { reason: "maintain" }, "maintained rule"));
    entered(); await held;
    return { outcome: "cancelled", output: "stopped", request: REQUEST };
  });
  const running = f.memory.dream({ ...f.target, executorSessionId: f.session.id });
  try {
    await ready;
    const claim = f.store.getClaim(f.session.id, "dreaming")!, lateSupport = f.existingFact("Late support").id;
    if (disabled) f.store.setEnrollment(f.session.id, false);
    expect(f.memory.cancelTasks(stopping)).toEqual([expect.objectContaining({ sessionId: f.session.id, phase: "dreaming" })]);
    expect(task.signal!.aborted).toBe(true);
    // 144 Stage 4 section 1.5: the fence closes first and the executor's claims expire at once; no token is kept for a terminal transaction.
    expect(f.store.getClaim(f.session.id, "dreaming")).toEqual({ ...claim, expiresAt: 0 });
    const before = revisions(f);
    // The model keeps working: its late file is never applied.
    writeFileSync(task.workspace.write[committed ? 1 : 0]!, block("create", { title: "Late rule", category: "reference", scope: "project", topics: "",
      supports: `F${lateSupport}`, reason: "late forbidden write" }, "Late rule body"));
    expect(task.passEnd()).toBeUndefined();
    expect(revisions(f)).toBe(before);
    release();
    expect((await running).outcome).toBe("cancelled");
    expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
    expect(covered(f)).toEqual([]); // curate did not pass: nothing is covered, whatever a batch wrote
    expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.text).toBe(committed ? "maintained rule" : original);
    expect(f.memory.taskEligibility("dreaming", f.target).due).toBe(!stopping && !disabled);
    expect(f.store.enabled(f.session.id)).toBe(!disabled);
    expect(f.store.taskFailures(f.session.id).every(failure => failure.count === 0)).toBe(true);
  } finally { release(); await running; }
});

test("64c a merge names its primary: the older identity continues, both parents are the merge's parents, the absorbed item is no longer current", async () => {
  const f = makeDreamerFixture(memories);
  const older = f.item("original earlier conclusion", { category: "constraint" }), newer = f.item("最新主张：条件与例外原样保留。", { category: "constraint", title: "最新主张" });
  const explicit = "Deliberately rewritten merge";
  f.dreamer.script.curate!.constraint = block(`merge ${older.ref}`, { absorb: newer.ref, topics: "merged", reason: "same conclusion" }, explicit);
  expect((await f.dream()).outcome).toBe("success");
  const merged = f.store.currentCommit(older.knowledgeId, f.path)[0]!;
  expect(merged).toMatchObject({ knowledgeId: older.knowledgeId, op: "merge", text: explicit, topics: ["merged"] });
  expect(f.store.commitParents(merged).map(parent => parent.id).sort((a, b) => a - b)).toEqual([older.commit, newer.commit].sort((a, b) => a - b));
  expect(f.store.currentCommit(newer.knowledgeId, f.path)).toEqual([]);
});
