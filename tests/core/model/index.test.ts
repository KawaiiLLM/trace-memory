import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, type ToolDefinition } from "../../source-fixture.ts";

let memory: ReturnType<typeof sourceSeededMemory>, note: ToolDefinition;
const fact = (extra = {}) => ({ text: "Use pnpm.", source: ["T1#E1"], ...extra });
beforeEach(() => {
  memory = sourceSeededMemory(":memory:", async () => ({ outcome: "success", output: "", request: {} }));
  const p = memory.store.createProject({ name: "p", declaredBy: "mark" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "test", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Use pnpm.", assistantText: "Done.", startedAt: "source time" });
  note = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: 1 }).find((t) => t.name === "note")!;
});
afterEach(() => memory.close());

for (const category of ["question", "proposal", "decision", "observation", "interpretation", "event"] as const) test(`legacy category ${category} remains readable but is rejected on new writes`, () => {
  expect(note.execute({ facts: [fact({ category })] })).toContain("unexpected field");
  expect(memory.store.listSessionFacts(1)).toEqual([]);
  const stored = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "source time" },
    facts: [{ turnId: 1, category, actor: "user", text: "Use pnpm.", source: ["T1#user"],
      ...(category === "event" ? { status: "completed" as const } : {}), createdAt: "source time" }] });
  expect(stored.ok).toBe(true);
  expect(memory.trace("F1")).toContain(`[${category}/user]`);
});
for (const status of ["completed", "reported", "dispatched", "attempted"] as const) test(`legacy event status ${status} renders as a prefix without storing it in text`, () => {
  const stored = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: 1, createdAt: "source time" },
    facts: [{ turnId: 1, category: "event", actor: "user", status, text: "Use pnpm.", source: ["T1#user"], createdAt: "source time" }] });
  expect(stored.ok).toBe(true);
  expect(memory.trace("F1")).toContain(`${status}: Use pnpm.`);
  expect(memory.store.getFact(1)?.text).toBe("Use pnpm.");
  expect(memory.store.getFact(1)?.createdAt).toBe("source time");
});
for (const [label, changes, error] of [
  ["unknown category", { category: "guess" }, "category"],
  ["unknown actor", { actor: "bot" }, "actor"],
  ["retired event category", { category: "event" }, "category"],
  ["non-event status", { status: "completed" }, "status"],
  ["unknown status", { category: "event", status: "done" }, "status"],
  ["caller-selected role", { role: "user" }, "unexpected field"],
  ["retired quote", { quote: "Use pnpm." }, "unexpected field"],
  ["timestamp", { timestamp: "invented" }, "unexpected field"],
  ["fact id in text", { text: "See F12" }, "embed"],
  ["knowledge id in text", { text: "See K7" }, "embed"],
  ["empty source", { source: [] }, "source"],
  ["invalid source", { source: ["T1"] }, "source"],
  ["missing entry source", { source: ["T1#E99"] }, "invalid source"],
  ["block-selected source", { source: ["T1#E1@text"] }, "invalid source"],
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
test("new episodes derive the entry role and keep completion wording in the body", () => {
  expect(note.execute({ facts: [fact({ text: "completed: the user confirmed pnpm" })] })).toContain("ok: F1");
  const stored = memory.store.getFact(1)!;
  expect(stored).toMatchObject({ text: "completed: the user confirmed pnpm", source: ["T1#E1"], createdAt: "source time" });
  expect(stored.roles).toEqual([{ role: "user" }]);
  expect(stored.category).toBeNull();
  expect(stored.actor).toBeNull();
  expect(stored.status).toBeNull();
  expect(memory.trace("F1")).toContain("user");
  expect(memory.trace("F1")).not.toContain("[null/null]");
});

test("local handles resolve to earlier facts and existing facts remain valid targets", () => {
  expect(note.execute({ facts: [fact(), fact({ support: [["$1", "weak"]] })] })).toContain("F2");
  expect(note.execute({ facts: [fact({ negate: [["F1", "strong"]] })] })).toContain("F3");
  expect(memory.trace("F2")).toContain("support F1 weak");
  expect(memory.trace("F1..")).toContain("[F3]");
});
