import { expect, test, vi } from "vitest";
import { host as createHost, reply, type Reply } from "./test-host.ts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Seed quietly, then enable real thresholds through the existing settings reload. These legacy
// fixtures test ownership/cancellation, not a below-threshold compaction exemption (removed by 32f).
const host = (config: Record<string, unknown>) => {
  const { "noting.triggerTokens": noting, "consolidation.triggerTokens": consolidation, ...rest } = config;
  const h = createHost(rest);
  const file = join(h.dir, "agent", "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8"));
  settings["trace-memory"] = { "noting.triggerTokens": noting, "consolidation.triggerTokens": consolidation };
  writeFileSync(file, JSON.stringify(settings));
  return h;
};

// Tickets 28b/32f — bounded recovery inside Pi's compaction hook. 32e's allocator checks required
// knowledge/facts/Raw against fixed 20k/10k/10k bases plus shared required-only 10k overflow.
// A shortfall permits at most one eligible Noting, Consolidation and Dreamer task, including reuse.
// Independently useful phases overlap; up to three rounds cover N→C→D. Committed progress is
// repriced on the frozen path before custom replacement or native delegation; failure stops recovery.
//
// The Pi lines the sequence is mapped onto (0.85.1 `dist/`, the installed package):
//   agent-session.js:1496-1509  manual `compact()`: the hook, its `signal`, and `{cancel: true}`
//   agent-session.js:1750-1782  `_runAutoCompaction()`: the same hook under the automatic controller
//   agent-session.js:1604       `abortCompaction()` aborts whichever controller is live (Esc)
// The three automatic triggers that reach `_runAutoCompaction` are exercised against a real Pi
// session in `compaction-triggers.test.ts`; the cases here drive the hook itself.

const quiet = { "noting.triggerTokens": 1_000_000_000, "consolidation.triggerTokens": 1_000_000_000 };
/** Independent bases plus a small shared allowance: pending demand still overflows, while empty
 * window titles can fit after successful recovery even in legacy one-token-base fixtures. */
const windows = (knowledge: number, facts: number, raw: number) =>
  ({ "render.knowledgeBlockTokens": knowledge, "compaction.factsTokens": facts, "compaction.rawTokens": raw,
    // Preserve these recovery probes' deliberately tiny admission allowance; 32e tests the default.
    "compaction.overflowTokens": 50 });
const long = (head: string) => `${head} ` + "word ".repeat(3_000);
type Host = ReturnType<typeof host>;
/** The runs this compaction caused: `noted` below seeds one directly in the store, which is state,
 * not work anyone did here. */
const runs = (h: Host, kind?: string) => h.memory.store.listRuns(1).filter(r => r.createdAt !== "seed" && (!kind || r.kind === kind));
const facts = (h: Host) => h.memory.store.listSessionFacts(1);
const compact = async (h: Host, signal?: AbortSignal): Promise<any> => {
  const file = join(h.dir, "agent", "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8"));
  for (const key of ["noting.triggerTokens", "consolidation.triggerTokens"])
    if (settings["trace-memory"][key] === 1_000_000_000) settings["trace-memory"][key] = 20;
  writeFileSync(file, JSON.stringify(settings));
  await h.emit("session_tree", {}); // reload on the unchanged path; does not reopen or steal claims
  return h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 }, ...(signal ? { signal } : {}) });
};

/** Turns whose entries stay pending: `quiet` starts no automatic Noting, so every entry is Raw the
 * compaction must represent. */
const turns = async (h: Host, count: number, head = "HEAD") => {
  for (let i = 0; i < count; i++) { await h.prompt(long(`${head}${i}`)); await h.answer(); }
};
/** Mark every pending entry noted and commit `count` facts, without a model: the state a facts-only
 * overflow needs (pending facts, no pending Raw). */
const noted = (h: Host, count: number) => {
  const pending = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id);
  const turnId = pending.at(-1)!.turnId;
  h.memory.store.commitNotingRun({
    run: { kind: "noting", sessionId: 1, branch: "main", rangeFrom: "S1/T1", rangeTo: `S1/T${turnId}`, createdAt: "seed" },
    facts: Array.from({ length: count }, (_, i) => ({ turnId, category: "observation" as const, actor: "user" as const,
      text: `a pending claim number ${i} that is long enough to charge the facts window a few tokens of its own`,
      source: [`T${turnId}#user`], createdAt: "seed" })),
    entryIds: pending.map(e => e.id),
  });
};
/** A Noter reply that submits one fact against a source address of the batch it was really given —
 * an address outside the frozen range is rejected, and the run would end incomplete. `autoStop`
 * answers the closing turn once the submission is in. */
const notes = (conversation: any, text = "recovered fact"): Reply => ({ ...reply(""), stopReason: "toolUse",
  content: [{ type: "toolCall", id: "note-1", name: "note", arguments: { facts: [{ category: "observation", actor: "user", text,
    source: [/\[(T\d+#E\d+@text)\] user:/.exec(String(conversation.messages[0]?.content ?? ""))?.[1] ?? "T1#user"] }] } }] });
/** A Consolidator reply that accounts for every fact of its batch by skipping it: the batch is
 * consolidated, so the facts window empties, and no knowledge is written. A batch that skips
 * everything reports no commit, which is not one of `test-host`'s automatic closing conditions, so
 * the closing reply is this helper's own. */
const consolidates = (h: Host, conversation: any): Reply =>
  // Ruling 18:39: the first batch is a candidate and the run commits on the resubmission after the
  // review feedback, so a scripted Consolidator submits the same batch twice.
  (conversation.messages ?? []).filter((m: any) => m.role === "toolResult" && m.toolName === "memory").length >= 2 ? reply("Done.")
  : ({ ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "memory-1", name: "memory",
      arguments: { operations: [], skipped: facts(h).map(f => ({ fact: `F${f.id}`, because: "Not durable." })) } }] });
/** Which worker is asking: both children register all four memory tools, so the phase is told by the
 * production prompt the material carries, exactly as `native-fixture`'s `worker()` tells them apart. */
const isNoting = (conversation: unknown) => JSON.stringify(conversation).includes("Noting (fact extraction)");

test.each([false, true])("32c: automatic off during compaction takes native failure; user cancellation takes precedence (%s)", async cancel => {
  const h = host({ ...quiet, ...windows(1, 1, 1) });
  try {
    await turns(h, 1);
    h.provider(async () => reply("Nothing to note."));
    await compact(h); await compact(h);
    expect(h.memory.store.taskFailures(1)).toMatchObject([{ count: 2 }]);
    const controller = new AbortController();
    const notify = h.ctx.ui.notify.bind(h.ctx.ui);
    const notices = vi.spyOn(h.ctx.ui, "notify").mockImplementation((message, level) => {
      notify(message, level); if (cancel && String(message).includes("off after three failures")) controller.abort();
    });
    const result = await compact(h, controller.signal);
    notices.mockRestore();
    expect(h.memory.store.enabled(1)).toBe(false);
    expect(h.memory.store.taskFailures(1)).toMatchObject([{ count: 3 }]);
    expect(h.notices.filter(n => n.includes("off after three failures"))).toHaveLength(1);
    expect(result).toEqual(cancel ? { cancel: true } : undefined);
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).not.toEqual([]);
    expect(h.memory.status(1)).toContain("Automatic off: noting");
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});

test("28b acceptance 5: a facts-only overflow runs one awaited Consolidation and nothing else", async () => {
  // Nothing pending in Raw, ten pending facts, and an envelope smaller than they charge.
  const h = host({ ...quiet, ...windows(1, 1, 200) });
  try {
    await turns(h, 1);
    noted(h, 10);
    h.provider(async conversation => isNoting(conversation) ? reply("a Noter must not be launched here") : consolidates(h, conversation));
    const result = await compact(h);
    expect(runs(h, "consolidation")).toHaveLength(1);
    expect(runs(h, "noting")).toHaveLength(0); // the Raw window was never over: no second phase is used
    expect(h.memory.store.consolidationBatch(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
    // The reallocation after the task saw the emptied window and the replacement was persisted.
    expect(result.compaction.summary).toBeTruthy();
    expect(h.notices.at(-1)).toContain("compaction preparing bounded entry views (after recovery: Consolidation)");
  } finally { await h.dispose(); }
});

test("28b acceptance 5: a Raw-only overflow runs one awaited Noting and persists the replacement it makes possible", async () => {
  const h = host({ ...quiet, ...windows(1, 1_000, 1) });
  try {
    await turns(h, 3);
    const pending = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    expect(pending.length).toBeGreaterThan(0);
    h.provider(async conversation => isNoting(conversation) ? notes(conversation) : reply("a Consolidator must not be launched here"));
    const result = await compact(h);
    expect(runs(h, "noting")).toHaveLength(1);
    expect(runs(h, "consolidation")).toHaveLength(0);
    expect(runs(h, "noting")[0]!.mode).toBe("subagent"); // never a fork of the context being compacted
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id)).toEqual([]);
    expect(result.compaction.summary).toBeTruthy();
    expect(h.notices.at(-1)).toContain("compaction preparing bounded entry views (after recovery: Noting)");
  } finally { await h.dispose(); }
});

test("28b acceptance 5: both windows over run their two tasks concurrently, in their separate slots", async () => {
  const h = host({ ...quiet, ...windows(1, 1, 1) });
  try {
    await turns(h, 1, "OLD");
    noted(h, 10);            // pending facts, no pending Raw yet
    await turns(h, 2, "NEW"); // and now pending Raw as well
    // The simulated held workers: neither reply is produced until BOTH requests are in flight, so a
    // sequential implementation deadlocks here instead of passing.
    const inFlight = new Set<string>(); let release = () => {};
    const both = new Promise<void>(resolve => { release = resolve; });
    h.provider(async conversation => {
      const noting = isNoting(conversation);
      inFlight.add(noting ? "noting" : "consolidation");
      if (inFlight.size === 2) release();
      await both;
      return noting ? notes(conversation) : consolidates(h, conversation);
    });
    await compact(h);
    expect([...inFlight].sort()).toEqual(["consolidation", "noting"]);
    expect(runs(h, "noting")).toHaveLength(1);
    expect(runs(h, "consolidation")).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("28b acceptance 6: a Noting success that overflows the facts window uses the unused Consolidation allowance, once", async () => {
  const h = host({ ...quiet, ...windows(1, 1, 200) });
  try {
    await turns(h, 1);
    // Raw over, facts empty: only Noting is launched in the first round. Its facts then overflow the
    // 1-token facts window, and the second round spends the allowance Consolidation still has.
    const order: string[] = [];
    h.provider(async conversation => {
      const noting = isNoting(conversation);
      order.push(noting ? "noting" : "consolidation");
      return noting ? notes(conversation, `a fact long enough to overflow the facts window on its own ${"word ".repeat(300)}`) : consolidates(h, conversation);
    });
    const result = await compact(h);
    expect([...new Set(order)]).toEqual(["noting", "consolidation"]); // sequential by dependency, not by policy
    expect(runs(h, "consolidation")).toHaveLength(1);
    expect(result.compaction.summary).toBeTruthy();
    expect(h.notices.at(-1)).toContain("(after recovery: Noting, Consolidation)");
  } finally { await h.dispose(); }
});

test("28b acceptance 6: with both phases used, the facts a Noting run added trigger no second Consolidation", async () => {
  const h = host({ ...quiet, ...windows(1, 1, 1) });
  try {
    await turns(h, 1, "OLD");
    noted(h, 10);
    await turns(h, 2, "NEW");
    h.provider(async conversation => isNoting(conversation) ? notes(conversation, "a fact the concurrent Consolidation never saw") : consolidates(h, conversation));
    const result = await compact(h);
    expect(result).toBeUndefined(); // the new facts are still pending and still over: this delegates
    expect(runs(h, "consolidation")).toHaveLength(1); // and never twice
    expect(runs(h, "noting")).toHaveLength(1);
    expect(h.notices.at(-1)).toContain("compaction preparing native delegation");
    expect(h.notices.at(-1)).toContain("(after recovery: Noting, Consolidation)");
  } finally { await h.dispose(); }
});

test("28b acceptance 7: a successful but insufficient recovery delegates, and its progress stays committed", async () => {
  // One ordinary bounded batch, not a drain: `noting.batchTokens` holds one entry, so a successful
  // Noting still leaves Raw over. No larger batch is built to avoid the fallback.
  const h = host({ ...quiet, ...windows(1, 1_000, 1), "noting.batchTokens": 2_400 });
  try {
    await turns(h, 3);
    h.provider(async conversation => notes(conversation));
    const before = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).length;
    const result = await compact(h);
    expect(result).toBeUndefined();
    expect(runs(h, "noting")).toHaveLength(1);
    expect(runs(h, "noting")[0]!.outcome).toBe("success");
    const after = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).length;
    expect(after).toBeLessThan(before); // the batch it did process stays processed
    expect(facts(h)).toHaveLength(1);
    expect(h.notices.at(-1)).toContain("compaction preparing native delegation");
  } finally { await h.dispose(); }
});

test("28b acceptance 7: a worker failure delegates only after the other task has reached a terminal state", async () => {
  const h = host({ ...quiet, ...windows(1, 1, 1) });
  try {
    await turns(h, 1, "OLD");
    noted(h, 10);
    await turns(h, 2, "NEW");
    let releaseConsolidation = () => {};
    const held = new Promise<void>(resolve => { releaseConsolidation = resolve; });
    let failedAt = -1;
    h.provider(async conversation => {
      if (isNoting(conversation)) { failedAt = runs(h).length; releaseConsolidation(); return { ...reply(""), stopReason: "error" as const, errorMessage: "the recovery Noter exploded" }; }
      await held; // still running when the other task fails
      return consolidates(h, conversation);
    });
    const result = await compact(h);
    expect(result).toBeUndefined();
    expect(failedAt).toBeGreaterThanOrEqual(0);
    // Both tasks are terminal by the time the delegation is decided: two records, both with outcomes.
    const settled = runs(h);
    expect(settled).toHaveLength(2);
    expect(settled.every(r => r.outcome !== null)).toBe(true);
    expect(settled.find(r => r.kind === "noting")!.outcome).toBe("failure"); // the failed run keeps its audit
    expect(h.notices.at(-1)).toContain("compaction preparing native delegation");
    // 27b: the failing child never compacts privately — the only requests are the two workers' own.
    expect(h.requests.length).toBeGreaterThan(0);
    expect(h.requests.every(body => JSON.stringify(body).includes("extraction"))).toBe(true);
  } finally { await h.dispose(); }
});

test("28b acceptance 8: cancelling before admission starts nothing, publishes nothing and delegates to nothing", async () => {
  const h = host({ ...quiet, ...windows(1, 1_000, 1) });
  try {
    await turns(h, 2);
    h.provider(async () => reply("no worker may be launched"));
    const controller = new AbortController(); controller.abort();
    const result = await compact(h, controller.signal);
    expect(result).toEqual({ cancel: true }); // Pi ends the compaction as aborted (agent-session.js:1509/:1770)
    expect(runs(h)).toHaveLength(0);
    expect(h.requests).toEqual([]);
    expect(h.notices.some(n => n.includes("compaction used"))).toBe(false);
    expect(h.notices.at(-1)).toContain("no native compaction was started");
  } finally { await h.dispose(); }
});

test("28b acceptance 8: cancelling during a worker cancels that worker and starts no native fallback", async () => {
  const h = host({ ...quiet, ...windows(1, 1_000, 1) });
  try {
    await turns(h, 2);
    const controller = new AbortController();
    // Aborted while the request is in flight: the abort is scheduled a tick after the reply is
    // promised, which is where `test-host` has attached the child's own abort listener.
    h.provider(async () => { setTimeout(() => controller.abort(), 0); return new Promise<Reply>(() => {}); });
    const pendingBefore = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    const result = await compact(h, controller.signal);
    expect(result).toEqual({ cancel: true });
    expect(facts(h)).toEqual([]);
    expect(h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id)).toEqual(pendingBefore);
    expect(h.notices.some(n => n.includes("compaction used"))).toBe(false);
  } finally { await h.dispose(); }
});

test("28b acceptance 8: cancelling after one commit keeps the commit, writes no carrier and starts no fallback", async () => {
  const h = host({ ...quiet, ...windows(1, 1, 1) });
  try {
    await turns(h, 1, "OLD");
    noted(h, 10);
    await turns(h, 2, "NEW");
    const controller = new AbortController();
    h.provider(async conversation => {
      if (isNoting(conversation)) return notes(conversation, "a fact committed before the cancellation");
      await vi.waitFor(() => expect(facts(h).length).toBeGreaterThan(10)); // the Noting commit landed
      controller.abort();
      return new Promise<Reply>(() => {});
    });
    const result = await compact(h, controller.signal);
    expect(result).toEqual({ cancel: true });
    expect(facts(h).map(f => f.text)).toContain("a fact committed before the cancellation"); // committed progress survives
    expect(h.notices.some(n => n.includes("compaction used"))).toBe(false);
    expect(h.entries.filter(e => e.type === "compaction")).toEqual([]); // no carrier, no false coverage
  } finally { await h.dispose(); }
});

test("28: user cancellation never starts native fallback", async () => {
  // The named ruling (28 "Failure and persistence"): cancellation is not a recoverable capacity
  // failure. Whatever state the sequence is in — before admission, in flight, or after every task
  // has settled but before the replacement is published — the hook cancels the compaction and Pi
  // runs no summary of its own.
  const h = host({ ...quiet, ...windows(1, 1_000, 1) });
  try {
    await turns(h, 2);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    h.provider(async conversation => { await held; return notes(conversation); });
    // A compatible task of another operation is already running, so this compaction owns nothing:
    // it is parked on the reuse wait when the user cancels.
    await h.commands.get("trace").handler("catchup", h.ctx);
    await vi.waitFor(() => expect(h.requests.length).toBe(1));
    const controller = new AbortController();
    const attempt = compact(h, controller.signal);
    await new Promise(resolve => setImmediate(resolve));
    controller.abort();
    expect(await attempt).toEqual({ cancel: true });
    expect(h.notices.some(n => n.includes("compaction used"))).toBe(false);
    // Cancelling the wait cancelled the wait alone: the other operation's task finishes normally.
    release();
    await h.drain();
    expect(runs(h, "noting")).toHaveLength(1);
    expect(runs(h, "noting")[0]!.outcome).toBe("success");
    expect(facts(h)).toHaveLength(1);
  } finally { await h.dispose(); }
});

test("28: one Noting and one Consolidation per compaction, reuse counts, cancellation is a signal", async () => {
  // The named ruling (28 amendments 1-3). A compatible in-flight task — same target, same frozen
  // boundary — is awaited instead of duplicated and spends that phase's one allowance, so a Raw
  // window still over after it delegates rather than launching a second batch. The signal half of
  // the ruling is the two cancellation cases above and `core/api/rulings.test.ts` "28 amendment 3".
  const h = host({ ...quiet, ...windows(1, 1_000, 1), "noting.batchTokens": 2_400 });
  try {
    await turns(h, 3);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let seen = 0;
    h.provider(async conversation => { if (++seen === 1) await held; return notes(conversation); });
    // `/trace catchup` freezes the same target and the same entry ceiling this compaction would, so
    // its first batch is the compatible in-flight task.
    await h.commands.get("trace").handler("catchup", h.ctx);
    await vi.waitFor(() => expect(h.requests.length).toBe(1));
    const attempt = compact(h);
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the running Noting task on this target"))).toBe(true));
    release();
    const result = await attempt;
    // Its completion is this phase's progress and its one use: nothing of this compaction's own ran.
    expect(h.notices.some(n => n.includes("compaction is running Noting"))).toBe(false);
    expect(result).toBeUndefined(); // one batch was not enough, and the allowance is spent
    expect(h.notices.filter(n => n.includes("compaction preparing")).at(-1)).toContain("native delegation");
    expect(h.notices.filter(n => n.includes("compaction preparing")).at(-1)).toContain("(after recovery: Noting)");
  } finally { await h.dispose(); }
});

test("28b acceptance 9: an unrelated occupied slot is waited out as capacity, neither counted nor cancelled", async () => {
  // Ordinary automatic work: same phase, same target, but no frozen boundary of ours — not the same
  // frozen range, so its completion is not this recovery's progress (28 amendment 2). The slot is
  // waited out, the task is left alone, and this compaction then runs its own batch.
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1_000_000_000, ...windows(1, 1_000, 1), "noting.batchTokens": 2_400 });
  try {
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    h.provider(async conversation => { await held; return notes(conversation, "the other operation's fact"); });
    await h.prompt(long("FIRST")); await h.answer(); // the ordinary trigger takes the Noting slot
    await vi.waitFor(() => expect(h.requests.length).toBe(1));
    await h.prompt(long("SECOND")); await h.answer(); // enough real Raw remains eligible after the capacity wait
    const attempt = compact(h);
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the occupied Noting slot"))).toBe(true));
    expect(h.requests).toHaveLength(1); // nothing of ours was launched into an occupied slot
    release();
    const result = await attempt;
    // The other operation's task ran to completion — this compaction cancelled nothing — and this
    // compaction then spent its own one use on its own batch.
    expect(facts(h).map(f => f.text)).toContain("the other operation's fact");
    expect(h.notices.some(n => n.includes("compaction is running Noting"))).toBe(true);
    expect(runs(h, "noting").length).toBe(2);
    expect(runs(h, "noting")[0]!.outcome).toBe("success"); // the other operation's own task, untouched
    expect(runs(h, "noting")[1]!.outcome).not.toBe("cancelled"); // and this compaction's own batch really ran
    expect(result === undefined || !!result.compaction).toBe(true);
  } finally { await h.dispose(); }
});

test.each([false, true])("a catchup slot acquired during the capacity wait is reused, with cancellable wait: %s", async cancel => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1e9,
    "noting.batchTokens": 2400, ...windows(1, 1000, 1) });
  let releaseFirst = () => {}, releaseRest = () => {};
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const rest = new Promise<void>(resolve => { releaseRest = resolve; });
  let calls = 0, finished = false;
  const controller = new AbortController();
  try {
    h.provider(async () => {
      await (++calls === 1 ? first : rest);
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "note", name: "note", arguments: { facts: [] } }] };
    });
    await turns(h, 3);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    await h.commands.get("trace").handler("catchup", h.ctx);
    const attempt = compact(h, controller.signal).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the occupied Noting slot"))).toBe(true));
    releaseFirst();
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the running Noting task"))).toBe(true));
    expect(finished).toBe(false); // the capacity release alone is not a recovery use
    expect(h.notices.some(n => n.includes("after recovery: Noting"))).toBe(false);
    if (cancel) {
      controller.abort();
      expect(await attempt).toEqual({ cancel: true });
      expect(h.notices.some(n => n.includes("compaction used"))).toBe(false);
      releaseRest();
      await h.drain();
      expect(runs(h, "noting").every(run => run.outcome === "success")).toBe(true);
    } else {
      releaseRest();
      await attempt;
      expect(h.notices.some(n => n.includes("after recovery: Noting"))).toBe(true);
      expect(h.notices.some(n => n.includes("compaction is running Noting"))).toBe(false);
    }
  } finally { releaseFirst(); releaseRest(); await h.dispose(); }
});

test("a second unrelated slot owner ends the capacity wait without false recovery status", async () => {
  const h = host({ "noting.triggerTokens": 30, "consolidation.triggerTokens": 1e9,
    "noting.batchTokens": 2400, ...windows(1, 1000, 1) });
  let releaseFirst = () => {}, releaseRest = () => {};
  const first = new Promise<void>(resolve => { releaseFirst = resolve; });
  const rest = new Promise<void>(resolve => { releaseRest = resolve; });
  let calls = 0;
  try {
    h.provider(async () => {
      await (++calls === 1 ? first : rest);
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "note", name: "note", arguments: { facts: [] } }] };
    });
    await turns(h, 2);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    await h.commands.get("trace").handler("catchup", h.ctx); // freezes an older target
    await turns(h, 1, "LATER");
    const attempt = compact(h);
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the occupied Noting slot"))).toBe(true));
    releaseFirst();
    expect(await attempt).toBeUndefined(); // do not queue behind another unrelated task
    expect(h.notices.some(n => n.includes("after recovery:"))).toBe(false);
    expect(h.notices.some(n => n.includes("compaction is running Noting"))).toBe(false);
    expect(h.notices.some(n => n.includes("compaction preparing native delegation"))).toBe(true);
  } finally { releaseFirst(); releaseRest(); await h.dispose(); }
});

test("a compatible reused Noter's exact output enters the unused Consolidation allowance", async () => {
  const h = host({ ...quiet, ...windows(1, 1, 200) });
  let releaseNoting = () => {}, releaseConsolidation = () => {};
  const notingGate = new Promise<void>(resolve => { releaseNoting = resolve; });
  const consolidationGate = new Promise<void>(resolve => { releaseConsolidation = resolve; });
  let finished = false;
  try {
    await turns(h, 1);
    h.provider(async conversation => {
      if (isNoting(conversation)) {
        await notingGate;
        return notes(conversation, "a long extracted fact " + "word ".repeat(300));
      }
      await consolidationGate;
      return consolidates(h, conversation);
    });
    await h.commands.get("trace").handler("catchup", h.ctx);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const attempt = compact(h).then(result => { finished = true; return result; });
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the running Noting task"))).toBe(true));
    releaseNoting();
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("compaction is running Consolidation")
      || n.includes("compaction is waiting for the running Consolidation"))).toBe(true));
    expect(finished).toBe(false); // native fallback cannot race past the remaining opportunity
    releaseConsolidation();
    expect((await attempt).compaction.summary).toBeTruthy();
    expect(runs(h, "noting")).toHaveLength(1);
    expect(runs(h, "consolidation")).toHaveLength(1);
    expect(h.notices.some(n => n.includes("after recovery: Noting, Consolidation"))).toBe(true);
  } finally { releaseNoting(); releaseConsolidation(); await h.dispose(); }
});

test("28b acceptance 10: a tree switch during recovery publishes nothing into the newly selected path", async () => {
  const h = host({ ...quiet, ...windows(1, 1_000, 1) });
  try {
    await turns(h, 2);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    h.provider(async conversation => { await held; return notes(conversation); });
    const attempt = compact(h);
    await vi.waitFor(() => expect(h.requests.length).toBe(1));
    // A tree switch: the selected ancestry is rewound past this host's own state entry, which is
    // exactly what `restore(fork)` compares against the tip before it opens a new evidence branch.
    h.entries.length = h.entries.findIndex(e => e.customType === "trace-memory");
    await h.emit("session_tree", {});
    release();
    const result = await attempt;
    expect(result).toBeUndefined(); // no replacement prepared for the old path reaches the new one
    expect(h.notices.at(-1)).toContain("the selected path changed during recovery");
    expect(h.entries.filter(e => e.type === "compaction")).toEqual([]);
  } finally { await h.dispose(); }
});

test("28b acceptance 10: a foreground entry arriving during recovery does not expand the frozen boundary", async () => {
  const h = host({ ...quiet, ...windows(1, 1_000, 1) });
  try {
    await turns(h, 1);
    const frozen = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id).map(e => e.id);
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    h.provider(async conversation => { await held; return notes(conversation); });
    const attempt = compact(h);
    await vi.waitFor(() => expect(h.requests.length).toBe(1));
    await h.emit("message_end", { message: reply(long("LATE")) }); // a new entry, after the freeze
    release();
    await attempt;
    await h.emit("agent_end"); // the boundary that records the late message; the compaction flushed before its freeze
    const late = h.memory.store.listSourceEntries(1).filter(e => !frozen.includes(e.id));
    expect(late.length).toBeGreaterThan(0);
    expect(late.every(e => !h.memory.store.entryNoted(e.id))).toBe(true); // outside this task's range
    expect(frozen.every(id => h.memory.store.entryNoted(id))).toBe(true); // and the frozen range was processed
  } finally { await h.dispose(); }
});

const knowledge = (h: Host) => {
  const c = h.memory.store.commitConsolidationRun({ run: { kind: "manual", sessionId: 1, createdAt: "seed" }, operations: [{ op: "create", handle: "$1", author: "test", text: "rule ".repeat(6000), category: "constraint", scope: "project", supports: [facts(h)[0]!.id], topics: [], reason: "seed evidence", createdAt: "seed" }] });
  if (!c.ok) throw Error(c.problems.join());
};
const archive = (h: Host): Reply => {
  const k = h.memory.store.listCurrentKnowledge(h.memory.store.knowledgePath(1))[0]!;
  return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "archive", name: "memory", arguments: { operations: [{ op: "archive", id: `K${k.knowledge.id}@${k.revision.id}`, supports: [], reason: "Deliberate retirement for hard budgets" }], skipped: [] } }] };
};

test("32f: independently eligible N/C/D overlap; each phase is used once with no fourth round", async () => {
  const h = host({ ...quiet, ...windows(100, 1, 1) });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await turns(h, 1); noted(h, 10); await turns(h, 2, "NEW"); knowledge(h);
    const inFlight = new Set<string>();
    h.provider(async c => {
      const kind = c.systemPrompt?.startsWith("# Dreamer") ? "D" : isNoting(c) ? "N" : "C";
      inFlight.add(kind); if (inFlight.size === 3) release();
      await held;
      return kind === "N" ? notes(c, "concurrent new fact remains pending " + "word ".repeat(100)) : kind === "C" ? consolidates(h, c) : archive(h);
    });
    const attempt = compact(h);
    await vi.waitFor(() => expect([...inFlight].sort()).toEqual(["C", "D", "N"]));
    expect(await attempt).toBeUndefined(); // new N facts missed the already-used C batch
    expect(runs(h).map(r => r.kind).sort()).toEqual(["consolidation", "dreaming", "noting"]);
    expect(h.notices.filter(n => n.includes("compaction is running"))).toHaveLength(3);
  } finally { release(); await h.dispose(); }
});

test("32f: exactly three real rounds cover N enables C enables D, then stop", async () => {
  const h = host({ ...quiet, ...windows(100, 1, 1) });
  try {
    await turns(h, 1);
    const starts: string[] = [];
    h.provider(async c => {
      if (isNoting(c)) { starts.push("N"); return notes(c, "new evidence " + "word ".repeat(6000)); }
      if (c.systemPrompt?.startsWith("# Dreamer")) { starts.push("D"); return archive(h); }
      starts.push("C");
      if (c.messages.filter((m: any) => m.role === "toolResult" && m.toolName === "memory").length >= 2) return reply("Done.");
      return { ...reply(""), stopReason: "toolUse", content: [{ type: "toolCall", id: "create", name: "memory", arguments: { operations: [{ op: "create", text: "rule ".repeat(6000), category: "constraint", scope: "project", supports: facts(h).map(f => `F${f.id}`), topics: [], reason: "new durable evidence" }], skipped: [] } }] };
    });
    const result = await compact(h);
    expect([...new Set(starts)]).toEqual(["N", "C", "D"]);
    expect(runs(h).map(r => r.kind)).toEqual(["noting", "consolidation", "dreaming"]);
    expect(runs(h).every(r => r.outcome === "success")).toBe(true);
    expect(result.compaction.summary).toBeTruthy();
    expect(h.notices.filter(n => n.includes("compaction is running"))).toHaveLength(3);
  } finally { await h.dispose(); }
});
