// Ticket 26b — a worker inherits the foreground thinking level, frozen at admission — and ticket
// 26d, which adds the two `notingThinking`/`consolidationThinking` preferences on top of it: a
// second level, frozen with the same task, that every *subagent* run of it uses. A fork keeps
// inheriting (26b), so the 26b cases below are the `inherit` behaviour and stay unchanged.
//
// Everything here runs on a real Pi child session with the provider stubbed at the wire, so the
// level asserted on is the one Pi's own session resolution produced and the one the request really
// carried. `test-thinking` is the fixture's only reasoning-capable model: Pi clamps every level to
// `off` on the others, which is what the clamp cases below use.
import { expect, test, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host, reply, notingFact, consolidationReply } from "./test-host.ts";
import { call, fixture, forkFixture, memoryBatch, noteBatch, say, settled, toolResults, worker, type Body } from "./native-fixture.ts";
import { recorded } from "../../source-fixture.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";

const at = "2026-09-08T00:00:00.000Z";
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const phaseOf = (c: { systemPrompt?: string }) => c.systemPrompt?.includes("### Second-round user message") ? "consolidation" : "noting";
const thinkingOf = (run: { response?: string | null }) => JSON.parse(run.response!).thinking;
/** 27d: the fallback case at the end tells the fresh child's own body from the fork attempt's — a
 * fresh child's system prompt is the Noter's, which a fork's never is — and rejects a fork body the
 * way a provider rejects one it cannot hold. */
const freshChild = (body: Body) => ["system", "developer"].includes(body.messages?.[0]?.role) && String(body.messages[0]!.content).includes("Noting (fact extraction)");
/** 29e: the same distinction for the phase whose mode was restored. */
const freshConsolidationChild = (body: Body) => ["system", "developer"].includes(body.messages?.[0]?.role) && String(body.messages[0]!.content).includes("Consolidation (knowledge extraction)");
const overflow = () => new Response(JSON.stringify({ error: { message: "prompt is too long: 213462 tokens > 200000 maximum" } }),
  { status: 400, headers: { "content-type": "application/json" } });
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
  const f = await forkFixture({ defaultThinkingLevel: "medium", modelThinkingLevels: { "fake/test-thinking": "low" } },
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
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, notingModel: "fake/test-thinking" });
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
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, defaultThinkingLevel: "medium" });
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
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 30, "consolidation.triggerTokens": 1 });
  try {
    h.setThinkingLevel("high");
    await h.turn(); // allocates the session; this case explicitly configures fork mode
    const tail = closedTail(h.memory);
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Own claim", source: ["T1#user"] }] });
    h.provider(async c => phaseOf(c) === "consolidation" ? consolidationReply(c) : notingFact(c));
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
  const f = await forkFixture({ defaultThinkingLevel: "medium" }, "fake", { model: "test-thinking", thinkingLevel: "high" });
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
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, notingModel: "fake/test-thinking" });
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

test("26d ruling 2026-09-10: the configured level is for subagent execution only — a fork keeps inheriting the foreground level, and the gate stays green", async () => {
  // `notingThinking: high` while the foreground — and the captured parent request — are at `medium`.
  const f = await forkFixture({ notingThinking: "high" }, "fake", { model: "test-thinking", thinkingLevel: "medium" });
  try {
    f.h.setThinkingLevel("medium");
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    expect(run.mode).toBe("fork");
    const response = JSON.parse(run.response!);
    // The inherited level, not the configured one: a fork's request prefix must stay the parent's.
    expect(response.thinking).toEqual({ requested: "medium", effective: "medium" });
    expect((f.sent[0] as Body).reasoning_effort).toBe("medium");
    expect((f.sent[1] as Body).reasoning_effort).toBe("medium");
    expect(response.verification.passed).toBe(true);
    expect(response.fallbackReason).toBeUndefined();
  } finally { await f.dispose(); }
});

test("26d: the same fork task, refused by the gate, runs its fresh child at the configured level", async () => {
  // 26b's gate case with a preference on top: the foreground is `low` against a parent captured at
  // `high`, so the inherited body differs and the existing gate refuses it — and the fallback child
  // is a fresh child, which is what `notingThinking` configures.
  const f = await forkFixture({ notingThinking: "high" }, "fake", { model: "test-thinking", thinkingLevel: "high" });
  try {
    f.h.setThinkingLevel("low");
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    expect(run.mode).toBe("subagent");
    expect(response.requestedMode).toBe("fork");
    expect(response.fallbackReason).toContain("native prefix mismatch");
    expect(response.verification.native.differingPath).toBe("$.reasoning_effort");
    expect(response.verification.native.normalized).toEqual(["cache_control"]); // the gate is the unchanged one
    expect(response.thinking).toEqual({ requested: "high", effective: "high" });
    const workerBodies = f.sent.filter(body => worker(body));
    expect(workerBodies.length).toBeGreaterThan(0);
    expect(workerBodies.every(body => body.reasoning_effort === "high")).toBe(true);
  } finally { await f.dispose(); }
});

test("26d: every subagent path takes its phase's configured level — explicit subagent mode, borrowed closed-session work, manual catchup and Consolidation", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1, "noting.forkModeDefault": false,
    notingThinking: "high", consolidationThinking: "low" });
  try {
    h.setThinkingLevel("off"); // the foreground level, which `inherit` would have used
    await h.turn();
    const tail = closedTail(h.memory);
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Own claim", source: ["T1#user"] }] });
    h.provider(async c => phaseOf(c) === "consolidation" ? consolidationReply(c) : notingFact(c));
    h.persist(reply("eligible completion")); await h.emit("agent_end"); await settle(h);
    const beforeCatchup = h.memory.store.listRuns(1).length;
    h.persist(reply("more evidence " + "word ".repeat(30)));
    await command(h, "catchup");
    await settle(h);
    expect(h.memory.store.listRuns(1).length, "manual catchup ran at least one run of its own").toBeGreaterThan(beforeCatchup);
    const runs = [...h.memory.store.listRuns(1), ...h.memory.store.listRuns(tail.sessionId)].filter(r => r.kind !== "manual" && r.response);
    expect(runs.map(r => r.kind).includes("consolidation")).toBe(true);
    expect(h.memory.store.listRuns(tail.sessionId).length).toBeGreaterThan(0); // borrowed closed-session work ran
    // Each run asked for its own phase's level, never the foreground `off`; the default model
    // declares no reasoning support, so Pi clamps every one of them.
    for (const run of runs) expect(thinkingOf(run), `${run.kind} R${run.id}`)
      .toEqual({ requested: run.kind === "consolidation" ? "low" : "high", effective: "off" });
  } finally { await h.dispose(); }
});

test("26d: a fork task that falls back runs at the configured level, clamped by Pi to what the worker model supports", async () => {
  // This case explicitly selects fork; the fake foreground has no session file to fork from, so
  // the documented fallback runs — on the session model, which declares no reasoning support.
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 30, notingThinking: "high" });
  try {
    h.setThinkingLevel("minimal");
    h.provider(async conversation => notingFact(conversation));
    await h.turn();
    const run = h.memory.store.listRuns(1).find(r => r.kind === "noting")!;
    expect(run.outcome).toBe("success");
    expect(JSON.parse(run.response!).requestedMode).toBe("fork");
    expect(run.mode).toBe("subagent");
    // `requested` is the configured level, not the foreground one and not the clamped one.
    expect(thinkingOf(run)).toEqual({ requested: "high", effective: "off" });
    expect(h.requests.every((body: any) => body.reasoning_effort === undefined)).toBe(true);
  } finally { await h.dispose(); }
});

test("26d: the configured level is frozen at admission — a preference saved while a task runs reaches neither its later rounds nor its fallback", async () => {
  const h = host({ "noting.triggerTokens": 30, "noting.forkModeDefault": false, notingModel: "fake/test-thinking" });
  try {
    // The level under edit has to be the Global layer the menu writes, not this fixture's environment
    // override, so seed the resolved settings file and load it the way a session start does.
    const file = join(h.dir, "agent", "settings.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), "trace-memory": { notingThinking: "high" } }));
    await h.emit("session_start");
    h.setThinkingLevel("off");
    let edited = false;
    h.provider(async conversation => {
      if (!edited) { // the user opens Settings and saves a different level while the worker is at the wire
        edited = true;
        h.ctx.hasUI = true;
        h.answers.push("Settings", "Noter thinking: high (Global)", "off");
        await command(h, "");
        h.ctx.hasUI = false;
      }
      return notingFact(conversation);
    }, { autoStop: true });
    await h.turn();
    const run = h.memory.store.listRuns(1).find(r => r.kind === "noting")!;
    expect(run.outcome).toBe("success");
    expect(thinkingOf(run)).toEqual({ requested: "high", effective: "high" });
    expect(h.requests.length).toBeGreaterThan(1);
    expect(h.requests.map((body: any) => body.reasoning_effort)).toEqual(h.requests.map(() => "high"));
    // The edit really happened, and it is the next admitted task that gets it.
    expect(h.notices.some(n => n.includes("saved notingThinking"))).toBe(true);
    const before = h.requests.length;
    await h.turn();
    expect(h.requests.slice(before).every((body: any) => body.reasoning_effort === undefined)).toBe(true);
    expect(thinkingOf(h.memory.store.listRuns(1).filter(r => r.kind === "noting").at(-1)!)).toEqual({ requested: "off", effective: "off" });
  } finally { await h.dispose(); }
});

test("27/26d: the levels frozen at admission survive fallback", async () => {
  // The review's reproduction: a fork admitted at `high` whose provider rejects the body for context
  // capacity. While that request is pending the foreground switches to `low` AND the Noter's own
  // preference is saved as `low`; the re-admission must read neither — it reuses the pair frozen with
  // the task. Before 27d both fresh requests and the audit said `low`.
  // The preference under edit has to be the Global layer the menu writes, so this fixture's
  // environment layer carries neither the model nor the level.
  const f = await forkFixture({}, "fake", { model: "test-thinking", thinkingLevel: "high" });
  try {
    const file = join(f.h.dir, "agent", "settings.json");
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")),
      "trace-memory": { notingModel: "fake/test-thinking", notingThinking: "high" } }));
    await f.h.emit("session_start");
    f.h.setThinkingLevel("high");
    let switched = false;
    f.script(async (body: Body) => {
      if (!worker(body)) return say("好的。");
      if (freshChild(body)) return toolResults(body) ? say("Done.") : call("t1", "note", noteBatch);
      if (!switched) {
        switched = true;
        f.h.setThinkingLevel("low");           // the foreground level moves
        f.h.ctx.hasUI = true;                  // and the user saves the preference as well
        f.h.answers.push("Settings", "Noter thinking: high (Global); fork mode inherits the foreground thinking level", "low");
        await command(f.h, "");
        f.h.ctx.hasUI = false;
      }
      return overflow();
    });
    await f.turn();
    const runs = await vi.waitFor(() => {
      const found = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response).sort((a, b) => a.id - b.id);
      expect(found).toHaveLength(2); // 27d: the refused attempt and the re-admitted run
      return found;
    }, { timeout: 5000 });
    expect(f.h.notices.some(n => n.includes("saved notingThinking"))).toBe(true); // the edit really happened
    expect(runs[0]!.mode).toBe("fork");
    expect(thinkingOf(runs[0]!)).toEqual({ requested: "high", effective: "high" });
    expect(runs[1]!.mode).toBe("subagent");
    expect(runs[1]!.model).toBe("fake/test-thinking");
    expect(thinkingOf(runs[1]!)).toEqual({ requested: "high", effective: "high" });
    const freshBodies = f.sent.filter(body => worker(body) && freshChild(body));
    expect(freshBodies.length).toBeGreaterThan(0);
    expect(freshBodies.every(body => body.reasoning_effort === "high")).toBe(true);
  } finally { await f.dispose(); }
}, 30000);

test("27/26d/29e (case 18): a Consolidation fork's fallback takes the configured Consolidator model and the frozen phase level", async () => {
  // The same freeze rule for the phase 29e restored the mode to: the fork inherits the foreground
  // level (26b), and its fallback child thinks at this phase's own configured level — the pair frozen
  // at admission, never the level or the preference as they stand when the fallback is admitted.
  const f = await fixture({ "noting.triggerTokens": 1000000000, "consolidation.triggerTokens": 1,
    "consolidation.forkModeDefault": true, consolidationModel: "fake/test-thinking", consolidationThinking: "high" },
    "fake", { model: "test-thinking", thinkingLevel: "low" });
  try {
    await f.h.emit("session_start");
    f.h.setThinkingLevel("low");
    let switched = false;
    f.script(async (body: Body) => {
      if (!worker(body, "Consolidation")) return say("好的。");
      if (freshConsolidationChild(body)) return toolResults(body) >= 2 ? say("Integrated.") : call(`t${toolResults(body)}`, "memory", memoryBatch);
      if (!switched) { switched = true; f.h.setThinkingLevel("off"); } // the foreground level moves mid-attempt
      return overflow();
    });
    await f.turn();
    f.h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })
      .find(t => t.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] });
    recorded(f.h.memory, 1, "main", 1);
    await f.turn("tick");
    const runs = await vi.waitFor(() => {
      const found = f.h.memory.store.listRuns(1).filter(r => r.kind === "consolidation" && r.response).sort((a, b) => a.id - b.id);
      expect(found).toHaveLength(2); // 27d: the refused attempt and the re-admitted run
      return found;
    }, { timeout: 5000 });
    expect(runs[0]!.mode).toBe("fork");
    expect(thinkingOf(runs[0]!)).toEqual({ requested: "low", effective: "low" }); // the inherited level, frozen
    expect(runs[1]!.mode).toBe("subagent");
    expect(runs[1]!.model).toBe("fake/test-thinking"); // the configured Consolidator model, not the session's
    expect(thinkingOf(runs[1]!)).toEqual({ requested: "high", effective: "high" }); // `consolidationThinking`
    const freshBodies = f.sent.filter(body => worker(body, "Consolidation") && freshConsolidationChild(body));
    expect(freshBodies.length).toBeGreaterThan(0);
    expect(freshBodies.every(body => body.reasoning_effort === "high")).toBe(true);
  } finally { await f.dispose(); }
}, 30000);
