import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, type SettleAgentInput, type RunAgentResult, type ConfigOverride } from "./index";
import memories from "./fixtures/note/facts.json";

let directory: string, memory: ReturnType<typeof TraceMemory>, sessionId: number, projectId: number;
let calls: SettleAgentInput[], script: ((input: SettleAgentInput) => Promise<RunAgentResult>)[];
const time = "2026-08-16 02:54";
const empty = { new: [], edit: [], merge: [], delete: [], not_admitted: [], near_ack: [], over_budget: false };
const success = (output: unknown, input: SettleAgentInput): RunAgentResult => ({ outcome: "success", output: JSON.stringify(output === empty ? { ...empty, not_admitted: input.range.facts.map((f) => ({ id: `F${f.id}`, because: "Not retained in this test." })) } : output),
  usage: { tokens: 12 }, request: { system: input.prompt, messages: [
    ...((input.continuation?.request as { messages: unknown[] } | undefined)?.messages ?? []),
    ...(input.continuation ? [{ role: "assistant", content: input.continuation.response.output }] : []),
    { role: "user", content: input.input },
  ], tools: [], hostField: input.round } });
function open(config: ConfigOverride = {}) {
  memory = TraceMemory(join(directory, "test.sqlite"), async (raw) => {
    const input = raw as SettleAgentInput; calls.push(input);
    const next = script.shift(); if (!next) throw new Error("unexpected call");
    return next(input);
  }, config);
}
const session = (project = projectId) => memory.store.createSession({ host: "fake", startedAt: time, firstReplyAt: time, projectId: project }).id;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-settle-")); calls = []; script = []; open();
  projectId = memory.store.createProject({ name: "fixture", declaredBy: "mark" }).id; sessionId = session();
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
function fact(text = memories.base, options: { sessionId?: number; branch?: string; source?: string[]; createdAt?: string; actor?: "user" | "agent"; category?: "observation" | "question"; quote?: string; negate?: { target: string; strength: "strong" | "weak" }[] } = {}) {
  const owner = options.sessionId ?? sessionId, branch = options.branch ?? "main";
  const turn = memory.store.appendTurn({ sessionId: owner, parentTurnId: memory.store.getWatermark(owner, branch)?.lastNotedTurn ?? undefined, kind: "turn", userPrompt: text, assistantText: text, startedAt: time });
  const result = memory.store.commitNoteRun({ run: { kind: "note", sessionId: owner, branch, createdAt: time }, watermark: { sessionId: owner, branch, lastNotedTurn: turn.id }, facts: [{ turnId: turn.id,
    category: options.category ?? "observation", actor: options.actor ?? "user", quote: options.quote, text, source: options.source ?? [`T${turn.id}#user`], createdAt: options.createdAt ?? time, negate: options.negate }] });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.facts[0]!.id;
}
function entry(supports: number[], options: { sessionId?: number; text?: string; category?: "constraint" | "open" | "dispute" | "goal" | "mechanism" | "term" | "reference"; scope?: "session" | "project" | "global" } = {}) {
  const result = memory.store.commitSettleRun({ run: { kind: "settle", sessionId: options.sessionId ?? sessionId, createdAt: time }, operations: [{
    op: "new", handle: "$e1", author: "fake", text: options.text ?? memories.entry, supports, createdAt: time,
    category: options.category ?? "mechanism", scope: options.scope ?? "project",
  }] });
  if (!result.ok || result.rejected.length) throw new Error("fixture entry failed");
  return result.committed[0]!.entryId;
}
function watermark(id: number, branch = "main") {
  const result = memory.store.commitSettleRun({ run: { kind: "settle", sessionId, branch, createdAt: time }, operations: [],
    watermark: { sessionId, branch, lastSettledFact: id } });
  expect(result.ok).toBe(true);
}
const newOutput = (support: number, text = memories.entry) => ({ ...empty, new: [{ handle: "$e1", text, category: "mechanism" as const, scope: "project" as const, supports: [`F${support}`] }] });
const settle = (branch = "main") => memory.settle({ sessionId, branch });
function queue(...outputs: unknown[]) { for (const output of outputs) script.push(async (input) => success(output, input)); }
function deferred() {
  let resolve!: (output: unknown) => void;
  const promise = new Promise<unknown>((r) => { resolve = r; });
  script.push(async (input) => success(await promise, input)); return resolve;
}
function audit(runId: number, callIndex: number, outcome: "success" | "failure" | "cancelled" = "success") {
  const run = memory.store.getRun(runId)!;
  expect(run.outcome).toBe(outcome);
  expect(JSON.parse(run.request!)).toEqual(success({}, calls[callIndex]!).request);
  expect(run.promptHash).toBe(createHash("sha256").update(calls[callIndex]!.prompt).digest("hex"));
  expect(JSON.parse(run.response!).readEntryRevisions).toEqual(calls[callIndex]!.readEntryRevisions);
  return JSON.parse(run.response!);
}

test("freezes session branch range, read revisions, relations and guidance through both calls and commits only the frozen range", async () => {
  const old = fact(), e = entry([old], { category: "open" }); watermark(old);
  const current = fact(memories.entry);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.observation, { sessionId: session(foreignProject) });
  const before = memory.trace(`E${e}`), resolve = deferred(), selection = { sessionId, branch: "main", model: "fake-model", mode: "branch" as const };
  const pending = memory.settle(selection);
  selection.branch = "switched";
  const late = fact(memories.observation, { negate: [{ target: `F${current}`, strength: "strong" }] });
  const update = memory.store.commitSettleRun({ run: { kind: "settle", sessionId, createdAt: time }, operations: [{ op: "edit", entryId: e,
    expectedRevision: 1, text: memories.editedEntry, category: "open", scope: "project", supports: [late], because: [late], createdAt: time }] });
  expect(update.ok).toBe(true);
  const moved = memory.trace(`E${e}`); expect(moved).not.toBe(before);
  entry([late]);
  queue(newOutput(current)); resolve(newOutput(current)); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range).toEqual({ from: `F${current}`, to: `F${current}`, facts: [memory.store.getFact(current)!] });
  expect(result.readEntryRevisions).toEqual([{ entryId: e, rev: 1 }]);
  for (const call of calls) {
    expect(call.branch).toBe("main"); expect(call.model).toBe("fake-model"); expect(call.mode).toBe("branch");
    expect(call.input).not.toContain(`[F${late}]`); expect(call.input).not.toContain(`[F${foreign}]`);
    expect(call.input).not.toContain(`inbound negate F${late}`); expect(call.input).not.toContain(`[E${e}@2]`);
  }
  expect(calls[1]!.input).toContain(`[E${e}@1]`);
  expect(audit(result.candidateRunId, 0).round).toBe("candidate"); expect(audit(result.runId, 1).round).toBe("final");
  expect(memory.trace(`E${e}`)).toBe(moved);
  expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBe(current);
  expect(memory.store.listPendingDeliveries(sessionId, "main")).toEqual([]);
});

test("reminder lists every visible supporting entry for both strengths and ignores lexical distance and budgets", async () => {
  const cited = fact(), unrelatedFact = fact(memories.observation), other = session();
  const ids = [entry([cited]), entry([cited], { text: memories.observation }), entry([cited], { scope: "session" }),
    entry([cited], { scope: "global", sessionId: other })];
  const excluded = [entry([unrelatedFact]), entry([cited], { scope: "session", sessionId: other })];
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreignSession = session(foreignProject);
  excluded.push(entry([cited], { sessionId: foreignSession }));
  ids.push(entry([cited], { scope: "global", sessionId: foreignSession }));
  const archived = entry([cited]);
  memory.store.commitSettleRun({ run: { kind: "settle", sessionId, createdAt: time }, operations: [{ op: "archive", entryId: archived,
    expectedRevision: 1, because: [unrelatedFact], createdAt: time }] }); excluded.push(archived);
  watermark(unrelatedFact);
  const strong = fact(memories.observation, { negate: [{ target: `F${cited}`, strength: "strong" }] });
  const weak = fact(memories.interpretation, { negate: [{ target: `F${cited}`, strength: "weak" }] });
  memory.close(); open({ render: { entriesBlockTokens: 0, episodicBlockTokens: 0 }, settle: { nearThreshold: 1 } });
  const traces = ids.map((id) => memory.trace(`E${id}`)); queue(empty, empty);
  expect((await settle()).outcome).toBe("success");
  const reminder = calls[0]!.input.split("Negated-evidence reminder (review cues only; no status derived):\n\n")[1]!.split("\n\nReceipts:")[0]!;
  for (const id of ids) expect(reminder.match(new RegExp(`\\[E${id}@1\\]`, "g"))).toHaveLength(2);
  for (const id of excluded) expect(reminder).not.toContain(`[E${id}@`);
  expect(reminder.match(/Recorded negation strength: strong/g)).toHaveLength(ids.length);
  expect(reminder.match(/Recorded negation strength: weak/g)).toHaveLength(ids.length);
  for (const id of [cited, strong, weak]) expect(reminder).toContain(memory.trace(`F${id}`));
  expect(calls[0]!.input).toContain("range overage:");
  expect(ids.map((id) => memory.trace(`E${id}`))).toEqual(traces);
});

test("feedback contains NEAR, CLOSER, an exact checklist section and continuation of the candidate request and response", async () => {
  const f = fact(memories.entry), e = entry([f], { category: "open" }), goal = entry([f], { category: "goal" });
  const candidate = newOutput(f); queue(candidate, candidate);
  const result = await settle(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.output).toEqual(candidate);
  expect(result.unansweredNear).toEqual([{ candidate: "$e1", entry: `E${e}`, score: 1 }, { candidate: "$e1", entry: `E${goal}`, score: 1 }]);
  expect(calls[0]!.input).not.toContain("NEAR:"); expect(calls[0]!.input).not.toContain("CLOSER:");
  expect(calls[0]!.continuation).toBeUndefined();
  const second = calls[1]!, firstResponse = success(candidate, calls[0]!);
  expect(second.continuation).toEqual({ request: firstResponse.request, response: firstResponse, message: { role: "user", content: second.input } });
  expect(second.input).toContain("NEAR:"); expect(second.input).toContain("CLOSER:");
  expect(second.input).toContain("System-generated review guidance; not a human ruling or adoption evidence.");
  const prompt = readFileSync(new URL("../prompts/settle.md", import.meta.url), "utf8");
  const section = prompt.split("### Second-round user message\n")[1]!.split("\n### ")[0]!;
  expect(second.input.endsWith(section)).toBe(true);
  expect(second.input.split(section)).toHaveLength(2);
  const closer = second.input.split("CLOSER:\n\n")[1]!.split(section)[0]!;
  expect(closer).toContain(`[E${e}@1]`); expect(closer).toContain(`[E${goal}@1]`); expect(closer).toContain(memory.trace(`F${f}`));
  expect(calls[0]!.mode).toBe("subagent"); expect(calls[0]!.model).toBe("session");
  audit(result.candidateRunId, 0); audit(result.runId, 1);
});

for (const resolution of ["edit", "merge", "ack", "withdraw", "wrong ack", "archive"] as const) test(`corrected final output: ${resolution}`, async () => {
  const f = fact(), e = entry([f]), absorbed = entry([f], { text: memories.observation });
  const candidate = newOutput(f), final = { ...candidate };
  let output: unknown = final;
  const operation = { id: `E${e}`, text: memories.entry, category: "mechanism", scope: "project", supports: [`F${f}`], because: [`F${f}`] };
  if (resolution === "edit") output = { ...final, edit: [operation] };
  if (resolution === "merge") output = { ...final, merge: [{ ...operation, into: `E${e}`, absorb: [`E${absorbed}`] }] };
  if (resolution === "ack" || resolution === "wrong ack") output = { ...final, near_ack: [{ candidate: resolution === "ack" ? "$e1" : "$e2", entry: `E${e}`, because: memories.interpretation }] };
  if (resolution === "withdraw") output = empty;
  if (resolution === "archive") output = { ...final, delete: [{ id: `E${e}`, because: [`F${f}`] }] };
  const before = memory.trace(`E${e}`); queue(candidate, output);
  const result = await settle(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.unansweredNear).toHaveLength(resolution === "wrong ack" || resolution === "archive" ? 1 : 0);
  expect(memory.store.getEntry(e)?.currentRevision).toBe(["edit", "merge", "archive"].includes(resolution) ? 2 : 1);
  expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBe(f);
  expect(calls).toHaveLength(2);
});

test("NEAR covers new, edit and merge text, excludes each target, and uses threshold on character bigram sets", async () => {
  const f = fact(), a = entry([f]), b = entry([f]), c = entry([f], { text: memories.observation });
  const op = { text: memories.entry, scope: "project", category: "mechanism", supports: [`F${f}`], because: [] };
  const output = { ...newOutput(f), edit: [{ ...op, id: `E${a}` }], merge: [{ ...op, into: `E${b}`, absorb: [`E${c}`] }] };
  queue(output, output); const result = await settle(); if (result.outcome !== "success") throw new Error("expected success");
  const feedback = calls[1]!.input.split("CLOSER:")[0]!;
  expect(feedback).toContain(`$e1 -> E${a} (Jaccard 1)`); expect(feedback).toContain(`$e1 -> E${b} (Jaccard 1)`);
  expect(feedback).toContain(`E${a} -> E${b} (Jaccard 1)`); expect(feedback).toContain(`E${b} -> E${a} (Jaccard 1)`);
  expect(feedback).not.toContain(`E${a} -> E${a}`); expect(feedback).not.toContain(`E${b} -> E${b}`);
  expect(feedback).not.toContain(`-> E${c}`);
  memory.close(); open({ settle: { nearThreshold: 1, subagentModeDefault: false } });
  fact(); queue(newOutput(f, memories.base), empty); await settle();
  expect(calls[3]!.input).toContain("NEAR:\n\nnone"); expect(calls[2]!.mode).toBe("branch");
});

for (const round of ["candidate", "final"] as const) for (const bad of ["json", "shape", "failure", "cancelled", "missing request", "throw", "abort"] as const) {
  test(`${round} ${bad} records the exact attempt, returns problems and releases deduplication`, async () => {
    fact(); if (round === "final") queue(empty);
    script.push(async (input) => {
      if (bad === "throw" || bad === "abort") { const error = new Error("stopped"); error.name = bad === "abort" ? "AbortError" : "Error"; throw error; }
      if (bad === "failure" || bad === "cancelled") return { ...success(empty, input), outcome: bad, output: "stopped" };
      if (bad === "missing request") return { outcome: "success", output: "{}" };
      return { ...success(empty, input), output: bad === "json" ? "{" : JSON.stringify({ new: [{ handle: "$e1", category: "invalid" }] }) };
    });
    const result = await settle();
    if (!("problems" in result)) throw new Error("expected failure");
    const expected = bad === "json" || bad === "shape" ? "bounced" : bad === "cancelled" || bad === "abort" ? "cancelled" : "failure";
    expect(result.outcome).toBe(expected); expect(result.problems.length).toBeGreaterThan(0);
    if (bad === "json") expect(result.problems.join("\n")).toContain("invalid JSON");
    if (bad === "shape") expect(result.problems.join("\n")).toContain("new[0].category");
    const run = memory.store.getRun(result.runId)!;
    expect(run.outcome).toBe(expected === "bounced" ? "failure" : expected);
    expect(JSON.parse(run.response!).problems).toEqual(result.problems);
    if (["throw", "abort", "missing request"].includes(bad)) expect(run.request).toBeNull();
    else audit(result.runId, round === "final" ? 1 : 0, run.outcome);
    if (round === "final") audit(result.runId - 1, 0);
    expect(memory.store.getRun(result.runId + 1)).toBeNull();
    expect(calls).toHaveLength(round === "final" ? 2 : 1);
    expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBeNull();
    queue(empty, empty); expect((await settle()).outcome).toBe("success");
  });
}

test("duplicate trigger is dropped across facades during either round; different branches and sessions of the project remain independent", async () => {
  fact(); const resolveFirst = deferred(), pending = settle();
  const other = TraceMemory(join(directory, "test.sqlite"), async () => { throw new Error("must not call"); });
  try {
    expect(await other.settle({ sessionId, branch: "main" })).toEqual({ outcome: "dropped" });
    expect(await settle("other")).toEqual({ outcome: "empty" });
    expect(await memory.settle({ sessionId: session(), branch: "main" })).toEqual({ outcome: "empty" });
    const resolveFinal = deferred(); resolveFirst(empty);
    // Let the candidate record and final model call finish entering the deferred seam.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.at(-1)!.round).toBe("final");
    expect(await settle()).toEqual({ outcome: "dropped" });
    resolveFinal(empty); expect((await pending).outcome).toBe("success");
    expect(calls).toHaveLength(2);
  } finally { other.close(); }
});

test("empty ranges do not call the agent or create records", async () => {
  expect(await settle()).toEqual({ outcome: "empty" }); expect(memory.store.getRun(1)).toBeNull();
  const f = fact(); watermark(f); expect(await settle()).toEqual({ outcome: "empty" });
  expect(memory.store.getRun(3)).toBeNull(); expect(calls).toEqual([]);
});

test("context uses timestamp freshness while range remains complete and categories follow note budgets", async () => {
  const newest = fact(memories.base, { createdAt: "2026-08-17" }), oldest = fact(memories.observation, { createdAt: "2026-08-15" });
  const categories = ["constraint", "open", "dispute", "goal", "mechanism", "term", "reference"] as const;
  for (const category of categories) entry([newest], { category });
  watermark(oldest); const current = fact(memories.interpretation);
  queue(empty, empty); await settle();
  const input = calls[0]!.input;
  expect(input.indexOf(`[F${newest}]`)).toBeLessThan(input.indexOf(`[F${oldest}]`));
  for (let i = 1; i < categories.length; i++) expect(input.indexOf(`[${categories[i - 1]}/project]`)).toBeLessThan(input.indexOf(`[${categories[i]}/project]`));
  memory.close(); open({ render: { entriesBlockTokens: 0, episodicBlockTokens: 0 } });
  const next = fact(memories.interpretation);
  queue(empty, empty); await settle(); const small = calls[2]!.input;
  expect(small).toContain(memory.trace(`F${next}`));
  expect(small).not.toContain(`[F${newest}]`); expect(small).not.toContain(`[F${oldest}]`);
  expect(small).toContain("omitted 3 older facts");
  for (const category of categories.slice(0, 3)) expect(small).toContain(`[${category}/project]`);
  for (const category of categories.slice(3)) { expect(small).not.toContain(`[${category}/project]`); expect(small).toContain(`omitted 1 ${category} entries`); }
  expect(calls[2]!.readEntryRevisions).toHaveLength(7);
});

test("bigram Jaccard has a known nontrivial score and an inclusive configurable threshold", async () => {
  const f = fact(), e = entry([f]);
  // The two fixture strings share eight bigrams; their union has twelve.
  // The longer fact inserts three bigrams and replaces one shared boundary.
  memory.close(); open({ settle: { nearThreshold: 2 / 3 } });
  queue(newOutput(f, memories.base), newOutput(f, memories.base));
  const result = await settle(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.unansweredNear).toEqual([{ candidate: "$e1", entry: `E${e}`, score: 2 / 3 }]);
  memory.close(); open({ settle: { nearThreshold: 2 / 3 + 0.001 } });
  fact(); queue(newOutput(f, memories.base), empty); await settle();
  expect(calls[3]!.input).not.toContain(`-> E${e} (`);
});

const editOutput = (id: number, support: number) => ({ ...empty, edit: [{ id: `E${id}`, text: memories.editedEntry,
  category: "mechanism", scope: "project", supports: [`F${support}`], because: [`F${support}`] }] });
const decline = (...ids: number[]) => ids.map((id) => ({ id: `F${id}`, because: "Not durable." }));

test("accounting bounces for user facts and agent questions, then accepts explicit not_admitted", async () => {
  const user = fact(), question = fact(memories.base, { actor: "agent", category: "question" });
  fact(memories.observation, { actor: "agent" });
  const output = { ...empty }; queue(output, output);
  const result = await settle();
  expect(result.outcome).toBe("bounced");
  if (result.outcome !== "bounced") throw new Error("expected bounce");
  expect(result.problems).toEqual([`uncited facts: F${user}, F${question}`]);
  expect(audit(result.runId, 1, "failure").problems).toEqual(result.problems);
  expect(memory.store.listVisibleEntries(sessionId, projectId)).toEqual([]);
  expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBeNull();
  queue(output, { ...output, not_admitted: decline(user, question) });
  expect((await settle()).outcome).toBe("success");
});

for (const operation of ["edit", "delete", "merge"] as const) test(`accounting evaluates supports after ${operation}`, async () => {
  const f = fact(), other = fact(memories.observation, { actor: "agent" }), e = entry([f]), survivor = entry([other]);
  const output = operation === "edit" ? editOutput(e, other) : operation === "delete"
    ? { ...empty, delete: [{ id: `E${e}`, because: [`F${other}`] }] }
    : { ...empty, merge: [{ ...editOutput(survivor, other).edit[0], into: `E${survivor}`, absorb: [`E${e}`] }] };
  queue(output, output); const result = await settle();
  expect(result.outcome).toBe("bounced");
  if (result.outcome !== "bounced") throw new Error("expected bounce");
  expect(result.problems).toContain(`uncited facts: F${f}`);
  expect(memory.store.getEntry(e)?.currentRevision).toBe(1);
  queue(output, { ...output, not_admitted: decline(f) });
  const accepted = await settle(); expect(accepted.outcome).toBe("success");
  expect(memory.store.getEntry(e)?.status).toBe(operation === "delete" ? "archived" : operation === "merge" ? "merged" : "active");
});

test("a conflict rejects only its operation and records actual lost citations with the watermark", async () => {
  const old = fact(), e = entry([old]); watermark(old);
  const lost = fact(), kept = fact(memories.observation);
  const output = { ...newOutput(kept), edit: editOutput(e, lost).edit };
  queue(output); const resolve = deferred(), pending = settle();
  await new Promise((r) => setTimeout(r, 0));
  memory.store.commitSettleRun({ run: { kind: "settle", sessionId, createdAt: time }, operations: [{ op: "edit", entryId: e,
    expectedRevision: 1, text: memories.base, category: "mechanism", scope: "project", supports: [old], because: [], createdAt: time }] });
  resolve(output); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toEqual([{ op: "new", handle: "$e1", entryId: e + 1, rev: 1 }]);
  expect(result.rejected).toHaveLength(1);
  expect(result.rejected[0]!.reason).toContain("expected revision 1, current revision is 2");
  expect(result.diagnostics).toContainEqual({ kind: "lost_citations", facts: [`F${lost}`] });
  const response = audit(result.runId, 1);
  expect(response.diagnostics).toEqual(result.diagnostics); expect(response.rejected).toEqual(result.rejected);
  expect(response.committed).toEqual(result.committed);
  expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBe(kept);
  expect(memory.store.getEntryRevision(e + 1, 1)?.runId).toBe(result.runId);
  expect(memory.trace(`F${lost}`)).toContain(memories.base);
});

test("merge records survivor revision, absorbed links, and trace history", async () => {
  const a = fact(), b = fact(memories.observation), survivor = entry([a]), absorbed = entry([b]);
  const output = { ...empty, merge: [{ into: `E${survivor}`, absorb: [`E${absorbed}`], text: memories.editedEntry,
    category: "mechanism", scope: "project", supports: [`F${a}`, `F${b}`], because: [`F${b}`] }] };
  queue(output, output); const result = await settle();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toEqual([{ op: "merge", entryId: survivor, rev: 2 }]);
  expect(memory.store.listEntryLinks(absorbed)).toEqual([{ fromEntry: absorbed, fromRev: 1, kind: "merged_into", toEntry: survivor, toRev: 2 }]);
  expect(memory.trace(`E${absorbed}`)).toContain(`E${survivor}@2`);
  expect(memory.trace(`E${survivor}`)).toContain("merge");
  expect(memory.trace(`E${survivor}@1..2`)).toContain(`F${b}`);
  expect(memory.store.getEntryRevision(survivor, 2)?.because).toEqual([b]);
});

test("numbers, token overage and unanswered NEAR are diagnostics, never gates", async () => {
  const f = fact("Measured 12 samples.", { quote: "Confirmed 42." }); entry([f], { text: "Measured 12 samples." });
  const output = newOutput(f, "Measured 12 samples. 42 2 999 " + "x".repeat(801));
  queue(newOutput(f, "Measured 12 samples."), output); const result = await settle();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toHaveLength(1); expect(result.rejected).toEqual([]);
  expect(result.diagnostics).toContainEqual({ kind: "unsupported_numbers", entry: "$e1", numbers: ["2", "999"] });
  expect(result.diagnostics).toContainEqual({ kind: "over_200_tokens", entry: "$e1", tokens: Math.ceil(output.new[0]!.text.length / 4) });
  expect(result.diagnostics).toContainEqual({ kind: "unanswered_near", pairs: result.unansweredNear });
  expect(audit(result.runId, 1).diagnostics).toEqual(result.diagnostics);
});

for (const bad of ["missing fact", "foreign fact", "late fact", "unread entry", "duplicate handle", "duplicate target", "empty merge"] as const) test(`resolution bounces: ${bad}`, async () => {
  const f = fact(), e = entry([f]);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.base, { sessionId: session(foreignProject) });
  queue(newOutput(f)); const resolve = deferred(), pending = settle();
  await new Promise((r) => setTimeout(r, 0));
  const late = fact(), unread = entry([late]);
  const output = bad === "unread entry" ? editOutput(unread, f)
    : bad === "duplicate target" ? { ...editOutput(e, f), delete: [{ id: `E${e}`, because: [] }] }
    : bad === "empty merge" ? { ...empty, merge: [{ ...editOutput(e, f).edit[0], into: `E${e}`, absorb: [] }] }
    : bad === "duplicate handle" ? { ...newOutput(f), new: [...newOutput(f).new, ...newOutput(f).new] }
    : newOutput(bad === "missing fact" ? 999999 : bad === "foreign fact" ? foreign : late);
  resolve(output); const result = await pending;
  expect(result.outcome).toBe("bounced");
  expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBeNull();
  expect(memory.store.getEntry(e)?.currentRevision).toBe(1);
});

test("each session settles only its own branch facts and shares already-settled context", async () => {
  const first = fact(), secondSession = session();
  const second = fact(memories.observation, { sessionId: secondSession, branch: "fork" });
  queue(newOutput(second), newOutput(second));
  const other = await memory.settle({ sessionId: secondSession, branch: "fork" });
  if (other.outcome !== "success") throw new Error("expected success");
  expect(other.range.facts.map((f) => f.id)).toEqual([second]);
  expect(calls[0]!.input).not.toContain(`[F${first}]`);
  queue(newOutput(first), newOutput(first));
  const result = await settle();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range.facts.map((f) => f.id)).toEqual([first]);
  expect(calls[2]!.input).toContain(memory.trace(`F${second}`));
  expect(memory.store.getWatermark(secondSession, "fork")?.lastSettledFact).toBe(second);
  expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBe(first);
  expect(await settle()).toEqual({ outcome: "empty" });
  const fork = fact(memories.interpretation, { branch: "fork" });
  expect(await settle()).toEqual({ outcome: "empty" });
  queue(newOutput(fork), newOutput(fork));
  const forkResult = await settle("fork");
  if (forkResult.outcome !== "success") throw new Error("expected success");
  expect(forkResult.range.facts.map((f) => f.id)).toEqual([fork]);
});

test("settlement revisions and success record roll back if watermark writing fails", async () => {
  const f = fact(), output = newOutput(f); queue(output, output);
  const original = memory.store.setWatermark;
  memory.store.setWatermark = () => { throw new Error("watermark write failed"); };
  try {
    const result = await settle(); expect(result.outcome).toBe("failure");
    expect(memory.store.listVisibleEntries(sessionId, projectId)).toEqual([]);
    expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBeNull();
    if (result.outcome !== "failure") throw new Error("expected failure");
    expect(memory.store.getRun(result.runId)?.outcome).toBe("failure");
    expect(JSON.parse(memory.store.getRun(result.runId)!.response!).problems).toEqual(result.problems);
  } finally { memory.store.setWatermark = original; }
});

test("simulation v7m fixture settles through the facade with traceable Chinese evidence", async () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/settle.json", import.meta.url), "utf8"));
  const ids = new Map<number, number>();
  for (const source of fixture.facts) ids.set(source.id, fact(source.text, { actor: source.actor, category: source.category, quote: source.quote, source: source.source, createdAt: source.timestamp }));
  const output = { ...empty, new: [{ ...fixture.entry, supports: fixture.entry.supports.map((id: string) => `F${ids.get(Number(id.slice(1)))}`) }] };
  queue(output, output); const result = await settle();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toHaveLength(1);
  expect(memory.trace(`E${result.committed[0]!.entryId}`)).toContain(fixture.entry.text);
  for (const source of fixture.facts) expect(memory.trace(`F${ids.get(source.id)}`)).toContain(source.text);
});

test("conflict diagnostics exclude citations retained by another committed entry", async () => {
  const old = fact(), e = entry([old]); watermark(old); const f = fact();
  const output = { ...newOutput(f), edit: editOutput(e, f).edit };
  queue(output); const resolve = deferred(), pending = settle();
  await new Promise((r) => setTimeout(r, 0));
  memory.store.commitSettleRun({ run: { kind: "settle", sessionId, createdAt: time }, operations: [{ op: "archive", entryId: e,
    expectedRevision: 1, because: [old], createdAt: time }] });
  resolve(output); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.rejected).toHaveLength(1);
  expect(result.diagnostics.some((d) => d.kind === "lost_citations")).toBe(false);
});

test("because addresses are resolved but do not satisfy accounting", async () => {
  const f = fact(), other = fact(memories.observation, { actor: "agent" }), e = entry([other]);
  const output = { ...empty, edit: [{ ...editOutput(e, other).edit[0], because: [`F${f}`] }] };
  queue(output, output); expect((await settle()).outcome).toBe("bounced");
  queue(output, { ...output, not_admitted: decline(f), edit: [{ ...output.edit[0], because: ["F999999"] }] });
  const bad = await settle();
  if (bad.outcome !== "bounced") throw new Error("expected bounce");
  expect(bad.problems.join(" ")).toContain("F999999");
});

test("a different project can settle while this project is in flight", async () => {
  const f = fact(), resolve = deferred(), pending = settle();
  const project = memory.store.createProject({ name: "independent", declaredBy: "mark" }).id, owner = session(project);
  const other = fact(memories.observation, { sessionId: owner });
  queue(newOutput(other), newOutput(other));
  expect((await memory.settle({ sessionId: owner, branch: "main" })).outcome).toBe("success");
  queue(newOutput(f)); resolve(newOutput(f)); expect((await pending).outcome).toBe("success");
});

test("exactly 200 estimated tokens is accepted without a length diagnostic", async () => {
  const f = fact(), output = newOutput(f, "x".repeat(800)); queue(output, output);
  const result = await settle(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.diagnostics).toEqual([]);
});

test("narrowing another session's global entry cannot conceal an uncited fact", async () => {
  const f = fact(), e = entry([f], { scope: "global", sessionId: session() });
  const output = { ...empty, edit: [{ ...editOutput(e, f).edit[0], scope: "session" }] };
  queue(output, output); const result = await settle();
  if (result.outcome !== "bounced") throw new Error("expected bounce");
  expect(result.problems).toContain(`uncited facts: F${f}`);
});


test("same-project sessions commit independently while another session is pending", async () => {
  const first = fact(), otherSession = session();
  const second = fact(memories.observation, { sessionId: otherSession });
  const resolve = deferred(), pending = settle();
  queue(newOutput(second), newOutput(second));
  const other = await memory.settle({ sessionId: otherSession, branch: "main" });
  if (other.outcome !== "success") throw new Error("expected success");
  expect(other.range.facts.map((f) => f.id)).toEqual([second]);
  queue(newOutput(first)); resolve(newOutput(first));
  const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range.facts.map((f) => f.id)).toEqual([first]);
  expect(memory.store.getWatermark(sessionId, "main")?.lastSettledFact).toBe(first);
  expect(memory.store.getWatermark(otherSession, "main")?.lastSettledFact).toBe(second);
});

test("rejected supports still cited by a committed operation are not lost", async () => {
  const old = fact(), e = entry([old]); watermark(old);
  const current = fact(), output = { ...newOutput(current), edit: editOutput(e, current).edit };
  queue(output); const resolve = deferred(), pending = settle();
  await new Promise((r) => setTimeout(r, 0));
  memory.store.commitSettleRun({ run: { kind: "settle", sessionId, createdAt: time }, operations: [{ op: "edit", entryId: e,
    expectedRevision: 1, text: memories.base, category: "mechanism", scope: "project", supports: [old], because: [], createdAt: time }] });
  resolve(output); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.rejected).toHaveLength(1);
  expect(result.diagnostics.some((d) => d.kind === "lost_citations")).toBe(false);
});
