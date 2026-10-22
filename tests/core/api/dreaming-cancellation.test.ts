// Ticket 146 §3.3: a Dreaming execution has several calls in flight (one per group), and an execution-level cancellation must end every one
// of them even when a runner ignores abort. The fence is closed first, so a late write of an ignored runner changes nothing.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DreamingAgentInput, RunAgentResult } from "../../../src/core/api/index.ts";
import { sourceSeededMemory, type TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture, listedBatches, noterWrittenItem, scriptedDreamer, type DreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";
import { REQUEST } from "../../support/noter.ts";

const memories: TraceMemory[] = [];
const dirs: string[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** Two groups (60 constraint, 50 reference) and a Noter-written trigger item. */
function setup(dbPath?: string) {
  const f = makeDreamerFixture(memories, {}, dbPath);
  const rules = Array.from({ length: 60 }, (_, i) => f.item(`rule ${i}`, { category: "constraint", title: `r ${i}` }));
  Array.from({ length: 50 }, (_, i) => f.item(`reference ${i}`, { category: "reference", title: `f ${i}` }));
  noterWrittenItem(f.memory, f.path as never, f.existingFact("trigger").id);
  return { f, rules };
}
const execution = (f: DreamerFixture) => f.store.db.prepare("SELECT outcome, reason FROM task_executions ORDER BY rowid").all() as { outcome: string | null; reason: string | null }[];
const count = (f: DreamerFixture) => Number(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")?.count ?? 0);
const revisions = (f: DreamerFixture) => Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions").get()!.n);
const deadline = (ms: number) => new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`did not end within ${ms} ms`)), ms));

/** Three conversations, held in flight: the first never answers and ignores abort (it writes a late update when released), the others wait for abort. */
function hung(f: DreamerFixture, rule: { ref: string }) {
  let started = 0, release!: () => void;
  const late = new Promise<void>(resolve => { release = resolve; });
  const lateRan = { value: false, message: "" as string | undefined };
  const body = (first: boolean) => async (raw: unknown): Promise<RunAgentResult> => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(REQUEST);
    input.reportProgress?.({ usage: { input: 3 } } as never);
    started++;
    if (!first) return new Promise<RunAgentResult>(resolve => input.signal!.addEventListener("abort", () => resolve({ outcome: "cancelled", output: "stopped", request: REQUEST }), { once: true }));
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    await late;
    writeFileSync(listedBatches(report)[0]!.file, block(`update ${rule.ref}`, { reason: "late" }, "Late text"));
    lateRan.value = true; lateRan.message = input.passEnd();
    return { outcome: "success", output: "late", request: REQUEST };
  };
  f.next(body(true)); f.next(body(false));
  return { started: () => started, release: () => release(), lateRan };
}

test("an ordinary stop ends every group's wait although one runner ignores abort: cancelled, not counted, claim released, the same executor runs the next execution", async () => {
  const { f, rules } = setup();
  const h = hung(f, rules[0]!);
  const before = revisions(f);
  const running = f.dream();
  while (h.started() < 2) await new Promise(resolve => setTimeout(resolve, 2));
  f.memory.cancelTasks(); // what /trace stop calls: it does not stop the executor
  expect(await Promise.race([running, deadline(2000)])).toMatchObject({ outcome: "cancelled" });
  expect(execution(f)).toEqual([{ outcome: "cancelled", reason: expect.any(String) }]);
  expect(count(f)).toBe(0);
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  h.release(); await new Promise(resolve => setTimeout(resolve, 20));
  expect(h.lateRan).toEqual({ value: true, message: undefined }); // the fence was closed: the stop hook has nothing to say
  expect(revisions(f)).toBe(before);
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  expect(await f.dream()).toMatchObject({ outcome: "success" }); // the same executor admits and runs again
});

test("the admitting call's own signal cancels the execution the same way", async () => {
  const { f, rules } = setup();
  const h = hung(f, rules[0]!);
  const controller = new AbortController();
  const running = f.memory.dream({ ...f.target, signal: controller.signal });
  while (h.started() < 2) await new Promise(resolve => setTimeout(resolve, 2));
  controller.abort();
  expect(await Promise.race([running, deadline(2000)])).toMatchObject({ outcome: "cancelled" });
  expect(count(f)).toBe(0);
  h.release();
  expect(await f.dream()).toMatchObject({ outcome: "success" });
});

test("a shutdown forces every wait, the late runner changes nothing, and a new executor on the same database resumes from what was committed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-146-shutdown-")); dirs.push(dir);
  const file = join(dir, "memory.sqlite");
  const { f, rules } = setup(file);
  const h = hung(f, rules[0]!);
  const before = revisions(f);
  const running = f.dream();
  while (h.started() < 2) await new Promise(resolve => setTimeout(resolve, 2));
  f.memory.close(); memories.pop();
  await Promise.race([running, deadline(2000)]); // execute ends although the first runner never answers
  h.release(); await new Promise(resolve => setTimeout(resolve, 20));
  const dreamer = scriptedDreamer();
  const memory = sourceSeededMemory(file, dreamer.agent); memories.push(memory);
  memory.config.dreaming.triggerOperations = 1;
  const rows = memory.store.db.prepare("SELECT outcome FROM task_executions").all();
  expect(rows).toEqual([{ outcome: null }]); // the execution was never settled: no verdict, no count
  expect(memory.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions").get()).toEqual({ n: before });
  expect(await memory.dream({ ...f.target })).toMatchObject({ outcome: "success" });
});

test("a call that has a deadline reports its own usage: a group's deadline result carries that group's progress, not another group's", async () => {
  const { f } = setup();
  f.memory.config.dreaming.timeoutMs = 150;
  const calls: number[] = [];
  const stuck = (usage: number) => async (raw: unknown) => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(REQUEST);
    input.reportProgress?.({ usage: { input: usage } } as never);
    calls.push(usage);
    return new Promise<RunAgentResult>(() => {});
  };
  f.next(stuck(7)); f.next(stuck(9));
  await f.dream();
  const inputs = f.store.db.prepare("SELECT b.response AS response FROM runs r JOIN run_bodies b ON b.run_id = r.id WHERE r.kind = 'dreaming'").all()
    .map(row => JSON.parse(String(row.response)));
  expect(calls.sort()).toEqual([7, 9]);
  expect(inputs.map(response => response.usage?.input).sort()).toEqual([7, 9]); // each failed run keeps its own call's usage
});
