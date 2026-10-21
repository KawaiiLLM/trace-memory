// Ticket 92 removes live NEAR. Historical receipts remain readable; the old mandatory-review,
// lexical-ranking and post-tool-commit tests are replaced by the terminal-publication contract.
import { afterEach, expect, test } from "vitest";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { submit, verifyUnchanged } from "../../support/noter.ts";

const close: (() => void)[] = [];
afterEach(() => { close.splice(0).forEach(fn => fn()); });
const unavailable = { available: false as const, reason: "native payload unavailable" };
function fixture(script: (task: NotingAgentInput) => Partial<RunAgentResult> | void | Promise<Partial<RunAgentResult> | void>) {
  const memory = sourceSeededMemory(":memory:", async raw => {
    const task = raw as NotingAgentInput;
    if (task.task === "verify") return verifyUnchanged(task, { request: undefined, audit: unavailable });
    return { outcome: "success", output: "done", audit: unavailable, ...await script(task) };
  });
  close.push(() => memory.close());
  const project = memory.store.createProject({ name: "no-near", declaredBy: "mark" });
  const session = memory.store.createSession({ enrollmentChoice: true, host: "pi:test", projectId: project.id, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "The user set a rule", assistantText: "Pi agent explained the rule", startedAt: "now" });
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  const tools = memory.tools({ kind: "manual", ...path, currentTurnId: turn.id });
  const note = tools.find(tool => tool.name === "note")!;
  expect(note.execute({ title: "User rule", sources: "[T1#E1] The user set a rule" })).toContain("F1");
  return { memory, path, note, run: () => memory.noting(path) };
}
for (const relation of [undefined, ["support", "strong"], ["support", "weak"], ["negate", "strong"], ["negate", "weak"]] as const)
  test(`92: identical facts need no lexical review; optional ${relation?.join(" ") ?? "no edge"}`, async () => {
    let ack!: () => void;
    const f = fixture(async task => {
      ack = task.acknowledgeRequest;
      task.reportRequest({ exact: "payload" });
      expect(await submit(task, f.memory, { noteInput: [{ title: "User rule reviewed", sources: "[T1#E1] The user set a rule",
        ...(relation ? { [relation[0]]: [["F1", relation[1]]] } : {}) }], memoryInput: {} })).toBeUndefined();
      expect(task).not.toHaveProperty("reviewFeedback");
      expect(f.memory.store.listSessionFacts(f.path.sessionId)).toHaveLength(1);
      return { request: { exact: "payload" } };
    });
    expect(f.memory.store).not.toHaveProperty("notingNearPool");
    const result = await f.run();
    expect(result).toMatchObject({ outcome: "success", diagnostics: [] });
    expect(f.memory.store.listFactRelations(2)).toHaveLength(relation ? 1 : 0);
    if (!("runId" in result)) throw new Error("missing run");
    const run = f.memory.store.getRun(result.runId!)!;
    expect(JSON.parse(run.response!)).not.toHaveProperty("notingNearReview");
    const write = f.memory.store.getRun(JSON.parse(run.response!).writeRun)!;
    expect(JSON.parse(write.request!)).toEqual({ exact: "payload" });
    expect(() => ack()).toThrow("finished");
  });

test("92: old review receipts and audit remain readable but grant no write protocol", () => {
  const legacy = { firstSubmission: { facts: [] }, shown: [{ handle: "$1", neighbours: [{ factId: 1, score: 1 }] }] };
  const f = fixture(() => {});
  const saved = f.memory.store.recordRun({ kind: "noting", sessionId: f.path.sessionId, createdAt: "old", outcome: "success",
    response: JSON.stringify({ notingNearReview: legacy, diagnostics: [{ kind: "unanswered_near", pairs: [] }] }) });
  expect(JSON.parse(f.memory.store.getRun(saved.id)!.response!).notingNearReview).toEqual(legacy);
  expect(f.note.execute({ slot: "$1", title: "No manual draft", sources: "[T1#E1] No manual draft" })).toContain("rejected:");
  expect(f.note.execute({ drop: "$1" })).toContain("rejected:");
});

test("92: explicit audit unavailability is allowed; missing both request and declaration rejects before publication", async () => {
  const f = fixture(async task => {
    task.acknowledgeRequest();
    await submit(task, f.memory, { noteInput: [], memoryInput: {} });
    return { audit: undefined };
  });
  const result = await f.run();
  expect(result).toMatchObject({ outcome: "failure", problems: ["runAgent must return the exact provider request"] });
  expect(f.memory.pendingEntries(f.path.sessionId, "main", f.path.headTurnId).length).toBeGreaterThan(0);
});

test("92: later same-Turn native entries cannot widen frozen source or processing membership", async () => {
  let lateId = 0;
  const f = fixture(async task => {
    await submit(task, f.memory, { noteInput: [{ title: "Pi agent explanation", sources: "[T1#E2] Pi agent explained the rule" }], memoryInput: {} });
    const before = f.memory.store.sourcePath(f.path.sessionId, "main", 1);
    const late = f.memory.appendEntry({ sessionId: f.path.sessionId, nativeLineage: "fixture", nativeId: "late", turnId: 1,
      role: "assistant", text: "later", raw: JSON.stringify({ role: "assistant", text: "later" }), calls: [] });
    lateId = late.id;
    f.memory.store.selectSourcePath(f.path.sessionId, "main", [...before.map(entry => entry.id), late.id]);
  });
  const result = await f.run(); expect(result.outcome).toBe("success");
  expect(f.memory.store.entryNoted(lateId)).toBe(false);
  expect(f.memory.store.factEntries(2)).not.toContain(lateId);
});
