// Ticket 26b — a worker inherits the foreground thinking level, frozen at admission — and ticket
// 26d, which adds the `notingThinking` preference on top of it: a second level,
// frozen with the same task, that every run of it uses. The 26b cases below are the `inherit` behaviour.
//
// Everything here runs on a real Pi child session with the provider stubbed at the wire, so the
// level asserted on is the one Pi's own session resolution produced and the one the request really
// carried. `test-thinking` is the fixture's only reasoning-capable model: Pi clamps every level to
// `off` on the others, which is what the clamp cases below use.
import { expect, test, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { host, reply, notingFact } from "./test-host.ts";
import { call, noterTurn, fixture, noteBatch, say, settled, toolResults, worker, type Body } from "./native-fixture.ts";
import { TraceMemory } from "../../../src/core/api/index.ts";

const at = "2026-09-08T00:00:00.000Z";
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
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

test("26b: a fresh subagent worker inherits the same frozen level, and a foreground switch mid-run reaches neither its later rounds nor the audit", async () => {
  const h = host({ "noting.triggerTokens": 30, notingModel: "fake/test-thinking" });
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
  const h = host({ "noting.triggerTokens": 30, defaultThinkingLevel: "medium" });
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

test("26b/92: every N launch path freezes the same level — automatic work, borrowed work and manual catchup", async () => {
  const h = host({ "noting.triggerTokens": 1_000 });
  try {
    h.setThinkingLevel("high");
    await h.turn(); // allocates the session
    const tail = closedTail(h.memory);
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ title: "Own claim", sources: "[T1#E1] Own claim" });
    h.provider(async c => notingFact(c));
    await h.prompt("eligible main turn"); await h.answer("word ".repeat(3000)); await settle(h);
    await h.turn(); await settle(h); // a small own backlog lets this turn borrow the closed tail
    const beforeCatchup = h.memory.store.listRuns(1).length;
    h.persist(reply("more evidence " + "word ".repeat(30)));
    await command(h, "catchup");
    await settle(h);
    expect(h.memory.store.listRuns(1).length, "manual catchup ran at least one run of its own").toBeGreaterThan(beforeCatchup);
    const runs = [...h.memory.store.listRuns(1), ...h.memory.store.listRuns(tail.sessionId)].filter(r => r.kind !== "manual" && r.response && !JSON.parse(r.response).noWork);
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.map(r => r.kind).includes("noting")).toBe(true);
    expect(runs.map(r => r.kind).includes("consolidation")).toBe(false);
    expect(h.memory.store.listRuns(tail.sessionId).length).toBeGreaterThan(0); // borrowed closed-session work ran
    for (const run of runs) expect(thinkingOf(run), `${run.kind} R${run.id}`).toEqual({ requested: "high", effective: "off" });
  } finally { await h.dispose(); }
});

test("26b: borrowed work inherits the executor's level, not the level any historical session ran at", async () => {
  const h = host({ "noting.triggerTokens": 1_000, notingModel: "fake/test-thinking" });
  try {
    await h.turn();
    const tail = closedTail(h.memory);
    h.setThinkingLevel("high");
    h.provider(async conversation => notingFact(conversation));
    await h.prompt("eligible main turn"); await h.answer("eligible completion"); await settle(h);
    const run = await vi.waitFor(() => {
      const found = h.memory.store.listRuns(tail.sessionId).find(r => r.kind === "noting" && r.response);
      expect(found).toBeTruthy(); return found!;
    }, { timeout: 5000 });
    expect(thinkingOf(run)).toEqual({ requested: "high", effective: "high" });
  } finally { await h.dispose(); }
});

test("26d/92: every N subagent path takes its configured level — explicit subagent mode, borrowed work and manual catchup", async () => {
  const h = host({ "noting.triggerTokens": 1_000, notingThinking: "high" });
  try {
    h.setThinkingLevel("off"); // the foreground level, which `inherit` would have used
    await h.turn();
    const tail = closedTail(h.memory);
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ title: "Own claim", sources: "[T1#E1] Own claim" });
    h.provider(async c => notingFact(c));
    await h.prompt("eligible main turn"); await h.answer("word ".repeat(3000)); await settle(h);
    await h.turn(); await settle(h); // a small own backlog lets this turn borrow the closed tail
    const beforeCatchup = h.memory.store.listRuns(1).length;
    h.persist(reply("more evidence " + "word ".repeat(30)));
    await command(h, "catchup");
    await settle(h);
    expect(h.memory.store.listRuns(1).length, "manual catchup ran at least one run of its own").toBeGreaterThan(beforeCatchup);
    const runs = [...h.memory.store.listRuns(1), ...h.memory.store.listRuns(tail.sessionId)].filter(r => r.kind !== "manual" && r.response && !JSON.parse(r.response).noWork);
    expect(runs.map(r => r.kind).includes("consolidation")).toBe(false);
    expect(h.memory.store.listRuns(tail.sessionId).length).toBeGreaterThan(0); // borrowed closed-session work ran
    // Each run asked for its own phase's level, never the foreground `off`; the default model
    // declares no reasoning support, so Pi clamps every one of them.
    for (const run of runs) expect(thinkingOf(run), `${run.kind} R${run.id}`)
      .toEqual({ requested: "high", effective: "off" });
  } finally { await h.dispose(); }
});

test("26d: the configured level is frozen at admission — a preference saved while a task runs reaches none of its later rounds", async () => {
  const h = host({ "noting.triggerTokens": 30, notingModel: "fake/test-thinking" });
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
        h.answers.push("Settings…", "Noter thinking: high", "off");
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
    expect(thinkingOf(h.memory.store.listRuns(1).filter(r => r.kind === "noting" && !JSON.parse(r.response!).noWork).at(-1)!)).toEqual({ requested: "off", effective: "off" });
  } finally { await h.dispose(); }
});
