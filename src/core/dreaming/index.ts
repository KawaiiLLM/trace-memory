import { loadPrompt } from "../prompts/load.ts";
import { createHash } from "node:crypto";
import type { Store, RunInput, TaskClaim } from "../store/index.ts";
import { deriveSharedMaterialAllowance, processedBlock } from "../store/processing.ts";
import { budgetKnowledge, renderFact, renderFactGroups, renderKnowledgeBlock, tokens } from "../render/index.ts";
import { dreamingToolDefinitions, type bindTools } from "../api/tools.ts";
import type { AgentControl, RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import type { ConsolidateInput } from "../consolidation/index.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";
import type { TriggerOrigin } from "../model/index.ts";
import { renderDreamingCheckReceipt, type DreamingCheckResult } from "./check-receipt.ts";

const prompt = loadPrompt("dreaming.md");
const promptHash = createHash("sha256").update(prompt).digest("hex");
export type DreamingInput = Omit<ConsolidateInput, "mode" | "effectiveMode" | "visible" | "boundary">;
export type DreamingResult = { automaticOff?: string } & (
  | { outcome: "empty" }
  | { outcome: "dropped"; reason?: string }
  | { outcome: "success" | "failure" | "cancelled" | "conflict"; runId: number; problems: string[] });

export interface DreamingAgentInput extends AgentControl {
  kind: "dreaming"; sessionId: number; branch: string; model: string; mode: "subagent";
  prompt: string; promptHash: string; text: string;
  material: { processed: string; changed: string; facts: string };
  admittedProcessedInputCap: number;
  tools: import("../api/tools.ts").ToolDefinition[];
  acknowledgeRequest(): void;
  reportRequest(request: unknown): void;
  passEnd(rounds: number): string | undefined;
  reportRounds(rounds: number): void;
}

/** Freeze exactly one due owner pool. Processing is scheduling state: references are the pool's
 * current revisions outside the selected prefix; Changed contains only that frozen prefix. */
export function freezeDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig, claim?: TaskClaim,
  _origin: TriggerOrigin | null = store.triggerOrigin({ sessionId: input.sessionId, branch: input.branch,
    headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId }, input.triggerEntryId)) {
  if (!claim) throw new Error("Dreaming freeze requires its live claim");
  const path = { sessionId: input.sessionId, branch: input.branch,
    headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId! };
  return prepareDreaming(store, input, config, claim, path,
    store.freezeKnowledgePool(path, claim, config.dreaming.triggerTokens));
}

/** Facade admission and material assembly stay in one transaction. No prepared snapshot is accepted
 * from outside: Store discovers, claims and reserves before the private read-only assembler runs. */
export function admitDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig, executorId: string) {
  return store.transaction(() => {
    const path = { sessionId: input.sessionId, branch: input.branch,
      headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId! };
    const admitted = store.admitKnowledgePool(path, executorId, input.borrowed, input.executorSessionId,
      config.dreaming.triggerTokens);
    if (admitted.outcome !== "admitted") return admitted;
    return { outcome: "admitted" as const, claim: admitted.claim,
      frozen: prepareDreaming(store, input, config, admitted.claim, path, admitted) };
  });
}

function prepareDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig, claim: TaskClaim,
  path: { sessionId: number; branch: string; headTurnId: number },
  { pool: due, range }: ReturnType<Store["freezeKnowledgePool"]>) {
  const frozenIds = new Set(range.eventIds);
  const pending = due.pending.filter(value => frozenIds.has(value.revisionId));
  const changed = ["Pending current knowledge:", ...pending.map(value => value.material)].join("\n");
  if (tokens(changed) > due.budget)
    throw new Error(`Dreaming pool ${due.pool} changed material exceeds its ${due.budget}-token budget including framing`);

  const references = due.versions.filter(value => !frozenIds.has(value.revision.id));
  const budgets = store.knowledgeBudgets();
  const knowledgeCapacity = budgets.injection + deriveSharedMaterialAllowance({ noting: config.noting.triggerTokens,
    consolidation: config.consolidation.triggerTokens, dreaming: config.dreaming.triggerTokens });
  if (!Number.isSafeInteger(knowledgeCapacity)) throw new Error("derived Dreamer Knowledge capacity must be a safe integer");
  // Changed and current references share one Knowledge window, not two independent allowances.
  const processedInputCap = knowledgeCapacity - tokens(changed) - 1;
  const renderReference = (value: (typeof references)[number]) => due.rendered.get(value.revision.id)!;
  let old = processedBlock(references, renderReference), oldIds = references.map(value => value.revision.id);
  if (tokens(`Current pool knowledge outside this range:\n${old}`) > processedInputCap) {
    const selected = budgetKnowledge(references, Math.max(0, processedInputCap - tokens("Current pool knowledge outside this range:\n")),
      renderReference, "Dreamer current reference input");
    old = [renderKnowledgeBlock(selected.groups.filter(group => group.text)), ...selected.receipts].join("\n");
    oldIds = selected.commits;
  }
  old = `Current pool knowledge outside this range:\n${old}`;
  if (tokens(old) > processedInputCap)
    throw new Error(`Dreaming current reference input exceeds ${processedInputCap} tokens including framing`);

  const frozenValues = due.versions.filter(value => frozenIds.has(value.revision.id));
  const facts = [...new Set(frozenValues.flatMap(value => value.revision.supports))].sort((a, b) => a - b).map(id => {
    const fact = store.getFact(id); if (!fact) throw new Error(`Missing direct support F${id}`); return fact;
  });
  const times = store.factTurnTimes(facts), snapshot = store.pathSnapshot(path);
  const relations = store.listFactRelationsOnPathOf(facts.map(fact => fact.id), path, snapshot);
  const factText = (count: number) => ["Direct supporting facts:",
    ...renderFactGroups(facts.slice(0, count), fact => renderFact(fact, relations.get(fact.id) ?? []), times),
    ...(count < facts.length ? [`Omitted whole direct facts beyond 10000: ${facts.slice(count).map(fact => `F${fact.id}`).join(", ")}; expand with trace.`] : [])].join("\n");
  let count = facts.length;
  while (count && tokens(factText(count)) > 10_000) count--;
  const direct = factText(count);
  if (tokens(direct) > 10_000) throw new Error("Dreaming direct fact receipts exceed 10000");

  const material = { processed: old, changed, facts: direct };
  const text = Object.values(material).join("\n\n");
  if (input.capacity && (!Number.isSafeInteger(input.capacity.inputTokens) || input.capacity.inputTokens < 0 ||
      tokens(prompt) + tokens(JSON.stringify(dreamingToolDefinitions())) + tokens(text) > input.capacity.inputTokens))
    throw new Error("Dreaming capacity: frozen material and tools exceed model input allowance; left pending");
  const supplied = [...references.filter(value => oldIds.includes(value.revision.id)), ...frozenValues];
  return { sessionId: path.sessionId, branch: path.branch, path, range, pool: due.pool, frozenIds: [...frozenIds],
    eventIds: [...frozenIds], changed: { versions: frozenValues }, material, text,
    profile: structuredClone(config.render), model: input.model ?? "session", mode: "subagent" as const, claim,
    readKnowledgeCommits: supplied.map(value => ({ knowledgeId: value.knowledge.id, commit: value.revision.id })),
    maxToolRounds: config.dreaming.maxToolRounds, admittedProcessedInputCap: processedInputCap };
}

export async function runDreaming(store: Store, frozen: ReturnType<typeof freezeDreaming>, runAgent: RunAgent,
  bind: (context: Parameters<typeof bindTools>[2], run: RunInput, review?: undefined, dreaming?: Parameters<typeof bindTools>[6]) => ReturnType<typeof bindTools>): Promise<DreamingResult> {
  const { sessionId, branch, path, range, readKnowledgeCommits } = frozen;
  let rounds = 0;
  const run: RunInput = { kind: "dreaming", sessionId, branch, dreamingRangeId: range.id, model: frozen.model, mode: "subagent",
    promptHash, rangeFrom: `${frozen.pool}#${range.id}`, rangeTo: `${frozen.pool}#${range.id}`, createdAt: new Date().toISOString() };
  let binding!: ReturnType<typeof bindTools>;
  const check = (): DreamingCheckResult => {
    const runId = store.dreamingRunId(run);
    const ownRevisionIds = runId === undefined ? [] : store.listCommitsByRun(runId).map(revision => revision.id);
    const excluded = new Set([...frozen.frozenIds, ...ownRevisionIds]);
    const operationFailures = [...binding.toolProblems, ...binding.memory.problems];
    const pools = store.knowledgePools(path);
    return { pool: frozen.pool, frozenRevisionIds: frozen.frozenIds, ownRevisionIds,
      pendingRevisionIds: pools.find(value => value.pool === frozen.pool)!.pending.map(value => value.revisionId).filter(id => !excluded.has(id)),
      totals: pools.map(({ pool, budget, tokens }) => ({ pool, budget, tokens })), operationFailures, problems: operationFailures };
  };
  binding = bind({ kind: "dreaming", sessionId, branch, headTurnId: path.headTurnId,
    range: { from: run.rangeFrom!, to: run.rangeTo! }, readKnowledgeCommits }, run, undefined,
    { path, check: () => renderDreamingCheckReceipt(check()), skippable: commit => frozen.frozenIds.includes(commit)
      ? undefined : "skip must name an exact frozen version from this run" });
  let result: RunAgentResult;
  try {
    result = await runAgent({ kind: "dreaming", sessionId, branch, model: frozen.model, mode: "subagent", prompt, promptHash,
      text: frozen.text, material: frozen.material, admittedProcessedInputCap: frozen.admittedProcessedInputCap,
      tools: binding.tools, acknowledgeRequest: binding.acknowledgeRequest, reportRequest: binding.reportRequest,
      passEnd: (used: number) => { rounds = used; return undefined; }, reportRounds: (used: number) => { rounds = used; } } satisfies DreamingAgentInput);
  } catch (error) { result = agentException(error); }
  binding.close();
  if (store.closed) return { outcome: "dropped" };
  const checked = check();
  const problems = [...checked.problems, ...(result.outcome === "success" ? [] : [String(result.output ?? result.outcome)]),
    ...(requestMissing(result) ? ["runAgent must return the exact provider request"] : [])];
  const skippedRevisionIds = binding.memory.skipped.map(value => Number(/^K[1-9]\d*@([1-9]\d*)$/.exec(value.knowledge)?.[1]))
    .filter(Number.isSafeInteger);
  const frozenSet = new Set(frozen.frozenIds), parentMap = store.commitGraphInput().parents;
  const operatedFrozenIds = new Set(checked.ownRevisionIds.flatMap(id => parentMap.get(id) ?? []).filter(id => frozenSet.has(id)));
  const deliberatedRevisionIds = [...new Set([...skippedRevisionIds, ...operatedFrozenIds])].sort((a, b) => a - b);
  recordAttempt(run, result, "subagent", { toolCalls: binding.sequence, fetched: binding.fetched, material: frozen.material,
    profile: frozen.profile, admittedProcessedInputCap: frozen.admittedProcessedInputCap, readKnowledgeCommits,
    committed: binding.memory.allCommitted, skipped: binding.memory.skipped, check: checked, rounds,
    deliberatedRevisionIds, deliberated: deliberatedRevisionIds.length, frozen: frozen.frozenIds.length, problems });
  const runId = store.dreamingRunId(run)!;
  let outcome: "success" | "failure" | "cancelled" = result.outcome === "cancelled" ? "cancelled"
    : result.outcome === "success" && !requestMissing(result) && !checked.problems.length ? "success" : "failure";
  try { store.completeKnowledgePoolRange(run, outcome, skippedRevisionIds); }
  catch (error) {
    outcome = "failure";
    problems.push(`pool completion rejected: ${String(error)}`);
    store.updateRun(runId, { ...run, outcome, response: JSON.stringify({ ...JSON.parse(run.response!), problems }) });
  }
  return { outcome, runId, problems };
}
