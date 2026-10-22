import { afterEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import type { DreamingAgentInput, RunAgentResult } from "../../../src/core/api/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const opened: TraceMemory[] = [];
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); });
const exact = { request: { fixture: "partial-batches" } };

// A Dreamer cut off in its second category: the first category's batch was kept (as a proposal; stage 5 applies nothing before verify
// passes), the claim is released, and the hand-off says where the next run resumes.
test.each(["failure", "cancelled", "timeout"] as const)("68: a kept batch stays after the next batch ends in %s, the claim is released and the hand-off resumes there", async outcome => {
  const f = makeDreamerFixture(opened);
  f.memory.config.dreaming.timeoutMs = 200;
  const rule = f.item("Rule one", { category: "constraint" });
  f.item("Ref one", { category: "reference" });
  const added = block(`update ${rule.ref}`, { reason: "tidy" }, "Body of the tidied rule");
  let applied = false;
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(exact.request);
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    // The conversation continues with the next batch after each applied one; here it is cut off at the second.
    writeFileSync(/File: (\S+?\.md)/.exec(report)![1]!, /category constraint/.test(report) ? added : "## none\n");
    expect(input.passEnd()).toContain("Batch 1 of 2 (constraint) kept for verify");
    applied = true;
    if (outcome === "timeout") return new Promise<RunAgentResult>(() => {});
    if (outcome === "cancelled") return new Promise<RunAgentResult>(resolve => input.signal!.addEventListener("abort", () => resolve({ outcome, output: "stopped", ...exact }), { once: true }));
    return { outcome, output: "cut", ...exact };
  });
  const before = f.store.listKnowledgeRevisions().length;
  const running = f.dream();
  if (outcome === "cancelled") { while (!applied) await new Promise(resolve => setTimeout(resolve, 2)); f.memory.cancelTasks(); }
  const result = await running;
  expect(result.outcome).toBe(outcome === "cancelled" ? "cancelled" : "failure");
  expect(f.store.listKnowledgeRevisions().length).toBe(before); // nothing is applied before verify passes
  expect(f.store.listRuns(f.session.id).filter(run => JSON.parse(run.response ?? "{}").proposed?.length === 1)).toHaveLength(1); // the first batch's proposal stays
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "curate", detail: { doneCategories: ["constraint"] } });
});
