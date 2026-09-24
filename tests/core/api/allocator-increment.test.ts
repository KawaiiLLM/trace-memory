import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, compacted } from "../../source-fixture.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";
import { setKnowledgeInjection, setSharedAllowance } from "../../knowledge-budget-fixture.ts";
import { charge, xmlBlock } from "../../../src/core/render/index.ts";

const time = "2026-09-06T00:00:00Z";
const open = () => sourceSeededMemory(":memory:", async () => { throw new Error("allocator calls no worker"); });
let memory: ReturnType<typeof open>;
beforeEach(() => { memory = open(); });
afterEach(() => memory.close());

/** `noted`/`consolidated` control whether the fact/entry this fixture creates is processed (never
 * borrows the shared allowance, 73) or still pending (borrows). */
function fixture(extra = { knowledge: 0, facts: 0, raw: 0 }, consolidated = true, noted = false, historicalManual = false) {
  const p = memory.store.createProject({ name: "project", declaredBy: "marker" });
  const s = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: p.id });
  const t = memory.store.appendTurn({ sessionId: s.id, userPrompt: "word ".repeat(extra.raw) + "source", assistantText: null, kind: "turn", startedAt: time });
  const entries = memory.store.sourcePath(s.id, "main", t.id);
  const factText = "word ".repeat(extra.facts) + "required fact";
  const knowledgeText = "word ".repeat(extra.knowledge) + "current complete knowledge";
  // Explicit historical/manual fixture mode for one whole giant item at an exact read-only
  // compaction boundary. The default N/C fixture never silently changes authority by item size.
  const f = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: historicalManual ? "manual" : "noting", createdAt: time }, entryIds: noted ? entries.map(e => e.id) : [],
    facts: [{ turnId: t.id, text: factText, category: "observation", actor: "user", source: [`T${t.id}#user`], entryIds: entries.map(e => e.id), createdAt: time }] });
  if (!f.ok) throw new Error(JSON.stringify(f));
  const k = memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: historicalManual ? "manual" : "consolidation", createdAt: time }, consolidated: consolidated ? [f.facts[0]!.id] : [],
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
  const seed = fixture(undefined, false);
  const floor = charged(memory.compact(seed.s.id, "main", seed.t.id));
  memory.close(); memory = open();
  memory.config.render.entryTokens = 30_000;
  setKnowledgeInjection(memory, 100_000);
  setSharedAllowance(memory, 100_000);
  const result = fixture({ knowledge: target.knowledge - floor.knowledge,
    facts: target.facts - floor.facts, raw: target.raw - floor.raw }, false, false, true);
  expect(charged(memory.compact(result.s.id, "main", result.t.id))).toMatchObject(target);
  setKnowledgeInjection(memory, 20_000);
  setSharedAllowance(memory, 20_000);
  return result;
}

function positiveExcess(value: { knowledge: number; facts: number; raw: number }) {
  return Math.max(0, value.knowledge - 20_000) + Math.max(0, value.facts - 10_000) + Math.max(0, value.raw - 10_000);
}

test("73: current Knowledge is optional regardless of Dreamer processing state", () => {
  const { s, t } = fixture({ knowledge: 6_000, facts: 0, raw: 0 }, true, false, true);
  setKnowledgeInjection(memory, 1);
  setSharedAllowance(memory, 0);
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result).toBe(false);
  expect(compacted(result)).not.toContain("current complete knowledge");
});

test("73: pending facts and Raw fit at exact shared boundary and truncate one token below", () => {
  const { s, t, f } = exactFixture({ knowledge: 20_000, facts: 14_000, raw: 16_003 });
  setSharedAllowance(memory, 10_003);
  const fitted = memory.compact(s.id, "main", t.id);
  expect(charged(fitted)).toMatchObject({ knowledge: 20_000, facts: 14_000, raw: 16_003, envelope: 50_003 });
  expect("native" in fitted ? [] : fitted.supplied.factIds).toContain(f.id);
  expect(memory.compact(s.id, "main", t.id)).toEqual(fitted);

  // 73: no fallback. One token short of what the facts window needs, the single pending fact does
  // not fit at all — Knowledge and Raw, allocated first, are untouched — so it is omitted and
  // receipted rather than delegated.
  setSharedAllowance(memory, 10_002);
  const short = memory.compact(s.id, "main", t.id);
  expect("native" in short).toBe(false);
  if ("native" in short) throw new Error("unreachable");
  expect(short.supplied.factIds).not.toContain(f.id);
  expect(charged(short).knowledge).toBe(20_000);
  expect(charged(short).raw).toBe(16_003);
  expect(short.truncated?.facts?.count).toBe(1);
  expect(short.truncated?.facts?.tokens).toBeGreaterThan(0);
  expect(compacted(short)).toContain(`omitted 1 older facts; expand: F${f.id}`);
});

test("73: Knowledge borrows the shared allowance before Raw, so Raw can lose out entirely", () => {
  const { s, t, f } = exactFixture({ knowledge: 35_000, facts: 10_000, raw: 16_000 });
  // exactFixture leaves the allowance at 20,000: Knowledge (needs 15,000 to reach 35,000) takes all
  // of it first, leaving 5,000 — short of the 6,000 Raw needs, so the one pending Raw entry (there is
  // only one, so it is all or nothing) is omitted whole rather than Knowledge giving any of it back.
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect(windows.knowledge).toBe(35_000);
  // The fixture sized facts at 10,000 beside a non-empty Raw window, which opens the `<episodic>`
  // block. With Raw emitting nothing, the facts window opens it and is charged the tag it now emits.
  expect(windows.facts).toBe(10_000 + charge([xmlBlock("episodic", "")]));
  expect(windows.raw).toBeLessThan(16_000);
  expect("native" in result ? [] : result.supplied.factIds).toContain(f.id);
  expect("native" in result ? [] : result.supplied.entries).toEqual([]);
  expect("native" in result ? undefined : result.truncated?.raw?.entries).toBe(1);
  expect(windows.knowledge + windows.facts + windows.raw).toBeLessThanOrEqual(windows.envelope);
});

test("73: optional Knowledge still yields to what Raw and facts need once Knowledge itself is satisfied", () => {
  const { s, t, f } = exactFixture({ knowledge: 21_000, facts: 14_000, raw: 16_000 });
  // Knowledge needs only 1,000 of the 20,000 allowance; the remaining 19,000 covers Raw's 6,000 and
  // facts' 4,000 excess with room to spare — nothing here is omitted.
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect(windows).toMatchObject({ knowledge: 21_000, facts: 14_000, raw: 16_000 });
  expect("native" in result ? [] : result.supplied.factIds).toContain(f.id);
  expect("native" in result).toBe(false);
  if (!("native" in result)) expect(result.truncated).toBeUndefined();
  expect(positiveExcess(windows)).toBeLessThanOrEqual(20_000);
});

test("73: an unconsolidated fact may still borrow the allowance when the Knowledge base is zero", () => {
  const { s, t } = exactFixture({ knowledge: 5_000, facts: 10_000, raw: 10_000 });
  setKnowledgeInjection(memory, 0);
  const raw = memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeId: "history", nativeLineage: "fixture",
    role: "assistant", text: "word ".repeat(2_000), raw: "", calls: [] });
  const history = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "manual", createdAt: time }, entryIds: [],
    facts: [{ turnId: t.id, text: "word ".repeat(2_000) + "historical fact", category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time }] });
  if (!history.ok) throw new Error(JSON.stringify(history));
  const result = memory.compact(s.id, "main", t.id);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toContain(raw.id);
  expect("native" in result ? [] : result.supplied.factIds).toContain(history.facts[0]!.id);
});

test("73: processed Raw and processed facts each fill only their own base remainder, never the shared allowance", () => {
  // The fixture'''s own fact and Raw entry are the OLDEST candidates in their windows (73 chooses
  // newest first) — 9,000 tokens each. Marked processed below, they may spend only what a newer
  // pending item leaves of the 10,000-token base, never the allowance however free it is.
  const { s, t, f } = exactFixture({ knowledge: 20_000, facts: 9_000, raw: 9_000 });
  setSharedAllowance(memory, 50_000);
  const primaryEntry = memory.store.sourcePath(s.id, "main", t.id)[0]!;
  expect(memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    entryIds: [primaryEntry.id], facts: [] }).ok).toBe(true);
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "consolidation", createdAt: time }, operations: [], consolidated: [f.id] });
  // A newer pending fact and Raw entry, each claiming most of their own 10,000-token base first —
  // 8,000 tokens, leaving only 1,000 leftover, short of the processed items''' 9,000.
  const newest = memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeId: "newest", nativeLineage: "fixture",
    role: "assistant", text: "word ".repeat(8_000), raw: "", calls: [] });
  expect(memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "manual", createdAt: time },
    facts: [{ turnId: t.id, text: "word ".repeat(8_000) + "NEWEST FACT", category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time }] }).ok).toBe(true);
  const result = memory.compact(s.id, "main", t.id), windows = charged(result);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toContain(newest.id);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).not.toContain(primaryEntry.id);
  expect("native" in result ? [] : result.supplied.factIds).not.toContain(f.id);
  expect(windows.facts).toBeLessThanOrEqual(10_000);
  expect(windows.raw).toBeLessThanOrEqual(10_000);
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
  memory.config.compaction.rawTokens = charged(full).raw;
  memory.config.compaction.sharedAllowanceTokens = 0;
  setKnowledgeInjection(memory, 0);
  const result = memory.compact(s.id, "main", later.id), text = compacted(result);
  for (const marker of ["partly covered", "incomplete binding", "old pending fact hole"]) expect(text).toContain(marker);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toEqual([entries[0]!.id, newer.id]);
  expect(memory.pendingEntries(s.id, "main", later.id).map(e => e.id)).toEqual([entries[0]!.id]);
});

test("32e coverage filtering precedes fact prefix budgeting and retained fact IDs deduplicate", () => {
  const { s, t, entries } = fixture(undefined, true, true);
  const history = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: time }, entryIds: entries.map(e => e.id), facts: [
    { turnId: t.id, text: "older unknown binding", category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time },
    { turnId: t.id, text: "newest covered " + "word ".repeat(850), category: "observation", actor: "user", source: [`T${t.id}#user`], entryIds: entries.map(e => e.id), createdAt: time },
  ] });
  if (!history.ok) throw new Error(JSON.stringify(history));
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: time }, operations: [], consolidated: history.facts.map(f => f.id) });
  memory.config.compaction.factsTokens = 200;
  const result = memory.compact(s.id, "main", t.id);
  expect(compacted(result)).toContain("older unknown binding");
  expect("native" in result ? [1] : result.supplied.factIds).toEqual([history.facts[0]!.id]);
  // Retained (already visible to the caller) deduplicates it out of the facts window entirely,
  // rather than showing it a second time.
  const retained = noVisibility(); retained.factIds.add(history.facts[0]!.id);
  const deduped = memory.compact(s.id, "main", t.id, retained);
  expect("native" in deduped ? [1] : deduped.supplied.factIds).not.toContain(history.facts[0]!.id);
  expect("native" in deduped ? -1 : charged(deduped).facts).toBeLessThan(charged(result).facts);
});
