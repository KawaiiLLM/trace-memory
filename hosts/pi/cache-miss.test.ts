import { expect, test, vi } from "vitest";
import { host, reply } from "./test-host.ts";
import { cacheMinimum, eligibleCacheMiss, runNative } from "./native.ts";
import { broken, call, fixture, memoryBatch, noteBatch, say, settled, toolResults, usage, worker } from "./native-fixture.ts";
import { recorded } from "../../test/source-fixture.ts";

// 19c cache-miss latch (ticket 19 gate 3 and "Cache-miss fallback"). The deterministic prefix check
// runs first: only a response whose request passed it and still reports an eligible `cacheRead = 0`
// counts. One eligible miss, one warning, session-scoped, reset only through the /trace menu.

const WARNING = "Trace Memory: fork cache miss. Future memory tasks in this session will use subagent.";
const big = () => usage(2000, 5, 0); // 2000 reported input tokens, nothing read from cache
const small = () => usage(10, 2, 0); // below every documented minimum
const long = "word ".repeat(400);
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const notingRuns = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).filter(r => r.kind === "noting");
const warnings = (h: ReturnType<typeof host>) => h.notices.filter(n => n.includes("fork cache miss"));

test("19c 2026-09-08: an eligible zero-cache fork response downgrades the session once and neither replays the task nor relabels its mode", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : toolResults(body) ? say("Done.", big()) : call("t1", "note", noteBatch, big()));
    await f.turn();
    const run = await settled(f);
    // The task that observed the miss finished its own write protocol in its own native session.
    expect(run.mode).toBe("branch"); // never relabelled as subagent execution
    expect(run.outcome).toBe("success");
    expect(f.h.memory.store.listSessionFacts(1).map(fact => fact.text)).toEqual(["用 pnpm，不要 npm"]);
    expect(f.h.memory.store.listRuns(1)).toHaveLength(1); // no replay, and no extra extraction trigger
    const response = JSON.parse(run.response!);
    expect(response.verification.passed).toBe(true); // the prefix check passed first (gate 3)
    expect(response.verification.cacheMiss).toEqual({ model: "fake/test", api: "openai-completions", minimum: 1024, input: 2000, cacheRead: 0, cacheWrite: 0 });
    // One warning, with the ruled text, although two of this run's responses reported a miss.
    expect(warnings(f.h)).toEqual([WARNING]);
    const suppression = f.h.memory.store.forkSuppression(1)!;
    expect(Number.isFinite(Date.parse(suppression.at))).toBe(true);
    expect(suppression.runId).toBe(run.id); // the audit names the run that detected it
    await command(f.h, "status");
    expect(f.h.notices.at(-1)).toContain(`Fork: suppressed since ${suppression.at} (cache miss on R${run.id}); Retry fork in the /trace menu`);
  } finally { await f.dispose(); }
}, 20000);

test("19c 2026-09-08: while the latch is set a requested fork is admitted as a subagent with the cache-miss reason", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : say("Nothing to note.", big()));
    await f.turn();
    await vi.waitFor(() => expect(notingRuns(f.h)).toHaveLength(1), { timeout: 5000 });
    const at = f.h.memory.store.forkSuppression(1)!.at;
    expect(warnings(f.h)).toEqual([WARNING]);
    // A later task of the same session, with the capture and the checkpoint both still valid.
    f.manager().appendMessage({ role: "user", content: long, timestamp: 1 } as never);
    f.manager().appendMessage({ ...reply("second answer"), timestamp: 1 } as never);
    await f.h.emit("message_start", { message: reply("") });
    const second = await vi.waitFor(() => { const runs = notingRuns(f.h); expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); return runs[1]!; }, { timeout: 5000 });
    expect(second.mode).toBe("subagent");
    const response = JSON.parse(second.response!);
    expect(response.requestedMode).toBe("branch"); // the configured mode is retained, not rewritten
    expect(response.fallbackReason).toContain("cache miss latch");
    expect(response.verification).toBeUndefined();
    expect(warnings(f.h)).toEqual([WARNING]); // the same episode never warns twice
    expect(f.h.memory.store.forkSuppression(1)!.at).toBe(at);
    // Global configuration and unrelated sessions are untouched.
    expect(f.h.memory.config.noting.branchModeDefault).toBe(true);
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
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
    expect(warnings(f.h)).toEqual([]);
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
    expect(warnings(f.h)).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    const missed = vi.fn();
    const cancelled = await runNative(f.task(captured, { signal: controller.signal, onCacheMiss: missed }));
    expect(cancelled.outcome).toBe("cancelled");
    expect(missed).not.toHaveBeenCalled();
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await f.dispose(); }
}, 20000);

test("19c 2026-09-08: cache eligibility rejects hits, small, missing, placeholder and unsupported usage, unknown limits and a disabled cache", () => {
  const openai = { api: "openai-completions", id: "test", provider: "fake" };
  const anthropic = { api: "anthropic-messages", id: "claude-sonnet-4", provider: "fake" };
  const haiku = { api: "anthropic-messages", id: "claude-3-5-haiku", provider: "fake" };
  const zero = { input: 2000, cacheRead: 0, cacheWrite: 0 };
  // Eligible: a documented minimum, a reported zero read, and enough actual input.
  expect(eligibleCacheMiss(openai, zero, true)).toEqual({ model: "fake/test", api: "openai-completions", minimum: 1024, input: 2000, cacheRead: 0, cacheWrite: 0 });
  // pi-ai reports `input` without the cached tokens on both families, so the request's real input is
  // input + cacheRead + cacheWrite: an Anthropic first write of 3000 tokens is over the minimum.
  expect(eligibleCacheMiss(anthropic, { input: 24, cacheRead: 0, cacheWrite: 3000 }, true)?.input).toBe(3024);
  // Not eligible, one reason each.
  expect(eligibleCacheMiss(openai, { input: 5000, cacheRead: 4000, cacheWrite: 0 }, true)).toBeUndefined(); // a hit, at any ratio
  expect(eligibleCacheMiss(openai, { input: 1, cacheRead: 1023, cacheWrite: 0 }, true)).toBeUndefined();
  expect(eligibleCacheMiss(openai, { input: 1000, cacheRead: 0, cacheWrite: 0 }, true)).toBeUndefined(); // below the minimum
  expect(eligibleCacheMiss(openai, undefined, true)).toBeUndefined(); // missing usage
  expect(eligibleCacheMiss(openai, { input: 0, cacheRead: 0, cacheWrite: 0 }, true)).toBeUndefined(); // placeholder zeros
  expect(eligibleCacheMiss(openai, { input: 2000 }, true)).toBeUndefined(); // no cache reporting at all
  expect(eligibleCacheMiss(openai, zero, false)).toBeUndefined(); // the request asked for no caching
  expect(eligibleCacheMiss({ api: "google-generative-ai", id: "gemini", provider: "g" }, zero, true)).toBeUndefined(); // unknown minimum
  expect(eligibleCacheMiss(haiku, zero, true)).toBeUndefined(); // 2000 < the Haiku family's 2048
  expect(eligibleCacheMiss(haiku, { input: 2048, cacheRead: 0, cacheWrite: 0 }, true)?.minimum).toBe(2048);
  // No universal fallback minimum is invented for an unlisted provider.
  expect(cacheMinimum("openai-responses", "gpt-5")).toBe(1024);
  expect(cacheMinimum("google-generative-ai", "gemini")).toBeUndefined();
});

test("19c 2026-09-08: two phases reporting a miss together produce one transition and one warning", async () => {
  const f = await fixture({ "consolidation.triggerUnconsolidatedFacts": 1, "consolidation.subagentModeDefault": false });
  try {
    // The first turn's own Noting task must not latch the session before the two-phase opportunity
    // below, so its response reports a below-minimum input; only the two frozen fork tasks of that
    // opportunity report an eligible zero-cache response.
    let notings = 0;
    f.script(body => !worker(body) && !worker(body, "Consolidation") ? say("好的。", small())
      : worker(body, "Consolidation") ? (toolResults(body) >= 2 ? say("Integrated.", big()) : call(`t${toolResults(body)}`, "memory", memoryBatch, big()))
      : say("Nothing to note.", ++notings === 1 ? small() : big()));
    await f.turn();
    f.h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })
      .find(t => t.name === "note")!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] });
    recorded(f.h.memory, 1, "main", 1);
    const before = new Set(f.h.memory.store.listRuns(1).map(r => r.id)); // the manual note and its receipt
    await f.turn("tick " + long); // one opportunity, both phases due, both requesting fork
    await vi.waitFor(() => {
      expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response)).not.toHaveLength(0);
      expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "consolidation" && r.response)).not.toHaveLength(0);
    }, { timeout: 8000 });
    const both = f.h.memory.store.listRuns(1).filter(r => !before.has(r.id)); // this opportunity's two runs
    expect(both.map(r => r.kind).sort()).toEqual(["consolidation", "noting"]);
    expect(both.map(r => r.mode)).toEqual(["branch", "branch"]); // both kept their frozen fork tasks
    // Both really forked and both really reported a zero-cache response of their own.
    expect(both.map(r => JSON.parse(r.response!).verification.passed)).toEqual([true, true]);
    expect(both.filter(r => JSON.parse(r.response!).verification.cacheMiss)).toHaveLength(2);
    expect(warnings(f.h)).toEqual([WARNING]); // one transition, one warning
    const suppression = f.h.memory.store.forkSuppression(1)!;
    expect(both.map(r => r.id)).toContain(suppression.runId); // whichever won the transition names itself
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
    await command(h, "status");
    expect(h.notices.at(-1)).toContain("Fork: suppressed since 2026-09-08T00:00:00.000Z (cache miss on R1); Retry fork in the /trace menu");
    const runs = h.memory.store.listRuns(1).length;
    h.ctx.hasUI = true;
    h.answers.push("Current session", "Retry fork");
    await command(h, "");
    expect(h.dialogs.at(-1)!.options).toEqual(["Disable", "Retry fork"]); // only while downgraded
    expect(h.memory.store.forkSuppression(1)).toBeNull();
    expect(h.notices.at(-1)).toContain("fork retry enabled for this session");
    expect(h.memory.store.listRuns(1)).toHaveLength(runs); // the reset launches no extraction
    expect(h.conversations).toEqual([]);
    // Gone from the menu once used, and a later eligible miss may start a new episode and warn again.
    h.answers.push("Current session", undefined);
    await command(h, "");
    expect(h.dialogs.at(-1)!.options).toEqual(["Disable"]);
    expect(h.memory.store.suppressFork(1)).toBe(true);
    // No dedicated reset subcommand was registered: the word is only in the menu.
    await command(h, "retry fork");
    expect(h.notices.at(-1)).toContain("Fork: suppressed since");
    expect([...h.commands.keys()]).toEqual(["trace"]);
  } finally { await h.dispose(); }
});
