import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { SourceNormalizationError, type SourceNormalizer, type SourceBlock } from "../../core/model/source.ts";

/** Shared by ingestion and snapshot readiness; Pi owns the persisted entry schema. */
export function piPersistedSource(entry: SessionEntry) {
  if (entry.type !== "message") return;
  const message = entry.message;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") return;
  const natural = message.role === "toolResult" ? "" : typeof message.content === "string" ? message.content
    : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
  const calls = message.role === "assistant" ? message.content.filter(block => block.type === "toolCall") : [];
  if (message.role === "assistant" && !natural && !calls.length && !message.content.some(block => block.type === "thinking")) return;
  return { id: entry.id, message, text: natural, calls };
}

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
    const matches = entry.calls.filter(call => call.callId === message.toolCallId);
    if (matches.length !== 1) throw new SourceNormalizationError();
    const call = matches[0]!;
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
      const matches = entry.calls.filter(call => call.callId === block.id);
      if (matches.length !== 1 || seen.has(block.id)) throw new SourceNormalizationError();
      const call = matches[0]!;
      seen.add(call.callId);
      blocks.push({ kind: "call", call: { ...call, name: block.name, input: JSON.stringify(block.arguments), status: "attempted" } });
    } else blocks.push({ kind: "marker", text: marker(block?.type) });
  }
  return blocks;
};
