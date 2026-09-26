import { expect, test } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { piSourceBlocks } from "../../../src/hosts/pi/source.ts";
import { resolveFactSource, sourceAddresses } from "../../../src/core/model/source.ts";
import { renderEntryIndex } from "../../../src/core/render/index.ts";

function fixture() {
  const m = TraceMemory(":memory:", async () => { throw Error("offline only"); }, {}, undefined, piSourceBlocks);
  const projectId = m.store.createProject({ name: "thinking", declaredBy: "mark" }).id;
  const sessionId = m.store.createSession({ projectId, host: "test", startedAt: "now", firstReplyAt: "now", enrollmentChoice: true }).id;
  const turnId = m.store.appendTurn({ sessionId, kind: "turn", startedAt: "now" }).id;
  const thinking = { type: "thinking", thinking: "Private inference is not factual evidence" };
  const call = { callId: "check", ordinal: 1, name: "bash", input: "{}", status: "attempted" };
  const pure = m.appendEntry({ sessionId, turnId, nativeLineage: "test", nativeId: "pure", role: "assistant", text: "", calls: [], raw: JSON.stringify({ role: "assistant", content: [thinking] }) });
  const mixed = m.appendEntry({ sessionId, turnId, nativeLineage: "test", nativeId: "mixed", role: "assistant", text: "Public explanation", calls: [call], raw: JSON.stringify({ role: "assistant", content: [thinking, { type: "text", text: "Public explanation" }, { type: "toolCall", id: "check", name: "bash", arguments: {} }] }) });
  const result = m.appendEntry({ sessionId, turnId, nativeLineage: "test", nativeId: "result", role: "toolResult", text: "", calls: [{ ...call, status: "success", result: "Passed" }], raw: JSON.stringify({ role: "toolResult", toolCallId: "check", content: [{ type: "text", text: "Passed" }] }) });
  const entries = [pure, mixed, result]; m.selectEntries(sessionId, "main", entries.map(e => e.id));
  return { m, sessionId, turnId, entries, pure, mixed };
}
for (const kind of ["manual", "noting"] as const) test(`thinking: ${kind} rejects new thinking facts but retains explicit reads and mixed evidence`, () => {
  const f = fixture();
  try {
    const tools = f.m.tools(kind === "manual" ? { kind, sessionId: f.sessionId, branch: "main", currentTurnId: f.turnId }
      : { kind, sessionId: f.sessionId, branch: "main", entryIds: f.entries.map(e => e.id), range: { from: "S1/T1", to: "S1/T1" } });
    const note = tools.find(t => t.name === "note")!, trace = tools.find(t => t.name === "trace")!;
    const fact = (source: string[]) => ({ category: "observation", actor: "agent", text: "An observation", source });
    for (const source of ["T1#E1", "T1#E1@thinking", "T1#E2@thinking"]) {
      expect(note.execute({ facts: [fact(["T1#E2@text"]), fact([source])] })).toContain("thinking are not fact sources");
      expect(f.m.store.listTurnFacts(1)).toHaveLength(0);
      expect(f.m.store.entryNoted(f.pure.id)).toBe(false);
    }
    expect(trace.execute({ address: "T1#E1@thinking" })).toContain("Private inference");
    expect(trace.execute({ address: "T1#E2@thinking" })).toContain("Private inference");
    expect(trace.execute({ address: "T1", full: true })).not.toContain("Private inference");
    const carry = f.m.branchSummary(f.sessionId, "main", f.turnId);
    expect(carry).toContain("Public explanation");
    expect(carry).not.toContain("Private inference");
    expect(renderEntryIndex(f.pure)).toContain("[T1#E1]");
    expect(renderEntryIndex(f.mixed)).not.toContain("thinking");
    expect(resolveFactSource(f.entries, "T1#E2")[0]!.blocks.map(b => b.kind)).toEqual(["text", "call"]);
    expect(note.execute({ facts: [fact(["T1#E2"]), fact(["T1#E2@text"]), fact(["T1#E2@check"]), fact(["T1#E3@check"]),
      { ...fact(["T1#E2", "T1#E3"]), category: "event", status: "completed" }] })).not.toContain("rejected:");
  } finally { f.m.close(); }
});

test.each([true, false])("thinking: historical facts and knowledge remain visible (entry bindings: %s)", bound => {
  const f = fixture();
  try {
    // Simulate a fact already stored under the reviewed policy; never use new-note validation to import history.
    const sources = ["T1#E1@thinking", "T1#E1"];
    const legacy = f.m.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "now" }, entryIds: [f.pure.id], facts: sources.map(source => ({ turnId: 1, category: "observation" as const, actor: "agent" as const, text: "Historical inference", source: [source], ...(bound ? { entryIds: [f.pure.id] } : {}), createdAt: "now" })) });
    if (!legacy.ok) throw Error(legacy.problems.join());
    const knowledge = f.m.store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "now" }, operations: [{ op: "create", handle: "$1", author: "test", text: "Historical knowledge", category: "mechanism", scope: "project", supports: legacy.facts.map(fact => fact.id), reason: "Historical support", topics: [], createdAt: "now" }] });
    expect(knowledge.ok).toBe(true);
    expect(sourceAddresses(f.pure)).toEqual(expect.arrayContaining(sources));
    const raw = f.m.store.getSourceEntry(f.pure.id)!.raw;
    for (const fact of legacy.facts) {
      expect(f.m.store.getFact(fact.id)!.source).toEqual(fact.source);
      expect(f.m.store.factCoveredByRaw(fact, new Set([f.pure.id]))).toBe(bound);
      expect(f.m.store.factOnPath(fact, { sessionId: 1, branch: "main", headTurnId: 1 })).toBe(true);
      expect(f.m.trace(`F${fact.id}`)).toContain("Historical inference");
    }
    expect(f.m.store.currentKnowledge({ sessionId: 1, branch: "main", headTurnId: 1 })).toHaveLength(1);
    expect(f.m.trace("K1")).toContain("Historical knowledge");
    expect(f.m.trace("T1#E1@thinking")).toContain("Private inference");
    expect(f.m.store.getSourceEntry(f.pure.id)!.raw).toBe(raw);
  } finally { f.m.close(); }
});
