import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { MemoryStatusCounts } from "../status-line.ts";

/**
 * Ticket 75: the CC executor's tiny published status, one file per native session, read by the status
 * command without opening the database. Deliberately independent of `binding.ts`'s `CcSessionBinding`
 * (a much larger, validated record) so this module stays cheap to import from the status command's
 * bundle entry — no Store, no `node:sqlite`, no core import.
 */
export interface CcStatusRunning { noting: boolean; dreaming: boolean }

export interface CcStatusFile {
  version: 1;
  nativeSessionId: string;
  /** The publishing executor's identity (binding.ts's `CcExecutorBinding`): ownership and liveness are
   * checked against these, never assumed from the file's mere presence. */
  executorId: string;
  pid: number;
  token: string;
  updatedAt: string;
  enabled: boolean;
  running: CcStatusRunning;
  counts?: MemoryStatusCounts;
  cost?: number;
  /** 108: runs of today whose cost is unknown; `cost` leaves them out. */
  costUnknown?: number;
}

export function statusPath(stateDir: string, nativeSessionId: string): string {
  return join(stateDir, "status", `${nativeSessionId}.json`);
}

/** Write, fsync, rename — the same durability pattern `binding.ts`'s `writeBinding` uses. Ownership
 * (does this executor still own the binding?) is the caller's decision, made before this is reached;
 * this function writes unconditionally once called. */
export function writeCcStatus(stateDir: string, status: CcStatusFile): void {
  const target = statusPath(stateDir, status.nativeSessionId), temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  mkdirSync(dirname(target), { recursive: true });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "w", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(status)}\n`);
    fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
}

export function removeCcStatus(stateDir: string, nativeSessionId: string): void {
  rmSync(statusPath(stateDir, nativeSessionId), { force: true });
}

export function readCcStatus(stateDir: string, nativeSessionId: string): CcStatusFile | null {
  try { return JSON.parse(readFileSync(statusPath(stateDir, nativeSessionId), "utf8")) as CcStatusFile; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}
