import { expect, test, vi } from "vitest";
import { sourceSeededMemory , hydrate } from "../../source-fixture.ts";
import { renderEntry, tokens } from "../../../src/core/render/index.ts";
import { legacyFacts } from "../../support/seed.ts";

test("N pending token projection shares joined entries with exact trigger eligibility", () => {
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
      const user = hydrate(store.listSourceEntries(session.id, turn.id), store).find(entry => entry.role === "user")!;
      legacyFacts(store, { kind: "manual", sessionId: session.id, createdAt: "now" }, [{
        sources: [{ entry: user, address: `T${turn.id}#user` }], category: "decision", actor: "user", text: `rule ${turn.id}`, createdAt: "now",
      }]);
    }
    const expectedRaw = tokens(hydrate(store.pendingEntries(session.id, "main", b.id), store).map(e => renderEntry(e, memory.config.render, memory.resultText).content).join("\n\n"));
    // Historical facts remain stored but no longer contribute to a live C trigger.
    expect(store.consolidationBatch(session.id, "main", b.id)).toHaveLength(2);
    for (const [phase, expected] of [["noting", expectedRaw]] as const) {
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
      const user = hydrate(s.listSourceEntries(session.id, turn.id), s).find(entry => entry.role === "user")!;
      const noted = legacyFacts(s, { kind: "manual", sessionId: session.id, createdAt: "now" }, [{
        sources: [{ entry: user, address: `T${turn.id}#user` }], category: "decision", actor: "user", text, createdAt: "now",
      }]);
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
    const projectTokens = (target: typeof targetA) => memory.dreamingPending(target).pending!.tokens;
    const small = projectTokens(targetA), large = projectTokens(targetB);
    expect(large).toBeGreaterThan(small);
    expect(projectTokens(reader)).toBe(small);
    memory.declareProject(session.id, "B", "mark", reader);
    expect(projectTokens(reader)).toBe(large);
    const sibling = s.appendTurn({ sessionId: targetB.sessionId, kind: "turn", userPrompt: "unrelated sibling", startedAt: "now" });
    s.selectSourcePath(targetB.sessionId, "sibling", []);
    s.setCurrentPath(targetB.sessionId, "sibling", sibling.id, "test-lineage");
    expect(projectTokens({ ...targetB, branch: "sibling", headTurnId: sibling.id })).toBe(0);
  } finally { memory.close(); }
});

test("104: dreamingPending is the session's summed pending weight and knowledge total, the figures duePools decides on", () => {
  const memory = sourceSeededMemory(":memory:", vi.fn());
  try {
    const store = memory.store, project = store.createProject({ name: "P", declaredBy: "mark" });
    const session = store.createSession({ host: "test", projectId: project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
    const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
    const user = hydrate(store.listSourceEntries(session.id, turn.id), store).find(entry => entry.role === "user")!;
    const noted = legacyFacts(store, { kind: "manual", sessionId: session.id, createdAt: "now" }, [{
      sources: [{ entry: user, address: `T${turn.id}#user` }], category: "decision", actor: "user", text: "rule", createdAt: "now",
    }]);
    const create = (scope: "global" | "project" | "session", text: string) => {
      const written = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [
        { op: "create", handle: `$${scope}`, author: "test", text, category: "constraint", scope, supports: [noted.facts[0]!.id], topics: [], reason: "test", createdAt: "now" },
      ] });
      if (!written.ok) throw Error(written.problems.join());
    };
    // Three pools with pending material. Budgets stay above each pool's whole rendered size, so
    // the summed pending weight alone decides.
    create("global", "global body ".repeat(5));
    create("project", "project body ".repeat(30));
    create("session", "session body ".repeat(15));
    memory.setKnowledgeBudget("global", 150);
    memory.setKnowledgeBudget("project", 200);
    memory.setKnowledgeBudget("session", 120);
    const target = { sessionId: session.id, branch: "main", headTurnId: turn.id };
    const pools = store.knowledgePools(target);
    expect(pools.every(pool => pool.pending.length > 0 && pool.tokens <= pool.budget)).toBe(true);
    const pending = pools.reduce((sum, pool) => sum + pool.pending.reduce((total, value) => total + value.tokens, 0), 0);
    memory.config.dreaming.triggerTokens = pending;
    expect(memory.dreamingPending(target)).toEqual({ state: "known", pending: { tokens: pending, trigger: pending },
      knowledge: { tokens: pools.reduce((sum, pool) => sum + pool.tokens, 0), window: 150 + 200 + 120 + memory.config.compaction.sharedAllowanceTokens } });
    expect(memory.taskEligibility("dreaming", target).due).toBe(true);
    memory.config.dreaming.triggerTokens = pending + 1;
    expect(memory.taskEligibility("dreaming", target).due).toBe(false);
  } finally { memory.close(); }
});

test("upToTrigger counts Noting only up to its trigger and reports the exact pending entry count (maintainer, 2026-09-25)", () => {
  const memory = sourceSeededMemory(":memory:", vi.fn());
  try {
    const store = memory.store, project = store.createProject({ name: "A", declaredBy: "mark" });
    const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
    let parent: number | undefined;
    for (let i = 0; i < 6; i++) parent = store.appendTurn({ sessionId: session.id, ...(parent ? { parentTurnId: parent } : {}), kind: "turn",
      userPrompt: `prompt ${i} `.repeat(40), assistantText: `answer ${i}`, startedAt: `2026-01-0${i + 1}T00:00:00Z` }).id;
    const target = { sessionId: session.id, branch: "main", headTurnId: parent! };
    const exact = memory.pendingTokens("noting", target), entries = store.pendingEntries(session.id, "main", parent!).length;
    if (exact.state !== "known") throw Error("pending is unknown");
    memory.config.noting.triggerTokens = Math.floor(exact.tokens / 3);
    expect(memory.pendingTokens("noting", target, true)).toEqual({ tokens: memory.config.noting.triggerTokens,
      trigger: memory.config.noting.triggerTokens, state: "known", atLeast: true, entries });
    expect(memory.pendingTokens("noting", target).tokens).toBe(exact.tokens); // the default stays exact
    memory.config.noting.triggerTokens = exact.tokens + 1;
    expect(memory.pendingTokens("noting", target, true)).toEqual({ tokens: exact.tokens, trigger: exact.tokens + 1, state: "known" });
  } finally { memory.store.close(); }
});
