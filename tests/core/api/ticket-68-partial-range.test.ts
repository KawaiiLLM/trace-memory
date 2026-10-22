import { afterEach, expect, test } from "vitest";
import { writeFileSync } from "node:fs";
import type { DreamingAgentInput, RunAgentResult } from "../../../src/core/api/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture } from "../../support/dreamer.ts";
import { block } from "../../support/workspace.ts";

const opened: TraceMemory[] = [];
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); });
const exact = { request: { fixture: "partial-batches" } };

// A Dreamer cut off in its second category: the first category's batch was applied at once and stays, the claim is released, and
// the hand-off says where the next run resumes (Stage 4: batches commit one by one; there is no frozen range to keep).
test.each(["failure", "cancelled", "timeout"] as const)("68: an applied batch stays after the next batch ends in %s, the claim is released and the hand-off resumes there", async outcome => {
  const f = makeDreamerFixture(opened);
  f.memory.config.dreaming.timeoutMs = 200;
  f.item("Rule one", { category: "constraint" });
  f.item("Ref one", { category: "reference" });
  const added = block("create", { title: "Added rule", category: "constraint", scope: "project", topics: "", supports: `F${f.existingFact("Support").id}`, reason: "new" }, "Body of added rule");
  let applied = false;
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(exact.request);
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    // The conversation continues with the next batch after each applied one; here it is cut off at the second.
    writeFileSync(/File: (\S+?\.md)/.exec(report)![1]!, /category constraint/.test(report) ? added : "## none\n");
    expect(input.passEnd()).toContain("Applied batch 1 of 2");
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
  expect(f.store.listKnowledgeRevisions().length).toBe(before + 1); // the first batch's create stays
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "curate", detail: { doneCategories: ["constraint"] } });
});
