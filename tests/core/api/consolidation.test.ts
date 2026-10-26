// Former C facade contracts that survive retirement exercise the two-lane N publication protocol.
// C-only fact triggers, processing watermarks and immediate-commit protocols have no live replacement.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, tokens, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import memories from "../../fixtures/noting/facts.json";
import { submit, verifyUnchanged } from "../../support/noter.ts";

let directory: string, memory: ReturnType<typeof sourceSeededMemory>, sessionId: number, projectId: number;
let calls: NotingAgentInput[], script: ((input: NotingAgentInput) => Promise<RunAgentResult>)[];
const time = "2026-08-16 02:54";
const request = { fixture: "joint extraction" };
const empty = {};
const success = (): RunAgentResult => ({ outcome: "success", output: "done", request });
const session = (project = projectId) => memory.store.createSession({ enrollmentChoice: true, host: "pi:fixture", startedAt: time, firstReplyAt: time, projectId: project }).id;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-authority-")); calls = []; script = [];
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    if (input.task !== "extract-facts") return verifyUnchanged(input, { request });
    calls.push(input); input.reportRequest(request);
    const next = script.shift(); if (!next) throw new Error("unexpected call");
    return next(input);
  });
  projectId = memory.store.createProject({ name: "fixture", declaredBy: "mark" }).id; sessionId = session();
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
function fact(text = memories.base, options: { sessionId?: number; branch?: string; actor?: "user" | "agent"; category?: "observation" | "question"; quote?: string; createdAt?: string } = {}) {
  const owner = options.sessionId ?? sessionId, branch = options.branch ?? "main";
  const parent = memory.store.knowledgePath(owner, branch).headTurnId;
  const previous = parent == null ? [] : memory.store.sourcePath(owner, branch, parent).map(entry => entry.id);
  const turn = memory.store.appendTurn({ sessionId: owner, parentTurnId: parent ?? undefined,
    kind: "turn", userPrompt: text, startedAt: time });
  const entryIds = [...previous, ...memory.store.listSourceEntries(owner, turn.id).map(entry => entry.id)];
  memory.selectEntries(owner, branch, entryIds);
  const result = memory.store.commitNotingRun({ run: { kind: "manual", sessionId: owner, branch, createdAt: time }, facts: [{ turnId: turn.id,
    entryIds: entryIds.slice(-1), text, source: [`T${turn.id}#E1`], category: options.category, actor: options.actor, quote: options.quote, createdAt: options.createdAt ?? time }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  return result.facts[0]!;
}
function knowledge(support: number, text = memories.knowledge) {
  const result = memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time }, operations: [{ files: null,
    op: "create", title: "Fixture title", handle: "$1", author: "fixture", text, category: "understanding", scope: "project", topics: [], supports: [support], reason: "Seed", createdAt: time,
  }] });
  if (!result.ok) throw new Error(result.problems.join("; "));
  const item = result.committed[0]!;
  return { ...item, tag: `K${item.knowledgeId}#${memory.store.versionTag(item.knowledgeId, item.commit)}` };
}
const create = (support: number, text = memories.knowledge) => ({ files: null, op: "create", title: "Fixture title", text, category: "understanding", scope: "project", topics: [], supports: [`F${support}`], reason: "Initial admission" });
async function stage(input: NotingAgentInput, output: unknown) {
  await submit(input, memory, { noteInput: [], memoryInput: output as Record<string, unknown> });
}
function queue(output: unknown) { script.push(async input => { await stage(input, output); return success(); }); }
const run = (owner = sessionId, branch = "main", headTurnId = memory.store.knowledgePath(owner, branch).headTurnId!) => memory.noting({ sessionId: owner, branch, headTurnId });
function deferred() {
  let resolve!: (output: unknown) => void;
  const promise = new Promise<unknown>(r => { resolve = r; });
  script.push(async input => { await stage(input, await promise); return success(); });
  return resolve;
}

test("freezes branch, Raw membership and references through both lane publications", async () => {
  const old = fact(), existing = knowledge(old.id);
  const frozen = memory.store.sourcePath(sessionId, "main", old.turnId).map(entry => entry.id);
  const resolve = deferred();
  const selection = { sessionId, branch: "main", headTurnId: old.turnId, model: "fake-model" };
  const pending = memory.noting(selection); selection.branch = "switched";
  await new Promise(r => setTimeout(r, 0));
  const late = fact(memories.observation);
  expect(memory.store.currentKnowledge()).toHaveLength(1);
  resolve(create(old.id));
  const result = await pending;
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.branch).toBe("main"); expect(calls[0]!.model).toBe("fake-model");
  expect(calls[0]!.entryIds).toEqual(frozen);
  expect(calls[0]!.text).not.toContain(`[T${late.turnId}#`);
  expect(memory.store.currentCommit(existing.knowledgeId)[0]!.id).toBe(existing.commit);
  expect(memory.pendingEntries(sessionId, "main", late.turnId).map(entry => entry.turnId)).toEqual([late.turnId]);
  if (result.outcome !== "success") throw new Error("missing success audit");
  const audit = memory.store.getRun(result.runId)!;
  expect(JSON.parse(audit.request!)).toEqual(request);
  expect(JSON.parse(audit.response!).toolCalls).toHaveLength(1); // the verify task's check
  expect(JSON.parse(audit.response!)).not.toHaveProperty("readKnowledgeCommits");
});

for (const bad of ["shape", "failure", "cancelled", "missing request", "throw", "abort"] as const) {
  test(`${bad} records the attempt, keeps the batch pending and releases admission`, async () => {
    const evidence = fact();
    script.push(async input => {
      if (bad === "throw" || bad === "abort") { const error = new Error("stopped"); error.name = bad === "abort" ? "AbortError" : "Error"; throw error; }
      if (bad === "failure" || bad === "cancelled") return { outcome: bad, output: "stopped", request };
      if (bad === "missing request") { await stage(input, empty); return { outcome: "success", output: "done" }; }
      await stage(input, { ...create(evidence.id), category: "invalid" });
      return success();
    });
    const result = await run();
    const expected = bad === "cancelled" || bad === "abort" ? "cancelled" : "failure";
    expect(result.outcome, JSON.stringify(result)).toBe(expected);
    if (!("runId" in result) || !result.runId) throw new Error("expected failed run audit");
    expect(memory.store.getRun(result.runId)!.outcome).toBe(expected);
    expect(memory.store.currentKnowledge()).toEqual([]);
    expect(memory.store.listSessionFacts(sessionId)).toHaveLength(1);
    expect(memory.progress(sessionId, "main", evidence.turnId).entries).toBe(1);
    expect(memory.store.getClaim(sessionId, "noting")).toBeNull();
    queue(empty); expect((await run()).outcome).toBe("success");
  });
}

test("a duplicate Noter trigger is dropped across connections while empty targets remain independent", async () => {
  fact(); const resolve = deferred(), pending = run();
  const other = sourceSeededMemory(join(directory, "test.sqlite"), async () => { throw new Error("must not call"); });
  try {
    expect(await other.noting({ sessionId, branch: "main", headTurnId: 1 })).toEqual({ outcome: "dropped" });
    expect(await run(sessionId, "other")).toEqual({ outcome: "empty" });
    expect(await run(session())).toEqual({ outcome: "empty" });
    resolve(empty); expect((await pending).outcome).toBe("success");
    expect(calls).toHaveLength(1);
  } finally { other.close(); }
});

test("empty Raw ranges create no run; successful explicit empties consume only Raw, never historical C backlog", async () => {
  expect(await run()).toEqual({ outcome: "empty" }); expect(calls).toEqual([]);
  const evidence = fact(); queue(empty);
  expect((await run()).outcome).toBe("success");
  expect(memory.store.listConsolidatedProjectFacts(projectId)).toEqual([]);
  expect(memory.store.getFact(evidence.id)).not.toBeNull();
  const before = memory.store.listRuns(sessionId);
  expect(await run()).toEqual({ outcome: "empty" });
  expect(memory.store.listRuns(sessionId)).toEqual(before);
});

for (const bad of ["missing fact", "foreign fact", "late fact", "untagged base", "model handle", "duplicate target"] as const) test(`N resolution refuses ${bad} without publishing a sibling operation`, async () => {
  const evidence = fact(), base = knowledge(evidence.id);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.base, { sessionId: session(foreignProject) });
  const resolve = deferred(), pending = run();
  const late = fact();
  const update = { files: null, op: "update", id: base.tag, text: memories.editedKnowledge, category: "understanding", scope: "project", topics: [], supports: [`F${evidence.id}`], reason: "Update" };
  const operation = bad === "untagged base" ? { ...update, id: `K${base.knowledgeId}` }
    : bad === "model handle" ? { ...create(evidence.id), handle: "$e1" }
    : bad === "duplicate target" ? update
    : create(bad === "missing fact" ? 999999 : bad === "foreign fact" ? foreign.id : late.id);
  resolve([bad === "duplicate target" ? update : create(evidence.id), operation]);
  const result = await pending;
  expect(result.outcome, JSON.stringify(result)).toBe("failure");
  expect(memory.store.listKnowledgeRevisions()).toHaveLength(1);
  expect(memory.store.currentCommit(base.knowledgeId)[0]!.id).toBe(base.commit);
  expect(memory.progress(sessionId, "main", late.turnId).entries).toBe(2);
});

for (const sameProject of [false, true]) test(`independent sessions publish while another N is pending (same project: ${sameProject})`, async () => {
  const first = fact();
  const otherProject = sameProject ? projectId : memory.store.createProject({ name: "independent", declaredBy: "mark" }).id;
  const owner = session(otherProject), second = fact(memories.observation, { sessionId: owner });
  const resolve = deferred(), pending = run();
  queue(create(second.id)); expect((await run(owner)).outcome).toBe("success");
  resolve(create(first.id)); expect((await pending).outcome).toBe("success");
  expect(memory.pendingEntries(owner, "main", second.turnId)).toEqual([]);
  expect(memory.pendingEntries(sessionId, "main", first.turnId)).toEqual([]);
  expect(memory.store.listConsolidatedProjectFacts(projectId)).toEqual([]);
});

test("Raw progress failure inside fact publication rolls back facts, knowledge and success audit", async () => {
  const evidence = fact();
  script.push(async input => {
    await submit(input, memory, { noteInput: [{ title: "New episode", sources: `[T${evidence.turnId}#E1] New episode` }], memoryInput: { ...create(evidence.id), supports: ["$1"] } });
    return success();
  });
  memory.store.db.exec(`CREATE TEMP TRIGGER reject_progress AFTER INSERT ON noted_entries
    BEGIN SELECT RAISE(ABORT, 'progress write failed'); END`);
  try {
    const result = await run();
    expect(result.outcome, JSON.stringify(result)).toBe("failure");
    expect(memory.store.currentKnowledge()).toEqual([]);
    expect(memory.store.listSessionFacts(sessionId)).toHaveLength(1);
    expect(memory.pendingEntries(sessionId, "main", evidence.turnId)).toHaveLength(1);
    if (result.outcome !== "failure") throw new Error("expected failure");
    expect(result.problems.join(" ")).toContain("progress write failed");
    expect(memory.store.getRun(result.runId)!.outcome).toBe("failure");
  } finally { memory.store.db.exec("DROP TRIGGER reject_progress"); }
});

test("simulation v7m Chinese evidence remains traceable through N knowledge publication", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../fixtures/consolidation.json", import.meta.url), "utf8"));
  const ids = new Map<number, number>();
  for (const source of fixture.facts) ids.set(source.id, fact(source.text, { actor: source.actor, category: source.category, quote: source.quote, createdAt: source.timestamp }).id);
  queue({ files: null, op: "create", title: "Fixture title", topics: [], reason: "Initial admission", ...fixture.knowledge, category: "understanding", supports: fixture.knowledge.supports.map((id: string) => `F${ids.get(Number(id.slice(1)))}`) });
  const result = await run();
  expect(result.outcome, JSON.stringify(result)).toBe("success");
  expect(memory.trace("K1")).toContain(fixture.knowledge.text);
  for (const source of fixture.facts) expect(memory.trace(`F${ids.get(source.id)}`)).toContain(source.text);
});

test("one malformed reason prevents sibling knowledge publication and complete-batch progress", async () => {
  const evidence = fact(), good = create(evidence.id);
  queue([good, { ...good, text: "Second conclusion", reason: "   " }]);
  const result = await run();
  expect(result.outcome).toBe("failure");
  expect("problems" in result && result.problems?.join(" ")).toContain("reason");
  expect(memory.store.currentKnowledge()).toEqual([]);
  expect(memory.progress(sessionId, "main", evidence.turnId).entries).toBe(1);
});

// 144 supersedes the 200-versus-1000 half of this case: a body over 200 estimated tokens is now refused at the write call.
test("new numbers are not an extra N rejection gate", async () => {
  const evidence = fact("Measured 12 samples."), text = ("Measured 12 samples. 42 2 999 " + "word ".repeat(100)).trim(); // a file body is trimmed
  expect(tokens(text)).toBeLessThanOrEqual(200);
  queue(create(evidence.id, text));
  expect((await run()).outcome).toBe("success");
  expect(memory.store.currentCommit(1)[0]!.text).toBe(text);
});

test("historical C numeric and length diagnostics remain readable without a live C worker", () => {
  const diagnostics = [{ kind: "unsupported_numbers", knowledge: "$e1", numbers: ["2", "999"] },
    { kind: "over_200_tokens", knowledge: "$e1", tokens: 240 }];
  const response = JSON.stringify({ diagnostics });
  const historical = memory.store.recordRun({ kind: "consolidation", sessionId, branch: "main", createdAt: time,
    outcome: "success", response, request: "{}", model: "historical-C" });
  expect(memory.store.getRun(historical.id)!.kind).toBe("consolidation");
  expect(JSON.parse(memory.store.getRun(historical.id)!.response!).diagnostics).toEqual(diagnostics);
  const rendered = memory.trace(`R${historical.id}`, { full: true });
  expect(rendered).toContain("consolidation success");
  expect(rendered).toContain("unsupported_numbers");
  expect(rendered).toContain("over_200_tokens");
  expect(calls).toEqual([]);
});
