import type { SourceNormalizer, SourceBlock } from "../../core/model/source.ts";

/** Decode Pi's role/content envelope at ingestion or upgrade. Core never guesses whether a
 * generic host string is a Pi envelope. The native block list, not a projected call map, owns order. */
export const piSourceBlocks: SourceNormalizer = entry => {
  let message: Record<string, unknown>;
  try { message = JSON.parse(entry.raw); } catch { return undefined; }
  if (!message || message.role !== entry.role || !(typeof message.content === "string" || Array.isArray(message.content))) return undefined;
  const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
  const blocks: SourceBlock[] = [];
  const marker = (type: unknown) => `[${typeof type === "string" && /^[\w-]+$/.test(type) ? type : "non-text content"} omitted]`;
  if (entry.role === "toolResult") {
    const call = entry.calls.find(call => call.callId === message.toolCallId);
    if (!call) return []; // An absent native call identity is not reconstructed from a projection.
    return [{ kind: "result", call: { ...call, result: JSON.stringify({ content: message.content, details: message.details }),
      status: message.isError ? "failure" : "success" }, texts: content.filter(b => b?.type === "text" && typeof b.text === "string").map(b => b.text) }];
  }
  const seen = new Set<string>();
  for (const block of content) {
    if (block?.type === "text" && typeof block.text === "string") blocks.push({ kind: "text", text: block.text });
    else if (block?.type === "thinking") {
      blocks.push(block.redacted !== true && typeof block.thinking === "string" && block.thinking.length
        ? { kind: "thinking", text: block.thinking } : { kind: "marker", text: "[thinking unavailable]" });
    } else if (block?.type === "toolCall") {
      const call = entry.calls.find(call => call.callId === block.id);
      if (!call || seen.has(call.callId)) throw new Error("native tool call lacks a unique stored ordinal");
      seen.add(call.callId);
      blocks.push({ kind: "call", call: { ...call, name: block.name, input: JSON.stringify(block.arguments), status: "attempted" } });
    } else blocks.push({ kind: "marker", text: marker(block?.type) });
  }
  return blocks;
};
