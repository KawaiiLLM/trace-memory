import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, recorded, toolRejected, type NotingAgentInput, type RunAgentResult , hydrate } from "../../source-fixture.ts";
import { similarity } from "../../../src/core/consolidation/similarity.ts";
import { Store } from "../../../src/core/store/index.ts";

let memory: ReturnType<typeof sourceSeededMemory>;
let sessionId: number;
let firstTurnId: number;
let directory: string;
let dbPath: string;
let agent: (input: NotingAgentInput) => Promise<RunAgentResult>;

const oldFact = (text = "Package trace-memory moved from beta.1 to beta.2") => ({
  category: "observation", actor: "agent", text, source: [`T${firstTurnId}#assistant`],
});
const newFact = (turnId: number, text = "Package trace-memory moved from beta.2 to beta.3", extra = {}) => ({
  category: "observation", actor: "agent", text, source: [`T${turnId}#assistant`], ...extra,
});

beforeEach(() => {
  agent = async () => { throw new Error("agent not installed"); };
  directory = mkdtempSync(join(tmpdir(), "trace-memory-noting-near-"));
  dbPath = join(directory, "test.sqlite");
  memory = sourceSeededMemory(dbPath, raw => agent(raw as NotingAgentInput));
  const project = memory.store.createProject({ name: "noting-near", declaredBy: "mark" });
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "fake", projectId: project.id, startedAt: "now", firstReplyAt: "now" }).id;
  firstTurnId = memory.store.appendTurn({ sessionId, kind: "turn", assistantText: "Package trace-memory moved from beta.1 to beta.2", startedAt: "first" }).id;
  expect(memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: firstTurnId })
    .find(tool => tool.name === "note")!.execute({ facts: [oldFact()] })).toContain("F1");
  recorded(memory, sessionId, "main", firstTurnId);
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

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

test("payload-free acknowledgement advances one Noter review generation without creating request audit", async () => {
  const turn = appendTarget(oldFact().text);
  let acknowledge!: NotingAgentInput["acknowledgeRequest"];
  let report!: NotingAgentInput["reportRequest"];
  agent = async input => {
    acknowledge = input.acknowledgeRequest;
    report = input.reportRequest;
    input.acknowledgeRequest();
    const note = input.tools.find(tool => tool.name === "note")!;
    const first = note.execute({ facts: [newFact(turn.id, oldFact().text)] });
    expect(input.reviewFeedback(first)).toContain("NEAR:");
    expect(note.execute({ facts: [newFact(turn.id, oldFact().text)] })).toContain("feedback has not been read yet");
    input.acknowledgeRequest();
    expect(JSON.parse(note.execute({ facts: [newFact(turn.id, oldFact().text)] })).factIds).toEqual([2]);
    return { outcome: "success", output: "done", audit: { available: false, reason: "native request body unavailable" } };
  };

  const result = await memory.noting({ sessionId, branch: "main", headTurnId: turn.id, mode: "subagent" });
  expect(result).toMatchObject({ outcome: "success" });
  if (result.outcome !== "success") throw new Error("expected success");
  const run = memory.store.getRun(result.runId)!;
  expect(run.request).toBeNull();
  expect(JSON.parse(run.response!)).toMatchObject({ usage: null, audit: { available: false }, problems: [] });
  expect(() => acknowledge()).toThrow("noting run has finished");
  expect(() => report({ tooLate: true })).toThrow("noting run has finished");
});

test("reportRequest preserves exact audit while acknowledging once, and later acknowledgement does not erase it", async () => {
  const turn = appendTarget(oldFact().text);
  agent = async input => {
    input.reportRequest({ exact: ["provider", "body"] });
    const note = input.tools.find(tool => tool.name === "note")!;
    expect(input.reviewFeedback(note.execute({ facts: [newFact(turn.id, oldFact().text)] }))).toContain("NEAR:");
    expect(note.execute({ facts: [newFact(turn.id, oldFact().text)] })).toContain("feedback has not been read yet");
    input.acknowledgeRequest();
    expect(JSON.parse(note.execute({ facts: [newFact(turn.id, oldFact().text)] })).factIds).toEqual([2]);
    return { outcome: "success", output: "done", audit: { available: false, reason: "native request body unavailable" } };
  };

  const result = await memory.noting({ sessionId, branch: "main", headTurnId: turn.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error("expected success");
  expect(JSON.parse(memory.store.getRun(result.runId)!.request!)).toEqual({ exact: ["provider", "body"] });
});

test("payload-free acknowledgement completes an empty Noting batch and preserves missing-request enforcement", async () => {
  const turn = appendTarget("No durable fact is present in this entry.");
  let unavailable = true;
  agent = async input => {
    input.acknowledgeRequest();
    expect(JSON.parse(input.tools.find(tool => tool.name === "note")!.execute({ facts: [] })).committed).toContain("zero facts");
    return unavailable
      ? { outcome: "success", output: "done", audit: { available: false as const, reason: "native request body unavailable" } }
      : { outcome: "success", output: "done" };
  };

  const accepted = await memory.noting({ sessionId, branch: "main", headTurnId: turn.id, mode: "subagent" });
  if (accepted.outcome !== "success") throw new Error("expected success");
  expect(memory.store.getRun(accepted.runId)!.request).toBeNull();
  expect(hydrate(memory.pendingEntries(sessionId, "main", turn.id), memory.store)).toEqual([]);

  const missingTurn = appendTarget("Another entry has no durable fact.");
  unavailable = false;
  const missing = await memory.noting({ sessionId, branch: "main", headTurnId: missingTurn.id, mode: "subagent" });
  if (missing.outcome !== "success") throw new Error("a committed empty batch remains business success");
  expect(missing.problems).toEqual(["runAgent must return the exact provider request after commit"]);
});

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

test("a later same-Turn legacy-address occurrence cannot invalidate the binding's frozen source", async () => {
  const target = appendTarget(oldFact().text);
  let frozenSourceId = 0, lateSourceId = 0;
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    const first = note.execute({ facts: [newFact(target.id, oldFact().text)] });
    expect(input.reviewFeedback(first)).toContain("NEAR:");
    const before = hydrate(memory.store.sourcePath(sessionId, "main", target.id), memory.store);
    frozenSourceId = before.find(entry => entry.turnId === target.id && entry.role === "assistant")!.id;
    const late = memory.appendEntry({ sessionId, nativeLineage: "fixture", nativeId: "late-same-turn", turnId: target.id,
      role: "assistant", text: oldFact().text, raw: JSON.stringify({ role: "assistant", text: oldFact().text }), calls: [] });
    lateSourceId = late.id;
    memory.store.selectSourcePath(sessionId, "main", [...before.map(entry => entry.id), late.id]);
    input.reportRequest({ round: 2 });
    expect(note.execute({ facts: [newFact(target.id, oldFact().text)] })).toContain("F2");
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(memory.store.factEntries(result.facts[0]!.id)).toContain(frozenSourceId);
  expect(memory.store.factEntries(result.facts[0]!.id)).not.toContain(lateSourceId);
});

test("the three-query candidate pool is one cross-connection database snapshot", () => {
  const secondId = addOld("A second earlier fact");
  const other = new Store(dbPath);
  other.db.exec("PRAGMA busy_timeout = 0");
  const sql = "INSERT INTO fact_relations (from_fact, to_fact, kind, strength) VALUES (?, ?, ?, ?)";
  let attempted = false, wroteDuringRead = false;
  const originalPrepare = memory.store.db.prepare.bind(memory.store.db);
  const prepare = vi.spyOn(memory.store.db, "prepare").mockImplementation(((statementSql: string) => {
    const statement = originalPrepare(statementSql);
    if (!String(statementSql).includes("SELECT f.*, t.session_id FROM facts f JOIN turns t ON t.id = f.turn_id")) return statement;
    return new Proxy(statement, { get(target, property) {
      if (property !== "all") {
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      }
      return (...params: unknown[]) => {
        const rows = (target.all as (...values: unknown[]) => unknown[])(...params);
        attempted = true;
        try { other.db.prepare(sql).run(secondId, 1, "support", "weak"); wroteDuringRead = true; }
        catch (error) { expect(String(error)).toMatch(/locked/); }
        return rows;
      };
    } });
  }) as typeof memory.store.db.prepare);
  try {
    const path = { sessionId, branch: "main", headTurnId: firstTurnId };
    const pool = memory.store.notingNearPool(sessionId, path, memory.store.pathSnapshot(path));
    expect(attempted).toBe(true);
    expect(wroteDuringRead).toBe(false);
    expect(pool.relations.get(1)).toEqual([]);
  } finally {
    prepare.mockRestore();
    if (!wroteDuringRead) other.db.prepare(sql).run(secondId, 1, "support", "weak");
    expect(other.listFactRelations(1)).toContainEqual({ fromFact: secondId, toFact: 1, kind: "support", strength: "weak" });
    other.close();
  }
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
  for (const run of memory.store.listRuns(sessionId).filter(run => run.kind === "noting" && run.outcome === "failure"))
    expect(JSON.parse(run.response!).diagnostics).toBeUndefined();
});

test.each([
  ["error", "failure", "provider failed after commit"],
  ["overflow", "failure", "prompt is too long after commit"],
  ["cancellation", "cancelled", "cancelled after commit"],
] as const)("a provider %s after the reviewed correction preserves business success and the audit", async (_label, outcome, output) => {
  const target = appendTarget(oldFact().text);
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    expect(input.reviewFeedback(note.execute({ facts: [newFact(target.id, oldFact().text)] }))).toContain("NEAR:");
    input.reportRequest({ round: 2 });
    expect(JSON.parse(note.execute({ facts: [newFact(target.id, oldFact().text)] })).factIds).toEqual([2]);
    return { outcome, output, request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  expect(result.outcome).toBe("success");
  const response = JSON.parse(memory.store.getRun(result.outcome === "success" ? result.runId : 0)!.response!);
  expect(JSON.stringify(response.problems)).toContain(output);
  expect(response.notingNearReview.firstSubmission.facts[0].text).toBe(oldFact().text);
  expect(response.toolCalls).toHaveLength(2);
  expect(response.toolCalls.at(-1).result).toContain("F2");
  expect(response.diagnostics).toEqual([{ kind: "unanswered_near", pairs: [{ fact: "F2", neighbour: "F1", score: 1 }] }]);
  expect(memory.progress(sessionId, "main", target.id).entries).toBe(0);
});

test.each([
  ["with its explicit relation", true],
  ["without a relation", false],
] as const)("38b binds reordered final facts by identity %s", async (_label, related) => {
  const a = oldFact().text;
  const b = "Database trace-memory moved from schema.2 to schema.3";
  const bId = addOld(b);
  memory.config.noting.nearThreshold = 1;
  const target = appendTarget(`${a}\n${b}`);
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    note.execute({ facts: [newFact(target.id, a), newFact(target.id, b)] });
    input.reportRequest({ round: 2 });
    const final = newFact(target.id, b, related ? { negate: [[`F${bId}`, "weak"]] } : {});
    expect(JSON.parse(note.execute({ facts: [final] })).factIds).toEqual([3]);
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error("expected success");
  const audit = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(audit.notingNearReview.shown.map((item: { handle: string }) => item.handle)).toEqual(["$1", "$2"]);
  expect(audit.notingNearReview.firstSubmission.facts.map((fact: { text: string }) => fact.text)).toEqual([a, b]);
  expect(audit.factIds).toEqual([3]);
  expect(audit.toolCalls).toHaveLength(2);
  expect(result.diagnostics).toEqual(related ? [] : [{ kind: "unanswered_near", pairs: [{ fact: "F3", neighbour: `F${bId}`, score: 1 }] }]);
  expect(audit.diagnostics).toEqual(result.diagnostics);
});

test("38b dropped and rewritten-below-threshold facts produce no positional or replacement pair", async () => {
  const a = oldFact().text;
  const target = appendTarget(a);
  memory.config.noting.nearThreshold = 1;
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    note.execute({ facts: [newFact(target.id, a)] });
    input.reportRequest({ round: 2 });
    note.execute({ facts: [newFact(target.id, "A wholly rewritten final claim")] });
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error("expected success");
  const audit = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(audit.notingNearReview.shown[0].text).toBe(a);
  expect(memory.store.getFact(result.facts[0]!.id)?.text).toBe("A wholly rewritten final claim");
  expect(audit.diagnostics).toEqual([]);
});

test("38b audits an inserted fact against all unique shown ids without a second top-three or current-pool read", async () => {
  const a = "Alpha package state";
  const b = "Beta database state";
  const c = "Inserted unrelated wording";
  addOld(a); addOld(a);
  addOld(b); addOld(b); addOld(b);
  const neverShown = addOld(c);
  memory.config.noting.nearThreshold = 0;
  const target = appendTarget(`${a}\n${b}\n${c}`);
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    note.execute({ facts: [newFact(target.id, a), newFact(target.id, b)] });
    input.reportRequest({ round: 2 });
    note.execute({ facts: [newFact(target.id, c)] });
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error("expected success");
  const audit = JSON.parse(memory.store.getRun(result.runId)!.response!);
  const shown = audit.notingNearReview.shown.flatMap((item: { neighbours: { factId: number }[] }) => item.neighbours.map(n => n.factId));
  expect(new Set(shown).size).toBeGreaterThan(3);
  expect(shown).not.toContain(neverShown);
  const pairs = audit.diagnostics[0].pairs as { fact: string; neighbour: string }[];
  expect(pairs).toHaveLength(new Set(shown).size);
  expect(new Set(pairs.map(pair => `${pair.fact}/${pair.neighbour}`)).size).toBe(pairs.length);
  expect(pairs.map(pair => pair.neighbour)).not.toContain(`F${neverShown}`);
});

test("38b duplicate displays collapse to one final identity pair and threshold equality is included", async () => {
  const a = oldFact().text;
  memory.config.noting.nearThreshold = 1;
  const target = appendTarget(a);
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    note.execute({ facts: [newFact(target.id, a), newFact(target.id, a)] });
    input.reportRequest({ round: 2 });
    note.execute({ facts: [newFact(target.id, a)] });
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.diagnostics).toEqual([{ kind: "unanswered_near", pairs: [{ fact: "F2", neighbour: "F1", score: 1 }] }]);
});

test.each([["support", "strong"], ["support", "weak"], ["negate", "strong"], ["negate", "weak"]] as const)(
  "38b an explicit %s relation of %s strength answers the pair", async (kind, strength) => {
    const a = oldFact().text;
    memory.config.noting.nearThreshold = 1;
    const target = appendTarget(a);
    agent = async input => {
      input.reportRequest({ round: 1 });
      const note = input.tools.find(tool => tool.name === "note")!;
      note.execute({ facts: [newFact(target.id, a)] });
      input.reportRequest({ round: 2 });
      note.execute({ facts: [newFact(target.id, a, { [kind]: [["F1", strength]] })] });
      return { outcome: "success", output: "done", request: { round: 2 } };
    };
    const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
    if (result.outcome !== "success") throw new Error("expected success");
    expect(result.diagnostics).toEqual([]);
  });

test("38b a rejected committing submission can be corrected and only the actual commit gets diagnostics", async () => {
  const target = appendTarget(oldFact().text);
  const commit = memory.store.commitNotingRun.bind(memory.store);
  let rejectCommit = true;
  memory.store.commitNotingRun = input => {
    if (!rejectCommit || input.run.kind !== "noting" || !input.facts.length) return commit(input);
    rejectCommit = false;
    const failed = memory.store.recordRun({ ...input.run, outcome: "failure", response: JSON.stringify({ problems: ["forced commit-time refusal"] }) });
    return { ok: false, runId: failed.id, problems: ["forced commit-time refusal"] };
  };
  agent = async input => {
    input.reportRequest({ round: 1 });
    const note = input.tools.find(tool => tool.name === "note")!;
    note.execute({ facts: [newFact(target.id, oldFact().text)] });
    input.reportRequest({ round: 2 });
    expect(note.execute({ facts: [newFact(target.id, oldFact().text)] })).toContain("forced commit-time refusal");
    expect(JSON.parse(note.execute({ facts: [newFact(target.id, oldFact().text, { support: [["F1", "weak"]] })] })).factIds).toEqual([2]);
    return { outcome: "success", output: "done", request: { round: 2 } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error(`expected success: ${JSON.stringify(result)}`);
  const audit = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(audit.toolCalls).toHaveLength(3);
  expect(audit.toolCalls[1].result).toContain("forced commit-time refusal");
  expect(audit.diagnostics).toEqual([]);
  const refused = memory.store.listRuns(sessionId).find(run => run.id !== result.runId && run.outcome === "failure"
    && run.response?.includes("forced commit-time refusal"));
  expect(refused?.outcome).toBe("failure");
});

test("38b fallback attempts keep separate review pools and only the committing attempt has diagnostics", async () => {
  const text = "Package trace-memory moved from beta.2 to beta.3";
  const target = appendTarget(text);
  let attempt = 0;
  agent = async input => {
    attempt++;
    input.reportRequest({ attempt });
    const note = input.tools.find(tool => tool.name === "note")!;
    const first = note.execute({ facts: [newFact(target.id, text)] });
    expect(input.reviewFeedback(first)).toContain("NEAR:");
    if (attempt === 1) return { outcome: "failure", output: "context overflow", request: { attempt },
      refused: { reason: "context overflow", boundary: { exactEntryIds: input.entryIds } } } as RunAgentResult;
    input.reportRequest({ attempt, round: 2 });
    note.execute({ facts: [newFact(target.id, text)] });
    return { outcome: "success", output: "done", request: { attempt, round: 2 }, mode: "subagent" };
  };
  const first = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "fork" });
  expect(first.outcome).toBe("dropped");
  addOld(text); addOld(text); addOld(text);
  const second = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "fork", effectiveMode: "subagent", fallbackReason: "context overflow" });
  if (second.outcome !== "success") throw new Error("expected fallback success");
  const runs = memory.store.listRuns(sessionId).filter(run => run.kind === "noting" && run.id !== 2);
  const failed = runs.find(run => run.outcome === "failure")!;
  const failedAudit = JSON.parse(failed.response!);
  const committedAudit = JSON.parse(memory.store.getRun(second.runId)!.response!);
  expect(failedAudit.notingNearReview.shown[0].neighbours.map((n: { factId: number }) => n.factId)).toEqual([1]);
  expect(failedAudit.diagnostics).toBeUndefined();
  expect(committedAudit.notingNearReview.shown[0].neighbours.map((n: { factId: number }) => n.factId)).toEqual([2, 3, 4]);
  expect(committedAudit.diagnostics[0].pairs.map((pair: { neighbour: string }) => pair.neighbour)).toEqual(["F2", "F3", "F4"]);
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
  const unrelated = await memory.noting({ sessionId, branch: "main", headTurnId: target.id, mode: "subagent" });
  expect(unrelated.outcome).toBe("success");
  if (unrelated.outcome !== "success") throw new Error("expected success");
  expect(unrelated.diagnostics).toEqual([]);
  expect(JSON.parse(memory.store.getRun(unrelated.runId)!.response!).notingNearReview).toBeUndefined();

  const emptyTurn = memory.store.appendTurn({ sessionId, parentTurnId: target.id, kind: "turn", assistantText: "nothing", startedAt: "third" });
  agent = async input => {
    input.reportRequest({ round: 1 });
    expect(JSON.parse(input.tools.find(tool => tool.name === "note")!.execute({ facts: [] })).committed).toContain("zero facts");
    return { outcome: "success", output: "done", request: { round: 1 } };
  };
  const empty = await memory.noting({ sessionId, branch: "main", headTurnId: emptyTurn.id, mode: "subagent" });
  expect(empty.outcome).toBe("success");
  if (empty.outcome !== "success") throw new Error("expected success");
  expect(empty.diagnostics).toEqual([]);

  const manual = memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: emptyTurn.id })
    .find(tool => tool.name === "note")!.execute({ facts: [newFact(emptyTurn.id, oldFact().text)] });
  expect(JSON.parse(manual).factIds).toEqual([3]);
  expect(JSON.parse(manual).feedback).toBeUndefined();
  expect(JSON.parse(memory.store.listRuns(sessionId).at(-1)!.response!).diagnostics).toBeUndefined();
});
