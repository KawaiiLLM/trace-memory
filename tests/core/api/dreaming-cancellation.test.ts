import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TraceMemory as openMemory, type TraceMemory } from "../../../src/core/api/index.ts";
import { dreamerFixture, scriptedDreamer, writeCurateFiles } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { REQUEST } from "../../support/noter.ts";

const memories: TraceMemory[] = [], directories: string[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

for (const source of ["stop", "signal", "off"] as const) test(`${source} closes every group fence and refuses late publication without counting a failure`, async () => {
  const f = dreamerFixture(memories); f.memory.config.dreaming.groupItems = 1;
  const items = [f.item("Rule one"), f.item("Rule two")];
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), finished = Promise.withResolvers<void>();
  let started = 0, late = 0;
  f.dreamer.script.instead = { curate: async input => {
    input.reportRequest(REQUEST);
    if (++started === 2) ready.resolve();
    await release.promise;
    writeFileSync(`${input.workspace.dir}/changes.md`, "## none\n");
    expect(input.passEnd()).toBeUndefined();
    if (++late === 2) finished.resolve();
    return { outcome: "success", request: REQUEST, output: "late" };
  } };
  const controller = new AbortController();
  const running = f.memory.dream({ ...f.target, signal: controller.signal });
  await ready.promise;
  if (source === "signal") controller.abort();
  else if (source === "off") { f.store.setEnrollment(f.session.id, false); f.memory.cancelTasks(); }
  else f.memory.cancelTasks();
  expect(await running).toMatchObject({ outcome: "cancelled" });
  release.resolve(); await finished.promise;
  for (const item of items) expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  expect(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")?.count ?? 0).toBe(0);
  expect(f.store.handoff(f.session.id, "dreaming")!.detail!.groups!.every(group => group.run === undefined)).toBe(true);
});

test("a lost-claim executor cannot overwrite a later executor's completed group, handoff or failure streak", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trace-dreamer-takeover-")); directories.push(directory);
  const file = join(directory, "memory.sqlite"), f = dreamerFixture(memories, {}, file), item = f.item("Original supported rule");
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  f.dreamer.script.instead = { curate: async input => {
    input.reportRequest(REQUEST);
    expect(await writeCurateFiles(input, block(`update ${item.ref}`, { reason: "first executor" }, "First executor proposal"))).toContain("<scoring_input>");
    writeFileSync(join(input.workspace.dir, "scores.md"), `K${item.knowledgeId} 4 4 4\n`);
    expect(input.passEnd()).toBeUndefined();
    ready.resolve(); await release.promise;
    writeFileSync(join(input.workspace.dir, "changes.md"), "## none\n");
    expect(input.passEnd()).toBeUndefined();
    return { outcome: "success", output: "Late completion", request: REQUEST };
  } };
  const old = f.dream(); await ready.promise;
  expect(f.store.releaseClaim(f.store.getClaim(f.session.id, "dreaming")!)).toBe(true);
  const replacement = scriptedDreamer({ curate: { group1: block(`update ${item.ref}`, { reason: "replacement executor" }, "Replacement executor rule") } });
  const next = openMemory(file, replacement.agent, { dreaming: { triggerOperations: 1 } }); memories.push(next);
  expect(await next.dream(f.target)).toMatchObject({ outcome: "success" });
  const revision = next.store.currentCommit(item.knowledgeId, f.path)[0]!;
  const streak = next.store.taskFailures(f.session.id);
  const coverage = next.store.db.prepare("SELECT * FROM knowledge_processed ORDER BY revision_id").all();
  release.resolve();
  expect(await old).toMatchObject({ outcome: "failure" });
  expect(next.store.currentCommit(item.knowledgeId, f.path)[0]).toEqual(revision);
  expect(revision.text).toBe("Replacement executor rule");
  expect(next.store.handoff(f.session.id, "dreaming")).toBeNull();
  expect(next.store.taskFailures(f.session.id)).toEqual(streak);
  expect(next.store.db.prepare("SELECT * FROM knowledge_processed ORDER BY revision_id").all()).toEqual(coverage);
  expect(next.store.enabled(f.session.id)).toBe(true);
});

test("shutdown preserves a committed group and a reopened executor resumes only its uncommitted sibling", async () => {
  const directory = mkdtempSync(join(tmpdir(), "trace-dreamer-reopen-")); directories.push(directory);
  const file = join(directory, "memory.sqlite"), f = dreamerFixture(memories, {}, file);
  f.memory.config.dreaming.groupItems = 1; f.memory.config.dreaming.parallelGroups = 1;
  const a = f.item("First supported rule"), b = f.item("Second supported rule");
  const ready = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), late = Promise.withResolvers<void>(), normal = scriptedDreamer();
  let group = 0;
  f.dreamer.script.instead = { curate: async input => {
    if (++group === 1) return normal.agent(input);
    input.reportRequest(REQUEST); ready.resolve(); await release.promise;
    expect(input.passEnd()).toBeUndefined(); late.resolve();
    return { outcome: "success", output: "Late completion", request: REQUEST };
  } };
  const running = f.dream(); await ready.promise;
  expect(f.store.getKnowledge(a.knowledgeId)!.score).toBe(75);
  f.memory.close(); await running;
  const replacement = scriptedDreamer(), next = openMemory(file, replacement.agent, { dreaming: { triggerOperations: 1 } }); memories.push(next);
  expect(next.store.handoff(f.session.id, "dreaming")!.detail!.groups!.map(group => !!group.run)).toEqual([true, false]);
  expect(await next.dream(f.target)).toMatchObject({ outcome: "success" });
  expect(replacement.inputs.map(input => input.task)).toEqual(["curate"]);
  expect(next.store.getKnowledge(b.knowledgeId)!.score).toBe(75);
  expect(next.store.noterOperations(f.path)).toBe(0);
  release.resolve(); await late.promise;
  expect(next.store.handoff(f.session.id, "dreaming")).toBeNull();
  expect(next.store.taskFailures(f.session.id).every(row => row.count === 0)).toBe(true);
});
