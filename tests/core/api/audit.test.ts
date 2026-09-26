// Maintainability audit finding 1: one rule finalizes the run audit of both phases. They ran separate
// finalizers and had drifted — a host that reported its request and then failed with `request: null`
// kept the reported request in Consolidation and had it overwritten with `null` in Noting.
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, type DreamingAgentInput, type NotingAgentInput } from "../../source-fixture.ts";

let memory: ReturnType<typeof sourceSeededMemory> | undefined;
afterEach(() => { memory?.close(); memory = undefined; });
const time = "2026-09-09T00:00:00Z";

for (const phase of ["noting", "dreaming"] as const)
  test(`${phase} keeps the request the host reported when the failed result carries none`, async () => {
    memory = sourceSeededMemory(":memory:", async raw => {
      (raw as NotingAgentInput | DreamingAgentInput).reportRequest({ captured: true });
      return { outcome: "failure", output: "offline failure", request: null };
    }, { dreaming: { triggerTokens: 1 } });
    const projectId = memory.store.createProject({ name: "audit", declaredBy: "mark" }).id;
    const sessionId = memory.store.createSession({ projectId, host: "fake", enrollmentChoice: true, startedAt: time, firstReplyAt: time }).id;
    const turn = memory.store.appendTurn({ sessionId, kind: "turn", userPrompt: "source", assistantText: "answer", startedAt: time });
    if (phase === "dreaming") {
      expect(memory.store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
        facts: [{ turnId: turn.id, entryIds: [memory.store.sourcePath(sessionId, "main", turn.id)[0]!.id], text: "evidence", source: [`T${turn.id}#E1`], createdAt: time }] }).ok).toBe(true);
      expect(memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId, createdAt: time }, operations: [
        { op: "create", handle: "$1", author: "fixture", text: "rule", category: "constraint", scope: "project", supports: [1], topics: [], reason: "evidence", createdAt: time },
      ] }).ok).toBe(true);
    }
    const input = { sessionId, branch: "main", headTurnId: turn.id, mode: "subagent" as const };
    const result = phase === "noting" ? await memory.noting(input) : await memory.dream(input);
    if (result.outcome !== "failure") throw new Error(`expected a failure, got ${result.outcome}`);
    expect(JSON.parse(memory.store.getRun(result.runId)!.request!)).toEqual({ captured: true });
    expect(JSON.parse(memory.store.getRun(result.runId)!.response!).problems).toEqual(phase === "noting"
      ? ["offline failure"] : ["offline failure", "runAgent must return the exact provider request"]);
  });
