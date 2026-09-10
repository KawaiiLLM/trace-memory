// Ticket 19 "Eligible miss", amended 2026-09-09: the consecutive-miss count lives in the executor
// process, and "a reopen starts at zero; the persisted latch itself is unchanged". These cases pin
// both halves of that boundary — a reopen of the memory session clears the count and nothing else,
// and ordinary tree navigation inside the same session is not a reopen.
import { expect, test, vi } from "vitest";
// These reopen regressions explicitly select fork execution to produce cache misses.
import { call, forkFixture as fixture, say, settled, toolResults, usage, worker } from "./native-fixture.ts";

const big = () => usage(32000, 5, 0); // 32,000 input tokens, nothing read from cache: an eligible miss
const small = () => usage(10, 2, 0); // below every documented minimum: neither a miss nor a hit
const long = "another question " + "word ".repeat(400);
type Fixture = Awaited<ReturnType<typeof fixture>>;
const misses = (f: Fixture) => f.h.notices.filter(n => /fork cache miss \d\/2 /.test(n));
const downgrades = (f: Fixture) => f.h.notices.filter(n => n.includes("downgraded"));
/** Every fork task of the run reports exactly one eligible miss: the reply that carries the tool
 * call pays for 32,000 uncached tokens, and the batch is empty so no case here depends on a write. */
const oneMiss = (f: Fixture) => f.script(body => !worker(body) ? say("好的。", small())
  : toolResults(body) ? say("Done.", small()) : call("t1", "note", { facts: [] }, big()));
const noted = (f: Fixture, count: number) => vi.waitFor(
  () => expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.response)).toHaveLength(count), { timeout: 5000 });

test("19 amendment: reopening the session starts the miss count at zero without clearing the latch", async () => {
  const f = await fixture();
  try {
    oneMiss(f);
    await f.turn();
    await settled(f);
    expect(misses(f).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2"]);
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
    // The reopen boundary: restore() reopens this memory session.
    await f.h.emit("session_start");
    await f.turn(long);
    await noted(f, 2);
    // The second run's own first miss, counted from zero again: no downgrade, no suppression.
    expect(misses(f).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2", "Trace Memory: fork cache miss 1/2"]);
    expect(downgrades(f)).toEqual([]);
    expect(f.h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await f.dispose(); }
}, 20000);

test("19 amendment: a tree switch inside the same session is not a reopen and keeps the count", async () => {
  const f = await fixture();
  try {
    oneMiss(f);
    await f.turn();
    await settled(f);
    expect(misses(f).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2"]);
    // Ordinary tree navigation: position changes, the memory session does not reopen.
    await f.h.emit("session_tree");
    await f.turn(long);
    await noted(f, 2);
    // The two misses are still consecutive, so the second one downgrades the session once.
    expect(misses(f).map(n => n.slice(0, 33))).toEqual(["Trace Memory: fork cache miss 1/2", "Trace Memory: fork cache miss 2/2"]);
    expect(downgrades(f)).toHaveLength(1);
    expect(f.h.memory.store.forkSuppression(1)).not.toBeNull();
  } finally { await f.dispose(); }
}, 20000);
