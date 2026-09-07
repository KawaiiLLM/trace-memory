import { bindTools, type ToolContext, type ToolDefinition } from "./tools.ts";
export type { ToolContext, ToolDefinition } from "./tools.ts";
import { readFacade, type ListingOptions, type SearchScope, type MarkInput } from "./read.ts";
export type { ListingOptions, SearchScope, MarkInput } from "./read.ts";
// Hosts use this façade; persistence remains entirely in core/store.
import { realpathSync } from "node:fs";
import { freezeRecording, runRecording, type RecordInput, type RecordResult } from "../recording/index.ts";
import { finish, renderFact, renderTurn, renderKnowledgeTrace, renderKnowledgeDiff, renderNegationWalk, type NegationStep, type TurnOptions } from "../render/index.ts";
export { tokens } from "../render/index.ts";
export type { RecordInput, RecordResult, RecordingAgentInput } from "../recording/index.ts";
import { openStore, type Store } from "../store/index.ts";

import { freezeIntegration, runIntegration, type IntegrateInput, type IntegrateResult } from "../integration/index.ts";
export type { IntegrateInput, IntegrateResult, IntegrationAgentInput, IntegrationRange, NearPair, IntegrationDiagnostic } from "../integration/index.ts";

const inFlightIntegrations = new Set<string>();
const inFlightRecordings = new Set<string>();
let memoryDatabaseId = 0;

// ---- Flat config, defaults in one place (spec.md: render budgets, recording/integration triggers and modes) ----

export interface TraceMemoryConfig {
  render: {
    commandTokens: number;
    stdoutHeadTokens: number;
    stdoutTailTokens: number;
    stderrTailTokens: number;
    reportHeadTokens: number;
    reportTailTokens: number;
    knowledgeBlockTokens: number;
    episodicBlockTokens: number;
  };
  recording: {
    branchModeDefault: boolean;
    triggerAnsweredTurns: number;
    triggerTokens: number;
  };
  integration: {
    subagentModeDefault: boolean;
    triggerUnintegratedFacts: number;
    nearThreshold: number;
  };
}

export const DEFAULT_CONFIG: TraceMemoryConfig = {
  render: {
    commandTokens: 120,
    stdoutHeadTokens: 60,
    stdoutTailTokens: 120,
    stderrTailTokens: 120,
    reportHeadTokens: 200,
    reportTailTokens: 80,
    knowledgeBlockTokens: 10_000,
    episodicBlockTokens: 20_000,
  },
  recording: {
    branchModeDefault: true,
    triggerAnsweredTurns: 5,
    triggerTokens: 50_000,
  },
  integration: {
    subagentModeDefault: true,
    triggerUnintegratedFacts: 50,
    nearThreshold: 0.28,
  },
};

export type ConfigOverride = { [K in keyof TraceMemoryConfig]?: Partial<TraceMemoryConfig[K]> };

function mergeConfig(base: TraceMemoryConfig, override: ConfigOverride): TraceMemoryConfig {
  return {
    render: { ...base.render, ...override.render },
    recording: { ...base.recording, ...override.recording },
    integration: { ...base.integration, ...override.integration },
  };
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
  /** Host-owned continuation state of an integration candidate, handed back inside the final round's `continuation.response`; never stored. */
  state?: unknown;
}

export type RunAgent = (input: unknown) => Promise<RunAgentResult>;

// ---- Façade ----

export interface TraceMemory {
  readonly store: Store;
  readonly config: TraceMemoryConfig;
  close(): void;
  tools(context: ToolContext): ToolDefinition[];
  record(input: RecordInput): Promise<RecordResult>;
  integrate(input: IntegrateInput): Promise<IntegrateResult>;
  /** Committed lineage facts and unrecorded raw, without consuming deliveries or dropping facts. */
  branchSummary(sessionId: number, branch: string, headTurnId: number): string;
  compact(sessionId: number, branch?: string, headTurnId?: number): string;
  /** A session id after the first reply; before it exists (first prompt), the project alone: global + project knowledge, no deliveries. */
  inject(target: number | { projectId: number }): string;
  /** Pending recording results for this session and branch, rendered once and marked delivered; "" when none. */
  deliver(sessionId: number, branch?: string | null): string;
  trace(address: string, options?: ListingOptions): string;
  search(query: string, scope?: SearchScope, options?: ListingOptions & { sessionId?: number }): string;
  mark(input: MarkInput): string;
  status(sessionId: number): string;
}

export function TraceMemory(dbPath: string, runAgent: RunAgent, config: ConfigOverride = {}): TraceMemory {
  const store = openStore(dbPath);
  const cfg = mergeConfig(DEFAULT_CONFIG, config);

  const databaseIdentity = dbPath === ":memory:" ? `:memory:${++memoryDatabaseId}` : realpathSync(dbPath);
  const trace = (address: string, display: ListingOptions = {}): string => {
    const [target, ...flags] = address.trim().split(/\s+/);
    const invalid = () => new Error(`invalid trace address: ${address}`);
    const knowledgeMatch = /^K([1-9]\d*)(?:@([1-9]\d*)(?:\.\.([1-9]\d*))?)?$/.exec(target ?? "");
    if (knowledgeMatch) {
      const [id, from, to] = knowledgeMatch.slice(1).map((n) => n === undefined ? undefined : Number(n));
      if (flags.length || [id, from, to].some((n) => n !== undefined && !Number.isSafeInteger(n)) ||
          (to !== undefined && to < from!)) throw invalid();
      const knowledge = store.getKnowledge(id!);
      if (!knowledge) throw new Error(`knowledge K${id} does not exist`);
      const visible = (rev: number) => display.sessionId === undefined || store.isKnowledgeVisible(id!, display.sessionId, rev);
      const history = store.listKnowledgeRevisions(id!).filter((r) => visible(r.rev));
      const revision = (rev: number) => {
        if (!visible(rev)) throw new Error("knowledge revision is not visible in this session");
        const value = store.getKnowledgeRevision(id!, rev);
        if (!value) throw new Error(`knowledge K${id} has no revision ${rev}`);
        return value;
      };
      if (to !== undefined) return renderKnowledgeDiff(revision(from!), revision(to),
        history.filter((r) => r.rev > from! && r.rev <= to));
      if (from !== undefined) return renderKnowledgeTrace({ knowledge, revision: revision(from) }, undefined, [], store.listKnowledgeMarks(id!));
      return renderKnowledgeTrace({ knowledge, revision: revision(knowledge.currentRevision) },
        history, store.listKnowledgeLinks(id!).filter((l) => display.sessionId === undefined || store.isKnowledgeVisible(l.toKnowledge, display.sessionId, l.toRev)), store.listKnowledgeMarks(id!));
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
        const relations = store.listFactRelations(id).filter((r) => display.sessionId === undefined || [r.fromFact, r.toFact].every((id) => {
          const fact = store.getFact(id)!; return store.getSession(store.getTurn(fact.turnId)!.sessionId)?.projectId === store.getSession(display.sessionId!)?.projectId;
        }));
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
    const turnMatch = /^(?:S([1-9]\d*)\/)?T([1-9]\d*)$/.exec(target ?? "");
    if (!turnMatch || !Number.isSafeInteger(Number(turnMatch[2]))) throw invalid();
    const sessionOfAddress = turnMatch[1] === undefined ? undefined : Number(turnMatch[1]);
    if (flags.length) throw new Error("invalid trace address: use tool and full parameters");
    const options: TurnOptions = { tool: display.tool, full: display.full };
    const turn = store.getTurn(Number(turnMatch[2]));
    if (!turn) throw new Error(`turn ${target} does not exist`);
    if (sessionOfAddress !== undefined && turn.sessionId !== sessionOfAddress) throw new Error(`turn ${target} does not exist`);
    const calls = store.listToolCalls(turn.id);
    if (options.tool !== undefined && !calls.some((c) => c.ordinal === options.tool)) throw new Error(`tool #t${options.tool} does not exist in ${target}`);
    return finish(renderTurn(turn, calls, cfg.render, options));
  };

  const read = readFacade(store, cfg, trace);
  return {
    store,
    config: cfg,
    close: () => store.close(),
    tools: (context) => bindTools(store, read, context).tools,
    record: async (input) => {
      const key = JSON.stringify([databaseIdentity, input.sessionId, input.branch]);
      if (inFlightRecordings.has(key)) return { outcome: "dropped" };
      inFlightRecordings.add(key);
      try {
        const frozen = freezeRecording(store, input, cfg);
        return await runRecording(store, frozen, runAgent, cfg, (context, run) => bindTools(store, read, context, run));
      } finally { inFlightRecordings.delete(key); }
    },
    integrate: async (input) => {
      const session = store.getSession(input.sessionId);
      if (!session) throw new Error(`session S${input.sessionId} does not exist`);
      const key = JSON.stringify([databaseIdentity, input.sessionId, input.branch]);
      if (inFlightIntegrations.has(key)) return { outcome: "dropped" };
      inFlightIntegrations.add(key);
      try {
        const frozen = freezeIntegration(store, input, cfg);
        return await runIntegration(store, frozen, runAgent, cfg);
      } finally { inFlightIntegrations.delete(key); }
    },
    ...read,
  };
}
