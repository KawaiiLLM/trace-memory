import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Store, RunInput } from "../store/index.ts";
import { checkProcessedScopes, placementOwner, processedBlock } from "../store/processing.ts";
import { renderFact, renderFactGroups, renderKnowledgeBlock, budgetKnowledge, tokens } from "../render/index.ts";
import { dreamingToolDefinitions, type bindTools } from "../api/tools.ts";
import type { AgentControl, RunAgent, RunAgentResult, TraceMemoryConfig } from "../api/index.ts";
import { similarity, type ConsolidateInput } from "../consolidation/index.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";

const prompt = readFileSync(new URL("../prompts/dreaming.md", import.meta.url), "utf8");
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
  tools: import("../api/tools.ts").ToolDefinition[];
  reportRequest(request: unknown): void;
  /** Called by the native host only at a completed pass, never an intermediate tool turn. */
  passEnd(rounds: number): string | undefined;
  reportRounds(rounds: number): void;
}

export function freezeDreaming(store: Store, input: DreamingInput, config: TraceMemoryConfig) {
  const retained = store.retryDreamingRange(store.knowledgePath(input.sessionId, input.branch, input.headTurnId));
  const path = retained ? { sessionId: retained.sessionId, branch: retained.branch, headTurnId: retained.headTurnId }
    : { sessionId: input.sessionId, branch: input.branch, headTurnId: input.headTurnId! };
  let ids: number[] = [];
  const ownCommits = retained ? store.dreamingOwnCommits(retained.id) : undefined;
  const changedText = (value: ReturnType<Store["dreamingInput"]>) => `Changed knowledge (unsettled events):\n${value.text}`;
  if (!retained) {
    const events = store.pendingKnowledgeEvents(path);
    // Prefix cost grows monotonically: event framing grows and the current-body union only adds.
    // Reuse the exact renderer with logarithmic probes instead of rebuilding the graph per event.
    let low = 0, high = events.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      const candidate = events.slice(0, middle).map(e => e.id);
      if (tokens(changedText(store.dreamingInput(path, candidate))) <= 10000) low = middle;
      else high = middle - 1;
    }
    ids = events.slice(0, low).map(e => e.id);
    if (!ids.length) throw new Error("Dreaming capacity: oldest change with its current body and framing exceeds 10000; left pending");
  } else {
    // The range is immutable audit/authority, not an immutable batch. A conflict can make current
    // descendants larger, so every later admission selects again from its still-unsettled events.
    // Earlier legal outputs are mandatory candidates and are certified first if they leave no room.
    const own = store.dreamingInput(path, [], ownCommits);
    if (tokens(changedText(own)) > 10000)
      throw new Error("Dreaming capacity: retained task output with its current body and framing exceeds 10000; left pending");
    const pending = new Set(store.pendingKnowledgeEvents(path).map(event => event.id));
    const blocked: number[] = [];
    for (const id of retained.eventIds.filter(eventId => pending.has(eventId))) {
      const candidate = [...ids, id];
      if (tokens(changedText(store.dreamingInput(path, candidate, ownCommits))) <= 10000) { ids = candidate; continue; }
      if (ids.length || own.versions.length) break;
      // One enlarged item is not allowed to pin every other independently fit retained event. It
      // remains unsettled and keeps the same logical anchor; no omission is certified as progress.
      blocked.push(id);
    }
    if (!ids.length && !own.versions.length)
      throw new Error(`Dreaming capacity: retained changes ${blocked.map(id => `K@${id}`).join(", ") || "(none)"} each exceed 10000 with their current body and framing; left pending`);
  }
  const changed = store.dreamingInput(path, ids, ownCommits);
  if (tokens(changedText(changed)) > 10000) throw new Error("Dreaming capacity: selected retained changed material exceeds 10000; left pending");
  const processed = store.listCurrentKnowledge(path).filter(v => store.isKnowledgeProcessed(v.revision.id));
  let old = processedBlock(processed), oldIds = processed.map(v => v.revision.id);
  if (tokens(`Processed knowledge:\n${old}`) > 20000) {
    const query = [...changed.versions, ...changed.predecessors].map(v => v.revision.text).join("\n");
    const scores = new Map(processed.map(v => [v.revision.id, similarity(query, v.revision.text)]));
    const selected = budgetKnowledge(processed, 20000 - tokens("Processed knowledge:\n"), undefined, "Dreamer processed input", undefined,
      (a, b) => scores.get(b.revision.id)! - scores.get(a.revision.id)!);
    old = [renderKnowledgeBlock(selected.groups.filter(g => g.text)), ...selected.receipts].join("\n");
    oldIds = selected.commits;
  }
  old = `Processed knowledge:\n${old}`;
  if (tokens(old) > 20000) throw new Error("Dreaming processed input exceeds 20000 including framing");
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
  const range = store.retainDreamingRange(path, ids, supplied.map(v => v.knowledge.id));
  return { sessionId: path.sessionId, branch: path.branch, path, range, eventIds: ids, changed, material, text,
    profile: structuredClone(config.render), model: input.model ?? "session", mode: "subagent" as const,
    readKnowledgeCommits: supplied.map(v => ({ knowledgeId: v.knowledge.id, commit: v.revision.id })),
    commitBoundary: Number(store.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM knowledge_revisions").get()!.id),
    maxToolRounds: config.dreaming.maxToolRounds };
}

export async function runDreaming(store: Store, frozen: ReturnType<typeof freezeDreaming>, runAgent: RunAgent,
  bind: (context: Parameters<typeof bindTools>[2], run: RunInput, review?: undefined, dreaming?: Parameters<typeof bindTools>[6]) => ReturnType<typeof bindTools>): Promise<DreamingResult> {
  const { sessionId, branch, path, range, eventIds, readKnowledgeCommits } = frozen;
  let rounds = 0, repaired = false;
  const run: RunInput = { kind: "dreaming", sessionId, branch, dreamingRangeId: range.id, model: frozen.model, mode: "subagent",
    promptHash, rangeFrom: `K@${range.anchor}`, rangeTo: `K@${range.eventIds.at(-1)}`, createdAt: new Date().toISOString() };
  // Reading grants exact write handles, not certification. This execution may certify its frozen
  // versions and this retained task's own outputs, but never a later external version merely read.
  const admitted = new Set(readKnowledgeCommits.map(v => v.commit));
  const changedAtFreeze = new Set(frozen.changed.versions.map(v => v.revision.id));
  const check = () => {
    const problems: string[] = [...binding.memory.problems, ...binding.toolProblems];
    const externalSuccessors: { knowledgeId: number; commit: number }[] = [];
    let family = range.knowledgeIds;
    try { family = store.validateDreamingRun(run, path, true).knowledgeIds; } catch (error) { problems.push(String(error)); }
    const own = store.dreamingOwnCommits(range.id);
    const state = store.dreamingInput(path, eventIds, own);
    const graph = store.commitGraph(path);
    const descendantsOfFrozen = new Set<number>();
    for (const handle of readKnowledgeCommits) if (family.includes(handle.knowledgeId) || changedAtFreeze.has(handle.commit)) {
      const descendants = graph.descendants(handle.commit);
      for (const id of descendants) descendantsOfFrozen.add(id);
      if (!graph.current.some(r => r.knowledgeId === handle.knowledgeId || descendants.has(r.id)))
        problems.push(`K${handle.knowledgeId}@${handle.commit}: no applicable result remains on the frozen path`);
    }
    const eligible = new Set([...admitted, ...own]);
    for (const id of own) if (!descendantsOfFrozen.has(id))
      for (const child of graph.descendants(id)) descendantsOfFrozen.add(child);
    // Settled event labels may disappear from state after another target completes them. The
    // actual current descendants of exactly what this execution read still decide staleness, while
    // only the selected changed results are candidates for a new processing certificate.
    const results = graph.current.filter(r => descendantsOfFrozen.has(r.id));
    for (const revision of results) if (!eligible.has(revision.id)) {
      if (revision.id > frozen.commitBoundary && descendantsOfFrozen.has(revision.id))
        externalSuccessors.push({ knowledgeId: revision.knowledgeId, commit: revision.id });
      else problems.push(`K${revision.knowledgeId}@${revision.id}: result is not an admitted version or this task's own descendant`);
    }
    // A later execution may freeze the actual merge result without adding its identity to the
    // writable family. A trace during this execution still grants no certification.
    const resultIds = state.versions.map(v => v.revision).filter(v => eligible.has(v.id)).map(v => v.id).sort((a, b) => a - b);
    // Recheck every scope touched by the frozen handles, including a read-only successor, but add
    // only true changed-result candidates to the tentative processed set.
    const affected = new Set([...results, ...frozen.changed.versions.map(v => v.revision)].map(revision => placementOwner(store, { revision })));
    const scopes = checkProcessedScopes(store, resultIds, affected);
    problems.push(...scopes.problems);
    return { family, eventIds, retainedEventIds: range.eventIds, resultIds, pendingEventIds: state.events.map(e => e.id),
      versions: state.versions.map(v => ({ knowledgeId: v.revision.knowledgeId, commit: v.revision.id, processed: store.isKnowledgeProcessed(v.revision.id) })),
      ...scopes, externalSuccessors, failures: problems,
      problems: [...problems, ...externalSuccessors.map(v => `K${v.knowledgeId}@${v.commit}: external successor after freeze${family.includes(v.knowledgeId) ? "" : " outside frozen family; read-only"}; reading alone cannot certify it`)],
      remainingRounds: Math.max(0, frozen.maxToolRounds - rounds), repairAvailable: !repaired };
  };
  const binding = bind({ kind: "dreaming", sessionId, branch, headTurnId: path.headTurnId,
    range: { from: run.rangeFrom!, to: run.rangeTo! }, readKnowledgeCommits }, run, undefined, { path, check: () => JSON.stringify(check()) });
  const passEnd = (used: number): string | undefined => {
    rounds = used;
    const checked = check();
    if (!checked.problems.length || repaired || rounds >= frozen.maxToolRounds) return;
    repaired = true;
    return `System-generated Dreamer completion check (not evidence). One repair, ${checked.remainingRounds} tool rounds remain:\n${checked.problems.join("\n")}`;
  };
  let result: RunAgentResult;
  try { result = await runAgent({ kind: "dreaming", sessionId, branch, model: frozen.model, mode: "subagent", prompt, promptHash,
    text: frozen.text, material: frozen.material, tools: binding.tools, reportRequest: binding.reportRequest,
    passEnd, reportRounds: (used: number) => { rounds = used; } } satisfies DreamingAgentInput); }
  catch (error) { result = agentException(error); }
  binding.close();
  if (store.closed) return { outcome: "dropped" };
  const checked = check();
  const problems = [...checked.problems, ...(result.outcome !== "success" ? [String(result.output ?? result.outcome)] : []),
    ...(requestMissing(result) ? ["runAgent must return the exact provider request"] : [])];
  recordAttempt(run, result, "subagent", { toolCalls: binding.sequence, fetched: binding.fetched, material: frozen.material,
    profile: frozen.profile, readKnowledgeCommits, commitBoundary: frozen.commitBoundary,
    committed: binding.memory.allCommitted, check: checked, rounds, repaired, problems });
  const runId = store.dreamingRunId(run)!;
  if (result.outcome === "success" && !requestMissing(result) && !checked.failures.length) {
    try {
      return store.transaction(() => {
        // Both successful completion and the sole non-penalizing business exception are decided
        // against a coherent final graph. Persist audit + settlement together, before returning.
        const final = check();
        if (final.failures.length) throw new Error(final.problems.join("; "));
        const outcome = final.externalSuccessors.length ? "conflict" as const : "success" as const;
        run.response = JSON.stringify({ ...JSON.parse(run.response!), check: final, problems: final.problems });
        store.updateRun(runId, { ...run, outcome });
        if (outcome === "conflict") store.settleDreamingConflict(run, final.problems.join("; "));
        else store.completeDreaming(runId, eventIds, final.resultIds);
        return { outcome, runId, problems: final.problems };
      });
    } catch (error) { problems.push(String(error)); }
  }
  const outcome = result.outcome === "cancelled" ? "cancelled" : "failure";
  run.response = JSON.stringify({ ...JSON.parse(run.response!), problems });
  store.updateRun(runId, { ...run, outcome });
  return { outcome, runId, problems };
}
