import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Store, RunInput } from "../store/index.ts";
import { checkProcessedScopes, placementOwner, processedBlock } from "../store/processing.ts";
import { renderFact, renderFactGroups, renderKnowledgeBlock, budgetKnowledge, tokens } from "../render/index.ts";
import { dreamingToolDefinitions, type bindTools } from "../api/tools.ts";
import type { AgentControl, RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import { similarity, type ConsolidateInput } from "../consolidation/index.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";
import type { TriggerOrigin } from "../model/index.ts";
import { renderDreamingCheckReceipt, type DreamingCheckResult } from "./check-receipt.ts";

const prompt = readFileSync(new URL("../prompts/dreaming.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");
export type DreamingInput = Omit<ConsolidateInput, "mode" | "effectiveMode" | "visible" | "boundary">;
export type DreamingResult = { automaticOff?: string } & (
  | { outcome: "empty" }
  | { outcome: "dropped"; reason?: string }
  | { outcome: "success" | "failure" | "cancelled" | "conflict"; runId: number; problems: string[] });
export class DreamingAdmissionBlocked extends Error {
  readonly rangeId: number;
  readonly signature: string;
  constructor(rangeId: number, signature: string, message: string) {
    super(message); this.rangeId = rangeId; this.signature = signature;
  }
}

export interface DreamingAgentInput extends AgentControl {
  kind: "dreaming"; sessionId: number; branch: string; model: string; mode: "subagent";
  prompt: string; promptHash: string; text: string;
  material: { processed: string; changed: string; facts: string };
  /** Admission-time snapshot only; later check receipts use the current database policy. */
  admittedProcessedInputCap: number;
  tools: import("../api/tools.ts").ToolDefinition[];
  reportRequest(request: unknown): void;
  /** Called by the native host only at a completed pass, never an intermediate tool turn. */
  passEnd(rounds: number): string | undefined;
  reportRounds(rounds: number): void;
}

export function freezeDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig,
  origin: TriggerOrigin | null = store.triggerOrigin({ sessionId: input.sessionId, branch: input.branch, headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId }, input.triggerEntryId)) {
  const retained = store.retryDreamingRange(store.knowledgePath(input.sessionId, input.branch, input.headTurnId));
  const path = retained ? { sessionId: retained.sessionId, branch: retained.branch, headTurnId: retained.headTurnId }
    : { sessionId: input.sessionId, branch: input.branch, headTurnId: input.headTurnId! };
  const ownCommits = retained ? store.dreamingOwnCommits(retained.id) : undefined;
  const admission = store.dreamingInputSnapshot(path, ownCommits);
  const changedText = (value: ReturnType<typeof admission.input>) => `Changed knowledge (unsettled events):\n${value.text}`;
  const selected = admission.select(retained ? [...retained.eventIds, ...retained.versionIds] : undefined, candidate => tokens(changedText(candidate)) <= 10000);
  const ids = selected.eventIds, versionIds = selected.versionIds, changed = selected.input;
  if (!ids.length && !versionIds.length && !changed.versions.length) {
    if (!retained) throw new Error("Dreaming capacity: oldest change with its current body and framing exceeds 10000; left pending");
    const ownBlocked = selected.blocked.filter(label => label.startsWith("retained task output "));
    const message = selected.ownBlocked
      ? `Dreaming capacity: retained task output ${ownBlocked.map(label => label.slice("retained task output ".length)).join(", ")} exceeds 10000 with its current body and framing; left pending`
      : `Dreaming capacity: retained changes ${selected.blocked.join(", ") || "(none)"} each exceed 10000 with their current body and framing; left pending`;
    throw new DreamingAdmissionBlocked(retained.id, selected.blockedSignature ?? "[]", message);
  }
  if (tokens(changedText(changed)) > 10000) throw new Error("Dreaming capacity: selected retained changed material exceeds 10000; left pending");
  const processed = store.listCurrentKnowledge(path).filter(v => store.isKnowledgeProcessed(v.revision.id));
  const processedInputCap = store.knowledgeBudgets().dreamingProcessedInput;
  let old = processedBlock(processed), oldIds = processed.map(v => v.revision.id);
  if (tokens(`Processed knowledge:\n${old}`) > processedInputCap) {
    const query = [...changed.versions, ...changed.predecessors].map(v => v.revision.text).join("\n");
    const scores = new Map(processed.map(v => [v.revision.id, similarity(query, v.revision.text)]));
    const selected = budgetKnowledge(processed, Math.max(0, processedInputCap - tokens("Processed knowledge:\n")), undefined, "Dreamer processed input", undefined,
      (a, b) => scores.get(b.revision.id)! - scores.get(a.revision.id)!);
    old = [renderKnowledgeBlock(selected.groups.filter(g => g.text)), ...selected.receipts].join("\n");
    oldIds = selected.commits;
  }
  old = `Processed knowledge:\n${old}`;
  if (tokens(old) > processedInputCap) throw new Error(`Dreaming processed input exceeds current ${processedInputCap}-token database-derived ceiling including framing`);
  const facts = [...new Set(changed.versions.flatMap(v => v.revision.supports))].sort((a, b) => a - b).map(id => {
    const fact = store.getFact(id); if (!fact) throw new Error(`Missing direct support F${id}`); return fact;
  });
  const times = store.factTurnTimes(facts);
  const factText = (count: number) => ["Direct supporting facts:", ...renderFactGroups(facts.slice(0, count), f => renderFact(f, store.listFactRelations(f.id)), times),
    ...(count < facts.length ? [`Omitted whole direct facts beyond 10000: ${facts.slice(count).map(f => `F${f.id}`).join(", ")}; expand with trace.`] : [])].join("\n");
  let count = facts.length;
  while (count && tokens(factText(count)) > 10000) count--;
  const direct = factText(count);
  if (tokens(direct) > 10000) throw new Error("Dreaming direct fact receipts exceed 10000");
  const material = { processed: old, changed: changedText(changed), facts: direct };
  const text = Object.values(material).join("\n\n");
  if (input.capacity && (!Number.isSafeInteger(input.capacity.inputTokens) || input.capacity.inputTokens < 0 ||
      tokens(prompt) + tokens(JSON.stringify(dreamingToolDefinitions())) + tokens(text) > input.capacity.inputTokens))
    throw new Error("Dreaming capacity: frozen material and tools exceed model input allowance; left pending");
  const supplied = [...processed.filter(v => oldIds.includes(v.revision.id)), ...changed.versions];
  const range = store.retainDreamingRange(path, ids, supplied.map(v => v.knowledge.id), origin, versionIds);
  return { sessionId: path.sessionId, branch: path.branch, path, range, eventIds: ids, versionIds, changed, material, text,
    profile: structuredClone(config.render), model: input.model ?? "session", mode: "subagent" as const,
    readKnowledgeCommits: supplied.map(v => ({ knowledgeId: v.knowledge.id, commit: v.revision.id })),
    commitBoundary: Number(store.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM knowledge_revisions").get()!.id),
    maxToolRounds: config.dreaming.maxToolRounds, admittedProcessedInputCap: processedInputCap };
}

export async function runDreaming(store: Store, frozen: ReturnType<typeof freezeDreaming>, runAgent: RunAgent,
  bind: (context: Parameters<typeof bindTools>[2], run: RunInput, review?: undefined, dreaming?: Parameters<typeof bindTools>[6]) => ReturnType<typeof bindTools>): Promise<DreamingResult> {
  const { sessionId, branch, path, range, eventIds, readKnowledgeCommits } = frozen;
  let rounds = 0, repaired = false;
  const run: RunInput = { kind: "dreaming", sessionId, branch, dreamingRangeId: range.id, model: frozen.model, mode: "subagent",
    promptHash, rangeFrom: `K@${range.anchor}`, rangeTo: `K@${Math.max(range.anchor, ...range.eventIds, ...range.versionIds)}`, createdAt: new Date().toISOString() };
  // Complete reads grant write handles only. Formal processing membership is the frozen changed
  // versions. A processed reference remains outside that membership unless this exact authorized
  // run legally maintains it inside the frozen family; then only the run's own output is added.
  const admitted = new Set(readKnowledgeCommits.map(v => v.commit));
  const formal = new Set(frozen.changed.versions.map(v => v.revision.id));
  const eventResults = new Map(frozen.changed.eventResults.map(value => [value.eventId, value.commits]));
  const check = (): DreamingCheckResult => {
    let family = range.knowledgeIds;
    const currentRunId = store.dreamingRunId(run);
    if (currentRunId === undefined) throw new Error("trusted Dreamer run binding required");
    // The bound run capability, claim and frozen-family write checks make every committed revision
    // here a legal operation of this pass. Range membership or an actor label is not provenance.
    const ownCandidates = store.listCommitsByRun(currentRunId).map(revision => revision.id);
    const graph = store.commitGraph(null);
    const candidates = [...new Set([...formal, ...ownCandidates])].sort((a, b) => a - b);
    const consumers = store.consumingSuccessors(candidates);
    const resultIds = candidates.filter(id => consumers.get(id)!.length === 0);

    // A transaction refusal is forgivable only when core returned an exact consumed base and the
    // fresh graph still contains that consuming edge for a formal processing version.
    const verifiedConflicts = binding.memory.competitiveConflicts.filter(conflict => formal.has(conflict.baseCommit) &&
      conflict.successorCommits.some(id => consumers.get(conflict.baseCommit)?.includes(id)));
    const memoryFailures = binding.memory.problems.length && (!binding.memory.competitiveConflicts.length ||
      verifiedConflicts.length !== binding.memory.competitiveConflicts.length) ? binding.memory.problems : [];
    const operationFailures = [...binding.toolProblems, ...memoryFailures];
    const failures: string[] = [...operationFailures];
    try { family = store.validateDreamingRun(run, path, true).knowledgeIds; } catch (error) { failures.push(String(error)); }

    const accountedEventIds = eventIds.filter(eventId => {
      const roots = eventResults.get(eventId) ?? [];
      return roots.length > 0 && roots.every(id => formal.has(id) && (resultIds.includes(id) || consumers.get(id)!.length > 0 ||
        ownCandidates.some(own => graph.descendants(id).has(own))));
    });
    if (accountedEventIds.length !== eventIds.length)
      failures.push(`Dreamer did not account for supplied events: ${eventIds.filter(id => !accountedEventIds.includes(id)).map(id => `K@${id}`).join(", ")}`);

    // Preserve the sole neutral outcome only for a post-freeze external successor of reference-only
    // processed material. Consumed formal inputs and filtered leaves are successful dispositions.
    const pathGraph = store.commitGraph(path);
    const ownSet = new Set(ownCandidates);
    const externalSuccessors: { knowledgeId: number; commit: number }[] = [];
    for (const reference of [...admitted].filter(id => !formal.has(id))) {
      const descendants = pathGraph.descendants(reference);
      for (const revision of pathGraph.current) if (revision.id > frozen.commitBoundary && descendants.has(revision.id) &&
          revision.id !== reference && !ownSet.has(revision.id) && !externalSuccessors.some(value => value.commit === revision.id))
        externalSuccessors.push({ knowledgeId: revision.knowledgeId, commit: revision.id });
    }

    // One policy read owns every cap and derived capacity in this canonical snapshot. The full
    // projection is retained for audit; the receipt separately selects this target's owner rows.
    const currentBudgets = store.knowledgeBudgets();
    const affected = new Set(candidates.map(id => placementOwner(store, { revision: store.knowledgeRevision(id)! })));
    const scopes = checkProcessedScopes(store, resultIds, affected, currentBudgets, true);
    failures.push(...scopes.problems);
    const pending = store.pendingKnowledgeEvents(path);
    const target = store.getSession(path.sessionId);
    if (!target) failures.push(`Dreamer target session ${path.sessionId} is unavailable`);
    const relevantOwnerScopes = ["global", ...(target ? [`project:${target.projectId}`, `session:${target.id}`] : [])];
    const problems = [...failures, ...externalSuccessors.map(value =>
      `K${value.knowledgeId}@${value.commit}: independently verified external successor of reference-only processed material after freeze; reading alone cannot certify it`)];
    return { family, suppliedEventIds: eventIds, eventIds: accountedEventIds, retainedEventIds: range.eventIds,
      candidateIds: candidates, resultIds,
      consumedInputIds: [...formal].filter(id => candidates.includes(id) && consumers.get(id)!.length > 0),
      pendingEventIds: pending.filter(value => value.kind === "event").map(value => value.id),
      pendingVersionIds: pending.filter(value => value.kind === "version").map(value => value.id),
      relevantOwnerScopes,
      versions: candidates.map(commit => { const revision = store.knowledgeRevision(commit)!; return {
        knowledgeId: revision.knowledgeId, commit, processed: store.isKnowledgeProcessed(commit),
        successorCommits: consumers.get(commit),
      }; }),
      verifiedConsumedBases: verifiedConflicts, ...scopes, externalSuccessors, operationFailures, failures, problems,
      remainingRounds: Math.max(0, frozen.maxToolRounds - rounds), repairAvailable: !repaired,
      capacities: { applicable: currentBudgets.applicable, injection: currentBudgets.injection,
        dreamingProcessedInput: currentBudgets.dreamingProcessedInput },
      admittedProcessedInputCap: frozen.admittedProcessedInputCap };
  };
  const binding = bind({ kind: "dreaming", sessionId, branch, headTurnId: path.headTurnId,
    range: { from: run.rangeFrom!, to: run.rangeTo! }, readKnowledgeCommits }, run, undefined,
    { path, check: () => renderDreamingCheckReceipt(check()) });
  const passEnd = (used: number): string | undefined => {
    rounds = used;
    const checked = check();
    if (!checked.problems.length || repaired || rounds >= frozen.maxToolRounds) return;
    repaired = true;
    return `System-generated Dreamer completion check (not evidence). One repair, ${checked.remainingRounds} tool rounds remain:\n${renderDreamingCheckReceipt({ ...checked, repairAvailable: false })}`;
  };
  let result: RunAgentResult;
  try { result = await runAgent({ kind: "dreaming", sessionId, branch, model: frozen.model, mode: "subagent", prompt, promptHash,
    text: frozen.text, material: frozen.material, admittedProcessedInputCap: frozen.admittedProcessedInputCap,
    tools: binding.tools, reportRequest: binding.reportRequest,
    passEnd, reportRounds: (used: number) => { rounds = used; } } satisfies DreamingAgentInput); }
  catch (error) { result = agentException(error); }
  binding.close();
  if (store.closed) return { outcome: "dropped" };
  const checked = check();
  const problems = [...checked.problems, ...(result.outcome !== "success" ? [String(result.output ?? result.outcome)] : []),
    ...(requestMissing(result) ? ["runAgent must return the exact provider request"] : [])];
  recordAttempt(run, result, "subagent", { toolCalls: binding.sequence, fetched: binding.fetched, material: frozen.material,
    profile: frozen.profile, admittedProcessedInputCap: frozen.admittedProcessedInputCap,
    readKnowledgeCommits, commitBoundary: frozen.commitBoundary,
    committed: binding.memory.allCommitted, check: checked, rounds, repaired, problems });
  const runId = store.dreamingRunId(run)!;
  let finalCheck: DreamingCheckResult | undefined;
  let finalization: { stage: "canonical-check" | "settlement"; error: string } | undefined;
  if (result.outcome === "success" && !requestMissing(result) && !checked.failures.length) {
    try {
      return store.transaction(() => {
        // Both successful completion and the sole non-penalizing business exception are decided
        // against a coherent final graph. Persist audit + settlement together, before returning.
        // Keep the returned value outside SQLite rollback so a rejection can retain the exact state
        // that rejected it rather than the earlier optimistic check.
        finalCheck = check();
        if (finalCheck.failures.length) throw new Error(finalCheck.problems.join("; "));
        const outcome = finalCheck.externalSuccessors.length ? "conflict" as const : "success" as const;
        run.response = JSON.stringify({ ...JSON.parse(run.response!), check: finalCheck, problems: finalCheck.problems });
        store.updateRun(runId, { ...run, outcome });
        if (outcome === "conflict") store.settleDreamingConflict(run, finalCheck.problems.join("; "));
        else store.completeDreaming(runId, [...finalCheck.eventIds], [...finalCheck.resultIds]);
        return { outcome, runId, problems: [...finalCheck.problems] };
      });
    } catch (error) {
      const message = String(error);
      finalization = { stage: !finalCheck || finalCheck.failures.length ? "canonical-check" : "settlement", error: message };
      if (finalCheck) for (const problem of finalCheck.problems) if (!problems.includes(problem)) problems.push(problem);
      if (!problems.includes(message)) problems.push(message);
    }
  }
  const outcome = result.outcome === "cancelled" ? "cancelled" : "failure";
  run.response = JSON.stringify({ ...JSON.parse(run.response!), ...(finalCheck ? { check: finalCheck } : {}),
    ...(finalization ? { finalization } : {}), problems });
  store.updateRun(runId, { ...run, outcome });
  return { outcome, runId, problems };
}
