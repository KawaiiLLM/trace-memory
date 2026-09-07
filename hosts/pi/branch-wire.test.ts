import { recorded } from "../../test/source-fixture.ts";
import { hash } from "./branch.ts";
import { expect, test, vi } from "vitest";
import { host } from "./test-host.ts";

// Exercise the installed pi-ai adapter, replacing only HTTP, not complete/onPayload.
test("real pi-ai serialization sends the preserved body and reports cache reads", async () => {
  const h = host({ "noting.triggerTokens": 60 });
  const sent: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const chunk = { id: "fake", object: "chat.completion.chunk", created: 1, model: "test",
      choices: [{ index: 0, delta: { role: "assistant", content: "[]" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22, prompt_tokens_details: { cached_tokens: 12 } } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }));
  try {
    h.ctx.model = { ...h.ctx.model!, name: "Test", baseUrl: "https://fake.invalid", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 100 };
    const captured = { model: "test", stream: true, temperature: 0.123, messages: [
      { role: "system", content: " Exact\n  system 漢字" }, { role: "user", content: "original" },
    ], tools: [{ type: "function", function: { name: "trace", description: "Read", parameters: { type: "object", properties: {} } } }],
    stream_options: { include_usage: true } };
    await h.prompt(); await h.emit("before_provider_request", { payload: captured });
    await h.answer(); await h.emit("agent_settled"); await h.drain();
    // 17c 2026-09-08: shutdown cancels; wait for this wire-verification run explicitly.
    await vi.waitFor(() => expect(h.memory.store.listRuns(1)).toHaveLength(1));
    await h.emit("session_shutdown", { reason: "new" });
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.outcome).toBe("success"); expect(run.mode).toBe("branch");
    expect(sent).toHaveLength(1); expect(JSON.parse(run.request!)).toEqual(sent[0]);
    expect(Buffer.from(JSON.stringify((sent[0]!.messages as unknown[]).slice(0, -1))))
      .toEqual(Buffer.from(JSON.stringify(captured.messages)));
    expect(sent[0]!.tools).toEqual(captured.tools); expect(sent[0]!.temperature).toBe(0.123);
    expect(JSON.parse(run.response!).verification).toMatchObject({ passed: true, cache_read: 12 });
  } finally { await h.dispose(); vi.unstubAllGlobals(); }
});

test("real Anthropic Consolidation tool continuation preserves signed thinking and the captured prefix", async () => {
  const h = host({ "noting.triggerTokens": 1000000000, "consolidation.triggerUnconsolidatedFacts": 1, "consolidation.subagentModeDefault": false });
  const sent: Record<string, any>[] = [];
  const batch = { operations: [], skipped: [{ fact: "F1", because: "Not durable." }] };
  vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const round = sent.length, tool = round <= 2;
    const events = [
      { type: "message_start", message: { id: `msg_${round}`, type: "message", role: "assistant", model: "claude-test", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } },
      ...(tool ? [
        { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Review evidence" } },
        { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: `signed-${round}` } },
        { type: "content_block_stop", index: 0 },
        { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: `tool_${round}`, name: "memory", input: {} } },
        { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: JSON.stringify(batch) } },
        { type: "content_block_stop", index: 1 },
      ] : [
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done" } },
        { type: "content_block_stop", index: 0 },
      ]),
      { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ];
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }));
  try {
    h.ctx.model = { ...h.ctx.model!, provider: "anthropic", id: "claude-test", api: "anthropic-messages", name: "Test", baseUrl: "https://fake.invalid", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 };
    await h.turn();
    const tools = h.memory.tools({ kind: "manual", sessionId: 1, branch: "main", currentTurnId: 1 });
    tools[2]!.execute({ facts: [{ category: "decision", actor: "user", text: "Use pnpm", source: ["T1#user"] }] });
    recorded(h.memory, 1, "main", 1); // T1 recorded: F1 may enter the Consolidation batch
    const captured = { model: "claude-test", stream: true, max_tokens: 1000, thinking: { type: "enabled", budget_tokens: 500 }, system: [{ type: "text", text: "Exact signed-thinking prefix", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "Original", cache_control: { type: "ephemeral" } }] }],
      tools: tools.map((t, i) => ({ name: t.name, description: t.description, input_schema: t.parameters, ...(i === tools.length - 1 ? { cache_control: { type: "ephemeral" } } : {}) })) };
    await h.emit("before_provider_request", { payload: captured });
    await h.answer("tick"); await h.emit("agent_settled");
    // 17c 2026-09-08: completion is observed before shutdown, which now cancels workers.
    await vi.waitFor(() => expect(JSON.parse(h.memory.store.listRuns(1).find(r => r.kind === "consolidation")?.response ?? "{}").output).toBe("Done"));
    await h.emit("session_shutdown");
    const run = h.memory.store.listRuns(1).find(r => r.kind === "consolidation")!;
    expect(run.outcome, run.response ?? "").toBe("success");
    expect(sent).toHaveLength(3);
    for (const body of sent) {
      expect(JSON.stringify(body).match(/"cache_control"/g)).toHaveLength(3);
      expect(body.system).toEqual(captured.system); expect(body.tools).toEqual(captured.tools); expect(body.thinking).toEqual(captured.thinking);
      expect(body.messages.slice(0, captured.messages.length)).toEqual(captured.messages);
    }
    const replay = sent[1]!.messages.find((m: any) => m.role === "assistant");
    expect(replay.content).toContainEqual({ type: "thinking", thinking: "Review evidence", signature: "signed-1" });
    expect(replay.content).toContainEqual({ type: "tool_use", id: "tool_1", name: "memory", input: batch });
    expect(sent[1]!.messages.at(-1).role).toBe("user");
    expect(JSON.stringify(sent[1]!.messages.at(-1))).toContain("NEAR:");
    expect(JSON.parse(run.request!)).toEqual(sent[2]);
    expect(JSON.parse(run.response!).toolCalls).toHaveLength(2);
    expect(JSON.parse(run.response!).verification.rounds).toEqual(sent.slice(1).map((body, i) => expect.objectContaining({ passed: true, capturedHash: hash(sent[i]), requestHash: hash(body) })));
    expect(sent[2]!.messages.slice(0, sent[1]!.messages.length)).toEqual(sent[1]!.messages);
  } finally { await h.dispose(); vi.unstubAllGlobals(); }
});
