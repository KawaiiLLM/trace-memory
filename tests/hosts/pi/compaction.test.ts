import { expect, test, vi } from "vitest";
import { host, reply, notingFact, type Reply } from "./test-host.ts";
import { noteAndMemory, stableForkFixture as forkFixture, noteBatch, say, toolResults, worker } from "./native-fixture.ts";

// Ticket 20c — compaction and post-compaction worker mode, at the host boundary. Core decides between
// the custom replacement and the native delegation over its own frozen snapshot (core/api/read.test.ts);
// this file pins what the Pi adapter does with it, and what a persisted compaction does to the next
// Noter's fork.
//
// 29c replaced the admission rule these cases were written for: the question is no longer "does a
// selected entry precede the compaction" but "is every selected entry still in the inherited
// context". A compaction persisted here keeps only its `firstKeptEntryId` and carries no views of
// ours, so its pre-boundary entries are in no representation at all and the outcome of every case
// below is unchanged; only the reason is. The representations that DO survive a compaction — a
// retained source, a bounded view a carrier supplied — are the rows in `fallback.test.ts`.

const long = (word: string) => `${word} ` + "word ".repeat(200);
const quiet = { "noting.triggerTokens": 1_000_000_000 };
const eager = { "noting.triggerTokens": 30 };
const lastRun = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).at(-1)!;
const response = (h: ReturnType<typeof host>) => JSON.parse(lastRun(h).response!);
/** A Noter that always fails leaves its entries pending, which is the state compact escalates over
 * and the state the post-compaction admission rule is about. */
const failing = (h: ReturnType<typeof host>) => h.provider(async () => ({ ...reply(""), stopReason: "error" as const, errorMessage: "leave pending" }));
const work = async (h: ReturnType<typeof host>, text: string) => { h.persist(reply(text)); await h.emit("agent_end"); await h.drain(); };

test("20c scenario 10, as 30 left it: the host hands Pi the bounded summary under one Raw title and names it in its own diagnostics", async () => {
  const h = host(quiet);
  try {
    // 25c/30: pending Raw is held up to `render.episodicBlockTokens` (20,000) and one entry view is
    // worth at most `render.entryTokens` (2,000), so three such prompts are three cut views.
    for (const head of ["HEAD", "SECOND", "THIRD"]) {
      await h.prompt(`${head} ` + "word ".repeat(12_000) + " TAIL");
      await h.answer();
    }
    const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    // One view, one title: the tier-2 block title went with the tier (30), and every prompt is present.
    expect(block.compaction.summary).toContain("\nRaw:\n");
    expect(block.compaction.summary).not.toContain("tier-2 entry views");
    for (const head of ["HEAD", "SECOND", "THIRD"]) expect(block.compaction.summary).toContain(head);
    expect(block.compaction.summary).toMatch(/\[\.\.\. \d+ characters truncated\]/);
    expect(block.compaction.summary).not.toContain("[entry ["); // no native identity in the model-facing text
    expect(block.compaction.firstKeptEntryId).toBe("");
    expect(h.notices.at(-1)).toContain("compaction preparing bounded entry views");
    const entry = h.compaction(block.compaction.summary);
    await h.emit("session_compact", { compactionEntry: entry, fromExtension: true });
    await h.commands.get("trace").handler("", h.ctx);
    expect(h.notices.at(-1)).toContain("Compaction: bounded entry views");
    expect(h.requests).toEqual([]); // the plugin's own rendering calls no model
  } finally { await h.dispose(); }
});

test("73: many tiny entries over the Raw window truncate to the newest span rather than delegate, and compact starts no worker", async () => {
  // Many tiny entries: their bounded views together exceed the Raw window plus its (zeroed) shared
  // allowance. 73: there is no fallback any more — compact keeps the newest contiguous span and
  // receipts the rest, and the failing Noter below is irrelevant to that (compact never runs a worker
  // of its own, with or without recovery).
  const h = host({ ...eager, "noting.forkModeDefault": true, "noting.batchTokens": 300, "dreaming.triggerTokens": 1,
    "compaction.factsTokens": 50, "compaction.rawTokens": 50, "compaction.sharedAllowanceTokens": 1 });
  try {
    h.memory.setKnowledgeBudget("global", 0);
    h.memory.setKnowledgeBudget("project", 0);
    h.memory.setKnowledgeBudget("session", 0);
    failing(h); // repeated Noter failures leave entries pending; unrelated to compact's own truncation
    for (let i = 0; i < 20; i++) { await h.prompt(`tiny ${i} ` + "word ".repeat(250)); await h.answer(); await h.emit("agent_settled"); await h.drain(); }
    // 32c: repeated failures now disable enrollment. Explicitly resume before testing the
    // compaction boundary itself; this imports the disabled interval and resets its streak.
    await h.commands.get("trace").handler("on", h.ctx);
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    const runsBefore = h.memory.store.listRuns(1).length;
    const pendingBefore = h.memory.pendingEntries(1, "main", 1).map(e => e.id);
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    expect(result.compaction.summary).toContain("earlier entries omitted from the Raw window");
    expect(h.notices.some(n => n.includes("compaction preparing bounded entry views"))).toBe(true);
    // The foreground truncation warning comes once Pi appends the carrier: what was omitted, and
    // that it stays pending.
    expect(h.notices.some(n => n.includes("compaction omitted"))).toBe(false);
    const entry = { id: "compact", parentId: h.entries.at(-1)!.id, timestamp: "now", type: "compaction",
      summary: result.compaction.summary, firstKeptEntryId: "", tokensBefore: 100_000, details: result.compaction.details };
    h.entries.push(entry as never); h.allEntries.push(entry as never);
    await h.emit("session_compact", { compactionEntry: entry });
    const warning = h.notices.find(n => n.includes("compaction omitted"));
    expect(warning).toContain("pending Raw");
    expect(warning).toContain("pending for Noting and Consolidation");
    // Compact itself never runs a worker (with or without recovery) and never touches progress.
    expect(h.memory.store.listRuns(1)).toHaveLength(runsBefore);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.id)).toEqual(pendingBefore);
    // Pi persists the (truncated) compaction entry; the next fork-mode Noter is downgraded because
    // the compaction dropped entries from the inherited context, same as any other truncated summary.
    await h.emit("session_compact", { compactionEntry: h.compaction(result.compaction.summary), fromExtension: true });
    await work(h, long("more"));
    expect(response(h).requestedMode).toBe("fork");
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 12: compact neither waits for nor launches a Noter, a concurrent commit survives it, and no summary re-enters the source queue", async () => {
  const h = host({ ...eager, "noting.forkModeDefault": false });
  try {
    const releases: ((value: Reply) => void)[] = [];
    h.provider(async () => new Promise<Reply>(resolve => releases.push(resolve)));
    await h.prompt(long("HEAD")); await h.answer(); await h.emit("agent_settled"); await h.drain();
    expect(h.requests).toHaveLength(1); // one Noter in flight, its reply held open
    const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 1_000 } });
    expect(h.requests).toHaveLength(1); // compact started nothing and waited for nothing
    expect(block.compaction.summary).toContain("HEAD");
    // The held Noter now commits. A business commit that wins concurrently survives the snapshot,
    // which may therefore contain Raw that is recorded just afterwards; that duplication is harmless.
    await vi.waitFor(() => expect(releases).toHaveLength(1), { timeout: 5000 });
    releases[0]!(notingFact(h.conversations[0]!));
    await h.drain();
    await vi.waitFor(() => expect(h.memory.store.listSessionFacts(1)).toHaveLength(1), { timeout: 5000 });
    expect(lastRun(h).outcome).toBe("success");
    // Progress came from the Noter and only from it: exactly the entries it froze are now recorded.
    const noted = new Set((JSON.parse(lastRun(h).response!).entryAudit.entries as { id: number }[]).map(e => e.id));
    expect(noted.size).toBeGreaterThan(0);
    expect(h.memory.pendingEntries(1, "main", 1).some(e => noted.has(e.id))).toBe(false);
    // Due work and a free slot afterwards: compact still starts nothing. Reconciling for the snapshot
    // is a read, never an extraction trigger (17b), so no lifecycle hook becomes a memory flush.
    h.persist(reply(long("DUE")));
    const requests = h.requests.length;
    await h.emit("session_before_compact", { preparation: { tokensBefore: 1_000 } });
    await h.drain();
    expect(h.requests).toHaveLength(requests);
    expect(h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(1);
    // The summary is the plugin's own message: it becomes no source entry, no fact and no receipt.
    const sources = h.memory.store.listSourceEntries(1).length;
    await h.emit("session_compact", { compactionEntry: h.compaction(block.compaction.summary), fromExtension: true });
    expect(h.memory.store.listSourceEntries(1)).toHaveLength(sources);
    const compactionTurn = h.memory.store.listTurns(1).at(-1)!;
    expect(compactionTurn.kind).toBe("compaction");
    expect(h.memory.store.listSourceEntries(1).some(e => e.turnId === compactionTurn.id)).toBe(false);
    expect(h.memory.pendingEntries(1, "main", compactionTurn.id).some(e => e.turnId === compactionTurn.id)).toBe(false);
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 13 (rule replaced in 29c): a persisted compaction that keeps none of the selected entries sends the Noter to subagent with a recorded reason; a sibling path's does not", async () => {
  const h = host({ ...eager, "noting.forkModeDefault": true }); // explicitly request fork throughout
  try {
    failing(h);
    await h.prompt(long("HEAD")); await h.answer(); await h.emit("agent_settled"); await h.drain();
    expect(response(h).requestedMode).toBe("fork");
    expect(String(response(h).fallbackReason)).not.toContain("Raw availability"); // no compaction yet
    // A compaction on a sibling path is in the session file but not on this ancestry, so it is in no
    // context this host builds: it drops nothing here.
    h.compaction("sibling summary", { sibling: true });
    await work(h, long("sibling era"));
    expect(String(response(h).fallbackReason)).not.toContain("Raw availability");
    // The selected ancestry's own persisted compaction does drop entries. The batch that follows is
    // mixed — entries the context still holds and entries it does not — and runs as subagent for all.
    const dropped = h.memory.pendingEntries(1, "main", h.memory.store.listTurns(1).at(-1)!.id)[0]!;
    h.compaction();
    await work(h, long("after"));
    expect(lastRun(h).mode).toBe("subagent");
    expect(response(h).requestedMode).toBe("fork"); // the configured/requested mode is preserved
    // 29c: the reason names the first entry of the batch the context no longer holds.
    expect(String(response(h).fallbackReason)).toContain(`Raw availability: entry ${dropped.id} (T${dropped.turnId}, native ${dropped.nativeId})`);
    expect(h.memory.store.forkSuppression(1)).toBeNull(); // not the cache-miss latch, and no enrollment change
    const sent = String(h.conversations.at(-1)!.messages[0]!.content);
    expect(sent).toContain("[T1#E1@text] user: "); // full primary material for the whole batch
    expect(sent).toContain("HEAD"); expect(sent).toContain("after");
    // Reopening re-reads the context: the view is not cached across it, and the answer does not change.
    await h.emit("session_start");
    await work(h, long("reopened"));
    expect(lastRun(h).mode).toBe("subagent");
    expect(String(response(h).fallbackReason)).toContain("Raw availability: entry ");
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 14: a task whose entries the compacted context still holds keeps the configured mode, and the requested/actual audit is unchanged", async () => {
  const h = host({ ...eager, "noting.forkModeDefault": true });
  try {
    h.compaction(); // the boundary is already in the ancestry; every entry below is post-compaction
    failing(h);
    await h.prompt(long("HEAD")); await h.answer(); await h.emit("agent_settled"); await h.drain();
    await work(h, long("post"));
    // Every selected entry is still retained, so the rule does not fire: this task keeps the requested
    // fork mode and falls back only for the reason it would have without any compaction at all.
    expect(response(h).requestedMode).toBe("fork");
    expect(String(response(h).fallbackReason)).not.toContain("Raw availability");
    expect(String(response(h).fallbackReason)).toContain("No current-branch provider payload captured");
    expect(h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 13/14 (native): a real persisted compaction downgrades the next Noter, while the fork already running keeps its own frozen context", async () => {
  const f = await forkFixture();
  try {
    let release!: (value: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    let first = true;
    f.script(body => {
      if (!worker(body)) return say("好的。");
      if (toolResults(body)) return say("Done.");
      if (first) { first = false; return held; }
      return noteAndMemory("t2", noteBatch);
    });
    await f.turn("用 pnpm，不要 npm " + "word ".repeat(400)); // a real fork Noting starts, holding its first request open
    await vi.waitFor(() => expect(f.sent.filter(b => worker(b))).toHaveLength(1), { timeout: 5000 });
    // The foreground compacts while that fork is in flight, and Pi persists the compaction entry.
    await f.h.emit("session_before_compact", { preparation: { tokensBefore: 100 } });
    const boundary = f.manager().appendCompaction("native summary", f.manager().getLeafId()!, 100);
    await f.h.emit("session_compact", { compactionEntry: { summary: "native summary" } });
    expect(boundary).toBeTruthy();
    release(noteAndMemory("t1", noteBatch));
    const run = await vi.waitFor(() => { const r = f.h.memory.store.listRuns(1)[0]; expect(r?.response).toBeTruthy(); return r!; }, { timeout: 5000 });
    // Not restarted, not replayed, not cancelled: the running fork finished against its frozen context.
    expect(run.mode).toBe("fork");
    expect(JSON.parse(run.response!).fallbackReason).toBeUndefined();
    expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(1);
    expect(f.h.memory.store.listSessionFacts(1).length).toBeGreaterThan(0); // its commit stands
    // New foreground work the second compaction drops from the context: the next Noter runs fresh.
    f.manager().appendMessage({ role: "user", content: "word ".repeat(400), timestamp: 1 } as never);
    f.manager().appendMessage({ ...reply("an answer " + "word ".repeat(400)), timestamp: 1 } as never);
    f.manager().appendCompaction("second native summary", f.manager().getLeafId()!, 100);
    await f.h.emit("message_start", { message: reply("") });
    const second = await vi.waitFor(() => { const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting");
      expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); return runs[1]!; }, { timeout: 5000 });
    expect(second.mode).toBe("subagent");
    const audit = JSON.parse(second.response!);
    expect(audit.requestedMode).toBe("fork");
    expect(String(audit.fallbackReason)).toContain("Raw availability: entry ");
  } finally { await f.dispose(); }
}, 30000);
