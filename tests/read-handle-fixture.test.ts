import { expect, test, vi } from "vitest";
import { sourceSeededMemory, memoryFiles } from "./source-fixture.ts";
import { readHandle } from "./read-handle-fixture.ts";

for (const long of [false, true]) test(`92: fixture reads the complete tagged body without translating legacy addresses (long=${long})`, () => {
  const memory = sourceSeededMemory(":memory:", async () => { throw Error("offline fixture"); }, { writing: { bodyTokens: 1_000_000 } });
  try {
    const project = memory.store.createProject({ name: "handle", declaredBy: "mark" });
    const session = memory.store.createSession({ projectId: project.id, host: "pi:fixture", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Keep this rule", startedAt: "now" });
    const tools = memory.tools({ kind: "manual", sessionId: session.id, branch: "main", currentTurnId: turn.id });
    const note = tools.find(tool => tool.name === "note")!, write = tools.find(tool => tool.name === "memory")!;
    expect(note.execute({ title: "Rule evidence", sources: `[T${turn.id}#E1] Keep this rule` })).not.toContain("rejected:");
    expect(write.execute({ op: "create", title: "Fixture title", text: long ? "Rule detail. ".repeat(4000) : "A short rule", category: "constraint",
      scope: "project", topics: [], supports: ["F1"], reason: "Fixture evidence" })).toContain("committed");
    const files = memoryFiles(memory, { sessionId: session.id, branch: "main", headTurnId: turn.id });
    const read = (path: string) => files.read(path).content;
    const spy = vi.spyOn(files, "read");
    const expected = `K1#${memory.store.versionTag(1, 1)}`;
    expect(readHandle(read, "K1")).toBe(expected);
    if (long) expect(files.read("trace://K1").content).toContain("Rule detail.");
    expect(readHandle(read, "K1@v1")).toBe(expected);
    expect(readHandle(read, expected)).toBe(expected);
    const calls = spy.mock.calls.length;
    expect(() => readHandle(read, "K1@1")).toThrow("@v fixture address");
    expect(spy.mock.calls).toHaveLength(calls);
  } finally { memory.close(); }
});
