export { toolDefinitions, toolRejected, reviewFeedback, validateReadInput } from "./tools.ts";
import { bindTools, type ToolContext, type ToolDefinition } from "./tools.ts";
import { knowledgeReadSelection } from "./knowledge-read.ts";
export type { ToolContext, ToolDefinition } from "./tools.ts";
import { parseTurnAddress, parseKnowledgeAddress } from "../model/address.ts";
import { sourceBlocks, resultHasText, type SourceNormalizer } from "../model/source.ts";
import { readFacade, readProfile, type ListingOptions, type SearchScope, type CompactResult, type Injection, type TopicGroups, type KnowledgeRead } from "./read.ts";
export type { ListingOptions, SearchScope, CompactResult, Injection, TopicGroups, TruncationReceipt } from "./read.ts";
// 29a/53: core owns only the host-neutral visibility contract; each host reads its own envelopes.
import type { VisibleView } from "./visible.ts";
export { knowledgeStateKey, noVisibility } from "./visible.ts";
export type { InitialContext, KnowledgeStateReceipt, SuppliedEntry, SuppliedMaterial, VisibleView } from "./visible.ts";
// Hosts use this façade; persistence remains entirely in core/store.
import { randomUUID } from "node:crypto";
import { DEFAULT_DREAMING_TRIGGER_TOKENS } from "../store/processing.ts";

import { freezeNoting, notingBatch, notingPending, runNoting, NOTING_MEMBERSHIP, type NotingInput, type NotingResult } from "../noting/index.ts";
import { finish, renderFact, renderFactGroups, renderRun, renderTrace, renderKnowledgeTrace, renderKnowledgeDiff, renderCommitHistory, renderNegationWalk, type NegationStep, type TurnOptions } from "../render/index.ts";
import { tokens, tokensJoined, JoinedTokens, renderEntry, rawResultText, type ResultExtractor } from "../render/index.ts";
export { tokens, tokensJoined, JoinedTokens, renderEntry, renderEntryWhole, rawResultText, finish, runMode, ENTRY_VIEW_VERSION } from "../render/index.ts";
export type { EntryProfile, ResultText, ResultExtractor } from "../render/index.ts";
// 20a: core owns the domain text of every memory consumer. A host places this text; it does not lay
// out knowledge, facts or Raw itself.
export { notingText, consolidationText, injectionText, compactText, knowledgeBlock, memoryBodyHash } from "../render/material.ts";
export type { SharedMaterial, KnowledgeGroup, TaskRange, MemoryComposition } from "../render/material.ts";
export { enrollmentDefault, sourceDigest } from "../store/index.ts";
export { directoryAllocation } from "../project/directory.ts";
export type { Enrollment, ClosedSessionScope } from "../store/index.ts";
export type { SourceInput, SourceEntry, TaskTarget } from "../store/index.ts";
export { compareTriggerOrigins } from "../model/index.ts";
export type { TriggerOrigin, TriggerOriginRelation } from "../model/index.ts";
export type { NotingInput, NotingResult, NotingAgentInput, NotingMaterial, EntryAudit } from "../noting/index.ts";
export type { NotingDiagnostic, NotingNearAudit, NotingUnansweredNearPair } from "../noting/review.ts";
export { NOTING_CAPACITY, NOTING_INCOMPLETE, NOTING_MEMBERSHIP } from "../noting/index.ts";
import { Store, type PendingEntries, type SourceInput, type SourceEntry, type SourceEntryMeta, type KnowledgePath, type Phase, type TaskClaim, type TaskTarget, type ClosedSessionScope } from "../store/index.ts";

import { admitDreaming, freezeDreaming, runDreaming, type DreamingInput, type DreamingResult } from "../dreaming/index.ts";
export type { DreamingInput, DreamingResult, DreamingAgentInput } from "../dreaming/index.ts";
import { freezeConsolidation, runConsolidation, CONSOLIDATION_MEMBERSHIP, type ConsolidateInput, type ConsolidateResult } from "../consolidation/index.ts";
export { CONSOLIDATION_CAPACITY, CONSOLIDATION_MEMBERSHIP } from "../consolidation/index.ts";
export type { ConsolidateInput, ConsolidateResult, ConsolidationAgentInput, ConsolidationMaterial, ConsolidationRange, ConsolidationDiagnostic } from "../consolidation/index.ts";


// ---- Flat config, defaults in one place (spec.md: render budgets, noting/consolidation triggers and modes) ----

export interface TraceMemoryConfig {
  closedSessionScope: ClosedSessionScope;
  render: {
    /** Ticket 30: `E`, the most one entry view is worth. */
    entryTokens: number;
    /** Ticket 30: `C`, the most one tool-call part is worth (ceiling `TOOL_CALL_CEILING`). */
    toolInputTokens: number;
    /** Ticket 30: `R`, the most one tool-result part is worth (the same ceiling). Independent of `C`:
     * neither allowance is ever lent to the other. */
    toolResultTokens: number;
    episodicBlockTokens: number;
  };
  noting: {
    /** Select inherited-context execution (fork, formerly branch); false defaults to a subagent. */
    forkModeDefault: boolean;
    batchTokens: number;
    triggerTokens: number;
    /** Character-bigram Jaccard threshold for automatic same-session fact review. */
    nearThreshold: number;
    /** Tool rounds a run may take before it fails; 0 = unlimited (the model stops when it stops). */
    maxToolRounds: number;
  };
  /** Bounded fresh-subagent maintenance; no fork mode. */
  dreaming: {
    /** Pending-trigger cap; each pool uses min(triggerTokens, its own budget). */
    triggerTokens: number;
    /** 0 = unlimited. Dreaming is bounded by timeoutMs instead. */
    maxToolRounds: number;
    /** Cooperative wall-clock deadline shared by every host. */
    timeoutMs: number;
  };
  consolidation: {
    /** 29e (parent 29 "Restore Consolidator fork without weakening review"): the same canonical
     * boolean the Noter has, for the phase that lost its mode preference in 25b. Default `false`:
     * the option is restored, the existing default is not switched. */
    forkModeDefault: boolean;
    /** Ticket 20: rendered tokens of applicable unconsolidated facts that make a run due. */
    triggerTokens: number;
    /** Ticket 20: the most rendered fact tokens one batch may select. */
    batchTokens: number;
    maxToolRounds: number;
  };
  /** The two database-independent material windows, and the allowance every consumer shares. Knowledge
   * uses the bound database policy's base sum; the maximum envelope adds all three bases and the
   * shared allowance below. */
  compaction: {
    /** The facts window: the pending facts on the path, then the consolidated refill (28a items 1, 4). */
    factsTokens: number;
    /** The Raw window: the pending entry views, then the already-extracted refill (28a items 1, 5). */
    rawTokens: number;
    /** 73: one fixed allowance shared by Knowledge, Facts and Raw — a configuration value, not derived
     * from the Noting/Consolidation/Dreaming triggers. Knowledge borrows first, for any effective
     * knowledge above its base; Facts and Raw borrow only for material Noting or Consolidation has not
     * processed yet. It is not a compaction-only overflow: injection and the Consolidator/Dreamer
     * knowledge capacities spend it too. */
    sharedAllowanceTokens: number;
  };
}

/** The configuration sections, in one place: the loader, the validator and the host's flat
 * `section.key` layer all enumerate them from here rather than repeating the list (28a added one). */
export const CONFIG_SECTIONS = ["render", "noting", "consolidation", "dreaming", "compaction"] as const;

export const DEFAULT_CONFIG: TraceMemoryConfig = {
  closedSessionScope: "project",
  render: {
    entryTokens: 2_000,
    toolInputTokens: 100,
    toolResultTokens: 100,
    episodicBlockTokens: 20_000,
  },
  noting: {
    forkModeDefault: false,
    batchTokens: 10_000,
    triggerTokens: 10_000,
    nearThreshold: 0.40,
    maxToolRounds: 0,
  },
  dreaming: { triggerTokens: DEFAULT_DREAMING_TRIGGER_TOKENS, maxToolRounds: 0, timeoutMs: 600_000 },
  consolidation: {
    forkModeDefault: false,
    triggerTokens: 5_000,
    batchTokens: 10_000,
    maxToolRounds: 0,
  },
  compaction: {
    factsTokens: 10_000,
    rawTokens: 10_000,
    sharedAllowanceTokens: 10_000,
  },
};

export type ConfigOverride = {
  closedSessionScope?: ClosedSessionScope;
  render?: Partial<TraceMemoryConfig["render"]>;
  /** `branchModeDefault` is the accepted legacy spelling of `forkModeDefault` (CONFIG_ALIASES). */
  noting?: Partial<TraceMemoryConfig["noting"]> & { branchModeDefault?: boolean };
  consolidation?: Partial<TraceMemoryConfig["consolidation"]>;
  dreaming?: Partial<TraceMemoryConfig["dreaming"]>;
  compaction?: Partial<TraceMemoryConfig["compaction"]>;
};

/** Legacy configuration spellings accepted at the boundary, `section.key` on both sides (ticket 19
 * "Legacy input"). The execution mode was renamed from branch to fork; the old key still selects the
 * new one so an existing settings.json keeps working. Only the canonical spelling is ever emitted.
 * One table for core and for every host: the flat `section.key` settings space (hosts/pi) and the
 * nested `ConfigOverride` (the façade) resolve the alias through the same two functions below. */
export const CONFIG_ALIASES: Readonly<Record<string, string>> = { "noting.branchModeDefault": "noting.forkModeDefault" };

/** Settings a ruling removed, and the remedy for each (ticket 20 "Configuration"). A removed key is
 * not an alias: an old fact count is never reinterpreted as tokens, so any layer supplying one fails
 * the load naming the key and what to do about it. The same two functions below enforce it for the
 * flat `section.key` settings space and for the nested `ConfigOverride`, and the read-only menu shows
 * it nowhere, because it builds itself from `DEFAULT_CONFIG`. Most remedies are a replacement key
 * ("use …"); a setting whose choice no longer exists says so instead. */
const PART_BUDGETS = "use render.toolInputTokens (the whole rendered call part) and render.toolResultTokens (the whole rendered result part)";
export const REMOVED_SETTINGS: Readonly<Record<string, string>> = {
  "consolidation.triggerUnconsolidatedFacts": "use consolidation.triggerTokens (tokens, not a count)",
  "compaction.overflowTokens": "use compaction.sharedAllowanceTokens (a fixed configuration value, default 10,000; no longer derived from the Noting, Consolidation and Dreamer triggers)",
  // Ticket 25b removed this key; 29e restores the choice under the canonical spelling every phase
  // shares. It stays a removed setting rather than becoming an alias, because it is the INVERSE
  // boolean: reading a saved `true` as `forkModeDefault: true` would switch the meaning of the value
  // silently. No file is rewritten and no request is normalized.
  "consolidation.subagentModeDefault": "use consolidation.forkModeDefault (the inverse boolean: true means fork)",
  "consolidation.knowledgeTokens": "remove it and use Settings to edit the bound database's Global, Project and Session Knowledge budgets",
  "consolidation.nearThreshold": "remove it; Consolidation review cues and lexical NEAR selection no longer exist",
  // Ticket 23: the stdout/stderr branch they budgeted reads a result shape Pi never produces, so they
  // were never effective on any Pi run; the uniform entry rule replaces them. Ticket 30 renamed the
  // budget they were pointed at, so the guidance names the two independent ones.
  "render.stdoutHeadTokens": PART_BUDGETS,
  "render.stdoutTailTokens": PART_BUDGETS,
  "render.stderrTailTokens": PART_BUDGETS,
  // Ticket 23b: the per-tool branches of the explicit Turn preview they budgeted are gone — an
  // explicit `trace` without `full` is the entry view under the configured profile, and `full` renders
  // the stored evidence uncut, so neither has a budget of its own any more.
  "render.commandTokens": PART_BUDGETS,
  "render.reportHeadTokens": PART_BUDGETS,
  "render.reportTailTokens": PART_BUDGETS,
  // Ticket 30 "Configuration and compatibility": `B` was one budget for a call and its result, split
  // in half; `C` and `R` are independent allowances, so the old value cannot be reinterpreted as
  // either of them and the key is removed rather than aliased. The tier-2 profile went with the
  // second tier itself: there is one bounded view, under `render.entryTokens` and the two below.
  "render.toolCallTokens": PART_BUDGETS,
  "render.secondaryToolCallTokens": `removed with the tier-2 view: ${PART_BUDGETS} — one bounded view everywhere`,
  "render.secondaryEntryTokens": "removed with the tier-2 view: use render.entryTokens — one bounded view everywhere",
  "render.knowledgeBlockTokens": "remove it and use Settings to edit the bound database's Global, Project and Session Knowledge budgets",
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
    dreaming: { ...base.dreaming, ...override.dreaming },
    compaction: { ...base.compaction, ...override.compaction },
  };
}

/** Ticket 23: a per-part budget has a hard upper bound — the 17a default — and is rejected above it.
 * A tool part larger than that is the volume problem that ticket exists to remove; ticket 30 applies
 * the same ceiling to each of the two independent allowances. */
export const TOOL_CALL_CEILING = 1_000;

export function validateConfig(override: ConfigOverride): TraceMemoryConfig {
  const cfg = mergeConfig(DEFAULT_CONFIG, override);
  if (!["off", "project", "global"].includes(cfg.closedSessionScope)) throw new Error("Invalid closedSessionScope: expected off, project or global");
  for (const section of CONFIG_SECTIONS) for (const [key, value] of Object.entries(cfg[section])) {
    const name = `${section}.${key}`;
    if (key.endsWith("ModeDefault")) {
      if (typeof value !== "boolean") throw new Error(`Invalid ${name}: expected boolean`);
    } else if (key === "nearThreshold") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`Invalid ${name}: expected a similarity between 0 and 1`);
    } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < (key === "maxToolRounds" ? 0 : 1)) {
      throw new Error(`Invalid ${name}: expected ${key === "maxToolRounds" ? "a nonnegative" : "a positive"} safe integer`);
    }
    if ((key === "toolInputTokens" || key === "toolResultTokens") && (value as number) > TOOL_CALL_CEILING) throw new Error(`Invalid ${name}: at most ${TOOL_CALL_CEILING}`);
  }
  if (cfg.dreaming.maxToolRounds !== 0) throw new Error("Invalid dreaming.maxToolRounds: Dreamer requires 0 (unlimited); use dreaming.timeoutMs for the run bound");
  if (cfg.dreaming.timeoutMs > 2_147_483_647) throw new Error("Invalid dreaming.timeoutMs: expected at most 2147483647 for the native timer");
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
  /** The host refused this frozen task's admitted mode and may re-admit it as a fresh child.
   * With no business commit, core returns this opaque value with `outcome: "dropped"`.
   * A refusal that sent a request records its own failed run and spend; one that sent nothing
   * records no run. Re-admission shares the logical execution, never the attempt's spend. */
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

/** A frozen target, in two meanings the field names now separate (29e, parent 29 "Capacity, fallback
 * and audit"). The *allowable* set is a manual catchup's snapshot: `maxEntryId` bounds Noting to
 * entries allocated no later than its freeze instant, `allowedFactIds` bounds Consolidation to the
 * pending-plus-produced fact set it froze. Both permit a smaller batch — that is what a drain does.
 * Absent, selection is the ordinary unbounded pending set (18b).
 *
 * The *exact* target is what a fork fallback re-admits on: `exactEntryIds` (27d, parent 27
 * amendment 6) and `exactFactIds` (29e). Under either, the freeze takes exactly those members or the
 * task stays pending — a smaller batch would be a membership change made after execution started. */
export interface TaskBoundary { maxEntryId?: number; exactEntryIds?: number[]; allowedFactIds?: number[]; exactFactIds?: number[] }
export interface TaskOptions {
  /** Durable execution shared only with a refused attempt's fallback. */
  executionId?: string;
  borrowed?: boolean; automatic?: boolean; executorSessionId?: number; boundary?: TaskBoundary;
  /** Host result ceiling in JavaScript UTF-16 characters, passed only to bound read tools. */
  maxReadChars?: number;
  /** Persisted source-entry identity at host admission; later same-Turn entries must not move it. */
  triggerEntryId?: number;
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
  /** 28b (parent 28 amendment 3, "Cancellation is a signal, not a new handle"): the operation that
   * admitted this task, as an `AbortSignal` of the host's own. Core links it to THIS task's existing
   * controller: an abort closes this task's tool binding — so nothing it was still running can commit
   * — and aborts its own run, and it touches no other task, no other claim and no admission. It is
   * the per-task counterpart of the executor-wide `cancelTasks`, which stays what it is. A signal
   * already aborted when the task reaches this point cancels it before its first request. */
  signal?: AbortSignal;
  /** 29b "Same builder, different initial state": what the child this task will run in already holds,
   * as the host derived it from that child's own starting context. Present only
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

/** One Knowledge pool's Dreaming projection: `pool` is the store's key (`global`,
 * `project:<id>`, `session:<id>`), `scope` its kind. */
export interface DreamingPoolPending { scope: "global" | "project" | "session"; pool: string; tokens: number; trigger: number }

// ---- Façade ----

export interface TraceMemory {
  readonly store: Store;
  readonly executorId: string;
  /** Ticket 23 "Host contract": the result-text extractor this host registered at construction. Core
   * applies it wherever it renders an entry and never inspects envelope fields itself. */
  readonly resultText: ResultExtractor;
  taskEligibility(phase: Phase, target: TaskTarget): { due: boolean };
  /** On-demand, read-only trigger material estimates; no admission, grants or cache writes. Covers
   * Noting and Consolidation only — Dreaming's Knowledge pools trigger independently, so its
   * projection is `dreamingPending`. */
  pendingTokens(phase: "noting" | "consolidation", target?: TaskTarget):
    | { tokens: number; trigger: number; state: "known" }
    | { tokens: null; trigger: number | null; state: "no session" | "unavailable" };
  /** Same read-only contract as `pendingTokens`, one entry per applicable Knowledge pool (fixed
   * order global, project, session) since each pool is due on its own budget-derived trigger and
   * is never merged into a single figure (maintainer 2026-09-24: scopes trigger separately, so each
   * must be shown separately). `trigger` is `min(dreaming.triggerTokens, pool.budget)`, exactly what
   * `taskEligibility("dreaming")`/`duePools` use to decide that pool is due. */
  dreamingPending(target?: TaskTarget):
    | { state: "known"; pools: DreamingPoolPending[] }
    | { state: "no session" | "unavailable"; pools: null };
  /** Terminal worker settlement, including Dreamer's future worker: persist first, then abort
   * locally owned target tasks on automatic off. Attempt refusal is not terminal settlement. */
  settleExecution(id: string, outcome: import("../store/executions.ts").ExecutionOutcome, runId: number, reason?: string): ReturnType<Store["settleExecution"]>;
  /** Fence owned tokens before requesting cancellation; stopping prevents later admission.
   * Returned identities acknowledge locally owned abort requests, not provider termination. */
  cancelTasks(stopping?: boolean): { sessionId: number; phase: Phase; executionId: string }[];
  /** Freeze before host preflight: even an unsent refusal belongs to this admission generation. */
  readonly cancellation: number;
  /** End local waits at teardown's deadline; provider promises remain rejection-handled. */
  forceTasks(): void;
  readonly config: TraceMemoryConfig;
  /** Current database-owned Knowledge policy and its derived capacities. */
  knowledgeBudgets(): import("../store/processing.ts").KnowledgeBudgets;
  /** Transactionally edit one row against the latest other two values. */
  setKnowledgeBudget(field: import("../store/processing.ts").KnowledgeBudgetField, value: number): ReturnType<Store["setKnowledgeBudget"]>;
  /** Ticket 24 amendment 2: the one runtime configuration surface. A saved global preference must
   * reach tasks admitted afterwards without a reload, and admission reads its execution mode from
   * this configuration. Only each phase's `forkModeDefault` and `closedSessionScope` may be replaced
   * here (29e restored Consolidation's, which 25b had retired), validated like the load path. Other keys are refused: this is not a second configuration source
   * and reloads nothing. Admitted tasks retain their frozen mode and borrowing scope. */
  configure(settings: ConfigOverride): void;
  close(): void;
  /** `known`, when passed (even `null`), is the caller's own prior `findSourceEntry` result for this
   * exact identity in the same synchronous flow; see `Store.appendSourceEntry`. */
  appendEntry(input: SourceInput, known?: SourceEntry | null): SourceEntry;
  selectEntries(sessionId: number, branch: string, entryIds: number[]): void;
  pendingEntries(sessionId: number, branch: string, headTurnId: number): SourceEntryMeta[];
  /** Ticket 29c: the entries a Noting freeze of this target would really select — the pending set the
   * boundary admits, cut to the oldest prefix that fits `noting.batchTokens` — without freezing,
   * claiming or diagnosing anything. The Pi host decides a fork's Raw availability against exactly
   * this set, so admission and the freeze can never disagree about which entries the task is about. */
  notingBatch(target: TaskTarget, boundary?: TaskBoundary): SourceEntry[];
  tools(context: ToolContext): ToolDefinition[];
  noting(input: NotingInput): Promise<NotingResult>;
  consolidate(input: ConsolidateInput): Promise<ConsolidateResult>;
  dream(input: DreamingInput): Promise<DreamingResult>;
  /** Committed lineage facts and unrecorded raw, without dropping facts. */
  branchSummary(sessionId: number, branch: string, headTurnId: number): string;
  /** Ticket 20, as 30 and 28a left it: the compaction result — the three allocated windows over one
   * envelope, or the explicit ask that the host decline and let its native compaction run (20c).
   * `retainedView` describes actually retained Raw/fact/knowledge identities; legacy native-ID arrays
   * remain accepted for Raw-only callers. A host that keeps none passes none. */
  compact(sessionId: number, branch?: string, headTurnId?: number, retainedView?: readonly string[] | VisibleView): CompactResult;
  /** Ticket 21b: the path-selected applicable knowledge grouped by topic, as commit references; a
   * read projection only — it neither reorders injection nor changes what is applicable. */
  topicGroups(sessionId: number, headTurnId?: number | null, branch?: string): TopicGroups;
  /** A session id after the first reply; before it exists (first prompt), the project alone: global + project knowledge. */
  inject(target: number | { projectId: number } | KnowledgePath): string;
  /** 29a: the same block with the commit ids it kept, for the carrier the host writes on the message
   * it persists. `inject` is this call read for its text alone. 31: `visible` is the reader's own
   * context, whose commits are subtracted and whose stale commits get a status line; the
   * default empty view is the whole applicable set, which is what a fresh context always got. */
  injection(target: number | { projectId: number } | KnowledgePath, visible?: VisibleView): Injection;
  trace(address: string, options?: ListingOptions): string;
  search(query: string | readonly string[], scope?: SearchScope, options?: ListingOptions & { sessionId?: number }): string;
  declareProject(sessionId: number, name: string, source?: "marker" | "mark", path?: KnowledgePath): string;
  status(sessionId: number, branch?: string, headTurnId?: number | null): string;
  /** Footer progress for one selected path: Raw and fact backlog, current visible Knowledge, and
   * current revisions changed since their owner pool last processed them. */
  progress(sessionId: number, branch?: string, headTurnId?: number | null): { entries: number; facts: number; unconsolidated: number;
    knowledge: number; changedKnowledge: number };
  /** Model spend of one session's runs: run counts and cost by kind, token totals and total cost (51: Current session shows this composition). */
  spend(sessionId: number): { runs: { noting: number; consolidation: number; dreaming: number; manual: number }; costs: { noting: number; consolidation: number; dreaming: number; manual: number };
    input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  /** Cost of every session's runs created at or after a UTC instant (51: the footer's figure for today, from the host's local midnight). */
  spendSince(since: string): number;
}

/** 79 item 2 (Pi review of 5ee34b5): an ordinal/range selection (`#E2`, `#E2..E7`) is decidable from
 * `entryOrdinal` alone, a field both `SourceEntryMeta` and hydrated `SourceEntry` carry — so the same
 * narrowing applies whether it runs before hydration (metadata) or after (an explicit id set already
 * hydrated for another reason). */
function selectByOrdinal<T extends { entryOrdinal: number }>(entries: readonly T[], selection: readonly { from: number; to?: number }[], turnId: number): T[] {
  const byOrdinal = new Map(entries.map(entry => [entry.entryOrdinal, entry]));
  return selection.flatMap(sel => {
    if (sel.to !== undefined) return entries.filter(entry => entry.entryOrdinal >= sel.from && entry.entryOrdinal <= sel.to!);
    const entry = byOrdinal.get(sel.from);
    if (!entry) throw new Error(`entry T${turnId}#E${sel.from} does not exist on this path`);
    return [entry];
  });
}

export function TraceMemory(dbPath: string, runAgent: RunAgent, config: ConfigOverride = {},
  /** Ticket 23: the host's one result-text extractor, registered here (default: the stored string). */
  resultText: ResultExtractor = rawResultText, normalizeSource?: SourceNormalizer): TraceMemory {
  const cfg = validateConfig(config);
  const store = new Store(dbPath, normalizeSource);
  const executorId = randomUUID();
  let stopping = false;
  const tasks = new Set<{ sessionId: number; phase: Phase; executionId: string; claimToken: string; controller: AbortController; force(): void; close(): void }>();
  const abortTarget = (sessionId: number) => {
    for (const task of tasks) if (task.sessionId === sessionId) { task.close(); task.controller.abort(); }
  };
  const settleExecution: TraceMemory["settleExecution"] = (id, outcome, runId, reason) => {
    const settled = store.settleExecution(id, outcome, runId, reason);
    if (settled.automaticOff) abortTarget(store.getRun(runId)!.sessionId!);
    return settled;
  };
  // 27d repair 4 (parent 27 line 83): the cancellation generation. Every cancellation advances it,
  // stop or not — `/trace stop` cancels without stopping, and a task cancelled that way must not
  // come back through a fork fallback either. Admission freezes it with the task, the host carries
  // it in the refusal, and the re-admission below compares. It fences the window `stopping` cannot:
  // a task whose attempt was already in flight, whose abort raced the provider's own answer.
  let cancellation = 0;
  const cancelTasks = (stop = false) => {
    stopping ||= stop;
    cancellation++;
    const owned = [...tasks].map(({ sessionId, phase, executionId }) => ({ sessionId, phase, executionId }));
    // Dreamer's terminal transaction records the frozen range and its committed outputs under the
    // same live claim. Close its tools immediately, but keep that exact token until finalization;
    // other phases and reservations still lose authority at once.
    try { if (!store.closed) {
      const completingDreamer = [...tasks].find(task => task.phase === "dreaming"
        && store.getClaim(task.sessionId, task.phase)?.token === task.claimToken)?.claimToken;
      if (stop) store.beginShutdown();
      store.invalidateExecutor(executorId, completingDreamer);
    } }
    finally { for (const task of tasks) { task.close(); task.controller.abort(); } }
    return owned;
  };
  // Freeze database values first; the returned renderer runs outside the read transaction.
  const prepareTrace = (address: string, display: ListingOptions = {}, reads?: KnowledgeRead[]): (() => string) => {
    const target = address.trim(), flags = /^(?:S\d+\/)?T\d/.test(target) ? [] : target.split(/\s+/).slice(1);
    const invalid = () => new Error(`invalid trace address: ${address}`);
    const itemCap = readProfile(display, display.profile ?? cfg.render).entryTokens;
    const knowledgeMatch = parseKnowledgeAddress(target);
    if (knowledgeMatch) {
      const { id, from, to } = knowledgeMatch;
      const knowledge = store.getKnowledge(id!);
      if (!knowledge) throw new Error(`knowledge K${id} does not exist`);
      const history = store.listKnowledgeRevisions(id!);
      const commit = (commitId: number) => {
        const value = store.getKnowledgeRevision(id!, commitId);
        if (!value) throw new Error(`commit K${id}@${commitId} does not exist`);
        return value;
      };
      const fields = new Set(display.fields ?? ["text", "supports", "topics", "status", "links"]);
      const descriptions = new Map<number, () => string>();
      const capture = (revisions: typeof history, historyLines = false) => {
        for (const r of revisions) {
          if (descriptions.has(r.id)) continue;
          const parents = store.commitParents(r), children = store.commitChildren(r);
          descriptions.set(r.id, () => {
            const grounds = [...store.revisionGrounds(r)].sort((a, b) => a - b);
            const full = renderKnowledgeTrace({ knowledge, revision: r }, parents, children, Infinity, grounds, fields, historyLines);
            const text = renderKnowledgeTrace({ knowledge, revision: r }, parents, children, itemCap, grounds, fields, historyLines);
            if (!fields.has("text") || text !== full) for (const read of reads ?? []) if (read.knowledgeId === id && read.commits.includes(r.id)) read.complete = false;
            return text;
          });
        }
      };
      const describe = (r: typeof history[number]) => descriptions.get(r.id)!();
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
        return () => renderKnowledgeDiff(a, b, history.filter(r => left.has(r.id) !== right.has(r.id)), itemCap, fields);
      }
      if (from !== undefined) {
        const revision = commit(from);
        reads?.push({ knowledgeId: id!, commits: [revision.id], replace: false });
        capture([revision]);
        return () => describe(revision);
      }
      if (knowledgeMatch.history) {
        capture(history, true);
        return () => `K${id} commit tree (all branches):\n` + history.map(describe).join("\n");
      }
      const versions = display.versions ?? "current";
      const selection = knowledgeReadSelection(store, display);
      const { path, graph, matches } = selection;
      const tips = versions === "current" ? selection.representatives(history)
        : graph.current.filter(r => r.knowledgeId === id && matches(r));
      reads?.push({ knowledgeId: id!, commits: tips.filter(r => r.op !== "archive").map(r => r.id), replace: true });
      const applicable = history.filter(r => graph.applicable.has(r.id) && matches(r));
      const allHistory = history.filter(matches);
      const otherHistory = allHistory.filter(r => !graph.applicable.has(r.id));
      const otherTips = path && versions === "all" ? store.commitGraph(null, undefined, undefined, selection.input).current
        .filter(r => r.knowledgeId === id && !graph.applicable.has(r.id) && matches(r)) : [];
      const links = store.listKnowledgeLinks(id!);
      const archived = versions === "current" && !tips.length && fields.has("status")
        ? graph.current.filter(r => r.knowledgeId === id && r.op === "archive" && matches(r)) : [];
      const described = versions === "current" ? tips : versions === "history" ? [...tips, ...applicable] : [...tips, ...allHistory, ...otherTips];
      capture([...new Map(described.map(r => [r.id, r])).values()]);
      return () => [path ? `K${id} path current: ${tips.map(r => `K${id}@${r.id}`).join(", ") || "none"}`
        : `K${id} tips (newest-created: ${tips.length ? `K${id}@${Math.max(...tips.map(r => r.id))}` : "none"}):`,
        ...tips.map(r => (tips.length > 1 ? `Alternative K${id}@${r.id}${!path && r.id === Math.max(...tips.map(t => t.id)) ? " (newest-created)" : ""}\n` : "") + describe(r)),
        ...archived.map(r => `  K${id}@${r.id}: ${selection.status(r)}; inspect trace(K${id}, versions:history)`),
        ...(fields.has("links") ? links.map(l => `  ${l.kind}: K${l.toKnowledge}@${l.toCommit} (from K${l.fromKnowledge}@${l.fromCommit})`) : []),
        ...(versions === "current" ? [] : path ? ["Applicable history on this path:", renderCommitHistory(applicable, fields)]
          : ["Commit history:", renderCommitHistory(allHistory, fields)]),
        ...(path && versions === "all" ? ["Other branches' tips:", ...otherTips.map(describe), "Other branches' commits:", renderCommitHistory(otherHistory, fields)] : [])].join("\n");
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
      return () => renderNegationWalk(steps, itemCap);
    }
    const factMatch = /^F([1-9]\d*)$/.exec(target ?? "");
    if (factMatch && !flags.length) {
      if (!Number.isSafeInteger(Number(factMatch[1]))) throw invalid();
      const fact = store.getFact(Number(factMatch[1]));
      if (!fact) throw new Error(`fact ${target} does not exist`);
      const relations = store.listFactRelations(fact.id);
      let receipt = "";
      if (display.sessionId !== undefined) {
        const path = store.knowledgePath(display.sessionId, display.branch, display.headTurnId);
        const snapshot = store.pathSnapshot(path);
        const otherIds = [...new Set(relations.map(relation => relation.fromFact === fact.id ? relation.toFact : relation.fromFact))];
        const applies = store.factApplicabilityOnPath(otherIds, path, snapshot);
        const inapplicable = otherIds.filter(id => !applies.get(id));
        if (inapplicable.length) receipt = `\nrelations retained by explicit Fact read; other endpoints not applicable on this path: ${inapplicable.map(id => `F${id}`).join(", ")}`;
      }
      return () => renderFact(fact, relations, itemCap) + receipt;
    }
    const runMatch = /^R([1-9]\d*)$/.exec(target ?? "");
    if (runMatch) {
      if (flags.length) throw new Error("invalid trace address: use the full parameter");
      const run = store.getRun(Number(runMatch[1]));
      if (!run) throw new Error(`run ${target} does not exist`);
      const facts = store.listFactsByRun(run.id).map((f) => f.id), commits = store.listCommitsByRun(run.id);
      return () => renderRun(run, facts, commits, display.full === true);
    }
    const parsed = parseTurnAddress(target);
    if (!parsed) throw invalid();
    const sessionOfAddress = parsed.session;
    const part = parsed.legacy;
    if (part && display.tool !== undefined && part !== `t${display.tool}`) throw new Error("source suffix conflicts with tool parameter");
    if ((parsed.entries || parsed.selector) && display.tool !== undefined) throw new Error("tool parameter conflicts with hierarchical selection; use an exact @toolCallId");
    const options: TurnOptions = { tool: display.tool, full: display.full, part, selector: parsed.selector, blocks: parsed.entries?.length === 1 && parsed.entries[0]!.to === undefined };
    const turn = store.getTurn(parsed.turn);
    if (!turn) throw new Error(`turn ${target} does not exist`);
    if (sessionOfAddress !== undefined && turn.sessionId !== sessionOfAddress) throw new Error(`turn ${target} does not exist`);
    if (parsed.selector?.kind === "facts") {
      const facts = store.listTurnFacts(turn.id);
      const relations = display.sessionId === undefined ? store.listFactRelationsOf(facts.map(f => f.id)) : (() => {
        const path = store.knowledgePath(display.sessionId!, display.branch, display.headTurnId);
        return store.listFactRelationsOnPathOf(facts.map(f => f.id), path);
      })();
      const times = store.factTurnTimes(facts);
      return () => renderFactGroups(facts, (f, frame) => renderFact(f, relations.get(f.id) ?? [], itemCap, frame), times, true).join("\n");
    }
    const calls = store.listToolCalls(turn.id);
    if (options.tool !== undefined && !calls.some((c) => c.ordinal === options.tool)) throw new Error(`tool #t${options.tool} does not exist in ${target}`);
    // 23b: without `full` the read is this Turn's selected source entries, in path order, each
    // rendered by the entry renderer under the configured profile — 22c's Turn-scoped read is what it
    // assembles, and `branch` (when the caller is bound to one) is what keeps a sibling branch's
    // occurrences out of it.
    // Full is now only a content-ceiling alias: it never widens a bound selection. Unbound reads
    // still include every occurrence. A paged read's exact entryIds override branch discovery,
    // so no continuation can pick up a newly added sibling.
    // 79 item 1 and item 2 (Pi review of 5ee34b5): the Turn's occurrences are chosen by id first
    // (metadata for the unbound case), then hydrated in one batched read — never a loop of single
    // reads over the whole list. An ordinal/range selection (`T792#E1`, on a 2,000-entry Turn) is
    // decided on that metadata *before* hydration, so it hydrates only the selected entries, not
    // the whole Turn; a caller-chosen id set (paging continuation) is already the exact page and is
    // narrowed the same way, after hydration, exactly as before.
    let occurrences: SourceEntry[];
    if (display.entryIds) {
      occurrences = store.hydrateSourceEntries(display.entryIds);
      if (parsed.entries) occurrences = selectByOrdinal(occurrences, parsed.entries, turn.id);
    } else {
      const meta = store.listSourceEntries(turn.sessionId, turn.id, display.branch);
      const selected = parsed.entries ? selectByOrdinal(meta, parsed.entries, turn.id) : meta;
      occurrences = store.hydrateSourceEntries(selected.map(entry => entry.id));
    }
    if (turn.kind === "compaction" && parsed.entries) return () => "";
    const selector = parsed.selector;
    if (selector?.kind === "role") occurrences = occurrences.filter(entry => entry.role === selector.role);
    else if (selector && selector.kind !== "facts") {
      const matches = (entry: SourceEntry) => !!entry.blocks && sourceBlocks(entry).some(block => selector.kind === "call"
        ? (block.kind === "call" || block.kind === "result") && block.call.callId === selector.id
        : selector.kind === "text" ? block.kind === "text" || block.kind === "result" && resultHasText(entry)
        : block.kind === "thinking");
      if (parsed.entries && occurrences.some(entry => !matches(entry))) throw new Error(`content selector does not exist in every selected entry: ${address}`);
      occurrences = occurrences.filter(matches);
      if (!occurrences.length && selector.kind !== "text") throw new Error(`content selector does not exist: ${address}`);
    }
    const profile = readProfile(display, display.profile ?? cfg.render);
    const uncompressed = Object.values(profile).every(cap => cap === Infinity);
    return () => finish(renderTrace(turn, occurrences, profile, { ...options, full: uncompressed }, uncompressed ? rawResultText : resultText));
  };

  const read = readFacade(store, cfg, prepareTrace, resultText);
  // Ticket 80 item 1: an entry is immutable and `cfg.render`/`resultText`/`ENTRY_VIEW_VERSION` are all
  // fixed for this process, so a rendered view is a pure function of the entry id alone — computed
  // once per process and reused by every later due check or pending-weight read, never re-rendered
  // (never re-reading Raw) for an entry already seen. Pruned to exactly the still-pending set on every
  // read: an entry drops out the moment it is noted, instead of leaking for the life of the process.
  const notingViewCache = new Map<number, string>();
  let lastPending: PendingEntries | undefined;
  type CountedPrefix = { count: JoinedTokens; offset: number; end: number; views: Map<number, { id: number; text: string }> };
  const counted = new WeakMap<PendingEntries, CountedPrefix>();
  const pendingState = (target: TaskTarget): PendingEntries => {
    const pending = store.pendingEntryState(target.sessionId, target.branch, target.headTurnId);
    if (pending !== lastPending) {
      const stillPending = new Set(pending);
      for (const id of notingViewCache.keys()) if (!stillPending.has(id)) notingViewCache.delete(id);
      lastPending = pending;
    }
    return pending;
  };
  const countPending = (pending: PendingEntries, limit: number): number => {
    let prefix = counted.get(pending);
    if (!prefix) {
      prefix = { count: new JoinedTokens(), offset: pending.offset, end: pending.offset, views: new Map() };
      counted.set(pending, prefix);
    }
    if (pending.offset > prefix.offset) {
      const removedEnd = Math.min(pending.offset, prefix.end);
      let removedChars = 0;
      for (let position = prefix.offset; position < removedEnd; position++) {
        const view = prefix.views.get(position)!;
        removedChars += view.text.length + (position + 1 < prefix.end ? 2 : 0);
        notingViewCache.delete(view.id);
        prefix.views.delete(position);
      }
      // Every removed view except the last counted view also removes its following separator.
      // The suffix keeps the exact segment boundaries of the original joined string.
      prefix.count.removePrefix(removedChars);
      prefix.offset = pending.offset;
      prefix.end = Math.max(prefix.end, pending.offset);
    }
    while (prefix.end - pending.offset < pending.length && prefix.count.count < limit) {
      const id = pending.at(prefix.end - pending.offset)!;
      let view = notingViewCache.get(id);
      if (view === undefined) {
        view = renderEntry(store.getSourceEntry(id)!, cfg.render, resultText).content;
        notingViewCache.set(id, view);
      }
      if (prefix.end > pending.offset) prefix.count.add("\n\n");
      prefix.count.add(view);
      prefix.views.set(prefix.end++, { id, text: view });
    }
    return prefix.count.count;
  };
  // Ticket 22b's rule kept exactly ("the estimate is still of one joined string, exactly as before —
  // independently estimated views are never summed"): `JoinedTokens` is not a per-entry sum, it is a
  // running tokenization of the one joined string, proven identical to `tokens(joined)` for every real
  // and adversarial boundary (tests/core/render/ticket-80-tokens-joined.test.ts) — just built without
  // re-scanning the whole growing prefix on every append. The early stop is unchanged: rendering (via
  // `notingViews`, cached) and tokenizing both stop the moment the threshold is reached, never reading
  // ahead through the rest of the backlog to warm the cache.
  const notingDue = (target: TaskTarget): boolean =>
    countPending(pendingState(target), cfg.noting.triggerTokens) >= cfg.noting.triggerTokens;
  const consolidationTokens = (target: TaskTarget): number => {
    const path = store.knowledgePath(target.sessionId, target.branch, target.headTurnId);
    const snapshot = store.pathSnapshot(path);
    const facts = store.consolidationBatch(target.sessionId, target.branch, target.headTurnId);
    const relations = store.listFactRelationsOnPathOf(facts.map(fact => fact.id), path, snapshot);
    return tokens(renderFactGroups(facts, f => renderFact(f, relations.get(f.id) ?? []), store.factTurnTimes(facts)).join("\n"));
  };
  const pendingTokens: TraceMemory["pendingTokens"] = (phase, target) => {
    const trigger = cfg[phase].triggerTokens;
    if (!target) return { tokens: null, trigger, state: "no session" };
    try {
      if (store.closed || !store.getSession(target.sessionId)) return { tokens: null, trigger, state: "unavailable" };
      const count = phase === "noting" ? countPending(pendingState(target), Infinity) : consolidationTokens(target);
      return { tokens: count, trigger: cfg[phase].triggerTokens, state: "known" };
    } catch { return { tokens: null, trigger, state: "unavailable" }; }
  };
  const poolScope = (pool: string): DreamingPoolPending["scope"] =>
    pool === "global" ? "global" : pool.startsWith("project:") ? "project" : "session";
  const dreamingPending: TraceMemory["dreamingPending"] = target => {
    if (!target) return { state: "no session", pools: null };
    try {
      if (store.closed || !store.getSession(target.sessionId)) return { state: "unavailable", pools: null };
      const pools = store.knowledgePools(target, cfg.dreaming.triggerTokens).map(size => ({
        scope: poolScope(size.pool), pool: size.pool,
        tokens: size.pending.reduce((sum, value) => sum + value.tokens, 0),
        trigger: Math.min(cfg.dreaming.triggerTokens, size.budget),
      }));
      return { state: "known", pools };
    } catch { return { state: "unavailable", pools: null }; }
  };
  // 29d: eligibility is the trigger threshold and nothing else. The delivery pause that used to hold
  // a fork-mode Noting task until its predecessor's facts had been delivered to the foreground went
  // with the deliveries themselves (parent 29: "Old pending rows cannot pause either phase once the
  // new version stops consuming them"), so the requested mode no longer changes this answer. Phase
  // slots, enrollment, the host's readiness wait and claim checks are untouched.
  const taskEligibility = (phase: Phase, target: TaskTarget) => {
    if (stopping || store.closed || !store.enabled(target.sessionId)) return { due: false };
    return { due: phase === "noting" ? notingDue(target)
      : phase === "dreaming" ? store.duePools(target, cfg.dreaming.triggerTokens).length > 0
      : consolidationTokens(target) >= cfg.consolidation.triggerTokens };
  };
  const execute = async (phase: Phase, input: NotingInput | ConsolidateInput): Promise<NotingResult | ConsolidateResult | DreamingResult> => {
    // 29e (parent 29, superseding 25b): both phases have two execution modes again, so no mode is
    // refused here by name. What stays subagent stays subagent where it is decided — borrowed work
    // and manual catchup request it explicitly, and ticket 28's recovery workers will too.
    if (stopping || store.closed || !store.enabled(input.sessionId)) return { outcome: "dropped" };
    // 27d repair 4 (parent 27 line 83): "User cancellation, stop, shutdown, claim loss or disabled
    // enrollment must not launch fallback work." A task cancelled between its refusal and this
    // re-admission carries a generation older than the current one: it launches nothing, records
    // nothing and warns nothing. The generation frozen below is what its own refusal would carry.
    if (input.cancellation !== undefined && input.cancellation < cancellation)
      return { outcome: "dropped", reason: CANCELLED_BEFORE_FALLBACK };
    const generation = cancellation;
    const target = { sessionId: input.sessionId, branch: input.branch, triggerEntryId: input.triggerEntryId,
      headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId! };
    const closedSessionScope = cfg.closedSessionScope;
    let claim: TaskClaim | null = null;
    let empty = false, projectId: number;
    let executionId: string;
    let origin: import("../model/index.ts").TriggerOrigin | null = null;
    let frozen: ReturnType<typeof freezeNoting> | ReturnType<typeof freezeConsolidation> | ReturnType<typeof freezeDreaming> | null;
    try { frozen = store.transaction(() => {
      // Candidate discovery is advisory: recheck the executor and borrowing scope atomically
      // with claim acquisition, before loading a closed target's evidence or constructing material.
      if (input.borrowed && !store.canBorrow(target.sessionId, input.executorSessionId, closedSessionScope)) return null;
      if (phase === "dreaming") {
        const admitted = admitDreaming(store, { ...input, ...target }, cfg, executorId);
        empty = admitted.outcome === "empty";
        if (admitted.outcome !== "admitted") return null;
        claim = admitted.claim;
        projectId = store.getSession(input.sessionId)!.projectId;
        const frozen = admitted.frozen;
        origin = frozen.range.origin;
        executionId = store.beginExecution({ sessionId: target.sessionId, phase, head: frozen.range.id, origin }, input.executionId);
        return frozen;
      }
      const pendingNow = phase === "noting" ? store.pendingEntries(target.sessionId, target.branch, target.headTurnId)
        : store.consolidationBatch(target.sessionId, target.branch, target.headTurnId);
      const boundary = input.boundary;
      // A frozen manual target (18b) counts only entries/facts inside its snapshot; later arrivals
      // do not turn "empty within the target" into "dropped", nor expand what a batch may take.
      // 27d/29e: the exact forms are read here exactly as the allowable ones are — none of the frozen members
      // still pending is "empty within the target"; a partial survivor is the drop `freezeNoting`
      // diagnoses below, never a silently smaller batch.
      empty = !boundary ? !pendingNow.length
        : phase === "noting" ? !pendingNow.some(e => (!boundary.exactEntryIds || boundary.exactEntryIds.includes((e as { id: number }).id))
            && (boundary.maxEntryId === undefined || (e as { id: number }).id <= boundary.maxEntryId))
        : !pendingNow.some(f => (!boundary.exactFactIds || boundary.exactFactIds.includes((f as { id: number }).id))
            && (!boundary.allowedFactIds || boundary.allowedFactIds.includes((f as { id: number }).id)));
      if (empty) return null;
      claim = store.acquireClaim(target, phase, executorId, input.borrowed, () => {
        if (input.executorSessionId !== undefined && !store.enabled(input.executorSessionId)) return false;
        if (!input.automatic || input.borrowed) return true;
        return taskEligibility(phase, target).due;
      });
      if (!claim) return null;
      projectId = store.getSession(input.sessionId)!.projectId;
      const selected = { ...input, ...target, ...(input.borrowed ? { mode: "subagent" as const } : {}) };
      const admittedOrigin = input.executionId ? store.executionOrigin(input.executionId) : store.triggerOrigin(target, target.triggerEntryId);
      // 70: `pendingNow` above already read this exact session/branch/head's full pending set inside
      // this same admission transaction; nothing between there and here can mark an entry noted, so
      // the freeze reuses it instead of reading it again.
      const frozen = phase === "noting" ? freezeNoting(store, selected, cfg, resultText, pendingNow as SourceEntryMeta[])
        : freezeConsolidation(store, selected, cfg);
      origin = admittedOrigin;
      const head = "entries" in frozen ? frozen.entries[0]?.id : frozen.rangeFacts[0]?.id;
      if (head !== undefined) executionId = store.beginExecution({ sessionId: target.sessionId, phase, head, origin }, input.executionId);
      return frozen;
    }); } catch (error) {
      // 27d repair 2: a batch frozen on exact membership whose evidence another executor already
      // processed is not an admission failure and not work to retry — the claim that completed it
      // has already been honoured, so this task simply drops, carrying the diagnostic that says so.
      if (error instanceof Error && (error.message.startsWith(NOTING_MEMBERSHIP) || error.message.startsWith(CONSOLIDATION_MEMBERSHIP))) return { outcome: "dropped", reason: error.message };
      throw new Error(error instanceof Error ? error.message : String(error), { cause: "task admission" });
    }
    if (!frozen || !claim) return { outcome: empty ? "empty" : "dropped" };
    const controller = new AbortController();
    let force!: (result?: RunAgentResult) => void;
    const progress: Partial<RunAgentResult> = {};
    const forced = new Promise<RunAgentResult>(resolve => { force = result => resolve(result ?? { ...progress, outcome: "cancelled", output: "executor cleanup deadline; provider completion and remaining usage unknown" }); });
    const task = { sessionId: target.sessionId, phase, executionId: executionId!, claimToken: (claim as TaskClaim).token, controller, force, close: () => {} };
    tasks.add(task);
    // 28b (parent 28 amendment 3): the admitting operation's own cancellation, linked to this task's
    // controller in exactly the shape `cancelTasks` uses for the whole executor — close the binding
    // first, release N/C ownership immediately, then abort the run. Dreamer retains its token for
    // terminal processing, as executor-wide cancellation does. Token matching preserves other claims;
    // finalization may safely release the old token again. `task.close` is read at abort time,
    // never captured, so the binding this closes is whichever one `bind` installed. The listener is
    // removed with the task below: a compaction that ends without cancelling leaves nothing attached
    // to its signal.
    const external = input.signal;
    const onExternalAbort = () => {
      task.close();
      try { if (!store.closed && phase !== "dreaming") store.releaseClaim(claim!); }
      catch { /* Finalization retries the same token and reports any remaining release failure. */ }
      finally { controller.abort(external!.reason); }
    };
    if (external?.aborted) onExternalAbort();
    else external?.addEventListener("abort", onExternalAbort, { once: true });
    const bind = (context: ToolContext, run: import("../store/index.ts").RunInput, consolidation?: ReturnType<typeof freezeConsolidation>, dreaming?: Parameters<typeof bindTools>[6]) => {
      run.claim = claim!; run.projectId = projectId; run.executorSessionId = input.executorSessionId;
      run.executionId = executionId!;
      if (input.borrowed) run.closedSessionScope = closedSessionScope;
      Object.assign(run, store.bindRunOrigin(run, origin));
      if (phase === "dreaming") Object.assign(run, store.bindDreamingRun(run));
      const binding = bindTools(store, read, input.maxReadChars === undefined ? context : { ...context, maxReadChars: input.maxReadChars },
        run, consolidation, undefined, dreaming, cfg.noting.nearThreshold);
      task.close = binding.close;
      return binding;
    };
    const agent: RunAgent = raw => {
      controller.signal.throwIfAborted();
      return Promise.race([runAgent({ ...raw as object, signal: controller.signal, thinkingLevel: input.thinkingLevel, subagentThinkingLevel: input.subagentThinkingLevel, fallbackReason: input.fallbackReason, forkAttempt: input.forkAttempt, cancellation: generation,
        reportProgress: (value: Partial<RunAgentResult>) => { Object.assign(progress, value); } }), forced]);
    };
    let result: NotingResult | ConsolidateResult | DreamingResult | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined, timedOut = false;
    if (phase === "dreaming") timeout = setTimeout(() => {
      // External cancellation owns its outcome even when the native worker ignores abort.
      if (controller.signal.aborted) return;
      timedOut = true;
      const reason = new Error(`Dreaming wall-clock limit exceeded (${cfg.dreaming.timeoutMs} ms)`);
      // Fence model writes before aborting native work. The existing forced-result seam settles the
      // exact range and claim even when a native worker does not cooperate; Promise.race retains a
      // rejection handler on that worker, so a late failure is not unowned.
      task.close();
      // Resolve the terminal failure before abort listeners can synchronously return "cancelled".
      force({ ...progress, outcome: "failure", output: `${reason.message}; provider completion and remaining usage unknown` });
      controller.abort(reason);
    }, cfg.dreaming.timeoutMs);
    try {
      result = phase === "noting"
        ? await runNoting(store, frozen as ReturnType<typeof freezeNoting>, agent, cfg, bind)
        : phase === "dreaming" ? await runDreaming(store, frozen as ReturnType<typeof freezeDreaming>, agent, bind)
        : await runConsolidation(store, frozen as ReturnType<typeof freezeConsolidation>, agent, cfg, bind);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      external?.removeEventListener("abort", onExternalAbort);
      task.close(); tasks.delete(task);
      const originalClaim = claim as TaskClaim; // assigned by the successful admission transaction
      const owned = () => {
        const current = store.getClaim(originalClaim.sessionId, originalClaim.phase);
        return current && current.token === originalClaim.token && current.executorId === originalClaim.executorId
          && !current.reserved && current.expiresAt > Date.now();
      };
      try {
        if (!store.closed && result && result.outcome !== "empty" && result.outcome !== "dropped") {
          const terminal = result;
          const settled = store.transaction(() => store.settleExecution(executionId!, terminal.outcome === "success" ? "success"
            : (controller.signal.aborted && !timedOut) || !owned() || !store.enabled(target.sessionId) || terminal.outcome === "cancelled" ? "cancelled"
            : terminal.outcome === "conflict" ? "conflict" : "failure",
            terminal.runId, terminal.problems?.join("; ")));
          if (settled.automaticOff) {
            terminal.automaticOff = settled.automaticOff;
            // The off/fence transaction has committed before invoking any local abort listener.
            abortTarget(target.sessionId);
          }
        }
      } finally {
        // Cleanup failure must neither roll back a terminal decision nor masquerade as one.
        try { if (!store.closed) store.transaction(() => {
          if (result?.outcome === "dropped" && "refused" in result && result.refused !== undefined) {
            if (owned()) result.executionId = executionId!;
            else result = { outcome: "dropped", reason: "task claim lost before fallback", ...(result.runId === undefined ? {} : { runId: result.runId }) };
          }
          store.releaseClaim(originalClaim);
        }); }
        catch (error) {
          if (result && result.outcome !== "dropped" && result.outcome !== "empty") result.problems = [...(result.problems ?? []), `claim release failed: ${String(error)}`];
          else throw error;
        }
      }
    }
    return result;
  };
  // A manual tool binding may be recreated between host calls. Keep exact full-body reads in
  // this database instance and target branch, never in a process-global or cross-database cache.
  const manualReads = new Map<string, Map<number, import("../store/index.ts").KnowledgeWithRevision>>();
  return {
    store, executorId, resultText, cancelTasks, taskEligibility, pendingTokens, dreamingPending, settleExecution,
    knowledgeBudgets: () => store.knowledgeBudgets(),
    setKnowledgeBudget: (field, value) => store.setKnowledgeBudget(field, value),
    get cancellation() { return cancellation; },
    forceTasks: () => { for (const task of tasks) { task.close(); task.force(); } },
    config: cfg,
    configure: (settings) => {
      // Reuse load validation, then restrict edits to the Noter mode and the borrowing scope.
      const requested = canonicalConfig(settings ?? {});
      if (!requested || typeof requested !== "object" || Array.isArray(requested)) throw new Error("Invalid configuration: expected an object");
      const reconfigurable: Record<string, string> = { noting: "forkModeDefault", consolidation: "forkModeDefault" };
      for (const [section, values] of Object.entries(requested)) {
        if (section === "closedSessionScope") continue;
        if (!Object.hasOwn(reconfigurable, section)) throw new Error(`Unknown setting ${section}`);
        if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`Invalid ${section}: expected an object`);
        for (const key of Object.keys(values)) if (key !== reconfigurable[section]) throw new Error(`Setting ${section}.${key} is not reconfigurable at runtime`);
      }
      const next = validateConfig({
        closedSessionScope: requested.closedSessionScope === undefined ? cfg.closedSessionScope : requested.closedSessionScope,
        render: cfg.render, noting: { ...cfg.noting, ...requested.noting }, consolidation: { ...cfg.consolidation, ...requested.consolidation }, dreaming: cfg.dreaming,
        compaction: cfg.compaction,
      });
      // One object identity throughout, so every existing reader sees the new default at its next
      // admission; nothing else of the frozen configuration moves.
      cfg.closedSessionScope = next.closedSessionScope;
      cfg.noting.forkModeDefault = next.noting.forkModeDefault;
      cfg.consolidation.forkModeDefault = next.consolidation.forkModeDefault;
    },
    close: () => {
      if (store.closed) return;
      try { cancelTasks(true); store.releaseExecutor(executorId); }
      finally { for (const task of tasks) task.force(); store.close(); }
    },
    appendEntry: (input, known) => store.appendSourceEntry(input, known),
    selectEntries: (sessionId, branch, ids) => store.selectSourcePath(sessionId, branch, ids),
    pendingEntries: (sessionId, branch, head) => store.pendingEntries(sessionId, branch, head),
    notingBatch: (target, boundary) => notingBatch(store, notingPending(store, { ...target, boundary }).pending, cfg, resultText).entries,
    tools: (context) => {
      const key = `${context.sessionId}/${context.branch}`;
      if (!manualReads.has(key)) manualReads.set(key, new Map());
      return bindTools(store, read, context, undefined, undefined, manualReads.get(key)).tools;
    },
    noting: input => execute("noting", input) as Promise<NotingResult>,
    consolidate: input => execute("consolidation", input) as Promise<ConsolidateResult>,
    dream: input => execute("dreaming", { ...input, mode: "subagent", effectiveMode: "subagent" }) as Promise<DreamingResult>,
    ...read,
    declareProject: (sessionId, name, source = "mark", path) => {
      const selected = path?.branch !== undefined && path.headTurnId !== null
        ? { sessionId: path.sessionId, branch: path.branch, headTurnId: path.headTurnId } : undefined;
      const project = store.declareProject(sessionId, name, source, selected && { path: selected, atTrigger: phase => phase === "noting"
        ? notingDue(selected)
        : phase === "consolidation" ? consolidationTokens(selected) >= cfg.consolidation.triggerTokens
        : store.duePools(selected, cfg.dreaming.triggerTokens).length > 0 });
      return `S${sessionId} project: ${project.name} (${store.projectDeclaration(sessionId)})`;
    },
  };
}
