import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { enrollmentDefault } from "../../core/api/index.ts";
import type { Store } from "../../core/store/index.ts";
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
  /** 62: the SessionStart hook's cwd, read once when the core session is allocated. Absent on
   * bindings written before 62 or by a hook without cwd: such a session keeps its own project. */
  cwd?: string;
  /** 63: the core session's `host` when it is not `cc:<this native id>` — a native session cleared
   * into from another keeps the root's host. `coreHostOf` reads it with the default. */
  coreHost?: string;
  /** 63: this native session continues the core session of the one it was cleared from. */
  clearedFrom?: CcClearedFrom;
  /** 63: this native session was cleared into another; its core session stays open there. */
  clearedInto?: { nativeSessionId: string; at: string };
}

export interface CcClearedFrom {
  nativeSessionId: string;
  at: string;
  /** The compaction Turn appended under the parent's head; the child's root records attach to it.
   * Null when the parent had no core session yet. */
  compactionTurnId: number | null;
  /** The branch's persisted path at the clear; the child's selected path continues it. */
  inheritedEntryIds: number[];
}

/** The `host` of the core session a binding names: the lineage root's, or this native id's. */
export const coreHostOf = (binding: Pick<CcSessionBinding, "nativeSessionId" | "coreHost">): string =>
  binding.coreHost ?? `cc:${validateNativeSessionId(binding.nativeSessionId)}`;

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

/** Resolve the undeclared per-session project. Callers perform this write only while holding the
 * binding lock so project, allocation, declaration and enrollment cannot be observed separately. */
export function implicitCcProject(store: Store, nativeSessionId: string) {
  const name = `cc:${validateNativeSessionId(nativeSessionId)}`;
  return store.findProjectByName(name) ?? store.createProject({ name, declaredBy: "marker" });
}

const validClearedFrom = (value: unknown): value is CcClearedFrom => {
  const cleared = value as Partial<CcClearedFrom>;
  return !!cleared && typeof cleared.nativeSessionId === "string" && NATIVE_ID.test(cleared.nativeSessionId) && typeof cleared.at === "string" &&
    (cleared.compactionTurnId === null || (Number.isSafeInteger(cleared.compactionTurnId) && cleared.compactionTurnId! > 0)) &&
    Array.isArray(cleared.inheritedEntryIds) && cleared.inheritedEntryIds.every(id => Number.isSafeInteger(id) && id > 0);
};

function parseBinding(value: unknown): CcSessionBinding {
  const binding = value as Partial<CcSessionBinding>;
  if (!binding || binding.version !== 1 || validateNativeSessionId(binding.nativeSessionId) !== binding.nativeSessionId ||
      typeof binding.transcriptPath !== "string" || !binding.transcriptPath || typeof binding.dbPath !== "string" ||
      (binding.coreSessionId !== null && (!Number.isSafeInteger(binding.coreSessionId) || binding.coreSessionId! < 1)) ||
      (binding.projectId !== null && (!Number.isSafeInteger(binding.projectId) || binding.projectId! < 1)) ||
      typeof binding.branch !== "string" || !binding.branch ||
      (binding.cwd !== undefined && (typeof binding.cwd !== "string" || !isAbsolute(binding.cwd))) ||
      (binding.coreHost !== undefined && (typeof binding.coreHost !== "string" || !binding.coreHost.startsWith("cc:"))) ||
      (binding.clearedFrom !== undefined && !validClearedFrom(binding.clearedFrom)) ||
      (binding.clearedInto !== undefined && (typeof binding.clearedInto?.nativeSessionId !== "string" || typeof binding.clearedInto.at !== "string")) ||
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

/** Validate the complete operator target before any database write or control message. */
export function assertOperatorBinding(config: ResolvedCcHostConfig, binding: CcSessionBinding, store: Store): void {
  if (binding.dbPath !== config.dbPath) throw new Error("Claude Code binding disagrees with the configured database");
  if (binding.coreSessionId === null) {
    if (binding.projectId !== null && !store.getProject(binding.projectId))
      throw new Error("bound Claude Code project is unavailable in the configured database");
    return;
  }
  const session = store.getSession(binding.coreSessionId);
  if (!session || session.host !== coreHostOf(binding))
    throw new Error("CC binding does not name its authoritative core session");
  if (binding.projectId === null || session.projectId !== binding.projectId)
    throw new Error("bound Claude Code core session or project disagrees with the database");
}

function writeBinding(config: ResolvedCcHostConfig, binding: CcSessionBinding, published?: () => void): void {
  const target = bindingPath(config, binding.nativeSessionId), temporary = `${target}.${process.pid}.${randomUUID()}`;
  const directory = dirname(target); mkdirSync(directory, { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(binding, null, 2)}\n`); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, target);
    published?.();
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

export interface CcBindingLock {
  read(): CcSessionBinding | null;
  update(update: (current: CcSessionBinding | null) => CcSessionBinding): CcSessionBinding;
}

/** Serialize all native-session projection publishers. The action may scan the transcript and make
 * per-record Store transactions while this file lock is held; the lock itself is not a Store
 * transaction. Binding updates made through the supplied interface do not reacquire the lock. */
export async function withCcBindingLock<T>(config: ResolvedCcHostConfig, nativeSessionId: string,
  action: (binding: CcBindingLock) => T | Promise<T>, timeoutMs = 5_000, signal?: AbortSignal): Promise<T> {
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
    const locked: CcBindingLock = {
      read: () => readBinding(config, nativeSessionId),
      update: update => {
        const current = readBinding(config, nativeSessionId), next = update(current);
        validateBindingUpdate(config, nativeSessionId, next);
        if (next !== current) writeBinding(config, next);
        return next;
      },
    };
    return await action(locked);
  } finally {
    try { if (acquired) database.exec("ROLLBACK"); }
    finally { database.close(); }
  }
}

function validateBindingUpdate(config: ResolvedCcHostConfig, nativeSessionId: string, next: CcSessionBinding): void {
  if (next.nativeSessionId !== nativeSessionId || next.dbPath !== config.dbPath)
    throw new Error("CC binding target changed during update");
}

export async function updateBinding(config: ResolvedCcHostConfig, nativeSessionId: string,
  update: (current: CcSessionBinding | null) => CcSessionBinding, timeoutMs?: number, signal?: AbortSignal): Promise<CcSessionBinding> {
  return withCcBindingLock(config, nativeSessionId, locked => locked.update(update), timeoutMs, signal);
}

/** Keep a binding file and related Store writes coherent under the existing binding lock and one
 * Store transaction. A binding write failure rolls the Store back; a Store commit failure restores
 * the prior binding before the lock is released. */
export async function updateBindingInStoreTransaction(config: ResolvedCcHostConfig, nativeSessionId: string, store: Store,
  update: (current: CcSessionBinding | null) => CcSessionBinding, timeoutMs?: number, signal?: AbortSignal): Promise<CcSessionBinding> {
  return withCcBindingLock(config, nativeSessionId, () => {
    const current = readBinding(config, nativeSessionId);
    let next!: CcSessionBinding, wrote = false;
    try {
      store.transaction(() => {
        next = update(current);
        validateBindingUpdate(config, nativeSessionId, next);
        if (next !== current) writeBinding(config, next, () => { wrote = true; });
      });
      return next;
    } catch (error) {
      if (wrote && current) {
        try { writeBinding(config, current); }
        catch (restoreError) { throw new AggregateError([error, restoreError], "CC Store transaction failed and its binding could not be restored"); }
      }
      throw error;
    }
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
    // Prepare the database's parent, never the database itself. Store opens an existing file in
    // place or creates it on first use, just as the Pi host does.
    mkdirSync(dirname(config.dbPath), { recursive: true });
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
      ...(typeof input.cwd === "string" && isAbsolute(input.cwd) ? { cwd: input.cwd } : {}),
    };
  });
}
