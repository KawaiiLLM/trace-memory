// 78: a minimal Anthropic Messages API loopback, for the native probes that must exercise the real,
// pinned `claude` executable without a real model call. It runs on 127.0.0.1 only, replies to every
// `POST /v1/messages` with a single streamed assistant turn built by the caller's own `respond`
// callback (given how many assistant turns the conversation already holds), and never touches the
// network beyond that loopback socket.
import { createServer, type Server } from "node:http";

export type LoopbackBlock = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };
export interface LoopbackTurn { blocks: LoopbackBlock[]; stopReason: "end_turn" | "tool_use" }
export interface LoopbackServer { url: string; close(): Promise<void> }

export async function startLoopbackAnthropic(respond: (assistantTurns: number, body: unknown) => LoopbackTurn): Promise<LoopbackServer> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) { res.writeHead(404); res.end(); return; }
      let body: { messages?: { role?: string }[] };
      try { body = JSON.parse(raw); } catch { res.writeHead(400); res.end(); return; }
      const assistantTurns = (body.messages ?? []).filter(message => message.role === "assistant").length;
      const turn = respond(assistantTurns, body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { id: `loopback-${assistantTurns}`, type: "message", role: "assistant",
        model: "claude-sonnet-4-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      turn.blocks.forEach((block, index) => {
        send("content_block_start", { type: "content_block_start", index, content_block: block.type === "text"
          ? { type: "text", text: "" } : { type: "tool_use", id: block.id, name: block.name, input: {} } });
        send("content_block_delta", { type: "content_block_delta", index, delta: block.type === "text"
          ? { type: "text_delta", text: block.text } : { type: "input_json_delta", partial_json: JSON.stringify(block.input) } });
        send("content_block_stop", { type: "content_block_stop", index });
      });
      send("message_delta", { type: "message_delta", delta: { stop_reason: turn.stopReason, stop_sequence: null }, usage: { output_tokens: 5 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  const port = process.env.TM_NATIVE_PREPARED_PORT ? Number(process.env.TM_NATIVE_PREPARED_PORT) : 0;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  if (port && (server.address() as { port: number }).port !== port) throw new Error("native mock failed to bind prepared port");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("loopback server did not bind a TCP port");
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise((resolve, reject) =>
    server.close(error => error ? reject(error) : resolve())) };
}
