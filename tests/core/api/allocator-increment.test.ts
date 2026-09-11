import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, compacted } from "../../source-fixture.ts";
import { noVisibility } from "../../../src/core/api/visible.ts";

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
    operations: [{ op: "create", topics: [], handle: "$k", author: "test", text: "word ".repeat(extra.knowledge) + "unprocessed complete knowledge", category: "constraint", scope: "project", supports: [f.facts[0]!.id], reason: "initial", createdAt: time }] });
  if (!k.ok) throw new Error(JSON.stringify(k));
  return { s, t, f: f.facts[0]!, entries };
}
function charged(result: ReturnType<typeof memory.compact>) { if ("native" in result) throw new Error(result.reason); return result.charged!; }

test("28: unprocessed knowledge is required material — consolidation of its facts does not make it optional", () => {
  const { s, t } = fixture();
  const before = memory.compact(s.id, "main", t.id), u = charged(before).required;
  memory.config.render.knowledgeBlockTokens = 1;
  memory.config.compaction.overflowTokens = u.knowledge - 1;
  expect(compacted(memory.compact(s.id, "main", t.id))).toContain("unprocessed complete knowledge");
  memory.config.compaction.overflowTokens--;
  const failure = memory.compact(s.id, "main", t.id);
  expect(failure).toMatchObject({ native: true, over: { knowledge: true, facts: false, raw: false } });
  expect("native" in failure && failure.reason).toContain("shortfall 1");
});

test("32e shared allowance equality and independent optional base remainders include framing", () => {
  const { s, t } = fixture();
  const u = charged(memory.compact(s.id, "main", t.id)).required;
  memory.config.render.knowledgeBlockTokens = u.knowledge - 5;
  memory.config.compaction.factsTokens = u.facts - 2;
  memory.config.compaction.rawTokens = u.raw - 3;
  memory.config.compaction.overflowTokens = 10;
  const fitted = memory.compact(s.id, "main", t.id);
  expect(charged(fitted).required).toEqual(u);
  expect(memory.compact(s.id, "main", t.id)).toEqual(fitted);
  memory.config.compaction.overflowTokens = 9;
  expect(memory.compact(s.id, "main", t.id)).toMatchObject({ native: true, over: { knowledge: true, facts: true, raw: true } });
  memory.config.render.knowledgeBlockTokens = 20_000; // idle K base cannot rescue other excesses
  memory.config.compaction.overflowTokens = 4;
  expect(memory.compact(s.id, "main", t.id)).toMatchObject({ native: true, over: { knowledge: false, facts: true, raw: true } });
});

test("32e final Raw coverage filters optional facts only; retained bounded views count and unknown bindings stay", () => {
  const { s, t, f, entries } = fixture(undefined, true, true);
  const first = memory.compact(s.id, "main", t.id);
  expect("native" in first ? [] : first.supplied.factIds).not.toContain(f.id); // extracted Raw covers the completely bound consolidated fact
  memory.store.db.prepare("DELETE FROM fact_sources WHERE fact_id = ?").run(f.id);
  expect(compacted(memory.compact(s.id, "main", t.id))).toContain("required fact");
  memory.store.db.prepare("INSERT INTO fact_sources VALUES (?, ?)").run(f.id, entries[0]!.id);
  memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time }, facts: [], entryIds: entries.map(e => e.id) });
  const visible = noVisibility(); visible.raw.set(entries[0]!.nativeId, "view");
  const retained = memory.compact(s.id, "main", t.id, visible);
  expect("native" in retained ? [f.id] : retained.supplied.factIds).not.toContain(f.id);
  expect("native" in retained ? [1] : retained.supplied.entries).toEqual([]);
});

/** Calibrate framing using the real renderer, then build a fresh store with exactly charged bodies.
 * No estimator stub, alternate material shape or mutation of immutable production records. */
function exactFixture(target: { knowledge: number; facts: number; raw: number }) {
  const seed = fixture(undefined, false);
  const floor = charged(memory.compact(seed.s.id, "main", seed.t.id)).required;
  memory.close(); memory = open();
  memory.config.render.entryTokens = 30_000;
  const result = fixture({ knowledge: target.knowledge - floor.knowledge,
    facts: target.facts - floor.facts, raw: target.raw - floor.raw }, false);
  // Measure without admission pressure, then restore the real default bases and allowance.
  memory.config.compaction.overflowTokens = 100_000;
  expect(charged(memory.compact(result.s.id, "main", result.t.id)).required).toEqual(target);
  memory.config.compaction.overflowTokens = 10_000;
  return result;
}

test("32e charged 20k/14k/16k fits exactly and one token more fails", () => {
  const { s, t, f } = exactFixture({ knowledge: 20_000, facts: 14_000, raw: 16_000 });
  const result = memory.compact(s.id, "main", t.id);
  expect(charged(result)).toMatchObject({ knowledge: 20_000, facts: 14_000, raw: 16_000, envelope: 50_000 });
  expect("native" in result ? [] : result.supplied.factIds).toContain(f.id); // required overlap stays
  expect(memory.compact(s.id, "main", t.id)).toEqual(result);
  memory.config.compaction.rawTokens--;
  expect(memory.compact(s.id, "main", t.id)).toMatchObject({ native: true, over: { knowledge: false, facts: true, raw: true } });
});

test("32e charged 5k/20k/15k fails despite a 40k total", () => {
  const { s, t } = exactFixture({ knowledge: 5_000, facts: 20_000, raw: 15_000 });
  const result = memory.compact(s.id, "main", t.id);
  expect(result).toMatchObject({ native: true, over: { knowledge: false, facts: true, raw: true } });
  expect("native" in result && result.reason).toContain("shortfall 5000");
});

test("32e charged 25k/8k/6k leaves optional capacity only 0/2k/4k", () => {
  const { s, t } = exactFixture({ knowledge: 25_000, facts: 8_000, raw: 6_000 });
  // Oversized optional entries and unbound facts cannot consume the spare overflow or K base.
  const raw = memory.appendEntry({ sessionId: s.id, turnId: t.id, nativeId: "history", nativeLineage: "fixture",
    role: "assistant", text: "word ".repeat(4_010), raw: "", calls: [] });
  const history = memory.store.commitNotingRun({ run: { sessionId: s.id, branch: "main", kind: "noting", createdAt: time },
    entryIds: [raw.id], facts: [{ turnId: t.id, text: "word ".repeat(2_010), category: "observation", actor: "user", source: [`T${t.id}#user`], createdAt: time }] });
  if (!history.ok) throw new Error(JSON.stringify(history));
  memory.store.commitConsolidationRun({ run: { sessionId: s.id, branch: "main", kind: "consolidation", createdAt: time }, operations: [], consolidated: history.facts.map(f => f.id) });
  const result = memory.compact(s.id, "main", t.id), w = charged(result);
  expect(w.knowledge).toBe(25_000); expect(w.facts).toBeLessThanOrEqual(10_000); expect(w.raw).toBe(6_000);
  expect("native" in result ? [raw.id] : result.supplied.entries.map(e => e.id)).not.toContain(raw.id);
  expect("native" in result ? history.facts.map(f => f.id) : result.supplied.factIds).not.toContain(history.facts[0]!.id);
});

test("32e exact processed version becomes optional; a committed unfinished successor is required", () => {
  const { s, t, f } = fixture();
  const path = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const original = memory.store.listCurrentKnowledge(path)[0]!;
  const success = memory.store.recordRun({ kind: "dreaming", sessionId: s.id, branch: "main", outcome: "success", createdAt: time });
  memory.store.completeDreaming(success.id, [original.revision.id], [original.revision.id]);
  memory.config.render.knowledgeBlockTokens = 1;
  expect(charged(memory.compact(s.id, "main", t.id)).knowledge).toBe(0); // optional cannot use overflow
  const changed = memory.store.commitConsolidationRun({ path, run: { kind: "dreaming", sessionId: s.id, branch: "main", createdAt: time },
    operations: [{ op: "update", knowledgeId: original.knowledge.id, baseCommit: original.revision.id,
      text: "unfinished changed body", category: "constraint", scope: "project", topics: [], supports: [f.id], reason: "changed", createdAt: time }] });
  expect(changed.ok).toBe(true);
  const result = memory.compact(s.id, "main", t.id);
  expect(compacted(result)).toContain("unfinished changed body");
  expect(charged(result).required.knowledge).toBeGreaterThan(1);
});

test("32e unfinished archive status is required until exact completion, without claiming a supplied body", () => {
  const { s, t, f } = fixture();
  const path = { sessionId: s.id, branch: "main", headTurnId: t.id };
  const k = memory.store.listCurrentKnowledge(path)[0]!;
  const range = memory.store.retainDreamingRange(path, [k.revision.id]);
  const archive = memory.store.commitConsolidationRun({ path, run: { kind: "dreaming", dreamingRangeId: range.id, sessionId: s.id, branch: "main", createdAt: time },
    operations: [{ op: "archive", knowledgeId: k.knowledge.id, baseCommit: k.revision.id, supports: [f.id], reason: "retired deliberately", createdAt: time }] });
  if (!archive.ok) throw new Error(JSON.stringify(archive));
  const result = memory.compact(s.id, "main", t.id);
  expect(compacted(result)).toContain("archived; maintenance not completed");
  expect(compacted(result)).toContain("retired deliberately");
  expect("native" in result ? [1] : result.supplied.knowledgeCommitIds).toEqual([]);
  memory.config.render.knowledgeBlockTokens = 1; memory.config.compaction.overflowTokens = 1;
  expect(memory.compact(s.id, "main", t.id)).toMatchObject({ native: true, over: { knowledge: true } });
  const success = memory.store.recordRun({ kind: "dreaming", sessionId: s.id, branch: "main", outcome: "success", createdAt: time });
  memory.store.completeDreaming(success.id, [k.revision.id], [archive.committed[0]!.commit]);
  expect(compacted(memory.compact(s.id, "main", t.id))).not.toContain("maintenance not completed");
});

test("32e old pending hole remains required; partial and incomplete optional bindings survive filtering", () => {
  const { s, t, entries } = fixture();
  const later = memory.store.appendTurn({ sessionId: s.id, parentTurnId: t.id, kind: "turn", userPrompt: "later source", startedAt: "2026-09-07T00:00:00Z" });
  const newer = memory.store.sourcePath(s.id, "main", later.id).at(-1)!;
  const added = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: time }, entryIds: [newer.id],
    facts: [
      { turnId: later.id, text: "partly covered", category: "observation", actor: "user", source: [`T${t.id}#user`, `T${later.id}#user`], entryIds: [entries[0]!.id, newer.id], createdAt: time },
      { turnId: later.id, text: "incomplete binding", category: "observation", actor: "user", source: [`T${t.id}#user`, `T${later.id}#user`], entryIds: [entries[0]!.id], createdAt: time },
      { turnId: t.id, text: "old pending fact hole", category: "observation", actor: "user", source: [`T${t.id}#user`], entryIds: [entries[0]!.id], createdAt: time },
    ] });
  if (!added.ok) throw new Error(JSON.stringify(added));
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: s.id, branch: "main", createdAt: time }, operations: [], consolidated: added.facts.slice(0, 2).map(f => f.id) });
  const full = memory.compact(s.id, "main", later.id);
  // Raw only has room for the old pending hole: newer extracted sources cannot borrow facts' base.
  memory.config.compaction.rawTokens = charged(full).required.raw;
  const result = memory.compact(s.id, "main", later.id), text = compacted(result);
  for (const marker of ["partly covered", "incomplete binding", "old pending fact hole"]) expect(text).toContain(marker);
  expect("native" in result ? [] : result.supplied.entries.map(e => e.id)).toEqual([entries[0]!.id]);
  expect(memory.pendingEntries(s.id, "main", later.id).map(e => e.id)).toEqual([entries[0]!.id]);
});

test("32e coverage filtering precedes fact prefix budgeting and retained fact IDs deduplicate", () => {
  const { s, t, entries } = fixture(undefined, true, true);
  const history = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: s.id, branch: "main", createdAt: time }, entryIds: entries.map(e => e.id),
    facts: [
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
