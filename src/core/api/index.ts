export { toolDefinitions, toolRejected, validateReadInput } from "./tools.ts";
import { bindTools, type ToolContext, type ToolDefinition } from "./tools.ts";
export type { ToolContext, ToolDefinition } from "./tools.ts";
import { readFacade, type ListingOptions, type SearchScope, type CompactResult, type Injection, type TopicGroups } from "./read.ts";
export type { ListingOptions, SearchScope, CompactResult, Injection, TopicGroups } from "./read.ts";
// 29a "One derived view": the pure visibility projection over a host's own retained context entries.
import type { VisibleView } from "./visible.ts";
export { noVisibility, visibleView } from "./visible.ts";
export type { Carrier, ContextEntry, InitialContext, SuppliedEntry, SuppliedMaterial, VisibleBinding, VisibleView } from "./visible.ts";
// Hosts use this façade; persistence remains entirely in core/store.
import { randomUUID } from "node:crypto";
import { freezeNoting, notingBatch, notingPending, runNoting, NOTING_MEMBERSHIP, type NotingInput, type NotingResult } from "../noting/index.ts";
import { finish, renderFact, renderFactGroups, renderRun, renderTrace, renderKnowledgeTrace, renderKnowledgeDiff, renderCommitHistory, renderNegationWalk, type NegationStep, type TurnOptions } from "../render/index.ts";
import { tokens, renderEntry, rawResultText, type ResultExtractor } from "../render/index.ts";
export { tokens, renderEntry, renderEntryWhole, rawResultText, finish, runMode, ENTRY_VIEW_VERSION } from "../render/index.ts";
export type { EntryProfile, ResultText, ResultExtractor } from "../render/index.ts";
// 20a: core owns the domain text of every memory consumer. A host places this text; it does not lay
// out knowledge, facts or Raw itself.
export { notingText, consolidationText, injectionText, compactText, knowledgeBlock } from "../render/material.ts";
export type { SharedMaterial, KnowledgeGroup, TaskRange } from "../render/material.ts";
export { enrollmentDefault } from "../store/index.ts";
export type { Enrollment, ClosedSessionScope } from "../store/index.ts";
export type { SourceInput, SourceEntry, TaskTarget } from "../store/index.ts";
export type { NotingInput, NotingResult, NotingAgentInput, NotingMaterial, EntryAudit } from "../noting/index.ts";
export { NOTING_CAPACITY, NOTING_INCOMPLETE, NOTING_MEMBERSHIP } from "../noting/index.ts";
import { Store, type SourceInput, type SourceEntry, type KnowledgePath, type Phase, type TaskClaim, type TaskTarget, type ClosedSessionScope } from "../store/index.ts";

import { freezeConsolidation, runConsolidation, type ConsolidateInput, type ConsolidateResult } from "../consolidation/index.ts";
export type { ConsolidateInput, ConsolidateResult, ConsolidationAgentInput, ConsolidationMaterial, ConsolidationRange, NearPair, ConsolidationDiagnostic } from "../consolidation/index.ts";


// ---- Flat config, defaults in one place (spec.md: render budgets, noting/consolidation triggers and modes) ----

export interface TraceMemoryConfig {
  closedSessionScope: ClosedSessionScope;
  render: {
    /** Ticket 23 tier 1: `B`, the most one tool call is worth (ceiling `TOOL_CALL_CEILING`). */
    toolCallTokens: number;
    /** Ticket 23 tier 1: `E`, the most one entry is worth. */
    entryTokens: number;
    /** Ticket 23 tier 2 (compaction only): the same two numbers, tighter. */
    secondaryToolCallTokens: number;
    secondaryEntryTokens: number;
    knowledgeBlockTokens: number;
    episodicBlockTokens: number;
  };
  noting: {
    /** Inherited-context execution by default (ticket 19: fork, formerly branch). */
    forkModeDefault: boolean;
    batchTokens: number;
    triggerTokens: number;
    /** Tool rounds a run may take before it fails; 0 = unlimited (the model stops when it stops). */
    maxToolRounds: number;
  };
  consolidation: {
    /** Ticket 20: rendered tokens of applicable unconsolidated facts that make a run due. */
    triggerTokens: number;
    /** Ticket 20: the most rendered fact tokens one batch may select. */
    batchTokens: number;
    nearThreshold: number;
    maxToolRounds: number;
  };
}

export const DEFAULT_CONFIG: TraceMemoryConfig = {
  closedSessionScope: "project",
  render: {
    toolCallTokens: 300,
    entryTokens: 10_000,
    secondaryToolCallTokens: 100,
    secondaryEntryTokens: 1_000,
    knowledgeBlockTokens: 10_000,
    episodicBlockTokens: 20_000,
  },
  noting: {
    forkModeDefault: true,
    batchTokens: 10_000,
    triggerTokens: 10_000,
    maxToolRounds: 0,
  },
  consolidation: {
    triggerTokens: 5_000,
    batchTokens: 10_000,
    nearThreshold: 0.28,
    maxToolRounds: 0,
  },
};

export type ConfigOverride = {
  closedSessionScope?: ClosedSessionScope;
  render?: Partial<TraceMemoryConfig["render"]>;
  /** `branchModeDefault` is the accepted legacy spelling of `forkModeDefault` (CONFIG_ALIASES). */
  noting?: Partial<TraceMemoryConfig["noting"]> & { branchModeDefault?: boolean };
  consolidation?: Partial<TraceMemoryConfig["consolidation"]>;
};

/** Legacy configuration spellings accepted at the boundary, `section.key` on both sides (ticket 19
 * "Legacy input"). The execution mode was renamed from branch to fork; the old key still selects the
 * new one so an existing settings.json keeps working. Only the canonical spelling is ever emitted.
 * One table for core and for every host: the flat `section.key` settings space (hosts/pi) and the
 * nested `ConfigOverride` (the façade) resolve the alias through the same two functions below. */
export const CONFIG_ALIASES: Readonly<Record<string, string>> = { "noting.branchModeDefault": "noting.forkModeDefault" };

/** Ticket 25 amendment 2: Consolidation has exactly one execution mode, so the preference that used
 * to choose one is removed rather than reinterpreted. This one sentence is the whole remedy, and the
 * explicit request guard in `execute` states it too: a caller who asks for the retired mode — in a
 * settings file or in a task — deletes the key instead of being silently normalized. */
export const CONSOLIDATION_SUBAGENT_ONLY = "Consolidation always runs as a subagent; delete the key";

/** Settings a ruling removed, and the remedy for each (ticket 20 "Configuration"). A removed key is
 * not an alias: an old fact count is never reinterpreted as tokens, so any layer supplying one fails
 * the load naming the key and what to do about it. The same two functions below enforce it for the
 * flat `section.key` settings space and for the nested `ConfigOverride`, and the read-only menu shows
 * it nowhere, because it builds itself from `DEFAULT_CONFIG`. Most remedies are a replacement key
 * ("use …"); a setting whose choice no longer exists says so instead. */
export const REMOVED_SETTINGS: Readonly<Record<string, string>> = {
  "consolidation.triggerUnconsolidatedFacts": "use consolidation.triggerTokens (tokens, not a count)",
  // Ticket 25b: the fork preference of a phase that only ever runs as a subagent now. Historical
  // fork-mode runs keep their recorded mode; no file is rewritten and no request is normalized.
  "consolidation.subagentModeDefault": CONSOLIDATION_SUBAGENT_ONLY,
  // Ticket 23: the stdout/stderr branch they budgeted reads a result shape Pi never produces, so they
  // were never effective on any Pi run; the uniform entry rule and `render.toolCallTokens` replace them.
  "render.stdoutHeadTokens": "use render.toolCallTokens (one budget for the whole tool call)",
  "render.stdoutTailTokens": "use render.toolCallTokens (one budget for the whole tool call)",
  "render.stderrTailTokens": "use render.toolCallTokens (one budget for the whole tool call)",
  // Ticket 23b: the per-tool branches of the explicit Turn preview they budgeted are gone — an
  // explicit `trace` without `full` is the entry view under the tier-1 profile, and `full` renders
  // the stored evidence uncut, so neither has a budget of its own any more.
  "render.commandTokens": "use render.toolCallTokens (one budget for the whole tool call)",
  "render.reportHeadTokens": "use render.toolCallTokens (one budget for the whole tool call)",
  "render.reportTailTokens": "use render.toolCallTokens (one budget for the whole tool call)",
};
const removedSetting = (key: string) => new Error(`Removed setting ${key}: ${REMOVED_SETTINGS[key]}`);

const aliasConflict = (legacy: string, canonical: string, legacyValue: unknown, canonicalValue: unknown) =>
  new Error(`Conflicting settings ${legacy} and ${canonical}: ${JSON.stringify(legacyValue)} vs ${JSON.stringify(canonicalValue)}; ` +
    `${legacy} is the legacy spelling of ${canonical} — supply ${canonical} alone`);

/** Map the legacy keys of one flat `section.key` configuration layer onto their canonical names,
 * keeping the layer's other keys and their order. The canonical value wins when both spellings are
 * supplied; the same layer supplying both with different values is a load error naming both keys
 * (18a: a configuration problem is reported by name, never silently resolved). Layers themselves
 * still mask one another as before, so a project layer may override a global legacy spelling. */
export function canonicalFlatConfig<T extends Record<string, unknown>>(values: T): T {
  let result: Record<string, unknown> = values;
  for (const key of Object.keys(REMOVED_SETTINGS)) if (Object.hasOwn(result, key)) throw removedSetting(key);
  for (const [legacy, canonical] of Object.entries(CONFIG_ALIASES)) {
    if (!Object.hasOwn(result, legacy)) continue;
    const legacyValue = result[legacy], present = Object.hasOwn(result, canonical);
    if (present && result[canonical] !== legacyValue) throw aliasConflict(legacy, canonical, legacyValue, result[canonical]);
    const { [legacy]: _dropped, ...rest } = result;
    result = { ...rest, [canonical]: present ? result[canonical] : legacyValue };
  }
  return result as T;
}

/** The same rule for the nested override the façade takes. */
export function canonicalConfig(override: ConfigOverride): ConfigOverride {
  let result: Record<string, unknown> = override;
  for (const key of Object.keys(REMOVED_SETTINGS)) {
    const section = key.slice(0, key.indexOf(".")), values = result[section] as Record<string, unknown> | undefined;
    if (values && typeof values === "object" && Object.hasOwn(values, key.slice(section.length + 1))) throw removedSetting(key);
  }
  for (const [legacy, canonical] of Object.entries(CONFIG_ALIASES)) {
    const section = legacy.slice(0, legacy.indexOf("."));
    const legacyKey = legacy.slice(section.length + 1), canonicalKey = canonical.slice(canonical.indexOf(".") + 1);
    const values = result[section] as Record<string, unknown> | undefined;
    if (!values || typeof values !== "object" || Array.isArray(values) || !Object.hasOwn(values, legacyKey)) continue;
    const legacyValue = values[legacyKey], present = Object.hasOwn(values, canonicalKey);
    if (present && values[canonicalKey] !== legacyValue) throw aliasConflict(legacy, canonical, legacyValue, values[canonicalKey]);
    const { [legacyKey]: _dropped, ...rest } = values;
    result = { ...result, [section]: { ...rest, [canonicalKey]: present ? values[canonicalKey] : legacyValue } };
  }
  return result as ConfigOverride;
}

function mergeConfig(base: TraceMemoryConfig, override: ConfigOverride): TraceMemoryConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("Invalid configuration: expected an object");
  override = canonicalConfig(override);
  for (const [section, values] of Object.entries(override)) {
    if (!Object.hasOwn(base, section)) throw new Error(`Unknown setting ${section}`);
    if (section === "closedSessionScope") continue;
    const defaults = base[section as Exclude<keyof TraceMemoryConfig, "closedSessionScope">];
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`Invalid ${section}: expected an object`);
    for (const key of Object.keys(values)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting ${section}.${key}`);
  }
  return {
    closedSessionScope: override.closedSessionScope === undefined ? base.closedSessionScope : override.closedSessionScope,
    render: { ...base.render, ...override.render },
    noting: { ...base.noting, ...override.noting },
    consolidation: { ...base.consolidation, ...override.consolidation },
  };
}

/** Ticket 23: `B` has a hard upper bound — the 17a default — and is rejected above it, in either
 * profile. A per-call budget larger than that is the volume problem this ticket exists to remove. */
export const TOOL_CALL_CEILING = 1_000;

export function validateConfig(override: ConfigOverride): TraceMemoryConfig {
  const cfg = mergeConfig(DEFAULT_CONFIG, override);
  if (!["off", "project", "global"].includes(cfg.closedSessionScope)) throw new Error("Invalid closedSessionScope: expected off, project or global");
  for (const section of ["render", "noting", "consolidation"] as const) for (const [key, value] of Object.entries(cfg[section])) {
    const name = `${section}.${key}`;
    if (key.endsWith("ModeDefault")) {
      if (typeof value !== "boolean") throw new Error(`Invalid ${name}: expected boolean`);
    } else if (key === "nearThreshold") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid ${name}: expected a similarity between 0 and 1`);
    } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (key === "maxToolRounds" ? 0 : 1)) {
      throw new Error(`Invalid ${name}: expected ${key === "maxToolRounds" ? "a nonnegative" : "a positive"} safe integer`);
    }
    if (/toolCallTokens$/i.test(key) && (value as number) > TOOL_CALL_CEILING) throw new Error(`Invalid ${name}: at most ${TOOL_CALL_CEILING}`);
  }
  return cfg;
}

// ---- runAgent contract (spec.md: Contracts, Run record contract) ----

export interface RunAgentResult {
  outcome: "success" | "failure" | "cancelled";
  output: unknown;
  usage?: unknown;
  request?: unknown;
  mode?: "fork" | "subagent";
  /** A host that cannot expose the provider request declares the limitation here instead of
   * returning `request`; core records it in the run record rather than reporting a missing request.
   * A host expected to capture a payload and returning none still gets the audit problem (19b). */
  audit?: { available: false; reason: string };
  verification?: unknown;
  fallbackReason?: string;
  /** 27c (parent 27 "Per-task fork fallback"): the host would not run this frozen task in the mode it
   * was admitted for — a fork its launch, its gate or the provider's context limit refused — and it
   * admits the task once more itself, on the model that will run it. Nothing was committed and no run
   * is recorded for this attempt: the value is opaque to core, which returns it to the caller with
   * `outcome: "dropped"` so what the attempt produced is charged to the run the re-admission makes,
   * and one task keeps one run record. */
  refused?: unknown;
  /** Absolute path of the host's native worker log for this run, when the host writes one (19a). */
  nativeLog?: string;
  /** Transient provider errors retried by the host before this reply, in order. */
  retries?: { attempt: number; error: string }[];
  /** 26b: the thinking level this run asked for — the level frozen at admission — and the level the
   * host's runtime actually ran at after clamping it to the worker model. Recorded side by side in
   * the run audit, so a clamp is visible instead of silent. */
  thinking?: { requested?: string; effective: string };

}

/** 27d repair 4: the reason a re-admission cancelled between its refusal and this call is dropped
 * with. It launches nothing, records nothing and — the host reads this value for exactly that —
 * warns nothing, because the user who cancelled asked for no further work, not for a notice. */
export const CANCELLED_BEFORE_FALLBACK = "cancelled before fallback";

/** A frozen target: `maxEntryId` bounds Noting to entries allocated no later than a manual catchup's
 * freeze instant; `factIds` bounds Consolidation to the frozen pending-plus-produced fact set.
 * Absent, selection is the ordinary unbounded pending set (18b).
 *
 * 27d (parent 27 amendment 6): `entryIds` is Noting's *exact membership* form — the same shape
 * `factIds` already is — and it is what a fork fallback re-admits on. An upper bound prevents later
 * arrivals from joining but permits a smaller batch, which is a membership change after execution
 * started; under `entryIds` the freeze takes exactly those entries or the task stays pending. */
export interface TaskBoundary { maxEntryId?: number; entryIds?: number[]; factIds?: number[] }
export interface TaskOptions {
  borrowed?: boolean; automatic?: boolean; executorSessionId?: number; boundary?: TaskBoundary;
  /** The mode the host will actually run this task in when it differs from the requested `mode`
   * (a requested fork resolved to subagent by the host's cache-miss latch). Capacity and material
   * follow it; the requested mode is still recorded (review 2026-09-08). */
  effectiveMode?: "fork" | "subagent";
  /** 26b: the runtime thinking level the host froze for this task at admission, beside its model.
   * Opaque to core, which only hands it back with the frozen task; the host's runtime resolves and
   * clamps it. Absent when the host has no such notion. */
  thinkingLevel?: string;
  /** 26d: the second level the host froze, for the same task's fresh-context execution (its own
   * setting, or the inherited one). Equally opaque: core carries it and never reads it. */
  subagentThinkingLevel?: string;
  /** 27b: why the host re-admitted this task without its inherited context — the fork's own capacity
   * refused the batch, or the host has no measure to fork from. Present only on that second
   * admission, which still requests `mode: "fork"` so the audit keeps what was configured while
   * `effectiveMode` prices and runs the fresh child. Opaque to core, like `thinkingLevel`: core hands
   * it back with the frozen task and it becomes the run's `fallbackReason`. */
  fallbackReason?: string;
  /** 27c: the refusal of this task's previous attempt, handed back by the host on the re-admission so
   * the run that does happen keeps the gate result of an attempt that recorded no run of its own.
   * Opaque to core, like `fallbackReason`: carried to the frozen task and never read. */
  forkAttempt?: unknown;
  /** 27d repair 4 (parent 27 line 83): the cancellation generation this task was first admitted
   * under, as core handed it to the host with that task. Core's own value, not an opaque one: a
   * re-admission carrying a generation older than the current one was cancelled between the refusal
   * and this call, and is dropped without launching anything. */
  cancellation?: number;
  /** 29b "Same builder, different initial state": what the child this task will run in already holds,
   * as the host derived it from that child's own starting context (29a's `visibleView`). Present only
   * for a task the host will really run with an inherited context; a fresh child — an explicit
   * subagent, a fork re-admitted as one after a refusal — carries none and its material is built from
   * the empty view. Core reads it to subtract, never to decide the mode. */
  visible?: VisibleView;
}
export interface AgentControl {
  signal?: AbortSignal;
  reportProgress?: (progress: Partial<RunAgentResult>) => void;
  /** 26b: the level frozen at admission (`TaskOptions.thinkingLevel`), returned to the host with the
   * frozen task so a level changed while the run is in flight cannot reach it. */
  thinkingLevel?: string;
  /** 26d: the same, for the task's fresh-context execution (`TaskOptions.subagentThinkingLevel`). */
  subagentThinkingLevel?: string;
  /** 27b: the reason frozen at admission (`TaskOptions.fallbackReason`), returned to the host with
   * the frozen task so this run launches no fork whatever the host's live state says now. */
  fallbackReason?: string;
  /** 27c: the previous attempt's refusal (`TaskOptions.forkAttempt`), returned with the frozen task
   * so this run's record keeps the gate result of an attempt that recorded no run of its own. */
  forkAttempt?: unknown;
  /** 27d: core's cancellation generation, frozen at this admission. A host that returns a refusal
   * carries it back with the re-admission (`TaskOptions.cancellation`), which is what fences a task
   * cancelled while its attempt was in flight. */
  cancellation?: number;
}

export type RunAgent = (input: unknown) => Promise<RunAgentResult>;

// ---- Façade ----

export interface TraceMemory {
  readonly store: Store;
  readonly executorId: string;
  /** Ticket 23 "Host contract": the result-text extractor this host registered at construction. Core
   * applies it wherever it renders an entry and never inspects envelope fields itself. */
  readonly resultText: ResultExtractor;
  taskEligibility(phase: Phase, target: TaskTarget): { due: boolean };
  /** Fence owned tokens before requesting cancellation; stopping prevents later admission. */
  cancelTasks(stopping?: boolean): void;
  /** End local waits at teardown's deadline; provider promises remain rejection-handled. */
  forceTasks(): void;
  readonly config: TraceMemoryConfig;
  /** Ticket 24 amendment 2: the one runtime configuration surface. A saved global preference must
   * reach tasks admitted afterwards without a reload, and admission reads its execution mode from
   * this configuration. Only `noting.forkModeDefault` and `closedSessionScope` may be replaced here
   * (25b retired Consolidation's mode preference, so a `consolidation` section is refused),
   * validated like the load path. Other keys are refused: this is not a second configuration source
   * and reloads nothing. Admitted tasks retain their frozen mode and borrowing scope. */
  configure(settings: ConfigOverride): void;
  close(): void;
  appendEntry(input: SourceInput): SourceEntry;
  selectEntries(sessionId: number, branch: string, entryIds: number[]): void;
  pendingEntries(sessionId: number, branch: string, headTurnId: number): SourceEntry[];
  /** Ticket 29c: the entries a Noting freeze of this target would really select — the pending set the
   * boundary admits, cut to the oldest prefix that fits `noting.batchTokens` — without freezing,
   * claiming or diagnosing anything. The Pi host decides a fork's Raw availability against exactly
   * this set, so admission and the freeze can never disagree about which entries the task is about. */
  notingBatch(target: TaskTarget, boundary?: TaskBoundary): SourceEntry[];
  tools(context: ToolContext): ToolDefinition[];
  noting(input: NotingInput): Promise<NotingResult>;
  consolidate(input: ConsolidateInput): Promise<ConsolidateResult>;
  /** Committed lineage facts and unrecorded raw, without dropping facts. */
  branchSummary(sessionId: number, branch: string, headTurnId: number): string;
  /** Ticket 20: the escalating compaction result — primary views, secondary views, or the explicit
   * ask that the host decline and let its native compaction run (20c). */
  compact(sessionId: number, branch?: string, headTurnId?: number): CompactResult;
  /** Ticket 21b: the path-selected applicable knowledge grouped by topic, as commit references; a
   * read projection only — it neither reorders injection nor changes what is applicable. */
  topicGroups(sessionId: number, headTurnId?: number | null, branch?: string): TopicGroups;
  /** A session id after the first reply; before it exists (first prompt), the project alone: global + project knowledge. */
  inject(target: number | { projectId: number } | KnowledgePath): string;
  /** 29a: the same block with the commit ids it kept, for the carrier the host writes on the message
   * it persists. `inject` is this call read for its text alone. */
  injection(target: number | { projectId: number } | KnowledgePath): Injection;
  trace(address: string, options?: ListingOptions): string;
  search(query: string, scope?: SearchScope, options?: ListingOptions & { sessionId?: number }): string;
  mark(address: number | string, kind: "verified" | "flagged" | "clear", path?: KnowledgePath): string;
  declareProject(sessionId: number, name: string, source?: "marker" | "mark"): string;
  status(sessionId: number, branch?: string, headTurnId?: number | null): string;
  /** Ticket 24a: the four footer counts of one session's selected branch and head — entries still to
   * note, applicable committed facts, those not yet consolidated, and applicable current knowledge.
   * Progress/applicability queries over one path snapshot: no Raw, no tokenizing, no freeze, no run
   * body, and pending work stays pending until its business commit. */
  progress(sessionId: number, branch?: string, headTurnId?: number | null): { entries: number; facts: number; unconsolidated: number; knowledge: number };
  /** Model spend of one session's runs: run counts by kind, token totals and cost (user ruling: the footer shows the session cumulative). */
  spend(sessionId: number): { runs: { noting: number; consolidation: number; manual: number }; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
}

export function TraceMemory(dbPath: string, runAgent: RunAgent, config: ConfigOverride = {},
  /** Ticket 23: the host's one result-text extractor, registered here (default: the stored string). */
  resultText: ResultExtractor = rawResultText): TraceMemory {
  const cfg = validateConfig(config);
  const store = new Store(dbPath);
  const executorId = randomUUID();
  let stopping = false;
  const tasks = new Set<{ controller: AbortController; force(): void; close(): void }>();
  // 27d repair 4 (parent 27 line 83): the cancellation generation. Every cancellation advances it,
  // stop or not — `/trace stop` cancels without stopping, and a task cancelled that way must not
  // come back through a fork fallback either. Admission freezes it with the task, the host carries
  // it in the refusal, and the re-admission below compares. It fences the window `stopping` cannot:
  // a task whose attempt was already in flight, whose abort raced the provider's own answer.
  let cancellation = 0;
  const cancelTasks = (stop = false) => {
    stopping ||= stop;
    cancellation++;
    try { if (!store.closed) { if (stop) store.beginShutdown(); store.invalidateExecutor(executorId); } }
    finally { for (const task of tasks) { task.close(); task.controller.abort(); } }
  };
  const trace = (address: string, display: ListingOptions = {}): string => {
    const [target, ...flags] = address.trim().split(/\s+/);
    const invalid = () => new Error(`invalid trace address: ${address}`);
    const knowledgeMatch = /^K([1-9]\d*)(?:@([1-9]\d*)(?:\.\.K([1-9]\d*)@([1-9]\d*))?|(\.\.))?$/.exec(target ?? "");
    if (knowledgeMatch) {
      const [id, from, other, to] = knowledgeMatch.slice(1, 5).map(n => n === undefined ? undefined : Number(n));
      if (flags.length || [id, from, other, to].some(n => n !== undefined && !Number.isSafeInteger(n)) ||
          (other !== undefined && other !== id)) throw invalid();
      const knowledge = store.getKnowledge(id!);
      if (!knowledge) throw new Error(`knowledge K${id} does not exist`);
      const history = store.listKnowledgeRevisions(id!);
      const commit = (commitId: number) => {
        const value = store.getKnowledgeRevision(id!, commitId);
        if (!value) throw new Error(`commit K${id}@${commitId} does not exist`);
        return value;
      };
      const describe = (r: typeof history[number]) => renderKnowledgeTrace({ knowledge, revision: r }, store.listKnowledgeMarks(id!), store.commitParents(r), store.commitChildren(r));
      if (to !== undefined) {
        const a = commit(from!), b = commit(to);
        const ancestors = (tip: typeof a) => {
          const ids = new Set<number>(), pending = [tip];
          while (pending.length) {
            const r = pending.pop()!;
            if (ids.has(r.id)) continue;
            ids.add(r.id); pending.push(...store.commitParents(r));
          }
          return ids;
        };
        const left = ancestors(a), right = ancestors(b);
        return renderKnowledgeDiff(a, b, history.filter(r => left.has(r.id) !== right.has(r.id)));
      }
      if (from !== undefined) return describe(commit(from));
      if (knowledgeMatch[5]) return `K${id} commit tree (all branches):\n` + history.map(describe).join("\n");
      const path = display.sessionId === undefined ? null : store.knowledgePath(display.sessionId, undefined, display.headTurnId);
      const snapshot = path ? store.pathSnapshot(path) : undefined; // 22c: one membership for the whole read
      const tips = store.currentCommit(id!, path);
      const applicable = history.filter(r => !path || store.commitApplies(r, path, snapshot));
      const otherTips = path ? store.currentCommit(id!).filter(r => !store.commitApplies(r, path, snapshot)) : [];
      return [path ? `K${id} path current: ${tips.map(r => `K${id}@${r.id}`).join(", ") || "none"}`
        : `K${id} tips (newest-created: ${tips.length ? `K${id}@${Math.max(...tips.map(r => r.id))}` : "none"}):`,
        ...tips.map(r => (tips.length > 1 ? `Alternative K${id}@${r.id}${!path && r.id === Math.max(...tips.map(t => t.id)) ? " (newest-created)" : ""}\n` : "") + describe(r)),
        ...(tips.length ? [] : history.map(describe)),
        ...store.listKnowledgeLinks(id!).map(l => `  ${l.kind}: K${l.toKnowledge}@${l.toCommit} (from K${l.fromKnowledge}@${l.fromCommit})`),
        path ? "Applicable history on this path:" : "Commit history:", renderCommitHistory(applicable),
        ...(path ? ["Other branches' tips:", ...otherTips.map(describe)] : [])].join("\n");
    }
    const walkMatch = /^F([1-9]\d*)\.\.$/.exec(target ?? "");
    if (walkMatch) {
      const id = Number(walkMatch[1]);
      if (flags.length || !Number.isSafeInteger(id)) throw invalid();
      const steps: NegationStep[] = [], pending = [{ id, depth: 0 }];
      while (pending.length) {
        const { id, depth } = pending.pop()!;
        const fact = store.getFact(id);
        if (!fact) throw new Error(`fact F${id} does not exist`);
        const relations = store.listFactRelations(id);
        // Later facts have larger allocated IDs; stored edges point newer -> older.
        const children = relations.filter((r) => r.toFact === id && r.fromFact > id && r.kind === "negate" && r.strength === "strong");
        steps.push({ fact, relations, depth, terminal: children.length === 0 });
        for (const child of children.reverse()) pending.push({ id: child.fromFact, depth: depth + 1 });
      }
      return renderNegationWalk(steps);
    }
    const factMatch = /^F([1-9]\d*)$/.exec(target ?? "");
    if (factMatch && !flags.length) {
      if (!Number.isSafeInteger(Number(factMatch[1]))) throw invalid();
      const fact = store.getFact(Number(factMatch[1]));
      if (!fact) throw new Error(`fact ${target} does not exist`);
      return renderFact(fact, store.listFactRelations(fact.id));
    }
    const runMatch = /^R([1-9]\d*)$/.exec(target ?? "");
    if (runMatch) {
      if (flags.length) throw new Error("invalid trace address: use the full parameter");
      const run = store.getRun(Number(runMatch[1]));
      if (!run) throw new Error(`run ${target} does not exist`);
      return renderRun(run, store.listFactsByRun(run.id).map((f) => f.id), store.listCommitsByRun(run.id), display.full === true);
    }
    const turnMatch = /^(?:S([1-9]\d*)\/)?T([1-9]\d*)(?:#(user|assistant|t[1-9]\d*))?$/.exec(target ?? "");
    if (!turnMatch || !Number.isSafeInteger(Number(turnMatch[2]))) throw invalid();
    const sessionOfAddress = turnMatch[1] === undefined ? undefined : Number(turnMatch[1]);
    if (flags.length) throw new Error("invalid trace address: use tool and full parameters");
    const part = turnMatch[3] as TurnOptions["part"];
    if (part && display.tool !== undefined && part !== `t${display.tool}`) throw new Error("source suffix conflicts with tool parameter");
    const options: TurnOptions = { tool: display.tool, full: display.full, part };
    const turn = store.getTurn(Number(turnMatch[2]));
    if (!turn) throw new Error(`turn ${target} does not exist`);
    if (sessionOfAddress !== undefined && turn.sessionId !== sessionOfAddress) throw new Error(`turn ${target} does not exist`);
    const calls = store.listToolCalls(turn.id);
    if (options.tool !== undefined && !calls.some((c) => c.ordinal === options.tool)) throw new Error(`tool #t${options.tool} does not exist in ${target}`);
    // 23b: without `full` the read is this Turn's selected source entries, in path order, each
    // rendered by the entry renderer under the tier-1 profile — 22c's Turn-scoped read is what it
    // assembles, and `branch` (when the caller is bound to one) is what keeps a sibling branch's
    // occurrences out of it.
    // 23c ruling 4: `full` is the same assembly through the renderer's unbounded path and the raw
    // extractor (the stored string as is), and its read scope is unchanged — unrestricted, every
    // native occurrence of the Turn's calls whatever branch selected them (17a), which is also why
    // each occurrence shows as its own entry instead of a merged `multiple results` call.
    // 22c: `entryIds` is a paged read's own frozen occurrence membership for this Turn, supplied
    // instead of a branch; without it the branch selects (never for `full`), exactly as 23b left it.
    const occurrences = display.entryIds
      ? display.entryIds.map(id => store.getSourceEntry(id)).filter(entry => entry !== null)
      : store.listSourceEntries(turn.sessionId, turn.id, options.full ? undefined : display.branch);
    return finish(renderTrace(turn, occurrences, display.profile ?? cfg.render, options, options.full ? rawResultText : resultText));
  };

  const read = readFacade(store, cfg, trace, resultText);
  // Ticket 22b: the pending entries are rendered one at a time and joined with the batch's own
  // separator, and the answer is given as soon as the joined estimate reaches the threshold. The
  // estimate is still of one joined string, exactly as before — independently estimated views are
  // never summed — but the work is bounded by `noting.triggerTokens` instead of by the backlog.
  const notingDue = (target: TaskTarget): boolean => {
    let joined = "";
    for (const id of store.pendingEntryIds(target.sessionId, target.branch, target.headTurnId)) {
      const view = renderEntry(store.getSourceEntry(id)!, cfg.render, resultText).content;
      joined = joined ? `${joined}\n\n${view}` : view;
      if (tokens(joined) >= cfg.noting.triggerTokens) return true;
    }
    return false;
  };
  const consolidationDue = (target: TaskTarget): boolean => {
    const facts = store.consolidationBatch(target.sessionId, target.branch, target.headTurnId);
    return tokens(renderFactGroups(facts, f => renderFact(f, store.listFactRelations(f.id)), store.factTurnTimes(facts)).join("\n")) >= cfg.consolidation.triggerTokens;
  };
  // 29d: eligibility is the trigger threshold and nothing else. The delivery pause that used to hold
  // a fork-mode Noting task until its predecessor's facts had been delivered to the foreground went
  // with the deliveries themselves (parent 29: "Old pending rows cannot pause either phase once the
  // new version stops consuming them"), so the requested mode no longer changes this answer. Phase
  // slots, enrollment, the host's readiness wait and claim checks are untouched.
  const taskEligibility = (phase: Phase, target: TaskTarget) => {
    if (stopping || store.closed || !store.enabled(target.sessionId)) return { due: false };
    return { due: phase === "noting" ? notingDue(target)
      // Ticket 20: the same rendered representation, relations and separator the batch selects with;
      // historical facts and knowledge contribute nothing to the trigger.
      : consolidationDue(target) };
  };
  const execute = async (phase: Phase, input: NotingInput | ConsolidateInput): Promise<NotingResult | ConsolidateResult> => {
    // 25 amendment 2: an explicit request for the retired Consolidation mode is refused by name, with
    // the sentence the removed setting carries. Nothing is normalized to subagent behind the caller.
    if (phase === "consolidation" && (input.mode === "fork" || input.effectiveMode === "fork"))
      throw new Error(`Invalid consolidation mode fork: ${CONSOLIDATION_SUBAGENT_ONLY}`);
    if (stopping || store.closed || !store.enabled(input.sessionId)) return { outcome: "dropped" };
    // 27d repair 4 (parent 27 line 83): "User cancellation, stop, shutdown, claim loss or disabled
    // enrollment must not launch fallback work." A task cancelled between its refusal and this
    // re-admission carries a generation older than the current one: it launches nothing, records
    // nothing and warns nothing. The generation frozen below is what its own refusal would carry.
    if (input.cancellation !== undefined && input.cancellation < cancellation)
      return { outcome: "dropped", reason: CANCELLED_BEFORE_FALLBACK };
    const generation = cancellation;
    const target = { sessionId: input.sessionId, branch: input.branch,
      headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId! };
    const closedSessionScope = cfg.closedSessionScope;
    let claim: TaskClaim | null = null;
    let empty = false, projectId: number;
    let frozen: ReturnType<typeof freezeNoting> | ReturnType<typeof freezeConsolidation> | null;
    try { frozen = store.transaction(() => {
      // Candidate discovery is advisory: recheck the executor and borrowing scope atomically
      // with claim acquisition, before loading a closed target's evidence or constructing material.
      if (input.borrowed && !store.canBorrow(target.sessionId, input.executorSessionId, closedSessionScope)) return null;
      const pendingNow = phase === "noting" ? store.pendingEntries(target.sessionId, target.branch, target.headTurnId)
        : store.consolidationBatch(target.sessionId, target.branch, target.headTurnId);
      const boundary = input.boundary;
      // A frozen manual target (18b) counts only entries/facts inside its snapshot; later arrivals
      // do not turn "empty within the target" into "dropped", nor expand what a batch may take.
      // 27d: `entryIds` is read here exactly as `factIds` already is — none of the frozen members
      // still pending is "empty within the target"; a partial survivor is the drop `freezeNoting`
      // diagnoses below, never a silently smaller batch.
      empty = !boundary ? !pendingNow.length
        : phase === "noting" ? !pendingNow.some(e => (!boundary.entryIds || boundary.entryIds.includes((e as { id: number }).id))
            && (boundary.maxEntryId === undefined || (e as { id: number }).id <= boundary.maxEntryId))
        : !pendingNow.some(f => !boundary.factIds || boundary.factIds.includes((f as { id: number }).id));
      if (empty) return null;
      claim = store.acquireClaim(target, phase, executorId, input.borrowed, () => {
        if (input.executorSessionId !== undefined && !store.enabled(input.executorSessionId)) return false;
        if (!input.automatic || input.borrowed) return true;
        return taskEligibility(phase, target).due;
      });
      if (!claim) return null;
      projectId = store.getSession(input.sessionId)!.projectId;
      const selected = { ...input, ...target, ...(input.borrowed ? { mode: "subagent" as const } : {}) };
      return phase === "noting" ? freezeNoting(store, selected, cfg, resultText) : freezeConsolidation(store, selected, cfg);
    }); } catch (error) {
      // 27d repair 2: a batch frozen on exact membership whose evidence another executor already
      // processed is not an admission failure and not work to retry — the claim that completed it
      // has already been honoured, so this task simply drops, carrying the diagnostic that says so.
      if (error instanceof Error && error.message.startsWith(NOTING_MEMBERSHIP)) return { outcome: "dropped", reason: error.message };
      throw new Error(error instanceof Error ? error.message : String(error), { cause: "task admission" });
    }
    if (!frozen || !claim) return { outcome: empty ? "empty" : "dropped" };
    const controller = new AbortController();
    let force!: () => void;
    const forced = new Promise<RunAgentResult>(resolve => { force = () => resolve({ ...progress, outcome: "cancelled", output: "executor cleanup deadline; provider completion and remaining usage unknown" }); });
    const progress: Partial<RunAgentResult> = {};
    const task = { controller, force, close: () => {} };
    tasks.add(task);
    const bind = (context: ToolContext, run: import("../store/index.ts").RunInput, review?: import("../consolidation/memory.ts").MemoryReview) => {
      run.claim = claim!; run.projectId = projectId; run.executorSessionId = input.executorSessionId;
      if (input.borrowed) run.closedSessionScope = closedSessionScope;
      const binding = bindTools(store, read, context, run, review);
      task.close = binding.close;
      return binding;
    };
    const agent: RunAgent = raw => {
      controller.signal.throwIfAborted();
      return Promise.race([runAgent({ ...raw as object, signal: controller.signal, thinkingLevel: input.thinkingLevel, subagentThinkingLevel: input.subagentThinkingLevel, fallbackReason: input.fallbackReason, forkAttempt: input.forkAttempt, cancellation: generation,
        reportProgress: (value: Partial<RunAgentResult>) => { Object.assign(progress, value); } }), forced]);
    };
    let result: NotingResult | ConsolidateResult | undefined;
    try {
      result = phase === "noting"
        ? await runNoting(store, frozen as ReturnType<typeof freezeNoting>, agent, cfg, bind)
        : await runConsolidation(store, frozen as ReturnType<typeof freezeConsolidation>, agent, cfg, bind);
    } finally {
      task.close(); tasks.delete(task);
      try { if (!store.closed) store.releaseClaim(claim); }
      catch (error) {
        // 27d: a dropped result may now carry the `runId` of a refused attempt's own record, so the
        // variants that own a `problems` list are selected by outcome rather than by that key.
        if (result && result.outcome !== "dropped" && result.outcome !== "empty") result.problems = [...(result.problems ?? []), `claim release failed: ${String(error)}`];
        else throw error;
      }
    }
    return result;
  };
  return {
    store, executorId, resultText, cancelTasks, taskEligibility,
    forceTasks: () => { for (const task of tasks) { task.close(); task.force(); } },
    config: cfg,
    configure: (settings) => {
      // Reuse load validation, then restrict edits to the Noter mode and the borrowing scope.
      const requested = canonicalConfig(settings ?? {});
      if (!requested || typeof requested !== "object" || Array.isArray(requested)) throw new Error("Invalid configuration: expected an object");
      const reconfigurable: Record<string, string> = { noting: "forkModeDefault" };
      for (const [section, values] of Object.entries(requested)) {
        if (section === "closedSessionScope") continue;
        if (!Object.hasOwn(reconfigurable, section)) throw new Error(`Unknown setting ${section}`);
        if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`Invalid ${section}: expected an object`);
        for (const key of Object.keys(values)) if (key !== reconfigurable[section]) throw new Error(`Setting ${section}.${key} is not reconfigurable at runtime`);
      }
      const next = validateConfig({
        closedSessionScope: requested.closedSessionScope === undefined ? cfg.closedSessionScope : requested.closedSessionScope,
        render: cfg.render, noting: { ...cfg.noting, ...requested.noting }, consolidation: cfg.consolidation,
      });
      // One object identity throughout, so every existing reader sees the new default at its next
      // admission; nothing else of the frozen configuration moves.
      cfg.closedSessionScope = next.closedSessionScope;
      cfg.noting.forkModeDefault = next.noting.forkModeDefault;
    },
    close: () => {
      if (store.closed) return;
      try { cancelTasks(true); store.releaseExecutor(executorId); }
      finally { for (const task of tasks) task.force(); store.close(); }
    },
    appendEntry: input => store.appendSourceEntry(input),
    selectEntries: (sessionId, branch, ids) => store.selectSourcePath(sessionId, branch, ids),
    pendingEntries: (sessionId, branch, head) => store.pendingEntries(sessionId, branch, head),
    notingBatch: (target, boundary) => notingBatch(notingPending(store, { ...target, boundary }).pending, cfg, resultText).entries,
    tools: (context) => bindTools(store, read, context).tools,
    noting: input => execute("noting", input) as Promise<NotingResult>,
    consolidate: input => execute("consolidation", input) as Promise<ConsolidateResult>,
    ...read,
  };
}
