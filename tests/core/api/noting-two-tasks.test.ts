// Ticket 144, Stage 3: the contract of the two-task Noter run, through the real runner and real Store effects. The scripted agent
// (tests/support/noter.ts) stands in for the model: it calls `check`, writes the two workspace files, and meets the stop hook.
import { afterEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { REQUEST, factsFile, knowledgeFile, scriptedNoter, type NoterOutput } from "../../support/noter.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const fact = (text = "User set the rule", source = "T1#E1") => ({ title: "Rule evidence", sources: `[${source}] ${text}` });
const create = (supports: string[] = ["$1"]) => ({ op: "create", title: "Fixture title", text: "Use the stated rule", category: "constraint", scope: "session", supports, reason: "new rule", topics: [] });

function fixture(script: NoterOutput[]) {
  const dir = mkdtempSync(join(tmpdir(), "tm-144-two-tasks-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "memory.sqlite");
  let memory!: ReturnType<typeof sourceSeededMemory>;
  const open = (next: NoterOutput[]) => {
    const noter = scriptedNoter(() => memory, next);
    memory = sourceSeededMemory(file, async raw => (raw as NotingAgentInput).kind === "noting" ? noter.agent(raw) : { outcome: "success", output: "", request: REQUEST } as RunAgentResult);
    return noter;
  };
  let noter = open(script);
  cleanup.push(() => memory.close());
  const project = memory.store.createProject({ name: "two-tasks", declaredBy: "mark" });
  const session = memory.store.createSession({ projectId: project.id, host: "pi:two-tasks", enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "User set the rule", assistantText: "Pi agent explained it", startedAt: "now" });
  const entries = memory.store.sourcePath(session.id, "main", turn.id);
  const path = { sessionId: session.id, branch: "main", headTurnId: turn.id };
  return {
    get memory() { return memory; }, get noter() { return noter; }, file, session, turn, entries, path,
    run: () => memory.noting(path),
    /** An executor restart: the façade closes and a new one opens the same database with a new script. */
    restart: (next: NoterOutput[]) => { memory.close(); noter = open(next); },
    published: () => memory.store.listSessionFacts(session.id),
    pending: () => memory.pendingEntries(session.id, "main", turn.id),
    runs: () => memory.store.listRuns(session.id).filter(run => run.kind === "noting"),
    failures: () => Number(memory.store.taskFailures(session.id).find(row => row.phase === "noting")?.count ?? 0),
  };
}
type Fixture = ReturnType<typeof fixture>;
const bodyOf = (run: { response: string | null }) => JSON.parse(run.response!);

// ---- Stop check -------------------------------------------------------------------------------------------------------------

test("a malformed file gets exactly one follow-up listing its problems; a fix that passes keeps the task", async () => {
  const f = fixture([{ noteInput: [fact("User set the rule", "T1#E99")], fix: () => ({ facts: factsFile([fact()]) }) }]);
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(f.noter.stopMessages).toHaveLength(1);
  expect(f.noter.stopMessages[0]).toContain("T1#E99");
  expect(f.noter.stopMessages[0]).toContain("Problems:");
  const [write, verify] = f.runs();
  expect(bodyOf(write!).stopChecks.map((check: { ok: boolean }) => check.ok)).toEqual([false, true]);
  expect(bodyOf(verify!).task).toBe("verify");
  expect(f.published()).toHaveLength(1);
});

test("a second failure fails the run: no hand-off, entries still pending, the directory removed", async () => {
  const f = fixture([{ noteInput: [fact("User set the rule", "T1#E99")] }]);
  const result = await f.run();
  expect(result).toMatchObject({ outcome: "failure" });
  expect(f.noter.stopMessages).toHaveLength(1); // one follow-up, never two
  expect(bodyOf(f.runs()[0]!).stopChecks.map((check: { ok: boolean }) => check.ok)).toEqual([false, false]);
  expect(f.noter.inputs).toHaveLength(1); // task 2 never started
  expect(f.memory.store.handoff(f.session.id, "noting")).toBeNull();
  expect(f.pending()).toHaveLength(f.entries.length);
  expect(f.published()).toEqual([]);
  expect(existsSync(f.noter.inputs[0]!.workspace.dir)).toBe(false);
});

// ---- Blocked before publication, through the runner ---------------------------------------------------------------------------

function seedKnowledge(f: Fixture) {
  const store = f.memory.store;
  const note = f.memory.tools({ kind: "manual", ...f.path, currentTurnId: f.turn.id }).find(tool => tool.name === "note")!;
  const fid = JSON.parse(note.execute(fact("User supplied enduring evidence"))).factIds[0] as number;
  const created = commitNoterKnowledge(store, { path: f.path, run: { sessionId: f.session.id, createdAt: "now" }, operations: [
    { op: "create", title: "Seeded title", text: "Old rule", category: "constraint", scope: "session", topics: [], supports: [fid], reason: "initial", createdAt: "now", author: "test", handle: "$seed" }] });
  if (!created.ok) throw new Error(created.problems.join("; "));
  const base = created.committed[0]!;
  return { fid, tag: `K${base.knowledgeId}#${store.versionTag(base.knowledgeId, base.commit)}` };
}

for (const [label, output, problem] of [
  ["an address outside the batch", () => ({ noteInput: [fact("x", "T1#E99")] }), "T1#E99"],
  ["a fact over the body limit", () => ({ noteInput: [fact("word ".repeat(300))] }), "200"],
  ["a role that does not match the entry", () => ({ noteInput: [fact("User set the rule", "T1#E1@assistant")] }), "assistant"],
  ["a second record for the same item", (f: Fixture) => { const seed = seedKnowledge(f);
    return { noteInput: [fact()], memoryInput: [{ op: "update", id: seed.tag, text: "First", supports: ["$1"], reason: "r" }, { op: "update", id: seed.tag, text: "Second", supports: ["$1"], reason: "r" }] }; }, "already has a record"],
] as const) test(`blocked before publication: ${label}`, async () => {
  const f = fixture([]);
  f.noter.script.push((output as (f: Fixture) => NoterOutput)(f)); // a seeded item, when the case needs one, exists before the run
  const pendingBefore = f.pending().length, factsBefore = f.published().length;
  const result = await f.run();
  expect(result.outcome).toBe("failure");
  if (result.outcome !== "failure") throw new Error("expected a failure");
  expect(result.problems.join("\n")).toContain(problem);
  expect(f.published()).toHaveLength(factsBefore);
  expect(f.memory.store.currentKnowledge(f.path).filter(item => item.revision.text !== "Old rule")).toEqual([]);
  expect(f.pending()).toHaveLength(pendingBefore);
  expect(f.memory.store.handoff(f.session.id, "noting")).toBeNull();
});

// ---- Resume -------------------------------------------------------------------------------------------------------------------

test("a task 2 that fails twice keeps its row and task 1's files; a restart resumes only task 2 on those files and publishes", async () => {
  const written = { noteInput: [fact()], memoryInput: create() };
  const f = fixture([{ ...written, verifyResult: { outcome: "failure", output: "verify stopped" } }, { verifyResult: { outcome: "failure", output: "verify stopped again" } }]);
  expect((await f.run()).outcome).toBe("failure");
  const row = f.memory.store.handoff(f.session.id, "noting")!;
  expect(row).toMatchObject({ nextTask: "verify", branch: "main", entryIds: f.entries.map(entry => entry.id) });
  const firstFiles = bodyOf(f.memory.store.getRun(row.runId)!).files;
  expect(firstFiles.facts).toBe(factsFile([fact()]));
  expect(firstFiles.knowledge).toBe(knowledgeFile(f.memory, create()));
  expect((await f.run()).outcome).toBe("failure"); // the resume fails too: same row, same files
  expect(f.memory.store.handoff(f.session.id, "noting")).toEqual(row);
  expect(f.pending()).toHaveLength(f.entries.length);
  expect(f.failures()).toBe(2); // each failed run is one failure, whichever task it stopped in
  // An executor restart: a new façade on the same database resumes without a task 1.
  let seen: { facts: string; knowledge: string } | undefined;
  f.restart([{ verify: files => { seen = files; }, noteInput: [fact("never written")] }]);
  const writesBefore = f.runs().filter(run => bodyOf(run).task === "write").length;
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(f.noter.inputs.map(input => input.task)).toEqual(["verify"]); // only task 2 ran
  expect(seen).toEqual({ facts: firstFiles.facts, knowledge: firstFiles.knowledge }); // on byte-equal files
  expect(f.runs().filter(run => bodyOf(run).task === "write")).toHaveLength(writesBefore); // no new task 1 run
  expect(f.memory.store.handoff(f.session.id, "noting")).toBeNull();
  expect(f.published().map(item => item.text)).toEqual(["User set the rule"]);
  expect(f.memory.store.currentKnowledge(f.path)).toHaveLength(1);
  expect(f.pending()).toEqual([]);
  expect(f.failures()).toBe(0); // a success resets the streak
});

test("cancelling a resumed task 2 keeps the row and counts no failure", async () => {
  const f = fixture([{ noteInput: [fact()], verifyResult: { outcome: "failure", output: "verify stopped" } }, { verifyResult: { outcome: "cancelled", output: "stopped" } }]);
  await f.run();
  const row = f.memory.store.handoff(f.session.id, "noting");
  expect(f.failures()).toBe(1);
  expect((await f.run()).outcome).toBe("cancelled");
  expect(f.memory.store.handoff(f.session.id, "noting")).toEqual(row);
  expect(f.failures()).toBe(1);
});

test("a hand-off whose batch is no longer pending whole is not resumed: a fresh task 1 runs, and its publication ends the row", async () => {
  const f = fixture([{ noteInput: [fact()], verifyResult: { outcome: "failure", output: "verify stopped" } }, { noteInput: [fact("Pi agent explained it", "T1#E2")] }]);
  await f.run();
  expect(f.memory.store.handoff(f.session.id, "noting")).not.toBeNull();
  // Another executor processed one entry of the frozen batch.
  const other = new Store(f.file);
  try { expect(other.commitNotingRun({ run: { kind: "noting", sessionId: f.session.id, branch: "main", createdAt: "elsewhere" }, facts: [], entryIds: [f.entries[0]!.id] }).ok).toBe(true); }
  finally { other.close(); }
  const result = await f.run();
  expect(result.outcome).toBe("success");
  expect(f.noter.inputs.slice(2).map(input => input.task)).toEqual(["write", "verify"]); // after the first batch's two
  expect(f.memory.store.handoff(f.session.id, "noting")).toBeNull();
});

test("an update whose base moved between the tasks is published as a create with the conflict note", async () => {
  const f = fixture([]);
  const seed = seedKnowledge(f);
  const advance = () => {
    const other = new Store(f.file);
    try {
      const base = other.currentKnowledge(f.path)[0]!;
      const result = commitNoterKnowledge(other, { path: f.path, run: { sessionId: f.session.id, createdAt: "later" }, operations: [
        { op: "update", knowledgeId: base.knowledge.id, baseCommit: base.revision.id, title: "Seeded title", text: "Concurrent rule", category: "constraint", scope: "session", topics: [], supports: [seed.fid], reason: "other", createdAt: "later" }] });
      if (!result.ok) throw new Error(result.problems.join("; "));
    } finally { other.close(); }
  };
  f.noter.script.push({ noteInput: [fact("Refinement")], memoryInput: { op: "update", id: seed.tag, text: "Requested rule", supports: [`F${seed.fid}`, "$1"], reason: "r" }, verify: () => advance() });
  expect(await f.run()).toMatchObject({ outcome: "success" });
  const current = f.memory.store.currentKnowledge(f.path);
  expect(current).toHaveLength(2);
  expect(current.find(item => item.revision.text === "Concurrent rule")).toBeDefined();
  expect(current.find(item => item.revision.text.includes("Requested rule"))!.revision.text).toContain(seed.tag);
  const audit = JSON.parse(f.memory.store.getRun(f.runs().at(-1)!.id)!.response!);
  expect(audit.knowledgeOperations[0].applied.op).toBe("create");
});

// ---- Identical inputs and `check` -----------------------------------------------------------------------------------------------

test("both tasks receive identical prompt, hash, text and tool definitions, and differ only in the task", async () => {
  const f = fixture([{ noteInput: [fact()] }]);
  expect(await f.run()).toMatchObject({ outcome: "success" });
  const [write, verify] = f.noter.inputs as [NotingAgentInput, NotingAgentInput];
  expect([write.task, verify.task]).toEqual(["write", "verify"]);
  for (const key of ["prompt", "promptHash", "text"] as const) expect(verify[key]).toBe(write[key]);
  const definitions = (input: NotingAgentInput) => JSON.stringify(input.tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
  expect(definitions(verify)).toBe(definitions(write));
  expect(write.text.endsWith("first: it names your task and your two files.")).toBe(true);
});

test("`check` names the task and files, lists problems and every length, and works before either file exists", async () => {
  const f = fixture([]);
  const reports: string[] = [];
  f.noter.script.push(async input => {
    const check = input.tools.find(tool => tool.name === "check")!;
    reports.push(String(await check.execute({}))); // before either file exists
    return { noteInput: [fact("word ".repeat(300))], fix: () => ({ facts: factsFile([fact()]) }) };
  });
  const result = await f.run();
  expect(result.outcome).toBe("success");
  const [before] = reports;
  const input = f.noter.inputs[0]!;
  expect(before).toContain("Task: write");
  expect(before).toContain(input.workspace.facts);
  expect(before).toContain(input.workspace.knowledge);
  expect(before).toContain("Problems: 2");
  expect(before).toContain("empty file");
  // The follow-up message is the same report: the over-limit body is named with its count against the limit.
  expect(f.noter.stopMessages[0]).toContain("Lengths:");
  expect(f.noter.stopMessages[0]).toMatch(/body \d+\/200 \(over\)/);
  expect(tokens("word ".repeat(300))).toBeGreaterThan(200);
});
