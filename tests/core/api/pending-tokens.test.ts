import { expect, test, vi } from "vitest";
import { sourceSeededMemory , hydrate } from "../../source-fixture.ts";
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
    const expectedRaw = tokens(hydrate(store.pendingEntries(session.id, "main", b.id), store).map(e => renderEntry(e, memory.config.render, memory.resultText).content).join("\n\n"));
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
    // All fixture knowledge is project-scoped; only the project pool carries pending material.
    const projectTokens = (target: typeof targetA) => memory.dreamingPending(target).pools!.find(pool => pool.scope === "project")!.tokens;
    const small = projectTokens(targetA), large = projectTokens(targetB);
    expect(large).toBeGreaterThan(small);
    expect(projectTokens(reader)).toBe(small);
    s.declareProject(session.id, "B", "mark");
    expect(projectTokens(reader)).toBe(large);
    const sibling = s.appendTurn({ sessionId: targetB.sessionId, kind: "turn", userPrompt: "unrelated sibling", startedAt: "now" });
    s.selectSourcePath(targetB.sessionId, "sibling", []);
    s.setCurrentPath(targetB.sessionId, "sibling", sibling.id, "test-lineage");
    expect(projectTokens({ ...targetB, branch: "sibling", headTurnId: sibling.id })).toBe(0);
  } finally { memory.close(); }
});

test("dreamingPending lists every pool in fixed order (global, project, session), each with its own pending tokens and effective trigger matching duePools", () => {
  const memory = sourceSeededMemory(":memory:", vi.fn());
  try {
    const store = memory.store, project = store.createProject({ name: "P", declaredBy: "mark" });
    const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
    const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [
      { turnId: turn.id, category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#user`], createdAt: "now" },
    ] });
    if (!noted.ok) throw Error(noted.problems.join());
    const create = (scope: "global" | "project" | "session", text: string) => {
      const written = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [
        { op: "create", handle: `$${scope}`, author: "test", text, category: "constraint", scope, supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now" },
      ] });
      if (!written.ok) throw Error(written.problems.join());
    };
    // Three pools with different pending amounts. Budgets stay above each pool's whole rendered
    // size so only the "pending at/over trigger" rule is exercised here, not the separate
    // over-budget rule (covered elsewhere) — keeping this test's due/not-due split unambiguous.
    create("global", "global body ".repeat(5));
    create("project", "project body ".repeat(30));
    create("session", "session body ".repeat(15));
    memory.setKnowledgeBudget("global", 150);
    memory.setKnowledgeBudget("project", 200);
    memory.setKnowledgeBudget("session", 120);
    memory.config.dreaming.triggerTokens = 80;
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const result = memory.dreamingPending(target);
    expect(result.state).toBe("known");
    const pools = result.pools!;
    expect(pools.map(pool => pool.scope)).toEqual(["global", "project", "session"]);
    const [global, projectPool, sessionPool] = pools;
    // Different pending amounts (project's longer body outweighs the others).
    expect(global!.tokens).toBeGreaterThan(0);
    expect(projectPool!.tokens).toBeGreaterThan(global!.tokens);
    expect(projectPool!.tokens).toBeGreaterThan(sessionPool!.tokens);
    // Effective trigger is min(configured trigger cap, pool budget); every budget here exceeds the
    // 80-token cap, so the cap itself binds for all three pools.
    for (const pool of pools) expect(pool.trigger).toBe(80);
    // Each pool's due decision agrees with duePools: a pool at/over its trigger with pending
    // material is due. Only project's pending clears the shared 80-token trigger.
    const due = new Set(store.duePools(target, memory.config.dreaming.triggerTokens).map(pool => pool.pool));
    for (const pool of pools) expect(due.has(pool.pool)).toBe(pool.tokens >= pool.trigger);
    expect(due.has(projectPool!.pool)).toBe(true);
    expect(due.has(global!.pool)).toBe(false);
    expect(due.has(sessionPool!.pool)).toBe(false);
  } finally { memory.close(); }
});
