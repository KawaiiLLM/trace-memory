// 22c "Paged search": a continuation is the query's own snapshot. 22c already froze the hit
// addresses and the commit graph; these cases pin the mutable state the lines themselves read — a
// fact's relations, a knowledge commit's marks, and the Turn occurrences an assembled trace shows.
// Writing any of them between two pages must not change a page the query already established.
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";

const time = "2026-09-09T00:00:00Z";
let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => { memory = sourceSeededMemory(":memory:", async () => { throw new Error("these cases call no model"); }); });
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
function paged(scope: "facts" | "knowledge" | "raw", query: string, between: () => void) {
  const body = (text: string) => text.split("\n\nReceipts:")[0]!;
  const fields = scope === "knowledge" ? { fields: ["text", "marks"] as const } : {};
  const whole = body(memory.search(query, scope, { cap: 100, ...fields }));
  const first = memory.search(query, scope, { cap: 1, ...fields });
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

test("22c: a knowledge commit marked between two pages does not carry the mark into the established page", () => {
  const { store, sessionId, turn } = session();
  const note = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: time }] });
  if (!note.ok) throw new Error(note.problems.join("; "));
  const consolidated = store.commitConsolidationRun({ path: { sessionId, headTurnId: turn.id, branch: "main" },
    run: { kind: "consolidation", sessionId, branch: "main", createdAt: time },
    operations: [1, 2].map(i => ({ op: "create" as const, handle: `h${i}`, author: "fake", text: `needle ${i}`,
      category: "mechanism" as const, scope: "session" as const, supports: [note.facts[0]!.id], reason: "test", topics: [], createdAt: time })) });
  if (!consolidated.ok) throw new Error(consolidated.problems.join("; "));
  const { joined, whole } = paged("knowledge", "needle", () => { memory.mark(consolidated.committed[1]!.knowledgeId, "flagged"); });
  expect(joined).toBe(whole);
  expect(whole).not.toContain("flagged");
  // The mark is real: a fresh query after the paging shows it.
  expect(memory.search("needle", "knowledge", { cap: 100, fields: ["text", "marks"] })).toContain("flagged");
});

test("41 repair: revision marks stay exact on first and continuation pages and freeze after the query", () => {
  const { store, sessionId, turn } = session();
  const path = { sessionId, headTurnId: turn.id, branch: "main" };
  const run = { kind: "consolidation" as const, sessionId, branch: "main", createdAt: time };
  const note = store.commitNotingRun({ run: { ...run, kind: "manual" },
    facts: [{ turnId: turn.id, category: "decision", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: time }] });
  if (!note.ok) throw new Error(note.problems.join("; "));
  const created = store.commitConsolidationRun({ path, run, operations: [{ op: "create", handle: "h1", author: "fake", text: "needle old",
    category: "mechanism", scope: "session", supports: [note.facts[0]!.id], reason: "old", topics: [], createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const oldCommit = created.committed[0]!.commit, knowledgeId = created.committed[0]!.knowledgeId;
  const updated = store.commitConsolidationRun({ path, run, operations: [{ op: "update", knowledgeId, baseCommit: oldCommit, text: "needle new",
    category: "mechanism", scope: "session", supports: [note.facts[0]!.id], reason: "new", topics: [], createdAt: time }] });
  if (!updated.ok) throw new Error(updated.problems.join("; "));
  const newCommit = updated.committed[0]!.commit;
  memory.mark(`K${knowledgeId}@${oldCommit}`, "flagged", path);

  const options = { sessionId, headTurnId: turn.id, branch: "main", versions: "all" as const, fields: ["text", "marks"] as const };
  expect(memory.search("needle old", "knowledge", options)).toContain("flagged");
  const second = store.commitConsolidationRun({ path, run, operations: [{ op: "create", handle: "h2", author: "fake", text: "needle second",
    category: "mechanism", scope: "session", supports: [note.facts[0]!.id], reason: "second", topics: [], createdAt: time }] });
  if (!second.ok) throw new Error(second.problems.join("; "));
  const selected = second.committed[0]!;
  const whole = memory.search("needle", "knowledge", options);
  const first = memory.search("needle", "knowledge", { ...options, cap: 1 });
  expect(first).toContain(`[K${knowledgeId}@${newCommit}]`);
  expect(first).not.toContain("flagged");
  const cursor = /cursor=(\S+)/.exec(first)![1]!;
  memory.mark(`K${selected.knowledgeId}@${selected.commit}`, "verified", path);
  const next = memory.search("", "knowledge", { cursor, sessionId });
  expect(`${first.split("\n\nReceipts:")[0]}\n${next.split("\n\nReceipts:")[0]}`).toBe(whole.split("\n\nReceipts:")[0]);
  expect(next).toContain(`[K${selected.knowledgeId}@${selected.commit}]`);
  expect(next).not.toContain("flagged");
  expect(next).not.toContain("verified");
  expect(memory.search("needle second", "knowledge", options)).toContain("verified");
});

test("22c: a message completed between two pages does not join the established page's assembled trace", () => {
  const { store, sessionId, turn } = session();
  const second = store.appendTurn({ sessionId, parentTurnId: turn.id, kind: "turn", userPrompt: "needle second", startedAt: time });
  const { joined, whole } = paged("raw", "needle", () => { store.updateTurn(second.id, { assistantText: "A MESSAGE PERSISTED AFTER THE QUERY" }); });
  expect(joined).toBe(whole);
  expect(whole).not.toContain("A MESSAGE PERSISTED AFTER THE QUERY");
  expect(memory.search("needle", "raw", { cap: 100 })).toContain("A MESSAGE PERSISTED AFTER THE QUERY");
});
