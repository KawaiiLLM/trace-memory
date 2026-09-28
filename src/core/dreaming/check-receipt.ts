export interface DreamingCheckResult {
  pool: string;
  frozenRevisionIds: number[];
  ownRevisionIds: number[];
  pendingRevisionIds: number[];
  totals: { pool: string; tokens: number; budget: number }[];
  operationFailures: string[];
  problems: string[];
}

/** The run's acceptance (104): blockers are rejected memory operations, the frozen pool over its
 * budget and frozen versions not yet deliberated. The run succeeds only with none left. */
export function renderDreamingCheckReceipt(result: DreamingCheckResult, address: (commit: number) => string = String): string {
  const total = (value: DreamingCheckResult["totals"][number]) =>
    `- ${value.pool}: ${value.tokens}/${value.budget} tokens`;
  return [
    "Dreamer pool check:",
    `- frozen pool: ${result.pool}`,
    `- frozen current revisions: ${result.frozenRevisionIds.length} (${result.frozenRevisionIds.map(address).join(", ") || "none"})`,
    `- own resulting revisions: ${result.ownRevisionIds.length} (${result.ownRevisionIds.map(address).join(", ") || "none"})`,
    `- newly pending revisions: ${result.pendingRevisionIds.length} (${result.pendingRevisionIds.map(address).join(", ") || "none"})`,
    ...result.totals.map(total),
    `- operation failures: ${result.operationFailures.length ? result.operationFailures.join("; ") : "none"}`,
    `Blockers: ${result.problems.length ? result.problems.join("; ") : "none"}`,
  ].join("\n");
}
