import type { bindTools } from "../api/tools.ts";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Fact, type MemoryBatch } from "../model/index.ts";
import { type ConsolidationDiagnostic } from "./commit.ts";
import type { CommittedKnowledgeOp, Store, RunInput } from "../store/index.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig, TaskOptions, AgentControl } from "../api/index.ts";
import { renderKnowledge, renderFact, renderFactGroups, tokens, charge, type FactTurns } from "../render/index.ts";
import { toolDefinitions } from "../api/tools.ts";
import { agentException, recordAttempt, requestMissing, updateCommitted } from "../api/audit.ts";
import { knowledgeStatusNotes } from "../api/read.ts";
import { budgetMaterial, consolidationText, RANGE_FACTS_TITLE, REMINDER_TITLE,
  type ConsolidationMaterial } from "../render/material.ts";
import { noVisibility, type InitialContext, type SuppliedMaterial } from "../api/visible.ts";

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
  /** 29e (parent 29, superseding 25b): two modes again, selected exactly as Noting's are — the
   * request's own `mode`, or `consolidation.forkModeDefault`. */
  sessionId: number; branch: string; headTurnId?: number; model?: string; mode?: "fork" | "subagent";
  /** Host model capacity (27a; review 2026-09-08: Consolidation negotiates capacity exactly as Noting
   * does). `inputTokens` is the model's context window minus the host's fixed headroom — no output
   * reserve enters it. One shape for both phases; `prefixTokens` is an inherited context's cost, and
   * since 29e this phase can inherit one, so a fork is priced with it exactly as Noting's is. */
  capacity?: { inputTokens: number; prefixTokens: number };
}
export interface ConsolidationRange { from: string; to: string; facts: Fact[] }
export interface NearPair { candidate: string; knowledge: string; score: number }
/** The frozen task material of one Consolidation run: the shared parts (knowledge, receipts) plus
 * this task's pending facts and review cues. Core renders and budgets the parts and prepares their
 * text (20a); no field is a provider message. */
export type { ConsolidationMaterial } from "../render/material.ts";
export interface ConsolidationAgentInput extends AgentControl {
  kind: "consolidation";
  sessionId: number;
  branch: string;
  range: ConsolidationRange;
  readKnowledgeCommits: { knowledgeId: number; commit: number }[];
  model: string;
  /** The mode this task was frozen for (29e: both values are reachable again). */
  mode: "fork" | "subagent";
  /** The domain instructions; core owns the prompt file and its hash. */
  prompt: string;
  promptHash: string;
  material: ConsolidationMaterial;
  /** Core's prepared domain text: the one material this task supplies, whatever mode runs it (29b). */
  text: string;
  /** 29a/29b: the identities this text actually carries, for the carrier a host persists with it. */
  supplied: SuppliedMaterial;
  /** Core's own reader of a `memory` receipt: the review guidance the adapter must put in front of
   * the model as a user message before the second submission, or undefined. The two-submission
   * protocol stays in core; the adapter only chooses the message or steering mechanism. */
  reviewFeedback(toolResult: string): string | undefined;
  tools: import("../api/tools.ts").ToolDefinition[];
  reportRequest(request: unknown): void;
}
export type ConsolidateResult = { executionId?: string; automaticOff?: string } & (
  // 27d: two variants rather than one union member — a dropped task may name why it dropped, and the
  // outcome alone is what narrows the results that own a `problems` list.
  // 29e: and, as Noting's has since 27c/27d, it may carry the host's fork refusal and the run record
  // of the attempt that raised it, for the host to re-admit on.
  | { outcome: "dropped"; reason?: string; refused?: unknown; runId?: number }
  | { outcome: "empty" }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[] }
  | { outcome: "success"; runId: number; output: MemoryBatch; problems?: string[];
      committed: CommittedKnowledgeOp[]; diagnostics: ConsolidationDiagnostic[];
      range: ConsolidationRange; readKnowledgeCommits: { knowledgeId: number; commit: number }[]; unansweredNear: NearPair[] });

/** 27b's twin for this phase (29e): the opening of both capacity refusals a Consolidation freeze can
 * raise — the preflight floor and the loop exit that pops the batch down to its oldest fact. The Pi
 * host matches this one string to tell "this batch does not fit the model" from every other admission
 * failure, and reroutes a fork that raised it to the subagent path with its own capacity. */
export const CONSOLIDATION_CAPACITY = "Consolidation capacity: oldest fact with its mandatory cues cannot fit consolidation.batchTokens or the model context: ";

/** 29e, the twin of `NOTING_MEMBERSHIP` (27d, parent 27 amendment 6): the opening of the diagnostic an
 * `exactFactIds` freeze raises when its exact membership is no longer pending in full. The evidence was
 * consolidated elsewhere — another executor's claim completed it — so the task is dropped rather than
 * retried and nothing is re-processed. The façade matches this one string to tell it from an admission
 * failure. */
export const CONSOLIDATION_MEMBERSHIP = "Consolidation membership: the frozen batch is no longer pending in full: ";

export function freezeConsolidation(store: Store, input: ConsolidateInput, config: TraceMemoryConfig) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("consolidation requires a non-empty branch");
  const facts = store.listProjectFacts(session.projectId);
  const rangeFactsAll = store.consolidationBatch(session.id, input.branch, input.headTurnId);
  // A manual catchup (18b) freezes an explicit allowable fact-id set: the pending facts at freeze time
  // plus whatever the frozen Noting batches went on to produce. Later unrelated facts stay outside it,
  // and a drain still takes it in bounded batches.
  // 29e (parent 27 amendment 6, as 27d did it for Noting): `exactFactIds` is the other meaning — the
  // frozen target of a fork attempt the host is re-admitting. It is taken whole or not at all: a member
  // no longer pending was consolidated by another executor under its own claim, which drops the task
  // here instead of re-processing the rest of the batch as though it were a fresh one.
  const exact = input.boundary?.exactFactIds;
  const allowed = input.boundary?.allowedFactIds;
  const applicable = exact ? rangeFactsAll.filter(f => exact.includes(f.id))
    : allowed === undefined ? rangeFactsAll : rangeFactsAll.filter(f => allowed.includes(f.id));
  if (exact && applicable.length !== exact.length)
    throw new Error(`${CONSOLIDATION_MEMBERSHIP}facts ${exact.filter(id => !applicable.some(f => f.id === id)).map(id => `F${id}`).join(", ")} `
      + `of the frozen batch ${exact.map(id => `F${id}`).join(", ")} are no longer pending; nothing was re-processed`);
  const capacity = input.capacity;
  if (capacity && (!Number.isSafeInteger(capacity.inputTokens) || capacity.inputTokens < 0 ||
    !Number.isSafeInteger(capacity.prefixTokens) || capacity.prefixTokens < 0)) throw new Error("Invalid Consolidation capacity: expected nonnegative safe integers");
  // 29e: the mode is selected exactly as `freezeNoting` selects it — the request's own, or this
  // phase's configured default. `effectiveMode` still decides what the material and the price are
  // built for (a requested fork the host will actually run fresh).
  const mode = input.mode ?? (config.consolidation.forkModeDefault ? "fork" : "subagent");
  const inheriting = (input.effectiveMode ?? mode) === "fork";
  // 22d, hotspot family 6, the twin of the Noting preflight: the instructions and the tool
  // definitions are unavoidable, so no batch is priced below them. An allowance under that floor is
  // rejected before a single fact line is rendered, instead of after the batch has been re-frozen
  // once per fact down to nothing. A floor, not the guard: the hard budget check inside the loop
  // below is unchanged and still decides every freeze that passes here.
  // 29b/29e: the floor is the price of the mode that will run, as the loop below prices it — a fork
  // pays its inherited measure and the instructions, a fresh child the instructions and the tools.
  const { instructions, tools } = fixedCost();
  const mandatory = inheriting ? (capacity?.prefixTokens ?? 0) + instructions : instructions + tools;
  if (capacity && applicable.length && mandatory > capacity.inputTokens)
    throw new Error(`${CONSOLIDATION_CAPACITY}${inheriting ? `instructions ${instructions} and the inherited context ${capacity.prefixTokens}` : `instructions ${instructions} and tools ${tools}`}`
      + ` already cost ${mandatory} of the ${capacity.inputTokens} tokens allowed for input; left pending`);
  const path = store.knowledgePath(session.id, input.branch, input.headTurnId);
  const knowledge = store.listCurrentKnowledge(path);
  // 29b "Same builder, different initial state", the twin of the Noting freeze: the host supplies the
  // view only for a task it will really fork; an explicit subagent and a fork re-admitted as one (27c)
  // arrive without it and get the fresh child's empty start.
  const initial: InitialContext = { visible: inheriting && input.visible ? input.visible : noVisibility(),
    inheritedTokens: inheriting ? capacity?.prefixTokens ?? 0 : 0 };
  // Parent 29 "Version-aware knowledge": a commit the child inherited that is not among this path's
  // current applicable commits is stale — superseded, archived or merged away — and the block below
  // carries only what is current, so nothing in it would contradict the inherited text. One line per
  // stale commit says what happened to it. Computed once for the freeze: the batch does not affect it.
  // 31 made this the shared rule: the main agent's knowledge block explains a stale commit the same way.
  const knowledgeNotes = knowledgeStatusNotes(store, knowledge, initial.visible.knowledgeCommitIds, path);
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
  // 29e: the same whole-or-nothing rule against the batch ceiling the selection loop above stops at.
  // A membership selected under that ceiling once can only fail this on a configuration change, and
  // then its facts wait together rather than half of them running.
  if (exact && rangeFacts.length !== applicable.length)
    throw new Error(`${CONSOLIDATION_CAPACITY}the frozen batch of ${applicable.length} facts exceeds consolidation.batchTokens (${config.consolidation.batchTokens}); left pending`);
  // The negated-evidence cues are mandatory material and grow with the selected facts, so they are
  // derived per candidate batch: a smaller batch has fewer cues.
  const remindersFor = (batch: Fact[]) => {
    const reminders: string[] = [];
    const reminderCommits = new Set<number>();
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
        reminderCommits.add(item.revision.id);
        reminders.push([renderKnowledge(item), `Recorded negation strength: ${edge.strength}`,
          `Cited fact: F${cited.id}; Negating fact: F${fact.id}`,
          ...renderFactGroups([cited, fact], f => lines.get(f.id)!, factTurns)].join("\n"));
      }
    }
    return { reminders, reminderCommits };
  };
  // Ticket 20 "Complete task evidence" and "Capacity negotiation" (review 2026-09-08): the selected
  // facts, their mandatory cues and the framing must fit the pending-fact allowance, and the rendered
  // text plus instructions and tools must fit the host's reported capacity. Neither is receipted away:
  // the batch shrinks oldest-first, whole facts only, and the reminders, the material and the write
  // eligibility re-freeze together on every step. An oldest fact that cannot fit alone stays pending.
  // 25a removed this phase's already-consolidated history block; since 29b the knowledge block is the
  // one optional material left, and 29e trims it before a selected fact is given up (the twin of the
  // Noter's history trim).
  let last: { priced: number; episodic: number } | undefined; // what the smallest candidate cost, for the diagnostic
  let optionalKnowledge = true;
  while (rangeFacts.length) {
    const frozen = { path, projectId: session.projectId, sessionId: session.id, branch: input.branch, rangeFacts: [...rangeFacts], facts, factTurns,
      knowledge, knowledgeNotes, lines, ...remindersFor(rangeFacts),
      model: input.model ?? "session", mode, threshold: config.consolidation.nearThreshold };
    const prepared = consolidationMaterial(frozen, config, initial, optionalKnowledge);
    // Priced by the mode that runs (29b's one line, as in Noting): the subagent's instructions, tools
    // and material today, and the inherited measure plus the newly supplied text once 29e can fork.
    const priced = inheriting ? initial.inheritedTokens + instructions + tokens(prepared.text)
      : instructions + tools + tokens(prepared.text);
    last = { priced, episodic: prepared.over.episodic };
    const fits = !prepared.over.episodic && (!capacity || priced <= capacity.inputTokens);
    if (fits) return { ...frozen, prepared };
    // 29e (parent 29 "Capacity, fallback and audit"): optional material goes before selected evidence.
    // The knowledge block is dropped whole rather than by a lowered cap, because a cap small enough to
    // matter here is also too small for the block's own omission receipt, which `budgetKnowledge`
    // refuses outright. The one line that replaces it is inside the priced text, so the check above
    // still charges it. The stale-commit status lines (29b) keep their reservation: an inherited
    // revision presented as current is a correctness problem, not a nicety.
    if (optionalKnowledge && !prepared.over.episodic && prepared.material.knowledge.length) { optionalKnowledge = false; continue; }
    // 29e (parent 27 amendment 6): under exact membership the batch never shrinks. Optional knowledge
    // is dropped above, as in any freeze; a batch that still does not fit leaves every frozen fact
    // pending under the diagnostic below, because a smaller batch is a membership change made after
    // execution had already started.
    if (exact) break;
    rangeFacts.pop(); optionalKnowledge = true;
  }
  // 27a: the diagnostic says what the numbers were — the last candidate the loop priced was the
  // smallest one, the oldest fact with its cues alone.
  if (applicable.length) throw new Error(CONSOLIDATION_CAPACITY
    + `${last!.episodic ? `it is ${last!.episodic} tokens over consolidation.batchTokens (${config.consolidation.batchTokens})` : `it costs ${last!.priced} tokens`}`
    + `${capacity ? ` against the ${capacity.inputTokens} tokens allowed for input` : ""}; left pending`);
  const empty = { path, projectId: session.projectId, sessionId: session.id, branch: input.branch, rangeFacts, facts, knowledge, knowledgeNotes, lines, factTurns, reminders: [] as string[], reminderCommits: new Set<number>(),
    model: input.model ?? "session", mode, threshold: config.consolidation.nearThreshold };
  return { ...empty, prepared: undefined };
}

/** The one Consolidation material builder (29b, parent 29 "One material-selection mechanism"). The
 * frozen task is the whole processing target — the oldest applicable pending whole-fact prefix, chosen
 * by `consolidation.batchTokens` alone — and `initial` is the child's starting point. Newly supplied
 * is the target minus the fact bodies the view holds by id, plus the current knowledge it does not
 * hold at that exact commit (a visible predecessor covers nothing), and only then the budgets.
 *
 * The two allowances are unchanged (ticket 20, as 25a corrected it): the knowledge within
 * `consolidation.knowledgeTokens` — which 29b's status lines are charged inside — and the pending facts
 * within `consolidation.batchTokens`, which also carries their review cues, the titles and the range,
 * because required framing belongs to the allowance of the material it frames. There is no automatic
 * Raw block and, since 25a, no already-consolidated history block: both are reached by explicit read. */
function consolidationMaterial(frozen: { rangeFacts: Fact[]; knowledge: ReturnType<Store["listCurrentKnowledge"]>; knowledgeNotes: string[]; lines: Map<number, string>; factTurns: FactTurns; reminders: string[]; reminderCommits: Set<number> }, config: TraceMemoryConfig, initial: InitialContext = { visible: noVisibility(), inheritedTokens: 0 }, optionalKnowledge = true) {
  const { rangeFacts, knowledge: applicable, knowledgeNotes, lines, factTurns, reminders } = frozen;
  const range = { from: `F${rangeFacts[0]!.id}`, to: `F${rangeFacts.at(-1)!.id}`, facts: rangeFacts };
  // The addresses name the whole frozen target — that is what this run must integrate — while the
  // bodies are only the facts the child cannot already read in its own context.
  const supplied = rangeFacts.filter(fact => !initial.visible.factIds.has(fact.id));
  const knowledge = applicable.filter(({ revision }) => !initial.visible.knowledgeCommitIds.has(revision.id));
  // 29e: the capacity negotiation dropped this run's optional knowledge block. It says so — a run that
  // silently received no knowledge would look like a session that has none — and the line is part of
  // the text the freeze prices, so it is charged where every other emitted component is.
  const grouped = renderFactGroups(supplied, f => lines.get(f.id)!, factTurns);
  const dropped = !optionalKnowledge && knowledge.length
    ? [`omitted all ${knowledge.length} current knowledge items; the model context left no room for the knowledge block; expand: trace K<n>`] : [];
  const budgeted = budgetMaterial({ ...(optionalKnowledge ? { knowledge } : {}), knowledgeNotes, current: grouped.join("\n"),
    framing: [RANGE_FACTS_TITLE, REMINDER_TITLE, ...reminders], range, label: "range",
    knowledgeBudget: "consolidation.knowledgeTokens",
    caps: { knowledge: config.consolidation.knowledgeTokens, episodic: config.consolidation.batchTokens, current: config.consolidation.batchTokens } });
  const material: ConsolidationMaterial = {
    factAddresses: rangeFacts.map((f) => `F${f.id}`),
    rangeFacts: grouped,
    knowledge: budgeted.knowledge.filter((g) => g.text),
    knowledgeNotes: budgeted.knowledgeNotes,
    reminders,
    receipts: [...budgeted.receipts, ...dropped],
  };
  const text = consolidationText(material, range);
  // 29a "Renderers return what they kept". This phase supplies no Raw (25a); the facts are the bodies
  // this text carries, and the commits are the ones the knowledge block kept after its cap.
  const keptIdentities: SuppliedMaterial = { entries: [], factIds: supplied.map(f => f.id), knowledgeCommitIds: budgeted.knowledgeCommitIds };
  // One authoritative list for write eligibility and the run audit. A reminder grants a read
  // only from the builder that emitted its complete body, never by parsing an address or summary.
  const readKnowledgeCommits = applicable.filter(item => initial.visible.knowledgeCommitIds.has(item.revision.id)
    || keptIdentities.knowledgeCommitIds.includes(item.revision.id)
    || frozen.reminderCommits.has(item.revision.id))
    .map(item => ({ knowledgeId: item.knowledge.id, commit: item.revision.id }));
  return { range, material, text, supplied: keptIdentities, readKnowledgeCommits, over: budgeted.over };
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
  const { range, material, text, supplied } = frozen.prepared;
  const readKnowledgeCommits = frozen.prepared.readKnowledgeCommits;
  // A first valid `memory` batch commits nothing and returns the review guidance inside its receipt,
  // as a user-role message. Core owns that protocol and reads its own receipt; the adapter only
  // decides how to put the message in front of the model (native message, steering, appended turn).
  const reviewFeedback = (toolResult: string): string | undefined => {
    try { const value = JSON.parse(toolResult); return value?.feedback?.role === "user" ? String(value.feedback.content) : undefined; }
    catch { return undefined; }
  };
  const base = { kind: "consolidation" as const, sessionId, branch, range, readKnowledgeCommits, model, mode, prompt, promptHash };
  const run: RunInput = { kind: "consolidation", sessionId, branch, rangeFrom: range.from, rangeTo: range.to, promptHash, model, mode, createdAt: new Date().toISOString() };
  const label = (item: typeof knowledge[number]) => `K${item.knowledge.id}@${item.revision.id}`;
  const binding = bind({ kind: "consolidation", sessionId, branch, headTurnId: frozen.path.headTurnId, range, readKnowledgeCommits }, run, { frozen, feedback: (batch) => {
  const near: NearPair[] = candidates(batch).flatMap((c) => knowledge
    .map(item => ({ candidate: c.id, knowledge: label(item), score: similarity(c.text, item.revision.text) }))
    .filter((p) => p.knowledge !== c.id && p.score >= threshold).sort((a, b) => b.score - a.score));
  const completed: import("../api/read.ts").KnowledgeRead[] = [];
  const renderFeedbackKnowledge = (item: typeof knowledge[number]) => {
    completed.push({ knowledgeId: item.knowledge.id, commits: [item.revision.id], replace: false });
    return renderKnowledge(item);
  };
  const nearText = near.map((p) => `${p.candidate} -> ${p.knowledge} (Jaccard ${p.score})\n${renderFeedbackKnowledge(knowledge.find((e) => label(e) === p.knowledge)!)}`);
  const closer = knowledge.filter(({ revision }) => revision.category === "open" || revision.category === "goal").flatMap((knowledge) => {
    const matches = rangeFacts.map(fact => ({ fact, score: similarity(knowledge.revision.text, fact.text) }))
      .filter(p => p.score >= threshold);
    if (!matches.length) return [];
    const scores = new Map(matches.map(p => [p.fact.id, p.score]));
    return [[renderFeedbackKnowledge(knowledge), ...renderFactGroups(matches.map(p => p.fact),
      f => `Jaccard ${scores.get(f.id)}\n${lines.get(f.id)!}`, factTurns)].join("\n")];
  });
  const feedback = ["System-generated review guidance; not a human ruling or adoption evidence.",
    "NEAR:", nearText.join("\n\n") || "none", "CLOSER:", closer.join("\n\n") || "none"].join("\n\n") + "\n" + checklist;
    return { text: feedback, near, completed };
  } });
  let result: RunAgentResult;
  try { result = await runAgent({ ...structuredClone(base), material, text, supplied: structuredClone(supplied), reviewFeedback, tools: binding.tools, reportRequest: binding.reportRequest }); }
  catch (error) { result = agentException(error); }
  binding.close();
  // A direct facade close may dispose before the provider settles; never access that store.
  if (store.closed) return binding.memory.committed ? { outcome: "success", ...binding.memory.committed, range, readKnowledgeCommits } : { outcome: "dropped" };
  // 27c/27d, as 29e restores them for this phase: the host would not run this frozen task in the mode
  // it was admitted for, and admits it once more itself. Nothing was committed — a candidate accepted
  // for review is not a business commit, and the native runner knows it (hosts/pi/native.ts) — so the
  // refusal goes back to the host unread. An attempt that really sent a request is finalized here as
  // its own `fork`/`failure` record, so its spend is accounted whatever becomes of the re-admission;
  // a refusal that sent nothing records nothing and carries its gate result instead.
  if (result.refused !== undefined && !binding.memory.committed) {
    if (result.request == null) return { outcome: "dropped", refused: result.refused };
    recordAttempt(run, result, mode, { readKnowledgeCommits, toolCalls: binding.sequence, fetched: binding.fetched,
      candidate: binding.memory.candidate, problems: [String(result.output)] });
    return { outcome: "dropped", refused: result.refused, runId: store.recordRun({ ...run, outcome: "failure" }).id };
  }
  const committed = binding.memory.committed;
  const problems = result.outcome !== "success" ? [String(result.output ?? result.outcome)] : requestMissing(result) ? ["runAgent must return the exact provider request"] : binding.memory.problems;
  recordAttempt(run, result, mode, { readKnowledgeCommits, toolCalls: binding.sequence, fetched: binding.fetched,
    candidate: binding.memory.candidate, problems,
    ...(committed ? { committed: committed.committed, diagnostics: committed.diagnostics } : {}) });
  if (committed) {
    const after = updateCommitted(store, committed.runId, run, problems);
    return { outcome: "success", ...committed, range, readKnowledgeCommits, ...(after.length ? { problems: after } : {}) };
  }
  const outcome = result.outcome !== "success" ? result.outcome : requestMissing(result) || binding.memory.failure ? "failure" : problems.length ? "bounced" : "success";
  if (outcome !== "success") {
    const runId = binding.memory.failure?.runId ?? store.recordRun({ ...run, outcome }).id;
    if (binding.memory.failure) store.updateRun(runId, { ...run, outcome });
    return { outcome, runId, problems };
  }
  const empty = store.commitConsolidationRun({ run, operations: [], consolidated: rangeFacts.map((f) => f.id) });
  return empty.ok ? { outcome: "success", ...empty, output: { operations: [], skipped: [] }, diagnostics: [], unansweredNear: [], range, readKnowledgeCommits }
    : { outcome: "failure", runId: empty.runId, problems: empty.problems };
}
