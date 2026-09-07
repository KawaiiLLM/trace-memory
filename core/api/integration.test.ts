import { afterEach, beforeEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, type IntegrationAgentInput as CoreInput, type RunAgentResult, type ConfigOverride } from "./index.ts";
import memories from "../../test/fixtures/recording/facts.json";

type IntegrationAgentInput = CoreInput & { round: "candidate" | "final"; request?: any; response?: RunAgentResult };
let directory: string, memory: ReturnType<typeof TraceMemory>, sessionId: number, projectId: number;
let calls: IntegrationAgentInput[], script: ((input: IntegrationAgentInput) => Promise<RunAgentResult>)[];
const time = "2026-08-16 02:54";
const empty = { operations: [], skipped: [] };
const success = (output: unknown, input: IntegrationAgentInput): RunAgentResult => ({ outcome: "success", output: output === empty ? { ...empty, skipped: input.range.facts.map(f => ({ fact: `F${f.id}`, because: "Not retained in this test." })) } : output,
  usage: { tokens: 12 }, request: input.request });
function open(config: ConfigOverride = {}) {
  memory = TraceMemory(join(directory, "test.sqlite"), async (raw) => {
    let input = { ...raw as CoreInput, round: "candidate" as const } as IntegrationAgentInput;
    const messages: any[] = [{ role: "user", content: input.input }];
    for (;;) {
      input.request = { system: input.prompt, messages: structuredClone(messages), tools: input.tools.map(({execute, ...tool}) => tool), hostField: input.round };
      input.reportRequest(input.request); calls.push(input);
      const next = script.shift(); if (!next) throw new Error("unexpected call");
      const response = await next(input); input.response = response;
      if (response.outcome !== "success" || response.request == null) return response;
      const batch = response.output;
      const receipt = input.tools.find(t => t.name === "memory")!.execute(batch);
      messages.push({ role: "assistant", toolCall: { name: "memory", arguments: batch } }, { role: "toolResult", content: receipt });
      const parsed = JSON.parse(receipt);
      if (!parsed.feedback) return { ...response, output: "done", request: input.request };
      messages.push(parsed.feedback);
      input = { ...input, round: "final", input: parsed.feedback.content };
    }
  }, config);
}
const session = (project = projectId) => memory.store.createSession({ host: "fake", startedAt: time, firstReplyAt: time, projectId: project }).id;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-integration-")); calls = []; script = []; open();
  projectId = memory.store.createProject({ name: "fixture", declaredBy: "mark" }).id; sessionId = session();
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
function fact(text = memories.base, options: { sessionId?: number; branch?: string; source?: string[]; createdAt?: string; actor?: "user" | "agent"; category?: "observation" | "question"; quote?: string; negate?: { target: string; strength: "strong" | "weak" }[] } = {}) {
  const owner = options.sessionId ?? sessionId, branch = options.branch ?? "main";
  const turn = memory.store.appendTurn({ sessionId: owner, parentTurnId: memory.store.getWatermark(owner, branch)?.lastRecordedTurn ?? undefined, kind: "turn", userPrompt: text, assistantText: text, startedAt: time });
  const result = memory.store.commitRecordingRun({ run: { kind: "recording", sessionId: owner, branch, createdAt: time }, watermark: { sessionId: owner, branch, lastRecordedTurn: turn.id }, facts: [{ turnId: turn.id,
    category: options.category ?? "observation", actor: options.actor ?? "user", quote: options.quote, text, source: options.source ?? [`T${turn.id}#user`], createdAt: options.createdAt ?? time, negate: options.negate }] });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.facts[0]!.id;
}
function knowledge(supports: number[], options: { sessionId?: number; text?: string; category?: "constraint" | "open" | "dispute" | "goal" | "mechanism" | "term" | "reference"; scope?: "session" | "project" | "global" } = {}) {
  const result = memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId: options.sessionId ?? sessionId, createdAt: time }, operations: [{
    op: "create", handle: "$e1", author: "fake", text: options.text ?? memories.knowledge, supports, createdAt: time,
    category: options.category ?? "mechanism", scope: options.scope ?? "project",
  }] });
  if (!result.ok) throw new Error("fixture knowledge failed");
  return result.committed[0]!.knowledgeId;
}
function watermark(id: number, branch = "main") {
  const result = memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, branch, createdAt: time }, operations: [],
    watermark: { sessionId, branch, lastIntegratedFact: id } });
  expect(result.ok).toBe(true);
}
const createOutput = (support: number, text = memories.knowledge) => ({ ...empty, operations: [{ op: "create", text, category: "mechanism" as const, scope: "project" as const, supports: [`F${support}`], because: [`F${support}`] }] });
const integration = (branch = "main") => memory.integrate({ sessionId, branch });
function queue(...outputs: unknown[]) { for (const output of outputs) script.push(async (input) => success(output, input)); }
function deferred() {
  let resolve!: (output: unknown) => void;
  const promise = new Promise<unknown>((r) => { resolve = r; });
  script.push(async (input) => success(await promise, input)); return resolve;
}
function audit(runId: number, callIndex: number, outcome: "success" | "failure" | "cancelled" | "bounced" = "success") {
  const run = memory.store.getRun(runId)!;
  expect(run.outcome).toBe(outcome);
  expect(JSON.parse(run.request!)).toEqual(calls[callIndex]!.request);
  expect(run.promptHash).toBe(createHash("sha256").update(calls[callIndex]!.prompt).digest("hex"));
  expect(JSON.parse(run.response!).readKnowledgeRevisions).toEqual(calls[callIndex]!.readKnowledgeRevisions);
  return JSON.parse(run.response!);
}

test("freezes session branch range, read revisions, relations and guidance through both calls and commits only the frozen range", async () => {
  const old = fact(), e = knowledge([old], { category: "open" }); watermark(old);
  const current = fact(memories.knowledge);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.observation, { sessionId: session(foreignProject) });
  const before = memory.trace(`K${e}`), resolve = deferred(), selection = { sessionId, branch: "main", model: "fake-model", mode: "branch" as const };
  const pending = memory.integrate(selection);
  selection.branch = "switched";
  const late = fact(memories.observation, { negate: [{ target: `F${current}`, strength: "strong" }] });
  const update = memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: time }, operations: [{ op: "update", knowledgeId: e,
    expectedRevision: 1, text: memories.editedKnowledge, category: "open", scope: "project", supports: [late], because: [late], createdAt: time }] });
  expect(update.ok).toBe(true);
  const moved = memory.trace(`K${e}`); expect(moved).not.toBe(before);
  knowledge([late]);
  queue(createOutput(current)); resolve(createOutput(current)); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range).toEqual({ from: `F${current}`, to: `F${current}`, facts: [memory.store.getFact(current)!] });
  expect(result.readKnowledgeRevisions).toEqual([{ knowledgeId: e, rev: 1 }]);
  for (const call of calls) {
    expect(call.branch).toBe("main"); expect(call.model).toBe("fake-model"); expect(call.mode).toBe("branch");
    expect(call.input).not.toContain(`[F${late}]`); expect(call.input).not.toContain(`[F${foreign}]`);
    expect(call.input).not.toContain(`inbound negate F${late}`); expect(call.input).not.toContain(`[K${e}@2]`);
  }
  expect(calls[1]!.input).toContain(`[K${e}@1]`);
  expect(audit(result.runId, 1).toolCalls).toHaveLength(2);
  expect(memory.trace(`K${e}`)).toBe(moved);
  expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBe(current);
  expect(memory.store.listPendingDeliveries(sessionId, "main")).toEqual([]);
});

test("reminder lists every visible supporting knowledge for both strengths and ignores lexical distance and budgets", async () => {
  const cited = fact(), unrelatedFact = fact(memories.observation), other = session();
  const ids = [knowledge([cited]), knowledge([cited], { text: memories.observation }), knowledge([cited], { scope: "session" }),
    knowledge([cited], { scope: "global", sessionId: other })];
  const excluded = [knowledge([unrelatedFact]), knowledge([cited], { scope: "session", sessionId: other })];
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreignSession = session(foreignProject);
  excluded.push(knowledge([cited], { sessionId: foreignSession }));
  ids.push(knowledge([cited], { scope: "global", sessionId: foreignSession }));
  const archived = knowledge([cited]);
  memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: time }, operations: [{ op: "archive", knowledgeId: archived,
    expectedRevision: 1, because: [unrelatedFact], createdAt: time }] }); excluded.push(archived);
  watermark(unrelatedFact);
  const strong = fact(memories.observation, { negate: [{ target: `F${cited}`, strength: "strong" }] });
  const weak = fact(memories.interpretation, { negate: [{ target: `F${cited}`, strength: "weak" }] });
  memory.close(); open({ render: { knowledgeBlockTokens: 0, episodicBlockTokens: 0 }, integration: { nearThreshold: 1 } });
  const traces = ids.map((id) => memory.trace(`K${id}`)); queue(empty, empty);
  expect((await integration()).outcome).toBe("success");
  const reminder = calls[0]!.input.split("Negated-evidence reminder (review cues only; no status derived):\n\n")[1]!.split("\n\nReceipts:")[0]!;
  for (const id of ids) expect(reminder.match(new RegExp(`\\[K${id}@1\\]`, "g"))).toHaveLength(2);
  for (const id of excluded) expect(reminder).not.toContain(`[K${id}@`);
  expect(reminder.match(/Recorded negation strength: strong/g)).toHaveLength(ids.length);
  expect(reminder.match(/Recorded negation strength: weak/g)).toHaveLength(ids.length);
  for (const id of [cited, strong, weak]) expect(reminder).toContain(memory.trace(`F${id}`));
  expect(calls[0]!.input).toContain("range overage:");
  expect(ids.map((id) => memory.trace(`K${id}`))).toEqual(traces);
});

test("feedback contains NEAR, CLOSER, an exact checklist section and continuation of the candidate request and response", async () => {
  const f = fact(memories.knowledge), e = knowledge([f], { category: "open" }), goal = knowledge([f], { category: "goal" });
  const candidate = createOutput(f); queue(candidate, candidate);
  const result = await integration(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.output).toEqual(candidate);
  expect(result.unansweredNear).toEqual([{ candidate: "$e1", knowledge: `K${e}`, score: 1 }, { candidate: "$e1", knowledge: `K${goal}`, score: 1 }]);
  expect(calls[0]!.input).not.toContain("NEAR:"); expect(calls[0]!.input).not.toContain("CLOSER:");
  expect(calls[0]!.request.messages).toHaveLength(1);
  const second = calls[1]!;
  expect(second.request.messages.slice(0, 1)).toEqual(calls[0]!.request.messages);
  expect(second.request.messages.at(-1)).toEqual({ role: "user", content: second.input });
  expect(second.input).toContain("NEAR:"); expect(second.input).toContain("CLOSER:");
  expect(second.input).toContain("System-generated review guidance; not a human ruling or adoption evidence.");
  const prompt = readFileSync(new URL("../prompts/integration.md", import.meta.url), "utf8");
  const section = prompt.split("### Second-round user message\n")[1]!.split("\n### ")[0]!;
  expect(second.input.endsWith(section)).toBe(true);
  expect(second.input.split(section)).toHaveLength(2);
  const closer = second.input.split("CLOSER:\n\n")[1]!.split(section)[0]!;
  expect(closer).toContain(`[K${e}@1]`); expect(closer).toContain(`[K${goal}@1]`); expect(closer).toContain(memory.trace(`F${f}`));
  expect(calls[0]!.mode).toBe("subagent"); expect(calls[0]!.model).toBe("session");
  audit(result.runId, 1);
});

for (const resolution of ["update", "merge", "unchanged", "withdraw", "archive"] as const) test(`corrected final output: ${resolution}`, async () => {
  const f = fact(), e = knowledge([f]), absorbed = knowledge([f], { text: memories.observation });
  const candidate = createOutput(f), final = { ...candidate };
  let output: unknown = final;
  const operation = { id: `K${e}`, text: memories.knowledge, category: "mechanism", scope: "project", supports: [`F${f}`], because: [`F${f}`] };
  if (resolution === "update") output = { ...final, operations: [...final.operations, { op: "update", ...operation }] };
  if (resolution === "merge") output = { ...final, operations: [...final.operations, { op: "merge", ...operation, id: `K${e}`, absorb: [`K${absorbed}`] }] };
  if (resolution === "withdraw") output = empty;
  if (resolution === "archive") output = { ...final, operations: [...final.operations, { op: "archive", id: `K${e}`, because: [`F${f}`] }] };
  const before = memory.trace(`K${e}`); queue(candidate, output);
  const result = await integration(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.unansweredNear).toHaveLength(["unchanged", "archive"].includes(resolution) ? 1 : 0);
  expect(memory.store.getKnowledge(e)?.currentRevision).toBe(["update", "merge", "archive"].includes(resolution) ? 2 : 1);
  expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBe(f);
  expect(calls).toHaveLength(2);
});

test("NEAR covers create, update and merge text, excludes each target, and uses threshold on character bigram sets", async () => {
  const f = fact(), a = knowledge([f]), b = knowledge([f]), c = knowledge([f], { text: memories.observation });
  const op = { text: memories.knowledge, scope: "project", category: "mechanism", supports: [`F${f}`], because: [] };
  const output = { ...empty, operations: [...createOutput(f).operations, { op: "update", ...op, id: `K${a}` }, { op: "merge", ...op, id: `K${b}`, absorb: [`K${c}`] }] };
  queue(output, output); const result = await integration(); if (result.outcome !== "success") throw new Error("expected success");
  const feedback = calls[1]!.input.split("CLOSER:")[0]!;
  expect(feedback).toContain(`$e1 -> K${a} (Jaccard 1)`); expect(feedback).toContain(`$e1 -> K${b} (Jaccard 1)`);
  expect(feedback).toContain(`K${a} -> K${b} (Jaccard 1)`); expect(feedback).toContain(`K${b} -> K${a} (Jaccard 1)`);
  expect(feedback).not.toContain(`K${a} -> K${a}`); expect(feedback).not.toContain(`K${b} -> K${b}`);
  expect(feedback).not.toContain(`-> K${c}`);
  memory.close(); open({ integration: { nearThreshold: 1, subagentModeDefault: false } });
  fact(); queue(createOutput(f, memories.base), empty); await integration();
  expect(calls[3]!.input).toContain("NEAR:\n\nnone"); expect(calls[2]!.mode).toBe("branch");
});

for (const round of ["candidate", "final"] as const) for (const bad of ["json", "shape", "failure", "cancelled", "missing request", "throw", "abort"] as const) {
  test(`${round} ${bad} records the exact attempt, returns problems and releases deduplication`, async () => {
    fact(); if (round === "final") queue(empty);
    script.push(async (input) => {
      if (bad === "throw" || bad === "abort") { const error = new Error("stopped"); error.name = bad === "abort" ? "AbortError" : "Error"; throw error; }
      if (bad === "failure" || bad === "cancelled") return { ...success(empty, input), outcome: bad, output: "stopped" };
      if (bad === "missing request") return { outcome: "success", output: "{}" };
      return { ...success(empty, input), output: bad === "json" ? "{" : { operations: [{ op: "create", category: "invalid", because: [] }], skipped: [] } };
    });
    const result = await integration();
    if (!("problems" in result)) throw new Error("expected failure");
    const expected = bad === "json" || bad === "shape" ? "bounced" : bad === "cancelled" || bad === "abort" ? "cancelled" : "failure";
    expect(result.outcome).toBe(expected); expect(result.problems!.length).toBeGreaterThan(0);
    if (bad === "json") expect(result.problems!.join("\n")).toContain("memory expects");
    if (bad === "shape") expect(result.problems!.join("\n")).toContain("category");
    const run = memory.store.getRun(result.runId)!;
    expect(run.outcome).toBe(expected);
    expect(JSON.parse(run.response!).problems).toEqual(result.problems);
    audit(result.runId, round === "final" ? 1 : 0, run.outcome as RunAgentResult["outcome"]);
    if (round === "final") expect(JSON.parse(run.response!).candidate).toEqual(success(empty, calls[0]!).output);
    expect(memory.store.getRun(result.runId + 1)).toBeNull();
    expect(calls).toHaveLength(round === "final" ? 2 : 1);
    expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBeNull();
    queue(empty, empty); expect((await integration()).outcome).toBe("success");
  });
}

test("duplicate trigger is dropped across facades during either round; different branches and sessions of the project remain independent", async () => {
  fact(); const resolveFirst = deferred(), pending = integration();
  const other = TraceMemory(join(directory, "test.sqlite"), async () => { throw new Error("must not call"); });
  try {
    expect(await other.integrate({ sessionId, branch: "main" })).toEqual({ outcome: "dropped" });
    expect(await integration("other")).toEqual({ outcome: "empty" });
    expect(await memory.integrate({ sessionId: session(), branch: "main" })).toEqual({ outcome: "empty" });
    const resolveFinal = deferred(); resolveFirst(empty);
    // Let the candidate record and final model call finish entering the deferred seam.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.at(-1)!.round).toBe("final");
    expect(await integration()).toEqual({ outcome: "dropped" });
    resolveFinal(empty); expect((await pending).outcome).toBe("success");
    expect(calls).toHaveLength(2);
  } finally { other.close(); }
});

test("empty ranges do not call the agent or create records", async () => {
  expect(await integration()).toEqual({ outcome: "empty" }); expect(memory.store.getRun(1)).toBeNull();
  const f = fact(); watermark(f); expect(await integration()).toEqual({ outcome: "empty" });
  expect(memory.store.getRun(3)).toBeNull(); expect(calls).toEqual([]);
});

test("context uses timestamp freshness while range remains complete and categories follow recording budgets", async () => {
  const newest = fact(memories.base, { createdAt: "2026-08-17" }), oldest = fact(memories.observation, { createdAt: "2026-08-15" });
  const categories = ["constraint", "open", "dispute", "goal", "mechanism", "term", "reference"] as const;
  for (const category of categories) knowledge([newest], { category });
  watermark(oldest); const current = fact(memories.interpretation);
  queue(empty, empty); await integration();
  const input = calls[0]!.input;
  expect(input.indexOf(`[F${newest}]`)).toBeLessThan(input.indexOf(`[F${oldest}]`));
  for (let i = 1; i < categories.length; i++) expect(input.indexOf(`[${categories[i - 1]}/project]`)).toBeLessThan(input.indexOf(`[${categories[i]}/project]`));
  memory.close(); open({ render: { knowledgeBlockTokens: 0, episodicBlockTokens: 0 } });
  const next = fact(memories.interpretation);
  queue(empty, empty); await integration(); const small = calls[2]!.input;
  expect(small).toContain(memory.trace(`F${next}`));
  expect(small).not.toContain(`[F${newest}]`); expect(small).not.toContain(`[F${oldest}]`);
  expect(small).toContain("omitted 3 older facts");
  for (const category of categories.slice(0, 3)) expect(small).toContain(`[${category}/project]`);
  for (const category of categories.slice(3)) { expect(small).not.toContain(`[${category}/project]`); expect(small).toContain(`omitted 1 ${category} knowledge`); }
  expect(calls[2]!.readKnowledgeRevisions).toHaveLength(7);
});

test("bigram Jaccard has a known nontrivial score and an inclusive configurable threshold", async () => {
  const f = fact(), e = knowledge([f]);
  // The two fixture strings share eight bigrams; their union has twelve.
  // The longer fact inserts three bigrams and replaces one shared boundary.
  memory.close(); open({ integration: { nearThreshold: 2 / 3 } });
  queue(createOutput(f, memories.base), createOutput(f, memories.base));
  const result = await integration(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.unansweredNear).toEqual([{ candidate: "$e1", knowledge: `K${e}`, score: 2 / 3 }]);
  memory.close(); open({ integration: { nearThreshold: 2 / 3 + 0.001 } });
  fact(); queue(createOutput(f, memories.base), empty); await integration();
  expect(calls[3]!.input).not.toContain(`-> K${e} (`);
});

const updateOutput = (id: number, support: number) => ({ ...empty, operations: [{ op: "update", id: `K${id}`, text: memories.editedKnowledge, category: "mechanism", scope: "project", supports: [`F${support}`], because: [`F${support}`] }] });
const decline = (...ids: number[]) => ids.map((id) => ({ fact: `F${id}`, because: "Not durable." }));

test("accounting diagnoses uncited user facts and agent questions, then accepts explicit skipped facts", async () => {
  const user = fact(), question = fact(memories.base, { actor: "agent", category: "question" });
  fact(memories.observation, { actor: "agent" });
  const output = { ...empty }; queue(output, output);
  const result = await integration();
  if (result.outcome !== "success") throw new Error("expected diagnostic success");
  expect(result.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [`F${user}`, `F${question}`] });
  expect(audit(result.runId, 1).diagnostics).toEqual(result.diagnostics);
  expect(memory.store.listVisibleKnowledge(sessionId, projectId)).toEqual([]);
  const later = fact(); queue(output, { ...output, skipped: decline(later) });
  const skipped = await integration();
  if (skipped.outcome !== "success") throw new Error("expected success");
  expect(skipped.diagnostics).toEqual([]);
});

for (const operation of ["update", "archive", "merge"] as const) test(`accounting evaluates supports after ${operation}`, async () => {
  const f = fact(), other = fact(memories.observation, { actor: "agent" }), e = knowledge([f]), survivor = knowledge([other]);
  const output = operation === "update" ? updateOutput(e, other) : operation === "archive"
    ? { ...empty, operations: [{ op: "archive", id: `K${e}`, because: [`F${other}`] }] }
    : { ...empty, operations: [{ ...updateOutput(survivor, other).operations[0], op: "merge", id: `K${survivor}`, absorb: [`K${e}`] }] };
  queue(output, output); const result = await integration();
  if (result.outcome !== "success") throw new Error("expected diagnostic success");
  expect(result.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [`F${f}`] });
  expect(memory.store.getKnowledge(e)?.status).toBe(operation === "archive" ? "archived" : operation === "merge" ? "merged" : "active");
});

test("a target that moved on bounces the whole batch, audits the rejection and preserves the watermark", async () => {
  const old = fact(), e = knowledge([old]); watermark(old);
  const lost = fact(), kept = fact(memories.observation);
  const output = { ...empty, operations: [...createOutput(kept).operations, ...updateOutput(e, lost).operations.map(op => ({ ...op, supports: [`F${lost}`, `F${kept}`] }))] };
  queue(output); const resolve = deferred(), pending = integration();
  await new Promise((r) => setTimeout(r, 0));
  memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: time }, operations: [{ op: "update", knowledgeId: e,
    expectedRevision: 1, text: memories.base, category: "mechanism", scope: "project", supports: [old], because: [], createdAt: time }] });
  resolve(output); const result = await pending;
  if (result.outcome !== "bounced") throw new Error("expected atomic bounce");
  expect(result.problems.join(" ")).toContain("expected revision 1, current revision is 2");
  expect(memory.store.getKnowledge(e + 1)).toBeNull();
  expect(audit(result.runId, 1, "bounced").toolCalls.at(-1).result).toContain("rejected:");
  expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBe(old);
  expect(memory.trace(`F${lost}`)).toContain(memories.base);
  expect(JSON.parse(memory.store.getRun(result.runId)!.response!).toolCalls).toHaveLength(2);
});

test("merge records survivor revision, absorbed links, and trace history", async () => {
  const a = fact(), b = fact(memories.observation), survivor = knowledge([a]), absorbed = knowledge([b]);
  const output = { ...empty, operations: [{ op: "merge", id: `K${survivor}`, absorb: [`K${absorbed}`], text: memories.editedKnowledge, category: "mechanism", scope: "project", supports: [`F${a}`, `F${b}`], because: [`F${b}`] }] };
  queue(output, output); const result = await integration();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toEqual([{ op: "merge", knowledgeId: survivor, rev: 2 }]);
  expect(memory.store.listKnowledgeLinks(absorbed)).toEqual([{ fromKnowledge: absorbed, fromRev: 1, kind: "merged_into", toKnowledge: survivor, toRev: 2 }]);
  expect(memory.trace(`K${absorbed}`)).toContain(`K${survivor}@2`);
  expect(memory.trace(`K${survivor}`)).toContain("merge");
  expect(memory.trace(`K${survivor}@1..2`)).toContain(`F${b}`);
  expect(memory.store.getKnowledgeRevision(survivor, 2)?.because).toEqual([b]);
});

test("numbers, token overage and unanswered NEAR are diagnostics, never gates", async () => {
  const f = fact("Measured 12 samples.", { quote: "Confirmed 42." }); knowledge([f], { text: "Measured 12 samples." });
  const output = createOutput(f, "Measured 12 samples. 42 2 999 " + "x".repeat(801));
  queue(createOutput(f, "Measured 12 samples."), output); const result = await integration();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toHaveLength(1);
  expect(result.diagnostics).toContainEqual({ kind: "unsupported_numbers", knowledge: "$e1", numbers: ["2", "999"] });
  expect(result.diagnostics).toContainEqual({ kind: "over_200_tokens", knowledge: "$e1", tokens: Math.ceil(output.operations[0]!.text.length / 4) });
  expect(result.diagnostics).toContainEqual({ kind: "unanswered_near", pairs: result.unansweredNear });
  expect(audit(result.runId, 1).diagnostics).toEqual(result.diagnostics);
});

for (const bad of ["missing fact", "foreign fact", "late fact", "unread knowledge", "duplicate handle", "duplicate target", "empty merge"] as const) test(`resolution bounces: ${bad}`, async () => {
  const f = fact(), e = knowledge([f]);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.base, { sessionId: session(foreignProject) });
  queue(createOutput(f)); const resolve = deferred(), pending = integration();
  await new Promise((r) => setTimeout(r, 0));
  const late = fact(), unread = knowledge([late]);
  const output = bad === "unread knowledge" ? updateOutput(unread, f)
    : bad === "duplicate target" ? { ...empty, operations: [...updateOutput(e, f).operations, { op: "archive", id: `K${e}`, because: [] }] }
    : bad === "empty merge" ? { ...empty, operations: [{ ...updateOutput(e, f).operations[0], op: "merge", id: `K${e}`, absorb: [] }] }
    : bad === "duplicate handle" ? { operations: [{ ...createOutput(f).operations[0], handle: "$e1" }], skipped: [] }
    : createOutput(bad === "missing fact" ? 999999 : bad === "foreign fact" ? foreign : late);
  resolve(output); const result = await pending;
  expect(result.outcome).toBe("bounced");
  expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBeNull();
  expect(memory.store.getKnowledge(e)?.currentRevision).toBe(1);
});

test("each session settles only its own branch facts and shares already-settled context", async () => {
  const first = fact(), secondSession = session();
  const second = fact(memories.observation, { sessionId: secondSession, branch: "fork" });
  queue(createOutput(second), createOutput(second));
  const other = await memory.integrate({ sessionId: secondSession, branch: "fork" });
  if (other.outcome !== "success") throw new Error("expected success");
  expect(other.range.facts.map((f) => f.id)).toEqual([second]);
  expect(calls[0]!.input).not.toContain(`[F${first}]`);
  queue(createOutput(first), createOutput(first));
  const result = await integration();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range.facts.map((f) => f.id)).toEqual([first]);
  expect(calls[2]!.input).toContain(memory.trace(`F${second}`));
  expect(memory.store.getWatermark(secondSession, "fork")?.lastIntegratedFact).toBe(second);
  expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBe(first);
  expect(await integration()).toEqual({ outcome: "empty" });
  const fork = fact(memories.interpretation, { branch: "fork" });
  expect(await integration()).toEqual({ outcome: "empty" });
  queue(createOutput(fork), createOutput(fork));
  const forkResult = await integration("fork");
  if (forkResult.outcome !== "success") throw new Error("expected success");
  expect(forkResult.range.facts.map((f) => f.id)).toEqual([fork]);
});

test("integration revisions and success record roll back if watermark writing fails", async () => {
  const f = fact(), output = createOutput(f); queue(output, output);
  const original = memory.store.setWatermark;
  memory.store.setWatermark = () => { throw new Error("watermark write failed"); };
  try {
    const result = await integration(); expect(result.outcome).toBe("failure");
    expect(memory.store.listVisibleKnowledge(sessionId, projectId)).toEqual([]);
    expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBeNull();
    if (result.outcome !== "failure") throw new Error("expected failure");
    expect(memory.store.getRun(result.runId)?.outcome).toBe("failure");
    expect(JSON.parse(memory.store.getRun(result.runId)!.response!).problems).toEqual(result.problems);
  } finally { memory.store.setWatermark = original; }
});

test("simulation v7m fixture integrates through the facade with traceable Chinese evidence", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/integration.json", import.meta.url), "utf8"));
  const ids = new Map<number, number>();
  for (const source of fixture.facts) ids.set(source.id, fact(source.text, { actor: source.actor, category: source.category, quote: source.quote, source: source.source, createdAt: source.timestamp }));
  const output = { ...empty, operations: [{ op: "create", ...fixture.knowledge, supports: fixture.knowledge.supports.map((id: string) => `F${ids.get(Number(id.slice(1)))}`), because: fixture.knowledge.supports.map((id: string) => `F${ids.get(Number(id.slice(1)))}`) }] };
  queue(output, output); const result = await integration();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toHaveLength(1);
  expect(memory.trace(`K${result.committed[0]!.knowledgeId}`)).toContain(fixture.knowledge.text);
  for (const source of fixture.facts) expect(memory.trace(`F${ids.get(source.id)}`)).toContain(source.text);
});

test("an archived target bounces the whole batch and preserves the watermark and audit", async () => {
  const old = fact(), e = knowledge([old]); watermark(old); const f = fact();
  const output = { ...empty, operations: [...createOutput(f).operations, ...updateOutput(e, f).operations] };
  queue(output); const resolve = deferred(), pending = integration();
  await new Promise((r) => setTimeout(r, 0));
  memory.store.commitIntegrationRun({ run: { kind: "integration", sessionId, createdAt: time }, operations: [{ op: "archive", knowledgeId: e,
    expectedRevision: 1, because: [old], createdAt: time }] });
  resolve(output); const result = await pending;
  if (result.outcome !== "bounced") throw new Error("expected atomic bounce");
  expect(result.problems.join(" ")).toContain("target moved on or is inactive");
  expect(memory.store.getKnowledge(e + 1)).toBeNull();
  expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBe(old);
  // No operation commits; the entire batch remains available for a fresh run.
  expect(JSON.parse(memory.store.getRun(result.runId)!.response!).toolCalls).toHaveLength(2);
});

test("because addresses are resolved but do not satisfy accounting", async () => {
  const f = fact(), other = fact(memories.observation, { actor: "agent" }), e = knowledge([other]);
  const output = { ...empty, operations: [{ op: "update", ...updateOutput(e, other).operations[0], because: [`F${f}`] }] };
  queue(output, output); const first = await integration();
  if (first.outcome !== "success") throw new Error("expected diagnostic success");
  expect(first.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [`F${f}`] });
  fact();
  queue(output, { ...output, operations: [{ op: "update", ...output.operations[0], because: ["F999999"] }] });
  const bad = await integration();
  if (bad.outcome !== "bounced") throw new Error("expected bounce");
  expect(bad.problems.join(" ")).toContain("F999999");
});

test("a different project can integration while this project is in flight", async () => {
  const f = fact(), resolve = deferred(), pending = integration();
  const project = memory.store.createProject({ name: "independent", declaredBy: "mark" }).id, owner = session(project);
  const other = fact(memories.observation, { sessionId: owner });
  queue(createOutput(other), createOutput(other));
  expect((await memory.integrate({ sessionId: owner, branch: "main" })).outcome).toBe("success");
  queue(createOutput(f)); resolve(createOutput(f)); expect((await pending).outcome).toBe("success");
});

test("exactly 200 estimated tokens is accepted without a length diagnostic", async () => {
  const f = fact(), output = createOutput(f, "x".repeat(800)); queue(output, output);
  const result = await integration(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.diagnostics).toEqual([]);
});

test("narrowing another session's global knowledge cannot conceal an uncited fact", async () => {
  const f = fact(), e = knowledge([f], { scope: "global", sessionId: session() });
  const output = { ...empty, operations: [{ op: "update", ...updateOutput(e, f).operations[0], scope: "session" }] };
  queue(output, output); const result = await integration();
  if (result.outcome !== "success") throw new Error("expected diagnostic success");
  expect(result.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [`F${f}`] });
});


test("same-project sessions commit independently while another session is pending", async () => {
  const first = fact(), otherSession = session();
  const second = fact(memories.observation, { sessionId: otherSession });
  const resolve = deferred(), pending = integration();
  queue(createOutput(second), createOutput(second));
  const other = await memory.integrate({ sessionId: otherSession, branch: "main" });
  if (other.outcome !== "success") throw new Error("expected success");
  expect(other.range.facts.map((f) => f.id)).toEqual([second]);
  queue(createOutput(first)); resolve(createOutput(first));
  const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range.facts.map((f) => f.id)).toEqual([first]);
  expect(memory.store.getWatermark(sessionId, "main")?.lastIntegratedFact).toBe(first);
  expect(memory.store.getWatermark(otherSession, "main")?.lastIntegratedFact).toBe(second);
});
