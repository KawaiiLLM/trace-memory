import { loadPrompt } from "../prompts/load.ts";
import { readingGuide } from "../render/reading-guide.ts";
import { withRetrievalPolicy } from "../render/retrieval-policy.ts";
import { createHash } from "node:crypto";
import { type Fact, type Turn, type ToolCall, type WritingLimits } from "../model/index.ts";
import type { Store, RunInput, SourceEntry, SourceEntryMeta } from "../store/index.ts";
import type { Handoff } from "../store/executions.ts";
import { isThinkingOnly, type HumanUserDetector } from "../model/source.ts";
import type { bindTools } from "../api/tools.ts";
import { pricedToolDefinitions, notingToolDefinitions, type ToolDefinition, type ToolContext } from "../api/tools.ts";
import { canonicalToolNames, renderToolNames, validateToolNames, type ToolNames } from "../prompts/tool-names.ts";
import { applyWorkspace, type NotingScope } from "../workspace/index.ts";
import { NotingWorkspace, NOTING_TASKS, defaultWorkspaceRoot, stagePrompts, type NotingTask, type StagePrompts } from "./workspace.ts";
import { agentException, recordAttempt, requestMissing } from "../api/audit.ts";
import type { RunAgent, RunAgentResult, TraceMemoryConfig, TaskBoundary, TaskOptions, AgentControl } from "../api/index.ts";
import { renderEntry, rawResultText, ENTRY_VIEW_VERSION, tokens, charge, type EntryView, type ResultExtractor } from "../render/index.ts";
import { notingText, rawWindowTokens, type NotingMaterial, type SharedMaterial } from "../render/material.ts";
import { readFacade } from "../api/read.ts";
import type { SuppliedMaterial } from "../api/visible.ts";
import type { NotingDiagnostic } from "./review.ts";

// Pricing includes the launch's rendered names, not the canonical template. The lazy per-map cache
// avoids repeatedly tokenizing static schemas through the source-selection loop. The host's native read, write
// and edit definitions are priced from its own estimates.
const fixed = new Map<string, { prompt: string; taskPrompts: StagePrompts; instructions: number; tools: number }>();
const fixedCost = (names: ToolNames, native: number, limits: WritingLimits) => {
  const key = JSON.stringify([names, native, limits]);
  let cost = fixed.get(key);
  if (!cost) {
    const domain = loadPrompt("noting.md", names, limits), prompt = withRetrievalPolicy(domain, names);
    // Each independent conversation carries exactly one stage instruction block.
    const taskPrompts = stagePrompts(names, limits), largest = Math.max(...Object.values(taskPrompts).map(prompt => tokens(prompt)));
    cost = { prompt, taskPrompts, instructions: tokens(prompt) + largest,
      tools: tokens(JSON.stringify(pricedToolDefinitions(notingToolDefinitions, names))) + native };
    fixed.set(key, cost);
  }
  return cost;
};

/** Stage instructions arrive in the first check result, keeping the prepared lane prefix stable. */
const CHECK_FIRST = "Call {{tool.check}} first: it names your stage and your files.";

export interface NotingInput extends TaskOptions {
  sessionId: number;
  /** Hosts reserve these independently; omitted runs the two lanes in order. */
  lane?: "facts" | "knowledge";
  branch: string;
  headTurnId: number;
  /** Host model capacity (27a): `inputTokens` is the model's context window minus the host's fixed
   * headroom — no output reserve enters it. Core prices its own material and fixed costs against the
   * allowance and never learns how the number was obtained. */
  capacity?: { inputTokens: number };
  model?: string;
  /** Actual names exposed in this launch; a direct Core invocation uses its canonical tools. */
  toolNames?: ToolNames;
}
/** The frozen task material of one Noting run: the shared parts (knowledge, historical facts,
 * compressed Raw entries, receipts) plus this task's head reply and source index. Core renders and
 * budgets the parts and prepares their text (20a); no field is a provider message or body. */
export type { NotingMaterial } from "../render/material.ts";
export interface NotingAgentInput extends AgentControl {
  kind: "noting";
  /** Four independent conversations; only check results carry stage-specific instructions. */
  task: NotingTask;
  entryIds: number[];
  sessionId: number;
  branch: string;
  range: { from: string; to: string };
  model: string;
  /** A fresh child's system prompt: the domain instructions plus the retrieval policy (137); core owns
   * the prompt file and its hash. */
  prompt: string;
  promptHash: string;
  material: NotingMaterial;
  /** Prepared first message, frozen for this lane and retained on resume. */
  text: string;
  /** 29a/29b: the identities this text actually carries, so the host can persist a carrier for the
   * entry it puts the text in and a later context can prove what it holds. Budget omissions are
   * absent from it: a carrier can only understate coverage. */
  supplied: SuppliedMaterial;
  /** The view versions, budgets and omissions core records for this batch. */
  entryAudit: EntryAudit;
  /** Core's tools: `search` and `check`. The host adds its native read, write and edit. */
  tools: ToolDefinition[];
  /** Readable inputs and the one deliverable owned by this stage. */
  workspace: { dir: string; facts: string; knowledge: string; read: string[]; write: string[] };
  passEnd(): string | undefined;
  /** One native model response, deduplicated by host identity; input includes both cache counters. */
  reportResponse?(id: string, inputTokens?: number): void;
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
export type NotingResult = { executionId?: string; dormant?: string } & (
  | { outcome: "empty" }
  /** `reason` says why a task that never ran dropped — evidence another executor already processed. */
  | { outcome: "dropped"; reason?: string }
  | { outcome: "success"; runId: number; facts: Fact[]; diagnostics: NotingDiagnostic[]; problems?: string[] }
  | { outcome: "failure" | "cancelled"; runId: number; problems: string[] });

/** 27b: the opening of both capacity refusals a Noting freeze can raise — the preflight floor
 * (instructions and tools) and the loop exit that pops the batch down to its oldest entry. A batch
 * over `noting.batchTokens` is not one of these: no model capacity decided it. */
export const NOTING_CAPACITY = "Noting capacity: selected evidence cannot fit the model context: ";

/** 27d (parent 27 amendment 6): the opening of the diagnostic a `boundary.exactEntryIds` freeze raises
 * when its exact membership is no longer pending in full. The evidence was processed elsewhere —
 * another executor's claim completed it — so the task is dropped rather than retried and nothing is
 * re-processed. The façade matches this one string to tell it from an admission failure. */
export const NOTING_MEMBERSHIP = "Noting membership: the frozen batch is no longer pending in full: ";

/** The pending entries one task's boundary admits, and the exact-membership form when it has one.
 * A manual catchup (18b) freezes an entry-id boundary so later arrivals never join this target.
 * 27d (parent 27 amendment 6; renamed in 29e): `exactEntryIds` is exact membership instead — a frozen
 * batch the host is re-admitting. It is taken whole or not at all: a member no longer pending was
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
 * reuses it.
 * 79 item 2: `pending` is metadata; each candidate is hydrated only as this loop reaches it, oldest
 * first, and the loop stops at the first that does not fit — the ruling's explicit allowance that the
 * candidate which fails the budget must still be rendered to know it does. */
export const notingBatch = (store: Store, pending: readonly SourceEntryMeta[], config: TraceMemoryConfig, resultText: ResultExtractor) => {
  const entries: SourceEntry[] = [], views: string[] = [];
  const rendered = new Map<number, ReturnType<typeof renderEntry>>();
  for (const meta of pending) {
    const entry = store.getSourceEntry(meta.id)!;
    if (isThinkingOnly(entry)) { entries.push(entry); continue; }
    const view = renderEntry(entry, config.render, resultText);
    if (rawWindowTokens([...views, view.content], [...rendered.values(), view].flatMap(value => value.receipts)) > config.noting.batchTokens) break;
    entries.push(entry); views.push(view.content); rendered.set(entry.id, view);
  }
  return { entries, views, rendered };
};

/** Durable task material carried from the fact lane into the knowledge lane. */
export interface FrozenNoting {
  sessionId: number; branch: string; headTurnId: number; entries: SourceEntry[]; headEntryId?: number;
  turns: { turn: Turn; calls: ToolCall[] }[];
  harness?: string; model: string; names: ToolNames; prompt: string; promptHash: string; taskPrompts: StagePrompts;
  thinkingLevel?: string; subagentThinkingLevel?: string;
  prepared?: {
    range: { from: string; to: string }; views: Map<number, EntryView>;
    material: NotingMaterial; text: string; selectedEntryIds: number[]; supplied: SuppliedMaterial;
  };
}

export function freezeNoting(store: Store, input: NotingInput, config: TraceMemoryConfig, resultText: ResultExtractor = rawResultText,
  pendingAll?: SourceEntryMeta[], humanUser?: HumanUserDetector): FrozenNoting {
  const session = store.getSession(input.sessionId);
  if (!session) throw new Error(`session S${input.sessionId} does not exist`);
  if (session.host.startsWith("cc:") && !input.toolNames) throw new Error("CC Noter launch requires exposed tool names");
  if (typeof input.branch !== "string" || !input.branch) throw new Error("noting requires a non-empty branch");
  if (input.capacity && (!Number.isSafeInteger(input.capacity.inputTokens) || input.capacity.inputTokens < 0)) throw new Error("Invalid Noting capacity: expected a nonnegative safe integer");
  for (const [name, value] of [["Read", input.nativeReadToolTokens], ["Write and Edit", input.nativeWriteToolTokens]] as const)
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error(`Invalid native ${name} token estimate: expected a nonnegative safe integer`);
  const path = store.knowledgePath(session.id, input.branch, input.headTurnId);
  let snapshot = pendingAll ? undefined : store.pathSnapshot(path);
  const allPending = pendingAll ?? store.pendingEntries(session.id, input.branch, input.headTurnId, snapshot);
  const { exact, pending } = notingPending(store, { ...input, sessionId: session.id }, allPending);
  if (exact && pending.length !== exact.length)
    throw new Error(`${NOTING_MEMBERSHIP}entries ${exact.filter((id: number) => !pending.some(e => e.id === id)).join(", ")} of the frozen batch ${exact.join(", ")} are no longer pending; nothing was re-processed`);
  // 22d, hotspot family 6: the instructions and the tool definitions are unavoidable; no batch,
  // however small, is priced below them. An allowance under that
  // floor is rejected here, before the first candidate view is rendered, instead of after the batch
  // has been re-frozen once per entry down to nothing. This is a floor and not the guard: the hard
  // budget check inside the loop below is unchanged and still decides every freeze that passes here
  // (parent 22: "A fast preflight supplements the final guard; it does not replace it").
  const names = validateToolNames(input.toolNames ?? canonicalToolNames);
  const { prompt, taskPrompts, instructions, tools } = fixedCost(names, (input.nativeReadToolTokens ?? 0) + (input.nativeWriteToolTokens ?? 0), config.writing);
  const mandatory = instructions + tools;
  if (input.capacity && pending.length && mandatory > input.capacity.inputTokens)
    throw new Error(`${NOTING_CAPACITY}instructions ${instructions}, tools ${tools}`
      + ` already cost ${mandatory} of the ${input.capacity.inputTokens} tokens allowed for input; left pending`);
  const { entries, rendered } = notingBatch(store, pending, config, resultText);
  // The Raw profile and the historical-user excerpt profile are distinct. Reuse hydrated batch
  // users and retain each historical source/excerpt only inside this synchronous freeze.
  const historicalUserEntries = new Map<number, { entry: SourceEntry; view?: EntryView }>(
    entries.filter(entry => entry.role === "user").map(entry => [entry.id, { entry }]));
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
  const omitted = new Set(entries.filter(isThinkingOnly).map(entry => entry.id));
  const preparedSources = { path, entries: source, pending: allPending.filter(entry => !omitted.has(entry.id)) };
  const ancestry = [...new Set(entries.map(entry => entry.turnId))].map(id => store.getTurn(id)!);
  const calls = new Map<number, ReturnType<Store["listToolCalls"]>>();
  const toolCalls = (turnId: number) => {
    let list = calls.get(turnId);
    if (list === undefined) calls.set(turnId, list = store.listToolCalls(turnId));
    return list;
  };
  const historyCap = config.compaction.factsTokens;
  let history = historyCap; // lowered further by the capacity negotiation below
  let temporary = config.compaction.temporaryTokens;
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
    const frozen = { sessionId: session.id, branch: input.branch, headTurnId: input.headTurnId, entries: [...entries], headEntryId, turns,
      harness: session.host.startsWith("pi:") ? "Pi agent" : session.host.startsWith("cc:") ? "Claude Code" : session.host,
      model: input.model ?? "session", thinkingLevel: input.thinkingLevel, subagentThinkingLevel: input.subagentThinkingLevel };
    const endpoint = entries.at(-1)!;
    const assembled = readFacade(store, { ...config, compaction: { ...config.compaction,
      rawTokens: config.noting.batchTokens, factsTokens: history, temporaryTokens: temporary } }, undefined, resultText, humanUser)
      .compact(session.id, input.branch, endpoint.turnId, [], false,
        { endpointEntryId: endpoint.id, processedRawRefill: false, showKnowledgeSize: true, readingGuide: false,
          renderedEntries: rendered, historicalUserEntries, preparedSources, toolNames: names });
    if ("native" in assembled || !assembled.material) throw new Error("Noting material assembly produced no material");
    const materialEntries = entries.filter(entry => !omitted.has(entry.id));
    if (assembled.supplied.entries.length !== materialEntries.length
      || assembled.supplied.entries.some((entry, index) => entry.id !== materialEntries[index]!.id))
      throw new Error("Noting material Raw membership differs from its frozen material batch; left pending");
    const prepared = notingMaterial(frozen, entry => rendered.get(entry.id)!, assembled.material, assembled.supplied, names);
    const capacity = input.capacity;
    // Gate 4 (ruling 2026-09-08), with ticket 20's "Capacity negotiation": the adapter reports its
    // available material budget before selection; core prices the domain text it prepared for this
    // frozen task — labels, titles, the range and receipts included — and never a message the host
    // composed. Popping the newest entry re-freezes the material, the write eligibility and the audit
    // membership together, so the reduced task and its progress range can never disagree.
    const priced = instructions + tools + tokens(prepared.text);
    lastPrice = priced;
    const fits = !capacity || priced <= capacity.inputTokens;
    if (fits) return { ...frozen, prepared, prompt, taskPrompts, promptHash: createHash("sha256").update(prompt).digest("hex"), names };
    // 133: temporary context, including receipt-only omissions, goes before full facts.
    if (capacity && temporary && assembled.charged!.temporary) {
      temporary = Math.max(0, Math.min(temporary - 1, assembled.charged!.temporary - Math.max(1, priced - capacity.inputTokens)));
      continue;
    }
    if (capacity && history && prepared.material.facts.length) {
      history = Math.max(0, Math.min(history - 1, charge(prepared.material.facts) - (priced - capacity.inputTokens)));
      continue;
    }
    // 27d (parent 27 amendment 6): under exact membership the batch never shrinks. Optional history
    // is trimmed above, as in any freeze; a batch that still does not fit leaves every frozen entry
    // pending under the diagnostic below, because a smaller batch is a membership change made after
    // execution had already started.
    if (exact) break;
    entries.pop(); history = historyCap; temporary = config.compaction.temporaryTokens;
  }
  // 27a: the diagnostic says what the numbers were — the last candidate the loop priced was the
  // smallest one it was allowed to reach: the oldest entry alone, or, under 27d's exact membership,
  // the whole frozen batch.
  if (pending.length) throw new Error(NOTING_CAPACITY
    + `it costs ${lastPrice} tokens`
    + `${input.capacity ? ` against the ${input.capacity.inputTokens} tokens allowed for input` : ""}; left pending`);
  return { sessionId: session.id, branch: input.branch, headTurnId: input.headTurnId, entries, turns: [], model: input.model ?? "session", prepared: undefined,
    thinkingLevel: input.thinkingLevel, subagentThinkingLevel: input.subagentThinkingLevel,
    names, prompt, taskPrompts, promptHash: createHash("sha256").update(prompt).digest("hex") };
}

/** The one Noting material builder. The frozen task is the whole processing target — chosen by
 * `noting.batchTokens` alone, never by what the child can see — and every non-thinking-only entry of
 * it is supplied. Fresh material uses the common compact selection at the final selected entry.
 *
 * Entry views are rendered once per freeze and reused through capacity negotiation (22d). */
function notingMaterial(frozen: { sessionId: number; harness: string; entries: SourceEntry[]; turns: { turn: Turn; calls: ReturnType<Store["listToolCalls"]> }[] }, view: (entry: { id: number }) => ReturnType<typeof renderEntry>, assembled: SharedMaterial, selected: SuppliedMaterial, names: ToolNames) {
  const { sessionId, turns } = frozen;
  const entries = frozen.entries.filter(entry => !isThinkingOnly(entry));
  const address = (id: number) => `S${sessionId}/T${id}`;
  const range = { from: address(turns[0]!.turn.id), to: address(turns.at(-1)!.turn.id) };
  const raw = entries.map(view);
  // Selection is solely the shared assembler's.
  const material: NotingMaterial = {
    harness: frozen.harness,
    readingGuide: readingGuide(sessionId, names),
    entries: entries.map((entry, i) => ({ id: entry.id, view: raw[i]!.content })),
    facts: assembled.facts ?? [],
    factTitles: assembled.factTitles ?? [],
    earlierUsers: assembled.earlierUsers ?? [],
    knowledge: assembled.knowledge, knowledgeNotice: assembled.knowledgeNotice,
    receipts: assembled.receipts,
  };
  // 20a: core owns the block order, the titles and the separators.
  const text = `${notingText(material, range)}\n\n${renderToolNames(CHECK_FIRST, names)}`;
  // 29a "Renderers return what they kept": every entry in the Raw block is the one bounded view (30),
  // and facts/Knowledge are exactly what the shared assembler kept.
  const suppliedMaterial: SuppliedMaterial = { entries: entries.map(e => ({ id: e.id, nativeId: e.nativeId, view: "bounded" as const })),
    factIds: selected.factIds, knowledgeCommitIds: selected.knowledgeCommitIds, knowledgeTokens: selected.knowledgeTokens };
  return { range, views: new Map(entries.map((e, i) => [e.id, raw[i]!])),
    material, text, selectedEntryIds: frozen.entries.map(entry => entry.id), supplied: suppliedMaterial };
}

/** The run audit records every omission marker of every entry it sent (17a). 23c ruling 3 replaced the
 * `[omitted … characters …]` wordings with Pi's one family, so this detects that family: a cut text,
 * argument value or result, and the details marker inside it. */
const OMISSION = /\[\.\.\. [^\]]+ truncated\]/g;

export interface NotingRunOptions {
  /** Where the run's workspace directory is made; a host with no preference gets the system temporary directory. */
  workspaceRoot?: string;
  executionId: string;
  /** The latest passed stage's run, whose files seed the failed next stage. */
  resumeRunId?: number;
  lane: "facts" | "knowledge";
  /** The fact lane's admission, kept in the knowledge hand-off. */
  admission?: NonNullable<NonNullable<Handoff["detail"]>["noting"]>["admission"];
  handoff?: Handoff;
  /** Registers the run's workspace with the cancellation fence (stage 4 §1.5): closing the task closes it. */
  registerFence?(workspace: { close(): void }): void;
}

/** One independently resumed lane; empty checks pass without a model call before lane publication. */
export async function runNoting(
  store: Store, frozen: FrozenNoting, runAgent: RunAgent,
  config: TraceMemoryConfig, tools: (context: ToolContext, run: RunInput, noting?: { check(): string }) => ReturnType<typeof bindTools>,
  options: NotingRunOptions,
): Promise<NotingResult> {
  const { sessionId, branch, entries, turns, model } = frozen;
  if (!turns.length || !frozen.prepared) return { outcome: "empty" };
  // The material the freeze priced is the material that runs (review 2026-09-08): re-rendering here
  // would restore the historical facts the capacity negotiation trimmed.
  const { range, views, material, text, supplied, selectedEntryIds } = frozen.prepared;
  const checkMembership = () => {
    if (selectedEntryIds.length !== entries.length || selectedEntryIds.some((id, index) => id !== entries[index]!.id))
      throw new Error("Noting material Raw membership differs from its frozen processing batch; left pending");
  };
  checkMembership();
  // The audit lists every entry of the frozen target (membership is the processing target); the
  // omission markers are read from the view this run actually sent, and a thinking-only member sent none.
  const entryAudit: EntryAudit = { entries: entries.map((e) => ({ id: e.id, nativeLineage: e.nativeLineage, nativeId: e.nativeId, turnId: e.turnId, omissions: views.get(e.id)?.content.match(OMISSION) ?? [] })),
    branch, viewVersion: ENTRY_VIEW_VERSION, viewBudgets: { entryTokens: config.render.entryTokens,
      toolInputTokens: config.render.toolInputTokens, toolResultTokens: config.render.toolResultTokens } };
  const entryIds = entries.map(e => e.id);
  const scope: NotingScope = { sessionId, branch, range, entryIds };
  const workspace = new NotingWorkspace(store, scope, options.workspaceRoot ?? defaultWorkspaceRoot(), sessionId, options.executionId, frozen.taskPrompts, config.noting, options.lane);
  options.registerFence?.(workspace);
  let previousRunId = options.resumeRunId;
  const seed = options.resumeRunId === undefined ? undefined : resumedFiles(store, options.resumeRunId, options.handoff?.nextTask);
  // Pre-lane hand-offs can already have checked facts, but have not published them yet.
  const publicationOnly = options.lane === "facts" && !!seed?.nextTask.endsWith("knowledge");

  /** Passing writer stages keep the audit and hand-off; checkers publish their lane. */
  const runTask = async (task: NotingTask): Promise<NotingResult | undefined> => {
    const started = Date.now();
    const run: RunInput = { kind: "noting", sessionId, branch, rangeFrom: range.from, rangeTo: range.to,
      promptHash: frozen.promptHash, model, entryAudit, createdAt: new Date().toISOString() };
    workspace.beginTask(task);
    const binding = tools({ kind: "noting", sessionId, branch, range, entryIds }, run, { check: () => workspace.checkTool() });
    const noWork = workspace.noWork();
    try {
      let result: RunAgentResult;
      if (noWork || publicationOnly) {
        workspace.passEnd();
        result = { outcome: "success", output: publicationOnly ? "Publishing saved checked facts" : "Skipped empty check" };
      } else {
        const agentInput: NotingAgentInput = { kind: "noting", task, entryIds, sessionId, branch, range,
          model, prompt: frozen.prompt!, promptHash: frozen.promptHash!,
          material, text, supplied: structuredClone(supplied), entryAudit: structuredClone(entryAudit),
          tools: binding.tools, workspace: { dir: workspace.dir, ...workspace.paths,
            read: [...Object.values(workspace.paths), workspace.path("related-facts.md"), workspace.path("related-knowledge.md")],
            write: [task === "extract-facts" || task === "check-facts" ? workspace.paths.facts : workspace.paths.knowledge] },
          passEnd: () => workspace.passEnd(), reportResponse: (id, inputTokens) => workspace.reportResponse(id, inputTokens),
          acknowledgeRequest: binding.acknowledgeRequest, reportRequest: binding.reportRequest };
        try { result = await runAgent(agentInput); }
        catch (error) { result = agentException(error); }
      }
      // A direct facade close may dispose before the provider settles; never access that store.
      if (store.closed) return { outcome: "dropped" };
      if ((binding.cancelled || workspace.closed) && result.outcome === "success") result = { ...result, outcome: "cancelled", output: "Noter cancelled before terminal publication" };
      // The host stop hook is a courtesy; a terminal recheck also refuses changed or unfinished stage files.
      const final = result.outcome === "success" ? workspace.check() : undefined;
      const unfinished = result.outcome === "success" ? workspace.unfinished() : undefined;
      const problems = result.outcome !== "success" ? [String(result.output ?? result.outcome)]
        : !noWork && !publicationOnly && requestMissing(result) ? ["runAgent must return the exact provider request"] : [...(unfinished ? [unfinished] : []), ...final!.problems];
      const { facts, knowledge } = workspace.read();
      recordAttempt(run, result, { task, ...(previousRunId === undefined ? {} : { previousRun: previousRunId }), files: { facts, knowledge },
        ...(noWork ? { noWork: true } : {}), ...(publicationOnly ? { resumedPublication: true } : {}),
        ...workspace.record(), toolCalls: binding.sequence, fetched: binding.fetched, problems, durationMs: Date.now() - started });
      if (problems.length || result.outcome !== "success") {
        const outcome = result.outcome !== "success" ? result.outcome : "failure";
        return { outcome, problems, runId: store.recordRun({ ...run, outcome }).id };
      }
      if (task === "extract-facts" || task === "write-knowledge") {
        const nextTask = NOTING_TASKS[NOTING_TASKS.indexOf(task) + 1]!;
        const passed = store.commitNotingStage({ run, handoff: { nextTask, branch, entryIds,
          lane: options.lane, batch: options.handoff?.batch ?? 0, detail: options.handoff?.detail } });
        if (!passed.ok) return { outcome: "failure", runId: passed.runId, problems: passed.problems };
        previousRunId = passed.runId;
        return undefined;
      }
      checkMembership();
      const published = applyWorkspace(store, { kind: "noting", scope, facts: workspace.read().files.facts,
        knowledge: task === "check-facts" ? { name: "knowledge.md", text: "## none\n" } : workspace.read().files.knowledge,
        run, ...(options.lane === "facts" ? { lane: "facts" as const }
          : { lane: "knowledge" as const, factIds: options.handoff!.detail!.noting!.factIds, factsAfter: options.handoff!.detail!.noting!.factsAfter }),
        after: done => {
          if (task === "check-facts") {
            const ids = Object.values(done.factIds);
            const factsAfter = ids.length ? Math.min(...ids) - 1 : Number(store.db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM facts").get()!.id);
            store.writeNotingHandoff({ sessionId, lane: "knowledge", batch: entryIds[0]!, nextTask: publicationOnly ? seed!.nextTask : "write-knowledge",
              runId: done.runId, branch, entryIds, detail: { noting: { frozen: saveNoting(frozen), factIds: done.factIds,
                committedAt: Date.now(), executionId: options.executionId, factsAfter, admission: options.admission } } });
          } else {
            store.db.prepare("DELETE FROM task_handoffs WHERE session_id=? AND phase='noting' AND lane='knowledge' AND batch=?")
              .run(sessionId, options.handoff!.batch!);
          }
        } });
      if (!published.ok) {
        const response = JSON.stringify({ ...JSON.parse(run.response ?? "{}"), problems: published.problems });
        return { outcome: "failure", problems: published.problems,
          runId: published.runId ?? store.recordRun({ ...run, response, outcome: "failure" }).id };
      }
      return { outcome: "success", runId: published.runId, facts: Object.values(published.factIds).map(id => store.getFact(id)!), diagnostics: [] };
    } finally { binding.close(); }
  };

  try {
    workspace.open(seed ? { "facts.md": seed.facts, "knowledge.md": seed.knowledge } : {
      "facts.md": "## fact f1\ntitle: \nobjects: \nnegate: \ncaused_by: \n\n",
      "knowledge.md": "## create\ntitle: \ncategory: \nscope: \ntopics: \nsupports: \nfiles: \nreason: \n\n",
    });
    const first = publicationOnly ? 1 : seed ? NOTING_TASKS.indexOf(seed.nextTask) : 0;
    for (const task of NOTING_TASKS.slice(first, options.lane === "facts" ? 2 : 4)) {
      const result = await runTask(task);
      if (result) return result;
    }
    throw new Error("Noter ended without terminal publication");
  } finally { workspace.remove(); }
}

/** Passed stage snapshots, rather than a failed stage's partial edits, are durable. */
function resumedFiles(store: Store, runId: number, next?: string) {
  const saved = JSON.parse(store.getRun(runId)?.response ?? "{}") as { task?: NotingTask; files?: { facts?: unknown; knowledge?: unknown } };
  const { files, task } = saved;
  const nextTask = next as NotingTask | undefined ?? (task === undefined ? undefined : NOTING_TASKS[NOTING_TASKS.indexOf(task) + 1]);
  if (typeof files?.facts !== "string" || typeof files.knowledge !== "string" || !nextTask || !NOTING_TASKS.includes(nextTask))
    throw new Error(`passed stage R${runId} holds no workspace files or next stage to resume`);
  return { facts: files.facts, knowledge: files.knowledge, nextTask };
}

/** JSON keeps the prepared bytes and frozen membership; only the rendered-view lookup is a Map. */
export function saveNoting(frozen: FrozenNoting): string {
  return JSON.stringify(frozen, (_key, value) => value instanceof Map ? [...value] : value);
}
export function restoreNoting(saved: string): FrozenNoting {
  const frozen = JSON.parse(saved);
  if (frozen.prepared) frozen.prepared.views = new Map(frozen.prepared.views);
  return frozen;
}
