import type { TraceMemory } from "../src/core/api/index.ts";

/** Set the database-owned Knowledge base for a fixture. The temporary allowance (a fixed configuration value) is independent. */
export function setKnowledgeInjection(memory: TraceMemory, capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error("test Knowledge injection capacity must be a nonnegative safe integer");
  memory.setKnowledgeBudget("global", 0);
  memory.setKnowledgeBudget("session", 0);
  memory.setKnowledgeBudget("project", capacity);
}

/** Set an exact Knowledge base capacity. Scored knowledge fills it in score order; the one temporary allowance
 * (`compaction.temporaryTokens`, 144 §7) is independent and carries unscored knowledge and titles. */
export function setKnowledgeCapacity(memory: TraceMemory, capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error("test total Knowledge capacity must be a nonnegative safe integer");
  setKnowledgeInjection(memory, capacity);
}

/** A pool budget that holds `weight` pending tokens twice over plus the block's own framing (wrapper,
 * recency notice, category header), which a one-line fixture item would otherwise be dwarfed by. */
export const roomyPoolBudget = (weight: number): number => weight * 2 + 100;
