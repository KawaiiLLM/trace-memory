import type { TraceMemory } from "../src/core/api/index.ts";

/** Set the database-owned Knowledge base for a fixture. The shared allowance (73: a fixed
 * configuration value) is independent. */
export function setKnowledgeInjection(memory: TraceMemory, capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error("test Knowledge injection capacity must be a nonnegative safe integer");
  memory.setKnowledgeBudget("global", 0);
  memory.setKnowledgeBudget("session", 0);
  memory.setKnowledgeBudget("project", capacity);
}

/** Set an exact total Knowledge input capacity: zero the database base for focused renderer tests
 * and put the whole capacity in the shared allowance. */
export function setKnowledgeCapacity(memory: TraceMemory, capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error("test total Knowledge capacity must be a nonnegative safe integer");
  setKnowledgeInjection(memory, 0);
  memory.config.compaction.sharedAllowanceTokens = capacity;
}

/** Select the shared allowance directly. The current pool budgets remain intact. */
export function setSharedAllowance(memory: TraceMemory, allowance: number): void {
  if (!Number.isSafeInteger(allowance) || allowance < 0) throw new Error("test shared allowance must be a nonnegative safe integer");
  memory.config.compaction.sharedAllowanceTokens = allowance;
}
