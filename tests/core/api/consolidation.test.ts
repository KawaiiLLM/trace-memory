import { afterEach, beforeEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, tokens, type ConsolidationAgentInput as CoreInput, type RunAgentResult, type ConfigOverride } from "../../source-fixture.ts";
import memories from "../../fixtures/noting/facts.json";
import { charge, renderFactGroups } from "../../../src/core/render/index.ts";
import { RANGE_FACTS_TITLE } from "../../../src/core/render/material.ts";
import type { Fact } from "../../../src/core/model/index.ts";

type ConsolidationAgentInput = CoreInput & { request?: any; response?: RunAgentResult };
let directory: string, memory: ReturnType<typeof sourceSeededMemory>, sessionId: number, projectId: number;
let calls: ConsolidationAgentInput[], script: ((input: ConsolidationAgentInput) => Promise<RunAgentResult>)[];
const time = "2026-08-16 02:54";
const empty = { operations: [], skipped: [] };
const success = (output: unknown, input: ConsolidationAgentInput): RunAgentResult => ({ outcome: "success", output: output === empty ? { ...empty, skipped: input.range.facts.map(f => ({ fact: `F${f.id}`, because: "Not retained in this test." })) } : output,
  usage: { tokens: 12 }, request: input.request });
function open(config: ConfigOverride = {}) {
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async (raw) => {
    // A stub host: it receives structured material and never a core-composed message, and builds its
    // own provider record out of the material, the tool rounds and core's review feedback (19b).
    const input = raw as ConsolidationAgentInput;
    const guidance = input.tools.find(t => t.name === "trace")!.description;
    expect(guidance).toContain("trace({address:'K12@v3',itemBudget:null})");
    expect(guidance).toContain("pageBudget still applies");
    expect(guidance).toContain("complete body carries its exact K#tag");
    expect(guidance).not.toContain("granted");
    const rounds: any[] = [{ material: structuredClone(input.material) }];
    for (;;) {
      input.request = { system: input.prompt, rounds: structuredClone(rounds), tools: input.tools.map(({execute, ...tool}) => tool) };
      input.reportRequest(input.request); calls.push(input);
      const next = script.shift(); if (!next) throw new Error("unexpected call");
      const response = await next(input); input.response = response;
      if (response.outcome !== "success" || response.request == null) return response;
      // The fake provider now names the exact version in its supplied material. This changes
      // only participants the script selected; it neither grants reads nor resolves live tips.
      const batch = structuredClone(response.output) as { operations?: { id?: string; absorb?: string[] }[] };
      const suppliedHandle = (address: string) => {
        const handles = input.text.match(new RegExp(`${address}#[a-z]{4,}`, "g")) ?? [];
        return new Set(handles).size === 1 ? handles[0]! : address;
      };
      for (const op of batch.operations ?? []) {
        if (op.id) op.id = suppliedHandle(op.id);
        if (op.absorb) op.absorb = op.absorb.map(suppliedHandle);
      }
      const receipt = input.tools.find(t => t.name === "memory")!.execute(batch);
      rounds.push({ toolCall: { name: "memory", arguments: batch } }, { toolResult: receipt });
      if (!receipt.includes("rejected:") || !script.length) return { ...response, output: "done", request: input.request };
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
    op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "fake", text: options.text ?? memories.knowledge, supports, createdAt: time,
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
const createOutput = (support: number, text = memories.knowledge) => ({ ...empty, operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", text, category: "mechanism" as const, scope: "project" as const, supports: [`F${support}`] }] });
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
  expect(JSON.parse(run.response!)).not.toHaveProperty("readKnowledgeCommits");
  return JSON.parse(run.response!);
}


test("freezes branch, range, supplied knowledge and relations until its single valid commit", async () => {
  const old = fact(), existing = knowledge([old], { category: "open" }); watermark(old);
  const current = fact(memories.knowledge);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.observation, { sessionId: session(foreignProject) });
  const before = memory.trace(`K${existing}`), resolve = deferred();
  const selection = { sessionId, branch: "main", model: "fake-model", mode: "subagent" as const };
  const pending = memory.consolidate(selection);
  selection.branch = "switched";
  await new Promise(resolveTick => setTimeout(resolveTick, 0));
  const late = fact(memories.observation, { negate: [{ target: `F${current}`, strength: "strong" }] });
  const laterKnowledge = knowledge([late], { text: memories.editedKnowledge });
  resolve(createOutput(current));
  const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range).toEqual({ from: `F${current}`, to: `F${current}`, facts: [memory.store.getFact(current)!] });
  expect(result).not.toHaveProperty("readKnowledgeCommits");
  expect(calls).toHaveLength(1);
  const call = calls[0]!;
  expect(call.branch).toBe("main"); expect(call.model).toBe("fake-model"); expect(call.mode).toBe("subagent");
  expect(call.text).not.toContain(`[F${late}]`); expect(call.text).not.toContain(`[F${foreign}]`);
  expect(call.text).not.toContain(`inbound negate F${late}`); expect(call.text).not.toContain(`[K${laterKnowledge}@`);
  expect(call.text).toContain(`[K${existing}#${memory.store.versionTag(existing, existing)}]`);
  expect(audit(result.runId, 0).toolCalls).toHaveLength(1);
  expect(memory.trace(`K${existing}`)).toBe(before);
  expect(consolidated(current)).toBe(true);
});


for (const bad of ["json", "shape", "failure", "cancelled", "missing request", "throw", "abort"] as const) {
  test(`${bad} records the exact attempt, returns problems and releases deduplication`, async () => {
    fact();
    script.push(async (input) => {
      if (bad === "throw" || bad === "abort") { const error = new Error("stopped"); error.name = bad === "abort" ? "AbortError" : "Error"; throw error; }
      if (bad === "failure" || bad === "cancelled") return { ...success(empty, input), outcome: bad, output: "stopped" };
      if (bad === "missing request") return { outcome: "success", output: "{}" };
      return { ...success(empty, input), output: bad === "json" ? "{" : { operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", category: "invalid" }], skipped: [] } };
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
    audit(result.runId, 0, run.outcome as RunAgentResult["outcome"]);
    expect(memory.store.getRun(result.runId + 1)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(memory.store.listConsolidatedProjectFacts(projectId)).toEqual([]);
    queue(empty, empty); expect((await consolidation()).outcome).toBe("success");
  });
}

test("duplicate trigger is dropped while one Consolidation request is in flight; different branches and sessions remain independent", async () => {
  fact(); const resolve = deferred(), pending = consolidation();
  const other = sourceSeededMemory(join(directory, "test.sqlite"), async () => { throw new Error("must not call"); });
  try {
    expect(await other.consolidate({ sessionId, branch: "main" })).toEqual({ outcome: "dropped" });
    expect(await consolidation("other")).toEqual({ outcome: "empty" });
    expect(await memory.consolidate({ sessionId: session(), branch: "main" })).toEqual({ outcome: "empty" });
    resolve(empty); expect((await pending).outcome).toBe("success");
    expect(calls).toHaveLength(1);
  } finally { other.close(); }
});

test("empty ranges do not call the agent or create records", async () => {
  expect(await consolidation()).toEqual({ outcome: "empty" }); expect(memory.store.getRun(1)).toBeNull();
  const f = fact(); watermark(f); expect(await consolidation()).toEqual({ outcome: "empty" });
  expect(memory.store.getRun(3)).toBeNull(); expect(calls).toEqual([]);
});

// 25a removed the already-consolidated context block, so the freshness half of this scenario no
// longer has a subject here; it survives on the Noter's history block, pinned in noting.test.ts
// ("selected historical facts display by Turn time rather than insertion id"). The knowledge half is
// unchanged, and the removal itself is pinned below.
test("already-consolidated facts are not supplied while the range remains complete, and categories keep presentation order", async () => {
  const newest = fact(memories.base, { createdAt: "2026-08-17" }), oldest = fact(memories.observation, { createdAt: "2026-08-15" });
  const categories = ["constraint", "open", "dispute", "goal", "mechanism", "term", "reference"] as const;
  for (const category of categories) knowledge([newest], { category });
  watermark(newest); watermark(oldest); const current = fact(memories.interpretation);
  // The two consolidated facts are stored and readable; neither is injected, and the range is exactly
  // the one fact that is still pending.
  expect(memory.store.listConsolidatedProjectFacts(projectId).map(f => f.id).sort()).toEqual([newest, oldest].sort());
  queue(empty, empty); await consolidation();
  const input = calls[0]!.text;
  expect(input).not.toContain(`[F${newest}]`);
  expect(input).not.toContain(`[F${oldest}]`);
  expect(input).toContain(`[F${current}]`);
  expect(calls[0]!.range.facts.map(f => f.id)).toEqual([current]);
  for (let i = 1; i < categories.length; i++) expect(input.indexOf(`[${categories[i - 1]}/project]`)).toBeLessThan(input.indexOf(`[${categories[i]}/project]`));
  // Ticket 45 retires the synthetic per-Consolidator cap; database-policy boundary cases are pinned
  // separately, while this older test keeps its fact/history and category-presentation contract.
});


const updateOutput = (id: number, support: number) => ({ ...empty, operations: [{ op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", id: `K${id}`, text: memories.editedKnowledge, category: "mechanism", scope: "project", supports: [`F${support}`] }] });
const decline = (...ids: number[]) => ids.map((id) => ({ fact: `F${id}`, because: "Not durable." }));






test("32d: Consolidator merge cannot create a survivor revision or absorbed links", async () => {
  const a = fact(), b = fact(memories.observation), survivor = knowledge([a]), absorbed = knowledge([b]);
  const output = { ...empty, operations: [{ op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", id: `K${survivor}`, absorb: [`K${absorbed}`], text: memories.editedKnowledge, category: "mechanism", scope: "project", supports: [`F${a}`, `F${b}`] }] };
  queue(output, output); const result = await consolidation();
  expect(result.outcome).toBe("bounced");
  expect("problems" in result && result.problems?.join()).toContain("Dreamer");
  expect(memory.store.listKnowledgeLinks(absorbed)).toEqual([]);
  expect(memory.store.getKnowledgeRevision(survivor, 3)).toBeNull();
  expect(memory.store.currentKnowledge()).toHaveLength(2);
});

test("numbers and token overage are diagnostics, never gates", async () => {
  const f = fact("Measured 12 samples.", { quote: "Confirmed 42." }); knowledge([f], { text: "Measured 12 samples." });
  const output = createOutput(f, "Measured 12 samples. 42 2 999 " + "the noter writes facts that cite their source. ".repeat(30));
  queue(output); const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toHaveLength(1);
  expect(result.diagnostics).toContainEqual({ kind: "unsupported_numbers", knowledge: "$e1", numbers: ["2", "999"] });
  expect(result.diagnostics).toContainEqual({ kind: "over_200_tokens", knowledge: "$e1", tokens: tokens(output.operations[0]!.text) });
  expect(audit(result.runId, 0).diagnostics).toEqual(result.diagnostics);
});

for (const bad of ["missing fact", "foreign fact", "late fact", "unread knowledge", "duplicate handle", "duplicate target", "empty merge"] as const) test(`resolution bounces: ${bad}`, async () => {
  const f = fact(), e = knowledge([f]);
  const foreignProject = memory.store.createProject({ name: "foreign", declaredBy: "mark" }).id;
  const foreign = fact(memories.base, { sessionId: session(foreignProject) });
  const resolve = deferred(), pending = consolidation();
  await new Promise((r) => setTimeout(r, 0));
  const late = fact(), unread = knowledge([late]);
  const output = bad === "unread knowledge" ? updateOutput(unread, f)
    : bad === "duplicate target" ? { ...empty, operations: [...updateOutput(e, f).operations, { op: "archive", reason: "Retired: the cited evidence withdraws this conclusion.", id: `K${e}`, supports: [] }] }
    : bad === "empty merge" ? { ...empty, operations: [{ ...updateOutput(e, f).operations[0], op: "merge", topics: [], reason: "Merged duplicate knowledge into the survivor.", id: `K${e}`, absorb: [] }] }
    : bad === "duplicate handle" ? { operations: [{ ...createOutput(f).operations[0], handle: "$e1" }], skipped: [] }
    : createOutput(bad === "missing fact" ? 999999 : bad === "foreign fact" ? foreign : late);
  resolve(output); const result = await pending;
  expect(result.outcome).toBe("bounced");
  expect(memory.store.listConsolidatedProjectFacts(projectId)).toEqual([]);
  expect(memory.store.currentCommit(e)[0]?.id).toBe(1);
});

test("each session settles only its own branch facts; another session's settled facts stay readable but unsupplied", async () => {
  const first = fact(), secondSession = session();
  const second = fact(memories.observation, { sessionId: secondSession, branch: "fork" });
  queue(createOutput(second), createOutput(second));
  const other = await memory.consolidate({ sessionId: secondSession, branch: "fork" });
  if (other.outcome !== "success") throw new Error("expected success");
  expect(other.range.facts.map((f) => f.id)).toEqual([second]);
  expect(calls[0]!.text).not.toContain(`[F${first}]`);
  queue(createOutput(first), createOutput(first));
  const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.range.facts.map((f) => f.id)).toEqual([first]);
  // 25a: the other session's settled fact is no longer injected as context; an explicit read still
  // returns it, unrestricted across sessions and projects.
  expect(calls[1]!.text).not.toContain(memory.trace(`F${second}`));
  expect(memory.trace(`F${second}`)).toContain(`[F${second}]`);
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
  const fixture = JSON.parse(readFileSync(new URL("../../fixtures/consolidation.json", import.meta.url), "utf8"));
  const ids = new Map<number, number>();
  for (const source of fixture.facts) ids.set(source.id, fact(source.text, { actor: source.actor, category: source.category, quote: source.quote, createdAt: source.timestamp }));
  const output = { ...empty, operations: [{ op: "create", topics: [], reason: "Initial admission of this conclusion.", ...fixture.knowledge, supports: fixture.knowledge.supports.map((id: string) => `F${ids.get(Number(id.slice(1)))}`) }] };
  queue(output, output); const result = await consolidation();
  if (result.outcome !== "success") throw new Error("expected success");
  expect(result.committed).toHaveLength(1);
  expect(memory.trace(`K${result.committed[0]!.knowledgeId}`)).toContain(fixture.knowledge.text);
  for (const source of fixture.facts) expect(memory.trace(`F${ids.get(source.id)}`)).toContain(source.text);
});


// 21a scenario 3: the reason is prose. Core stores it and never reads an address out of it.

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

test("19b 2026-09-08, as 25b left it: Consolidation material carries the exact fact list, the fact lines and the knowledge", async () => {
  const first = fact(); const second = fact(memories.observation);
  await memory.consolidate({ sessionId, branch: "main", mode: "subagent" }); // the queue is empty; only the frozen material matters here
  await memory.consolidate({ sessionId, branch: "main" });                   // the default is the same one mode
  for (const call of calls) {
    // The exact set, not the F..F span: what an inherited context integrates is a membership list.
    expect(call.material.factAddresses).toEqual([`F${first}`, `F${second}`]);
    expect(call.material.rangeFacts.join("\n")).toContain(memory.trace(`F${first}`));
    expect(call.material.knowledge.map(g => g.text).join("\n")).toBe(calls[0]!.material.knowledge.map(g => g.text).join("\n"));
    expect(call.mode).toBe("subagent"); // 25b: the only mode this phase has, requested or defaulted
  }
  // One frozen material either way; which parts the host sends is pinned in hosts/pi/compose.test.ts.
  expect(calls[1]!.material).toEqual(calls[0]!.material);
});

// ----------------------------------------------------------- 20b: token triggers and token batches

/** The rendered representation of the applicable unconsolidated facts: the same `renderFact` lines,
 * with their relations and their joining separator, that the trigger and the selection both count. */
const grouped = (facts: Fact[]) => renderFactGroups(facts, f => memory.trace(`F${f.id}`), memory.store.factTurnTimes(facts));
/** 25a: the pending-fact allowance also carries this batch's titles and range line, so a cap stated
 * as "holds N facts" must state their framing too. Reminders are per batch and are zero here. */
const withFraming = (facts: Fact[]) => tokens(grouped(facts).join("\n"))
  + charge([RANGE_FACTS_TITLE, `Range: F${facts[0]!.id}..F${facts.at(-1)!.id}`]);
const applicableTokens = (branch = "main") =>
  tokens(grouped(memory.store.consolidationBatch(sessionId, branch, memory.store.knowledgePath(sessionId, branch).headTurnId ?? undefined)).join("\n"));
const due = (branch = "main") => memory.taskEligibility("consolidation",
  { sessionId, branch, headTurnId: memory.store.knowledgePath(sessionId, branch).headTurnId! }).due;

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
  const pending = memory.store.consolidationBatch(sessionId, "main", memory.store.knowledgePath(sessionId, "main").headTurnId ?? undefined);
  const cap = withFraming(pending.slice(0, 3));
  expect(withFraming(pending.slice(0, 4))).toBeGreaterThan(cap); // a fourth whole fact does not fit
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
  const alone = [first, second, third].map(id => withFraming([memory.store.getFact(id)!]));
  // A ceiling that holds any one of these facts with its framing but never two: one whole fact per batch.
  memory.close(); open({ consolidation: { triggerTokens: 1, batchTokens: Math.max(...alone) } });
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

/** Ticket 86 supersedes the old single-item batch refusal: the oldest fact always enters first. */
test("86: an oldest fact over the batch cap is admitted before a smaller later fact", async () => {
  const huge = fact("word ".repeat(400)), small = fact(memories.base);
  const cap = tokens(memory.trace(`F${huge}`)) - 1;
  memory.close(); open({ consolidation: { triggerTokens: 1, batchTokens: cap } });
  queue(empty);
  const result = await consolidation();
  expect(result.outcome === "success" && result.range.facts.map(f => f.id)).toEqual([huge]);
  expect(calls).toHaveLength(1);
  expect(consolidated(huge)).toBe(true);
  expect(consolidated(small)).toBe(false); // the smaller later fact did not jump the queue
  expect(memory.trace(`F${huge}`)).toContain("word word"); // the evidence text is untouched
});

// ---- 21a / ticket 76: a Consolidator archive commits alongside a create and advances fact accounting ----

test("76: a Consolidator archive commits alongside a create, and both advance fact accounting", async () => {
  const withdrawal = fact("The user withdrew the packaging rule"), agent = fact(memories.observation, { actor: "agent" });
  const e = knowledge([agent]);
  const output = { ...empty, operations: [...createOutput(agent).operations, { op: "archive", id: `K${e}`,
    supports: [`F${withdrawal}`], reason: "The user withdrew the rule this knowledge stated." }] };
  queue(output);
  const result = await consolidation();
  expect(result.outcome).toBe("success");
  if (result.outcome !== "success") throw new Error("expected success");
  expect(memory.store.currentCommit(e)[0]?.op).toBe("archive");
  expect(memory.store.getKnowledge(e + 1)).not.toBeNull(); // the create committed too, as a new identity
  expect(consolidated(withdrawal)).toBe(true);
});


test("21a 2026-09-08: one malformed reason among valid operations commits nothing", async () => {
  const f = fact(); const good = createOutput(f);
  const bad = { ...empty, operations: [...good.operations, { ...good.operations[0]!, text: "A second conclusion", reason: "   " }] };
  queue(bad);
  const result = await consolidation();
  if (result.outcome !== "bounced") throw new Error("expected an atomic bounce");
  expect(result.problems.join(" ")).toContain("reason");
  expect(memory.store.listVisibleKnowledge(sessionId, projectId)).toEqual([]);
  expect(consolidated(f)).toBe(false);
});

// Ticket 21 "Review cues": the diagnostics read knowledge text and facts, never commit messages.

/** Ticket 86: even the complete framing of the first fact may exceed the soft batch cap. */
test("86: a first fact whose framing exceeds the batch cap is still admitted", async () => {
  const one = fact(memories.base);
  const alone = memory.store.getFact(one)!;
  const line = tokens(grouped([alone]).join("\n")), framed = withFraming([alone]);
  expect(framed).toBeGreaterThan(line);
  memory.close(); open({ consolidation: { triggerTokens: 1, batchTokens: line } });
  queue(empty);
  const result = await consolidation();
  expect(calls).toHaveLength(1);
  expect(memory.store.consolidationBatch(sessionId, "main").map(f => f.id)).toEqual([]);
  expect(result.outcome === "success" && result.range.facts.map(f => f.id)).toEqual([one]);
});
