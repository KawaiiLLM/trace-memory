import { expect, test, vi } from "vitest";
import { host, reply } from "./test-host.ts";
import { cacheMinimum, cacheObservation, runNative } from "../../../src/hosts/pi/native.ts";
// Cache observations require an explicitly requested fork, not the product's subagent default.
import { broken, call, noteAndMemory, stableForkFixture as fixture, memoryBatch, noteBatch, say, settled, toolResults, usage, worker } from "./native-fixture.ts";
import { recorded } from "../../source-fixture.ts";

// 19c cache-miss latch (ticket 19 gate 3 and "Cache-miss fallback"), under the user rulings of
// 2026-09-09: the deterministic prefix check runs first; a response whose request passed it is a miss
// when its cacheRead is below half of its input; every miss is noticed once with its count; the second
// consecutive miss downgrades the session once; a hit resets the count; the latch is session-scoped
// and reset only through the /trace menu.

const DOWNGRADE = "Trace Memory: fork downgraded after two consecutive cache misses. Future memory tasks in this session will use subagent.";
const big = () => usage(32000, 5, 0); // 32,000 input tokens, nothing read from cache: a miss
const small = () => usage(10, 2, 0); // below every documented minimum
const long = "word ".repeat(400);
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const notingRuns = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).filter(r => r.kind === "noting");
const misses = (h: ReturnType<typeof host>) => h.notices.filter(n => /fork cache miss \d\/2 /.test(n));
const downgrades = (h: ReturnType<typeof host>) => h.notices.filter(n => n === DOWNGRADE);

test("19c 2026-09-08/09: two consecutive zero-cache fork responses downgrade the session once and neither replay the task nor relabel its mode", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : toolResults(body) ? say("Done.", big()) : noteAndMemory("t1", noteBatch, big()));
    await f.turn();
    const run = await settled(f);
    // The task that observed the miss finished its own write protocol in its own native session.
    expect(run.mode).toBe("fork"); // never relabelled as subagent execution
    expect(run.outcome).toBe("success");
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1); // no replay, and no extra extraction trigger
    const response = JSON.parse(run.response!);
    expect(response.verification.passed).toBe(true); // the prefix check passed first (gate 3)
    expect(response.verification.cacheMiss).toEqual({ model: "fake/test", api: "openai-completions", minimum: 1024, ratio: 0.5, input: 32000, cacheRead: 0, cacheWrite: 0, total: 32000, miss: true });
    // One notice per miss with its count, then one downgrade notice (user ruling 2026-09-09).
    expect(misses(f.h).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2", "Trace Memory: fork cache miss 2/2"]);
    expect(downgrades(f.h)).toEqual([DOWNGRADE]);
    const suppression = f.h.memory.store.forkSuppression(1)!;
    expect(Number.isFinite(Date.parse(suppression.at))).toBe(true);
    expect(suppression.runId).toBe(run.id); // the audit names the run that detected it
    await command(f.h, "");
    expect(f.h.notices.at(-1)).toContain(`Fork suppressed since ${suppression.at} (R${run.id})`);
  } finally { await f.dispose(); }
}, 20000);

test("19c 2026-09-08: while the latch is set a requested fork is admitted as a subagent with the cache-miss reason", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : toolResults(body) ? say("Done.", big()) : noteAndMemory("t1", noteBatch, big()));
    await f.turn();
    await vi.waitFor(() => expect(f.h.memory.store.forkSuppression(1)).toBeTruthy(), { timeout: 5000 });
    const at = f.h.memory.store.forkSuppression(1)!.at;
    expect(downgrades(f.h)).toEqual([DOWNGRADE]);
    // A later task of the same session, with the capture and the checkpoint both still valid.
    f.manager().appendMessage({ role: "user", content: long, timestamp: 1 } as never);
    f.manager().appendMessage({ ...reply("second answer"), timestamp: 1 } as never);
    await f.h.emit("message_start", { message: reply("") });
    const second = await vi.waitFor(() => { const runs = notingRuns(f.h); expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); return runs[1]!; }, { timeout: 5000 });
    expect(second.mode).toBe("subagent");
    const response = JSON.parse(second.response!);
    expect(response.requestedMode).toBe("fork"); // the configured mode is retained, not rewritten
    expect(response.fallbackReason).toContain("cache miss latch");
    expect(response.verification).toBeUndefined();
    expect(downgrades(f.h)).toEqual([DOWNGRADE]); // the same episode never downgrades twice
    expect(misses(f.h)).toHaveLength(2); // and a subagent run observes nothing
    expect(f.h.memory.store.forkSuppression(1)!.at).toBe(at);
    // Global configuration and unrelated sessions are untouched.
    // `h.memory` is a separate observer facade; Settings reads the actual executor configuration.
    f.h.ctx.hasUI = true;
    f.h.answers.push("Settings…", undefined); await command(f.h, "");
    expect(f.h.dialogs.at(-1)!.options).toContain("Noter mode: fork (Environment setting — this edit will not take effect)");
    const other = f.h.memory.store.createSession({ host: "pi:other", startedAt: at, firstReplyAt: at, projectId: 1 });
    expect(f.h.memory.store.forkSuppression(other.id)).toBeNull();
  } finally { await f.dispose(); }
}, 20000);

test("19c 2026-09-08: a request that failed the prefix check does not count toward the latch", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : say("Nothing to note.", big()));
    await f.h.emit("before_agent_start", { prompt: "用 pnpm，不要 npm" });
    await f.parent.prompt("用 pnpm，不要 npm");
    // A capture the child cannot reproduce: one message the parent's own file does not contain. The
    // gate rejects the child's first body before it leaves the process, so this task is a known miss
    // routed to subagent — and the subagent's own zero-cache responses are not fork responses either.
    const doctored = { ...f.sent[0]!, messages: [...f.sent[0]!.messages, { role: "user", content: "ghost" }] };
    await f.h.emit("before_provider_request", { payload: doctored });
    await f.h.emit("agent_settled");
    const run = await settled(f);
    expect(run.mode).toBe("subagent");
    const response = JSON.parse(run.response!);
    expect(response.fallbackReason).toContain("native prefix mismatch");
    expect(response.verification.native.passed).toBe(false);
    // 27d: a gate rejection sends nothing, so it is not an attempt and records no run of its own —
    // this one re-admitted run is the whole audit of the task, and it carries the rejected gate result.
    expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(1);
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
    expect(misses(f.h)).toEqual([]);
  } finally { await f.dispose(); }
}, 20000);

test("19c 2026-09-08: a provider error sets no latch, and a cancelled child reports no miss", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : broken());
    const captured = await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("failure");
    expect(f.h.memory.store.forkSuppression(1)).toBeNull(); // placeholder zeros are unknown, not a miss
    expect(misses(f.h)).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    const missed = vi.fn();
    const cancelled = await runNative(f.task(captured, { signal: controller.signal, onCache: missed }));
    expect(cancelled.outcome).toBe("cancelled");
    expect(missed).not.toHaveBeenCalled();
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await f.dispose(); }
}, 20000);

test("19c 2026-09-08: cache eligibility rejects small, missing, placeholder and unsupported usage, unknown providers and a disabled cache", () => {
  const openai = { api: "openai-completions", id: "test", provider: "fake" };
  const anthropic = { api: "anthropic-messages", id: "claude-sonnet-4", provider: "fake" };
  const haiku = { api: "anthropic-messages", id: "claude-3-5-haiku", provider: "fake" };
  const zero = { input: 32000, cacheRead: 0, cacheWrite: 0 };
  // Eligible: a listed provider, reported cache counts, 32,000 input tokens and nothing read: a miss.
  expect(cacheObservation(openai, zero, true)).toEqual({ model: "fake/test", api: "openai-completions", minimum: 1024, ratio: 0.5, input: 32000, cacheRead: 0, cacheWrite: 0, total: 32000, miss: true });
  // pi-ai reports `input` without the cached tokens on both families; a cache write is not a read,
  // so an Anthropic first write of 31,000 tokens is a miss on a 31,024-token input.
  expect(cacheObservation(anthropic, { input: 24, cacheRead: 0, cacheWrite: 31000 }, true)).toMatchObject({ total: 31024, miss: true });
  // Eligible hits are observed too (they reset the host's count), never recorded as misses.
  expect(cacheObservation(openai, { input: 2000, cacheRead: 40000, cacheWrite: 0 }, true)).toMatchObject({ total: 42000, miss: false });
  expect(cacheObservation(openai, { input: 1, cacheRead: 1023, cacheWrite: 0 }, true)).toMatchObject({ total: 1024, miss: false }); // exactly the minimum, almost all read
  // Not eligible, one reason each.
  expect(cacheObservation(openai, { input: 1000, cacheRead: 0, cacheWrite: 0 }, true)).toBeUndefined(); // below the cacheable minimum
  expect(cacheObservation(openai, undefined, true)).toBeUndefined(); // missing usage
  expect(cacheObservation(openai, { input: 0, cacheRead: 0, cacheWrite: 0 }, true)).toBeUndefined(); // placeholder zeros
  expect(cacheObservation(openai, { input: 32000 }, true)).toBeUndefined(); // no cache reporting at all
  expect(cacheObservation(openai, zero, false)).toBeUndefined(); // the request asked for no caching
  expect(cacheObservation({ api: "google-generative-ai", id: "gemini", provider: "g" }, zero, true)).toBeUndefined(); // unlisted provider
  // The provider table still records the documented minimum on the observation.
  expect(cacheObservation(haiku, zero, true)?.minimum).toBe(2048);
  expect(cacheMinimum("openai-responses", "gpt-5")).toBe(1024);
  expect(cacheMinimum("google-generative-ai", "gemini")).toBeUndefined();
});

test("19c ruling 2026-09-09: a response is a miss when its cacheRead is below half of its input (input + cacheRead + cacheWrite)", () => {
  const openai = { api: "openai-completions", id: "test", provider: "fake" };
  const codex = { api: "openai-codex-responses", id: "gpt-5.6-sol", provider: "openai-codex" };
  // The live run's R2: 5,277 input tokens, nothing read: a miss now, but one miss alone downgrades nothing.
  expect(cacheObservation(codex, { input: 5277, cacheRead: 0, cacheWrite: 0 }, true)?.miss).toBe(true);
  // The boundary: exactly half read is a hit; one token below half is a miss.
  expect(cacheObservation(openai, { input: 5000, cacheRead: 5000, cacheWrite: 0 }, true)?.miss).toBe(false);
  expect(cacheObservation(openai, { input: 5001, cacheRead: 4999, cacheWrite: 0 }, true)?.miss).toBe(true);
  // A large partial hit is a hit whatever it re-sent; the old 30,000-uncached rule no longer applies.
  expect(cacheObservation(openai, { input: 35000, cacheRead: 40000, cacheWrite: 0 }, true)).toMatchObject({ total: 75000, miss: false });
  expect(cacheObservation(openai, { input: 35000, cacheRead: 4000, cacheWrite: 0 }, true)).toMatchObject({ total: 39000, miss: true });
  // Cache-write tokens were not read, so they count against the ratio.
  expect(cacheObservation({ api: "anthropic-messages", id: "claude-sonnet-4", provider: "fake" }, { input: 100, cacheRead: 0, cacheWrite: 29900 }, true)).toMatchObject({ total: 30000, miss: true });
});

test("19c 2026-09-08, as 25b left it: only the Noter forks, so the Consolidator beside it observes nothing and the transition stays single", async () => {
  const f = await fixture({ "consolidation.triggerTokens": 1 });
  try {
    // The first turn's own Noting task must not latch the session before the shared opportunity
    // below, so its response reports a below-minimum input; the later fork tasks report eligible
    // zero-cache responses. The Consolidator runs fresh context (25b) and never forks, so it has no
    // prefix to verify and no cache observation to make, however large its own responses are.
    let notings = 0;
    f.script(body => !worker(body) && !worker(body, "Consolidation") ? say("好的。", small())
      : worker(body, "Consolidation") ? (toolResults(body) >= 2 ? say("Integrated.", big()) : call(`t${toolResults(body)}`, "memory", memoryBatch, big()))
      : say("Nothing to note.", ++notings === 1 ? small() : big()));
    await f.turn();
    f.h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })
      .find(t => t.name === "note")!.execute({ facts: [{ text: "Use pnpm", source: ["T1#E1"] }] });
    recorded(f.h.memory, 1, "main", 1);
    const before = new Set(f.h.memory.store.listRuns(1).map(r => r.id)); // the manual note and its receipt
    await f.turn("tick " + long); // one opportunity, both phases due: one fork task and one subagent task
    await vi.waitFor(() => {
      expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response)).not.toHaveLength(0);
      expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "consolidation" && r.response)).not.toHaveLength(0);
    }, { timeout: 8000 });
    const both = f.h.memory.store.listRuns(1).filter(r => !before.has(r.id)); // this opportunity's two runs
    expect(both.map(r => r.kind).sort()).toEqual(["consolidation", "noting"]);
    const modes = new Map(both.map(r => [r.kind, r.mode]));
    expect(modes.get("noting")).toBe("fork");           // the frozen fork task kept its mode
    expect(modes.get("consolidation")).toBe("subagent"); // and the other phase has only this one
    const audit = (kind: string) => JSON.parse(both.find(r => r.kind === kind)!.response!);
    expect(audit("noting").verification.passed).toBe(true); // it really forked and really reported a zero-cache response
    expect(audit("noting").verification.cacheMiss).toMatchObject({ miss: true });
    expect(audit("consolidation").verification).toBeUndefined(); // a fresh child verifies no prefix and observes no cache
    expect(misses(f.h).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2"]); // one fork, one miss
    expect(downgrades(f.h)).toEqual([]);                 // one miss is not a transition
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
    // The next opportunity's fork run is the second consecutive miss: one transition, one notice.
    await f.turn("tick again " + long);
    await vi.waitFor(() => expect(f.h.memory.store.forkSuppression(1)).toBeTruthy(), { timeout: 8000 });
    expect(misses(f.h).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2", "Trace Memory: fork cache miss 2/2"]);
    expect(downgrades(f.h)).toEqual([DOWNGRADE]);
    const suppression = f.h.memory.store.forkSuppression(1)!;
    expect(notingRuns(f.h).map(r => r.id)).toContain(suppression.runId); // the run that detected it names itself
    // The store's guarded UPDATE is the transition: a second reporter never re-arms it.
    expect(f.h.memory.store.suppressFork(1)).toBe(false);
    expect(f.h.memory.store.forkSuppression(1)!.at).toBe(suppression.at);
  } finally { await f.dispose(); }
}, 30000);

test("19c 2026-09-08: the latch survives reopen and clears only through the menu's Retry fork", async () => {
  const h = host();
  try {
    await h.turn();
    h.memory.store.suppressFork(1, "2026-09-08T00:00:00.000Z");
    h.memory.store.linkForkSuppression(1, 1);
    // A reopen and a settings refresh both go through restore(); neither may clear the suppression.
    await h.emit("session_start");
    expect(h.memory.store.forkSuppression(1)).toEqual({ at: "2026-09-08T00:00:00.000Z", runId: 1 });
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Fork suppressed since 2026-09-08T00:00:00.000Z (R1)");
    const runs = h.memory.store.listRuns(1).length;
    h.ctx.hasUI = true;
    h.answers.push("Retry fork");
    await command(h, "");
    expect(h.dialogs.at(-1)!.options).toEqual(["Turn off", "Catch up", "Stop", "Project…", "Runs…", "Settings…", "Retry fork"]); // Retry fork only while downgraded
    expect(h.memory.store.forkSuppression(1)).toBeNull();
    expect(h.notices.at(-1)).toContain("fork retry enabled for this session");
    expect(h.memory.store.listRuns(1)).toHaveLength(runs); // the reset launches no extraction
    expect(h.conversations).toEqual([]);
    // Gone from the menu once used, and a later eligible miss may start a new episode and warn again.
    h.answers.push(undefined);
    await command(h, "");
    expect(h.dialogs.at(-1)!.options).toEqual(["Turn off", "Catch up", "Stop", "Project…", "Runs…", "Settings…"]);
    expect(h.memory.store.suppressFork(1)).toBe(true);
    // No dedicated reset subcommand was registered: the word is only in the menu, and an unknown
    // command form prints the usage (24b) instead of acting.
    await command(h, "retry fork");
    expect(h.notices.at(-1)).toContain("is not a command form");
    expect(h.memory.store.forkSuppression(1)).not.toBeNull();
    expect([...h.commands.keys()]).toEqual(["trace"]);
  } finally { await h.dispose(); }
});

// 29d retired the fork-only delivery pause this case was built around, so the "although" clause has
// no subject. The downgrade itself -- a latched session admits its next task as a subagent, keeping
// the requested mode for the audit -- is unchanged and is what this case still pins.
test("review 2026-09-08: a downgraded session's next task is admitted as a subagent, with the requested fork kept for the audit", async () => {
  const f = await fixture();
  try {
    // R1 writes a fact; its two responses read 0% and 25% of their input: two misses, the latch sets.
    f.script(body => !worker(body) ? say("好的。") : toolResults(body) ? say("Done.", usage(40000, 2, 10000)) : call("n", "note", noteBatch, usage(40000, 2, 0)));
    await f.turn();
    await settled(f);
    expect(f.h.memory.store.forkSuppression(1)).toBeTruthy();
    // New entries make the backlog due again, and the subagent the latch selected runs it.
    // 30: one entry view is capped at `render.entryTokens` (2,000), so it takes more entries to make
    // the backlog due again at the ordinary 10,000-token trigger.
    for (const label of ["A", "B", "C", "D", "E", "F"]) f.manager().appendMessage(reply(`new source ${label} ` + "word ".repeat(6000)) as never);
    await f.h.emit("agent_end"); await f.h.drain();
    const target = { sessionId: 1, branch: "main", headTurnId: 1 };
    expect(f.h.memory.taskEligibility("noting", target).due).toBe(true); // 29d: due is the whole answer; no mode pauses it
    const second = await vi.waitFor(() => { const runs = notingRuns(f.h); expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); return runs[1]!; }, { timeout: 5000 });
    expect(second.mode).toBe("subagent");
    expect(JSON.parse(second.response!).requestedMode).toBe("fork"); // requested fork is kept for the audit
    expect(JSON.parse(second.response!).fallbackReason).toContain("cache miss latch");
  } finally { await f.dispose(); }
}, 20000);

test("19c ruling 2026-09-09: a hit between two misses resets the count, so the session is not downgraded", async () => {
  const f = await fixture();
  try {
    // R1: the note round misses, the closing reply reads 100% of its input (a hit); R2 misses once more.
    f.script(body => !worker(body) ? say("好的。", small()) : toolResults(body) ? say("Done.", usage(32000, 5, 32000)) : call("t1", "note", noteBatch, big()));
    await f.turn();
    await settled(f);
    expect(misses(f.h).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2"]);
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
    // R1's fact is delivered at the next prompt and confirmed when it settles; only then may a fork start.
    f.script(body => !worker(body) ? say("好的。", small()) : say("Nothing to note.", big()));
    await f.turn("second " + long); // delivers and confirms; the next completion may fork
    f.manager().appendMessage({ role: "user", content: long, timestamp: 1 } as never);
    f.manager().appendMessage({ ...reply("third answer"), timestamp: 1 } as never);
    await f.h.emit("message_start", { message: reply("") });
    await vi.waitFor(() => { const runs = notingRuns(f.h); expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); }, { timeout: 5000 });
    expect(notingRuns(f.h)[1]!.mode).toBe("fork"); // still forking: the count restarted after the hit
    expect(misses(f.h).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2", "Trace Memory: fork cache miss 1/2"]);
    expect(downgrades(f.h)).toEqual([]);
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await f.dispose(); }
}, 20000);
