import { isAbsolute, resolve } from "node:path";

export interface CcHostConfig {
  dbPath: string;
  stateDir: string;
  /** Installation baseline. Unknown or malformed values keep provisional enrollment disabled. */
  baseline?: string;
  pollIntervalMs?: number;
  finalSyncTimeoutMs?: number;
  finalSyncStablePolls?: number;
}

export interface ResolvedCcHostConfig {
  dbPath: string;
  stateDir: string;
  baseline?: string;
  pollIntervalMs: number;
  finalSyncTimeoutMs: number;
  finalSyncStablePolls: number;
}

const positive = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid CC ${name}: expected a positive safe integer`);
  return value;
};

export function resolveCcHostConfig(input: CcHostConfig): ResolvedCcHostConfig {
  if (!input || typeof input !== "object") throw new Error("CC configuration is required");
  if (typeof input.dbPath !== "string" || !input.dbPath.trim()) throw new Error("CC dbPath is required");
  if (typeof input.stateDir !== "string" || !input.stateDir.trim()) throw new Error("CC stateDir is required");
  if (!isAbsolute(input.dbPath) || !isAbsolute(input.stateDir)) throw new Error("CC dbPath and stateDir must be absolute");
  if (input.baseline !== undefined && (typeof input.baseline !== "string" || !Number.isFinite(Date.parse(input.baseline))))
    throw new Error("Invalid CC baseline: expected an ISO timestamp");
  return {
    dbPath: resolve(input.dbPath),
    stateDir: resolve(input.stateDir),
    ...(input.baseline === undefined ? {} : { baseline: input.baseline }),
    pollIntervalMs: positive("pollIntervalMs", input.pollIntervalMs ?? 2_000),
    finalSyncTimeoutMs: positive("finalSyncTimeoutMs", input.finalSyncTimeoutMs ?? 5_000),
    finalSyncStablePolls: positive("finalSyncStablePolls", input.finalSyncStablePolls ?? 2),
  };
}
