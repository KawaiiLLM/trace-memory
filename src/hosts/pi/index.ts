import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { createGrepToolDefinition, createReadToolDefinition, SettingsManager, type GrepToolInput, type ReadToolInput, type ExtensionAPI, type ExtensionContext, type SessionEntry, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { hash, snapshot, type Body } from "./fork.ts";
import { checkpointReadiness } from "./native.ts";
import { contextComposition } from "./context-composition.ts";
import { statusBody } from "./session-status.ts";
import { showSessionPanel } from "./session-panel.ts";
import { renderTraceMenu, renderTraceSettings } from "./trace-menu-view.ts";
import { buildActions, buildSettingsChoices, MENU_INPUTS, parseRunsCount, toggleConfirmation, type TraceMenuInput, type SettingsInput } from "../trace-menu.ts";
import { agentDirectory, configuration, configuredMode, parseKnowledgeBudgetInput, preferenceValue, preferences, shownValue, tag, thinkingChoices, writeGlobal, type Preference } from "./settings.ts";
import { runWorker, type ForkLaunch, type ForkRefusal, type WorkerModel } from "./worker.ts";
import { TraceMemory, selectNotingMode, memoryFiles, memoryPath, MEMORY_READ_ONLY, type MemoryGrepMode, deliveredView, directoryAllocation, enrollmentDefault, knowledgeStateKey, sourceDigest, tokens, validateConfig, validateReadInput, toolDefinitions, toolRejected, CANCELLED_BEFORE_FALLBACK, NOTING_CAPACITY, type NotingAgentInput, type NotingResult, type DreamingAgentInput, type DreamingResult, type Enrollment, type ResultExtractor, type SuppliedMaterial, type TaskBoundary, type TaskTarget, type VisibleView, type TruncationReceipt } from "../../core/api/index.ts";
import { visibleView, extendVisibleView, type ContextEntry, type VisibleBinding } from "./visible.ts";
export { visibleView } from "./visible.ts";
export type { Carrier, ContextEntry, VisibleBinding } from "./visible.ts";
import { CURRENT_CONTEXT_SNAPSHOT_EVENT, type CurrentContextSnapshotResult } from "./context-snapshot.ts";
import { PHASE_SETTING_KEYS } from "../phase-settings.ts";
import { memoryStatusLine } from "../status-line.ts";

/** Ticket 27a (parent 27 "Decision", amendment 9): the fixed headroom of the one capacity rule both
 * memory-worker guards decide by — `context measure + 10,000 <= context window`. It is an allowance,
 * not an output reserve, not a guaranteed output size and not a setting: the 85% window multiplier
 * and the subtraction of the model's declared maximum output are gone from both guards, and
 * `model.maxTokens` is read by neither. Admission hands core `contextWindow - CONTEXT_HEADROOM` as
 * its input allowance; the last check before every round applies the same subtraction to Pi's own
 * measure of the child's context. Generation limits, `noting.batchTokens`,
 * the render block budgets and foreground compaction are untouched by it. */
export const CONTEXT_HEADROOM = 10_000;
const now = () => new Date().toISOString();
const text = (message: { content?: unknown }) => typeof message.content === "string" ? message.content
  : Array.isArray(message.content) ? message.content.filter(c => c.type === "text").map(c => c.text).join("\n") : "";

/** Ticket 23 "Host contract": this adapter's result-text extractor, registered with the façade at
 * construction. It unwraps the `{content, details}` result this host stores: the text blocks joined,
 * every other block marked by its type, and `details` reported as dropped structured data with its
 * serialized size — core marks the size, never the content. Evidence is unchanged: the raw message and
 * the raw result are stored exactly as before and `trace` with `full` still renders them uncut. Edit
 * diffs live only in `details`, so they leave the Noter view with a marker in their place. */
export const piResultText: ResultExtractor = (result) => {
  let envelope: { content?: unknown; details?: unknown };
  try { envelope = JSON.parse(result); } catch { return { text: result }; }
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) return { text: result };
  const blocks = Array.isArray(envelope.content) ? envelope.content as { type?: string; text?: unknown }[] : [];
  const text = Array.isArray(envelope.content)
    ? blocks.map(block => block?.type === "text" ? String(block.text ?? "") : `[${block?.type ?? "unknown"} omitted]`).join("\n")
    : typeof envelope.content === "string" ? envelope.content : "";
  const details = envelope.details;
  const empty = details == null || (typeof details === "object" && !Object.keys(details as object).length);
  return { text, ...(empty ? {} : { details: JSON.stringify(details) }) };
};

/** One selected-context view. Native parent lookups extend an append; navigation/compaction rebuild.
 * Even getEntries() copies the entire native history, so the warm path never calls it. Database
 * applicability remains separate and observes external writes at an unchanged native leaf.
 * Consumers borrow this mutable view read-only; asynchronous task admission takes one frozen copy. */
export type VisibleSource = Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntry" | "buildContextEntries">;
export function visibility(manager: VisibleSource) {
  let cached: { binding: string; leaf: string | null; view: VisibleView } | undefined;
  return (binding: VisibleBinding): VisibleView => {
    const identity = JSON.stringify(binding), leaf = manager.getLeafId();
    if (cached?.binding === identity && cached.leaf === leaf) return cached.view;
    const appended: ContextEntry[] = [];
    let parent = leaf;
    if (cached?.binding === identity) while (parent !== cached.leaf && parent !== null) {
      const entry = manager.getEntry(parent);
      if (!entry || entry.type === "compaction" || entry.type === "branch_summary") break;
      appended.push(entry);
      parent = entry.parentId;
    }
    const view = cached?.binding === identity && parent === cached.leaf
      ? extendVisibleView(cached.view, appended.reverse(), binding)
      : visibleView(manager.buildContextEntries() as ContextEntry[], binding);
    cached = { binding: identity, leaf, view };
    return view;
  };
}

// 19c gate 6: retry and provider policy are Pi's own, read by the `SettingsManager` the native child
// is built with (hosts/pi/native.ts). The handwritten `retry` merge that used to live here — and its
// stale "a value import of SettingsManager needs pi-server" comment — went with the request-copy
// runner; nothing in this adapter reads or duplicates Pi's runtime settings any more.

import { piPersistedSource, piSourceBlocks } from "./source.ts";

export default function (pi: ExtensionAPI) {
  const environment = process.env.TRACE_MEMORY_CONFIG;
  const agentDir = agentDirectory();
  let { flat, core, sources, layers } = configuration(process.cwd());
  const dbPath = String(flat.dbPath ?? join(homedir(), ".trace-memory", "trace.db")).replace(/^~\//, `${homedir()}/`);
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  // 24c supersedes ruling 19:5's default destination (`<dbPath's directory>/runs/<parent id>/`).
  // With no explicit `runsDir`, a new worker log is a DIRECT child of `<agent dir>/sessions/
  // trace-memory` — one level under Pi's own sessions root, with no per-parent subdirectory —
  // because the external daily-cost reader scans the sessions root plus exactly one directory
  // level, and a second level would hide the file from it. The tradeoff, documented in docs/pi.md,
  // is that worker sessions become visible in Pi's all-session browser under `trace-memory`.
  // Old logs are not moved, copied or rewritten, and no historical `nativeLog` is rewritten:
  // this changes where the NEXT log is written and nothing else. Retention is still a v1 limit.
  const sessionsRoot = join(agentDir, "sessions");
  // An explicit `runsDir` keeps 19a's precedence and its `<runsDir>/<parent Pi session id>/` layout.
  // Read from `flat` on every call, as before: `restore` reloads the settings layers on each
  // session start, so a directory decided once at construction would go stale.
  const configuredRunsDir = () => flat.runsDir === undefined ? undefined : resolve(String(flat.runsDir).replace(/^~\//, `${homedir()}/`));
  const runsDirectory = (piId: string) => { const configured = configuredRunsDir(); return configured === undefined ? join(sessionsRoot, "trace-memory") : join(configured, piId); };
  // Disclosure for the read-only settings view: with the per-parent level an explicit directory
  // puts its logs two levels down unless it IS the sessions root, so file-based daily statistics
  // do not see them.
  const runsOutsideScan = () => { const configured = configuredRunsDir(); return configured !== undefined && configured !== sessionsRoot; };
  let ctx: ExtensionContext;
  let closed = false;
  type Capture = { payload: Body; model: string; provider: string; branch: string };
  // One extension instance serves one Pi session: Pi tears the runtime down and re-runs the
  // factory on new/resume/fork, so the capture state is a single object.
  const session: { capture?: Capture; notified?: boolean } = {};
  /** Whether this task may still run with inherited context, decided against this host's live state
   * at the moment it launches, and handed to the worker as a value: either the parent state to fork
   * at or the reason it was refused. Every condition is rechecked here for every task, so a task
   * queued before a transition cannot bypass one. */
  const rawUnavailable = (entries: readonly { id: number; turnId: number; nativeId: string }[]): string | undefined =>
    selectNotingMode({ requested: "fork", publicationPending: false, visible: visible(binding()), pending: () => entries,
      batch: () => entries }).fallbackReason;
  const unpublishedKnowledge = (target: TaskTarget): string | undefined => {
    const delta = memory.injection(target, delivered(target));
    return delta.knowledgeCommitIds.length || delta.knowledgeStates?.length
      ? "Knowledge publication: ordinary deliverable material has not landed in the exact parent context" : undefined;
  };
  const forkLaunch = (context: ExtensionContext, input: NotingAgentInput,
      model: { id: string; provider: string }, piId: string): ForkLaunch | { refused: string } => {
    // 19c cache-miss latch: the requested mode stays fork; admission resolves it to subagent
    // while this memory session is automatically downgraded.
    const suppression = memory.store.forkSuppression(input.sessionId);
    if (suppression) return { refused: latchReason(suppression) };
    // Ticket 29c, rechecked here at the actual launch against the exact frozen entry set — a task
    // admitted before a compaction but held for a slot, a claim or native readiness reaches this line
    // with its batch already frozen, and the context it would inherit has moved since. The whole batch
    // then runs as a fresh child instead, recorded like any other fallback: requested mode fork,
    // actual mode subagent, reason named. A per-task readiness decision, not the cache-miss latch.
    if (input.kind === "noting") {
      const refused = rawUnavailable(input.entryAudit.entries);
      if (refused) return { refused };
    }
    // A tree switch since admission invalidates this launch context; the new branch's history is
    // never substituted for the task frozen on the old one.
    if (state.branch !== input.branch) return { refused: "The selected branch changed after admission" };
    const captured = session.capture;
    if (!captured || captured.branch !== input.branch) return { refused: "No current-branch provider payload captured" };
    if (captured.model !== model.id || captured.provider !== model.provider) return { refused: "Session model changed since capture" };
    const parentFile = context.sessionManager.getSessionFile?.();
    if (!parentFile) return { refused: "The parent session is not persisted" };
    const checkpoint = context.sessionManager.getLeafId();
    if (!checkpoint) return { refused: "The parent session has no persisted leaf entry" };
    // 06 changes Noter inheritance; the still-live C lifecycle belongs to 07.
    if (input.kind !== "noting") return { parentFile, parentSessionId: piId, checkpoint, captured: captured.payload };
    const parentBinding = JSON.stringify(binding());
    const recheck = () => {
      if (context.sessionManager.getSessionId() !== piId || context.sessionManager.getLeafId() !== checkpoint
        || JSON.stringify(binding()) !== parentBinding || state.branch !== input.branch)
        return "Fork parent changed after admission; the exact native checkpoint is no longer selected";
      return unpublishedKnowledge({ sessionId: input.sessionId, branch: input.branch, headTurnId: state.head! });
    };
    const reason = recheck();
    return reason ? { refused: reason } : { parentFile, parentSessionId: piId, checkpoint, captured: captured.payload, recheck };
  };
  const memory = TraceMemory(dbPath, async raw => {
    const input = raw as NotingAgentInput | DreamingAgentInput;
    const callContext = ctx;
    const callPiId = callContext.sessionManager.getSessionId();
    const registry = callContext.modelRegistry;
    const slash = input.model.indexOf("/");
    // The model is frozen with the run (a fork run freezes the session model at launch), so a
    // model switch during a worker run cannot redirect its later rounds.
    const current = callContext.model;
    const model = input.model === "session" || (current && `${current.provider}/${current.id}` === input.model) ? current
      : registry.find(input.model.slice(0, slash), input.model.slice(slash + 1));
    // The last check before a request leaves, for both phases (27a, superseding the 2026-09-08
    // whole-body estimate): the frozen batch fit the reported capacity, and Pi's own measure of the
    // child's context — the child session's `getContextUsage()`, taken in hosts/pi/native.ts where
    // that session is — must still fit the same rule the allowance was cut by. Nothing here parses a
    // provider body, so a child on an API the fork gate does not know keeps running, and images and
    // encrypted fields need no rule of ours. An unknown measure refuses nothing.
    const checkCapacity = !model ? undefined : (contextTokens: number | undefined) => {
      if (contextTokens !== undefined && contextTokens > model.contextWindow - CONTEXT_HEADROOM)
        throw new Error(`${PHASE_LABEL[input.kind]} capacity: the child's context of ${contextTokens} tokens leaves less than the ${CONTEXT_HEADROOM}-token headroom in the ${model.contextWindow}-token window of ${model.provider}/${model.id}`);
    };
    // 24a review (2026-09-09): a worker's tool execution is the boundary at which its bound writer
    // commits (`note`, `memory`), so the footer is re-read after each one — the counts then show the
    // committed progress while the trailing reply is still in flight and the running indicator stays.
    // Reads (`trace`, `search`) refresh too, cheaply; nothing polls and nothing decrements early.
    const tools = input.tools.map(tool => ({ ...tool, execute: (raw: unknown) => { try { return tool.execute(raw); } finally { showSpend(callContext); } } }));
    // Everything the run needs, resolved now and frozen: the model, the runs directory, the tool
    // round cap and the fork launch cannot be re-read by a run already in flight, and this host
    // keeps its own state behind the callbacks below.
    return runWorker(input, {
      model: model as unknown as WorkerModel | undefined, checkCapacity, tools,
      runsDir: runsDirectory(callPiId), cwd: callContext.cwd, agentDir,
      maxToolRounds: memory.config[input.kind].maxToolRounds,
      // 27b/27c: a task carrying a reason was admitted as a subagent — the configured model, that
      // model's capacity, fresh material — because something already refused its fork. It is offered
      // no launch at all: it runs fresh and records the reason it carries (hosts/pi/worker.ts). That
      // is also the structural one-transition guard, since a task with no fork to launch can never be
      // refused one. Every other condition is re-derived here, for this task, at this moment.
      fork: input.mode === "fork" && model && !input.fallbackReason && !input.signal?.aborted
        ? forkLaunch(callContext, input, model, callPiId) : undefined,
      onCache: observation => {
        // User rulings 2026-09-09: every eligible miss is noticed once, with its count; a hit
        // resets the count; the second consecutive miss downgrades the session — one transition,
        // decided by the store's guarded UPDATE, so two phases reaching it together notice once.
        // This run continues in its own native session; the first miss of a run is audited under
        // `verification.cacheMiss` in its run record.
        if (!observation.miss) { cacheMisses.delete(input.sessionId); return; }
        const misses = (cacheMisses.get(input.sessionId) ?? 0) + 1;
        cacheMisses.set(input.sessionId, misses);
        callContext.ui.notify(`Trace Memory: fork cache miss ${Math.min(misses, 2)}/2 (${observation.cacheRead} of ${observation.total} input tokens read from cache).`, "warning");
        if (misses < 2 || !memory.store.suppressFork(input.sessionId)) return;
        missDetected.add(input.kind);
        callContext.ui.notify("Trace Memory: fork downgraded after two consecutive cache misses. Future memory tasks in this session will use subagent.", "warning");
      },
      // Pi's own retry policy runs inside the child; the one warning per scheduled backoff stays the
      // adapter's. 51: the footer indicator no longer tracks a retry — the notify reports it.
      onRetry: event => {
        callContext.ui.notify(`Trace Memory: ${input.kind} retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${event.error}`, "warning");
      },
      onRetryEnd: () => showSpend(callContext), // the same refresh point as before; only the colour is gone
    });
  }, core, piResultText, piSourceBlocks);
  /** One fork-to-subagent notice per Pi session, whatever refused the fork: the live state at
   * admission (the cache-miss latch, 29c's Raw availability), the launch, the native runner's own
   * gate, and (27b) a capacity refusal before sending or a provider overflow after a real attempt.
   * A warning, never an error — the work continues on the fresh child, and a later task may request
   * fork again. */
  const notifyFallback = (kind: string, reason: string) => {
    if (session.notified) return;
    ctx.ui.notify(`Trace Memory: ${kind} fell back to subagent mode. ${reason}`, "warning");
    session.notified = true;
  };
  /** Host state written before Ticket 34c may still contain supplement counters. They are preserved
   * when an old entry is copied but never read as delivery eligibility; each ordinary prompt now
   * recomputes the exact visible/applicable difference. */
  type State = { enrollment?: { defaultEnabled: boolean; choice: boolean | null }; shared?: boolean; sourceHead?: number; originPiId?: string; sessionId?: number; projectId: number; branch: string; head?: number; piId: string; project?: string; supplementGeneration?: number; supplementServed?: number };
  let state: State;
  // 18b: one manual catchup at a time per executor, host-local state only (no new queue/claim
  // system — it drives 17c's own executor slots and claims under a frozen Raw boundary).
  type Catchup = {
    sessionId: number; branch: string; headTurnId: number; triggerEntryId?: number;
    maxEntryId?: number; entryTotal: number; // Noting boundary: undefined means nothing was pending to note
    stopped: boolean;
    waitingPhase?: WorkerPhase;
    active: Set<WorkerPhase>;
    outcome?: "completed" | "stopped" | "failed";
    diagnostic?: string;
  };
  let catchup: Catchup | undefined;
  /** What the last compaction of this executor did — the bounded views, or a native delegation and its
   * reason — for `/trace status` (ticket 20 "Failure visibility"). A diagnostic string, not a state
   * machine: nothing reads it back. */
  let lastCompaction: string | undefined;
  /** 73: the truncation receipt of the carrier this handler last returned, warned once Pi appends it. */
  let publishedTruncation: TruncationReceipt | undefined;
  let baseline: string;
  // 29a's visible-view memo for the selected context, created by `restore` (29d: the initial
  // knowledge block's only lifecycle input).
  let visible: ReturnType<typeof visibility>;
  const baselinePath = join(agentDir, "trace-memory-baseline.json");
  const enrollment = () => state.sessionId ? memory.store.enrollment(state.sessionId) : state.enrollment!;
  const enabled = () => { const e = enrollment(); return e.choice ?? e.defaultEnabled; };

  // Pi does not flush a new native file before its first assistant message. Keep the
  // provisional enrollment entry durable without manufacturing a reply or a Turn.
  const provisionalPath = () => join(agentDir, "trace-memory-enrollment", `${hash([dbPath, state.piId])}.json`);
  const provisional = (): Enrollment | undefined => {
    try {
      const value = JSON.parse(readFileSync(provisionalPath(), "utf8"));
      if (!value || typeof value.defaultEnabled !== "boolean" || (value.choice !== null && typeof value.choice !== "boolean")) throw new Error("Invalid provisional enrollment state");
      return value;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  };
  const persistProvisional = (value: Enrollment, replace = false) => {
    const path = provisionalPath(), temporary = `${path}.${randomUUID()}`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx" });
    try { if (replace) renameSync(temporary, path); else linkSync(temporary, path); }
    catch (error) { if (replace || (error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  };
  let current: { started: string; id?: number } | undefined;
  const pending = new Set<Promise<unknown>>();
  /** The executor's one slot per phase, and what occupies it: one task of a kind at a time. The entry
   * carries the task's target and its frozen boundary beside the promise; `done` is assigned in the
   * same tick the slot is taken. */
  type Slot = { target: TaskTarget; boundary?: TaskBoundary; result?: Promise<NotingResult | { outcome: string } | undefined>; done?: Promise<unknown> };
  type WorkerPhase = "noting" | "dreaming";
  const slots = new Map<WorkerPhase, Slot>();
  // 19c: the phase whose run observed the eligible cache miss, so the run id can be linked to the
  // session's suppression once core has allocated it (the miss is seen before any run row exists).
  const missDetected = new Set<WorkerPhase>();
  // Consecutive eligible fork cache misses per memory session, in this process only (user ruling
  // 2026-09-09): a reopen starts at zero; the persisted latch itself is the session-scoped state.
  const cacheMisses = new Map<number, number>();
  const suppressed = () => (state.sessionId ? memory.store.forkSuppression(state.sessionId) : null);
  /** The one wording of the cache-miss latch's refusal, said the same way at admission and at launch. */
  const latchReason = (suppression: { at: string }) => `cache miss latch: fork suppressed for this session since ${suppression.at}`;
  /** Ticket 29a "Carriers": the `details.traceMemory` written on the two entries that put memory
   * material into this conversation — the injected `custom_message` and a custom compaction — beside
   * what the renderer actually supplied. The database identity is the resolved `dbPath`, the same
   * value `restore` already compares its own state entries by, so another database's equal integer ids
   * can never satisfy coverage. `session` is null until the first reply allocates the memory session
   * id; an injection written before that is recognised afterwards through the Pi session id here. */
  const binding = (): VisibleBinding => ({ db: dbPath, session: state.sessionId ?? null, pi: state.piId });
  /** 97: the carrier names the delivery recorded for its own node; the walk binds that key to the
   * Turn Pi persisted it under. `supplied` Knowledge fields describe the text; nothing reads them. */
  const carrier = (supplied: SuppliedMaterial, prompt?: string) => ({ traceMemory: { ...binding(), supplied, ...(prompt ? { prompt } : {}) } });
  /** 97: the session host that owns this context's delivery records, known before allocation. */
  const owner = () => state.sessionId ? memory.store.getSession(state.sessionId)!.host : `pi:${state.piId}`;
  /** 97: the delivery key a persisted carrier of this database names. */
  const deliveryKey = (entry: object): string | undefined => {
    const own = (entry as { details?: { traceMemory?: { db?: unknown; prompt?: unknown } } }).details?.traceMemory;
    return own?.db === dbPath && typeof own.prompt === "string" && own.prompt ? own.prompt : undefined;
  };
  /** 97: what this context has been delivered, read from the per-node records. Before allocation
   * there is no Turn: the prompts on the path are the carriers Pi persisted on the selected branch. */
  const delivered = (target?: TaskTarget | { sessionId: number; branch: string; headTurnId: number | null }): VisibleView =>
    deliveredView(memory.store.deliveredKnowledge(target
      ? { owner: owner(), sessionId: target.sessionId, branch: target.branch, headTurnId: target.headTurnId }
      : { owner: owner(), sessionId: null, headTurnId: null, pending: ctx.sessionManager.getBranch().flatMap(entry =>
        entry.type === "custom_message" && entry.customType === tag ? [deliveryKey(entry)].filter(key => key !== undefined).map(key => ({ key })) : []) }));
  const deliveryPart = (block: { knowledgeCommitIds: number[]; knowledgeStates?: { fromCommit: number; toCommits: number[] }[]; knowledgeTokens?: number; text: string }) =>
    ({ knowledgeCommitIds: block.knowledgeCommitIds, knowledgeStates: (block.knowledgeStates ?? []).map(knowledgeStateKey),
      knowledgeTokens: block.knowledgeTokens ?? tokens(block.text) });
  /** The task a fork refusal is decided for: its phase, its evidence path and — 27d/18b — the
   * boundary that fixes which pending entries it may take, so 29c checks the batch this task would
   * really select and not a larger set it will never freeze. */
  type ForkTask = { kind: WorkerPhase; target: TaskTarget; boundary?: TaskBoundary };
  /** Ticket 29c "Noter fork eligibility by actual Raw availability" (parent 29). A requested Noter
   * fork runs as a fork exactly when every entry of its target is available in the inherited context
   * in a representation it may extract from — a source entry Pi retained, or the bounded view a
   * carrier of ours supplied for an entry the conversation itself no longer holds (30: one view, and a
   * legacy tier-1 or tier-2 carrier counts as it). That is precisely what 29a's view calls `raw`, so a
   * free summary, an id in prose and an absent tool result are simply not in it; an incomplete
   * tool-call group stays the native gate's
   * own check (`forkable`). One unavailable entry sends the whole target down the existing fallback
   * (27c) with its exact membership — the invisible entry is never skipped to manufacture a forkable
   * batch. This replaces ticket 20's blanket pre-compaction refusal: a pre-compaction entry Pi
   * retained, and one a custom compaction carried as a bounded view, are both available and both fork.
   *
   * A view with no Raw at all is unknown coverage, not proven absence, and is refused for the same
   * reason 27a refuses an unknown context measure: nothing about the inherited context is
   * established, so there is no fork base to check a target against. */
  /** Why a requested fork will not run with inherited context for this task, decided against this
   * host's live state at admission — before anything is frozen, so the refused task is admitted once
   * more as a subagent with fresh material (27c): the cache-miss latch is set, or 29c's Raw
   * availability rule refuses the batch. Undefined means it may fork. Neither refusal is a latch:
   * both are re-decided for every task, and 27c records the reason rather than only its verdict,
   * because the reason is what the run audit and the one warning say. */
  const forkRefused = (requested: "fork" | "subagent", task?: ForkTask): string | undefined => {
    if (requested !== "fork") return;
    const suppression = suppressed();
    if (suppression) return latchReason(suppression);
    if (task?.kind !== "noting") return;
    const parentFile = ctx.sessionManager.getSessionFile?.();
    const checkpoint = ctx.sessionManager.getLeafId();
    if (parentFile && checkpoint) {
      const refusal = checkpointReadiness(parentFile, checkpoint);
      if (refusal) return refusal;
    }
    const view = visible(binding());
    const delta = memory.injection(task.target, delivered(task.target));
    return selectNotingMode({ requested,
      publicationPending: !!(delta.knowledgeCommitIds.length || delta.knowledgeStates?.length), visible: view,
      pending: () => memory.pendingEntries(task.target.sessionId, task.target.branch, task.target.headTurnId),
      batch: () => memory.notingBatch(task.target, task.boundary) }).fallbackReason;
  };
  const modelName = (kind: WorkerPhase) => {
    const configured = flat[PHASE_SETTING_KEYS[kind].model];
    return String(configured && configured !== "session" ? configured : ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session");
  };
  // Each phase configures its own mode, defaulting to subagent when no override is supplied.
  // This is the ordinary automatic path only. Borrowed closed-session
  // work and manual catchup ask for a subagent explicitly at their own call sites, and ticket 28's
  // recovery workers will do the same. Fork mode always runs on the session model, subagent mode on
  // the configured one.
  const launch = (kind: WorkerPhase) => {
    const fork = kind !== "dreaming" && memory.config[kind].forkModeDefault;
    return { mode: fork ? "fork" as const : "subagent" as const, model: fork ? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "session") : modelName(kind) };
  };
  // A committed run may still carry problems (audit update or provider failure after the commit): warn, keep success.
  // The plugin's own model spend as a footer status item (Pi's setStatus, the shape ponytail uses);
  // background runs never enter Pi's session totals, which only count entries of the session file.
  const activity = { running: new Map<WorkerPhase, number>() };
  const runningKind = (kind: WorkerPhase) => (activity.running.get(kind) ?? 0) > 0;
  /** Ticket 24 "Footer counts and cost" and "Indicator semantics" (24a), scope and colours revised by
   * ticket 51. One status item, one line:
   *
   *     🧠 ● notes: 24->102 memory: 252/306 cost: $0.12
   *
   * `notes` is the entries still to note over every applicable committed fact; `memory` is the
   * changed current Knowledge versions followed by all current Knowledge versions. Changed counts
   * are scheduling backlog, not a partition by knowledge validity. `cost` is today's memory spend across the whole
   * database — every session's runs created since local midnight (51) — the memory share of the
   * daily total pi-status reports; this session's cumulative spend and its composition by phase
   * are in Current session. Off is the compact `🧠 ○ off`; the stored counts stay available there.
   *
   * Every count comes from one core progress/applicability query over the current selected branch
   * and head (`memory.progress`), so nothing here renders Raw, tokenizes, freezes a task or loads a
   * run's audit body, and no timer refreshes it — the existing lifecycle, commit, control and
   * status points do, and a day boundary is observed at the next of them. A value that cannot be
   * read is `?`: an unknown is not a fabricated zero, and before this Pi session has allocated a
   * memory identity there is nothing to count at all.
   *
   * The indicator is Pi theme roles, never a literal colour: one role per running phase — Noting
   * `accent`, Dreaming `customMessageLabel` (teal, purple in both
   * bundled themes) — in that precedence when phases overlap; idle and off are `dim`. A retry, a
   * failure or a warning does not colour it: the foreground notify reports those (51). It describes
   * this executor, including while it works on a borrowed target. */
  /** Local midnight of the host's clock as the UTC instant `runs.created_at` is compared against (51). */
  const localMidnight = (now = new Date()) => new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const showSpend = (context: ExtensionContext) => {
    if (closed || !context.ui?.setStatus) return;
    const theme = (context.ui as { theme?: { fg?: (color: string, text: string) => string } }).theme;
    const paint = (color: string, text: string) => { try { return theme?.fg ? theme.fg(color, text) : text; } catch { return text; } };
    const isEnabled = enabled();
    let counts: ReturnType<typeof memory.progress> | undefined, cost: number | undefined;
    // Off counts nothing at all (24a): the off line reads no path, no Raw and no run audit body.
    if (isEnabled) {
      if (state?.sessionId) {
        try { counts = memory.progress(state.sessionId, state.branch, state.head ?? null); } catch { /* unavailable: shown as ?, never as 0 */ }
      }
      try { cost = memory.spendSince(localMidnight()); } catch { /* the same rule for the amount */ }
    }
    // Ticket 75: text/indicator logic moved to the host-neutral formatter Claude Code's status
    // command shares; only the painting (this host's theme roles) stays here.
    const segments = memoryStatusLine({ enabled: isEnabled,
      running: { noting: runningKind("noting"), dreaming: runningKind("dreaming") },
      counts, cost });
    context.ui.setStatus(tag, `🧠 ${segments.map(segment => paint(segment.role, segment.text)).join(" ")}`);
  };
  const reportProblems = (result: unknown, context: ExtensionContext) => {
    const r = result as { outcome?: string; problems?: string[] } | undefined;
    if (r?.outcome === "dropped") return; // a duplicate trigger says nothing about the run still in flight
    showSpend(context);
    if (r?.outcome === "success" && r.problems?.length) context.ui.notify(`Trace Memory: committed with problems. ${r.problems.join("; ")}`, "warning");
  };
  // One admission path for ordinary (own/borrowed) and manual-catchup work (18b): only the target,
  // mode/model and admission flags differ. `boundary` is absent for ordinary automatic work.
  // The return type is written out because 27b/27c's re-admission re-enters this function.
  const attemptPhase = (context: ExtensionContext, kind: WorkerPhase, target: TaskTarget,
      selected: { mode: "fork" | "subagent"; model: string; fallbackReason?: string },
      options: { borrowed: boolean; automatic: boolean; boundary?: TaskBoundary; forkAttempt?: ForkRefusal },
      ): Promise<NotingResult | DreamingResult | { outcome: "dropped"; permanent?: string }> => {
    if (closed || !enabled()
        || (options.forkAttempt?.cancellation !== undefined && options.forkAttempt.cancellation < memory.cancellation))
      return Promise.resolve({ outcome: "dropped", reason: CANCELLED_BEFORE_FALLBACK } as const);
    // 26b: admission is the freeze point of the worker's thinking level, beside its model and its
    // material. The foreground level is read once here, as a value — every later round of this run
    // and its fork-to-subagent fallback use exactly this level, whatever the foreground switches to
    // meanwhile — and Pi's own session constructor clamps it to what the worker model supports, so
    // no per-model preference and no global default decides a worker's level. Borrowed closed-session
    // work and manual catchup reach this line too, and inherit this executor's level, never a
    // historical target session's.
    // 26d: two levels are frozen, not one. `thinkingLevel` is the inherited foreground level a fork
    // run uses (26b, unchanged: its request prefix must still match the captured parent's).
    // `subagentThinkingLevel` is what every fresh child of this task thinks at — explicit subagent
    // mode, a fork fallback, borrowed work, manual catchup — which is this phase's configured
    // preference, or the same inherited level when it is `inherit` or unset. Read here, at admission,
    // so a preference saved afterwards reaches neither this run's later rounds nor its fallback.
    // 27d repair 3 (parent 27 line 96): a re-admitted task reuses the pair its refusal carried and
    // reads neither the foreground level nor the preference again — this is the same task's admission
    // continuing, and repricing fresh material is not permission to reread a frozen policy choice.
    // The fresh model preference is frozen here too, before any asynchronous refusal.
    const carried = options.forkAttempt;
    const generation = carried?.cancellation ?? memory.cancellation;
    const configuredModel = carried?.subagentModel ?? modelName(kind);
    const fallbackModel = configuredModel === "session" && context.model
      ? `${context.model.provider}/${context.model.id}` : configuredModel;
    const configuredThinking = flat[PHASE_SETTING_KEYS[kind].thinking];
    const inheritedThinking = carried ? carried.thinkingLevel : pi.getThinkingLevel();
    const subagentThinking = carried ? carried.subagentThinkingLevel
      : configuredThinking && configuredThinking !== "inherit" ? String(configuredThinking) : inheritedThinking;
    // 27c (parent 27 "Per-task fork fallback", amendments 5 and 6): the one rule for every fork this
    // host does not run — whatever the reason, the task runs as a subagent on the configured Noter
    // model (`notingModel`, the `session` preference included), priced by that model's own capacity,
    // with fresh material, and one warning names the reason. The requested mode stays `fork`, so the
    // run audit keeps what was configured; `fallbackReason` is what makes it run fresh, and it is the
    // run's recorded reason. A task carrying one is never refused a fork again (the launch below is
    // not even offered one), which is the structural one-transition guard.
    const asSubagent = (reason: string) => { notifyFallback(kind, reason); return { ...selected, model: fallbackModel, fallbackReason: reason }; };
    // The refusals this host knows before anything is frozen — the cache-miss latch, 29c's Raw
    // availability — are applied here, where the model and the capacity are still open:
    // one admission, no second freeze. A re-admitted task carries its own reason and re-resolves none.
    const refusal = selected.fallbackReason ? undefined : forkRefused(selected.mode, { kind, target, boundary: options.boundary });
    const selection = refusal ? asSubagent(refusal) : selected;
    const effective = selection.fallbackReason ? "subagent" as const : selection.mode; // admission pauses by what will run, not by what was asked
    const [provider, ...id] = selection.model.split("/");
    const model = selection.model === "session" || selection.model === `${context.model?.provider}/${context.model?.id}` ? context.model : context.modelRegistry.find(provider!, id.join("/"));
    const phase = kind === "noting" ? "Noting" : "Dreaming";
    // 27a: the allowance is the window minus the fixed headroom, so an invalid window and one that
    // cannot even hold the headroom fail here, before anything is sent. `model.maxTokens` is read
    // nowhere any more: it changes neither the allowance nor this verdict.
    if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow - CONTEXT_HEADROOM <= 0) {
      const permanent = `${phase} capacity: unavailable model context window (it must exceed the ${CONTEXT_HEADROOM}-token headroom); left pending`;
      context.ui.notify(permanent, "error");
      // A configuration error, not a transient wait: a manual catchup must fail on it, never retry (review 2026-09-08).
      return Promise.resolve({ outcome: "dropped", permanent } as const);
    }
    // Capacity is checked before selection.
    // 27a: a fork's inherited prefix is Pi's own measure of this session's context, read once here
    // and frozen with the task beside the model and the thinking level — the real usage of the latest
    // valid reply on the path plus Pi's estimate of the messages after it. It already holds the
    // images and the encrypted fields of that history, so no accounting of ours walks a request body,
    // and a later foreground turn cannot move the number this task was admitted on. A capture from
    // another branch or another model is not a fork base and prices no prefix; the launch below
    // refuses those to a fresh child, which is priced by the same freeze's subagent material.
    // A session the cache-miss latch has downgraded runs with fresh context, so there is no prefix.
    const base = effective === "fork" && session.capture?.branch === target.branch
      && session.capture.model === model.id && session.capture.provider === model.provider;
    const measure = base ? context.getContextUsage() : undefined;
    // 27b (parent 27 amendment 5) and 27c (amendment 6): a refusal this admission could not know —
    // the freeze's own capacity verdict, a fork base this host cannot price, and every refusal the
    // launch, the gate or the provider raises after the task was frozen — is one re-admission, not a
    // retry: the same task, admitted once more as a subagent by `asSubagent` above, so the batch is
    // re-frozen with fresh material under the ordinary exact selection at the configured model's own
    // capacity. A task that already ran keeps its frozen evidence membership through the task
    // boundary — 27d: its exact entry ids, never an upper bound — and its frozen levels and
    // cancellation generation travel with it. The evidence path and a manual catchup's own boundary
    // travel in `target` and `options`. Nothing is drained immediately: the same task, admitted once
    // more.
    // 27d repair 1: an attempt that sent a request already has its own run record, whose id core
    // returned with the refusal; the run this admission makes names it in its own reason, so the two
    // records read as the one task they are. The warning stays the reason alone.
    // 27d repair 4: the warning is said only if this admission launched something. A task cancelled
    // between the refusal and here drops before it freezes anything, and a cancelled user is owed no
    // notice; every other ending, its own failure included, warns exactly as before.
    const reroute = (refusal: ForkRefusal) => {
      const refused: ForkRefusal = { thinkingLevel: inheritedThinking, subagentThinkingLevel: subagentThinking,
        cancellation: generation, ...refusal, subagentModel: fallbackModel };
      const reason = refused.runId === undefined ? refused.reason : `${refused.reason} (fork attempt recorded as R${refused.runId})`;
      const warn = () => notifyFallback(kind, refused.reason);
      return attemptPhase(context, kind, target, { ...selected, model: fallbackModel, fallbackReason: reason },
        { ...options, ...(refused.boundary ? { boundary: refused.boundary } : {}), forkAttempt: refused })
        .then(result => { if ((result as { reason?: string }).reason !== CANCELLED_BEFORE_FALLBACK) warn(); return result; },
          error => { warn(); throw error; });
    };
    // An unknown measure — right after a compaction, before a valid reply — is not a fork base either,
    // and unlike the two above nothing downstream would refuse it, so it is rerouted here rather than
    // waiting: no whole-body estimate ever stands in for the measure.
    if (base && typeof measure?.tokens !== "number")
      return reroute({ reason: `${phase} capacity: Pi reports an unknown context measure for this session, so this task has no fork base` });
    const capacity = { inputTokens: model.contextWindow - CONTEXT_HEADROOM, prefixTokens: measure?.tokens ?? 0 };
    // 29b: the second half of a fork's initial state, beside the measure above — what this session's
    // selected context actually holds, read through the 29a memo and frozen with the task. Only a task
    // that will run with an inherited context gets one: an explicit subagent and a fork re-admitted as
    // a subagent (`fallbackReason` makes `effective` subagent above) pass none, so core builds the
    // complete fresh material for them, exactly as before.
    const inherited = effective === "fork" ? structuredClone(visible(binding())) : undefined;
    const common = { ...target, ...selection, effectiveMode: effective, thinkingLevel: inheritedThinking,
      ...(inherited ? { visible: inherited } : {}),
      subagentThinkingLevel: subagentThinking,
      borrowed: options.borrowed, automatic: options.automatic, executorSessionId: state.sessionId!, capacity,
      ...(options.boundary ? { boundary: options.boundary } : {}),
      // 27c: the refused attempt's gate result, for a refusal that recorded no run of its own.
      // 27d: with it, the cancellation generation that attempt was admitted under — core drops this
      // admission when a cancellation happened in between.
      ...(carried ? { forkAttempt: carried, executionId: carried.executionId, ...(carried.cancellation !== undefined ? { cancellation: carried.cancellation } : {}) } : {}) };
    const admitted = (kind === "dreaming" ? memory.dream(common) : memory.noting(common))
      .then(result => { if (result.automaticOff) context.ui.notify(result.automaticOff, "warning"); return result; });
    if (effective !== "fork") return admitted;
    // 27b: the freeze priced this batch as a fork — the inherited context plus the instructions — and
    // refused it. The same evidence under a fresh child's own price often fits, so that one refusal
    // is re-admitted instead of leaving feasible work pending. Only this refusal: any other admission
    // failure (a `noting.batchTokens` overflow, a store error) is reported as itself, and if the
    // subagent admission refuses the batch too, that refusal is what the caller reports.
    return admitted.catch(error => error instanceof Error && error.cause === "task admission"
      && error.message.startsWith(NOTING_CAPACITY)
      ? reroute({ reason: error.message.replace(/; left pending$/, "") }) : Promise.reject(error))
      // 27c: the launch, the gate or the provider refused this fork after the task was frozen. Core
      // handed the refusal back unread, so the one re-admission happens here — on the frozen batch's
      // own entries. The re-admitted task runs fresh, so nothing it returns can be a refusal again.
      // 27d: `runId` is core's record of that attempt, present exactly when it sent a request.
      .then(result => { const dropped = result as { refused?: ForkRefusal; runId?: number; executionId?: string };
        return dropped.refused ? reroute({ ...dropped.refused, executionId: dropped.executionId, ...(dropped.runId !== undefined ? { runId: dropped.runId } : {}) }) : result; });
  };
  // Keep the existing storage provenance value; session.project_declaration controls sharing.
  const ownProject = (piId: string) => (memory.store.findProjectByName(`pi:${piId}`)
    ?? memory.store.createProject({ name: `pi:${piId}`, declaredBy: "marker" })).id;
  let savedSourceHead: number | undefined;
  const save = () => { pi.appendEntry(tag, { ...state, dbPath }); savedSourceHead = state.sourceHead; };
  const restore = (context: ExtensionContext, fork = false) => {
    ctx = context;
    // 29a's memo, bound to this session's manager: one visible-view computation per context position,
    // re-read by every prompt of that position. Rebuilt here because `restore` is the one place a
    // different Pi session (and therefore a different manager) can arrive.
    visible = visibility(ctx.sessionManager);
    const loaded = configuration(ctx.cwd, environment, agentDir);
    if (loaded.flat.dbPath !== flat.dbPath) throw new Error("dbPath changed; reload the extension to reopen the database");
    ({ flat, core, sources, layers } = loaded);
    Object.assign(memory.config, validateConfig(core));
    if (!baseline) {
      mkdirSync(dirname(baselinePath), { recursive: true });
      const temporary = `${baselinePath}.${randomUUID()}`;
      writeFileSync(temporary, JSON.stringify(now()), { flag: "wx" });
      try { linkSync(temporary, baselinePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      finally { unlinkSync(temporary); }
      baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
      if (typeof baseline !== "string" || !Number.isFinite(Date.parse(baseline))) throw new Error("Invalid Trace Memory baseline");
    }
    const saved = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === tag)
      .map(e => (e as { data: State & { dbPath: string } }).data).filter(d => d.dbPath === dbPath).at(-1);
    const piId = ctx.sessionManager.getSessionId();
    // A tree switch invalidates the old branch body, even when returning to a saved head.
    session.capture = undefined;
    if (saved) {
      const tip = ctx.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === tag)
        .map(e => (e as { data: State & { dbPath: string } }).data)
        .filter(d => d.dbPath === dbPath && d.sessionId === saved.sessionId && d.branch === saved.branch).at(-1);
      // A provisional state cannot have a user project declaration; do not restore a former file-derived project.
      state = { ...saved, projectId: saved.sessionId ? saved.projectId : ownProject(piId), piId, branch: (fork && (tip?.head !== saved.head || tip?.sourceHead !== saved.sourceHead)) || saved.piId !== piId ? randomUUID() : saved.branch };
    } else {
      state = { projectId: ownProject(piId), branch: "main", piId };
    }
    // Branch history restores position only; the database and latest provisional choice own intent.
    const latest = ctx.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === tag)
      .map(e => (e as { data: State & { dbPath: string } }).data).filter(d => d.dbPath === dbPath && d.piId === piId).at(-1);
    // Legacy supplement counters are deliberately not restored as intent. Visibility comes only
    // from identity-bound carriers on the selected context path.
    if (!state.sessionId && latest?.sessionId) {
      state.sessionId = latest.sessionId;
      state.originPiId = latest.originPiId;
      state.branch = randomUUID();
    }
    // 84 edge case: `synchronous=NORMAL`'s accepted rollback window can reach back before this
    // session's own creation — this custom entry still names a core session id the rollback erased
    // (the row is simply gone; a session that exists under the wrong host is a different, unrelated
    // corruption and still throws below). Drop the lost identity and continue exactly like a
    // not-yet-registered (provisional) session: `walk()` below allocates a fresh core session
    // through the ordinary first-start path and re-imports Raw from the native session. The
    // enrollment fallback right below already carries the user's last choice forward from
    // `latest`/`saved` as the provisional one, so it is left untouched; `projectId` self-heals the
    // same way, through `allocate()`'s own `directoryAllocation` call.
    if (state.sessionId && !memory.store.getSession(state.sessionId)) {
      state.sessionId = undefined;
      state.originPiId = undefined;
      state.shared = false;
      state.branch = "main";
      state.project = undefined;
    }
    state.enrollment = state.sessionId ? memory.store.enrollment(state.sessionId)
      : provisional() ?? latest?.enrollment ?? saved?.enrollment ?? { defaultEnabled: enrollmentDefault(ctx.sessionManager.getHeader()?.timestamp, baseline), choice: null };
    if (!state.sessionId) { persistProvisional(state.enrollment); state.enrollment = provisional()!; }
    state.shared = state.shared || (!!state.sessionId && memory.store.getSession(state.sessionId)!.host !== `pi:${piId}`);
    // 19 amendment 2026-09-09: "a reopen starts at zero; the persisted latch itself is unchanged".
    // The reopen of the memory session is that boundary, so the process-local consecutive-miss count
    // is cleared exactly here — not on a tree switch (`fork`), which moves position inside the same
    // session and leaves its misses consecutive, and never together with `forkSuppression`, which is
    // database state and survives (its only reset is the menu's Retry fork).
    if (state.sessionId && !fork) { memory.store.reopenSession(state.sessionId, memory.executorId); cacheMisses.delete(state.sessionId); }
    // 18b lifecycle: switching away from a catchup's frozen path ends it and cancels its owned
    // in-flight work; it is never retargeted to the newly selected branch or resumed on reopen.
    if (catchup && !catchup.outcome && (catchup.sessionId !== state.sessionId || catchup.branch !== state.branch)) {
      catchup.stopped = true;
      if (!catchup.active.size) catchup.outcome = "stopped";
      memory.cancelTasks();
    }
    current = undefined;
    reconciledLeaf = undefined; reconciled = undefined; // 22b: a restored session reconciles its ancestry from the start
    reconcile();
    showSpend(ctx);
    if (state.sessionId) {
      state.projectId = memory.store.getSession(state.sessionId)!.projectId;
      if (memory.store.projectDeclaration(state.sessionId) === "mark") state.project = memory.store.getProject(state.projectId)!.name;
    }
    save(); // Provisional intent is durable before the first reply, too.
  };
  const ensure = (context: ExtensionContext) => { if (closed) throw new Error("Trace Memory executor is closed"); ctx = context; if (!state || state.piId !== context.sessionManager.getSessionId()) restore(context); };
  const allocate = (started: string) => {
    if (state.sessionId) return;
    // 62: the one place this host resolves cwd; a resume restores the row's project and never re-resolves.
    const allocation = directoryAllocation(memory.store, ctx.cwd, () => ownProject(state.piId));
    state.projectId = allocation.projectId;
    state.sessionId = memory.store.createSession({ host: `pi:${state.piId}`, startedAt: started, firstReplyAt: now(), ...allocation, nativeCreatedAt: ctx.sessionManager.getHeader()?.timestamp, baseline, enrollmentChoice: (provisional() ?? state.enrollment!).choice }).id;
    state.originPiId = state.piId;
    try { unlinkSync(provisionalPath()); } catch { /* no receipt, or already consumed */ } // the store owns enrollment from here
  };
  const historyProblems = new Set<string>();
  const missing = (problem: string) => {
    if (!historyProblems.has(problem)) { historyProblems.add(problem); ctx.ui.notify(`Trace Memory: missing native history: ${problem}`, "warning"); }
  };
  // Pi persists after message_end hooks. Unchanged leaves need no work; a changed leaf follows
  // native parent links only as far as the already reconciled leaf. Restoration/navigation still
  // rebuilds and verifies the full ancestry, and snapshots retain their full integrity check.
  let reconciledLeaf: string | null | undefined;
  let reconciled: { ids: string[]; lineage: string; turnId?: number; head?: number; selected: number[]; seen: Set<string>;
    path: ReturnType<TraceMemory["store"]["sourcePathState"]>;
    toolCalls: Map<string, { ordinal: number; name: string; callId: string }> } | undefined;
  const reconcile = () => {
    if (!enabled()) return;
    const leaf = ctx.sessionManager.getLeafId();
    if (state.sessionId && leaf === reconciledLeaf) return;
    try { walk(); }
    catch (error) { reconciled = undefined; reconciledLeaf = undefined; throw error; }
    // A walk before the memory session exists creates no Turn; the first walk after allocation must run.
    reconciledLeaf = state.sessionId ? leaf : undefined;
    // Reconciliation imports evidence only; the settled main turn checks work once.
  };
  const walk = () => memory.store.transaction(() => {
    let resume: typeof reconciled;
    let ancestry: SessionEntry[] = [];
    if (reconciled && state.sessionId) {
      const previousLeaf = reconciled.ids.at(-1);
      let cursor = ctx.sessionManager.getLeafId();
      const visited = new Set<string>();
      while (cursor && cursor !== previousLeaf) {
        if (visited.has(cursor)) throw new Error("Trace Memory: cyclic native ancestry");
        visited.add(cursor);
        const entry = ctx.sessionManager.getEntry(cursor);
        if (!entry) break;
        ancestry.push(entry); cursor = entry.parentId;
      }
      if (cursor === previousLeaf) {
        const stored = memory.store.sourcePathState(state.sessionId, state.branch), expected = reconciled.path;
        if (stored && expected && stored.count === expected.count && stored.tailId === expected.tailId && stored.version === expected.version)
          resume = reconciled;
      }
    }
    ancestry = resume ? ancestry.reverse() : ctx.sessionManager.getBranch();
    if (!state.sessionId && ancestry.some(e => e.type === "message" && e.message.role === "assistant" &&
      (text(e.message) || e.message.content.some(c => c.type === "toolCall" || c.type === "thinking")))) allocate(ancestry[0]?.timestamp ?? now());
    if (!state.sessionId) return;
    reconciled = undefined; // a walk that throws leaves nothing to resume from
    let lineage = resume ? resume.lineage : state.originPiId ?? state.piId;
    let turnId = resume?.turnId;
    // 97: the node a new user Turn descends from. It is the owning Turn, except after a compaction
    // this host recorded: then the compaction's Turn, so the compaction lies on every later path.
    let head = resume?.head;
    const ids = resume ? resume.ids : [], selected = resume ? resume.selected : [];
    const priorCount = selected.length;
    const seen = resume ? resume.seen : new Set<string>();
    const toolCalls = resume ? resume.toolCalls : new Map<string, { ordinal: number; name: string; callId: string }>();
    // One Turn's offer of a call id. A later entry supersedes an earlier one and the first occurrence
    // inside an entry wins, which is the order the per-result rescan searched in.
    const offer = (turn: number, list: { ordinal: number; name: string; callId: string }[]) => {
      const own = new Set<string>();
      for (const call of list) {
        const key = `${turn} ${call.callId}`;
        if (own.has(key)) continue;
        own.add(key); toolCalls.set(key, call);
      }
    };
    for (const entry of ancestry) {
      ids.push(entry.id);
      if (entry.parentId && !seen.has(entry.parentId)) missing(`parent ${entry.parentId} before ${entry.id}`);
      seen.add(entry.id);
      if (entry.type === "custom" && entry.customType === tag) {
        const data = entry.data as State & { dbPath?: string };
        if (data.dbPath === dbPath) lineage = data.piId;
        continue;
      }
      // 97: a carrier's delivery belongs to the node Pi persisted it under.
      const key = deliveryKey(entry);
      if (entry.type === "custom_message" && entry.customType === tag) {
        if (key && turnId) memory.store.bindDeliveryNode(key, state.sessionId, turnId);
        continue;
      }
      if (entry.type === "compaction") {
        const node = memory.store.findNativeTurn(state.sessionId, lineage, entry.id);
        if (node?.kind === "compaction") {
          head = node.turnId;
          if (key) memory.store.bindDeliveryNode(key, state.sessionId, node.turnId);
        }
        continue;
      }
      const source = piPersistedSource(entry);
      if (!source) continue;
      const { message, text: natural, calls } = source;
      // 74: identity without Raw — `digest` compares against the same string (`JSON.stringify(message)`)
      // `known.raw` used to, without loading `content`/`blocks`. A matching digest is the same
      // serialized message, so its role is the persisted one. A changed entry is reported and the walk
      // goes on, still deciding `offer` by the persisted role as before; only that entry pays a full read.
      const known = memory.store.findKnownSourceEntry(state.sessionId, lineage, entry.id);
      if (known) {
        let role = message.role;
        if (known.digest !== sourceDigest(JSON.stringify(message))) {
          missing(`entry ${entry.id} changed after persistence`);
          role = memory.store.getSourceEntry(known.id)!.role;
        }
        selected.push(known.id); turnId = known.turnId;
        if (role === "user" || head === undefined) head = known.turnId;
        if (role === "assistant") offer(known.turnId, known.calls);
        continue;
      }
      if (message.role === "user") {
        turnId = memory.store.appendTurn({ sessionId: state.sessionId, parentTurnId: head ?? turnId ?? null, kind: "turn", userPrompt: natural, startedAt: entry.timestamp }).id;
        head = turnId;
      }
      if (!turnId) { missing(`owning user entry for ${entry.id}`); continue; }
      const fragments: Parameters<typeof memory.appendEntry>[0]["calls"] = [];
      for (const call of calls) {
        const input = JSON.stringify(call.arguments);
        const stored = memory.store.appendToolCall({ turnId, name: call.name, input, status: "attempted" });
        fragments.push({ ordinal: stored.ordinal, name: call.name, callId: call.id, input, status: "attempted" });
      }
      if (message.role === "toolResult") {
        const call = toolCalls.get(`${turnId} ${message.toolCallId}`);
        if (!call) { missing(`tool call ${message.toolCallId} for ${entry.id}`); continue; }
        const result = JSON.stringify({ content: message.content, details: message.details });
        const status = message.isError ? "failure" : "success";
        memory.store.completeToolCall(turnId, call.ordinal, result, status);
        fragments.push({ ordinal: call.ordinal, name: call.name, callId: call.callId, result, status });
      }
      const stored = memory.appendEntry({ sessionId: state.sessionId, nativeLineage: lineage, nativeId: entry.id, turnId,
        role: message.role, text: natural, raw: JSON.stringify(message), calls: fragments });
      selected.push(stored.id);
      if (message.role === "assistant") {
        offer(turnId, fragments);
        const value = memory.store.getTurn(turnId)!;
        memory.store.updateTurn(turnId, { assistantText: [value.assistantText, natural].filter(Boolean).join("\n") });
      }
    }
    if (state.head && !turnId && memory.store.listSourceEntries(state.sessionId).length) missing("selected ancestry contains no available source entries");
    let path: ReturnType<TraceMemory["store"]["sourcePathState"]>;
    if (turnId && resume?.path) {
      path = selected.length === priorCount && turnId === resume.turnId ? resume.path
        : memory.store.appendSourcePath(state.sessionId, state.branch, resume.path, selected.slice(priorCount), turnId, state.piId);
    } else {
      if (turnId) memory.store.publishSourcePath(state.sessionId, state.branch, selected, turnId, state.piId);
      else memory.selectEntries(state.sessionId, state.branch, selected);
      path = memory.store.sourcePathState(state.sessionId, state.branch);
    }
    state.sourceHead = selected.at(-1);
    if (turnId) {
      state.head = head ?? turnId;
      if (current) current.id = turnId;
    }
    reconciled = { ids, lineage, turnId, head, selected, seen, toolCalls, path };
  });

  const unavailable = (reason: Extract<CurrentContextSnapshotResult, { available: false }>["reason"], message: string): CurrentContextSnapshotResult =>
    ({ available: false, reason, message });
  /** Read the already-ingested node. Never reconcile, publish, or run compact recovery here. */
  const currentContextSnapshot = (): CurrentContextSnapshotResult => {
    if (closed) return unavailable("closed", "Trace Memory executor is closed");
    if (!ctx || !state?.sessionId || !state.head)
      return unavailable("not-initialized", "Trace Memory has no current memory session");
    if (!enabled()) return unavailable("disabled", "Trace Memory is disabled");
    const nativeSessionId = ctx.sessionManager.getSessionId();
    const nativeLeafId = ctx.sessionManager.getLeafId();
    if (!ctx.sessionManager.getSessionFile() || !nativeLeafId || nativeSessionId !== state.piId)
      return unavailable("node-not-ready", "The current native node is not persisted or bound");
    const ancestry = ctx.sessionManager.getBranch();
    if (!reconciled || reconciled.ids.length > ancestry.length
        || !reconciled.ids.every((id, index) => ancestry[index]!.id === id))
      return unavailable("node-not-ready", "The current native ancestry has not been ingested");
    const nativeSources = ancestry.map(piPersistedSource).filter(source => source !== undefined);
    const { sessionId, projectId, branch, head } = state;
    const selected = reconciled.selected;
    return memory.store.transaction(() => {
      if (memory.store.getSession(sessionId)?.projectId !== projectId)
        return unavailable("node-not-ready", "The memory binding changed");
      if (!memory.store.enabled(sessionId)) return unavailable("disabled", "Trace Memory is disabled");
      // 79 item 3: the integrity check reads no Raw. It compares metadata alone -- id, native id and
      // 74's stored digest -- against `sourceDigest` of the live native message, catching exactly what
      // yesterday's `entry.raw !== JSON.stringify(...)` caught (a persisted message whose content
      // changed under the same id after the last walk), without loading a single stored `content`.
      const sources = memory.store.sourcePath(sessionId, branch, head);
      if (sources.length !== selected.length || sources.length !== nativeSources.length
          || sources.some((entry, index) => entry.id !== selected[index] || entry.nativeId !== nativeSources[index]!.id
            || entry.digest !== sourceDigest(JSON.stringify(nativeSources[index]!.message))))
        return unavailable("node-not-ready", "The current native source path is not completely reconciled");
      const compact = memory.compact(sessionId, branch, head, []);
      if ("native" in compact) return unavailable("capacity", compact.reason);
      if (!compact.composition) return unavailable("data-error", "The compact allocator returned no composition");
      return { available: true, node: { nativeSessionId, nativeLeafId }, text: compact.text,
        estimatedTokens: tokens(compact.text), composition: compact.composition, supplied: compact.supplied };
    });
  };
  const unsubscribeCurrentContextSnapshot = pi.events.on(CURRENT_CONTEXT_SNAPSHOT_EVENT, reply => {
    if (typeof reply !== "function") return;
    let result: CurrentContextSnapshotResult;
    try { result = currentContextSnapshot(); }
    catch (error) { result = unavailable("data-error", error instanceof Error ? error.message : String(error)); }
    reply(result);
  });

  const persistState = () => { reconcile(); if (state.sessionId && state.sourceHead !== savedSourceHead) save(); };
  const flush = (ended = false) => {
    reconcile();
    if (enabled() && ended && current?.id && state.sessionId && state.head) memory.store.transaction(() => {
      memory.store.updateTurn(current!.id!, { endedAt: now() });
      // Reconcile already published this path and cursor atomically; ending a Turn
      // changes no membership and must not revalidate the entire ancestry.
    });
  };
  pi.on("before_provider_request", (event, context) => {
    ensure(context);
    if (!enabled()) { showSpend(context); return; }
    reconcile();
    // The capture is the fork gate's comparand and nothing else: the request-copy runner that also
    // read the ancestry behind it was deleted in 19c, so only the body is kept (review 2026-09-08).
    if (context.model) session.capture = { payload: snapshot(event.payload) as Body, model: context.model.id, provider: context.model.provider, branch: state.branch };
  });
  pi.on("session_start", (_event, context) => {
    restore(context);
    // 101: Pi keeps the first registration of a tool name; say what that costs when it is not ours.
    const tools = pi.getAllTools();
    for (const [name, description] of memoryTools) {
      const winner = tools.find(tool => tool.name === name);
      if (winner && winner.description !== description) context.ui.notify(`Trace Memory: ${winner.sourceInfo?.path ?? "another extension"} registered ${name} first; ` +
        `Pi keeps the first registration, so ${name} cannot read Trace Memory under /tm/ in this session.`, "warning");
    }
  });
  // 29d: the injected-once flag is gone, so a tree switch resets nothing here — the selected
  // context's own visible view is what decides the next prompt's knowledge block (29a case 8).
  pi.on("session_tree", (_event, context) => { restore(context, true); });
  pi.on("before_agent_start", (event, context) => {
    ensure(context);
    current = { started: now() };
    if (!enabled()) { showSpend(context); return; }
    reconcile();
    // Ticket 34c: this is the single delivery predicate. Every enabled ordinary prompt compares one
    // selected-context view with one current applicable graph; commands and worker completions add no
    // separate trigger. Facts and Raw can suppress a revision but are never added to this payload.
    const authority = { binding: binding(), leaf: context.sessionManager.getLeafId(), branch: state.branch,
      head: state.head ?? null, projectId: state.projectId, sessionId: state.sessionId ?? null };
    let block: ReturnType<TraceMemory["injection"]>;
    try {
      const target = state.sessionId ? { sessionId: state.sessionId, headTurnId: state.head ?? null, branch: state.branch } : undefined;
      block = memory.injection(target ?? { projectId: state.projectId }, delivered(target));
    } catch (error) { context.ui.notify(String(error), "error"); return; }
    if (!block.text) return;
    // Publication, not an offer, is authoritative. Recheck every mutable binding immediately before
    // returning the message Pi may persist; a retarget or enrollment/project change consumes nothing.
    const sameBinding = JSON.stringify(binding()) === JSON.stringify(authority.binding);
    const sameTarget = context.sessionManager.getLeafId() === authority.leaf && state.branch === authority.branch
      && (state.head ?? null) === authority.head && state.projectId === authority.projectId
      && (state.sessionId ?? null) === authority.sessionId;
    const sameProject = !state.sessionId || memory.store.getSession(state.sessionId)?.projectId === authority.projectId;
    if (!enabled() || !sameBinding || !sameTarget || !sameProject) return;
    const supplied: SuppliedMaterial = { entries: [], factIds: [], knowledgeCommitIds: block.knowledgeCommitIds,
      knowledgeTokens: block.knowledgeTokens,
      ...(block.knowledgeStates?.length ? { knowledgeStates: block.knowledgeStates } : {}) };
    // 97 "Record at emission": this prompt's node owns the delivery once Pi persists the prompt.
    const prompt = randomUUID();
    try { memory.store.recordKnowledgeDelivery({ owner: owner(), nodeKey: prompt }, [deliveryPart(block)]); }
    catch (error) { context.ui.notify(String(error), "error"); return; }
    return { message: { customType: tag, content: block.text, display: false,
      details: { traceMemory: { ...carrier(supplied, prompt).traceMemory, composition: block.composition } } } };
  });
  pi.on("message_start", (event, context) => {
    ensure(context); reconcile();
    if (event.message.role === "user") {
      flush(true);
      current = { started: now() };
      reconcile();
    }
  });
  const assistant = (message: { content?: unknown }, context: ExtensionContext) => {
    ensure(context);
    if (!enabled()) return;
    persistState(); // the user message is in the session file once the assistant has started
    if (!current || (!text(message) && (!Array.isArray(message.content) ||
      !message.content.some(c => c.type === "toolCall" || (c.type === "thinking" && c.thinking))))) return;
    allocate(current.started);
    reconcile();
  };
  pi.on("message_update", (event, context) => { if (event.message.role === "assistant") assistant(event.message, context); });
  pi.on("message_end", (event, context) => { if (event.message.role === "assistant") assistant(event.message, context); });
  // Persisted assistant/tool entries are imported here; no work is scheduled mid-turn.
  pi.on("tool_execution_start", (_event, context) => { ensure(context); reconcile(); });
  // 24a: a tool result, the end of an agent run and the settle are the existing boundaries at which
  // this turn's evidence became importable, so they are where the footer's counts are re-read. A
  // streaming update is not one of them: `message_update` fires per delta and refreshes nothing.
  pi.on("tool_result", (_event, context) => { ensure(context); persistState(); showSpend(context); });
  pi.on("agent_end", (_event, context) => { ensure(context); persistState(); showSpend(context); });
  let checkedTurn: string | undefined;
  pi.on("agent_settled", (_event, context) => {
    ensure(context); persistState();
    try {
      if (!enabled()) return;
      // 29d: nothing is confirmed here any more. What this prompt supplied is stated on the entry Pi
      // persisted for it (29a's carrier), so the settle has no delivery queue to drain and no
      // injected-once flag to set.
      if (!state.sessionId || !state.head) return;
      if (current?.id && memory.store.getTurn(current.id)?.assistantText !== null) flush(true);
      else reconcile();
      const key = `${state.sessionId}/${state.branch}/${state.head}`;
      if (checkedTurn === key) return;
      checkedTurn = key;
      checkQueues();
    } finally { showSpend(context); } // one refresh at the settle, whichever path this turn took
  });
  /** Track cleanup, not admission or result policy. Callers reserve the slot before starting work
   * and choose whether `slot.result` exposes the raw attempt, a swallowed rejection or this settled
   * promise. Shutdown waits for cleanup; only an explicit catchup may chain on release. */
  const trackSlot = <T,>(kind: WorkerPhase, slot: Slot, work: Promise<T>, context: ExtensionContext, released: () => void): Promise<T> => {
    const settled = work.finally(() => {
      slots.delete(kind); pending.delete(settled); activity.running.delete(kind);
      released();
    });
    slot.done = settled;
    pending.add(settled);
    // Consume cleanup failures even when the initiating caller does not await this task.
    void settled.catch(error => { try { context.ui.notify(`Trace Memory cleanup failed: ${String(error)}`, "error"); } catch { /* exit must still finish */ } });
    return settled;
  };
  const checkQueues = () => {
    if (closed || !enabled() || !state.sessionId || !state.head) return;
    const context = ctx;
    const own = { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head, triggerEntryId: state.sourceHead };
    const generation = memory.cancellation;
    for (const kind of ["noting", "dreaming"] as const) {
      if (slots.has(kind)) continue;
      let due = false;
      try { ({ due } = memory.taskEligibility(kind, own)); }
      catch (error) { context.ui.notify(String(error), "error"); }
      const candidates: ({ borrowed: boolean } & TaskTarget)[] = due ? [{ ...own, borrowed: false }] : [];
      if (kind !== "dreaming") {
        try { candidates.push(...memory.store.closedTasks(kind, own.sessionId, memory.config.closedSessionScope)
          .map(target => ({ ...target, borrowed: true }))); }
        catch (error) { context.ui.notify(`${kind} closed-session scan failed: ${String(error)}`, "error"); }
      }
      if (!candidates.length) continue;
      const slot: Slot = { target: own }; // ordinary automatic work: the whole pending set, no frozen boundary
      slots.set(kind, slot); // Reserve before any asynchronous admission or model work.
      const work = async () => {
        for (const { borrowed, ...target } of candidates) {
          if (closed || !enabled() || memory.cancellation !== generation || state.sessionId !== own.sessionId
              || state.branch !== own.branch || state.head !== own.headTurnId) return;
          try {
            const selected = borrowed ? { mode: "subagent" as const, model: modelName(kind) } : launch(kind);
            const result = await attemptPhase(context, kind, target, selected, { borrowed, automatic: true });
            // The run that detected the cache miss now has an id: link it, so status and the audit
            // name the response that downgraded this session. Its own mode stays fork.
            const runId = (result as { runId?: number }).runId;
            if (missDetected.delete(kind) && typeof runId === "number") memory.store.linkForkSuppression(target.sessionId, runId);
            if (result.outcome !== "dropped" && result.outcome !== "empty") return result;
          } catch (error) {
            context.ui.notify(String(error), "error");
            if (!(error instanceof Error && error.cause === "task admission")) return;
          }
        }
      };
      const promise = work();
      slot.result = promise;
      activity.running.set(kind, 1); showSpend(context);
      let settled: Awaited<ReturnType<typeof work>>;
      trackSlot(kind, slot, promise.then(result => { settled = result; reportProblems(result, context); }, error => {
        context.ui.notify(String(error), "error");
      }), context, () => {
        showSpend(context);
        // Only an explicit catchup may chain on an ordinary worker's release.
        if (catchup && settled?.outcome !== "failure" && settled?.outcome !== "cancelled") driveCatchup(settled?.outcome === "success");
      });
    }
    if (catchup) driveCatchup(false); // A manual drain retains its independent checkpoint.
  };
  // Ticket 68: one explicit checkpoint starts the drain and follows every successful
  // catchup-owned completion. It checks all phases; only N ignores its ordinary threshold.
  const pendingCatchupEntryIds = (c: Catchup) => c.maxEntryId === undefined ? [] :
    memory.store.pendingEntryIds(c.sessionId, c.branch, c.headTurnId).filter(id => id <= c.maxEntryId!);
  const catchupProgress = (c: Catchup) => {
    const remainingEntries = pendingCatchupEntryIds(c).length;
    return { entriesDone: c.entryTotal - remainingEntries, remainingEntries };
  };
  const catchupLine = (): string | undefined => {
    if (!catchup) return undefined;
    const c = catchup, p = catchupProgress(c);
    if (c.outcome === "completed") return `Catchup: completed (${p.entriesDone} entries noted; below-threshold knowledge may remain pending)`;
    if (c.outcome === "stopped") return `Catchup: stopped (${p.entriesDone}/${c.entryTotal} entries processed; unprocessed work stays pending; /trace catchup resumes it)`;
    if (c.outcome === "failed") return `Catchup: failed — ${c.diagnostic} (${p.entriesDone}/${c.entryTotal} entries processed)`;
    if (c.waitingPhase) return `Catchup: waiting for ${c.waitingPhase} (${p.entriesDone}/${c.entryTotal} entries)`;
    if (c.active.size) return `Catchup: running ${[...c.active].join(" + ")} (${p.entriesDone}/${c.entryTotal} entries)`;
    return `Catchup: idle (${p.entriesDone}/${c.entryTotal} entries)`;
  };
  const hasBackgroundWork = () => runningKind("noting") || runningKind("dreaming") || !!(catchup && !catchup.outcome);
  const finishCatchup = (c: Catchup) => {
    if (catchup !== c || c.outcome || c.active.size) return;
    const p = catchupProgress(c);
    if (p.remainingEntries) { c.waitingPhase = "noting"; return; }
    const own = { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId, triggerEntryId: c.triggerEntryId };
    for (const phase of ["dreaming"] as const) {
      try {
        if (memory.taskEligibility(phase, own).due) { c.waitingPhase = phase; return; }
      } catch (error) { c.outcome = "failed"; c.diagnostic = String(error); return; }
    }
    c.outcome = "completed"; c.waitingPhase = undefined;
    ctx.ui.notify(`Trace Memory: catchup completed (${p.entriesDone} entries noted; below-threshold knowledge may remain pending).`, "info");
    showSpend(ctx);
  };
  const driveCatchup = (checkAll = true, retryPhase?: WorkerPhase) => {
    const c = catchup;
    if (!c || c.stopped || c.outcome || closed || !enabled()) return;
    const context = ctx;
    const own = { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId, triggerEntryId: c.triggerEntryId };
    const remainingEntries = pendingCatchupEntryIds(c);
    if (!checkAll && !retryPhase && !remainingEntries.length && c.waitingPhase && c.waitingPhase !== "noting") {
      finishCatchup(c); // Ordinary release may have cleared all due work; settle only, never replay its busy check.
      return;
    }
    let launched = false, blockedNoting = false;
    if (checkAll) c.waitingPhase = undefined;
    const phases: readonly WorkerPhase[] = retryPhase ? [retryPhase] : checkAll ? ["noting", "dreaming"] : ["noting"];
    for (const phase of phases) {
      let due = retryPhase === phase || phase === "noting" && remainingEntries.length > 0;
      try { if (phase !== "noting" && !retryPhase) due = memory.taskEligibility(phase, own).due; }
      catch (error) { c.outcome = "failed"; c.diagnostic = String(error); context.ui.notify(String(error), "error"); return; }
      if (!due || slots.has(phase)) { if (phase === "noting" && due) blockedNoting = true; continue; }
      if (phase === "noting") {
        const foreign = memory.store.getClaim(own.sessionId, phase);
        if (foreign && foreign.expiresAt > Date.now() && foreign.executorId !== memory.executorId) {
          blockedNoting = true; continue;
        }
      }
      launched = true;
      const boundary = phase === "noting" ? { maxEntryId: c.maxEntryId } : undefined;
      const slot: Slot = { target: own, ...(boundary ? { boundary } : {}) };
      slots.set(phase, slot); c.active.add(phase); activity.running.set(phase, 1); showSpend(context);
      const promise = attemptPhase(context, phase, own, { mode: "subagent", model: modelName(phase) },
        { borrowed: false, automatic: phase !== "noting", ...(boundary ? { boundary } : {}) });
      slot.result = promise.catch(() => undefined);
      let checkpoint = false, retry = false;
      // A failed D may retain partial commits. Arm ordinary D for the next entry, but do not
      // check either phase at failure: retry this phase after its slot is released. A successful
      // completion drives the full catchup checkpoint instead of racing an ordinary check.
      let completed = false;
      const handled = promise.then(result => {
        reportProblems(result, context);
        const outcome = (result as { outcome?: string }).outcome;
        completed = outcome !== undefined && outcome !== "empty" && outcome !== "dropped";
        checkpoint = outcome === "success";
        if (c.stopped) { c.outcome = "stopped"; checkpoint = false; return; }
        const permanent = (result as { permanent?: string }).permanent;
        if (outcome === "dropped" && permanent) { c.outcome = "failed"; c.diagnostic = permanent; checkpoint = false; return; }
        if (outcome === "dropped") { if (phase === "noting") c.waitingPhase = phase; return; }
        if (outcome === "failure" || outcome === "bounced") {
          c.diagnostic = (result as { problems?: string[]; output?: unknown }).problems?.join("; ") ?? String((result as { output?: unknown }).output ?? outcome);
          if ((result as { automaticOff?: string }).automaticOff) c.outcome = "stopped";
          else retry = true;
        } else if (outcome !== "success" && outcome !== "empty") {
          c.outcome = outcome === "cancelled" ? "stopped" : "failed";
          c.diagnostic = (result as { problems?: string[]; output?: unknown }).problems?.join("; ") ?? String((result as { output?: unknown }).output ?? outcome);
          checkpoint = false;
        }
      }, error => { c.outcome = "failed"; c.diagnostic = String(error); context.ui.notify(String(error), "error"); });
      trackSlot(phase, slot, handled, context, () => {
        c.active.delete(phase); showSpend(context);
        if (catchup !== c) return; // A late completion owns no checkpoint in a replacement drain.
        if (retry) driveCatchup(false, phase); // Slot released; retry only the failed phase under the frozen boundary.
        else if (checkpoint) driveCatchup();
        else finishCatchup(c); // empty/dropped settle this opportunity but never re-arm it.
      });
    }
    if (launched || c.active.size) return;
    if (remainingEntries.length && blockedNoting) { c.waitingPhase = "noting"; return; }
    finishCatchup(c);
  };
  const startCatchup = () => {
    if (!enabled()) throw new Error("Trace Memory is Disabled; use /trace on to enable memory.");
    if (catchup && !catchup.outcome) {
      // A waiting/idle drain (nothing drain-owned active) has no in-process completion left to wake it
      // (e.g. a D admission dropped by a foreign claim). A repeated command is that recovery. A
      // running drain is only reported, never duplicated.
      if (!catchup.active.size) driveCatchup(true);
      ctx.ui.notify(catchupLine()!, "info"); return;
    }
    if (!state.sessionId || !state.head) { ctx.ui.notify("Trace Memory: no assistant reply yet; nothing to catch up.", "info"); return; }
    reconcile();
    showSpend(ctx);
    const { sessionId, branch } = state, headTurnId = state.head;
    const pendingNow = memory.store.pendingEntryIds(sessionId, branch, headTurnId);
    const maxEntryId = pendingNow.length ? Math.max(...pendingNow) : undefined;
    catchup = { sessionId, branch, headTurnId, triggerEntryId: state.sourceHead, maxEntryId, entryTotal: pendingNow.length,
      stopped: false, active: new Set() };
    driveCatchup();
    if (catchup.outcome === "completed" && !catchup.entryTotal) {
      ctx.ui.notify("Trace Memory: catchup found nothing pending; already caught up.", "info"); return;
    }
    ctx.ui.notify(catchupLine()!, "info");
  };
  const stopCatchup = () => {
    const active = hasBackgroundWork();
    if (catchup && !catchup.outcome) { catchup.stopped = true; if (!catchup.active.size) catchup.outcome = "stopped"; }
    memory.cancelTasks(); // Not the `stopping` form: future ordinary/explicit admission for this executor remains possible.
    showSpend(ctx);
    ctx.ui.notify(active ? "Trace Memory: stop requested. This executor's background work is being cancelled; future automatic triggers remain enabled."
      : "Trace Memory: nothing to stop.", "info");
  };
  pi.on("session_before_tree", async (_event, context) => {
    ensure(context); if (!enabled()) return; flush(true);
    const { sessionId, branch, head } = state;
    if (!sessionId || !head) return { summary: { summary: "" } };
    return { summary: { summary: memory.branchSummary(sessionId, branch, head) } };
  });
  // The custom replacement represents every pending entry itself, so it asks Pi to keep no original
  // entry beside it: an empty `firstKeptEntryId` makes `buildContextEntries` (session-manager.ts:410)
  // find no first-kept entry, and the post-compaction context is the compaction plus what follows it.
  // 28a item 5 reads the retained set off exactly this value, so the two can never disagree — with
  // nothing kept, refill (b) excludes nothing but the pending entries it already excludes.
  const KEPT_AFTER_CUSTOM_COMPACTION = "";
  /** Raw, fact and knowledge identities actually retained from `first` onwards in Pi's
   * compaction-aware context, including recognized identity-bound carriers. */
  const retainedView = (context: ExtensionContext, first: string): VisibleView => {
    if (!first) return visibleView([], binding());
    const entries = context.sessionManager.buildContextEntries() as ContextEntry[];
    const at = entries.findIndex(entry => entry.id === first);
    return visibleView(at < 0 ? [] : entries.slice(at), binding());
  };
  const PHASE_LABEL = { noting: "Noting", dreaming: "Dreamer" } as const;
  // Ticket 73 "Shared allowance": core allocates once and never falls back — compact truncates
  // unprocessed material instead of asking for recovery or native delegation. This handler freezes the
  // path, allocates, and either publishes the replacement or (a host-caught error only) delegates.
  //
  // Cancellation is Pi's own. `event.signal` is the compaction abort controller behind Esc and
  // `session.abortCompaction()`. The compaction launches no task, so the signal is only checked here:
  // a cancelled compaction returns `{cancel: true}`, which is how Pi ends a compaction as aborted
  // instead of running its own.
  pi.on("session_before_compact", async (event, context) => {
    publishedTruncation = undefined;
    ensure(context); if (!enabled()) return; flush();
    const signal = (event as { signal?: AbortSignal }).signal;
    const initial = { sessionId: state.sessionId, branch: state.branch, head: state.head, projectId: state.projectId };
    const valid = () => !closed && enabled() && state.sessionId === initial.sessionId
      && state.branch === initial.branch && state.head === initial.head && state.projectId === initial.projectId
      && (!initial.sessionId || memory.store.getSession(initial.sessionId)?.projectId === initial.projectId);
    const allocate = (knowledge = true): ReturnType<typeof memory.compact> => {
      try {
        if (!valid()) return { native: true, reason: "memory enrollment or the selected path changed" };
        if (state.sessionId) return memory.store.transaction(() => {
          if (!valid()) return { native: true as const, reason: "memory enrollment, project or the selected path changed" };
          return memory.compact(state.sessionId!, state.branch, state.head, retainedView(context, KEPT_AFTER_CUSTOM_COMPACTION), false, { knowledge });
        });
        if (!knowledge) return { text: "", supplied: { entries: [], factIds: [], knowledgeCommitIds: [] } };
        const block = memory.injection({ projectId: state.projectId });
        return { text: block.text, composition: block.composition, supplied: { entries: [], factIds: [], knowledgeCommitIds: block.knowledgeCommitIds,
          knowledgeTokens: block.knowledgeTokens, knowledgeStates: block.knowledgeStates } };
      } catch (error) { return { native: true, reason: String(error) }; } // an unexpected store error is a reason to delegate, never oversized material
    };
    const path = state.sessionId && state.head ? { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head } : undefined;
    // 28 "Failure and persistence": user cancellation cancels this operation's own work — the signal
    // did that through core — publishes nothing and starts no native fallback. Committed progress
    // stays committed; a cancelled compaction appends no entry, so no carrier and no baseline moves.
    if (signal?.aborted) {
      context.ui.notify("Trace Memory: compaction was cancelled; no native compaction was started.", "info");
      return { cancel: true };
    }
    if (closed) return { cancel: true };
    let result = allocate();
    if (signal?.aborted || closed) return { cancel: true };
    context.ui.notify(`Trace Memory: compaction preparing ${"native" in result ? `native delegation — ${result.reason}` : "bounded entry views"}.`, "info");
    // Notification callbacks may themselves cancel or change the binding. No await or callback
    // separates this final coherent reprice from constructing the exact publication carrier.
    if (signal?.aborted || closed) return { cancel: true };
    result = allocate();
    if (signal?.aborted || closed) return { cancel: true };
    if ("native" in result) return;
    // 29a "Receipt and content are one carrier": the identities this replacement supplies ride on the
    // compaction entry Pi appends for it, so a cancelled or failed attempt — which appends no entry —
    // leaves the earlier baseline untouched, and a native delegation carries no `traceMemory` at all.
    // 73 "Truncation is announced in the foreground": the warning describes exactly this carrier, and is
    // given once Pi has appended it (\`session_compact\` below). No callback runs between the final
    // reprice above and this return, and a compaction Pi does not append warns about nothing.
    // 97 "Record at emission", in Claude Code's order: the supplement is recorded before it is
    // published, as the compaction node's delivery once Pi appends the compaction (a compaction Pi
    // never appends leaves the key unbound, and so on no path). What cannot be recorded, including
    // anything before a memory session exists, is published without its Knowledge body.
    let prompt: string | undefined;
    if (state.sessionId) try {
      prompt = randomUUID();
      memory.store.recordKnowledgeDelivery({ owner: owner(), nodeKey: prompt }, [deliveryPart({ ...result.supplied, text: result.text })]);
    } catch (error) {
      prompt = undefined;
      context.ui.notify(`Trace Memory: compaction Knowledge was not recorded and is left out: ${String(error)}`, "warning");
    }
    if (!prompt) {
      if (signal?.aborted || closed) return { cancel: true };
      result = allocate(false);
      if (signal?.aborted || closed) return { cancel: true };
      if ("native" in result || !result.text) return;
    }
    publishedTruncation = result.truncated;
    return { compaction: { summary: result.text, firstKeptEntryId: KEPT_AFTER_CUSTOM_COMPACTION, tokensBefore: event.preparation.tokensBefore, details: { traceMemory: { ...carrier(result.supplied, prompt).traceMemory, composition: result.composition } } } };
  });
  pi.on("session_compact", (_event, context) => {
    // Pi 0.85.1 finds its event entry by the first equal summary. Read the actual appended
    // compaction on the selected ancestry instead: equal text is never carrier identity.
    const entry = context.sessionManager.getBranch().filter(entry => entry.type === "compaction").at(-1);
    if (!entry || entry.type !== "compaction") return;
    const own = (entry.details as { traceMemory?: VisibleBinding & { prompt?: unknown } } | undefined)?.traceMemory;
    const custom = own?.db === dbPath && own.pi === state.piId && own.session === (state.sessionId ?? null);
    lastCompaction = custom ? "bounded entry views" : "native delegation — saved without Trace Memory material coverage";
    const omitted = custom ? publishedTruncation : undefined;
    publishedTruncation = undefined;
    if (omitted) {
      const { raw, facts } = omitted;
      // 79 item 4 (ruled): Raw is an exact count only, never a token figure -- rendering every omitted
      // entry to size it would read the whole omitted backlog on every compaction. Facts keep both.
      const parts = [
        ...(raw ? [`${raw.entries} pending Raw ${raw.entries === 1 ? "entry" : "entries"}`] : []),
        ...(facts ? [`${facts.count} ${facts.count === 1 ? "fact" : "facts"} (${facts.tokens} tokens)`] : []),
      ];
      context.ui.notify(`Trace Memory: compaction omitted ${parts.join(" and ")}${raw ? "; omitted Raw remains pending for Noting." : "."}`, "warning");
    }
    if (enabled() && state.sessionId) {
      const sessionId = state.sessionId;
      const key = custom && typeof own.prompt === "string" && own.prompt ? own.prompt : undefined;
      const turn = memory.store.transaction(() => {
        const turn = memory.store.appendTurn({ sessionId, parentTurnId: state.head, kind: "compaction", assistantText: entry.summary, startedAt: now(), endedAt: now() });
        // 97: the compaction is a node on every later path. It starts from its own supplement; a
        // compaction without ours (native) starts from nothing.
        memory.store.bindNativeTurn(sessionId, reconciled?.lineage ?? state.originPiId ?? state.piId, entry.id, turn.id, "compaction");
        if (key) memory.store.bindDeliveryNode(key, sessionId, turn.id);
        return turn;
      });
      state.head = turn.id;
      if (reconciled) reconciled.head = turn.id;
      save();
    }
    context.ui.notify(`Trace Memory: compaction used ${lastCompaction}.`, "info");
  });
  pi.on("session_compact_failed", (event, context) => {
    // An unsuccessful attempt does not replace the last successfully saved result.
    context.ui.notify(event.aborted ? "Trace Memory: compaction was cancelled; no completed replacement."
      : `Trace Memory: compaction failed. ${event.errorMessage ?? "No completed replacement."}`, event.aborted ? "info" : "warning");
  });
  // Pi tears the extension runtime down and re-runs the factory for every reason, including
  // session replacement (new, resume, fork); this instance never serves the next session.
  pi.on("session_shutdown", async () => {
    if (closed) return;
    closed = true;
    const report = (error: unknown) => { try { ctx?.ui.notify(`Trace Memory cleanup failed: ${String(error)}`, "error"); } catch { /* reporting cannot block exit */ } };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, 5_000); });
    try {
      try { memory.cancelTasks(true); if (catchup && !catchup.outcome) { catchup.stopped = true; catchup.outcome = "stopped"; } } catch (error) { report(error); }
      try { if (state) flush(true); } catch (error) { report(error); }
      await Promise.race([Promise.allSettled([...pending]), deadline]);
      memory.forceTasks(); // Close bindings and end only local waits, retaining partial audit.
      await Promise.allSettled([...pending]);
      try { if (state?.sessionId) memory.store.closeSession(state.sessionId); } catch (error) { report(error); }
    } finally {
      clearTimeout(timer);
      unsubscribeCurrentContextSnapshot();
      try { memory.close(); } catch (error) { report(error); }
    }
  });
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  // 101: `read` and `grep` of the same names serve /tm/ from Trace Memory, read-only, for this session's
  // reader, and hand every other path to Pi's own tool unchanged. Edits and writes under /tm/ are refused.
  const files = () => memoryFiles(memory, state.sessionId ? { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head ?? null,
    projectId: state.projectId } : { projectId: state.projectId });
  const listed = (listing: { lines: string[]; cut?: string }) => listing.lines.length ? [...listing.lines, ...(listing.cut ? [listing.cut] : [])].join("\n") : "No matches found";
  // Same settings source Pi's own agent session builds its read tool from (`_buildRuntime` reads
  // `settingsManager.getImageAutoResize()`), so a delegated `/tm`-external read resizes images exactly
  // as Pi's own read would.
  const autoResizeImages = SettingsManager.create(process.cwd(), agentDir).getImageAutoResize();
  const builtinRead = createReadToolDefinition(process.cwd(), { autoResizeImages }), builtinGrep = createGrepToolDefinition(process.cwd());
  const memoryTools = new Map([["read", `${builtinRead.description} Paths under /tm/ are Trace Memory, read-only; read /tm for its layout.`],
    ["grep", `${builtinGrep.description} Under /tm/ (Trace Memory, read-only) it lists matching files by default and searches Raw entries in full.`]]);
  pi.registerTool({ ...builtinRead, description: memoryTools.get("read")!,
    async execute(id: string, params: ReadToolInput, signal: AbortSignal | undefined, update: never, context: ExtensionContext) {
      const path = memoryPath(params.path);
      if (path === null) return builtinRead.execute(id, params, signal, update, context);
      ensure(context);
      const page = files().read(path, params.offset, params.limit);
      return result([...page.lines, ...(page.cut ? [page.cut] : [])].join("\n"));
    } } as ToolDefinition);
  const grepMode = { type: "string", enum: ["files_with_matches", "content", "count"],
    description: "Only under /tm/: files_with_matches (default) lists matching files; content shows path:line:text; count shows matches per file." };
  pi.registerTool({ ...builtinGrep,
    description: memoryTools.get("grep")!,
    // A plain JSON schema, as the memory tools use: Pi's own schema plus the two /tm/-only fields.
    parameters: ((schema: { properties: Record<string, unknown> }) => ({ ...schema, properties: { ...schema.properties, output_mode: grepMode,
      offset: { type: "number", description: "Only under /tm/: output lines to skip, to continue a cut result." } } }))(JSON.parse(JSON.stringify(builtinGrep.parameters))),
    async execute(id: string, raw: GrepToolInput & { output_mode?: MemoryGrepMode; offset?: number }, signal: AbortSignal | undefined, update: never, context: ExtensionContext) {
      const { output_mode: mode, offset, ...params } = raw;
      const path = memoryPath(params.path);
      if (path === null) return builtinGrep.execute(id, params, signal, update, context);
      ensure(context);
      return result(listed(files().grep(params.pattern, path, { mode, ignoreCase: params.ignoreCase, literal: params.literal,
        before: params.context, after: params.context, glob: params.glob, limit: params.limit, offset })));
    } } as unknown as ToolDefinition);
  pi.on("tool_call", event => {
    if ((event.toolName === "edit" || event.toolName === "write") && memoryPath((event.input as { path?: unknown }).path) !== null)
      return { block: true, reason: MEMORY_READ_ONLY };
  });
  // The main agent registers the façade metadata (same name, description, schema the runs send)
  // wrapped with an executor bound to the current session and turn.
  const definitions = toolDefinitions.map(definition => ({ ...definition, label: definition.name,
    async execute(_id: string, raw: unknown, _signal: unknown, _update: unknown, context: ExtensionContext) {
      ensure(context); reconcile();
      const bound = state.sessionId && current?.id ? memory.tools({ kind: "manual", sessionId: state.sessionId, branch: state.branch, currentTurnId: current.id, triggerEntryId: state.sourceHead }) : null;
      if (definition.name === "trace" || definition.name === "search") {
        const input = validateReadInput(definition.name, raw);
        if (bound) return result(bound.find(t => t.name === definition.name)!.execute(input));
        const options = { ...input, modelFacing: true, sessionId: state.sessionId, headTurnId: state.head, branch: state.branch };
        return result(definition.name === "trace" ? memory.trace(input.address as string, options)
          : memory.search((input.queries ?? input.query) as string | string[], input.layer as import("../../core/api/index.ts").SearchScope, options));
      }
      if (!enabled()) throw new Error("Trace Memory is Disabled; use /trace on to enable memory.");
      if (!state.sessionId || !current?.id) throw new Error("A tool call requires an assistant reply and current turn");
      const content = bound!.find(t => t.name === definition.name)!.execute(raw);
      if (toolRejected(definition.name, content)) throw new Error(content);
      return result(content);
    } }) as unknown as ToolDefinition);
  for (const definition of definitions) pi.registerTool(definition);
  const toggle = (value: boolean) => {
    if (state.sessionId) memory.store.setEnrollment(state.sessionId, value);
    else { state.enrollment = { ...enrollment(), choice: value }; persistProvisional(state.enrollment, true); }
    // Disable ends a manual catchup the same way it cancels any other owned in-flight work (18b lifecycle).
    if (!value) { memory.cancelTasks(); if (catchup && !catchup.outcome) { catchup.stopped = true; if (!catchup.active.size) catchup.outcome = "stopped"; } }
    // Enrollment changes immediately. The next ordinary prompt recomputes delivery from its retained
    // carriers; enabling creates no generation or one-shot intent.
    save();
    reconciledLeaf = undefined; reconciled = undefined; // 22b: the enrollment switch reconciles from the start too
    if (value) { reconcile(); save(); }
    showSpend(ctx);
    const { lines, recovery, cost, composition, shared } = sessionSummary();
    const notice = statusBody([...recovery, ...lines, cost, ...composition, ...shared], Math.max(1, (process.stdout.columns ?? 100) - 2));
    ctx.ui.notify(`${notice}\n${value ? "Available history, including the paused interval, is queued; ordinary completions check thresholds." : "Processing and future injection are paused. Stored memory and already-injected text remain."}`, "info");
  };
  // ---- 24b: the command surface ----
  // `enable`, `disable`, `status` and `runs` are retired — status and runs live in the menu's
  // Current session. Project assignment, catchup and stop retain headless command forms.
  const commands = "/trace (menu; status when headless) | /trace on | /trace off | /trace catchup | /trace stop | " +
    "/trace project <name>";
  const retiredForms: Record<string, string> = {
    enable: "/trace on", disable: "/trace off",
    status: "the menu's Current session (headless: bare /trace)", runs: "the menu's Current session > Runs",
  };
  const runView = (limit = 10) => {
    const runs = state.sessionId ? memory.store.listRuns(state.sessionId).slice(-limit).reverse() : [];
    ctx.ui.notify(runs.length ? runs.map(r => memory.trace(`R${r.id}`).split("\n")[0]!).join("\n") : "Trace Memory: no runs yet.", "info");
  };
  /** Project assignment, shared by the command form and the menu. Unchanged rules: an allocated
   * session and an explicit name; the menu selection replaces the old command only as the way the
   * intent is expressed, never the project-sharing rules themselves. */
  const assignProject = (name: string) => {
    if (!state.sessionId) throw new Error("A session requires an assistant reply");
    const marked = memory.declareProject(state.sessionId, name, "mark", {
      sessionId: state.sessionId, branch: state.branch, headTurnId: state.head ?? null,
    });
    state.projectId = memory.store.getSession(state.sessionId)!.projectId;
    state.project = memory.store.getProject(state.projectId)!.name;
    // Project attribution changes immediately; the next ordinary prompt evaluates the same delivery
    // predicate against the newly applicable graph. No command-generation state is consumed.
    save();
    ctx.ui.notify(marked, "info");
  };
  // 24b's preference descriptions live in hosts/pi/settings.ts; only the foreground model is this
  // session's own, so a fork-mode line can name the model that child would inherit.
  const foregroundModel = () => ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "the session model";
  /** Pi's own registry decides which models exist and which have resolved auth; nothing here asks for
   * a credential or calls a model to validate a choice. The foreground model is always offered: it is
   * demonstrably usable in this session even when a registry snapshot is empty. */
  const availableModels = (): string[] => {
    const registry = ctx.modelRegistry as unknown as { getAvailable?: () => { provider: string; id: string }[]; getAll?: () => { provider: string; id: string }[] };
    let listed: { provider: string; id: string }[] = [];
    try { listed = (typeof registry.getAvailable === "function" ? registry.getAvailable() : typeof registry.getAll === "function" ? registry.getAll() : []) ?? []; }
    catch { listed = []; }
    const names = new Set(listed.map(model => `${model.provider}/${model.id}`));
    if (ctx.model) names.add(`${ctx.model.provider}/${ctx.model.id}`);
    return [...names].sort();
  };
  const settingsFile = join(agentDir, "settings.json");
  /** Application, in this instance, without a reload: the settings layers are re-read exactly as
   * `restore` reads them (so precedence, masking and validation are the load path's), the host's own
   * model selection follows `flat`, and core's mode booleans and borrowing scope are replaced through
   * `configure`. Tasks admitted from now on use the new values; running tasks retain their scope,
   * mode, model, evidence and budgets. Nothing here dispatches a
   * worker, touches the cache-miss latch or reopens the database. */
  const applySettings = () => {
    const loaded = configuration(ctx.cwd, environment, agentDir);
    if (loaded.flat.dbPath !== flat.dbPath) throw new Error("dbPath changed; reload the extension to reopen the database");
    ({ flat, core, sources, layers } = loaded);
    // The merged, validated layers decide: a project or environment override still wins, and core is
    // told the value that is actually effective — never the global one an override masks.
    const effective = validateConfig(core);
    memory.configure({ closedSessionScope: effective.closedSessionScope, noting: { forkModeDefault: effective.noting.forkModeDefault } });
  };
  const saveGlobal = (p: Preference, value: string | boolean) => {
    let replaced: string | undefined;
    try { replaced = writeGlobal(settingsFile, p.key, value); }
    catch (error) { ctx.ui.notify(`Trace Memory: ${p.name} unchanged — ${String(error)}`, "error"); return; }
    try { applySettings(); }
    catch (error) { ctx.ui.notify(`Trace Memory: ${p.key} was saved in ${settingsFile}, but the settings could not be reloaded: ${String(error)}`, "error"); return; }
    const source = sources[p.key] ?? "Global";
    // Never claim a masked edit changed the effective behaviour: the override stays, and it is named.
    const override = source === "Global" ? "" :
      ` A ${source} setting takes precedence, so the effective ${p.name} stays ${shownValue(p, preferenceValue(flat, p))} (${source}); it was not removed.`;
    ctx.ui.notify(`Trace Memory: saved ${p.key} = ${JSON.stringify(value)} (${shownValue(p, value)}) in ${settingsFile}.` +
      (replaced ? ` The legacy spelling ${replaced} of the same preference was replaced by ${p.key}.` : "") + override +
      (p.kind === "scope" ? " It applies to memory tasks admitted from now on; running tasks keep their admission scope. Use Stop to end running work."
        : p.kind === "thinking" ? " It applies to memory tasks admitted from now on; running tasks keep the thinking level they were frozen with."
        : " It applies to memory tasks admitted from now on; running tasks keep the mode and model they started with."), "info");
  };
  const editPreference = async (p: Preference) => {
    if (p.kind === "scope") {
      const choice = await ctx.ui.select("Closed-session scope — off: keep tails pending; project: same-project executors; global: any executor. New tasks only; Stop ends running work.", ["off", "project", "global"]);
      if (choice === undefined) return;
      saveGlobal(p, choice);
      return;
    }
    if (p.kind === "mode") {
      const choice = await ctx.ui.select(`${p.name} — applies to tasks admitted from now on; running tasks keep their mode`,
        ["fork", "subagent"]);
      if (choice === undefined) return; // cancelled: nothing written, nothing requested
      saveGlobal(p, choice === "fork");
      return;
    }
    // 26d: the level this phase's subagent runs think at. `inherit` is 26b's rule — the foreground
    // level frozen at admission. A fork keeps inheriting either way, so a configured level reaches a
    // fork task only through its fallback child. Pi clamps a level the worker model cannot do.
    if (p.kind === "thinking") {
      const choice = await ctx.ui.select(`${p.name} — inherit: the foreground level frozen at admission; otherwise this phase's subagent runs think at the chosen level` +
        (configuredMode(flat, p.phase) === "fork" ? `, and Noting is configured for fork mode, whose child keeps inheriting the foreground level` : "") +
        ". Applies to tasks admitted from now on; running tasks keep their level.", thinkingChoices);
      if (choice === undefined) return;
      saveGlobal(p, choice);
      return;
    }
    const follow = "Follow foreground";
    const models = availableModels();
    if (!models.length) { ctx.ui.notify(`Trace Memory: ${p.name} unchanged — Pi's model registry lists no available model.`, "warning"); return; }
    const title = configuredMode(flat, p.phase) === "fork"
      ? `${p.name} — Noting is configured for fork mode, which inherits the foreground model ${foregroundModel()}; this choice is used by subagent runs`
      : `${p.name} — used by this phase's subagent runs`;
    const choice = await ctx.ui.select(title, [follow, ...models]);
    if (choice === undefined) return;
    if (choice !== follow) {
      const slash = choice.indexOf("/");
      // Validated against the registry, never by calling the model. An entry that vanished between
      // listing and choosing is refused rather than saved as a model no run could resolve.
      if (slash < 0 || !ctx.modelRegistry.find(choice.slice(0, slash), choice.slice(slash + 1))) {
        ctx.ui.notify(`Trace Memory: ${p.name} unchanged — ${choice} is not an available provider/model in Pi's registry.`, "warning"); return;
      }
    }
    // Selecting a model never switches the mode: only `${p.key}` is written.
    saveGlobal(p, choice === follow ? "session" : choice);
  };
  const settingsInput = (): SettingsInput => {
    const worker = (phase: "Noter" | "Dreamer", key: "noting" | "dreaming") => {
      const pref = (kind: Preference["kind"]) => preferences.find(p => p.phase === key && p.kind === kind);
      const model = pref("model")!, thinking = pref("thinking")!, mode = pref("mode");
      const effective = (p: Preference) => shownValue(p, preferenceValue(flat, p));
      const source = (p: Preference) => sources[p.key] && sources[p.key] !== "Global" ? `${sources[p.key]} setting — this edit will not take effect` : undefined;
      return { phase, ...(mode ? { mode: effective(mode) } : {}), model: effective(model), thinking: effective(thinking),
        sources: { mode: mode && source(mode) || undefined, model: source(model), thinking: source(thinking) } };
    };
    return { database: dbPath, budgets: { ...memory.knowledgeBudgets(), sharedAllowanceTokens: memory.config.compaction.sharedAllowanceTokens },
      workers: [worker("Noter", "noting"), worker("Dreamer", "dreaming")],
      closedSessionScope: memory.config.closedSessionScope,
      closedSessionSource: sources.closedSessionScope && sources.closedSessionScope !== "Global"
        ? `${sources.closedSessionScope} setting — this edit will not take effect` : undefined };
  };
  const settingsMenu = async () => {
    const input = settingsInput();
    const rows = buildSettingsChoices(input);
    const choice = ctx.mode === "tui" ? await showSessionPanel(ctx,
      (width, paint) => renderTraceSettings(input, width, paint).join("\n"), rows.map(row => row.label))
      : await ctx.ui.select(renderTraceSettings(input, Math.max(1, (process.stdout.columns ?? 100) - 2)).join("\n"), rows.map(row => row.label));
    if (choice === undefined) return;
    const selected = rows.find(row => row.label === choice);
    if (!selected) throw new Error(`Unknown settings row: ${choice}`);
    const field = selected.id.startsWith("budget.") ? selected.id.slice(7) as "global" | "project" | "session" : undefined;
    const budget = field ? { field, name: `${field[0]!.toUpperCase()}${field.slice(1)} Knowledge budget` } : undefined;
    if (budget) {
      const input = await ctx.ui.input(`${budget.name} — enter tokens; changing this database policy does not run maintenance`);
      if (input === undefined) return;
      try {
        const value = parseKnowledgeBudgetInput(input, budget.name);
        const saved = memory.setKnowledgeBudget(budget.field, value);
        const base = saved.policy.global + saved.policy.project + saved.policy.session;
        const shared = memory.config.compaction.sharedAllowanceTokens;
        ctx.ui.notify(saved.changed
          ? `Trace Memory: saved ${budget.name} = ${value} tokens in database ${dbPath}. Knowledge base window ${base}; shared material allowance ${shared}; maximum Knowledge input ${base + shared}. New admissions use these capacities; running inputs remain frozen.`
          : `Trace Memory: ${budget.name} is already ${value} tokens in database ${dbPath}; nothing was written.`, "info");
      } catch (error) { ctx.ui.notify(`Trace Memory: ${budget.name} unchanged — ${String(error)}`, "error"); }
      return;
    }
    const [phase, kind] = selected.id.split(".");
    const preference = selected.id === "closedSessionScope" ? preferences.find(p => p.kind === "scope")
      : preferences.find(p => p.phase === phase && p.kind === kind);
    if (!preference) throw new Error(`Unknown settings preference: ${selected.id}`);
    await editPreference(preference);
  };
  // Shared wording only: enrollment confirmations must not census context or render pending material.
  const sessionSummary = (compact = false) => {
    const lines: string[] = [], recovery: string[] = [];
    const e = enrollment();
    lines.push(compact ? `${state.sessionId ? `S${state.sessionId}` : "Session: No session"} | ${enabled() ? "On" : "Off"}(${e.choice === null ? "default" : "explicit"})`
      : `Session: ${state.sessionId ? `S${state.sessionId}` : "None (no assistant reply)"}`);
    if (!compact) lines.push(`Enrollment: ${enabled() ? "Enabled" : "Disabled"} (${e.choice === null ? "default" : "explicit choice"})`);
    try {
      const s = state.sessionId ? memory.store.getSession(state.sessionId) : null;
      lines.push(`Project: ${s ? `${memory.store.getProject(s.projectId)!.name} (${memory.store.projectDeclaration(s.id)})` : state.project ?? "Unassigned"}`);
      if (s && !enabled()) for (const task of memory.store.taskFailures(s.id).filter(t => t.count >= 3))
        recovery.push(`Automatic off: ${task.phase}, ${task.pool ? `pool ${task.pool}` : `backlog head ${task.head}`}, ${task.count} failures; last R${task.lastRunId}: ${task.lastReason}. Use /trace on to resume.`);
    } catch { recovery.push("Project / recovery: Unknown (unavailable)"); }
    let cost: string; const composition: string[] = [];
    try {
      if (!state.sessionId) cost = "Cost: N/A (no session)";
      else {
        const totals = memory.spend(state.sessionId);
        cost = `Cost: $${totals.cost.toFixed(4)}`;
        // 51: the session's cumulative spend by phase, two short lines under the total; the footer
        // shows today's database-wide figure instead, so neither repeats the other.
        const phase = (kind: "noting" | "consolidation" | "dreaming" | "manual", label: string) => `${label} ${totals.runs[kind]} runs $${totals.costs[kind].toFixed(4)}`;
        composition.push(`  ${phase("noting", "Noting")} · ${phase("consolidation", "Consolidation")}`,
          `  ${phase("dreaming", "Dreaming")} · ${phase("manual", "Manual")}`);
      }
    } catch { cost = "Cost: Unknown (unavailable)"; }
    if (compact) lines[0] += ` | ${cost.replace(/^Cost: /, "")}`;
    const downgrade = suppressed();
    if (downgrade) recovery.push(`Fork: suppressed since ${downgrade.at} (cache miss${downgrade.runId ? ` on R${downgrade.runId}` : ""}); Retry fork in the /trace menu`);
    if (lastCompaction) recovery.push(`Compaction: ${lastCompaction}`);
    const catchupStatus = catchupLine();
    if (catchupStatus) recovery.push(catchupStatus);
    const shared = compact ? (state.shared ? ["Shared identity"] : [])
      : [state.shared ? "Shared identity: this switch also affects forks or clones carrying this memory identity."
        : "Forks or clones carrying this memory identity share this switch."];
    return { lines, recovery, cost, composition, shared };
  };
  // The panel reads one snapshot. It never reconciles, admits work or mutates a setting.
  const menuInput = (): TraceMenuInput => {
    const composition = contextComposition(ctx, pi);
    const e = enrollment();
    const target = state.sessionId && state.head ? { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head } : undefined;
    const noting = memory.pendingTokens("noting", target, true);
    const dreaming = memory.dreamingPending(target);
    const totals = state.sessionId ? memory.spend(state.sessionId) : undefined;
    const notices: string[] = [];
    if (state.sessionId && !enabled()) for (const task of memory.store.taskFailures(state.sessionId).filter(t => t.count >= 3))
      notices.push(`Automatic off: ${task.phase} failed ${task.count} times (R${task.lastRunId}: ${task.lastReason}). Turn on to resume.`);
    const downgrade = suppressed();
    if (downgrade) notices.push(`Fork suppressed since ${downgrade.at}${downgrade.runId ? ` (R${downgrade.runId})` : ""}.`);
    if (lastCompaction) notices.push(`Compaction: ${lastCompaction}`);
    const catchup = catchupLine();
    if (catchup) notices.push(catchup);
    if (state.shared) notices.push("Shared identity");
    return {
      header: { session: state.sessionId ? `S${state.sessionId}` : "No session",
        project: state.sessionId ? memory.store.getProject(memory.store.getSession(state.sessionId)!.projectId)!.name : state.project ?? "Unassigned",
        enabled: enabled(), explicit: e.choice !== null },
      context: { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "Model unavailable",
        ...(composition.sdkTokens !== undefined && composition.window !== undefined ? { sdk: { tokens: composition.sdkTokens, window: composition.window } } : {}),
        categories: [
          ...(["System", "Tools", "Skills"] as const).map(name => ({ name, tokens: composition.amounts[name] })),
          ...(["Knowledge", "Facts", "Raw"] as const).map(name => ({ name, tokens: composition.memory[name] })),
          { name: "Unclassified" as const, tokens: composition.memory.Unclassified },
          ...(["Conversation", "Other"] as const).map(name => ({ name, tokens: composition.amounts[name] })),
        ], complete: composition.complete },
      pending: { noting: { tokens: noting.tokens, trigger: noting.trigger, ...(noting.state === "known" && noting.atLeast ? { atLeast: true, entries: noting.entries } : {}) },
        dreaming: { pending: dreaming.pending ?? { tokens: null, trigger: memory.config.dreaming.triggerTokens },
          knowledge: dreaming.knowledge ? { tokens: dreaming.knowledge.tokens, trigger: dreaming.knowledge.window } : { tokens: null, trigger: null } } },
      spend: { session: totals?.cost ?? 0,
        noting: { runs: totals?.runs.noting ?? 0, cost: totals?.costs.noting ?? 0 },
        consolidation: { runs: totals?.runs.consolidation ?? 0, cost: totals?.costs.consolidation ?? 0 },
        dreaming: { runs: totals?.runs.dreaming ?? 0, cost: totals?.costs.dreaming ?? 0 }, today: memory.spendSince(localMidnight()) },
      notices, actions: { enabled: enabled(), retryForkAvailable: !!downgrade },
    };
  };
  const sessionMenu = async () => {
    const input = menuInput();
    const actions = buildActions(input.actions);
    const choice = ctx.mode === "tui" ? await showSessionPanel(ctx,
      (width, paint) => renderTraceMenu(input, width, paint).slice(0, -1).join("\n"), actions)
      : await ctx.ui.select(renderTraceMenu(input, Math.max(1, (process.stdout.columns ?? 100) - 2)).join("\n"), actions);
    if (choice === undefined) return; // cancellation is inert: no write, no request
    if (choice === "Retry fork") {
      memory.store.clearForkSuppression(state.sessionId!);
      cacheMisses.delete(state.sessionId!);
      showSpend(ctx);
      ctx.ui.notify("Trace Memory: fork retry enabled for this session. The next memory task may request fork again; no task was started and global settings are unchanged.", "info");
      return;
    }
    if (choice === "Runs…") {
      const count = await ctx.ui.input(MENU_INPUTS.runs, "10");
      if (count !== undefined) {
        try { runView(parseRunsCount(count)); }
        catch (error) { ctx.ui.notify(`Trace Memory: ${String(error)}`, "error"); }
      }
      return;
    }
    if (choice === "Project…") {
      if (!state.sessionId) { ctx.ui.notify("Trace Memory: a project assignment requires an assistant reply.", "warning"); return; }
      const name = await ctx.ui.input(MENU_INPUTS.project, state.project ?? "");
      if (name === undefined) return;
      if (!String(name).trim()) { ctx.ui.notify("Trace Memory: no project name given; nothing changed.", "warning"); return; }
      try { assignProject(String(name).trim()); } catch (error) { ctx.ui.notify(String(error), "error"); }
      return;
    }
    if (choice === "Settings…") { await settingsMenu(); return; }
    if (choice === "Catch up") { try { startCatchup(); } catch (error) { ctx.ui.notify(String(error), "error"); } return; }
    if (choice === "Stop") { stopCatchup(); return; }
    if (choice === "Turn on" || choice === "Turn off") {
      const on = choice === "Turn on";
      const confirmation = toggleConfirmation(on, !!state.shared);
      if (await ctx.ui.confirm(confirmation.title, confirmation.message)) toggle(on);
    }
  };
  pi.registerCommand("trace", { description: "Trace Memory: menu, session participation (on/off), catchup/stop and project assignment.",
    async handler(args, context) {
      ensure(context);
      const parts = args.trim() ? args.trim().split(/\s+/) : [];
      // Bare `/trace` opens the menu; without dialog-capable UI (`-p`, rpc scripting) it prints the
      // status the menu would have shown and the forms that replace the retired subcommands.
      if (!parts.length) { if (context.hasUI) await sessionMenu(); else context.ui.notify(`${renderTraceMenu(menuInput(), Math.max(1, (process.stdout.columns ?? 100) - 2)).join("\n")}\n${commands}`, "info"); return; }
      const [verb, ...rest] = parts;
      if ((verb === "on" || verb === "off") && !rest.length) { toggle(verb === "on"); return; }
      if (verb === "catchup" && !rest.length) { startCatchup(); return; }
      if (verb === "stop" && !rest.length) { stopCatchup(); return; }
      if (verb === "project" && rest.length) { assignProject(rest.join(" ")); return; }
      // A retired subcommand and a malformed argument end in the same place: the usage, and no
      // mutation. Retirement is documented rather than aliased — the old spelling does nothing.
      const retired = retiredForms[verb!];
      context.ui.notify(`Trace Memory: /trace ${parts.join(" ")} is not a command form.` +
        (retired ? ` \`${verb}\` was retired; use ${retired}.` : "") + `\n${commands}\nNothing was changed.`, "warning");
    } });
}
