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
