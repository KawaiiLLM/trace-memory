// Ticket 118 rulings 6/7 and Paging retire public trace cursors, mixed-address lists and
// Core-owned item/page ceilings. Keep the independent whole-entry and write-authority contracts.
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";

let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => { memory = sourceSeededMemory(":memory:", async () => { throw new Error("offline fixture"); }); });
afterEach(() => memory.close());

function corpus() {
  const store = memory.store;
  const projectId = store.createProject({ name: "entries", declaredBy: "mark" }).id;
  const sessionId = store.createSession({ host: "fake", projectId, startedAt: "now", firstReplyAt: "now", enrollmentChoice: true }).id;
  const turn = store.appendTurn({ sessionId, kind: "turn", userPrompt: "USER-ONLY", assistantText: "ASSISTANT-ONLY", startedAt: "now" });
  const script = '中文😀𠮷 é👨‍👩‍👧‍👦 \\"\n\\t\\uD83D\\uDE00 </script> '.repeat(600) + "SCRIPT-END";
  const result = "RESULT-START " + "🧪数据 abc123 ".repeat(900) + " RESULT-END\r\n\n";
  store.appendToolCall({ turnId: turn.id, name: "bash", input: JSON.stringify({ command: script }), result, status: "success" });
  store.appendToolCall({ turnId: turn.id, name: "read", input: '{"path":"OTHER-CALL"}', result: "OTHER-RESULT", status: "success" });
  return { sessionId, turn, script, result };
}

test("118: one exact Raw entry is whole, preserving Unicode, escapes and source isolation", () => {
  const { sessionId, turn, script, result } = corpus();
  const files = memoryFiles(memory, { sessionId, branch: "main", headTurnId: turn.id });
  const root = `/tm/raw/S${sessionId}/T${turn.id}`;
  const call = files.read(`${root}#E3@assistant`);
  const observation = files.read(`${root}#E4@observation`);
  expect(call.unbounded).toBe(true);
  expect(call.content).toContain(`command=${JSON.stringify(script)}`);
  expect(call.content).not.toContain("USER-ONLY");
  expect(call.content).not.toContain("OTHER-CALL");
  expect(observation.content).toContain(result);
  expect(observation.content).not.toContain("OTHER-RESULT");
  expect(() => files.read(`${root}#E3@user`)).toThrow(/role does not match/);
  const overview = files.read(root).content;
  expect(overview).toContain(`[S${sessionId}/T${turn.id}]`);
  expect(overview).toContain(`[T${turn.id}#E3@assistant]`);
  expect(overview).toContain(`[T${turn.id}#E4@observation]`);
  expect(overview).toContain(`${root}#E3`);
  expect(overview).toContain(`${root}#E4`);
  expect(overview).toContain("omitted calls"); // A bounded call may retain its tail, including SCRIPT-END.
});

test.each(["😀", "𠮷", "👨‍👩‍👧‍👦", "é", "\\\\uD83D\\\\uDE00", "\\\\\\\"\\\\n", "abc123"])("118: exact user entry preserves repeated script bytes: %s", unit => {
  const { sessionId, turn } = corpus();
  const text = unit.repeat(2000);
  const later = memory.store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: text, startedAt: "now" });
  const exact = memoryFiles(memory, { sessionId, branch: "main", headTurnId: later.id }).read(`/tm/raw/S${sessionId}/T${later.id}#E1@user`);
  expect(exact.content).toContain(`[T${later.id}#E1@user] user: ${text}`);
  expect(exact.content).toContain(text.slice(-100));
  expect(exact.unbounded).toBe(true);
});

test("118/92: reading an exact tagged knowledge body does not grant manual update authority", () => {
  const { sessionId, turn } = corpus();
  const tools = memory.tools({ kind: "manual", sessionId, currentTurnId: turn.id, branch: "main" });
  const note = tools.find(tool => tool.name === "note")!, write = tools.find(tool => tool.name === "memory")!;
  const fact = JSON.parse(note.execute({ title: "Script decision", sources: `[T${turn.id}#E1] USER-ONLY` })).factIds[0];
  const created = JSON.parse(write.execute({ op: "create", text: "Keep exact scripts", category: "constraint", scope: "project",
    topics: [], supports: [`F${fact}`], reason: "User decision" }));
  const id = created.committed[0].knowledgeId;
  const tag = `K${id}#${memory.store.versionTag(id, memory.store.resolveVersionOrdinal(id, 1))}`;
  expect(memoryFiles(memory, { sessionId, branch: "main", headTurnId: turn.id }).read(`/tm/${tag}`).content).toContain("Keep exact scripts");
  expect(write.execute({ op: "update", id: tag, text: "Unauthorized rewrite", category: "constraint", scope: "project",
    topics: [], supports: [`F${fact}`], reason: "Read is not authority" })).toContain("Dreamer");
});
