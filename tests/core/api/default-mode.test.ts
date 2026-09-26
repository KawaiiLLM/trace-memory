import { expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import type { ConfigOverride, NotingAgentInput } from "../../../src/core/api/index.ts";

// Exercise the facade's own mode resolution, without a host supplying `mode` for it.
const choices: { name: string; config: ConfigOverride; mode?: "fork" | "subagent"; expected: "fork" | "subagent" }[] = [
  { name: "omitted", config: {}, expected: "subagent" },
  { name: "explicit true", config: { noting: { forkModeDefault: true } }, expected: "fork" },
  { name: "per-task fork", config: {}, mode: "fork", expected: "fork" },
  { name: "per-task subagent", config: { noting: { forkModeDefault: true } }, mode: "subagent", expected: "subagent" },
  { name: "legacy true", config: { noting: { branchModeDefault: true } }, expected: "fork" },
];
test.each(choices)("N executes $expected with $name", async ({ config, mode, expected }) => {
  const calls: NotingAgentInput[] = [];
  const memory = sourceSeededMemory(":memory:", async raw => {
    const input = raw as NotingAgentInput;
    calls.push(input);
    expect(input.tools.find(t => t.name === "note")!.execute({ facts: [] })).not.toContain("rejected:");
    expect(input.tools.find(t => t.name === "memory")!.execute({ operations: [], skipped: [] })).not.toContain("rejected:");
    return { outcome: "success", output: "Done.", request: { fake: true } };
  }, config);
  try {
    const project = memory.store.createProject({ name: "default-mode", declaredBy: "mark" });
    const session = memory.store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "t", firstReplyAt: "t" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Evidence", assistantText: "Reply", startedAt: "t" });
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    expect((await memory.noting({ ...target, ...(mode ? { mode } : {}) })).outcome).toBe("success");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.mode).toBe(expected);
    const recorded = memory.store.listRuns(session.id).filter(r => r.kind === "noting");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.mode).toBe(expected);
    expect(JSON.parse(recorded[0]!.response!).requestedMode).toBe(expected);
  } finally { memory.close(); }
});
