import { afterEach, beforeEach, expect, test } from "vitest";
import { TraceMemory } from "./index.ts";
import fixture from "../../test/fixtures/trace.json";

let memory: ReturnType<typeof TraceMemory>;
let sessionId: number;
const time = "2026-09-07T00:00:00Z";
type Operation = Parameters<ReturnType<typeof TraceMemory>["store"]["commitIntegrationRun"]>[0]["operations"][number];
function integration(...operations: Operation[]) {
  const result = memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: time }, operations });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.problems.join(", "));
  return result.committed;
}
function create(text = "use red tiles now") {
  return integration({ op: "create", handle: "$e1", author: "test", text, category: "reference", scope: "project", supports: [1], createdAt: time })[0]!.knowledgeId;
}
function edit(knowledgeId: number, baseCommit: number, text: string, extra: Partial<Extract<Operation, { op: "update" }>> = {}) {
  integration({ op: "update", knowledgeId, baseCommit, text, category: "reference", scope: "project", supports: [1], because: [2], createdAt: time, ...extra });
}
beforeEach(() => {
  memory = TraceMemory(":memory:", async () => { throw new Error("trace must not call the model"); });
  const project = memory.store.createProject({ name: "trace", declaredBy: "mark" });
  sessionId = memory.store.createSession({ host: "test", projectId: project.id, startedAt: time, firstReplyAt: time }).id;
  const turn = memory.store.appendTurn({ sessionId, kind: "turn", startedAt: time });
  const facts = memory.store.commitRecordingRun({ run: { kind: "recording", sessionId, createdAt: time }, facts: [
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

test("current knowledge and historical snapshot include evidence and revision metadata", () => {
  const id = create();
  edit(id, 1, "use blue tiles now", { category: "constraint", scope: "global", supports: [2, 3] });
  expect(memory.trace(`K${id}`)).toBe(`K1 tips (newest-created: K1@2):\n[K1@2] [constraint/global] use blue tiles now\n  supports: F2, F3\n  parents: K1@1\n  children: none\n  K1@2 update ${time} because: F2\nCommit history:\nCommits:\n  K1@1 create ${time} because: none\n  K1@2 update ${time} because: F2`);
  expect(memory.trace(`K${id}@1`)).toBe(`[K1@1] [reference/project] use red tiles now\n  supports: F1\n  parents: none\n  children: K1@2\n  K1@1 create ${time} because: none`);
});

test("diff preserves unchanged spans and lists all transitions even if endpoints revert", () => {
  const id = create();
  edit(id, 1, "use blue tiles now", { supports: [2], category: "constraint", scope: "global" });
  edit(id, 2, "use green tiles now", { supports: [2, 3], category: "constraint", scope: "global", because: [3, 4] });
  expect(memory.trace(`K${id}@1..K${id}@3`)).toBe(`[K1@1..K1@3]\n  text: use [-red-]{+green+} tiles now\n  supports added: F2, F3\n  supports removed: F1\n  category: reference -> constraint\n  scope: project -> global\nCommits:\n  K1@2 update ${time} because: F2\n  K1@3 update ${time} because: F3, F4`);
  edit(id, 3, "use red tiles now");
  expect(memory.trace(`K${id}@1..K${id}@4`)).toContain("text: use red tiles now\n  supports added: none\n  supports removed: none");
  expect(memory.trace(`K${id}@1..K${id}@4`)).toContain(`K1@3 update ${time} because: F3, F4`);
  expect(memory.trace(`K${id}@2..K${id}@2`)).toContain("Commits: none");
});

test.each([
  ["a b a", "a a", "a [-b -]a"],
  ["", "hello", "{+hello+}"],
  ["hello", "", "[-hello-]"],
  ["a  b!", "a b?", "a[-  -]{+ +}b[-!-]{+?+}"],
])("token LCS handles %j to %j", (before, after, expected) => {
  const id = create(before); edit(id, 1, after);
  expect(memory.trace(`K${id}@1..K${id}@2`)).toContain(`  text: ${expected}\n`);
});

test("Chinese token edits preserve surrounding characters from the simulation fixture", () => {
  const chars = Array.from(fixture.facts[0]!.text);
  const before = chars.join("");
  const removed = chars[5]!;
  const added = Array.from(fixture.facts[1]!.text).find((c) => /\p{Script=Han}/u.test(c) && !before.includes(c))!;
  chars[5] = added;
  const id = create(before); edit(id, 1, chars.join(""));
  expect(memory.trace(`K${id}@1..K${id}@2`)).toContain(`  text: ${before.slice(0, 5)}[-${removed}-]{+${added}+}${before.slice(6)}\n`);
});

test("merged knowledge retain their snapshot and frozen survivor revision; archives show the archive revision", () => {
  const absorbed = create("absorbed"), survivor = create("survivor");
  integration({ op: "merge", intoKnowledgeId: survivor, intoBaseCommit: 2, absorb: [{ knowledgeId: absorbed, baseCommit: 1 }], text: "combined", category: "reference", scope: "project", supports: [1, 2], because: [3], createdAt: time });
  edit(survivor, 3, "later survivor");
  expect(memory.trace(`K${absorbed}`)).toContain("merged_into: K2@3 (from K1@1)");
  expect(memory.trace(`K${absorbed}`)).toContain("children: K2@3");
  expect(memory.trace(`K${absorbed}@1`)).not.toContain("later survivor");
  integration({ op: "archive", knowledgeId: survivor, baseCommit: 4, because: [4], createdAt: time });
  expect(memory.trace(`K${survivor}`)).toContain("[K2@5] [reference/project] \n  supports: ");
  expect(memory.trace(`K${survivor}@5`)).toContain(`K2@5 archive ${time} because: F4`);
});

test("negation walk branches, repeats shared descendants, excludes weak and support edges, and ends every branch", () => {
  const result = memory.trace("F1..");
  const fact = (id: number, depth: number) => memory.trace(`F${id}`).split("\n").map((l) => "  ".repeat(depth) + l).join("\n");
  expect(result).toBe([fact(1, 0), fact(2, 1), fact(4, 2), "      no later strong negation recorded", fact(3, 1), fact(4, 2), "      no later strong negation recorded"].join("\n"));
  expect(memory.trace("F4..")).toBe(memory.trace("F4") + "\n  no later strong negation recorded");
});

test.each(["", "K0", "K01", "K1@0", "K1@1..", "K1@3..1", "K1 full", "F1.. full", "F0..", "F01..", "K9007199254740992", "K1@9007199254740992", "F9007199254740992..", "garbage"])("rejects invalid address %j", (address) => {
  create(); expect(() => memory.trace(address)).toThrow(/invalid trace address/);
});
test.each(["K99", "K99@1", "K1@99", "K1@1..K1@99", "F99.."])("reports missing target %s", (address) => {
  create(); expect(() => memory.trace(address)).toThrow(/does not exist|has no revision/);
});

test("simulation knowledge and strong negation goldens preserve Chinese memory content", () => {
  // Remap fixture fact and raw-source IDs into this database; preserve the original fixture on disk.
  const ids = new Map(fixture.facts.map((f, i) => [f.id, i + 7]));
  const turn = memory.store.appendTurn({ sessionId, kind: "turn", assistantText: fixture.facts.map(f => f.text).join("\n"), startedAt: time });
  const committed = memory.store.commitRecordingRun({ run: { kind: "recording", sessionId, createdAt: time }, facts: fixture.facts.map((f) => ({
    turnId: turn.id, category: f.category as "observation", actor: f.actor as "agent", text: f.text, quote: f.quote,
    source: [`T${turn.id}#assistant`], createdAt: f.timestamp,
    negate: f.negate?.map(([id]) => ({ target: `F${ids.get(Number(id))}`, strength: "strong" as const })),
  })) });
  expect(committed.ok).toBe(true);
  fixture.knowledge.log.forEach((r, i) => {
    const fields = { text: r.text, category: "reference" as const, scope: "project" as const, supports: r.supports.map((id) => ids.get(id)!), createdAt: r.at };
    if (!i) integration({ ...fields, op: "create", handle: "$e1", author: "integration" });
    else integration({ ...fields, op: "update", knowledgeId: 1, baseCommit: i, because: r.because.map((id) => ids.get(Number(id.slice(1)))!) });
  });
  expect(memory.trace("K1")).toMatchSnapshot();
  expect(memory.trace("K1@1")).toMatchSnapshot();
  expect(memory.trace("K1@1..K1@2")).toMatchSnapshot();
  expect(memory.trace(`F${ids.get(8)}..`)).toMatchSnapshot();
});
