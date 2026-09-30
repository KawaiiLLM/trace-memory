// 22d: a freeze whose unavoidable costs already exceed the model's input allowance is rejected before
// any candidate material is built, and the session's spend is aggregated from usage rather than from
// run audit bodies. The contracts pinned here are public: the rejection's observable effects (no
// dispatch, no run, no progress, nothing rendered), the fact that the preflight is a floor and never
// the final guard, and spend totals that keep an unknown usage distinct from an observed zero.
import { afterEach, beforeEach, expect, test } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceSeededMemory, tokens, toolDefinitions, type NotingAgentInput } from "../../source-fixture.ts";
import { countRunBodies } from "../../perf/fixture.ts";
import { Store } from "../../../src/core/store/index.ts";
import { renderRun } from "../../../src/core/render/index.ts";

/** 77: every real writer stores `response` and its five usage columns in one statement (Store's
 * private `usageColumns` helper), so a raw-SQL amendment that only sets `response` -- exactly what
 * these tests used before 77 -- now leaves a run's usage columns stale (null, "no observation"),
 * which is no longer a valid fixture: spend reads the columns, never `response`. This mirrors that
 * derivation for the well-formed shapes these tests write (an object `usage`, or none); the
 * deliberately odd shapes -- scalars, booleans, non-JSON -- are pinned separately below against 71's
 * own extraction SQL, not re-derived by hand here. */
function writeRunResponse(store: Store, runId: number, response: unknown): void {
  const usage = response && typeof response === "object" && "usage" in (response as object) ? (response as { usage?: unknown }).usage : undefined;
  const columns = usage && typeof usage === "object" ? [
    (usage as { input?: number }).input ?? 0, (usage as { output?: number }).output ?? 0,
    (usage as { cacheRead?: number }).cacheRead ?? 0, (usage as { cacheWrite?: number }).cacheWrite ?? 0,
    (usage as { cost?: { total?: number } }).cost?.total ?? null,
  ] : [null, null, null, null, null];
  // 79: `response` moved to `run_bodies`; the usage columns stay on `runs`.
  store.db.prepare("UPDATE run_bodies SET response = ? WHERE run_id = ?").run(JSON.stringify(response), runId);
  store.db.prepare(`UPDATE runs SET usage_input = ?, usage_output = ?, usage_cache_read = ?, usage_cache_write = ?, usage_cost = ? WHERE id = ?`)
    .run(...columns, runId);
}

const time = "2026-09-09T00:00:00Z";
let directory: string, dbPath: string, memory: ReturnType<typeof sourceSeededMemory>;
let calls: NotingAgentInput[], renders: number;
let sessionId: number, turnId: number;

/** One session with `entries` tool results pending, and a result extractor that counts how many entry
 * views are rendered: `renderEntry` reads a tool result through it exactly once per view, so it is a
 * render counter that needs no production hook. */
function open(entries = 6) {
  calls = []; renders = 0;
  // 26a: with nothing to record a Noter still submits the explicit empty batch to complete it.
  memory = sourceSeededMemory(dbPath, async raw => { const input = raw as NotingAgentInput; calls.push(input);
      if (input.kind === "noting") {
        input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
        input.tools.find(tool => tool.name === "memory")!.execute({ operations: [], skipped: [] });
      }
      return { outcome: "success", output: "", request: { probe: true } }; },
    {}, result => { renders++; return { text: result }; });
  const project = memory.store.createProject({ name: "capacity", declaredBy: "mark" });
  sessionId = memory.store.createSession({ host: "test", startedAt: time, firstReplyAt: time, projectId: project.id, enrollmentChoice: true }).id;
  turnId = memory.store.appendTurn({ sessionId, kind: "turn", userPrompt: "Source", assistantText: "Reply", startedAt: time }).id;
  for (let i = 0; i < entries; i++) memory.store.appendToolCall({ turnId, name: "read", input: `{"path":"f${i}"}`, result: `result ${i} ` + "word ".repeat(40), status: "success" });
  renders = 0;
}
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "trace-memory-22d-")); dbPath = join(directory, "trace.db"); open(); });
afterEach(() => { memory.close(); rmSync(directory, { recursive: true, force: true }); });

const noting = (capacity?: { inputTokens: number; prefixTokens: number }, extra: Record<string, unknown> = {}) =>
  memory.noting({ sessionId, branch: "main", headTurnId: turnId, mode: "subagent", ...(capacity ? { capacity } : {}), ...extra });

test("22d: an allowance under the mandatory instruction and tool cost is rejected with nothing rendered, dispatched or recorded", async () => {
  const before = memory.pendingEntries(sessionId, "main", turnId);
  expect(before.length).toBeGreaterThan(1);
  await expect(noting({ inputTokens: 2_000, prefixTokens: 0 })).rejects.toThrow(/Noting capacity/);
  expect(renders).toBe(0); // no candidate material was built: not one entry view
  expect(calls).toEqual([]); // no model dispatch
  expect(memory.store.listRuns(sessionId)).toEqual([]); // no run record
  expect(memory.pendingEntries(sessionId, "main", turnId)).toEqual(before); // no progress advanced
  expect(memory.spend(sessionId)).toMatchObject({ runs: { noting: 0, consolidation: 0, manual: 0 }, input: 0, cost: 0 });
});

test("22d: the rejection costs the same whatever the pending backlog is, and a workable allowance still renders each pending view once", async () => {
  await expect(noting({ inputTokens: 2_000, prefixTokens: 0 })).rejects.toThrow(/Noting capacity/);
  expect(renders).toBe(0);
  memory.close();
  open(24); // four times the pending entries
  await expect(noting({ inputTokens: 2_000, prefixTokens: 0 })).rejects.toThrow(/Noting capacity/);
  expect(renders).toBe(0);
  // The same freeze under a workable allowance: every pending tool result is rendered once, and the
  // re-freezing capacity negotiation reuses those views instead of rendering the batch per candidate.
  const results = memory.store.hydrateSourceEntries(memory.pendingEntries(sessionId, "main", turnId).map(e => e.id))
    .filter(entry => entry.role === "toolResult").length;
  expect(results).toBe(24);
  renders = 0;
  expect((await noting()).outcome).toBe("success");
  expect(renders).toBe(results);
});

test("22d: the preflight is a floor and not the guard — an allowance over the fixed cost but under the material is still refused", async () => {
  expect((await noting()).outcome).toBe("success");
  const first = calls[0]!;
  const fixed = tokens(first.prompt) + tokens(JSON.stringify(toolDefinitions)); // what the preflight alone can see
  memory.appendEntry({ sessionId, turnId, nativeLineage: "fixture", nativeId: "long-assistant", role: "assistant", text: "word ".repeat(5_000), raw: "", calls: [] });
  // Comfortably above the mandatory floor, so the preflight passes and says nothing; far below what
  // the pending material costs, so the hard-budget check inside the freeze must still refuse to send.
  await expect(noting({ inputTokens: fixed + 500, prefixTokens: 0 })).rejects.toThrow(/Noting capacity/);
  expect(calls).toHaveLength(1); // nothing dispatched over the allowance
  expect(memory.store.listRuns(sessionId)).toHaveLength(1); // the first run only; the refused freeze recorded none
  // The same pending material under an allowance that fits runs, priced under what it was given.
  const generous = 60_000;
  expect((await noting({ inputTokens: generous, prefixTokens: 0 })).outcome).toBe("success");
  const run = calls.at(-1)!;
  expect(tokens(run.prompt) + tokens(JSON.stringify(toolDefinitions)) + tokens(run.text)).toBeLessThanOrEqual(generous);
});

// 27a: the host's half of the rule (`contextWindow - 10,000`) is pinned in tests/hosts/pi/capacity.test.ts.
// This is core's half: whatever allowance it is handed, it admits material that exactly fits and
// refuses the same material one token above it — for a fresh child and for an inherited one, whose
// prefix is the host's context measure and is counted once.
test("27a 2026-09-10: the freeze admits material the allowance exactly fits and refuses the same material one token above it", async () => {
  const price = (input: NotingAgentInput, prefix = 0) =>
    prefix ? prefix + tokens(input.prompt) + tokens(input.text)
      : tokens(input.prompt) + tokens(JSON.stringify(toolDefinitions)) + tokens(input.text);
  // What this batch costs, priced by the same terms the freeze prices it by.
  expect((await noting({ inputTokens: 60_000, prefixTokens: 0 })).outcome).toBe("success");
  const whole = calls[0]!;
  const fresh = price(whole);

  // Each re-open seeds the same conversation as a new session in the same database, so the batches are
  // compared by size and by price, not by entry id.
  memory.close(); open();
  expect((await noting({ inputTokens: fresh, prefixTokens: 0 })).outcome).toBe("success");
  expect(calls[0]!.entryIds).toHaveLength(whole.entryIds.length); // equality: the whole batch, not a reduced one
  expect(price(calls[0]!)).toBe(fresh);

  memory.close(); open();
  expect((await noting({ inputTokens: fresh - 1, prefixTokens: 0 })).outcome).toBe("success");
  expect(calls[0]!.entryIds.length).toBeLessThan(whole.entryIds.length); // one token more: refused, and reduced

  // The same boundary for a fork, whose price adds the host's frozen context measure once.
  const prefix = 20_000;
  memory.close(); open();
  const forked = { mode: "fork" as const, effectiveMode: "fork" as const };
  expect((await noting({ inputTokens: price(whole, prefix), prefixTokens: prefix }, forked)).outcome).toBe("success");
  expect(calls[0]!.entryIds).toHaveLength(whole.entryIds.length);
  memory.close(); open();
  expect((await noting({ inputTokens: price(whole, prefix) - 1, prefixTokens: prefix }, forked)).outcome).toBe("success");
  expect(calls[0]!.entryIds.length).toBeLessThan(whole.entryIds.length); // one token more: refused, and reduced
});

test("22d: spend totals come from the recorded usage without loading a run's request or response body", async () => {
  expect((await noting()).outcome).toBe("success");
  const usage = { input: 1_200, output: 300, cacheRead: 4_000, cacheWrite: 100, cost: { total: 0.25 } };
  const write = (runId: number, response: unknown) => writeRunResponse(memory.store, runId, response);
  const runId = memory.store.listRuns(sessionId)[0]!.id;
  write(runId, { output: "x".repeat(200_000), usage, problems: [] });
  // The pre-change implementation, computed here from the bodies: the same totals, read the slow way.
  const reference = { runs: { noting: 0, consolidation: 0, dreaming: 0, manual: 0 }, costs: { noting: 0, consolidation: 0, dreaming: 0, manual: 0 },
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, unknown: 0 };
  for (const run of memory.store.listRuns(sessionId)) {
    reference.runs[run.kind]++;
    let recorded: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | null = null;
    try { recorded = JSON.parse(run.response ?? "{}").usage ?? null; } catch { recorded = null; }
    if (!recorded) continue;
    reference.input += recorded.input ?? 0; reference.output += recorded.output ?? 0;
    reference.cacheRead += recorded.cacheRead ?? 0; reference.cacheWrite += recorded.cacheWrite ?? 0; reference.cost += recorded.cost?.total ?? 0;
    reference.costs[run.kind] += recorded.cost?.total ?? 0; // 51: the same total, attributed by kind
  }
  const bodies = countRunBodies();
  try {
    bodies.reset();
    expect(memory.spend(sessionId)).toEqual(reference);
    expect(bodies.chars()).toBe(0); // no request or response body entered JavaScript
  } finally { bodies.restore(); }

  // A later usage amendment on the same run is reflected exactly, and nothing is double-counted.
  write(runId, { output: "x".repeat(200_000), usage: { ...usage, input: 2_200, cost: { total: 0.5 } }, problems: [] });
  expect(memory.spend(sessionId)).toMatchObject({ input: 2_200, output: 300, cacheRead: 4_000, cost: 0.5, runs: { noting: 1, consolidation: 0, manual: 0 } });
});

test("22d: an unknown or non-JSON usage counts its run and contributes no observed zero", async () => {
  expect((await noting()).outcome).toBe("success");
  const runId = memory.store.listRuns(sessionId)[0]!.id;
  const observed = { input: 900, output: 90, cacheRead: 10, cacheWrite: 1, cost: { total: 0.125 } };
  writeRunResponse(memory.store, runId, { output: "done", usage: observed });
  const one = memory.spend(sessionId);
  const cancelled = memory.store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "cancelled", createdAt: time,
    response: JSON.stringify({ output: "cancelled", usage: null, usageStatus: "unknown" }) }).id;
  const failed = memory.store.recordRun({ kind: "consolidation", sessionId, branch: "main", outcome: "failure", createdAt: time,
    response: "provider refused: not JSON at all" }).id;
  expect(cancelled).not.toBe(failed);
  const after = memory.spend(sessionId);
  expect(after).toMatchObject({ input: one.input, output: one.output, cacheRead: one.cacheRead, cacheWrite: one.cacheWrite, cost: one.cost });
  expect(after.runs).toEqual({ noting: 2, consolidation: 1, dreaming: 0, manual: 0 }); // counted as runs, never as usage
  // A run that did record an all-zero usage is an observation, and stays one: the totals are unchanged
  // by it, but it is not confused with the two above — its usage is present in the projection.
  writeRunResponse(memory.store, cancelled, { output: "empty", usage: {} });
  expect(memory.store.listRunUsage(sessionId).map(r => r.usage === null)).toEqual([false, false, true]);
  expect(memory.spend(sessionId)).toMatchObject({ input: one.input, cost: one.cost });
});

// 77: listRunUsage now reads only the five usage columns through `idx_runs_session_usage`, never
// `request` or `response` -- superseding 71's read-time reparse (a per-refresh multi-path
// `json_extract`), whose one-parse query survives only as the schema upgrade's backfill. These cases
// pin that (a) the statement it issues never mentions `response`/`request` and is answered by the
// covering index alone, whatever the response's shape at write time (a large body, a stray scalar
// `usage`, a string that itself looks like JSON, a non-JSON response, or no response at all), (b) an
// amendment from a second connection is seen with no cache to invalidate, and (c) `since` stays an
// inclusive UTC boundary across midnight (in `spendSince`, below).
test("77: listRunUsage never selects response or request, served by its covering index alone", async () => {
  expect((await noting()).outcome).toBe("success");
  const runId = memory.store.listRuns(sessionId)[0]!.id;
  const bigOutput = "x".repeat(200_000);
  writeRunResponse(memory.store, runId, { output: bigOutput, usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } });
  memory.store.recordRun({ kind: "consolidation", sessionId, branch: "main", outcome: "cancelled", createdAt: time,
    response: JSON.stringify({ usage: null }) });
  memory.store.recordRun({ kind: "manual", sessionId, branch: "main", outcome: "failure", createdAt: time, response: "not json at all" });
  memory.store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "success", createdAt: time, response: null as unknown as string });
  // A stray non-object usage, including one whose string contents look like a JSON object — it must
  // stay "observed, all fields zero", never be reparsed into an object by its own textual shape.
  memory.store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "success", createdAt: time,
    response: JSON.stringify({ usage: '{"input":999}' }) });

  const original = memory.store.db.prepare.bind(memory.store.db);
  const statements: string[] = [];
  (memory.store.db as unknown as { prepare: typeof memory.store.db.prepare }).prepare = ((sql: string) => { statements.push(sql); return original(sql); }) as typeof memory.store.db.prepare;
  let usage: ReturnType<typeof memory.store.listRunUsage>;
  try { usage = memory.store.listRunUsage(sessionId); }
  finally { (memory.store.db as unknown as { prepare: typeof memory.store.db.prepare }).prepare = original; }

  expect(statements).toHaveLength(1); // one statement, no per-row follow-up query
  expect(statements[0]).not.toMatch(/\bresponse\b|\brequest\b/); // the audit bodies are never named
  // 79: the split (item 0) retired the covering idx_runs_session_usage -- `runs` has no body columns
  // to dodge anymore, so SCHEMA_SQL's plain idx_runs_session answers the same lookup on a tiny row.
  expect(statements[0]).toMatch(/INDEXED BY idx_runs_session\b/);
  expect(usage.map(u => u.usage === null)).toEqual([false, true, true, true, false]);
  expect(usage[4]!.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null }); // the string usage: zero tokens, not reparsed; no cost.total, so the cost is unknown
});

test("77: listRunUsage's persisted columns match 71's extraction SQL for every scalar shape, booleans included", async () => {
  expect((await noting()).outcome).toBe("success");
  // Historical responses can carry odd scalar types. `usageColumns` (the one write-time helper every
  // writer of `response` routes through) must reproduce the same result the old read-time SQL
  // extracted (JSON true -> 1, false -> 0), not drop it. `recordRun` writes both in one statement, so
  // this reads them straight back through `listRunUsage`'s covering index, not the SQL below --
  // which is independent ground truth, computed here against the same `response` text for comparison.
  const shapes: unknown[] = [
    { usage: { input: true, output: false, cacheRead: "7", cacheWrite: null, cost: { total: true } } },
    { usage: { input: 3, output: 2.5, cacheRead: -1, cacheWrite: [1], cost: { total: { nested: 1 } } } },
    { usage: false }, { usage: 0 }, { usage: "text" }, { usage: [] }, { usage: null }, {},
  ];
  for (const response of shapes) memory.store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "success",
    createdAt: time, response: JSON.stringify(response) });
  // 79: `response` lives in `run_bodies` now; join it back in for this independent-ground-truth query.
  const legacy = memory.store.db.prepare(`SELECT r.kind,
      CASE WHEN json_valid(b.response) THEN json_type(b.response, '$.usage') END recorded,
      CASE WHEN json_valid(b.response) THEN json_extract(b.response, '$.usage.input') END input,
      CASE WHEN json_valid(b.response) THEN json_extract(b.response, '$.usage.output') END output,
      CASE WHEN json_valid(b.response) THEN json_extract(b.response, '$.usage.cacheRead') END cacheRead,
      CASE WHEN json_valid(b.response) THEN json_extract(b.response, '$.usage.cacheWrite') END cacheWrite,
      CASE WHEN json_valid(b.response) THEN json_extract(b.response, '$.usage.cost.total') END cost
    FROM runs r JOIN run_bodies b ON b.run_id = r.id WHERE r.session_id = ? ORDER BY r.id`).all(sessionId) as Record<string, unknown>[];
  const count = (value: unknown) => (typeof value === "number" ? value : 0);
  const expected = legacy.map(row => ({ kind: row.kind, costUnknown: !(!row.recorded || row.recorded === "null") && typeof row.cost !== "number", usage: !row.recorded || row.recorded === "null" ? null
    : { input: count(row.input), output: count(row.output), cacheRead: count(row.cacheRead), cacheWrite: count(row.cacheWrite), cost: typeof row.cost === "number" ? row.cost : null } }));
  expect(expected.some(value => value.usage?.input === 1 && value.usage.cost === 1)).toBe(true); // the boolean case is really exercised
  expect(memory.store.listRunUsage(sessionId)).toEqual(expected);
});

test("77: an amendment from a second connection to the same file is reflected with no stale cache", async () => {
  expect((await noting()).outcome).toBe("success");
  const runId = memory.store.listRuns(sessionId)[0]!.id;
  const second = new Store(dbPath);
  try {
    writeRunResponse(second, runId, { usage: { input: 500, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.2 } } });
    expect(memory.spend(sessionId)).toMatchObject({ input: 500, output: 50, cost: 0.2 });
    writeRunResponse(second, runId, { usage: { input: 900, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.4 } } });
    expect(memory.spend(sessionId)).toMatchObject({ input: 900, cost: 0.4 }); // no cache stuck on the first read
  } finally { second.close(); }
});

test("71: spendSince keeps an inclusive UTC midnight boundary", async () => {
  memory.store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "success", createdAt: "2026-09-08T23:59:59.000Z",
    response: JSON.stringify({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 1 } } }) });
  memory.store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "success", createdAt: "2026-09-09T00:00:00.000Z",
    response: JSON.stringify({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 2 } } }) });
  memory.store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "success", createdAt: "2026-09-09T00:00:01.000Z",
    response: JSON.stringify({ usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 4 } } }) });
  expect(memory.spendSince("2026-09-09T00:00:00.000Z").cost).toBe(6); // midnight itself counts; the run just before it does not
});

// Ticket 108: tokens without a price (a CC fork's cost until its transcript is read, or when it cannot be
// priced) are stored with a null cost. Unknown is never a zero: it is left out of every total and marked.
test("108: an unknown cost is stored as null, marked in the totals and the daily figure, and rendered as unknown", () => {
  const store = memory.store, known = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } };
  const record = (response: unknown, outcome: "success" | "cancelled" = "success") =>
    store.recordRun({ kind: "noting", sessionId, branch: "main", outcome, createdAt: time, response: JSON.stringify(response) }).id;
  record({ output: "priced", usage: known });
  const tokensOnly = record({ output: "unpriced", usage: { input: 7, output: 1, cacheRead: 3, cacheWrite: 4 } });
  const cancelled = record({ output: "stopped", usage: null, usageStatus: "unknown" }, "cancelled");
  record({ output: "failed before any request" }); // no usage observation, not cancelled: nothing to know
  const rows = store.db.prepare("SELECT id, usage_input, usage_cost FROM runs ORDER BY id").all() as { id: number; usage_input: number | null; usage_cost: number | null }[];
  expect(rows.map(r => [r.usage_input, r.usage_cost])).toEqual([[10, 0.5], [7, null], [null, null], [null, null]]); // null, never 0
  const totals = memory.spend(sessionId);
  expect(totals).toMatchObject({ input: 17, cost: 0.5, unknown: 2, runs: { noting: 4 } }); // the tokens count, the price is left out and marked
  expect(memory.spendSince(time)).toEqual({ cost: 0.5, unknown: 2 });
  expect(store.listRunUsage(sessionId).map(r => r.costUnknown)).toEqual([false, true, true, false]);
  expect(renderRun(store.getRun(tokensOnly)!, [], [])).toContain("cost unknown");
  expect(renderRun(store.getRun(tokensOnly)!, [], [])).not.toContain("$0.0000");
  expect(renderRun(store.getRun(cancelled)!, [], [])).toContain("cost unknown");
  expect(memory.status(sessionId)).toContain("$0.5000 + 2 runs of unknown cost");
});

test("108: amending a recorded run's usage prices it in place: columns follow, problems accumulate, partial is marked", () => {
  const store = memory.store;
  const id = store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "cancelled", createdAt: time,
    response: JSON.stringify({ output: "stopped", usage: null, usageStatus: "unknown", problems: ["stopped"] }) }).id;
  expect(memory.spend(sessionId).unknown).toBe(1);
  store.amendRunUsage(id, { usage: { input: 5, output: 1, cacheRead: 2, cacheWrite: 3, cost: { total: 0.25 } }, usageStatus: "partial", problem: "CC fork cost unknown: example",
    cacheMiss: { miss: true } });
  const run = store.getRun(id)!, response = JSON.parse(run.response!);
  expect(response).toMatchObject({ usage: { input: 5, cost: { total: 0.25 } }, usageStatus: "partial", problems: ["stopped", "CC fork cost unknown: example"], verification: { cacheMiss: { miss: true } } });
  // A partial cost is a lower bound: the known part counts, the run is still marked unknown.
  expect(memory.spend(sessionId)).toMatchObject({ input: 5, cost: 0.25, unknown: 1 });
  expect(memory.spendSince(time)).toEqual({ cost: 0.25, unknown: 1 });
  expect(memory.status(sessionId)).toContain("$0.2500 + 1 run of unknown cost");
  expect(renderRun(run, [], [])).toContain("known usage only; remaining cost unknown");
});
