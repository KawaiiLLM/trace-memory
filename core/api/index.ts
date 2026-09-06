// core/api — the façade hosts call. TraceMemory(dbPath, runAgent, config) exposes the
// method signatures from .scratch/v1/spec.md (core/api, "core/api" module paragraph):
// note, settle, compact, inject, trace, search, mark, status.
//
// This ticket wires the skeleton and the flat config object only. All eight methods throw
// NotImplementedError; their behaviour (note extraction, settlement, rendering, addressing)
// is later tickets. Tests exercise the store's public interface directly for behaviour, and
// this façade only for its own shape: construction, config defaults, and the NotImplemented
// contract.

import { openStore, type Store } from "../store/index";
import type { RunOutcome } from "../model/index";

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
  },
};

function mergeConfig(base: TraceMemoryConfig, override: Partial<TraceMemoryConfig>): TraceMemoryConfig {
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
}

export type RunAgent = (input: unknown) => Promise<RunAgentResult>;

// ---- NotImplemented (this ticket's methods are a skeleton only) ----

export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`TraceMemory.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}

// ---- Façade ----

export interface TraceMemory {
  readonly store: Store;
  readonly config: TraceMemoryConfig;
  close(): void;
  note(input: unknown): Promise<unknown>;
  settle(input: unknown): Promise<unknown>;
  compact(input: unknown): unknown;
  inject(input: unknown): unknown;
  trace(address: string): unknown;
  search(query: string): unknown;
  mark(input: unknown): unknown;
  status(sessionId: number): unknown;
}

export function TraceMemory(dbPath: string, _runAgent: RunAgent, config: Partial<TraceMemoryConfig> = {}): TraceMemory {
  const store = openStore(dbPath);
  const cfg = mergeConfig(DEFAULT_CONFIG, config);

  return {
    store,
    config: cfg,
    close: () => store.close(),
    note: async () => {
      throw new NotImplementedError("note");
    },
    settle: async () => {
      throw new NotImplementedError("settle");
    },
    compact: () => {
      throw new NotImplementedError("compact");
    },
    inject: () => {
      throw new NotImplementedError("inject");
    },
    trace: () => {
      throw new NotImplementedError("trace");
    },
    search: () => {
      throw new NotImplementedError("search");
    },
    mark: () => {
      throw new NotImplementedError("mark");
    },
    status: () => {
      throw new NotImplementedError("status");
    },
  };
}
