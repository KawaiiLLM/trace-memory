import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { enrollmentDefault } from "../../core/api/index.ts";
import type { Store } from "../../core/store/index.ts";
import type { ResolvedCcHostConfig } from "./config.ts";
import { currentNativeProcess, type CcProcessIdentity } from "./native-session.ts";

export interface CcHookInput {
  hook_event_name: "SessionStart" | "SessionEnd";
  session_id: string;
  transcript_path: string;
  source?: "startup" | "resume" | "clear" | "compact";
  reason?: string;
  cwd?: string;
}

/** Whether memory is on for this native session. The binding's enrollment is the record only while
 * no core session exists (a provisional session); once one does, the Store's enrollment decides —
 * automatic off (executions.ts) changes it there and never touches the binding. */
export function sessionEnabled(binding: Pick<CcSessionBinding, "coreSessionId" | "enrollment">, store: Pick<Store, "enabled">): boolean {
  return binding.coreSessionId === null ? binding.enrollment.choice ?? binding.enrollment.defaultEnabled
    : store.enabled(binding.coreSessionId);
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
  /** 97: byte offset just after the selected leaf's line at its import. Hooks read only what
   * follows it. Absent on bindings written before 97. */
  transcriptOffset?: number;
  /** 97: the Turn a prompt written after the selected leaf descends from: the leaf's own prompt
   * Turn, or a compaction that interrupted it. Written with `transcriptOffset`. */
  selectedHeadTurnId?: number;
  executor: CcExecutorBinding | null;
  /** Native SessionStart owner; fences a delayed SessionEnd from a previous native process. */
  nativeProcess?: CcProcessIdentity;
  lastClose: { at: string; reason: string; confirmed: boolean; diagnostic?: string } | null;
  /** Exact foreground truncation warning emitted by the last successful SessionStart; null if clean. */
  lastCompactionNotice?: string | null;
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
      (binding.nativeProcess !== undefined && (!Number.isSafeInteger(binding.nativeProcess?.pid) || binding.nativeProcess.pid <= 0 ||
        typeof binding.nativeProcess.startedAt !== "string" || !binding.nativeProcess.startedAt)) ||
      (binding.lastCompactionNotice !== undefined && binding.lastCompactionNotice !== null && typeof binding.lastCompactionNotice !== "string") ||
      (binding.cwd !== undefined && (typeof binding.cwd !== "string" || !isAbsolute(binding.cwd))) ||
      (binding.coreHost !== undefined && (typeof binding.coreHost !== "string" || !binding.coreHost.startsWith("cc:"))) ||
      (binding.clearedFrom !== undefined && !validClearedFrom(binding.clearedFrom)) ||
      (binding.clearedInto !== undefined && (typeof binding.clearedInto?.nativeSessionId !== "string" || typeof binding.clearedInto.at !== "string")) ||
      (binding.transcriptOffset !== undefined && (!Number.isSafeInteger(binding.transcriptOffset) || binding.transcriptOffset < 0)) ||
      (binding.selectedHeadTurnId !== undefined && (!Number.isSafeInteger(binding.selectedHeadTurnId) || binding.selectedHeadTurnId < 1)) ||
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

/** 84 edge case: `synchronous=NORMAL`'s accepted rollback window can reach back before this native
 * session's own core session was created — the binding still names a session id the rollback
 * erased (the row is simply gone; a session that exists under the wrong host is a different,
 * unrelated corruption and still throws downstream). Drop the lost identity and continue exactly
 * like a not-yet-registered (provisional) binding: the enrollment mirror is left as-is (it already
 * carries the user's last choice forward as the provisional one), the project stays only if its own
 * row also survived, and everything else that only made sense for the lost core session — its
 * lineage host, its selected branch/leaf, and the `/clear` lineage fields tied to it — is dropped so
 * the ordinary first-start path allocates a fresh core session for this native identity. */
export function dropLostCoreSession(binding: CcSessionBinding, store: Pick<Store, "getSession" | "getProject">): CcSessionBinding {
  if (binding.coreSessionId === null || store.getSession(binding.coreSessionId)) return binding;
  const { coreSessionId: _coreSessionId, coreHost: _coreHost, clearedFrom: _clearedFrom, clearedInto: _clearedInto,
    selectedLeafUuid: _selectedLeafUuid, transcriptOffset: _transcriptOffset, selectedHeadTurnId: _selectedHeadTurnId, branch: _branch, projectId, ...rest } = binding;
  return { ...rest, coreSessionId: null, branch: "main", selectedLeafUuid: null,
    projectId: projectId !== null && store.getProject(projectId) ? projectId : null };
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

/** A new SessionStart replaces native ownership even when its new identity is unavailable.
 * Keeping the old owner in that case would authorize a delayed hook from the previous process. */
export function renewNativeBinding(current: CcSessionBinding, nativeProcess: CcProcessIdentity | null): CcSessionBinding {
  const sameOwner = nativeProcess ? current.nativeProcess?.pid === nativeProcess.pid &&
    current.nativeProcess.startedAt === nativeProcess.startedAt : current.nativeProcess === undefined;
  if (!current.lastClose && sameOwner) return current;
  const { nativeProcess: previous, ...rest } = current;
  return { ...rest, ...(nativeProcess ? { nativeProcess } : {}), lastClose: null };
}

export async function recordSessionStart(config: ResolvedCcHostConfig, input: CcHookInput,
  nativeCreatedAt: string | null): Promise<CcSessionBinding> {
  if (input.hook_event_name !== "SessionStart") throw new Error("expected a SessionStart Hook input");
  const nativeSessionId = validateNativeSessionId(input.session_id);
  if (typeof input.transcript_path !== "string" || !isAbsolute(input.transcript_path))
    throw new Error("SessionStart transcript_path must be absolute");
  const nativeProcess = currentNativeProcess();
  return updateBinding(config, nativeSessionId, current => {
    if (current) {
      if (current.dbPath !== config.dbPath || current.transcriptPath !== input.transcript_path)
        throw new Error("native Claude Code binding disagrees with its configured database or transcript path");
      return renewNativeBinding(current, nativeProcess);
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
      ...(nativeProcess ? { nativeProcess } : {}),
      lastClose: null,
      ...(typeof input.cwd === "string" && isAbsolute(input.cwd) ? { cwd: input.cwd } : {}),
    };
  });
}
