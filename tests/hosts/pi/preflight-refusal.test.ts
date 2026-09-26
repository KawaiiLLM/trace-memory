import { expect, test } from "vitest";
import { host, reply } from "./test-host.ts";

const cases = (["noting", "consolidation"] as const).flatMap(phase =>
  (["unknown", "capacity"] as const).map(route => ({ phase, route })));

async function pending(phase: "noting" | "consolidation") {
  const h = host({ "noting.forkModeDefault": true, "noting.triggerTokens": phase === "noting" ? 20 : 1e9,
    "consolidation.triggerTokens": 1, "consolidation.forkModeDefault": true,
    [`${phase}Model`]: "fake/test-thinking", [`${phase}Thinking`]: "high" });
  await h.emit("session_start");
  if (phase === "consolidation") {
    await h.prompt("seed"); await h.answer("seed reply");
    h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 })
      .find(tool => tool.name === "note")!.execute({ facts: [{ text: "A pending fact", source: ["T1#E1"] }] });
  }
  h.setThinkingLevel("high");
  h.ctx.model = { ...h.ctx.model!, contextWindow: 50_000 };
  await h.prompt("word ".repeat(200));
  const start = (shuttingDown = () => false) => {
    const captured = h.emit("before_provider_request", { payload: { model: "test", messages: [{ role: "user", content: "hi" }] } });
    if (shuttingDown()) return Promise.all([captured]);
    h.persist(reply("word ".repeat(200)));
    return Promise.all([captured, h.emit("agent_end")]);
  };
  return { h, start };
}

test.each(cases)("$phase $route preflight preserves first-admission thinking", async ({ phase, route }) => {
  const { h, start } = await pending(phase);
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
    const { h, start } = await pending(phase);
    try {
      let cancelled: Promise<unknown> | undefined, cancelling = false;
      const cancelNow = () => {
        // Inject one user action. Its status notice may read context usage synchronously too.
        if (cancelling) return;
        cancelling = true;
        cancelled = cancel === "shutdown" ? h.emit("session_shutdown") : h.commands.get("trace")!.handler(cancel, h.ctx);
      };
      h.ctx.getContextUsage = () => {
        if (route === "unknown") cancelNow();
        return { tokens: route === "unknown" ? null : 40_000, contextWindow: 50_000, percent: null };
      };
      const ending = start(() => cancel === "shutdown" && cancelled !== undefined);
      if (route === "capacity") cancelNow(); // after freeze rejection, before its catch/reroute microtask
      await ending; await cancelled; await h.drain();
      expect(cancelled).toBeDefined();
      expect(h.requests).toHaveLength(0);
      expect(h.notices.filter(notice => notice.includes("fell back to subagent mode"))).toEqual([]);
    } finally { await h.dispose(); }
  });
