// Ticket 144, Stage 3: the contract of the two-task Noter run, through the real runner and real Store effects. The scripted agent
// (tests/support/noter.ts) stands in for the model: it calls `check`, writes the two workspace files, and meets the stop hook.
import { afterEach, expect, test } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult } from "../../source-fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { createHash } from "node:crypto";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { NOTING_CAPACITY, freezeNoting } from "../../../src/core/noting/index.ts";
import { notingToolDefinitions, pricedToolDefinitions } from "../../../src/core/api/tools.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import { REQUEST, factsFile, knowledgeFile, largestTaskPromptTokens, scriptedNoter, submit, verifyUnchanged, type NoterOutput } from "../../support/noter.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const fact = (text = "User set the rule", source = "T1#E1") => ({ title: "Rule evidence", sources: `[${source}] ${text}` });
const create = (supports: string[] = ["$1"]) => ({ op: "create", title: "Fixture title", text: "Use the stated rule", category: "constraint", scope: "session", supports, reason: "new rule", topics: [] });

function fixture(script: NoterOutput[], agent?: (input: NotingAgentInput) => Promise<RunAgentResult>) {
  const dir = mkdtempSync(join(tmpdir(), "tm-144-two-tasks-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "memory.sqlite");
  let memory!: ReturnType<typeof sourceSeededMemory>;
  const open = (next: NoterOutput[], custom = agent) => {
    const noter = scriptedNoter(() => memory, next);
    memory = sourceSeededMemory(file, async raw => (raw as NotingAgentInput).kind === "noting" ? (custom ? custom(raw as NotingAgentInput) : noter.agent(raw)) : { outcome: "success", output: "", request: REQUEST } as RunAgentResult);
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
    restart: (next: NoterOutput[], custom?: typeof agent) => { memory.close(); noter = open(next, custom); },
    published: () => memory.store.listSessionFacts(session.id),
    pending: () => memory.pendingEntries(session.id, "main", turn.id),
    runs: () => memory.store.listRuns(session.id).filter(run => run.kind === "noting"),
    failures: () => Number(memory.store.taskFailures(session.id).find(row => row.phase === "noting")?.count ?? 0),
  };
}
type Fixture = ReturnType<typeof fixture>;
const bodyOf = (run: { response: string | null }) => JSON.parse(run.response!);
/** Each step's stop-check outcomes of a run. */
const stopOks = (run: { response: string | null }) => bodyOf(run).steps.map((step: { stopChecks: { ok: boolean }[] }) => step.stopChecks.map(check => check.ok));

// ---- Stop check -------------------------------------------------------------------------------------------------------------

test("a malformed file gets exactly one follow-up listing its problems; a fix that passes keeps the task", async () => {
  const f = fixture([{ noteInput: [fact("User set the rule", "T1#E99")], fix: () => ({ facts: factsFile([fact()]) }) }]);
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(f.noter.stopMessages).toHaveLength(1);
  expect(f.noter.stopMessages[0]).toContain("T1#E99");
  expect(f.noter.stopMessages[0]).toContain("Problems:");
  const [write, verify] = f.runs();
  expect(stopOks(write!)).toEqual([[false, true], [true]]); // step 1 failed once and passed; step 2 passed
  expect(bodyOf(verify!).task).toBe("verify");
  expect(f.published()).toHaveLength(1);
});

test("a second failure fails the run: no hand-off, entries still pending, the directory removed", async () => {
  // The model stops again after the repair with the file as it was: the step's second failure.
  const f = fixture([{ noteInput: [fact("User set the rule", "T1#E99")], fix: (_message, files) => ({ facts: files.facts }) }]);
  const result = await f.run();
  expect(result).toMatchObject({ outcome: "failure" });
  expect(f.noter.stopMessages).toHaveLength(1); // one follow-up, never two
  expect(stopOks(f.runs()[0]!)).toEqual([[false, false]]); // step 1 failed twice; step 2 was never reached
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
  for (const file of Object.keys(PROMPTS) as (keyof typeof PROMPTS)[]) { // no task prompt rides in the shared prefix
    const heading = text(file).split("\n")[0]!;
    expect(write.prompt).not.toContain(heading); expect(write.text).not.toContain(heading);
  }
  const definitions = (input: NotingAgentInput) => JSON.stringify(input.tools.map(({ name, description, parameters }) => ({ name, description, parameters })));
  expect(definitions(verify)).toBe(definitions(write));
  expect(write.text.endsWith("first: it names your task, its first step and your files.")).toBe(true);
});

test("`check` names the task, step and file, lists problems and every length, and works before the file exists; step 1 needs no knowledge file", async () => {
  const f = fixture([]);
  const reports: string[] = [];
  f.noter.script.push(async input => {
    const check = input.tools.find(tool => tool.name === "check")!;
    reports.push(String(await check.execute({}))); // before the facts file exists
    writeFileSync(input.workspace.facts, factsFile([fact()]));
    reports.push(String(await check.execute({}))); // facts valid, no knowledge file: nothing to say about it at step 1
    return { noteInput: [fact("word ".repeat(300))], fix: () => ({ facts: factsFile([fact()]) }) };
  });
  const result = await f.run();
  expect(result.outcome).toBe("success");
  const [before, withoutKnowledge] = reports;
  const input = f.noter.inputs[0]!;
  expect(before).toContain("Task: write");
  expect(before).toContain("Step 1 of 2 (facts)");
  expect(before).toContain(input.workspace.facts);
  expect(before).not.toContain(input.workspace.knowledge);
  expect(before).toContain("Problems: 1");
  expect(before).toContain("empty file");
  expect(withoutKnowledge).toContain("Problems: none");
  // The follow-up message is the same report: the over-limit body is named with its count against the limit.
  expect(f.noter.stopMessages[0]).toContain("Lengths:");
  expect(f.noter.stopMessages[0]).toMatch(/body \d+\/200 \(over\)/);
  expect(tokens("word ".repeat(300))).toBeGreaterThan(200);
});

// ---- A lost claim (stage 4 §3.4, ruling 2026-10-22) -------------------------------------------------------------------------

test("a Noter run that loses its claim is one counted failure and publishes nothing; three in a row switch memory off", async () => {
  const lose = (f: Fixture) => () => { f.memory.store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE phase = 'noting'").run(); };
  const f = fixture([]);
  for (let n = 1; n <= 3; n++) {
    f.restart([{ noteInput: [fact()], memoryInput: [create()], verify: lose(f) }]);
    const result = await f.run();
    expect(result.outcome, `run ${n}`).toBe("failure");
    expect(f.published(), `run ${n}`).toHaveLength(0);
    expect(f.failures(), `run ${n}`).toBe(n);
    const last = f.memory.store.db.prepare("SELECT outcome, reason FROM task_executions ORDER BY rowid DESC LIMIT 1").get()!;
    expect(last).toMatchObject({ outcome: "failure", reason: "claim lost" });
    expect(f.memory.store.enabled(f.session.id), `run ${n}`).toBe(n < 3);
  }
});

// ---- Steps (stage 5 §1) ----------------------------------------------------------------------------------------------------------

const PROMPTS = { write1: "tasks/noting-write-facts.md", write2: "tasks/noting-write-knowledge.md", verify1: "tasks/noting-verify-facts.md", verify2: "tasks/noting-verify-knowledge.md" } as const;
const text = (file: keyof typeof PROMPTS) => loadPrompt(PROMPTS[file]);
const OK = { outcome: "success", output: "Done.", request: REQUEST } as RunAgentResult;
const check = async (input: NotingAgentInput) => String(await input.tools.find(tool => tool.name === "check")!.execute({}));
const put = (path: string, content: string) => writeFileSync(path, content);
/** A normal task 1: one fact, one create. */
const normalWrite = (f: () => Fixture) => (input: NotingAgentInput) => submit(input, f().memory, { noteInput: [fact()], memoryInput: create() }).then(() => OK);

test("each step's prompt reaches the model exactly once, in a check result, a repair or the advance, and never twice", async () => {
  const sent: string[] = [];
  const f: Fixture = fixture([], async input => {
    if (input.task === "verify") return verifyUnchanged(input);
    sent.push(await check(input), await check(input)); // the second check of a step repeats nothing
    put(input.workspace.facts, factsFile([fact("User set the rule", "T1#E99")]));
    sent.push(input.passEnd()!);                         // step 1's repair: its prompt was delivered by the first check
    put(input.workspace.facts, factsFile([fact()]));
    sent.push(input.passEnd()!);                         // the advance carries step 2's prompt
    sent.push(await check(input));                       // step 2's first check names the step but carries no second copy
    put(input.workspace.knowledge, knowledgeFile(f.memory, create()));
    expect(input.passEnd()).toBeUndefined();
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "success" });
  const all = sent.join("\n");
  expect(all.split(text("write1"))).toHaveLength(2);
  expect(all.split(text("write2"))).toHaveLength(2);
  expect(sent[0]).toContain("Step 1 of 2 (facts)"); expect(sent[0]).toContain(text("write1"));
  expect(sent[2]).not.toContain(text("write1")); // the repair
  expect(sent[3]).toContain("Step 1 passed."); expect(sent[3]).toContain(text("write2"));
  expect(sent[4]).toContain("Step 2 of 2 (knowledge)"); expect(sent[4]).not.toContain(text("write2"));
  // The run records a hash of every prompt it sent.
  const hash = (file: keyof typeof PROMPTS) => createHash("sha256").update(text(file)).digest("hex");
  expect(bodyOf(f.runs()[0]!).taskPrompts).toEqual([{ step: 1, hash: hash("write1") }, { step: 2, hash: hash("write2") }]);
  expect(bodyOf(f.runs()[1]!).taskPrompts).toEqual([{ step: 1, hash: hash("verify1") }, { step: 2, hash: hash("verify2") }]);
});

test("a model that stops without calling check gets the step's prompt in its repair; the core's final check and the stop records deliver nothing", async () => {
  const repairs: string[] = [];
  const f: Fixture = fixture([], async input => {
    if (input.task === "verify") return verifyUnchanged(input);
    put(input.workspace.facts, factsFile([fact("User set the rule", "T1#E99")]));
    repairs.push(input.passEnd()!);
    repairs.push(await check(input));
    put(input.workspace.facts, factsFile([fact()])); input.passEnd();
    put(input.workspace.knowledge, knowledgeFile(f.memory, create())); input.passEnd();
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(repairs[0]).toContain(text("write1"));
  expect(repairs[1]).not.toContain(text("write1")); // a later check does not repeat it
  // A host that returns without a stop or a check: the core's own check fails the run and no prompt was delivered.
  const g = fixture([], async () => OK);
  const result = await g.run();
  expect(result).toMatchObject({ outcome: "failure" });
  expect(result.outcome === "failure" && result.problems[0]).toBe("ended at step 1");
  expect(bodyOf(g.runs()[0]!).taskPrompts).toEqual([]);
  expect(g.memory.store.handoff(g.session.id, "noting")).toBeNull();
});

test("no state leaks from write into verify: verify starts at step 1 with its own prompt, compares step 2 with its own passed facts, and ends only after both steps", async () => {
  const reports: string[] = [];
  const f: Fixture = fixture([], async input => {
    if (input.task === "write") return normalWrite(() => f)(input);
    reports.push(await check(input));
    const original = input.workspace.facts;
    const facts = factsFile([{ ...fact(), title: "Rule evidence, verified" }]);
    put(original, facts);
    expect(input.passEnd()).toContain("Step 1 passed.");
    put(original, factsFile([fact()]));                      // task 1's text is not what step 1 of verify passed
    const repair = input.passEnd();
    expect(repair).toContain("changed after step 1 passed"); // Q10, against verify's own text
    put(original, facts);
    expect(input.passEnd()).toBeUndefined();
    return OK;
  });
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(reports[0]).toContain("Task: verify"); expect(reports[0]).toContain("Step 1 of 2 (facts)");
  expect(reports[0]).toContain(text("verify1")); expect(reports[0]).not.toContain(text("write1")); expect(reports[0]).not.toContain(text("verify2"));
  expect(f.published().map(item => item.title)).toEqual(["Rule evidence, verified"]);
  // A verify that passes its facts and stops has not finished its task, whatever the files hold.
  const g: Fixture = fixture([], async input => {
    if (input.task === "write") return normalWrite(() => g)(input);
    await check(input);
    expect(input.passEnd()).toContain("Step 1 passed.");
    return OK;
  });
  const result = await g.run();
  expect(result.outcome === "failure" && result.problems[0]).toBe("ended at step 2");
  expect(g.memory.store.handoff(g.session.id, "noting")).toMatchObject({ nextTask: "verify" });
  expect(g.published()).toEqual([]);
});

test("each step has its own repair, and step 2 may not change the facts file that passed step 1", async () => {
  const f: Fixture = fixture([{ noteInput: [fact("User set the rule", "T1#E99")], memoryInput: { ...create(), supports: [] },
    fix: message => message.includes("Step 2 of 2") ? { knowledge: knowledgeFile(f.memory, create()) } : { facts: factsFile([fact()]) } }]);
  expect(await f.run()).toMatchObject({ outcome: "success" });
  expect(f.noter.stopMessages).toHaveLength(2); // one repair at step 1 and one at step 2, not one for the task
  expect(f.noter.stopMessages[0]).toContain("Step 1 of 2"); expect(f.noter.stopMessages[1]).toContain("Step 2 of 2");
  const g: Fixture = fixture([], async input => {
    put(input.workspace.facts, factsFile([fact()]));
    expect(input.passEnd()).toContain("Step 1 passed.");
    put(input.workspace.facts, factsFile([{ ...fact(), title: "Changed in step 2" }]));
    put(input.workspace.knowledge, "## none\n");
    expect(input.passEnd()).toContain("changed after step 1 passed");
    put(input.workspace.facts, factsFile([fact()]));
    expect(input.passEnd()).toBeUndefined();
    return OK;
  });
  expect(await g.run()).toMatchObject({ outcome: "success" });
  expect(g.published().map(item => item.title)).toEqual(["Rule evidence"]);
});

test("a step's second failure is terminal: a later stop that finds the file fixed advances nothing and the run fails", async () => {
  // Step 1: the model stops twice with a bad facts file, then fixes it and stops again.
  const one: Fixture = fixture([], async input => {
    if (input.task === "verify") throw new Error("task 2 must not start");
    put(input.workspace.facts, factsFile([fact("User set the rule", "T1#E99")]));
    expect(input.passEnd()).toContain("Problems:");
    expect(input.passEnd()).toBeUndefined();
    put(input.workspace.facts, factsFile([fact()]));
    put(input.workspace.knowledge, "## none\n");
    expect(input.passEnd()).toBeUndefined();
    return OK;
  });
  const first = await one.run();
  expect(first.outcome === "failure" && first.problems[0]).toBe("check failed twice: step 1");
  expect(one.published()).toEqual([]);
  expect(one.pending()).toHaveLength(one.entries.length);
  expect(one.memory.store.handoff(one.session.id, "noting")).toBeNull();
  // Step 2 of task 2: the hand-off and task 1's files are kept.
  const two: Fixture = fixture([], async input => {
    if (input.task === "write") return normalWrite(() => two)(input);
    await check(input);
    expect(input.passEnd()).toContain("Step 1 passed.");
    put(input.workspace.knowledge, "not a block\n");
    expect(input.passEnd()).toContain("Problems:");
    expect(input.passEnd()).toBeUndefined();
    put(input.workspace.knowledge, knowledgeFile(two.memory, create()));
    expect(input.passEnd()).toBeUndefined();
    return OK;
  });
  const second = await two.run();
  expect(second.outcome === "failure" && second.problems[0]).toBe("check failed twice: step 2");
  const row = two.memory.store.handoff(two.session.id, "noting")!;
  expect(row.nextTask).toBe("verify");
  expect(bodyOf(two.memory.store.getRun(row.runId)!).files).toEqual({ facts: factsFile([fact()]), knowledge: knowledgeFile(two.memory, create()) });
  expect(stopOks(two.runs().at(-1)!)).toEqual([[true], [false, false]]);
  expect(two.published()).toEqual([]);
  // The resumed task 2 starts again at step 1.
  const reports: string[] = [];
  two.restart([], async input => { reports.push(await check(input)); return verifyUnchanged(input); });
  expect(await two.run()).toMatchObject({ outcome: "success" });
  expect(reports[0]).toContain("Step 1 of 2 (facts)");
});

test("task 1 failing at step 2 keeps nothing: no hand-off, entries pending, workspace removed", async () => {
  const f = fixture([{ noteInput: [fact()], files: { knowledge: "not a block\n" }, fix: (_message, files) => ({ knowledge: files.knowledge }) }]);
  const result = await f.run();
  expect(result.outcome === "failure" && result.problems[0]).toBe("check failed twice: step 2");
  expect(stopOks(f.runs()[0]!)).toEqual([[true], [false, false]]);
  expect(f.memory.store.handoff(f.session.id, "noting")).toBeNull();
  expect(f.pending()).toHaveLength(f.entries.length);
  expect(existsSync(f.noter.inputs[0]!.workspace.dir)).toBe(false);
});

test("the largest step-prompt set is priced with the instructions at the freeze", () => {
  const f = fixture([]);
  const frozen = freezeNoting(f.memory.store, f.path, f.memory.config);
  const tools = tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, canonicalToolNames)));
  const largest = Math.max(tokens([text("write1"), text("write2")].join("\n\n")), tokens([text("verify1"), text("verify2")].join("\n\n")));
  expect(largestTaskPromptTokens()).toBe(largest);
  const fixed = tokens(frozen.prompt) + largest + tools;
  expect(() => freezeNoting(f.memory.store, { ...f.path, capacity: { inputTokens: fixed - 1 } }, f.memory.config)).toThrow(NOTING_CAPACITY);
  expect(() => freezeNoting(f.memory.store, { ...f.path, capacity: { inputTokens: fixed + tokens(frozen.prepared!.text) } }, f.memory.config)).not.toThrow();
});
