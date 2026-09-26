// Review of 80e2cb5..26df70e (2026-09-09), two footer gaps in 24a: a refresh with scoped knowledge
// must not load a run's audit body to learn which session the run belonged to, and a business
// commit made by a running worker must show in the footer before the worker's trailing reply lands.
import { expect, test, vi } from "vitest";
import { host } from "./test-host.ts";
import { fixture, worker, toolResults, say, noteAndMemory, noteBatch } from "./native-fixture.ts";
import { countRunBodies } from "../../perf/fixture.ts";

test("24a review: a footer refresh with session-scoped knowledge reads no run audit body", async () => {
  const h = host({ "noting.triggerTokens": 1e9 });
  try {
    await h.turn();
    const noted = h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: "t" },
      facts: [{ turnId: 1, category: "observation", actor: "user", text: "evidence", source: ["T1#user"], createdAt: "t" }] });
    if (!noted.ok) throw new Error(noted.problems.join("; "));
    // The originating manual run carries a megabyte of request audit: scope resolution must not read it.
    const integrated = h.memory.store.commitConsolidationRun({ path: { sessionId: 1, branch: "main", headTurnId: 1 },
      run: { kind: "manual", sessionId: 1, branch: "main", createdAt: "t", request: "Q".repeat(1_000_000),
        response: JSON.stringify({ usage: { input: 10, output: 2, cost: { total: 0.01 } } }) },
      operations: [{ op: "create", handle: "k", text: "A scoped conclusion", category: "understanding", scope: "session",
        supports: [noted.facts[0]!.id], reason: "evidence", topics: [], author: "fake", createdAt: "t" }] });
    if (!integrated.ok) throw new Error(integrated.problems.join("; "));
    const bodies = countRunBodies();
    try {
      await h.emit("agent_end");
      expect(h.statuses.get("trace-memory")).toMatch(/memory: 1\/1 /); // the scoped current version is pending for D
      expect(bodies.chars()).toBe(0);
    } finally { bodies.restore(); }
  } finally { await h.dispose(); }
});

test("24a review: Noter held output stays pending in the footer until its normal terminal reply", async () => {
  const f = await fixture({ "noting.forkModeDefault": false });
  let release!: (r: Response) => void;
  let closing = false;
  const pending = new Promise<Response>(resolve => { release = resolve; });
  let turn: Promise<unknown> | undefined;
  try {
    // Both tools stage output; publication waits for the final reply held open at the wire.
    f.script(body => !worker(body) ? say("parent reply") : toolResults(body) ? (closing = true, pending) : noteAndMemory("n", noteBatch));
    turn = f.turn();
    await vi.waitFor(() => { expect(closing).toBe(true); expect(f.h.memory.store.listSessionFacts(1)).toHaveLength(0); }, { timeout: 5000 });
    expect(f.h.memory.progress(1, "main", 1)).toMatchObject({ entries: 2, facts: 0 });
    const footer = f.h.statuses.get("trace-memory")!;
    expect(footer).toContain("notes: 2->0 memory: 0/0");
    expect(footer).toContain("●"); // the worker is still running: the indicator says so
    release(say("done")); await turn; await f.h.drain();
    expect(f.h.memory.store.listSessionFacts(1)).toHaveLength(1);
    expect(f.h.memory.progress(1, "main", 1)).toMatchObject({ entries: 0, facts: 1 });
  } finally { release(say("done")); await turn; await f.dispose(); }
}, 15000);
