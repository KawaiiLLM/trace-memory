import { deriveSharedMaterialAllowance, type TraceMemory } from "../src/core/api/index.ts";

/** Set the database-owned Knowledge base for a fixture. The shared allowance remains derived from
 * this policy and the current maintenance triggers, exactly as in production. */
export function setKnowledgeInjection(memory: TraceMemory, capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 0) throw new Error("test Knowledge injection capacity must be a nonnegative safe integer");
  memory.setKnowledgeBudget("global", 0);
  memory.setKnowledgeBudget("session", 0);
  memory.setKnowledgeBudget("project", capacity);
}

/** Set an exact total Knowledge input capacity through the real authorities. This intentionally
 * puts the whole capacity in N/C triggers and zeroes the database base for focused renderer tests. */
export function setKnowledgeCapacity(memory: TraceMemory, capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 2) throw new Error("test total Knowledge capacity must be a safe integer of at least two");
  setKnowledgeInjection(memory, 0);
  memory.config.noting.triggerTokens = 1;
  memory.config.consolidation.triggerTokens = capacity - 1;
}

/** Select a derived allowance through its real authorities. The current pool budgets remain intact. */
export function setSharedAllowance(memory: TraceMemory, allowance: number): void {
  if (!Number.isSafeInteger(allowance) || allowance < 2) throw new Error("test shared allowance must be a safe integer of at least two");
  const budgets = memory.knowledgeBudgets();
  const dreaming = Math.ceil(budgets.global / 2) + Math.ceil(budgets.project / 2) + Math.ceil(budgets.session / 2);
  const consolidation = allowance - dreaming - 1;
  if (consolidation < 1) throw new Error(`test shared allowance ${allowance} is below the Dreamer triggers ${dreaming} plus two`);
  memory.config.noting.triggerTokens = 1;
  memory.config.consolidation.triggerTokens = consolidation;
  if (deriveSharedMaterialAllowance(budgets, { noting: 1, consolidation }) !== allowance)
    throw new Error("test shared allowance derivation mismatch");
}
