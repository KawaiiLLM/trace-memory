import type { DreamingAgentInput, RunAgent, RunAgentResult } from "../src/core/api/index.ts";
import type { TaskTarget } from "../src/core/store/index.ts";
import type { TraceMemory } from "./source-fixture.ts";

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
 * Dreamer trigger (104) and selects its own scope's pool: the global and session pools it puts over
 * budget, the project pool by the most pending weight. Retiring it returns the pool to its budget. */
export function createDreamerTrigger(memory: TraceMemory, path: TaskTarget, factId: number, sequence: number,
  scope: "global" | "project" | "session" = "project") {
  const tools = memory.tools({ kind: "manual", sessionId: path.sessionId, branch: path.branch,
    currentTurnId: path.headTurnId });
  const operation = (text: string) => ({ op: "create", text, category: "reference" as const,
    scope, supports: [`F${factId}`], topics: ["test-fixture"],
    reason: "Explicit trigger for a genuinely later admitted Dreamer fixture run." });
  const operations = [operation(`Fixture trigger ${sequence}: ${"trigger ".repeat(5_500)}`)];
  const receipt = JSON.parse(tools.find(tool => tool.name === "memory")!.execute({ operations, skipped: [] }));
  if (!receipt.committed?.[0]) throw new Error(`could not create Dreamer fixture trigger: ${JSON.stringify(receipt)}`);
  const item = receipt.committed[0] as { knowledgeId: number; version: string };
  return { knowledgeId: item.knowledgeId,
    commit: memory.store.resolveVersionOrdinal(item.knowledgeId, Number(item.version.split("@v")[1])) };
}
