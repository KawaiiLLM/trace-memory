import { afterEach, beforeEach, expect, test } from "vitest";
import { sourceSeededMemory, recorded, toolRejected, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { similarity } from "../../../src/core/consolidation/similarity.ts";

let memory: ReturnType<typeof sourceSeededMemory>;
let sessionId: number;
let firstTurnId: number;
let agent: (input: NotingAgentInput) => Promise<RunAgentResult>;

const oldFact = (text = "Package trace-memory moved from beta.1 to beta.2") => ({
  category: "observation", actor: "agent", text, source: [`T${firstTurnId}#assistant`],
});
const newFact = (turnId: number, text = "Package trace-memory moved from beta.2 to beta.3", extra = {}) => ({
  category: "observation", actor: "agent", text, source: [`T${turnId}#assistant`], ...extra,
});

beforeEach(() => {
  agent = async () => { throw new Error("agent not installed"); };
  memory = sourceSeededMemory(":memory:", raw => agent(raw as NotingAgentInput));
  const project = memory.store.createProject({ name: "noting-near", declaredBy: "mark" });
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: "now", firstReplyAt: "now" }).id;
  firstTurnId = memory.store.appendTurn({ sessionId, kind: "turn", assistantText: "Package trace-memory moved from beta.1 to beta.2", startedAt: "first" }).id;
  expect(memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: firstTurnId })
    .find(tool => tool.name === "note")!.execute({ facts: [oldFact()] })).toContain("F1");
  recorded(memory, sessionId, "main", firstTurnId);
});
afterEach(() => memory.close());

function appendTarget(text: string) {
  return memory.store.appendTurn({ sessionId, parentTurnId: firstTurnId, kind: "turn", assistantText: text, startedAt: "second" });
}

function addOld(text: string, turnId = firstTurnId) {
  const result = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: turnId })
    .find(tool => tool.name === "note")!.execute({ facts: [{ ...oldFact(text), source: [`T${turnId}#assistant`] }] });
  const ids = JSON.parse(result).factIds as number[];
  return ids[0]!;
}

function shownIds(receipt: string): number[] {
  const text = JSON.parse(receipt).feedback?.content ?? "";
  return [...text.matchAll(/^F(\d+) \(Jaccard /gm)].map(match => Number(match[1]));
}

test("38a baseline distinction: a valid same-object batch reviews before it commits", async () => {
  const turn = memory.store.appendTurn({ sessionId, parentTurnId: firstTurnId, kind: "turn", assistantText: "Package trace-memory moved from beta.2 to beta.3", startedAt: "second" });
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    const first = note.execute({ facts: [newFact(turn.id)] });
    const parsed = JSON.parse(first);
    expect(parsed.results).toEqual(["ok"]);
    expect(parsed.feedback.role).toBe("user");
    expect(parsed.factIds).toBeUndefined();
    expect(memory.store.listSessionFacts(sessionId)).toHaveLength(1);
    expect((input as NotingAgentInput & { reviewFeedback(result: string): string | undefined }).reviewFeedback(first)).toContain("NEAR:");
    input.reportRequest({ round: 2 });
    expect(note.execute({ facts: [newFact(turn.id, "Package trace-memory moved from beta.2 to beta.3", { negate: [["F1", "strong"]] })] })).toContain("F2");
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: turn.id, mode: "subagent" });
  expect(result.outcome).toBe("success");
  expect(memory.store.listSessionFacts(sessionId).map(fact => fact.id)).toEqual([2, 1]);
  expect(memory.store.listFactRelations(2)).toContainEqual({ fromFact: 2, toFact: 1, kind: "negate", strength: "strong" });
});

test("selects at most three neighbours by descending score and ascending fact id on ties", async () => {
  const exact = "Package trace-memory moved from beta.2 to beta.3";
  const ids = [addOld(exact), addOld(exact), addOld(exact), addOld(exact)];
  const turn = appendTarget(exact);
  let receipt = "";
  agent = async input => {
    input.reportRequest({ round: 1 });
    receipt = input.tools.find(tool => tool.name === "note")!.execute({ facts: [newFact(turn.id, exact)] });
    return { outcome: "success", output: "stop after review", request: { round: 1 } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: turn.id, mode: "subagent" })).outcome).toBe("bounced");
  expect(shownIds(receipt)).toEqual(ids.slice(0, 3));
  expect(memory.store.listSessionFacts(sessionId)).toHaveLength(5);
});

test("feedback uses complete existing fact rendering, including relations", async () => {
  const text = "Package trace-memory moved from beta.2 to beta.3";
  const relationReceipt = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: firstTurnId })
    .find(tool => tool.name === "note")!.execute({ facts: [{ ...oldFact(text), support: [["F1", "strong"]] }] });
  expect(JSON.parse(relationReceipt).factIds).toEqual([2]);
  const target = appendTarget(text);
  let feedback = "";
  agent = async input => {
    input.reportRequest({ round: 1 });
    feedback = input.reviewFeedback(input.tools.find(tool => tool.name === "note")!.execute({ facts: [newFact(target.id, text)] }))!;
    return { outcome: "success", output: "review", request: { round: 1 } };
  };
  await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  expect(feedback).toContain("support F1 strong");
  expect(feedback).toContain(`source: T${firstTurnId}#assistant`);
  expect(feedback).toContain("unrelated neighbour needs no answer");
});

test("includes threshold equality and excludes scores below the loaded threshold", async () => {
  const text = "Package trace-memory moved from beta.2 to beta.3";
  const score = similarity(text, oldFact().text);
  memory.config.noting.nearThreshold = score;
  const equalTurn = appendTarget(text);
  let equal = "";
  agent = async input => {
    input.reportRequest({ round: 1 });
    equal = input.tools.find(tool => tool.name === "note")!.execute({ facts: [newFact(equalTurn.id, text)] });
    return { outcome: "success", output: "review", request: { round: 1 } };
  };
  await memory.noting({ sessionId, branch: "main", headTurnId: equalTurn.id, mode: "subagent" });
  expect(shownIds(equal)).toContain(1);

  memory.config.noting.nearThreshold = score + Number.EPSILON;
  const belowTurn = memory.store.appendTurn({ sessionId, parentTurnId: equalTurn.id, kind: "turn", assistantText: text, startedAt: "third" });
  agent = async input => {
    input.reportRequest({ round: 1 });
    const receipt = input.tools.find(tool => tool.name === "note")!.execute({ facts: [newFact(belowTurn.id, text)] });
    expect(JSON.parse(receipt).feedback).toBeUndefined();
    return { outcome: "success", output: "committed", request: { round: 1 } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: belowTurn.id, mode: "subagent" })).outcome).toBe("success");
});

test("automatic candidates exclude sibling-path and foreign-session facts", async () => {
  const exact = oldFact().text;
  const sibling = memory.store.appendTurn({ sessionId, parentTurnId: firstTurnId, kind: "turn", assistantText: exact, startedAt: "sibling" });
  const siblingId = addOld(exact, sibling.id);
  const otherProject = memory.store.createProject({ name: "other", declaredBy: "mark" });
  const otherSession = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: otherProject.id, startedAt: "now", firstReplyAt: "now" });
  const foreignTurn = memory.store.appendTurn({ sessionId: otherSession.id, kind: "turn", assistantText: exact, startedAt: "foreign" });
  const foreign = memory.tools({ kind: "manual", sessionId: otherSession.id, branch: "main", currentTurnId: foreignTurn.id })
    .find(tool => tool.name === "note")!.execute({ facts: [{ ...oldFact(exact), source: [`T${foreignTurn.id}#assistant`] }] });
  const foreignId = JSON.parse(foreign).factIds[0] as number;
  memory.config.noting.nearThreshold = 1;
  const target = memory.store.appendTurn({ sessionId, parentTurnId: firstTurnId, kind: "turn", assistantText: exact, startedAt: "target" });
  let receipt = "";
  agent = async input => {
    input.reportRequest({ round: 1 });
    receipt = input.tools.find(tool => tool.name === "note")!.execute({ facts: [newFact(target.id, exact)] });
    return { outcome: "success", output: "review", request: { round: 1 } };
  };
  await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  expect(shownIds(receipt)).toEqual([1]);
  expect(shownIds(receipt)).not.toContain(siblingId);
  expect(shownIds(receipt)).not.toContain(foreignId);
});

test("rejected input does not read the pool; the first valid submission reads it once and freezes it", async () => {
  const target = appendTarget(oldFact().text);
  let reads = 0;
  const original = memory.store.notingNearPool.bind(memory.store);
  memory.store.notingNearPool = (...args) => { reads++; return original(...args); };
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    expect(note.execute({ facts: [{ ...newFact(target.id), actor: "invalid" }] })).toContain("rejected:");
    expect(reads).toBe(0);
    const first = note.execute({ facts: [newFact(target.id, oldFact().text)] });
    expect(reads).toBe(1);
    const lateId = addOld(oldFact().text);
    memory.store.selectSourcePath(sessionId, "main", []); // a mutable tree move cannot replace the held path/pool
    expect(note.execute({ facts: [newFact(target.id, oldFact().text)] })).toContain("has not been read yet");
    input.reportRequest({ round: 2 });
    expect(note.execute({ facts: [newFact(target.id, oldFact().text, { negate: [["F1", "strong"]] })] })).toContain("F3");
    expect(reads).toBe(1);
    expect(lateId).toBe(2);
    expect(note.execute({ facts: [] })).toContain("already committed");
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  expect(result.outcome).toBe("success");
  const response = JSON.parse(memory.store.getRun(result.outcome === "success" ? result.runId : 0)!.response!);
  expect(response.notingNearReview.shown[0].neighbours.map((n: { factId: number }) => n.factId)).toEqual([1]);
  expect(response.toolCalls).toHaveLength(5);
  expect(response.factIds).toEqual([3]);
});

test("an invalid correction can be retried, and the changed valid batch commits without another review", async () => {
  const target = appendTarget(oldFact().text);
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    const first = note.execute({ facts: [newFact(target.id, oldFact().text)] });
    expect(toolRejected("note", first)).toBe(false);
    expect(input.reviewFeedback(first)).toContain("NEAR:");
    input.reportRequest({ round: 2 });
    expect(note.execute({ facts: [{ ...newFact(target.id), actor: "invalid" }] })).toContain("rejected:");
    const changed = note.execute({ facts: [newFact(target.id, "A rewritten final claim", { support: [["F1", "weak"]] }),
      newFact(target.id, "A newly added final claim", { support: [["$1", "weak"]] })] });
    expect(JSON.parse(changed).factIds).toEqual([2, 3]);
    expect(note.execute({ facts: [newFact(target.id)] })).toContain("already committed");
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  expect(result.outcome).toBe("success");
  expect(memory.store.getFact(2)?.text).toBe("A rewritten final claim");
  expect(memory.store.getFact(3)?.text).toBe("A newly added final claim");
});

test("does not compare proposed facts with other facts in the same batch", async () => {
  memory.config.noting.nearThreshold = 1;
  const target = appendTarget("A new claim with no identical history");
  agent = async input => {
    input.reportRequest({ round: 1 });
    const repeated = newFact(target.id, "A new claim with no identical history");
    const receipt = input.tools.find(tool => tool.name === "note")!.execute({ facts: [repeated, repeated] });
    expect(input.reviewFeedback(receipt)).toBeUndefined();
    expect(JSON.parse(receipt).factIds).toEqual([2, 3]);
    return { outcome: "success", output: "done", request: { round: 1 } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" })).outcome).toBe("success");
});

test("a failure before correction advances nothing and a fresh attempt reviews again", async () => {
  const target = appendTarget(oldFact().text);
  let attempts = 0;
  agent = async input => {
    attempts++;
    input.reportRequest({ attempt: attempts });
    const receipt = input.tools.find(tool => tool.name === "note")!.execute({ facts: [newFact(target.id, oldFact().text)] });
    expect(input.reviewFeedback(receipt)).toContain("NEAR:");
    return { outcome: "failure", output: "provider failed", request: { attempt: attempts } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" })).outcome).toBe("failure");
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" })).outcome).toBe("failure");
  expect(attempts).toBe(2);
  expect(memory.store.listSessionFacts(sessionId)).toHaveLength(1);
  expect(memory.progress(sessionId, "main", target.id).entries).toBeGreaterThan(0);
});

test("a provider failure after the reviewed correction preserves business success and the audit", async () => {
  const target = appendTarget(oldFact().text);
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    expect(input.reviewFeedback(note.execute({ facts: [newFact(target.id, oldFact().text)] }))).toContain("NEAR:");
    input.reportRequest({ round: 2 });
    expect(JSON.parse(note.execute({ facts: [newFact(target.id, oldFact().text)] })).factIds).toEqual([2]);
    return { outcome: "failure", output: "provider failed after commit", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  expect(result.outcome).toBe("success");
  const response = JSON.parse(memory.store.getRun(result.outcome === "success" ? result.runId : 0)!.response!);
  expect(JSON.stringify(response.problems)).toContain("provider failed after commit");
  expect(response.notingNearReview.firstSubmission.facts[0].text).toBe(oldFact().text);
  expect(response.toolCalls.at(-1).result).toContain("F2");
});

test("no-neighbour, explicit empty, and manual notes commit immediately", async () => {
  memory.config.noting.nearThreshold = 1;
  const target = appendTarget("A wholly unrelated final claim");
  agent = async input => {
    input.reportRequest({ round: 1 });
    const receipt = input.tools.find(tool => tool.name === "note")!.execute({ facts: [newFact(target.id, "A wholly unrelated final claim")] });
    expect(JSON.parse(receipt).factIds).toEqual([2]);
    expect(input.reviewFeedback(receipt)).toBeUndefined();
    return { outcome: "success", output: "done", request: { round: 1 } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" })).outcome).toBe("success");

  const emptyTurn = memory.store.appendTurn({ sessionId, parentTurnId: target.id, kind: "turn", assistantText: "nothing", startedAt: "third" });
  agent = async input => {
    input.reportRequest({ round: 1 });
    expect(JSON.parse(input.tools.find(tool => tool.name === "note")!.execute({ facts: [] })).committed).toContain("zero facts");
    return { outcome: "success", output: "done", request: { round: 1 } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: emptyTurn.id, mode: "subagent" })).outcome).toBe("success");

  const manual = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: emptyTurn.id })
    .find(tool => tool.name === "note")!.execute({ facts: [newFact(emptyTurn.id, oldFact().text)] });
  expect(JSON.parse(manual).factIds).toEqual([3]);
  expect(JSON.parse(manual).feedback).toBeUndefined();
});
