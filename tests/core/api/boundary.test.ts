// Tickets 19b and 20a: the core task boundary. Core owns memory (frozen material, evidence
// eligibility, validation, atomic commits, progress) and, since the user's ruling of 2026-09-08, the
// host-neutral domain text as well: it builds no provider message or body, and the host receives
// structured material plus prepared text and reports what it can and cannot audit. Every test here
// names the ruling it pins.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { freezeNoting } from "../../../src/core/noting/index.ts";
import { pricedToolDefinitions, notingToolDefinitions } from "../../../src/core/api/tools.ts";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTS_TITLE } from "../../../src/core/render/material.ts";
import { submit, submitEmpty, verifyUnchanged } from "../../support/noter.ts";
import { sourceSeededMemory, renderEntry, toolDefinitions, tokens, ENTRY_VIEW_VERSION,
  compacted, type NotingAgentInput, type RunAgentResult , hydrate } from "../../source-fixture.ts";
import { largestTaskPromptTokens } from "../../support/noter.ts";

let directory: string, memory: ReturnType<typeof sourceSeededMemory>;
let calls: NotingAgentInput[];
let runAgent: (input: NotingAgentInput) => Promise<RunAgentResult>;
let verified: Partial<RunAgentResult> | undefined;
const time = "2026-09-08T00:00:00Z";
const notingPrompt = loadPrompt("noting.md");

function open() {
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput;
    if (input.task === "verify") return verifyUnchanged(input, verified); // the scripted write task is what these tests vary
    calls.push(input);
    return runAgent(input);
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-boundary-"));
  calls = []; verified = undefined;
  runAgent = async input => { submitEmpty(input); return { outcome: "success", output: "", request: { fake: true } }; };
  open();
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

function session() {
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  return memory.store.createSession({ enrollmentChoice: true, host: "pi:boundary", startedAt: time, firstReplyAt: time, projectId: project.id }).id;
}
const turn = (sessionId: number, parentTurnId: number | null, user: string, assistant: string) =>
  memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: user, assistantText: assistant, startedAt: time });
const fact = (source: string) => ({ title: "Observed boundary", sources: `[${source}] Observed at ${source}` });

test.each([
  ["noting", false], ["noting", true],
] as const)("external abort selectively releases delayed %s claims (replaced before abort: %s)", async (phase, replaced) => {
  const own = session(), other = session();
  const ownTurn = turn(own, null, "own evidence", "reply");
  const otherTurn = turn(other, null, "other evidence", "reply");
  for (const [id, t] of [[own, ownTurn], [other, otherTurn]] as const)
    memory.tools({ kind: "manual", sessionId: id, branch: "main", currentTurnId: t.id })
      .find(tool => tool.name === "note")!.execute(fact(`T${t.id}#E1`));
  let releaseOwn = () => {}, releaseOther = () => {};
  const ownGate = new Promise<void>(resolve => { releaseOwn = resolve; });
  const otherGate = new Promise<void>(resolve => { releaseOther = resolve; });
  const late: string[] = [];
  runAgent = async input => {
    await (input.sessionId === own ? ownGate : otherGate);
    if (input.sessionId === own) late.push(...input.tools.map(tool => tool.execute({}) as string));
    return { outcome: "cancelled", output: "delayed runner settled", request: { fake: true } };
  };
  const target = { sessionId: own, branch: "main", headTurnId: ownTurn.id };
  const controller = new AbortController();
  const run = memory.noting;
  const cancelled = run({ ...target, signal: controller.signal });
  const untouched = run({ ...target, sessionId: other, headTurnId: otherTurn.id });
  expect(memory.tools({ kind: "manual", sessionId: own, branch: "main", currentTurnId: ownTurn.id }).find(tool => tool.name === "memory")!.execute({
    op: "create", title: "Fixture title", text: "Own rule", category: "constraint", scope: "session", supports: ["F1"], topics: [], reason: "Seed independent D claim",
  })).toContain("committed");
  const oldClaim = memory.store.getClaim(own, phase)!;
  const otherClaim = memory.store.getClaim(other, phase)!;
  const otherPhase = "dreaming";
  const phaseClaim = memory.store.acquireClaim(target, otherPhase, memory.executorId, false, () => true, 0)!; // trigger 0: the test needs the claim held, not a due Dreamer
  expect(phaseClaim).not.toBeNull();
  expect(oldClaim).toBeTruthy();
  expect(otherClaim).toBeTruthy();
  try {
    // A takeover before the abort must survive the listener as well as the stale finalizer.
    if (replaced) memory.store.releaseClaim(oldClaim);
    const taken = replaced ? memory.store.acquireClaim(target, phase, memory.executorId)! : null;
    controller.abort();
    // Neither runner has settled; release-on-finalization would fail this assertion.
    expect(memory.store.getClaim(own, phase)).toEqual(taken);
    expect(memory.store.getClaim(own, otherPhase)).toEqual(phaseClaim);
    expect(memory.store.getClaim(other, phase)).toEqual(otherClaim);
    const replacement = taken ?? memory.store.acquireClaim(target, phase, memory.executorId)!;
    expect(replacement.token).not.toBe(oldClaim.token);
    releaseOwn();
    expect((await cancelled).outcome).not.toBe("success");
    expect(calls.find(input => input.sessionId === own)!.tools.map(tool => tool.name)).toEqual(["search", "check"]);
    expect(late).toEqual(Array(2).fill("rejected: run has finished"));
    // The stale task's finally must not release a new task, even under the same executor id.
    expect(memory.store.getClaim(own, phase)).toEqual(replacement);
    expect(memory.store.getClaim(own, otherPhase)).toEqual(phaseClaim);
    expect(memory.store.getClaim(other, phase)).toEqual(otherClaim);
    memory.store.releaseClaim(replacement);
    memory.store.releaseClaim(phaseClaim);
  } finally { releaseOwn(); releaseOther(); await Promise.all([cancelled, untouched]); }
});

test.each([
  ["noting", false, false], ["noting", true, false],
  ["noting", false, true], ["noting", true, true],
] as const)("external abort retries %s claim release (persistent failure: %s, already aborted: %s)", async (phase, persistent, alreadyAborted) => {
  const id = session(), t = turn(id, null, "evidence", "reply");
  let settle = () => {};
  const held = new Promise<void>(resolve => { settle = resolve; });
  runAgent = async () => {
    await held;
    return { outcome: "cancelled", output: "runner cancelled", request: { fake: true } };
  };
  const releaseClaim = memory.store.releaseClaim.bind(memory.store);
  const release = vi.spyOn(memory.store, "releaseClaim");
  if (persistent) release.mockImplementation(() => { throw new Error("release unavailable"); });
  else release.mockImplementationOnce(() => { throw new Error("release unavailable"); });
  const controller = new AbortController();
  if (alreadyAborted) controller.abort();
  const target = { sessionId: id, branch: "main", headTurnId: t.id, signal: controller.signal };
  const attempt = memory.noting(target);
  try {
    if (!alreadyAborted) {
      expect(() => controller.abort()).not.toThrow();
      expect(calls[0]!.signal!.aborted).toBe(true);
      expect(calls[0]!.signal!.reason).toBe(controller.signal.reason);
      expect(calls[0]!.tools.map(tool => tool.name)).toEqual(["search", "check"]);
      expect(calls[0]!.tools.map(tool => tool.execute({}))).toEqual(Array(2).fill("rejected: run has finished"));
    } else expect(calls).toEqual([]);
    expect(release).toHaveBeenCalledTimes(1);
    const claim = memory.store.getClaim(id, phase)!;
    expect(claim).toBeTruthy(); // Immediate release failed; finalization has not run yet.
    settle();
    const result = await attempt;
    expect(result.outcome).toBe("cancelled");
    expect(release).toHaveBeenCalledTimes(2);
    expect(release.mock.calls).toEqual([[claim], [claim]]);
    if (result.outcome !== "cancelled") throw new Error("expected cancellation");
    expect(result.problems?.filter(problem => problem.startsWith("claim release failed:")))
      .toEqual(persistent ? ["claim release failed: Error: release unavailable"] : []);
    expect(memory.store.getClaim(id, phase)).toEqual(persistent ? claim : null);
    if (persistent) releaseClaim(claim);
  } finally { settle(); release.mockRestore(); await attempt; }
});

test.each(["noting"] as const)("external abort respects the %s publication boundary", async phase => {
  const id = session(), t = turn(id, null, "evidence", "reply");
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  runAgent = async input => {
    expect(input.tools.find(tool => tool.name === "check")!.execute({})).toContain("Task: write");
    await held;
    return { outcome: "cancelled", output: "aborted after commit", request: { fake: true } };
  };
  const controller = new AbortController();
  const target = { sessionId: id, branch: "main", headTurnId: t.id, signal: controller.signal };
  const attempt = memory.noting(target);
  try {
    expect(memory.store.listRuns(id).filter(run => run.kind === phase)).toHaveLength(0);
    controller.abort();
    expect(memory.store.getClaim(id, phase)).toBeNull();
    release();
    const result = await attempt;
    expect(result.outcome).toBe("cancelled");
    expect(memory.store.listRuns(id).find(run => run.kind === phase)!.outcome).toBe("cancelled");
    expect(memory.pendingEntries(id, "main", t.id)).toHaveLength(2);
  } finally { release(); await attempt; }
});

// --------------------------------------------------- structured material and text, no provider body

/** 20a 2026-09-08 supersedes the 19b wording "no core module builds a message sequence or a provider
 * body, and no host receives composed domain text": core now owns the domain text and still builds no
 * provider message or body. `text` is allowed; a message sequence, a system slot or a body is not. */
function assertNoProviderMessage(input: NotingAgentInput) {
  const record = input as unknown as Record<string, unknown>;
  for (const key of ["subagentInput", "messages", "system", "conversation", "body"])
    expect(key in record).toBe(false);
  expect(Array.isArray(record.input)).toBe(false); // no provider message array under any name
  expect(typeof input.text).toBe("string"); // 29b: one prepared text per task, whatever mode runs it
  // The parts stay parts: core's assembled blocks live in `text`, never smuggled into a material field.
  const parts = Object.values(input.material).flat().filter((part): part is string => typeof part === "string");
  for (const part of parts) {
    expect(part.startsWith("Range: ")).toBe(false);
    expect(part).not.toContain("<knowledge>");
    expect(part).not.toContain(`\n\n${FACTS_TITLE}`);
    expect(part).not.toContain("\n\nRaw:");
  }
}

test("19b 2026-09-08: a host stub that receives structured material and declares its request audit unavailable still commits", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  verified = { request: undefined, audit: { available: false, reason: "this host cannot expose provider requests" } };
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    assertNoProviderMessage(input);
    // Everything this stub needs is a part it can place itself.
    expect(input.material.entries.map(e => e.view)).toEqual(hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store).map(e => renderEntry(e, memory.config.render).content));
    expect(input.entryAudit.viewVersion).toBe(ENTRY_VIEW_VERSION);
    expect(input.entryAudit.viewBudgets).toEqual({ entryTokens: 2_000, toolInputTokens: 100, toolResultTokens: 100 }); // the one profile (30)
    await submit(input, memory, { noteInput: [fact(`T${t.id}#E1`)], memoryInput: {} });
    return { outcome: "success", output: "done", audit: { available: false, reason: "this host cannot expose provider requests" } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: t.id });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.problems).toBeUndefined();
  expect(memory.store.listSessionFacts(sessionId).map(f => f.text)).toEqual([`Observed at T${t.id}#E1`]);
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe("success");
  expect(run.request).toBeNull(); // nothing fabricated
  const response = JSON.parse(run.response!);
  expect(response.audit).toEqual({ available: false, reason: "this host cannot expose provider requests" });
  expect(response.problems).toEqual([]);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", t.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
});

test("19b 2026-09-08: the same stub still fails core validation, and a host expected to capture a request still reports the audit problem", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  // Unavailable audit is not a licence to write anything: validation is core's and is unchanged.
  runAgent = async raw => {
    await submit(raw, memory, { noteInput: [{ ...fact(`T${t.id}#E1`), category: "invalid" }], memoryInput: {} });
    return { outcome: "success", output: "done", audit: { available: false, reason: "no request available" } };
  };
  const refused = await memory.noting({ sessionId, branch: "main", headTurnId: t.id });
  expect(refused.outcome).toBe("failure");
  if (refused.outcome !== "failure") throw new Error("expected a refusal");
  expect(refused.problems.join("\n")).toContain("category");
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  // A host that claims nothing about its audit and returns no request is still an audit problem.
  runAgent = async input => {
    submitEmpty(input);
    return { outcome: "success", output: "done" };
  };
  const failed = await memory.noting({ sessionId, branch: "main", headTurnId: t.id });
  expect(failed.outcome).toBe("failure");
  if (failed.outcome !== "failure") throw new Error("expected a failure");
  expect(failed.problems).toEqual(["runAgent must return the exact provider request"]);
  expect(hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store)).toHaveLength(2); // neither attempt advanced progress
});

test("19b/92: N with unavailable audit stages knowledge on earlier facts and commits terminally", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute(fact(`T${t.id}#E1`));
  const batch = { op: "create", title: "Fixture title", topics: [], reason: "Initial admission of this conclusion.", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] };
  verified = { request: undefined, audit: { available: false, reason: "no provider request on this host" } };
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    assertNoProviderMessage(input);
    await submit(input, memory, { noteInput: [], memoryInput: batch });
    expect(memory.store.currentKnowledge()).toEqual([]);
    return { outcome: "success", output: "integrated", audit: { available: false, reason: "no provider request on this host" } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: t.id });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(memory.store.currentKnowledge(memory.store.knowledgePath(sessionId, "main")).map(k => k.revision.text)).toEqual(["The project uses pnpm"]);
  const response = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(response.audit).toEqual({ available: false, reason: "no provider request on this host" });
  expect(response.problems).toEqual([]);
});

// ---------------------------------------------------------- gate 4: budget before selection

/** Cost of everything core adds to the material of a Noting run in an empty database. */
const overhead = () => tokens(notingPrompt) + tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, canonicalToolNames)));

/** Calibrate the artificial host window against the same frozen, rendered material Core prices.
 * This only measures a boundary; the actual noting call below still admits the full pending path. */
function calibratedNoting(sessionId: number, headTurnId: number, maxEntryId?: number) {
  const frozen = freezeNoting(memory.store, { sessionId, branch: "main", headTurnId,
    ...(maxEntryId === undefined ? {} : { boundary: { maxEntryId } }) }, memory.config);
  if (!frozen.prepared) throw new Error("Expected pending Noting material for capacity calibration");
  const fixed = tokens(frozen.prompt) + largestTaskPromptTokens() + tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, frozen.names)));
  return { frozen, cost: fixed + tokens(frozen.prepared.text) };
}

test("19b 2026-09-08 gate 4: the supplied budget shrinks the batch before the only model call, and the excluded tail stays pending and unwritable", async () => {
  const sessionId = session();
  const first = turn(sessionId, null, "first " + "word ".repeat(600), "reply one");
  const second = turn(sessionId, first.id, "second " + "word ".repeat(600), "reply two");
  const views = hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store).map(e => renderEntry(e, memory.config.render).content);
  const owned = hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store).filter(e => e.turnId === first.id);
  expect(views.length).toBe(4);
  // The batch ceiling admits both Turns; the host's artificial window admits exactly the first
  // Turn's production-rendered material, including guide, range, titles and receipts.
  expect(tokens(views.join("\n\n"))).toBeLessThan(10_000);
  const firstCost = calibratedNoting(sessionId, second.id, owned.at(-1)!.id);
  const fullCost = calibratedNoting(sessionId, second.id);
  expect(firstCost.frozen.entries.map(e => e.id)).toEqual(owned.map(e => e.id));
  expect(fullCost.frozen.entries).toHaveLength(4);
  const inputTokens = firstCost.cost;
  expect(fullCost.cost).toBeGreaterThan(inputTokens);
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    expect(input.material.entries.map(e => e.id)).toEqual(owned.map(e => e.id)); // oldest first, one Turn
    expect(input.range).toEqual({ from: `S${sessionId}/T${first.id}`, to: `S${sessionId}/T${first.id}` });
    expect(tokens(input.prompt) + largestTaskPromptTokens() + tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, canonicalToolNames))) + tokens(input.text)).toBeLessThanOrEqual(inputTokens);
    // Inherited context is not evidence permission: the excluded tail cannot be cited.
    const refused = await submit(input, memory, { noteInput: [fact(`T${second.id}#E1`)], memoryInput: {} });
    expect(refused).toContain("invalid source");
    await submit(input, memory, { noteInput: [fact(`T${first.id}#E1`)], memoryInput: {} });
    return { outcome: "success", output: "done", request: { fake: true } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: second.id,
    capacity: { inputTokens } });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(calls).toHaveLength(1); // one selection, one freeze, one model call
  const run = memory.store.getRun(result.runId)!;
  expect([run.rangeFrom, run.rangeTo]).toEqual([`S${sessionId}/T${first.id}`, `S${sessionId}/T${first.id}`]);
  expect(JSON.parse(run.response!).entryAudit.entries.map((e: { id: number }) => e.id)).toEqual(owned.map(e => e.id));
  expect(memory.store.listSessionFacts(sessionId).map(f => f.text)).toEqual([`Observed at T${first.id}#E1`]);
  // The unselected tail is untouched: still pending, for a later permitted trigger.
  expect(hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store).map(e => e.turnId)).toEqual([second.id, second.id]);
});

test("19b 2026-09-08 gate 4: an oldest entry that does not fit the supplied budget leaves the queue pending with a capacity problem and no progress", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "first " + "word ".repeat(600), "reply one");
  const before = hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store);
  runAgent = async () => { throw new Error("no model call may happen"); };
  await expect(memory.noting({ sessionId, branch: "main", headTurnId: t.id,
    capacity: { inputTokens: overhead() } })).rejects.toThrow(/Noting capacity: selected evidence cannot fit the model context/);
  expect(calls).toEqual([]);
  expect(memory.store.listRuns(sessionId)).toEqual([]);
  expect(hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store)).toEqual(before);
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
});

test("19b 2026-09-08: the frozen material carries the whole batch, and core's fresh text is what a fresh-context run sends", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    expect(input.text).toContain("用 pnpm");
    submitEmpty(input);
    return { outcome: "success", output: "", request: { fake: true } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: t.id })).outcome).toBe("success");
});

// --------------------------------------------------------------- 20a scenario 1: one shared assembly

/** Ticket 20 acceptance scenario 1. This stub knows no Pi or CC message type: it reads core's
 * prepared text, runs the tool protocol of both phases, and lays nothing out itself. */
test("20a/92: a host-neutral N extracts both layers and shares knowledge rendering with injection and compact", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  let noted = "";
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    assertNoProviderMessage(input);
    noted = input.text; // the whole task, as text: instructions stay a separate field
    expect(input.prompt).toContain("Noting (facts and knowledge)");
    expect(noted).toContain(input.material.entries[0]!.view);
    await submit(input, memory, { noteInput: [fact(`T${t.id}#E1`)], memoryInput: { op: "create", title: "Fixture title", text: "The project uses pnpm", category: "constraint", scope: "project", topics: [], supports: ["$1"], reason: "Joint extraction" } });
    expect(memory.store.currentKnowledge()).toEqual([]);
    return { outcome: "success", output: "done", audit: { available: false, reason: "text-only host" } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: t.id })).outcome).toBe("success");

  expect(memory.store.currentCommit(1)[0]!.supports).toEqual([1]);
  expect(calls).toHaveLength(1);

  // The same knowledge block reaches the main agent: initial injection and compact share the rendering.
  const injected = memory.inject(sessionId);
  expect(injected).toContain("The project uses pnpm");
  const knowledgeBlock = injected.split("\n\nReceipts:")[0]!;
  expect(compacted(memory.compact(sessionId, "main", t.id)).startsWith(`${knowledgeBlock}\n\n<episodic>`)).toBe(true);
  // Injection is knowledge-only: sharing the material type adds no facts and no Raw to it.
  expect(injected).not.toContain(FACTS_TITLE);
  expect(injected).not.toContain("\nRaw:");
  // Fresh-N knowledge input is the independent 06 integration; no retired C request is needed.
});

test("20a 2026-09-08: no host file lays out the knowledge, fact, Raw or review blocks", () => {
  const titles = [FACTS_TITLE,
    "<knowledge>", "Range: ${"];
  const directory = new URL("../../../src/hosts/", import.meta.url);
  const files: URL[] = [];
  for (const host of readdirSync(directory, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    for (const file of readdirSync(new URL(`${host.name}/`, directory)))
      if (file.endsWith(".ts") && !file.endsWith(".test.ts")) files.push(new URL(`${host.name}/${file}`, directory));
  }
  // Test helpers live outside src now; require the actual production files, not a fixture-inflated count.
  expect(files.map(file => file.href)).toEqual(expect.arrayContaining(
    ["pi/index.ts", "pi/native.ts", "cc/index.ts"].map(path => new URL(path, directory).href)));
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    // Text headings begin at a word boundary; identifiers such as the SDK's `settingSources:` do not.
    for (const title of titles) {
      const present = /^\w/.test(title)
        ? new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(source)
        : source.includes(title);
      expect([file.pathname, present]).toEqual([file.pathname, false]);
    }
  }
});

/** Ticket 20 "Capacity negotiation" and acceptance scenario 15. The host reports the context it has;
 * core reduces the oldest-first task set and re-freezes the material, the write eligibility and the
 * audit membership together, and prices the domain text it actually sends — titles, range and
 * receipts included — so the reduced task provably fits the window it was given. */
test("20b 2026-09-08 scenario 15: a smaller host window reduces and re-freezes the task, with evidence, audit membership and writable sources moving together", async () => {
  const sessionId = session();
  const first = turn(sessionId, null, "first " + "word ".repeat(600), "reply one");
  const second = turn(sessionId, first.id, "second " + "word ".repeat(600), "reply two");
  const pending = hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store);
  const views = pending.map(e => renderEntry(e, memory.config.render).content);
  const owned = pending.filter(e => e.turnId === first.id).map(e => e.id);
  const firstCost = calibratedNoting(sessionId, second.id, pending.filter(e => e.turnId === first.id).at(-1)!.id);
  const fullCost = calibratedNoting(sessionId, second.id);
  expect(firstCost.frozen.entries.map(e => e.id)).toEqual(owned);
  expect(fullCost.frozen.entries).toHaveLength(4);
  const inputTokens = firstCost.cost;
  expect(fullCost.cost).toBeGreaterThan(inputTokens);
  let sent!: NotingAgentInput;
  runAgent = async raw => {
    sent = raw as NotingAgentInput;
    expect(await submit(sent, memory, { noteInput: [fact(`T${second.id}#E1`)], memoryInput: {} })).toContain("invalid source");
    await submit(sent, memory, { noteInput: [fact(`T${first.id}#E1`)], memoryInput: {} });
    return { outcome: "success", output: "done", request: { fake: true } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: second.id,
    capacity: { inputTokens } });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(calls).toHaveLength(1); // one reduction, one freeze, one model call
  // What core priced is what it sends, and it fits the window the host reported.
  expect(tokens(sent.prompt) + largestTaskPromptTokens() + tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, canonicalToolNames))) + tokens(sent.text))
    .toBeLessThanOrEqual(inputTokens);
  // Evidence, frozen material, audit membership and the recorded range are the same reduced set.
  expect(sent.entryIds).toEqual(owned);
  expect(sent.material.entries.map(e => e.id)).toEqual(owned);
  expect(sent.text).toContain(views[0]!);
  expect(sent.text).not.toContain(views[2]!);
  const run = memory.store.getRun(result.runId)!;
  expect(JSON.parse(run.response!).entryAudit.entries.map((e: { id: number }) => e.id)).toEqual(owned);
  expect([run.rangeFrom, run.rangeTo]).toEqual([`S${sessionId}/T${first.id}`, `S${sessionId}/T${first.id}`]);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", second.id), memory.store).filter(e => memory.store.entryNoted(e.id)).map(e => e.id)).toEqual(owned);
  // The excluded tail is untouched, for a later permitted trigger.
  expect(hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store).map(e => e.turnId)).toEqual([second.id, second.id]);
});
