import type { bindTools } from "../api/tools.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Fact, type MemoryBatch } from "../model/index.ts";
import { type ConsolidationDiagnostic } from "./commit.ts";
import type { CommittedKnowledgeOp, Store, RunInput } from "../store/index.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig, TaskOptions, AgentControl } from "../api/index.ts";
import { renderKnowledge, renderFact, renderFactGroups, tokens, charge, type FactTurns } from "../render/index.ts";
import { toolDefinitions } from "../api/tools.ts";
import { budgetMaterial, consolidationText, consolidationIncrement, CONSOLIDATED_TITLE, RANGE_FACTS_TITLE, REMINDER_TITLE,
  type MaterialText, type ConsolidationMaterial } from "../render/material.ts";

const prompt = readFileSync(new URL("../prompts/consolidation.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");
const sectionStart = prompt.indexOf("### Second-round user message\n") + "### Second-round user message\n".length;
const checklist = prompt.slice(sectionStart, prompt.indexOf("\n### ", sectionStart));
// 22d, as in Noting: the instructions and the tool definitions are the same bytes for the life of the
// process, so they are estimated once instead of once per re-freeze. Lazily, because `toolDefinitions`
// reaches this module through an import cycle and is not yet initialized while this module body runs.
let fixed: { instructions: number; tools: number } | undefined;
const fixedCost = () => (fixed ??= { instructions: tokens(prompt), tools: tokens(JSON.stringify(toolDefinitions)) });

export type { ConsolidationDiagnostic } from "./commit.ts";

export interface ConsolidateInput extends TaskOptions {
  sessionId: number; branch: string; headTurnId?: number; model?: string; mode?: "fork" | "subagent";
  /** Host model capacity after reserving output; prefix includes native tools and context (review 2026-09-08: Consolidation negotiates capacity exactly as Noting does). */
  capacity?: { inputTokens: number; prefixTokens: number };
}
export interface ConsolidationRange { from: string; to: string; facts: Fact[] }
export interface NearPair { candidate: string; knowledge: string; score: number }
/** The frozen task material of one Consolidation run: the shared parts (knowledge, already-
 * consolidated historical facts, receipts) plus this task's pending facts and review cues. Core
 * renders and budgets the parts and prepares their text (20a); no field is a provider message. */
export type { ConsolidationMaterial } from "../render/material.ts";
export interface ConsolidationAgentInput extends AgentControl {
  kind: "consolidation";
  sessionId: number;
  branch: string;
  range: ConsolidationRange;
  readKnowledgeCommits: { knowledgeId: number; commit: number }[];
  model: string;
  mode: "fork" | "subagent";
  /** The domain instructions; core owns the prompt file and its hash. */
  prompt: string;
  promptHash: string;
  material: ConsolidationMaterial;
  /** Core's prepared domain text, both representations from this one frozen task (20a). The host
   * chooses one by the native context capability it has, and places it in its own messages. */
  text: MaterialText;
  /** Core's own reader of a `memory` receipt: the review guidance the adapter must put in front of
   * the model as a user message before the second submission, or undefined. The two-submission
   * protocol stays in core; the adapter only chooses the message or steering mechanism. */
  reviewFeedback(toolResult: string): string | undefined;
  tools: import("../api/tools.ts").ToolDefinition[];
  reportRequest(request: unknown): void;
}
export type ConsolidateResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[] }
  | { outcome: "success"; runId: number; output: MemoryBatch; problems?: string[];
      committed: CommittedKnowledgeOp[]; diagnostics: ConsolidationDiagnostic[];
      range: ConsolidationRange; readKnowledgeCommits: { knowledgeId: number; commit: number }[]; unansweredNear: NearPair[] };

export function freezeConsolidation(store: Store, input: ConsolidateInput, config: TraceMemoryConfig) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("consolidation requires a non-empty branch");
  const facts = store.listProjectFacts(session.projectId);
  const rangeFactsAll = store.consolidationBatch(session.id, input.branch, input.headTurnId);
  // A manual catchup (18b) freezes an explicit fact-id set: the pending facts at freeze time plus
  // whatever the frozen Noting batches went on to produce. Later unrelated facts stay outside it.
  const applicable = input.boundary?.factIds === undefined ? rangeFactsAll : rangeFactsAll.filter(f => input.boundary!.factIds!.includes(f.id));
  const capacity = input.capacity;
  if (capacity && (!Number.isSafeInteger(capacity.inputTokens) || capacity.inputTokens < 0 ||
    !Number.isSafeInteger(capacity.prefixTokens) || capacity.prefixTokens < 0)) throw new Error("Invalid Consolidation capacity: expected nonnegative safe integers");
  const mode = input.mode ?? (config.consolidation.subagentModeDefault ? "subagent" : "fork");
  // 22d, hotspot family 6, the twin of the Noting preflight: the instructions, the tool definitions
  // and — for a fork — the inherited prefix are unavoidable, so no batch is priced below them. An
  // allowance under that floor is rejected before a single fact line is rendered, instead of after
  // the batch has been re-frozen once per fact down to nothing. A floor, not the guard: the hard
  // budget check inside the loop below is unchanged and still decides every freeze that passes here.
  const { instructions, tools } = fixedCost();
  const mandatory = Math.max(instructions + tools,
    (input.effectiveMode ?? mode) === "fork" ? (capacity?.prefixTokens ?? 0) + instructions : 0);
  if (capacity && applicable.length && mandatory > capacity.inputTokens)
    throw new Error(`Consolidation capacity: oldest fact with its mandatory cues cannot fit the episodic budget or the model context: instructions, tools and the inherited prefix alone cost ${mandatory} of the ${capacity.inputTokens} tokens allowed for input; left pending`);
  const path = store.knowledgePath(session.id, input.branch, input.headTurnId);
  const knowledge = store.listCurrentKnowledge(path);
  const relations = new Map(facts.map((f) => [f.id, store.listFactRelations(f.id)]));
  const lines = new Map(facts.map((f) => [f.id, renderFact(f, relations.get(f.id)!)]));
  const byId = new Map(facts.map(f => [f.id, f]));
  const factTurns = store.factTurnTimes(facts);
  // Ticket 20 "Consolidation": the oldest-first whole-fact prefix whose rendered lines — the same
  // representation, relations and joining separator the trigger and the run itself count — fit
  // `consolidation.batchTokens`. Arrival order is the store's; path eligibility is already applied.
  // "Oversized fact": a fact has no primary-entry-style size bound, so an oldest one that cannot fit
  // alone stays pending with a capacity problem. It is never clipped, skipped for a smaller later
  // fact, or marked consolidated without being presented.
  const rangeFacts: Fact[] = [];
  for (const fact of applicable) {
    const candidate = renderFactGroups([...rangeFacts, fact], f => lines.get(f.id)!, factTurns);
    if (tokens(candidate.join("\n")) > config.consolidation.batchTokens) break;
    rangeFacts.push(fact);
  }
  if (applicable.length && !rangeFacts.length) throw new Error("Consolidation capacity: oldest fact exceeds consolidation.batchTokens; left pending");
  // The negated-evidence cues are mandatory material and grow with the selected facts, so they are
  // derived per candidate batch: a smaller batch has fewer cues.
  const remindersFor = (batch: Fact[]): string[] => {
    const reminders: string[] = [];
    for (const item of knowledge) for (const fact of batch) {
      for (const edge of relations.get(fact.id)!) {
        if (edge.fromFact !== fact.id || edge.kind !== "negate" || !item.revision.supports.includes(edge.toFact)) continue;
        let cited = byId.get(edge.toFact);
        if (!cited) {
          cited = store.getFact(edge.toFact)!;
          byId.set(cited.id, cited);
          lines.set(cited.id, renderFact(cited, store.listFactRelations(cited.id)));
          if (!factTurns.has(cited.turnId)) for (const [id, time] of store.factTurnTimes([cited])) factTurns.set(id, time);
        }
        reminders.push([renderKnowledge(item), `Recorded negation strength: ${edge.strength}`,
          `Cited fact: F${cited.id}; Negating fact: F${fact.id}`,
          ...renderFactGroups([cited, fact], f => lines.get(f.id)!, factTurns)].join("\n"));
      }
    }
    return reminders;
  };
  const context = store.listConsolidatedProjectFacts(session.projectId);
  // Ticket 20 "Complete task evidence" and "Capacity negotiation" (review 2026-09-08): the selected
  // facts, their mandatory cues and the framing must fit the episodic budget, and the rendered text
  // plus instructions and tools must fit the host's reported capacity. Neither is receipted away:
  // the batch shrinks oldest-first, whole facts only, and the reminders, the material and the write
  // eligibility re-freeze together on every step. An oldest fact that cannot fit alone stays pending.
  let history = Infinity; // the historical-fact allowance under negotiation; Infinity = the episodic budget decides
  while (rangeFacts.length) {
    const frozen = { path, projectId: session.projectId, sessionId: session.id, branch: input.branch, rangeFacts: [...rangeFacts], facts, factTurns,
      context: context.filter((f) => !rangeFacts.some((r) => r.id === f.id)), knowledge, lines, reminders: remindersFor(rangeFacts),
      model: input.model ?? "session", mode, threshold: config.consolidation.nearThreshold };
    const prepared = consolidationMaterial(frozen, config, history);
    const subagentTokens = instructions + tools + tokens(prepared.text.fresh);
    const forkTokens = (capacity?.prefixTokens ?? 0) + instructions + tokens(prepared.text.inherited);
    // Priced by the mode that will actually run (review 2026-09-08), not by the requested one.
    const priced = Math.max(subagentTokens, (input.effectiveMode ?? mode) === "fork" ? forkTokens : 0);
    const fits = !prepared.over.episodic && (!capacity || priced <= capacity.inputTokens);
    if (fits) return { ...frozen, prepared };
    // Optional history goes first (review 2026-09-08): trim the already-consolidated facts by the excess
    // before a selected fact is given up; only when none are left does the batch shrink.
    if (capacity && !prepared.over.episodic && prepared.material.facts.length) { history = Math.max(0, charge(prepared.material.facts) - (priced - capacity.inputTokens)); continue; }
    rangeFacts.pop(); history = Infinity;
  }
  if (applicable.length) throw new Error("Consolidation capacity: oldest fact with its mandatory cues cannot fit the episodic budget or the model context; left pending");
  const empty = { path, projectId: session.projectId, sessionId: session.id, branch: input.branch, rangeFacts, facts, context, knowledge, lines, factTurns, reminders: [] as string[],
    model: input.model ?? "session", mode, threshold: config.consolidation.nearThreshold };
  return { ...empty, prepared: undefined };
}

/** Every part of one run's material, rendered and budgeted once from the frozen task (ticket 20).
 * The selected pending facts take the current-material allowance — Consolidation has no automatic Raw
 * block — the titles, the range and the mandatory negation cues are charged to the episodic budget,
 * and the already-consolidated facts fill what is left of it. Core lays out both representations
 * (ruling 08:53); the host only decides which native message carries the text. */
function consolidationMaterial(frozen: { rangeFacts: Fact[]; context: Fact[]; knowledge: ReturnType<Store["listCurrentKnowledge"]>; lines: Map<number, string>; factTurns: FactTurns; reminders: string[] }, config: TraceMemoryConfig, history = Infinity) {
  const { rangeFacts, context, knowledge, lines, factTurns, reminders } = frozen;
  const range = { from: `F${rangeFacts[0]!.id}`, to: `F${rangeFacts.at(-1)!.id}`, facts: rangeFacts };
  const grouped = renderFactGroups(rangeFacts, f => lines.get(f.id)!, factTurns);
  const budgeted = budgetMaterial({ knowledge, current: grouped.join("\n"),
    framing: [CONSOLIDATED_TITLE, RANGE_FACTS_TITLE, REMINDER_TITLE, ...reminders], range, label: "range",
    facts: context, factLine: (f) => lines.get(f.id)!, factTurns, history,
    caps: { knowledge: config.render.knowledgeBlockTokens, episodic: config.render.episodicBlockTokens, current: config.consolidation.batchTokens } });
  const material: ConsolidationMaterial = {
    factAddresses: rangeFacts.map((f) => `F${f.id}`),
    rangeFacts: grouped,
    knowledge: budgeted.knowledge.filter((g) => g.text),
    facts: budgeted.facts,
    reminders,
    receipts: budgeted.receipts,
  };
  const text: MaterialText = { fresh: consolidationText(material, range), inherited: consolidationIncrement(material, range) };
  return { range, material, text, over: budgeted.over };
}

// Unicode character bigrams retain CJK text; punctuation and whitespace are ignored.
function bigrams(text: string): Set<string> {
  const chars = [...text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "")];
  return new Set(chars.slice(1).map((c, i) => chars[i]! + c));
}
function similarity(a: string, b: string): number {
  const left = bigrams(a), right = bigrams(b);
  const intersection = [...left].filter((gram) => right.has(gram)).length;
  const union = left.size + right.size - intersection;
  return union ? intersection / union : 0;
}
const candidates = (output: MemoryBatch) => output.operations.flatMap((op, i) => op.op === "archive" ? [] : [{ id: op.op === "create" ? `$e${i + 1}` : op.id!, text: op.text! }]);

export async function runConsolidation(store: Store, frozen: ReturnType<typeof freezeConsolidation>, runAgent: RunAgent,
  config: TraceMemoryConfig, bind: (context: Parameters<typeof bindTools>[2], run: RunInput, review: import("./memory.ts").MemoryReview) => ReturnType<typeof bindTools>): Promise<ConsolidateResult> {
  const { sessionId, branch, rangeFacts, knowledge, lines, factTurns, model, mode, threshold } = frozen;
  if (!rangeFacts.length || !frozen.prepared) return { outcome: "empty" };
  // The material was rendered and budgeted when the task was frozen (consolidationMaterial), so the
  // batch that runs is exactly the batch whose size was checked.
  const { range, material, text } = frozen.prepared;
  const readKnowledgeCommits = knowledge.map(({ knowledge, revision }) => ({ knowledgeId: knowledge.id, commit: revision.id }));
  // A first valid `memory` batch commits nothing and returns the review guidance inside its receipt,
  // as a user-role message. Core owns that protocol and reads its own receipt; the adapter only
  // decides how to put the message in front of the model (native message, steering, appended turn).
  const reviewFeedback = (toolResult: string): string | undefined => {
    try { const value = JSON.parse(toolResult); return value?.feedback?.role === "user" ? String(value.feedback.content) : undefined; }
    catch { return undefined; }
  };
  const base = { kind: "consolidation" as const, sessionId, branch, range, readKnowledgeCommits, model, mode, prompt, promptHash };
  const run: RunInput = { kind: "consolidation", sessionId, branch, rangeFrom: range.from, rangeTo: range.to, promptHash, model, mode, createdAt: new Date().toISOString() };
  const label = (item: typeof knowledge[number]) => `K${item.knowledge.id}` +
    (knowledge.filter(k => k.knowledge.id === item.knowledge.id).length > 1 ? `@${item.revision.id}` : "");
  const binding = bind({ kind: "consolidation", sessionId, branch, headTurnId: frozen.path.headTurnId, range, readKnowledgeCommits }, run, { frozen, feedback: (batch) => {
  const near: NearPair[] = candidates(batch).flatMap((c) => knowledge
    .map(item => ({ candidate: c.id, knowledge: label(item), score: similarity(c.text, item.revision.text) }))
    .filter((p) => p.knowledge !== c.id && p.score >= threshold).sort((a, b) => b.score - a.score));
  const nearText = near.map((p) => `${p.candidate} -> ${p.knowledge} (Jaccard ${p.score})\n${renderKnowledge(knowledge.find((e) => label(e) === p.knowledge)!)}`);
  const closer = knowledge.filter(({ revision }) => revision.category === "open" || revision.category === "goal").flatMap((knowledge) => {
    const matches = rangeFacts.map(fact => ({ fact, score: similarity(knowledge.revision.text, fact.text) }))
      .filter(p => p.score >= threshold);
    if (!matches.length) return [];
    const scores = new Map(matches.map(p => [p.fact.id, p.score]));
    return [[renderKnowledge(knowledge), ...renderFactGroups(matches.map(p => p.fact),
      f => `Jaccard ${scores.get(f.id)}\n${lines.get(f.id)!}`, factTurns)].join("\n")];
  });
  const feedback = ["System-generated review guidance; not a human ruling or adoption evidence.",
    "NEAR:", nearText.join("\n\n") || "none", "CLOSER:", closer.join("\n\n") || "none"].join("\n\n") + "\n" + checklist;
    return { text: feedback, near };
  } });
  let result: RunAgentResult;
  try { result = await runAgent({ ...structuredClone(base), material, text, reviewFeedback, tools: binding.tools, reportRequest: binding.reportRequest }); }
  catch (error) { result = { outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failure", output: error instanceof Error ? error.message : String(error) }; }
  binding.close();
  // A direct facade close may dispose before the provider settles; never access that store.
  if (store.closed) return binding.memory.committed ? { outcome: "success", ...binding.memory.committed, range, readKnowledgeCommits } : { outcome: "dropped" };
  run.mode = result.mode ?? mode;
  if (result.request != null) run.request = JSON.stringify(result.request);
  const committed = binding.memory.committed;
  // A host that cannot expose a provider request says so; core records the limitation instead of the
  // missing-request problem. A host expected to capture one and returning none still gets it.
  const unavailable = result.audit?.available === false;
  const problems = result.outcome !== "success" ? [String(result.output ?? result.outcome)] : result.request == null && !unavailable ? ["runAgent must return the exact provider request"] : binding.memory.problems;
  run.response = JSON.stringify({ output: result.output, usage: result.usage ?? null, ...(result.outcome === "cancelled" ? { usageStatus: result.usage == null ? "unknown" : "partial" } : {}), readKnowledgeCommits, toolCalls: binding.sequence, fetched: binding.fetched,
    candidate: binding.memory.candidate, problems, requestedMode: mode, ...(result.audit !== undefined ? { audit: result.audit } : {}),
    ...(committed ? { committed: committed.committed, diagnostics: committed.diagnostics } : {}),
    ...(result.verification !== undefined ? { verification: result.verification } : {}), ...(result.fallbackReason !== undefined ? { fallbackReason: result.fallbackReason } : {}),
    ...(result.nativeLog !== undefined ? { nativeLog: result.nativeLog } : {}),
    ...(result.retries?.length ? { retries: result.retries } : {}) });
  if (committed) {
    const after = [...problems];
    try { store.updateRun(committed.runId, { ...run, outcome: "success" }); }
    catch (error) { after.push(`audit update failed after commit: ${String(error)}`); }
    return { outcome: "success", ...committed, range, readKnowledgeCommits, ...(after.length ? { problems: after } : {}) };
  }
  const outcome = result.outcome !== "success" ? result.outcome : (result.request == null && !unavailable) || binding.memory.failure ? "failure" : problems.length ? "bounced" : "success";
  if (outcome !== "success") {
    const runId = binding.memory.failure?.runId ?? store.recordRun({ ...run, outcome }).id;
    if (binding.memory.failure) store.updateRun(runId, { ...run, outcome });
    return { outcome, runId, problems };
  }
  const empty = store.commitConsolidationRun({ run, operations: [], consolidated: rangeFacts.map((f) => f.id) });
  return empty.ok ? { outcome: "success", ...empty, output: { operations: [], skipped: [] }, diagnostics: [], unansweredNear: [], range, readKnowledgeCommits }
    : { outcome: "failure", runId: empty.runId, problems: empty.problems };
}
