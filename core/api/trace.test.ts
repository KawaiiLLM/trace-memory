import { afterEach, beforeEach, expect, test } from "bun:test";
import { TraceMemory } from "./index";
import fixture from "./fixtures/trace.json";

let memory: ReturnType<typeof TraceMemory>;
let sessionId: number;
const time = "2026-09-07T00:00:00Z";
type Operation = Parameters<ReturnType<typeof TraceMemory>["store"]["commitSettleRun"]>[0]["operations"][number];
function settle(...operations: Operation[]) {
  const result = memory.store.commitSettleRun({ run: { kind: "settle", sessionId, createdAt: time }, operations });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.problems.join(", "));
  expect(result.rejected).toEqual([]);
  return result.committed;
}
function create(text = "use red tiles now") {
  return settle({ op: "new", handle: "$e1", author: "test", text, category: "reference", scope: "project", supports: [1], createdAt: time })[0]!.entryId;
}
function edit(entryId: number, expectedRevision: number, text: string, extra: Partial<Extract<Operation, { op: "edit" }>> = {}) {
  settle({ op: "edit", entryId, expectedRevision, text, category: "reference", scope: "project", supports: [1], because: [2], createdAt: time, ...extra });
}
beforeEach(() => {
  memory = TraceMemory(":memory:", async () => { throw new Error("trace must not call the model"); });
  const project = memory.store.createProject({ name: "trace", declaredBy: "mark" });
  sessionId = memory.store.createSession({ host: "test", projectId: project.id, startedAt: time, firstReplyAt: time }).id;
  const turn = memory.store.appendTurn({ sessionId, kind: "turn", startedAt: time });
  const facts = memory.store.commitNoteRun({ run: { kind: "note", sessionId, createdAt: time }, facts: [
    { text: "original claim" },
    { text: "first correction", negate: [{ target: "$1", strength: "strong" as const }] },
    { text: "second correction", negate: [{ target: "$1", strength: "strong" as const }] },
    { text: "shared correction", negate: [{ target: "$2", strength: "strong" as const }, { target: "$3", strength: "strong" as const }] },
    { text: "weak objection", negate: [{ target: "$1", strength: "weak" as const }] },
    { text: "adoption", support: [{ target: "$1", strength: "strong" as const }] },
  ].map((f) => ({ ...f, turnId: turn.id, category: "observation", actor: "user", source: ["T1#user"], createdAt: time })) });
  expect(facts.ok).toBe(true);
});
afterEach(() => memory.close());

test("current entry and historical snapshot include evidence and revision metadata", () => {
  const id = create();
  edit(id, 1, "use blue tiles now", { category: "constraint", scope: "global", supports: [2, 3] });
  expect(memory.trace(`E${id}`)).toBe(`[E1@2] [constraint/global] use blue tiles now\n  supports: F2, F3\n  status: active\nRevisions:\n  E1@1 new ${time} because: none\n  E1@2 edit ${time} because: F2`);
  expect(memory.trace(`E${id}@1`)).toBe(`[E1@1] [reference/project] use red tiles now\n  supports: F1\n  E1@1 new ${time} because: none`);
});

test("diff preserves unchanged spans and lists all transitions even if endpoints revert", () => {
  const id = create();
  edit(id, 1, "use blue tiles now", { supports: [2], category: "constraint", scope: "global" });
  edit(id, 2, "use green tiles now", { supports: [2, 3], category: "constraint", scope: "global", because: [3, 4] });
  expect(memory.trace(`E${id}@1..3`)).toBe(`[E1@1..3]\n  text: use [-red-]{+green+} tiles now\n  supports added: F2, F3\n  supports removed: F1\n  category: reference -> constraint\n  scope: project -> global\nRevisions:\n  E1@2 edit ${time} because: F2\n  E1@3 edit ${time} because: F3, F4`);
  edit(id, 3, "use red tiles now");
  expect(memory.trace(`E${id}@1..4`)).toContain("text: use red tiles now\n  supports added: none\n  supports removed: none");
  expect(memory.trace(`E${id}@1..4`)).toContain(`E1@3 edit ${time} because: F3, F4`);
  expect(memory.trace(`E${id}@2..2`)).toContain("Revisions: none");
});

test.each([
  ["a b a", "a a", "a [-b -]a"],
  ["", "hello", "{+hello+}"],
  ["hello", "", "[-hello-]"],
  ["a  b!", "a b?", "a[-  -]{+ +}b[-!-]{+?+}"],
])("token LCS handles %j to %j", (before, after, expected) => {
  const id = create(before); edit(id, 1, after);
  expect(memory.trace(`E${id}@1..2`)).toContain(`  text: ${expected}\n`);
});

test("Chinese token edits preserve surrounding characters from the simulation fixture", () => {
  const chars = Array.from(fixture.facts[0]!.text);
  const before = chars.join("");
  const removed = chars[5]!;
  const added = Array.from(fixture.facts[1]!.text).find((c) => /\p{Script=Han}/u.test(c) && !before.includes(c))!;
  chars[5] = added;
  const id = create(before); edit(id, 1, chars.join(""));
  expect(memory.trace(`E${id}@1..2`)).toContain(`  text: ${before.slice(0, 5)}[-${removed}-]{+${added}+}${before.slice(6)}\n`);
});

test("merged entries retain their snapshot and frozen survivor revision; archives show the archive revision", () => {
  const absorbed = create("absorbed"), survivor = create("survivor");
  settle({ op: "merge", intoEntryId: survivor, intoExpectedRevision: 1, absorb: [{ entryId: absorbed, expectedRevision: 1 }], text: "combined", category: "reference", scope: "project", supports: [1, 2], because: [3], createdAt: time });
  edit(survivor, 2, "later survivor");
  expect(memory.trace(`E${absorbed}`)).toContain("[E1@1] [reference/project] absorbed\n  supports: F1\n  status: merged\n  merged_into: E2@2 (from E1@1)");
  expect(memory.trace(`E${absorbed}@1`)).not.toContain("later survivor");
  settle({ op: "archive", entryId: survivor, expectedRevision: 3, because: [4], createdAt: time });
  expect(memory.trace(`E${survivor}`)).toContain("[E2@4] [reference/project] later survivor\n  supports: F1\n  status: archived");
  expect(memory.trace(`E${survivor}@4`)).toContain(`E2@4 archive ${time} because: F4`);
});

test("negation walk branches, repeats shared descendants, excludes weak and support edges, and ends every branch", () => {
  const result = memory.trace("F1..");
  const fact = (id: number, depth: number) => memory.trace(`F${id}`).split("\n").map((l) => "  ".repeat(depth) + l).join("\n");
  expect(result).toBe([fact(1, 0), fact(2, 1), fact(4, 2), "      no later strong negation recorded", fact(3, 1), fact(4, 2), "      no later strong negation recorded"].join("\n"));
  expect(memory.trace("F4..")).toBe(memory.trace("F4") + "\n  no later strong negation recorded");
});

test.each(["", "E0", "E01", "E1@0", "E1@1..", "E1@3..1", "E1 full", "F1.. full", "F0..", "F01..", "E9007199254740992", "E1@9007199254740992", "F9007199254740992..", "garbage"])("rejects invalid address %j", (address) => {
  create(); expect(() => memory.trace(address)).toThrow(/invalid trace address/);
});
test.each(["E99", "E99@1", "E1@99", "E1@1..99", "F99.."])("reports missing target %s", (address) => {
  create(); expect(() => memory.trace(address)).toThrow(/does not exist|has no revision/);
});

test("simulation entry and strong negation goldens preserve Chinese memory content", () => {
  // Fixture IDs are remapped after the six synthetic facts; source addresses stay verbatim.
  const ids = new Map(fixture.facts.map((f, i) => [f.id, i + 7]));
  const turn = memory.store.appendTurn({ sessionId, kind: "turn", startedAt: time });
  const committed = memory.store.commitNoteRun({ run: { kind: "note", sessionId, createdAt: time }, facts: fixture.facts.map((f) => ({
    turnId: turn.id, category: f.category as "observation", actor: f.actor as "agent", text: f.text, quote: f.quote,
    source: f.source, createdAt: f.timestamp,
    negate: f.negate?.map(([id]) => ({ target: `F${ids.get(Number(id))}`, strength: "strong" as const })),
  })) });
  expect(committed.ok).toBe(true);
  fixture.entry.log.forEach((r, i) => {
    const fields = { text: r.text, category: "reference" as const, scope: "project" as const, supports: r.supports.map((id) => ids.get(id)!), createdAt: r.at };
    if (!i) settle({ ...fields, op: "new", handle: "$e1", author: "settlement" });
    else settle({ ...fields, op: "edit", entryId: 1, expectedRevision: i, because: r.because.map((id) => ids.get(Number(id.slice(1)))!) });
  });
  expect(memory.trace("E1")).toMatchSnapshot();
  expect(memory.trace("E1@1")).toMatchSnapshot();
  expect(memory.trace("E1@1..2")).toMatchSnapshot();
  expect(memory.trace(`F${ids.get(8)}..`)).toMatchSnapshot();
});
