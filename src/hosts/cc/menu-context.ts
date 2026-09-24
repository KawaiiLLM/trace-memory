import { tokens } from "../../core/render/tokens.ts";
import { measureRetainedMemoryText } from "../../core/render/material.ts";
import { databaseIdentity, decodeCcInjection, selectedCcVisibleRecords } from "./injection.ts";
import type { CcSessionBinding } from "./binding.ts";
import type { CcNativeRecord } from "./transcript.ts";

export interface CcContextEvidence {
  presence: "confirmed" | "unavailable";
  reason?: string;
  estimatedMessagesTokens?: number;
  memory?: { knowledge: number; facts: number; raw: number; unclassified: number };
}
export interface CcApiMessage { role: "user" | "assistant"; content: Array<Record<string, unknown>> }
export interface CcContextSnapshot { session: string; messages: CcApiMessage[] }

const unavailable = (reason: string): CcContextEvidence => ({ presence: "unavailable", reason });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const memoryKeys = ["knowledge", "facts", "raw", "unclassified"] as const;
type Amounts = Record<typeof memoryKeys[number], number>;
const zero = (): Amounts => ({ knowledge: 0, facts: 0, raw: 0, unclassified: 0 });

function originalSlice(rendered: string, original: string, preview: string): { offset: number; length: number } | null {
  if (rendered.includes(original)) {
    if (rendered.indexOf(original) !== rendered.lastIndexOf(original)) return null;
    return { offset: rendered.indexOf(original), length: original.length };
  }
  // Native persisted-output is bounded; the recorded preview, not a reconstructed wrapper or
  // referenced full-output file, defines precisely which prefix entered Messages.
  const match = /(?:^|\n)Preview \(first 2KB\):\n([\s\S]*?)\n\.\.\.\n<\/persisted-output>/.exec(preview);
  if (!match || !match[1] || !original.startsWith(match[1])) return null;
  const offset = rendered.indexOf(match[1]);
  if (offset < 0 || rendered.indexOf(match[1], offset + 1) >= 0) return null;
  return { offset, length: match[1].length };
}

function estimateBlock(block: Record<string, unknown>): number | null {
  if (block.type === "text" && typeof block.text === "string") return tokens(block.text);
  if (block.type === "thinking" && typeof block.thinking === "string") return tokens(block.thinking);
  if (block.type === "tool_use" && typeof block.name === "string" && object(block.input)) return tokens(block.name + JSON.stringify(block.input));
  if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
    const content = block.content;
    if (typeof content === "string") return tokens(content);
    if (Array.isArray(content) && content.every(part => object(part) && part.type === "text" && typeof part.text === "string"))
      return content.reduce((sum: number, part) => sum + tokens(part.text), 0);
  }
  // An image/document/unknown block has no defensible local text-only denominator. Never count
  // base64 media as prose and never claim a complete scaled split from an incomplete snapshot.
  return null;
}

/** The native attachment supplies exact rendered bytes; its parent hook_success supplies the
 * authenticated envelope. A lookalike user quotation is not a carrier merely because it includes
 * TRACE-MEMORY-CC/1. No referenced full-output file is opened. */
export function ccContextEvidence(records: readonly CcNativeRecord[], binding: CcSessionBinding,
  dbPath: string, snapshot?: CcContextSnapshot): CcContextEvidence {
  if (!snapshot) return unavailable("current Messages snapshot unavailable");
  if (snapshot.session !== binding.nativeSessionId) return unavailable("native session changed");
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length >= 4096) return unavailable("Messages snapshot incomplete");
  let selected: CcNativeRecord[];
  try { selected = selectedCcVisibleRecords(records); }
  catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
  if (!selected.length) {
    // Before the first source reply the native source-path resolver has no leaf. A single complete
    // attachment chain is still authoritative; sibling chains without a selected leaf are not.
    const nodes = records.filter(record => typeof record.uuid === "string" && record.isSidechain !== true);
    const seen = new Set<string>();
    for (const node of nodes) {
      if (seen.has(node.uuid!)) return unavailable("ambiguous native attachment chain");
      seen.add(node.uuid!);
    }
    if (nodes.length && (nodes[0]!.parentUuid !== null || nodes.some((node, index) => index > 0 &&
      node.parentUuid !== nodes[index - 1]!.uuid))) return unavailable("native attachment chain is not uniquely selected");
    selected = nodes;
  }
  const byId = new Map(selected.filter(record => typeof record.uuid === "string").map(record => [record.uuid, record]));
  const carriers = new Map<string, { original: string; preview: string }>();
  const unverified = new Set<string>();
  const identity = { db: databaseIdentity(dbPath), nativeSession: binding.nativeSessionId, coreSession: binding.coreSessionId };
  for (const record of selected) {
    const a = record.attachment;
    if (record.type !== "attachment" || record.isSidechain === true || !object(a) || a.type !== "hook_additional_context" ||
      a.hookEvent !== "SessionStart" || !Array.isArray(a.content) || !Array.isArray(record.rendered)) continue;
    if (a.content.length !== 1 || typeof a.content[0] !== "string" || record.rendered.length !== 1 ||
      !object(record.rendered[0]) || typeof record.rendered[0].content !== "string") continue;
    const rendered = record.rendered[0].content;
    // An unproven native memory-looking attachment cannot be counted as zero if still present.
    if (rendered.includes("TRACE-MEMORY-CC/1 ")) unverified.add(rendered);
    let parent = typeof record.parentUuid === "string" ? byId.get(record.parentUuid) : undefined;
    // Native truncation warnings insert hook_system_message between this attachment and its
    // SessionStart success. Other intervening records do not establish a correspondence.
    while (parent && object(parent.attachment) && parent.attachment.type === "hook_system_message" &&
      parent.attachment.hookEvent === "SessionStart")
      parent = typeof parent.parentUuid === "string" ? byId.get(parent.parentUuid) : undefined;
    const p = parent?.attachment;
    if (!parent || !object(p) || p.type !== "hook_success" || p.hookEvent !== "SessionStart" || typeof p.stdout !== "string") continue;
    let output: unknown;
    try { output = JSON.parse(p.stdout); } catch { continue; }
    const hook = object(output) && object(output.hookSpecificOutput) ? output.hookSpecificOutput : null;
    const original = hook?.additionalContext;
    if (typeof original !== "string" || !decodeCcInjection(original, identity)) continue;
    if (carriers.has(rendered)) return unavailable("ambiguous repeated native carrier");
    unverified.delete(rendered);
    carriers.set(rendered, { original, preview: a.content[0] });
  }
  const memory = zero();
  let estimatedMessagesTokens = 0;
  const matched = new Set<string>();
  for (const message of snapshot.messages) {
    if (!object(message) || (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content))
      return unavailable("unsupported Messages content");
    for (const block of message.content) {
      if (!object(block)) return unavailable("unsupported Messages content");
      const amount = estimateBlock(block);
      if (amount === null) return unavailable("unsupported Messages content");
      estimatedMessagesTokens += amount;
      if (message.role !== "user" || block.type !== "text" || typeof block.text !== "string") continue;
      if (unverified.has(block.text)) return unavailable("native memory carrier could not be authenticated");
      const carrier = carriers.get(block.text);
      if (!carrier) {
        if (block.text.startsWith("<system-reminder>\nSessionStart hook additional context:") &&
          block.text.includes("TRACE-MEMORY-CC/1 ")) return unavailable("native memory carrier is missing from selected transcript");
        continue;
      }
      if (matched.has(block.text)) return unavailable("ambiguous repeated Messages carrier");
      matched.add(block.text);
      const slice = originalSlice(block.text, carrier.original, carrier.preview);
      if (!slice) return unavailable("native carrier preview cannot be measured");
      const parts = measureRetainedMemoryText(block.text, carrier.original, slice.offset, slice.length);
      for (const key of memoryKeys) memory[key] += parts[key];
    }
  }
  return { presence: "confirmed", estimatedMessagesTokens, memory };
}
