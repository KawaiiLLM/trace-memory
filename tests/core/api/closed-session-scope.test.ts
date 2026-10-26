import { expect, test } from "vitest";
import { hydrate, sourceSeededMemory, validateConfig, type ClosedSessionScope, type NotingAgentInput } from "../../source-fixture.ts";
import { legacyFacts } from "../../support/seed.ts";
import { submit, submitEmpty, verifyUnchanged } from "../../support/noter.ts";

const at = "2026-09-09T00:00:00Z";
/** The scripted write task records nothing; its verify task finds nothing to correct. */
const submitted = submitEmpty;
/** Set to make the next knowledge writers fail at the provider, as a terminal attempt of that lane. */
const faults = { knowledge: false };
function setup(scope: ClosedSessionScope = "project", agent: Parameters<typeof sourceSeededMemory>[1] = async raw => { submitted(raw); return { outcome: "success", output: "", request: {} }; }) {
  const memory = sourceSeededMemory(":memory:", raw => {
    const input = raw as NotingAgentInput;
    if (faults.knowledge && input.task === "write-knowledge") { input.reportRequest({}); return Promise.resolve({ outcome: "failure", output: "provider failed", request: {} }); }
    return input.kind === "noting" && input.task !== "extract-facts" ? verifyUnchanged(raw, { request: {} }) : agent(raw);
  }, { closedSessionScope: scope });
  const p = memory.store.createProject({ name: "same", declaredBy: "mark" });
  const other = memory.store.createProject({ name: "other", declaredBy: "mark" });
  const session = (projectId: number, closed: boolean) => {
    const s = memory.store.createSession({ host: "fake", projectId, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "evidence", assistantText: "answer", startedAt: at });
    const user = hydrate(memory.store.listSourceEntries(s.id, turn.id), memory.store).find(entry => entry.role === "user")!;
    legacyFacts(memory.store, { kind: "manual", sessionId: s.id, branch: "main", createdAt: at }, [{
      sources: [{ entry: user, address: `T${turn.id}#user` }], category: "observation", actor: "user", text: "evidence", createdAt: at,
    }]);
    memory.selectEntries(s.id, "main", memory.store.listSourceEntries(s.id).map(e => e.id));
    if (closed) memory.store.closeSession(s.id);
    return { sessionId: s.id, branch: "main", headTurnId: turn.id };
  };
  return { memory, active: session(p.id, false), same: session(p.id, true), other: session(other.id, true) };
}

test("closedSessionScope defaults to project and validates atomically at load and configure", () => {
  expect(validateConfig({}).closedSessionScope).toBe("project");
  const { memory } = setup();
  try {
    for (const value of ["off", "project", "global"] as const) {
      memory.configure({ closedSessionScope: value });
      expect(memory.config.closedSessionScope).toBe(value);
    }
    for (const value of ["session", "GLOBAL", true, null, 0, {}]) {
      expect(() => validateConfig({ closedSessionScope: value as never })).toThrow("closedSessionScope");
      expect(() => memory.configure({ closedSessionScope: value as never })).toThrow("closedSessionScope");
      expect(memory.config.closedSessionScope).toBe("global");
    }
  } finally { memory.close(); }
});

test.each(["noting"] as const)("%s discovery filters project/global/off without changing pending work", phase => {
  const { memory, active, same, other } = setup();
  try {
    const list = (scope: ClosedSessionScope) => memory.store.closedTasks(phase, active.sessionId, scope).map(t => t.sessionId);
    expect(list("project")).toEqual([same.sessionId]);
    expect(list("global")).toEqual([same.sessionId, other.sessionId]);
    expect(list("off")).toEqual([]);
    memory.store.setEnrollment(active.sessionId, false);
    expect(list("global")).toEqual([]);
    memory.store.setEnrollment(active.sessionId, true);
    memory.store.closeSession(active.sessionId);
    expect(list("global")).toEqual([]);
    expect(memory.store.pendingEntryIds(other.sessionId, "main", other.headTurnId)).toHaveLength(2);
    expect(memory.store.consolidationBatch(other.sessionId, "main", other.headTurnId)).toHaveLength(1);
  } finally { memory.close(); }
});

test.each(["noting"] as const)("%s admission rechecks the project, requires an executor, and global permits foreign tails", async phase => {
  let dispatched = 0;
  const { memory, active, same, other } = setup("project", async raw => { dispatched++; submitted(raw); return { outcome: "success", output: "", request: {} }; });
  const run = (target: typeof same, executorSessionId?: number) =>
    memory.noting({ ...target, borrowed: true, executorSessionId });
  try {
    expect((await run(other, active.sessionId)).outcome).toBe("dropped");
    expect((await run(same)).outcome).toBe("dropped");
    expect(memory.store.closedTasks(phase, active.sessionId)).toContainEqual(same);
    memory.declareProject(active.sessionId, "moved between discovery and admission", "mark", active);
    expect((await run(same, active.sessionId)).outcome).toBe("dropped");
    expect(dispatched).toBe(0);
    memory.configure({ closedSessionScope: "global" });
    expect((await run(other, active.sessionId)).outcome).toBe("success");
    expect(dispatched).toBe(1);
    memory.configure({ closedSessionScope: "off" });
    expect((await run(same, active.sessionId)).outcome).toBe("dropped");
    const own = await memory.noting(active);
    expect(own.outcome).toBe("success"); // off affects borrowing, not active-session work/manual catchup
  } finally { memory.close(); }
});

test.each(["project", "global"] as const)("%s is frozen for a running task when future borrowing is disabled", async scope => {
  let finish!: () => void;
  const { memory, active, same, other } = setup(scope, async raw => {
    await new Promise<void>(resolve => { finish = resolve; });
    submitted(raw);
    return { outcome: "success", output: "", request: {} };
  });
  try {
    const target = scope === "project" ? same : other;
    // 179 (user ruling): the knowledge lane continues its batch's admission, so the scope is frozen for all four stages.
    const pending = memory.noting({ ...target, borrowed: true, executorSessionId: active.sessionId });
    memory.configure({ closedSessionScope: "off" });
    finish();
    expect((await pending).outcome).toBe("success");
    expect(memory.pendingEntries(target.sessionId, target.branch, target.headTurnId)).toEqual([]);
    expect(memory.store.handoff(target.sessionId, "noting", "knowledge")).toBeNull();
    expect(memory.store.incompleteEntryIds(target.sessionId, target.branch, target.headTurnId)).toEqual([]);
  } finally { memory.close(); }
});

test("a batch's knowledge lane keeps its fact lane's admission and frozen path; another borrower is admitted afresh and cannot redirect it", async () => {
  const { memory, active, same } = setup("project");
  try {
    const stranger = memory.store.createSession({ host: "fake", projectId: memory.store.getSession(active.sessionId)!.projectId,
      enrollmentChoice: true, startedAt: at, firstReplyAt: at }).id;
    const borrow = (executorSessionId: number, target: typeof same) => memory.noting({ ...target, borrowed: true, executorSessionId, lane: "knowledge" });
    expect((await memory.noting({ ...same, borrowed: true, executorSessionId: active.sessionId, lane: "facts" })).outcome).toBe("success");
    const pendingKnowledge = () => memory.store.handoff(same.sessionId, "noting", "knowledge");
    expect(pendingKnowledge()).not.toBeNull();
    memory.configure({ closedSessionScope: "off" });
    expect((await borrow(stranger, same)).outcome).toBe("dropped"); // not the admitting executor: scope is checked now
    // The session's active path moves away from the one the batch froze.
    memory.selectEntries(same.sessionId, "moved", memory.store.listSourceEntries(same.sessionId).map(entry => entry.id));
    memory.store.setCurrentPath(same.sessionId, "moved", same.headTurnId, "closed");
    memory.configure({ closedSessionScope: "project" });
    expect((await borrow(stranger, { ...same, branch: "moved" })).outcome).toBe("dropped"); // validated on its own frozen path, not the caller's
    expect(pendingKnowledge()).not.toBeNull();
    memory.configure({ closedSessionScope: "off" });
    expect((await borrow(active.sessionId, { ...same, branch: "moved" })).outcome).toBe("success"); // the admitting executor continues
    expect(pendingKnowledge()).toBeNull();
    expect(memory.store.listRuns(same.sessionId).filter(run => run.kind === "noting").every(run => run.branch === same.branch)).toBe(true);
  } finally { memory.close(); }
});

/** The batch's fact lane borrowed by `active`; `later` is a second turn that moves the closed target's retained cursor on from the frozen head. */
async function factsDone(h: ReturnType<typeof setup>) {
  const { memory, active, same } = h;
  expect((await memory.noting({ ...same, borrowed: true, executorSessionId: active.sessionId, lane: "facts" })).outcome).toBe("success");
  expect(memory.store.handoff(same.sessionId, "noting", "knowledge")).not.toBeNull();
  const later = memory.store.appendTurn({ sessionId: same.sessionId, parentTurnId: same.headTurnId, kind: "turn", userPrompt: "later", assistantText: "ok", startedAt: at });
  return { later: { ...same, headTurnId: later.id }, advance: () => {
    memory.selectEntries(same.sessionId, "main", memory.store.listSourceEntries(same.sessionId).map(entry => entry.id));
    memory.store.setCurrentPath(same.sessionId, "main", later.id, "closed");
  } };
}
const stranger = (memory: ReturnType<typeof setup>["memory"], active: { sessionId: number }) => memory.store.createSession({ host: "fake",
  projectId: memory.store.getSession(active.sessionId)!.projectId, enrollmentChoice: true, startedAt: at, firstReplyAt: at }).id;

test("a fresh knowledge admission accepts a frozen batch that is still an ancestor of the retained cursor", async () => {
  const h = setup("project");
  try {
    const { memory, same } = h, other = stranger(memory, h.active);
    const { later, advance } = await factsDone(h);
    advance();
    expect(memory.store.closedTasks("noting", other, "project", "knowledge")).toEqual([later]);
    expect((await memory.noting({ ...later, borrowed: true, executorSessionId: other, lane: "knowledge" })).outcome).toBe("success");
    expect(memory.store.handoff(same.sessionId, "noting", "knowledge")).toBeNull();
  } finally { h.memory.close(); }
});

test.each(["closed", "disabled"] as const)("an inherited knowledge admission still needs its executor %s: the attempt is dropped before any claim or execution", async state => {
  const h = setup("project");
  try {
    const { memory, active, same } = h;
    await factsDone(h);
    const count = (table: string) => Number(memory.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n);
    const before = { runs: count("runs"), executions: count("task_executions"), failures: memory.store.taskFailures(same.sessionId).length };
    if (state === "closed") memory.store.closeSession(active.sessionId); else memory.store.setEnrollment(active.sessionId, false);
    for (let attempt = 0; attempt < 3; attempt++)
      expect((await memory.noting({ ...same, borrowed: true, executorSessionId: active.sessionId, lane: "knowledge" })).outcome).toBe("dropped");
    expect({ runs: count("runs"), executions: count("task_executions"), failures: memory.store.taskFailures(same.sessionId).length }).toEqual(before);
    expect(memory.store.getClaim(same.sessionId, "noting", "knowledge")).toBeNull();
    expect(memory.store.enabled(same.sessionId)).toBe(true);
    expect(memory.store.handoff(same.sessionId, "noting", "knowledge")).not.toBeNull();
  } finally { h.memory.close(); }
});

test("only the knowledge lane's first admission inherits: a retry after a terminal failure by the same executor is admitted afresh", async () => {
  const h = setup("project");
  try {
    const { memory, active, same } = h;
    await factsDone(h);
    const retry = () => memory.noting({ ...same, borrowed: true, executorSessionId: active.sessionId, lane: "knowledge" });
    faults.knowledge = true;
    expect((await retry()).outcome).toBe("failure"); // the first admission inherited and ran
    faults.knowledge = false;
    expect(memory.store.handoff(same.sessionId, "noting", "knowledge")).not.toBeNull();
    memory.configure({ closedSessionScope: "off" });
    expect((await retry()).outcome).toBe("dropped"); // the scope now in force governs a retry
    memory.configure({ closedSessionScope: "project" });
    expect((await retry()).outcome).toBe("success");
    expect(memory.store.handoff(same.sessionId, "noting", "knowledge")).toBeNull();
  } finally { faults.knowledge = false; h.memory.close(); }
});

test.each(["noting"] as const)("%s rechecks a closed executor at commit without advancing progress", async phase => {
  let finish!: () => void;
  const { memory, active, same } = setup("project", async raw => {
    await new Promise<void>(resolve => { finish = resolve; });
    submitted(raw); // 26a: the batch is submitted, so the closed-executor recheck really runs at commit
    return { outcome: "success", output: "", request: {} };
  });
  try {
    const input = { ...same, borrowed: true, executorSessionId: active.sessionId };
    const pending = memory.noting(input);
    memory.store.closeSession(active.sessionId);
    finish();
    expect((await pending).outcome).not.toBe("success");
    expect(memory.pendingEntries(same.sessionId, same.branch, same.headTurnId)).toHaveLength(2);
    expect(memory.store.consolidationBatch(same.sessionId, same.branch, same.headTurnId)).toHaveLength(1);
  } finally { memory.close(); }
});

test("a project-scoped borrowed writer cannot commit after its executor moves to another project", async () => {
  let input!: NotingAgentInput, finish!: () => void;
  const { memory, active, same } = setup("project", async raw => {
    input = raw as NotingAgentInput;
    await new Promise<void>(resolve => { finish = resolve; });
    await submit(input, memory, { noteInput: [{ title: "Late borrowed write", sources: `[T${same.headTurnId}#E1] late write` }], memoryInput: {} });
    return { outcome: "success", output: "", request: {} };
  });
  try {
    const pending = memory.noting({ ...same, borrowed: true, executorSessionId: active.sessionId });
    memory.declareProject(active.sessionId, "different", "mark", active);
    expect(memory.store.listTurnFacts(same.headTurnId)).toHaveLength(1); // only the prior manual fact
    finish();
    const result = await pending;
    expect(result.outcome).not.toBe("success");
    expect("problems" in result && result.problems?.join(" ")).toContain("borrowed work");
    expect(memory.store.listTurnFacts(same.headTurnId)).toHaveLength(1);
    expect(memory.pendingEntries(same.sessionId, same.branch, same.headTurnId)).toHaveLength(2);
  } finally { memory.close(); }
});
