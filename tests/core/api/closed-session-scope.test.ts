import { expect, test } from "vitest";
import { sourceSeededMemory, validateConfig, type ClosedSessionScope, type NotingAgentInput } from "../../source-fixture.ts";

const at = "2026-09-09T00:00:00Z";
/** Explicit scripted empty N output uses both tools. */
const submitted = (raw: unknown) => {
  const input = raw as NotingAgentInput;
  if (input.kind === "noting") {
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
  }
};
function setup(scope: ClosedSessionScope = "project", agent: Parameters<typeof sourceSeededMemory>[1] = async raw => { submitted(raw); return { outcome: "success", output: "", request: {} }; }) {
  const memory = sourceSeededMemory(":memory:", agent, { closedSessionScope: scope });
  const p = memory.store.createProject({ name: "same", declaredBy: "mark" });
  const other = memory.store.createProject({ name: "other", declaredBy: "mark" });
  const session = (projectId: number, closed: boolean) => {
    const s = memory.store.createSession({ host: "fake", projectId, enrollmentChoice: true, startedAt: at, firstReplyAt: at });
    const turn = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "evidence", assistantText: "answer", startedAt: at });
    const noted = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: s.id, branch: "main", createdAt: at },
      facts: [{ turnId: turn.id, category: "observation", actor: "user", text: "evidence", source: [`T${turn.id}#user`], createdAt: at }] });
    expect(noted.ok).toBe(true);
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
      memory.configure({ noting: { forkModeDefault: false } });
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
    const pending = memory.noting({ ...target, borrowed: true, executorSessionId: active.sessionId });
    memory.configure({ closedSessionScope: "off" });
    finish();
    expect((await pending).outcome).toBe("success");
    expect(memory.pendingEntries(target.sessionId, target.branch, target.headTurnId)).toEqual([]);
  } finally { memory.close(); }
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
    return { outcome: "success", output: "", request: {} };
  });
  try {
    const pending = memory.noting({ ...same, borrowed: true, executorSessionId: active.sessionId });
    memory.declareProject(active.sessionId, "different", "mark", active);
    const receipt = String(await input.tools.find(tool => tool.name === "note")!.execute({ facts: [{ text: "late write", source: [`T${same.headTurnId}#E1`] }] }));
    expect(receipt).toContain("held");
    input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
    expect(memory.store.listTurnFacts(same.headTurnId)).toHaveLength(1); // only the prior manual fact
    finish();
    const result = await pending;
    expect(result.outcome).not.toBe("success");
    expect("problems" in result && result.problems?.join(" ")).toContain("borrowed work");
    expect(memory.store.listTurnFacts(same.headTurnId)).toHaveLength(1);
    expect(memory.pendingEntries(same.sessionId, same.branch, same.headTurnId)).toHaveLength(2);
  } finally { memory.close(); }
});
