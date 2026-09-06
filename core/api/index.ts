// Hosts use this façade; persistence remains entirely in core/store.
import { realpathSync } from "node:fs";
import { freezeNote, runNote, type NoteInput, type NoteResult } from "../note/index";
import { finish, renderFact, renderTurn, type TurnOptions } from "../render/index";
export type { NoteInput, NoteResult, NoteAgentInput } from "../note/index";
import { openStore, type Store } from "../store/index";
import type { RunOutcome } from "../model/index";

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
}

export type RunAgent = (input: unknown) => Promise<RunAgentResult>;

// ---- Methods assigned to later tickets ----

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
  note(input: NoteInput): Promise<NoteResult>;
  settle(input: unknown): Promise<unknown>;
  compact(input: unknown): unknown;
  inject(input: unknown): unknown;
  trace(address: string): string;
  search(query: string): unknown;
  mark(input: unknown): unknown;
  status(sessionId: number): unknown;
}

export function TraceMemory(dbPath: string, runAgent: RunAgent, config: ConfigOverride = {}): TraceMemory {
  const store = openStore(dbPath);
  const cfg = mergeConfig(DEFAULT_CONFIG, config);

  const databaseIdentity = dbPath === ":memory:" ? `:memory:${++memoryDatabaseId}` : realpathSync(dbPath);
  const trace = (address: string): string => {
    const [target, ...flags] = address.trim().split(/\s+/);
    const factMatch = /^F([1-9]\d*)$/.exec(target ?? "");
    if (factMatch && !flags.length) {
      const fact = store.getFact(Number(factMatch[1]));
      if (!fact) throw new Error(`fact ${target} does not exist`);
      return renderFact(fact, store.listFactRelations(fact.id));
    }
    const turnMatch = /^T([1-9]\d*)$/.exec(target ?? "");
    if (!turnMatch) throw new NotImplementedError("trace address " + address);
    const options: TurnOptions = {};
    for (const flag of flags) {
      if (flag === "full") options.full = true;
      else if (/^tool=[1-9]\d*$/.test(flag)) options.tool = Number(flag.slice(5));
      else if (/^cap=\d+$/.test(flag) && Number.isSafeInteger(Number(flag.slice(4)))) options.cap = Number(flag.slice(4));
      else throw new Error(`invalid trace option: ${flag}`);
    }
    const turn = store.getTurn(Number(turnMatch[1]));
    if (!turn) throw new Error(`turn ${target} does not exist`);
    const calls = store.listToolCalls(turn.id);
    if (options.tool !== undefined && !calls.some((c) => c.ordinal === options.tool)) throw new Error(`tool #t${options.tool} does not exist in ${target}`);
    return finish(renderTurn(turn, calls, cfg.render, options));
  };

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
        return await runNote(store, frozen, runAgent, cfg, trace);
      } finally { inFlightNotes.delete(key); }
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
    trace,
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
