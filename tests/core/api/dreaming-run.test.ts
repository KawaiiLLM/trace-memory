// Ticket 144, stage 4: the Dreamer's run shape. One admission, the hand-off and resume, curate's batches and what a pass
// leaves in the Store. A scripted model (tests/support/dreamer.ts) writes the files a host's model would.
import { afterEach, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture, scriptedDreamer, type DreamerScript } from "../../support/dreamer.ts";
import { archive, knowledge, legacyKnowledge, updateKnowledge } from "../../support/seed.ts";
import { tokens } from "../../../src/core/render/index.ts";
import { curatePrefix } from "../../../src/core/dreaming/curate.ts";
import { TASK_GAP_MS, executionLimitMs, remainingTasks } from "../../../src/core/dreaming/index.ts";
import { block } from "../../support/workspace.ts";
import { REQUEST } from "../../support/noter.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });

const dreamerFixture = (script: DreamerScript = {}, dbPath?: string) => makeDreamerFixture(memories, script, dbPath);
const archiveItem = (f: ReturnType<typeof dreamerFixture>, item: { knowledgeId: number; commit: number; supports: number[] }) =>
  archive(f.store, f.path, item.knowledgeId, item.commit, item.supports, "invalid", "No longer holds, per the user's later correction, which replaces it");
const covered = (f: { store: { db: { prepare(sql: string): { all(): Record<string, unknown>[] } } } }) =>
  f.store.db.prepare("SELECT revision_id FROM knowledge_processed ORDER BY revision_id").all().map(row => Number(row.revision_id));

test("a due run curates every category, scores the items, covers what it showed and leaves no hand-off", async () => {
  const f = dreamerFixture();
  const rule = f.item("Use pnpm everywhere", { category: "constraint" }), fact = f.item("Lockfile is committed", { category: "reference" });
  const result = await f.dream();
  expect(result).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.map(input => input.task)).toEqual(["curate", "classify"]); // curate changed nothing, so verify has no model call
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  expect(covered(f)).toEqual([rule.commit, fact.commit].sort((a, b) => a - b));
  const execution = f.store.db.prepare("SELECT outcome FROM task_executions").all();
  expect(execution).toEqual([{ outcome: "success" }]);
  expect(await f.dream()).toMatchObject({ outcome: "empty" }); // nothing changed since: not due
});

test("the trigger in the configuration is the one the due check and the admission use, whenever it is read", async () => {
  // Part 4c saw `dreaming.triggerTokens: 1` read back as 10000 on a host test's observer; the instance that schedules and admits reads its own.
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  f.memory.config.dreaming.triggerTokens = Number.MAX_SAFE_INTEGER;
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: false });
  expect(await f.dream()).toMatchObject({ outcome: "empty" });
  f.memory.config.dreaming.triggerTokens = 1;
  expect(f.memory.taskEligibility("dreaming", f.target)).toEqual({ due: true });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
});

// ---- Fixtures for the cases below -------------------------------------------------------------------------------------------

/** A batch proposal for the first run's operation (`update`): the stand-in for any change a pass keeps. */
const updateBlock = (item: { ref: string }, text: string) => block(`update ${item.ref}`, { reason: "tidy" }, text);
/** The curate batch runs that kept a proposal (nothing is applied by a batch). */
const keptBatches = (f: ReturnType<typeof dreamerFixture>) => f.store.listRuns(f.session.id).filter(run => JSON.parse(run.response ?? "{}").proposed !== undefined).length;
const revisions = (f: ReturnType<typeof dreamerFixture>) => Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions").get()!.n);
const task = (f: ReturnType<typeof dreamerFixture>) => f.store.db.prepare("SELECT outcome, reason FROM task_executions ORDER BY rowid").all() as { outcome: string | null; reason: string | null }[];
const count = (f: ReturnType<typeof dreamerFixture>) => Number(f.store.taskFailures(f.session.id).find(row => row.phase === "dreaming")?.count ?? 0);
/** The scripted conversation stopped at a gate the test opens, so a terminal path can happen while the model is "working". */
function gated(f: ReturnType<typeof dreamerFixture>, write: (file: string) => void) {
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const late: { message?: string | undefined; ran: boolean } = { ran: false };
  const agent = async (raw: unknown) => {
    const input = raw as import("../../source-fixture.ts").DreamingAgentInput;
    input.reportRequest({ system: "s", messages: [], tools: [] });
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    await gate;
    write(/File: (\S+?\.md)/.exec(report)![1]!);
    late.ran = true; late.message = input.passEnd();
    return { outcome: "success" as const, output: "late", request: { system: "s", messages: [], tools: [] } };
  };
  return { agent, release: () => open(), late };
}

// ---- Cancellation fence (R4-2) ----------------------------------------------------------------------------------------------

type Path = "stop" | "executor exit" | "memory off" | "lost claim" | "task deadline";
for (const path of ["stop", "executor exit", "memory off", "lost claim", "task deadline"] as Path[]) {
  test(`${path}: a model that ignores it and ends its pass later changes nothing and leaves the hand-off as it was`, async () => {
    const f = dreamerFixture();
    const existing = f.item("Existing rule", { category: "constraint" });
    const before = revisions(f);
    const late = updateBlock(existing, "Late rule text");
    const g = gated(f, file => writeFileSync(file, late));
    f.next(g.agent);
    if (path === "task deadline") f.memory.config.dreaming.timeoutMs = 5;
    const running = f.dream();
    await new Promise(resolve => setTimeout(resolve, 20));
    if (path === "stop") f.memory.cancelTasks();
    else if (path === "executor exit") f.memory.cancelTasks(true);
    else if (path === "memory off") f.store.setEnrollment(f.session.id, false);
    else if (path === "lost claim") f.store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE phase = 'dreaming'").run();
    g.release();
    const result = await running;
    expect(g.late.ran).toBe(true);
    expect(g.late.message).toBeUndefined();
    expect(revisions(f)).toBe(before);
    expect(keptBatches(f)).toBe(0); // the late pass kept no proposal either
    expect(covered(f)).toEqual([]);
    expect(task(f)[0]!.outcome).toBe(path === "lost claim" || path === "task deadline" ? "failure" : "cancelled");
    if (path !== "memory off") expect(result.outcome).toBe(path === "lost claim" || path === "task deadline" ? "failure" : "cancelled");
  });
}

// ---- Hand-off, resume and the retry rule (§3) -------------------------------------------------------------------------------

test("a batch is kept, not applied; a failure in the next keeps it, and a later run resumes at the batch that failed", async () => {
  const f = dreamerFixture({ curate: { reference: ["## bogus\n"] } });
  const rule = f.item("Rule one", { category: "constraint" });
  const ref = f.item("Ref one", { category: "reference" });
  f.dreamer.script.curate!.constraint = updateBlock(rule, "Rule one, tidied");
  const before = revisions(f);
  const failed = await f.dream();
  expect(failed).toMatchObject({ outcome: "failure", failure: { task: "curate", class: "check failed twice", transient: false, operation: "update" } });
  const handoff = f.store.handoff(f.session.id, "dreaming")!;
  expect(handoff.nextTask).toBe("curate");
  expect(handoff.detail).toMatchObject({ doneCategories: ["constraint"], curateRuns: [expect.any(Number)], operation: "update" });
  expect(covered(f)).toEqual([]); // coverage is written when verify passes, never before
  expect(revisions(f)).toBe(before); // the kept batch is not applied
  expect(keptBatches(f)).toBe(1);
  // It waits for a threshold (a permanent failure): nothing changed, so it is not due.
  expect(await f.dream()).toMatchObject({ outcome: "empty" });
  f.dreamer.script.curate!.reference = "## none\n";
  f.item("A later Noter item", { category: "reference" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs.slice(-3).map(input => input.task)).toEqual(["curate", "verify", "classify"]);
  expect(f.dreamer.reports.at(-3)).toContain("batch 1 of 1, category reference");
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  expect(covered(f)).toContain(ref.commit);
  expect(f.store.currentKnowledge(f.path).find(value => value.knowledge.id === rule.knowledgeId)!.revision.text).toBe("Rule one, tidied"); // applied at verify's pass
});

test("a transient failure retries at every check for three more attempts, then waits; a permanent one waits at once; memory stays on", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  const fail = (output: string) => f.next(async () => ({ outcome: "failure", output }));
  for (let attempt = 1; attempt <= 4; attempt++) {
    fail("429 rate limit");
    expect(await f.dream(), `attempt ${attempt}`).toMatchObject({ outcome: "failure", failure: { class: "provider error", transient: true } });
    const waitFrom = f.store.handoff(f.session.id, "dreaming")!.detail!.waitFrom;
    if (attempt === 4) expect(waitFrom).toBeTypeOf("number"); else expect(waitFrom).toBeUndefined();
  }
  expect(count(f)).toBe(0);
  expect(await f.dream()).toMatchObject({ outcome: "empty" }); // waiting for 10k tokens of newer Noter changes
  expect(f.store.enabled(f.session.id)).toBe(true);
  expect(task(f).map(row => row.reason)).toEqual(["curate: provider error, retry 1/3", "curate: provider error, retry 2/3", "curate: provider error, retry 3/3", "curate: provider error, waits for threshold"]);
  f.item("Another Noter item");
  fail("bad request");
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { class: "error", transient: false } });
  expect(await f.dream()).toMatchObject({ outcome: "empty" });
  f.item("Yet another Noter item");
  expect(await f.dream()).toMatchObject({ outcome: "success" }); // the pass resets the count and ends the hand-off
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  expect(count(f)).toBe(0);
});

test("the first failure persists the pointer: a retry runs even after the Noter changes are archived away", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  f.next(async () => ({ outcome: "failure", output: "network error" }));
  await f.dream();
  expect(f.store.handoff(f.session.id, "dreaming")!.detail).toMatchObject({ operation: "update" }); // the first-failure row names the operation
  archiveItem(f, rule);
  expect(f.store.noterChangedTokens(f.path)).toBe(0);
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs).toHaveLength(0); // no category is left, so curate passes without a model call
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
});

// ---- Settlement and late settlers (§3.4) ------------------------------------------------------------------------------------

test("a lost claim is one counted failure: hand-off kept, nothing written; user stop, memory off and executor exit are not counted", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  const late = updateBlock(rule, "Late rule text");
  const g = gated(f, file => writeFileSync(file, late));
  f.next(g.agent);
  const before = revisions(f);
  const running = f.dream();
  await new Promise(resolve => setTimeout(resolve, 20));
  f.store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE phase = 'dreaming'").run();
  g.release();
  expect(await running).toMatchObject({ outcome: "failure" });
  expect(revisions(f)).toBe(before);
  expect(task(f)).toEqual([{ outcome: "failure", reason: "curate: claim lost, retry 1/3" }]);
  expect(count(f)).toBe(1);
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "curate" });
  // A stop is not a failure.
  const stopping = gated(f, file => writeFileSync(file, "## none\n"));
  f.next(stopping.agent);
  const second = f.dream();
  await new Promise(resolve => setTimeout(resolve, 20));
  f.memory.cancelTasks();
  stopping.release();
  await second;
  expect(task(f).at(-1)!.outcome).toBe("cancelled");
  expect(count(f)).toBe(1);
});

test("A loses its claim, B takes over and finishes first: A's late settlement writes only its own row", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  const late = updateBlock(rule, "Late rule text");
  const a = gated(f, file => writeFileSync(file, late));
  f.next(a.agent);
  const first = f.dream();
  await new Promise(resolve => setTimeout(resolve, 20));
  f.store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE phase = 'dreaming'").run();
  expect(await f.dream()).toMatchObject({ outcome: "success" }); // B: the default scripted Dreamer, to the end
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  a.release();
  expect(await first).toMatchObject({ outcome: "failure" });
  expect(task(f).map(row => row.outcome)).toEqual(["failure", "success"]);
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull(); // B's finished cycle is not reopened
  expect(count(f)).toBe(0);
});

// ---- Time limits (§1.3) -----------------------------------------------------------------------------------------------------

test("a model that ignores its deadline fails as a timeout at its own deadline; a cooperative one sees the effective signal abort", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  f.memory.config.dreaming.timeoutMs = 30;
  let aborted = false;
  f.next(raw => new Promise(() => { void raw; })); // never settles and never looks at the signal
  const stuck = await f.dream();
  expect(stuck).toMatchObject({ outcome: "failure", failure: { task: "curate", class: "timeout", transient: true } });
  expect(task(f)[0]).toEqual({ outcome: "failure", reason: "curate: timeout, retry 1/3" });
  f.next(raw => new Promise(resolve => {
    (raw as { signal: AbortSignal }).signal.addEventListener("abort", () => { aborted = true; resolve({ outcome: "cancelled", output: "stopped" }); });
  }));
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { class: "timeout" } });
  expect(aborted).toBe(true);
  expect(task(f).at(-1)!.outcome).toBe("failure"); // the task deadline aborts the task, not the execution: not a cancellation
});

// ---- curate (§4) ------------------------------------------------------------------------------------------------------------

test("a failing batch file gets one repair message and then is kept; the receipt says kept, and nothing is applied before verify", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  f.dreamer.script.curate!.constraint = ["## bogus\n", updateBlock(rule, "Fixed rule")];
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.messages).toHaveLength(1);
  expect(f.dreamer.messages[0]).toContain("does not pass the check");
  expect(f.store.listKnowledgeRevisions().some(revision => revision.text === "Fixed rule")).toBe(true); // applied at verify's pass
});

test("a batch touches only its own category: a base from another category is a check problem", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  f.item("Reference", { category: "reference" });
  const update = block(`update K${rule.knowledgeId}@v${rule.ordinal}`, { title: "Rule", reason: "tidy" }, "Rule, tidied");
  f.dreamer.script.curate!.reference = [update, update]; // the reference batch names a constraint item
  const result = await f.dream();
  expect(result).toMatchObject({ outcome: "failure", failure: { class: "check failed twice" } });
  expect(f.dreamer.messages.join("\n")).toContain("is in category constraint; this batch covers reference");
});

test("the prefix shows unscored items whole and scored items whole by score while the cap holds, then titles only; it is deterministic", () => {
  const f = dreamerFixture();
  const low = f.item("Low scored rule with a long body ".repeat(20), { category: "constraint", title: "Low item" });
  const high = f.item("High scored rule with a long body ".repeat(20), { category: "constraint", title: "High item" });
  f.item("Unscored rule with a long body ".repeat(20), { category: "constraint", title: "New item" });
  f.store.db.prepare("UPDATE knowledge SET score = ? WHERE id = ?").run(30, low.knowledgeId);
  f.store.db.prepare("UPDATE knowledge SET score = ? WHERE id = ?").run(90, high.knowledgeId);
  const items = f.store.curateItems(f.path);
  const whole = tokens(curatePrefix(f.store, f.path, items, Infinity).text);
  const text = curatePrefix(f.store, f.path, items, Math.floor(whole * 0.8)).text;
  expect(text).toContain("Unscored rule with a long body");
  expect(text).toContain("High scored rule with a long body");
  expect(text).not.toContain("Low scored rule with a long body");
  expect(text).toContain("Low item"); // its header line, with the address and title
  expect(curatePrefix(f.store, f.path, items, Math.floor(whole * 0.8)).text).toBe(text);
});

// ---- Resume across a restart (§3.2) -----------------------------------------------------------------------------------------

test("after a restart the hand-off resumes at the first category not done, and the earlier batch's coverage counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-144-dreamer-restart-"));
  try {
    const file = join(dir, "memory.sqlite");
    const first = dreamerFixture({ curate: { reference: ["## bogus\n"] } }, file);
    const rule = first.item("Rule", { category: "constraint" }), ref = first.item("Reference", { category: "reference" });
    first.dreamer.script.curate!.constraint = updateBlock(rule, "Rule, tidied");
    expect(await first.dream()).toMatchObject({ outcome: "failure" });
    const { sessionId, branch, headTurnId } = first.target;
    const laterFact = first.existingFact("Later");
    first.memory.close(); memories.pop();
    // A new executor on the same database: nothing of the first run lives anywhere but the Store.
    const dreamer = scriptedDreamer();
    const memory = sourceSeededMemory(file, dreamer.agent); memories.push(memory);
    memory.config.dreaming.triggerTokens = 1;
    expect(memory.store.handoff(sessionId, "dreaming")).toMatchObject({ nextTask: "curate", detail: { doneCategories: ["constraint"] } });
    // The permanent failure waits for newer Noter changes; one arrives.
    const path = { sessionId, branch, headTurnId };
    knowledge(memory.store, path, "project", "reference", [laterFact.id], "A later reference", { operation: { title: "Later item" } });
    expect(await memory.dream({ sessionId, branch, headTurnId, model: "scripted" })).toMatchObject({ outcome: "success" });
    expect(dreamer.inputs.map(input => input.task)).toEqual(["curate", "verify", "classify"]); // the earlier batch's change is verified
    expect(dreamer.reports[0]).toContain("batch 1 of 1, category reference");
    const processed = memory.store.db.prepare("SELECT revision_id FROM knowledge_processed").all().map(row => Number(row.revision_id));
    expect(processed).toEqual(expect.arrayContaining([rule.commit, ref.commit]));
    expect(memory.store.handoff(sessionId, "dreaming")).toBeNull();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---- Arming and the backstop arithmetic (§2.5, §1.3) ------------------------------------------------------------------------

test("a Dreamer failure moves the progress signal, so the next check evaluates the retry", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  const before = f.store.progressSignal(f.session.id);
  f.next(async () => ({ outcome: "failure", output: "network error" }));
  await f.dream();
  expect(f.store.progressSignal(f.session.id)).not.toBe(before);
});

test("the backstop leaves every task a full timeout and a gap, and a resumed run only for the tasks it has left", () => {
  expect(executionLimitMs(remainingTasks(undefined), 1000)).toBe(3 * 1000 + 4 * TASK_GAP_MS);
  expect(executionLimitMs(remainingTasks("classify"), 1000)).toBe(1000 + 2 * TASK_GAP_MS);
  // The last deadline (admission + n timeouts + n - 1 gaps at most, clamped to the limit minus one gap) is always before the limit.
  for (const next of [undefined, "verify", "classify"] as const) {
    const left = remainingTasks(next), limit = executionLimitMs(left, 1000);
    expect(left * 1000 + (left - 1) * TASK_GAP_MS).toBeLessThan(limit - TASK_GAP_MS + 1);
  }
});

// ---- Titles, stale bases and a Noter write during the run (§4) ----------------------------------------------------------------

test("touching an untitled legacy item requires a title", async () => {
  const f = dreamerFixture();
  const legacy = legacyKnowledge(f.store, f.path, { scope: "project", category: "constraint", supports: [f.existingFact("Legacy support").id], text: "A legacy body without a title" });
  const touch = (title?: string) => block(`update K${legacy.knowledgeId}@v1`, { ...(title ? { title } : {}), reason: "tidy" }, "A legacy body, tidied");
  f.item("A Noter item that makes the run due", { category: "reference" }); // a legacy row is not a Noter change
  f.dreamer.script.curate!.constraint = [touch(), touch("Legacy item")];
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.messages[0]).toMatch(/title/i);
  expect(f.store.listKnowledgeRevisions(legacy.knowledgeId).at(-1)!.title).toBe("Legacy item");
});

test("a base that moved on during the run is refused at apply for that operation only and left for the next run; the batch still passes", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" }), other = f.item("Other rule", { category: "constraint" });
  f.dreamer.script.curate!.constraint = [
    block(`update K${rule.knowledgeId}@v${rule.ordinal}`, { reason: "tidy" }, "Rule, tidied"),
    block(`update K${other.knowledgeId}@v${other.ordinal}`, { reason: "tidy" }, "Other rule, tidied"),
  ].join("\n");
  f.next(async raw => { // a manual write lands on `rule` after the prefix was frozen
    updateKnowledge(f.store, f.path, rule.knowledgeId, rule.commit, "Rule, edited by hand", rule.supports);
    return f.dreamer.agent(raw);
  });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const run = f.store.listRuns(f.session.id).find(value => value.kind === "dreaming" && JSON.parse(value.response ?? "{}").verdicts)!; // refused at verify's apply, not by the batch check
  const results = (JSON.parse(run.response!).verdicts as { result: { ok: boolean; stale?: boolean } }[]).map(entry => entry.result);
  expect(results.map(result => result.ok)).toEqual([false, true]);
  expect(results[0]!.stale).toBe(true);
  expect(f.store.currentKnowledge(f.path).find(value => value.knowledge.id === rule.knowledgeId)!.revision.text).toBe("Rule, edited by hand");
});

test("a Noter version written after the prefix was frozen is not covered by the pass and still counts", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  let late: { commit: number } | undefined;
  f.next(async raw => { late = f.item("Written by the Noter mid-run", { category: "reference" }); return f.dreamer.agent(raw); });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(covered(f)).not.toContain(late!.commit);
  expect(f.store.noterChangedTokens(f.path)).toBeGreaterThan(0);
});

// ---- The rotation (stage 5 §3): one operation per run, update → merge → split → archive -----------------------------------------

type Fixture = ReturnType<typeof dreamerFixture>;
const due = (f: Fixture) => f.store.nextCurateOperation(f.project.id);
/** A second session of the same project, with its own path; `dream()` runs the shared scripted Dreamer for it. */
function secondSession(f: Fixture) {
  const session = f.store.createSession({ host: "offline", projectId: f.project.id, enrollmentChoice: true, startedAt: "now", firstReplyAt: "now" });
  const turn = f.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "second", startedAt: "now" });
  const entry = f.memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeLineage: "fixture", nativeId: "second", role: "user", text: "second", raw: "second", calls: [] });
  f.memory.selectEntries(session.id, "main", [entry.id]);
  const target = { sessionId: session.id, branch: "main", headTurnId: turn.id, model: "scripted" };
  return { session, target, dream: () => f.memory.dream(target) };
}
/** Every Dreamer run body that ended a run, oldest first. */
const finishes = (f: Fixture) => (f.store.db.prepare("SELECT r.id AS id, b.response AS response FROM runs r JOIN run_bodies b ON b.run_id = r.id WHERE r.kind = 'dreaming' ORDER BY r.id").all() as { id: number; response: string }[])
  .flatMap(row => { const finished = JSON.parse(row.response ?? "{}").finished; return finished ? [{ run: row.id, ...finished as { operation: string; advanced: boolean } }] : []; });
const taskHeaders = (f: Fixture) => f.dreamer.reports.filter(report => report.startsWith("Task: curate")).map(report => /Task: curate (\w+)/.exec(report)![1]!);
const execution = (f: Fixture) => f.store.db.prepare("SELECT outcome, reason FROM task_executions ORDER BY rowid").all() as { outcome: string | null; reason: string | null }[];
/** A classify model that scores every item in its pass, meets the stop hook, then does `after` with the pass number (1-based) before it returns. */
const classifyThen = (after: (input: import("../../source-fixture.ts").DreamingAgentInput, pass: number) => Promise<Partial<import("../../source-fixture.ts").RunAgentResult> | void> | Partial<import("../../source-fixture.ts").RunAgentResult> | void, failBefore?: number) =>
  async (input: import("../../source-fixture.ts").DreamingAgentInput) => {
    input.reportRequest(REQUEST);
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    if (Number(/pass (\d+)/.exec(report)?.[1] ?? 1) === failBefore) return { outcome: "failure", output: "429 rate limit", request: REQUEST } as import("../../source-fixture.ts").RunAgentResult; // fails before its stop: nothing committed
    const ids = [...(/Items: (.*)/.exec(report)?.[1] ?? "").matchAll(/K(\d+)/g)].map(match => match[1]!);
    writeFileSync(/File: (\S+?\.md)/.exec(report)![1]!, ids.map(id => `K${id} 50`).join("\n") + "\n");
    input.passEnd();
    const pass = Number(/pass (\d+)/.exec(report)?.[1] ?? 1);
    return { outcome: "success", output: "Done.", request: REQUEST, usage: { tokens: 12 }, ...(await after(input, pass) ?? {}) } as import("../../source-fixture.ts").RunAgentResult;
  };

test("a curate file holds the run's one operation: a block of another operation, and any create, are refused", async () => {
  const f = dreamerFixture();
  const a = f.item("Rule A", { category: "constraint" }), b = f.item("Rule B", { category: "constraint" });
  const merge = block(`merge ${a.ref}`, { absorb: b.ref, reason: "same" }, "Merged.");
  f.dreamer.script.curate!.constraint = [merge, merge];
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { class: "check failed twice" } });
  expect(f.dreamer.messages[0]).toContain("`## merge` is not allowed in a curate file; allowed: `update`");
  const g = dreamerFixture();
  const c = g.item("Rule C", { category: "constraint" });
  const create = block("create", { title: "New", category: "constraint", scope: "project", topics: "", supports: `F${c.supports[0]}`, reason: "new" }, "A new rule.");
  g.dreamer.script.curate!.constraint = [create, create];
  expect(await g.dream()).toMatchObject({ outcome: "failure" });
  expect(g.dreamer.messages[0]).toContain("`## create` is not allowed in a curate file");
});

test("the first run is update; each finished run advances the project to the next operation, and a lap returns to update", async () => {
  const f = dreamerFixture();
  expect(due(f)).toBe("update");
  f.item("Rule", { category: "constraint" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(due(f)).toBe("merge");
  expect(finishes(f)).toMatchObject([{ operation: "update", advanced: true }]);
  await f.cycleTo("update"); // merge, split, archive: a whole lap
  expect(finishes(f).map(finished => finished.operation)).toEqual(["update", "merge", "split", "archive"]);
  expect(taskHeaders(f)).toEqual(["update", "merge", "split", "archive"]);
});

test("a run with nothing to curate or score finishes and advances through its no-work tasks", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  f.next(async () => ({ outcome: "failure", output: "network error" }));
  await f.dream();
  archiveItem(f, rule);
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(f.dreamer.inputs).toHaveLength(0); // curate, verify and classify were all no-work runs
  expect(finishes(f)).toMatchObject([{ operation: "update", advanced: true }]);
  expect(due(f)).toBe("merge");
});

for (const failing of ["curate", "verify", "classify"] as const) {
  test(`a ${failing} failure does not advance: a second session of the project runs the same operation, and the failed run resumes it`, async () => {
    const f = dreamerFixture();
    const rule = f.item("Rule", { category: "constraint" });
    if (failing !== "classify") f.dreamer.script.curate!.constraint = failing === "curate" ? ["## bogus\n", "## bogus\n"] : block(`update ${rule.ref}`, { reason: "tidy" }, "Rule, tidied");
    if (failing === "verify") f.dreamer.script.verify = ["## bogus\n", "## bogus\n"];
    if (failing === "classify") f.dreamer.script.instead = { classify: () => ({ outcome: "failure", output: "bad request" }) as never };
    expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: failing, operation: "update" } });
    expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: failing, detail: { operation: "update" } });
    expect(due(f)).toBe("update");
    // The second session has a real trigger: a Noter-written item the project has not covered.
    const other = secondSession(f);
    f.dreamer.script.curate = {}; f.dreamer.script.verify = undefined; f.dreamer.script.instead = {};
    f.dreamer.reports.length = 0;
    f.item("A later Noter item", { category: "reference" });
    expect(await other.dream()).toMatchObject({ outcome: "success" });
    expect(taskHeaders(f)[0]).toBe("update"); // the same operation: nothing advanced
    expect(finishes(f)).toMatchObject([{ operation: "update", advanced: true }]);
    expect(due(f)).toBe("merge");
    // The failed session resumes its own operation, update, though the project is on merge now; it finishes without moving the rotation (Q13).
    f.dreamer.reports.length = 0;
    f.item("Another Noter item", { category: "reference" });
    expect(await f.dream()).toMatchObject({ outcome: "success" });
    expect(f.dreamer.reports.find(report => report.startsWith("Task: curate")) ?? f.dreamer.reports[0]).toMatch(failing === "curate" ? /curate update/ : /./);
    expect(finishes(f).at(-1)).toMatchObject({ operation: "update", advanced: false });
    expect(due(f)).toBe("merge");
  });
}

test("a finished run whose operation is not the one due does not move the rotation; finishing first, or after a whole lap, does [Q13]", async () => {
  // A (update) fails at verify and keeps its hand-off; B runs update and merge; A resumes update: the next run is split, not merge.
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy" }, "Rule, tidied");
  f.dreamer.script.verify = ["## bogus\n", "## bogus\n"];
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "verify" } });
  f.dreamer.script.curate = {}; f.dreamer.script.verify = undefined;
  const b = secondSession(f);
  f.item("B item 1", { category: "reference" });
  expect(await b.dream()).toMatchObject({ outcome: "success" }); // update, finished
  f.item("B item 2", { category: "reference" });
  expect(await b.dream()).toMatchObject({ outcome: "success" }); // merge, finished
  expect(due(f)).toBe("split");
  f.item("A fresh Noter item", { category: "reference" }); // B covered what it saw; A is due again by new Noter changes
  expect(await f.dream()).toMatchObject({ outcome: "success" }); // A resumes verify of its update
  expect(finishes(f).map(finished => [finished.operation, finished.advanced])).toEqual([["update", true], ["merge", true], ["update", false]]);
  expect(due(f)).toBe("split");
  // Finishing first (nothing advanced meanwhile) advances.
  const g = dreamerFixture();
  const r = g.item("Rule", { category: "constraint" });
  g.dreamer.script.curate!.constraint = block(`update ${r.ref}`, { reason: "tidy" }, "Rule, tidied");
  g.dreamer.script.verify = ["## bogus\n", "## bogus\n"];
  await g.dream();
  g.dreamer.script.verify = undefined;
  g.item("Later", { category: "reference" });
  expect(await g.dream()).toMatchObject({ outcome: "success" });
  expect(finishes(g)).toMatchObject([{ operation: "update", advanced: true }]);
  expect(due(g)).toBe("merge");
});

test("wrap-around is compared by operation name: after the others go once round, a resumed update that finishes advances", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  f.dreamer.script.curate!.constraint = block(`update ${rule.ref}`, { reason: "tidy" }, "Rule, tidied");
  f.dreamer.script.verify = ["## bogus\n", "## bogus\n"];
  await f.dream();
  f.dreamer.script.curate = {}; f.dreamer.script.verify = undefined;
  const b = secondSession(f);
  for (const lap of ["update", "merge", "split", "archive"]) {
    f.item(`B item ${lap}`, { category: "reference" });
    expect(await b.dream()).toMatchObject({ outcome: "success" });
  }
  expect(due(f)).toBe("update");
  f.item("A fresh Noter item", { category: "reference" });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(finishes(f).at(-1)).toMatchObject({ operation: "update", advanced: true });
  expect(due(f)).toBe("merge");
});

test("the rotation is kept per project: another project starts at update", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  await f.dream();
  expect(due(f)).toBe("merge");
  expect(f.store.nextCurateOperation(f.store.createProject({ name: "other", declaredBy: "mark" }).id)).toBe("update");
});

test("the finish is committed with the last pass: before any settlement the rotation has advanced and no hand-off remains; a non-final pass writes none", async () => {
  const f = dreamerFixture();
  for (let i = 0; i < 105; i++) f.item(`Rule number ${i}`, { category: "reference", title: `Rule ${i}` }); // 105 unscored items: two classify passes
  const seen: { pass: number; handoff: unknown; due: string; outcome: unknown; finished: boolean }[] = [];
  f.dreamer.script.instead = { classify: classifyThen((input, pass) => {
    const run = f.store.db.prepare("SELECT b.response AS response FROM runs r JOIN run_bodies b ON b.run_id = r.id WHERE r.kind = 'dreaming' ORDER BY r.id DESC LIMIT 1").get()!;
    seen.push({ pass, handoff: f.store.handoff(f.session.id, "dreaming")?.nextTask ?? null, due: due(f), outcome: execution(f).at(-1)!.outcome, finished: JSON.parse(String(run.response)).finished !== undefined });
    void input;
  }) };
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  expect(seen).toEqual([
    { pass: 1, handoff: "classify", due: "update", outcome: null, finished: false }, // not final: no finish, the rotation has not moved
    { pass: 2, handoff: null, due: "merge", outcome: null, finished: true }]); // final: finished and advanced, the execution not yet settled
});

test("two sessions: while the first holds the Dreamer seat after a non-final pass the second is dropped; once it fails and releases it, the second runs the same operation", async () => {
  const f = dreamerFixture();
  for (let i = 0; i < 105; i++) f.item(`Rule number ${i}`, { category: "reference", title: `Rule ${i}` });
  const b = secondSession(f);
  let duringSeat: unknown;
  f.dreamer.script.instead = { classify: classifyThen(async (_input, pass) => {
    if (pass === 1) { f.item("Item for the second session", { category: "constraint" }); duringSeat = (await b.dream()).outcome; }
  }, 2) };
  expect(await f.dream()).toMatchObject({ outcome: "failure", failure: { task: "classify", operation: "update" } });
  expect(duringSeat).toBe("dropped"); // assertion (1)
  expect(due(f)).toBe("update"); // nothing advanced
  f.dreamer.script.instead = {}; f.dreamer.reports.length = 0;
  f.item("A real trigger for the second session", { category: "constraint" });
  expect(await b.dream()).toMatchObject({ outcome: "success" });
  expect(taskHeaders(f)[0]).toBe("update"); // assertion (2)
});

test("a lost lease at the final pass commits no finish, and the next run repeats the operation", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  f.dreamer.script.instead = { classify: async input => {
    input.reportRequest(REQUEST);
    const report = String(await input.tools.find(tool => tool.name === "check")!.execute({}));
    const ids = [...(/Items: (.*)/.exec(report)![1]!).matchAll(/K(\d+)/g)].map(match => match[1]!);
    writeFileSync(/File: (\S+?\.md)/.exec(report)![1]!, ids.map(id => `K${id} 50`).join("\n") + "\n");
    f.store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE phase = 'dreaming'").run(); // the lease lapses before the final commit
    input.passEnd();
    return { outcome: "success", output: "Done.", request: REQUEST } as never;
  } };
  expect(await f.dream()).toMatchObject({ outcome: "failure" });
  expect(finishes(f)).toEqual([]);
  expect(due(f)).toBe("update");
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "classify", detail: { operation: "update" } });
});

test.each(["failure", "cancelled", "claim lost"] as const)("a final commit, then a host %s: the run is complete, no hand-off or retry is recreated, and the rotation advanced once", async how => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  f.dreamer.script.instead = { classify: classifyThen(input => {
    if (how === "cancelled") { f.memory.cancelTasks(); return { outcome: "cancelled", output: "stopped after the commit" }; }
    if (how === "claim lost") f.store.db.prepare("UPDATE task_claims SET expires_at = 0 WHERE phase = 'dreaming'").run();
    else return { outcome: "failure", output: "provider stopped after the final commit" };
    void input;
  }) };
  await f.dream();
  expect(f.store.handoff(f.session.id, "dreaming")).toBeNull();
  // A failure is recorded as the audit of a complete run; a cancel keeps its outcome; a lapse after the commit settles as the success the run was.
  const [row] = execution(f);
  expect(row!.outcome).toBe(how === "failure" ? "failure" : how === "cancelled" ? "cancelled" : "success");
  if (how === "failure") expect(row!.reason).toContain("run already finished");
  expect(count(f)).toBe(0);
  expect(finishes(f)).toMatchObject([{ operation: "update", advanced: true }]);
  expect(due(f)).toBe("merge"); // advanced exactly once
  // A second session with a real trigger runs the successor operation.
  const other = secondSession(f);
  f.dreamer.script.instead = {}; f.dreamer.reports.length = 0;
  f.item("A real trigger", { category: "constraint" });
  expect(await other.dream()).toMatchObject({ outcome: "success" });
  expect(taskHeaders(f)[0]).toBe("merge");
  expect(finishes(f).map(finished => finished.operation)).toEqual(["update", "merge"]);
});
