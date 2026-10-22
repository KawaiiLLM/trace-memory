import { afterEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import type { DreamingAgentInput, RunAgentResult } from "../../../src/core/api/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture, listedBatches } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const opened: TraceMemory[] = [];
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); });
const exact = { request: { fixture: "partial-batches" } };

// A Dreamer cut off before it wrote its second batch's file (146 ruling 12): the first batch's file passed the check and is kept (as a
// proposal; nothing is applied before verify passes), the claim is released, and the hand-off says where the next run resumes. A cancellation
// closes the fences first and keeps nothing (Q23).
test.each(["failure", "timeout", "cancelled"] as const)("68: a file that passed stays after the conversation ends in %s unless it was cancelled; the claim is released", async outcome => {
  const f = makeDreamerFixture(opened);
  f.memory.config.dreaming.timeoutMs = 200;
  const rule = f.item("Rule one", { category: "constraint" });
  f.item("Ref one", { category: "reference" });
  const added = block(`update ${rule.ref}`, { reason: "tidy" }, "Body of the tidied rule");
  let written = false;
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(exact.request);
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    const [first, second] = listedBatches(report);
    expect([first!.category, second!.category]).toEqual(["constraint", "reference"]);
    writeFileSync(first!.file, added); // the second batch's file is never written
    written = true;
    if (outcome === "timeout") return new Promise<RunAgentResult>(() => {});
    if (outcome === "cancelled") return new Promise<RunAgentResult>(resolve => input.signal!.addEventListener("abort", () => resolve({ outcome, output: "stopped", ...exact }), { once: true }));
    return { outcome, output: "cut", ...exact };
  });
  const before = f.store.listKnowledgeRevisions().length;
  const running = f.dream();
  if (outcome === "cancelled") { while (!written) await new Promise(resolve => setTimeout(resolve, 2)); f.memory.cancelTasks(); }
  const result = await running;
  expect(result.outcome).toBe(outcome === "cancelled" ? "cancelled" : "failure");
  expect(f.store.listKnowledgeRevisions().length).toBe(before); // nothing is applied before verify passes
  const kept = f.store.listRuns(f.session.id).filter(run => JSON.parse(run.response ?? "{}").proposed?.length === 1);
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  if (outcome === "cancelled") {
    expect(kept).toHaveLength(0);
    expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
    return;
  }
  expect(kept).toHaveLength(1); // the first batch's proposal stays
  const batches = f.store.handoff(f.session.id, "dreaming")!.detail!.groups![0]!.batches;
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "curate" });
  expect(batches[0]).toMatchObject({ category: "constraint", run: kept[0]!.id });
  expect(batches[1]).not.toHaveProperty("run");
});
