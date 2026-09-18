import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { ClosedSessionScope } from "../../core/api/index.ts";

export const CC_AGENT_SDK_VERSION = "0.1.77";
export const CC_NATIVE_VERSION = "2.1.257";
export const CC_CONTEXT_HEADROOM = 10_000;
export const CC_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type CcEffort = typeof CC_EFFORT_LEVELS[number];

export interface CcWorkerConfig {
  /** Prepared Claude Code executable. The worker verifies its exact version before use. */
  claudeExecutable: string;
  claudeVersion: string;
  model: string;
  effort: CcEffort;
  /** Prepared model context window. Core receives this value minus CC_CONTEXT_HEADROOM. */
  contextWindow: number;
  /** Private child cwd; neither the foreground project nor cwd is inferred. */
  cwd: string;
  /** Bound for native tool-handler/assistant-response correlation. */
  responseOriginTimeoutMs?: number;
}

export interface ResolvedCcWorkerConfig extends Omit<CcWorkerConfig, "responseOriginTimeoutMs"> {
  responseOriginTimeoutMs: number;
}

export interface CcHostConfig {
  /** Omitted uses the same ~/.trace-memory/trace.db default as the Pi host. */
  dbPath?: string;
  stateDir: string;
  /** Installation baseline. Unknown or malformed values keep provisional enrollment disabled. */
  baseline?: string;
  pollIntervalMs?: number;
  finalSyncTimeoutMs?: number;
  finalSyncStablePolls?: number;
  /** Bound for a write tool to observe its exact native assistant call in the transcript. */
  writeSourceTimeoutMs?: number;
  closedSessionScope?: ClosedSessionScope;
  /** Required to admit N/C work. Hosts that only ingest/read may omit it. */
  worker?: CcWorkerConfig;
}

export interface ResolvedCcHostConfig {
  dbPath: string;
  stateDir: string;
  baseline?: string;
  pollIntervalMs: number;
  finalSyncTimeoutMs: number;
  finalSyncStablePolls: number;
  writeSourceTimeoutMs: number;
  closedSessionScope: ClosedSessionScope;
  worker?: ResolvedCcWorkerConfig;
}

const positive = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid CC ${name}: expected a positive safe integer`);
  return value;
};

export function resolveCcHostConfig(input: CcHostConfig): ResolvedCcHostConfig {
  if (!input || typeof input !== "object") throw new Error("CC configuration is required");
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
    if (typeof value.claudeExecutable !== "string" || !isAbsolute(value.claudeExecutable))
      throw new Error("Invalid CC worker.claudeExecutable: expected an absolute path");
    if (typeof value.cwd !== "string" || !isAbsolute(value.cwd))
      throw new Error("Invalid CC worker.cwd: expected an absolute path");
    if (value.claudeVersion !== CC_NATIVE_VERSION)
      throw new Error(`Invalid CC worker.claudeVersion: this adapter is pinned to ${CC_NATIVE_VERSION}`);
    if (typeof value.model !== "string" || !value.model.trim())
      throw new Error("Invalid CC worker.model: expected a non-empty model id");
    if (!CC_EFFORT_LEVELS.includes(value.effort))
      throw new Error(`Invalid CC worker.effort: expected ${CC_EFFORT_LEVELS.join(", ")}`);
    const contextWindow = positive("worker.contextWindow", value.contextWindow);
    if (contextWindow <= CC_CONTEXT_HEADROOM)
      throw new Error(`Invalid CC worker.contextWindow: must exceed the ${CC_CONTEXT_HEADROOM}-token headroom`);
    worker = { claudeExecutable: resolve(value.claudeExecutable), claudeVersion: value.claudeVersion,
      model: value.model, effort: value.effort, contextWindow, cwd: resolve(value.cwd),
      responseOriginTimeoutMs: positive("worker.responseOriginTimeoutMs", value.responseOriginTimeoutMs ?? 5_000) };
  }
  return {
    dbPath: resolve(dbPath),
    stateDir: resolve(input.stateDir),
    ...(input.baseline === undefined ? {} : { baseline: input.baseline }),
    pollIntervalMs: positive("pollIntervalMs", input.pollIntervalMs ?? 2_000),
    finalSyncTimeoutMs: positive("finalSyncTimeoutMs", input.finalSyncTimeoutMs ?? 5_000),
    finalSyncStablePolls: positive("finalSyncStablePolls", input.finalSyncStablePolls ?? 2),
    writeSourceTimeoutMs: positive("writeSourceTimeoutMs", input.writeSourceTimeoutMs ?? 5_000),
    closedSessionScope,
    ...(worker ? { worker } : {}),
  };
}
