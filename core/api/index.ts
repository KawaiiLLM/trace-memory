export { toolDefinitions, validateReadInput } from "./tools.ts";
import { bindTools, type ToolContext, type ToolDefinition } from "./tools.ts";
export type { ToolContext, ToolDefinition } from "./tools.ts";
import { readFacade, type ListingOptions, type SearchScope } from "./read.ts";
export type { ListingOptions, SearchScope } from "./read.ts";
// Hosts use this façade; persistence remains entirely in core/store.
import { realpathSync } from "node:fs";
import { freezeNoting, runNoting, type NotingInput, type NotingResult } from "../noting/index.ts";
import { finish, renderFact, renderRun, renderTurn, renderKnowledgeTrace, renderKnowledgeDiff, renderCommitHistory, renderNegationWalk, type NegationStep, type TurnOptions } from "../render/index.ts";
export { tokens, renderEntry, ENTRY_VIEW_VERSION } from "../render/index.ts";
export { enrollmentDefault } from "../store/index.ts";
export type { Enrollment } from "../store/index.ts";
export type { SourceInput, SourceEntry } from "../store/index.ts";
export type { NotingInput, NotingResult, NotingAgentInput } from "../noting/index.ts";
import { Store, type SourceInput, type SourceEntry, type KnowledgePath } from "../store/index.ts";

import { freezeConsolidation, runConsolidation, type ConsolidateInput, type ConsolidateResult } from "../consolidation/index.ts";
export type { ConsolidateInput, ConsolidateResult, ConsolidationAgentInput, ConsolidationRange, NearPair, ConsolidationDiagnostic } from "../consolidation/index.ts";

const inFlightConsolidations = new Set<string>();
const inFlightNotings = new Set<string>();
let memoryDatabaseId = 0;

// ---- Flat config, defaults in one place (spec.md: render budgets, noting/consolidation triggers and modes) ----

export interface TraceMemoryConfig {
  render: {
    toolCallTokens: number;
    entryTokens: number;
    commandTokens: number;
    stdoutHeadTokens: number;
    stdoutTailTokens: number;
    stderrTailTokens: number;
    reportHeadTokens: number;
    reportTailTokens: number;
    knowledgeBlockTokens: number;
    episodicBlockTokens: number;
  };
  noting: {
    branchModeDefault: boolean;
    batchTokens: number;
    triggerTokens: number;
    /** Tool rounds a run may take before it fails; 0 = unlimited (the model stops when it stops). */
    maxToolRounds: number;
  };
  consolidation: {
    subagentModeDefault: boolean;
    triggerUnconsolidatedFacts: number;
    nearThreshold: number;
    maxToolRounds: number;
  };
}

export const DEFAULT_CONFIG: TraceMemoryConfig = {
  render: {
    toolCallTokens: 1_000,
    entryTokens: 10_000,
    commandTokens: 120,
    stdoutHeadTokens: 60,
    stdoutTailTokens: 120,
    stderrTailTokens: 120,
    reportHeadTokens: 200,
    reportTailTokens: 80,
    knowledgeBlockTokens: 10_000,
    episodicBlockTokens: 20_000,
  },
  noting: {
    branchModeDefault: true,
    batchTokens: 50_000,
    triggerTokens: 10_000,
    maxToolRounds: 0,
  },
  consolidation: {
    subagentModeDefault: true,
    triggerUnconsolidatedFacts: 50,
    nearThreshold: 0.28,
    maxToolRounds: 0,
  },
};

export type ConfigOverride = { [K in keyof TraceMemoryConfig]?: Partial<TraceMemoryConfig[K]> };

function mergeConfig(base: TraceMemoryConfig, override: ConfigOverride): TraceMemoryConfig {
  if (!override || typeof override !== "object" || Array.isArray(override)) throw new Error("Invalid configuration: expected an object");
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
  }
  return cfg;
}

// ---- runAgent contract (spec.md: Contracts, Run record contract) ----

export interface RunAgentResult {
  outcome: "success" | "failure" | "cancelled";
  output: unknown;
  usage?: unknown;
  request?: unknown;
  mode?: "branch" | "subagent";
  verification?: unknown;
  fallbackReason?: string;
  /** Transient provider errors retried by the host before this reply, in order. */
  retries?: { attempt: number; error: string }[];

}

export type RunAgent = (input: unknown) => Promise<RunAgentResult>;

// ---- Façade ----

export interface TraceMemory {
  readonly store: Store;
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
  compact(sessionId: number, branch?: string, headTurnId?: number): string;
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

export function TraceMemory(dbPath: string, runAgent: RunAgent, config: ConfigOverride = {}): TraceMemory {
  const cfg = validateConfig(config);
  const store = new Store(dbPath);
  const databaseIdentity = dbPath === ":memory:" ? `:memory:${++memoryDatabaseId}` : realpathSync(dbPath);
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
      const tips = store.currentCommit(id!, path);
      const applicable = history.filter(r => !path || store.commitApplies(r, path));
      const otherTips = path ? store.currentCommit(id!).filter(r => !store.commitApplies(r, path)) : [];
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
    const originals = options.full ? calls.map(call => {
      const results = store.listSourceEntries(turn.sessionId).filter(e => e.turnId === turn.id && e.role === "toolResult")
        .flatMap(e => e.calls.filter(c => c.ordinal === call.ordinal).map(c => ({ entry: e, call: c })));
      return results.length < 2 ? call : { ...call, status: "multiple results", result: results.map(({ entry: e, call: c }) =>
        `[entry ${JSON.stringify([e.nativeLineage, e.nativeId])}] status=${c.status}\n${c.result ?? ""}`).join("\n") };
    }) : calls;
    return finish(renderTurn(turn, originals, cfg.render, options));
  };

  const read = readFacade(store, cfg, trace);
  return {
    store,
    config: cfg,
    close: () => store.close(),
    appendEntry: input => store.appendSourceEntry(input),
    selectEntries: (sessionId, branch, ids) => store.selectSourcePath(sessionId, branch, ids),
    pendingEntries: (sessionId, branch, head) => store.pendingEntries(sessionId, branch, head),
    tools: (context) => bindTools(store, read, context).tools,
    noting: async (input) => {
      if (!store.enabled(input.sessionId)) return { outcome: "dropped" };
      const key = JSON.stringify([databaseIdentity, input.sessionId, input.branch]);
      if (inFlightNotings.has(key)) return { outcome: "dropped" };
      inFlightNotings.add(key);
      try {
        const frozen = freezeNoting(store, input, cfg);
        return await runNoting(store, frozen, runAgent, cfg, (context, run) => bindTools(store, read, context, run));
      } finally { inFlightNotings.delete(key); }
    },
    consolidate: async (input) => {
      if (!store.enabled(input.sessionId)) return { outcome: "dropped" };
      const session = store.getSession(input.sessionId);
      if (!session) throw new Error(`session S${input.sessionId} does not exist`);
      const key = JSON.stringify([databaseIdentity, input.sessionId, input.branch]);
      if (inFlightConsolidations.has(key)) return { outcome: "dropped" };
      inFlightConsolidations.add(key);
      try {
        const frozen = freezeConsolidation(store, input, cfg);
        return await runConsolidation(store, frozen, runAgent, cfg, (context, run, review) => bindTools(store, read, context, run, review));
      } finally { inFlightConsolidations.delete(key); }
    },
    ...read,
  };
}
