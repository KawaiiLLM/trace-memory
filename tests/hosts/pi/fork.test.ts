import { expect, test } from "vitest";
import * as fork from "../../../src/hosts/pi/fork.ts";
import { host as createHost, reply, notingFact, consolidationReply } from "./test-host.ts";

// 19c: the request-copy runner is gone, and with it every test that drove it through a mocked
// `complete`. What is left here is the gate module's own unit coverage plus the two host rules that
// are runner-independent: the run's model is frozen at launch, and a fork with no usable capture
// falls back to a fresh-context child for both Consolidation rounds with one warning.

const consolidationOutput = consolidationReply();

test("17:01 2026-09-08: a model switch during the consolidation candidate round does not redirect or break the final round", async () => {
  const h = createHost({ "noting.triggerTokens": 20, "consolidation.triggerTokens": 1, "noting.forkModeDefault": false });
  try {
    await h.emit("session_start");
    let release!: () => void;
    h.provider(async c => {
      const last = String(c.messages.at(-1)!.content);
      if (/Range: F/.test(last)) await new Promise<void>(resolve => { release = resolve; });
      if (c.messages.filter(m => m.role === "toolResult").length >= 2) return reply("Done.");
      if (/Range: F/.test(last) || /NEAR:/.test(last)) return consolidationOutput;
      return notingFact(c);
    }, { autoStop: false });
    await h.prompt(); await h.answer(); await h.emit("agent_settled"); await h.drain();
    await h.prompt(); // the noting's facts reach the conversation
    await h.emit("agent_settled"); await h.answer("tick"); await h.drain();
    h.ctx.model = { ...h.ctx.model!, id: "next" }; // The user switches the session model mid-consolidation.
    release(); await h.drain();
    const runs = h.memory.store.listRuns(1).filter(r => r.kind === "consolidation");
    expect(runs.map(r => [r.model, r.outcome])).toEqual([["fake/test", "success"]]);
    // Every request of that run went to the frozen model, including the final round.
    expect(h.requests.map(r => (r as { model: string }).model)).not.toContain("next");
  } finally { await h.dispose(); }
});

// 25b withdrew this phase's fork preference, so there is no capture to be missing and no fallback to
// announce: both rounds run in a fresh child on the configured Consolidator model, with no notice.
test("25b: consolidation runs both rounds in a fresh child on its own model, with nothing to fall back from", async () => {
  const h = createHost({ "noting.triggerTokens": 20, "consolidation.triggerTokens": 1, "noting.forkModeDefault": false, notingModel: "fake/noter", consolidationModel: "fake/Consolidator" });
  try {
    h.provider(async c => c.systemPrompt!.includes("### Second-round user message") ? consolidationOutput : notingFact(c));
    await h.turn();
    await h.prompt(); // the noting's facts reach the conversation first
    await h.emit("agent_settled"); await h.answer("tick"); await h.drain();
    const runs = h.memory.store.listRuns(1).filter(r => r.kind === "consolidation");
    expect(runs.map(r => [r.mode, r.model, r.outcome])).toEqual([["subagent", "fake/Consolidator", "success"]]);
    expect(JSON.parse(runs[0]!.response!).fallbackReason).toBeUndefined(); // nothing was requested and refused
    expect(JSON.parse(runs[0]!.response!).toolCalls).toHaveLength(2); // both submissions ran in the fresh child
    expect(h.notices.filter(n => n.includes("consolidation fell back"))).toEqual([]);
  } finally { await h.dispose(); }
});

test("19a ruling 2026-09-08: the fork gate ignores cache_control placement and no other difference", () => {
  const api = "anthropic-messages";
  const parent = { model: "m", system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }, { role: "assistant", content: [{ type: "text", text: "ok" }] }] };
  const child = { model: "m", system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }], temperature: 0,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "text", text: "task", cache_control: { type: "ephemeral" } }] }] };
  // The raw comparison fails exactly where the adapter moved the breakpoint; the gate passes.
  expect(fork.verifyNativeRequest(parent, child, api, child.messages.slice(2)).differingPath).toBe("$.messages.0.content.0.cache_control");
  const gate = fork.verifyForkRequest(parent, child, api);
  expect(gate.passed).toBe(true);
  expect(gate.normalized).toEqual(["cache_control"]);
  expect(gate.appendedMessages).toEqual([{ role: "user", content: [{ type: "text", text: "task" }] }]);
  // Hashes are of the raw bodies, so the audit still records what was actually sent.
  expect(gate.capturedHash).toBe(fork.hash(parent));
  expect(gate.requestHash).toBe(fork.hash(child));
  // Any other difference still fails: a sampling field, a system prompt byte, a tool definition.
  expect(fork.verifyForkRequest(parent, { ...child, temperature: 1 }, api).differingPath).toBe("$.temperature");
  expect(fork.verifyForkRequest(parent, { ...child, system: [{ type: "text", text: "sys!" }] }, api).differingPath).toBe("$.system.0.text");
  expect(fork.verifyForkRequest({ ...parent, tools: [{ name: "a", description: "d", input_schema: {} }] }, { ...child, tools: [{ name: "a", description: "e", input_schema: {} }] }, api).differingPath).toBe("$.tools.0.description");
  expect(fork.verifyForkRequest(parent, { ...child, messages: [...child.messages.slice(0, 1), { role: "assistant", content: [{ type: "text", text: "no" }] }, child.messages[2]] }, api).differingPath).toBe("$.messages.1.content.0.text");
});
