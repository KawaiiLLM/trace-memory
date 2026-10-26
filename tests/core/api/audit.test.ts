// Maintainability audit finding 1: one rule finalizes the run audit of both phases. They ran separate
// finalizers and had drifted — a host that reported its request and then failed with `request: null`
// kept the reported request in Consolidation and had it overwritten with `null` in Noting.
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, type NotingAgentInput, type TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture } from "../../support/dreamer.ts";
import { REQUEST } from "../../support/noter.ts";

let memory: ReturnType<typeof sourceSeededMemory> | undefined;
const dreamers: TraceMemory[] = [];
afterEach(() => { memory?.close(); memory = undefined; for (const m of dreamers.splice(0)) m.close(); });
const time = "2026-09-09T00:00:00Z";

test("noting keeps the request the host reported when the failed result carries none", async () => {
  memory = sourceSeededMemory(":memory:", async raw => {
    (raw as NotingAgentInput).reportRequest({ captured: true });
    return { outcome: "failure", output: "offline failure", request: null };
  }, { dreaming: { triggerKnowledge: 1 } });
  const projectId = memory.store.createProject({ name: "audit", declaredBy: "mark" }).id;
  const sessionId = memory.store.createSession({ projectId, host: "fake", enrollmentChoice: true, startedAt: time, firstReplyAt: time }).id;
  const turn = memory.store.appendTurn({ sessionId, kind: "turn", userPrompt: "source", assistantText: "answer", startedAt: time });
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: turn.id });
  if (result.outcome !== "failure") throw new Error(`expected a failure, got ${result.outcome}`);
  expect(JSON.parse(memory.store.getRun(result.runId)!.request!)).toEqual({ captured: true });
  expect(JSON.parse(memory.store.getRun(result.runId)!.response!).problems).toEqual(["offline failure"]);
});

test("dreaming keeps the request the host reported when the failed result carries none", async () => {
  const f = dreamerFixture(dreamers, { curateResult: { outcome: "failure", output: "offline failure", request: null } });
  f.item("A rule");
  const result = await f.dream();
  if (result.outcome !== "failure") throw new Error(`expected a failure, got ${result.outcome}`);
  const run = f.store.getRun(result.runId)!;
  expect(JSON.parse(run.request!)).toEqual(REQUEST);
  expect(JSON.parse(run.response!).problems).toEqual(["offline failure"]);
});
