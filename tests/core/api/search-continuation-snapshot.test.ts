// 22c "Paged search": a continuation is the query's own snapshot. 22c already froze the hit
// addresses and the commit graph; these cases pin the mutable state the lines themselves read — a
// fact's relations and the Turn occurrences an assembled trace shows. Writing either between two
// pages must not change a page the query already established.
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
const time = "2026-09-09T00:00:00Z";

let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => {
  memory = sourceSeededMemory(":memory:", async () => { throw new Error("these cases call no model"); });
});
afterEach(() => { memory.close(); });

/** One enrolled session with one Turn whose prompt matches the query used below. */
function session() {
  const store = memory.store;
  const projectId = store.createProject({ name: "p", declaredBy: "mark" }).id;
  const { id } = store.createSession({ host: "fake", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true });
  const turn = store.appendTurn({ sessionId: id, kind: "turn", userPrompt: "needle", assistantText: "reply", startedAt: time });
  return { store, sessionId: id, turn };
}

/** The body of every case: page a two-hit query one hit at a time, write between the pages, and
 * require the two pages to join into exactly what the same query printed whole. */
function paged(scope: "facts" | "raw", query: string, between: () => void) {
  const body = (text: string) => text.split("\n\nReceipts:")[0]!;
  const whole = body(memory.search(query, scope, { cap: 100 }));
  const first = memory.search(query, scope, { cap: 1 });
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  expect(memory.store.db.isTransaction).toBe(false); // no transaction is held while the caller decides
  between();
  const next = memory.search("", scope, { cursor });
  return { joined: `${body(first)}\n${body(next)}`, whole };
}

test("22c: a fact negated between two pages does not add a relation to the established page", () => {
  const { store, sessionId, turn } = session();
  const note = (text: string, more: object = {}) => {
    const result = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
      facts: [{ turnId: turn.id, category: "observation", actor: "user", text, source: [`T${turn.id}#user`], createdAt: time, ...more }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.facts[0]!;
  };
  note("needle first");
  const second = note("needle second");
  const { joined, whole } = paged("facts", "needle", () => note("later correction", { negate: [{ target: `F${second.id}`, strength: "strong" }] }));
  expect(joined).toBe(whole);
});

test("22c: a message completed between two pages does not join the established page's assembled trace", () => {
  const { store, sessionId, turn } = session();
  const second = store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: "needle second", startedAt: time });
  const { joined, whole } = paged("raw", "needle", () => { store.updateTurn(second.id, { assistantText: "A MESSAGE PERSISTED AFTER THE QUERY" }); });
  expect(joined).toBe(whole);
  expect(whole).not.toContain("A MESSAGE PERSISTED AFTER THE QUERY");
  expect(memory.search("needle", "raw", { cap: 100 })).toContain("A MESSAGE PERSISTED AFTER THE QUERY");
});
