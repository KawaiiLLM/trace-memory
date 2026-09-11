import { expect, test, vi } from "vitest";
import { sourceSeededMemory } from "../../source-fixture.ts";
import { renderEntry, renderFact, renderFactGroups, tokens } from "../../../src/core/render/index.ts";

test("pending token projection shares joined entries and grouped facts with exact trigger eligibility", () => {
  const agent = vi.fn();
  const memory = sourceSeededMemory(":memory:", agent);
  try {
    const store = memory.store, project = store.createProject({ name: "A", declaredBy: "mark" });
    const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
    const a = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "first", assistantText: "answer", startedAt: "2026-01-01T00:00:00Z" });
    const b = store.appendTurn({ sessionId: session.id, parentTurnId: a.id, kind: "turn", userPrompt: "second", startedAt: "2026-01-02T00:00:00Z" });
    const sibling = store.appendTurn({ sessionId: session.id, parentTurnId: a.id, kind: "turn", userPrompt: "sibling ".repeat(100), startedAt: "2026-01-03T00:00:00Z" });
    const target = { sessionId: session.id, branch: "main", headTurnId: b.id };
    for (const turn of [a, b, sibling]) {
      const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
        { turnId: turn.id, category: "decision", actor: "user", text: `rule ${turn.id}`, source: [`T${turn.id}#user`], createdAt: "now" },
      ] });
      if (!noted.ok) throw Error(noted.problems.join());
    }
    const expectedRaw = tokens(store.pendingEntries(session.id, "main", b.id).map(e => renderEntry(e, memory.config.render, memory.resultText).content).join("\n\n"));
    const facts = store.consolidationBatch(session.id, "main", b.id);
    const expectedFacts = tokens(renderFactGroups(facts, f => renderFact(f, store.listFactRelations(f.id)), store.factTurnTimes(facts)).join("\n"));
    expect(expectedFacts).toBeGreaterThan(tokens(facts.map(f => renderFact(f, store.listFactRelations(f.id))).join("\n"))); // group framing counts
    for (const [phase, expected] of [["noting", expectedRaw], ["consolidation", expectedFacts]] as const) {
      expect(memory.pendingTokens(phase, target).tokens).toBe(expected);
      for (const threshold of [expected + 1, expected, expected - 1]) {
        memory.config[phase].triggerTokens = threshold;
        expect(memory.pendingTokens(phase, target).trigger).toBe(threshold);
        expect(memory.taskEligibility(phase, target).due).toBe(expected >= threshold);
      }
      expect(memory.pendingTokens(phase, { ...target, headTurnId: a.id }).tokens).toBeLessThan(expected);
    }
    expect(memory.pendingTokens("noting", { ...target, branch: "sibling", headTurnId: sibling.id }).tokens).toBeGreaterThan(expectedRaw);
    store.setEnrollment(session.id, false);
    expect(memory.pendingTokens("noting", target).tokens).toBe(expectedRaw); // Off is not zero
    expect(memory.taskEligibility("noting", target).due).toBe(false);
    expect(memory.pendingTokens("noting").state).toBe("no session");
    expect(memory.pendingTokens("noting", { ...target, sessionId: 9999 }).state).toBe("unavailable");
    expect(agent).not.toHaveBeenCalled();
  } finally { memory.close(); }
});

test("Dreaming projection follows the selected head and current project, not database totals", () => {
  const memory = sourceSeededMemory(":memory:", vi.fn());
  try {
    const s = memory.store, a = s.createProject({ name: "A", declaredBy: "mark" }), b = s.createProject({ name: "B", declaredBy: "mark" });
    const create = (projectId: number, text: string) => {
      const session = s.createSession({ host: "test", projectId, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
      const turn = s.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: text, startedAt: "now" });
      const noted = s.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
        { turnId: turn.id, category: "decision", actor: "user", text, source: [`T${turn.id}#user`], createdAt: "now" },
      ] });
      if (!noted.ok) throw Error(noted.problems.join());
      const written = s.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [
        { op: "create", handle: "$1", author: "test", text, category: "constraint", scope: "project", supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now" },
      ] });
      if (!written.ok) throw Error(written.problems.join());
      return { sessionId: session.id, branch: "main", headTurnId: turn.id };
    };
    const targetA = create(a.id, "small"), targetB = create(b.id, "large ".repeat(200));
    const session = s.createSession({ host: "test", projectId: a.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = s.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "reader", startedAt: "now" });
    const reader = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const small = memory.pendingTokens("dreaming", targetA).tokens, large = memory.pendingTokens("dreaming", targetB).tokens;
    expect(large).toBeGreaterThan(small!);
    expect(memory.pendingTokens("dreaming", reader).tokens).toBe(small);
    s.declareProject(session.id, "B", "mark");
    expect(memory.pendingTokens("dreaming", reader).tokens).toBe(large);
    const sibling = s.appendTurn({ sessionId: targetB.sessionId, kind: "turn", userPrompt: "unrelated sibling", startedAt: "now" });
    expect(memory.pendingTokens("dreaming", { ...targetB, branch: "sibling", headTurnId: sibling.id }).tokens).toBe(0);
  } finally { memory.close(); }
});
