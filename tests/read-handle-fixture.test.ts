import { expect, test, vi } from "vitest";
import { sourceSeededMemory } from "./source-fixture.ts";
import { readHandle } from "./read-handle-fixture.ts";

for (const long of [false, true]) test(`92: fixture reads the complete tagged body without translating legacy addresses (long=${long})`, () => {
  const memory = sourceSeededMemory(":memory:", async () => { throw Error("offline fixture"); });
  try {
    const project = memory.store.createProject({ name: "handle", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:fixture", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Keep this rule", startedAt: "now" });
    const tools = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id });
    const note = tools.find(tool => tool.name === "note")!, write = tools.find(tool => tool.name === "memory")!;
    expect(note.execute({ facts: [{ title: "Rule evidence", sources: [{ address: `T${turn.id}#E1`, text: "Keep this rule" }] }] })).not.toContain("rejected:");
    expect(write.execute({ operations: [{ op: "create", text: long ? "Rule detail. ".repeat(4000) : "A short rule", category: "constraint",
      scope: "project", topics: [], supports: ["F1"], reason: "Fixture evidence" }], skipped: [] })).toContain("committed");
    const trace = vi.spyOn(tools.find(tool => tool.name === "trace")!, "execute");
    const expected = `K1#${memory.store.versionTag(1, 1)}`;
    expect(readHandle(tools, "K1")).toBe(expected);
    if (long) expect(trace.mock.calls.length).toBeGreaterThan(1);
    expect(readHandle(tools, "K1@v1")).toBe(expected);
    expect(readHandle(tools, expected)).toBe(expected);
    const calls = trace.mock.calls.length;
    expect(() => readHandle(tools, "K1@1")).toThrow("@v fixture address");
    expect(trace.mock.calls).toHaveLength(calls);
  } finally { memory.close(); }
});
