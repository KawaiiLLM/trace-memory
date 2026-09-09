import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { type Fact, type Turn } from "../model/index.ts";
import type { Store, RunInput } from "../store/index.ts";
import type { bindTools } from "../api/tools.ts";
import { toolDefinitions, type ToolDefinition, type ToolContext } from "../api/tools.ts";
import { agentException, recordAttempt, requestMissing, updateCommitted } from "../api/audit.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig, TaskOptions, AgentControl } from "../api/index.ts";
import { renderFact, renderText, renderSources, renderEntry, rawResultText, ENTRY_VIEW_VERSION, tokens, charge, type ResultExtractor, type FactTurns } from "../render/index.ts";
import { budgetMaterial, notingText, notingIncrement, BLOCK, FACTS_TITLE, RAW_TITLE, type MaterialText, type NotingMaterial } from "../render/material.ts";

const prompt = readFileSync(new URL("../prompts/noting.md", import.meta.url), "utf8");
const promptHash = createHash("sha256").update(prompt).digest("hex");
// 22d: what every candidate of every freeze pays before any material is added. The instructions and
// the tool definitions are the same bytes for the life of the process, so they are estimated once
// instead of once per re-freeze. Lazily, because `toolDefinitions` reaches this module through an
// import cycle and is not yet initialized while this module's body runs.
let fixed: { instructions: number; tools: number } | undefined;
const fixedCost = () => (fixed ??= { instructions: tokens(prompt), tools: tokens(JSON.stringify(toolDefinitions)) });

export interface NotingInput extends TaskOptions {
  sessionId: number;
  branch: string;
  headTurnId: number;
  /** Host model capacity (27a): `inputTokens` is the model's context window minus the host's fixed
   * headroom — no output reserve enters it — and `prefixTokens` is the host's measure of the context a
   * fork inherits, counted once. Core prices its own material and fixed costs against the allowance
   * and never learns how either number was obtained. */
  capacity?: { inputTokens: number; prefixTokens: number };
  model?: string;
  mode?: "fork" | "subagent";
}
/** The frozen task material of one Noting run: the shared parts (knowledge, historical facts,
 * compressed Raw entries, receipts) plus this task's head reply and source index. Core renders and
 * budgets the parts and prepares their text (20a); no field is a provider message or body. */
export type { NotingMaterial } from "../render/material.ts";
export interface NotingAgentInput extends AgentControl {
  kind: "noting";
  entryIds: number[];
  sessionId: number;
  branch: string;
  range: { from: string; to: string };
  readKnowledgeCommits: { knowledgeId: number; commit: number }[];
  model: string;
  mode: "fork" | "subagent";
  /** The domain instructions; core owns the prompt file and its hash. */
  prompt: string;
  promptHash: string;
  material: NotingMaterial;
  /** Core's prepared domain text, both representations from this one frozen task (20a). The host
   * chooses one by the native context capability it has, and places it in its own messages. */
  text: MaterialText;
  /** The view versions, budgets and omissions core records for this batch. */
  entryAudit: EntryAudit;
  tools: ToolDefinition[];
  reportRequest: (request: unknown) => void;
}
export interface EntryAudit {
  entries: { id: number; nativeLineage: string; nativeId: string; turnId: number; omissions: string[] }[];
  branch: string;
  viewVersion: string;
  /** The profile these views were rendered under: `B` and `E` (ticket 23). */
  viewBudgets: { toolCallTokens: number; entryTokens: number };
}
export type NotingResult =
  | { outcome: "dropped" | "empty" }
  | { outcome: "success"; runId: number; facts: Fact[]; problems?: string[] }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[];
      /** 26a: the oldest frozen entry of an incomplete batch — the run ended normally, committed
       * nothing and had nothing rejected. Present on that outcome alone; it identifies the batch a
       * host counts consecutive incomplete runs for. */
      incompleteHeadEntryId?: number };

/** 27b: the opening of both capacity refusals a Noting freeze can raise — the preflight floor
 * (instructions, tools and, for a fork, the inherited context) and the loop exit that pops the batch
 * down to its oldest entry. The Pi host matches this one string to tell "this batch does not fit the
 * model" from every other admission failure, and reroutes a fork that raised it to the subagent path
 * with its own capacity (parent 27 amendment 5). A batch over `noting.batchTokens` is not one of
 * these: no model capacity decided it and no fresh child would change it. */
export const NOTING_CAPACITY = "Noting capacity: oldest entry cannot fit the episodic budget or the model context: ";

/** 26a: the diagnostic of a Noting run that ended without a submission. A batch is completed only by
 * a `note` call, `note({facts: []})` included; final prose is never read as an implicit empty
 * submission. The run is recorded with its usage under the existing `failure` outcome and advances no
 * entry progress, so the same entries stay pending for the next admission. */
export const NOTING_INCOMPLETE = "incomplete Noting: the run ended without calling note, so nothing was submitted; call note({facts: []}) to complete an empty batch. The selected entries stay pending.";

export function freezeNoting(store: Store, input: NotingInput, config: TraceMemoryConfig, resultText: ResultExtractor = rawResultText) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("noting requires a non-empty branch");
  const ancestry: Turn[] = [];
  const seen = new Set<number>();
  let id: number | null = input.headTurnId;
  while (id !== null) {
    if (seen.has(id)) throw new Error("cyclic turn ancestry");
    seen.add(id);
    const turn = store.getTurn(id);
    if (!turn || turn.sessionId !== session.id) throw new Error(`turn T${id} does not belong to S${session.id}`);
    ancestry.unshift(turn);
    id = turn.parentTurnId;
  }
  if (input.capacity && (!Number.isSafeInteger(input.capacity.inputTokens) || input.capacity.inputTokens < 0 ||
    !Number.isSafeInteger(input.capacity.prefixTokens) || input.capacity.prefixTokens < 0)) throw new Error("Invalid Noting capacity: expected nonnegative safe integers");
  const pendingAll = store.pendingEntries(session.id, input.branch, input.headTurnId);
  // A manual catchup (18b) freezes an entry-id boundary so later arrivals never join this target.
  const pending = input.boundary?.maxEntryId === undefined ? pendingAll : pendingAll.filter(e => e.id <= input.boundary!.maxEntryId!);
  const mode = input.mode ?? (config.noting.forkModeDefault ? "fork" : "subagent");
  // 22d, hotspot family 6: the instructions, the tool definitions and — for a fork — the inherited
  // prefix are unavoidable; no batch, however small, is priced below them. An allowance under that
  // floor is rejected here, before the first candidate view is rendered, instead of after the batch
  // has been re-frozen once per entry down to nothing. This is a floor and not the guard: the hard
  // budget check inside the loop below is unchanged and still decides every freeze that passes here
  // (parent 22: "A fast preflight supplements the final guard; it does not replace it").
  const { instructions, tools } = fixedCost();
  const inheriting = (input.effectiveMode ?? mode) === "fork";
  const mandatory = Math.max(instructions + tools, inheriting ? (input.capacity?.prefixTokens ?? 0) + instructions : 0);
  if (input.capacity && pending.length && mandatory > input.capacity.inputTokens)
    throw new Error(`${NOTING_CAPACITY}instructions ${instructions}, tools ${tools}`
      + `${inheriting ? ` and the inherited context ${input.capacity.prefixTokens}` : ""} already cost ${mandatory} of the ${input.capacity.inputTokens} tokens allowed for input; left pending`);
  const entries: typeof pending = [];
  const views: string[] = [];
  // 22d: an entry's view is immutable within one freeze — the same stored entry, the same profile,
  // the same result extractor — so selection renders it once and every re-freeze below reuses it.
  const rendered = new Map<number, ReturnType<typeof renderEntry>>();
  for (const entry of pending) {
    const view = renderEntry(entry, config.render, resultText);
    if (tokens([...views, view.content].join(BLOCK)) > config.noting.batchTokens) break;
    entries.push(entry); views.push(view.content); rendered.set(entry.id, view);
  }
  if (pending.length && !entries.length) throw new Error("Noting capacity: oldest entry exceeds noting.batchTokens; left pending");
  // 25a: neither Noter mode receives a knowledge block, but a run still records which commits its
  // path made current, so an explicit `trace K…` inside the run is judged against a frozen base.
  const knowledge = store.listCurrentKnowledge(store.knowledgePath(session.id, input.branch, input.headTurnId)); // entry-aware (review 2026-09-08)
  const facts = store.listSessionFacts(session.id);
  const factTurns = store.factTurnTimes(facts);
  // The same fact renders the same line for the whole freeze, and one Turn's tool calls are the same
  // rows on every candidate: both are read and rendered once here rather than inside the loop.
  const lines = new Map<number, string>();
  const factLine = (fact: Fact) => {
    let line = lines.get(fact.id);
    if (line === undefined) lines.set(fact.id, line = renderFact(fact, store.listFactRelations(fact.id)));
    return line;
  };
  const calls = new Map<number, ReturnType<Store["listToolCalls"]>>();
  const toolCalls = (turnId: number) => {
    let list = calls.get(turnId);
    if (list === undefined) calls.set(turnId, list = store.listToolCalls(turnId));
    return list;
  };
  // 25a: the Noter's two allowances are independent. The Raw ceiling is reserved out of the episodic
  // budget whether or not this batch uses it, so history is capped at what remains — 10,000 tokens at
  // the defaults — and an under-budget Raw batch never enlarges the history block, nor the reverse.
  const historyCap = Math.max(0, config.render.episodicBlockTokens - config.noting.batchTokens);
  let history = historyCap; // lowered further by the capacity negotiation below
  let last: { priced: number; episodic: number } | undefined; // what the smallest candidate cost, for the diagnostic
  while (entries.length) {
    const ids = new Set(entries.map(e => e.turnId));
    const turns = ancestry.filter(t => ids.has(t.id)).map(turn => {
      const selected = entries.filter(e => e.turnId === turn.id);
      const ordinals = new Set(selected.flatMap(e => e.calls.map(c => c.ordinal)));
      return { turn: { ...turn, userPrompt: selected.find(e => e.role === "user")?.text ?? null,
        assistantText: selected.filter(e => e.role === "assistant" && e.text).map(e => e.text).join("\n") || null },
        calls: toolCalls(turn.id).filter(c => ordinals.has(c.ordinal)) };
    });
    const frozen = { sessionId: session.id, branch: input.branch, entries: [...entries], turns, knowledge, facts,
      model: input.model ?? "session", mode };
    const prepared = notingMaterial(frozen, config, entry => rendered.get(entry.id)!, factLine, factTurns, history);
    const capacity = input.capacity;
    // Gate 4 (ruling 2026-09-08), with ticket 20's "Capacity negotiation": the adapter reports its
    // available material budget before selection; core prices the domain text it prepared for this
    // frozen task — labels, titles, the range and receipts included — and never a message the host
    // composed. Popping the newest entry re-freezes the material, the write eligibility and the audit
    // membership together, so the reduced task and its progress range can never disagree.
    const subagentTokens = instructions + tools + tokens(prepared.text.fresh);
    const forkTokens = (capacity?.prefixTokens ?? 0) + instructions + tokens(prepared.text.inherited!)  /* Noting always prepares the increment */;
    // Capacity is priced by the mode that will actually run (review 2026-09-08): a requested fork the
    // host resolves to subagent sends fresh material, not the inherited increment.
    const priced = Math.max(subagentTokens, inheriting ? forkTokens : 0);
    last = { priced, episodic: prepared.over.episodic };
    // Ticket 20 "Complete task evidence" (review 2026-09-08): the domain episodic budget is a reduction
    // signal too, never a receipt that lets the task run over it.
    const fits = !prepared.over.episodic && (!capacity || priced <= capacity.inputTokens);
    if (fits) return { ...frozen, prepared };
    // Optional history goes first (review 2026-09-08): trim the historical facts by the excess before
    // a selected entry is given up; only when none are left does the batch shrink.
    if (capacity && !prepared.over.episodic && prepared.material.facts.length) { history = Math.max(0, charge(prepared.material.facts) - (priced - capacity.inputTokens)); continue; }
    entries.pop(); history = historyCap;
  }
  // 27a: the diagnostic says what the numbers were — the last candidate the loop priced was the
  // smallest one, the oldest entry alone.
  if (pending.length) throw new Error(NOTING_CAPACITY
    + `${last!.episodic ? `it is ${last!.episodic} tokens over render.episodicBlockTokens (${config.render.episodicBlockTokens})` : `it costs ${last!.priced} tokens`}`
    + `${input.capacity ? ` against the ${input.capacity.inputTokens} tokens allowed for input` : ""}; left pending`);
  return { sessionId: session.id, branch: input.branch, entries, turns: [], knowledge, facts, model: input.model ?? "session", mode, prepared: undefined };
}

/** The material of one candidate batch. The entry views and the fact lines are supplied by the
 * freeze, which renders each of them once for the whole negotiation (22d): re-freezing a smaller
 * batch changes which of them are used, never what any one of them says. */
function notingMaterial(frozen: { sessionId: number; entries: ReturnType<Store["pendingEntries"]>; turns: { turn: Turn; calls: ReturnType<Store["listToolCalls"]> }[]; knowledge: ReturnType<Store["listCurrentKnowledge"]>; facts: Fact[] }, config: TraceMemoryConfig, view: (entry: { id: number }) => ReturnType<typeof renderEntry>, factLine: (fact: Fact) => string, factTurns: FactTurns, history = Infinity) {
  const { sessionId, entries, turns, knowledge, facts } = frozen;
  const address = (id: number) => `S${sessionId}/T${id}`;
  const range = { from: address(turns[0]!.turn.id), to: address(turns.at(-1)!.turn.id) };
  const readKnowledgeCommits = knowledge.map(({ knowledge, revision }) => ({ knowledgeId: knowledge.id, commit: revision.id }));
  const raw = entries.map(view);
  // One budgeting for every consumer of the shared material (ticket 20): the selected Raw is charged
  // against this phase's own batch ceiling — `noting.batchTokens` — and the titles, the range and the
  // historical facts against the episodic budget. 25c stopped compact from applying that ceiling to a
  // foreground backlog, which changes nothing here: a Noter batch is still capped by it, and the
  // reservation is still what keeps this phase's two allowances independent. 25a: no knowledge
  // candidates are passed, because neither Noter mode emits a knowledge block.
  const budgeted = budgetMaterial({ current: raw.map((r) => r.content).join(BLOCK),
    framing: [FACTS_TITLE, RAW_TITLE], range, facts, factLine, factTurns, history,
    caps: { episodic: config.render.episodicBlockTokens, current: config.noting.batchTokens } });
  const receipts = [...raw.flatMap((r) => r.receipts), ...budgeted.receipts];
  const head = turns.at(-1)!.turn;
  // Every part of the run's material, rendered and budgeted once. An inherited-context run does not
  // need the raw, the delivered facts or the knowledge again (ruling 08:53); core lays both
  // representations out below, and the host only decides which native message carries the text.
  const material: NotingMaterial = {
    entries: entries.map((entry, i) => ({ id: entry.id, view: raw[i]!.content })),
    // The captured request precedes the head's final reply; that missing raw and the source index
    // are what an inherited-context run still needs.
    head: head.assistantText ? renderText(head.id, "assistant", head.assistantText) : null,
    sources: turns.map(({ turn, calls }) => renderSources(turn, calls)),
    facts: budgeted.facts,
    receipts,
  };
  // 20a: core owns the block order, the titles and the separators of both representations, from this
  // one frozen material. Which one a run sends is the host's choice of native context capability.
  const text: MaterialText = { fresh: notingText(material, range), inherited: notingIncrement(material, range) };
  return { range, readKnowledgeCommits, raw, material, text, over: budgeted.over };
}

/** The run audit records every omission marker of every entry it sent (17a). 23c ruling 3 replaced the
 * `[omitted … characters …]` wordings with Pi's one family, so this detects that family: a cut text,
 * argument value or result, and the details marker inside it. */
const OMISSION = /\[\.\.\. [^\]]+ truncated\]/g;

export async function runNoting(
  store: Store, frozen: ReturnType<typeof freezeNoting>, runAgent: RunAgent,
  config: TraceMemoryConfig, tools: (context: ToolContext, run: RunInput) => ReturnType<typeof bindTools>,
): Promise<NotingResult> {
  const { sessionId, branch, entries, turns, model, mode } = frozen;
  if (!turns.length || !frozen.prepared) return { outcome: "empty" };
  // The material the freeze priced is the material that runs (review 2026-09-08): re-rendering here
  // would restore the historical facts the capacity negotiation trimmed.
  const { range, readKnowledgeCommits, raw, material, text } = frozen.prepared;
  const entryAudit: EntryAudit = { entries: entries.map((e, i) => ({ id: e.id, nativeLineage: e.nativeLineage, nativeId: e.nativeId, turnId: e.turnId, omissions: raw[i]!.content.match(OMISSION) ?? [] })),
    branch, viewVersion: ENTRY_VIEW_VERSION, viewBudgets: { toolCallTokens: config.render.toolCallTokens, entryTokens: config.render.entryTokens } };
  const run: RunInput = { kind: "noting", sessionId, branch, rangeFrom: range.from, rangeTo: range.to,
    promptHash, model, mode, entryAudit, createdAt: new Date().toISOString() };
  const binding = tools({ kind: "noting", sessionId, branch, range, entryIds: entries.map(e => e.id), readKnowledgeCommits }, run);
  const agentInput: NotingAgentInput = { kind: "noting", entryIds: entries.map(e => e.id), sessionId, branch, range,
    readKnowledgeCommits: structuredClone(readKnowledgeCommits), model, mode, prompt, promptHash,
    material, text, entryAudit: structuredClone(entryAudit), tools: binding.tools, reportRequest: binding.reportRequest };
  let result: RunAgentResult;
  try { result = await runAgent(agentInput); }
  catch (error) { result = agentException(error); }
  finally { binding.close(); }
  // A direct facade close may dispose before the provider settles; never access that store.
  if (store.closed) return binding.committed ? { outcome: "success", ...binding.committed } : { outcome: "dropped" };
  // 26a: the run ended normally, committed nothing and had nothing rejected. That is incomplete, not
  // an implicit empty submission: the attempt and its usage are recorded under the existing `failure`
  // outcome and no entry is marked processed. A provider failure or a cancellation keeps its own.
  const incomplete = !binding.committed && result.outcome === "success" && !requestMissing(result) && !binding.problems.length;
  const problems = binding.committed
    ? (result.outcome === "success" ? (requestMissing(result) ? ["runAgent must return the exact provider request after commit"] : []) : [`provider ${result.outcome === "cancelled" ? "cancelled" : "failed"} after commit: ${String(result.output)}`])
    : result.outcome !== "success" ? [String(result.output ?? result.outcome)]
    : requestMissing(result) ? ["runAgent must return the exact provider request"]
    : incomplete ? [NOTING_INCOMPLETE] : binding.problems;
  recordAttempt(run, result, mode, { readKnowledgeCommits, toolCalls: binding.sequence, fetched: binding.fetched, problems });
  if (binding.committed) {
    const after = updateCommitted(store, binding.committed.runId, run, problems);
    return { outcome: "success", ...binding.committed, ...(after.length ? { problems: after } : {}) };
  }
  const outcome = result.outcome !== "success" ? result.outcome : requestMissing(result) || incomplete ? "failure" : "bounced";
  return { outcome, problems, runId: store.recordRun({ ...run, outcome }).id,
    ...(incomplete ? { incompleteHeadEntryId: entries[0]!.id } : {}) };
}
