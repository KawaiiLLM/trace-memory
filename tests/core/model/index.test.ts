import { afterEach, beforeEach, expect, test } from "vitest";
import { TraceMemory, type ToolDefinition } from "../../source-fixture.ts";

let memory: TraceMemory, note: ToolDefinition;
const fact = (extra = {}) => ({ category: "observation", actor: "user", text: "Use pnpm.", source: ["T1#user"], ...extra });
beforeEach(() => {
  memory = TraceMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }));
  const p = memory.store.createProject({ name: "p", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "test", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Use pnpm.", assistantText: "Done.", startedAt: "source time" });
  note = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: 1 }).find((t) => t.name === "note")!;
});
afterEach(() => memory.close());

for (const category of ["question", "proposal", "decision", "observation", "interpretation", "event"]) test(`note accepts category ${category} through the facade`, () => {
  expect(note.execute({ facts: [fact({ category, ...(category === "event" ? { status: "completed" } : {}) })] })).toContain("F1");
});
for (const status of ["completed", "reported", "dispatched", "attempted"]) test(`event status ${status} renders as a prefix without storing it in text`, () => {
  expect(note.execute({ facts: [fact({ category: "event", status })] })).toContain("F1");
  expect(memory.trace("F1")).toContain(`${status}: Use pnpm.`);
  expect(memory.store.getFact(1)?.text).toBe("Use pnpm.");
  expect(memory.store.getFact(1)?.createdAt).toBe("source time");
});
for (const [label, changes, error] of [
  ["unknown category", { category: "guess" }, "category"],
  ["unknown actor", { actor: "bot" }, "actor"],
  ["event without status", { category: "event" }, "status"],
  ["non-event status", { status: "completed" }, "status"],
  ["unknown status", { category: "event", status: "done" }, "status"],
  ["completion prefix", { category: "event", status: "completed", text: "completed: tests" }, "prefix"],
  ["timestamp", { timestamp: "invented" }, "unexpected field"],
  ["fact id in text", { text: "See F12" }, "embed"],
  ["knowledge id in text", { text: "See K7" }, "embed"],
  ["empty source", { source: [] }, "source"],
  ["invalid source", { source: ["T1"] }, "source"],
  ["missing tool source", { source: ["T1#t99"] }, "does not exist"],
  ["self handle", { support: [["$1", "weak"]] }, "earlier"],
  ["zero handle", { support: [["$0", "weak"]] }, "earlier"],
  ["missing fact", { negate: [["F101", "strong"]] }, "existing"],
  ["malformed relation", { support: ["F1"] }, "[target, strength]"],
  ["unknown strength", { support: [["$1", "medium"]] }, "strength"],
  ["invalid relation target", { support: [["K7", "weak"]] }, "target"],
] as const) test(`note rejects ${label} and writes nothing`, () => {
  expect(note.execute({ facts: [fact(changes)] })).toContain(error);
  expect(memory.store.listSessionFacts(1)).toEqual([]);
});
test("local handles resolve to earlier facts and existing facts remain valid targets", () => {
  expect(note.execute({ facts: [fact(), fact({ support: [["$1", "weak"]] })] })).toContain("F2");
  expect(note.execute({ facts: [fact({ negate: [["F1", "strong"]] })] })).toContain("F3");
  expect(memory.trace("F2")).toContain("support F1 weak");
  expect(memory.trace("F1..")).toContain("[F3]");
});
