import { expect, test, vi } from "vitest";
import * as api from "../../../src/core/api/index.ts";
import { host, reply } from "./test-host.ts";

// 73: bounded recovery is deleted, so `session_before_compact` no longer admits a Noting task of its
// own — only the "automatic" and "catchup" triggers remain eligible for this slot-lifecycle case.
test.each(["automatic", "catchup"] as const)("%s releases a rejected slot once and admits later work without completion chaining", async mode => {
  const create = api.TraceMemory, facades: ReturnType<typeof create>[] = [];
  const factory = vi.spyOn(api, "TraceMemory").mockImplementation((...args) => {
    const memory = create(...args); facades.push(memory); return memory;
  });
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9, "dreaming.triggerTokens": 1,
    "compaction.rawTokens": 1 });
  factory.mockRestore();
  const runtime = facades[0]!;
  try {
    await h.turn();
    runtime.setKnowledgeBudget("global", 0);
    runtime.setKnowledgeBudget("project", 0);
    runtime.setKnowledgeBudget("session", 0);
    runtime.config.noting.triggerTokens = 0;
    runtime.config.consolidation.triggerTokens = 0;
    const start = async () => {
      if (mode === "automatic") { h.persist(reply("next eligible entry")); return h.emit("agent_end"); }
      if (mode === "catchup") return h.commands.get("trace").handler("catchup", h.ctx);
      return h.emit("session_before_compact", { preparation: { tokensBefore: 100000 } });
    };
    const admission = vi.spyOn(runtime, "noting").mockRejectedValue(new Error("slot admission rejected"));
    await start(); await h.drain();
    expect(admission).toHaveBeenCalledTimes(1);
    expect(h.notices.join("\n")).toContain("slot admission rejected");
    expect(h.requests).toEqual([]);
    expect(runtime.store.getClaim(1, "noting")).toBeNull();
    expect(h.statuses.get("trace-memory")).not.toMatch(/<(accent|success)>●/);
    if (mode === "catchup") {
      h.ctx.hasUI = false;
      await h.commands.get("trace").handler("", h.ctx);
      expect(h.notices.at(-1)).toContain("Catchup: failed");
    }
    admission.mockRestore();
    const release = vi.spyOn(runtime.store, "releaseClaim");
    await start(); await h.drain();
    expect(runtime.store.listRuns(1).filter(r => r.kind === "noting")).toMatchObject([{ outcome: "success" }]);
    expect(runtime.store.listRuns(1).filter(r => r.kind === "noting")).toHaveLength(1);
    // The released/reused slot must still send the normalized entry view, not the old labels.
    const run = runtime.store.listRuns(1).find(r => r.kind === "noting")!;
    const audit = JSON.parse(run.response!).entryAudit;
    expect(audit.viewVersion).toBe(api.ENTRY_VIEW_VERSION);
    expect(audit.viewBudgets).toEqual({ entryTokens: 2000, toolInputTokens: 100, toolResultTokens: 100 });
    expect(audit.entries.length).toBeGreaterThan(0);
    for (const { id } of audit.entries) {
      const entry = runtime.store.getSourceEntry(id)!;
      expect(entry.blocks?.length).toBeGreaterThan(0);
      expect(JSON.stringify(h.requests)).toContain(`[T${entry.turnId}#E${entry.entryOrdinal}@text]`);
    }
    expect(release).toHaveBeenCalledTimes(1);
    expect(runtime.store.getClaim(1, "noting")).toBeNull();
    const requests = h.requests.length;
    await h.drain();
    expect(h.requests).toHaveLength(requests);
    release.mockRestore();
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});
