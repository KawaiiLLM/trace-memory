export { toolDefinitions, validateReadInput } from "./tools.ts";
import { bindTools, type ToolContext, type ToolDefinition } from "./tools.ts";
export type { ToolContext, ToolDefinition } from "./tools.ts";
import { readFacade, type ListingOptions, type SearchScope, type CompactResult, type TopicGroups } from "./read.ts";
export type { ListingOptions, SearchScope, CompactResult, TopicGroups } from "./read.ts";
// Hosts use this façade; persistence remains entirely in core/store.
import { randomUUID } from "node:crypto";
import { freezeNoting, runNoting, type NotingInput, type NotingResult } from "../noting/index.ts";
import { finish, renderFact, renderRun, renderTurn, renderTrace, renderKnowledgeTrace, renderKnowledgeDiff, renderCommitHistory, renderNegationWalk, type NegationStep, type TurnOptions } from "../render/index.ts";
import { tokens, renderEntry, rawResultText, type ResultExtractor } from "../render/index.ts";
export { tokens, renderEntry, rawResultText, finish, runMode, ENTRY_VIEW_VERSION } from "../render/index.ts";
export type { EntryProfile, ResultText, ResultExtractor } from "../render/index.ts";
// 20a: core owns the domain text of every memory consumer. A host places this text; it does not lay
// out knowledge, facts or Raw itself.
export { notingText, notingIncrement, consolidationText, consolidationIncrement, injectionText, compactText, knowledgeBlock } from "../render/material.ts";
export type { SharedMaterial, KnowledgeGroup, MaterialText, TaskRange } from "../render/material.ts";
export { enrollmentDefault } from "../store/index.ts";
export type { Enrollment } from "../store/index.ts";
export type { SourceInput, SourceEntry } from "../store/index.ts";
export type { NotingInput, NotingResult, NotingAgentInput, NotingMaterial, EntryAudit } from "../noting/index.ts";
import { Store, type SourceInput, type SourceEntry, type KnowledgePath, type Phase, type TaskClaim, type TaskTarget } from "../store/index.ts";

import { freezeConsolidation, runConsolidation, type ConsolidateInput, type ConsolidateResult } from "../consolidation/index.ts";
export type { ConsolidateInput, ConsolidateResult, ConsolidationAgentInput, ConsolidationMaterial, ConsolidationRange, NearPair, ConsolidationDiagnostic } from "../consolidation/index.ts";


// ---- Flat config, defaults in one place (spec.md: render budgets, noting/consolidation triggers and modes) ----

export interface TraceMemoryConfig {
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
    subagentModeDefault: boolean;
    /** Ticket 20: rendered tokens of applicable unconsolidated facts that make a run due. */
    triggerTokens: number;
    /** Ticket 20: the most rendered fact tokens one batch may select. */
    batchTokens: number;
    nearThreshold: number;
    maxToolRounds: number;
  };
}

export const DEFAULT_CONFIG: TraceMemoryConfig = {
  render: {
    toolCallTokens: 300,
    entryTokens: 10_000,
    secondaryToolCallTokens: 100,
    secondaryEntryTokens: 150,
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
    subagentModeDefault: true,
    triggerTokens: 5_000,
    batchTokens: 10_000,
    nearThreshold: 0.28,
    maxToolRounds: 0,
  },
};

export type ConfigOverride = {
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

/** Settings a ruling removed, and what replaces each (ticket 20 "Configuration"). A removed key is
 * not an alias: an old fact count is never reinterpreted as tokens, so any layer supplying one fails
 * the load naming the key and its replacement. The same two functions below enforce it for the flat
 * `section.key` settings space and for the nested `ConfigOverride`, and the read-only menu shows it
 * nowhere, because it builds itself from `DEFAULT_CONFIG`. */
export const REMOVED_SETTINGS: Readonly<Record<string, string>> = {
  "consolidation.triggerUnconsolidatedFacts": "consolidation.triggerTokens (tokens, not a count)",
  // Ticket 23: the stdout/stderr branch they budgeted reads a result shape Pi never produces, so they
  // were never effective on any Pi run; the uniform entry rule and `render.toolCallTokens` replace them.
  "render.stdoutHeadTokens": "render.toolCallTokens (one budget for the whole tool call)",
  "render.stdoutTailTokens": "render.toolCallTokens (one budget for the whole tool call)",
  "render.stderrTailTokens": "render.toolCallTokens (one budget for the whole tool call)",
  // Ticket 23b: the per-tool branches of the explicit Turn preview they budgeted are gone — an
  // explicit `trace` without `full` is the entry view under the tier-1 profile, and `full` renders
  // the stored evidence uncut, so neither has a budget of its own any more.
  "render.commandTokens": "render.toolCallTokens (one budget for the whole tool call)",
  "render.reportHeadTokens": "render.toolCallTokens (one budget for the whole tool call)",
  "render.reportTailTokens": "render.toolCallTokens (one budget for the whole tool call)",
};
const removedSetting = (key: string) => new Error(`Removed setting ${key}: use ${REMOVED_SETTINGS[key]}`);

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
    const defaults = base[section as keyof TraceMemoryConfig];
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`Invalid ${section}: expected an object`);
    for (const key of Object.keys(values)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown setting ${section}.${key}`);
  }
  return {
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
  for (const [section, values] of Object.entries(cfg)) for (const [key, value] of Object.entries(values)) {
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
  /** Absolute path of the host's native worker log for this run, when the host writes one (19a). */
  nativeLog?: string;
  /** Transient provider errors retried by the host before this reply, in order. */
  retries?: { attempt: number; error: string }[];

}

/** A manual catchup's frozen target: `maxEntryId` bounds Noting to entries allocated no later than
 * the freeze instant; `factIds` bounds Consolidation to the frozen pending-plus-produced fact set.
 * Absent, selection is the ordinary unbounded pending set (18b). */
export interface TaskBoundary { maxEntryId?: number; factIds?: number[] }
export interface TaskOptions {
  borrowed?: boolean; automatic?: boolean; executorSessionId?: number; boundary?: TaskBoundary;
  /** The mode the host will actually run this task in when it differs from the requested `mode`
   * (a requested fork resolved to subagent by the host's cache-miss latch). Admission's delivery
   * pause follows it; the requested mode is still recorded (review 2026-09-08). */
  effectiveMode?: "fork" | "subagent";
}
export interface AgentControl {
  signal?: AbortSignal;
  reportProgress?: (progress: Partial<RunAgentResult>) => void;
}

export type RunAgent = (input: unknown) => Promise<RunAgentResult>;

// ---- Façade ----

export interface TraceMemory {
  readonly store: Store;
  readonly executorId: string;
  /** Ticket 23 "Host contract": the result-text extractor this host registered at construction. Core
   * applies it wherever it renders an entry and never inspects envelope fields itself. */
  readonly resultText: ResultExtractor;
  taskEligibility(phase: Phase, target: TaskTarget, mode: "fork" | "subagent"): { due: boolean; paused: boolean };
  /** Fence owned tokens before requesting cancellation; stopping prevents later admission. */
  cancelTasks(stopping?: boolean): void;
  /** End local waits at teardown's deadline; provider promises remain rejection-handled. */
  forceTasks(): void;
  readonly config: TraceMemoryConfig;
  close(): void;
  appendEntry(input: SourceInput): SourceEntry;
  selectEntries(sessionId: number, branch: string, entryIds: number[]): void;
  pendingEntries(sessionId: number, branch: string, headTurnId: number): SourceEntry[];
  tools(context: ToolContext): ToolDefinition[];
  noting(input: NotingInput): Promise<NotingResult>;
  consolidate(input: ConsolidateInput): Promise<ConsolidateResult>;
  /** Committed lineage facts and unrecorded raw, without consuming deliveries or dropping facts. */
  branchSummary(sessionId: number, branch: string, headTurnId: number): string;
  /** Ticket 20: the escalating compaction result — primary views, secondary views, or the explicit
   * ask that the host decline and let its native compaction run (20c). */
  compact(sessionId: number, branch?: string, headTurnId?: number): CompactResult;
  /** Ticket 21b: the path-selected applicable knowledge grouped by topic, as commit references; a
   * read projection only — it neither reorders injection nor changes what is applicable. */
  topicGroups(sessionId: number, headTurnId?: number | null, branch?: string): TopicGroups;
  /** A session id after the first reply; before it exists (first prompt), the project alone: global + project knowledge, no deliveries. */
  inject(target: number | { projectId: number } | KnowledgePath): string;
  /** Pending noting results for this session and branch, rendered once and marked delivered; "" when none. */
  /** Pending noting results for this session and branch, rendered but not consumed; "" when none. */
  deliver(sessionId: number, branch?: string | null): { text: string; runIds: number[] };
  /** Marks the given deliveries consumed once the host has persisted them. */
  confirmDelivery(runIds: number[]): void;
  trace(address: string, options?: ListingOptions): string;
  search(query: string, scope?: SearchScope, options?: ListingOptions & { sessionId?: number }): string;
  mark(address: number | string, kind: "verified" | "flagged" | "clear", path?: KnowledgePath): string;
  declareProject(sessionId: number, name: string, source?: "marker" | "mark"): string;
  status(sessionId: number): string;
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
  const cancelTasks = (stop = false) => {
    stopping ||= stop;
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
    if (!options.full) return finish(renderTrace(turn, store.listSourceEntries(turn.sessionId, turn.id, display.branch), cfg.render, options, resultText));
    // 22c: this Turn's native result occurrences, obtained once and reused across its tool ordinals
    // instead of loading the whole session per call. Every call is still described from them — the
    // unselected ones by their own character counts — so metadata and omission receipts are unchanged.
    const occurrences = store.listSourceEntries(turn.sessionId, turn.id).filter(e => e.role === "toolResult");
    const originals = calls.map(call => {
      const results = occurrences.flatMap(e => e.calls.filter(c => c.ordinal === call.ordinal).map(c => ({ entry: e, call: c })));
      return results.length < 2 ? call : { ...call, status: "multiple results", result: results.map(({ entry: e, call: c }) =>
        `[entry ${JSON.stringify([e.nativeLineage, e.nativeId])}] status=${c.status}\n${c.result ?? ""}`).join("\n") };
    });
    return finish(renderTurn(turn, originals, options));
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
  const taskEligibility = (phase: Phase, target: TaskTarget, mode: "fork" | "subagent") => {
    if (stopping || store.closed || !store.enabled(target.sessionId)) return { due: false, paused: false };
    const due = phase === "noting" ? notingDue(target)
      // Ticket 20: the same rendered representation, relations and separator the batch selects with;
      // historical facts and knowledge contribute nothing to the trigger.
      : tokens(store.consolidationBatch(target.sessionId, target.branch, target.headTurnId)
        .map(f => renderFact(f, store.listFactRelations(f.id))).join("\n")) >= cfg.consolidation.triggerTokens;
    const paused = mode === "fork" && store.listPendingDeliveries(target.sessionId, target.branch)
      .some(p => phase === "consolidation" || store.getRun(p.runId)?.kind === "noting");
    return { due, paused };
  };
  const execute = async (phase: Phase, input: NotingInput | ConsolidateInput): Promise<NotingResult | ConsolidateResult> => {
    if (stopping || store.closed || !store.enabled(input.sessionId)) return { outcome: "dropped" };
    const target = { sessionId: input.sessionId, branch: input.branch,
      headTurnId: input.headTurnId ?? store.knowledgePath(input.sessionId, input.branch).headTurnId! };
    let claim: TaskClaim | null = null;
    let empty = false, projectId: number;
    let frozen: ReturnType<typeof freezeNoting> | ReturnType<typeof freezeConsolidation> | null;
    try { frozen = store.transaction(() => {
      const pendingNow = phase === "noting" ? store.pendingEntries(target.sessionId, target.branch, target.headTurnId)
        : store.consolidationBatch(target.sessionId, target.branch, target.headTurnId);
      const boundary = input.boundary;
      // A frozen manual target (18b) counts only entries/facts inside its snapshot; later arrivals
      // do not turn "empty within the target" into "dropped", nor expand what a batch may take.
      empty = !boundary ? !pendingNow.length
        : phase === "noting" ? !pendingNow.some(e => boundary.maxEntryId === undefined || (e as { id: number }).id <= boundary.maxEntryId)
        : !pendingNow.some(f => !boundary.factIds || boundary.factIds.includes((f as { id: number }).id));
      if (empty) return null;
      claim = store.acquireClaim(target, phase, executorId, input.borrowed, () => {
        if (input.executorSessionId !== undefined && !store.enabled(input.executorSessionId)) return false;
        if (!input.automatic || input.borrowed) return true;
        const mode = input.mode ?? (phase === "noting" ? (cfg.noting.forkModeDefault ? "fork" : "subagent") : (cfg.consolidation.subagentModeDefault ? "subagent" : "fork"));
        const { due, paused } = taskEligibility(phase, target, input.effectiveMode ?? mode);
        return due && !paused;
      });
      if (!claim) return null;
      projectId = store.getSession(input.sessionId)!.projectId;
      const selected = { ...input, ...target, ...(input.borrowed ? { mode: "subagent" as const } : {}) };
      return phase === "noting" ? freezeNoting(store, selected, cfg, resultText) : freezeConsolidation(store, selected, cfg);
    }); } catch (error) {
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
      const binding = bindTools(store, read, context, run, review);
      task.close = binding.close;
      return binding;
    };
    const agent: RunAgent = raw => {
      controller.signal.throwIfAborted();
      return Promise.race([runAgent({ ...raw as object, signal: controller.signal,
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
        if (result && "runId" in result) result.problems = [...(result.problems ?? []), `claim release failed: ${String(error)}`];
        else throw error;
      }
    }
    return result;
  };
  return {
    store, executorId, resultText, cancelTasks, taskEligibility,
    forceTasks: () => { for (const task of tasks) { task.close(); task.force(); } },
    config: cfg,
    close: () => {
      if (store.closed) return;
      try { cancelTasks(true); store.releaseExecutor(executorId); }
      finally { for (const task of tasks) task.force(); store.close(); }
    },
    appendEntry: input => store.appendSourceEntry(input),
    selectEntries: (sessionId, branch, ids) => store.selectSourcePath(sessionId, branch, ids),
    pendingEntries: (sessionId, branch, head) => store.pendingEntries(sessionId, branch, head),
    tools: (context) => bindTools(store, read, context).tools,
    noting: input => execute("noting", input) as Promise<NotingResult>,
    consolidate: input => execute("consolidation", input) as Promise<ConsolidateResult>,
    ...read,
  };
}
