// Ticket 25d "Batch trace: fact intervals and documented comma lists". The read façade already
// accepted a comma list; this file pins that list's promoted contract (request order, repeats kept,
// kinds mixable) and the one new form: `F81-F90`, the inclusive fact-id interval. Amendment 1 of
// ticket 25 is what the hyphen is for — `..` keeps its single meaning, so `F81..` still walks later
// strong negations and `K1@57..K1@61` still diffs two commits, and both are asserted here beside the
// new grammar. An interval reads the facts that exist in the range: it costs what they cost, never
// what the numeric span suggests, and it answers an empty range with an empty result rather than with
// a missing-record diagnostic per integer.
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, toolDefinitions, type ToolContext } from "../../source-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";

const time = "2026-09-09T00:00:00Z";
let memory: ReturnType<typeof sourceSeededMemory>;
beforeEach(() => { memory = sourceSeededMemory(":memory:", async () => { throw new Error("these cases call no model"); }); });
afterEach(() => { memory.close(); });

/** One enrolled session with one Turn and `count` facts on it, in allocation order. */
function facts(count: number, projectName = "p") {
  const store = memory.store;
  const projectId = store.createProject({ name: projectName, declaredBy: "mark" }).id;
  const { id: sessionId } = store.createSession({ enrollmentChoice: true, host: "fake", projectId, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId, kind: "turn", userPrompt: "prompt", assistantText: "reply", startedAt: time });
  const committed = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    facts: Array.from({ length: count }, (_unused, i) => ({ turnId: turn.id, category: "observation" as const, actor: "user" as const,
      text: `fact ${i + 1}`, source: [`T${turn.id}#user`], createdAt: time })) });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  return { sessionId, turnId: turn.id, ids: committed.facts.map(f => f.id) };
}

/** Count the fact rows a read materializes: the range query's ids and every record it then renders.
 * A read that probes the numeric span, or allocates by it, moves these counters with the span. */
function countFactReads() {
  const prototype = Store.prototype;
  const one = prototype.getFact, range = prototype.factMetadataInRange;
  let records = 0, queries = 0;
  prototype.getFact = function (this: Store, id: number) { records++; return one.call(this, id); };
  prototype.factMetadataInRange = function (this: Store, from: number, to: number) { queries++; return range.call(this, from, to); };
  return { records: () => records, queries: () => queries, reset: () => { records = 0; queries = 0; },
    restore: () => { prototype.getFact = one; prototype.factMetadataInRange = range; } };
}

/** Count the two ways a fact's relations are read: once for a fact whose line is being printed now,
 * and once for the whole remainder a query freezes. */
function countRelationReads() {
  const prototype = Store.prototype as { listFactRelations: Store["listFactRelations"]; listFactRelationsOf: Store["listFactRelationsOf"] };
  const one = prototype.listFactRelations, many = prototype.listFactRelationsOf;
  let single = 0, batched = 0;
  prototype.listFactRelations = function (this: Store, id: number) { single++; return one.call(this, id); };
  prototype.listFactRelationsOf = function (this: Store, ids: number[]) { batched++; return many.call(this, ids); };
  return { single: () => single, batched: () => batched, reset: () => { single = 0; batched = 0; },
    restore: () => { prototype.listFactRelations = one; prototype.listFactRelationsOf = many; } };
}

test("25d goldens: single, list, interval and mixed expressions read the same records, in the order asked", () => {
  const { ids } = facts(5);
  const record = (id: number) => memory.trace(`F${id}`);
  const group = (ids: number[]) => `[T1] ${time} (selected facts)\n${ids.map(record).join("\n")}`;
  expect(memory.trace("F2-F4")).toBe(group([2, 3, 4]));
  expect(memory.trace("F2-F2")).toBe(group([2])); // a selected interval is a collection
  expect(memory.trace("F1,F3,F5")).toBe([1, 3, 5].map(record).join("\n"));
  expect(memory.trace("F4-F5,F1")).toBe([group([4, 5]), record(1)].join("\n")); // component order, not id order
  expect(memory.trace("F2-F3,F2,F2-F3")).toBe([group([2, 3]), record(2), group([2, 3])].join("\n")); // repeats are kept, not deduplicated
  expect(ids).toEqual([1, 2, 3, 4, 5]);
});

test("25d goldens: sparse, empty and very wide intervals cover the records that exist", () => {
  const { ids } = facts(5);
  memory.store.db.exec("DELETE FROM facts WHERE id = 3"); // a gap inside the range
  expect(memory.store.factMetadataInRange(1, 5).map(fact => fact.id)).toEqual([1, 2, 4, 5]);
  const record = (id: number) => memory.trace(`F${id}`);
  const grouped = `[T1] ${time} (selected facts)\n${[1, 2, 4, 5].map(record).join("\n")}`;
  expect(memory.trace("F1-F5")).toBe(grouped); // no missing-record diagnostic for F3
  expect(memory.trace("F3-F3")).toBe("F3-F3: no facts exist in this range");
  expect(memory.trace("F80-F90")).toBe("F80-F90: no facts exist in this range");
  expect(memory.trace("F1-F1000000000")).toBe(grouped);
  // An empty component disappears neither itself nor its neighbours from a mixed expression.
  expect(memory.trace("F1,F6-F9,F2")).toBe([record(1), "F6-F9: no facts exist in this range", record(2)].join("\n"));
  expect(ids).toHaveLength(5);
  // An explicit individual id keeps its own missing-record diagnostic.
  expect(() => memory.trace("F3")).toThrow("fact F3 does not exist");
});

test("25d validation: reversed, unsafe, padded and non-fact intervals are rejected by name, before anything is read", () => {
  facts(3);
  const counter = countFactReads();
  try {
    for (const [address, reason] of [["F9-F1", "endpoints ascend"], ["F1-F9007199254740993", "endpoints are safe integers"],
      ["F0-F9", "endpoints are positive integers without leading zeros"], ["F01-F9", "endpoints are positive integers without leading zeros"],
      ["F1-K9", "only fact-id intervals exist"], ["K1-K9", "only fact-id intervals exist"], ["T1-T9", "only fact-id intervals exist"]] as const) {
      counter.reset();
      expect(() => memory.trace(address)).toThrow(`invalid trace interval ${address}: ${reason}`);
      expect(() => memory.trace(`F1,${address},F2`, { cap: 1 })).toThrow(`invalid trace interval ${address}`);
      // Nothing was read and, because the refusal is a throw and not a page, no cursor was minted:
      // the expression is parsed whole before any continuation state can exist.
      expect(counter.records() + counter.queries()).toBe(0);
    }
  } finally { counter.restore(); }
  // An address that is not address-shaped is not an interval: a hyphenated project name still resolves.
  memory.store.createProject({ name: "trace-memory", declaredBy: "mark" });
  expect(() => memory.trace("trace-memory")).not.toThrow();
});

test("25d bounds: a 10^9-wide interval costs what its facts cost, in one range query", () => {
  const { ids } = facts(6);
  const counter = countFactReads();
  try {
    counter.reset();
    const started = performance.now();
    const wide = memory.trace("F1-F1000000000");
    const elapsed = performance.now() - started;
    // One bounded query selects the existing ids; each of them is rendered once. A read that walked
    // or allocated the span would move both numbers with the span, not with the six facts.
    expect(counter.queries()).toBe(1);
    expect(counter.records()).toBe(ids.length);
    expect(elapsed).toBeLessThan(1_000);
    expect(wide).toBe(memory.trace(`F1-F${ids.length}`));
    // Ten times the span, the same cost.
    counter.reset();
    expect(memory.trace("F1-F1000000000")).toBe(wide);
    const narrow = counter.records();
    counter.reset();
    memory.trace("F1-F9000000000");
    expect(counter.records()).toBe(narrow);
    expect(counter.queries()).toBe(1);
  } finally { counter.restore(); }
});

/** Page one read a cap at a time, run `between` after the first page, and return the joined pages
 * beside what the same read printed whole (22c's continuation idiom, applied to trace). */
function paged(address: string, between: () => void, cap = 2) {
  // Only this page's own receipt is stripped: a component of a mixed read may carry receipts of its
  // own (a Turn's omitted calls), and those belong to the content the pages must reproduce.
  const body = (text: string) => text.replace(/\n\nReceipts:\ncursor=\S+$/, "");
  const whole = body(memory.trace(address));
  let page = memory.trace(address, { cap });
  const parts = [body(page)];
  let wrote = false;
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1]) {
    if (!wrote) {
      expect(memory.store.db.isTransaction).toBe(false); // no transaction is held while the caller decides
      between(); wrote = true;
    }
    page = memory.trace(`cursor=${cursor}`);
    parts.push(body(page));
  }
  expect(wrote).toBe(true);
  return { joined: parts.join("\n"), whole };
}

test("25d pagination: a wide interval pages by cap, completely and without duplicates", () => {
  const { ids } = facts(12);
  const whole = memory.trace("F1-F1000000000");
  const { joined } = paged("F1-F1000000000", () => {}, 3);
  expect(joined).toBe(whole);
  for (const id of ids) expect(whole.split(`[F${id}]`)).toHaveLength(2); // each record once, none lost
  // The remainder of an address is never dropped: one line at a time reaches the same whole.
  expect(paged("F1-F12,F1-F3", () => {}, 1).joined).toBe(memory.trace("F1-F12,F1-F3"));
});

test("a first page of an interval costs the page: one record rendered, one batched relation snapshot", () => {
  const { ids } = facts(200);
  const records = countFactReads(), relations = countRelationReads();
  try {
    records.reset(); relations.reset();
    const first = memory.trace(`F1-F${ids.length}`, { cap: 1 });
    expect(first).toContain(`[T1] ${time} (selected facts)`); // cap=1 admits the group heading first
    expect(first).not.toContain("[F2]"); // the page, and only the page, was formatted
    // One range query names the interval's facts; exactly one body is read and rendered.
    // All relations freeze in one batch under the transaction, before any rendering.
    // The 199 deferred bodies cost no record read at all.
    expect(records.queries()).toBe(1);
    expect(records.records()).toBe(1);
    expect(relations.single()).toBe(0);
    expect(relations.batched()).toBe(1);
    // A cap wide enough for every line is what it always was: every record in the interval.
    records.reset();
    memory.trace(`F1-F${ids.length}`, { cap: ids.length * 3, maxTokens: 8000 });
    expect(records.records()).toBe(ids.length);
  } finally { records.restore(); relations.restore(); }
});

test("25d pagination: a fact negated, a knowledge marked or a profile changed between pages does not reach an established page", () => {
  const { sessionId, turnId, ids } = facts(4);
  const store = memory.store;
  const negate = () => {
    const later = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
      facts: [{ turnId, category: "observation", actor: "user", text: "later correction", source: [`T${turnId}#user`], createdAt: time,
        negate: [{ target: `F${ids[2]!}`, strength: "strong" }] }] });
    if (!later.ok) throw new Error(later.problems.join("; "));
  };
  const relations = paged("F1-F4", negate);
  expect(relations.joined).toBe(relations.whole);
  expect(relations.whole).not.toContain("later correction");
  expect(memory.trace("F1-F4")).toContain(`inbound negate F${ids.length + 1} strong`); // the write is real

  const consolidated = store.commitConsolidationRun({ path: { sessionId, headTurnId: turnId, branch: "main" },
    run: { kind: "consolidation", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "h1", author: "fake", text: "conclusion", category: "mechanism", scope: "session",
      supports: [ids[0]!], reason: "test", topics: [], createdAt: time }] });
  if (!consolidated.ok) throw new Error(consolidated.problems.join("; "));
  const knowledgeId = consolidated.committed[0]!.knowledgeId;
  const marks = paged(`K${knowledgeId}@${consolidated.committed[0]!.commit},F1-F4`, () => { memory.mark(knowledgeId, "flagged"); }, 3);
  expect(marks.joined).toBe(marks.whole);
  expect(marks.whole).not.toContain("flagged");
  expect(memory.trace(`K${knowledgeId}@${consolidated.committed[0]!.commit}`)).toContain("flagged");

  store.appendToolCall({ turnId, name: "tool", input: "{}", result: "head " + "value ".repeat(400) + " tail", status: "success" });
  const profile = paged(`T${turnId},F1-F4`, () => { memory.config.render.toolResultTokens = 1_000; }, 3);
  expect(profile.joined).toBe(profile.whole);
});

test("25d pagination: an interval cursor belongs to the session that made the read", () => {
  const first = facts(6, "one"), second = facts(6, "two");
  const manual = (sessionId: number, currentTurnId: number): ToolContext => ({ kind: "manual", sessionId, currentTurnId, branch: "main" });
  const mine = memory.tools(manual(first.sessionId, first.turnId))[0]!;
  const theirs = memory.tools(manual(second.sessionId, second.turnId))[0]!;
  const page = mine.execute({ address: "F1-F12", cap: 2 });
  const cursor = /cursor=(\S+)/.exec(page)![1]!;
  expect(theirs.execute({ address: "F1-F12", cursor })).toContain("rejected: unknown or expired cursor");
  expect(mine.execute({ address: "F1-F12", cursor })).toContain("[F2]");
});

test("25d: the `..` grammars keep their single meaning beside the interval, and the description names both", () => {
  const { sessionId, turnId, ids } = facts(3);
  const store = memory.store;
  const later = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId, category: "observation", actor: "user", text: "supersedes", source: [`T${turnId}#user`], createdAt: time,
      negate: [{ target: `F${ids[0]!}`, strength: "strong" }] }] });
  if (!later.ok) throw new Error(later.problems.join("; "));
  const walk = memory.trace("F1..");
  expect(walk).toContain("supersedes"); // the negation walk, not an interval
  expect(walk).not.toContain(`[F${ids[1]!}]`);
  expect(memory.trace("F1-F1")).not.toContain("supersedes"); // the interval, not a walk

  const created = store.commitConsolidationRun({ path: { sessionId, headTurnId: turnId, branch: "main" },
    run: { kind: "consolidation", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "h1", author: "fake", text: "first", category: "mechanism", scope: "session",
      supports: [ids[0]!], reason: "test", topics: [], createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const { knowledgeId, commit } = created.committed[0]!;
  const updated = store.commitConsolidationRun({ path: { sessionId, headTurnId: turnId, branch: "main" },
    run: { kind: "consolidation", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "update", knowledgeId, baseCommit: commit, text: "second", category: "mechanism", scope: "session",
      supports: [ids[0]!], reason: "test", topics: [], createdAt: time }] });
  if (!updated.ok) throw new Error(updated.problems.join("; "));
  const diff = memory.trace(`K${knowledgeId}@${commit}..K${knowledgeId}@${updated.committed[0]!.commit}`);
  expect(diff).toContain("{+second+}");
  expect(memory.trace(`K${knowledgeId}..`)).toContain("commit tree (all branches)");

  const description = toolDefinitions.find(t => t.name === "trace")!.description;
  for (const form of ["F81,F90,F95", "F81-F90", "F81-F90,F95", "F<n>..", "K1@57..K1@61"]) expect(description).toContain(form);
  expect(description).toContain("cap counts output lines (default 100)"); // the existing unit, documented as it is
});

test("25d accounting: a mixed batch read is recorded whole and keeps knowledge read-base tracking", () => {
  const { sessionId, turnId, ids } = facts(3);
  const store = memory.store;
  const path = { sessionId, headTurnId: turnId, branch: "main" };
  const created = store.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "h1", author: "fake", text: "first", category: "mechanism", scope: "session",
      supports: [ids[0]!], reason: "test", topics: [], createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const { knowledgeId, commit } = created.committed[0]!;
  const [trace, , , knowledge] = memory.tools({ kind: "manual", sessionId, currentTurnId: turnId, branch: "main" });
  // The commit this run read at its start is superseded while the run is open.
  const superseded = store.commitConsolidationRun({ path, run: { kind: "consolidation", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "update", knowledgeId, baseCommit: commit, text: "second", category: "mechanism", scope: "session",
      supports: [ids[0]!], reason: "test", topics: [], createdAt: time }] });
  if (!superseded.ok) throw new Error(superseded.problems.join("; "));
  const tip = superseded.committed[0]!.commit;
  const update = (base: number) => knowledge!.execute({ operations: [{ op: "update", id: `K${knowledgeId}@${base}`, text: "third",
    category: "mechanism", scope: "session", supports: [`F${ids[0]!}`], reason: "test", topics: [] }], skipped: [] });
  expect(update(tip)).toContain("rejected:"); // the new tip has not been read by this run
  const read = trace!.execute({ address: `K${knowledgeId}@${tip},F1-F3` });
  expect(read).toContain("[F2]"); expect(read).toContain(`[K${knowledgeId}@${tip}]`);
  expect(update(tip)).not.toContain("rejected:"); // the knowledge component of a mixed read still tracks the base
});
