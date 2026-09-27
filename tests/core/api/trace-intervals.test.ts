// Ticket 93 keeps complete independent addresses in comma lists, but removes fact intervals,
// negation walks and all-branch K.. navigation. Preserve the prior paging, frozen evidence,
// query batching, version tags and writer authority checks using explicit address lists.
import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, toolDefinitions, type ToolContext } from "../../source-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { AdmittedDreamerScenarios, createDreamerTrigger } from "../../admitted-dreamer-scenario.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";

const time = "2026-09-09T00:00:00Z";

function fullRead(tool: { execute(input: unknown): string }, address: string) {
  let page = tool.execute({ address, full: true, itemBudget: null });
  for (let cursor = /cursor=(\S+)/.exec(page)?.[1]; cursor; cursor = /cursor=(\S+)/.exec(page)?.[1])
    page = tool.execute({ address: `cursor=${cursor}`, itemBudget: null });
}
let memory: ReturnType<typeof sourceSeededMemory>, scenarios: AdmittedDreamerScenarios;
beforeEach(() => {
  scenarios = new AdmittedDreamerScenarios(async () => { throw new Error("these cases call no model"); });
  memory = sourceSeededMemory(":memory:", scenarios.agent);
});
afterEach(() => { memory.close(); });

/** One enrolled session with one Turn and `count` facts on it, in allocation order. */
function facts(count: number, projectName = "p") {
  const store = memory.store;
  const projectId = store.createProject({ name: projectName, declaredBy: "mark" }).id;
  const { id: sessionId } = store.createSession({ enrollmentChoice: true, host: "fake", projectId, startedAt: time, firstReplyAt: time });
  const turn = store.appendTurn({ sessionId, kind: "turn", userPrompt: "prompt", assistantText: "reply", startedAt: time });
  const user = store.listSourceEntries(sessionId, turn.id)[0]!;
  const committed = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    facts: Array.from({ length: count }, (_unused, i) => ({ turnId: turn.id, category: "observation" as const, actor: "user" as const,
      text: `fact ${i + 1}`, source: [`T${turn.id}#user`], entryIds: [user.id], createdAt: time })) });
  if (!committed.ok) throw new Error(committed.problems.join("; "));
  return { sessionId, turnId: turn.id, ids: committed.facts.map(f => f.id) };
}

async function updateKnowledge(path: { sessionId: number; branch: string; headTurnId: number }, factId: number,
  base: { knowledgeId: number; commit: number }, text: string) {
  const selectedEntries = memory.store.sourcePath(path.sessionId, path.branch, path.headTurnId);
  memory.selectEntries(path.sessionId, path.branch, selectedEntries.map(entry => entry.id));
  const target = { ...path, triggerEntryId: selectedEntries.at(-1)!.id };
  const trigger = createDreamerTrigger(memory, target, factId, base.commit, "session");
  let changed!: { knowledgeId: number; commit: number };
  const result = await scenarios.run(memory, target, input => {
    input.reportRequest({ fixture: "trace interval revision" });
    const trace = input.tools.find(tool => tool.name === "trace")!;
    const tag = `K${base.knowledgeId}#${memory.store.versionTag(base.knowledgeId, base.commit)}`;
    fullRead(trace, tag);
    const receipt = JSON.parse(input.tools.find(tool => tool.name === "memory")!.execute({ operations: [
      { op: "update", id: tag, text, category: "understanding", scope: "session", supports: [`F${factId}`], reason: "test", topics: [] },
      { op: "archive", id: `K${trigger.knowledgeId}#${memory.store.versionTag(trigger.knowledgeId, trigger.commit)}`, supports: [`F${factId}`], reason: "Retire the explicit interval trigger." },
    ], skipped: [] }));
    const item = receipt.committed.find((item: { knowledgeId: number }) => item.knowledgeId === base.knowledgeId)!;
    changed = { knowledgeId: item.knowledgeId, commit: memory.store.resolveVersionOrdinal(item.knowledgeId, Number(/@v(\d+)$/.exec(item.version)![1])) };
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Blockers: none");
    return { outcome: "success", output: "revision complete", request: { fixture: "trace interval revision" } };
  });
  expect(result.outcome).toBe("success");
  return changed;
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

test("93: complete fact addresses preserve request order, repeats and independent components", () => {
  const { ids } = facts(5);
  const record = (id: number) => memory.trace(`F${id}`);
  expect(memory.trace("F1,F3,F5")).toBe([1, 3, 5].map(record).join("\n"));
  expect(memory.trace("F4,F5,F1")).toBe([4, 5, 1].map(record).join("\n"));
  expect(memory.trace("F2,F3,F2,F2,F3")).toBe([2, 3, 2, 2, 3].map(record).join("\n"));
  expect(ids).toEqual([1, 2, 3, 4, 5]);
});

test("93: sparse existing facts stay readable; a missing explicit fact fails rather than silently skipping", () => {
  const { ids } = facts(5);
  expect(memory.trace("F1,F2,F4,F5")).toBe([1, 2, 4, 5].map(id => memory.trace(`F${id}`)).join("\n"));
  expect(ids).toHaveLength(5);
  expect(() => memory.trace("F999")).toThrow("fact F999 does not exist");
  expect(() => memory.trace("F1,F999,F2", { cap: 1 })).toThrow("fact F999 does not exist");
});

test("93: retired interval and walk forms fail before reading any fact, while a project name remains valid", () => {
  facts(3);
  const counter = countFactReads();
  try {
    for (const address of ["F9-F1", "F1-F9007199254740993", "F0-F9", "F01-F9", "F1-K9", "K1-K9", "T1-T9", "F1..", "K1.."]) {
      counter.reset();
      expect(() => memory.trace(address)).toThrow(/invalid (public )?trace address/);
      expect(() => memory.trace(`F1,${address},F2`, { cap: 1 })).toThrow(/invalid (public )?trace address/);
      expect(counter.records() + counter.queries()).toBe(0);
    }
  } finally { counter.restore(); }
  memory.store.createProject({ name: "trace-memory", declaredBy: "mark" });
  expect(() => memory.trace("trace-memory")).not.toThrow();
});

test("93: an explicit fact list materializes only the requested bodies", () => {
  const { ids } = facts(6);
  const counter = countFactReads();
  try {
    counter.reset();
    const list = memory.trace(ids.map(id => `F${id}`).join(","));
    expect(counter.records()).toBe(ids.length);
    expect(counter.queries()).toBe(0); // removed interval resolver is never called
    expect(list).toBe(ids.map(id => memory.trace(`F${id}`)).join("\n"));
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

test("93: a complete-address list pages by cap, completely and without duplicates", () => {
  const { ids } = facts(12);
  const address = ids.map(id => `F${id}`).join(",");
  const whole = memory.trace(address);
  expect(paged(address, () => {}, 3).joined).toBe(whole);
  for (const id of ids) expect(whole.split(`[F${id}]`)).toHaveLength(2);
  const repeated = `${address},F1,F2,F3`;
  expect(paged(repeated, () => {}, 1).joined).toBe(memory.trace(repeated));
});

test("93: first page of a fact list renders only that page; relations freeze in one batch", () => {
  const { ids } = facts(200);
  const address = ids.map(id => `F${id}`).join(",");
  const records = countFactReads(), relations = countRelationReads();
  try {
    records.reset(); relations.reset();
    const first = memory.trace(address, { cap: 1 });
    expect(first).toContain("[F1]");
    expect(first).not.toContain("[F2]");
    expect(records.queries()).toBe(0);
    expect(records.records()).toBe(1);
    expect(relations.single()).toBe(0);
    expect(relations.batched()).toBe(1);
    records.reset();
    memory.trace(address, { cap: ids.length * 3, maxTokens: 8000 });
    expect(records.records()).toBe(ids.length);
  } finally { records.restore(); relations.restore(); }
});

test("25d pagination: a fact relation or profile change between pages does not reach an established page", () => {
  const { sessionId, turnId, ids } = facts(4);
  const store = memory.store;
  const negate = () => {
    const user = store.listSourceEntries(sessionId, turnId)[0]!;
    const later = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
      facts: [{ turnId, category: "observation", actor: "user", text: "later correction", source: [`T${turnId}#user`], entryIds: [user.id], createdAt: time,
        negate: [{ target: `F${ids[2]!}`, strength: "strong" }] }] });
    if (!later.ok) throw new Error(later.problems.join("; "));
  };
  const relations = paged("F1,F2,F3,F4", negate);
  expect(relations.joined).toBe(relations.whole);
  expect(relations.whole).not.toContain("later correction");
  expect(memory.trace("F1,F2,F3,F4")).toContain(`inbound negate F${ids.length + 1} strong`);

  store.appendToolCall({ turnId, name: "tool", input: "{}", result: "head " + "value ".repeat(400) + " tail", status: "success" });
  const profile = paged(`T${turnId}#E1,F1,F2,F3,F4`, () => { memory.config.render.toolResultTokens = 1_000; }, 3);
  expect(profile.joined).toBe(profile.whole);
});

test("93: paged fact backlinks freeze their original knowledge selection and citations", () => {
  const { sessionId, turnId, ids } = facts(3);
  const path = { sessionId, headTurnId: turnId, branch: "main" };
  const created = memory.store.commitConsolidationRun({ path, run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "h1", author: "fake", text: "initial", category: "understanding", scope: "session",
      supports: [ids[1]!], reason: "before first page", topics: [], createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const { knowledgeId, commit } = created.committed[0]!;
  const address = "F1,F2,F3";
  const frozen = paged(address, () => {
    const updated = commitNoterKnowledge(memory.store, { path, run: { sessionId, branch: "main", createdAt: "later" },
      operations: [{ op: "update", knowledgeId, baseCommit: commit, text: "changed", category: "understanding", scope: "session",
        supports: [ids[2]!], reason: "later citation", topics: [], createdAt: "later" }] });
    expect(updated.ok).toBe(true);
  }, 1);
  expect(frozen.joined).toBe(frozen.whole);
  expect(frozen.joined).toContain("cited by v1; current v1");
  expect(frozen.joined).not.toContain("current v2");
  expect(memory.trace("F2,F3")).toContain("current v2");
});

test("93 pagination: a list cursor belongs to the session that made the read", () => {
  const first = facts(6, "one"), second = facts(6, "two");
  const manual = (sessionId: number, currentTurnId: number): ToolContext => ({ kind: "manual", sessionId, currentTurnId, branch: "main" });
  const mine = memory.tools(manual(first.sessionId, first.turnId))[0]!;
  const theirs = memory.tools(manual(second.sessionId, second.turnId))[0]!;
  const address = Array.from({ length: 12 }, (_unused, i) => `F${i + 1}`).join(",");
  const page = mine.execute({ address, cap: 2 });
  const cursor = /cursor=(\S+)/.exec(page)![1]!;
  expect(theirs.execute({ address, cursor })).toContain("rejected: unknown or expired cursor");
  expect(mine.execute({ address, cursor })).toContain("[F2]");
});

test("93: removed fact walks and K.. reject; exact versions and version ranges remain readable", async () => {
  const { sessionId, turnId, ids } = facts(3);
  const store = memory.store;
  const user = store.listSourceEntries(sessionId, turnId)[0]!;
  const later = store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId, category: "observation", actor: "user", text: "supersedes", source: [`T${turnId}#user`], entryIds: [user.id], createdAt: time,
      negate: [{ target: `F${ids[0]!}`, strength: "strong" }] }] });
  if (!later.ok) throw new Error(later.problems.join("; "));
  expect(() => memory.trace("F1..")).toThrow(/invalid public trace address/);
  expect(memory.trace("F1")).toContain(`inbound negate F${ids.length + 1} strong`);

  const created = store.commitConsolidationRun({ path: { sessionId, headTurnId: turnId, branch: "main" },
    run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "h1", author: "fake", text: "first", category: "understanding", scope: "session",
      supports: [ids[0]!], reason: "test", topics: [], createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const { knowledgeId, commit } = created.committed[0]!;
  const updated = await updateKnowledge({ sessionId, headTurnId: turnId, branch: "main" }, ids[0]!, { knowledgeId, commit }, "second");
  expect(memory.trace(`K${knowledgeId}@v1..v2`)).toContain("second");
  expect(() => memory.trace(`K${knowledgeId}..`)).toThrow(/invalid public trace address/);
  const description = toolDefinitions.find(t => t.name === "trace")!.description;
  for (const form of ["F81,F90,F95", "K1@v2..v5"]) expect(description).toContain(form);
  expect(description).toContain("Fact intervals, negation walks and all-branch K.. are not public addresses");
  expect(description).toContain("cap counts output lines (default 100)"); // the existing unit, documented as it is
});

test("25d/92: mixed batch reads keep exact tags without granting manual update authority", async () => {
  const { sessionId, turnId, ids } = facts(3);
  const store = memory.store;
  const path = { sessionId, headTurnId: turnId, branch: "main" };
  const created = store.commitConsolidationRun({ path, run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    operations: [{ op: "create", handle: "h1", author: "fake", text: "first", category: "understanding", scope: "session",
      supports: [ids[0]!], reason: "test", topics: [], createdAt: time }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const { knowledgeId, commit } = created.committed[0]!;
  const [trace, , , knowledge] = memory.tools({ kind: "manual", sessionId, currentTurnId: turnId, branch: "main" });
  // The commit this run read at its start is superseded while the run is open.
  const superseded = await updateKnowledge(path, ids[0]!, { knowledgeId, commit }, "second");
  const tip = superseded.commit;
  const tag = `K${knowledgeId}#${store.versionTag(knowledgeId, tip)}`;
  const update = (base: number) => knowledge!.execute({ operations: [{ op: "update", id: `K${knowledgeId}#${store.versionTag(knowledgeId, base)}`, text: "third",
    category: "understanding", scope: "session", supports: [`F${ids[0]!}`], reason: "test", topics: [] }], skipped: [] });
  expect(update(tip)).toContain("update belongs to the Dreamer"); // authority is independent of read completion
  const read = trace!.execute({ address: `K${knowledgeId}@v2,F1,F2,F3` });
  expect(read).toContain("[F2]"); expect(read).toContain(`[${tag}]`);
  expect(update(tip)).toContain("update belongs to the Dreamer"); // complete reads do not grant manual maintenance authority
});
