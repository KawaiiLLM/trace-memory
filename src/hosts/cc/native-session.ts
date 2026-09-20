import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { ResolvedCcHostConfig } from "./config.ts";
import { validateNativeSessionId, type CcHookInput } from "./binding.ts";

/** 65: the SessionStart Hook's answer to "which session does this Claude Code process serve now?",
 * keyed by the native process pid. Claude Code spawns the MCP executor before the interactive resume
 * picker chooses a session, so the executor's `CLAUDE_CODE_SESSION_ID` can name a session no Hook
 * ever reports; the Hook's id is authoritative and the executor follows it. */
export interface CcNativeSessionRecord {
  version: 1;
  pid: number;
  /** `ps -o lstart=` of the native process, an opaque string; null when unreadable. */
  startedAt: string | null;
  nativeSessionId: string;
  transcriptPath: string;
  source: string | null;
  at: string;
}

export interface CcProcessIdentity { pid: number; startedAt: string | null }

export function nativeSessionDirectory(config: ResolvedCcHostConfig): string {
  return join(config.stateDir, "native-sessions");
}

export function nativeSessionPath(config: ResolvedCcHostConfig, pid: number): string {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("native process pid must be a positive integer");
  return join(nativeSessionDirectory(config), `${pid}.json`);
}

const ps = (format: string, pid: number): string | null => {
  try { return execFileSync("ps", ["-o", format, "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }).trim() || null; }
  catch { return null; }
};

/** The process start time as `ps` prints it; null when `ps` is unavailable or the process is gone. */
export function processStartedAt(pid: number): string | null { return ps("lstart=", pid); }

/** The calling process's ancestors, closest first: `process.ppid`, then up to `depth - 1` further
 * parents through `ps`. Stops at init or when `ps` cannot answer. */
export function processAncestors(depth = 5, parentOf: (pid: number) => number | null = pid => {
  const value = ps("ppid=", pid); const parent = value === null ? NaN : Number(value);
  return Number.isSafeInteger(parent) && parent > 0 ? parent : null;
}, first = process.ppid): CcProcessIdentity[] {
  const ancestors: CcProcessIdentity[] = [];
  for (let pid: number | null = first; pid !== null && pid > 1 && ancestors.length < depth; pid = parentOf(pid))
    ancestors.push({ pid, startedAt: processStartedAt(pid) });
  return ancestors;
}

function writeAtomically(target: string, content: string): void {
  const temporary = `${target}.${process.pid}.${randomUUID()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content); fsyncSync(descriptor); closeSync(descriptor); descriptor = undefined;
    renameSync(temporary, target);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true }); throw error;
  }
}

/** Hook side: publish the session this native process serves. `pid` defaults to `CLAUDE_PID`;
 * without it nothing is written and the caller is told so. */
export function publishNativeSession(config: ResolvedCcHostConfig, input: CcHookInput,
  pid: number | null = parsePid(process.env.CLAUDE_PID)): CcNativeSessionRecord | null {
  if (pid === null) return null;
  const record: CcNativeSessionRecord = { version: 1, pid, startedAt: processStartedAt(pid), nativeSessionId: validateNativeSessionId(input.session_id),
    transcriptPath: input.transcript_path, source: typeof input.source === "string" ? input.source : null, at: new Date().toISOString() };
  mkdirSync(nativeSessionDirectory(config), { recursive: true });
  writeAtomically(nativeSessionPath(config, pid), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

const parsePid = (value: string | undefined): number | null => {
  const pid = Number(value); return value !== undefined && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
};

function readNativeSession(config: ResolvedCcHostConfig, pid: number): CcNativeSessionRecord | null {
  let record: Partial<CcNativeSessionRecord>;
  try { record = JSON.parse(readFileSync(nativeSessionPath(config, pid), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  if (record?.version !== 1 || record.pid !== pid || typeof record.nativeSessionId !== "string" || typeof record.transcriptPath !== "string")
    throw new Error(`invalid native session record for pid ${pid}`);
  validateNativeSessionId(record.nativeSessionId);
  return record as CcNativeSessionRecord;
}

/** Executor side: the assignment published for the closest ancestor that has one. A record whose
 * start time disagrees with the live process is a pid reused by another process and is ignored. */
export function assignedNativeSession(config: ResolvedCcHostConfig, ancestors: CcProcessIdentity[]): CcNativeSessionRecord | null {
  for (const ancestor of ancestors) {
    const record = readNativeSession(config, ancestor.pid);
    if (!record) continue;
    if (record.startedAt !== null && ancestor.startedAt !== null && record.startedAt !== ancestor.startedAt) continue;
    return record;
  }
  return null;
}

export interface CcNativeSessionFollower { check(): void; stop(): void }

/** Watch the native-session directory and hand every assignment to `adopt`; the caller decides
 * what an assignment means for its current state. `check` runs once immediately. */
export function followNativeSession(config: ResolvedCcHostConfig, ancestors: CcProcessIdentity[],
  adopt: (record: CcNativeSessionRecord) => void, report: (message: string) => void, pollIntervalMs = config.pollIntervalMs): CcNativeSessionFollower {
  const directory = nativeSessionDirectory(config);
  let watcher: FSWatcher | null = null, last: string | null = null, stopped = false;
  const check = () => {
    if (stopped) return;
    let record: CcNativeSessionRecord | null;
    try { record = assignedNativeSession(config, ancestors); }
    catch (error) { report(`native session assignment unreadable: ${error instanceof Error ? error.message : String(error)}`); return; }
    if (!record) return;
    const key = `${record.nativeSessionId}\n${record.at}`;
    if (key === last) return;
    last = key;
    adopt(record);
  };
  const names = new Set(ancestors.map(ancestor => `${ancestor.pid}.json`));
  const startWatch = () => {
    if (watcher || !existsSync(directory)) return;
    try {
      watcher = watch(directory, (_event, filename) => { if (names.has(String(filename))) check(); });
      watcher.on("error", error => { report(`native session watch failed: ${String(error)}; polling remains active`); watcher?.close(); watcher = null; });
    } catch (error) { report(`native session watch unavailable: ${error instanceof Error ? error.message : String(error)}; polling remains active`); }
  };
  const poll = setInterval(() => { startWatch(); check(); }, pollIntervalMs);
  startWatch(); check();
  return { check, stop: () => { stopped = true; clearInterval(poll); watcher?.close(); watcher = null; } };
}
