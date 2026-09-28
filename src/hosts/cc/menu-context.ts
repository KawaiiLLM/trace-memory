import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { tokens } from "../../core/render/tokens.ts";
import { measureRetainedMemoryText } from "../../core/render/material.ts";
import { CC_INJECTION_HEADER, databaseIdentity, decodeCcInjection, decodeCcInjectionHeader, type CcVisibleBinding } from "./injection.ts";
import { COMPACTION_SUMMARY_SUFFIX, ccCarrierStart, ccStripAutoContinue } from "./transcript.ts";
import { estimateCcImageTokens } from "./image-tokens.ts";
import type { CcSessionBinding } from "./binding.ts";

export interface CcContextEvidence {
  presence: "confirmed" | "unavailable";
  reason?: string;
  estimatedMessagesTokens?: number;
  memory?: { knowledge: number; facts: number; raw: number; unclassified: number };
}
export interface CcApiMessage { role: "user" | "assistant"; content: Array<Record<string, unknown>> }
export interface CcContextSnapshot { session: string; model?: string; messages: CcApiMessage[] }

const unavailable = (reason: string): CcContextEvidence => ({ presence: "unavailable", reason });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const memoryKeys = ["knowledge", "facts", "raw", "unclassified"] as const;
const HOOK_CONTEXT = "<system-reminder>\nSessionStart hook additional context: ";
const HOOK_END = "\n</system-reminder>";
const PREVIEW_TITLE = "\n\nPreview (first 2KB):\n";

/** Current Messages is the occurrence/path authority (ticket 82). Only its native hook wrapper
 * is a candidate; quotes, tool results and ordinary envelope-looking prose are not carriers. */
function carrier(text: string, identity: CcVisibleBinding): { retained: string; offset: number } {
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!normalized.endsWith(HOOK_END)) throw new Error("malformed SessionStart memory context");
  const payload = normalized.slice(HOOK_CONTEXT.length, -HOOK_END.length);
  if (!payload.startsWith("<persisted-output>\n")) {
    const header = decodeCcInjection(payload, identity);
    if (!header) throw new Error("memory carrier failed identity or digest verification");
    return { retained: payload, offset: HOOK_CONTEXT.length };
  }
  const preview = /^<persisted-output>\n[^\n]*Full output saved to: ([^\n]+)\n\nPreview \(first 2KB\):\n([\s\S]+)\n\.\.\.\n<\/persisted-output>$/.exec(payload);
  if (!preview || !isAbsolute(preview[1]!)) throw new Error("malformed native memory preview");
  const retained = preview[2]!, header = decodeCcInjectionHeader(retained, identity);
  if (!header) throw new Error("memory preview failed identity verification");
  let full: string | undefined;
  try { full = readFileSync(preview[1]!, "utf8"); }
  catch (error) {
    // The maintainer permits identity-only evidence ONLY when the referenced native file is gone.
    // Permission/I/O errors are not absence and must never silently weaken verification.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (full !== undefined && (!decodeCcInjection(full, identity) || !full.startsWith(retained)))
    throw new Error("memory preview disagrees with its authenticated original");
  // The original, when available, verifies authenticity only. Neither classification nor token
  // accounting includes its omitted suffix; both use exactly the retained native prefix.
  return { retained, offset: HOOK_CONTEXT.length + payload.indexOf(PREVIEW_TITLE) + PREVIEW_TITLE.length };
}

function estimateBlock(block: Record<string, unknown>, model?: string): number | null {
  if (block.type === "text" && typeof block.text === "string") return tokens(block.text);
  if (block.type === "image") return estimateCcImageTokens(block, model);
  if (block.type === "thinking" && typeof block.thinking === "string") return tokens(block.thinking);
  if (block.type === "tool_use" && typeof block.name === "string" && object(block.input)) return tokens(block.name + JSON.stringify(block.input));
  if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
    const content = block.content;
    if (typeof content === "string") return tokens(content);
    if (Array.isArray(content)) {
      let total = 0;
      for (const part of content) {
        if (!object(part) || part.type !== "text" && part.type !== "image") return null;
        const amount = estimateBlock(part, model);
        if (amount === null) return null;
        total += amount;
      }
      return total;
    }
  }
  // Documents and unreadable/unsupported blocks cannot establish a complete denominator.
  return null;
}

/** A compaction whose delivery was recorded with exactly this carrier's Knowledge and cost (97). */
export type CcRecordedCompaction = (header: NonNullable<ReturnType<typeof decodeCcInjection>>) => boolean;

/** No transcript or executor reads: authenticate only envelopes in the current API snapshot.
 * Native preview files are optional integrity evidence, never substitute context content. */
export function ccContextEvidence(binding: Pick<CcSessionBinding, "nativeSessionId" | "coreSessionId">,
  dbPath: string, snapshot?: CcContextSnapshot, recorded?: CcRecordedCompaction): CcContextEvidence {
  if (!snapshot) return unavailable("current Messages snapshot unavailable");
  if (snapshot.session !== binding.nativeSessionId) return unavailable("native session changed");
  if (!Array.isArray(snapshot.messages) || snapshot.messages.length >= 4096) return unavailable("Messages snapshot incomplete");
  const identity = { db: databaseIdentity(dbPath), nativeSession: binding.nativeSessionId, coreSession: binding.coreSessionId };
  const memory = { knowledge: 0, facts: 0, raw: 0, unclassified: 0 };
  let estimatedMessagesTokens = 0;
  for (const message of snapshot.messages) {
    if (!object(message) || (message.role !== "user" && message.role !== "assistant") || !Array.isArray(message.content))
      return unavailable("unsupported Messages content");
    for (const block of message.content) {
      if (!object(block)) return unavailable("unsupported Messages content");
      const amount = estimateBlock(block, snapshot.model);
      if (amount === null) return unavailable("unsupported Messages content or image dimensions/model");
      estimatedMessagesTokens += amount;
      // A function-added user message has no provenance in the API snapshot. A user can paste
      // the same valid envelope; role/content alone cannot authorize Knowledge classification.
      // 102: a compaction delivery recorded with exactly this carrier's Knowledge and cost is taken as
      // its source, an estimate; a carrier without such a record stays unavailable. Trace Memory's
      // compaction arrives in Pi's compaction framing, which is measured as host framing.
      if (message.role === "user" && block.type === "text" && typeof block.text === "string" && ccCarrierStart(block.text) >= 0) {
        // 102 requirement 14: an automatic compaction's trailing native continue sentence is host
        // framing, stripped here exactly as the surrounding compaction framing already is.
        const start = ccCarrierStart(block.text), text = ccStripAutoContinue(block.text.endsWith("\n") ? block.text.slice(0, -1) : block.text);
        const original = start === 0 ? text : text.endsWith(COMPACTION_SUMMARY_SUFFIX) ? text.slice(start, -COMPACTION_SUMMARY_SUFFIX.length) : "";
        const header = decodeCcInjection(original, identity);
        if (!header || !recorded?.(header)) return unavailable("native function carrier provenance unavailable in Messages snapshot");
        const parts = measureRetainedMemoryText(block.text, original, start, original.length);
        for (const key of memoryKeys) memory[key] += parts[key];
        continue;
      }
      if (message.role !== "user" || block.type !== "text" || typeof block.text !== "string" ||
          !block.text.startsWith(HOOK_CONTEXT) || !block.text.includes(CC_INJECTION_HEADER)) continue;
      let current: ReturnType<typeof carrier>;
      try { current = carrier(block.text, identity); }
      catch (error) { return unavailable(error instanceof Error ? error.message : String(error)); }
      const parts = measureRetainedMemoryText(block.text, current.retained, current.offset, current.retained.length);
      for (const key of memoryKeys) memory[key] += parts[key];
    }
  }
  return { presence: "confirmed", estimatedMessagesTokens, memory };
}
