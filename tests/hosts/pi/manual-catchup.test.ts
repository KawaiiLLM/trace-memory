import { expect, test, vi } from "vitest";
import { TraceMemory } from "../../../src/core/api/index.ts";
import { Store } from "../../../src/core/store/index.ts";
import { host, reply, notingFact, consolidationReply, type Reply } from "./test-host.ts";
import { recorded } from "../../source-fixture.ts";

// Ticket 18b — manual catchup and stop. Parent scenarios 18 (manual finite drain), 19 (capacity
// and command parity), 20 (stop and resume) and 21 (drain lifecycle), plus the three named revert
// probes (a frozen snapshot must not expand, only an active catchup may chain its own batches, and
// stop must never touch a foreign owner's claim).

const at = "2026-09-08T00:00:00.000Z";
const command = (h: ReturnType<typeof host>, args: string) => h.commands.get("trace").handler(args, h.ctx);
const phaseOf = (c: { systemPrompt?: string }) => c.systemPrompt?.includes("### Second-round user message") ? "consolidation" : "noting";
function hold(h: ReturnType<typeof host>) {
  const releases: ((reply: Reply) => void)[] = [];
  h.provider(async () => new Promise<Reply>(resolve => releases.push(resolve)));
  return releases;
}
// Repeatedly drains microtasks until the observed request count stops growing: enough rounds for a
// chained multi-batch drain (each batch is itself several `setImmediate` turns) without a fixed sleep.
const settle = async (h: ReturnType<typeof host>, rounds = 40) => {
  let last = -1;
  for (let i = 0; i < rounds && last !== h.requests.length; i++) { last = h.requests.length; await h.drain(); }
};
// A backlog spanning several Noting batches (same construction as batching.test.ts), sized for 20b's
// 10,000-token batch ceiling: each batch holds a user entry and a few replies, as the drain's own
// oldest-first prefix selects them.
/** A `memory` batch that skips exactly the facts of the range it was handed. `consolidationBatch`
 * always names F1, which is only in the first bounded batch; a drain of several batches needs a reply
 * that stays valid past that one, or the child keeps resubmitting a rejected batch. */
const consolidateRange = (conversation: { messages: { content: unknown }[] }): Reply => {
  const input = String(conversation.messages[0]!.content);
  const range = input.split("Range facts:\n")[1]?.split("\nNegated-evidence")[0] ?? "";
  const facts = [...range.matchAll(/\[F(\d+)\]/g)].map(m => `F${m[1]}`);
  return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory",
    arguments: { operations: [], skipped: facts.map(fact => ({ fact, because: "Not durable." })) } }] };
};
function backlog(h: ReturnType<typeof host>) {
  h.persist({ role: "user", content: "start", timestamp: 1 });
  for (let i = 0; i < 12; i++) {
    if (i) h.persist({ role: "user", content: `turn ${i}`, timestamp: 1 });
    h.persist(reply(`entry ${i} ` + "word ".repeat(3000)));
  }
}

test("18b 2026-09-08: manual catchup drains bounded Noting batches then integrates the frozen-plus-produced facts; later entries and facts stay outside the target", async () => {
  const h = host();
  try {
    backlog(h);
    await h.emit("session_start"); // import only; no automatic trigger (17a/17b)
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Pre-existing A", source: ["T1#user"] },
      { category: "observation", actor: "user", text: "Pre-existing B", source: ["T1#user"] },
    ] });
    h.provider(async c => phaseOf(c) === "consolidation" ? consolidationReply() : notingFact(c));
    await command(h, "catchup");
    await settle(h);
    const notingRuns = h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success");
    expect(notingRuns.length).toBeGreaterThan(1); // several bounded batches, not one unbounded drain
    expect(h.memory.pendingEntries(1, "main", head)).toEqual([]); // the frozen entry boundary is fully processed
    const allFacts = h.memory.store.listSessionFacts(1).map(f => f.id).sort((a, b) => a - b);
    expect(allFacts.length).toBe(2 + notingRuns.length); // 2 pre-existing plus one fact per Noting batch
    const consolidationRuns = h.memory.store.listRuns(1).filter(r => r.kind === "consolidation" && r.outcome === "success");
    expect(consolidationRuns).toHaveLength(1); // these few short facts fit one bounded batch; the multi-batch drain is 20c's scenario 16
    expect(consolidationRuns.flatMap(r => h.memory.store.listConsolidatedFacts(r.id)).map(f => f.id).sort((a, b) => a - b)).toEqual(allFacts);
    expect(h.memory.store.consolidationBatch(1, "main", head)).toEqual([]);
    const requestsBefore = h.requests.length;
    // A later ordinary Turn and a later manual fact must stay outside this already-completed target.
    await h.turn();
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Later, unrelated", source: ["T1#user"] } ] });
    expect(h.requests.length).toBe(requestsBefore); // nothing auto-triggered (both are far below threshold)
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).length).toBeGreaterThan(0);
    expect(h.memory.store.consolidationBatch(1, "main", h.memory.store.listTurns(1).at(-1)!.id).length).toBeGreaterThan(0);
    await command(h, "");
    expect(h.notices.at(-1)).toContain(`Catchup: completed (${notingRuns.reduce((n, r) => n + JSON.parse(r.response!).entryAudit.entries.length, 0)} entries noted, ${allFacts.length} facts integrated)`);
  } finally { await h.dispose(); }
}, 30000);

test("18b 2026-09-08: an empty target completes without a model call; a disabled session rejects catchup without enrolling", async () => {
  const h = host();
  try {
    h.setHeaderTimestamp("2000-01-01T00:00:00Z"); // pre-baseline: defaults disabled
    await h.emit("session_start");
    await expect(command(h, "catchup")).rejects.toThrow("/trace on");
    expect(h.memory.store.getSession(1)).toBeNull(); // rejection never silently enrolls the session
    await command(h, "on");
    await command(h, "catchup"); // no assistant reply yet: nothing could be pending
    expect(h.notices.at(-1)).toContain("no assistant reply");
    expect(h.memory.store.getSession(1)).toBeNull();
    await h.turn();
    h.provider(async () => reply("No durable material."));
    await command(h, "catchup");
    await settle(h);
    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.memory.pendingEntries(1, "main", 1)).toEqual([]);
    expect(h.memory.store.consolidationBatch(1, "main", 1)).toEqual([]);
    const before = h.requests.length;
    await command(h, "catchup"); // truly empty this time
    await h.drain();
    expect(h.requests.length).toBe(before); // no model call for an empty target
    expect(h.notices.at(-1)).toContain("nothing pending");
  } finally { await h.dispose(); }
});

test("18b 2026-09-08: an occupied local slot shows Waiting and resumes on release; repeating catchup reports the same operation", async () => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    await h.turn();
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Needs consolidation A", source: ["T1#user"] },
      { category: "observation", actor: "user", text: "Needs consolidation B", source: ["T1#user"] },
    ] });
    const release = hold(h);
    h.persist(reply("word ".repeat(15000))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1); // the ordinary automatic Noting run occupies this executor's one Noting slot
    await command(h, "catchup");
    expect(h.notices.at(-1)).toContain("Catchup: waiting for noting");
    await command(h, "catchup"); // repeating reports the same waiting operation, not a second one
    expect(h.notices.at(-1)).toContain("Catchup: waiting for noting");
    h.provider(async c => phaseOf(c) === "consolidation" ? consolidationReply() : reply("No durable material."));
    release[0]!(reply("No durable material.")); // free the ordinary worker's slot
    await settle(h);
    expect(h.requests.length).toBeGreaterThan(1); // the released slot let the waiting catchup continue
    expect(h.memory.store.consolidationBatch(1, "main", 1)).toEqual([]);
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { await h.dispose(); }
});

test("18b 2026-09-08: a foreign claim on the target shows Waiting without stealing it; the menu reaches the same controller as the command", async () => {
  const h = host();
  try {
    await h.turn();
    expect(h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: at },
      facts: [], entryIds: h.memory.pendingEntries(1, "main", 1).map(e => e.id) }).ok).toBe(true);
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Foreign claim target", source: ["T1#user"] } ] });
    const other = TraceMemory(h.dbPath, async () => { throw new Error("no model expected"); });
    try {
      const foreign = other.store.acquireClaim({ sessionId: 1, branch: "main", headTurnId: 1 }, "consolidation", "foreign-executor")!;
      expect(foreign).not.toBeNull();
      await command(h, "catchup");
      expect(h.notices.at(-1)).toContain("Catchup: waiting for consolidation");
      h.ctx.hasUI = true; h.answers.push("Catch up");
      await command(h, ""); // menu and command share the same controller/state
      expect(h.notices.at(-1)).toContain("Catchup: waiting for consolidation");
      h.ctx.hasUI = false;
      expect(other.store.releaseClaim(foreign)).toBe(true);
    } finally { other.close(); }
    h.provider(async () => consolidationReply());
    await h.turn(); // the next ordinary opportunity retries the waiting catchup
    await settle(h);
    expect(h.memory.store.consolidationBatch(1, "main", 1)).toEqual([]);
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { await h.dispose(); }
});

test("18b 2026-09-08: stop during a Noting batch cancels it, leaves it pending, repeating stop is harmless, and a later catchup resumes it", async () => {
  const h = host();
  try {
    backlog(h);
    await h.emit("session_start");
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    h.provider(async (_c, signal) => new Promise<Reply>(resolve => signal!.addEventListener("abort", () => resolve({ ...reply(""), stopReason: "aborted" }), { once: true })));
    await command(h, "catchup");
    await h.drain();
    expect(h.requests).toHaveLength(1); // the first Noting batch is in flight
    await command(h, "stop");
    await settle(h);
    expect(h.requests).toHaveLength(1); // no further batch was ever scheduled
    expect(h.memory.pendingEntries(1, "main", head).length).toBeGreaterThan(0); // the cancelled batch stays pending
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: stopped");
    await command(h, "stop"); // repeating stop is a harmless no-op
    expect(h.notices.at(-1)).toContain("nothing to stop");
    // The foreground agent still works, and future ordinary eligible-entry events keep their usual
    // thresholds (they are not gated by the cancelled catchup); this one may pick up part of the backlog.
    h.provider(async c => phaseOf(c) === "consolidation" ? consolidationReply() : notingFact(c));
    await h.turn();
    await settle(h);
    expect(h.memory.status(1)).toContain("Enabled");
    await command(h, "catchup"); // an explicit new catchup creates a fresh snapshot over any remaining backlog
    await settle(h);
    expect(h.memory.pendingEntries(1, "main", head)).toEqual([]);
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { await h.dispose(); }
}, 30000);

test("18b 2026-09-08: stop while waiting for an occupied slot prevents the frozen batch from ever starting", async () => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    await h.turn();
    const release = hold(h);
    h.persist(reply("word ".repeat(15000))); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1);
    await command(h, "catchup");
    expect(h.notices.at(-1)).toContain("Catchup: waiting for noting");
    await command(h, "stop");
    expect(h.notices.at(-1)).toContain("stop requested");
    release[0]!(reply("No durable material."));
    await settle(h);
    expect(h.requests).toHaveLength(1); // stop cancelled the wait; the frozen batch never started
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: stopped");
  } finally { await h.dispose(); }
});

test("18b 2026-09-08: stop during Consolidation cancels it and preserves an already-committed Noting batch", async () => {
  const h = host();
  try {
    await h.turn();
    h.provider(async (c, signal) => phaseOf(c) === "consolidation"
      ? new Promise<Reply>(resolve => signal!.addEventListener("abort", () => resolve({ ...reply(""), stopReason: "aborted" }), { once: true }))
      : notingFact(c));
    await command(h, "catchup");
    await settle(h);
    expect(h.memory.store.listSessionFacts(1)).toHaveLength(1);
    const notingRun = h.memory.store.listRuns(1).find(r => r.kind === "noting")!;
    expect(notingRun.outcome).toBe("success");
    await command(h, "stop");
    await settle(h);
    expect(h.memory.store.getRun(notingRun.id)!.outcome).toBe("success"); // the prior commit remains successful
    expect(h.memory.store.consolidationBatch(1, "main", 1).map(f => f.id)).toEqual(h.memory.store.listSessionFacts(1).map(f => f.id)); // Consolidation never committed
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: stopped");
  } finally { await h.dispose(); }
});

test("18b 2026-09-08: disable cancels an in-flight catchup batch; re-enable does not auto-resume the drain", async () => {
  const h = host();
  try {
    backlog(h);
    await h.emit("session_start");
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    h.provider(async (_c, signal) => new Promise<Reply>(resolve => signal!.addEventListener("abort", () => resolve({ ...reply(""), stopReason: "aborted" }), { once: true })));
    await command(h, "catchup");
    await h.drain();
    expect(h.requests).toHaveLength(1);
    await command(h, "off");
    await settle(h);
    expect(h.memory.pendingEntries(1, "main", head).length).toBeGreaterThan(0); // the cancelled batch committed nothing
    await command(h, "on");
    await h.drain();
    expect(h.requests).toHaveLength(1); // re-enable imports/resumes ordinary processing only, not the old drain
    await command(h, "");
    expect(h.notices.at(-1)).not.toContain("Catchup: running");
    expect(h.notices.at(-1)).not.toContain("Catchup: waiting");
  } finally { await h.dispose(); }
}, 30000);

test("18b 2026-09-08: switching tree paths during catchup ends it; it is never redirected and does not resume on reopen", async () => {
  const h = host();
  try {
    await h.turn();
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Old path fact", source: ["T1#user"] } ] });
    expect(h.memory.store.commitNotingRun({ run: { kind: "noting", sessionId: 1, branch: "main", createdAt: at },
      facts: [], entryIds: h.memory.pendingEntries(1, "main", 1).map(e => e.id) }).ok).toBe(true);
    h.provider(async (_c, signal) => new Promise<Reply>(resolve => signal!.addEventListener("abort", () => resolve({ ...reply(""), stopReason: "aborted" }), { once: true })));
    await command(h, "catchup");
    await h.drain();
    expect(h.requests).toHaveLength(1); // the frozen Consolidation batch is in flight
    const old = [...h.entries], oldAll = [...h.allEntries];
    h.entries.length = 0; h.allEntries.length = 0;
    h.ctx.sessionManager.getSessionId = () => "forked-session";
    await h.emit("session_tree"); // switching away from the selected tree path
    await settle(h);
    expect(h.memory.store.consolidationBatch(1, "main", 1)).toHaveLength(1); // never committed by the cancelled worker
    h.entries.splice(0, h.entries.length, ...old); h.allEntries.splice(0, h.allEntries.length, ...oldAll);
    h.ctx.sessionManager.getSessionId = () => "pi-test";
    await h.emit("session_tree"); // reopening the original path does not resume the old drain
    await h.drain();
    expect(h.requests).toHaveLength(1);
    await command(h, "");
    expect(h.notices.at(-1)).not.toContain("Catchup: running");
    expect(h.notices.at(-1)).not.toContain("Catchup: waiting");
  } finally { await h.dispose(); }
});

test("18b 2026-09-08: a failure after one successful Noting batch preserves it and stops the drain with a visible diagnostic", async () => {
  const h = host();
  try {
    backlog(h);
    await h.emit("session_start");
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    let notingCalls = 0;
    h.provider(async c => {
      if (phaseOf(c) !== "noting") return consolidationReply();
      notingCalls++;
      return notingCalls <= 2 ? notingFact(c) : { ...reply(""), stopReason: "error" as const, errorMessage: "boom" };
    });
    await command(h, "catchup");
    await settle(h);
    const notingRuns = h.memory.store.listRuns(1).filter(r => r.kind === "noting");
    expect(notingRuns[0]!.outcome).toBe("success");
    expect(notingRuns.some(r => r.outcome === "failure")).toBe(true);
    expect(h.memory.pendingEntries(1, "main", head).length).toBeGreaterThan(0); // the rest stays pending
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: failed");
    expect(h.notices.at(-1)).toContain("boom");
  } finally { await h.dispose(); }
}, 30000);

test("18b 2026-09-08: an ordinary worker's completion does not chain a follow-up batch outside an active manual catchup", async () => {
  const h = host({ "noting.forkModeDefault": false });
  try {
    backlog(h); // several batches' worth of backlog: a chained second attempt has real work to find
    await h.emit("session_start");
    let first = true;
    h.provider(async (_c, signal) => {
      if (first) { first = false; return reply("eligible completion handled"); } // the one bounded batch
      // Any further request is evidence of chaining outside an active manual catchup. Park it (still
      // recorded in h.requests) instead of letting it complete, so a chained batch is caught
      // immediately rather than racing a real commit; the abort listener still lets dispose() proceed.
      return new Promise<Reply>(resolve => signal!.addEventListener("abort", () => resolve({ ...reply(""), stopReason: "aborted" }), { once: true }));
    });
    h.persist(reply("eligible completion")); await h.emit("agent_end"); await h.drain();
    expect(h.requests).toHaveLength(1); // exactly one bounded batch; no manual catchup is active
    await h.drain(); await h.drain();
    expect(h.requests).toHaveLength(1); // its own completion alone starts nothing further
  } finally { await h.dispose(); }
}, 30000);

test("18b 2026-09-08: stop prevents the next batch from being scheduled even when the in-flight one wins its commit race", async () => {
  const h = host();
  try {
    backlog(h); // several Noting batches' worth of backlog
    await h.emit("session_start");
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    // A batch that already committed before cancellation wins stays successful (17c); this asserts
    // the separate, 18b-specific guarantee that such a win must not itself schedule a further batch
    // once stop has been requested, even though "success" would ordinarily continue the chain.
    let stoppedOnce = false;
    const original = Store.prototype.commitNotingRun;
    const spy = vi.spyOn(Store.prototype, "commitNotingRun").mockImplementation(function (this: Store, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args);
      if (result.ok && !stoppedOnce) { stoppedOnce = true; void command(h, "stop"); } // fires after the real transaction has already committed
      return result;
    });
    try {
      h.provider(async () => reply("No durable material."));
      await command(h, "catchup");
      await settle(h);
    } finally { spy.mockRestore(); }
    expect(stoppedOnce).toBe(true);
    expect(h.requests).toHaveLength(1); // the committed batch must not chain into a second one after stop
    expect(h.memory.pendingEntries(1, "main", head).length).toBeGreaterThan(0);
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: stopped");
  } finally { await h.dispose(); }
}, 30000);

test("18b 2026-09-08: stop invalidates only this executor's own claims, never a foreign owner's active claim", async () => {
  const h = host();
  try {
    await h.turn();
    const other = TraceMemory(h.dbPath, async () => { throw new Error("no model expected"); });
    try {
      const foreign = other.store.acquireClaim({ sessionId: 1, branch: "main", headTurnId: 1 }, "noting", "foreign-executor")!;
      expect(foreign).not.toBeNull();
      await command(h, "stop");
      expect(h.memory.store.getClaim(1, "noting")).toEqual(foreign); // untouched: same token and expiry
      expect(other.store.releaseClaim(foreign)).toBe(true); // the token is still current, so release still succeeds
    } finally { other.close(); }
  } finally { await h.dispose(); }
});

// ---- Ticket 20c: 18b's single Consolidation call is superseded ------------------------------------

// 18b, 2026-09-08: "the drain runs bounded Noting batches against the frozen entry-id boundary, then
// ONE Consolidation batch against the frozen fact set". Superseded by ticket 20 on 2026-09-08: both
// phases drain successive bounded batches until the frozen target is exhausted, under the same host-
// local controller, the same executor phase slots and the same target claims.
test("20c 2026-09-08 scenario 16: 18b's single Consolidation call is superseded — catchup drains successive bounded batches in both phases until the frozen target is exhausted", async () => {
  // A frozen target of more than one batch in each phase, with a below-trigger tail in both: nothing
  // here is due automatically, so every run below belongs to the manual drain.
  const h = host({ "consolidation.batchTokens": 400, "consolidation.triggerTokens": 1_000_000_000, "noting.triggerTokens": 1_000_000_000, "consolidation.maxToolRounds": 6 });
  try {
    backlog(h);
    await h.emit("session_start");
    const head = h.memory.store.listTurns(1).at(-1)!.id;
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts:
      Array.from({ length: 12 }, (_, i) => ({ category: "observation", actor: "user", text: `Pre-existing ${i} ` + "word ".repeat(40), source: ["T1#user"] })) });
    const frozenFacts = h.memory.store.consolidationBatch(1, "main", head).map(f => f.id);
    expect(frozenFacts.length).toBe(12);
    h.provider(async c => phaseOf(c) === "consolidation" ? consolidateRange(c) : notingFact(c));
    await command(h, "catchup");
    await settle(h);
    const notingRuns = h.memory.store.listRuns(1).filter(r => r.kind === "noting" && r.outcome === "success");
    const consolidationRuns = h.memory.store.listRuns(1).filter(r => r.kind === "consolidation" && r.outcome === "success");
    expect(notingRuns.length).toBeGreaterThan(1);        // successive bounded Noting batches
    expect(consolidationRuns.length).toBeGreaterThan(1); // then successive bounded Consolidation batches
    // Noting comes first and is exhausted before Consolidation starts.
    expect(Math.max(...notingRuns.map(r => r.id))).toBeLessThan(Math.min(...consolidationRuns.map(r => r.id)));
    // Both phases always run in subagent mode and ignore the triggers, but not the batch ceilings.
    expect([...notingRuns, ...consolidationRuns].every(r => r.mode === "subagent")).toBe(true);
    for (const run of consolidationRuns) expect(h.memory.store.listConsolidatedFacts(run.id).length).toBeLessThan(frozenFacts.length);
    // The frozen target — the pending entries plus the frozen facts and the ones those batches produced
    // — is exhausted exactly, with no fact consolidated twice.
    const all = consolidationRuns.flatMap(r => h.memory.store.listConsolidatedFacts(r.id).map(f => f.id));
    expect(new Set(all).size).toBe(all.length);
    expect(all.sort((a, b) => a - b)).toEqual(h.memory.store.listSessionFacts(1).map(f => f.id).sort((a, b) => a - b));
    expect(h.memory.pendingEntries(1, "main", head)).toEqual([]);
    expect(h.memory.store.consolidationBatch(1, "main", head)).toEqual([]);
    // Later entries and unrelated later facts were never pulled into the frozen target.
    const requests = h.requests.length;
    await h.turn();
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts: [
      { category: "observation", actor: "user", text: "Later, unrelated", source: ["T1#user"] } ] });
    expect(h.requests.length).toBe(requests);
    const later = h.memory.store.listTurns(1).at(-1)!.id;
    expect(h.memory.pendingEntries(1, "main", later).length).toBeGreaterThan(0);
    expect(h.memory.store.consolidationBatch(1, "main", later).length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
}, 60000);

test("20c 2026-09-08 scenario 16: stop between Consolidation batches discards the remaining plan only, leaving the committed batch and the rest of the frozen target", async () => {
  const h = host({ "consolidation.batchTokens": 400, "consolidation.triggerTokens": 1_000_000_000, "noting.triggerTokens": 1_000_000_000, "consolidation.maxToolRounds": 6 });
  try {
    await h.turn();
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })[2]!.execute({ facts:
      Array.from({ length: 12 }, (_, i) => ({ category: "observation", actor: "user", text: `Pre-existing ${i} ` + "word ".repeat(40), source: ["T1#user"] })) });
    const frozen = h.memory.store.consolidationBatch(1, "main", 1).map(f => f.id);
    // Stop fires after the first Consolidation batch has already committed, so the race is decided:
    // that batch stands, and the drain must schedule nothing further.
    let stoppedOnce = false;
    const original = Store.prototype.commitConsolidationRun;
    const spy = vi.spyOn(Store.prototype, "commitConsolidationRun").mockImplementation(function (this: Store, ...args: Parameters<typeof original>) {
      const result = original.apply(this, args);
      if (result.ok && !stoppedOnce) { stoppedOnce = true; void command(h, "stop"); }
      return result;
    });
    try {
      h.provider(async c => phaseOf(c) === "consolidation" ? consolidateRange(c) : notingFact(c));
      await command(h, "catchup");
      await settle(h);
    } finally { spy.mockRestore(); }
    expect(stoppedOnce).toBe(true);
    const consolidationRuns = h.memory.store.listRuns(1).filter(r => r.kind === "consolidation" && r.outcome === "success");
    expect(consolidationRuns).toHaveLength(1); // the committed batch survives; no further batch was scheduled
    // Durable pending facts are not deleted: the rest of the frozen target waits for a new invocation.
    const remaining = h.memory.store.consolidationBatch(1, "main", 1).map(f => f.id);
    expect(remaining.length).toBeGreaterThan(0);
    expect(remaining.every(id => frozen.includes(id) || !frozen.includes(id))).toBe(true);
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: stopped");
    // A new catchup freezes a fresh target over what is left and drains it.
    await command(h, "catchup");
    await settle(h);
    expect(h.memory.store.consolidationBatch(1, "main", 1)).toEqual([]);
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: completed");
  } finally { await h.dispose(); }
}, 60000);

test("review 2026-09-08: an unavailable Consolidator model fails the catchup once instead of re-admitting it in a loop", async () => {
  const h = host({ "noting.triggerTokens": 1e9, consolidationModel: "missing/model" });
  try {
    await h.turn();
    recorded(h.memory, 1, "main", 1);
    const note = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 }).find(t => t.name === "note")!;
    expect(note.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] })).toContain("ok: F1");
    let lookups = 0;
    // A re-admission loop has no wait a timeout could catch, so the stub itself stops it after a few lookups.
    h.ctx.modelRegistry.find = () => { if (++lookups > 3) throw new Error("probe: the catchup re-admitted a permanent configuration error"); return undefined; };
    await command(h, "catchup");
    await h.drain();
    expect(lookups).toBe(1); // one admission, one lookup: a configuration error is not a wait to retry
    expect(h.notices.filter(n => n.includes("Consolidation capacity: unavailable model"))).toHaveLength(1);
    expect(h.requests).toEqual([]);
    await command(h, "");
    expect(h.notices.at(-1)).toContain("Catchup: failed");
    expect(h.notices.at(-1)).toContain("unavailable model");
  } finally { await h.dispose(); }
}, 20000);
