import { afterEach, expect, test } from "vitest";
import { TraceMemory, type IntegrationAgentInput, type RunAgentResult } from "./index.ts";
let memory: TraceMemory;
afterEach(() => memory?.close());
const create = { op: "create", text: "Use pnpm", category: "constraint", scope: "project", supports: ["F1"], because: ["F1"] };
const batch = { operations: [create], skipped: [] };
function setup(agent: (input: IntegrationAgentInput) => Promise<RunAgentResult>) {
  memory = TraceMemory(":memory:", raw => agent(raw as IntegrationAgentInput));
  const project = memory.store.createProject({ name: "test", declaredBy: "mark" });
  const s = memory.store.createSession({ host: "test", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "Use pnpm", assistantText: "Okay", startedAt: "now" });
  const tools = memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id });
  tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] });
  return tools[3]!;
}
const success = (): RunAgentResult => ({ outcome: "success", output: "Done", request: { last: true } });
const integrate = () => memory.integrate({ sessionId: 1, branch: "main" });

test("Integration stopping after its first valid batch bounces and preserves the candidate and receipt", async () => {
  setup(async input => { input.reportRequest({ first: true }); input.tools[3]!.execute(batch); return success(); });
  const result = await integrate();
  expect(result.outcome).toBe("bounced");
  if (result.outcome !== "bounced") throw new Error("expected bounce");
  expect(memory.store.getKnowledge(1)).toBeNull();
  expect(memory.store.getWatermark(1, "main")).toBeNull();
  const audit = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(audit.candidate).toEqual(batch); expect(audit.toolCalls[0].input).toEqual(batch);
  expect(JSON.parse(audit.toolCalls[0].result).feedback.role).toBe("user");
});

test("a rejected second submission can be corrected without another review round", async () => {
  setup(async input => {
    const write = input.tools[3]!; input.reportRequest({ first: true });
    expect(write.execute(batch)).toContain("feedback");
    input.reportRequest({ second: true });
    expect(write.execute({ operations: [{ ...create, supports: [] }], skipped: [] })).toContain("rejected:");
    expect(memory.store.getKnowledge(1)).toBeNull();
    input.reportRequest({ third: true });
    const corrected = JSON.parse(write.execute(batch));
    expect(corrected.feedback).toBeUndefined(); expect(corrected.committed).toHaveLength(1);
    return success();
  });
  expect((await integrate()).outcome).toBe("success");
  expect(memory.store.getKnowledge(2)).toBeNull();
});

for (const mode of ["failure", "cancelled", "throw", "abort"] as const) test(`Integration ${mode} after commit only appends a problem`, async () => {
  setup(async input => {
    input.reportRequest({ provider: "captured" });
    input.tools[3]!.execute(batch); input.reportRequest({ second: true }); input.tools[3]!.execute(batch);
    const run = memory.store.listRuns(1).at(-1)!;
    expect(run.outcome).toBe("success"); expect(JSON.parse(run.response!).toolCalls).toHaveLength(2);
    if (mode === "throw" || mode === "abort") { const error = new Error("late provider error"); if (mode === "abort") error.name = "AbortError"; throw error; }
    return { outcome: mode, output: "late provider error", request: { final: true } };
  });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("commit is success");
  expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
  expect(memory.store.getWatermark(1, "main")?.lastIntegratedFact).toBe(1);
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe("success"); expect(JSON.parse(run.response!).problems).toEqual(["late provider error"]);
  expect(JSON.parse(run.request!)).toEqual(mode === "throw" || mode === "abort" ? { second: true } : { final: true });
});

for (const mode of ["failure", "cancelled"] as const) test(`Integration ${mode} before commit advances nothing`, async () => {
  setup(async input => { input.tools[3]!.execute(batch); return { outcome: mode, output: "stopped", request: {} }; });
  expect((await integrate()).outcome).toBe(mode);
  expect(memory.store.getKnowledge(1)).toBeNull(); expect(memory.store.getWatermark(1, "main")).toBeNull();
});

test("Integration normal stop without a submission succeeds with zero knowledge", async () => {
  setup(async () => success()); const result = await integrate();
  expect(result.outcome).toBe("success"); expect(memory.store.getKnowledge(1)).toBeNull();
  expect(memory.store.getWatermark(1, "main")?.lastIntegratedFact).toBe(1);
});

test("memory rejects malformed items, obsolete fields and invisible evidence without losing ordered results", () => {
  const tool = setup(async () => success());
  for (const invalid of [null, [], { ...create, op: "mark" }, { ...create, supports: ["F999999"] }, { ...create, id: "K1" }, { ...create, because: "reason" }, { ...create, because: undefined }]) {
    const result = JSON.parse(tool.execute({ operations: [create, invalid], skipped: [] }));
    expect(result.results[0]).toBe("ok"); expect(result.results[1]).toContain("rejected:");
    expect(memory.store.getKnowledge(1)).toBeNull();
  }
  const p = memory.store.createProject({ name: "foreign", declaredBy: "mark" });
  const s = memory.store.createSession({ host: "test", projectId: p.id, startedAt: "now", firstReplyAt: "now" });
  const t = memory.store.appendTurn({ sessionId: s.id, kind: "turn", userPrompt: "secret", startedAt: "now" });
  memory.tools({ kind: "manual", sessionId: s.id, branch: "main", currentTurnId: t.id })[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "secret", source: [`T${t.id}#user`] }] });
  expect(tool.execute({ operations: [{ ...create, supports: ["F2"] }], skipped: [] })).toContain("not an available fact");
});

test("skipped validates its range, reason and shape atomically", async () => {
  setup(async input => {
    for (const skipped of [null, { fact: "F999", because: "not durable" }, { fact: "F1", because: "" }, { fact: "F1", because: "skip", id: "F1" }]) {
      expect(input.tools[3]!.execute({ operations: [create], skipped: [skipped] })).toContain("rejected:");
      expect(memory.store.getKnowledge(1)).toBeNull();
    }
    input.tools[3]!.execute(batch); input.reportRequest({ second: true }); input.tools[3]!.execute(batch); return success();
  });
  expect((await integrate()).outcome).toBe("success");
});

test("manual memory reuses current revisions and refuses inactive or duplicate merge participants", () => {
  const write = setup(async () => success());
  write.execute({ operations: [create, create], skipped: [] });
  const merge = { ...create, op: "merge", id: "K1", absorb: ["K2"] };
  for (const absorb of [["K1"], ["K2", "K2"], ["K999"], []]) {
    expect(write.execute({ operations: [{ ...merge, absorb }], skipped: [] })).toContain("rejected:");
    expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
    expect(memory.store.currentCommit(2)[0]?.op).toBe("create");
  }
  write.execute({ operations: [merge], skipped: [] });
  expect(write.execute({ operations: [{ ...create, op: "update", id: "K2" }], skipped: [] })).toContain("rejected:");
  expect(JSON.parse(write.execute({ operations: [{ ...create, op: "update", id: "K1" }], skipped: [] })).committed[0].commit).toBe(4);
  write.execute({ operations: [{ op: "archive", id: "K1", because: ["F1"] }], skipped: [] });
  expect(memory.store.currentCommit(1)[0]?.op).toBe("archive");
  expect(memory.trace("K1")).toContain("archive");
});

test("accounting observes concurrent changes to untouched knowledge in the committing transaction", async () => {
  const manual = setup(async input => {
    const final = { operations: [{ ...create, supports: ["F2"] }], skipped: [] };
    input.tools[3]!.execute(final);
    manual.execute({ operations: [{ op: "archive", id: "K1", because: ["F2"] }], skipped: [] });
    input.reportRequest({ second: true }); input.tools[3]!.execute(final); return success();
  });
  manual.execute(batch);
  memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Use another tool", source: ["T1#user"] }] });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.diagnostics).toContainEqual({ kind: "uncited_facts", facts: ["F1"] });
  expect(memory.store.currentCommit(1)[0]?.op).toBe("archive");
  expect(memory.store.getKnowledgeRevision(2, 3)?.supports).toEqual([2]);
});

test("inserting an archive before a retained create cannot erase its unanswered NEAR", async () => {
  const manual = setup(async input => {
    input.tools[3]!.execute(batch); input.reportRequest({ second: true });
    input.tools[3]!.execute({ operations: [{ op: "archive", id: "K2", because: [] }, create], skipped: [] });
    return success();
  });
  manual.execute({ operations: [create, { ...create, text: "Unrelated subject" }], skipped: [] });
  const result = await integrate();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.diagnostics).toContainEqual({ kind: "unanswered_near", pairs: [{ candidate: "$e1", knowledge: "K1", score: 1 }] });
});

test("2026-09-07: an audit update that fails after the commit is reported, not turned into a business failure", async () => {
  let done = false;
  setup(async input => {
    input.reportRequest({ first: true }); input.tools[3]!.execute(batch);
    input.reportRequest({ second: true }); input.tools[3]!.execute(batch);
    done = true; return success();
  });
  const original = memory.store.updateRun.bind(memory.store);
  memory.store.updateRun = ((...args: Parameters<typeof original>) => { if (done) throw new Error("disk full"); return original(...args); }) as typeof original;
  const result = await integrate();
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.problems).toEqual(["audit update failed after commit: Error: disk full"]);
  expect(memory.store.currentCommit(1)[0]?.id).toBe(1);
  expect(memory.store.getRun(result.runId)!.outcome).toBe("success");
});
