import type { DreamingAgentInput, RunAgent, RunAgentResult } from "../src/core/api/index.ts";
import type { TaskTarget } from "../src/core/store/index.ts";
import type { TraceMemory } from "./source-fixture.ts";
import { knowledge } from "./support/seed.ts";

export type DreamerScenario = (input: DreamingAgentInput) => Promise<RunAgentResult> | RunAgentResult;

/**
 * Construction-time deterministic Dreamer adapter for facade tests.
 *
 * A test queues one complete provider scenario, then calls `run()`. Every rejection, read,
 * correction and final accounting step in that scenario shares the real admitted run and ledger.
 * The adapter grants no authority: admission, bounded selection, claims, tools, completion and
 * accounting all remain owned by `TraceMemory.dream()`.
 */
export class AdmittedDreamerScenarios {
  private pending: DreamerScenario | undefined;

  constructor(private readonly fallback: RunAgent) {}

  readonly agent: RunAgent = async input => {
    if ((input as { kind?: string }).kind !== "dreaming") return this.fallback(input);
    const scenario = this.pending;
    if (!scenario) throw new Error("unexpected Dreamer fixture admission");
    this.pending = undefined;
    return await scenario(input as DreamingAgentInput);
  };

  async run(memory: TraceMemory, path: TaskTarget, scenario: DreamerScenario) {
    if (this.pending) throw new Error("a Dreamer fixture scenario is already queued");
    this.pending = scenario;
    try {
      return await memory.dream(path);
    } finally {
      this.pending = undefined;
    }
  }
}

/** A visible, normally-accounted body whose pending weight alone crosses the session's configured
 * Dreamer trigger (104). In the global or session scope it puts that pool over budget; retiring it
 * returns the pool to its budget. */
export function createDreamerTrigger(memory: TraceMemory, path: TaskTarget, factId: number, sequence: number,
  scope: "global" | "project" | "session" = "project") {
  // The trigger item below is sized for a 5,000-token threshold; the fixture pins it so the default can move.
  memory.config.dreaming.triggerTokens = Math.min(memory.config.dreaming.triggerTokens, 5_000);
  // The item is far over the writing caps on purpose (its weight crosses the trigger), so it is seeded
  // through the store, as an item written before the caps would be, not through the capped manual tool.
  const now = new Date().toISOString();
  const item = knowledge(memory.store, path, scope, "reference", [factId],
    `Fixture trigger ${sequence}: ${"trigger ".repeat(5_500)}`,
    { run: { kind: "manual", createdAt: now }, operation: { topics: ["test-fixture"], createdAt: now } });
  return { knowledgeId: item.knowledgeId, commit: item.commit };
}

