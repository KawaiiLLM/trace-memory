import { expect, test, vi } from "vitest";
import * as api from "../../../src/core/api/index.ts";
import { host, reply } from "./test-host.ts";

test.each(["automatic", "catchup", "recovery"] as const)("%s releases a rejected slot once and admits later work without completion chaining", async mode => {
  const create = api.TraceMemory, facades: ReturnType<typeof create>[] = [];
  const factory = vi.spyOn(api, "TraceMemory").mockImplementation((...args) => {
    const memory = create(...args); facades.push(memory); return memory;
  });
  const h = host({ "noting.triggerTokens": 1e9, "consolidation.triggerTokens": 1e9,
    "compaction.rawTokens": 1, "compaction.overflowTokens": 1 });
  factory.mockRestore();
  const runtime = facades[0]!;
  try {
    await h.turn();
    runtime.config.noting.triggerTokens = 20;
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
    expect(release).toHaveBeenCalledTimes(1);
    expect(runtime.store.getClaim(1, "noting")).toBeNull();
    const requests = h.requests.length;
    await h.drain();
    expect(h.requests).toHaveLength(requests);
    release.mockRestore();
  } finally { vi.restoreAllMocks(); await h.dispose(); }
});
