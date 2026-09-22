import { expect, test, vi } from "vitest";
import { emptyNote, host, reply } from "./test-host.ts";

const compact = (h: ReturnType<typeof host>, signal?: AbortSignal) =>
  h.emit("session_before_compact", { preparation: { tokensBefore: 100000 }, signal }) as Promise<any>;

// Restoring persisted history imports it without scheduling. The first compaction owns one bounded
// Noter recovery; the second has the same target and frozen boundary, so it can only wait for it.
test("64c review: cancelling a compatible compaction waiter leaves its Noter owner alive", async () => {
  const h = host({ "noting.triggerTokens": 20, "consolidation.triggerTokens": 20,
    "compaction.factsTokens": 1, "compaction.rawTokens": 1, "render.entryTokens": 2_000 });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    h.provider(async conversation => { await held; return emptyNote(conversation) ?? reply("Done."); });
    for (let i = 0; i < 12; i++) {
      h.persist({ role: "user", content: `persisted source ${i} ` + "word ".repeat(3_000), timestamp: 1 });
      h.persist(reply("recorded"));
    }
    await h.emit("session_start");
    expect(h.requests).toEqual([]);
    const path = h.memory.store.knowledgePath(1, "main");
    const before = h.memory.pendingEntries(1, "main", path.headTurnId!).length;
    const owner = compact(h);
    await vi.waitFor(() => expect(h.requests).toHaveLength(1));
    const claim = h.memory.store.getClaim(1, "noting");
    expect(claim).not.toBeNull();

    const controller = new AbortController();
    const waiter = compact(h, controller.signal);
    await vi.waitFor(() => expect(h.notices.some(n => n.includes("waiting for the running Noting task"))).toBe(true));
    controller.abort();
    expect(await waiter).toEqual({ cancel: true });
    expect(h.memory.store.getClaim(1, "noting")).toEqual(claim);
    expect(h.signals[0]!.aborted).toBe(false);
    expect(h.requests).toHaveLength(1);

    release();
    expect(await owner).toBeUndefined();
    await h.drain();
    expect(h.notices.at(-1)).toContain("native delegation");
    expect(h.memory.store.listRuns(1).filter(run => run.kind === "noting")).toMatchObject([{ outcome: "success" }]);
    expect(h.memory.store.listRuns(1).filter(run => run.kind === "noting")).toHaveLength(1);
    expect(h.memory.store.db.prepare("SELECT * FROM task_executions WHERE phase = 'noting'").all()).toHaveLength(1);
    const remaining = h.memory.pendingEntries(1, "main", path.headTurnId!).length;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThan(before);
    expect(h.memory.store.enabled(1)).toBe(true);
  } finally { release(); await h.dispose(); }
});
