export interface DreamingScopeTotal {
  scope: string;
  tokens: number;
  cap: number;
}

/**
 * The complete canonical check retained in the run audit. This interface names the fields used by
 * the model-facing projection as well as the exact sets and detailed rows that projection omits.
 */
export interface DreamingCheckResult {
  family: readonly number[];
  suppliedEventIds: readonly number[];
  eventIds: readonly number[];
  retainedEventIds: readonly number[];
  candidateIds: readonly number[];
  resultIds: readonly number[];
  consumedInputIds: readonly number[];
  pendingEventIds: readonly number[];
  pendingVersionIds: readonly number[];
  /** Owner pools applicable to this frozen target; full `totals` remains unfiltered audit. */
  relevantOwnerScopes: readonly string[];
  versions: readonly unknown[];
  verifiedConsumedBases: readonly unknown[];
  totals: readonly DreamingScopeTotal[];
  externalSuccessors: readonly unknown[];
  operationFailures: readonly string[];
  failures: readonly string[];
  problems: readonly string[];
  remainingRounds: number;
  repairAvailable: boolean;
  capacities: { applicable: number; injection: number; dreamingProcessedInput: number };
  admittedProcessedInputCap: number;
}

function compareScope(left: { scope: string }, right: { scope: string }): number {
  return left.scope < right.scope ? -1 : left.scope > right.scope ? 1 : 0;
}

function budgetRow(total: DreamingScopeTotal): string {
  const headroom = total.cap - total.tokens;
  return `- ${total.scope}: used ${total.tokens} / limit ${total.cap} / headroom ${headroom >= 0 ? "+" : ""}${headroom}`;
}

function blockerRows(problems: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const problem of problems) counts.set(problem, (counts.get(problem) ?? 0) + 1);
  return [...counts].map(([problem, count]) => `- ${problem}${count === 1 ? "" : ` (${count} occurrences)`}`);
}

/**
 * Render only the model-facing projection of an already completed canonical check. It performs no
 * validation or completion decision and does not mutate or replace the full check used by audit.
 */
export function renderDreamingCheckReceipt(check: DreamingCheckResult): string {
  const relevant = new Set(check.relevantOwnerScopes);
  const owners = check.totals.filter(total => relevant.has(total.scope)).slice().sort(compareScope);
  const applicable = check.totals.filter(total => total.scope.startsWith("applicable:"));
  const maximum = applicable.slice().sort((left, right) => right.tokens - left.tokens || compareScope(left, right))[0];
  const blockers = blockerRows(check.problems);

  return [
    "Dreamer completion check receipt",
    `Current database capacities: applicable ${check.capacities.applicable}; injection ${check.capacities.injection}; Dreamer processed input for new admissions ${check.capacities.dreamingProcessedInput}.`,
    `This run's frozen admitted processed-input ceiling: ${check.admittedProcessedInputCap}.`,
    "Owner budgets:",
    ...(owners.length ? owners.map(budgetRow) : ["- none"]),
    maximum
      ? `Maximum applicable projection (${applicable.length} checked):\n${budgetRow(maximum)}`
      : "Maximum applicable projection (0 checked): none",
    "Completion:",
    `- frozen family: ${check.family.length}`,
    `- supplied formal events: ${check.suppliedEventIds.length}`,
    `- accounted formal events: ${check.eventIds.length}`,
    `- pending obligations: ${check.pendingEventIds.length + check.pendingVersionIds.length} (change events ${check.pendingEventIds.length}; exact versions ${check.pendingVersionIds.length})`,
    `- host-derived candidates: ${check.candidateIds.length}`,
    `- successor-free results: ${check.resultIds.length}`,
    `- consumed inputs: ${check.consumedInputIds.length}`,
    `- external successors: ${check.externalSuccessors.length}`,
    `- operation failures: ${check.operationFailures.length}`,
    `- remaining tool rounds: ${check.remainingRounds}`,
    `- repair available: ${check.repairAvailable ? "yes" : "no"}`,
    ...(blockers.length ? [`Blockers (${check.problems.length} occurrences):`, ...blockers] : ["Blockers: none"]),
  ].join("\n");
}
