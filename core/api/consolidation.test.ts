import { afterEach, beforeEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceMemory, tokens, type ConsolidationAgentInput as CoreInput, type RunAgentResult, type ConfigOverride } from "../../test/source-fixture.ts";
import memories from "../../test/fixtures/noting/facts.json";

type ConsolidationAgentInput = CoreInput & { round: "candidate" | "final"; feedback?: string; request?: any; response?: RunAgentResult };
let directory: string, memory: ReturnType<typeof TraceMemory>, sessionId: number, projectId: number;
let calls: ConsolidationAgentInput[], script: ((input: ConsolidationAgentInput) => Promise<RunAgentResult>)[];
const time = "2026-08-16 02:54";
const empty = { operations: [], skipped: [] };
const success = (output: unknown, input: ConsolidationAgentInput): RunAgentResult => ({ outcome: "success", output: output === empty ? { ...empty, skipped: input.range.facts.map(f => ({ fact: `F${f.id}`, because: "Not retained in this test." })) } : output,
  usage: { tokens: 12 }, request: input.request });
function open(config: ConfigOverride = {}) {
  memory = TraceMemory(join(directory, "test.sqlite"), async (raw) => {
    // A stub host: it receives structured material and never a core-composed message, and builds its
    // own provider record out of the material, the tool rounds and core's review feedback (19b).
    let input = { ...raw as CoreInput, round: "candidate" as const } as ConsolidationAgentInput;
    const rounds: any[] = [{ material: structuredClone(input.material) }];
    for (;;) {
      input.request = { system: input.prompt, rounds: structuredClone(rounds), tools: input.tools.map(({execute, ...tool}) => tool), hostField: input.round };
      input.reportRequest(input.request); calls.push(input);
      const next = script.shift(); if (!next) throw new Error("unexpected call");
      const response = await next(input); input.response = response;
      if (response.outcome !== "success" || response.request == null) return response;
      const batch = response.output;
      const receipt = input.tools.find(t => t.name === "memory")!.execute(batch);
      rounds.push({ toolCall: { name: "memory", arguments: batch } }, { toolResult: receipt });
      const feedback = input.reviewFeedback(receipt);
      if (!feedback) return { ...response, output: "done", request: input.request };
      rounds.push({ role: "user", content: feedback });
      input = { ...input, round: "final", feedback };
    }
  }, config);
}
const session = (project = projectId) => memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project }).id;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-consolidation-")); calls = []; script = []; open();
  projectId = memory.store.createProject({ name: "fixture", declaredBy: "mark" }).id; sessionId = session();
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
function fact(text = memories.base, options: { sessionId?: number; branch?: string; source?: string[]; createdAt?: string; actor?: "user" | "agent"; category?: "observation" | "question"; quote?: string; negate?: { target: string; strength: "strong" | "weak" }[] } = {}) {
  const owner = options.sessionId ?? sessionId, branch = options.branch ?? "main";
  const turn = memory.store.appendTurn({ sessionId: owner, parentTurnId: memory.store.knowledgePath(owner, branch).headTurnId ?? undefined, kind: "turn", userPrompt: text, assistantText: text, startedAt: time });
  const result = memory.store.commitNotingRun({ run: { kind: "noting", sessionId: owner, branch, createdAt: time }, entryIds: memory.store.sourcePath(owner, branch, turn.id).map(e => e.id), facts: [{ turnId: turn.id,
    category: options.category ?? "observation", actor: options.actor ?? "user", quote: options.quote, text, source: options.source ?? [`T${turn.id}#user`], createdAt: options.createdAt ?? time, negate: options.negate }] });
  if (!result.ok) throw new Error(result.problems.join("\n"));
  return result.facts[0]!.id;
}
function knowledge(supports: number[], options: { sessionId?: number; text?: string; category?: "constraint" | "open" | "dispute" | "goal" | "mechanism" | "term" | "reference"; scope?: "session" | "project" | "global" } = {}) {
  const result = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId: options.sessionId ?? sessionId, createdAt: time }, operations: [{
    op: "create", handle: "$e1", author: "fake", text: options.text ?? memories.knowledge, supports, createdAt: time,
    category: options.category ?? "mechanism", scope: options.scope ?? "project",
  }] });
  if (!result.ok) throw new Error("fixture knowledge failed");
  return result.committed[0]!.knowledgeId;
}
function watermark(id: number, branch = "main") {
  const result = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, branch, createdAt: time }, operations: [], consolidated: [id] });
  expect(result.ok).toBe(true);
}
const consolidated = (id: number, branch = "main", owner = sessionId) => memory.store.consolidatedOnPath(id, memory.store.knowledgePath(owner, branch));
const createOutput = (support: number, text = memories.knowledge) => ({ ...empty, operations: [{ op: "create", text, category: "mechanism" as const, scope: "project" as const, supports: [`F${support}`], because: [`F${support}`] }] });
const consolidation = (branch = "main") => memory.consolidate({ sessionId, branch });
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
  expect(JSON.parse(run.response!).readKnowledgeCommits).toEqual(calls[callIndex]!.readKnowledgeCommits);
  return JSON.parse(run.response!);
}

test("freezes session branch range, read revisions, relations and guidance through both calls and commits only the frozen range", async () => {
  const old = fact(), e = knowledge([old], { category: "open" }); watermark(old);
  const current = fact(memories.knowledge);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.observation, { sessionId: session(foreignProject) });
  const before = memory.trace(`K${e}`), resolve = deferred(), selection = { sessionId, branch: "main", model: "fake-model", mode: "fork" as const };
  const pending = memory.consolidate(selection);
  selection.branch = "switched";
  const late = fact(memories.observation, { negate: [{ target: `F${current}`, strength: "strong" }] });
  const update = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: time }, operations: [{ op: "update", knowledgeId: e,
    baseCommit: 1, text: memories.editedKnowledge, category: "open", scope: "project", supports: [late], because: [late], createdAt: time }] });
  expect(update.ok).toBe(true);
  const moved = memory.trace(`K${e}`); expect(moved).not.toBe(before);
  knowledge([late]);
  queue(createOutput(current)); resolve(createOutput(current)); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range).toEqual({ from: `F${current}`, to: `F${current}`, facts: [memory.store.getFact(current)!] });
  expect(result.readKnowledgeCommits).toEqual([{ knowledgeId: e, commit: 1 }]);
  for (const call of calls) {
    expect(call.branch).toBe("main"); expect(call.model).toBe("fake-model"); expect(call.mode).toBe("fork");
    expect(call.text.fresh).not.toContain(`[F${late}]`); expect(call.text.fresh).not.toContain(`[F${foreign}]`);
    expect(call.text.fresh).not.toContain(`inbound negate F${late}`); expect(call.text.fresh).not.toContain(`[K${e}@2]`);
  }
  expect(calls[1]!.text.fresh).toContain(`[K${e}@${e}]`);
  expect(audit(result.runId, 1).toolCalls).toHaveLength(2);
  expect(memory.trace(`K${e}`)).toBe(moved);
  expect(consolidated(current)).toBe(true);
  expect(memory.deliver(sessionId, "main").text).toContain("<consolidated>"); // 2026-09-08 supersedes mode-derived delivery
});

test("reminder lists every visible supporting knowledge for both strengths and ignores lexical distance and budgets", async () => {
  const cited = fact(), unrelatedFact = fact(memories.observation), other = session();
  const ids = [knowledge([cited]), knowledge([cited], { text: memories.observation }), knowledge([cited], { scope: "session" }),
    knowledge([cited], { scope: "global", sessionId: other })];
  const excluded = [knowledge([unrelatedFact]), knowledge([fact(memories.base, { sessionId: other })], { scope: "session", sessionId: other })];
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreignSession = session(foreignProject);
  excluded.push(knowledge([fact(memories.base, { sessionId: foreignSession })], { sessionId: foreignSession }));
  ids.push(knowledge([cited], { scope: "global", sessionId: foreignSession }));
  const archived = knowledge([cited]);
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: time }, operations: [{ op: "archive", knowledgeId: archived,
    baseCommit: archived, because: [unrelatedFact], createdAt: time }] }); excluded.push(archived);
  watermark(unrelatedFact);
  const strong = fact(memories.observation, { negate: [{ target: `F${cited}`, strength: "strong" }] });
  const weak = fact(memories.interpretation, { negate: [{ target: `F${cited}`, strength: "weak" }] });
  memory.close(); open({ render: { knowledgeBlockTokens: 1, episodicBlockTokens: 1 }, consolidation: { nearThreshold: 1 } });
  const traces = ids.map((id) => memory.trace(`K${id}`)); queue(empty, empty);
  expect((await consolidation()).outcome).toBe("success");
  const reminder = calls[0]!.material.reminders.join("\n\n");
  for (const id of ids) expect(reminder.match(new RegExp(`\\[K${id}@${id}\\]`, "g"))).toHaveLength(2);
  for (const id of excluded) expect(reminder).not.toContain(`[K${id}@`);
  expect(reminder.match(/Recorded negation strength: strong/g)).toHaveLength(ids.length);
  expect(reminder.match(/Recorded negation strength: weak/g)).toHaveLength(ids.length);
  for (const id of [cited, strong, weak]) expect(reminder).toContain(memory.trace(`F${id}`));
  expect(calls[0]!.material.receipts.join("\n")).toContain("range overage:");
  expect(ids.map((id) => memory.trace(`K${id}`))).toEqual(traces);
});

test("feedback contains NEAR, CLOSER, an exact checklist section and continuation of the candidate request and response", async () => {
  const f = fact(memories.knowledge), e = knowledge([f], { category: "open" }), goal = knowledge([f], { category: "goal" });
  const candidate = createOutput(f); queue(candidate, candidate);
  const result = await consolidation(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.output).toEqual(candidate);
  expect(result.unansweredNear).toEqual([{ candidate: "$e1", knowledge: `K${e}`, score: 1 }, { candidate: "$e1", knowledge: `K${goal}`, score: 1 }]);
  expect(calls[0]!.feedback).toBeUndefined();
  expect(calls[0]!.text.fresh).not.toContain("NEAR:"); expect(calls[0]!.text.fresh).not.toContain("CLOSER:");
  expect(calls[0]!.request.rounds).toHaveLength(1);
  const second = calls[1]!;
  expect(second.request.rounds.slice(0, 1)).toEqual(calls[0]!.request.rounds);
  expect(second.request.rounds.at(-1)).toEqual({ role: "user", content: second.feedback });
  expect(second.feedback).toContain("NEAR:"); expect(second.feedback).toContain("CLOSER:");
  expect(second.feedback).toContain("System-generated review guidance; not a human ruling or adoption evidence.");
  const prompt = readFileSync(new URL("../prompts/consolidation.md", import.meta.url), "utf8");
  const section = prompt.split("### Second-round user message\n")[1]!.split("\n### ")[0]!;
  expect(second.feedback!.endsWith(section)).toBe(true);
  expect(second.feedback!.split(section)).toHaveLength(2);
  const closer = second.feedback!.split("CLOSER:\n\n")[1]!.split(section)[0]!;
  expect(closer).toContain(`[K${e}@${e}]`); expect(closer).toContain(`[K${goal}@${goal}]`); expect(closer).toContain(memory.trace(`F${f}`));
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
  const result = await consolidation(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.unansweredNear).toHaveLength(["unchanged", "archive"].includes(resolution) ? 1 : 0);
  expect(memory.store.currentCommit(e)[0]?.id).toBe(["update", "merge", "archive"].includes(resolution) ? 4 : 1);
  expect(consolidated(f)).toBe(true);
  expect(calls).toHaveLength(2);
});

test("NEAR covers create, update and merge text, excludes each target, and uses threshold on character bigram sets", async () => {
  const f = fact(), a = knowledge([f]), b = knowledge([f]), c = knowledge([f], { text: memories.observation });
  const op = { text: memories.knowledge, scope: "project", category: "mechanism", supports: [`F${f}`], because: [] };
  const output = { ...empty, operations: [...createOutput(f).operations, { op: "update", ...op, id: `K${a}` }, { op: "merge", ...op, id: `K${b}`, absorb: [`K${c}`] }] };
  queue(output, output); const result = await consolidation(); if (result.outcome !== "success") throw new Error("expected success");
  const feedback = calls[1]!.feedback!.split("CLOSER:")[0]!;
  expect(feedback).toContain(`$e1 -> K${a} (Jaccard 1)`); expect(feedback).toContain(`$e1 -> K${b} (Jaccard 1)`);
  expect(feedback).toContain(`K${a} -> K${b} (Jaccard 1)`); expect(feedback).toContain(`K${b} -> K${a} (Jaccard 1)`);
  expect(feedback).not.toContain(`K${a} -> K${a}`); expect(feedback).not.toContain(`K${b} -> K${b}`);
  expect(feedback).not.toContain(`-> K${c}`);
  memory.close(); open({ consolidation: { nearThreshold: 1, subagentModeDefault: false } });
  fact(); queue(createOutput(f, memories.base), empty); await consolidation();
  expect(calls[3]!.feedback).toContain("NEAR:\n\nnone"); expect(calls[2]!.mode).toBe("fork");
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
    const result = await consolidation();
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
    expect(memory.store.listConsolidatedProjectFacts(projectId)).toEqual([]);
    queue(empty, empty); expect((await consolidation()).outcome).toBe("success");
  });
}

test("duplicate trigger is dropped across facades during either round; different branches and sessions of the project remain independent", async () => {
  fact(); const resolveFirst = deferred(), pending = consolidation();
  const other = TraceMemory(join(directory, "test.sqlite"), async () => { throw new Error("must not call"); });
  try {
    expect(await other.consolidate({ sessionId, branch: "main" })).toEqual({ outcome: "dropped" });
    expect(await consolidation("other")).toEqual({ outcome: "empty" });
    expect(await memory.consolidate({ sessionId: session(), branch: "main" })).toEqual({ outcome: "empty" });
    const resolveFinal = deferred(); resolveFirst(empty);
    // Let the candidate record and final model call finish entering the deferred seam.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls.at(-1)!.round).toBe("final");
    expect(await consolidation()).toEqual({ outcome: "dropped" });
    resolveFinal(empty); expect((await pending).outcome).toBe("success");
    expect(calls).toHaveLength(2);
  } finally { other.close(); }
});

test("empty ranges do not call the agent or create records", async () => {
  expect(await consolidation()).toEqual({ outcome: "empty" }); expect(memory.store.getRun(1)).toBeNull();
  const f = fact(); watermark(f); expect(await consolidation()).toEqual({ outcome: "empty" });
  expect(memory.store.getRun(3)).toBeNull(); expect(calls).toEqual([]);
});

test("context uses timestamp freshness while range remains complete and categories follow noting budgets", async () => {
  const newest = fact(memories.base, { createdAt: "2026-08-17" }), oldest = fact(memories.observation, { createdAt: "2026-08-15" });
  const categories = ["constraint", "open", "dispute", "goal", "mechanism", "term", "reference"] as const;
  for (const category of categories) knowledge([newest], { category });
  watermark(newest); watermark(oldest); const current = fact(memories.interpretation);
  queue(empty, empty); await consolidation();
  const input = calls[0]!.text.fresh;
  expect(input.indexOf(`[F${newest}]`)).toBeLessThan(input.indexOf(`[F${oldest}]`));
  for (let i = 1; i < categories.length; i++) expect(input.indexOf(`[${categories[i - 1]}/project]`)).toBeLessThan(input.indexOf(`[${categories[i]}/project]`));
  memory.close(); open({ render: { knowledgeBlockTokens: 1, episodicBlockTokens: 1 } });
  const next = fact(memories.interpretation);
  queue(empty, empty); await consolidation(); const small = calls[2]!.text.fresh;
  expect(small).toContain(memory.trace(`F${next}`));
  expect(small).not.toContain(`[F${newest}]`); expect(small).not.toContain(`[F${oldest}]`);
  expect(small).toContain("omitted 3 older facts");
  // 20b: the knowledge cap is hard, so a one-token budget keeps no category at all — not even the
  // three that 17b's exemption protected — and every omission is receipted and still traceable.
  for (const category of categories) { expect(small).not.toContain(`[${category}/project]`); expect(small).toContain(`omitted 1 ${category} knowledge`); }
  expect(calls[2]!.readKnowledgeCommits).toHaveLength(7);
});

test("bigram Jaccard has a known nontrivial score and an inclusive configurable threshold", async () => {
  const f = fact(), e = knowledge([f]);
  // The two fixture strings share eight bigrams; their union has twelve.
  // The longer fact inserts three bigrams and replaces one shared boundary.
  memory.close(); open({ consolidation: { nearThreshold: 2 / 3 } });
  queue(createOutput(f, memories.base), createOutput(f, memories.base));
  const result = await consolidation(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.unansweredNear).toEqual([{ candidate: "$e1", knowledge: `K${e}`, score: 2 / 3 }]);
  memory.close(); open({ consolidation: { nearThreshold: 2 / 3 + 0.001 } });
  fact(); queue(createOutput(f, memories.base), empty); await consolidation();
  expect(calls[3]!.feedback).not.toContain(`-> K${e} (`);
});

const updateOutput = (id: number, support: number) => ({ ...empty, operations: [{ op: "update", id: `K${id}`, text: memories.editedKnowledge, category: "mechanism", scope: "project", supports: [`F${support}`], because: [`F${support}`] }] });
const decline = (...ids: number[]) => ids.map((id) => ({ fact: `F${id}`, because: "Not durable." }));

test("accounting diagnoses uncited user facts and agent questions, then accepts explicit skipped facts", async () => {
  const user = fact(), question = fact(memories.base, { actor: "agent", category: "question" });
  fact(memories.observation, { actor: "agent" });
  const output = { ...empty }; queue(output, output);
  const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected diagnostic success");
  expect(result.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [`F${user}`, `F${question}`] });
  expect(audit(result.runId, 1).diagnostics).toEqual(result.diagnostics);
  expect(memory.store.listVisibleKnowledge(sessionId, projectId)).toEqual([]);
  const later = fact(); queue(output, { ...output, skipped: decline(later) });
  const skipped = await consolidation();
  if (skipped.outcome !== "success") throw new Error("expected success");
  expect(skipped.diagnostics).toEqual([]);
});

for (const operation of ["update", "archive", "merge"] as const) test(`accounting evaluates supports after ${operation}`, async () => {
  const f = fact(), other = fact(memories.observation, { actor: "agent" }), e = knowledge([f]), survivor = knowledge([other]);
  const output = operation === "update" ? updateOutput(e, other) : operation === "archive"
    ? { ...empty, operations: [{ op: "archive", id: `K${e}`, because: [`F${other}`] }] }
    : { ...empty, operations: [{ ...updateOutput(survivor, other).operations[0], op: "merge", id: `K${survivor}`, absorb: [`K${e}`] }] };
  queue(output, output); const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected diagnostic success");
  expect(result.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [`F${f}`] });
  expect(memory.store.currentCommit(e)[0]?.op).toBe(operation === "archive" ? "archive" : operation === "merge" ? undefined : "update");
});

test("a target that moved on bounces the whole batch, audits the rejection and preserves the watermark", async () => {
  const old = fact(), e = knowledge([old]); watermark(old);
  const lost = fact(), kept = fact(memories.observation);
  const output = { ...empty, operations: [...createOutput(kept).operations, ...updateOutput(e, lost).operations.map(op => ({ ...op, supports: [`F${lost}`, `F${kept}`] }))] };
  queue(output); const resolve = deferred(), pending = consolidation();
  await new Promise((r) => setTimeout(r, 0));
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: time }, operations: [{ op: "update", knowledgeId: e,
    baseCommit: 1, text: memories.base, category: "mechanism", scope: "project", supports: [old], because: [], createdAt: time }] });
  resolve(output); const result = await pending;
  if (result.outcome !== "bounced") throw new Error("expected atomic bounce");
  expect(result.problems.join(" ")).toContain("current: K1@2");
  expect(memory.store.getKnowledge(e + 1)).toBeNull();
  expect(audit(result.runId, 1, "bounced").toolCalls.at(-1).result).toContain("rejected:");
  expect(consolidated(old)).toBe(true);
  expect(memory.trace(`F${lost}`)).toContain(memories.base);
  expect(JSON.parse(memory.store.getRun(result.runId)!.response!).toolCalls).toHaveLength(2);
});

test("merge records survivor revision, absorbed links, and trace history", async () => {
  const a = fact(), b = fact(memories.observation), survivor = knowledge([a]), absorbed = knowledge([b]);
  const output = { ...empty, operations: [{ op: "merge", id: `K${survivor}`, absorb: [`K${absorbed}`], text: memories.editedKnowledge, category: "mechanism", scope: "project", supports: [`F${a}`, `F${b}`], because: [`F${b}`] }] };
  queue(output, output); const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toEqual([{ op: "merge", knowledgeId: survivor, commit: 3 }]);
  expect(memory.store.listKnowledgeLinks(absorbed)).toEqual([{ fromKnowledge: absorbed, fromCommit: 2, kind: "merged_into", toKnowledge: survivor, toCommit: 3 }]);
  expect(memory.trace(`K${absorbed}`)).toContain(`K${survivor}@3`);
  expect(memory.trace(`K${survivor}`)).toContain("merge");
  expect(memory.trace(`K${survivor}@1..K${survivor}@3`)).toContain(`F${b}`);
  expect(memory.store.getKnowledgeRevision(survivor, 3)?.because).toEqual([b]);
});

test("numbers, token overage and unanswered NEAR are diagnostics, never gates", async () => {
  const f = fact("Measured 12 samples.", { quote: "Confirmed 42." }); knowledge([f], { text: "Measured 12 samples." });
  const output = createOutput(f, "Measured 12 samples. 42 2 999 " + "the noter writes facts that cite their source. ".repeat(30));
  queue(createOutput(f, "Measured 12 samples."), output); const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toHaveLength(1);
  expect(result.diagnostics).toContainEqual({ kind: "unsupported_numbers", knowledge: "$e1", numbers: ["2", "999"] });
  expect(result.diagnostics).toContainEqual({ kind: "over_200_tokens", knowledge: "$e1", tokens: tokens(output.operations[0]!.text) });
  expect(result.diagnostics).toContainEqual({ kind: "unanswered_near", pairs: result.unansweredNear });
  expect(audit(result.runId, 1).diagnostics).toEqual(result.diagnostics);
});

for (const bad of ["missing fact", "foreign fact", "late fact", "unread knowledge", "duplicate handle", "duplicate target", "empty merge"] as const) test(`resolution bounces: ${bad}`, async () => {
  const f = fact(), e = knowledge([f]);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.base, { sessionId: session(foreignProject) });
  queue(createOutput(f)); const resolve = deferred(), pending = consolidation();
  await new Promise((r) => setTimeout(r, 0));
  const late = fact(), unread = knowledge([late]);
  const output = bad === "unread knowledge" ? updateOutput(unread, f)
    : bad === "duplicate target" ? { ...empty, operations: [...updateOutput(e, f).operations, { op: "archive", id: `K${e}`, because: [] }] }
    : bad === "empty merge" ? { ...empty, operations: [{ ...updateOutput(e, f).operations[0], op: "merge", id: `K${e}`, absorb: [] }] }
    : bad === "duplicate handle" ? { operations: [{ ...createOutput(f).operations[0], handle: "$e1" }], skipped: [] }
    : createOutput(bad === "missing fact" ? 999999 : bad === "foreign fact" ? foreign : late);
  resolve(output); const result = await pending;
  expect(result.outcome).toBe("bounced");
  expect(memory.store.listConsolidatedProjectFacts(projectId)).toEqual([]);
  expect(memory.store.currentCommit(e)[0]?.id).toBe(1);
});

test("each session settles only its own branch facts and shares already-settled context", async () => {
  const first = fact(), secondSession = session();
  const second = fact(memories.observation, { sessionId: secondSession, branch: "fork" });
  queue(createOutput(second), createOutput(second));
  const other = await memory.consolidate({ sessionId: secondSession, branch: "fork" });
  if (other.outcome !== "success") throw new Error("expected success");
  expect(other.range.facts.map((f) => f.id)).toEqual([second]);
  expect(calls[0]!.text.fresh).not.toContain(`[F${first}]`);
  queue(createOutput(first), createOutput(first));
  const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range.facts.map((f) => f.id)).toEqual([first]);
  expect(calls[2]!.text.fresh).toContain(memory.trace(`F${second}`));
  expect(consolidated(second, "fork", secondSession)).toBe(true);
  expect(consolidated(first)).toBe(true);
  expect(await consolidation()).toEqual({ outcome: "empty" });
  const fork = fact(memories.interpretation, { branch: "fork" });
  expect(await consolidation()).toEqual({ outcome: "empty" });
  queue(createOutput(fork), createOutput(fork));
  const forkResult = await consolidation("fork");
  if (forkResult.outcome !== "success") throw new Error("expected success");
  expect(forkResult.range.facts.map((f) => f.id)).toEqual([fork]);
});

test("consolidation revisions and success record roll back if progress marking fails", async () => {
  const f = fact(), output = createOutput(f); queue(output, output);
  const original = memory.store.markConsolidated;
  memory.store.markConsolidated = () => { throw new Error("progress write failed"); };
  try {
    const result = await consolidation(); expect(result.outcome).toBe("failure");
    expect(memory.store.listVisibleKnowledge(sessionId, projectId)).toEqual([]);
    expect(memory.store.listConsolidatedProjectFacts(projectId)).toEqual([]);
    if (result.outcome !== "failure") throw new Error("expected failure");
    expect(memory.store.getRun(result.runId)?.outcome).toBe("failure");
    expect(JSON.parse(memory.store.getRun(result.runId)!.response!).problems).toEqual(result.problems);
  } finally { memory.store.markConsolidated = original; }
});

test("simulation v7m fixture consolidates through the facade with traceable Chinese evidence", async () => {
  const fixture = JSON.parse(readFileSync(new URL("../../test/fixtures/consolidation.json", import.meta.url), "utf8"));
  const ids = new Map<number, number>();
  for (const source of fixture.facts) ids.set(source.id, fact(source.text, { actor: source.actor, category: source.category, quote: source.quote, createdAt: source.timestamp }));
  const output = { ...empty, operations: [{ op: "create", ...fixture.knowledge, supports: fixture.knowledge.supports.map((id: string) => `F${ids.get(Number(id.slice(1)))}`), because: fixture.knowledge.supports.map((id: string) => `F${ids.get(Number(id.slice(1)))}`) }] };
  queue(output, output); const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toHaveLength(1);
  expect(memory.trace(`K${result.committed[0]!.knowledgeId}`)).toContain(fixture.knowledge.text);
  for (const source of fixture.facts) expect(memory.trace(`F${ids.get(source.id)}`)).toContain(source.text);
});

test("an archived target bounces the whole batch and preserves the watermark and audit", async () => {
  const old = fact(), e = knowledge([old]); watermark(old); const f = fact();
  const output = { ...empty, operations: [...createOutput(f).operations, ...updateOutput(e, f).operations] };
  queue(output); const resolve = deferred(), pending = consolidation();
  await new Promise((r) => setTimeout(r, 0));
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: time }, operations: [{ op: "archive", knowledgeId: e,
    baseCommit: 1, because: [old], createdAt: time }] });
  resolve(output); const result = await pending;
  if (result.outcome !== "bounced") throw new Error("expected atomic bounce");
  expect(result.problems.join(" ")).toContain("target moved on or is inactive");
  expect(memory.store.getKnowledge(e + 1)).toBeNull();
  expect(consolidated(old)).toBe(true);
  // No operation commits; the entire batch remains available for a fresh run.
  expect(JSON.parse(memory.store.getRun(result.runId)!.response!).toolCalls).toHaveLength(2);
});

test("because addresses are resolved but do not satisfy accounting", async () => {
  const f = fact(), other = fact(memories.observation, { actor: "agent" }), e = knowledge([other]);
  const output = { ...empty, operations: [{ op: "update", ...updateOutput(e, other).operations[0], because: [`F${f}`] }] };
  queue(output, output); const first = await consolidation();
  if (first.outcome !== "success") throw new Error("expected diagnostic success");
  expect(first.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [`F${f}`] });
  fact();
  queue(output, { ...output, operations: [{ op: "update", ...output.operations[0], because: ["F999999"] }] });
  const bad = await consolidation();
  if (bad.outcome !== "bounced") throw new Error("expected bounce");
  expect(bad.problems.join(" ")).toContain("F999999");
});

test("a different project can consolidation while this project is in flight", async () => {
  const f = fact(), resolve = deferred(), pending = consolidation();
  const project = memory.store.createProject({ name: "independent", declaredBy: "mark" }).id, owner = session(project);
  const other = fact(memories.observation, { sessionId: owner });
  queue(createOutput(other), createOutput(other));
  expect((await memory.consolidate({ sessionId: owner, branch: "main" })).outcome).toBe("success");
  queue(createOutput(f)); resolve(createOutput(f)); expect((await pending).outcome).toBe("success");
});

test("exactly 200 estimated tokens is accepted without a length diagnostic", async () => {
  const f = fact(), output = createOutput(f, "x".repeat(800)); queue(output, output);
  const result = await consolidation(); if (result.outcome !== "success") throw new Error("expected success");
  expect(result.diagnostics).toEqual([]);
});

test("narrowing another session's global knowledge cannot conceal an uncited fact", async () => {
  const f = fact(), e = knowledge([f], { scope: "global", sessionId: session() });
  const other = fact(memories.observation, { actor: "agent" });
  const output = { ...empty, operations: [{ op: "update", ...updateOutput(e, other).operations[0], scope: "session" }] };
  queue(output, output); const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected diagnostic success");
  expect(result.diagnostics).toContainEqual({ kind: "uncited_facts", facts: [`F${f}`] });
  expect(memory.store.currentCommit(e, memory.store.knowledgePath(sessionId))[0]?.scope).toBe("session");
});


test("same-project sessions commit independently while another session is pending", async () => {
  const first = fact(), otherSession = session();
  const second = fact(memories.observation, { sessionId: otherSession });
  const resolve = deferred(), pending = consolidation();
  queue(createOutput(second), createOutput(second));
  const other = await memory.consolidate({ sessionId: otherSession, branch: "main" });
  if (other.outcome !== "success") throw new Error("expected success");
  expect(other.range.facts.map((f) => f.id)).toEqual([second]);
  queue(createOutput(first)); resolve(createOutput(first));
  const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range.facts.map((f) => f.id)).toEqual([first]);
  expect(consolidated(first)).toBe(true);
  expect(consolidated(second, "main", otherSession)).toBe(true);
});

test("19b 2026-09-08: Consolidation material carries the exact fact list, the fact lines and the knowledge in either mode", async () => {
  const first = fact(); const second = fact(memories.observation);
  await memory.consolidate({ sessionId, branch: "main", mode: "subagent" }); // the queue is empty; only the frozen material matters here
  await memory.consolidate({ sessionId, branch: "main", mode: "fork" });
  for (const call of calls) {
    // The exact set, not the F..F span: what an inherited context integrates is a membership list.
    expect(call.material.factAddresses).toEqual([`F${first}`, `F${second}`]);
    expect(call.material.rangeFacts.join("\n")).toContain(memory.trace(`F${first}`));
    expect(call.material.knowledge.map(g => g.text).join("\n")).toBe(calls[0]!.material.knowledge.map(g => g.text).join("\n"));
  }
  expect(calls[0]!.mode).toBe("subagent"); expect(calls[1]!.mode).toBe("fork");
  // Core froze one material for both modes; which parts each mode sends is pinned in hosts/pi/compose.test.ts.
  expect(calls[1]!.material).toEqual(calls[0]!.material);
});

// ----------------------------------------------------------- 20b: token triggers and token batches

/** The rendered representation of the applicable unconsolidated facts: the same `renderFact` lines,
 * with their relations and their joining separator, that the trigger and the selection both count. */
const applicableTokens = (branch = "main") =>
  tokens(memory.store.consolidationBatch(sessionId, branch, memory.store.knowledgePath(sessionId, branch).headTurnId ?? undefined)
    .map(f => memory.trace(`F${f.id}`)).join("\n"));
const due = (branch = "main") => memory.taskEligibility("consolidation",
  { sessionId, branch, headTurnId: memory.store.knowledgePath(sessionId, branch).headTurnId! }, "subagent").due;

/** Ticket 20 acceptance scenario 6, superseding 17b's fifty-fact trigger: the same rendered fact view
 * decides both admission and selection, and neither historical facts nor knowledge contribute. */
test("20b 2026-09-08 scenario 6: Consolidation is due on rendered fact tokens, exactly at the trigger, and one batch takes at most its token ceiling", async () => {
  const short = Array.from({ length: 8 }, () => fact(memories.base));
  const rendered = applicableTokens();
  expect(short).toHaveLength(8);
  // Exactly at the trigger the run is due; one token more of trigger and it waits — a count would see
  // eight facts either way.
  memory.close(); open({ consolidation: { triggerTokens: rendered } });
  expect(due()).toBe(true);
  memory.close(); open({ consolidation: { triggerTokens: rendered + 1 } });
  expect(due()).toBe(false);
  // Historical (already-consolidated) facts and knowledge are not part of the trigger.
  watermark(short[0]!); knowledge([short[0]!], { text: "word ".repeat(400) });
  expect(applicableTokens()).toBeLessThan(rendered);
  // The batch takes the oldest-first whole-fact prefix that fits its own ceiling, in arrival order.
  const lines = memory.store.consolidationBatch(sessionId, "main", memory.store.knowledgePath(sessionId, "main").headTurnId ?? undefined).map(f => memory.trace(`F${f.id}`));
  const cap = tokens(lines.slice(0, 3).join("\n"));
  memory.close(); open({ consolidation: { triggerTokens: 1, batchTokens: cap } });
  queue(empty, empty);
  const result = await consolidation();
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range.facts.map(f => f.id)).toEqual(short.slice(1, 4)); // three facts, oldest first
  expect(tokens(calls[0]!.material.rangeFacts.join("\n"))).toBeLessThanOrEqual(cap);
  expect(memory.store.consolidationBatch(sessionId, "main", memory.store.knowledgePath(sessionId, "main").headTurnId ?? undefined).map(f => f.id)).toEqual(short.slice(4));
});

/** Ticket 20 acceptance scenario 7. Progress is the exact selected fact ids: no Turn gate, no
 * watermark over the range label, no cross-branch leakage, nothing advanced by a failed batch. */
test("20b 2026-09-08 scenario 7: successive token-bounded batches advance exactly their selected fact ids, and a failed batch advances nothing", async () => {
  const first = fact(memories.base), second = fact(memories.observation), third = fact(memories.interpretation);
  const lines = [first, second, third].map(id => memory.trace(`F${id}`));
  // A ceiling that holds any one of these fact lines but never two: one whole fact per batch.
  memory.close(); open({ consolidation: { triggerTokens: 1, batchTokens: Math.max(...lines.map(line => tokens(line))) } });
  // A failed first batch advances nothing at all.
  script.push(async () => ({ outcome: "failure", output: "provider failed", request: {} }));
  expect((await consolidation()).outcome).toBe("failure");
  expect(consolidated(first)).toBe(false);
  queue(empty, empty);
  const one = await consolidation();
  expect(one.outcome === "success" && one.range.facts.map(f => f.id)).toEqual([first]);
  expect(consolidated(first)).toBe(true);
  expect(consolidated(second)).toBe(false); // no watermark: the range label is not an id cursor
  queue(empty, empty);
  const two = await consolidation();
  expect(two.outcome === "success" && two.range.facts.map(f => f.id)).toEqual([second]);
  // A fact committed later on an earlier Turn stays eligible and is taken by a later batch.
  const late = memory.store.commitNotingRun({ run: { kind: "manual", sessionId, branch: "main", createdAt: time },
    facts: [{ turnId: memory.store.getFact(first)!.turnId, category: "observation", actor: "user", text: memories.observation, source: [`T${memory.store.getFact(first)!.turnId}#user`], createdAt: time }] });
  if (!late.ok) throw new Error(late.problems.join("; "));
  const lateId = late.facts[0]!.id;
  const remaining = memory.store.consolidationBatch(sessionId, "main", memory.store.knowledgePath(sessionId, "main").headTurnId ?? undefined).map(f => f.id);
  expect(remaining).toEqual([third, lateId]);
  queue(empty, empty);
  const three = await consolidation();
  expect(three.outcome === "success" && three.range.facts.map(f => f.id)).toEqual([third]);
  expect(consolidated(lateId)).toBe(false); // the hole between ids is not processed by implication
});

/** Ticket 20 "Oversized fact" and acceptance scenario 8. A fact has no primary-entry-style size
 * bound, so an oldest one that cannot fit alone stays pending with a capacity problem: it is not
 * clipped, not skipped for a smaller later fact, and not marked consolidated without being presented. */
test("20b 2026-09-08 scenario 8: an oldest fact over the batch ceiling stays pending with a capacity problem and is never bypassed", async () => {
  const huge = fact("word ".repeat(400)), small = fact(memories.base);
  const cap = tokens(memory.trace(`F${huge}`)) - 1;
  memory.close(); open({ consolidation: { triggerTokens: 1, batchTokens: cap } });
  script.push(async () => { throw new Error("no model call may happen"); });
  await expect(consolidation()).rejects.toThrow("Consolidation capacity: oldest fact exceeds consolidation.batchTokens");
  expect(calls).toEqual([]);
  expect(memory.store.listRuns(sessionId).filter(r => r.kind === "consolidation")).toEqual([]);
  expect(consolidated(huge)).toBe(false);
  expect(consolidated(small)).toBe(false); // the smaller later fact did not jump the queue
  expect(memory.trace(`F${huge}`)).toContain("word word"); // the evidence text is untouched
});
