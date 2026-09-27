import { expect, test } from "vitest";
import { TraceMemory, DEFAULT_CONFIG, renderEntry, tokens } from "../../../src/core/api/index.ts";
import { renderFact, renderFactGroups } from "../../../src/core/render/index.ts";
import { rawWindowTokens } from "../../../src/core/render/material.ts";
import { unifiedFixture } from "../../fixtures/unified-entry.ts";

const time = "2026-09-01T00:00:00Z";
test("33: fixed realistic fixture prices the exact Raw bytes for status, trigger and oldest-prefix batching", () => {
  const fixture = unifiedFixture();
  const blocks = new Map(fixture.entries.map(entry => [entry.nativeId, entry.blocks]));
  const memory = TraceMemory(":memory:", async () => { throw new Error("no provider"); }, {}, undefined, entry => blocks.get(entry.nativeId));
  try {
    const projectId = memory.store.createProject({ name: "fixed-review", declaredBy: "mark" }).id;
    const sessionId = memory.store.createSession({ host: "fixture", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
    let head: number | null = null;
    const entries = fixture.entries.map(entry => {
      if (entry.entryOrdinal === 1) head = memory.store.appendTurn({ sessionId, parentTurnId: head, kind: "turn", startedAt: time }).id;
      const { id: _id, entryOrdinal: _ordinal, blocks: _blocks, ...input } = entry;
      return memory.appendEntry(input);
    });
    const target = { sessionId, branch: "main", headTurnId: head! };
    memory.selectEntries(sessionId, "main", entries.map(entry => entry.id));
    const views = entries.map(entry => renderEntry(entry, memory.config.render).content);
    const actual = views.join("\n\n");
    expect(Buffer.byteLength(actual)).toBe(108766);
    expect(tokens(actual)).toBe(25619);
    expect(memory.pendingTokens("noting", target)).toEqual({ tokens: tokens(actual), trigger: 10000, state: "known" });
    expect(memory.config.noting).toEqual(DEFAULT_CONFIG.noting);
    expect(memory.taskEligibility("noting", target)).toEqual({ due: true });
    const batch = memory.notingBatch(target);
    expect(batch).toHaveLength(92);
    expect(rawWindowTokens(views.slice(0, batch.length), [])).toBeLessThanOrEqual(10000);
    expect(tokens(views.slice(0, batch.length + 1).join("\n\n"))).toBeLessThanOrEqual(10000); // bare Raw is not the batch charge
    expect(rawWindowTokens(views.slice(0, batch.length + 1), [])).toBeGreaterThan(10000); // full framing rejects the next entry
    for (const count of [93, 94]) {
      memory.selectEntries(sessionId, "main", entries.slice(0, count).map(entry => entry.id));
      const measured = tokens(views.slice(0, count).join("\n\n"));
      expect(memory.pendingTokens("noting", target).tokens).toBe(measured);
      expect(memory.taskEligibility("noting", target).due).toBe(count === 94);
    }
  } finally { memory.close(); }
});

test("33: automatic semantic bodies remain complete beyond the trace item default", () => {
  const memory = TraceMemory(":memory:", async () => { throw new Error("no provider"); });
  try {
    const projectId = memory.store.createProject({ name: "semantic", declaredBy: "mark" }).id;
    const sessionId = memory.store.createSession({ host: "fixture", projectId, startedAt: time, firstReplyAt: time, enrollmentChoice: true }).id;
    const turn = memory.store.appendTurn({ sessionId, kind: "turn", startedAt: time }).id;
    const entry = memory.appendEntry({ sessionId, turnId: turn, nativeLineage: "fixture", nativeId: "user", role: "user", text: "evidence", raw: "evidence", calls: [] });
    memory.selectEntries(sessionId, "main", [entry.id]);
    const text = "Complete semantic evidence must survive material assembly. ".repeat(300);
    const committed = memory.store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time }, facts: [
      { turnId: turn, category: "observation", actor: "user", text, source: [`T${turn}#E1`], createdAt: time, entryIds: [entry.id] }] });
    if (!committed.ok) throw new Error(committed.problems.join("; "));
    const fact = committed.facts[0]!;
    const target = { sessionId, branch: "main", headTurnId: turn };
    const lines = renderFactGroups([fact], f => renderFact(f, []), memory.store.factTurnTimes([fact])).join("\n");
    expect(tokens(lines)).toBeGreaterThan(2000);
    expect(lines).toContain(text); // the complete stored body survives automatic fact rendering
    expect(memory.trace(`F${fact.id}`, { pageBudget: null })).toContain("characters truncated");
    expect(memory.trace(`F${fact.id}`, { full: true, pageBudget: null })).toContain(text);
    const compact = memory.compact(sessionId, "main", turn);
    expect("native" in compact).toBe(false);
    if ("native" in compact) throw new Error(compact.reason);
    expect(compact.text).toContain(text);
    expect(compact.supplied.factIds).toContain(fact.id);
  } finally { memory.close(); }
});
