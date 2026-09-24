// Tickets 19b and 20a: the core task boundary. Core owns memory (frozen material, evidence
// eligibility, validation, atomic commits, progress) and, since the user's ruling of 2026-09-08, the
// host-neutral domain text as well: it builds no provider message or body, and the host receives
// structured material plus prepared text and reports what it can and cannot audit. Every test here
// names the ruling it pins.
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACTS_TITLE, RANGE_FACTS_TITLE, SOURCES_TITLE } from "../../../src/core/render/material.ts";
import { sourceSeededMemory, renderEntry, toolDefinitions, tokens, ENTRY_VIEW_VERSION,
  compacted, NOTING_INCOMPLETE, type ConsolidationAgentInput, type NotingAgentInput, type RunAgentResult , hydrate } from "../../source-fixture.ts";

let directory: string, memory: ReturnType<typeof sourceSeededMemory>;
let calls: (NotingAgentInput | ConsolidationAgentInput)[];
let runAgent: (input: NotingAgentInput | ConsolidationAgentInput) => Promise<RunAgentResult>;
const time = "2026-09-08T00:00:00Z";
const notingPrompt = loadPrompt("noting.md");

function open() {
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async raw => {
    const input = raw as NotingAgentInput | ConsolidationAgentInput;
    calls.push(input);
    return runAgent(input);
  });
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-boundary-"));
  calls = [];
  runAgent = async () => ({ outcome: "success", output: "", request: { fake: true } });
  open();
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

function session() {
  const project = memory.store.createProject({ name: "p", declaredBy: "mark" });
  return memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id }).id;
}
const turn = (sessionId: number, parentTurnId: number | null, user: string, assistant: string) =>
  memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: user, assistantText: assistant, startedAt: time });
const fact = (source: string) => ({ category: "observation", actor: "user", text: `Observed at ${source}`, source: [source] });

test.each([
  ["noting", false], ["consolidation", false], ["noting", true], ["consolidation", true],
] as const)("external abort selectively releases delayed %s claims (replaced before abort: %s)", async (phase, replaced) => {
  const own = session(), other = session();
  const ownTurn = turn(own, null, "own evidence", "reply");
  const otherTurn = turn(other, null, "other evidence", "reply");
  for (const [id, t] of [[own, ownTurn], [other, otherTurn]] as const)
    memory.tools({ kind: "manual", sessionId: id, branch: "main", currentTurnId: t.id })
      .find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] });
  let releaseOwn = () => {}, releaseOther = () => {};
  const ownGate = new Promise<void>(resolve => { releaseOwn = resolve; });
  const otherGate = new Promise<void>(resolve => { releaseOther = resolve; });
  const late: string[] = [];
  runAgent = async input => {
    await (input.sessionId === own ? ownGate : otherGate);
    if (input.sessionId === own) late.push(...input.tools.map(tool => tool.execute({})));
    return { outcome: "cancelled", output: "delayed runner settled", request: { fake: true } };
  };
  const target = { sessionId: own, branch: "main", headTurnId: ownTurn.id, mode: "subagent" as const };
  const controller = new AbortController();
  const run = phase === "noting" ? memory.noting : memory.consolidate;
  const cancelled = run({ ...target, signal: controller.signal });
  const untouched = run({ ...target, sessionId: other, headTurnId: otherTurn.id });
  const oldClaim = memory.store.getClaim(own, phase)!;
  const otherClaim = memory.store.getClaim(other, phase)!;
  const otherPhase = phase === "noting" ? "consolidation" : "noting";
  const phaseClaim = memory.store.acquireClaim(target, otherPhase, memory.executorId)!;
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
    expect(late).toEqual(Array(4).fill("rejected: run has finished"));
    // The stale task's finally must not release a new task, even under the same executor id.
    expect(memory.store.getClaim(own, phase)).toEqual(replacement);
    expect(memory.store.getClaim(own, otherPhase)).toEqual(phaseClaim);
    expect(memory.store.getClaim(other, phase)).toEqual(otherClaim);
    memory.store.releaseClaim(replacement);
    memory.store.releaseClaim(phaseClaim);
  } finally { releaseOwn(); releaseOther(); await Promise.all([cancelled, untouched]); }
});

test.each([
  ["noting", false, false], ["consolidation", false, false],
  ["noting", true, false], ["consolidation", true, false],
  ["noting", false, true], ["consolidation", false, true],
  ["noting", true, true], ["consolidation", true, true],
] as const)("external abort retries %s claim release (persistent failure: %s, already aborted: %s)", async (phase, persistent, alreadyAborted) => {
  const id = session(), t = turn(id, null, "evidence", "reply");
  if (phase === "consolidation") memory.tools({ kind: "manual", sessionId: id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] });
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
  const target = { sessionId: id, branch: "main", headTurnId: t.id, mode: "subagent" as const, signal: controller.signal };
  const attempt = phase === "noting" ? memory.noting(target) : memory.consolidate(target);
  try {
    if (!alreadyAborted) {
      expect(() => controller.abort()).not.toThrow();
      expect(calls[0]!.signal!.aborted).toBe(true);
      expect(calls[0]!.signal!.reason).toBe(controller.signal.reason);
      expect(calls[0]!.tools.map(tool => tool.execute({}))).toEqual(Array(4).fill("rejected: run has finished"));
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

test.each(["noting", "consolidation"] as const)("external abort after a %s commit preserves success", async phase => {
  const id = session(), t = turn(id, null, "evidence", "reply");
  if (phase === "consolidation") memory.tools({ kind: "manual", sessionId: id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] });
  let release = () => {};
  const held = new Promise<void>(resolve => { release = resolve; });
  runAgent = async input => {
    if (input.kind === "noting") expect(input.tools.find(tool => tool.name === "note")!.execute({ facts: [] })).toContain("committed");
    else {
      const tool = input.tools.find(tool => tool.name === "memory")!;
      const batch = { operations: [], skipped: [{ fact: "F1", because: "Not durable." }] };
      expect(tool.execute(batch)).toContain("committed");
    }
    await held;
    return { outcome: "cancelled", output: "aborted after commit", request: { fake: true } };
  };
  const controller = new AbortController();
  const target = { sessionId: id, branch: "main", headTurnId: t.id, mode: "subagent" as const, signal: controller.signal };
  const attempt = phase === "noting" ? memory.noting(target) : memory.consolidate(target);
  try {
    expect(memory.store.listRuns(id).filter(run => run.kind === phase)).toHaveLength(1); // tool commit precedes runner completion
    controller.abort();
    expect(memory.store.getClaim(id, phase)).toBeNull();
    release();
    const result = await attempt;
    expect(result.outcome).toBe("success");
    expect(memory.store.listRuns(id).find(run => run.kind === phase)!.outcome).toBe("success");
  } finally { release(); await attempt; }
});

// --------------------------------------------------- structured material and text, no provider body

/** 20a 2026-09-08 supersedes the 19b wording "no core module builds a message sequence or a provider
 * body, and no host receives composed domain text": core now owns the domain text and still builds no
 * provider message or body. `text` is allowed; a message sequence, a system slot or a body is not. */
function assertNoProviderMessage(input: NotingAgentInput | ConsolidationAgentInput) {
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
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    assertNoProviderMessage(input);
    // Everything this stub needs is a part it can place itself.
    expect(input.material.entries.map(e => e.view)).toEqual(hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store).map(e => renderEntry(e, memory.config.render).content));
    expect(input.entryAudit.viewVersion).toBe(ENTRY_VIEW_VERSION);
    expect(input.entryAudit.viewBudgets).toEqual({ entryTokens: 2_000, toolInputTokens: 100, toolResultTokens: 100 }); // the one profile (30)
    expect(input.tools.find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] })).toContain("ok: F1");
    return { outcome: "success", output: "done", audit: { available: false, reason: "this host cannot expose provider requests" } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.problems).toBeUndefined();
  expect(memory.store.listSessionFacts(sessionId).map(f => f.text)).toEqual([`Observed at T${t.id}#user`]);
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
    (raw as NotingAgentInput).tools.find(tool => tool.name === "note")!.execute({ facts: [{ ...fact(`T${t.id}#user`), category: "invalid" }] });
    return { outcome: "success", output: "done", audit: { available: false, reason: "no request available" } };
  };
  const bounced = await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect(bounced.outcome).toBe("bounced");
  if (bounced.outcome !== "bounced") throw new Error("expected a bounce");
  expect(bounced.problems.join("\n")).toContain("category");
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  // A host that claims nothing about its audit and returns no request is still an audit problem.
  runAgent = async () => ({ outcome: "success", output: "done" });
  const failed = await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" });
  expect(failed.outcome).toBe("failure");
  if (failed.outcome !== "failure") throw new Error("expected a failure");
  expect(failed.problems).toEqual(["runAgent must return the exact provider request"]);
  expect(hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store)).toHaveLength(2); // neither attempt advanced progress
});

test("19b 2026-09-08: a Consolidation stub with unavailable audit runs the two submissions and commits", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] });
  const batch = { operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] };
  runAgent = async raw => {
    const input = raw as ConsolidationAgentInput;
    assertNoProviderMessage(input);
    expect(input.material.factAddresses).toEqual(["F1"]);
    const tool = input.tools.find(t => t.name === "memory")!;
    expect(tool.execute(batch)).toContain('"committed"');
    return { outcome: "success", output: "integrated", audit: { available: false, reason: "no provider request on this host" } };
  };
  const result = await memory.consolidate({ sessionId, branch: "main", mode: "subagent" });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(memory.store.currentKnowledge(memory.store.knowledgePath(sessionId, "main")).map(k => k.revision.text)).toEqual(["The project uses pnpm"]);
  const response = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(response.audit).toEqual({ available: false, reason: "no provider request on this host" });
  expect(response.problems).toEqual([]);
});

// ---------------------------------------------------------- gate 4: budget before selection

/** Cost of everything core adds to the material of a Noting run in an empty database. */
const overhead = () => tokens(notingPrompt) + tokens(JSON.stringify(toolDefinitions));
/** 29b: what a fork pays before its material — its inherited measure and the instructions. The tool
 * definitions are not in it: a fork inherits them with the context its measure already covers. */
const forkOverhead = (prefix: number) => tokens(notingPrompt) + prefix;

test("19b 2026-09-08 gate 4: the supplied budget shrinks the batch before the only model call, and the excluded tail stays pending and unwritable", async () => {
  const sessionId = session();
  const first = turn(sessionId, null, "first " + "word ".repeat(600), "reply one");
  const second = turn(sessionId, first.id, "second " + "word ".repeat(600), "reply two");
  const views = hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store).map(e => renderEntry(e, memory.config.render).content);
  const owned = hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store).filter(e => e.turnId === first.id);
  expect(views.length).toBe(4);
  // Below the 10,000-token material ceiling, but the reported budget holds only the first Turn. The
  // slack covers what 20b charges beyond the entry views themselves: the block titles, the range line
  // and the joining separators of the fresh text core prices.
  expect(tokens(views.join("\n\n"))).toBeLessThan(10_000);
  const inputTokens = forkOverhead(50) + views.slice(0, 2).reduce((total, view) => total + tokens(view), 0) + 80;
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    expect(input.material.entries.map(e => e.id)).toEqual(owned.map(e => e.id)); // oldest first, one Turn
    expect(input.range).toEqual({ from: `S${sessionId}/T${first.id}`, to: `S${sessionId}/T${first.id}` });
    // Inherited context is not evidence permission: the excluded tail cannot be cited.
    expect(input.tools.find(tool => tool.name === "note")!.execute({ facts: [fact(`T${second.id}#user`)] })).toContain("rejected:");
    expect(input.tools.find(tool => tool.name === "note")!.execute({ facts: [fact(`T${first.id}#user`)] })).toContain("ok: F1");
    return { outcome: "success", output: "done", request: { fake: true } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: second.id, mode: "fork",
    capacity: { inputTokens, prefixTokens: 50 } });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(calls).toHaveLength(1); // one selection, one freeze, one model call
  const run = memory.store.getRun(result.runId)!;
  expect([run.rangeFrom, run.rangeTo]).toEqual([`S${sessionId}/T${first.id}`, `S${sessionId}/T${first.id}`]);
  expect(JSON.parse(run.response!).entryAudit.entries.map((e: { id: number }) => e.id)).toEqual(owned.map(e => e.id));
  expect(memory.store.listSessionFacts(sessionId).map(f => f.text)).toEqual([`Observed at T${first.id}#user`]);
  // The unselected tail is untouched: still pending, for a later permitted trigger.
  expect(hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store).map(e => e.turnId)).toEqual([second.id, second.id]);
});

test("19b 2026-09-08 gate 4: an oldest entry that does not fit the supplied budget leaves the queue pending with a capacity problem and no progress", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "first " + "word ".repeat(600), "reply one");
  const before = hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store);
  runAgent = async () => { throw new Error("no model call may happen"); };
  await expect(memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "fork",
    capacity: { inputTokens: forkOverhead(50), prefixTokens: 50 } })).rejects.toThrow(/Noting capacity: selected evidence cannot fit the model context/);
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
    input.tools.find(t => t.name === "note")!.execute({ facts: [] }); // 26a: a batch is completed by a submission
    return { outcome: "success", output: "", request: { fake: true } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" })).outcome).toBe("success");
});

// --------------------------------------------------------------- 20a scenario 1: one shared assembly

/** Ticket 20 acceptance scenario 1. This stub knows no Pi or CC message type: it reads core's
 * prepared text, runs the tool protocol of both phases, and lays nothing out itself. */
test("20a 2026-09-08 scenario 1: a host stub with no provider message types runs note and the two-submission memory protocol from core's prepared text", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  let noted = "";
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    assertNoProviderMessage(input);
    noted = input.text; // the whole task, as text: instructions stay a separate field
    expect(input.prompt).toContain("Noting (fact extraction)");
    expect(noted).toContain(input.material.entries[0]!.view);
    expect(input.tools.find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] })).toContain("ok: F1");
    return { outcome: "success", output: "done", audit: { available: false, reason: "text-only host" } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" })).outcome).toBe("success");

  const batch = { operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"] }], skipped: [] };
  let integrated = "";
  runAgent = async raw => {
    const input = raw as ConsolidationAgentInput;
    assertNoProviderMessage(input);
    integrated = input.text;
    expect(integrated).toContain(input.material.rangeFacts[0]!);
    const tool = input.tools.find(t => t.name === "memory")!;
    expect(tool.execute(batch)).toContain('"committed"');
    return { outcome: "success", output: "integrated", audit: { available: false, reason: "text-only host" } };
  };
  expect((await memory.consolidate({ sessionId, branch: "main", mode: "subagent" })).outcome).toBe("success");

  // The same knowledge block reaches the main agent: initial injection and compact share the rendering.
  const injected = memory.inject(sessionId);
  expect(injected).toContain("The project uses pnpm");
  const knowledgeBlock = injected.split("\n\nReceipts:")[0]!;
  expect(compacted(memory.compact(sessionId, "main", t.id)).startsWith(`${knowledgeBlock}\n\n<episodic>`)).toBe(true);
  // Injection is knowledge-only: sharing the material type adds no facts and no Raw to it.
  expect(injected).not.toContain(FACTS_TITLE);
  expect(injected).not.toContain("\nRaw:");
  // A later Noting task carries no knowledge at all (25a) and starts with its own first block.
  runAgent = async raw => { noted = (raw as NotingAgentInput).text; return { outcome: "success", output: "", request: { fake: true } }; };
  const next = turn(sessionId, t.id, "再来一次", "好。");
  await memory.noting({ sessionId, branch: "main", headTurnId: next.id, mode: "subagent" });
  expect(noted.startsWith(FACTS_TITLE)).toBe(true);
  expect(noted).not.toContain("<knowledge>");
  expect(integrated.startsWith(`${knowledgeBlock}\n\nRange: `)).toBe(false); // that run read no knowledge yet
});

test("20a 2026-09-08: no host file lays out the knowledge, fact, Raw or review blocks", () => {
  const titles = [FACTS_TITLE, RANGE_FACTS_TITLE, SOURCES_TITLE,
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
    ["pi/index.ts", "pi/native.ts", "pi/fork.ts", "cc/index.ts"].map(path => new URL(path, directory).href)));
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
  const inputTokens = overhead() + tokens(views.slice(0, 2).join("\n\n")) + 80;
  let sent!: NotingAgentInput;
  runAgent = async raw => {
    sent = raw as NotingAgentInput;
    expect(sent.tools.find(tool => tool.name === "note")!.execute({ facts: [fact(`T${second.id}#user`)] })).toContain("rejected:");
    expect(sent.tools.find(tool => tool.name === "note")!.execute({ facts: [fact(`T${first.id}#user`)] })).toContain("ok: F1");
    return { outcome: "success", output: "done", request: { fake: true } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: second.id, mode: "subagent",
    capacity: { inputTokens, prefixTokens: 0 } });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(calls).toHaveLength(1); // one reduction, one freeze, one model call
  // What core priced is what it sends, and it fits the window the host reported.
  expect(overhead() + tokens(sent.text)).toBeLessThanOrEqual(inputTokens);
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

// ----------------------------------------------------------------- 26a: explicit Noting completion

/** Ticket 26 "Explicit Noting completion", acceptance scenario 1, as 26a implements it. A batch is
 * completed only by a `note` call. A run that ended normally, committed nothing and had nothing
 * rejected is incomplete: the existing `failure` outcome with the explicit diagnostic, the attempt
 * and its usage recorded, and no business progress at all — the same entries are frozen again. */
test("26a scenario 1: a run that never calls note is incomplete, records its usage and advances nothing", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  const before = hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store).map(e => e.id);
  runAgent = async () => ({ outcome: "success", output: "I answered a question instead.", request: { fake: true }, usage: { tokens: 12 } });
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" });
  if (result.outcome !== "failure") throw new Error(`expected failure, got ${result.outcome}`);
  expect(result.problems).toEqual([NOTING_INCOMPLETE]);
  expect(result.incompleteHeadEntryId).toBe(before[0]); // the batch identity a host counts by
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe("failure"); // no new outcome value, no schema change
  const response = JSON.parse(run.response!);
  expect(response.usage).toEqual({ tokens: 12 }); // the available usage is kept
  expect(response.problems).toEqual([NOTING_INCOMPLETE]);
  expect(response.output).toBe("I answered a question instead."); // final prose is audit content, never facts
  // No business progress: no facts and no processed entry — and the next freeze selects the same entries.
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  expect(hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store).map(e => e.id)).toEqual(before);
  let frozen: number[] = [];
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    frozen = input.entryIds;
    input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
    return { outcome: "success", output: "", request: { fake: true } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" })).outcome).toBe("success");
  expect(frozen).toEqual(before);
});

/** Ticket 26 "Empty submission" and acceptance scenario 1: `note({facts: []})` is a valid explicit
 * submission. It commits a successful zero-fact run, marks exactly the frozen entries processed,
 * closes the batch to later `note` calls, and a provider failure after that commit keeps the success
 * and only appends the trailing problem. (29d removed this scenario's "creates no delivery" clause
 * with the delivery mechanism itself: no commit creates one now.) */
test("26a scenario 1: note({facts: []}) commits a zero-fact run, and a later provider failure keeps it", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  const before = hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store).map(e => e.id);
  let receipt = "", second = "";
  runAgent = async raw => {
    const note = (raw as NotingAgentInput).tools.find(tool => tool.name === "note")!;
    receipt = note.execute({ facts: [] });
    second = note.execute({ facts: [fact(`T${t.id}#user`)] }); // the empty submission closed the batch
    return { outcome: "failure", output: "provider exploded after the commit", request: { fake: true } };
  };
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error(`expected success, got ${result.outcome}`);
  expect(result.facts).toEqual([]);
  expect(JSON.parse(receipt)).toEqual({ results: [], factIds: [], committed: "zero facts; this batch is complete" });
  expect(second).toBe("rejected: already committed");
  expect(result.problems?.join(" ")).toContain("provider failed after commit"); // trailing problem, commit intact
  expect(memory.store.getRun(result.runId)!.outcome).toBe("success");
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", t.id), memory.store).filter(e => memory.store.entryNoted(e.id)).map(e => e.id)).toEqual(before);
  expect(hydrate(memory.pendingEntries(sessionId, "main", t.id), memory.store)).toEqual([]);
});


test.each((["noting", "consolidation"] as const).flatMap(phase =>
  (["expired", "replaced", "released"] as const).map(loss => ({ phase, loss }))))(
  "29 $phase fallback cannot revive its original $loss claim", async ({ phase, loss }) => {
  const id = session(), t = turn(id, null, "ownership evidence", "reply");
  if (phase === "consolidation") memory.tools({ kind: "manual", sessionId: id, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] });
  const peer = sourceSeededMemory(join(directory, "test.sqlite"), async () => ({ outcome: "success", output: "" }));
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  try {
    runAgent = async input => {
      const original = memory.store.getClaim(id, phase)!;
      clock.mockReturnValue(original.expiresAt + 1);
      if (loss !== "expired") {
        const replacement = peer.store.acquireClaim({ sessionId: id, branch: "main", headTurnId: t.id }, phase, peer.executorId)!;
        expect(replacement.token).not.toBe(original.token);
        if (loss === "released") expect(peer.store.releaseClaim(replacement)).toBe(true);
      }
      return { outcome: "failure", output: "context overflow", request: { sent: true },
        refused: { reason: "context overflow", cancellation: input.cancellation,
          boundary: phase === "noting" ? { exactEntryIds: (input as NotingAgentInput).entryIds }
            : { exactFactIds: (input as ConsolidationAgentInput).range.facts.map(f => f.id) } } };
    };
    const result = await (phase === "noting" ? memory.noting : memory.consolidate)({ sessionId: id, branch: "main", headTurnId: t.id, mode: "fork" });
    expect(result).toMatchObject({ outcome: "dropped", reason: "task claim lost before fallback" });
    expect(result).not.toHaveProperty("refused");
    expect(memory.store.listRuns(id).filter(run => run.mode === "fork")).toHaveLength(1);
    if (loss === "replaced") expect(memory.store.getClaim(id, phase)?.executorId).toBe(peer.executorId);
    else expect(memory.store.getClaim(id, phase)).toBeNull();
    expect(phase === "noting" ? hydrate(memory.pendingEntries(id, "main", t.id), memory.store).length : memory.store.consolidationBatch(id, "main", t.id).length).toBeGreaterThan(0);
  } finally { clock.mockRestore(); peer.close(); }
});
