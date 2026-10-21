// LEGACY (ticket 144 stage 4 part 2): the old Dreamer's frozen-range material. Nothing in a run reaches it any more; the
// only callers left are tests and tools/perf scripts of the old protocol. Stage 4 part 4 deletes this file with them.
import { loadPrompt } from "../prompts/load.ts";
import { withRetrievalPolicy } from "../render/retrieval-policy.ts";
import { readingGuide } from "../render/reading-guide.ts";
import { createHash } from "node:crypto";
import type { Store, RunInput, TaskClaim } from "../store/index.ts";
import { processedBlock } from "../store/processing.ts";
import { budgetKnowledge, renderFact, renderFactGroups, renderKnowledgeBlock, tokens } from "../render/index.ts";
import { dreamingToolDefinitions, pricedToolDefinitions, type bindTools } from "../api/tools.ts";
import { canonicalToolNames, validateToolNames } from "../prompts/tool-names.ts";
import type { AgentControl, RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import type { NotingInput } from "../noting/index.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";
import type { TriggerOrigin } from "../model/index.ts";
import { renderDreamingCheckReceipt, type DreamingCheckResult } from "./check-receipt.ts";
import { renderDreamingReview } from "./review.ts";


import type { DreamingInput } from "./index.ts";

/** 126: freeze all of the session's pools. Processing is scheduling state: references are the pools'
 * current revisions outside the selected prefix; Changed contains only that frozen prefix. */
export function freezeDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig, claim?: TaskClaim,
  _origin: TriggerOrigin | null = store.triggerOrigin({ sessionId: input.sessionId, branch: input.branch,
    headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId }, input.triggerEntryId)) {
  if (!claim) throw new Error("Dreaming freeze requires its live claim");
  const path = { sessionId: input.sessionId, branch: input.branch,
    headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId! };
  return prepareDreaming(store, input, config, claim, path,
    store.freezeKnowledgePool(path, claim, config.dreaming.triggerTokens, config.compaction.sharedAllowanceTokens));
}

/** 104 F1: the claim lease outlives the configured wall-clock bound by this margin, so the terminal
 * settlement in `core/api/index.ts` still finds the claim current when a run times out — otherwise a
 * lease equal to the bound races the timeout and can lapse first, misfiling the failure as cancelled. */
export const CLAIM_LEASE_MARGIN_MS = 60_000;

function prepareDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig, claim: TaskClaim,
  path: { sessionId: number; branch: string; headTurnId: number },
  { pools, range }: ReturnType<Store["freezeKnowledgePool"]>) {
  if (store.getSession(path.sessionId)!.host.startsWith("cc:") && !input.toolNames)
    throw new Error("CC Dreamer launch requires exposed tool names");
  if (input.nativeReadToolTokens !== undefined && (!Number.isSafeInteger(input.nativeReadToolTokens) || input.nativeReadToolTokens < 0))
    throw new Error("Invalid native Read token estimate: expected a nonnegative safe integer");
  const frozenIds = new Set(range.eventIds);
  const pending = pools.flatMap(pool => pool.pending).filter(value => frozenIds.has(value.revisionId))
    .sort((left, right) => left.revisionId - right.revisionId);
  const changed = ["Pending current knowledge:", ...pending.map(value => value.shown)].join("\n");
  // 131: a run with pending items deliberates them first; the budget is only `check`'s verdict. A run with
  // none (started by the three-pool total, 104) has no item to take up, so the material tells it to reduce.
  const over = pending.length ? [] : pools.filter(pool => pool.tokens > pool.budget);
  const noPendingOrder = !over.length ? "" : ` ${over.map(pool => `Pool ${pool.pool} is ${pool.tokens}/${pool.budget} tokens, over budget.`).join(" ")} This run has no pending items. Reduce the already-processed knowledge of ${over.length === 1 ? "that pool" : "each of these pools"} under the Over budget principle until it fits.`;
  const rendered = new Map(pools.flatMap(pool => [...pool.rendered]));
  const references = pools.flatMap(pool => pool.versions).filter(value => !frozenIds.has(value.revision.id));
  const budgets = store.knowledgeBudgets();
  const knowledgeCapacity = budgets.injection + config.compaction.sharedAllowanceTokens;
  if (!Number.isSafeInteger(knowledgeCapacity)) throw new Error("derived Dreamer Knowledge capacity must be a safe integer");
  // Changed and current references share one Knowledge window, not two independent allowances.
  const processedInputCap = knowledgeCapacity - tokens(changed) - 1;
  const referenceTitle = "Current pool knowledge outside this range:\n";
  if (processedInputCap < tokens(referenceTitle))
    throw new Error("Dreaming capacity: pending Knowledge and required framing cannot fit the Knowledge window; left pending");
  const renderReference = (value: (typeof references)[number]) => rendered.get(value.revision.id)!;
  let old = processedBlock(references, renderReference);
  if (tokens(`${referenceTitle}${old}`) > processedInputCap) {
    const selected = budgetKnowledge(references, processedInputCap - tokens(referenceTitle),
      renderReference, "Dreamer current reference input");
    old = [renderKnowledgeBlock(selected.groups.filter(group => group.text)), ...selected.receipts].join("\n");
  }
  old = `${referenceTitle}${old}`;
  if (tokens(old) > processedInputCap)
    throw new Error(`Dreaming current reference input exceeds ${processedInputCap} tokens including framing`);
  if (tokens(["Pending current knowledge:", ...pending.map(value => value.material)].join("\n")) > 10_000 || tokens([old, changed].join("\n\n")) > knowledgeCapacity)
    throw new Error("Dreaming capacity: complete Knowledge rendering exceeds its pending slice or total Knowledge window; left pending");

  const frozenValues = pools.flatMap(pool => pool.versions).filter(value => frozenIds.has(value.revision.id));
  // 76: a frozen archive is not among a pool's versions (pool size/versions exclude archives); its own
  // supports and the body it removed still need to reach D, exactly as any other frozen item's do.
  const frozenArchives = pools.flatMap(pool => pool.archived).filter(value => frozenIds.has(value.revision.id));
  const facts = [...new Set([...frozenValues, ...frozenArchives].flatMap(value => value.revision.supports))].sort((a, b) => a - b).map(id => {
    const fact = store.getFact(id); if (!fact) throw new Error(`Missing direct support F${id}`); return fact;
  });
  const times = store.factTurnTimes(facts), snapshot = store.pathSnapshot(path);
  const relations = store.listFactRelationsOnPathOf(facts.map(fact => fact.id), path, snapshot);
  const names = validateToolNames(input.toolNames ?? canonicalToolNames);
  // 134: trim the oldest ids, retaining a whole newest-first selection in the existing display order.
  const factText = (count: number) => ["Direct supporting facts:",
    ...renderFactGroups(facts.slice(facts.length - count), fact => renderFact(fact, relations.get(fact.id) ?? []), times),
    ...(count < facts.length ? [`Omitted whole direct facts beyond 10000: ${facts.slice(0, facts.length - count).map(fact => `trace://F${fact.id}`).join(" ")}.`] : [])].join("\n");
  let count = facts.length;
  while (count && tokens(factText(count)) > 10_000) count--;
  const direct = factText(count);
  if (tokens(direct) > 10_000) throw new Error("Dreaming direct fact receipts exceed 10000");

  const material = { bound: `Run wall-clock bound: ${config.dreaming.timeoutMs} ms. Wrap up before this deadline.${noPendingOrder}`,
    processed: old, changed, facts: direct };
  const text = [readingGuide(path.sessionId, names), ...Object.values(material)].join("\n\n");
  const prompt = withRetrievalPolicy(loadPrompt("dreaming.md", names, config.writing), names);
  if (input.capacity && (!Number.isSafeInteger(input.capacity.inputTokens) || input.capacity.inputTokens < 0 ||
      tokens(prompt) + tokens(JSON.stringify(pricedToolDefinitions(dreamingToolDefinitions(), names))) +
        (input.nativeReadToolTokens ?? 0) + tokens(text) > input.capacity.inputTokens))
    throw new Error("Dreaming capacity: frozen material and tools exceed model input allowance; left pending");
  return { sessionId: path.sessionId, branch: path.branch, path, range, frozenIds: [...frozenIds],
    eventIds: [...frozenIds], changed: { versions: [...frozenValues, ...frozenArchives] }, material, text,
    profile: structuredClone(config.render), model: input.model ?? "session", mode: "subagent" as const, claim,
    prompt, names, promptHash: createHash("sha256").update(prompt).digest("hex"),
    maxToolRounds: config.dreaming.maxToolRounds, admittedProcessedInputCap: processedInputCap };
}
