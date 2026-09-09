// Maintainability audit finding 1: one rule finalizes the run audit of both phases. They ran separate
// finalizers and had drifted — a host that reported its request and then failed with `request: null`
// kept the reported request in Consolidation and had it overwritten with `null` in Noting.
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, type ConsolidationAgentInput, type NotingAgentInput } from "../../source-fixture.ts";

let memory: ReturnType<typeof sourceSeededMemory> | undefined;
afterEach(() => { memory?.close(); memory = undefined; });
const time = "2026-09-09T00:00:00Z";

for (const phase of ["noting", "consolidation"] as const)
  test(`${phase} keeps the request the host reported when the failed result carries none`, async () => {
    memory = sourceSeededMemory(":memory:", async raw => {
      (raw as NotingAgentInput | ConsolidationAgentInput).reportRequest({ captured: true });
      return { outcome: "failure", output: "offline failure", request: null };
    });
    const projectId = memory.store.createProject({ name: "audit", declaredBy: "mark" }).id;
    const sessionId = memory.store.createSession({ projectId, host: "fake", enrollmentChoice: true, startedAt: time, firstReplyAt: time }).id;
    const turn = memory.store.appendTurn({ sessionId, kind: "turn", userPrompt: "source", assistantText: "answer", startedAt: time });
    if (phase === "consolidation") expect(memory.store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
      facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: time }] }).ok).toBe(true);
    const input = { sessionId, branch: "main", headTurnId: turn.id, mode: "subagent" as const };
    const result = phase === "noting" ? await memory.noting(input) : await memory.consolidate(input);
    if (result.outcome !== "failure") throw new Error(`expected a failure, got ${result.outcome}`);
    expect(JSON.parse(memory.store.getRun(result.runId)!.request!)).toEqual({ captured: true });
    expect(JSON.parse(memory.store.getRun(result.runId)!.response!).problems).toEqual(["offline failure"]);
  });
