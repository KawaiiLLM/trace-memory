import { loadPrompt } from "../prompts/load.ts";
import { createHash } from "node:crypto";
import { type Fact, type Turn } from "../model/index.ts";
import type { Store, RunInput, SourceEntry, SourceEntryMeta } from "../store/index.ts";
import type { bindTools } from "../api/tools.ts";
import { toolDefinitions, type ToolDefinition, type ToolContext } from "../api/tools.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig, TaskBoundary, TaskOptions, AgentControl } from "../api/index.ts";
import { renderEntryIndex, renderEntry, rawResultText, ENTRY_VIEW_VERSION, tokens, charge, type ResultExtractor } from "../render/index.ts";
import { notingText, rawWindowTokens, type NotingMaterial, type SharedMaterial } from "../render/material.ts";
import { readFacade } from "../api/read.ts";
import { noVisibility, type InitialContext, type SuppliedMaterial } from "../api/visible.ts";
import type { NotingDiagnostic } from "./review.ts";

const prompt = loadPrompt("noting.md");
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
  model: string;
  mode: "fork" | "subagent";
  /** The domain instructions; core owns the prompt file and its hash. */
  prompt: string;
  promptHash: string;
  material: NotingMaterial;
  /** Core's prepared domain text: the one material this task supplies, whatever mode runs it (29b).
   * The host places it in its own messages and never chooses between two representations. */
  text: string;
  /** 29a/29b: the identities this text actually carries, so the host can persist a carrier for the
   * entry it puts the text in and a later context can prove what it holds. Budget omissions are
   * absent from it: a carrier can only understate coverage. */
  supplied: SuppliedMaterial;
  /** The view versions, budgets and omissions core records for this batch. */
  entryAudit: EntryAudit;
  tools: ToolDefinition[];
  /** A host schema refusal must invalidate the same held slot even when execute was not reached. */
  reportToolRejection(id: string, name: "note" | "memory", input: unknown, reason: string): void;
  /** Host-only: a proven later model turn acknowledges review delivery without fabricating an audit
   * payload. This is not a model-facing tool or argument. A native boundary calls this or
   * reportRequest exactly once, never both. */
  acknowledgeRequest: () => void;
  reportRequest: (request: unknown) => void;
}
export interface EntryAudit {
  entries: { id: number; nativeLineage: string; nativeId: string; turnId: number; omissions: string[] }[];
  branch: string;
  viewVersion: string;
  /** The profile these views were rendered under: `B` and `E` (ticket 23). */
  /** Ticket 30: the one profile this run rendered under. A record written before it keeps its stored
   * `{toolCallTokens, entryTokens}` shape, with its own `B`/`E` meaning, and is never relabelled. */
  viewBudgets: { entryTokens: number; toolInputTokens: number; toolResultTokens: number };
}
export type NotingResult = { executionId?: string; automaticOff?: string } & (
  | { outcome: "empty" }
  /** 27c: `refused` is the host's own refusal value, returned unread when the host declined to run
   * this task in the mode it was admitted for and admits it once more itself.
   * 27d: `runId` is the run core recorded for that refused attempt, present exactly when the attempt
   * sent a provider request; the host names it in the re-admitted run's `fallbackReason`. `reason`
   * says why a task that never ran dropped — cancelled before the fallback, or evidence another
   * executor already processed. */
  | { outcome: "dropped"; refused?: unknown; runId?: number; reason?: string }
  | { outcome: "success"; runId: number; facts: Fact[]; diagnostics: NotingDiagnostic[]; problems?: string[] }
  | { outcome: "failure" | "cancelled" | "bounced"; runId: number; problems: string[];
      /** 26a: the oldest frozen entry of an incomplete batch — the run ended normally, committed
       * nothing and had nothing rejected. Retained as diagnostic metadata; persisted logical-task
       * settlement now owns failure counting, not a host-local incomplete guard. */
      incompleteHeadEntryId?: number });

/** 27b: the opening of both capacity refusals a Noting freeze can raise — the preflight floor
 * (instructions, tools and, for a fork, the inherited context) and the loop exit that pops the batch
 * down to its oldest entry. The Pi host matches this one string to tell "this batch does not fit the
 * model" from every other admission failure, and reroutes a fork that raised it to the subagent path
 * with its own capacity (parent 27 amendment 5). A batch over `noting.batchTokens` is not one of
 * these: no model capacity decided it and no fresh child would change it. */
export const NOTING_CAPACITY = "Noting capacity: selected evidence cannot fit the model context: ";

/** 27d (parent 27 amendment 6): the opening of the diagnostic a `boundary.exactEntryIds` freeze raises
 * when its exact membership is no longer pending in full. The evidence was processed elsewhere —
 * another executor's claim completed it — so the task is dropped rather than retried and nothing is
 * re-processed. The façade matches this one string to tell it from an admission failure. */
export const NOTING_MEMBERSHIP = "Noting membership: the frozen batch is no longer pending in full: ";

/** 26a: the diagnostic of a Noting run that ended without a submission. A batch is completed only by
 * a `note` call, `note({facts: []})` included; final prose is never read as an implicit empty
 * submission. The run is recorded with its usage under the existing `failure` outcome and advances no
 * entry progress, so the same entries stay pending for the next admission. */
export const NOTING_INCOMPLETE = "incomplete Noting: explicitly call both note({facts: []}) and memory({operations: [], skipped: []}) even for empty output. The selected entries stay pending.";

/** The pending entries one task's boundary admits, and the exact-membership form when it has one.
 * A manual catchup (18b) freezes an entry-id boundary so later arrivals never join this target.
 * 27d (parent 27 amendment 6; renamed in 29e): `exactEntryIds` is exact membership instead — the frozen batch of a fork
 * attempt the host is re-admitting. It is taken whole or not at all: a member no longer pending was
 * processed by another executor under its own claim, which drops the task at the freeze below instead
 * of re-processing the rest of the batch as though it were a fresh one. Selection only: the freeze
 * owns every diagnostic, so a caller that merely asks what would be selected raises none of them. */
/** `pendingAll`, when passed, replaces the internal `store.pendingEntries` query: a caller that
 * already read the same session/branch/head's full pending set inside the same admission
 * transaction (70: discovery and the freeze would otherwise each read it once) reuses that read. */
export const notingPending = (store: Store, input: { sessionId: number; branch: string; headTurnId: number; boundary?: TaskBoundary },
  pendingAll: SourceEntryMeta[] = store.pendingEntries(input.sessionId, input.branch, input.headTurnId)) => {
  const exact = input.boundary?.exactEntryIds;
  return { exact, pending: exact ? pendingAll.filter(e => exact.includes(e.id))
    : input.boundary?.maxEntryId === undefined ? pendingAll : pendingAll.filter(e => e.id <= input.boundary!.maxEntryId!) };
};

/** The batch a freeze takes out of those: the oldest prefix whose views together fit
 * `noting.batchTokens`. 22d: an entry's view is immutable within one freeze — the same stored entry,
 * the same profile, the same result extractor — so selection renders it once and every re-freeze
 * reuses it. 29c: the Pi host asks the same question at admission, to decide a fork against the
 * entries this task would really select rather than against everything still pending.
 * 79 item 2: `pending` is metadata; each candidate is hydrated only as this loop reaches it, oldest
 * first, and the loop stops at the first that does not fit — the ruling's explicit allowance that the
 * candidate which fails the budget must still be rendered to know it does. */
export const notingBatch = (store: Store, pending: readonly SourceEntryMeta[], config: TraceMemoryConfig, resultText: ResultExtractor) => {
  const entries: SourceEntry[] = [], views: string[] = [];
  const rendered = new Map<number, ReturnType<typeof renderEntry>>();
  for (const meta of pending) {
    const entry = store.getSourceEntry(meta.id)!;
    const view = renderEntry(entry, config.render, resultText);
    if (rawWindowTokens([...views, view.content], [...rendered.values(), view].flatMap(value => value.receipts)) > config.noting.batchTokens) break;
    entries.push(entry); views.push(view.content); rendered.set(entry.id, view);
  }
  return { entries, views, rendered };
};

export function freezeNoting(store: Store, input: NotingInput, config: TraceMemoryConfig, resultText: ResultExtractor = rawResultText,
  pendingAll?: SourceEntryMeta[]) {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (typeof input.branch !== "string" || !input.branch) throw new Error("noting requires a non-empty branch");
  if (input.capacity && (!Number.isSafeInteger(input.capacity.inputTokens) || input.capacity.inputTokens < 0 ||
    !Number.isSafeInteger(input.capacity.prefixTokens) || input.capacity.prefixTokens < 0)) throw new Error("Invalid Noting capacity: expected nonnegative safe integers");
  const path = store.knowledgePath(session.id, input.branch, input.headTurnId);
  let snapshot = pendingAll ? undefined : store.pathSnapshot(path);
  const allPending = pendingAll ?? store.pendingEntries(session.id, input.branch, input.headTurnId, snapshot);
  const { exact, pending } = notingPending(store, { ...input, sessionId: session.id }, allPending);
  if (exact && pending.length !== exact.length)
    throw new Error(`${NOTING_MEMBERSHIP}entries ${exact.filter((id: number) => !pending.some(e => e.id === id)).join(", ")} of the frozen batch ${exact.join(", ")} are no longer pending; nothing was re-processed`);
  const mode = input.mode ?? (config.noting.forkModeDefault ? "fork" : "subagent");
  // 22d, hotspot family 6: the instructions, the tool definitions and — for a fork — the inherited
  // prefix are unavoidable; no batch, however small, is priced below them. An allowance under that
  // floor is rejected here, before the first candidate view is rendered, instead of after the batch
  // has been re-frozen once per entry down to nothing. This is a floor and not the guard: the hard
  // budget check inside the loop below is unchanged and still decides every freeze that passes here
  // (parent 22: "A fast preflight supplements the final guard; it does not replace it").
  const { instructions, tools } = fixedCost();
  const inheriting = (input.effectiveMode ?? mode) === "fork";
  // 29b: the floor is the price of the mode that will run, as the loop below prices it — a fork pays
  // its inherited measure and the instructions, a fresh child the instructions and the tools. Keeping
  // the subagent's floor over a fork would reject batches the loop would then admit.
  const mandatory = inheriting ? (input.capacity?.prefixTokens ?? 0) + instructions : instructions + tools;
  if (input.capacity && pending.length && mandatory > input.capacity.inputTokens)
    throw new Error(`${NOTING_CAPACITY}${inheriting ? `instructions ${instructions} and the inherited context ${input.capacity.prefixTokens}` : `instructions ${instructions}, tools ${tools}`}`
      + ` already cost ${mandatory} of the ${input.capacity.inputTokens} tokens allowed for input; left pending`);
  const { entries, rendered } = notingBatch(store, pending, config, resultText);
  if (pending.length && !entries.length)
    throw new Error(`${NOTING_CAPACITY}oldest entry and Raw framing exceed noting.batchTokens (${config.noting.batchTokens}); left pending`);
  // 27d: the same whole-or-nothing rule against the batch ceiling the selection loop above stops at.
  // A membership selected under that ceiling once can only fail this on a configuration change, and
  // then its entries wait together rather than half of them running.
  if (exact && entries.length !== pending.length)
    throw new Error(`${NOTING_CAPACITY}the frozen batch of ${pending.length} entries exceeds noting.batchTokens (${config.noting.batchTokens}); left pending`);
  snapshot ??= store.pathSnapshot(path);
  // Reuse the same authoritative ordered metadata for the head and every endpoint assembly.
  // This replaces sourceHeadEntryId's metadata read, not a new per-node cache.
  const source = store.sourcePath(session.id, input.branch, input.headTurnId, snapshot);
  const headEntryId = source.at(-1)?.id;
  const preparedSources = { path, entries: source, pending: allPending };
  const ancestry = [...new Set(entries.map(entry => entry.turnId))].map(id => store.getTurn(id)!);
  const calls = new Map<number, ReturnType<Store["listToolCalls"]>>();
  const toolCalls = (turnId: number) => {
    let list = calls.get(turnId);
    if (list === undefined) calls.set(turnId, list = store.listToolCalls(turnId));
    return list;
  };
  const historyCap = config.compaction.factsTokens;
  let history = historyCap; // lowered further by the capacity negotiation below
  // 29b "Same builder, different initial state": the one input that separates a fork's material from
  // a fresh child's. The host supplies the view only for a task it will really fork (hosts/pi/index.ts
  // at admission); everything else — an explicit subagent, a fork re-admitted as one after a refusal
  // (27c) — arrives without it and gets the fresh child's empty start, so the fallback still sends
  // complete material. `inheritedTokens` is the measure the fork price below is built on.
  const initial: InitialContext = { visible: inheriting && input.visible ? input.visible : noVisibility(),
    inheritedTokens: inheriting ? input.capacity?.prefixTokens ?? 0 : 0 };
  let lastPrice = 0;
  while (entries.length) {
    const ids = new Set(entries.map(e => e.turnId));
    const turns = ancestry.filter(t => ids.has(t.id)).map(turn => {
      const selected = entries.filter(e => e.turnId === turn.id);
      const ordinals = new Set(selected.flatMap(e => e.calls.map(c => c.ordinal)));
      return { turn: { ...turn, userPrompt: selected.find(e => e.role === "user")?.text ?? null,
        assistantText: selected.filter(e => e.role === "assistant" && e.text).map(e => e.text).join("\n") || null },
        calls: toolCalls(turn.id).filter(c => ordinals.has(c.ordinal)) };
    });
    const frozen = { sessionId: session.id, branch: input.branch, entries: [...entries], headEntryId, turns,
      harness: session.host.startsWith("pi:") ? "Pi agent" : session.host.startsWith("cc:") ? "Claude Code" : session.host,
      model: input.model ?? "session", mode };
    const endpoint = entries.at(-1)!;
    const assembled = readFacade(store, { ...config, compaction: { ...config.compaction,
      rawTokens: config.noting.batchTokens, factsTokens: history } }, undefined, resultText)
      .compact(session.id, input.branch, endpoint.turnId, [], false,
        { endpointEntryId: endpoint.id, processedRawRefill: false, renderedEntries: rendered, preparedSources });
    if ("native" in assembled || !assembled.material) throw new Error("Noting material assembly produced no material");
    if (assembled.supplied.entries.length !== entries.length
      || assembled.supplied.entries.some((entry, index) => entry.id !== entries[index]!.id))
      throw new Error("Noting material Raw membership differs from its frozen processing batch; left pending");
    const prepared = notingMaterial(frozen, entry => rendered.get(entry.id)!, assembled.material, assembled.supplied, initial, inheriting);
    const capacity = input.capacity;
    // Gate 4 (ruling 2026-09-08), with ticket 20's "Capacity negotiation": the adapter reports its
    // available material budget before selection; core prices the domain text it prepared for this
    // frozen task — labels, titles, the range and receipts included — and never a message the host
    // composed. Popping the newest entry re-freezes the material, the write eligibility and the audit
    // membership together, so the reduced task and its progress range can never disagree.
    // Capacity is priced by the mode that will actually run (review 2026-09-08), on the one material
    // this freeze prepared for it. 29b (parent 29 "Capacity, fallback and audit"): a fork pays its
    // inherited measure plus the instructions plus the text it newly supplies — the full fresh
    // representation it does not send is neither built nor charged, so a fork whose target is already
    // visible is not refused for a cost nothing would have paid. Its fallback is not left unguarded:
    // a re-admitted subagent (27b/27c) re-freezes with the empty initial state and is priced by this
    // same line at the fresh child's own model capacity, and refuses the batch there if it must.
    const priced = inheriting ? initial.inheritedTokens + instructions + tokens(prepared.text)
      : instructions + tools + tokens(prepared.text);
    lastPrice = priced;
    const fits = !capacity || priced <= capacity.inputTokens;
    if (fits) return { ...frozen, prepared };
    // Optional history goes first (review 2026-09-08): trim the historical facts by the excess before
    // a selected entry is given up; only when none are left does the batch shrink.
    if (capacity && history && prepared.material.facts.length) { history = Math.max(0, Math.min(history - 1, charge(prepared.material.facts) - (priced - capacity.inputTokens))); continue; }
    // 27d (parent 27 amendment 6): under exact membership the batch never shrinks. Optional history
    // is trimmed above, as in any freeze; a batch that still does not fit leaves every frozen entry
    // pending under the diagnostic below, because a smaller batch is a membership change made after
    // execution had already started.
    if (exact) break;
    entries.pop(); history = historyCap;
  }
  // 27a: the diagnostic says what the numbers were — the last candidate the loop priced was the
  // smallest one it was allowed to reach: the oldest entry alone, or, under 27d's exact membership,
  // the whole frozen batch.
  if (pending.length) throw new Error(NOTING_CAPACITY
    + `it costs ${lastPrice} tokens`
    + `${input.capacity ? ` against the ${input.capacity.inputTokens} tokens allowed for input` : ""}; left pending`);
  return { sessionId: session.id, branch: input.branch, entries, turns: [], model: input.model ?? "session", mode, prepared: undefined };
}

/** The one Noting material builder (29b, parent 29 "One material-selection mechanism"). The frozen
 * task is the whole processing target — chosen by `noting.batchTokens` alone, never by what the child
 * can see — and `initial` is the child's starting point. What is newly supplied is the target minus
 * what that view proves visible at the same identity and representation, and only then does the
 * budget apply: an entry whose native id the view holds as a retained source or as a carrier's bounded
 * view is withheld. A fork supplies no historical facts or Knowledge supplement. Fresh material
 * uses the common compact selection at the final selected entry.
 *
 * Entry views are rendered once per freeze and reused through capacity negotiation (22d). */
function notingMaterial(frozen: { sessionId: number; harness: string; headEntryId?: number; entries: SourceEntry[]; turns: { turn: Turn; calls: ReturnType<Store["listToolCalls"]> }[] }, view: (entry: { id: number }) => ReturnType<typeof renderEntry>, assembled: SharedMaterial, selected: SuppliedMaterial, initial: InitialContext, inheriting: boolean) {
  const { sessionId, entries, turns } = frozen;
  const address = (id: number) => `S${sessionId}/T${id}`;
  const range = { from: address(turns[0]!.turn.id), to: address(turns.at(-1)!.turn.id) };
  // Every entry the map holds is either the retained original or a marked bounded view of ours (29a,
  // 30: one view, and a legacy tier-1 or tier-2 carrier counts as that same view).
  const supplied = entries.filter(entry => !initial.visible.raw.has(entry.nativeId));
  const withheld = entries.length - supplied.length;
  const raw = supplied.map(view);
  // Only the selected path's last native reply can be absent from the captured parent request.
  // Earlier assistant entries in the same Turn are already inherited, not head supplements.
  const headEntry = entries.find(entry => entry.id === frozen.headEntryId && entry.role === "assistant"
    && initial.visible.raw.has(entry.nativeId));
  const headView = headEntry ? view(headEntry) : undefined;
  const head = headView?.content || null;
  const sources = withheld ? entries.map(renderEntryIndex) : [];
  // Selection is solely the shared assembler's. A fork inherits the parent's ordinary material;
  // this adapter adds only its exact range/index and missing head reply, never a Knowledge supplement.
  const receipts = inheriting ? raw.flatMap(r => r.receipts) : assembled.receipts;
  const material: NotingMaterial = {
    harness: frozen.harness,
    entries: supplied.map((entry, i) => ({ id: entry.id, view: raw[i]!.content })),
    head,
    // Mandatory framing (parent 29 "Keep mandatory framing"): with a body withheld, the source index
    // is what identifies the target entries exactly and maps them to addresses the child must find in
    // its own context. It covers the whole frozen range, not only what was supplied.
    sources,
    facts: inheriting ? [] : assembled.facts ?? [],
    ...(inheriting ? {} : { knowledge: assembled.knowledge }),
    receipts,
  };
  // 20a: core owns the block order, the titles and the separators; 29b: there is one layout, and the
  // host only decides which native message carries it.
  const text = notingText(material, range);
  // 29a "Renderers return what they kept": every entry in the Raw block is the one bounded view (30),
  // and facts/Knowledge are exactly what the shared assembler kept for the fresh child.
  const carried = [...supplied, ...(headEntry && head ? [headEntry] : [])];
  const suppliedMaterial: SuppliedMaterial = { entries: carried.map(e => ({ id: e.id, nativeId: e.nativeId, view: "bounded" as const })),
    factIds: inheriting ? [] : selected.factIds, knowledgeCommitIds: inheriting ? [] : selected.knowledgeCommitIds,
    ...(inheriting ? {} : { knowledgeTokens: selected.knowledgeTokens }) };
  return { range, views: new Map(carried.map(e => [e.id, view(e)])),
    material, text, selectedEntryIds: selected.entries.map(entry => entry.id), supplied: suppliedMaterial };
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
  const { range, views, material, text, supplied, selectedEntryIds } = frozen.prepared;
  const checkMembership = () => {
    if (selectedEntryIds.length !== entries.length || selectedEntryIds.some((id, index) => id !== entries[index]!.id))
      throw new Error("Noting material Raw membership differs from its frozen processing batch; left pending");
  };
  checkMembership();
  // 29b: the audit still lists every entry of the frozen target — membership is the processing target,
  // not what was injected — but the omission markers are read from the view this run actually sent.
  // An inherited entry without a head supplement sent no view and has no markers of ours to record.
  const entryAudit: EntryAudit = { entries: entries.map((e) => ({ id: e.id, nativeLineage: e.nativeLineage, nativeId: e.nativeId, turnId: e.turnId, omissions: views.get(e.id)?.content.match(OMISSION) ?? [] })),
    branch, viewVersion: ENTRY_VIEW_VERSION, viewBudgets: { entryTokens: config.render.entryTokens,
      toolInputTokens: config.render.toolInputTokens, toolResultTokens: config.render.toolResultTokens } };
  const run: RunInput = { kind: "noting", sessionId, branch, rangeFrom: range.from, rangeTo: range.to,
    promptHash, model, mode, entryAudit, createdAt: new Date().toISOString() };
  const binding = tools({ kind: "noting", sessionId, branch, range, entryIds: entries.map(e => e.id) }, run);
  const agentInput: NotingAgentInput = { kind: "noting", entryIds: entries.map(e => e.id), sessionId, branch, range,
    model, mode, prompt, promptHash,
    material, text, supplied: structuredClone(supplied), entryAudit: structuredClone(entryAudit),
    tools: binding.tools, reportToolRejection: binding.reportToolRejection,
    acknowledgeRequest: binding.acknowledgeRequest, reportRequest: binding.reportRequest };
  let result: RunAgentResult;
  try { result = await runAgent(agentInput); }
  catch (error) { result = agentException(error); }
  // A direct facade close may dispose before the provider settles; never access that store.
  if (store.closed) { binding.close(); return { outcome: "dropped" }; }
  // 27c: the host would not run this frozen task in the mode it was admitted for (its fork was
  // refused at the launch, by the host's gate or by the provider's context limit) and admits it once
  // more itself. Nothing was committed, so the refusal goes back to the host unread.
  // 27d (user ruling 2026-09-10, superseding 27c's "one run record for both attempts"): each attempt
  // is its own run record. An attempt that really sent a request is finalized here, before the
  // refusal leaves — requested mode `fork`, outcome `failure`, the refusal reason among its problems,
  // and exactly the usage, retries, request and native log it reported — so the spend is accounted
  // whatever becomes of the re-admission, and the re-admitted run charges only itself. A refusal
  // that sent nothing is not an attempt and records nothing; its gate result travels in the refusal.
  // "Sent a request" is the reported request itself: the host reports one on its way out, and every
  // refusal that sends nothing — a launch that never started, a gate that rejects inside the payload
  // hook, before the body leaves — reports none.
  if (result.refused !== undefined) {
    binding.close();
    if (result.request == null) return { outcome: "dropped", refused: result.refused };
    recordAttempt(run, result, mode, { toolCalls: binding.sequence, fetched: binding.fetched,
      problems: [String(result.output)] });
    return { outcome: "dropped", refused: result.refused, runId: store.recordRun({ ...run, outcome: "failure" }).id };
  }
  // 26a: the run ended normally, committed nothing and had nothing rejected. That is incomplete, not
  // an implicit empty submission: the attempt and its usage are recorded under the existing `failure`
  // outcome and no entry is marked processed. A provider failure or a cancellation keeps its own.
  if (binding.cancelled && result.outcome === "success") result = { ...result, outcome: "cancelled", output: "Noter cancelled before terminal publication" };
  const incomplete = result.outcome === "success" && binding.incomplete;
  const problems = result.outcome !== "success" ? [String(result.output ?? result.outcome)]
    : requestMissing(result) ? ["runAgent must return the exact provider request"]
    : [...binding.problems, ...(incomplete ? [NOTING_INCOMPLETE] : [])];
  recordAttempt(run, result, mode, { toolCalls: binding.sequence, fetched: binding.fetched, problems });
  try {
    if (result.outcome === "success" && !problems.length) {
      checkMembership();
      const published = binding.finalize();
      return published.ok ? { outcome: "success", runId: published.runId, facts: published.facts, diagnostics: [] }
        : { outcome: "failure", runId: published.runId, problems: published.problems };
    }
    const outcome = result.outcome !== "success" ? result.outcome : requestMissing(result) || incomplete ? "failure" : "bounced";
    return { outcome, problems, runId: store.recordRun({ ...run, outcome }).id,
      ...(incomplete ? { incompleteHeadEntryId: entries[0]!.id } : {}) };
  } finally { binding.close(); }
}
