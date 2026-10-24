import { afterEach, expect, test, vi } from "vitest";
import { sourceSeededMemory, seedSourceEntry, recorded, type NotingAgentInput } from "../../source-fixture.ts";
import { readFacade } from "../../../src/core/api/read.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { validateConfig, toolDefinitions } from "../../../src/core/api/index.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { withRetrievalPolicy } from "../../../src/core/render/retrieval-policy.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { pricedToolDefinitions, notingToolDefinitions } from "../../../src/core/api/tools.ts";
import { facts } from "../../support/seed.ts";
import { submitEmpty, largestTaskPromptTokens } from "../../support/noter.ts";

const memories: ReturnType<typeof sourceSeededMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
function fixture(native = true) {
  const inputs: NotingAgentInput[] = [];
  const memory = sourceSeededMemory(":memory:", async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ material: input.text });
    if (input.kind !== "noting") throw new Error("unexpected Dreaming");
    if (input.task === "extract-facts") inputs.push(input);
    submitEmpty(input);
    return { outcome: "success", output: "done", request: { material: input.text } };
  });
  memories.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "material", declaredBy: "mark" });
  const session = store.createSession({ host: "pi:material", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "preceding evidence", startedAt: "now" });
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const select = () => memory.selectEntries(session.id, "main", store.listSourceEntries(session.id).map(e => e.id));
  if (native) select();
  const entries = store.sourcePath(session.id, "main", turn.id).map(e => e.id);
  const published = store.commitNotingRun({ run: { kind: "noting", sessionId: session.id, branch: "main", createdAt: "now" },
    facts: [{ turnId: turn.id, text: "Earlier evidence remains citable", source: [`T${turn.id}#E1`], createdAt: "now", entryIds: entries }], entryIds: entries });
  if (!published.ok) throw new Error(published.problems.join("; "));
  const fact = published.facts[0]!.id;
  return { memory, store, session, turn, target, fact, inputs, select };
}

test("ticket92material borrowed active target keeps original harness through rewind and reactivation", async () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "assistant", "closed Pi evidence");
  f.select();
  const all = f.store.sourcePath(f.session.id, "main", f.turn.id).map(entry => entry.id);
  f.store.setCurrentPath(f.session.id, "main", f.turn.id, "target-lineage");
  const executor = f.store.createSession({ host: "cc:executor", projectId: f.session.projectId, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  f.store.closeSession(f.session.id);
  f.memory.selectEntries(f.session.id, "rewound", [all[0]!]);
  f.store.setCurrentPath(f.session.id, "rewound", f.turn.id, "target-lineage");
  const input = { ...f.target, borrowed: true, executorSessionId: executor.id };
  expect((await f.memory.noting(input)).outcome).toBe("dropped");
  expect(f.inputs).toHaveLength(0);
  f.store.setCurrentPath(f.session.id, "main", f.turn.id, "target-lineage");
  expect((await f.memory.noting(input)).outcome).toBe("success");
  expect(f.inputs).toHaveLength(1);
  expect(f.inputs[0]!.material.entries.map(entry => entry.id)).toEqual([all[1]!]);
  expect(f.inputs[0]!.text).toContain("Target session agent: Pi agent");
});

test("133: Noter hydrates selected Raw and reachable user context, never processed assistant history", () => {
  const f = fixture();
  for (let index = 0; index < 100; index++) seedSourceEntry(f.memory, f.turn.id, "assistant", `processed ${index}`);
  f.select();
  const older = f.store.sourcePath(f.session.id, "main", f.turn.id).map(entry => entry.id);
  const result = f.store.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: "now" }, facts: [], entryIds: older });
  if (!result.ok) throw new Error(result.problems.join("; "));
  seedSourceEntry(f.memory, f.turn.id, "assistant", "new evidence"); f.select();
  const raw = vi.spyOn(f.store, "getSourceEntry"), turns = vi.spyOn(f.store, "getTurn");
  const snapshots = vi.spyOn(f.store, "pathSnapshot"), statements = vi.spyOn(f.store.db, "prepare");
  const start = performance.now();
  const frozen = freezeNoting(f.store, { ...f.target }, f.memory.config);
  const elapsed = performance.now() - start;
  expect(frozen.entries).toHaveLength(1);
  const processedAssistants = new Set(older.slice(1));
  expect(raw.mock.calls.some(([id]) => processedAssistants.has(id))).toBe(false);
  expect(raw.mock.calls.map(([id]) => id)).toEqual([frozen.entries[0]!.id, older[0]!]);
  expect(turns).toHaveBeenCalledTimes(1);
  expect(snapshots.mock.calls.map(([path, endpoint]) => ({ path, endpoint }))).toEqual([
    { path: f.target, endpoint: undefined }, { path: f.target, endpoint: frozen.entries[0]!.id },
  ]);
  const pathBuilds = statements.mock.calls.filter(([sql]) => sql.includes("SELECT j.position, j.entry_id, e.id AS owned_id"));
  expect(pathBuilds).toHaveLength(1); // one complete cold path view, reused by the endpoint snapshot
  const metadataReads = () => statements.mock.calls.filter(([sql]) => sql.startsWith("SELECT id, session_id, native_lineage, native_id, turn_id, entry_ordinal, addresses, digest FROM source_entries"));
  expect(metadataReads()).toHaveLength(2); // pending discovery and ordered metadata, reused by compact
  const secondRaw = raw.mock.calls.length;
  snapshots.mockClear(); statements.mockClear(); raw.mockClear();
  freezeNoting(f.store, { ...f.target }, f.memory.config);
  expect(statements.mock.calls.filter(([sql]) => sql.includes("SELECT j.position, j.entry_id, e.id AS owned_id"))).toHaveLength(0);
  expect(raw.mock.calls).toHaveLength(secondRaw);
  expect(metadataReads()).toHaveLength(2);
  console.info(JSON.stringify({ materialPreparationMs: elapsed, priorEntries: older.length, rawReads: raw.mock.calls.length, turnReads: turns.mock.calls.length }));
});

test("ticket92material capacity shrinking reuses metadata and Raw views but rebinds each endpoint", () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "user", "another historical human message");
  seedSourceEntry(f.memory, f.turn.id, "user", "latest historical human message");
  seedSourceEntry(f.memory, f.turn.id, "assistant", "processed assistant history");
  const processedAssistant = f.store.listSourceEntries(f.session.id, f.turn.id).at(-1)!.id;
  f.select();
  recorded(f.memory, f.session.id, "main", f.turn.id);
  for (let index = 0; index < 6; index++) seedSourceEntry(f.memory, f.turn.id, "assistant", `entry-${index} ${"words ".repeat(80)}`);
  f.select();
  const config = { ...f.memory.config, compaction: { ...f.memory.config.compaction, factsTokens: 1 } };
  const complete = freezeNoting(f.store, { ...f.target }, config);
  const batchIds = new Set(complete.entries.map(entry => entry.id));
  const fixed = tokens(withRetrievalPolicy(loadPrompt("noting.md"), canonicalToolNames)) + largestTaskPromptTokens() + tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, canonicalToolNames)));
  const historicalUsers = f.store.sourcePath(f.session.id, "main", f.turn.id)
    .filter(entry => !batchIds.has(entry.id) && entry.addresses.some(address => /#user$/.test(address)))
    .map(entry => entry.id);
  const raw = vi.spyOn(f.store, "getSourceEntry"), snapshots = vi.spyOn(f.store, "pathSnapshot");
  const statements = vi.spyOn(f.store.db, "prepare");
  const reduced = freezeNoting(f.store, { ...f.target, capacity: {
    inputTokens: fixed + tokens(complete.prepared!.text) - 80 } }, config);
  expect(reduced.entries.length).toBeLessThan(complete.entries.length);
  expect(reduced.entries.length).toBeGreaterThan(0);
  expect(reduced.prepared!.selectedEntryIds).toEqual(reduced.entries.map(entry => entry.id));
  const batchReads = raw.mock.calls.filter(([id]) => batchIds.has(id)).map(([id]) => id);
  expect(batchReads).toEqual([...batchIds]);
  expect(new Set(batchReads).size).toBe(batchReads.length);
  expect(raw.mock.calls.filter(([id]) => !batchIds.has(id)).map(([id]) => id)).toEqual(historicalUsers);
  expect(raw.mock.calls.some(([id]) => id === processedAssistant)).toBe(false);
  const endpoints = snapshots.mock.calls.map(([, endpoint]) => endpoint).filter(id => id !== undefined);
  expect(endpoints[0]).toBe(complete.entries.at(-1)!.id);
  expect(endpoints.at(-1)).toBe(reduced.entries.at(-1)!.id);
  expect(reduced.prepared!.text).not.toContain("entry-5");
  expect(statements.mock.calls.filter(([sql]) => sql.startsWith("SELECT id, session_id, native_lineage, native_id, turn_id, entry_ordinal, addresses, digest FROM source_entries"))).toHaveLength(2);
});

test("133: fresh receipt-only temporary context trims before rejecting an exact pending batch", () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "user", "historical context ".repeat(300));
  f.select();
  recorded(f.memory, f.session.id, "main", f.turn.id);
  seedSourceEntry(f.memory, f.turn.id, "assistant", "pending reply");
  f.select();
  const config = { ...f.memory.config, compaction: { ...f.memory.config.compaction, factsTokens: 1, temporaryTokens: 100, pointerTokens: 100 } }; // 165
  const input = { ...f.target };
  const complete = freezeNoting(f.store, input, config);
  expect(complete.prepared!.material.earlierUsers).toEqual([]);
  expect(complete.prepared!.material.factTitles).toEqual([]);
  expect(complete.prepared!.material.receipts.join("\n")).toContain("user");
  const withoutTemporary = freezeNoting(f.store, input,
    { ...config, compaction: { ...config.compaction, temporaryTokens: 0, pointerTokens: 0 } });
  const fixed = tokens(withRetrievalPolicy(loadPrompt("noting.md"), canonicalToolNames)) + largestTaskPromptTokens() + tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, canonicalToolNames)));
  const inputTokens = fixed + tokens(withoutTemporary.prepared!.text);
  expect(fixed + tokens(complete.prepared!.text)).toBeGreaterThan(inputTokens);
  const entryIds = complete.entries.map(entry => entry.id);
  const reduced = freezeNoting(f.store, { ...input, boundary: { exactEntryIds: entryIds },
    capacity: { inputTokens } }, config);
  expect(reduced.entries.map(entry => entry.id)).toEqual(entryIds);
  expect(reduced.prepared!.selectedEntryIds).toEqual(entryIds);
  expect(reduced.prepared!.text).toBe(withoutTemporary.prepared!.text);
  expect(f.store.pendingEntries(f.session.id, "main", f.turn.id).map(entry => entry.id)).toEqual(entryIds);
});

test("ticket92material hard input capacity rejects before invoking the worker and leaves Raw pending", async () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "assistant", "new evidence"); f.select();
  const pending = f.store.pendingEntries(f.session.id, "main", f.turn.id).map(entry => entry.id);
  await expect(f.memory.noting({ ...f.target, capacity: { inputTokens: 1 } })).rejects.toThrow(/Noting capacity/);
  expect(f.inputs).toEqual([]);
  expect(f.store.pendingEntries(f.session.id, "main", f.turn.id).map(entry => entry.id)).toEqual(pending);
});

test("ticket92material legacy no-path endpoint preserves existing ordered sourcePath semantics", () => {
  const f = fixture(false);
  seedSourceEntry(f.memory, f.turn.id, "assistant", "legacy first");
  seedSourceEntry(f.memory, f.turn.id, "assistant", "legacy later");
  const sequence = f.store.sourcePath(f.session.id, "main", f.turn.id);
  const result = readFacade(f.store, f.memory.config).compact(f.session.id, "main", f.turn.id, [], false,
    { endpointEntryId: sequence[1]!.id, processedRawRefill: false });
  if ("native" in result) throw new Error("unexpected fallback");
  expect(result.supplied.entries.map(entry => entry.id)).toEqual([sequence[1]!.id]);
  expect(result.supplied.factIds).toContain(f.fact);
  expect(result.text).not.toContain("legacy later");
  expect(f.store.sourcePathState(f.session.id, "main")).toBeNull();
});

test("ticket92material native prefix uses path position, rejects empty/corrupt/sibling endpoints, and does not leak later facts", () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "assistant", "lower id but later on path");
  seedSourceEntry(f.memory, f.turn.id, "assistant", "higher id but earlier on path");
  const all = f.store.listSourceEntries(f.session.id);
  const order = [all[0]!.id, all[2]!.id, all[1]!.id];
  f.memory.selectEntries(f.session.id, "main", order);
  const note = f.memory.tools({ kind: "manual", ...f.target, currentTurnId: f.turn.id }).find(tool => tool.name === "note")!;
  const laterFact = JSON.parse(note.execute({ title: "Later source", sources: `[T${f.turn.id}#E2] later source must not leak` })).factIds[0];
  const read = readFacade(f.store, f.memory.config);
  const result = read.compact(f.session.id, "main", f.turn.id, [], false, { endpointEntryId: all[2]!.id, processedRawRefill: false });
  if ("native" in result) throw new Error("unexpected fallback");
  expect(result.supplied.entries.map(e => e.id)).toEqual([all[2]!.id]);
  expect(result.supplied.factIds).not.toContain(laterFact);
  expect(result.text).not.toContain("lower id but later");
  expect(f.store.sourcePath(f.session.id, "main", f.turn.id).map(e => e.id)).toEqual(order);
  f.memory.selectEntries(f.session.id, "main", [all[0]!.id, all[2]!.id]);
  expect(() => read.compact(f.session.id, "main", f.turn.id, [], false, { endpointEntryId: all[1]!.id })).toThrow(/endpoint/);
  f.memory.selectEntries(f.session.id, "main", []);
  expect(() => read.compact(f.session.id, "main", f.turn.id, [], false, { endpointEntryId: all[0]!.id })).toThrow(/endpoint/);
  f.memory.selectEntries(f.session.id, "main", order);
  f.store.db.prepare("UPDATE source_paths SET length = length + 1 WHERE session_id = ? AND branch = 'main'").run(f.session.id);
  expect(() => read.compact(f.session.id, "main", f.turn.id, [], false, { endpointEntryId: all[2]!.id })).toThrow();
});

test("ticket92material configuration cannot raise the fixed Raw entry cap", () => {
  expect(() => validateConfig({ render: { entryTokens: 2001 } })).toThrow(/2000/);
  expect(validateConfig({ render: { entryTokens: 2000 } }).render.entryTokens).toBe(2000);
});

test("ticket92material same-Turn exact endpoints preserve preceding facts, exclude later entries, and leave cursor/history unchanged", () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "assistant", "first pending");
  seedSourceEntry(f.memory, f.turn.id, "assistant", "later pending");
  f.select();
  const all = f.store.sourcePath(f.session.id, "main", f.turn.id);
  const read = readFacade(f.store, f.memory.config);
  const first = read.compact(f.session.id, "main", f.turn.id, [], false, { endpointEntryId: all[1]!.id, processedRawRefill: false });
  const second = read.compact(f.session.id, "main", f.turn.id, [], false, { endpointEntryId: all[2]!.id, processedRawRefill: false });
  if ("native" in first || "native" in second) throw new Error("unexpected native fallback");
  expect(first.supplied.entries.map(e => e.id)).toEqual([all[1]!.id]);
  expect(second.supplied.entries.map(e => e.id)).toEqual([all[1]!.id, all[2]!.id]);
  expect(first.supplied.factIds).toContain(f.fact);
  expect(first.text).not.toContain("later pending");
  expect(f.store.sourcePath(f.session.id, "main", f.turn.id)).toEqual(all);
  expect(f.store.listTurns(f.session.id)).toHaveLength(1);
  const main = f.memory.compact(f.session.id, "main", f.turn.id);
  if ("native" in main) throw new Error("unexpected native fallback");
  expect(main.supplied.entries.map(e => e.id)).toEqual(all.map(e => e.id));
  expect(main.supplied.factIds).not.toContain(f.fact);
});

test("ticket92material facade publishes successive exact oldest batches through the common assembler", async () => {
  const f = fixture();
  for (let index = 0; index < 12; index++) seedSourceEntry(f.memory, f.turn.id, "assistant", `${index}: ${"context ".repeat(1100)}`);
  f.select();
  const original = f.store.pendingEntries(f.session.id, "main", f.turn.id).map(e => e.id);
  const selected: number[] = [];
  while (f.store.pendingEntries(f.session.id, "main", f.turn.id).length) {
    expect((await f.memory.noting({ ...f.target })).outcome).toBe("success");
    const input = f.inputs.at(-1)!;
    expect(input.material.entries.map(e => e.id)).toEqual(input.entryIds);
    expect(input.supplied.entries.map(e => e.id)).toEqual(input.entryIds);
    expect(input.supplied.factIds).toContain(f.fact);
    selected.push(...input.entryIds);
  }
  expect(f.inputs.length).toBeGreaterThan(1);
  expect(selected).toEqual(original);
});

test("ticket92material due checks never call compact or read already-counted Raw", () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "assistant", "small pending");
  f.select();
  f.memory.pendingTokens("noting", f.target);
  const raw = vi.spyOn(f.store, "getSourceEntry");
  for (let index = 0; index < 10; index++) f.memory.taskEligibility("noting", f.target);
  expect(raw).not.toHaveBeenCalled();
});
