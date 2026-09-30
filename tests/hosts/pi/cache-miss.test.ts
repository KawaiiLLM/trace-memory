import { expect, test, vi } from "vitest";
import { runNative } from "../../../src/hosts/pi/native.ts";
import { reply } from "./test-host.ts";
// Cache observations require an explicitly requested fork, not the product's subagent default.
import { broken, call, noteAndMemory, stableForkFixture as fixture, noteBatch, say, settled, toolResults, usage, worker } from "./native-fixture.ts";

// Ticket 108 (superseding 19c's cache-miss latch and the 2026-09-09 two-consecutive-miss downgrade):
// the deterministic prefix check runs first; a response whose request passed it is a miss when its
// cacheRead is below half of its input; every miss is audited and warned once, with the input tokens the
// cache served; nothing else follows from it.

const big = () => usage(32000, 5, 0); // 32,000 input tokens, nothing read from cache: a miss
const small = () => usage(10, 2, 0); // below every documented minimum
const long = "word ".repeat(400);
const notingRuns = (h: { memory: { store: { listRuns(id: number): { kind: string; mode: string | null; response: string | null }[] } } }) => h.memory.store.listRuns(1).filter(r => r.kind === "noting");
const misses = (h: { notices: string[] }) => h.notices.filter(n => /fork cache miss \(/.test(n));
const WARNING = "Trace Memory: fork cache miss (0 of 32000 input tokens read from cache).";

test("ticket 108: a miss is audited in its run and warned once; the task keeps its mode and nothing is downgraded", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : toolResults(body) ? say("Done.", big()) : noteAndMemory("t1", noteBatch, big()));
    await f.turn();
    const run = await settled(f);
    expect(run.mode).toBe("fork"); // never relabelled as subagent execution
    expect(run.outcome).toBe("success");
    const response = JSON.parse(run.response!);
    expect(response.verification.passed).toBe(true); // the prefix check passed first
    expect(response.verification.cacheMiss).toEqual({ model: "fake/test", api: "openai-completions", minimum: 1024, ratio: 0.5, input: 32000, cacheRead: 0, cacheWrite: 0, total: 32000, miss: true });
    expect(misses(f.h)).toEqual([WARNING, WARNING]); // one per missed response: the note round and the closing reply
    expect(f.h.notices.some(n => /downgrad|suppress|cache miss \d\/2/i.test(n))).toBe(false);
  } finally { await f.dispose(); }
}, 20000);

test("ticket 108: repeated misses never downgrade the session: the next task still forks and warns again", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : toolResults(body) ? say("Done.", small()) : call("t1", "note", noteBatch, big()));
    await f.turn();
    await settled(f);
    expect(misses(f.h)).toEqual([WARNING]);
    f.script(body => !worker(body) ? say("好的。", small()) : say("Nothing to note.", big()));
    await f.turn("second " + long); // delivers and confirms; the next completion may fork
    f.manager().appendMessage({ role: "user", content: long, timestamp: 1 } as never);
    f.manager().appendMessage({ ...reply("third answer"), timestamp: 1 } as never);
    await f.h.emit("message_start", { message: reply("") });
    await vi.waitFor(() => { const runs = notingRuns(f.h); expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); }, { timeout: 5000 });
    expect(notingRuns(f.h)[1]!.mode).toBe("fork"); // two consecutive misses, still forking
    expect(JSON.parse(notingRuns(f.h)[1]!.response!).fallbackReason).toBeUndefined();
    expect(misses(f.h)).toEqual([WARNING, WARNING]);
  } finally { await f.dispose(); }
}, 20000);

test("ticket 108: a request that failed the prefix check is no fork response and warns nothing", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : say("Nothing to note.", big()));
    await f.h.emit("before_agent_start", { prompt: "用 pnpm，不要 npm" });
    await f.parent.prompt("用 pnpm，不要 npm");
    // A capture the child cannot reproduce: one message the parent's own file does not contain. The
    // gate rejects the child's first body before it leaves the process, so this task runs fresh.
    const doctored = { ...f.sent[0]!, messages: [...f.sent[0]!.messages, { role: "user", content: "ghost" }] };
    await f.h.emit("before_provider_request", { payload: doctored });
    await f.h.emit("agent_settled");
    const run = await settled(f);
    expect(run.mode).toBe("subagent");
    expect(JSON.parse(run.response!).fallbackReason).toContain("native prefix mismatch");
    expect(misses(f.h)).toEqual([]);
  } finally { await f.dispose(); }
}, 20000);

test("ticket 108: a provider error warns nothing, and a cancelled child reports no miss", async () => {
  const f = await fixture();
  try {
    f.script(body => !worker(body) ? say("好的。", small()) : broken());
    const captured = await f.turn();
    const run = await settled(f);
    expect(run.outcome).toBe("failure");
    expect(misses(f.h)).toEqual([]); // placeholder zeros are unknown, not a miss
    const controller = new AbortController();
    controller.abort();
    const missed = vi.fn();
    const cancelled = await runNative(f.task(captured, { signal: controller.signal, onCache: missed }));
    expect(cancelled.outcome).toBe("cancelled");
    expect(missed).not.toHaveBeenCalled();
  } finally { await f.dispose(); }
}, 20000);
