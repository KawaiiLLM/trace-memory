import type { TraceMemory } from "../src/core/api/index.ts";

/** Set a valid database policy whose derived injection capacity is the requested value. */
export function setKnowledgeInjection(memory: TraceMemory, capacity: number): void {
  if (!Number.isSafeInteger(capacity) || capacity < 5_000) throw new Error("test Knowledge injection capacity must be a safe integer of at least 5000");
  memory.setKnowledgeBudget("global", 0);
  memory.setKnowledgeBudget("project", Math.max(memory.knowledgeBudgets().project, capacity - 5_000));
  memory.setKnowledgeBudget("session", 0);
  memory.setKnowledgeBudget("project", capacity - 5_000);
}
