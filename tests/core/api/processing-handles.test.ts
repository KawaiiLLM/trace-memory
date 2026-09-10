import { afterEach, expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { seedSourceEntry } from "../../source-fixture.ts";

const all: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { for (const m of all.splice(0)) m.close(); });
function setup() {
  const m = TraceMemory(":memory:", async () => ({ outcome: "success", output: "unused" })); all.push(m);
  const p = m.store.createProject({ name: "A", declaredBy: "mark" });
  const s = m.store.createSession({ host: "test", projectId: p.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const t = m.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "facts", startedAt: "now" });
  seedSourceEntry(m, t.id, "user", "facts");
  const context = { kind: "manual" as const, sessionId: s.id, currentTurnId: t.id, branch: "main" };
  const tools = m.tools(context);
  tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "facts", source: [`T${t.id}#user`] }] });
  const content = { text: "body A", category: "constraint", scope: "project", topics: [], supports: ["F1"], reason: "test" };
  const write = (operations: unknown[], binding = tools) => binding[3]!.execute({ operations, skipped: [] });
  expect(write([{ op: "create", ...content }])).not.toContain("rejected:");
  return { m, context, tools, content, write, t };
}

test("32: update and archive name an exact version — a bare K is refused", () => {
  const a = setup();
  expect(a.tools[0]!.execute({ address: "K1@1" })).toContain("body A");
  for (const op of ["update", "archive"]) {
    const value = op === "archive" ? { supports: ["F1"], reason: "retire" } : a.content;
    expect(a.write([{ op, id: "K1", ...value }])).toMatch(/exact read K@commit.*current tips: K1@1/);
  }
  expect(a.write([{ op: "update", id: "K1@1", ...a.content }])).not.toContain("rejected:");
});

test("32: candidate pool, receipt and search preview do not grant a read; complete trace persists across bindings", () => {
  const a = setup();
  const update = { op: "update", id: "K1@1", ...a.content };
  expect(a.write([update])).toContain("not read as visible and active");
  a.tools[1]!.execute({ query: "body", layer: "knowledge" });
  expect(a.write([update])).toContain("not read as visible and active");
  a.tools[0]!.execute({ address: "K1@1", cap: 1 });
  expect(a.write([update])).toContain("not read as visible and active");
  a.tools[0]!.execute({ address: "K1@1" });
  expect(a.write([update], a.m.tools(a.context))).not.toContain("rejected:");
  expect(a.write([{ ...update, id: "K1@2" }])).toContain("not read as visible and active");
});

test("32: ABA and archive invalidate old handles; no substitution on stale refusal", () => {
  const a = setup();
  a.tools[0]!.execute({ address: "K1@1" });
  expect(a.write([{ op: "update", id: "K1@1", ...a.content, text: "body B" }])).not.toContain("rejected:");
  a.tools[0]!.execute({ address: "K1@2" });
  expect(a.write([{ op: "update", id: "K1@2", ...a.content }])).not.toContain("rejected:");
  expect(a.write([{ op: "update", id: "K1@1", ...a.content }])).toMatch(/target moved on.*K1@3.*re-read/);
  a.tools[0]!.execute({ address: "K1@3" });
  expect(a.write([{ op: "archive", id: "K1@3", supports: ["F1"], reason: "retired" }])).not.toContain("rejected:");
  expect(a.write([{ op: "update", id: "K1@3", ...a.content }])).toMatch(/target moved on.*K1@4/);
});

test("32: every merge participant is read and current; one bad handle rolls back the whole batch", () => {
  const a = setup();
  a.write([{ op: "create", ...a.content, text: "second" }]);
  a.tools[0]!.execute({ address: "K1@1" });
  const merge = { op: "merge", id: "K1@1", absorb: ["K2@2"], ...a.content };
  expect(a.write([{ op: "create", ...a.content }, merge])).toContain("not read as visible and active");
  expect(a.m.store.getKnowledge(3)).toBeNull();
  a.tools[0]!.execute({ address: "K2@2" });
  expect(a.write([{ ...merge, absorb: ["K2"] }])).toContain("exact read K@commit");
  expect(a.write([merge])).not.toContain("rejected:");
});

test("32: an inapplicable sibling successor does not invalidate an exact read on this path", () => {
  const a = setup();
  const left = a.m.store.appendTurn({ sessionId: 1, parentTurnId: a.t.id, kind: "turn", userPrompt: "left", startedAt: "now" });
  const right = a.m.store.appendTurn({ sessionId: 1, parentTurnId: a.t.id, kind: "turn", userPrompt: "right", startedAt: "now" });
  seedSourceEntry(a.m, left.id, "user", "left"); seedSourceEntry(a.m, right.id, "user", "right");
  const l = a.m.tools({ ...a.context, branch: "left", currentTurnId: left.id });
  const r = a.m.tools({ ...a.context, branch: "right", currentTurnId: right.id });
  l[0]!.execute({ address: "K1@1" }); r[0]!.execute({ address: "K1@1" });
  l[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "left", source: [`T${left.id}#user`] }] });
  r[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "right", source: [`T${right.id}#user`] }] });
  expect(a.write([{ op: "update", id: "K1@1", ...a.content, supports: ["F2"] }], l)).not.toContain("rejected:");
  expect(a.write([{ op: "update", id: "K1@1", ...a.content, supports: ["F3"] }], r)).not.toContain("rejected:");
});
