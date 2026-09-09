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
      if (input.kind === "noting") input.tools.find(tool => tool.name === "note")!.execute({ facts: [] });
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
  const results = memory.pendingEntries(sessionId, "main", turnId).filter(entry => entry.role === "toolResult").length;
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
  expect(tokens(run.prompt) + tokens(JSON.stringify(toolDefinitions)) + tokens(run.text.fresh)).toBeLessThanOrEqual(generous);
});

test("22d: spend totals come from the recorded usage without loading a run's request or response body", async () => {
  expect((await noting()).outcome).toBe("success");
  const usage = { input: 1_200, output: 300, cacheRead: 4_000, cacheWrite: 100, cost: { total: 0.25 } };
  const write = (runId: number, response: unknown) => memory.store.db.prepare("UPDATE runs SET response = ? WHERE id = ?").run(JSON.stringify(response), runId);
  const runId = memory.store.listRuns(sessionId)[0]!.id;
  write(runId, { output: "x".repeat(200_000), usage, problems: [] });
  // The pre-change implementation, computed here from the bodies: the same totals, read the slow way.
  const reference = { runs: { noting: 0, consolidation: 0, manual: 0 }, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const run of memory.store.listRuns(sessionId)) {
    reference.runs[run.kind]++;
    let recorded: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: { total?: number } } | null = null;
    try { recorded = JSON.parse(run.response ?? "{}").usage ?? null; } catch { recorded = null; }
    if (!recorded) continue;
    reference.input += recorded.input ?? 0; reference.output += recorded.output ?? 0;
    reference.cacheRead += recorded.cacheRead ?? 0; reference.cacheWrite += recorded.cacheWrite ?? 0; reference.cost += recorded.cost?.total ?? 0;
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
  memory.store.db.prepare("UPDATE runs SET response = ? WHERE id = ?").run(JSON.stringify({ output: "done", usage: observed }), runId);
  const one = memory.spend(sessionId);
  const cancelled = memory.store.recordRun({ kind: "noting", sessionId, branch: "main", outcome: "cancelled", createdAt: time,
    response: JSON.stringify({ output: "cancelled", usage: null, usageStatus: "unknown" }) }).id;
  const failed = memory.store.recordRun({ kind: "consolidation", sessionId, branch: "main", outcome: "failure", createdAt: time,
    response: "provider refused: not JSON at all" }).id;
  expect(cancelled).not.toBe(failed);
  const after = memory.spend(sessionId);
  expect(after).toMatchObject({ input: one.input, output: one.output, cacheRead: one.cacheRead, cacheWrite: one.cacheWrite, cost: one.cost });
  expect(after.runs).toEqual({ noting: 2, consolidation: 1, manual: 0 }); // counted as runs, never as usage
  // A run that did record an all-zero usage is an observation, and stays one: the totals are unchanged
  // by it, but it is not confused with the two above — its usage is present in the projection.
  memory.store.db.prepare("UPDATE runs SET response = ? WHERE id = ?").run(JSON.stringify({ output: "empty", usage: {} }), cancelled);
  expect(memory.store.listRunUsage(sessionId).map(r => r.usage === null)).toEqual([false, false, true]);
  expect(memory.spend(sessionId)).toMatchObject({ input: one.input, cost: one.cost });
});
