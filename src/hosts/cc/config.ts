import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { validateConfig, type ClosedSessionScope, type ConfigOverride, type TraceMemoryConfig } from "../../core/api/index.ts";
import { MEMORY_PHASES, PHASE_SETTING_KEYS, type MemoryPhase } from "../phase-settings.ts";
import { retireConsolidationSettings } from "../retired-settings.ts";

export const CC_AGENT_SDK_VERSION = "0.1.77";
export const CC_NATIVE_VERSION = "2.1.280";
export const CC_CONTEXT_HEADROOM = 10_000;
export const CC_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type CcEffort = typeof CC_EFFORT_LEVELS[number];

export interface CcRetryConfig {
  /** Native Claude Code request retry count. The runtime owns eligibility, timing and backoff. */
  maxRetries: number;
}

export interface CcWorkerConfig {
  /** Prepared Claude Code executable. The worker verifies its exact version before use. */
  claudeExecutable: string;
  claudeVersion: string;
  /** Offline capacities keyed by the exact configured model identifier. */
  contextWindows: Record<string, number>;
  /** Private child cwd; neither the foreground project nor cwd is inferred. */
  cwd: string;
  /** Bound for native tool-handler/assistant-response correlation. */
  responseOriginTimeoutMs?: number;
}

export interface ResolvedCcPhaseConfig {
  model: string;
  thinking: CcEffort;
  capacity: { inputTokens: number; prefixTokens: 0 };
}

export interface ResolvedCcWorkerConfig extends Omit<CcWorkerConfig, "responseOriginTimeoutMs" | "contextWindows"> {
  contextWindows: Readonly<Record<string, number>>;
  phases: Readonly<Record<MemoryPhase, ResolvedCcPhaseConfig>>;
  responseOriginTimeoutMs: number;
}

export interface CcHostConfig {
  /** Omitted uses the same ~/.trace-memory/trace.db default as the Pi host. */
  dbPath?: string;
  stateDir: string;
  notingModel?: string;
  notingThinking?: string;
  "dreaming.model"?: string;
  "dreaming.thinking"?: string;
  "noting.triggerTokens"?: number;
  "dreaming.triggerTokens"?: number;
  "dreaming.timeoutMs"?: number;
  /** 73: the fixed allowance shared by Knowledge, Facts and Raw (default 10,000). Not a
   * compaction-only overflow — injection and the Consolidator/Dreamer knowledge capacities spend it too. */
  "compaction.sharedAllowanceTokens"?: number;
  /** Installation baseline. Unknown or malformed values keep provisional enrollment disabled. */
  baseline?: string;
  /** Omitted preserves Claude Code's native default. No adapter retry policy is added. */
  retry?: CcRetryConfig;
  pollIntervalMs?: number;
  finalSyncTimeoutMs?: number;
  finalSyncStablePolls?: number;
  /** Bound for a write tool to observe its exact native assistant call in the transcript. */
  writeSourceTimeoutMs?: number;
  closedSessionScope?: ClosedSessionScope;
  /** Required to admit N/D work. Hosts that only ingest/read may omit it. */
  worker?: CcWorkerConfig;
}

export interface ResolvedCcHostConfig {
  removedSettings: string[];
  dbPath: string;
  stateDir: string;
  notingModel?: string;
  notingThinking?: string;
  "dreaming.model"?: string;
  "dreaming.thinking"?: string;
  baseline?: string;
  retry?: CcRetryConfig;
  pollIntervalMs: number;
  finalSyncTimeoutMs: number;
  finalSyncStablePolls: number;
  writeSourceTimeoutMs: number;
  closedSessionScope: ClosedSessionScope;
  /** Validated core configuration assembled from the CC file's flat phase keys. */
  coreConfig: TraceMemoryConfig;
  worker?: ResolvedCcWorkerConfig;
}

const positive = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid CC ${name}: expected a positive safe integer`);
  return value;
};

function retry(input: CcRetryConfig | undefined): CcRetryConfig | undefined {
  if (input === undefined) return undefined;
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid CC retry: expected { maxRetries }");
  const extra = Object.keys(input).filter(key => key !== "maxRetries");
  if (extra.length) throw new Error(`Invalid CC retry.${extra[0]}: native retry configuration accepts only maxRetries`);
  if (!Number.isSafeInteger(input.maxRetries) || input.maxRetries < 0)
    throw new Error("Invalid CC retry.maxRetries: expected a non-negative safe integer");
  if (input.maxRetries > 15)
    throw new Error("Invalid CC retry.maxRetries: pinned Claude Code supports at most 15 without retry watchdog");
  return { maxRetries: input.maxRetries };
}

function phaseFields(input: CcHostConfig, phase: MemoryPhase): { model: string; thinking: CcEffort } {
  const keys = PHASE_SETTING_KEYS[phase];
  const model = input[keys.model as keyof CcHostConfig];
  const thinking = input[keys.thinking as keyof CcHostConfig];
  if (typeof model !== "string" || !model.trim())
    throw new Error(`Invalid CC ${keys.model}: an explicit non-empty model id is required when worker is configured`);
  if (model === "session") throw new Error(`Invalid CC ${keys.model}: session inheritance is unavailable in the CC worker`);
  if (thinking === "inherit" || thinking === "session")
    throw new Error(`Invalid CC ${keys.thinking}: inheritance is unavailable in the CC worker`);
  if (typeof thinking !== "string" || !CC_EFFORT_LEVELS.includes(thinking as CcEffort))
    throw new Error(`Invalid CC ${keys.thinking}: expected ${CC_EFFORT_LEVELS.join(", ")}; unsupported Pi thinking levels cannot be coerced`);
  return { model, thinking: thinking as CcEffort };
}

export function resolveCcHostConfig(input: CcHostConfig): ResolvedCcHostConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("CC configuration is required");
  const retired = retireConsolidationSettings(input);
  input = retired.values;
  const dbPath = input.dbPath === undefined ? join(homedir(), ".trace-memory", "trace.db") : input.dbPath;
  if (typeof dbPath !== "string" || !dbPath.trim()) throw new Error("CC dbPath must be a non-empty absolute path when specified");
  if (typeof input.stateDir !== "string" || !input.stateDir.trim()) throw new Error("CC stateDir is required");
  if (!isAbsolute(dbPath) || !isAbsolute(input.stateDir)) throw new Error("CC dbPath and stateDir must be absolute");
  if (input.baseline !== undefined && (typeof input.baseline !== "string" || !Number.isFinite(Date.parse(input.baseline))))
    throw new Error("Invalid CC baseline: expected an ISO timestamp");
  const closedSessionScope = input.closedSessionScope ?? "project";
  if (!(["off", "project", "global"] as const).includes(closedSessionScope))
    throw new Error("Invalid CC closedSessionScope: expected off, project or global");
  let worker: ResolvedCcWorkerConfig | undefined;
  if (input.worker !== undefined) {
    const value = input.worker;
    if (!value || typeof value !== "object") throw new Error("Invalid CC worker: expected an object");
    const legacy = ["model", "effort", "contextWindow"].filter(key => Object.hasOwn(value, key));
    if (legacy.length) throw new Error(`Legacy CC worker.${legacy.join("/worker.")} is unsupported; migrate to the six root phase keys and worker.contextWindows`);
    const parallel = ["noting", "consolidation", "dreaming"].filter(key => Object.hasOwn(value, key));
    if (parallel.length) throw new Error(`Invalid CC worker.${parallel[0]}: phase settings use the six flat host keys, not a worker phase hierarchy`);
    if (typeof value.claudeExecutable !== "string" || !isAbsolute(value.claudeExecutable))
      throw new Error("Invalid CC worker.claudeExecutable: expected an absolute path");
    if (typeof value.cwd !== "string" || !isAbsolute(value.cwd))
      throw new Error("Invalid CC worker.cwd: expected an absolute path");
    if (value.claudeVersion !== CC_NATIVE_VERSION)
      throw new Error(`Invalid CC worker.claudeVersion: this adapter is pinned to ${CC_NATIVE_VERSION}`);
    if (!value.contextWindows || typeof value.contextWindows !== "object" || Array.isArray(value.contextWindows))
      throw new Error("Invalid CC worker.contextWindows: expected model-to-capacity object");
    const phases = Object.fromEntries(MEMORY_PHASES.map(phase => {
      const selected = phaseFields(input, phase);
      if (!Object.hasOwn(value.contextWindows, selected.model))
        throw new Error(`Invalid CC worker.contextWindows: no capacity for selected ${phase} model ${selected.model}`);
      const contextWindow = positive(`worker.contextWindows[${JSON.stringify(selected.model)}]`, value.contextWindows[selected.model]!);
      if (contextWindow <= CC_CONTEXT_HEADROOM)
        throw new Error(`Invalid CC worker.contextWindows[${JSON.stringify(selected.model)}]: must exceed the ${CC_CONTEXT_HEADROOM}-token headroom`);
      return [phase, { ...selected, capacity: { inputTokens: contextWindow - CC_CONTEXT_HEADROOM, prefixTokens: 0 as const } }];
    })) as Record<MemoryPhase, ResolvedCcPhaseConfig>;
    worker = { claudeExecutable: resolve(value.claudeExecutable), claudeVersion: value.claudeVersion,
      contextWindows: { ...value.contextWindows }, phases, cwd: resolve(value.cwd),
      responseOriginTimeoutMs: positive("worker.responseOriginTimeoutMs", value.responseOriginTimeoutMs ?? 5_000) };
  }
  const phaseValues = Object.fromEntries(Object.values(PHASE_SETTING_KEYS).flatMap(keys =>
    [keys.model, keys.thinking].flatMap(key => input[key as keyof CcHostConfig] === undefined ? [] : [[key, input[key as keyof CcHostConfig]]]))) as Partial<ResolvedCcHostConfig>;
  const coreConfig = validateConfig({
    closedSessionScope,
    ...(input["noting.triggerTokens"] === undefined ? {} : { noting: { triggerTokens: input["noting.triggerTokens"] } }),
    ...(input["dreaming.triggerTokens"] === undefined && input["dreaming.timeoutMs"] === undefined ? {} : { dreaming: {
      ...(input["dreaming.triggerTokens"] === undefined ? {} : { triggerTokens: input["dreaming.triggerTokens"] }),
      ...(input["dreaming.timeoutMs"] === undefined ? {} : { timeoutMs: input["dreaming.timeoutMs"] }),
    } }),
    ...(input["compaction.sharedAllowanceTokens"] === undefined ? {} : { compaction: { sharedAllowanceTokens: input["compaction.sharedAllowanceTokens"] } }),
  } as ConfigOverride);
  return {
    removedSettings: retired.removed,
    dbPath: resolve(dbPath), stateDir: resolve(input.stateDir), ...phaseValues,
    ...(input.baseline === undefined ? {} : { baseline: input.baseline }),
    ...(input.retry === undefined ? {} : { retry: retry(input.retry)! }),
    pollIntervalMs: positive("pollIntervalMs", input.pollIntervalMs ?? 2_000),
    finalSyncTimeoutMs: positive("finalSyncTimeoutMs", input.finalSyncTimeoutMs ?? 5_000),
    finalSyncStablePolls: positive("finalSyncStablePolls", input.finalSyncStablePolls ?? 2),
    writeSourceTimeoutMs: positive("writeSourceTimeoutMs", input.writeSourceTimeoutMs ?? 5_000),
    closedSessionScope, coreConfig, ...(worker ? { worker } : {}),
  };
}
