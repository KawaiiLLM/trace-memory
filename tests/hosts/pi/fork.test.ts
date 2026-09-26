import { expect, test } from "vitest";
import * as fork from "../../../src/hosts/pi/fork.ts";
import { host as createHost, notingFact } from "./test-host.ts";

// The legacy request-copy runner is gone. The independent model-freeze rule belongs to N now.
test("92: a model switch during Noting does not redirect its admitted run", async () => {
  const h = createHost({ "noting.triggerTokens": 30, "noting.forkModeDefault": false });
  let release!: () => void;
  try {
    await h.emit("session_start");
    let held = false;
    h.provider(async c => {
      if (!held) { held = true; await new Promise<void>(resolve => { release = resolve; }); }
      return notingFact(c);
    }, { autoStop: false });
    await h.prompt(); await h.answer(); await h.emit("agent_settled");
    await h.drain();
    expect(typeof release).toBe("function");
    h.ctx.model = { ...h.ctx.model!, id: "next" };
    release(); await h.drain();
    const runs = h.memory.store.listRuns(1).filter(r => r.kind === "noting");
    expect(runs.map(r => [r.model, r.outcome])).toEqual([["fake/test", "success"]]);
    expect(h.requests.map(r => (r as { model: string }).model)).toEqual(["test", "test"]);
  } finally { release?.(); await h.dispose(); }
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
