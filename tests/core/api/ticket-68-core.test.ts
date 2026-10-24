import { afterEach, expect, test } from "vitest";
import { DEFAULT_CONFIG, canonicalFlatConfig, validateConfig, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture } from "../../support/dreamer.ts";

const opened: TraceMemory[] = [];
afterEach(() => { for (const memory of opened.splice(0)) memory.close(); });
/** A due session with one item and a runner that stands in for the host's model. */
function setup(agent: (task: DreamingAgentInput) => Promise<RunAgentResult>, timeoutMs = 600_000) {
  const f = makeDreamerFixture(opened);
  f.memory.config.dreaming.timeoutMs = timeoutMs;
  f.item("A rule", { category: "constraint" });
  f.next(raw => agent(raw as DreamingAgentInput));
  return f;
}
const revisions = (f: ReturnType<typeof setup>) => f.store.listKnowledgeRevisions().length;

test("removed Dreamer round limits and out-of-range native timer values are rejected", () => {
  for (const value of [0, 1]) {
    expect(() => validateConfig({ dreaming: { maxToolRounds: value } } as never)).toThrow(/Removed setting dreaming\.maxToolRounds/);
    expect(() => canonicalFlatConfig({ "dreaming.maxToolRounds": value })).toThrow(/Removed setting dreaming\.maxToolRounds.*timeoutMs/);
  }
  expect(() => validateConfig({ dreaming: { timeoutMs: 2_147_483_648 } })).toThrow(/dreaming.timeoutMs.*at most 2147483647/);
});

test("68 timeout settles failure, releases the exact claim and does not await a non-cooperative worker", async () => {
  const f = setup(() => new Promise<RunAgentResult>(() => {}), 25);
  const before = revisions(f);
  const result = await f.dream();
  expect(result.outcome).toBe("failure");
  if (result.outcome !== "failure") throw new Error("expected failure");
  expect(result.failure).toMatchObject({ task: "notes", class: "timeout" });
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "notes" });
  expect(revisions(f)).toBe(before);
});

test("68 timeout failure wins over a synchronous native cancelled result", async () => {
  const f = setup(task => new Promise<RunAgentResult>(resolve => {
    task.reportRequest({ exact: "request" });
    task.signal!.addEventListener("abort", () => resolve({ outcome: "cancelled", output: "native cancelled", request: { exact: "request" } }), { once: true });
  }), 25);
  expect((await f.dream()).outcome).toBe("failure");
});

test("68 external cancellation remains cancellation when its native worker cooperates before the deadline", async () => {
  const controller = new AbortController();
  const f = setup(task => new Promise<RunAgentResult>(resolve => {
    task.reportRequest({ exact: "request" });
    task.signal!.addEventListener("abort", () => resolve({ outcome: "cancelled", output: "stopped", request: { exact: "request" } }), { once: true });
  }), 25);
  const running = f.memory.dream({ ...f.target, signal: controller.signal });
  controller.abort("stop");
  expect((await running).outcome).toBe("cancelled");
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
});
