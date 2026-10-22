// What a Dreamer run leaves behind and what it hands its model (ticket 144, stage 4): capacity before dispatch, the audited
// prompt and request, and the Store state after a failure, a cancellation or a fault in the final transaction. The run shape
// itself (hand-off, resume, retries, the cancellation fence) is `dreaming-run.test.ts`.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterEach, expect, test } from "vitest";
import type { RunAgentResult } from "../../../src/core/api/index.ts";
import type { DreamingAgentInput } from "../../../src/core/dreaming/index.ts";
import { dreamingWorkspaceToolDefinitions, pricedToolDefinitions } from "../../../src/core/api/tools.ts";
import { canonicalToolNames } from "../../../src/core/prompts/tool-names.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { withRetrievalPolicy } from "../../../src/core/render/retrieval-policy.ts";
import { tokens } from "../../../src/core/render/index.ts";
import type { TraceMemory } from "../../source-fixture.ts";
import { dreamerFixture as makeDreamerFixture, writeCurateBatch, type DreamerScript } from "../../support/dreamer.ts";
import { REQUEST } from "../../support/noter.ts";
import { block } from "../../support/workspace.ts";

const memories: TraceMemory[] = [];
afterEach(() => { for (const memory of memories.splice(0)) memory.close(); });
const dreamerFixture = (script: DreamerScript = {}) => makeDreamerFixture(memories, script);
type Fixture = ReturnType<typeof dreamerFixture>;

const covered = (f: Fixture) => f.store.db.prepare("SELECT revision_id FROM knowledge_processed ORDER BY revision_id").all().map(row => Number(row.revision_id));
const revisions = (f: Fixture) => Number(f.store.db.prepare("SELECT COUNT(*) AS n FROM knowledge_revisions").get()!.n);
const curateRun = (f: Fixture) => f.store.listRuns(f.session.id).find(run => run.rangeFrom === `S${f.session.id}/curate`)!;
const update = (item: { ref: string }, text: string) => block(`update ${item.ref}`, { reason: "tidy" }, text);
const writeBatch = (input: DreamingAgentInput, text: string) => writeCurateBatch(input, text);

// ---- Capacity, prompt and tools ------------------------------------------------------------------------------------------------

test("native Read token estimate counts in Dreamer capacity before dispatch", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  let base: DreamingAgentInput | undefined;
  const stop = (input: DreamingAgentInput): RunAgentResult => { input.acknowledgeRequest(); return { outcome: "cancelled", output: "capacity fixture stopped without writes", request: REQUEST }; };
  f.next(async raw => { base = raw as DreamingAgentInput; return stop(base); });
  await f.dream();
  if (!base) throw new Error("missing baseline Dreamer dispatch");
  const nativeReadToolTokens = 402;
  const definitions = pricedToolDefinitions(dreamingWorkspaceToolDefinitions, canonicalToolNames);
  // The largest task prompt the run can send (curate's or verify's, delivered with `check`) is priced with the first message (stage 5 §0).
  const taskPrompt = Math.max(...(["curate", "verify"] as const).map(task => tokens(loadPrompt(`tasks/${task}-update.md`, canonicalToolNames, f.memory.config.writing))));
  const price = tokens(base.prompt) + tokens(JSON.stringify(definitions)) + nativeReadToolTokens + tokens(base.text) + taskPrompt;
  const bounded = { ...f.target, nativeReadToolTokens, capacity: { inputTokens: price - 1 } };
  const runs = f.store.listRuns(f.session.id).length;
  f.next(() => { throw new Error("over-cap dispatch"); });
  await expect(f.memory.dream(bounded)).rejects.toThrow(/Dreaming capacity/);
  expect(f.store.listRuns(f.session.id)).toHaveLength(runs);
  f.next(async raw => { const input = raw as DreamingAgentInput;
    expect(tokens(input.prompt) + tokens(JSON.stringify(definitions)) + nativeReadToolTokens + tokens(input.text) + taskPrompt).toBe(price);
    return stop(input); });
  await f.memory.dream({ ...bounded, capacity: { inputTokens: price } });
  expect(f.store.listRuns(f.session.id)).toHaveLength(runs + 1);
  expect(covered(f)).toEqual([]);
});

test("136 review SPEC4: a Dreamer's over-long search output is saved where its host says, and the path is in the result", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  const saved: string[] = [];
  let answer = "";
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.setSpill!(text => { saved.push(text); return "/where/the/host/saved/it"; });
    answer = await input.tools.find(tool => tool.name === "search")!.execute({ layer: "knowledge", code: "text('HEAD ' + 'word '.repeat(60000) + ' TAIL')" });
    input.acknowledgeRequest();
    return { outcome: "failure", output: "fixture stopped", request: REQUEST };
  });
  expect((await f.dream()).outcome).toBe("failure");
  expect(answer).toContain("[Full output: /where/the/host/saved/it]");
  expect(answer).not.toContain("not saved");
  expect(saved).toHaveLength(1);
  expect(saved[0]!.startsWith("HEAD word")).toBe(true); expect(saved[0]!.endsWith(" TAIL")).toBe(true);
});

test("the Dreamer's audited prompt carries the configured title and body limits", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  Object.assign(f.memory.config.writing, { titleWords: 13, bodyWords: 321 });
  expect((await f.dream()).outcome).toBe("success");
  const prompt = f.dreamer.inputs[0]!.prompt;
  expect(prompt).toContain("a title of a fact or knowledge is at most 13 字/词 and a body at most 321 字/词");
  expect(prompt).not.toContain("{{limit.");
});

test("Dreamer instructions use its fresh host's exposed check and read tools in the audited prompt", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  const names = { ...canonicalToolNames, search: "mcp__trace_memory__search", note: "mcp__trace_memory__note", memory: "mcp__trace_memory__memory", check: "mcp__trace_memory__check", read: "Read", write: "Write", edit: "Edit", grep: "Grep" };
  const rendered = withRetrievalPolicy(loadPrompt("dreaming.md", names, f.memory.config.writing), names); // 137: the policy is part of a fresh Dreamer's system prompt
  const result = await f.memory.dream({ ...f.target, toolNames: names } as typeof f.target);
  expect(result.outcome).toBe("success");
  const input = f.dreamer.inputs[0]!;
  expect(input.prompt).toBe(rendered);
  expect(input.prompt).toContain("Call mcp__trace_memory__check first");
  expect(input.prompt).not.toContain("{{tool.");
  expect(input.prompt.split("When to look up memory").length).toBe(2);
  expect(input.prompt).toContain("Find topics and exact strings with mcp__trace_memory__search;");
  expect(input.text).toContain("Call mcp__trace_memory__check first");
  expect(input.promptHash).toBe(createHash("sha256").update(rendered).digest("hex"));
  expect(input.tools.map(tool => tool.name)).toEqual(["search", "check"]);
  expect(curateRun(f).promptHash).toBe(createHash("sha256").update(rendered).digest("hex"));
});

// ---- The audit of a task ------------------------------------------------------------------------------------------------------

test("64c exact provider request and terminal audit are preserved while a passing curate covers what it showed", async () => {
  const exact = { provider: "exact body" };
  const f = dreamerFixture({ curateResult: { output: "audited", request: exact, nativeLog: "/tmp/dream.jsonl",
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } } });
  const base = f.item("durable base", { category: "constraint" });
  expect((await f.dream()).outcome).toBe("success");
  const run = curateRun(f);
  expect(run.request).toBe(JSON.stringify(exact));
  expect(JSON.parse(run.response!)).toMatchObject({ output: "audited", nativeLog: "/tmp/dream.jsonl", task: "curate",
    usage: { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } });
  expect(f.memory.spend(f.session.id)).toMatchObject({ input: 7, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 });
  expect(covered(f)).toEqual([base.commit]);
});

test("64c payload-free acknowledgement preserves unavailable audit without fabricating a request", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  f.next(async raw => { (raw as DreamingAgentInput).acknowledgeRequest();
    return { outcome: "failure", output: "provider body unavailable", audit: { available: false, reason: "no provider body" } }; });
  const result = await f.dream();
  expect(result.outcome).toBe("failure");
  if (!("runId" in result)) throw new Error("missing run id");
  const run = f.store.getRun(result.runId)!;
  expect(run.request).toBeNull();
  expect(JSON.parse(run.response!)).toMatchObject({ output: "provider body unavailable", audit: { available: false, reason: "no provider body" } });
  expect(result.problems).not.toContain("runAgent must return the exact provider request");
});

test("64c missing request without an unavailable-audit acknowledgement is an explicit failure", async () => {
  const f = dreamerFixture();
  f.item("Rule", { category: "constraint" });
  f.next(async raw => { await writeBatch(raw as DreamingAgentInput, "## none\n"); return { outcome: "success", output: "request omitted" }; });
  const result = await f.dream();
  expect(result.outcome).toBe("failure");
  if (!("runId" in result)) throw new Error("missing run id");
  expect(result.problems).toContain("runAgent must return the exact provider request");
  expect(f.store.getRun(result.runId)!.request).toBeNull();
});

test.each(["failure", "cancelled"] as const)("64c %s terminal transaction persists the audit and covers nothing", async terminal => {
  const f = dreamerFixture();
  const item = f.item(`${terminal} rule`, { category: "constraint" });
  f.next(async raw => { (raw as DreamingAgentInput).acknowledgeRequest(); return { outcome: terminal, output: `${terminal} output`, request: { terminal }, nativeLog: `/tmp/${terminal}.jsonl` }; });
  const result = await f.dream();
  if (!("runId" in result)) throw new Error("missing run");
  const run = f.store.getRun(result.runId)!;
  expect(run.outcome).toBe(terminal);
  expect(JSON.parse(run.response!)).toMatchObject({ output: `${terminal} output`, nativeLog: `/tmp/${terminal}.jsonl` });
  expect(JSON.parse(run.request!)).toEqual({ terminal });
  expect(covered(f)).toEqual([]);
  expect(f.store.currentCommit(item.knowledgeId, f.path)[0]!.id).toBe(item.commit);
});

test("64c a rejected terminal transaction rolls back the batch and its coverage but preserves the attempt evidence", async () => {
  const f = dreamerFixture();
  const rule = f.item("fenced rule", { category: "constraint" });
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.acknowledgeRequest();
    f.store.invalidateExecutor(f.memory.executorId); // the claim is gone before the batch is applied
    await writeBatch(input, update(rule, "fenced rewrite"));
    return { outcome: "success", output: "done", request: REQUEST };
  });
  const result = await f.dream();
  if (!("runId" in result)) throw new Error("missing run");
  expect(result.outcome).toBe("failure");
  expect(covered(f)).toEqual([]);
  expect(f.store.currentCommit(rule.knowledgeId, f.path)[0]!.id).toBe(rule.commit);
  expect(JSON.parse(f.store.getRun(result.runId)!.response!)).toMatchObject({ output: "done" });
  expect(f.store.getRun(result.runId)!.request).toBe(JSON.stringify(REQUEST));
});

// ---- What a failed or cancelled run leaves in the Store --------------------------------------------------------------------------

test("68 provider failure covers nothing and leaves the hand-off at curate", async () => {
  const f = dreamerFixture();
  f.item("failed base", { category: "constraint" });
  f.next(async raw => { (raw as DreamingAgentInput).acknowledgeRequest(); return { outcome: "failure", output: "provider failed", request: REQUEST }; });
  expect((await f.dream()).outcome).toBe("failure");
  expect(covered(f)).toEqual([]);
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "curate" });
});

test("64c cancellation before the first batch covers nothing and leaves the work due", async () => {
  const f = dreamerFixture();
  f.item("project source", { category: "constraint" });
  const before = revisions(f), controller = new AbortController();
  f.next(raw => new Promise<RunAgentResult>(resolve => {
    const input = raw as DreamingAgentInput;
    input.acknowledgeRequest();
    input.signal!.addEventListener("abort", () => resolve({ outcome: "cancelled", output: "cancelled", request: REQUEST }), { once: true });
  }));
  const pending = f.memory.dream({ ...f.target, signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 0)); controller.abort();
  expect((await pending).outcome).toBe("cancelled");
  expect(covered(f)).toEqual([]);
  expect(revisions(f)).toBe(before);
  expect(f.memory.taskEligibility("dreaming", f.target).due).toBe(true);
});

for (const mode of ["failure", "cancelled", "throw", "abort"] as const) test(`D ${mode} after a kept batch keeps its proposal, applies nothing, covers nothing and releases the claim`, async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  f.item("Reference", { category: "reference" });
  f.next(async raw => {
    await writeBatch(raw as DreamingAgentInput, update(rule, "Rule, moved by the batch"));
    expect(f.store.currentCommit(rule.knowledgeId, f.path)[0]!.text).toBe("Rule"); // a kept batch is a proposal, not a version
    if (mode === "throw" || mode === "abort") {
      const error = new Error("provider stopped after the batch");
      if (mode === "abort") error.name = "AbortError";
      throw error;
    }
    return { outcome: mode, output: "provider stopped after the batch", request: REQUEST };
  });
  expect((await f.dream()).outcome).toBe(mode === "cancelled" || mode === "abort" ? "cancelled" : "failure");
  expect(f.store.listKnowledgeRevisions(rule.knowledgeId)).toHaveLength(1);
  expect(covered(f)).toEqual([]); // coverage is written when verify passes, never before
  expect(f.store.handoff(f.session.id, "dreaming")).toMatchObject({ nextTask: "curate", detail: { doneCategories: ["constraint"], operation: "update" } }); // the kept batch survives
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
});

test("64c a fault in the final transaction of verify rolls back its applied operations and its coverage together, and keeps the exact audit", async () => {
  const f = dreamerFixture();
  const rule = f.item("terminal rollback base", { category: "constraint" });
  f.dreamer.script.curate!.constraint = update(rule, "committed before the terminal fault");
  f.store.db.exec(`CREATE TRIGGER reject_processing BEFORE INSERT ON knowledge_processed
    BEGIN SELECT RAISE(ABORT, 'injected processing insert failure'); END`);
  const before = revisions(f);
  const result = await f.dream();
  expect(result.outcome).toBe("failure");
  if (!("runId" in result)) throw new Error("missing run id");
  expect(result.problems.join(" ")).toContain("injected processing insert failure");
  expect(f.store.currentCommit(rule.knowledgeId, f.path)[0]!.id).toBe(rule.commit);
  expect(revisions(f)).toBe(before);
  expect(covered(f)).toEqual([]);
  expect(f.store.getClaim(f.session.id, "dreaming")).toBeNull();
  const run = f.store.getRun(result.runId)!;
  expect(run.request).toBe(JSON.stringify(REQUEST));
  expect(JSON.parse(run.response!).problems.join(" ")).toContain("injected processing insert failure");
});

// ---- Task instructions (stage 5 §0): delivered once, with the first check result ---------------------------------------------------

test("2026-10-22, 144: 「任务说明由第一次 check 结果告知」 — a Dreamer task's instructions arrive once, with its first check result; the first message and system prompt carry none; the run records the hash", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  f.dreamer.script.curate!.constraint = ["## bogus\n", update(rule, "Rule, tidied")];
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const prompt = (task: "curate" | "verify") => loadPrompt(`tasks/${task}-update.md`, canonicalToolNames, f.memory.config.writing);
  const count = (text: string, part: string) => text.split(part).length - 1;
  const [curate, verify] = f.dreamer.inputs;
  for (const input of [curate!, verify!]) for (const task of ["curate", "verify"] as const) { expect(input.prompt).not.toContain(prompt(task)); expect(input.text).not.toContain(prompt(task)); }
  expect(count(f.dreamer.reports[0]!, prompt("curate"))).toBe(1); // curate's first check result
  expect(count(f.dreamer.messages[0]!, prompt("curate"))).toBe(0); // its repair does not repeat it
  expect(count(f.dreamer.reports[1]!, prompt("verify"))).toBe(1);
  expect(f.dreamer.reports[1]).not.toContain(prompt("curate"));
  const hash = (task: "curate" | "verify") => createHash("sha256").update(prompt(task)).digest("hex");
  const bodies = f.store.listRuns(f.session.id).map(run => JSON.parse(run.response ?? "{}") as { task?: string; taskPrompts?: string[] });
  expect(bodies.find(body => body.task === "curate")?.taskPrompts).toEqual([hash("curate")]);
  expect(bodies.find(body => body.task === "verify")?.taskPrompts).toEqual([hash("verify")]);
  expect(bodies.find(body => body.task === "classify")?.taskPrompts ?? []).toEqual([]);
});

test("a model that never calls check still gets its task's instructions, in the first message that goes to it, and only once", async () => {
  const f = dreamerFixture();
  const rule = f.item("Rule", { category: "constraint" });
  const seen: string[] = [];
  f.next(async raw => {
    const input = raw as DreamingAgentInput;
    input.reportRequest(REQUEST);
    writeFileSync(input.workspace.write[0]!, "## bogus\n");
    seen.push(input.passEnd()!); // the repair is the first message that carries the instructions
    writeFileSync(input.workspace.write[0]!, update(rule, "Rule, tidied"));
    seen.push(String(await input.tools.find(tool => tool.name === "check")!.execute({}))); // a later check does not repeat them
    input.passEnd();
    return { outcome: "success", output: "Done.", request: REQUEST } as RunAgentResult;
  });
  expect(await f.dream()).toMatchObject({ outcome: "success" });
  const instructions = loadPrompt("tasks/curate-update.md", canonicalToolNames, f.memory.config.writing);
  expect(seen[0]).toContain(instructions);
  expect(seen[1]).not.toContain(instructions);
});
