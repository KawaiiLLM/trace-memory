import { readFacade, type ListingOptions, type SearchScope, type MarkInput } from "./read.ts";
export type { ListingOptions, SearchScope, MarkInput } from "./read.ts";
// Hosts use this façade; persistence remains entirely in core/store.
import { realpathSync } from "node:fs";
import { freezeNote, runNote, type NoteInput, type NoteResult } from "../note/index.ts";
import { finish, renderFact, renderTurn, renderEntryTrace, renderEntryDiff, renderNegationWalk, type NegationStep, type TurnOptions } from "../render/index.ts";
export { tokens } from "../render/index.ts";
export type { NoteInput, NoteResult, NoteAgentInput } from "../note/index.ts";
import { openStore, type Store } from "../store/index.ts";
import type { RunOutcome } from "../model/index.ts";

import { freezeSettle, runSettle, type SettleInput, type SettleResult } from "../settle/index.ts";
export type { SettleInput, SettleResult, SettleAgentInput, SettleRange, NearPair, SettleDiagnostic } from "../settle/index.ts";

const inFlightSettles = new Set<string>();
const inFlightNotes = new Set<string>();
let memoryDatabaseId = 0;

// ---- Flat config, defaults in one place (spec.md: render budgets, note/settle triggers and modes) ----

export interface TraceMemoryConfig {
  render: {
    commandTokens: number;
    stdoutHeadTokens: number;
    stdoutTailTokens: number;
    stderrTailTokens: number;
    reportHeadTokens: number;
    reportTailTokens: number;
    entriesBlockTokens: number;
    episodicBlockTokens: number;
  };
  note: {
    branchModeDefault: boolean;
    triggerAnsweredTurns: number;
    triggerTokens: number;
  };
  settle: {
    subagentModeDefault: boolean;
    triggerUnsettledFacts: number;
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
    entriesBlockTokens: 10_000,
    episodicBlockTokens: 20_000,
  },
  note: {
    branchModeDefault: true,
    triggerAnsweredTurns: 5,
    triggerTokens: 50_000,
  },
  settle: {
    subagentModeDefault: true,
    triggerUnsettledFacts: 50,
    nearThreshold: 0.28,
  },
};

export type ConfigOverride = { [K in keyof TraceMemoryConfig]?: Partial<TraceMemoryConfig[K]> };

function mergeConfig(base: TraceMemoryConfig, override: ConfigOverride): TraceMemoryConfig {
  return {
    render: { ...base.render, ...override.render },
    note: { ...base.note, ...override.note },
    settle: { ...base.settle, ...override.settle },
  };
}

// ---- runAgent contract (spec.md: Contracts, Run record contract) ----

export interface RunAgentResult {
  outcome: RunOutcome;
  output: unknown;
  usage?: unknown;
  request?: unknown;
  mode?: "branch" | "subagent";
  verification?: unknown;
  fallbackReason?: string;
  /** Host-owned continuation state of a settle candidate, handed back inside the final round's `continuation.response`; never stored. */
  state?: unknown;
}

export type RunAgent = (input: unknown) => Promise<RunAgentResult>;

// ---- Façade ----

export interface TraceMemory {
  readonly store: Store;
  readonly config: TraceMemoryConfig;
  close(): void;
  note(input: NoteInput): Promise<NoteResult>;
  settle(input: SettleInput): Promise<SettleResult>;
  /** Committed lineage facts and unnoted raw, without consuming deliveries or dropping facts. */
  branchSummary(sessionId: number, branch: string, headTurnId: number): string;
  compact(sessionId: number, branch?: string, headTurnId?: number): string;
  /** A session id after the first reply; before it exists (first prompt), the project alone: global + project entries, no deliveries. */
  inject(target: number | { projectId: number }): string;
  /** Pending note results for this session and branch, rendered once and marked delivered; "" when none. */
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
  const trace = (address: string): string => {
    const [target, ...flags] = address.trim().split(/\s+/);
    const invalid = () => new Error(`invalid trace address: ${address}`);
    const entryMatch = /^E([1-9]\d*)(?:@([1-9]\d*)(?:\.\.([1-9]\d*))?)?$/.exec(target ?? "");
    if (entryMatch) {
      const [id, from, to] = entryMatch.slice(1).map((n) => n === undefined ? undefined : Number(n));
      if (flags.length || [id, from, to].some((n) => n !== undefined && !Number.isSafeInteger(n)) ||
          (to !== undefined && to < from!)) throw invalid();
      const entry = store.getEntry(id!);
      if (!entry) throw new Error(`entry E${id} does not exist`);
      const revision = (rev: number) => {
        const value = store.getEntryRevision(id!, rev);
        if (!value) throw new Error(`entry E${id} has no revision ${rev}`);
        return value;
      };
      if (to !== undefined) return renderEntryDiff(revision(from!), revision(to),
        store.listEntryRevisions(id!).filter((r) => r.rev > from! && r.rev <= to));
      if (from !== undefined) return renderEntryTrace({ entry, revision: revision(from) }, undefined, [], store.listMarks(id!));
      return renderEntryTrace({ entry, revision: revision(entry.currentRevision) },
        store.listEntryRevisions(id!), store.listEntryLinks(id!), store.listMarks(id!));
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
    const turnMatch = /^(?:S([1-9]\d*)\/)?T([1-9]\d*)$/.exec(target ?? "");
    if (!turnMatch || !Number.isSafeInteger(Number(turnMatch[2]))) throw invalid();
    const sessionOfAddress = turnMatch[1] === undefined ? undefined : Number(turnMatch[1]);
    const options: TurnOptions = {};
    for (const flag of flags) {
      if (flag === "full") options.full = true;
      else if (/^tool=[1-9]\d*$/.test(flag)) options.tool = Number(flag.slice(5));
      else if (/^cap=\d+$/.test(flag) && Number.isSafeInteger(Number(flag.slice(4)))) options.cap = Number(flag.slice(4));
      else throw new Error(`invalid trace option: ${flag}`);
    }
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
    note: async (input) => {
      const key = JSON.stringify([databaseIdentity, input.sessionId, input.branch]);
      if (inFlightNotes.has(key)) return { outcome: "dropped" };
      inFlightNotes.add(key);
      try {
        const frozen = freezeNote(store, input, cfg);
        return await runNote(store, frozen, runAgent, cfg, read.trace);
      } finally { inFlightNotes.delete(key); }
    },
    settle: async (input) => {
      const session = store.getSession(input.sessionId);
      if (!session) throw new Error(`session S${input.sessionId} does not exist`);
      const key = JSON.stringify([databaseIdentity, input.sessionId, input.branch]);
      if (inFlightSettles.has(key)) return { outcome: "dropped" };
      inFlightSettles.add(key);
      try {
        const frozen = freezeSettle(store, input, cfg);
        return await runSettle(store, frozen, runAgent, cfg);
      } finally { inFlightSettles.delete(key); }
    },
    ...read,
  };
}
