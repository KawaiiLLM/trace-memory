import { expect, test } from "vitest";
import { host, reply } from "./test-host.ts";

const cases = (["unknown", "capacity"] as const).map(route => ({ phase: "noting" as const, route }));

async function pending() {
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": 20,
    notingModel: "fake/test-thinking", notingThinking: "high" });
  await h.emit("session_start");
  h.setThinkingLevel("high");
  h.ctx.model = { ...h.ctx.model!, contextWindow: 50_000 };
  await h.prompt("word ".repeat(200));
  const start = async () => {
    await h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: "hi" }] } });
    h.persist(reply("word ".repeat(200)));
    await h.emit("agent_end");
    await h.emit("agent_settled");
  };
  return { h, start };
}

test.each(cases)("$phase $route preflight preserves first-admission thinking", async ({ phase, route }) => {
  const { h, start } = await pending();
  try {
    h.ctx.getContextUsage = () => {
      // This callback runs after admission freezes policy, before either host preflight refusal.
      h.setThinkingLevel("low");
      return { tokens: route === "unknown" ? null : 40_000, contextWindow: 50_000, percent: null };
    };
    await start(); await h.drain();
    const runs = h.memory.store.listRuns(1).filter(run => run.kind === phase && run.response);
    expect(runs).toHaveLength(1);
    const response = JSON.parse(runs[0]!.response!);
    expect(response.thinking.effective).toBe("high");
    expect(runs[0]!.model).toBe("fake/test-thinking");
    expect(response.fallbackReason).toContain(route === "unknown" ? "unknown context measure" : "inherited context 40000");
    expect(h.requests.length).toBeGreaterThan(0);
  } finally { await h.dispose(); }
});

test.each(cases.flatMap(value => (["stop", "off", "shutdown"] as const).map(cancel => ({ ...value, cancel }))))(
  "$phase $route preflight cannot continue after $cancel", async ({ phase, route, cancel }) => {
    const { h, start } = await pending();
    try {
      let cancelled: Promise<unknown> | undefined, cancelling = false;
      const cancelNow = () => {
        // Inject one user action. Its status notice may read context usage synchronously too.
        if (cancelling) return;
        cancelling = true;
        cancelled = cancel === "shutdown" ? h.emit("session_shutdown") : h.commands.get("trace")!.handler(cancel, h.ctx);
      };
      h.ctx.getContextUsage = () => {
        cancelNow(); // during frozen admission's capacity preflight, before fallback begins
        return { tokens: route === "unknown" ? null : 40_000, contextWindow: 50_000, percent: null };
      };
      await start(); await cancelled; await h.drain();
      expect(cancelled).toBeDefined();
      expect(h.requests).toHaveLength(0);
      expect(h.notices.filter(notice => notice.includes("fell back to subagent mode"))).toEqual([]);
    } finally { await h.dispose(); }
  });
