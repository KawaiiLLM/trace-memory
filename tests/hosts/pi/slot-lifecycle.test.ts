import { expect, test, vi } from "vitest";
import * as api from "../../../src/core/api/index.ts";
import { host, reply } from "./test-host.ts";

// 73: bounded recovery is deleted, so `session_before_compact` no longer admits a Noting task of its
// own — only the "automatic" and "catchup" triggers remain eligible for this slot-lifecycle case.
test.each(["automatic", "catchup"] as const)("%s releases a rejected slot and permits later complete batches", async mode => {
  const create = api.TraceMemory, facades: ReturnType<typeof create>[] = [];
  const factory = vi.spyOn(api, "TraceMemory").mockImplementation((...args) => {
    const memory = create(...args); facades.push(memory); return memory;
  });
  const h = host({ "noting.triggerTokens": 1e9, "dreaming.triggerKnowledge": 1,
    "compaction.rawTokens": 1 });
  factory.mockRestore();
  const runtime = facades[0]!;
  try {
    await h.turn();
    runtime.setKnowledgeBase(0);
    runtime.config.noting.triggerTokens = 0;
    const start = async () => {
      if (mode === "automatic") { await h.prompt("next eligible turn"); return h.answer("next eligible entry"); }
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
    await start(); await h.drain();
    expect(runtime.progress(1, "main", runtime.store.listTurns(1).at(-1)!.id).entries).toBe(0);
    // The released/reused slot must still send the normalized entry view, not the old labels.
    const run = runtime.store.listRuns(1).find(r => r.kind === "noting")!;
    const audit = JSON.parse(run.response!).entryAudit;
    for (const { id } of audit.entries) {
      const entry = runtime.store.getSourceEntry(id)!;
      expect(JSON.stringify(h.requests)).toContain(`[T${entry.turnId}#E${entry.entryOrdinal}@${entry.role === "toolResult" ? "observation" : entry.role}]`);
    }
    expect(runtime.store.getClaim(1, "noting")).toBeNull();
    expect(runtime.store.getClaim(1, "noting", "knowledge")).toBeNull();
    const requests = h.requests.length;
    await h.drain();
    expect(h.requests).toHaveLength(requests);
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});
