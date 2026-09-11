import { existsSync, mkdirSync, readFileSync, writeFileSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { hash, snapshot, type Body } from "./fork.ts";
import { contextComposition } from "./context-composition.ts";
import { compositionMap, pendingBar, statusBody } from "./session-status.ts";
import { showSessionPanel, type SessionBody } from "./session-panel.ts";
import { checkpointReadiness } from "./native.ts";
import { agentDirectory, configuration, configuredMode, preferenceLine, preferenceValue, preferences, shownValue, tag, thinkingChoices, writeGlobal, type Preference } from "./settings.ts";
import { runWorker, type ForkLaunch, type ForkRefusal, type WorkerModel } from "./worker.ts";
import { TraceMemory, enrollmentDefault, validateConfig, validateReadInput, toolDefinitions, toolRejected, visibleView, CANCELLED_BEFORE_FALLBACK, CONSOLIDATION_CAPACITY, NOTING_CAPACITY, type ConsolidateResult, type ContextEntry, type NotingAgentInput, type NotingResult, type ConsolidationAgentInput, type DreamingAgentInput, type DreamingResult, type Enrollment, type ResultExtractor, type SuppliedMaterial, type TaskBoundary, type TaskTarget, type VisibleBinding, type VisibleView } from "../../core/api/index.ts";

/** Ticket 27a (parent 27 "Decision", amendment 9): the fixed headroom of the one capacity rule both
 * memory-worker guards decide by — `context measure + 10,000 <= context window`. It is an allowance,
 * not an output reserve, not a guaranteed output size and not a setting: the 85% window multiplier
 * and the subtraction of the model's declared maximum output are gone from both guards, and
 * `model.maxTokens` is read by neither. Admission hands core `contextWindow - CONTEXT_HEADROOM` as
 * its input allowance; the last check before every round applies the same subtraction to Pi's own
 * measure of the child's context. Generation limits, `noting.batchTokens`, `consolidation.batchTokens`,
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

/** Ticket 29a "One derived view": the visible view of the selected context, computed at most once per
 * context position. The key is the leaf id, the entry count and the identity the view is bound to —
 * three cheap reads, none of which walks the tree — so a rewind, a fork, a new entry, a compaction and
 * the allocation of the memory session id each invalidate it, while a streaming token changes none of
 * them and re-reads the cached value. Database state is deliberately NOT in the key: applicability
 * must observe a new fact or commit even when the native leaf has not moved, so it is answered by its
 * own reads and never memoized with this. */
export type VisibleSource = Pick<ExtensionContext["sessionManager"], "getLeafId" | "getEntries" | "buildContextEntries">;
export function visibility(manager: VisibleSource) {
  let cached: { key: string; view: VisibleView } | undefined;
  return (binding: VisibleBinding): VisibleView => {
    const key = `${binding.db}|${binding.session ?? ""}|${binding.pi}|${manager.getLeafId() ?? ""}|${manager.getEntries().length}`;
    if (cached?.key !== key) cached = { key, view: visibleView(manager.buildContextEntries() as ContextEntry[], binding) };
    return cached.view;
  };
}

// 19c gate 6: retry and provider policy are Pi's own, read by the `SettingsManager` the native child
// is built with (hosts/pi/native.ts). The handwritten `retry` merge that used to live here — and its
// stale "a value import of SettingsManager needs pi-server" comment — went with the request-copy
// runner; nothing in this adapter reads or duplicates Pi's runtime settings any more.

import { piSourceBlocks } from "./source.ts";

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
  const forkLaunch = (context: ExtensionContext, input: NotingAgentInput | ConsolidationAgentInput,
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
    return { parentFile, parentSessionId: piId, checkpoint, captured: captured.payload };
  };
  const memory = TraceMemory(dbPath, async raw => {
    const input = raw as NotingAgentInput | ConsolidationAgentInput | DreamingAgentInput;
    const callContext = ctx;
    const callPiId = callContext.sessionManager.getSessionId();
    const registry = callContext.modelRegistry;
    const slash = input.model.indexOf("/");
    // The model is frozen with the run (a fork run freezes the session model at launch), so a
    // model switch during a two-round consolidation cannot redirect its final round.
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
      // Pi's own retry policy runs inside the child; the footer and the one warning per scheduled
      // backoff stay the adapter's, exactly as they were before the cutover.
      onRetry: event => {
        activity.retrying = true; showSpend(callContext);
        callContext.ui.notify(`Trace Memory: ${input.kind} retry ${event.attempt}/${event.maxAttempts} in ${Math.round(event.delayMs / 1000)}s: ${event.error}`, "warning");
      },
      onRetryEnd: () => { activity.retrying = false; showSpend(callContext); },
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
  /** Ticket 31 "One-shot knowledge supplement": `supplementGeneration` is the counter every successful
   * `on` and `project` command advances, `supplementServed` the generation confirmed complete by an
   * empty delta or a persisted message. These are session intent, restored from the latest session
   * state and persisted carriers, not from the selected ancestry's source/head snapshot. Material
   * visibility remains path-local. Both are optional for state written before this ticket. */
  type State = { enrollment?: { defaultEnabled: boolean; choice: boolean | null }; shared?: boolean; sourceHead?: number; originPiId?: string; sessionId?: number; projectId: number; branch: string; head?: number; piId: string; project?: string; supplementGeneration?: number; supplementServed?: number };
  let state: State;
  // 18b: one manual catchup at a time per executor, host-local state only (no new queue/claim
  // system — it drives 17c's own executor slot and target claim under a frozen entry/fact snapshot).
  type Catchup = {
    sessionId: number; branch: string; headTurnId: number;
    maxEntryId?: number; entryTotal: number; // Noting boundary: undefined means nothing was pending to note
    factIds: Set<number>; factTotal: number; // Consolidation boundary: pending-at-freeze plus produced-by-this-drain
    stopped: boolean;
    runningPhase?: "noting" | "consolidation";
    waitingPhase?: "noting" | "consolidation";
    outcome?: "completed" | "stopped" | "failed";
    diagnostic?: string;
  };
  let catchup: Catchup | undefined;
  /** What the last compaction of this executor did — the bounded views, or a native delegation and its
   * reason — for `/trace status` (ticket 20 "Failure visibility"). A diagnostic string, not a state
   * machine: nothing reads it back. */
  let lastCompaction: string | undefined;
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
  /** 28 amendment 2: the executor's one slot per phase, and what occupies it. The slot itself is
   * unchanged — one task of a kind at a time — but the entry now carries the task's target and its
   * frozen boundary beside the promise, because 28b's recovery has to tell a task it may reuse
   * (same target, same frozen boundary, so its completion IS this phase's progress) from unrelated
   * work it may neither count nor cancel. `done` is assigned in the same tick the slot is taken. */
  type Slot = { target: TaskTarget; boundary?: TaskBoundary; dreamingRangeId?: number; projectId?: number; claimToken?: string; result?: Promise<NotingResult | ConsolidateResult | { outcome: string } | undefined>; done?: Promise<unknown> };
  type WorkerPhase = "noting" | "consolidation" | "dreaming";
  const slots = new Map<WorkerPhase, Slot>();
  /** Same target and same frozen boundary — the compatibility 28 amendment 2 defines, field by field
   * over `TaskBoundary` rather than by a serialization whose key order would decide it. An ordinary
   * automatic task carries no boundary and is therefore not the same frozen range as a recovery
   * task's. */
  const sameTask = (slot: Slot, target: TaskTarget, boundary?: TaskBoundary) => {
    const ids = (value?: readonly number[]) => value === undefined ? "-" : [...value].sort((a, b) => a - b).join(",");
    const a = slot.boundary, b = boundary;
    return slot.target.sessionId === target.sessionId && slot.target.branch === target.branch && slot.target.headTurnId === target.headTurnId
      && (a?.maxEntryId ?? null) === (b?.maxEntryId ?? null) && ids(a?.exactEntryIds) === ids(b?.exactEntryIds)
      && ids(a?.allowedFactIds) === ids(b?.allowedFactIds) && ids(a?.exactFactIds) === ids(b?.exactFactIds);
  };
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
  const carrier = (supplied: SuppliedMaterial, generation?: number) =>
    ({ traceMemory: { ...binding(), supplied, ...(generation === undefined ? {} : { generation }) } });
  /** 31 "Triggers": the counter every successful `on` and every successful `project` command advances,
   * with no "did the state actually change" test — an unchanged state may still want the commit an
   * earlier budget omitted or a revision committed since. A tree switch, an ordinary prompt and a
   * background commit advance nothing. Several commands before one prompt collapse into one open
   * generation, so the final state is what that prompt is served from. */
  const requestSupplement = () => { state.supplementGeneration = (state.supplementGeneration ?? 0) + 1; };
  /** 31 "Completion": open until the message serving *this* generation is confirmed saved. The proof
   * is the persisted `custom_message` entry's carrier, read back through 29a's view of the selected
   * context — never the value `before_agent_start` returned, and never the settle. So a generation
   * advanced while a message is in flight stays open (its number is higher than that carrier's), a
   * turn that aborted before the entry was written supplies again, and a persisted message whose turn
   * never settles is complete: the budget-omitted remainder is not re-supplied for it. */
  const supplementOpen = (view: VisibleView) =>
    (state.supplementGeneration ?? 0) > Math.max(state.supplementServed ?? 0, view.suppliedGeneration);
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
  const rawUnavailable = (entries: readonly { id: number; turnId: number; nativeId: string }[]): string | undefined => {
    const view = visible(binding());
    if (!view.raw.size) return "Raw availability: the selected context holds no conversation entry of ours, so nothing establishes that this task's evidence is inherited";
    const missing = entries.find(entry => !view.raw.has(entry.nativeId));
    return missing ? `Raw availability: entry ${missing.id} (T${missing.turnId}, native ${missing.nativeId}) of this batch is not in the inherited context:`
      + " Pi retained no source for it and no compaction carrier supplied its bounded view" : undefined;
  };
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
    // 29e (parent 29 "Phase-specific evidence"): the Raw rule below is the Noter's alone. Consolidation
    // processes facts, and its own material carries the complete body of every selected fact the child
    // cannot already see (29b), so inherited Raw is neither a prerequisite nor extra citation authority.
    if (task?.kind !== "noting") return;
    const view = visible(binding());
    if (!view.raw.size) return rawUnavailable([]);
    // 29c: the target is the batch a freeze of this task would select — the pending set this task's
    // boundary admits, cut to the oldest prefix that fits `noting.batchTokens`. Asking core for it
    // renders those entries, which is what a freeze costs, so it is asked only once the whole pending
    // set (a superset of that batch) is known to be missing something at all.
    const pending = memory.pendingEntries(task.target.sessionId, task.target.branch, task.target.headTurnId);
    if (!pending.some(entry => !view.raw.has(entry.nativeId))) return;
    return rawUnavailable(memory.notingBatch(task.target, task.boundary));
  };
  /** The mode a task of this session will actually run in, for the readiness wait and the budget;
   * the requested mode is still what the run record keeps. */
  const effectiveMode = (requested: "fork" | "subagent", task?: ForkTask) =>
    forkRefused(requested, task) ? "subagent" as const : requested;
  const modelName = (kind: WorkerPhase) => {
    const configured = flat[kind === "dreaming" ? "dreaming.model" : `${kind}Model`];
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
  const activity = { running: new Map<WorkerPhase, number>(), retrying: false, last: "ok" as "ok" | "warning" | "error" };
  const runningKind = (kind: WorkerPhase) => (activity.running.get(kind) ?? 0) > 0;
  /** Ticket 24 "Footer counts and cost" and "Indicator semantics" (24a). One status item, one line:
   *
   *     🧠 ● notes: 24->102 memory: 15->54 cost: $0.12
   *
   * The arrows are stage inputs and existing outputs, not percentages: `notes` is the entries still
   * to note over every applicable committed fact, `memory` the facts still to consolidate over the
   * applicable current knowledge, `cost` this memory session's cumulative run spend (work another
   * executor performed *for* it included, work it performed for another session excluded, because
   * each run is charged to the session it was run for). Off is the compact `🧠 ○ off`; the stored
   * counts stay available in Current session.
   *
   * Every count comes from one core progress/applicability query over the current selected branch
   * and head (`memory.progress`), so nothing here renders Raw, tokenizes, freezes a task or loads a
   * run's audit body, and no timer refreshes it — the existing lifecycle, commit, control and
   * status points do. A value that cannot be read is `?`: an unknown is not a fabricated zero, and
   * before this Pi session has allocated a memory identity there is nothing to count at all.
   *
   * The indicator is Pi theme roles, never a literal colour, in the ruled precedence: off, active
   * retry, running Noting, running Consolidation, last failure, last warning, idle. Both phases
   * running shows Noting. It describes this executor, including while it works on a borrowed
   * target; the counts and the cost stay this session's. */
  const showSpend = (context: ExtensionContext) => {
    if (closed || !context.ui?.setStatus) return;
    const theme = (context.ui as { theme?: { fg?: (color: string, text: string) => string } }).theme;
    const paint = (color: string, text: string) => { try { return theme?.fg ? theme.fg(color, text) : text; } catch { return text; } };
    if (!enabled()) { context.ui.setStatus(tag, `🧠 ${paint("dim", "○ off")}`); return; }
    const indicator = activity.retrying ? paint("warning", "●") : runningKind("noting") ? paint("accent", "●") : runningKind("consolidation") || runningKind("dreaming") ? paint("success", "●")
      : activity.last === "error" ? paint("error", "●") : activity.last === "warning" ? paint("warning", "●") : paint("dim", "○");
    let counts: ReturnType<typeof memory.progress> | undefined, cost: number | undefined;
    if (state?.sessionId) {
      try { counts = memory.progress(state.sessionId, state.branch, state.head ?? null); } catch { /* unavailable: shown as ?, never as 0 */ }
      try { cost = memory.spend(state.sessionId).cost; } catch { /* the same rule for the amount */ }
    }
    const value = (count?: number) => count === undefined ? "?" : String(count);
    const text = `notes: ${value(counts?.entries)}->${value(counts?.facts)}` +
      ` memory: ${value(counts?.unconsolidated)}->${value(counts?.knowledge)} cost: ${cost === undefined ? "$?" : `$${cost.toFixed(2)}`}`;
    // Routine counts stay quiet; only the indicator uses an activity or warning colour.
    context.ui.setStatus(tag, `🧠 ${indicator} ${paint("dim", text)}`);
  };
  const reportProblems = (result: unknown, context: ExtensionContext) => {
    const r = result as { outcome?: string; problems?: string[] } | undefined;
    if (r?.outcome === "dropped") return; // a duplicate trigger says nothing about the run still in flight
    activity.last = r?.outcome === "failure" || r?.outcome === "cancelled" ? "error" : r?.outcome === "bounced" || r?.problems?.length ? "warning" : "ok";
    showSpend(context);
    if (r?.outcome === "success" && r.problems?.length) context.ui.notify(`Trace Memory: committed with problems. ${r.problems.join("; ")}`, "warning");
  };
  // One admission path for ordinary (own/borrowed) and manual-catchup work (18b): only the target,
  // mode/model and admission flags differ. `boundary` is absent for ordinary automatic work.
  // The return type is written out because 27b/27c's re-admission re-enters this function.
  const attemptPhase = (context: ExtensionContext, kind: WorkerPhase, target: { sessionId: number; branch: string; headTurnId: number },
      selected: { mode: "fork" | "subagent"; model: string; fallbackReason?: string },
      options: { borrowed: boolean; automatic: boolean; boundary?: TaskBoundary; forkAttempt?: ForkRefusal; signal?: AbortSignal },
      ): Promise<NotingResult | ConsolidateResult | DreamingResult | { outcome: "dropped"; permanent?: string }> => {
    if (closed || !enabled() || options.signal?.aborted
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
    const configuredThinking = flat[kind === "dreaming" ? "dreaming.thinking" : `${kind}Thinking`];
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
    const phase = kind === "noting" ? "Noting" : kind === "dreaming" ? "Dreaming" : "Consolidation";
    // 27a: the allowance is the window minus the fixed headroom, so an invalid window and one that
    // cannot even hold the headroom fail here, before anything is sent. `model.maxTokens` is read
    // nowhere any more: it changes neither the allowance nor this verdict.
    if (!model || !Number.isFinite(model.contextWindow) || model.contextWindow - CONTEXT_HEADROOM <= 0) {
      const permanent = `${phase} capacity: unavailable model context window (it must exceed the ${CONTEXT_HEADROOM}-token headroom); left pending`;
      context.ui.notify(permanent, "error");
      // A configuration error, not a transient wait: a manual catchup must fail on it, never retry (review 2026-09-08).
      return Promise.resolve({ outcome: "dropped", permanent } as const);
    }
    // Both phases negotiate capacity before selection (gate 4; review 2026-09-08 for Consolidation).
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
    const inherited = effective === "fork" ? visible(binding()) : undefined;
    const common = { ...target, ...selection, effectiveMode: effective, thinkingLevel: inheritedThinking,
      ...(inherited ? { visible: inherited } : {}),
      subagentThinkingLevel: subagentThinking,
      borrowed: options.borrowed, automatic: options.automatic, executorSessionId: state.sessionId!, capacity,
      ...(options.boundary ? { boundary: options.boundary } : {}),
      // 28b (parent 28 amendment 3): the admitting operation's cancellation, for the one operation
      // that has one — a compaction's recovery task. Core links it to this task's own controller, so
      // an Esc during compaction closes this task's binding and aborts this task, and nothing else.
      // It travels with a re-admission (`reroute` below spreads these options), because that is the
      // same task continuing.
      ...(options.signal ? { signal: options.signal } : {}),
      // 27c: the refused attempt's gate result, for a refusal that recorded no run of its own.
      // 27d: with it, the cancellation generation that attempt was admitted under — core drops this
      // admission when a cancellation happened in between.
      ...(carried ? { forkAttempt: carried, executionId: carried.executionId, ...(carried.cancellation !== undefined ? { cancellation: carried.cancellation } : {}) } : {}) };
    const admitted = (kind === "dreaming" ? memory.dream(common) : kind === "consolidation" ? memory.consolidate(common) : memory.noting(common))
      .then(result => { if (result.automaticOff) context.ui.notify(result.automaticOff, "warning"); return result; });
    if (kind === "dreaming") {
      // Core freezes synchronously at admission. Keep the retained identity beside this slot so
      // recovery reuses that exact family, not arbitrary same-path knowledge work.
      const slot = slots.get(kind);
      if (slot) {
        slot.target = target;
        slot.projectId = memory.store.getSession(target.sessionId)?.projectId;
        slot.dreamingRangeId = memory.store.retryDreamingRange(target)?.id;
        slot.claimToken = memory.store.getClaim(target.sessionId, kind)?.token;
      }
    }
    if (effective !== "fork") return admitted;
    // 27b: the freeze priced this batch as a fork — the inherited context plus the instructions — and
    // refused it. The same evidence under a fresh child's own price often fits, so that one refusal
    // is re-admitted instead of leaving feasible work pending. Only this refusal: any other admission
    // failure (a `noting.batchTokens` overflow, a store error) is reported as itself, and if the
    // subagent admission refuses the batch too, that refusal is what the caller reports.
    // 29e: the same two re-admissions for a Consolidation fork, told apart by that phase's own
    // capacity string. Nothing else about the path differs, which is the point of restoring the mode
    // rather than giving this phase a second fallback mechanism.
    return admitted.catch(error => error instanceof Error && error.cause === "task admission"
      && error.message.startsWith(kind === "noting" ? NOTING_CAPACITY : CONSOLIDATION_CAPACITY)
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
    // Command intent is session-wide, unlike the selected path's source/head snapshot. Reuse the
    // latest durable state; never roll a pending command back when selecting an earlier ancestor.
    state.supplementGeneration = latest?.supplementGeneration;
    state.supplementServed = latest?.supplementServed;
    const completed = visibleView(ctx.sessionManager.getEntries().filter(e => e.type === "custom_message"),
      { db: dbPath, session: state.sessionId ?? latest?.sessionId ?? null, pi: piId }).suppliedGeneration;
    state.supplementServed = Math.max(state.supplementServed ?? 0, completed);
    if (!state.sessionId && latest?.sessionId) {
      state.sessionId = latest.sessionId;
      state.originPiId = latest.originPiId;
      state.branch = randomUUID();
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
      if (!catchup.runningPhase) catchup.outcome = "stopped";
      memory.cancelTasks();
    }
    current = undefined;
    reconciledLeaf = undefined; reconciled = undefined; // 22b: a restored session reconciles its ancestry from the start
    reconcile(false);
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
    state.projectId = ownProject(state.piId);
    state.sessionId = memory.store.createSession({ host: `pi:${state.piId}`, startedAt: started, firstReplyAt: now(), projectId: state.projectId, projectDeclaration: "undeclared", nativeCreatedAt: ctx.sessionManager.getHeader()?.timestamp, baseline, enrollmentChoice: (provisional() ?? state.enrollment!).choice }).id;
    state.originPiId = state.piId;
    try { unlinkSync(provisionalPath()); } catch { /* no receipt, or already consumed */ } // the store owns enrollment from here
  };
  const historyProblems = new Set<string>();
  const missing = (problem: string) => {
    if (!historyProblems.has(problem)) { historyProblems.add(problem); ctx.ui.notify(`Trace Memory: missing native history: ${problem}`, "warning"); }
  };
  // Pi persists AFTER message_end extension hooks. Only the ancestry supplies native identities.
  // The walk is linear in the ancestry with one lookup per entry, and hooks fire on every streaming
  // update, so it runs only when the persisted leaf has moved (10 ms per update at 400 entries otherwise).
  let reconciledLeaf: string | null | undefined;
  // 22b: what the previous walk established, kept in process memory only. `ids` is the ancestry
  // prefix it covered; the rest is the state that prefix produced, including the tool calls each
  // Turn has offered, so a tool result finds its call without rereading the entries before it. The
  // next walk trusts this only when the ancestry still begins with exactly `ids` — tree navigation, a
  // fork, a lineage change or a shortened ancestry is not a prefix, and rebuilds. Restoration and the
  // enrollment switch drop it outright. Every entry the walk does check keeps its content-identity
  // check: this state decides what is new, never that a changed message is unchanged.
  let reconciled: { ids: string[]; lineage: string; turnId?: number; selected: number[]; seen: Set<string>;
    toolCalls: Map<string, { ordinal: number; name: string; callId: string }> } | undefined;
  const reconcile = (check = true) => {
    if (!enabled()) return;
    const leaf = ctx.sessionManager.getLeafId();
    if (state.sessionId && leaf === reconciledLeaf) return;
    const previous = state.sourceHead;
    walk();
    // A walk before the memory session exists creates no Turn; the first walk after allocation must run.
    reconciledLeaf = state.sessionId ? leaf : undefined;
    if (check && state.sourceHead !== previous && state.sourceHead !== undefined) checkQueues();
  };
  const walk = () => memory.store.transaction(() => {
    const ancestry = ctx.sessionManager.getBranch();
    if (!state.sessionId && ancestry.some(e => e.type === "message" && e.message.role === "assistant" &&
      (text(e.message) || e.message.content.some(c => c.type === "toolCall" || c.type === "thinking")))) allocate(ancestry[0]?.timestamp ?? now());
    if (!state.sessionId) return;
    const resume = reconciled && reconciled.ids.length <= ancestry.length
      && reconciled.ids.every((id, i) => (ancestry[i] as { id: string }).id === id) ? reconciled : undefined;
    reconciled = undefined; // a walk that throws leaves nothing to resume from
    let lineage = resume ? resume.lineage : state.originPiId ?? state.piId;
    let turnId = resume?.turnId;
    const ids = resume ? resume.ids : [], selected = resume ? resume.selected : [];
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
    for (let index = ids.length; index < ancestry.length; index++) {
      const entry = ancestry[index]!;
      ids.push(entry.id);
      if (entry.parentId && !seen.has(entry.parentId)) missing(`parent ${entry.parentId} before ${entry.id}`);
      seen.add(entry.id);
      if (entry.type === "custom" && entry.customType === tag) {
        const data = entry.data as State & { dbPath?: string };
        if (data.dbPath === dbPath) lineage = data.piId;
        continue;
      }
      if (entry.type !== "message") continue;
      const message = entry.message;
      if (message.role !== "user" && message.role !== "assistant" && message.role !== "toolResult") continue;
      const natural = message.role === "toolResult" ? "" : text(message);
      const calls = message.role === "assistant" ? message.content.filter(c => c.type === "toolCall") : [];
      // A user message is a Turn boundary whatever it carries (an image-only message has no text); only an
      // assistant message with neither text nor tool calls is nothing (review 2026-09-08).
      if (!natural && !calls.length && message.role === "assistant" && !message.content.some(c => c.type === "thinking")) continue;
      const known = memory.store.findSourceEntry(state.sessionId, lineage, entry.id);
      if (known) {
        if (known.raw !== JSON.stringify(message)) missing(`entry ${entry.id} changed after persistence`);
        selected.push(known.id); turnId = known.turnId;
        if (known.role === "assistant") offer(known.turnId, known.calls);
        continue;
      }
      if (message.role === "user") {
        turnId = memory.store.appendTurn({ sessionId: state.sessionId, parentTurnId: turnId ?? null, kind: "turn", userPrompt: natural, startedAt: entry.timestamp }).id;
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
    memory.selectEntries(state.sessionId, state.branch, selected);
    state.sourceHead = selected.at(-1);
    if (turnId) { state.head = turnId; if (current) current.id = turnId; }
    reconciled = { ids, lineage, turnId, selected, seen, toolCalls };
  });
  const persistState = () => { reconcile(); if (state.sessionId && state.sourceHead !== savedSourceHead) save(); };
  const flush = (ended = false) => { reconcile(false); if (enabled() && ended && current?.id) memory.store.updateTurn(current.id, { endedAt: now() }); };
  pi.on("before_provider_request", (event, context) => {
    ensure(context);
    if (!enabled()) { showSpend(context); return; }
    const previous = state.sourceHead;
    reconcile(false);
    // The capture is the fork gate's comparand and nothing else: the request-copy runner that also
    // read the ancestry behind it was deleted in 19c, so only the body is kept (review 2026-09-08).
    if (context.model) session.capture = { payload: snapshot(event.payload) as Body, model: context.model.id, provider: context.model.provider, branch: state.branch };
    if (state.sourceHead !== previous && state.sourceHead !== undefined) checkQueues();
  });
  pi.on("session_start", (_event, context) => restore(context));
  // 29d: the injected-once flag is gone, so a tree switch resets nothing here — the selected
  // context's own visible view is what decides the next prompt's knowledge block (29a case 8).
  pi.on("session_tree", (_event, context) => { restore(context, true); });
  pi.on("before_agent_start", (event, context) => {
    ensure(context);
    current = { started: now() };
    if (!enabled()) { showSpend(context); return; }
    reconcile();
    // 29d "Retire automatic foreground receipt delivery": the knowledge block is the only automatic
    // material a prompt still carries. The per-prompt `<noted>`/`<consolidated>` delivery, its
    // settle-time confirmation and the `injected` flag that competed with the native context are gone;
    // the foreground learns a worker's results through a later compaction, an explicit read, or (31,
    // the one exception) the single supplement an `on` or `project` command asks for.
    //
    // Whether the block is offered is decided by 29a's baseline of the *selected* context alone: it is
    // offered iff that context holds neither a marked injection of ours nor a custom compaction that
    // carried knowledge commits. Unknown coverage — a native compaction, a foreign carrier, a turn Pi
    // never persisted — fabricates no earlier supply and injects again: duplicates over silent loss.
    // It is a baseline test, never a delta: once a baseline is present, newer commits are not offered
    // prompt by prompt, which is what keeps initial setup from becoming continuous delivery.
    //
    // Ticket 31 "One selection, two triggers": that initial condition is one of two triggers now, and
    // it is unchanged and independent — a rewind to before the first injection satisfies it on its own,
    // with no generation involved. The second is the one-shot supplement a successful `on` or `project`
    // command opened. Both are served by the same core selection below; the trigger only decides
    // whether it is consulted at all, never what it selects.
    const view = visible(binding());
    const initial = !view.injection && !view.knowledgeCommitIds.size;
    const supplement = supplementOpen(view);
    if (!initial && !supplement) return;
    // A knowledge cap that cannot hold even its omission receipt is reported, never injected over (review 2026-09-08).
    let block: ReturnType<TraceMemory["injection"]>;
    try {
      // 31: the selected context's own view is what the applicable set is subtracted against. On the
      // initial trigger that view holds no knowledge commit at all, so nothing is subtracted and the
      // bytes are the block 29d produced.
      block = memory.injection(state.sessionId ? { sessionId: state.sessionId, headTurnId: state.head ?? null, branch: state.branch } : { projectId: state.projectId }, view);
    } catch (error) { context.ui.notify(String(error), "error"); return; }
    if (!block.text) {
      // 31 "Completion": an empty delta completes its generation at once, with no message — every
      // candidate is already visible, and there is nothing to persist a carrier on. The initial
      // trigger has no generation to complete and simply tries again next prompt.
      if (supplement) { state.supplementServed = state.supplementGeneration; save(); }
      return;
    }
    // 29a "Carriers": what this message actually supplies, written on it as `details` when Pi persists
    // it. An id that appears only in the rendered text is not coverage. A planned injection is not a
    // persisted one: this handler only offers the message, and the carrier rides the same value, so a
    // turn Pi never persists leaves no coverage behind either — and, since 31, leaves the generation
    // it would have served open.
    const supplied: SuppliedMaterial = { entries: [], factIds: [], knowledgeCommitIds: block.knowledgeCommitIds };
    return { message: { customType: tag, content: block.text, display: false,
      details: { traceMemory: { ...carrier(supplied, supplement ? state.supplementGeneration : undefined).traceMemory, composition: block.composition } } } };
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
  // 24a: a tool result, the end of an agent run and the settle are the existing boundaries at which
  // this turn's evidence became importable, so they are where the footer's counts are re-read. A
  // streaming update is not one of them: `message_update` fires per delta and refreshes nothing.
  pi.on("tool_result", (_event, context) => { ensure(context); persistState(); showSpend(context); });
  pi.on("agent_end", (_event, context) => { ensure(context); persistState(); showSpend(context); });
  pi.on("agent_settled", (_event, context) => {
    ensure(context); persistState();
    try {
      if (!enabled()) return;
      // 29d: nothing is confirmed here any more. What this prompt supplied is stated on the entry Pi
      // persisted for it (29a's carrier), so the settle has no delivery queue to drain and no
      // injected-once flag to set.
      if (!state.sessionId || !state.head) return;
      if (current?.id && memory.store.getTurn(current.id)?.assistantText !== null) flush(true);
    } finally { showSpend(context); } // one refresh at the settle, whichever path this turn took
  });
  // The reason a due fork-mode task must wait for a later boundary, or undefined when it may launch
  // now. Only the inherited-context path has a checkpoint to be ready: a fresh-context run and a
  // session already downgraded by the cache-miss latch have none.
  const forkWait = (context: ExtensionContext, mode: "fork" | "subagent"): string | undefined => {
    if (mode !== "fork" || suppressed()) return;
    const parentFile = context.sessionManager.getSessionFile?.();
    if (!parentFile) return; // no native file at all: the documented subagent fallback applies, not a wait
    const checkpoint = context.sessionManager.getLeafId();
    if (!checkpoint) return "the parent session has no persisted leaf entry";
    return checkpointReadiness(parentFile, checkpoint);
  };
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
    const own = { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head };
    for (const kind of ["noting", "consolidation", "dreaming"] as const) {
      if (slots.has(kind)) continue;
      const selected = launch(kind);
      // The readiness wait follows the mode that will actually run: a session the cache-miss latch has
      // downgraded runs fresh-context work, which reads nothing from the conversation and forks
      // nothing. The requested mode stays what it is, for the audit (review 2026-09-08). 29d removed
      // the delivery pause that used to read this too.
      const effective = effectiveMode(selected.mode, { kind, target: own });
      let due = false;
      try { ({ due } = memory.taskEligibility(kind, own)); }
      catch (error) { context.ui.notify(String(error), "error"); }
      // 19c "Trigger versus launch": the threshold above decides that this task is due; the checkpoint
      // decides when it may launch. A due fork-mode task whose native checkpoint is not yet persisted,
      // reopenable and free of an open tool-call group waits for the next safe boundary — no timer, no
      // duplicate task, no progress, and starting later is not a new extraction trigger. Borrowed
      // closed-session work is fresh-context and is never held back by this.
      const waiting = due ? forkWait(context, effective) : undefined;
      const candidates = [...(due && !waiting ? [{ ...own, borrowed: false }] : []),
        ...memory.store.closedTasks(kind, own.sessionId, memory.config.closedSessionScope).map(target => ({ ...target, borrowed: true }))];
      if (!candidates.length) continue;
      const slot: Slot = { target: own }; // ordinary automatic work: the whole pending set, no frozen boundary
      slots.set(kind, slot); // Reserve before any asynchronous admission or model work.
      const work = async () => {
        for (const { borrowed, ...target } of candidates) {
          if (closed || !enabled()) return;
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
      trackSlot(kind, slot, promise.then(result => reportProblems(result, context), error => {
        activity.last = "error"; context.ui.notify(String(error), "error");
      }), context, () => { showSpend(context); if (catchup) driveCatchup(); });
    }
    if (catchup) driveCatchup(); // 18b: an ordinary eligible-entry opportunity is the other resumption event.
  };
  // 18b: manual catchup drains a frozen snapshot (18-"Manual catchup and stop"). It shares 17c's
  // executor slots and target claim through `attemptPhase`; no second scheduler or queue is added.
  // `driveCatchup` is the sole place that starts a batch on completion of the previous one — the
  // one explicit exception to 17b/17c's no-completion-chaining rule.
  const catchupProgress = (c: Catchup) => {
    const remainingEntries = c.maxEntryId === undefined ? 0 : memory.pendingEntries(c.sessionId, c.branch, c.headTurnId).filter(e => e.id <= c.maxEntryId!).length;
    const remainingFacts = memory.store.consolidationBatch(c.sessionId, c.branch, c.headTurnId).filter(f => c.factIds.has(f.id)).length;
    return { entriesDone: c.entryTotal - remainingEntries, remainingEntries, factsDone: c.factIds.size - remainingFacts, remainingFacts };
  };
  const catchupLine = (): string | undefined => {
    if (!catchup) return undefined;
    const c = catchup, p = catchupProgress(c);
    if (c.outcome === "completed") return `Catchup: completed (${c.entryTotal} entries noted, ${c.factTotal} facts integrated)`;
    if (c.outcome === "stopped") return `Catchup: stopped (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts processed; unprocessed work stays pending; /trace catchup resumes it)`;
    if (c.outcome === "failed") return `Catchup: failed — ${c.diagnostic} (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts processed)`;
    if (c.waitingPhase) return `Catchup: waiting for ${c.waitingPhase} (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts)`;
    if (c.runningPhase) return `Catchup: running ${c.runningPhase} (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts)`;
    return `Catchup: idle (${p.entriesDone}/${c.entryTotal} entries, ${p.factsDone}/${c.factTotal} facts)`;
  };
  const hasBackgroundWork = () => runningKind("noting") || runningKind("consolidation") || runningKind("dreaming") || !!(catchup && !catchup.outcome);
  const driveCatchup = () => {
    const c = catchup;
    if (!c || c.stopped || c.outcome || closed) return;
    const context = ctx;
    const own = { sessionId: c.sessionId, branch: c.branch, headTurnId: c.headTurnId };
    const p = catchupProgress(c);
    const phase: "noting" | "consolidation" | undefined = p.remainingEntries ? "noting" : p.remainingFacts ? "consolidation" : undefined;
    if (!phase) {
      c.outcome = "completed"; c.waitingPhase = undefined; c.runningPhase = undefined;
      context.ui.notify(`Trace Memory: catchup completed (${c.entryTotal} entries noted, ${c.factTotal} facts integrated).`, "info");
      showSpend(context); return;
    }
    if (slots.has(phase)) { c.waitingPhase = phase; c.runningPhase = undefined; return; } // 17c's slot is not stolen; wait for its release.
    const foreign = memory.store.getClaim(own.sessionId, phase);
    if (foreign && foreign.expiresAt > Date.now() && foreign.executorId !== memory.executorId) {
      c.waitingPhase = phase; c.runningPhase = undefined; return; // A live foreign claim on our own target is exposed as Waiting, not stolen.
    }
    c.waitingPhase = undefined; c.runningPhase = phase;
    // 29e: the *allowable* set, never the exact one — a drain takes it in bounded batches (18b).
    const boundary = phase === "noting" ? { maxEntryId: c.maxEntryId } : { allowedFactIds: [...c.factIds] };
    const slot: Slot = { target: own, boundary };
    slots.set(phase, slot); activity.running.set(phase, 1); showSpend(context);
    const promise = attemptPhase(context, phase, own, { mode: "subagent", model: modelName(phase) }, { borrowed: false, automatic: false, boundary });
    let waited = false; // this attempt itself ended in Waiting (a concurrent drive may set waitingPhase too, and that must not stop the chain)
    const handled = promise.then(result => {
      if (phase === "noting" && result && Array.isArray((result as { facts?: unknown }).facts))
        for (const f of (result as { facts: { id: number }[] }).facts) if (!c.factIds.has(f.id)) { c.factIds.add(f.id); c.factTotal++; }
      reportProblems(result, context);
      const outcome = (result as { outcome?: string }).outcome;
      if (c.stopped) { c.outcome = "stopped"; return; } // Stop wins the race: no further chaining, whatever this batch returned.
      const permanent = (result as { permanent?: string }).permanent;
      if (outcome === "dropped" && permanent) { c.outcome = "failed"; c.diagnostic = permanent; return; } // a configuration error ends the drain
      if (outcome === "dropped") { c.waitingPhase = phase; waited = true; return; } // A foreign claim on our own target; retry on the next opportunity.
      if (outcome !== "success" && outcome !== "empty") {
        c.outcome = outcome === "cancelled" ? "stopped" : "failed";
        c.diagnostic = (result as { problems?: string[]; output?: unknown }).problems?.join("; ") ?? String((result as { output?: unknown }).output ?? outcome);
      }
    }, error => { c.outcome = "failed"; c.diagnostic = String(error); context.ui.notify(String(error), "error"); });
    slot.result = promise.catch(() => undefined);
    trackSlot(phase, slot, handled, context, () => {
      c.runningPhase = undefined; showSpend(context);
      // Only this explicit drain chains. A dropped attempt waits for a later opportunity;
      // immediately re-driving it would loop without a wait.
      if (!waited) driveCatchup();
    });
  };
  const startCatchup = () => {
    if (!enabled()) throw new Error("Trace Memory is Disabled; use /trace on to enable memory.");
    if (catchup && !catchup.outcome) { ctx.ui.notify(catchupLine()!, "info"); return; } // Repeating catchup reports the active operation, never a second one.
    if (!state.sessionId || !state.head) { ctx.ui.notify("Trace Memory: no assistant reply yet; nothing to catch up.", "info"); return; }
    reconcile(false); // Reconcile available native history (17a) before freezing the boundary.
    // Refresh the footer even on paths below that start no batch.
    showSpend(ctx);
    const { sessionId, branch } = state, headTurnId = state.head;
    const pendingNow = memory.pendingEntries(sessionId, branch, headTurnId);
    const maxEntryId = pendingNow.length ? Math.max(...pendingNow.map(e => e.id)) : undefined;
    const factsNow = memory.store.consolidationBatch(sessionId, branch, headTurnId).map(f => f.id);
    catchup = { sessionId, branch, headTurnId, maxEntryId, entryTotal: pendingNow.length, factIds: new Set(factsNow), factTotal: factsNow.length, stopped: false };
    if (!pendingNow.length && !factsNow.length) { catchup.outcome = "completed"; ctx.ui.notify("Trace Memory: catchup found nothing pending; already caught up.", "info"); return; }
    driveCatchup(); // Starts the cancellable operation and returns; stop remains available while it runs.
    ctx.ui.notify(catchupLine()!, "info"); // Honestly reports the immediate result: running or Waiting for an occupied phase/claim.
  };
  const stopCatchup = () => {
    const active = hasBackgroundWork();
    if (catchup && !catchup.outcome) { catchup.stopped = true; if (!catchup.runningPhase) catchup.outcome = "stopped"; }
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
  const PHASE_LABEL = { noting: "Noting", consolidation: "Consolidation", dreaming: "Dreamer" } as const;
  /** A wait that ends when the work ends or when the user cancels the compaction, whichever comes
   * first. Cancelling the wait never touches the work: this operation may wait for capacity it does
   * not own, and Pi's Esc must not end another operation's task (28 "Execution and interaction").
   * The listener is removed on both exits, so a compaction that ends normally leaves nothing on its
   * signal. */
  const untilSettled = (work: Promise<unknown> | undefined, signal?: AbortSignal) => {
    if (!work || signal?.aborted) return Promise.resolve();
    const quiet = work.then(() => {}, () => {});
    if (!signal) return quiet;
    return new Promise<void>(resolve => {
      const done = () => { signal.removeEventListener("abort", done); resolve(); };
      signal.addEventListener("abort", done, { once: true });
      void quiet.then(done);
    });
  };
  /** 28b (parent 28 "Recovery sequence" steps 3-4): this compaction's one task of one phase. It is an
   * ordinary bounded batch admitted through the one admission path — subagent mode on the configured
   * phase model, at the level `attemptPhase` freezes (26d), in a child whose own automatic compaction
   * is off (27b), so a recovery worker can never compact recursively. The executor's phase slot, the
   * target claim and every commit fence are the existing ones: this adds no scheduler, no queue and
   * no dialog.
   *
   * Reuse and actual admission consume one use. A capacity-only wait consumes none. After one
   * capacity wait, inspect the new occupant once: reuse compatible work, but do not queue behind
   * another unrelated owner or turn recovery into a drain. */
  const recoverPhase = async (context: ExtensionContext, kind: WorkerPhase, target: TaskTarget,
      boundary: TaskBoundary | undefined, valid: () => boolean, signal: AbortSignal | undefined, needed: () => boolean): Promise<{ used: boolean; result?: NotingResult | ConsolidateResult | { outcome: string } }> => {
    const phase = PHASE_LABEL[kind];
    const compatible = (slot: Slot) => {
      if (kind !== "dreaming") return sameTask(slot, target, boundary);
      const range = memory.store.retryDreamingRange(target);
      const claim = memory.store.getClaim(target.sessionId, kind);
      // D admits the retained range's head, not the moving foreground leaf. N/C above keep their
      // original head/boundary comparison. The range, live ownership and applicable frozen members
      // must still match; ignoring the leaf alone would also accept a rewind or a lost claim.
      if (!range || range.id !== slot.dreamingRangeId || range.branch !== target.branch
          || !sameTask(slot, { ...target, headTurnId: slot.target.headTurnId }, boundary)
          || slot.projectId !== memory.store.getSession(target.sessionId)?.projectId
          || !claim || claim.reserved || claim.token !== slot.claimToken
          || claim.executorId !== memory.executorId || claim.expiresAt <= Date.now()) return false;
      const snapshot = memory.store.pathSnapshot(target);
      if (!snapshot.turns.has(range.headTurnId)) return false;
      const frozenPath = { sessionId: range.sessionId, branch: range.branch, headTurnId: range.headTurnId };
      const frozen = memory.store.pathSnapshot(frozenPath);
      return range.eventIds.every(id => {
        const event = memory.store.knowledgeRevision(id);
        return !!event && memory.store.commitApplies(event, target, snapshot)
          && memory.store.commitApplies(event, frozenPath, frozen);
      });
    };
    let occupied = slots.get(kind);
    if (occupied && !compatible(occupied)) {
      context.ui.notify(`Trace Memory: compaction is waiting for the occupied ${phase} slot.`, "info");
      await untilSettled(occupied.done, signal);
      if (!valid() || signal?.aborted) return { used: false };
      occupied = slots.get(kind);
      if (occupied && !compatible(occupied)) return { used: false };
      if (!occupied && !needed()) return { used: false }; // capacity work may already have made it fit
    }
    if (occupied) {
      // 28 item 7: the awaited phase is named through the existing notify, beside the footer's own
      // running indicator, which already paints the phase. No second dialog is opened.
      context.ui.notify(`Trace Memory: compaction is waiting for the running ${phase} task on this target.`, "info");
      await untilSettled(occupied.done, signal);
      if (!valid() || signal?.aborted) return { used: false };
      const result = await occupied.result;
      if (result?.outcome === "failure" && "problems" in result)
        context.ui.notify(`Trace Memory: ${phase} recovery failed. ${result.problems.join("; ")}`, "warning");
      return { used: !!result && "runId" in result, result };
    }
    if (!valid() || signal?.aborted) return { used: false };
    // Eligibility is rechecked after a capacity wait, before admission. Overflow never waives it.
    if (!memory.taskEligibility(kind, target).due) return { used: false };
    const remaining = kind === "dreaming" || (kind === "noting"
      ? memory.pendingEntries(target.sessionId, target.branch, target.headTurnId).some(e => boundary?.maxEntryId === undefined || e.id <= boundary.maxEntryId)
      : memory.store.consolidationBatch(target.sessionId, target.branch, target.headTurnId).some(f => !boundary?.allowedFactIds || boundary.allowedFactIds.includes(f.id)));
    if (!remaining) return { used: false };
    const slot: Slot = { target, boundary };
    slots.set(kind, slot); activity.running.set(kind, 1); showSpend(context);
    context.ui.notify(`Trace Memory: compaction is running ${phase} to reduce the pending ${kind === "noting" ? "Raw" : kind === "dreaming" ? "knowledge" : "facts"}.`, "info");
    const promise = attemptPhase(context, kind, target, { mode: "subagent", model: modelName(kind) },
      { borrowed: false, automatic: false, boundary, signal });
    const settled = trackSlot(kind, slot, promise.then(result => {
      reportProblems(result, context);
      if (result.outcome === "failure") context.ui.notify(`Trace Memory: ${phase} recovery failed. ${result.problems.join("; ")}`, "warning");
      return result;
    },
      error => { activity.last = "error"; context.ui.notify(String(error), "error"); return undefined; }),
      context, () => { showSpend(context); if (catchup) driveCatchup(); });
    slot.result = settled;
    const result = await settled;
    return { used: !!result && "runId" in result, result };
  };
  // Ticket 20 "Compaction escalation", as 30 and 28a/28b left it. Core renders its own frozen read
  // snapshot and allocates over three windows; this handler binds the outcome and, when a REQUIRED
  // window overflows, runs ticket 28's bounded recovery before deciding:
  //
  //   freeze (path, the pending entries, the initially applicable pending facts)
  //     -> allocate -> shared shortfall? -> unused, eligible N/C/D phases, concurrently
  //     -> await -> re-read committed progress and exact processed versions on the frozen path
  //     -> still over? -> unused downstream eligibility (N enables C, C enables D), then reallocate
  //     -> persist the replacement with its carrier, or delegate to Pi with the reason.
  //
  // One use per phase per attempt, whatever its outcome: `used` below is that flag, and three rounds
  // cover the dependency chain (32f — no state machine, one flag per phase plus
  // the promises this host already holds). No larger-than-normal batch is ever built to avoid the
  // delegation: each task is one ordinary bounded batch, and a batch that leaves backlog behind
  // simply delegates. Nothing else changes: ordinary triggers, drains, borrowed work and manual
  // catchup are untouched, and outside this handler compaction still starts no worker.
  //
  // Cancellation is Pi's own. `event.signal` is the compaction abort controller behind Esc and
  // `session.abortCompaction()` (agent-session.js:1476 manual / :1750 automatic create it, :1604
  // aborts both). It reaches the tasks this operation launched — and only those — through
  // `TaskOptions.signal`, and a cancelled compaction returns `{cancel: true}`, which is how Pi ends
  // a compaction as aborted (:1509 manual, :1770 automatic) instead of running its own.
  pi.on("session_before_compact", async (event, context) => {
    ensure(context); if (!enabled()) return; flush();
    const signal = (event as { signal?: AbortSignal }).signal;
    const initial = { sessionId: state.sessionId, branch: state.branch, head: state.head, projectId: state.projectId };
    const valid = () => !closed && enabled() && state.sessionId === initial.sessionId
      && state.branch === initial.branch && state.head === initial.head && state.projectId === initial.projectId
      && (!initial.sessionId || memory.store.getSession(initial.sessionId)?.projectId === initial.projectId);
    const allocate = (): ReturnType<typeof memory.compact> => {
      try {
        if (!valid()) return { native: true, reason: "memory enrollment or the selected path changed during recovery" };
        if (state.sessionId) return memory.store.transaction(() => {
          if (!valid()) return { native: true as const, reason: "memory enrollment, project or the selected path changed during recovery" };
          return memory.compact(state.sessionId!, state.branch, state.head, retainedView(context, KEPT_AFTER_CUSTOM_COMPACTION));
        });
        const block = memory.injection({ projectId: state.projectId });
        return { text: block.text, composition: block.composition, supplied: { entries: [], factIds: [], knowledgeCommitIds: block.knowledgeCommitIds } };
      } catch (error) { return { native: true, reason: String(error) }; } // a capacity error is a reason to delegate, never oversized material
    };
    let result = allocate();
    const recovered: string[] = [];
    // The freeze of this attempt: the selected path, its pending source entries and the pending facts
    // applicable to it. New foreground entries never join — Pi refuses a prompt while a compaction is
    // in progress (agent-session.js:836), and the entry ceiling below makes that structural.
    const path = state.sessionId && state.head ? { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head } : undefined;
    if (path && !signal?.aborted && "native" in result && result.over) {
      const frozen = memory.pendingEntries(path.sessionId, path.branch, path.headTurnId);
      // The boundary is that frozen ceiling, not exact membership: a recovery task is one ORDINARY
      // bounded batch (28 "Recovery sequence"), and exact membership would refuse every batch bigger
      // than `noting.batchTokens` — which is exactly what an overflowing Raw window is. Entry ids are
      // allocated in order, so the ceiling is the frozen set minus whatever gets noted, and never more.
      const maxEntryId = frozen.length ? Math.max(...frozen.map(e => e.id)) : undefined;
      // The Consolidation allowance: the initially applicable pending facts, plus the facts this
      // exact launched or compatible reused Noting task commits (28 "Recovery sequence" step 5).
      // Slot results preserve task identity; unrelated completed work never contributes facts here.
      const factIds = new Set(memory.store.consolidationBatch(path.sessionId, path.branch, path.headTurnId).map(f => f.id));
      const used = { noting: false, consolidation: false, dreaming: false };
      for (let round = 0; round < 3; round++) {
        if (!("native" in result) || !result.over) break;
        const over = result.over;
        const wanted = (["noting", "consolidation", "dreaming"] as const).filter(kind => !used[kind]
          && (kind === "noting" ? over.raw && maxEntryId !== undefined : kind === "dreaming" ? over.knowledge : over.facts && factIds.size > 0)
          && memory.taskEligibility(kind, path).due);
        if (!wanted.length) break; // the allowed tasks are exhausted: the delegation below is the outcome
        const results = await Promise.all(wanted.map(async kind => ({ kind,
          ...await recoverPhase(context, kind, path, kind === "noting" ? { maxEntryId } : kind === "dreaming" ? undefined : { allowedFactIds: [...factIds] }, valid, signal, () => {
            const fresh = allocate();
            return "native" in fresh && !!fresh.over?.[kind === "noting" ? "raw" : kind === "dreaming" ? "knowledge" : "facts"];
          }),
        })));
        if (signal?.aborted || !valid()) break;
        for (const settled of results) {
          if (settled.used) { used[settled.kind] = true; recovered.push(PHASE_LABEL[settled.kind]); }
          for (const fact of (settled.result as { facts?: { id: number }[] } | undefined)?.facts ?? []) factIds.add(fact.id);
        }
        result = allocate(); // re-read committed progress on the frozen path; nothing is subtracted merely because a task ran
        if (!results.some(settled => settled.used) || results.some(settled => settled.result?.outcome === "failure")) break;
        // Capacity is not a use; a terminal failure gets the final reprice, not another recovery task.
      }
    }
    // 28 "Failure and persistence": user cancellation cancels this operation's own work — the signal
    // did that through core — publishes nothing and starts no native fallback. Committed progress
    // stays committed; a cancelled compaction appends no entry, so no carrier and no baseline moves.
    if (signal?.aborted) {
      context.ui.notify("Trace Memory: compaction was cancelled; its recovery work was cancelled with it and no native compaction was started.", "info");
      return { cancel: true };
    }
    if (closed) return { cancel: true };
    // Disabled during recovery is a native failure route, never core's empty disabled summary.
    if (!valid()) result = { native: true, reason: "memory enrollment, project or the selected path changed during recovery" };
    // A tree switch during recovery abandons the path this replacement was prepared for. The attempt
    // is never retargeted: it delegates, and a late result of the old path publishes nothing here.
    if (path && (state.sessionId !== path.sessionId || state.branch !== path.branch || state.head !== path.headTurnId
        || state.projectId !== initial.projectId || memory.store.getSession(path.sessionId)?.projectId !== initial.projectId))
      result = { native: true, reason: `the selected path changed during recovery (S${path.sessionId}/${path.branch}/T${path.headTurnId} is no longer selected); nothing prepared for it is published into the new one` };
    const recovery = recovered.length ? ` (after recovery: ${[...new Set(recovered)].join(", ")})` : "";
    context.ui.notify(`Trace Memory: compaction preparing ${"native" in result ? `native delegation — ${result.reason}` : "bounded entry views"}${recovery}.`, "info");
    // Notification callbacks may themselves cancel or change the binding. No await or callback
    // separates this final coherent reprice from constructing the exact publication carrier.
    if (signal?.aborted || closed) return { cancel: true };
    result = allocate();
    if (signal?.aborted || closed) return { cancel: true };
    if ("native" in result) return;
    // 29a "Receipt and content are one carrier": the identities this replacement supplies ride on the
    // compaction entry Pi appends for it, so a cancelled or failed attempt — which appends no entry —
    // leaves the earlier baseline untouched, and a native delegation carries no `traceMemory` at all.
    return { compaction: { summary: result.text, firstKeptEntryId: KEPT_AFTER_CUSTOM_COMPACTION, tokensBefore: event.preparation.tokensBefore, details: { traceMemory: { ...carrier(result.supplied).traceMemory, composition: result.composition, recovery } } } };
  });
  pi.on("session_compact", (_event, context) => {
    // Pi 0.85.1 finds its event entry by the first equal summary. Read the actual appended
    // compaction on the selected ancestry instead: equal text is never carrier identity.
    const entry = context.sessionManager.getBranch().filter(entry => entry.type === "compaction").at(-1);
    if (!entry || entry.type !== "compaction") return;
    const own = (entry.details as { traceMemory?: VisibleBinding & { recovery?: unknown } } | undefined)?.traceMemory;
    const custom = own?.db === dbPath && own.pi === state.piId && own.session === (state.sessionId ?? null);
    lastCompaction = custom ? `bounded entry views${typeof own?.recovery === "string" ? own.recovery : ""}`
      : "native delegation — saved without Trace Memory material coverage";
    if (enabled() && state.sessionId) {
      const turn = memory.store.appendTurn({ sessionId: state.sessionId, parentTurnId: state.head, kind: "compaction", assistantText: entry.summary, startedAt: now(), endedAt: now() });
      state.head = turn.id; save();
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
      try { memory.close(); } catch (error) { report(error); }
    }
  });
  const result = (value: string) => ({ content: [{ type: "text" as const, text: value }], details: {} });
  // The main agent registers the façade metadata (same name, description, schema the runs send)
  // wrapped with an executor bound to the current session and turn.
  const definitions = toolDefinitions.map(definition => ({ ...definition, label: definition.name,
    async execute(_id: string, raw: unknown, _signal: unknown, _update: unknown, context: ExtensionContext) {
      ensure(context); reconcile();
      const bound = state.sessionId && current?.id ? memory.tools({ kind: "manual", sessionId: state.sessionId, branch: state.branch, currentTurnId: current.id,
        readKnowledgeCommits: [...visible(binding()).knowledgeCommitIds].flatMap(commit => {
          const revision = memory.store.knowledgeRevision(commit);
          return revision ? [{ knowledgeId: revision.knowledgeId, commit }] : [];
        }) }) : null;
      if (definition.name === "trace" || definition.name === "search") {
        const input = validateReadInput(definition.name, raw);
        if (bound) return result(bound.find(t => t.name === definition.name)!.execute(input));
        const options = { ...input, sessionId: state.sessionId, headTurnId: state.head, branch: state.branch };
        return result(definition.name === "trace" ? memory.trace(input.address as string, options)
          : memory.search(input.query as string, input.layer as import("../../core/api/index.ts").SearchScope, options));
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
    if (!value) { memory.cancelTasks(); if (catchup && !catchup.outcome) { catchup.stopped = true; if (!catchup.runningPhase) catchup.outcome = "stopped"; } }
    // 31: re-enabling opens one supplement generation, whatever the previous state was. `off` opens
    // none and closes none — with memory off the next prompt injects nothing and the generation an
    // earlier command opened simply stays open until a prompt runs with memory on.
    if (value) requestSupplement();
    save();
    reconciledLeaf = undefined; reconciled = undefined; // 22b: the enrollment switch reconciles from the start too
    if (value) { reconcile(false); save(); }
    showSpend(ctx);
    const { lines, recovery, cost, shared } = sessionSummary();
    const notice = statusBody([...recovery, ...lines, cost, ...shared], Math.max(1, (process.stdout.columns ?? 100) - 2));
    ctx.ui.notify(`${notice}\n${value ? "Available history, including the paused interval, is queued; ordinary completions check thresholds." : "Processing and future injection are paused. Stored memory and already-injected text remain."}`, "info");
  };
  // ---- 24b: the command surface ----
  // Amendment 1 (user ruling 2026-09-09): seven documented forms, no hidden aliases. `enable`,
  // `disable`, `status` and `runs` are retired — status and runs live in the menu's Current session —
  // while `project`, `catchup`, `stop` and `mark` stay as command forms because `-p`/rpc sessions have
  // no menu at all. The menu is the primary surface for those four; these are not aliases of it but
  // the same operations, and both paths call the same functions below.
  const commands = "/trace (menu; status when headless) | /trace on | /trace off | /trace catchup | /trace stop | " +
    "/trace project <name> | /trace mark K<n>[@<commit>] verified|flagged|clear";
  const retiredForms: Record<string, string> = {
    enable: "/trace on", disable: "/trace off",
    status: "the menu's Current session (headless: bare /trace)", runs: "the menu's Current session > Runs",
  };
  const markAddress = /^K[1-9]\d*(?:@[1-9]\d*)?$/;
  const markKinds = ["verified", "flagged", "clear"];
  const runView = (limit = 10) => {
    const runs = state.sessionId ? memory.store.listRuns(state.sessionId).slice(-limit).reverse() : [];
    ctx.ui.notify(runs.length ? runs.map(r => memory.trace(`R${r.id}`).split("\n")[0]!).join("\n") : "Trace Memory: no runs yet.", "info");
  };
  /** Project assignment, shared by the command form and the menu. Unchanged rules: an allocated
   * session and an explicit name; the menu selection replaces the old command only as the way the
   * intent is expressed, never the project-sharing rules themselves. */
  const assignProject = (name: string) => {
    if (!state.sessionId) throw new Error("A session requires an assistant reply");
    const marked = memory.declareProject(state.sessionId, name);
    state.projectId = memory.store.getSession(state.sessionId)!.projectId;
    state.project = memory.store.getProject(state.projectId)!.name;
    // 31: the new project's applicable knowledge reaches this conversation at the next prompt, as one
    // supplement of what it does not already hold — the single exception to 29d's rule that the
    // foreground learns background results only through a later compaction or an explicit read.
    requestSupplement();
    save();
    ctx.ui.notify(marked, "info");
  };
  /** Knowledge marks, shared by the command form and the menu: core keeps exact-commit handling and
   * rejects an ambiguous address on divergent tips, from either surface. */
  const applyMark = (address: string, kind: "verified" | "flagged" | "clear") =>
    ctx.ui.notify(memory.mark(address, kind, state.sessionId ? { sessionId: state.sessionId, headTurnId: state.head ?? null } : undefined), "info");

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
    memory.configure({ closedSessionScope: effective.closedSessionScope, noting: { forkModeDefault: effective.noting.forkModeDefault },
      consolidation: { forkModeDefault: effective.consolidation.forkModeDefault } });
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
        (configuredMode(flat, p.phase) === "fork" ? `, and ${p.phase === "noting" ? "Noting" : "Consolidation"} is configured for fork mode, whose child keeps inheriting the foreground level` : "") +
        ". Applies to tasks admitted from now on; running tasks keep their level.", thinkingChoices);
      if (choice === undefined) return;
      saveGlobal(p, choice);
      return;
    }
    const follow = "Follow foreground";
    const models = availableModels();
    if (!models.length) { ctx.ui.notify(`Trace Memory: ${p.name} unchanged — Pi's model registry lists no available model.`, "warning"); return; }
    const title = configuredMode(flat, p.phase) === "fork"
      ? `${p.name} — ${p.phase === "noting" ? "Noting" : "Consolidation"} is configured for fork mode, which inherits the foreground model ${foregroundModel()}; this choice is used by subagent runs`
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
  const settingsMenu = async () => {
    // 24c's disclosure keeps its home here: where new worker logs go is a global fact about this
    // installation, and the settings entry is where the superseded read-only view stated it.
    const logs = `Worker logs: ${runsDirectory(state.piId)}${runsOutsideScan() ? " — outside Pi's scanned sessions tree, so file-based daily statistics do not see them" : ""}`;
    const title = ["Settings — global defaults, saved under \"trace-memory\" in " + settingsFile,
      "Project and environment layers still take precedence; advanced values stay in the settings files.", logs].join("\n");
    const lines = preferences.map(p => preferenceLine(p, { flat, sources, layers }, foregroundModel()));
    const choice = await ctx.ui.select(title, lines);
    if (choice === undefined) return; // cancelling an entry or an input changes nothing
    const index = lines.indexOf(choice);
    if (index < 0) return;
    await editPreference(preferences[index]!);
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
        recovery.push(`Automatic off: ${task.phase}, backlog head ${task.head}, ${task.count} failures; last R${task.lastRunId}: ${task.lastReason}. Use /trace on to resume.`);
    } catch { recovery.push("Project / recovery: Unknown (unavailable)"); }
    let cost: string;
    try { cost = `Cost: ${state.sessionId ? `$${memory.spend(state.sessionId).cost.toFixed(4)}` : "N/A (no session)"}`; }
    catch { cost = "Cost: Unknown (unavailable)"; }
    if (compact) lines[0] += ` | ${cost.replace(/^Cost: /, "")}`;
    const downgrade = suppressed();
    if (downgrade) recovery.push(`Fork: suppressed since ${downgrade.at} (cache miss${downgrade.runId ? ` on R${downgrade.runId}` : ""}); Retry fork in the /trace menu`);
    if (lastCompaction) recovery.push(`Compaction: ${lastCompaction}`);
    const catchupStatus = catchupLine();
    if (catchupStatus) recovery.push(catchupStatus);
    const shared = compact ? (state.shared ? ["Shared identity"] : [])
      : [state.shared ? "Shared identity: this switch also affects forks or clones carrying this memory identity."
        : "Forks or clones carrying this memory identity share this switch."];
    return { lines, recovery, cost, shared };
  };
  // Full measurements only on explicit panel/headless status opening, never on toggle confirmation.
  // No reconciliation, compact allocation, tool grants or worker admission.
  const sessionStatus = (compact = false): SessionBody => {
    const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "Model: Unknown";
    const composition = contextComposition(ctx, pi);
    const summary = sessionSummary(compact);
    const lines: (string | ((paint: Parameters<SessionBody>[1]) => string))[] = [...summary.lines];
    const target = state.sessionId && state.head ? { sessionId: state.sessionId, branch: state.branch, headTurnId: state.head } : undefined;
    lines.push(`${compact ? "Pending / trigger (~tokens)" : "Pending: / trigger — estimated tokens"}${enabled() ? "" : " (Off; stored evidence only)"}`);
    for (const phase of ["noting", "consolidation", "dreaming"] as const) {
      const label = phase === "dreaming" ? "Dreaming" : PHASE_LABEL[phase], pending = memory.pendingTokens(phase, target);
      lines.push(paint => pendingBar(label, pending, compact, paint));
    }
    if (!compact) lines.push("Pending / trigger is not task completion or worker readiness.", summary.cost);
    lines.push(...summary.shared);
    return (width, paint) => statusBody([...summary.recovery, ...compositionMap(composition, model, width, paint), ...lines.map(line => typeof line === "string" ? line : line(paint))], width, paint);
  };
  // ---- 24b: the menu ----
  const sessionMenu = async () => {
    const shared = state.shared ? " Shared identity: this switch also affects forks or clones carrying this memory identity." : " Forks or clones carrying this memory identity share this switch.";
    // 19c "Menu-only reset": Retry fork exists only while this session is automatically downgraded.
    // No slash subcommand and no permanent menu item; it clears the suppression only.
    const downgrade = suppressed();
    const participation = enabled() ? "Off" : "On";
    const body = sessionStatus(true);
    const actions = [participation, "Runs", "Project", "Mark", ...(downgrade ? ["Retry fork"] : [])];
    const choice = ctx.mode === "tui" ? await showSessionPanel(ctx, body, actions)
      : await ctx.ui.select(`Current session\n${body(Math.max(1, (process.stdout.columns ?? 100) - 2))}`, actions);
    if (choice === undefined) return; // cancellation is inert: no write, no request
    if (choice === "Retry fork") {
      memory.store.clearForkSuppression(state.sessionId!);
      cacheMisses.delete(state.sessionId!);
      showSpend(ctx);
      ctx.ui.notify("Trace Memory: fork retry enabled for this session. The next memory task may request fork again; no task was started and global settings are unchanged.", "info");
      return;
    }
    if (choice === "Runs") {
      const count = await ctx.ui.input("Runs: number to show", "10");
      if (count !== undefined) runView(Math.max(1, Number(count) || 10));
      return;
    }
    if (choice === "Project") {
      if (!state.sessionId) { ctx.ui.notify("Trace Memory: a project assignment requires an assistant reply.", "warning"); return; }
      const name = await ctx.ui.input("Project name (every session declaring this name in this database shares its knowledge)", state.project ?? "");
      if (name === undefined) return;
      if (!String(name).trim()) { ctx.ui.notify("Trace Memory: no project name given; nothing changed.", "warning"); return; }
      try { assignProject(String(name).trim()); } catch (error) { ctx.ui.notify(String(error), "error"); }
      return;
    }
    if (choice === "Mark") {
      const address = await ctx.ui.input("Knowledge address: K<n>, or K<n>@<commit> for an exact revision", "K1");
      if (address === undefined) return;
      const target = String(address).trim();
      if (!markAddress.test(target)) { ctx.ui.notify(`Trace Memory: ${target || "(empty)"} is not a knowledge address; use K<n> or K<n>@<commit>. Nothing changed.`, "warning"); return; }
      const kind = await ctx.ui.select(`Mark ${target}`, markKinds);
      if (kind === undefined) return;
      try { applyMark(target, kind as "verified" | "flagged" | "clear"); } catch (error) { ctx.ui.notify(String(error), "error"); }
      return;
    }
    if (choice === participation && await ctx.ui.confirm(`Turn Trace Memory ${participation.toLowerCase()} for this session?`, shared + (participation === "Off"
      ? " Processing and future injection stop; stored memory and already-injected text remain."
      : " Available history, including the paused interval, will be queued without a model call."))) toggle(participation === "On");
  };
  const menu = async () => {
    const selected = await ctx.ui.select("Trace Memory", ["Current session", "Catch up", "Stop", "Settings"]);
    if (selected === "Current session") await sessionMenu();
    else if (selected === "Catch up") { try { startCatchup(); } catch (error) { ctx.ui.notify(String(error), "error"); } }
    else if (selected === "Stop") stopCatchup();
    else if (selected === "Settings") await settingsMenu();
  };
  pi.registerCommand("trace", { description: "Trace Memory: menu, session participation (on/off), catchup/stop, project assignment and knowledge marks.",
    async handler(args, context) {
      ensure(context);
      const parts = args.trim() ? args.trim().split(/\s+/) : [];
      // Bare `/trace` opens the menu; without dialog-capable UI (`-p`, rpc scripting) it prints the
      // status the menu would have shown and the forms that replace the retired subcommands.
      if (!parts.length) { if (context.hasUI) await menu(); else context.ui.notify(`Current session\n${sessionStatus()(Math.max(1, (process.stdout.columns ?? 100) - 2))}\n${commands}`, "info"); return; }
      const [verb, ...rest] = parts;
      if ((verb === "on" || verb === "off") && !rest.length) { toggle(verb === "on"); return; }
      if (verb === "catchup" && !rest.length) { startCatchup(); return; }
      if (verb === "stop" && !rest.length) { stopCatchup(); return; }
      if (verb === "project" && rest.length) { assignProject(rest.join(" ")); return; }
      if (verb === "mark" && rest.length === 2 && markAddress.test(rest[0]!) && markKinds.includes(rest[1]!)) {
        applyMark(rest[0]!, rest[1] as "verified" | "flagged" | "clear"); return;
      }
      // A retired subcommand and a malformed argument end in the same place: the usage, and no
      // mutation. Retirement is documented rather than aliased — the old spelling does nothing.
      const retired = retiredForms[verb!];
      context.ui.notify(`Trace Memory: /trace ${parts.join(" ")} is not a command form.` +
        (retired ? ` \`${verb}\` was retired; use ${retired}.` : "") + `\n${commands}\nNothing was changed.`, "warning");
    } });
}
