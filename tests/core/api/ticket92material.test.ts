import { afterEach, expect, test, vi } from "vitest";
import { sourceSeededMemory, seedSourceEntry, type NotingAgentInput } from "../../source-fixture.ts";
import { readFacade } from "../../../src/core/api/read.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";
import { freezeDreaming } from "../../../src/core/dreaming/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { validateConfig, toolDefinitions } from "../../../src/core/api/index.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { pricedToolDefinitions } from "../../../src/core/api/tools.ts";

const memories: ReturnType<typeof sourceSeededMemory>[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
function fixture(native = true) {
  const inputs: NotingAgentInput[] = [];
  const memory = sourceSeededMemory(":memory:", async raw => {
    const input = raw as NotingAgentInput;
    input.reportRequest({ material: input.text });
    if (input.kind !== "noting") throw new Error("unexpected Dreaming");
    inputs.push(input);
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
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
  const input = { ...f.target, borrowed: true, executorSessionId: executor.id, mode: "fork" as const };
  expect((await f.memory.noting(input)).outcome).toBe("dropped");
  expect(f.inputs).toHaveLength(0);
  f.store.setCurrentPath(f.session.id, "main", f.turn.id, "target-lineage");
  expect((await f.memory.noting(input)).outcome).toBe("success");
  expect(f.inputs).toHaveLength(1);
  expect(f.inputs[0]!.mode).toBe("subagent");
  expect(f.inputs[0]!.material.entries.map(entry => entry.id)).toEqual([all[1]!]);
  expect(f.inputs[0]!.text).toContain("Target session agent: Pi agent");
});

test("ticket92material preparation loads only selected Raw, never the processed history's Turn payloads", () => {
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
  const frozen = freezeNoting(f.store, { ...f.target, mode: "subagent" }, f.memory.config);
  const elapsed = performance.now() - start;
  expect(frozen.entries).toHaveLength(1);
  expect(raw.mock.calls.map(([id]) => id)).toEqual([frozen.entries[0]!.id]);
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
  freezeNoting(f.store, { ...f.target, mode: "subagent" }, f.memory.config);
  expect(statements.mock.calls.filter(([sql]) => sql.includes("SELECT j.position, j.entry_id, e.id AS owned_id"))).toHaveLength(0);
  expect(raw.mock.calls).toHaveLength(secondRaw);
  expect(metadataReads()).toHaveLength(2);
  console.info(JSON.stringify({ materialPreparationMs: elapsed, priorEntries: older.length, rawReads: raw.mock.calls.length, turnReads: turns.mock.calls.length }));
});

test("ticket92material capacity shrinking reuses metadata and Raw views but rebinds each endpoint", () => {
  const f = fixture();
  for (let index = 0; index < 6; index++) seedSourceEntry(f.memory, f.turn.id, "assistant", `entry-${index} ${"words ".repeat(80)}`);
  f.select();
  const config = { ...f.memory.config, compaction: { ...f.memory.config.compaction, factsTokens: 1 } };
  const complete = freezeNoting(f.store, { ...f.target, mode: "subagent" }, config);
  const fixed = tokens(loadPrompt("noting.md")) + tokens(JSON.stringify(pricedToolDefinitions(toolDefinitions, canonicalToolNames)));
  const raw = vi.spyOn(f.store, "getSourceEntry"), snapshots = vi.spyOn(f.store, "pathSnapshot");
  const statements = vi.spyOn(f.store.db, "prepare");
  const reduced = freezeNoting(f.store, { ...f.target, mode: "subagent", capacity: {
    inputTokens: fixed + tokens(complete.prepared!.text) - 80, prefixTokens: 0 } }, config);
  expect(reduced.entries.length).toBeLessThan(complete.entries.length);
  expect(reduced.entries.length).toBeGreaterThan(0);
  expect(reduced.prepared!.selectedEntryIds).toEqual(reduced.entries.map(entry => entry.id));
  expect(raw.mock.calls.map(([id]) => id)).toEqual(complete.entries.map(entry => entry.id));
  expect(new Set(raw.mock.calls.map(([id]) => id)).size).toBe(raw.mock.calls.length);
  const endpoints = snapshots.mock.calls.map(([, endpoint]) => endpoint).filter(id => id !== undefined);
  expect(endpoints[0]).toBe(complete.entries.at(-1)!.id);
  expect(endpoints.at(-1)).toBe(reduced.entries.at(-1)!.id);
  expect(reduced.prepared!.text).not.toContain("entry-5");
  expect(statements.mock.calls.filter(([sql]) => sql.startsWith("SELECT id, session_id, native_lineage, native_id, turn_id, entry_ordinal, addresses, digest FROM source_entries"))).toHaveLength(2);
});

test("ticket92material hard input capacity rejects before invoking the worker and leaves Raw pending", async () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "assistant", "new evidence"); f.select();
  const pending = f.store.pendingEntries(f.session.id, "main", f.turn.id).map(entry => entry.id);
  await expect(f.memory.noting({ ...f.target, mode: "subagent", capacity: { inputTokens: 1, prefixTokens: 0 } })).rejects.toThrow(/Noting capacity/);
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
  const laterFact = JSON.parse(note.execute({ facts: [{ title: "Later source", sources: [{ address: `T${f.turn.id}#E2`, text: "later source must not leak" }] }] })).factIds[0];
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

test("ticket92material D pending slice is 10k inside K, direct facts are separate and due remains pending-only", () => {
  const f = fixture();
  f.memory.setKnowledgeBudget("project", 1_000);
  for (let index = 0; index < 18; index++) {
    const committed = f.store.commitConsolidationRun({ path: f.target, run: { kind: "manual", sessionId: f.session.id, createdAt: "now" },
      operations: [{ op: "create", handle: "$new", author: "fixture", category: "understanding", scope: "project",
        text: `${index} ${"knowledge ".repeat(320)}`, supports: [f.fact], topics: [], reason: "fixture", createdAt: "now" }] });
    if (!committed.ok) throw new Error(committed.problems.join("; "));
  }
  expect(f.memory.taskEligibility("dreaming", f.target).due).toBe(true);
  const claim = f.store.acquireClaim(f.target, "dreaming", f.memory.executorId, false)!;
  const frozen = freezeDreaming(f.store, f.target, f.memory.config, claim);
  expect(tokens(frozen.material.changed)).toBeLessThanOrEqual(10_000);
  expect(tokens(frozen.material.changed)).toBeGreaterThan(1_000);
  expect(tokens(`${frozen.material.processed}\n\n${frozen.material.changed}`)).toBeLessThanOrEqual(f.store.knowledgeBudgets().injection + f.memory.config.compaction.sharedAllowanceTokens);
  expect(tokens(frozen.material.facts)).toBeLessThanOrEqual(10_000);
  expect(frozen.material.facts).toContain(`F${f.fact}`);
  expect(frozen.frozenIds.length).toBeLessThan(18);
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
    expect((await f.memory.noting({ ...f.target, mode: "subagent" })).outcome).toBe("success");
    const input = f.inputs.at(-1)!;
    expect(input.material.entries.map(e => e.id)).toEqual(input.entryIds);
    expect(input.supplied.entries.map(e => e.id)).toEqual(input.entryIds);
    expect(input.supplied.factIds).toContain(f.fact);
    selected.push(...input.entryIds);
  }
  expect(f.inputs.length).toBeGreaterThan(1);
  expect(selected).toEqual(original);
});

test("ticket92material fork adds no Knowledge or historical-fact supplement", () => {
  const f = fixture();
  seedSourceEntry(f.memory, f.turn.id, "assistant", "pending reply");
  f.select();
  const pending = f.store.pendingEntries(f.session.id, "main", f.turn.id);
  const visible = { ...noVisibility(), raw: new Map(pending.map(e => [e.nativeId, "source" as const])) };
  const frozen = freezeNoting(f.store, { ...f.target, mode: "fork", visible }, f.memory.config);
  expect(frozen.prepared!.material.knowledge).toBeUndefined();
  expect(frozen.prepared!.material.facts).toEqual([]);
  expect(frozen.prepared!.material.sources).toHaveLength(pending.length);
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
