import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, compacted } from "../../source-fixture.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";
import { setKnowledgeInjection, setSharedAllowance } from "../../knowledge-budget-fixture.ts";
import { charge, xmlBlock } from "../../../src/core/render/index.ts";
import { legacyFacts } from "../../support/seed.ts";

const time = "2026-09-06T00:00:00Z";
const open = () => sourceSeededMemory(":memory:", async () => { throw new Error("allocator calls no worker"); });
let memory: ReturnType<typeof open>;
beforeEach(() => { memory = open(); });
afterEach(() => memory.close());

/** Manual/historical item sizes exercise read-only compaction; normal N writes remain capped. */
function fixture(extra = { knowledge: 0, facts: 0, raw: 0 }, noted = false, historicalManual = false) {
  const p = memory.store.createProject({ name: "project", declaredBy: "marker" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: p.id });
  const t = memory.store.appendTurn({ sessionId: s.id, userPrompt: "word ".repeat(extra.raw) + "source", assistantText: null, kind: "turn", startedAt: time });
  const entries = memory.store.sourcePath(s.id, "main", t.id);
  const factText = "word ".repeat(extra.facts) + "required fact";
  const knowledgeText = "word ".repeat(extra.knowledge) + "current complete knowledge";
  // Oversized facts are isolated as manual/historical writes, not new Noter output.
  const f = legacyFacts(memory.store, { sessionId: s.id, branch: "main", kind: historicalManual ? "manual" : "noting", createdAt: time }, [
    { sources: [{ entry: entries[0]!, address: `T${t.id}#user` }], text: factText,
      category: "observation", actor: "user", createdAt: time },
  ], noted ? entries.map(e => e.id) : []);
  const k = memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "manual", createdAt: time },
    operations: [{ op: "create", topics: [], handle: "$k", author: "test", text: knowledgeText, category: "constraint", scope: "project", supports: [f.facts[0]!.id], reason: "initial", createdAt: time }] });
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
  const seed = fixture();
  const floor = charged(memory.compact(seed.s.id, "main", seed.t.id));
  memory.close(); memory = open();
  // Large persisted manual/historical material is read through the fixed 2k entry-view profile.
  setKnowledgeInjection(memory, 100_000);
  setSharedAllowance(memory, 100_000);
  const result = fixture({ knowledge: target.knowledge - floor.knowledge,
    facts: target.facts - floor.facts, raw: target.raw - floor.raw }, false, true);
  expect(charged(memory.compact(result.s.id, "main", result.t.id))).toMatchObject(target);
  setKnowledgeInjection(memory, 20_000);
  setSharedAllowance(memory, 20_000);
  return result;
}

function positiveExcess(value: { knowledge: number; facts: number; raw: number }) {
  return Math.max(0, value.knowledge - 20_000) + Math.max(0, value.facts - 10_000) + Math.max(0, value.raw - 10_000);
}

test("73: current Knowledge is optional regardless of Dreamer processing state", () => {
  const { s, t } = fixture({ knowledge: 6_000, facts: 0, raw: 0 }, false, true);
  setKnowledgeInjection(memory, 1);
  setSharedAllowance(memory, 0);
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false);
  expect(compacted(result)).not.toContain("current complete knowledge");
});

test("92: facts stay in their own base while pending Raw borrows at the exact shared boundary", () => {
  const { s, t, f } = exactFixture({ knowledge: 20_000, facts: 9_000, raw: 1_800 });
  memory.config.compaction.rawTokens = 1_000;
  setSharedAllowance(memory, 800);
  const fitted = memory.compact(s.id, "main", t.id);
  expect(charged(fitted)).toMatchObject({ knowledge: 20_000, facts: 9_000, raw: 1_800 });
  expect("native" in fitted ? [] : fitted.supplied.factIds).toContain(f.id);
  expect("native" in fitted ? [] : fitted.supplied.entries).toHaveLength(1);
  expect(memory.compact(s.id, "main", t.id)).toEqual(fitted);

  setSharedAllowance(memory, 799);
  const short = memory.compact(s.id, "main", t.id);
  expect("native" in short).toBe(false);
  if ("native" in short) throw new Error("unreachable");
  expect(short.supplied.entries).toEqual([]); // one whole pending entry, never a cut view
  expect(short.supplied.factIds).toContain(f.id); // facts never depend on Raw's shared remainder
  expect(short.truncated?.raw?.entries).toBe(1);
  expect(short.truncated?.raw).not.toHaveProperty("tokens");
});

test("73: Knowledge borrows the shared allowance before Raw, so Raw can lose out entirely", () => {
  const { s, t, f } = exactFixture({ knowledge: 35_000, facts: 9_000, raw: 1_800 });
  // Knowledge needs all 15k shared tokens; a whole pending entry needing another 800 cannot fit.
  memory.config.compaction.rawTokens = 1_000;
  setSharedAllowance(memory, 15_000);
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect(windows.knowledge).toBe(35_000);
  expect(windows.facts).toBe(9_000 + charge([xmlBlock("episodic", "")])); // facts open the wrapper when Raw is omitted
  expect(windows.raw).toBeLessThan(1_800);
  expect("native" in result ? [] : result.supplied.factIds).toContain(f.id);
  expect("native" in result ? [] : result.supplied.entries).toEqual([]);
  expect("native" in result ? undefined : result.truncated?.raw?.entries).toBe(1);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
});

test("73: optional Knowledge still yields to what Raw and facts need once Knowledge itself is satisfied", () => {
  const { s, t, f } = exactFixture({ knowledge: 21_000, facts: 9_000, raw: 1_800 });
  // Knowledge needs 1k; the remaining allowance funds the pending Raw above its 1k base.
  memory.config.compaction.rawTokens = 1_000;
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect(windows).toMatchObject({ knowledge: 21_000, facts: 9_000, raw: 1_800 });
  expect("native" in result ? [] : result.supplied.factIds).toContain(f.id);
  expect("native" in result).toBe(false);
  if (!("native" in result)) expect(result.truncated).toBeUndefined();
  expect(positiveExcess(windows)).toBeLessThanOrEqual(20_000);
});

test("92: a historical unconsolidated fact stays eligible but cannot borrow shared allowance", () => {
  const { s, t } = exactFixture({ knowledge: 5_000, facts: 9_000, raw: 1_800 });
  setKnowledgeInjection(memory, 0);
  const raw = memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeId: "history", nativeLineage: "fixture",
    role: "assistant", text: "word ".repeat(2_000), raw: "", calls: [] });
  const history = legacyFacts(memory.store, { sessionId: s.id, branch: "main", kind: "manual", createdAt: time }, [
    { sources: [{ entry: memory.store.sourcePath(s.id, "main", t.id)[0]!, address: `T${t.id}#user` }],
      text: "word ".repeat(2_000) + "historical fact", category: "observation", actor: "user", createdAt: time },
  ]);
  memory.config.compaction.factsTokens = 9_000;
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toContain(raw.id);
  expect(charged(result).facts).toBeLessThanOrEqual(9_000);
  expect("native" in result ? [] : result.supplied.factIds).toContain(history.facts[0]!.id);
  expect("native" in result ? [] : result.supplied.factIds).not.toContain(1); // older 9k item cannot fit behind it
  expect(compacted(result)).toContain("older facts; expand:");
});

test("92: processed Raw uses only its base remainder; facts independently keep their base", () => {
  // The old Raw view needs 1,800 tokens, more than the 1k base after a newer pending view.
  // Facts remain newest-first and cannot spend shared allowance.
  const { s, t, f } = exactFixture({ knowledge: 20_000, facts: 9_000, raw: 1_800 });
  setSharedAllowance(memory, 50_000);
  const primaryEntry = memory.store.sourcePath(s.id, "main", t.id)[0]!;
  expect(memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    entryIds: [primaryEntry.id], facts: [] }).ok).toBe(true);
  // A legal newer pending view fits the reduced Raw base but leaves too little for the older one.
  memory.config.compaction.rawTokens = 1_000;
  const newest = memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeId: "newest", nativeLineage: "fixture",
    role: "assistant", text: "word ".repeat(700), raw: "", calls: [] });
  legacyFacts(memory.store, { sessionId: s.id, branch: "main", kind: "manual", createdAt: time }, [
    { sources: [{ entry: primaryEntry, address: `T${t.id}#user` }], text: "word ".repeat(8_000) + "NEWEST FACT",
      category: "observation", actor: "user", createdAt: time },
  ]);
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toContain(newest.id);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).not.toContain(primaryEntry.id);
  expect("native" in result ? [] : result.supplied.factIds).not.toContain(f.id);
  expect(windows.facts).toBeLessThanOrEqual(10_000);
  expect(windows.raw).toBeLessThanOrEqual(1_000);
});

test("32e final Raw coverage filters optional facts; damaged legacy bindings fail explicitly", () => {
  const { s, t, f, entries } = fixture(undefined, true);
  const first = memory.compact(s.id, "main", t.id);
  expect("native" in first ? [] : first.supplied.factIds).not.toContain(f.id);
  const binding = memory.store.db.prepare("SELECT segment_text FROM fact_sources WHERE fact_id = ? AND entry_id = ?")
    .get(f.id, entries[0]!.id) as { segment_text: string };
  memory.store.db.prepare("DELETE FROM fact_sources WHERE fact_id = ?").run(f.id);
  expect(() => memory.compact(s.id, "main", t.id)).toThrow("missing legacy source bindings");
  memory.store.db.prepare("INSERT INTO fact_sources (fact_id, entry_id, segment_text) VALUES (?, ?, ?)")
    .run(f.id, entries[0]!.id, binding.segment_text);
  memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time }, facts: [], entryIds: entries.map(e => e.id) });
  const visible = noVisibility(); visible.raw.set(entries[0]!.nativeId, "view");
  const retained = memory.compact(s.id, "main", t.id, visible);
  expect("native" in retained ? [f.id] : retained.supplied.factIds).not.toContain(f.id);
  expect("native" in retained ? [1] : retained.supplied.entries).toEqual([]);
});

test("32e old pending holes and fully bound facts survive when final Raw does not cover every source", () => {
  const { s, t, entries } = fixture();
  const later = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "later source", startedAt: "2026-09-07T00:00:00Z" });
  const newer = memory.store.sourcePath(s.id, "main", later.id).at(-1)!;
  const olderSource = { entry: entries[0]!, address: `T${t.id}#user` };
  const newerSource = { entry: newer, address: `T${later.id}#user` };
  const added = legacyFacts(memory.store, { kind: "noting", sessionId: s.id, branch: "main", createdAt: time }, [
    { turnId: later.id, sources: [olderSource, newerSource], text: "partly covered", category: "observation", actor: "user", createdAt: time },
    { turnId: later.id, sources: [olderSource, newerSource], text: "fully bound fact", category: "observation", actor: "user", createdAt: time },
    { turnId: t.id, sources: [olderSource], text: "old pending fact hole", category: "observation", actor: "user", createdAt: time },
  ], [newer.id]);
  expect(added.facts.map(fact => ({ turnId: fact.turnId, source: fact.source }))).toEqual([
    { turnId: later.id, source: [`T${t.id}#user`, `T${later.id}#user`] },
    { turnId: later.id, source: [`T${t.id}#user`, `T${later.id}#user`] },
    { turnId: t.id, source: [`T${t.id}#user`] },
  ]);
  const full = memory.compact(s.id, "main", later.id);
  memory.config.compaction.rawTokens = charged(full).raw;
  memory.config.compaction.sharedAllowanceTokens = 0;
  setKnowledgeInjection(memory, 0);
  const result = memory.compact(s.id, "main", later.id), text = compacted(result);
  for (const marker of ["partly covered", "fully bound fact", "old pending fact hole"]) expect(text).toContain(marker);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toEqual([entries[0]!.id, newer.id]);
  expect(memory.pendingEntries(s.id, "main", later.id).map(e => e.id)).toEqual([entries[0]!.id]);
});

test("32e fully bound facts: final Raw coverage filters before fact budgeting; retained IDs deduplicate", () => {
  const { s, t, entries, f } = fixture(undefined, true);
  const append = (nativeId: string, text: string) => memory.appendEntry({ sessionId: s.id, turnId: t.id,
    nativeId, nativeLineage: "fixture", role: "user", text, raw: text, calls: [] });
  const older = append("older-source", "old source ".repeat(1_500));
  const newer = append("newer-source", "new source");
  memory.selectEntries(s.id, "main", [...entries.map(entry => entry.id), older.id, newer.id]);
  const history = legacyFacts(memory.store, { kind: "noting", sessionId: s.id, branch: "main", createdAt: time }, [
    { sources: [{ entry: older, address: `T${t.id}#E${older.entryOrdinal}` }], text: "older bound fact",
      category: "observation", actor: "user", createdAt: time },
    { sources: [{ entry: newer, address: `T${t.id}#E${newer.entryOrdinal}` }], text: "newest covered " + "word ".repeat(850),
      category: "observation", actor: "user", createdAt: time },
  ], [older.id, newer.id]);
  expect(memory.store.factEntries(history.facts[0]!.id)).toEqual([older.id]);
  expect(memory.store.factEntries(history.facts[1]!.id)).toEqual([newer.id]);
  memory.config.compaction.rawTokens = 200;
  memory.config.compaction.factsTokens = 400;
  const visible = noVisibility(); visible.factIds.add(f.id);
  const result = memory.compact(s.id, "main", t.id, visible);
  if ("native" in result) throw new Error(result.reason);
  const rawIds = result.supplied.entries.map(entry => entry.id);
  expect(rawIds).toContain(newer.id);
  expect(rawIds).not.toContain(older.id);
  expect([...memory.store.factsCoveredByRaw(history.facts, new Set(rawIds))]).toEqual([history.facts[1]!.id]);
  expect(result.supplied.factIds).toEqual([history.facts[0]!.id]);
  expect(result.text).toContain("older bound fact");
  visible.factIds.add(history.facts[0]!.id);
  const deduped = memory.compact(s.id, "main", t.id, visible);
  if ("native" in deduped) throw new Error(deduped.reason);
  expect(deduped.supplied.factIds).not.toContain(history.facts[0]!.id);
  expect(charged(deduped).facts).toBeLessThan(charged(result).facts);
});
