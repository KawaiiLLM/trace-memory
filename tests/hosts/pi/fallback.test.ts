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
// not capacity failures. A cancellation ends the task. Since 92, a held note is not a commit;
// failed attempts discard their drafts and only normal termination publishes both layers.
//
// 27c generalised the second path: whatever refuses a fork — the live state at admission, the launch,
// the native gate, the provider — the task is admitted once more as a subagent on the CONFIGURED
// Noter model and its capacity. `runWorker` reruns nothing; it returns the refusal, and the host
// re-admits on the frozen batch's own entries.
import { readFileSync } from "node:fs";
import { expect, test, vi } from "vitest";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { host, reply } from "./test-host.ts";
// This suite explicitly requests forks to exercise their refusal and re-admission paths.
import { stableForkFixture as fixture, say, call, noteAndMemory, worker, submitted, noteBatch, settled, toolResults, usage as wireUsage, type Body } from "./native-fixture.ts";
import { hydrate } from "../../source-fixture.ts";
import { fact } from "../../support/seed.ts";
import { CONTEXT_HEADROOM } from "../../../src/hosts/pi/index.ts";
import { loadPrompt } from "../../../src/core/prompts/load.ts";
import { tokens } from "../../../src/core/render/tokens.ts";
import { runWorker, type WorkerBinding } from "../../../src/hosts/pi/worker.ts";
import { forkable, runNative } from "../../../src/hosts/pi/native.ts";
import { toolDefinitions, type NotingAgentInput } from "../../../src/core/api/index.ts";

/** A provider rejection, at the status this fixture's wire uses for one: Pi does not treat it as
 * transient, so the scripted message is what decides — which is the point of every case below. */
const rejected = (message: string) => new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { "content-type": "application/json" } });
const OVERFLOW = "prompt is too long: 213462 tokens > 200000 maximum";
/** A fresh child's own body: its system prompt is the Noter's, which a fork's never is (a fork
 * inherits the parent's system prompt and carries the Noter instructions in its appended message). */
const fresh = (body: Body) => body.messages?.[0]?.role === "system" && String(body.messages[0].content).includes("Noting (facts and knowledge)");
const forkAttempt = (body: Body) => worker(body) && !fresh(body);
/** 27d (user ruling 2026-09-10, superseding 27c's "one run record for both attempts"): a fallback
 * task leaves one record per attempt that sent a request — the refused fork first, then the
 * re-admitted run. Waits for exactly `count` finished Noting records, oldest first. */
const records = async (f: Awaited<ReturnType<typeof fixture>>, count: number) => await vi.waitFor(() => {
  const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response).sort((a, b) => a.id - b.id);
  expect(runs).toHaveLength(count);
  return runs;
}, { timeout: 5000 });

test("27b 2026-09-10: a fork prefix the freeze cannot fit is re-admitted once as a subagent, on the configured Noter model and its capacity", async () => {
  // The session model's window is 50,000, so the 40,000-token measure plus the Noter instructions
  // cannot fit its 40,000-token allowance. `notingModel` names a different model, whose own capacity
  // (the fixture's 200,000-token window) prices the second admission — and which the audit must name,
  // because it is the model that was charged.
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 30, notingModel: "fake/test-mini" });
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
    expect(h.conversations[0]!.systemPrompt).toContain("Noting (facts and knowledge)");
    expect(response.entryAudit.entries.map((e: { nativeId: string }) => e.nativeId)).toEqual(["e1", "e2"]);
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]); // 105 freezes after the final reply
    // No latch, no configuration change.
    expect(h.memory.store.forkSuppression(1)).toBeNull();
    // Settings belongs to the executor; `h.memory` is only an independent database observer.
    h.ctx.hasUI = true;
    h.answers.push("Settings…", undefined); await h.commands.get("trace")!.handler("", h.ctx);
    expect(h.dialogs.at(-1)!.options).toContain("Noter mode: fork (Environment setting — this edit will not take effect)");
    expect(JSON.parse(readFileSync(`${h.dir}/agent/settings.json`, "utf8")).compaction).toBeUndefined();
  } finally { await h.dispose(); }
});

test("27b 2026-09-10: the pre-send fallback decides before any provider request, and the child that runs is a fresh one", async () => {
  const f = await fixture();
  try {
    // A measure no window could hold: this session has no fork base the freeze can price.
    (f.h.ctx as unknown as { getContextUsage: () => unknown }).getContextUsage = () => ({ tokens: 10_000_000, contextWindow: 200_000, percent: 5_000 });
    f.script((body: Body) => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : noteAndMemory("t1", noteBatch));
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
    // 29b: the re-admitted subagent is given no visible view, so its material is the complete fresh
    // one — the Raw of its whole target — however much of it the foreground it did not fork happens
    // to hold. A fresh child that inherited the fork's subtraction would be a task with no evidence.
    expect(JSON.stringify(f.sent.filter(fresh)[0]!.messages![1]!.content)).toContain("Raw:");
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10: a provider context-overflow rejection with nothing committed falls back once, on the same frozen evidence", async () => {
  // 27c: `notingModel` names a model the foreground is not on, so the re-admission's model is visible.
  const f = await fixture({ notingModel: "fake/test-mini" });
  try {
    f.script((body: Body) => {
      if (!worker(body)) return say("好的。");
      if (!fresh(body)) {
        // 27c: the foreground model could not hold this batch any more (11,000 − 10,000 = 1,000
        // tokens for input), so the re-admission below happens at all only because it is priced by
        // the Noter model's own window.
        (f.h.ctx as { model: unknown }).model = { ...f.h.ctx.model!, contextWindow: 11_000 };
        return rejected(OVERFLOW); // the fork attempt, rejected by the provider
      }
      return submitted(body) ? say("Done.", wireUsage(7, 2)) : noteAndMemory("t1", noteBatch, wireUsage(11, 3));
    });
    await f.turn();
    // 27d: two records, one per attempt. The first is the fork attempt's own.
    const [attempt, run] = await records(f, 2);
    const first = JSON.parse(attempt!.response!), response = JSON.parse(run!.response!);
    expect(f.sent.filter(forkAttempt)).toHaveLength(1); // one fork attempt, and only one
    expect(attempt!.mode).toBe("fork");
    expect(attempt!.outcome).toBe("failure");
    // 32c: native fallback transports the same durable execution, not two failed tasks.
    const links = f.h.memory.store.db.prepare("SELECT execution_id FROM execution_runs WHERE run_id IN (?,?)").all(attempt!.id, run!.id);
    expect(new Set(links.map(row => row.execution_id)).size).toBe(1);
    expect(links).toHaveLength(2);
    expect(f.h.memory.store.taskFailures(1)).toMatchObject([{ count: 0 }]);
    expect(attempt!.model).toBe("fake/test"); // the session model it really ran on
    expect(first.requestedMode).toBe("fork");
    expect(first.problems.join(" ")).toContain(OVERFLOW);
    expect(first.fallbackReason).toBeUndefined(); // the reason belongs to the run that fell back
    expect(String(first.nativeLog).startsWith(`${f.runsDir}/`)).toBe(true);
    expect(first.verification.passed).toBe(true); // the attempt really went out: its gate result is kept
    expect(run!.mode).toBe("subagent");
    expect(response.requestedMode).toBe("fork");
    // 27c: the fork attempt ran on the session model; the re-admission runs — and is charged — on the
    // configured Noter model, priced by that model's own capacity.
    expect(f.sent.filter(forkAttempt)[0]!.model).toBe("test");
    expect(f.sent.filter(fresh).map((body: Body) => body.model)).toEqual(["test-mini", "test-mini"]);
    expect(run!.model).toBe("fake/test-mini");
    expect(response.fallbackReason).toContain("context overflow");
    expect(response.fallbackReason).toContain(OVERFLOW);
    expect(response.fallbackReason).toContain(`R${attempt!.id}`); // and names the attempt's own record
    // The same frozen membership, and the evidence committed once.
    expect(response.entryAudit.entries.map((e: { nativeId: string }) => e.nativeId))
      .toEqual(hydrate(f.h.memory.store.listSourceEntries(1), f.h.memory.store).map(e => e.nativeId));
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    // Usage is the fresh child's two real responses and nothing else: the rejected request reported
    // the SDK's placeholder zeros, which are unknown, never a paid successful generation.
    expect(response.usage.input).toBe(18);
    expect(response.usage.output).toBe(5);
    expect(first.usage).toBeNull(); // and the attempt's record reports its own unknown, not the fresh child's spend
    // One explicit note/memory pair across both attempts: the rejected attempt executed no tool, and its child was
    // disposed before the fresh one started, so nothing of it could still write.
    expect(response.toolCalls.map((c: { name: string }) => c.name)).toEqual(["note", "memory"]);
    expect(first.toolCalls).toEqual([]);
    expect(f.h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
  } finally { await f.dispose(); }
}, 30000);

test("92: a Noter overflow fallback discards the first held pool and publishes only the fresh attempt", async () => {
  const f = await fixture({ notingModel: "fake/test-mini" });
  try {
    const oldText = "Package trace-memory moved from beta.1 to beta.2";
    const finalText = "Package trace-memory moved from beta.2 to beta.3";
    f.script((body: Body) => {
      if (!worker(body)) return say("Seeded.");
      return submitted(body) ? say("Done.") : noteAndMemory("seed", { facts: [{ ...noteBatch.facts[0], sources: [{ address: "T1#E1", text: oldText }] }] });
    });
    await f.turn("seed source " + "word ".repeat(100));
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual([oldText]);

    let inserted = false;
    const finalBatch = { facts: [{ ...noteBatch.facts[0], sources: [{ address: "T2#E1", text: finalText }] }] };
    f.script((body: Body) => {
      if (!worker(body)) return say("Target recorded.");
      if (!fresh(body)) {
        if (!toolResults(body)) return call("candidate", "note", finalBatch);
        if (!inserted) {
          inserted = true;
          const source = f.h.memory.store.sourcePath(1, "main", 1).find(entry => entry.entryOrdinal === 1)!;
          for (let i = 0; i < 3; i++) fact(f.h.memory, f.h.memory.store.knowledgePath(1, "main", 1),
            `Updated package ${i}`, [{ entry: f.h.memory.store.getSourceEntry(source.id)!, text: finalText }]);
        }
        return rejected(OVERFLOW);
      }
      return submitted(body) ? say("Done.") : noteAndMemory("fresh", finalBatch);
    });
    await f.turn("target source " + "word ".repeat(100));
    const [, attempt, run] = await records(f, 3);
    const first = JSON.parse(attempt!.response!), second = JSON.parse(run!.response!);
    expect([attempt!.mode, attempt!.outcome, run!.mode, run!.outcome]).toEqual(["fork", "failure", "subagent", "success"]);
    expect(first.notingNearReview).toBeUndefined();
    expect(second.notingNearReview).toBeUndefined();
    expect(first.toolCalls[0].result).toContain("held: $1");
    expect(f.h.memory.store.listSessionFacts(1).sort((a, b) => a.id - b.id).map(fact => fact.text)).toEqual([oldText, finalText, finalText, finalText, finalText]);
    expect(f.h.memory.store.listFactsByRun(attempt!.id)).toEqual([]);
    expect(f.h.memory.store.listFactsByRun(run!.id)).toHaveLength(1);
    expect(second.fallbackReason).toContain(`R${attempt!.id}`);
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
    expect(hydrate(f.h.memory.pendingEntries(1, "main", 1), f.h.memory.store).length).toBeGreaterThan(0);
  } finally { await f.dispose(); }
}, 30000);

test.each([
  ["a nonempty", noteBatch],
  ["an explicit empty", { facts: [] }],
])("92: %s held note followed by overflow can fall back, but neither failed attempt publishes", async (_kind, batch) => {
  const f = await fixture();
  try {
    f.script((body: Body) => {
      if (!worker(body)) return say("好的。");
      if (fresh(body)) return rejected(OVERFLOW);
      return submitted(body) ? rejected(OVERFLOW) : noteAndMemory("t1", batch);
    });
    await f.turn();
    const [attempt, run] = await records(f, 2);
    expect([attempt!.mode, attempt!.outcome, run!.mode, run!.outcome]).toEqual(["fork", "failure", "subagent", "failure"]);
    expect(f.sent.filter(fresh)).toHaveLength(1);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(f.h.memory.store.listVisibleKnowledge(1, f.h.memory.store.getSession(1)!.projectId)).toEqual([]);
    expect(JSON.parse(attempt!.response!).problems.join(" ")).toContain(OVERFLOW);
    expect(hydrate(f.h.memory.pendingEntries(1, "main", 1), f.h.memory.store)).toHaveLength(2);
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
    const task = {
      kind: "noting", mode: "fork", model: "fake/test", sessionId: 1, branch: "main", signal: controller.signal, entryIds: [1],
      prompt: "You are the Noter.", text: { fresh: "note what happened", inherited: "the increment" },
      reportRequest: () => {}, reportProgress: () => {},
    } as unknown as NotingAgentInput;
    const binding: WorkerBinding = { model: f.model as never, checkCapacity: () => {},
      tools: toolDefinitions.map(t => ({ ...t, execute: () => "committed" })), runsDir: f.runsDir, cwd: f.h.dir, agentDir: f.agentDir, maxToolRounds: 0,
      fork: { parentFile: f.manager().getSessionFile()!, parentSessionId: f.manager().getSessionId(), checkpoint: f.manager().getLeafId()!, captured },
      onCache: () => {}, onRetry: () => {}, onRetryEnd: () => {} };
    const result = await runWorker(task, binding);
    expect(result.outcome).toBe("cancelled");
    expect(result.mode).toBe("fork");
    expect(result.refused).toBeUndefined(); // a cancelled attempt is not re-admitted by anyone
    expect(f.sent.filter(fresh)).toEqual([]);
  } finally { await f.dispose(); }
}, 30000);

test("27c 2026-09-10: a fresh rebuild the re-admission cannot fit leaves the frozen evidence pending with that diagnostic", async () => {
  // 27b rebuilt inside the worker; 27c re-admits, so the refusal that decides this case is the second
  // admission's own — and it is what is reported, never hidden by the fallback warning.
  const f = await fixture();
  try {
    f.script((body: Body) => {
      if (!worker(body)) return say("好的。");
      // The provider rejects the fork body for capacity, and by the time the host admits the task
      // again, the model it would run on can no longer hold even the instructions.
      (f.h.ctx as { model: unknown }).model = { ...f.h.ctx.model!, contextWindow: 10_500 };
      return rejected(OVERFLOW);
    });
    await f.turn();
    await vi.waitFor(() => expect(f.h.notices.some(n => n.includes("left pending"))).toBe(true), { timeout: 5000 });
    expect(f.sent.filter(forkAttempt)).toHaveLength(1);
    expect(f.sent.filter(fresh)).toEqual([]); // the fresh child never started: nothing fit its window
    expect(f.h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1); // the transition happened
    expect(f.h.notices.some(n => n.includes("already cost"))).toBe(true); // and its own refusal is the diagnostic
    // 27d (the review's zero-record case): the attempt that really sent a request is recorded even
    // though the re-admission never ran. Its spend is accounted, and only it — nothing was committed.
    const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting");
    expect(runs).toHaveLength(1);
    expect(runs[0]!.mode).toBe("fork");
    expect(runs[0]!.outcome).toBe("failure");
    expect(JSON.parse(runs[0]!.response!).problems.join(" ")).toContain(OVERFLOW);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(hydrate(f.h.memory.pendingEntries(1, "main", 1), f.h.memory.store).length).toBeGreaterThan(0); // the evidence waits
  } finally { await f.dispose(); }
}, 30000);

test("27b 2026-09-10: at most one transition per task — the fresh child's own failure is reported as itself, not hidden by the warning", async () => {
  const f = await fixture();
  try {
    // Both attempts are rejected for context capacity. The second one is a subagent already, so
    // nothing falls back again: its failure is the run's failure.
    f.script((body: Body) => !worker(body) ? say("好的。") : rejected(OVERFLOW));
    await f.turn();
    const [attempt, run] = await records(f, 2);
    const response = JSON.parse(run!.response!);
    expect(f.sent.filter(forkAttempt)).toHaveLength(1);
    expect(f.sent.filter(fresh)).toHaveLength(1);
    const links = f.h.memory.store.db.prepare("SELECT execution_id FROM execution_runs WHERE run_id IN (?,?)").all(attempt!.id, run!.id);
    expect(new Set(links.map(row => row.execution_id)).size).toBe(1);
    expect(links).toHaveLength(2);
    expect(f.h.memory.store.taskFailures(1)).toMatchObject([{ count: 1 }]);
    expect(attempt!.mode).toBe("fork");   // 27d: the refused attempt is its own record
    expect(attempt!.outcome).toBe("failure");
    expect(run!.mode).toBe("subagent");
    expect(run!.outcome).toBe("failure");
    expect(response.problems.join(" ")).toContain(OVERFLOW);
    // Neither attempt reported usage, and unknown stays unknown rather than a fabricated zero.
    expect(JSON.parse(attempt!.response!).usage).toBeNull();
    expect(response.usage).toBeNull();
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(hydrate(f.h.memory.pendingEntries(1, "main", 1), f.h.memory.store).length).toBeGreaterThan(0);
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
      task: "# Noting (facts and knowledge)\n\nnote what happened",
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
      : noteAndMemory(`t${++submissions}`, submissions === 1 ? { facts: [] } : { facts: [{ ...noteBatch.facts[0], source: ["T2#E1"] }] }));
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


// ---------------------------------------------------------------- 27c: one fallback path

/** The foreground model, left with 1,000 tokens for input: an admission that priced this batch by it
 * would refuse the batch instead of running it, so a run at all is the capacity assertion. Only the
 * two refusals decided at admission can state it — a launch-time refusal needs an admissible fork. */
const foregroundTooSmall = (h: ReturnType<typeof host>) => { h.ctx.model = { ...h.ctx.model!, contextWindow: 11_000 }; };

test.each([
  ["the cache-miss latch", (h: ReturnType<typeof host>) => { foregroundTooSmall(h); expect(h.memory.store.suppressFork(1)).toBe(true); }, "cache miss latch"],
  // 29c: a compaction Pi persisted that kept none of the selected entries and carried no views of
  // ours, so the batch is no longer available in the context a fork would inherit.
  ["an entry the compacted context no longer holds", (h: ReturnType<typeof host>) => { foregroundTooSmall(h); h.compaction(); }, "Raw availability: entry "],
  ["a launch-time refusal", () => {}, "native runner: No current-branch provider payload captured"],
])("27c: whatever the refusal, the subagent model (%s)", async (_kind, arrange, reason) => {
  // `notingModel` is a model the foreground is not on, so the run record's model is the whole point:
  // before 27c only the requested mode decided it, and an effective-subagent task was frozen on — and
  // charged to — the foreground model at the foreground's own capacity.
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 30, notingModel: "fake/test-mini" });
  try {
    await h.emit("session_start");
    // A first turn too small to be due: it allocates the memory session the arrangement below needs.
    await h.prompt("hi"); await h.answer("ok"); await h.emit("agent_settled"); await h.drain();
    expect(h.memory.store.listRuns(1)).toEqual([]);
    arrange(h);
    await h.prompt("word ".repeat(200));
    await h.answer("word ".repeat(200));
    await h.emit("agent_settled"); await h.drain();
    const runs = h.memory.store.listRuns(1).filter(r => r.kind === "noting");
    expect(runs).toHaveLength(1); // one task, one run: a re-admission is neither a second run nor a drain
    const run = runs[0]!, response = JSON.parse(run.response!);
    expect(run.mode).toBe("subagent");
    expect(response.requestedMode).toBe("fork"); // the audit keeps what was configured
    expect(run.model).toBe("fake/test-mini");    // and names the model that ran and was charged
    expect((h.requests[0] as { model?: string }).model).toBe("test-mini"); // which really is the one asked
    expect(String(response.fallbackReason)).toContain(reason);
    expect(h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
    expect(h.conversations[0]!.systemPrompt).toContain("Noting (facts and knowledge)"); // fresh material
    h.ctx.hasUI = true;
    h.answers.push("Settings…", undefined); await h.commands.get("trace")!.handler("", h.ctx);
    expect(h.dialogs.at(-1)!.options).toContain("Noter mode: fork (Environment setting — this edit will not take effect)"); // no executor mode change
  } finally { await h.dispose(); }
});

test("27c 2026-09-10: the reported live case — an entry the compaction did not keep runs on the configured Noter model, at its own thinking level", async () => {
  // The defect as it was reported: a Noter admitted as `fork` whose evidence a compaction had removed
  // ran as a subagent on the FOREGROUND model, at the foreground's level. Here the foreground is
  // `fake/test` and the configured Noter is a second model with its own configured level.
  // 29c retargeted the arrangement, not the outcome: the compaction below is Pi's own, so the earlier
  // entries are neither retained nor carried as bounded views, which is what refuses the fork now.
  const f = await fixture({ notingModel: "fake/test-thinking", notingThinking: "high" });
  try {
    let notes = 0;
    f.script((body: Body) => !worker(body) ? say("好的。") : submitted(body) ? say("Done.") : noteAndMemory(`t${++notes}`, notes === 1 ? noteBatch : { facts: [{ ...noteBatch.facts[0], source: ["T2#E1"] }] }));
    await f.turn(); // an ordinary fork Noting first: fork mode always runs on the session model
    const first = await settled(f);
    expect(first.mode).toBe("fork");
    expect(first.model).toBe("fake/test");
    // New foreground evidence, then a compaction Pi persists on this ancestry keeping only the leaf:
    // the next Noter's older entries are in no representation the inherited context holds, so its fork
    // is refused at admission.
    f.manager().appendMessage({ role: "user", content: "用 bun，不要 node " + "word ".repeat(400), timestamp: 1 } as never);
    f.manager().appendMessage({ ...reply("an answer " + "word ".repeat(400)), timestamp: 1 } as never);
    f.manager().appendCompaction("native summary", f.manager().getLeafId()!, 100);
    await f.h.emit("agent_settled");
    const second = await vi.waitFor(() => {
      const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response);
      expect(runs).toHaveLength(2); return runs.sort((a, b) => a.id - b.id)[1]!;
    }, { timeout: 5000 });
    const audit = JSON.parse(second.response!);
    expect(second.mode).toBe("subagent");
    expect(audit.requestedMode).toBe("fork");
    expect(String(audit.fallbackReason)).toContain("Raw availability: entry ");
    expect(second.model).toBe("fake/test-thinking");
    const child = f.sent.filter((body: Body) => worker(body)).at(-1)!; // the second run's own child
    expect(child.model).toBe("test-thinking"); // the model the request really named
    // 26d: a fresh child of this task thinks at the phase's configured subagent level, frozen at its
    // own admission — the foreground's `off` never reaches it.
    expect(audit.thinking).toEqual({ requested: "high", effective: "high" });
    expect(child.reasoning_effort).toBe("high");
    expect(f.h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
    expect(f.h.memory.store.forkSuppression(1)).toBeNull(); // a warning, not the latch
  } finally { await f.dispose(); }
}, 30000);

test("27c 2026-09-10: the re-admission keeps the frozen entry membership — evidence that arrives during the attempt waits", async () => {
  const f = await fixture();
  try {
    let frozen: string[] = [];
    f.script(async (body: Body) => {
      if (!worker(body)) return say("好的。");
      if (fresh(body)) return submitted(body) ? say("Done.") : noteAndMemory("t1", noteBatch);
      // The fork attempt is in flight when new foreground evidence lands, and the provider then
      // rejects this body for context capacity.
      if (frozen.length) return rejected(OVERFLOW);
      frozen = hydrate(f.h.memory.store.listSourceEntries(1), f.h.memory.store).map(e => e.nativeId);
      f.manager().appendMessage({ role: "user", content: "LATER EVIDENCE " + "word ".repeat(400), timestamp: 1 } as never);
      f.manager().appendMessage({ ...reply("later answer " + "word ".repeat(400)), timestamp: 1 } as never);
      await f.h.emit("message_start", { message: reply("") });
      return rejected(OVERFLOW);
    });
    await f.turn();
    const [, run] = await records(f, 2);
    const response = JSON.parse(run!.response!);
    expect(frozen.length).toBeGreaterThan(0);
    expect(hydrate(f.h.memory.store.listSourceEntries(1), f.h.memory.store).length).toBeGreaterThan(frozen.length); // the newcomers were recorded
    // 18b's boundary: the re-admission selects the batch the refused attempt was frozen on, never the
    // range that grew under it, and the evidence that arrived meanwhile stays pending.
    expect(response.entryAudit.entries.map((e: { nativeId: string }) => e.nativeId)).toEqual(frozen);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.h.memory.pendingEntries(1, "main", f.h.memory.store.listTurns(1).at(-1)!.id).length).toBeGreaterThan(0);
  } finally { await f.dispose(); }
}, 30000);


// ------------------------------------------- 27d: one run record per attempt, exact membership

test("27d 2026-09-10 (user ruling): a fork attempt that sent a round is its own run record, and the re-admitted run charges only itself", async () => {
  // The attempt spends one paid tool round and is then rejected for capacity. Before 27d both
  // attempts shared one record and the attempt's usage was merged into the fresh child's.
  const f = await fixture({ notingModel: "fake/test-mini" });
  try {
    let forks = 0;
    f.script((body: Body) => {
      if (!worker(body)) return say("好的。");
      if (!fresh(body)) return ++forks === 1 ? call("r1", "search", { query: "pnpm" }, wireUsage(1234, 7)) : rejected(OVERFLOW);
      return submitted(body) ? say("Done.", wireUsage(7, 2)) : noteAndMemory("t1", noteBatch, wireUsage(11, 3));
    });
    await f.turn();
    const [attempt, run] = await records(f, 2);
    const first = JSON.parse(attempt!.response!), second = JSON.parse(run!.response!);
    expect(forks).toBe(2); // one tool round, then the overflow
    // The attempt's own record: the mode and model it ran in, its own usage, its tool call and its log.
    expect(attempt!.mode).toBe("fork");
    expect(attempt!.outcome).toBe("failure");
    expect(attempt!.model).toBe("fake/test");
    expect(first.requestedMode).toBe("fork");
    expect(first.usage.input).toBe(1234);
    expect(first.usage.output).toBe(7);
    expect(first.toolCalls.map((c: { name: string }) => c.name)).toEqual(["search"]);
    expect(String(first.nativeLog).startsWith(`${f.runsDir}/`)).toBe(true);
    expect(first.fallbackReason).toBeUndefined();
    expect(first.problems.join(" ")).toContain(OVERFLOW);
    // The re-admitted run records what IT spent — the fresh child's two responses, never 1234 more —
    // and names the record of the attempt it followed, so the two read as the one task they are.
    expect(run!.mode).toBe("subagent");
    expect(run!.model).toBe("fake/test-mini");
    expect(run!.outcome).toBe("success");
    expect(second.usage.input).toBe(18);
    expect(second.usage.output).toBe(5);
    expect(second.fallbackReason).toContain("context overflow");
    expect(second.fallbackReason).toContain(`R${attempt!.id}`);
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
  } finally { await f.dispose(); }
}, 30000);

test("27d 2026-09-10: an unavailable fallback model leaves the paid attempt's own record — never a task with two requests and no accounting", async () => {
  // The review's zero-record case, with a fallback model that does not exist at all.
  const f = await fixture({ notingModel: "absent/mini" });
  try {
    let forks = 0;
    f.script((body: Body) => {
      if (!worker(body)) return say("好的。");
      if (fresh(body)) throw new Error("an unavailable fallback model must send nothing");
      return ++forks === 1 ? call("r1", "search", { query: "pnpm" }, wireUsage(1234, 7)) : rejected(OVERFLOW);
    });
    await f.turn();
    await vi.waitFor(() => expect(f.h.notices.some(n => n.includes("unavailable model context window"))).toBe(true), { timeout: 5000 });
    const [attempt] = await records(f, 1);
    expect(forks).toBe(2);
    expect(attempt!.mode).toBe("fork");
    expect(attempt!.outcome).toBe("failure");
    expect(JSON.parse(attempt!.response!).usage.input).toBe(1234); // the spend is accounted, not lost
    expect(f.sent.filter(fresh)).toEqual([]);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(hydrate(f.h.memory.pendingEntries(1, "main", 1), f.h.memory.store).length).toBeGreaterThan(0); // and the evidence waits
  } finally { await f.dispose(); }
}, 30000);

test("27d 2026-09-10 (parent 27 amendment 6): a fallback model that cannot hold the whole frozen batch leaves it pending, never a smaller batch", async () => {
  // The review's membership case: the fork froze two entries, and the configured Noter model's own
  // window holds only one. Before 27d the fallback reported success on the subset it could fit.
  const f = await fixture({ notingModel: "fake/test-mini" });
  try {
    const find = f.h.ctx.modelRegistry.find.bind(f.h.ctx.modelRegistry);
    f.h.ctx.modelRegistry.find = ((provider: string, id: string) => {
      const model = find(provider, id);
      // The Noter's fixed cost fits with 204 tokens to spare, as it did when this window was 18,000:
      // the whole frozen batch cannot, so the capacity loop, not the preflight floor, refuses it.
      const fixed = tokens(loadPrompt("noting.md")) + tokens(JSON.stringify(toolDefinitions));
      return id === "test-mini" && model ? { ...model, contextWindow: CONTEXT_HEADROOM + fixed + 204 } : model;
    }) as typeof f.h.ctx.modelRegistry.find;
    let frozen: number[] = [];
    f.script((body: Body) => {
      if (!worker(body)) return say("word ".repeat(3000));
      if (fresh(body)) throw new Error("a batch that does not fit whole must send nothing");
      frozen = hydrate(f.h.memory.store.listSourceEntries(1), f.h.memory.store).map(e => e.id);
      return rejected(OVERFLOW);
    });
    await f.turn("word ".repeat(3000));
    await vi.waitFor(() => expect(f.h.notices.some(n => n.includes("left pending"))).toBe(true), { timeout: 5000 });
    expect(frozen.length).toBeGreaterThan(1);
    // The refusal is the capacity loop's own — the batch was priced whole and did not fit — not the
    // preflight floor, which would have refused before any entry was selected.
    expect(f.h.notices.some(n => n.includes("it costs"))).toBe(true);
    // Only the attempt's own record exists: no subagent run took a subset of the frozen evidence.
    const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting");
    expect(runs.map(r => r.mode)).toEqual(["fork"]);
    expect(f.h.memory.store.listSessionFacts(1)).toEqual([]);
    expect(f.h.memory.pendingEntries(1, "main", f.h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id)).toEqual(frozen);
  } finally { await f.dispose(); }
}, 30000);


// ------------------------------------------------- 29c: a fork needs its whole target in the context

/** 29a's persisted carrier shape (`details.traceMemory` on the compaction entry), stated directly so
 * one row can pin one representation. The real bounded-view path is driven through the compaction
 * hook in the row above it; core's own reading of every representation — the one bounded view and
 * both legacy tiers — is `tests/core/api/visible.test.ts`. */
const carrier = (h: ReturnType<typeof host>, entries: { id: number; nativeId: string; view?: "bounded"; tier?: 1 | 2 }[]) =>
  ({ traceMemory: { db: h.dbPath, session: 1, pi: "pi-test", supplied: { entries, factIds: [], knowledgeCommitIds: [] } } });

type Older = { id: number; turnId: number; nativeId: string }[];
/** Each row arranges what the context holds of the three entries laid down before it, and answers
 * with the refusal the admission must state — `undefined` when the target is available and the fork
 * is admitted (the fake host has no persisted parent session, so an admitted fork is refused at the
 * LAUNCH for the capture it has no way to have; that is the assertion the `undefined` rows make). */
test.each([
  ["every entry retained: nothing was compacted at all", () => {}, undefined],
  ["the oldest entries survive as bounded views in a custom compaction of ours",
    async (h: ReturnType<typeof host>, older: Older) => {
      // The real path, not a stated payload: compact writes the custom replacement and the carrier
      // that says what it supplied, which is exactly what the rule then reads back.
      const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 1_000 } });
      const entry = h.compaction(block.compaction.summary) as { details: { traceMemory: { supplied: { entries: { view: string }[] } } } };
      for (const e of older) expect(entry.details.traceMemory.supplied.entries).toContainEqual(expect.objectContaining({ id: e.id, view: "bounded" }));
    }, undefined],
  // 30 "Visibility and fork": the tier-2 exclusion is superseded, so a legacy carrier that marked the
  // whole target as tier-2 views is coverage, and the fork is admitted on it.
  ["the whole target survives as legacy tier-2 views",
    (h: ReturnType<typeof host>) => {
      const head = h.memory.store.listTurns(1).at(-1)!.id;
      h.compaction("legacy tier-2 views", { details: carrier(h, hydrate(h.memory.pendingEntries(1, "main", head), h.memory.store)
        .map(e => ({ id: e.id, nativeId: e.nativeId, tier: 2 as const }))) });
    }, undefined],
  ["a compaction Pi wrote itself: a summary and nothing else", (h: ReturnType<typeof host>) => h.compaction(), (older: Older) => older[0]!],
  ["ids named in the summary text with no supplied entry behind them",
    (h: ReturnType<typeof host>, older: Older) => h.compaction(`covers ${older.map(e => e.nativeId).join(", ")}`, { details: carrier(h, []) }),
    (older: Older) => older[0]!],
  ["one entry absent from an otherwise complete carrier",
    (h: ReturnType<typeof host>, older: Older) =>
      h.compaction("most of it", { details: carrier(h, older.slice(0, -1).map(e => ({ id: e.id, nativeId: e.nativeId, view: "bounded" as const }))) }),
    (older: Older) => older.at(-1)!],
])("29: a Noter forks only when its whole target is available in the inherited context (%s)", async (_label, arrange, expected) => {
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 100, notingModel: "fake/test-mini" });
  try {
    await h.emit("session_start");
    // Two turns too small to be due: they lay down the entries a compaction can drop, and the memory
    // session the carriers above are bound to.
    for (const [ask, answer] of [["hi", "ok"], ["hey", "sure"]]) {
      await h.prompt(ask!); await h.answer(answer!); await h.emit("agent_settled"); await h.drain();
    }
    expect(h.memory.store.listRuns(1)).toEqual([]);
    const head = () => h.memory.store.listTurns(1).at(-1)!.id;
    // The fake host's compaction keeps its last entry, so these three are the droppable ones.
    const older = h.memory.pendingEntries(1, "main", head()).slice(0, 3);
    expect(older).toHaveLength(3);
    await arrange(h, older);
    // A turn large enough to be due. Its own entries are always retained, and so — for this rule — is
    // the head reply: `buildContextEntries()` holds it, and 29b's increment restates it for the fork
    // whose captured request stops before it, so a target whose only non-retained entry is the head
    // reply still forks.
    await h.prompt("word ".repeat(200)); await h.answer("word ".repeat(200));
    await h.emit("agent_settled"); await h.drain();
    const runs = h.memory.store.listRuns(1).filter(r => r.kind === "noting");
    expect(runs).toHaveLength(1); // one task, one run: never a second batch and never a partial one
    const run = runs[0]!, response = JSON.parse(run.response!);
    expect(response.requestedMode).toBe("fork"); // the audit keeps what was configured, either way
    // Whatever the verdict, the target is the whole batch: an entry the context does not hold is never
    // dropped to make the rest forkable.
    const frozen = (response.entryAudit.entries as { id: number }[]).map(e => e.id);
    expect(frozen).toEqual(expect.arrayContaining(older.map(e => e.id)));
    if (!expected) {
      // 105 freezes at the final reply, including it. The persisted head is in the
      // inherited view, even though the captured pre-reply provider request lacks it.
      const headReply = hydrate(h.memory.store.listSourceEntries(1), h.memory.store).at(-1)!;
      expect(headReply.role).toBe("assistant");
      expect(frozen).toContain(headReply.id);
      expect(String(response.fallbackReason)).not.toContain("Raw availability");
      // Admitted as a fork: what stops it here is the fake host's missing capture, at the launch.
      expect(String(response.fallbackReason)).toContain("No current-branch provider payload captured");
    } else {
      const entry = expected(older);
      expect(run.mode).toBe("subagent");
      expect(run.model).toBe("fake/test-mini"); // 27c: the configured Noter model, not the foreground
      expect(String(response.fallbackReason)).toContain(`Raw availability: entry ${entry.id} (T${entry.turnId}, native ${entry.nativeId})`);
      expect(frozen).toContain(entry.id); // the entry that refused the fork is in the batch that ran
      expect(h.notices.filter(n => n.includes("fell back to subagent mode"))).toHaveLength(1);
      expect(h.memory.store.forkSuppression(1)).toBeNull(); // a per-task refusal, not the cache-miss latch
    }
  } finally { await h.dispose(); }
});

test("29: a Noter forks only when its whole target is available in the inherited context (an unknown view, and an incomplete tool group)", async () => {
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 30, notingModel: "fake/test-mini" });
  try {
    await h.emit("session_start");
    await h.prompt("hi"); await h.answer("ok"); await h.emit("agent_settled"); await h.drain();
    // A context that holds no conversation entry of ours establishes nothing about what a fork would
    // inherit. Like 27a's unknown context measure, unknown is not "available": it reroutes.
    const build = h.ctx.sessionManager.buildContextEntries.bind(h.ctx.sessionManager);
    const getEntry = h.ctx.sessionManager.getEntry.bind(h.ctx.sessionManager);
    (h.ctx.sessionManager as { buildContextEntries: () => unknown[] }).buildContextEntries = () => [];
    // 92's append reader uses native parent lookups. The unknown-context fixture must make
    // that native surface unavailable too, rather than exposing a contradictory complete path.
    h.ctx.sessionManager.getEntry = () => undefined;
    await h.prompt("word ".repeat(200)); await h.answer("word ".repeat(200));
    await h.emit("agent_settled"); await h.drain();
    const run = h.memory.store.listRuns(1).filter(r => r.kind === "noting")[0]!;
    const response = JSON.parse(run.response!);
    expect(run.mode).toBe("subagent");
    expect(response.requestedMode).toBe("fork");
    expect(run.model).toBe("fake/test-mini");
    expect(String(response.fallbackReason)).toContain("holds no conversation entry of ours");
    (h.ctx.sessionManager as { buildContextEntries: () => unknown[] }).buildContextEntries = build;
    h.ctx.sessionManager.getEntry = getEntry;
  } finally { await h.dispose(); }
});

test("29: an incomplete tool-call group is not availability (the native gate, unchanged by 29c)", () => {
  // 29c decides Raw availability and leaves this check where it already is: `forkable` rejects the
  // checkpoint itself, so the group never becomes "one more available entry". Its deferral at the
  // launch is `readiness.test.ts` ("a checkpoint with an unanswered tool call defers the launch"),
  // and the runner's own refusal reaches the subagent path through 27c's `NotForkable` seam.
  const entries = [
    { id: "e0", type: "message", message: { role: "user", content: "hi" } },
    { id: "e1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read" }] } },
  ] as never;
  expect(() => forkable(entries)).toThrow("checkpoint tool call call-1 has no result");
});
