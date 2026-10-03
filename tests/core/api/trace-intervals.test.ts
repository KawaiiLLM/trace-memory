// Ticket 118 rulings 6/7 and Paging remove public address lists, ranges and owned cursors.
// Retain the independent exact-fact and invalid-path contracts at the /tm boundary.
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, memoryFiles } from "../../source-fixture.ts";
import { legacyFacts } from "../../support/seed.ts";

let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => { memory = sourceSeededMemory(":memory:", async () => { throw new Error("offline fixture"); }); });
afterEach(() => memory.close());

function facts(count: number) {
  const store = memory.store;
  const projectId = store.createProject({ name: "fact-reads", declaredBy: "mark" }).id;
  const sessionId = store.createSession({ enrollmentChoice: true, host: "fake", projectId, startedAt: "now", firstReplyAt: "now" }).id;
  const turn = store.appendTurn({ sessionId, kind: "turn", userPrompt: "evidence", startedAt: "now" });
  const entry = store.listSourceEntries(sessionId, turn.id)[0]!;
  const committed = legacyFacts(store, { kind: "manual", sessionId, branch: "main", createdAt: "now" },
    Array.from({ length: count }, (_, index) => ({ sources: [{ entry, address: `T${turn.id}#E1` }],
      category: "observation" as const, actor: "user" as const, text: `fact ${index + 1}`, createdAt: "now" })));
  return { sessionId, turn, ids: committed.facts.map(fact => fact.id) };
}

test("118: separate exact fact paths retain order and identity; a missing fact fails", () => {
  const { sessionId, turn, ids } = facts(5);
  const files = memoryFiles(memory, { sessionId, branch: "main", headTurnId: turn.id });
  expect(ids).toEqual([1, 2, 3, 4, 5]);
  const selected = [1, 3, 5].map(id => files.read(`/tm/F${id}`).content);
  expect(selected.map(text => /fact (\d+)/.exec(text)?.[1])).toEqual(["1", "3", "5"]);
  expect(selected[0]).not.toContain("fact 3");
  expect(selected[1]).not.toContain("fact 5");
  expect(() => files.read("/tm/F999")).toThrow("fact F999 does not exist");
});

test("118: removed fact intervals and comma lists cannot be used as /tm paths", () => {
  const { sessionId, turn } = facts(3);
  const files = memoryFiles(memory, { sessionId, branch: "main", headTurnId: turn.id });
  for (const path of ["/tm/F1,F2", "/tm/F1-F3", "/tm/K1@v1..v2", `/tm/raw/S${sessionId}/T${turn.id}#E1,E2`]) {
    expect(() => files.read(path)).toThrow(`no such path: ${path}; /tm`);
  }
  expect(files.read("/tm/F1").content).toContain("fact 1");
});
