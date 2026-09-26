import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, type NotingAgentInput, type RunAgentResult, type ConfigOverride, renderEntry , hydrate } from "../../source-fixture.ts";
import { renderKnowledge, tokens } from "../../../src/core/render/index.ts";
import { commitNoterKnowledge } from "../../noting-knowledge-fixture.ts";
import fixture from "../../fixtures/noting/turns.json";
import memories from "../../fixtures/noting/facts.json";
import { setKnowledgeCapacity } from "../../knowledge-budget-fixture.ts";

let directory: string;
let memory: ReturnType<typeof sourceSeededMemory>;
let sessionId: number;
let calls: NotingAgentInput[];
type ScriptResult = RunAgentResult & { noteInput?: unknown; memoryInput?: unknown };
let script: ((input: NotingAgentInput) => Promise<ScriptResult>)[];
const time = "2026-08-16 02:54";
const request = { system: "actual host system", messages: [{ role: "user", content: "actual provider input" }], tools: [] };
// 26a: a Noter completes its batch by calling `note`, and an empty batch is submitted explicitly as
// `note({facts: []})`. `silent` is the run that submits nothing at all, which is incomplete.
const success = (batches: { facts: unknown[] }[]): ScriptResult => ({ outcome: "success", output: "Done.", noteInput: { facts: batches.flatMap((b) => b.facts) }, memoryInput: { operations: [], skipped: [] }, request, usage: { tokens: 12 } });
const silent = (): ScriptResult => ({ outcome: "success", output: "Nothing to note.", request, usage: { tokens: 12 } });
const fact = (extra = {}) => ({ text: memories.base, source: ["T1#E2"], ...extra });
const batch = (turnId: number, facts = [fact()]) => ({ turn: `S${sessionId}/T${turnId}`, title: "mapC terrain", topic: "terrain", facts: facts.map((f) => ({ ...f, source: f.source[0] === "T1#E2" ? [`T${turnId}#E${hydrate(memory.store.listSourceEntries(sessionId), memory.store).find(e => e.turnId === turnId && e.role === "assistant")!.entryOrdinal}`] : f.source })) });
function open(config: ConfigOverride = {}) {
  memory = sourceSeededMemory(join(directory, "test.sqlite"), async (raw) => {
    const input = raw as NotingAgentInput;
    calls.push(input);
    const next = script.shift();
    if (!next) throw new Error("unexpected model call");
    const result = await next(input);
    if (result.request !== undefined) input.reportRequest(result.request);
    if (result.noteInput !== undefined) {
      const note = input.tools.find((t) => t.name === "note")!;
      note.execute(result.noteInput);
    }
    if (result.memoryInput !== undefined) input.tools.find(tool => tool.name === "memory")!.execute(result.memoryInput);
    return result;
  }, config);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "trace-memory-noting-")); calls = []; script = []; open();
  const project = memory.store.createProject({ name: "fixture", declaredBy: "mark" });
  sessionId = memory.store.createSession({ enrollmentChoice: true, host: "pi:noting", startedAt: time, firstReplyAt: time, projectId: project.id }).id;
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
function unchanged(_branch = "main") {
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  expect(hydrate(memory.store.listSourceEntries(sessionId), memory.store).some(e => memory.store.entryNoted(e.id))).toBe(false);
}

test("a turn arriving during the model call waits for the next trigger", async () => {
  const first = turn(), resolve = deferred();
  const pending = noting(first.id);
  const second = turn(first.id, 1);
  expect(calls[0]!.range.to).toBe(`S${sessionId}/T${first.id}`);
  expect(calls[0]!.text).not.toContain(second.userPrompt!);
  resolve(success([batch(first.id)]));
  const result = await pending;
  expect(result.outcome).toBe("success");
  expect(hydrate(memory.store.sourcePath(sessionId, "main", first.id), memory.store).length).toBeGreaterThan(0);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", first.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
  script.push(async () => success([batch(second.id, [fact({ source: [`T${second.id}#E1`], support: [["F1", "weak"]] })])]));
  await noting(second.id);
  expect(calls[1]!.text).toContain(second.userPrompt!);
  expect(calls[1]!.material.facts[0]).toContain("[F1]");
  expect(calls[1]!.text).not.toContain(first.userPrompt!);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", second.id), memory.store).length).toBeGreaterThan(0);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", second.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.listSessionFacts(sessionId)).toHaveLength(2);
  expect(await noting(second.id)).toEqual({ outcome: "empty" });
  expect(calls).toHaveLength(2);
});

test("switching branch while pending keeps the old branch's progress and excludes the sibling", async () => {
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
  expect(hydrate(memory.store.sourcePath(sessionId, "old", old.id), memory.store).length).toBeGreaterThan(0);
  expect(hydrate(memory.store.sourcePath(sessionId, "old", old.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(hydrate(memory.store.sourcePath(sessionId, "new", sibling.id), memory.store).length).toBeGreaterThan(0);
  expect(hydrate(memory.store.sourcePath(sessionId, "new", sibling.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(calls[1]!.text).not.toContain(`[S${sessionId}/T${old.id}]`);
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
  ["event status", { status: "completed" }, "status"],
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

test("26a: final text is never parsed and never an implicit submission; a successful reply without provider request fails", async () => {
  const t = turn(); script.push(async () => ({ outcome: "success", output: "[", request }));
  expect((await noting(t.id)).outcome).toBe("failure"); // ended without calling note: incomplete
  expect(memory.store.listSessionFacts(sessionId)).toEqual([]);
  unchanged(); // and no entry of the batch advanced, so the same entries are pending
  script.push(async () => ({ outcome: "success", output: "[]" }));
  expect((await noting(t.id)).outcome).toBe("failure");
  const next = turn(t.id);
  script.push(async () => success([]));
  expect((await noting(next.id)).outcome).toBe("success"); // the explicit empty batch does advance them
  expect(hydrate(memory.store.sourcePath(sessionId, "main", t.id), memory.store).length).toBeGreaterThan(0);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", t.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
});

test("model cannot write to a late turn outside the frozen range", async () => {
  const first = turn(), resolve = deferred(), pending = noting(first.id), late = turn(first.id, 1);
  resolve(success([batch(late.id)]));
  expect((await pending).outcome).toBe("bounced"); unchanged();
});

test("an explicit empty submission notings the range; compactions cannot acquire facts", async () => {
  const t = memory.store.appendTurn({ sessionId, kind: "compaction", startedAt: time });
  // 17a supersedes whole-Turn progress: compactions have no eligible source entry.
  expect((await noting(t.id)).outcome).toBe("empty");
  expect(calls).toHaveLength(0);
  const raw = turn(t.id); script.push(async () => success([])); await noting(raw.id);
  expect(hydrate(memory.pendingEntries(sessionId, "main", raw.id), memory.store)).toEqual([]);
});

test("read knowledge revisions and exact provider request are recorded, even when a knowledge item moves", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await noting(first.id);
  const created = commitNoterKnowledge(memory.store, { run: { sessionId, createdAt: time }, operations: [
    { op: "create", topics: [], reason: "Initial admission of this conclusion.", handle: "$e1", author: "fake", category: "understanding", scope: "project", text: memories.knowledge, supports: [1], createdAt: time },
  ] });
  expect(created.ok).toBe(true);
  const second = turn(first.id, 1), resolve = deferred(), pending = noting(second.id);
  expect(calls[1]).not.toHaveProperty("readKnowledgeCommits");
  // Fresh N now receives current visible knowledge through the shared compact renderer, without a read grant.
  expect(calls[1]!.material.knowledge!.map(group => group.text).join("\n")).toContain(`[K1#${memory.store.versionTag(1, 1)}]`);
  expect(calls[1]!.text).toContain(memories.knowledge);
  expect(commitNoterKnowledge(memory.store, { run: { sessionId, createdAt: time }, operations: [
    { op: "update", topics: [], reason: "Substantive correction of the recorded conclusion.", knowledgeId: 1, baseCommit: 1, category: "understanding", scope: "project", text: memories.editedKnowledge, supports: [1], createdAt: time },
  ] }).ok).toBe(true);
  resolve(success([])); const result = await pending;
  if (result.outcome !== "success") throw new Error("expected success");
  const run = memory.store.getRun(result.runId)!;
  expect(JSON.parse(run.response!)).not.toHaveProperty("readKnowledgeCommits");
  expect(JSON.parse(run.request!)).toEqual(request);
  expect(run.model).toBe("fake-model"); expect(run.promptHash).toMatch(/^[0-9a-f]{64}$/);
  expect(run.request).not.toBe(calls[1]!.text);
});

const golden = (name: string) => readFileSync(new URL(`../../fixtures/noting/${name}.txt`, import.meta.url), "utf8").trimEnd();
test("fixture turn golden and noting input use identical rendering with receipts last", async () => {
  const first = turn(); turn(first.id, 1);
  expect(memory.trace("T1")).toBe(golden("turn"));
  expect(memory.trace("T2")).toBe(golden("read"));
  script.push(async (input) => {
    // 17a: automatic Raw uses completed entries; explicit trace retains its independent full read.
    const views = hydrate(memory.pendingEntries(sessionId, "main", first.id), memory.store).map(e => renderEntry(e, memory.config.render).content).join("\n\n");
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
  // Stored legacy rows keep their original metadata and source selectors. New N
  // writes above exercise the new schema; this golden deliberately tests history.
  const legacy = memory.store.commitNotingRun({ run: { kind: "noting", sessionId, branch: "main", createdAt: time }, facts: [
    { turnId: first.id, category: "observation", actor: "agent", text: memories.base, quote: memories.quote, source: ["T1#assistant"], createdAt: time },
    { turnId: second.id, category: "interpretation", actor: "agent", text: memories.interpretation, source: ["T2#assistant"], support: [{ target: "$1", strength: "weak" }], createdAt: time },
    { turnId: second.id, category: "observation", actor: "agent", text: memories.observation, source: ["T2#assistant"], negate: [{ target: "$1", strength: "strong" }], createdAt: time },
  ] });
  expect(legacy.ok).toBe(true);
  expect([1, 2, 3].map((id) => memory.trace(`F${id}`)).join("\n\n")).toBe(golden("facts"));
});

test("full expands selected calls; cap is the listing budget and address flags are rejected", () => {
  const t = turn();
  const full = memory.trace(`T${t.id}`, { tool: 2, full: true });
  expect(full).toContain(fixture[0]!.calls[1]!.result!);
  // 23c: `full` is the entry renderer's unbounded path, so the selected call carries the same labels
  // every other view uses; the unselected one keeps its floor and its receipt.
  expect(full).toContain("[T1#E5@call-2] Bash success: ");
  expect(full).toContain("[T1#E3@call-1] mcp__plugin_claude-mnemo_mnemo__note(...)");
  expect(memory.trace(`T${t.id}`, { cap: 1 })).toContain("cursor=");
  expect(() => memory.trace("T1", { tool: 99 })).toThrow("does not exist");
  expect(() => memory.trace("T1 cap=0")).toThrow("invalid trace address");
});

test("86: an oldest entry exceeding the batch envelope still reaches the Noter", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await noting(first.id);
  memory.close(); open({ render: { episodicBlockTokens: 1 } });
  const second = turn(first.id, 1);
  const before = hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store);
  script.push(async () => success([]));
  await noting(second.id);
  expect(calls).toHaveLength(2); // the first item is admitted despite the soft ceiling
  expect(hydrate(memory.pendingEntries(sessionId, "main", second.id), memory.store).length).toBeLessThan(before.length);
});

// The retired C cap used the shared renderer. Pin it through foreground injection until 06
// integrates that renderer into fresh-N material; omission never removes trace access.
test("64c: no knowledge category bypasses the cap, newer commits are kept, and omitted items stay traceable", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await noting(first.id);
  const categories = ["constraint", "open", "goal", "understanding", "reference"] as const;
  expect(commitNoterKnowledge(memory.store, { run: { sessionId, createdAt: time }, operations: categories.map((category, i) => ({
    op: "create", topics: [], reason: "Initial admission of this conclusion." as const, handle: `$e${i + 1}`, author: "fake", category, scope: "project" as const,
    text: `${memories.knowledge} ${"word ".repeat(600)}`, supports: [1], createdAt: time,
  })) }).ok).toBe(true);
  const item = (id: number) => renderKnowledge(memory.store.currentKnowledge(memory.store.knowledgePath(sessionId, "main")).find(k => k.knowledge.id === id)!, `K${id}#${memory.store.versionTag(id, id)}`);
  // With five admitted categories instead of seven, a 3k window still forces
  // whole-item omission. Use the real capacity policy rather than empty knowledge.
  memory.close(); open();
  setKnowledgeCapacity(memory, 3_000);
  const cap = 3_000;
  const injection = memory.injection({ sessionId, branch: "main", headTurnId: first.id });
  const text = injection.text;
  const kept = [...text.matchAll(/\[K(\d+)#[a-z]+\]/g)].map(match => Number(match[1]));
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.length).toBeLessThan(categories.length); // the cap really binds
  expect(kept).toEqual(categories.map((_, index) => index + 1).slice(-kept.length)); // one chronological list, newest retained
  for (const id of kept) expect(text).toContain(item(id)); // complete tagged bodies, never rewritten
  expect(text).toContain("omitted");
  for (let id = 1; id <= categories.length; id++) expect(memory.trace(`K${id}`)).toContain("word word");
  expect(tokens(text)).toBeLessThanOrEqual(cap);
});

test("selected historical facts display by Turn time rather than insertion id", async () => {
  const first = turn();
  const later = memory.store.appendTurn({ sessionId, parentTurnId: first.id, kind: "turn", assistantText: "later", startedAt: "2026-08-16 03:00" });
  script.push(async () => success([batch(later.id), batch(first.id)])); await noting(later.id);
  const second = turn(later.id, 1); script.push(async () => success([])); await noting(second.id);
  expect(calls[1]!.text.indexOf("[F2]")).toBeLessThan(calls[1]!.text.indexOf("[F1]"));
});

test("reopening the database preserves the run, facts and watermark", async () => {
  const first = turn(); script.push(async () => success([batch(first.id)])); await noting(first.id);
  const traced = memory.trace("F1"); memory.close(); open();
  expect(memory.trace("F1")).toBe(traced);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", first.id), memory.store).length).toBeGreaterThan(0);
  expect(hydrate(memory.store.sourcePath(sessionId, "main", first.id), memory.store).every(e => memory.store.entryNoted(e.id))).toBe(true);
  expect(memory.store.getRun(1)?.outcome).toBe("success");
});

/** Ticket 20 "Primary entry bound" and acceptance scenario 8, under 30's one profile. The renderer
 * either returns an entry inside its configured budget or throws: it never returns an oversized view,
 * and an entry whose mandatory labels and omission markers cannot fit leaves Noting pending with no
 * progress. */
test("20b 2026-09-08 scenario 8: an entry whose mandatory metadata cannot fit is a capacity failure, never an oversized success", async () => {
  const first = turn();
  const views = hydrate(memory.pendingEntries(sessionId, "main", first.id), memory.store).map(e => renderEntry(e, memory.config.render).content);
  for (const view of views) expect(tokens(view)).toBeLessThanOrEqual(memory.config.render.entryTokens); // bounded, labels included
  const before = hydrate(memory.pendingEntries(sessionId, "main", first.id), memory.store);
  memory.close(); open({ render: { entryTokens: 4, toolInputTokens: 4, toolResultTokens: 4 } });
  script.push(async () => success([]));
  await expect(noting(first.id)).rejects.toThrow("entry view capacity cannot hold source labels and omission markers");
  expect(calls).toEqual([]);
  expect(memory.store.listRuns(sessionId)).toEqual([]);
  expect(hydrate(memory.pendingEntries(sessionId, "main", first.id), memory.store)).toEqual(before);
});
