import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { enrollmentDefault } from "../../core/api/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";

export interface CcHookInput {
  hook_event_name: "SessionStart" | "SessionEnd";
  session_id: string;
  transcript_path: string;
  source?: "startup" | "resume" | "clear" | "compact";
  reason?: string;
  cwd?: string;
}

export interface CcExecutorBinding {
  executorId: string;
  pid: number;
  token: string;
  socketPath: string;
  startedAt: string;
}

export interface CcSessionBinding {
  version: 1;
  nativeSessionId: string;
  transcriptPath: string;
  dbPath: string;
  nativeCreatedAt: string | null;
  enrollment: { defaultEnabled: boolean; choice: boolean | null };
  coreSessionId: number | null;
  projectId: number | null;
  branch: string;
  selectedLeafUuid: string | null;
  executor: CcExecutorBinding | null;
  lastClose: { at: string; reason: string; confirmed: boolean; diagnostic?: string } | null;
}

const NATIVE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const wait = (milliseconds: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason ?? new DOMException("Aborted", "AbortError")); return; }
  const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, milliseconds);
  const abort = () => { clearTimeout(timer); reject(signal!.reason ?? new DOMException("Aborted", "AbortError")); };
  signal?.addEventListener("abort", abort, { once: true });
});

export function validateNativeSessionId(value: unknown): string {
  if (typeof value !== "string" || !NATIVE_ID.test(value)) throw new Error("invalid native Claude Code session id");
  return value;
}

export function bindingPath(config: ResolvedCcHostConfig, nativeSessionId: string): string {
  return join(config.stateDir, "bindings", `${validateNativeSessionId(nativeSessionId)}.json`);
}

export function bindingMutexPath(config: ResolvedCcHostConfig, nativeSessionId: string): string {
  return join(config.stateDir, "locks", `${validateNativeSessionId(nativeSessionId)}.mutex.sqlite`);
}

function parseBinding(value: unknown): CcSessionBinding {
  const binding = value as Partial<CcSessionBinding>;
  if (!binding || binding.version !== 1 || validateNativeSessionId(binding.nativeSessionId) !== binding.nativeSessionId ||
      typeof binding.transcriptPath !== "string" || !binding.transcriptPath || typeof binding.dbPath !== "string" ||
      (binding.coreSessionId !== null && (!Number.isSafeInteger(binding.coreSessionId) || binding.coreSessionId! < 1)) ||
      (binding.projectId !== null && (!Number.isSafeInteger(binding.projectId) || binding.projectId! < 1)) ||
      typeof binding.branch !== "string" || !binding.branch ||
      (binding.selectedLeafUuid !== null && (typeof binding.selectedLeafUuid !== "string" || !binding.selectedLeafUuid)))
    throw new Error("invalid Claude Code binding record");
  return binding as CcSessionBinding;
}

export function readBinding(config: ResolvedCcHostConfig, nativeSessionId: string): CcSessionBinding | null {
  try { return parseBinding(JSON.parse(readFileSync(bindingPath(config, nativeSessionId), "utf8"))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function writeBinding(config: ResolvedCcHostConfig, binding: CcSessionBinding): void {
  const target = bindingPath(config, binding.nativeSessionId), temporary = `${target}.${process.pid}.${randomUUID()}`;
  const directory = dirname(target); mkdirSync(directory, { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(binding, null, 2)}\n`); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, target);
    const directoryDescriptor = openSync(directory, "r");
    try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true }); throw error;
  }
}

type SqliteBusyError = Error & { code?: string; errcode?: number };
const isSqliteBusy = (error: unknown): error is SqliteBusyError => {
  const value = error as SqliteBusyError;
  return value?.code === "ERR_SQLITE_ERROR" && value.errcode === 5;
};

async function withBindingLock<T>(config: ResolvedCcHostConfig, nativeSessionId: string, action: () => T,
  timeoutMs = 5_000, signal?: AbortSignal): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("CC binding lock timeout must be positive");
  const deadline = Date.now() + timeoutMs, target = bindingPath(config, nativeSessionId);
  const mutex = bindingMutexPath(config, nativeSessionId);
  mkdirSync(dirname(target), { recursive: true }); mkdirSync(dirname(mutex), { recursive: true });
  const database = new DatabaseSync(mutex, { timeout: 0 });
  let acquired = false;
  const checkDeadline = () => {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error(`timed out waiting for CC binding lock for ${nativeSessionId}`);
  };
  try {
    while (!acquired) {
      checkDeadline();
      try { database.exec("BEGIN IMMEDIATE"); acquired = true; }
      catch (error) {
        if (!isSqliteBusy(error)) throw error;
        const remaining = deadline - Date.now();
        if (remaining <= 0) checkDeadline();
        await wait(Math.min(20, remaining), signal);
      }
    }
    checkDeadline();
    return action();
  } finally {
    try { if (acquired) database.exec("ROLLBACK"); }
    finally { database.close(); }
  }
}

export async function updateBinding(config: ResolvedCcHostConfig, nativeSessionId: string,
  update: (current: CcSessionBinding | null) => CcSessionBinding, timeoutMs?: number, signal?: AbortSignal): Promise<CcSessionBinding> {
  return withBindingLock(config, nativeSessionId, () => {
    const current = readBinding(config, nativeSessionId), next = update(current);
    if (next.nativeSessionId !== nativeSessionId || next.dbPath !== config.dbPath) throw new Error("CC binding target changed during update");
    // Returning the locked current value means there is no durable change. In particular, transcript
    // reconciliation must not atomically replace an identical binding and wake its own watcher again.
    if (next !== current) writeBinding(config, next);
    return next;
  }, timeoutMs, signal);
}

export async function recordSessionStart(config: ResolvedCcHostConfig, input: CcHookInput,
  nativeCreatedAt: string | null): Promise<CcSessionBinding> {
  if (input.hook_event_name !== "SessionStart") throw new Error("expected a SessionStart Hook input");
  const nativeSessionId = validateNativeSessionId(input.session_id);
  if (typeof input.transcript_path !== "string" || !isAbsolute(input.transcript_path))
    throw new Error("SessionStart transcript_path must be absolute");
  return updateBinding(config, nativeSessionId, current => {
    if (current) {
      if (current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path)
        throw new Error("native Claude Code binding disagrees with its configured database or transcript path");
      return current;
    }
    return {
      version: 1,
      nativeSessionId,
      transcriptPath: input.transcript_path,
      dbPath: config.dbPath,
      nativeCreatedAt,
      enrollment: { defaultEnabled: enrollmentDefault(nativeCreatedAt, config.baseline), choice: null },
      coreSessionId: null,
      projectId: null,
      branch: "main",
      selectedLeafUuid: null,
      executor: null,
      lastClose: null,
    };
  });
}
