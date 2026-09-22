import { afterEach, expect, test, vi } from "vitest";
import { TraceMemory, DEFAULT_CONFIG, validateConfig, type DreamingAgentInput, type RunAgentResult } from "../../../src/core/api/index.ts";

const opened: ReturnType<typeof TraceMemory>[] = [];
afterEach(() => { vi.useRealTimers(); for (const memory of opened.splice(0)) memory.close(); });

function setup(agent: (task: DreamingAgentInput) => Promise<RunAgentResult>, dreaming: { triggerTokens?: number; timeoutMs?: number } = {}) {
  const memory = TraceMemory(":memory:", raw => agent(raw as DreamingAgentInput), {
    dreaming: { triggerTokens: dreaming.triggerTokens ?? 1, timeoutMs: dreaming.timeoutMs ?? 600_000 },
  });
  opened.push(memory);
  const store = memory.store;
  const project = store.createProject({ name: "ticket-68", declaredBy: "mark" });
  const session = store.createSession({ host: "test", enrollmentChoice: true, projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "rule", startedAt: "now" });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "test", nativeId: "root", role: "user", text: "rule", raw: "{}", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  const noted = store.commitNotingRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, facts: [{
    turnId: turn.id, entryIds: [entry.id], category: "decision", actor: "user", text: "rule", source: [`T${turn.id}#E1`], createdAt: "now",
  }] });
  if (!noted.ok) throw new Error(noted.problems.join("; "));
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, triggerEntryId: entry.id };
  const create = (scope: "global" | "project" | "session", text: string) => {
    const result = store.commitConsolidationRun({ run: { kind: "manual", sessionId: session.id, createdAt: "now" }, operations: [{
      op: "create", handle: `$${text}`, author: "test", text, category: "constraint", scope,
      supports: [noted.facts[0]!.id], topics: [], reason: "fixture", createdAt: "now",
    }] });
    if (!result.ok) throw new Error(result.problems.join("; "));
    return result.committed[0]!;
  };
  return { memory, store, project, session, target, create };
}

const exactRequest = { exact: "request" };

test("68 defaults pin flat Dreamer trigger, unlimited rounds and ten-minute deadline", () => {
  expect(DEFAULT_CONFIG.dreaming).toEqual({ triggerTokens: 5_000, maxToolRounds: 0, timeoutMs: 600_000 });
  expect(() => validateConfig({ dreaming: { maxToolRounds: 1 } })).toThrow(/Dreamer requires 0/);
  expect(() => validateConfig({ dreaming: { timeoutMs: 2_147_483_648 } })).toThrow(/dreaming.timeoutMs.*at most 2147483647/);
});

test("68 timeout fences tools, settles failure, releases the exact claim, and does not await a non-cooperative worker", async () => {
  vi.useFakeTimers();
  let task!: DreamingAgentInput;
  const never = new Promise<RunAgentResult>(() => {});
  const f = setup(async value => { task = value; value.acknowledgeRequest(); value.reportRequest(exactRequest); return never; }, { timeoutMs: 25 });
  const item = f.create("project", "timed item");
  const running = f.memory.dream(f.target);
  expect(task.material.bound).toContain("25 ms");
  await vi.advanceTimersByTimeAsync(25);
  const result = await running;
  expect(result.outcome).toBe("failure");
  if (result.outcome !== "failure") throw new Error("expected failure");
  expect(result.problems.join(" ")).toContain("Dreaming wall-clock limit exceeded (25 ms)");
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(value => value.revisionId)).toEqual([item.commit]);
  const memoryTool = task.tools.find(tool => tool.name === "memory")!;
  expect(memoryTool.execute({ operations: [], skipped: [] })).toContain("run has finished");
});

test("68 timeout failure wins over a synchronous native cancelled result", async () => {
  vi.useFakeTimers();
  const f = setup(async task => new Promise<RunAgentResult>(resolve => {
    task.acknowledgeRequest(); task.reportRequest(exactRequest);
    task.signal!.addEventListener("abort", () => resolve({ outcome: "cancelled", output: "native cancelled", request: exactRequest }), { once: true });
  }), { timeoutMs: 25 });
  f.create("project", "timed item");
  const running = f.memory.dream(f.target);
  await vi.advanceTimersByTimeAsync(25);
  expect((await running).outcome).toBe("failure");
});

test("68 external cancellation remains cancellation when its native worker cooperates before the deadline", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const f = setup(async task => new Promise<RunAgentResult>(resolve => {
    task.acknowledgeRequest(); task.reportRequest(exactRequest);
    task.signal!.addEventListener("abort", () => resolve({ outcome: "cancelled", output: "stopped", request: exactRequest }), { once: true });
  }), { timeoutMs: 25 });
  f.create("project", "cancelled item");
  const running = f.memory.dream({ ...f.target, signal: controller.signal });
  controller.abort("stop");
  expect((await running).outcome).toBe("cancelled");
  await vi.advanceTimersByTimeAsync(25);
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
});

test.each(["success", "failure", "cancelled"] as const)("68 %s consumes an accepted skip but leaves untouched frozen versions pending", async outcome => {
  const f = setup(async task => {
    task.acknowledgeRequest();
    const handles = [...task.material.changed.matchAll(/K\d+@\d+/g)].map(match => match[0]);
    const receipt = task.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [{ knowledge: handles[0], because: "already correct" }] });
    expect(receipt).toContain("committed");
    return { outcome, output: outcome, request: exactRequest };
  });
  const first = f.create("project", "first ".repeat(20));
  const second = f.create("project", "second ".repeat(20));
  const result = await f.memory.dream(f.target);
  expect(result.outcome).toBe(outcome === "success" ? "success" : outcome);
  expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed ORDER BY revision_id").all().map(row => Number(row.revision_id))).toEqual([first.commit]);
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(value => value.revisionId)).toEqual([second.commit]);
});

test("68 own output is processed, its superseded parent needs no processing row, and untouched input remains due", async () => {
  let output = 0;
  const f = setup(async task => {
    task.acknowledgeRequest();
    const handle = task.material.changed.match(/K\d+@\d+/)![0];
    const receipt = JSON.parse(task.tools.find(tool => tool.name === "memory")!.execute({ operations: [{
      op: "update", id: handle, text: "updated", category: "constraint", scope: "project", supports: [], topics: [], reason: "maintained",
    }], skipped: [] }));
    output = receipt.committed[0].commit;
    return { outcome: "failure", output: "cut", request: exactRequest };
  });
  const first = f.create("project", "first ".repeat(20));
  const second = f.create("project", "second ".repeat(20));
  expect((await f.memory.dream(f.target)).outcome).toBe("failure");
  expect(f.store.db.prepare("SELECT revision_id FROM knowledge_processed ORDER BY revision_id").all().map(row => Number(row.revision_id))).toEqual([output]);
  expect(f.store.currentCommit(first.knowledgeId, f.target).map(value => value.id)).toEqual([output]);
  expect(f.store.pendingVersions(`project:${f.project.id}`, f.target).map(value => value.revisionId)).toEqual([second.commit]);
  expect(f.memory.taskEligibility("dreaming", f.target).due).toBe(true);
});

test("68 each pool uses min(configured trigger cap, pool budget) and untouched pending stays due", async () => {
  const f = setup(async task => { task.acknowledgeRequest(); return { outcome: "failure", output: "cut", request: exactRequest }; }, { triggerTokens: 5_000 });
  const first = f.create("session", "first ".repeat(80));
  const second = f.create("session", "second ".repeat(80));
  const pool = `session:${f.session.id}`;
  const pending = f.store.pendingVersions(pool, f.target);
  const budget = pending[0]!.tokens + 10;
  f.store.setKnowledgeBudget("session", budget);
  expect(f.store.pendingPoolWeight(pool, f.target)).toBeLessThan(5_000);
  expect(f.memory.pendingTokens("dreaming", f.target)).toMatchObject({ trigger: budget, state: "known" });
  expect(f.store.duePools(f.target, 5_000).find(value => value.pool === pool)?.reason).toBe("pending");
  expect((await f.memory.dream(f.target)).outcome).toBe("failure");
  expect(f.store.pendingVersions(pool, f.target).map(value => value.revisionId)).toEqual([first.commit, second.commit]);
  expect(f.store.duePools(f.target, 5_000).find(value => value.pool === pool)?.reason).toBe("pending");
});
