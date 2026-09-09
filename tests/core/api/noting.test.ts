import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult, type ConfigOverride, renderEntry } from "../../source-fixture.ts";
import { renderKnowledge, tokens } from "../../../src/core/render/index.ts";
import { knowledgeBlock } from "../../../src/core/render/material.ts";
import fixture from "../../fixtures/noting/turns.json";
import memories from "../../fixtures/noting/facts.json";

let directory: string;
let memory: ReturnType<typeof sourceSeededMemory>;
let sessionId: number;
let calls: NotingAgentInput[];
type ScriptResult = RunAgentResult & { noteInput?: unknown };
let script: ((input: NotingAgentInput) => Promise<ScriptResult>)[];
const time = "2026-08-16 02:54";
const request = { system: "actual host system", messages: [{ role: "user", content: "actual provider input" }], tools: [] };
const success = (batches: { facts: unknown[] }[]): ScriptResult => ({ outcome: "success", output: "Done.", noteInput: batches.length ? { facts: batches.flatMap((b) => b.facts) } : undefined, request, usage: { tokens: 12 } });
const fact = (extra = {}) => ({ category: "observation", actor: "agent", text: memories.base, source: ["T1#assistant"], ...extra });
const batch = (turnId: number, facts = [fact()]) => ({ turn: `S${sessionId}/T${turnId}`, title: "mapC terrain", topic: "terrain", facts: facts.map((f) => ({ ...f, source: f.source[0] === "T1#assistant" ? [`T${turnId}#assistant`] : f.source })) });
function open(config: ConfigOverride = {}) {
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async (raw) => {
    const input = raw as NotingAgentInput;
    calls.push(input);
    const next = script.shift();
    if (!next) throw new Error("unexpected model call");
    const result = await next(input);
    if (result.request !== undefined) input.reportRequest(result.request);
    if (result.noteInput !== undefined) input.tools.find((t) => t.name === "note")!.execute(result.noteInput);
    return result;
  }, config);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-noting-")); calls = []; script = []; open();
  const project = memory.store.createProject({ name: "fixture", declaredBy: "mark" });
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "fake", startedAt: time, firstReplyAt: time, projectId: project.id }).id;
});
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });
function turn(parentTurnId: number | null = null, index = 0) {
  const f = fixture[index]!;
  const t = memory.store.appendTurn({ sessionId, parentTurnId, kind: "turn", userPrompt: f.userPrompt, assistantText: f.assistantText, startedAt: time });
  for (const c of f.calls) memory.store.appendToolCall({ turnId: t.id, name: c.name, input: c.input, result: c.result, status: c.status });
  return t;
}
const noting = (headTurnId: number, branch = "main") => memory.noting({ sessionId, branch, headTurnId, model: "fake-model", mode: "subagent" });
function deferred() {
  let resolve!: (result: ScriptResult) => void;
  const promise = new Promise<ScriptResult>((r) => { resolve = r; });
  script.push(async () => promise);
  return resolve;
}
function unchanged(branch = "main") {
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  expect(memory.store.listSourceEntries(sessionId).some(e => memory.store.entryNoted(e.id))).toBe(false);
  expect(memory.store.listPendingDeliveries(sessionId, branch)).toEqual([]);
}

test("a turn arriving during the model call waits for the next trigger", async () => {
  const first = turn(), resolve = deferred();
  const pending = noting(first.id);
  const second = turn(first.id, 1);
  expect(calls[0]!.range.to).toBe(`S${sessionId}/T${first.id}`);
  expect(calls[0]!.text.fresh).not.toContain(second.userPrompt!);
  resolve(success([batch(first.id)]));
  const result = await pending;
  expect(result.outcome).toBe("success");
  expect(memory.store.sourcePath(sessionId, "main", first.id).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(sessionId, "main", first.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
  script.push(async () => success([batch(second.id, [fact({ source: [`T${second.id}#user`], support: [["F1", "weak"]] })])]));
  await noting(second.id);
  expect(calls[1]!.text.fresh).toContain(second.userPrompt!);
  expect(calls[1]!.material.facts[0]).toContain("[F1]");
  expect(calls[1]!.text.fresh).not.toContain(first.userPrompt!);
  expect(memory.store.sourcePath(sessionId, "main", second.id).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(sessionId, "main", second.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.listSessionFacts(sessionId)).toHaveLength(2);
  expect(await noting(second.id)).toEqual({ outcome: "empty" });
  expect(calls).toHaveLength(2);
});

test("switching branch while pending preserves the old delivery and excludes the sibling", async () => {
  const root = turn(), old = turn(root.id, 1), resolve = deferred();
  const selection = { sessionId, branch: "old", headTurnId: old.id };
  const pending = memory.noting(selection);
  const sibling = turn(root.id);
  selection.branch = "new"; selection.headTurnId = sibling.id;
  script.push(async () => success([]));
  // 17c 2026-09-08 supersedes concurrent sibling workers: the target claim spans branches.
  expect(await memory.noting(selection)).toEqual({ outcome: "dropped" });
  resolve(success([batch(old.id)]));
  await pending;
  await memory.noting(selection);
  expect(memory.store.sourcePath(sessionId, "old", old.id).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(sessionId, "old", old.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.sourcePath(sessionId, "new", sibling.id).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(sessionId, "new", sibling.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.listPendingDeliveries(sessionId, "old").map((d) => d.branch)).toEqual(["old"]);
  expect(memory.store.listPendingDeliveries(sessionId, "new")).toEqual([]);
  expect(calls[1]!.text.fresh).not.toContain(`[S${sessionId}/T${old.id}]`);
  expect(memory.store.getRun(1)?.branch).toBe("old");
});

test("duplicate trigger is dropped, including another façade on the same file", async () => {
  const t = turn(), resolve = deferred(), pending = noting(t.id);
  expect(await noting(t.id)).toEqual({ outcome: "dropped" });
  const other = sourceSeededMemory(join(directory, "test.sqlite"), async () => { throw new Error("must not run"); });
  try { expect(await other.noting({ sessionId, branch: "main", headTurnId: t.id })).toEqual({ outcome: "dropped" }); }
  finally { other.close(); }
  expect(memory.store.getRun(1)).toBeNull();
  resolve(success([])); await pending;
  expect(calls).toHaveLength(1);
  expect(memory.store.getRun(2)).toBeNull();
});

for (const outcome of ["failure", "cancelled"] as const) test(`${outcome} records only the attempt and allows a retry`, async () => {
  const t = turn(); script.push(async () => ({ outcome, output: "provider stopped", request }));
  const result = await noting(t.id);
  expect(result.outcome).toBe(outcome); unchanged();
  expect(memory.store.getRun(1)?.outcome).toBe(outcome);
  expect(JSON.parse(memory.store.getRun(1)!.request!)).toEqual(request);
  script.push(async () => success([])); expect((await noting(t.id)).outcome).toBe("success");
});
for (const name of ["Error", "AbortError"]) test(`thrown ${name} records an attempt without fabricating a request`, async () => {
  const t = turn(); script.push(async () => { const e = new Error("stopped"); e.name = name; throw e; });
  expect((await noting(t.id)).outcome).toBe(name === "AbortError" ? "cancelled" : "failure");
  unchanged(); expect(memory.store.getRun(1)?.request).toBeNull();
});

for (const [label, changes, problem] of [
  ["category", { category: "open" }, "category"],
  ["actor", { actor: "tool" }, "actor"],
  ["unknown fact", { support: [["F999", "weak"]] }, "F999"],
  ["self handle", { support: [["$1", "weak"]] }, "$1"],
  ["zero handle", { support: [["$0", "weak"]] }, "$0"],
  ["forward handle", { support: [["$2", "weak"]] }, "$2"],
  ["malformed handle", { support: [["$x", "weak"]] }, "target"],
  ["relation shape", { support: ["F1"] }, "expected [target, strength]"],
  ["embedded id", { text: "See F101" }, "must not embed"],
  ["event status", { category: "event" }, "status"],
] as const) test(`bounces ${label} with problems and only a run record`, async () => {
  const t = turn(), output = [batch(t.id, [fact(changes)])];
  script.push(async () => success(output));
  const result = await noting(t.id);
  expect(result.outcome).toBe("bounced");
  if (result.outcome !== "bounced") throw new Error("expected bounce");
  expect(result.problems.join("\n")).toContain(problem);
  unchanged();
  const run = memory.store.getRun(result.runId)!;
  expect(run.outcome).toBe("bounced");
  expect(JSON.parse(run.response!).toolCalls[0].input).toEqual({ facts: output.flatMap((b) => b.facts) });
  expect(JSON.parse(run.response!).problems).toEqual(result.problems);
});

test("final text is never parsed; a successful reply without provider request fails", async () => {
  const t = turn(); script.push(async () => ({ outcome: "success", output: "[", request }));
  expect((await noting(t.id)).outcome).toBe("success");
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  const next = turn(t.id);
  script.push(async () => ({ outcome: "success", output: "[]" }));
  expect((await noting(next.id)).outcome).toBe("failure");
  expect(memory.store.sourcePath(sessionId, "main", t.id).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(sessionId, "main", t.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
});

test("model cannot write to a late turn outside the frozen range", async () => {
  const first = turn(), resolve = deferred(), pending = noting(first.id), late = turn(first.id, 1);
  resolve(success([batch(late.id)]));
  expect((await pending).outcome).toBe("bounced"); unchanged();
});

test("empty output notings the range; compactions cannot acquire facts", async () => {
  const t = memory.store.appendTurn({ sessionId, kind: "compaction", startedAt: time });
  // 17a supersedes whole-Turn progress: compactions have no eligible source entry.
  expect((await noting(t.id)).outcome).toBe("empty");
  expect(calls).toHaveLength(0);
  const raw = turn(t.id); script.push(async () => success([])); await noting(raw.id);
  expect(memory.pendingEntries(sessionId, "main", raw.id)).toEqual([]);
  expect(memory.store.listPendingDeliveries(sessionId, "main")).toHaveLength(0);
});

test("read knowledge revisions and exact provider request are recorded, even when a knowledge item moves", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await noting(first.id);
  const created = memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: time }, operations: [
    { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "fake", category: "mechanism", scope: "project", text: memories.knowledge, supports: [1], createdAt: time },
  ] });
  expect(created.ok).toBe(true);
  const second = turn(first.id, 1), resolve = deferred(), pending = noting(second.id);
  expect(calls[1]!.readKnowledgeCommits).toEqual([{ knowledgeId: 1, commit: 1 }]);
  expect(calls[1]!.material.knowledge.map(g => g.text).join("\n")).toContain("[K1@1]");
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: time }, operations: [
    { op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: 1, baseCommit: 1, category: "mechanism", scope: "project", text: memories.editedKnowledge, supports: [1], createdAt: time },
  ] });
  resolve(success([])); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  const run = memory.store.getRun(result.runId)!;
  expect(JSON.parse(run.response!).readKnowledgeCommits).toEqual([{ knowledgeId: 1, commit: 1 }]);
  expect(JSON.parse(run.request!)).toEqual(request);
  expect(run.model).toBe("fake-model"); expect(run.promptHash).toMatch(/^[0-9a-f]{64}$/);
  expect(run.request).not.toBe(calls[1]!.text.fresh);
});

const golden = (name: string) => readFileSync(new URL(`../../fixtures/noting/${name}.txt`, import.meta.url), "utf8").trimEnd();
test("fixture turn golden and noting input use identical rendering with receipts last", async () => {
  const first = turn(); turn(first.id, 1);
  expect(memory.trace("T1")).toBe(golden("turn"));
  expect(memory.trace("T2")).toBe(golden("read"));
  script.push(async (input) => {
    // 17a: automatic Raw uses completed entries; explicit trace retains its independent full read.
    const views = memory.pendingEntries(sessionId, "main", first.id).map(e => renderEntry(e, memory.config.render).content).join("\n\n");
    expect(input.material.entries.map(e => e.view).join("\n\n")).toBe(views);
    expect(input.tools[0]!.execute({ address: "T1", tool: 2, full: true })).toBe(memory.trace("T1", { tool: 2, full: true }));
    return success([]);
  });
  const result = await memory.noting({ sessionId, branch: "main", headTurnId: first.id, mode: "subagent" });
  if (result.outcome !== "success") throw new Error("expected success");
  expect(JSON.parse(memory.store.getRun(result.runId)!.response!).fetched[0].input).toEqual({ address: "T1", tool: 2, full: true });
  expect(calls[0]!.tools[0]!.execute({ address: "T1" })).toContain("finished");
});

test("fixture fact goldens include quote, sources and both relation directions across turns", async () => {
  const first = turn(), second = turn(first.id, 1);
  script.push(async () => success([
    batch(first.id, [fact({ quote: memories.quote })]),
    batch(second.id, [fact({ category: "interpretation", text: memories.interpretation, source: ["T2#assistant"], support: [["$1", "weak"]] }),
      fact({ category: "observation", text: memories.observation, source: ["T2#assistant"], negate: [["$1", "strong"]] })]),
  ]));
  expect((await noting(second.id)).outcome).toBe("success");
  expect([1, 2, 3].map((id) => memory.trace(`F${id}`)).join("\n\n")).toBe(golden("facts"));
});

test("full expands selected calls; cap is the listing budget and address flags are rejected", () => {
  const t = turn();
  const full = memory.trace(`T${t.id}`, { tool: 2, full: true });
  expect(full).toContain(fixture[0]!.calls[1]!.result!);
  // 23c: `full` is the entry renderer's unbounded path, so the selected call carries the same labels
  // every other view uses; the unselected one keeps its floor and its receipt.
  expect(full).toContain("[T1#t2] Bash success: ");
  expect(full).toContain("[T1#t1] mcp__plugin_claude-mnemo_mnemo__note(...)");
  expect(memory.trace(`T${t.id}`, { cap: 1 })).toContain("cursor=");
  expect(() => memory.trace("T1", { tool: 99 })).toThrow("does not exist");
  expect(() => memory.trace("T1 cap=0")).toThrow("invalid trace address");
});

test("an oldest entry the episodic budget cannot hold leaves Noting pending (the 'raw overage' receipt was superseded 2026-09-08)", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await noting(first.id);
  memory.close(); open({ render: { episodicBlockTokens: 1 } });
  const second = turn(first.id, 1);
  const before = memory.pendingEntries(sessionId, "main", second.id);
  await expect(noting(second.id)).rejects.toThrow(/Noting capacity/);
  expect(calls).toHaveLength(1); // no model call ran over the budget
  expect(memory.pendingEntries(sessionId, "main", second.id)).toEqual(before);
});

test("20b 2026-09-08 scenario 4: no knowledge category bypasses the cap, constraints keep first priority, and omitted items stay traceable", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await noting(first.id);
  const categories = ["constraint", "open", "dispute", "goal", "mechanism", "term", "reference"] as const;
  memory.store.commitConsolidationRun({ run: { kind: "consolidation", sessionId, createdAt: time }, operations: categories.map((category, i) => ({
    op: "create", topics: [], reason: "Initial admission of this conclusion." as const, handle: `$e${i + 1}`, author: "fake", category, scope: "project" as const, text: memories.knowledge, supports: [1], createdAt: time,
  })) });
  const item = (id: number) => renderKnowledge(memory.store.listCurrentKnowledge(memory.store.knowledgePath(sessionId, "main")).find(k => k.knowledge.id === id)!);
  // A cap of one token holds nothing at all — not even the first-priority constraint (17b kept three)
  // and not even the receipt naming the omissions, so the task stays pending (review 2026-09-08).
  memory.close(); open({ render: { knowledgeBlockTokens: 1 } });
  const second = turn(first.id, 1);
  await expect(noting(second.id)).rejects.toThrow(/Knowledge capacity/);
  for (const [i] of categories.entries()) expect(memory.trace(`K${i + 1}`)).toContain(`[K${i + 1}@`); // omitted, not deleted
  // A binding cap keeps a whole prefix of the priority order, and the block, its category tags and its
  // own omission receipts all stay inside it — the receipts are charged, not free.
  const cap = 200;
  memory.close(); open({ render: { knowledgeBlockTokens: cap } });
  const third = turn(second.id, 1); script.push(async () => success([])); await noting(third.id);
  const material = calls[1]!.material;
  const kept = material.knowledge.map(g => g.category);
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.length).toBeLessThan(categories.length); // the cap really binds
  expect(kept).toEqual(categories.slice(0, kept.length)); // category priority, deterministically
  expect(material.knowledge.map(g => g.text)).toEqual(kept.map((_, i) => item(i + 1))); // whole items, never rewritten
  const receipts = material.receipts.filter(r => r.includes(" knowledge; expand: "));
  expect(receipts).toHaveLength(categories.length - kept.length);
  expect(tokens(knowledgeBlock(material)) + tokens(receipts.join("\n"))).toBeLessThanOrEqual(cap);
});

test("selected historical facts display by Turn time rather than insertion id", async () => {
  const first = turn();
  const later = memory.store.appendTurn({ sessionId, parentTurnId: first.id, kind: "turn", assistantText: "later", startedAt: "2026-08-16 03:00" });
  script.push(async () => success([batch(later.id), batch(first.id)])); await noting(later.id);
  const second = turn(later.id, 1); script.push(async () => success([])); await noting(second.id);
  expect(calls[1]!.text.fresh.indexOf("[F2]")).toBeLessThan(calls[1]!.text.fresh.indexOf("[F1]"));
});

test("reopening the database preserves the run, facts, watermark and delivery", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await noting(first.id);
  const traced = memory.trace("F1"); memory.close(); open();
  expect(memory.trace("F1")).toBe(traced);
  expect(memory.store.sourcePath(sessionId, "main", first.id).length).toBeGreaterThan(0);
  expect(memory.store.sourcePath(sessionId, "main", first.id).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.listPendingDeliveries(sessionId, "main")).toHaveLength(1);
  expect(memory.store.getRun(1)?.outcome).toBe("success");
});

/** Ticket 20 "Primary entry bound" and acceptance scenario 8. The primary renderer either returns an
 * entry inside its configured budget or throws: it never returns an oversized view, and an entry
 * whose mandatory labels and omission markers cannot fit leaves Noting pending with no progress. */
test("20b 2026-09-08 scenario 8: an entry whose mandatory metadata cannot fit is a capacity failure, never an oversized success", async () => {
  const first = turn();
  const views = memory.pendingEntries(sessionId, "main", first.id).map(e => renderEntry(e, memory.config.render).content);
  for (const view of views) expect(tokens(view)).toBeLessThanOrEqual(memory.config.render.entryTokens); // bounded, labels included
  const before = memory.pendingEntries(sessionId, "main", first.id);
  memory.close(); open({ render: { entryTokens: 4, toolCallTokens: 4 } });
  script.push(async () => success([]));
  await expect(noting(first.id)).rejects.toThrow("entry view capacity cannot hold source labels and omission markers");
  expect(calls).toEqual([]);
  expect(memory.store.listRuns(sessionId)).toEqual([]);
  expect(memory.pendingEntries(sessionId, "main", first.id)).toEqual(before);
});
