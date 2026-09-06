import { expect, test, vi } from "vitest";
import { host } from "./test-host.ts";

// Exercise the installed pi-ai adapter, replacing only HTTP, not complete/onPayload.
test("real pi-ai serialization sends the preserved body and reports cache reads", async () => {
  const h = host({ "note.triggerAnsweredTurns": 1 });
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
    await h.emit("before_provider_request", { payload: captured });
    await h.turn(); await h.emit("session_shutdown", { reason: "new" });
    // SDK initialization can outlast the stub host's short drain.
    await vi.waitFor(() => expect(h.memory.store.listRuns(1)).toHaveLength(1));
    const run = h.memory.store.listRuns(1)[0]!;
    expect(run.outcome).toBe("success"); expect(run.mode).toBe("branch");
    expect(sent).toHaveLength(1); expect(JSON.parse(run.request!)).toEqual(sent[0]);
    expect(Buffer.from(JSON.stringify((sent[0]!.messages as unknown[]).slice(0, -1))))
      .toEqual(Buffer.from(JSON.stringify(captured.messages)));
    expect(sent[0]!.tools).toEqual(captured.tools); expect(sent[0]!.temperature).toBe(0.123);
    expect(JSON.parse(run.response!).verification).toMatchObject({ passed: true, cache_read: 12 });
  } finally { await h.dispose(); vi.unstubAllGlobals(); }
});
