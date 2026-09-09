// Ticket 26b — a worker inherits the foreground thinking level, frozen at admission.
//
// Everything here runs on a real Pi child session with the provider stubbed at the wire, so the
// level asserted on is the one Pi's own session resolution produced and the one the request really
// carried. `test-thinking` is the fixture's only reasoning-capable model: Pi clamps every level to
// `off` on the others, which is what the clamp case below uses.
import { expect, test, vi } from "vitest";
import { host, reply, notingFact, consolidationReply } from "./test-host.ts";
import { call, fixture, noteBatch, say, settled, toolResults, worker, type Body } from "./native-fixture.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";

const at = "2026-09-08T00:00:00.000Z";
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const phaseOf = (c: { systemPrompt?: string }) => c.systemPrompt?.includes("### Second-round user message") ? "consolidation" : "noting";
const thinkingOf = (run: { response?: string | null }) => JSON.parse(run.response!).thinking;
const settle = async (h: ReturnType<typeof host>, rounds = 40) => {
  let last = -1;
  for (let i = 0; i < rounds && last !== h.requests.length; i++) { last = h.requests.length; await h.drain(); }
};
/** A closed tail another session owns, for the borrowed-work path (the shape catchup.test.ts uses). */
function closedTail(memory: ReturnType<typeof TraceMemory>) {
  const project = memory.store.getProject(memory.store.getSession(1)!.projectId)!;
  const session = memory.store.createSession({ host: "target-host", projectId: project.id, startedAt: at, firstReplyAt: at, enrollmentChoice: true });
  const turn = memory.store.appendTurn({ sessionId: session.id, kind: "turn", userPrompt: "Target evidence", startedAt: at });
  const entry = memory.appendEntry({ sessionId: session.id, turnId: turn.id, nativeId: `u${session.id}`, nativeLineage: "target", role: "user", text: "Target evidence", raw: "Target evidence", calls: [] });
  memory.selectEntries(session.id, "main", [entry.id]);
  memory.store.closeSession(session.id);
  return { sessionId: session.id, branch: "main", headTurnId: turn.id };
}

test("26b: a fork worker runs at the frozen foreground level; neither the global default nor the worker model's preference overrides it", async () => {
  // Global default `medium`, a `low` preference for this very model, foreground `high`.
  const f = await fixture({ defaultThinkingLevel: "medium", modelThinkingLevels: { "fake/test-thinking": "low" } },
    "fake", { model: "test-thinking", thinkingLevel: "high" });
  try {
    f.h.setThinkingLevel("high");
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(run.mode).toBe("fork");
    const response = JSON.parse(run.response!);
    expect(response.thinking).toEqual({ requested: "high", effective: "high" });
    // The level really reached the provider, and the inherited request still matches the parent's.
    expect((f.sent[0] as Body).reasoning_effort).toBe("high");
    expect((f.sent[1] as Body).reasoning_effort).toBe("high");
    expect(response.verification.passed).toBe(true);
    expect(response.fallbackReason).toBeUndefined();
  } finally { await f.dispose(); }
});

test("26b: a fresh subagent worker inherits the same frozen level, and a foreground switch mid-run reaches neither its later rounds nor the audit", async () => {
  const h = host({ "noting.triggerTokens": 20, "noting.forkModeDefault": false, notingModel: "fake/test-thinking" });
  try {
    h.setThinkingLevel("high");
    h.provider(async conversation => {
      h.setThinkingLevel("off"); // the user switches the foreground while the worker is running
      return notingFact(conversation);
    }, { autoStop: true });
    await h.turn();
    const run = h.memory.store.listRuns(1).find(r => r.kind === "noting")!;
    expect(run.outcome).toBe("success");
    expect(thinkingOf(run)).toEqual({ requested: "high", effective: "high" });
    // Every round of the run — the first and the one after the `note` result — kept the frozen level.
    expect(h.requests.length).toBeGreaterThan(1);
    expect(h.requests.map((body: any) => body.reasoning_effort)).toEqual(h.requests.map(() => "high"));
    expect(h.getThinkingLevel()).toBe("off");
  } finally { await h.dispose(); }
});

test("26b: a worker model that does not support the level runs at Pi's clamped level, and the audit shows both", async () => {
  const h = host({ "noting.triggerTokens": 20, "noting.forkModeDefault": false, defaultThinkingLevel: "medium" });
  try {
    h.setThinkingLevel("high"); // the default model declares no reasoning support
    h.provider(async conversation => notingFact(conversation));
    await h.turn();
    const run = h.memory.store.listRuns(1).find(r => r.kind === "noting")!;
    expect(run.outcome).toBe("success");
    expect(thinkingOf(run)).toEqual({ requested: "high", effective: "off" });
    // No fabricated reasoning support, and no unrelated default silently substituted.
    expect(h.requests.every((body: any) => body.reasoning_effort === undefined)).toBe(true);
  } finally { await h.dispose(); }
});

test("26b: every launch path freezes the same level — both phases, automatic work, a fork fallback, borrowed closed-session work and manual catchup", async () => {
  const h = host({ "noting.triggerTokens": 20, "consolidation.triggerTokens": 1 });
  try {
    h.setThinkingLevel("high");
    await h.turn(); // allocates the session; fork mode is the Noter's default here
    const tail = closedTail(h.memory);
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Own claim", source: ["T1#user"] }] });
    h.provider(async c => phaseOf(c) === "consolidation" ? consolidationReply() : notingFact(c));
    h.persist(reply("eligible completion")); await h.emit("agent_end"); await settle(h);
    const beforeCatchup = h.memory.store.listRuns(1).length;
    h.persist(reply("more evidence " + "word ".repeat(30)));
    await command(h, "catchup");
    await settle(h);
    expect(h.memory.store.listRuns(1).length, "manual catchup ran at least one run of its own").toBeGreaterThan(beforeCatchup);
    const runs = [...h.memory.store.listRuns(1), ...h.memory.store.listRuns(tail.sessionId)].filter(r => r.kind !== "manual" && r.response);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.map(r => r.kind).includes("consolidation")).toBe(true);
    expect(runs.map(r => r.kind).includes("noting")).toBe(true);
    expect(h.memory.store.listRuns(tail.sessionId).length).toBeGreaterThan(0); // borrowed closed-session work ran
    for (const run of runs) expect(thinkingOf(run), `${run.kind} R${run.id}`).toEqual({ requested: "high", effective: "off" });
    // The Noter asked to fork, the host refused (this fake foreground has no persisted session file)
    // and the fresh child it fell back to kept the frozen level.
    const fallback = runs.find(r => JSON.parse(r.response!).fallbackReason);
    expect(fallback?.mode).toBe("subagent");
    expect(JSON.parse(fallback!.response!).requestedMode).toBe("fork");
  } finally { await h.dispose(); }
});

test("26b: a level that makes the inherited request differ is refused by the existing gate and falls back at the frozen level", async () => {
  const f = await fixture({ defaultThinkingLevel: "medium" }, "fake", { model: "test-thinking", thinkingLevel: "high" });
  try {
    f.h.setThinkingLevel("low"); // deliberately not the level the captured parent request was sent at
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    expect(run.mode).toBe("subagent");
    expect(response.requestedMode).toBe("fork");
    expect(response.fallbackReason).toContain("native prefix mismatch");
    expect(response.verification.native.differingPath).toBe("$.reasoning_effort");
    expect(response.verification.native.normalized).toEqual(["cache_control"]); // the gate is the unchanged one
    expect(response.thinking).toEqual({ requested: "low", effective: "low" });
    // Nothing was sent by the rejected child: the only worker request is the fresh one, at `low`.
    const workerBodies = f.sent.filter(body => worker(body));
    expect(workerBodies.length).toBeGreaterThan(0);
    expect(workerBodies.every(body => body.reasoning_effort === "low")).toBe(true);
  } finally { await f.dispose(); }
});

test("26b: borrowed work inherits the executor's level, not the level any historical session ran at", async () => {
  const h = host({ "noting.triggerTokens": 20, "noting.forkModeDefault": false, notingModel: "fake/test-thinking" });
  try {
    await h.turn();
    const tail = closedTail(h.memory);
    h.setThinkingLevel("high");
    h.provider(async conversation => notingFact(conversation));
    h.persist(reply("eligible completion")); await h.emit("agent_end"); await settle(h);
    const run = await vi.waitFor(() => {
      const found = h.memory.store.listRuns(tail.sessionId).find(r => r.kind === "noting" && r.response);
      expect(found).toBeTruthy(); return found!;
    }, { timeout: 5000 });
    expect(thinkingOf(run)).toEqual({ requested: "high", effective: "high" });
  } finally { await h.dispose(); }
});
