import { expect, test, vi } from "vitest";
import { host, reply, notingFact, type Reply } from "./test-host.ts";
import { call, fixture, noteBatch, say, toolResults, worker } from "./native-fixture.ts";

// Ticket 20c — compaction escalation and post-compaction worker mode, at the host boundary. Core
// decides the tier over its own frozen snapshot (core/api/read.test.ts); this file pins what the Pi
// adapter does with it, and the admission rule the persisted compaction entry establishes.

const long = (word: string) => `${word} ` + "word ".repeat(200);
const quiet = { "noting.triggerTokens": 1_000_000_000 };
const eager = { "noting.triggerTokens": 30 };
const lastRun = (h: ReturnType<typeof host>) => h.memory.store.listRuns(1).at(-1)!;
const response = (h: ReturnType<typeof host>) => JSON.parse(lastRun(h).response!);
/** A Noter that always fails leaves its entries pending, which is the state compact escalates over
 * and the state the post-compaction admission rule is about. */
const failing = (h: ReturnType<typeof host>) => h.provider(async () => ({ ...reply(""), stopReason: "error" as const, errorMessage: "leave pending" }));
const work = async (h: ReturnType<typeof host>, text: string) => { h.persist(reply(text)); await h.emit("agent_end"); await h.drain(); };

test("20c 2026-09-08 scenario 10: the host hands Pi the labelled secondary summary and names the tier in its own diagnostics", async () => {
  const h = host(quiet);
  try {
    await h.prompt("HEAD " + "word ".repeat(12_000) + " TAIL");
    await h.answer();
    const block = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    // The custom entry names the view version and the profile its views were rendered under (23).
    expect(block.compaction.summary).toContain("Raw (tier-2 entry views, 23-v1-uniform-parts, tool call budget 100 tokens, entry budget 150 tokens):");
    expect(block.compaction.summary).not.toContain("[entry ["); // no native identity in the model-facing text
    expect(block.compaction.firstKeptEntryId).toBe("");
    expect(h.notices.at(-1)).toContain("compaction used secondary views");
    await h.commands.get("trace").handler("status", h.ctx);
    expect(h.notices.at(-1)).toContain("Compaction: secondary views");
    expect(h.requests).toEqual([]); // the plugin's own tiers call no model
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 11: the host returns no custom replacement when compact delegates, and an attempt that never persists establishes no boundary", async () => {
  // Many tiny entries: their primary views together exceed the Raw ceiling, and their secondary views
  // — each carrying its identity header — exceed it too, so even tier 2 cannot represent them all.
  // Each entry alone still fits a batch, so a Noter can run afterwards (review 2026-09-08: a budget the
  // mandatory material cannot fit reduces or holds the task rather than running over it).
  const h = host({ ...eager, "noting.batchTokens": 300 });
  try {
    failing(h); // repeated Noter failures are what make a session hard to compact
    for (let i = 0; i < 20; i++) { await h.prompt(`tiny ${i}`); await h.answer(); await h.emit("agent_settled"); await h.drain(); }
    expect(h.memory.pendingEntries(1, "main", 1).length).toBeGreaterThan(0);
    const runsBefore = h.memory.store.listRuns(1).length;
    const pendingBefore = h.memory.pendingEntries(1, "main", 1).map(e => e.id);
    const deliveries = h.memory.store.listPendingDeliveries(1, "main").length;
    const result = await h.emit("session_before_compact", { preparation: { tokensBefore: 100_000 } });
    expect(result).toBeUndefined(); // no summary at all: Pi's own compaction path runs and reports
    expect(h.notices.at(-1)).toContain("compaction used native delegation");
    expect(h.notices.at(-1)).toContain("exceed");
    // Delegating starts no extraction, advances no progress, erases no source and confirms nothing.
    expect(h.memory.store.listRuns(1)).toHaveLength(runsBefore);
    expect(h.memory.pendingEntries(1, "main", 1).map(e => e.id)).toEqual(pendingBefore);
    expect(h.memory.store.listPendingDeliveries(1, "main")).toHaveLength(deliveries);
    // Pi persists a compaction entry only when compaction succeeded, so this failed/cancelled route
    // wrote none — and the next fork-mode Noter is not downgraded for pre-compaction evidence.
    await work(h, long("more"));
    expect(response(h).requestedMode).toBe("fork");
    expect(String(response(h).fallbackReason)).not.toContain("pre-compaction");
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
    await h.emit("session_compact", { compactionEntry: { summary: block.compaction.summary } });
    expect(h.memory.store.listSourceEntries(1)).toHaveLength(sources);
    const compactionTurn = h.memory.store.listTurns(1).at(-1)!;
    expect(compactionTurn.kind).toBe("compaction");
    expect(h.memory.store.listSourceEntries(1).some(e => e.turnId === compactionTurn.id)).toBe(false);
    expect(h.memory.pendingEntries(1, "main", compactionTurn.id).some(e => e.turnId === compactionTurn.id)).toBe(false);
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 13: a persisted compaction on the selected ancestry sends a Noter with pre-boundary entries to subagent with a recorded reason; a sibling path's does not", async () => {
  const h = host(eager); // noting.forkModeDefault stays on: fork is the requested mode throughout
  try {
    failing(h);
    await h.prompt(long("HEAD")); await h.answer(); await h.emit("agent_settled"); await h.drain();
    expect(response(h).requestedMode).toBe("fork");
    expect(String(response(h).fallbackReason)).not.toContain("pre-compaction"); // no compaction yet
    // A compaction on a sibling path is in the session file but not on this ancestry: it establishes
    // nothing here.
    h.compaction("sibling summary", { sibling: true });
    await work(h, long("sibling era"));
    expect(String(response(h).fallbackReason)).not.toContain("pre-compaction");
    // The selected ancestry's own persisted compaction does. The batch that follows is mixed — entries
    // from before and after the boundary — and runs as subagent for all of it.
    h.compaction();
    await work(h, long("after"));
    expect(lastRun(h).mode).toBe("subagent");
    expect(response(h).requestedMode).toBe("fork"); // the configured/requested mode is preserved
    expect(String(response(h).fallbackReason)).toContain("pre-compaction evidence");
    expect(h.memory.store.forkSuppression(1)).toBeNull(); // not the cache-miss latch, and no enrollment change
    const sent = String(h.conversations.at(-1)!.messages[0]!.content);
    expect(sent).toContain("[Source entry id: T1#user]"); // full primary material for the whole batch
    expect(sent).toContain("HEAD"); expect(sent).toContain("after");
    // Reopening re-reads the ancestry: the boundary is not cached, and the answer does not change.
    await h.emit("session_start");
    await work(h, long("reopened"));
    expect(lastRun(h).mode).toBe("subagent");
    expect(String(response(h).fallbackReason)).toContain("pre-compaction evidence");
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 14: a task whose frozen entries all follow the boundary keeps the configured mode, and the requested/actual audit is unchanged", async () => {
  const h = host(eager);
  try {
    h.compaction(); // the boundary is already in the ancestry; every entry below is post-compaction
    failing(h);
    await h.prompt(long("HEAD")); await h.answer(); await h.emit("agent_settled"); await h.drain();
    await work(h, long("post"));
    // Nothing selected precedes the boundary, so the rule does not fire: this task keeps the requested
    // fork mode and falls back only for the reason it would have without any compaction at all.
    expect(response(h).requestedMode).toBe("fork");
    expect(String(response(h).fallbackReason)).not.toContain("pre-compaction");
    expect(String(response(h).fallbackReason)).toContain("No current-branch provider payload captured");
    expect(h.memory.store.forkSuppression(1)).toBeNull();
  } finally { await h.dispose(); }
});

test("20c 2026-09-08 scenario 13/14 (native): a real persisted compaction downgrades the next Noter, while the fork already running keeps its own frozen context", async () => {
  const f = await fixture();
  try {
    let release!: (value: Response) => void;
    const held = new Promise<Response>(resolve => { release = resolve; });
    let first = true;
    f.script(body => {
      if (!worker(body)) return say("好的。");
      if (toolResults(body)) return say("Done.");
      if (first) { first = false; return held; }
      return call("t2", "note", noteBatch);
    });
    await f.turn("用 pnpm，不要 npm " + "word ".repeat(400)); // a real fork Noting starts, holding its first request open
    await vi.waitFor(() => expect(f.sent.filter(b => worker(b))).toHaveLength(1), { timeout: 5000 });
    // The foreground compacts while that fork is in flight, and Pi persists the compaction entry.
    await f.h.emit("session_before_compact", { preparation: { tokensBefore: 100 } });
    const boundary = f.manager().appendCompaction("native summary", f.manager().getLeafId()!, 100);
    await f.h.emit("session_compact", { compactionEntry: { summary: "native summary" } });
    expect(boundary).toBeTruthy();
    release(call("t1", "note", noteBatch));
    const run = await vi.waitFor(() => { const r = f.h.memory.store.listRuns(1)[0]; expect(r?.response).toBeTruthy(); return r!; }, { timeout: 5000 });
    // Not restarted, not replayed, not cancelled: the running fork finished against its frozen context.
    expect(run.mode).toBe("fork");
    expect(JSON.parse(run.response!).fallbackReason).toBeUndefined();
    expect(f.h.memory.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(1);
    expect(f.h.memory.store.listSessionFacts(1).length).toBeGreaterThan(0); // its commit stands
    // New foreground work whose entries precede the persisted boundary: the next Noter runs fresh.
    f.manager().appendMessage({ role: "user", content: "word ".repeat(400), timestamp: 1 } as never);
    f.manager().appendMessage({ ...reply("an answer " + "word ".repeat(400)), timestamp: 1 } as never);
    f.manager().appendCompaction("second native summary", f.manager().getLeafId()!, 100);
    await f.h.emit("message_start", { message: reply("") });
    const second = await vi.waitFor(() => { const runs = f.h.memory.store.listRuns(1).filter(r => r.kind === "noting");
      expect(runs).toHaveLength(2); expect(runs[1]!.response).toBeTruthy(); return runs[1]!; }, { timeout: 5000 });
    expect(second.mode).toBe("subagent");
    const audit = JSON.parse(second.response!);
    expect(audit.requestedMode).toBe("fork");
    expect(String(audit.fallbackReason)).toContain("pre-compaction evidence");
  } finally { await f.dispose(); }
}, 30000);
