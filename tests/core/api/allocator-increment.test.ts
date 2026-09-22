import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, compacted } from "../../source-fixture.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";
import { setKnowledgeInjection, setSharedAllowance } from "../../knowledge-budget-fixture.ts";

const time = "2026-09-06T00:00:00Z";
const open = () => sourceSeededMemory(":memory:", async () => { throw new Error("allocator calls no worker"); });
let memory: ReturnType<typeof open>;
beforeEach(() => { memory = open(); });
afterEach(() => memory.close());

function fixture(extra = { knowledge: 0, facts: 0, raw: 0 }, consolidated = true, noted = false) {
  const p = memory.store.createProject({ name: "project", declaredBy: "marker" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: p.id });
  const t = memory.store.appendTurn({ sessionId: s.id, userPrompt: "word ".repeat(extra.raw) + "source", assistantText: null, kind: "turn", startedAt: time });
  const entries = memory.store.sourcePath(s.id, "main", t.id);
  const f = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time }, entryIds: noted ? entries.map(e => e.id) : [],
    facts: [{ turnId: t.id, text: "word ".repeat(extra.facts) + "required fact", category: "observation", actor: "user", source: [`T${t.id}#user`], entryIds: entries.map(e => e.id), createdAt: time }] });
  if (!f.ok) throw new Error(JSON.stringify(f));
  const k = memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "consolidation", createdAt: time }, consolidated: consolidated ? [f.facts[0]!.id] : [],
    operations: [{ op: "create", topics: [], handle: "$k", author: "test", text: "word ".repeat(extra.knowledge) + "current complete knowledge", category: "constraint", scope: "project", supports: [f.facts[0]!.id], reason: "initial", createdAt: time }] });
  if (!k.ok) throw new Error(JSON.stringify(k));
  return { s, t, f: f.facts[0]!, entries };
}

function charged(result: ReturnType<typeof memory.compact>) {
  if ("native" in result) throw new Error(result.reason);
  return result.charged!;
}

/** Calibrate framing with the real renderers, then create immutable bodies with exact charges. */
function exactFixture(target: { knowledge: number; facts: number; raw: number }) {
  setKnowledgeInjection(memory, 100_000);
  setSharedAllowance(memory, 100_000);
  const seed = fixture(undefined, false);
  const floor = charged(memory.compact(seed.s.id, "main", seed.t.id));
  memory.close(); memory = open();
  memory.config.render.entryTokens = 30_000;
  setKnowledgeInjection(memory, 100_000);
  setSharedAllowance(memory, 100_000);
  const result = fixture({ knowledge: target.knowledge - floor.knowledge,
    facts: target.facts - floor.facts, raw: target.raw - floor.raw }, false);
  expect(charged(memory.compact(result.s.id, "main", result.t.id))).toMatchObject(target);
  setKnowledgeInjection(memory, 20_000);
  setSharedAllowance(memory, 20_000);
  return result;
}

function positiveExcess(value: { knowledge: number; facts: number; raw: number }) {
  return Math.max(0, value.knowledge - 20_000) + Math.max(0, value.facts - 10_000) + Math.max(0, value.raw - 10_000);
}

test("64c current Knowledge is optional regardless of Dreamer processing state", () => {
  const { s, t } = fixture({ knowledge: 6_000, facts: 0, raw: 0 });
  setKnowledgeInjection(memory, 1);
  memory.config.noting.triggerTokens = 1;
  memory.config.consolidation.triggerTokens = 1;
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false);
  expect(compacted(result)).not.toContain("current complete knowledge");
  expect(charged(result).required.knowledge).toBe(0);
});

test("64c mandatory facts and Raw fit at exact shared boundary and delegate one token below", () => {
  const { s, t, f } = exactFixture({ knowledge: 20_000, facts: 14_000, raw: 16_003 });
  setSharedAllowance(memory, 10_003);
  const fitted = memory.compact(s.id, "main", t.id);
  expect(charged(fitted)).toMatchObject({ knowledge: 20_000, facts: 14_000, raw: 16_003, envelope: 50_003 });
  expect("native" in fitted ? [] : fitted.supplied.factIds).toContain(f.id);
  expect(memory.compact(s.id, "main", t.id)).toEqual(fitted);
  setSharedAllowance(memory, 10_002);
  const failure = memory.compact(s.id, "main", t.id);
  expect(failure).toMatchObject({ native: true, over: { knowledge: false, facts: true, raw: true } });
  expect("native" in failure && failure.reason).toContain("shortfall 1");
});

test("64c optional Knowledge borrows shared allowance after mandatory reservations", () => {
  const { s, t, f } = exactFixture({ knowledge: 30_000, facts: 10_000, raw: 10_000 });
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect(windows).toMatchObject({ knowledge: 30_000, facts: 10_000, raw: 10_000, envelope: 60_000 });
  expect("native" in result ? [] : result.supplied.factIds).toContain(f.id);
  expect(compacted(result)).toContain("current complete knowledge");
});

test("64c optional Knowledge cannot displace required facts or Raw", () => {
  const { s, t, f } = exactFixture({ knowledge: 35_000, facts: 14_000, raw: 16_000 });
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect(windows.facts).toBe(14_000);
  expect(windows.raw).toBe(16_000);
  expect(windows.knowledge).toBeLessThan(35_000);
  expect("native" in result ? [] : result.supplied.factIds).toContain(f.id);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
  expect(positiveExcess(windows)).toBeLessThanOrEqual(20_000);
});

test("64c unused base windows do not lend when shared allowance is disabled", () => {
  const { s, t } = exactFixture({ knowledge: 5_000, facts: 10_000, raw: 10_000 });
  setKnowledgeInjection(memory, 0);
  memory.config.noting.triggerTokens = 1;
  memory.config.consolidation.triggerTokens = 1;
  const raw = memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeId: "history", nativeLineage: "fixture",
    role: "assistant", text: "word ".repeat(2_000), raw: "", calls: [] });
  const history = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time }, entryIds: [raw.id],
    facts: [{ turnId: t.id, text: "word ".repeat(2_000) + "historical fact", category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time }] });
  if (!history.ok) throw new Error(JSON.stringify(history));
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "consolidation", createdAt: time }, operations: [], consolidated: history.facts.map(f => f.id) });
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result ? [raw.id] : result.supplied.entries.map(e => e.id)).not.toContain(raw.id);
  expect("native" in result ? history.facts.map(f => f.id) : result.supplied.factIds).not.toContain(history.facts[0]!.id);
});

test("64c historical Raw borrows remaining shared before historical facts", () => {
  const { s, t } = exactFixture({ knowledge: 25_000, facts: 10_000, raw: 10_000 });
  const raw = memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeId: "history", nativeLineage: "fixture",
    role: "assistant", text: "word ".repeat(8_000), raw: "", calls: [] });
  const history = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time }, entryIds: [raw.id],
    facts: [{ turnId: t.id, text: "word ".repeat(8_000) + "historical fact", category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time }] });
  if (!history.ok) throw new Error(JSON.stringify(history));
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "consolidation", createdAt: time }, operations: [], consolidated: history.facts.map(f => f.id) });
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toContain(raw.id);
  expect("native" in result ? history.facts.map(f => f.id) : result.supplied.factIds).not.toContain(history.facts[0]!.id);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(60_000);
  expect(positiveExcess(windows)).toBeLessThanOrEqual(20_000);
});

test("64c historical facts borrow shared left after Knowledge when no historical Raw consumes it", () => {
  const { s, t } = exactFixture({ knowledge: 25_000, facts: 10_000, raw: 10_000 });
  const history = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time }, facts: [
    { turnId: t.id, text: "word ".repeat(8_000) + "borrowed historical fact", category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time },
  ] });
  if (!history.ok) throw new Error(JSON.stringify(history));
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "consolidation", createdAt: time }, operations: [], consolidated: history.facts.map(f => f.id) });
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect("native" in result ? [] : result.supplied.factIds).toContain(history.facts[0]!.id);
  expect(compacted(result)).toContain("borrowed historical fact");
  expect(windows.facts).toBeGreaterThan(10_000);
  expect(positiveExcess(windows)).toBeLessThanOrEqual(20_000);
});

test("32e final Raw coverage filters optional facts only; retained bounded views count and unknown bindings stay", () => {
  const { s, t, f, entries } = fixture(undefined, true, true);
  const first = memory.compact(s.id, "main", t.id);
  expect("native" in first ? [] : first.supplied.factIds).not.toContain(f.id);
  memory.store.db.prepare("DELETE FROM fact_sources WHERE fact_id = ?").run(f.id);
  expect(compacted(memory.compact(s.id, "main", t.id))).toContain("required fact");
  memory.store.db.prepare("INSERT INTO fact_sources VALUES (?, ?)").run(f.id, entries[0]!.id);
  memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time }, facts: [], entryIds: entries.map(e => e.id) });
  const visible = noVisibility(); visible.raw.set(entries[0]!.nativeId, "view");
  const retained = memory.compact(s.id, "main", t.id, visible);
  expect("native" in retained ? [f.id] : retained.supplied.factIds).not.toContain(f.id);
  expect("native" in retained ? [1] : retained.supplied.entries).toEqual([]);
});

test("32e old pending holes and incomplete optional bindings survive filtering", () => {
  const { s, t, entries } = fixture();
  const later = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "later source", startedAt: "2026-09-07T00:00:00Z" });
  const newer = memory.store.sourcePath(s.id, "main", later.id).at(-1)!;
  const added = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: time }, entryIds: [newer.id], facts: [
    { turnId: later.id, text: "partly covered", category: "observation", actor: "user", source: [`T${t.id}#user`, `T${later.id}#user`], entryIds: [entries[0]!.id, newer.id], createdAt: time },
    { turnId: later.id, text: "incomplete binding", category: "observation", actor: "user", source: [`T${t.id}#user`, `T${later.id}#user`], entryIds: [entries[0]!.id], createdAt: time },
    { turnId: t.id, text: "old pending fact hole", category: "observation", actor: "user", source: [`T${t.id}#user`], entryIds: [entries[0]!.id], createdAt: time },
  ] });
  if (!added.ok) throw new Error(JSON.stringify(added));
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: time }, operations: [], consolidated: added.facts.slice(0, 2).map(f => f.id) });
  const full = memory.compact(s.id, "main", later.id);
  memory.config.compaction.rawTokens = charged(full).required.raw;
  setKnowledgeInjection(memory, 0);
  memory.config.noting.triggerTokens = 1;
  memory.config.consolidation.triggerTokens = 1;
  const result = memory.compact(s.id, "main", later.id), text = compacted(result);
  for (const marker of ["partly covered", "incomplete binding", "old pending fact hole"]) expect(text).toContain(marker);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toEqual([entries[0]!.id]);
  expect(memory.pendingEntries(s.id, "main", later.id).map(e => e.id)).toEqual([entries[0]!.id]);
});

test("32e coverage filtering precedes fact prefix budgeting and retained fact IDs deduplicate", () => {
  const { s, t, entries } = fixture(undefined, true, true);
  const history = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: time }, entryIds: entries.map(e => e.id), facts: [
    { turnId: t.id, text: "older unknown binding", category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time },
    { turnId: t.id, text: "newest covered " + "word ".repeat(3_000), category: "observation", actor: "user", source: [`T${t.id}#user`], entryIds: entries.map(e => e.id), createdAt: time },
  ] });
  if (!history.ok) throw new Error(JSON.stringify(history));
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: time }, operations: [], consolidated: history.facts.map(f => f.id) });
  memory.config.compaction.factsTokens = 200;
  const result = memory.compact(s.id, "main", t.id);
  expect(compacted(result)).toContain("older unknown binding");
  expect("native" in result ? [1] : result.supplied.factIds).toEqual([history.facts[0]!.id]);
  const retained = noVisibility(); retained.factIds.add(history.facts[0]!.id);
  expect("native" in result ? -1 : charged(memory.compact(s.id, "main", t.id, retained)).facts).toBe(charged(result).required.facts);
});
