// A task's scratch workspace (ticket 144): a directory whose files a task writes, the stop-hook bookkeeping, and the
// cancellation fence of stage 4 §1.5. The Noter and the Dreaming tasks each build theirs on this class. The directory is
// scratch; the database holds what must survive.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Where a host that names no root has its workspaces. */
export const defaultWorkspaceRoot = (): string => join(tmpdir(), "trace-memory-workspaces");

const PREFIXES = ["noting-", "dreaming-"];
/** The directory is far older than any claim lease (30 minutes) by then, so nothing live is removed. */
const STALE_MS = 24 * 60 * 60 * 1000;
/** Remove workspaces a crashed executor left behind. A workspace being swept is never one a live run uses. */
export function sweepStaleWorkspaces(root: string, now = Date.now()): void {
  if (!existsSync(root)) return;
  for (const name of readdirSync(root)) {
    if (!PREFIXES.some(prefix => name.startsWith(prefix))) continue;
    const path = join(root, name);
    try { if (now - statSync(path).mtimeMs > STALE_MS) rmSync(path, { recursive: true, force: true }); } catch { /* another sweeper took it */ }
  }
}

export interface StopCheck { ok: boolean; problems: string[] }

export class TaskWorkspace {
  readonly dir: string;
  readonly stopChecks: StopCheck[] = [];
  private shut = false;

  /** `prefix` is `noting-` or `dreaming-`; a Dreaming task adds its own name so each task has its own directory. */
  constructor(root: string, prefix: "noting-" | "dreaming-", sessionId: number, executionId: string, task?: string) {
    this.dir = join(root, `${prefix}S${sessionId}-${executionId.slice(0, 8)}${task ? `-${task}` : ""}`);
  }

  /** Create the directory with the files a resumed run starts from (name to text). */
  open(seed: Readonly<Record<string, string>> = {}): this {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const [name, text] of Object.entries(seed)) writeFileSync(this.path(name), text);
    return this;
  }

  path(name: string): string { return join(this.dir, name); }
  /** A file as it is; one the task never wrote reads as empty. */
  text(name: string): string { return existsSync(this.path(name)) ? readFileSync(this.path(name), "utf8") : ""; }
  /** Whether the task wrote the file at all (an absent file reads as empty text, which is not the same as a written one). */
  written(name: string): boolean { return existsSync(this.path(name)); }
  remove(): void { rmSync(this.dir, { recursive: true, force: true }); }

  /** The fence (§1.5): after it, the stop hook has nothing to say and core applies no file of this workspace. */
  close(): void { this.shut = true; }
  get closed(): boolean { return this.shut; }

  /** The stop hook: `undefined` when closed or when the check passes; otherwise the one follow-up that lists what to correct. */
  protected stop(check: () => StopCheck, followUp: (problems: string[]) => string): string | undefined {
    if (this.shut) return undefined;
    const result = check();
    this.stopChecks.push({ ok: result.ok, problems: result.problems });
    return result.ok ? undefined : followUp(result.problems);
  }
}
