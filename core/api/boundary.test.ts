// Tickets 19b and 20a: the core task boundary. Core owns memory (frozen material, evidence
// eligibility, validation, atomic commits, progress) and, since the user's ruling of 2026-09-08, the
// host-neutral domain text as well: it builds no provider message or body, and the host receives
// structured material plus prepared text and reports what it can and cannot audit. Every test here
// names the ruling it pins.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONSOLIDATED_TITLE, FACTS_TITLE, INTEGRATE_TITLE, RANGE_FACTS_TITLE, REMINDER_TITLE, SOURCES_TITLE } from "../render/material.ts";
import { TraceMemory, renderEntry, toolDefinitions, tokens,
  type ConsolidationAgentInput, type NotingAgentInput, type RunAgentResult } from "../../test/source-fixture.ts";

let directory: string, memory: ReturnType<typeof TraceMemory>;
let calls: (NotingAgentInput | ConsolidationAgentInput)[];
let runAgent: (input: NotingAgentInput | ConsolidationAgentInput) => Promise<RunAgentResult>;
const time = "2026-09-08T00:00:00Z";
const notingPrompt = readFileSync(new URL("../prompts/noting.md", import.meta.url), "utf8");

function open() {
  memory = TraceMemory(join(directory, "test.sqlite"), async raw => {
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

// --------------------------------------------------- structured material and text, no provider body

/** 20a 2026-09-08 supersedes the 19b wording "no core module builds a message sequence or a provider
 * body, and no host receives composed domain text": core now owns the domain text and still builds no
 * provider message or body. `text` is allowed; a message sequence, a system slot or a body is not. */
function assertNoProviderMessage(input: NotingAgentInput | ConsolidationAgentInput) {
  const record = input as unknown as Record<string, unknown>;
  for (const key of ["subagentInput", "messages", "system", "conversation", "body"])
    expect(key in record).toBe(false);
  expect(Array.isArray(record.input)).toBe(false); // no provider message array under any name
  expect(typeof input.text.fresh).toBe("string");
  expect(typeof input.text.inherited).toBe("string");
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
    expect(input.material.entries.map(e => e.view)).toEqual(memory.pendingEntries(sessionId, "main", t.id).map(e => renderEntry(e, memory.config.render).content));
    expect(input.entryAudit.viewVersion).toBe("17a-v1-fixed-halves");
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
  expect(memory.store.sourcePath(sessionId, "main", t.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
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
  expect(memory.pendingEntries(sessionId, "main", t.id)).toHaveLength(2); // neither attempt advanced progress
});

test("19b 2026-09-08: a Consolidation stub with unavailable audit runs the two submissions and commits", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  memory.tools({ kind: "manual", sessionId, branch: "main", currentTurnId: t.id })
    .find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] });
  const batch = { operations: [{ op: "create", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"], because: ["F1"] }], skipped: [] };
  runAgent = async raw => {
    const input = raw as ConsolidationAgentInput;
    assertNoProviderMessage(input);
    expect(input.material.factAddresses).toEqual(["F1"]);
    const tool = input.tools.find(t => t.name === "memory")!;
    const first = tool.execute(batch);
    // Core owns the two-submission protocol and reads its own receipt; the stub only relays it.
    const feedback = input.reviewFeedback(first);
    expect(feedback).toContain("NEAR:");
    input.reportRequest({ round: 2 }); // a second request the host did make: the counter is the protocol's
    expect(tool.execute(batch)).toContain('"committed"');
    return { outcome: "success", output: "integrated", audit: { available: false, reason: "no provider request on this host" } };
  };
  const result = await memory.consolidate({ sessionId, branch: "main", mode: "subagent" });
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(memory.store.listCurrentKnowledge(memory.store.knowledgePath(sessionId, "main")).map(k => k.revision.text)).toEqual(["The project uses pnpm"]);
  const response = JSON.parse(memory.store.getRun(result.runId)!.response!);
  expect(response.audit).toEqual({ available: false, reason: "no provider request on this host" });
  expect(response.problems).toEqual([]);
});

// ---------------------------------------------------------- gate 4: budget before selection

/** Cost of everything core adds to the material of a Noting run in an empty database. */
const overhead = () => tokens(notingPrompt) + tokens(JSON.stringify(toolDefinitions));

test("19b 2026-09-08 gate 4: the supplied budget shrinks the batch before the only model call, and the excluded tail stays pending and unwritable", async () => {
  const sessionId = session();
  const first = turn(sessionId, null, "first " + "word ".repeat(600), "reply one");
  const second = turn(sessionId, first.id, "second " + "word ".repeat(600), "reply two");
  const views = memory.pendingEntries(sessionId, "main", second.id).map(e => renderEntry(e, memory.config.render).content);
  const owned = memory.pendingEntries(sessionId, "main", second.id).filter(e => e.turnId === first.id);
  expect(views.length).toBe(4);
  // Below the 50,000-token material ceiling, but the reported budget holds only the first Turn.
  expect(tokens(views.join("\n\n"))).toBeLessThan(50_000);
  const inputTokens = overhead() + views.slice(0, 2).reduce((total, view) => total + tokens(view), 0) + 20;
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
  expect(memory.pendingEntries(sessionId, "main", second.id).map(e => e.turnId)).toEqual([second.id, second.id]);
});

test("19b 2026-09-08 gate 4: an oldest entry that does not fit the supplied budget leaves the queue pending with a capacity problem and no progress", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "first " + "word ".repeat(600), "reply one");
  const before = memory.pendingEntries(sessionId, "main", t.id);
  runAgent = async () => { throw new Error("no model call may happen"); };
  await expect(memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "fork",
    capacity: { inputTokens: overhead(), prefixTokens: 50 } })).rejects.toThrow("oldest entry cannot fit");
  expect(calls).toEqual([]);
  expect(memory.store.listRuns(sessionId)).toEqual([]);
  expect(memory.pendingEntries(sessionId, "main", t.id)).toEqual(before);
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
});

test("19b 2026-09-08: the frozen material carries the whole batch, and core's fresh text is what a fresh-context run sends", async () => {
  const sessionId = session();
  const t = turn(sessionId, null, "用 pnpm", "好的。");
  runAgent = async raw => {
    const input = raw as NotingAgentInput;
    expect(input.text.fresh).toContain("用 pnpm");
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
    noted = input.text.fresh; // the whole task, as text: instructions stay a separate field
    expect(input.prompt).toContain("Noting (fact extraction)");
    expect(noted).toContain(input.material.entries[0]!.view);
    expect(input.tools.find(tool => tool.name === "note")!.execute({ facts: [fact(`T${t.id}#user`)] })).toContain("ok: F1");
    return { outcome: "success", output: "done", audit: { available: false, reason: "text-only host" } };
  };
  expect((await memory.noting({ sessionId, branch: "main", headTurnId: t.id, mode: "subagent" })).outcome).toBe("success");

  const batch = { operations: [{ op: "create", text: "The project uses pnpm", category: "constraint", scope: "project", supports: ["F1"], because: ["F1"] }], skipped: [] };
  let integrated = "";
  runAgent = async raw => {
    const input = raw as ConsolidationAgentInput;
    assertNoProviderMessage(input);
    integrated = input.text.fresh;
    expect(integrated).toContain(input.material.rangeFacts[0]!);
    const tool = input.tools.find(t => t.name === "memory")!;
    // Two submissions: core's review guidance is text this stub relays, not a provider message.
    expect(input.reviewFeedback(tool.execute(batch))).toContain("NEAR:");
    input.reportRequest({ round: 2 });
    expect(tool.execute(batch)).toContain('"committed"');
    return { outcome: "success", output: "integrated", audit: { available: false, reason: "text-only host" } };
  };
  expect((await memory.consolidate({ sessionId, branch: "main", mode: "subagent" })).outcome).toBe("success");

  // The same knowledge block reaches the main agent: initial injection and compact share the rendering.
  const injected = memory.inject(sessionId);
  expect(injected).toContain("The project uses pnpm");
  const knowledgeBlock = injected.split("\n\nReceipts:")[0]!;
  expect(memory.compact(sessionId, "main", t.id).startsWith(`${knowledgeBlock}\n\n<episodic>`)).toBe(true);
  // Injection is knowledge-only: sharing the material type adds no facts and no Raw to it.
  expect(injected).not.toContain(FACTS_TITLE);
  expect(injected).not.toContain("\nRaw:");
  // A later Noting task starts with that identical block, before anything task-specific.
  runAgent = async raw => { noted = (raw as NotingAgentInput).text.fresh; return { outcome: "success", output: "", request: { fake: true } }; };
  const next = turn(sessionId, t.id, "再来一次", "好。");
  await memory.noting({ sessionId, branch: "main", headTurnId: next.id, mode: "subagent" });
  expect(noted.startsWith(`${knowledgeBlock}\n\n${FACTS_TITLE}`)).toBe(true);
  expect(integrated.startsWith(`${knowledgeBlock}\n\n${CONSOLIDATED_TITLE}`)).toBe(false); // that run read no knowledge yet
});

test("20a 2026-09-08: no host file lays out the knowledge, fact, Raw or review blocks", () => {
  const titles = [FACTS_TITLE, CONSOLIDATED_TITLE, RANGE_FACTS_TITLE, SOURCES_TITLE, INTEGRATE_TITLE, REMINDER_TITLE,
    "<knowledge>", "Range: ${"];
  const directory = new URL("../../hosts/", import.meta.url);
  const files: URL[] = [];
  for (const host of readdirSync(directory, { withFileTypes: true })) {
    if (!host.isDirectory()) continue;
    for (const file of readdirSync(new URL(`${host.name}/`, directory)))
      if (file.endsWith(".ts") && !file.endsWith(".test.ts")) files.push(new URL(`${host.name}/${file}`, directory));
  }
  expect(files.length).toBeGreaterThan(5);
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const title of titles) expect([file.pathname, source.includes(title)]).toEqual([file.pathname, false]);
  }
});
