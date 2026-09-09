// Ticket 27b — per-task fork fallback. Each test names the ruling it pins (parent 27 "Per-task fork
// fallback" and "Notices and audit", amendments 1, 4, 5 and 6).
//
// Two paths, one transition each, and never more than one per task:
//
//   before sending  — the freeze cannot price this batch as a fork (its inherited context leaves no
//                     room, or Pi reports no measure to fork from), so the host admits the task once
//                     more with the configured subagent model and that model's capacity, and the
//                     batch is re-frozen with fresh material.
//   after an attempt — the provider rejected the request and pi-ai's own `isContextOverflow` says it
//                     was a context overflow, with nothing committed: the same frozen evidence runs
//                     once more in a fresh child.
//
// A capacity fallback is a warning, not an error: no cache-miss latch, no settings file, no default
// mode change, and a later task may request fork again. Authentication and rate-limit rejections are
// not capacity failures; a committed note, a cancellation and every failure after a commit end the
// task where it is.
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { host } from "./test-host.ts";
import { fixture, say, call, worker, submitted, noteBatch, settled, usage as wireUsage, type Body } from "./native-fixture.ts";
import { runWorker, type WorkerBinding } from "../../../src/hosts/pi/worker.ts";
import { runNative } from "../../../src/hosts/pi/native.ts";
import { toolDefinitions, type NotingAgentInput } from "../../../src/core/api/index.ts";

/** A provider rejection, at the status this fixture's wire uses for one: Pi does not treat it as
 * transient, so the scripted message is what decides — which is the point of every case below. */
const rejected = (message: string) => new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { "content-type": "application/json" } });
const OVERFLOW = "prompt is too long: 213462 tokens > 200000 maximum";
/** A fresh child's own body: its system prompt is the Noter's, which a fork's never is (a fork
 * inherits the parent's system prompt and carries the Noter instructions in its appended message). */
const fresh = (body: Body) => body.messages?.[0]?.role === "system" && String(body.messages[0].content).includes("Noting (fact extraction)");
const forkAttempt = (body: Body) => worker(body) && !fresh(body);

test("27b 2026-09-10: a fork prefix the freeze cannot fit is re-admitted once as a subagent, on the configured Noter model and its capacity", async () => {
  // The session model's window is 50,000, so the 40,000-token measure plus the Noter instructions
  // cannot fit its 40,000-token allowance. `notingModel` names a different model, whose own capacity
  // (the fixture's 200,000-token window) prices the second admission — and which the audit must name,
  // because it is the model that was charged.
  const h = host({ "noting.triggerTokens": 20, notingModel: "fake/test-mini" }); // fork is the default mode
  try {
    await h.emit("session_start");
    h.ctx.model = { ...h.ctx.model!, contextWindow: 50_000 };
    h.setContextUsage({ tokens: 40_000, contextWindow: 50_000, percent: 80 });
    await h.prompt("word ".repeat(200));
    await h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: "hi" }] } });
    await h.answer("word ".repeat(200));
    await h.emit("agent_settled"); await h.drain();

    const runs = h.memory.store.listRuns(1);
    expect(runs).toHaveLength(1); // one task, one run: a re-admission is not a second run or a drain
    const run = runs[0]!, response = JSON.parse(run.response!);
    expect(run.mode).toBe("subagent");
    expect(response.requestedMode).toBe("fork");
    expect(run.model).toBe("fake/test-mini");
    expect(run.outcome).toBe("success");
    // The reason names the fork's own refusal, and it is a warning, said once.
    expect(response.fallbackReason).toContain("and the inherited context 40000");
    expect(h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
    expect(h.notices.filter(n => n.includes("and the inherited context 40000"))).toHaveLength(1);
    // Fresh material, and only the evidence the second freeze selected is committed.
    expect(h.conversations[0]!.systemPrompt).toContain("Noting (fact extraction)");
    expect(response.entryAudit.entries.map((e: { nativeId: string }) => e.nativeId)).toEqual(["e1"]);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.nativeId)).toEqual(["e2"]);
    // No latch, no configuration change.
    expect(h.memory.store.forkSuppression(1)).toBeNull();
    expect(h.memory.config.noting.forkModeDefault).toBe(true);
    expect(JSON.parse(readFileSync(`${h.dir}/agent/settings.json`, "utf8")).compaction).toBeUndefined();
  } finally { await h.dispose(); }
});

test("27b 2026-09-10: the pre-send fallback decides before any provider request, and the child that runs is a fresh one", async () => {
  const f = await fixture();
  try {
    // A measure no window could hold: this session has no fork base the freeze can price.
    (f.h.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 10_000_000, contextWindow: 200_000, percent: 5_000 });
    f.script((body: Body) => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : call("t1", "note", noteBatch));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    expect(run.mode).toBe("subagent");
    expect(response.requestedMode).toBe("fork");
    // Nothing carrying the parent's prefix was ever sent: every worker body is the fresh child's own,
    // and no fork gate ran at all (a rejected gate would have left its hashes here).
    expect(f.sent.filter(forkAttempt)).toEqual([]);
    expect(response.verification).toBeUndefined();
    expect(String(response.nativeLog).startsWith(`${f.runsDir}/`)).toBe(true);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10: a provider context-overflow rejection with nothing committed falls back once, on the same frozen evidence", async () => {
  const f = await fixture();
  try {
    f.script((body: Body) => {
      if (!worker(body)) return say("好的。");
      if (!fresh(body)) return rejected(OVERFLOW); // the fork attempt, rejected by the provider
      return submitted(body) ? say("Done.", wireUsage(7, 2)) : call("t1", "note", noteBatch, wireUsage(11, 3));
    });
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    expect(f.sent.filter(forkAttempt)).toHaveLength(1); // one fork attempt, and only one
    expect(run.mode).toBe("subagent");
    expect(response.requestedMode).toBe("fork");
    expect(response.fallbackReason).toContain("context overflow");
    expect(response.fallbackReason).toContain(OVERFLOW);
    expect(response.verification.passed).toBe(true); // the attempt really went out: its gate result is kept
    // The same frozen membership, and the evidence committed once.
    expect(response.entryAudit.entries.map((e: { nativeId: string }) => e.nativeId))
      .toEqual(f.h.memory.store.listSourceEntries(1).map(e => e.nativeId));
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    // Usage is the fresh child's two real responses and nothing else: the rejected request reported
    // the SDK's placeholder zeros, which are unknown, never a paid successful generation.
    expect(response.usage.input).toBe(18);
    expect(response.usage.output).toBe(5);
    // One submission across both attempts: the rejected attempt executed no tool, and its child was
    // disposed before the fresh one started, so nothing of it could still write.
    expect(response.toolCalls.map((c: { name: string }) => c.name)).toEqual(["note"]);
    expect(f.h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
  } finally { await f.dispose(); }
}, 30000);

test.each([
  ["an authentication", "invalid api key: check your credentials"],
  ["a rate-limit", "rate limit exceeded: too many requests, please slow down"],
])("27b 2026-09-10: %s rejection is not a capacity failure and runs no second extraction", async (_kind, message) => {
  const f = await fixture();
  try {
    f.script((body: Body) => !worker(body) ? say("好的。") : rejected(message));
    await f.turn();
    const run = await settled(f);
    expect(run.mode).toBe("fork"); // the attempt is this run, and its failure is this run's outcome
    expect(run.outcome).toBe("failure");
    expect(f.sent.filter(fresh)).toEqual([]); // no fresh child was launched
    expect(f.h.notices.filter(n => n.includes("fell back to subagent mode"))).toEqual([]);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(f.h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
  } finally { await f.dispose(); }
}, 30000);

test.each([
  ["a nonempty", noteBatch, ["用 pnpm，不要 npm"]],
  ["an explicit empty", { facts: [] }, []],
])("27b 2026-09-10: %s note followed by a provider failure never runs a second extraction", async (_kind, batch, facts) => {
  const f = await fixture();
  try {
    f.script((body: Body) => {
      if (!worker(body)) return say("好的。");
      if (fresh(body)) throw new Error("a committed batch must never be extracted a second time");
      return submitted(body) ? rejected(OVERFLOW) : call("t1", "note", batch);
    });
    await f.turn();
    const run = await settled(f);
    expect(run.mode).toBe("fork");
    expect(run.outcome).toBe("success"); // 26a: the submission is the commit, whatever the trailing reply does
    expect(f.sent.filter(fresh)).toEqual([]);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(facts);
    expect(JSON.parse(run.response!).problems.join(" ")).toContain("provider failed after commit");
    expect(f.h.memory.pendingEntries(1, "main", 1)).toEqual([]); // the committed batch advanced
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10: a cancelled fork attempt launches no fallback work", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const captured = await f.turn();
    // The rejection arrives after the task was cancelled — stop, shutdown, a lost claim and a
    // disabled enrollment all reach a running task exactly this way.
    const parentRequests = f.sent.length; // every later body is this worker's own
    f.script((_body: Body, index: number) => { if (index < parentRequests) return say("好的。"); controller.abort(); return rejected(OVERFLOW); });
    const fallbacks: string[] = [];
    const task = {
      kind: "noting", mode: "fork", model: "fake/test", sessionId: 1, branch: "main", signal: controller.signal,
      prompt: "You are the Noter.", text: { fresh: "note what happened", inherited: "the increment" },
      reportRequest: () => {}, reportProgress: () => {},
    } as unknown as NotingAgentInput;
    const binding: WorkerBinding = { model: f.model as never, checkCapacity: () => {},
      tools: toolDefinitions.map(t => ({ ...t, execute: () => "committed" })), runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      fork: { parentFile: f.manager().getSessionFile()!, parentSessionId: f.manager().getSessionId(), checkpoint: f.manager().getLeafId()!, captured },
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {}, onFallback: reason => fallbacks.push(reason) };
    const result = await runWorker(task, binding);
    expect(result.outcome).toBe("cancelled");
    expect(result.mode).toBe("fork");
    expect(fallbacks).toEqual([]);
    expect(f.sent.filter(fresh)).toEqual([]);
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10: a fresh rebuild the last check refuses leaves the frozen evidence pending with that diagnostic", async () => {
  const f = await fixture();
  try {
    const parentRequests = f.sent.length + 1; // the parent's turn below is the last body that is not this worker's
    await f.turn();
    const captured = f.sent[parentRequests - 1]!;
    f.script((_body: Body, index: number) => index < parentRequests ? say("好的。") : rejected(OVERFLOW));
    const fallbacks: string[] = [];
    let checks = 0;
    const task = {
      kind: "noting", mode: "fork", model: "fake/test", sessionId: 1, branch: "main",
      prompt: "You are the Noter.", text: { fresh: "note what happened", inherited: "the increment" },
      reportRequest: () => {}, reportProgress: () => {},
    } as unknown as NotingAgentInput;
    const binding: WorkerBinding = { model: f.model as never,
      // The fork attempt's body leaves; the fresh child's does not fit any more.
      checkCapacity: () => { if (++checks > 1) throw new Error("Noting capacity: the child's context of 300000 tokens leaves less than the 10000-token headroom"); },
      tools: toolDefinitions.map(t => ({ ...t, execute: () => "committed" })), runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      fork: { parentFile: f.manager().getSessionFile()!, parentSessionId: f.manager().getSessionId(), checkpoint: f.manager().getLeafId()!, captured },
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {}, onFallback: reason => fallbacks.push(reason) };
    const result = await runWorker(task, binding);
    expect(fallbacks).toHaveLength(1); // the transition happened
    expect(result.outcome).toBe("failure"); // and its own refusal is the outcome, not the warning
    expect(String(result.output)).toContain("leaves less than the 10000-token headroom");
    expect(result.mode).toBe("subagent");
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]); // nothing was committed by either attempt
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10: at most one transition per task — the fresh child's own failure is reported as itself, not hidden by the warning", async () => {
  const f = await fixture();
  try {
    // Both attempts are rejected for context capacity. The second one is a subagent already, so
    // nothing falls back again: its failure is the run's failure.
    f.script((body: Body) => !worker(body) ? say("好的。") : rejected(OVERFLOW));
    await f.turn();
    const run = await settled(f);
    const response = JSON.parse(run.response!);
    expect(f.sent.filter(forkAttempt)).toHaveLength(1);
    expect(f.sent.filter(fresh)).toHaveLength(1);
    expect(run.mode).toBe("subagent");
    expect(run.outcome).toBe("failure");
    expect(response.problems.join(" ")).toContain(OVERFLOW);
    // Neither attempt reported usage, and unknown stays unknown rather than a fabricated zero.
    expect(response.usage).toBeNull();
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(f.h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10 (amendment 1): the memory child runs with Pi's automatic compaction off, and the user's own settings are untouched", async () => {
  // The user's settings ask for automatic compaction, with a recent-token budget small enough that
  // Pi really has something to compact. Without the child's in-memory override, Pi answers the
  // overflow below by deleting the failed reply, paying for a native summary and retrying — two
  // provider requests, a `compaction` entry in the worker log, and no overflow for the adapter to
  // classify. (Measured on this fixture: with the override removed the child sends 2 requests and
  // writes that entry; with it, 1 and none.)
  const f = await fixture({ compaction: { enabled: true, keepRecentTokens: 1, reserveTokens: 1 } });
  try {
    f.script((body: Body) => worker(body) ? rejected(OVERFLOW) : say("好的。"));
    const captured = await f.turn();
    const before = f.sent.length;
    const result = await runNative(f.task(captured, {
      tools: toolDefinitions.map(t => ({ ...t, execute: () => "committed" })),
      task: "# Noting (fact extraction)\n\nnote what happened",
    }));
    // The overflow reached the adapter as an error, with the terminal message Pi built for it.
    expect(result.outcome).toBe("failure");
    expect(result.committed).toBe(false);
    expect((result.terminal as { errorMessage: string }).errorMessage).toContain(OVERFLOW);
    expect(f.sent.length - before).toBe(1); // no summarization call was paid for
    expect(readFileSync(result.nativeLog!, "utf8")).not.toContain('"type":"compaction"');
    // In memory only: the user's settings file still says what it said, and a manager built over the
    // same directories — the foreground's own, and Pi's compaction hooks with it — still reads it.
    const settings = JSON.parse(readFileSync(`${f.agentDir}/settings.json`, "utf8"));
    expect(settings.compaction).toEqual({ enabled: true, keepRecentTokens: 1, reserveTokens: 1 });
    expect(SettingsManager.create(f.h.dir, f.agentDir).getCompactionSettings()).toEqual({ enabled: true, keepRecentTokens: 1, reserveTokens: 1 });
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10: a capacity fallback latches nothing — the next task requests fork again", async () => {
  const f = await fixture();
  try {
    const parent = f.h.ctx.getContextUsage!.bind(f.h.ctx);
    // What Pi reports right after a compaction: no measure, so the first task cannot fork.
    (f.h.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: null, contextWindow: 200_000, percent: null });
    // The first run submits an explicit empty batch: a Noter fork waits for pending fact receipts
    // (25b), and this case is about the fallback latching nothing, not about that pause.
    let submissions = 0;
    f.script((body: Body) => !worker(body) ? say("好的。") : submitted(body) ? say("Done.")
      : call(`t${++submissions}`, "note", submissions === 1 ? { facts: [] } : noteBatch));
    await f.turn();
    const first = await settled(f);
    expect(first.mode).toBe("subagent");
    expect(JSON.parse(first.response!).requestedMode).toBe("fork");

    // The measure returns; the next task is admitted as a fork and runs as one.
    (f.h.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = parent;
    await f.turn("用 bun，不要 node");
    const second = await vi.waitFor(() => {
      const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response);
      expect(runs).toHaveLength(2);
      return runs.sort((a, b) => a.id - b.id)[1]!;
    }, { timeout: 5000 });
    expect(second.mode).toBe("fork");
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await f.dispose(); }
}, 30000);

