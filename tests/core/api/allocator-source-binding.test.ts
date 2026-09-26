import { historicalConsolidation } from "../../noting-knowledge-fixture.ts";
import { expect, test, vi } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";

const time = "2026-09-06T00:00:00Z";
function fixture(manual = false, count = 1) {
  const m = TraceMemory(":memory:", async () => { throw new Error("no worker"); });
  const p = m.store.createProject({ name: "p", declaredBy: "marker" });
  const s = m.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: p.id });
  const t = m.store.appendTurn({ sessionId: s.id, userPrompt: null, assistantText: "source", kind: "turn", startedAt: time });
  const append = (nativeId: string) => m.appendEntry({ sessionId: s.id, nativeLineage: "x", nativeId, turnId: t.id, role: "assistant", text: "source " + nativeId, raw: "", calls: [] });
  const entries = [append("a"), append("b")];
  // Historical ambiguous role aliases remain readable. New N input no longer accepts these
  // aliases; seed their original persisted shape through the Store, not the live tool protocol.
  const receipt = m.store.commitNotingRun({ run: { kind: manual ? "manual" : "noting", sessionId: s.id, branch: "main", createdAt: time },
    ...(manual ? {} : { entryIds: entries.map(e => e.id) }), facts: Array.from({ length: count }, (_, i) => ({ turnId: t.id,
      category: "observation", actor: "user", text: `optional fact ${i}`, source: [`T${t.id}#assistant`], entryIds: entries.map(e => e.id), createdAt: time })) });
  if (!receipt.ok) throw new Error(receipt.problems.join("; "));
  const facts = receipt.facts;
  expect(facts).toHaveLength(count);
  for (const f of facts) expect(m.store.factEntries(f.id)).toEqual(entries.map(e => e.id));
  historicalConsolidation(m.store, s.id, facts.map(fact => fact.id));
  const compact = () => { const r = m.compact(s.id, "main", t.id); if ("native" in r) throw new Error(r.reason); return r; };
  return { m, s, t, entries, facts, append, compact };
}
for (const missing of [false, true]) test(`historical note same-address binding: missing=${missing}`, () => {
  const f = fixture();
  try {
    if (missing) f.m.store.db.prepare("DELETE FROM fact_sources WHERE fact_id = ? AND entry_id = ?").run(f.facts[0]!.id, f.entries[0]!.id);
    const r = f.compact();
    expect(r.supplied.entries.map(e => e.id)).toEqual(f.entries.map(e => e.id));
    expect(r.supplied.factIds).toEqual(missing ? [f.facts[0]!.id] : []);
    expect(r.text.includes("optional fact 0")).toBe(missing);
  } finally { f.m.close(); }
});
test("later same-address entry from another run/branch is not an original binding requirement", () => {
  const f = fixture();
  try {
    const later = f.append("later");
    expect(f.m.store.commitNotingRun({ run: { sessionId: f.s.id, branch: "other", kind: "noting", createdAt: time }, facts: [], entryIds: [later.id] }).ok).toBe(true);
    expect(f.m.store.factCoveredByRaw(f.facts[0]!, new Set(f.entries.map(e => e.id)))).toBe(true);
    expect(f.compact().supplied.factIds).toEqual([]);
  } finally { f.m.close(); }
});
test("manual binding has no frozen writer set: conservatively keep", () => {
  const f = fixture(true);
  try { expect(f.compact().supplied.factIds).toEqual([f.facts[0]!.id]); } finally { f.m.close(); }
});
for (const count of [1, 40]) test(`coverage SQL count is bounded per batch: ${count} facts`, () => {
  const f = fixture(false, count);
  try {
    const spy = vi.spyOn(f.m.store.db, "prepare");
    expect(f.m.store.factsCoveredByRaw(f.facts, new Set(f.entries.map(e => e.id))).size).toBe(count);
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockClear();
    f.compact();
    const queries = spy.mock.calls.filter(([sql]) => /fact_sources|json_extract\(content/.test(sql));
    const operations = queries.map(([sql]) => String(sql).replace(/\s+/g, " ").trim());
    process.stdout.write(`coverage SQL: ${count} facts, batch=4, compact related=${queries.length}\n`);
    // Ticket 80 item 3: `compact`'s applicable-fact filter and `unconsolidated`'s per-run
    // `consolidatedOnPath` check now each batch their own `fact_sources` read too (one call each,
    // never one per fact), on top of `currentKnowledge`'s existing graph-build read and
    // `factsCoveredByRaw`'s own batched read — four bounded calls total, still independent of fact count.
    expect(operations).toHaveLength(4);
    expect(operations.filter(sql => sql.startsWith("SELECT fact_id, entry_id FROM fact_sources WHERE fact_id IN (SELECT value FROM json_each(?))")))
      .toHaveLength(3);
    expect(operations.filter(sql => sql.includes("FROM fact_sources b JOIN facts f ON f.id = b.fact_id WHERE f.id IN (SELECT value FROM json_each(?))")))
      .toHaveLength(1);
    expect(operations.some(sql => /WHERE (?:f\.)?id = \?$/.test(sql))).toBe(false);
    spy.mockRestore();
  } finally { f.m.close(); }
});

for (const damage of ["none", "missing", "uncovered", "required"] as const) test(`native tool + cross-Turn frozen sources: ${damage}`, () => {
  const f = fixture();
  try {
    const t = f.m.store.appendTurn({ sessionId: f.s.id, parentTurnId: f.t.id, userPrompt: null, assistantText: null, kind: "turn", startedAt: time });
    const call = f.m.store.appendToolCall({ turnId: t.id, name: "bash", status: "success", result: "passed" });
    const entry = (nativeId: string, role: "assistant" | "toolResult") => f.m.appendEntry({ sessionId: f.s.id, nativeLineage: "x", nativeId, turnId: t.id, role, text: "", raw: "",
      calls: [{ ordinal: call.ordinal, name: "bash", callId: "call", status: "success", ...(role === "assistant" ? { input: "true" } : { result: "passed" }) }] });
    const tool = [entry("call", "assistant"), entry("result", "toolResult")];
    const ids = [...f.entries, ...tool].map(e => e.id);
    const receipt = f.m.store.commitNotingRun({ run: { kind: "noting", sessionId: f.s.id, branch: "main", createdAt: time }, entryIds: ids,
      facts: [{ turnId: f.t.id, category: "observation", actor: "user", text: "cross Turn tool fact",
        source: [`T${f.t.id}#assistant`, `T${t.id}#t${call.ordinal}`], entryIds: ids, createdAt: time }] });
    if (!receipt.ok) throw new Error(receipt.problems.join("; "));
    expect(receipt.facts).toHaveLength(1);
    const fact = receipt.facts[0]!;
    expect(f.m.store.factEntries(fact.id)).toEqual(ids);
    if (damage !== "required") historicalConsolidation(f.m.store, f.s.id, [fact.id]);
    if (damage === "missing") f.m.store.db.prepare("DELETE FROM fact_sources WHERE fact_id = ? AND entry_id = ?").run(fact.id, tool[0]!.id);
    expect(f.m.store.factCoveredByRaw(fact, new Set(damage === "uncovered" ? ids.slice(0, -1) : ids))).toBe(damage === "none" || damage === "required");
    const r = f.m.compact(f.s.id, "main", t.id);
    if ("native" in r) throw new Error(r.reason);
    expect(r.supplied.entries.map(e => e.id)).toEqual(ids);
    // 73: coverage now drops a pending (unconsolidated) fact too, not only a consolidated one — only
    // an incomplete binding ("missing") stays eligible regardless of coverage.
    expect(r.supplied.factIds).toEqual(damage === "missing" ? [fact.id] : []);
  } finally { f.m.close(); }
});
